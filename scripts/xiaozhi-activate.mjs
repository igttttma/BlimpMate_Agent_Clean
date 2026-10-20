#!/usr/bin/env node
// Xiaozhi device activation CLI.
//
// Drives the real OTA flow (src/xiaozhi/ota/activation.mjs) against the OTA
// endpoint you pass (argument or BM_XIAOZHI_OTA_URL), prints the 6-digit
// binding code, waits while you bind it in the server's console, then prints
// the resulting websocket URL + token as ready-to-paste env vars.
//
//   node scripts/xiaozhi-activate.mjs http://127.0.0.1:8003/xiaozhi/ota/
//
// Identity is persisted to scripts/.xiaozhi-activation.json so re-runs reuse the
// same device. The end result (BM_XIAOZHI_WS_URL / BM_XIAOZHI_WS_TOKEN) plugs
// into the env-config fast-path so `npm run demo` connects with no GUI binding.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requestOta, performActivation } from "../src/xiaozhi/ota/activation.mjs";
import { STORAGE_KEYS } from "../src/xiaozhi/config/app-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_FILE = process.env.BM_XIAOZHI_STORE || join(__dirname, ".xiaozhi-activation.json");
const OTA_URL = (process.argv[2] || process.env.BM_XIAOZHI_OTA_URL || "").trim();

function loadStore() {
  if (existsSync(STORE_FILE)) {
    try { return JSON.parse(readFileSync(STORE_FILE, "utf8")); } catch { /* ignore */ }
  }
  return {};
}
const _data = loadStore();
const storage = {
  get: (k) => (k in _data ? _data[k] : null),
  set: (k, v) => { _data[k] = v; writeFileSync(STORE_FILE, JSON.stringify(_data, null, 2)); },
  remove: (k) => { delete _data[k]; writeFileSync(STORE_FILE, JSON.stringify(_data, null, 2)); }
};

function printResult(wsUrl, wsToken) {
  console.log("\n" + "=".repeat(60));
  console.log("\x1b[32m✅ xiaozhi device activated.\x1b[0m\n");
  console.log("Set these env vars (or put them in .env), then `npm run demo`:\n");
  console.log(`  export BM_XIAOZHI_WS_URL="${wsUrl}"`);
  console.log(`  export BM_XIAOZHI_WS_TOKEN="${wsToken || ""}"`);
  console.log("\n(The app uses them as a direct-WebSocket backend, with no binding round-trip.)");
  console.log("=".repeat(60) + "\n");
}

async function main() {
  if (!OTA_URL) {
    console.error("Usage: node scripts/xiaozhi-activate.mjs <ota-url>   (or set BM_XIAOZHI_OTA_URL)");
    process.exit(1);
  }
  console.log(`\nXiaozhi activation  (ota: ${OTA_URL}, store: ${STORE_FILE})`);
  const { identity, response } = await requestOta(storage, OTA_URL);
  console.log(`device mac: ${identity.mac}`);

  // Match ensureActivated's priority: an `activation` block means the device is
  // UNBOUND. Some servers also return a pre-binding websocket alongside it, but
  // binding links the device to your account + agent config. So bind first.
  if (response.activation && response.activation.code) {
    // fall through to the binding flow below
  } else if (response.websocket && response.websocket.url) {
    printResult(response.websocket.url, response.websocket.token);
    return;
  } else {
    console.error("Unexpected OTA response (no activation, no websocket):", JSON.stringify(response));
    process.exit(1);
  }

  const { code, message } = response.activation;
  console.log("\n" + "-".repeat(60));
  console.log(`\x1b[1m\x1b[36mBIND THIS DEVICE\x1b[0m`);
  console.log(`  1. ${message || "Open your server's device console and log in"}`);
  console.log(`  2. Add a device and enter code:  \x1b[1m\x1b[33m${code}\x1b[0m`);
  console.log(`  3. Keep this script running — it polls until binding completes (≈5 min).`);
  console.log("-".repeat(60));

  await performActivation(storage, OTA_URL, response.activation, ({ attempt }) => {
    process.stdout.write(`\r  waiting for binding… (poll ${attempt})   `);
  });
  console.log("\n  binding confirmed; fetching websocket endpoint…");

  const second = await requestOta(storage, OTA_URL);
  if (!second.response.websocket || !second.response.websocket.url) {
    console.error("Activation succeeded but OTA returned no websocket URL.");
    process.exit(1);
  }
  printResult(second.response.websocket.url, second.response.websocket.token);
}

main().catch((err) => {
  console.error("\nactivation failed:", err.message);
  console.error("(Re-run to get a fresh code; the device identity is preserved.)");
  process.exit(1);
});
