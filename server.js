// server.js — Twilio <-> OpenAI Realtime (Node 20, ESM)
// - Accept Twilio WS subprotocol "audio" (fixes 31921)
// - 1s beep on connect; echo caller UNTIL assistant speaks
// - British English only; alloy voice; server-side VAD
// - 20ms μ-law pacing; correct μ-law encode/decode
//
// ENV: set OPENAI_API_KEY

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

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
    sample -= 0x84; // bias 132
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
    let exp = 7;
    for (let m = 0x4000; (pcm & m) === 0 && exp > 0; exp--, m >>= 1) {}
    const man = (pcm >> (exp + 3)) & 0x0f;
    out[i] = ~(sign | (exp << 4) | man) & 0xff;
  }
  return out;
}
function upsample8kTo16k(pcm8k) {
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) { out[j] = pcm8k[i]; out[j + 1] = pcm8k[i]; }
  return out;
}
function downsampleIntFactor(int16, factor) {
  const len = Math.floor(int16.length / factor);
  const out = new Int16Array(len);
  for (let i = 0, j = 0; j < len; i += factor, j++) out[j] = int16[i];
  return out;
}
const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
const i16ToB64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString("base64");
const u8ToB64  = (u8)  => Buffer.from(u8).toString("base64");

// ---------- WS endpoint (accept Twilio subprotocol "audio") ----------
const wss = new WebSocketServer({
  server,
  path: "/stream",
  handleProtocols: (protocols) => (protocols.includes("audio") ? "audio" : false)
});

wss.on("connection", async (twilioWs) => {
  console.log("Twilio connected; subprotocol:", twilioWs.protocol);

  let streamSid = null;

  // Outbound queue + 20 ms pacer
  const queue = [];
  const pacer = setInterval(() => {
    if (!streamSid || queue.length === 0 || twilioWs.readyState !== WebSocket.OPEN) return;
    const frame = queue.shift(); // Uint8Array(160) = 20ms @ 8kHz μ-law
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: u8ToB64(frame) }
    }));
  }, 20);

  // ---- OpenAI Realtime ----
  let openaiWs = null;
  let openaiReady = false;

  // Assistant speaking flag + helpers (controls echo)
  let assistantSpeaking = false;
  let speakingResetTimer = null;
  const markAssistantSpeaking = () => {
    if (!assistantSpeaking) console.log("Assistant started speaking");
    assistantSpeaking = true;
    if (speakingResetTimer) clearTimeout(speakingResetTimer);
    speakingResetTimer = setTimeout(() => {
      assistantSpeaking = false;
      console.log("Assistant speaking auto-cleared (timeout)");
    }, 800);
  };
  const clearAssistantSpeaking = () => {
    if (assistantSpeaking) console.log("Assistant finished speaking");
    assistantSpeaking = false;
    if (speakingResetTimer) { clearTimeout(speakingResetTimer); speakingResetTimer = null; }
  };

  try {
    openaiWs = new WebSocket(OPENAI_WS_URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });

openaiWs.on("open", () => {
  // 1) Apply session settings (English-only, server VAD, etc.)
  openaiWs.send(JSON.stringify({
    type: "session.update",
    session: {
      instructions:
        "You are the SmartFlows phone agent. RESPOND ONLY IN BRITISH ENGLISH (en-GB). Never use any other language. If the caller speaks another language, apologise briefly and continue in British English. Keep replies to 1–2 short sentences and end with a helpful question when appropriate.",
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
      input_audio_format:  "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { language: "en" }
    }
  }));

  console.log("OpenAI connected (sent session.update, waiting for session.updated)");
});

      // Quick greeting so the line feels alive
openaiWs.send(JSON.stringify({
  type: "response.create",
  response: { modalities: ["audio", "text"], instructions: "Hello—how can I help today?" }
}));
      openaiReady = true;
      console.log("OpenAI connected");
    });

    // OpenAI -> audio deltas -> μ-law frames -> queue (verbose for first 30 events)
    let oaDebug = 0;
    openaiWs.on("message", (buf) => {
      try {
        const txt = buf.toString();
        let msg;
        try { msg = JSON.parse(txt); } catch (e) { console.log("OpenAI non-JSON frame:", txt.slice(0, 120)); return; }

    // ---- GREETING AFTER SETTINGS APPLY ----
    if (msg.type === "session.updated") {
      console.log("OpenAI event: session.updated — settings applied");
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Hello — how can I help today? (British English only.)"
        }
      }));
      return;
    }
        
        if (oaDebug < 30) {
          console.log("OpenAI event:", msg.type, JSON.stringify(msg).slice(0, 240));
          oaDebug++;
        }

        // Primary delta
        if (msg.type === "response.output_audio.delta" && msg.delta) {
          markAssistantSpeaking();
          const raw = Buffer.from(msg.delta, "base64");
          const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
          const pcm8k = downsampleIntFactor(pcm, 3);
          const ulaw = pcm16ToMuLaw(pcm8k);
          for (let i = 0; i + 160 <= ulaw.length; i += 160) queue.push(ulaw.subarray(i, i + 160));
          return;
        }

        // Fallback names seen on some accounts
        if (msg.type === "response.audio.delta" && (msg.delta || msg.audio)) {
          markAssistantSpeaking();
          const raw = Buffer.from(msg.delta || msg.audio, "base64");
          const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
          const pcm8k = downsampleIntFactor(pcm, 3);
          const ulaw = pcm16ToMuLaw(pcm8k);
          for (let i = 0; i + 160 <= ulaw.length; i += 160) queue.push(ulaw.subarray(i, i + 160));
          return;
        }

        if (msg.type === "output_audio.delta" && msg.audio) {
          markAssistantSpeaking();
          const raw = Buffer.from(msg.audio, "base64");
          const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
          const pcm8k = downsampleIntFactor(pcm, 3);
          const ulaw = pcm16ToMuLaw(pcm8k);
          for (let i = 0; i + 160 <= ulaw.length; i += 160) queue.push(ulaw.subarray(i, i + 160));
          return;
        }

        // Text-only visibility
        if (msg.type === "response.output_text.delta" && msg.delta) {
          return;
        }

        // End-of-turn signals → allow echo again
        if (
          msg.type === "response.completed" ||
          msg.type === "response.finished"  ||
          msg.type === "response.output_audio.done" ||
          msg.type === "response.done"
        ) {
          clearAssistantSpeaking();
          return;
        }

        // Error visibility
        if (msg.type === "error" || msg.type === "response.error") {
          console.log("OpenAI error event:", JSON.stringify(msg));
          return;
        }

      } catch (e) {
        console.log("OpenAI message handler error:", e?.message || e);
      }
    });

    openaiWs.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));
    openaiWs.on("close", (c, r) => { console.log("OpenAI WS closed:", c, r ? String(r) : ""); openaiReady = false; });

  } catch (e) {
    console.error("OpenAI connect failed:", e?.message || e);
  }

  // ---- Twilio -> (OpenAI + conditional echo) ----
  let debugCount = 0;
  let frames = 0;

  twilioWs.on("message", (msg) => {
    const txt = msg.toString();
    let data;
    try { data = JSON.parse(txt); } catch (e) { console.log("non-JSON from Twilio:", txt.slice(0,120)); return; }

    if (debugCount < 5 && data.event !== "media") {
      console.log("Twilio event:", data.event, JSON.stringify(data).slice(0, 200));
      debugCount++;
    }

    switch (data.event) {
      case "start": {
        streamSid = data.start?.streamSid || data.streamSid || null;
        console.log("Twilio stream started:", streamSid);

        // 1 s test beep (1 kHz) so caller hears something immediately
        const frames = 50, samplesPerFrame = 160, total = frames * samplesPerFrame;
        const tonePcm = new Int16Array(total);
        for (let i = 0; i < total; i++) {
          const s = Math.sin(2 * Math.PI * 1000 * (i / 8000));
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

          // Always feed OpenAI if connected
          if (openaiReady && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            const pcm8k  = muLawDecodeToPcm16(ulaw);
            const pcm16k = upsample8kTo16k(pcm8k);
            const b64pcm16 = i16ToB64(pcm16k);
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64pcm16 }));

            // Light periodic commit (no response.create; server VAD handles replies)
            frames = (frames + 1) % 1000000;
            if (frames % 60 === 0) {
              openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            }
          }

          // Echo caller UNTIL assistant starts talking
          if (!assistantSpeaking) {
            queue.push(ulaw);
          }
        } catch (e) {
          console.error("Media forward error:", e?.message || e);
        }
        break;
      }

      case "stop": {
        console.log("Twilio stream stopped");
        try { openaiWs?.close(); } catch (e) {}
        try { twilioWs.close(); } catch (e) {}
        break;
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    clearInterval(pacer);
    try { openaiWs?.close(); } catch (e) {}
  });

  twilioWs.on("error", (e) => console.error("Twilio WS error:", e?.message || e));
}); // final line — no extra closers below

