import assert from "node:assert/strict";
import http from "node:http";
import {
  BackendMode,
  inferBackendMode,
  resolveBackendConfig,
  saveBackendConfig,
  clearBackendConfig,
  validateBackendConfig
} from "../backend-config.mjs";
import { ensureActivated } from "../../ota/activation.mjs";
import { STORAGE_KEYS } from "../app-config.mjs";

function memoryStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
}

// --- validation / inference -------------------------------------------------
assert.equal(validateBackendConfig({ mode: "ota", url: "" }), "Enter the backend URL.");
assert.match(validateBackendConfig({ mode: "ota", url: "ws://x" }), /http/);
assert.match(validateBackendConfig({ mode: "ws", url: "http://x" }), /ws:\/\//);
assert.equal(validateBackendConfig({ mode: "ws", url: "ws://127.0.0.1:8000/xiaozhi/v1/" }), null);
assert.equal(inferBackendMode("wss://a"), BackendMode.WS);
assert.equal(inferBackendMode("https://a"), BackendMode.OTA);
assert.equal(inferBackendMode("a.b"), null);

// --- resolution order: saved > env > ask (null) -----------------------------
const storage = memoryStorage();
delete globalThis.xiaozhiConfig;
assert.equal(resolveBackendConfig(storage), null, "no config means the UI must ask");

globalThis.xiaozhiConfig = { otaUrl: "http://env-ota/xiaozhi/ota/", wsUrl: null };
assert.deepEqual(resolveBackendConfig(storage), {
  config: { mode: "ota", url: "http://env-ota/xiaozhi/ota/", token: "" }, source: "env"
});
globalThis.xiaozhiConfig = { otaUrl: "http://env-ota/", wsUrl: "ws://env-ws/", wsToken: "t" };
assert.equal(resolveBackendConfig(storage).config.mode, "ws", "env websocket beats env OTA");

saveBackendConfig(storage, { mode: "ota", url: " http://saved/ota/ ", token: "ignored" });
assert.deepEqual(resolveBackendConfig(storage), {
  config: { mode: "ota", url: "http://saved/ota/", token: "" }, source: "saved"
});
storage.set(STORAGE_KEYS.BACKEND, "{not json");
assert.equal(resolveBackendConfig(storage).source, "env", "corrupt saved config falls back");
clearBackendConfig(storage);
delete globalThis.xiaozhiConfig;
assert.equal(resolveBackendConfig(storage), null);

// --- ensureActivated per mode, against a fake OTA server --------------------
let otaReplies = [];
const server = http.createServer((req, res) => {
  const reply = otaReplies.shift() || { status: 500, body: {} };
  res.writeHead(reply.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(reply.body));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const otaUrl = `http://127.0.0.1:${server.address().port}/xiaozhi/ota/`;
// device-identity needs WebCrypto + a storage; Node provides both here.
const s2 = memoryStorage();

try {
  const direct = await ensureActivated(s2, { mode: "ws", url: "ws://direct/", token: "tok" });
  assert.deepEqual([direct.wsUrl, direct.wsToken], ["ws://direct/", "tok"]);

  otaReplies = [{ status: 200, body: { websocket: { url: "ws://from-ota/", token: "" } } }];
  const viaOta = await ensureActivated(s2, { mode: "ota", url: otaUrl });
  assert.equal(viaOta.wsUrl, "ws://from-ota/");

  // OTA down: reuse the endpoint the same OTA URL gave last time...
  otaReplies = [{ status: 503, body: {} }];
  const cached = await ensureActivated(s2, { mode: "ota", url: otaUrl });
  assert.equal(cached.wsUrl, "ws://from-ota/");
  assert.equal(cached.cached, true);

  // ...but never one handed out by a different OTA URL.
  await assert.rejects(ensureActivated(s2, { mode: "ota", url: "http://127.0.0.1:1/ota/" }));

  await assert.rejects(ensureActivated(s2, null), /No backend configured/);
} finally {
  server.close();
}

console.log("backend config tests: ok");
