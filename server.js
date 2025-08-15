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

  // Controls echo
  let assistantSpeaking = false;
  let speakingResetTimer = null;
const markAssistantSpeaking = () => {
  if (!assistantSpeaking) console.log("Assistant started speaking");
  assistantSpeaking = true;
  if (speakingResetTimer) clearTimeout(speakingResetTimer);

  // Reset VAD counters so we never commit while the assistant is talking
  appendedMs = 0;
  silenceCount = 0;
  heardSpeech = false;

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
      // Apply session settings (English-only, server VAD, etc.)
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are the SmartFlows phone agent. RESPOND ONLY IN BRITISH ENGLISH (en-GB). Never use any other language. Keep replies to 1–2 short sentences and end with a helpful question when appropriate.",
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
          input_audio_transcription: { model: "gpt-4o-transcribe", language: "en" }
        }
      }));
      console.log("OpenAI connected (sent session.update, waiting for session.updated)");
      openaiReady = true;
    });

    // OpenAI -> audio deltas -> μ-law frames -> queue (verbose for first 30 events)
    let oaDebug = 0;
    openaiWs.on("message", (buf) => {
      const txt = buf.toString();

      // Parse once, tight try/catch
      let msg;
      try {
        msg = JSON.parse(txt);
      } catch (e) {
        console.log("OpenAI non-JSON frame:", txt.slice(0, 120));
        return;
      }

      // After settings apply, send the greeting
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

      // Verbose: show first 30 events
      if (oaDebug < 30) {
        console.log("OpenAI event:", msg.type, JSON.stringify(msg).slice(0, 240));
        oaDebug++;
      }

      // Primary audio delta
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
    });

    openaiWs.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));
    openaiWs.on("close", (c, r) => {
      console.log("OpenAI WS closed:", c, r ? String(r) : "");
      openaiReady = false;
    });

  } catch (e) {
    console.error("OpenAI connect failed:", e?.message || e);
  }

  // ---- Twilio -> (OpenAI + conditional echo) ----
  let debugCount = 0;
  let frames = 0;
  
// Fallback VAD (commit-on-silence)
let appendedMs = 0;            // how much audio we've sent since last commit
let silenceCount = 0;          // consecutive 20ms frames below threshold
const SILENCE_FRAMES = 20;     // 20 * 20ms = ~400ms of silence
const SILENCE_THRESH = 600;    // simple peak threshold on 16-bit PCM
let heardSpeech = false;       // have we detected any speech since last commit?
  

  

  twilioWs.on("message", (msg) => {
    const txt = msg.toString();

    // Parse Twilio JSON safely
    let data;
    try {
      data = JSON.parse(txt);
    } catch (e) {
      console.log("non-JSON from Twilio:", txt.slice(0,120));
      return;
    }

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

      // Append caller audio to OpenAI (20 ms per Twilio frame)
      const b64pcm16 = i16ToB64(pcm16k);
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64pcm16 }));
      appendedMs += 20;

      // Simple energy check to detect speech vs. silence
      let peak = 0;
      for (let i = 0; i < pcm16k.length; i += 16) { // sample ~every 1ms
        const v = pcm16k[i] < 0 ? -pcm16k[i] : pcm16k[i];
        if (v > peak) peak = v;
      }
      if (peak >= SILENCE_THRESH) {
        heardSpeech = true;     // mark that we heard *some* speech since last commit
        silenceCount = 0;       // reset silence run
      } else {
        silenceCount++;
      }

      // Only trigger when:
      // - we heard *some* speech since last commit (avoid pure-silence commits),
      // - we've had ~400 ms of silence (end of user turn),
      // - the assistant is NOT currently speaking (avoid model “talking to itself”).
      if (heardSpeech && !assistantSpeaking && appendedMs >= 200 && silenceCount >= SILENCE_FRAMES) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWs.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));
        console.log("Committed on silence & requested response");
        // reset turn trackers
        appendedMs = 0;
        silenceCount = 0;
        heardSpeech = false;
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
