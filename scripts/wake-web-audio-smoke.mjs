import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// Starts the desktop wake service and streams the test clips through
// /wake_word/audio the way the renderer does (20 ms float32 frames, paced in
// real time): "Hey Blimp" must wake it, and "answer" only once the keyword
// set is switched to "answer".

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceRoot = path.join(root, "host-service");
const python = process.platform === "win32"
  ? path.join(serviceRoot, ".venv", "Scripts", "python.exe")
  : path.join(serviceRoot, ".venv", "bin", "python");
const port = 15050;
const baseUrl = `http://127.0.0.1:${port}`;

const service = spawn(python, ["server.py"], {
  cwd: serviceRoot,
  env: {
    ...process.env,
    BM_HOST_SERVICE_HOST: "127.0.0.1",
    BM_HOST_SERVICE_PORT: String(port),
    BM_WAKE_MODEL_DIR: path.join(root, "src", "wake-models"),
    PYTHONUNBUFFERED: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let logs = "";
service.stdout.on("data", (chunk) => { logs += String(chunk); });
service.stderr.on("data", (chunk) => { logs += String(chunk); });

async function waitForService() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/wake_word/status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`host-service did not start\n${logs}`);
}

/** 16 kHz mono 16-bit WAV -> Float32Array, with 2 s of silence before (a running stream) and 1 s after. */
function loadClip(name) {
  const buf = readFileSync(path.join(root, "test-media", "audio", `${name}.wav`));
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  let at = 12;
  let fmt = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === "data") {
      assert.deepEqual(fmt, { channels: 1, rate: 16000, bits: 16 }, `${name}.wav must be 16 kHz mono 16-bit`);
      const samples = Math.min(size, buf.length - at - 8) / 2;
      const out = new Float32Array(32000 + samples + 16000);
      for (let i = 0; i < samples; i++) out[32000 + i] = buf.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size & 1);
  }
  throw new Error(`${name}.wav has no data chunk`);
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wake_word/audio`);
    const events = [];
    socket.on("message", (data) => {
      const payload = JSON.parse(String(data));
      events.push(payload);
      if (payload.type === "hello") resolve({ socket, events, hello: payload });
    });
    socket.on("error", (error) => reject(new Error(`${error.message}\n${logs}`)));
  });
}

async function stream(socket, samples) {
  const frame = 320; // 20 ms
  for (let i = 0; i < samples.length; i += frame) {
    socket.send(Buffer.from(samples.slice(i, i + frame).buffer));
    // A bit faster than real time keeps the test short; the service has no clock
    if ((i / frame) % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const wakes = (events) => events.filter((e) => e.type === "wake");

try {
  await waitForService();
  const { socket, events, hello } = await openSocket();
  assert.equal(hello.running, true, hello.error || hello.reason);
  assert.equal(hello.mode, "openwakeword");
  assert.equal(hello.keywords, "wake");

  await stream(socket, loadClip("hey_blimp"));
  assert.deepEqual(wakes(events).map((e) => [e.word, e.keywords]), [["Hey Blimp", "wake"]]);

  await stream(socket, loadClip("question_weather"));
  assert.equal(wakes(events).length, 1, "other speech must not wake it");

  socket.send(JSON.stringify({ type: "keywords", set: "answer" }));
  await stream(socket, loadClip("hey_blimp"));
  assert.equal(wakes(events).length, 1, '"Hey Blimp" does not answer a call');
  await stream(socket, loadClip("answer"));
  assert.deepEqual(wakes(events).map((e) => e.keywords), ["wake", "answer"]);

  socket.close();
  console.log("wake web audio smoke: ok (openwakeword: Hey Blimp, answer)");
} finally {
  service.kill();
}
