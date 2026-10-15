import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceRoot = path.join(root, "host-service");
const python = process.platform === "win32"
  ? path.join(serviceRoot, ".venv", "Scripts", "python.exe")
  : path.join(serviceRoot, ".venv", "bin", "python");
const modelDir = path.join(serviceRoot, "data", "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");
const keywordsFile = path.join(serviceRoot, "wake_word", "keywords.en.txt");
const port = 15050;
const baseUrl = `http://127.0.0.1:${port}`;

const service = spawn(python, ["server.py"], {
  cwd: serviceRoot,
  env: {
    ...process.env,
    BM_HOST_SERVICE_HOST: "127.0.0.1",
    BM_HOST_SERVICE_PORT: String(port),
    BM_SHERPA_MODEL_DIR: modelDir,
    BM_SHERPA_KEYWORDS_FILE: keywordsFile,
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

async function runAudioSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wake_word/audio`);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`wake audio websocket timed out\n${logs}`));
    }, 10000);
    socket.on("message", (data) => {
      const payload = JSON.parse(String(data));
      if (payload.type !== "hello") return;
      try {
        assert.equal(payload.running, true);
        assert.equal(payload.mode, "sherpa");
        assert.equal(payload.audio_backend, "web-audio");
        socket.send(Buffer.from(new Float32Array(3200).buffer));
        clearTimeout(timer);
        socket.close();
        resolve(payload);
      } catch (error) {
        clearTimeout(timer);
        socket.terminate();
        reject(error);
      }
    });
    socket.on("error", (error) => {
      setTimeout(() => reject(new Error(`${error.message}\n${logs}`)), 100);
    });
  });
}

try {
  await waitForService();
  const hello = await runAudioSocket();
  console.log(`wake web audio smoke: ok (${hello.mode}/${hello.audio_backend})`);
} finally {
  service.kill();
}
