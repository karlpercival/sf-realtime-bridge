// server.js — Twilio <-> OpenAI Realtime (Node 20, ESM)
// ✓ Accepts Twilio subprotocol "audio" (fixes 31921)
// ✓ 20ms pacing of μ-law frames (160 @ 8kHz)
// ✓ 1s test beep, echo fallback, and OpenAI "alloy" replies
// ENV: OPENAI_API_KEY must be set on Railway

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}
const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// ---------- tiny HTTP (health) ----------
const app = express();
app.get("/healthz", (_, res) => res.status(200).send("ok"));
const server = app.listen(process.env.PORT || 8080, () => {
  console.log("Bridge listening on", server.address().port);
});

// ---------- μ-law helpers ----------
const MULAW_EXPAND = new Int16Array(256);
(function () {
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff, sign = mu & 0x80, exp = (mu >> 4) & 0x07, man = mu & 0x0f;
    let sample = ((man << 4) + 0x08) << (exp + 3);
    sample -= 0x84; // 132
    MULAW_EXPAND[i] = sign ? -sample : sample;
  }
})();
function muLawDecodeToPcm16(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    out[i] = MULAW_EXPAND[u8[i]];   // ← correct indexing (no assignment to i)
  }
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
    let exp = 7;
    for (let m = 0x4000; (pcm & m) === 0 && exp > 0; exp--, m >>= 1) {}
    const man = (pcm >> (exp + 3)) & 0x0f;
    out[i] = ~(sign | (exp << 4) | man) & 0xff;
  }
  return out;
}
// 8k -> 16k (duplicate)
function upsample8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) { out[j] = pcm8k[i]; out[j + 1] = pcm8k[i]; }
  return out;
}
// 24k -> 8k (decimate by 3)
function downsampleIntFactor(int16, factor) {
  const len = Math.floor(int16.length / factor);
  const out = new Int16Array(len);
  for (let i = 0, j = 0; j < len; i += factor, j++) out[j] = int16[i];
  return out;
}

const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
const i16ToB64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString("base64");
const u8ToB64  = (u8)  => Buffer.from(u8).toString("base64");

// ---------- WS endpoint (accept Twilio 'audio' subprotocol) ----------
const wss = new WebSocketServer({
  server,
  path: "/stream",
  handleProtocols: (protocols) => (protocols.includes("audio") ? "audio" : false)
});

wss.on("connection", async (twilioWs) => {
  console.log("Twilio connected; subprotocol:", twilioWs.protocol);

  let streamSid = null;
  const queue = [];

  // 20 ms pacer — MUST use WebSocket.OPEN
  const pacer = setInterval(() => {
    if (!streamSid || queue.length === 0 || twilioWs.readyState !== WebSocket.OPEN) return;
    const frame = queue.shift(); // Uint8Array(160)
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: u8ToB64(frame) } // exact shape Twilio expects
    }));
  }, 20);

  // ---- OpenAI Realtime ----
  let openaiWs = null;
  let openaiReady = false;

  try {
    openaiWs = new WebSocket(OPENAI_WS_URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });

openaiWs.on("open", () => {
  // Force British English input + output
  openaiWs.send(JSON.stringify({
    type: "session.update",
    session: {
      instructions:
        "You are the SmartFlows phone agent. ALWAYS respond in British English only. Never switch languages. Keep replies to 1–2 sentences and end with a helpful question when appropriate.",
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
      output_audio_format: { type: "pcm16", sample_rate_hz: 24000 },
      // IMPORTANT: force STT to English
      input_audio_transcription: { language: "en" }
    }
  }));

  // Optional greeting in English so the first voice you hear is correct
  openaiWs.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio"],
      instructions: "Hello, you’re speaking to the SmartFlows assistant. How can I help today?"
    }
  }));
});


      // Optional greeting so line feels responsive
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"], instructions: "Hello—how can I help today?" }
      }));

      openaiReady = true;
      console.log("OpenAI connected");
    });

    // OpenAI -> audio deltas -> μ-law frames -> queue
    openaiWs.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());

        // Current event
        if (msg.type === "response.output_audio.delta" && msg.delta) {
          const raw = Buffer.from(msg.delta, "base64");
          const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
          const pcm8k = downsampleIntFactor(pcm, 3);
          const ulaw = pcm16ToMuLaw(pcm8k);
          for (let i = 0; i + 160 <= ulaw.length; i += 160) queue.push(ulaw.subarray(i, i + 160));
          return;
        }
        // Fallback names
        if (msg.type === "response.audio.delta" && (msg.delta || msg.audio)) {
          const raw = Buffer.from(msg.delta || msg.audio, "base64");
          const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
          const pcm8k = downsampleIntFactor(pcm, 3);
          const ulaw = pcm16ToMuLaw(pcm8k);
          for (let i = 0; i + 160 <= ulaw.length; i += 160) queue.push(ulaw.subarray(i, i + 160));
          return;
        }
        if (msg.type === "output_audio.delta" && msg.audio) {
          const raw = Buffer.from(msg.audio, "base64");
          const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
          const pcm8k = downsampleIntFactor(pcm, 3);
          const ulaw = pcm16ToMuLaw(pcm8k);
          for (let i = 0; i + 160 <= ulaw.length; i += 160) queue.push(ulaw.subarray(i, i + 160));
          return;
        }
      } catch {
        // ignore non-JSON frames
      }
    });

    openaiWs.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));
    openaiWs.on("close", (c, r) => { console.log("OpenAI WS closed:", c, r?.toString?.()); openaiReady = false; });

  } catch (e) {
    console.error("OpenAI connect failed:", e?.message || e);
  }

  // ---- Twilio -> (OpenAI or echo) ----
  let debugCount = 0;
  twilioWs.on("message", (msg) => {
    const txt = msg.toString();
    let data; try { data = JSON.parse(txt); } catch { console.log("non-JSON from Twilio:", txt.slice(0,120)); return; }

    if (debugCount < 5 && data.event !== "media") {
      console.log("Twilio event:", data.event, JSON.stringify(data).slice(0, 200));
      debugCount++;
    }

    switch (data.event) {
      case "start": {
        streamSid = data.start?.streamSid || data.streamSid || null;
        console.log("Twilio stream started:", streamSid);

        // 1 s test beep so caller hears something immediately
        const frames = 50, samplesPerFrame = 160, total = frames * samplesPerFrame;
        const tonePcm = new Int16Array(total);
        for (let i = 0; i < total; i++) {
          const s = Math.sin(2 * Math.PI * 1000 * (i / 8000)); // 1 kHz
          tonePcm[i] = Math.round(s * 12000);
        }
        const toneU = pcm16ToMuLaw(tonePcm);
        for (let i = 0; i + samplesPerFrame <= toneU.length; i += samplesPerFrame) {
          queue.push(toneU.subarray(i, i + samplesPerFrame));
        }
        break;
      }

      case "media": {
        try {
          const ulaw = b64ToU8(data.media?.payload || "");
          if (ulaw.length !== 160) break;

          if (openaiReady && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            // 8k μ-law -> 16k PCM16 -> OpenAI
            const pcm8k  = muLawDecodeToPcm16(ulaw);
            const pcm16k = upsample8kTo16k(pcm8k);
            const b64pcm16 = i16ToB64(pcm16k);
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64pcm16 }));

            // Force a reply every ~1s of caller audio
            globalThis._frames = (globalThis._frames || 0) + 1;
            if (globalThis._frames % 50 === 0) {
              openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              openaiWs.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
              console.log("Committed audio & requested response");
            }
          } else {
            // Echo until OpenAI is ready
            queue.push(ulaw);
          }
        } catch (e) {
          console.error("Media forward error:", e?.message || e);
        }
        break;
      }

      case "stop": {
        console.log("Twilio stream stopped");
        try { openaiWs?.close(); } catch {}
        try { twilioWs.close(); } catch {}
        break;
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    clearInterval(pacer);
    try { openaiWs?.close(); } catch {}
  });

  twilioWs.on("error", (e) => console.error("Twilio WS error:", e?.message || e));
});

