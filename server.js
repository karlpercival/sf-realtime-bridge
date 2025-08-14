// server.js — Minimal Twilio <-> WS tone + echo (no OpenAI yet)
// Purpose: prove outbound audio works. Twilio requires WS subprotocol "audio".
// Env: none. Railway provides PORT. Twilio streams to wss://.../stream

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

// ---------- tiny HTTP for health ----------
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

// ---------- WebSocket endpoint (accept Twilio 'audio' subprotocol) ----------
const wss = new WebSocketServer({
  server,
  path: "/stream",
  handleProtocols: (protocols /*, req*/) => {
    // Twilio offers ["audio"]; we must select it or the handshake fails (31921)
    return protocols.includes("audio") ? "audio" : false;
  }
});

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected; subprotocol:", twilioWs.protocol);

  let streamSid = null;

  // Outbound queue + 20ms pacer (160 samples @ 8kHz per frame)
  const queue = [];
  const pacer = setInterval(() => {
    if (!streamSid || queue.length === 0 || twilioWs.readyState !== WebSocket.OPEN) return;
    const frame = queue.shift(); // Uint8Array(160)
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: u8ToB64(frame) }   // Twilio expects ONLY event, streamSid, media.payload
    }));
  }, 20);

  let debugCount = 0;
  twilioWs.on("message", (msg) => {
    const txt = msg.toString();
    let data;
    try { data = JSON.parse(txt); } catch { console.log("non-JSON from Twilio:", txt.slice(0,120)); return; }

    // Log first few control events
    if (debugCount < 5 && data.event !== "media") {
      console.log("Twilio event:", data.event, JSON.stringify(data).slice(0, 200));
      debugCount++;
    }

    switch (data.event) {
      case "start": {
        streamSid = data.start?.streamSid || data.streamSid || null;
        console.log("Twilio stream started:", streamSid);

        // --- 1s test tone (1 kHz) so we can verify outbound audio path ---
        try {
          const frames = 50;                 // 50 * 20ms = 1s
          const samplesPerFrame = 160;       // 20ms @ 8kHz
          const total = frames * samplesPerFrame;
          const tonePcm = new Int16Array(total);
          for (let i = 0; i < total; i++) {
            const s = Math.sin(2 * Math.PI * 1000 * (i / 8000)); // 1kHz @ 8kHz
            tonePcm[i] = Math.round(s * 12000);
          }
          const toneU = pcm16ToMuLaw(tonePcm);
          for (let i = 0; i + samplesPerFrame <= toneU.length; i += samplesPerFrame) {
            queue.push(toneU.subarray(i, i + samplesPerFrame));
          }
        } catch (e) { console.error("Tone error:", e); }
        break;
      }

      case "media": {
        // Echo caller audio back (payload is already μ-law 20ms)
        try {
          const ulaw = b64ToU8(data.media?.payload || "");
          if (ulaw.length === 160) queue.push(ulaw);
        } catch (e) {
          console.error("Echo error:", e);
        }
        break;
      }

      case "stop": {
        console.log("Twilio stream stopped");
        try { twilioWs.close(); } catch {}
        break;
      }

      default:
        // dtmf/mark/clear, etc.
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    clearInterval(pacer);
  });

  twilioWs.on("error", (e) => {
    console.error("Twilio WS error:", e?.message || e);
  });
});

