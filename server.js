// server.js — Twilio <-> OpenAI Realtime bridge (ESM, Node 20)
// Env var required on Railway: OPENAI_API_KEY
// Twilio <Connect><Stream track="both"> ↔ this WS at /stream
// Sends/receives 20 ms μ-law (PCMU) frames to Twilio; uses OpenAI "alloy" voice.

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY"); process.exit(1);
}

const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// -------------------- tiny HTTP (health) --------------------
const app = express();
app.get("/healthz", (_, res) => res.status(200).send("ok"));
const server = app.listen(process.env.PORT || 8080, () => {
  console.log("Bridge listening on", server.address().port);
});

// -------------------- Twilio WS endpoint --------------------
const wss = new WebSocketServer({ server, path: "/stream" });

// ---------- μ-law helpers ----------
const MULAW_EXPAND = new Int16Array(256);
(function buildMuLawTable() {
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff;
    const sign = mu & 0x80;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
    sample -= 0x84;
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
// 8 kHz -> 16 kHz (dup)
function upsample8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) { out[j] = pcm8k[i]; out[j + 1] = pcm8k[i]; }
  return out;
}
// decimate by integer factor (e.g., 24k -> 8k : factor=3)
function downsampleIntFactor(int16, factor) {
  const len = Math.floor(int16.length / factor);
  const out = new Int16Array(len);
  for (let i = 0, j = 0; j < len; i += factor, j++) out[j] = int16[i];
  return out;
}
const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
const i16ToB64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString("base64");
const u8ToB64  = (u8)  => Buffer.from(u8).toString("base64");

// -------------------- OpenAI connect --------------------
function connectOpenAI() {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" };
    const client = new WebSocket(OPENAI_WS_URL, { headers });

    client.on("open", () => {
      // Session config: British English, alloy, server VAD
      client.send(JSON.stringify({
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
          input_audio_format:  { type: "pcm16", sample_rate_hz: 16000 },
          output_audio_format: { type: "pcm16", sample_rate_hz: 24000 }
        }
      }));

      // Immediate greeting (so caller hears something)
      client.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"], instructions: "Hi, you’re speaking to the SmartFlows assistant. How can I help today?" }
      }));

      resolve(client);
    });

    client.on("error", (e) => { console.error("OpenAI WS error:", e); reject(e); });
    client.on("close", (c, r) => { console.log("OpenAI WS closed:", c, r?.toString?.()); });
  });
}

// -------------------- Bridge --------------------
wss.on("connection", async (twilioWs) => {
  console.log("Twilio connected");
  let streamSid = null;
  let openaiWs   = null;
  let openaiReady = false;

  // queue of μ-law 20ms frames to send to Twilio
  const ulawQueue = [];
  let txTimer = null;

  function startPacer() {
    if (txTimer) return;
    txTimer = setInterval(() => {
      if (!streamSid || ulawQueue.length === 0 || twilioWs.readyState !== WebSocket.OPEN) return;
      const frame = ulawQueue.shift(); // Uint8Array length 160
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: u8ToB64(frame) }
      }));
    }, 20); // 20 ms per frame
  }
  function stopPacer() { if (txTimer) { clearInterval(txTimer); txTimer = null; } }

try {
  openaiWs = await connectOpenAI();
  openaiReady = true;
} catch (e) {
  console.error("OpenAI connect failed (continuing without it):", e?.message || e);
  openaiReady = false; // keep Twilio stream alive so we can test outbound audio
}


  // OpenAI -> build μ-law frames and enqueue (with proper Int16 view)
  openaiWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // New event name (preferred)
      if (msg.type === "response.audio.delta" && (msg.delta || msg.audio)) {
        const buf = Buffer.from((msg.delta || msg.audio), "base64");
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2)); // correct view
        const pcm8k = downsampleIntFactor(pcm, 3);
        const ulaw  = pcm16ToMuLaw(pcm8k);

        // split into 20ms frames @ 8kHz = 160 samples
        for (let i = 0; i + 160 <= ulaw.length; i += 160) {
          ulawQueue.push(ulaw.subarray(i, i + 160));
        }
        startPacer();
        return;
      }

      // Back-compat event
      if (msg.type === "output_audio.delta" && msg.audio) {
        const buf = Buffer.from(msg.audio, "base64");
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
        const pcm8k = downsampleIntFactor(pcm, 3);
        const ulaw  = pcm16ToMuLaw(pcm8k);
        for (let i = 0; i + 160 <= ulaw.length; i += 160) {
          ulawQueue.push(ulaw.subarray(i, i + 160));
        }
        startPacer();
        return;
      }

      if (msg.type === "response.completed") {
        // leave pacer running until queue empties
        return;
      }
    } catch {
      // non-JSON frames can be ignored
    }
  });

  openaiWs.on("close", () => { openaiReady = false; });

  // Twilio -> relay caller audio to OpenAI
// ---- Twilio -> audio frames (with debug logging of first few events) ----
let debugCount = 0;

twilioWs.on("message", (msg) => {
  const txt = msg.toString();
  let data;
  try { data = JSON.parse(txt); }
  catch { console.log("Twilio non-JSON:", txt.slice(0,120)); return; }

  // Log the first few non-media events so we can see the real event names/payloads
  if (debugCount < 5 && data.event !== "media") {
    console.log("Twilio event:", data.event, JSON.stringify(data).slice(0,300));
    debugCount++;
  }

  switch (data.event) {
    case "start":
      streamSid = data.start?.streamSid || data.streamSid || null;
      console.log("Twilio stream started:", streamSid);

      // --- TEST TONE: 1 second of 1 kHz so we can verify outbound audio path ---
      try {
        const frames = 50;                  // 50 * 20ms = 1 second
        const samplesPerFrame = 160;        // 20ms @ 8kHz
        const totalSamples = frames * samplesPerFrame;

        // Build a 1 kHz sine tone at 8 kHz, amplitude ~12k
        const tonePcm = new Int16Array(totalSamples);
        for (let i = 0; i < totalSamples; i++) {
          const s = Math.sin(2 * Math.PI * 1000 * (i / 8000));
          tonePcm[i] = Math.round(s * 12000);
        }

        // Encode to μ-law and enqueue as 20ms frames
        const toneUlaw = pcm16ToMuLaw(tonePcm);
        for (let i = 0; i + samplesPerFrame <= toneUlaw.length; i += samplesPerFrame) {
          ulawQueue.push(toneUlaw.subarray(i, i + samplesPerFrame));
        }
        startPacer(); // ensure the 20ms sender is running
      } catch (e) {
        console.error("Test tone error:", e);
      }
      // -------------------------------------------------------------------------
      break;

    case "media":
      if (!openaiReady) break;
      try {
        // Twilio sends base64 μ-law @ 8 kHz
        const ulaw = b64ToU8(data.media.payload);
        const pcm8k = muLawDecodeToPcm16(ulaw);
        const pcm16k = upsample8kTo16k(pcm8k);
        const b64pcm16 = i16ToB64(pcm16k);
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64pcm16 }));
      } catch (e) {
        console.error("Decode/forward error:", e);
      }
      break;

    case "stop":
      console.log("Twilio stream stopped");
      stopPacer();
      try { openaiWs.close(); } catch {}
      try { twilioWs.close(); } catch {}
      break;

    default:
      // Keep logging unexpected events so we can adapt if names differ
      console.log("Twilio unhandled event:", data.event);
      break;
  }
});

  twilioWs.on("close", () => {
    stopPacer();
    try { openaiWs.close(); } catch {}
    console.log("Twilio WS closed");
  });
});
