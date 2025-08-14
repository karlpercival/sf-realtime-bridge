// server.js — Minimal Twilio <-> WS tone + echo (no OpenAI)
// Env: none. Railway sets PORT. Twilio streams to wss://.../stream

import express from "express";
import { WebSocketServer } from "ws";

const app = express();
app.get("/healthz", (_, res) => res.status(200).send("ok"));
const server = app.listen(process.env.PORT || 8080, () => {
  console.log("Bridge listening on", server.address().port);
});

const wss = new WebSocketServer({ server, path: "/stream" });

// μ-law helpers
const MULAW_EXPAND = new Int16Array(256);
(function () {
  for (let i = 0; i < 256; i++) {
    const mu = ~i & 0xff, sign = mu & 0x80, exp = (mu >> 4) & 0x07, man = mu & 0x0f;
    let sample = ((man << 4) + 0x08) << (exp + 3);
    sample -= 0x84; // 132
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

// WS
wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");
  let streamSid = null;

  // 20ms frame pacer
  const queue = [];
  const pacer = setInterval(() => {
    if (!streamSid || queue.length === 0 || twilioWs.readyState !== twilioWs.OPEN) return;
    const frame = queue.shift(); // Uint8Array of 160 bytes (20ms @ 8kHz)
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
       track: "outbound",                 // ← required for audio back to caller
      media: { payload: u8ToB64(frame) }
    }));
  }, 20);

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }

    switch (data.event) {
      case "start":
        streamSid = data.start?.streamSid || data.streamSid || null;
        console.log("Twilio stream started:", streamSid);

        // 1 second 1kHz test tone (so we know outbound audio works)
        try {
          const frames = 50, samplesPerFrame = 160, total = frames * samplesPerFrame;
          const tonePcm = new Int16Array(total);
          for (let i = 0; i < total; i++) {
            const s = Math.sin(2 * Math.PI * 1000 * (i / 8000)); // 1kHz @ 8kHz
            tonePcm[i] = Math.round(s * 12000);
          }
          const toneU = pcm16ToMuLaw(tonePcm);
          for (let i = 0; i + samplesPerFrame <= toneU.length; i += samplesPerFrame) {
            queue.push(toneU.subarray(i, i + samplesPerFrame));
          }
        } catch (e) {
          console.error("Tone error:", e);
        }
        break;

      case "media":
        // Echo back caller audio (payload is already μ-law 20ms)
        try {
          const ulaw = b64ToU8(data.media.payload);
          if (ulaw.length === 160) queue.push(ulaw);
        } catch (e) {
          console.error("Echo error:", e);
        }
        break;

      case "stop":
        console.log("Twilio stream stopped");
        try { twilioWs.close(); } catch {}
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    clearInterval(pacer);
  });
});
