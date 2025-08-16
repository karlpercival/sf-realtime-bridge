// server.js — Twilio <-> OpenAI Realtime (Node 20, ESM)
// - Accepts Twilio WS subprotocol "audio"
// - 1s beep on connect; NO echo
// - British English; server VAD (create_response: true, interrupt_response: true)
// - INPUT: Twilio g711_ulaw (8 kHz) forwarded raw to OpenAI
// - OUTPUT: OpenAI PCM16 @ 24 kHz -> FIR low-pass -> decimate-by-3 -> μ-law -> 20ms frames
//
// ENV (Railway):
//   OPENAI_API_KEY  = sk-...            (required)
//   SYM_API_URL     = https://...       (optional; your Syms API base)
//   SYM_API_KEY     = ...               (optional; bearer for your API)

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

// ---- Env ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
const SYM_API_URL = process.env.SYM_API_URL || "";
const SYM_API_KEY = process.env.SYM_API_KEY || "";

const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

// ---------- tiny HTTP (health) ----------
const app = express();
app.get("/healthz", (_, res) => res.status(200).send("ok"));
const server = app.listen(process.env.PORT || 8080, () => {
  const addr = server.address();
  console.log("Bridge listening on", typeof addr === "object" ? addr.port : addr);
});

// ---------- basic helpers ----------
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
const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
const u8ToB64  = (u8)  => Buffer.from(u8).toString("base64");

// ---------- Downsampling (24 kHz -> 8 kHz) ----------
function designLowpassFIR(taps, cutoffHz, srHz) {
  // Windowed-sinc (Blackman)
  const N = taps;
  const fc = cutoffHz / srHz; // 0..0.5
  const a0 = 0.42, a1 = 0.5, a2 = 0.08;
  const h = new Float32Array(N);
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const m = n - (N - 1) / 2;
    const sinc = m === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * m) / m;
    const w = a0 - a1 * Math.cos((2 * Math.PI * n) / (N - 1)) + a2 * Math.cos((4 * Math.PI * n) / (N - 1));
    const v = w * sinc;
    h[n] = v;
    sum += v;
  }
  for (let n = 0; n < N; n++) h[n] /= sum || 1; // DC normalise
  return h;
}
function makeDecimatorBy3_24kTo8k() {
  const TAPS = 63, CUT_HZ = 3400, SR_IN = 24000;
  const H = designLowpassFIR(TAPS, CUT_HZ, SR_IN);
  let keep = new Float32Array(0); // carry over (TAPS-1 + remainder<3)

  return function decimate(int16In) {
    const x = new Float32Array(keep.length + int16In.length);
    if (keep.length) x.set(keep, 0);
    for (let i = 0; i < int16In.length; i++) x[keep.length + i] = int16In[i];

    const need = TAPS - 1;
    const avail = x.length - need;
    if (avail <= 0) { keep = x; return new Int16Array(0); }

    const outCount = Math.floor(avail / 3);
    const y = new Int16Array(outCount);
    let pos = need;

    for (let o = 0; o < outCount; o++, pos += 3) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += H[k] * x[pos - k];
      let s = Math.max(-32768, Math.min(32767, Math.round(acc)));
      y[o] = s;
    }

    const consumed = outCount * 3;
    const remain = avail - consumed; // 0..2
    const keepLen = need + remain;
    keep = x.subarray(x.length - keepLen);
    return y;
  };
}

// μ-law frame packer for Twilio (160 bytes = 20 ms @ 8 kHz)
function makeUlawFramer() {
  let ulawRemainder = new Uint8Array(0);
  return function flushUlawFrames(ulawChunk, queue) {
    const combined = new Uint8Array(ulawRemainder.length + ulawChunk.length);
    combined.set(ulawRemainder, 0);
    combined.set(ulawChunk, ulawRemainder.length);
    let off = 0;
    while (off + 160 <= combined.length) {
      queue.push(combined.subarray(off, off + 160));
      off += 160;
    }
    ulawRemainder = combined.subarray(off);
  };
}

// ---------- WS endpoint (accept Twilio subprotocol "audio") ----------
const wss = new WebSocketServer({
  server,
  path: "/stream",
  handleProtocols: (protocols) => (protocols && protocols.includes("audio") ? "audio" : false)
});

wss.on("connection", async (twilioWs) => {
  console.log("Twilio connected; subprotocol:", twilioWs.protocol);

  let streamSid = null;

  // Outbound queue + 20 ms pacer (160 μ-law bytes @ 8 kHz)
  const queue = [];
  const pacer = setInterval(() => {
    if (!streamSid || queue.length === 0 || twilioWs.readyState !== WebSocket.OPEN) return;
    const frame = queue.shift(); // Uint8Array(160)
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: u8ToB64(frame) }
    }));
  }, 20);

  // ---- OpenAI Realtime ----
  let openaiWs = null;
  let openaiReady = false;

  // Per-call context from Twilio <Parameter>
  let symParam = "";
  let instParam = "";

  // Talk-over logs (no echo path at all)
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

  // Build per-call resampler & framer
  const decimate24kTo8k = makeDecimatorBy3_24kTo8k();
  const flushUlawFrames = makeUlawFramer();

  // Base instructions (British English); will be augmented by sym/inst
  const baseInstructions =
    "You are the SmartFlows phone agent. RESPOND ONLY IN BRITISH ENGLISH (en-GB). " +
    "Never use any other language. Keep replies to 1–2 short sentences and end with a helpful question when appropriate.";

  // Compose and apply instruction update (safe after OpenAI WS open)
  function applySessionInstructions() {
    const parts = [baseInstructions];
    if (symParam)  parts.push(`Sym: ${symParam}.`);
    if (instParam) parts.push(`Task: ${instParam}`);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: { instructions: parts.join(" ") }
      }));
    }
  }

  // Fetch Sym-specific instructions from your API (optional)
  async function fetchSymInstructions(sym) {
    if (!SYM_API_URL) return "";
    try {
      const base = SYM_API_URL.replace(/\/+$/, "");
      // Adjust this path to your API if needed:
      const url = `${base}/syms/${encodeURIComponent(sym)}/instructions`;

      const headers = { Accept: "application/json" };
      if (SYM_API_KEY) headers.Authorization = `Bearer ${SYM_API_KEY}`;

      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await resp.json();
        return (j.instructions || j.prompt || j.description || "").toString();
      }
      return (await resp.text()).toString();
    } catch (e) {
      console.log("Sym API fetch failed:", e?.message || e);
      return "";
    }
  }

  // Fetch an OpenAI Assistant's instructions by ID (asst_...)
  async function fetchAssistantInstructions(assistantId) {
    if (!assistantId || !assistantId.startsWith("asst_")) return "";
    try {
      const resp = await fetch(`https://api.openai.com/v1/assistants/${assistantId}`, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = await resp.json();
      return (
        (j.instructions) ||
        (j.metadata && (j.metadata.instructions || j.metadata.prompt)) ||
        ""
      ).toString();
    } catch (e) {
      console.log("Assistant fetch failed:", e?.message || e);
      return "";
    }
  }

  // One-time greeting after instructions are in
  let greetingSent = false;
  function sendGreetingOnce() {
    if (greetingSent || !openaiReady || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    greetingSent = true;
    const greet = symParam && symParam.startsWith("asst_")
      ? "Hello — you’re connected to our SmartFlows assistant. How can I help today?"
      : (symParam ? `Hello — you’re connected to ${symParam}. How can I help today?`
                  : "Hello — how can I help today?");
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio", "text"], instructions: greet }
    }));
  }

  try {
    openaiWs = new WebSocket(OPENAI_WS_URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });

    openaiWs.on("open", () => {
      // Initial session config; instructions refined once we know sym/inst
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: baseInstructions,
          voice: "alloy",
          modalities: ["audio", "text"],
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200,
            create_response: true,   // auto reply at end of caller speech
            interrupt_response: true // barge-in
          },
          input_audio_format:  "g711_ulaw", // Twilio μ-law in (8 kHz)
          output_audio_format: "pcm16",     // 24 kHz PCM out (default)
          input_audio_transcription: { model: "gpt-4o-transcribe", language: "en" }
        }
      }));
      console.log("OpenAI connected (sent session.update)");
      openaiReady = true;
    });

    openaiWs.on("message", (buf) => {
      const txt = buf.toString();
      let msg;
      try { msg = JSON.parse(txt); } catch { /* non-JSON frames */ return; }

      // Assistant audio (PCM16 @ 24k) -> resample to 8k -> μ-law -> 20ms frames
      if (msg.type === "response.output_audio.delta" && msg.delta) {
        markAssistantSpeaking();
        const raw = Buffer.from(msg.delta, "base64");
        const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        const pcm8k = decimate24kTo8k(pcm);
        if (pcm8k.length) flushUlawFrames(pcm16ToMuLaw(pcm8k), queue);
        return;
      }
      if (msg.type === "response.audio.delta" && (msg.delta || msg.audio)) {
        markAssistantSpeaking();
        const raw = Buffer.from(msg.delta || msg.audio, "base64");
        const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        const pcm8k = decimate24kTo8k(pcm);
        if (pcm8k.length) flushUlawFrames(pcm16ToMuLaw(pcm8k), queue);
        return;
      }
      if (msg.type === "output_audio.delta" && msg.audio) {
        markAssistantSpeaking();
        const raw = Buffer.from(msg.audio, "base64");
        const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        const pcm8k = decimate24kTo8k(pcm);
        if (pcm8k.length) flushUlawFrames(pcm16ToMuLaw(pcm8k), queue);
        return;
      }

      // End-of-turn → allow talking again
      if (
        msg.type === "response.output_audio.done" ||
        msg.type === "response.done" ||
        msg.type === "response.completed" ||
        msg.type === "response.finished"
      ) {
        clearAssistantSpeaking();
        return;
      }

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

  // ---- Twilio -> (OpenAI) ----
  let debugCount = 0;
  twilioWs.on("message", (msg) => {
    const txt = msg.toString();

    let data;
    try { data = JSON.parse(txt); }
    catch { console.log("non-JSON from Twilio:", txt.slice(0, 120)); return; }

    if (debugCount < 5 && data.event !== "media") {
      console.log("Twilio event:", data.event, JSON.stringify(data).slice(0, 200));
      debugCount++;
    }

    switch (data.event) {
      case "start": {
        streamSid = data.start?.streamSid || data.streamSid || null;
        console.log("Twilio stream started:", streamSid);

        // Custom <Parameter> values (sym / inst)
        const cp = data.start?.customParameters || {};
        symParam  = typeof cp.sym  === "string" ? cp.sym  : "";
        instParam = typeof cp.inst === "string" ? cp.inst : "";
        console.log("Received customParameters:", { sym: symParam || "", inst: instParam || "" });

        // Fetch instructions based on sym:
        // - if sym looks like an OpenAI Assistant ID (asst_...), pull from OpenAI
        // - otherwise, fall back to your SmartFlows Sym API (if configured)
        (async () => {
          let symExtra = "";
          if (symParam) {
            if (symParam.startsWith("asst_")) {
              symExtra = await fetchAssistantInstructions(symParam);
            } else {
              symExtra = await fetchSymInstructions(symParam);
            }
          }
          const merged = [instParam, symExtra].filter(Boolean).join(" ").trim();
          if (merged) instParam = merged;
          applySessionInstructions();
          sendGreetingOnce();
        })();

        // 1s test beep (1 kHz) so caller hears something immediately
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
          const payload = data.media?.payload || "";
          const ulaw = b64ToU8(payload);
          if (ulaw.length !== 160) break; // 20ms @ 8kHz

          // Feed OpenAI (barge-in handled server-side)
          if (openaiReady && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
          }

          // NO ECHO — prevents talk-over & VAD confusion
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
}); // final line — no extra closers below


