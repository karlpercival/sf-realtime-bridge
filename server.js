// server.js — Twilio <-> OpenAI Realtime (Node 20, ESM)
// - Accepts Twilio WS subprotocol "audio"
// - Plays a 1s beep, echoes caller UNTIL assistant starts talking
// - Uses per-call instructions from Twilio <Parameter name="inst"> OR local defaults by Assistant ID
// - Forces British English; alloy voice; server-side VAD
// - Correct μ-law pacing and 24k<->8k conversion

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || ""; // optional, if you use projects

const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// ---------- Local default prompts (used if 'inst' not provided) ----------
const DEFAULT_PROMPTS = {
  // Amy
  "asst_9BHzwy5FsQJqHr2OZgY8Clg9":
    `You are Amy, a warm, concise British PA for SmartFlows. Always speak British English. Greet once, then listen. Keep replies to 1–2 short sentences, ask one helpful question when appropriate, never talk over the caller, and pause if they’re speaking. First line: “This is Amy. How can I help today?”`,
};

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

// ---------- Optional: fetch Assistant instructions (only used if no inst + no local default) ----------
async function fetchAssistantInstructions(assistantId) {
  if (!assistantId || !assistantId.startsWith("asst_")) return "";
  try {
    const headers = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    };
    if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;

    const r = await fetch(`https://api.openai.com/v1/assistants/${assistantId}`, { headers });
    const txt = await r.text();
    if (!r.ok) {
      console.log("Assistant fetch failed:", r.status, txt);
      return "";
    }
    const j = JSON.parse(txt);
    return (j.instructions || j?.metadata?.instructions || j?.metadata?.prompt || "").toString();
  } catch (e) {
    console.log("Assistant fetch failed (network):", e?.message || e);
    return "";
  }
}

// ---------- WS endpoint (accept Twilio subprotocol "audio") ----------
const wss = new WebSocketServer({
  server,
  path: "/stream",
  handleProtocols: (protocols) => (protocols.includes("audio") ? "audio" : false),
});

wss.on("connection", async (twilioWs) => {
  console.log("Twilio connected; subprotocol:", twilioWs.protocol);

  // Per-connection state
  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;
  let twilioStarted = false;
  let sessionApplied = false;
  let assistantSpeaking = false;

  let pendingInstructions = ""; // from inst or defaults
  let pendingAssistantId = "";

  // Outbound queue -> Twilio @ 20 ms
  const queue = [];
  const pacer = setInterval(() => {
    if (!streamSid || queue.length === 0 || twilioWs.readyState !== WebSocket.OPEN) return;
    const frame = queue.shift(); // Uint8Array(160) = 20ms @ 8kHz
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: u8ToB64(frame) }
    }));
  }, 20);

  // ----- Helper: apply session.update when both sides are ready -----
  function applySessionUpdateIfReady() {
    if (!openaiReady || !twilioStarted || sessionApplied) return;

    const finalInstructions =
      (pendingInstructions ? pendingInstructions + "\n\n" : "") +
      "System: Speak British English only. Keep replies brief (1–2 sentences). Do not talk over the caller. If the caller is speaking, pause and wait.";

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: finalInstructions,
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
        input_audio_transcription: { language: "en", model: "gpt-4o-transcribe" }
      }
    }));

    sessionApplied = true;
    console.log("Sent session.update (length:", finalInstructions.length, ")");
  }

  // ----- OpenAI Realtime connection -----
  try {
    const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" };
    if (OPENAI_PROJECT) headers["OpenAI-Project"] = OPENAI_PROJECT;

    openaiWs = new WebSocket(OPENAI_WS_URL, { headers });

    openaiWs.on("open", () => {
      openaiReady = true;
      console.log("OpenAI connected (awaiting session.update trigger)");
      applySessionUpdateIfReady();
    });

    // OpenAI -> audio deltas -> μ-law frames -> queue
    let oaDebug = 0;
    openaiWs.on("message", (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      if (oaDebug < 20) {
        console.log("OpenAI event:", msg.type);
        oaDebug++;
      }

      if (msg.type === "session.updated") {
        console.log("OpenAI event: session.updated — settings applied");
        // Nudge a first line; instructions already carry the greeting policy
        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio", "text"], instructions: " " }
        }));
        return;
      }

      // Primary names observed across versions
      const b64 =
        (msg.type === "response.output_audio.delta" && msg.delta) ? msg.delta :
        (msg.type === "response.audio.delta"       && msg.delta) ? msg.delta :
        (msg.type === "output_audio.delta"         && msg.audio) ? msg.audio :
        null;

      if (b64) {
        if (!assistantSpeaking) {
          assistantSpeaking = true;
          console.log("Assistant started speaking");
        }
        const raw = Buffer.from(b64, "base64");
        const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
        const pcm8k = downsampleIntFactor(pcm, 3); // 24k -> 8k
        const ulaw = pcm16ToMuLaw(pcm8k);
        for (let i = 0; i + 160 <= ulaw.length; i += 160) queue.push(ulaw.subarray(i, i + 160));
        return;
      }

      if (msg.type === "response.completed" || msg.type === "response.audio.done" || msg.type === "response.done") {
        console.log("Assistant finished speaking");
      }
    });

    openaiWs.on("error", (e) => console.error("OpenAI WS error:", e?.message || e));
    openaiWs.on("close", (c, r) => { console.log("OpenAI WS closed:", c, r?.toString?.()); openaiReady = false; });

  } catch (e) {
    console.error("OpenAI connect failed:", e?.message || e);
  }

  // ----- Twilio -> (OpenAI + conditional echo) -----
  let debugCount = 0;

  async function handleStartEvent(data) {
    streamSid = data.start?.streamSid || data.streamSid || null;
    console.log("Twilio stream started:", streamSid);

    const cp = data.start?.customParameters || {};
    console.log("Received customParameters:", cp);

    pendingAssistantId = (typeof cp.sym === "string") ? cp.sym.trim() : "";
    const passedInst    = (typeof cp.inst === "string") ? cp.inst.trim() : "";

    if (passedInst) {
      pendingInstructions = passedInst;
      console.log("Using instructions from inst param (len):", pendingInstructions.length);
    } else if (pendingAssistantId && DEFAULT_PROMPTS[pendingAssistantId]) {
      pendingInstructions = DEFAULT_PROMPTS[pendingAssistantId];
      console.log("Using local default prompt for", pendingAssistantId, "(len):", pendingInstructions.length);
    } else if (pendingAssistantId) {
      const fetched = await fetchAssistantInstructions(pendingAssistantId);
      if (fetched) {
        pendingInstructions = fetched;
        console.log("Using fetched assistant instructions (len):", pendingInstructions.length);
      } else {
        pendingInstructions =
          "You are the SmartFlows phone agent. British English only. Keep replies to 1–2 sentences, ask one helpful question when appropriate, do not talk over the caller. If unclear, briefly ask for clarification. First line: “Hello—how can I help today?”";
        console.log("Using generic fallback prompt (len):", pendingInstructions.length);
      }
    } else {
      pendingInstructions =
        "You are the SmartFlows phone agent. British English only. Keep replies to 1–2 sentences, ask one helpful question when appropriate, do not talk over the caller. If unclear, briefly ask for clarification. First line: “Hello—how can I help today?”";
      console.log("Using generic fallback prompt (len):", pendingInstructions.length);
    }

    twilioStarted = true;
    applySessionUpdateIfReady();

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
  }

  twilioWs.on("message", (msg) => {
    const txt = msg.toString();
    let data; try { data = JSON.parse(txt); } catch { console.log("non-JSON from Twilio:", txt.slice(0,120)); return; }

    if (debugCount < 5 && data.event !== "media") {
      console.log("Twilio event:", data.event, JSON.stringify(data).slice(0, 200));
      debugCount++;
    }

    switch (data.event) {
      case "start": {
        handleStartEvent(data).catch((e) => console.error("start handler error:", e?.message || e));
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
          }

          // Echo caller UNTIL assistant starts talking, then stop echoing
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


