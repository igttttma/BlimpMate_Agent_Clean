function randomMacLike() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] & 0xfe) | 0x02;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(":");
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function md5Like(input) {
  const hex = await sha256Hex(input);
  return hex.slice(0, 8);
}

import { STORAGE_KEYS } from "./app-config.mjs";

export async function ensureDeviceIdentity(storage) {
  let mac = storage.get(STORAGE_KEYS.MAC);
  if (!mac) {
    mac = randomMacLike();
    storage.set(STORAGE_KEYS.MAC, mac);
  }

  let clientId = storage.get(STORAGE_KEYS.CLIENT_ID);
  if (!clientId) {
    clientId = crypto.randomUUID();
    storage.set(STORAGE_KEYS.CLIENT_ID, clientId);
  }

  let serial = storage.get(STORAGE_KEYS.SERIAL);
  if (!serial) {
    const hash = await md5Like(`${mac}|${clientId}|${Date.now()}`);
    serial = `SN-${hash.toUpperCase()}-${mac.replace(/:/g, "")}`;
    storage.set(STORAGE_KEYS.SERIAL, serial);
  }

  let hmacKey = storage.get(STORAGE_KEYS.HMAC_KEY);
  if (!hmacKey) {
    hmacKey = await sha256Hex(`${mac}||${clientId}||${serial}`);
    storage.set(STORAGE_KEYS.HMAC_KEY, hmacKey);
  }

  return { mac, clientId, serial, hmacKey };
}

export async function computeHmacSha256(keyHex, message) {
  const keyBytes = new Uint8Array(keyHex.length / 2);
  for (let i = 0; i < keyBytes.length; i++) {
    keyBytes[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
