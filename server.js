// server.js — Twilio <-> OpenAI Realtime bridge (ESM, Node 20)
// Deploy on Railway. Set env var: OPENAI_API_KEY
// Twilio <Connect><Stream> <-> WebSocket here
// Audio path: Twilio μ-law 8 kHz 20ms frames  ⇄  OpenAI PCM16
// Low-latency, single consistent voice: alloy

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const OPENAI_WS_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// -------------------- Web server (health) --------------------
const app = express();
app.get("/healthz", (_, res) => res.status(200).send("ok"));

const server = app.listen(process.env.PORT || 8080, () => {
  console.log("Bridge listening on", server.address().port);
});

// -------------------- Twilio WS endpoint --------------------
const wss = new WebSocketServer({ server, path: "/stream" });

// ---------- G.711 μ-law helpers ----------
const MULAW_EXPAND = new Int16Array(256);
(function buildMuLawTable() {
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
    sample -= 0x84; // bias (132)
    MULAW_EXPAND[i] = sign ? -sample : sample;
  }
})();
function muLawDecodeToPcm16(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = MULAW_EXPAND[u8[i]];
  return out;
}
function pcm16ToMuLaw(int16) {
  const BIAS = 0x84, CLIP = 32635;
  const out = new Uint8Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    let pcm = int16[i];
    const sign = (pcm >> 8) & 0x80;
    if (pcm < 0) pcm = -pcm;
    if (pcm > CLIP) pcm = CLIP;
    pcm += BIAS;
    let exponent = 7;
    for (let m = 0x4000; (pcm & m) === 0 && exponent > 0; exponent--, m >>= 1) {}
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

// 8 kHz -> 16 kHz (simple duplication)
function upsample8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) {
    out[j] = pcm8k[i];
    out[j + 1] = pcm8k[i];
  }
  return out;
}
// Decimate by integer factor (24k -> 8k uses factor=3)
function downsampleIntFactor(int16, factor) {
  const len = Math.floor(int16.length / factor);
  const out = new Int16Array(len);
  for (let i = 0, j = 0; j < len; i += factor, j++) out[j] = int16[i];
  return out;
}
function int16ToBase64(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString("base64");
}
function base64ToUint8(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
function muLawToBase64(u8) {
  return Buffer.from(u8).toString("base64");
}

// -------------------- OpenAI connect helper --------------------
function connectOpenAI() {
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    };
    const client = new WebSocket(OPENAI_WS_URL, { headers });

    client.on("open", () => {
      // Session config: British English, alloy, server VAD, audio in/out specs
      const sessionUpdate = {
        type: "session.update",
        session: {
          instructions:
            "You are the SmartFlows phone agent. Keep replies to 1–2 sentences, friendly, British English. Ask a helpful question when appropriate.",
          voice: "alloy",
          modalities: ["audio", "text"],
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200,
            create_response: true,
            interrupt_response: true
          },
          input_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
          output_audio_format: { type: "pcm16", sample_rate_hz: 24000 }
        }
      };
      client.send(JSON.stringify(sessionUpdate));

      // Immediate greeting so the caller hears something right away
      client.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: "Hi, you’re speaking to the SmartFlows assistant. How can I help today?"
        }
      }));

      resolve(client);
    });

    client.on("error", (e) => {
      console.error("OpenAI WS error:", e);
      reject(e);
    });
    client.on("close", (code, reason) => {
      console.log("OpenAI WS closed:", code, reason?.toString?.());
    });
  });
}

// -------------------- Main WS bridge --------------------
wss.on("connection", async (twilioWs) => {
  console.log("Twilio connected");
  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

  try {
    openaiWs = await connectOpenAI();
    openaiReady = true;
  } catch (e) {
    try { twilioWs.close(1011, "OpenAI unavailable"); } catch {}
    return;
  }

  // Buffer for PCM from OpenAI (we'll flush to μ-law frames)
  let outPcmBuffer = new Int16Array(0);
  function flushToTwilioMuLaw() {
    if (!streamSid || outPcmBuffer.length === 0) return;
    // 24 kHz -> 8 kHz
    const pcm8k = downsampleIntFactor(outPcmBuffer, 3);
    const ulaw = pcm16ToMuLaw(pcm8k);

    // Send 20ms frames (160 samples @ 8kHz)
    const frameLen = 160;
    for (let i = 0; i < ulaw.length; i += frameLen) {
      const frame = ulaw.subarray(i, Math.min(i + frameLen, ulaw.length));
      if (frame.length < frameLen) break; // drop tail
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: muLawToBase64(frame) }
      }));
    }
    outPcmBuffer = new Int16Array(0);
  }

  // ---- OpenAI -> audio deltas ----
  openaiWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Newer event
      if (msg.type === "response.audio.delta" && msg.delta) {
        const pcm = new Int16Array(Buffer.from(msg.delta, "base64").buffer);
        const merged = new Int16Array(outPcmBuffer.length + pcm.length);
        merged.set(outPcmBuffer, 0);
        merged.set(pcm, outPcmBuffer.length);
        outPcmBuffer = merged;
        flushToTwilioMuLaw();
        return;
      }
      // Back-compat
      if (msg.type === "output_audio.delta" && msg.audio) {
        const pcm = new Int16Array(Buffer.from(msg.audio, "base64").buffer);
        const merged = new Int16Array(outPcmBuffer.length + pcm.length);
        merged.set(outPcmBuffer, 0);
        merged.set(pcm, outPcmBuffer.length);
        outPcmBuffer = merged;
        flushToTwilioMuLaw();
        return;
      }
      if (msg.type === "response.completed") {
        flushToTwilioMuLaw();
        return;
      }
    } catch {
      // ignore non-JSON/binary we don't recognise
    }
  });

  openaiWs.on("close", () => {
    openaiReady = false;
    try { twilioWs.close(); } catch {}
  });

  // ---- Twilio -> audio frames ----
  // Twilio sends JSON: {event:"start"|"media"|"stop"|...}
  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
case "start":
  streamSid = data.start.streamSid;
  console.log("Twilio stream started:", streamSid);
  // flush any greeting audio that arrived before streamSid was set
  flushToTwilioMuLaw();
  setTimeout(flushToTwilioMuLaw, 50); // tiny safety flush
  break;


      case "media":
        if (!openaiReady) break;
        // Twilio media payload is base64 μ-law @ 8 kHz
        try {
          const ulaw = base64ToUint8(data.media.payload);
          const pcm8k = muLawDecodeToPcm16(ulaw);
          const pcm16k = upsample8kTo16k(pcm8k);
          const b64pcm16 = int16ToBase64(pcm16k);
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: b64pcm16
          }));
          // Rely on server VAD to detect silence and create responses
        } catch (e) {
          console.error("Decode/forward error:", e);
        }
        break;

      case "stop":
        console.log("Twilio stream stopped");
        try { openaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
        break;

      default:
        // mark, clear, dtmf, etc. (not required here)
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    try { openaiWs.close(); } catch {}
  });
});
