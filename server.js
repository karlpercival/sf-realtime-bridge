// Minimal Twilio <-> OpenAI Realtime bridge (μ-law 8kHz <-> PCM16 16/24kHz)
// Env required on Railway: OPENAI_API_KEY (and Railway sets PORT)

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();
app.get("/healthz", (_, res) => res.status(200).send("ok"));

const server = app.listen(process.env.PORT || 8080, () => {
  console.log("Bridge listening on", server.address().port);
});

const wss = new WebSocketServer({ server, path: "/stream" });

// ---------- G.711 μ-law utilities ----------
const MULAW_EXPAND = new Int16Array(256);
(function buildMuLawTable() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    let sign = mu & 0x80;
    let exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0f;
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
  const BIAS = 0x84;
  const CLIP = 32635;
  const out = new Uint8Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    let pcm = int16[i];
    let sign = (pcm >> 8) & 0x80;
    if (pcm < 0) pcm = -pcm;
    if (pcm > CLIP) pcm = CLIP;
    pcm += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

// 8k -> 16k (simple 2x upsample by duplication)
function upsample8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) {
    out[j] = pcm8k[i];
    out[j + 1] = pcm8k[i];
  }
  return out;
}

// 24k -> 8k (naive decimation by factor 3)
function downsampleIntFactor(int16, factor) {
  const len = Math.floor(int16.length / factor);
  const out = new Int16Array(len);
  for (let i = 0, j = 0; j < len; i += factor, j++) out[j] = int16[i];
  return out;
}

function int16ToBase64(int16) {
  const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  return buf.toString("base64");
}
function base64ToUint8(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
function muLawToBase64(u8) {
  return Buffer.from(u8).toString("base64");
}

const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

wss.on("connection", async (twilioWs) => {
  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;

  // Connect to OpenAI Realtime WS
  function connectOpenAI() {
    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      };
      const client = new WebSocket(OPENAI_WS_URL, { headers });

client.on("open", () => {
  // Configure session: British English + alloy voice + server VAD
  const sessionUpdate = {
    type: "session.update",
    session: {
      instructions:
        "You are the SmartFlows phone agent. Keep replies to 1–2 sentences, friendly, British English.",
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

  // Immediate greeting so the caller hears something straightaway
  client.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio"],
      instructions: "Hi, you’re speaking to the SmartFlows assistant. How can I help today?"
    }
  }));

  resolve(client);
});

  }

  try {
    openaiWs = await connectOpenAI();
    openaiReady = true;
  } catch (e) {
    console.error("OpenAI WS connect error:", e);
    twilioWs.close(1011, "OpenAI unavailable");
    return;
  }

  let outPcmBuffer = new Int16Array(0);

  function flushToTwilioMuLaw() {
    if (!streamSid || outPcmBuffer.length === 0) return;
    // 24 kHz -> 8 kHz
    const pcm8k = downsampleIntFactor(outPcmBuffer, 3);
    const ulaw = pcm16ToMuLaw(pcm8k);

    // Send in 20ms frames (160 samples @ 8kHz)
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

  // OpenAI → audio deltas
  openaiWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if ((msg.type === "output_audio.delta" || msg.type === "response.output_audio.delta") && msg.audio) {
        const pcm = new Int16Array(Buffer.from(msg.audio, "base64").buffer);
        const merged = new Int16Array(outPcmBuffer.length + pcm.length);
        merged.set(outPcmBuffer, 0);
        merged.set(pcm, outPcmBuffer.length);
        outPcmBuffer = merged;
        flushToTwilioMuLaw();
      }
    } catch {
      // ignore binary frames we don't recognise
    }
  });

  openaiWs.on("close", () => {
    openaiReady = false;
    try { twilioWs.close(); } catch {}
  });

  // Twilio → OpenAI
  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        break;

      case "media":
        if (!openaiReady) break;
        // Twilio media is base64 μ-law @ 8kHz
        const ulaw = base64ToUint8(data.media.payload);
        const pcm8k = muLawDecodeToPcm16(ulaw);
        const pcm16k = upsample8kTo16k(pcm8k);
        const b64pcm16 = int16ToBase64(pcm16k);
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: b64pcm16
        }));
        break;

      case "stop":
        try { openaiWs.close(); } catch {}
        try { twilioWs.close(); } catch {}
        break;
    }
  });

  twilioWs.on("close", () => {
    try { openaiWs.close(); } catch {}
  });
});
