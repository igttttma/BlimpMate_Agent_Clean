import { APP_CONFIG, STORAGE_KEYS } from "../config/app-config.mjs";
import { ensureDeviceIdentity, computeHmacSha256 } from "../config/device-identity.mjs";

const RETRY_INTERVAL_MS = 5000;
const MAX_RETRY = 60;

// Effective OTA endpoint: env override (BM_XIAOZHI_OTA_URL via preload ->
// globalThis.xiaozhiConfig.otaUrl) wins over the public tenclass default.
function resolveOtaUrl() {
  const override = globalThis?.xiaozhiConfig?.otaUrl;
  if (typeof override === "string" && override.trim()) {
    return override.trim();
  }
  return APP_CONFIG.OTA_URL;
}

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { status: res.status, data };
}

function buildOtaHeaders(identity) {
  return {
    "Device-Id": identity.mac,
    "Client-Id": identity.clientId,
    "User-Agent": `${APP_CONFIG.APP_NAME}/${APP_CONFIG.APP_VERSION}`
  };
}

function buildOtaBody(identity) {
  return {
    application: {
      version: APP_CONFIG.APP_VERSION,
      elf_sha256: identity.hmacKey
    },
    board: {
      type: APP_CONFIG.BOARD_TYPE,
      name: APP_CONFIG.APP_NAME,
      ip: "0.0.0.0",
      mac: identity.mac
    }
  };
}

export async function requestOta(storage) {
  const identity = await ensureDeviceIdentity(storage);
  const { status, data } = await postJson(
    resolveOtaUrl(),
    buildOtaBody(identity),
    buildOtaHeaders(identity)
  );

  if (status !== 200 || !data) {
    throw new Error(`OTA HTTP ${status}`);
  }

  if (data.websocket && data.websocket.url) {
    storage.set(STORAGE_KEYS.WS_URL, data.websocket.url);
    if (data.websocket.token) {
      storage.set(STORAGE_KEYS.WS_TOKEN, data.websocket.token);
    }
    storage.set(STORAGE_KEYS.ACTIVATION_STATUS, "activated");
  }

  return { identity, response: data };
}

export async function performActivation(storage, activation, onProgress) {
  const identity = await ensureDeviceIdentity(storage);
  const headers = buildOtaHeaders(identity);
  const challenge = activation.challenge;
  if (!challenge) throw new Error("activation.challenge missing");
  const hmac = await computeHmacSha256(identity.hmacKey, challenge);

  const body = {
    Payload: {
      algorithm: "hmac-sha256",
      serial_number: identity.serial,
      challenge,
      hmac
    }
  };

  const url = resolveOtaUrl().replace(/\/$/, "") + "/activate";

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    if (onProgress) onProgress({ attempt, code: activation.code, message: activation.message });

    const { status } = await postJson(url, body, headers);
    if (status === 200) {
      storage.set(STORAGE_KEYS.ACTIVATION_STATUS, "activated");
      return true;
    }
    if (status !== 202) {
      throw new Error(`Activation HTTP ${status}`);
    }
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }
  throw new Error("Activation timed out");
}

export async function ensureActivated(storage, onActivationRequired) {
  // Injected endpoint (env -> preload -> globalThis.xiaozhiConfig) wins: lets
  // BM_XIAOZHI_WS_URL / BM_XIAOZHI_WS_TOKEN connect to a known xiaozhi endpoint
  // directly, with no device-binding round-trip.
  const injectedWs = globalThis?.xiaozhiConfig?.wsUrl;
  if (typeof injectedWs === "string" && injectedWs.trim()) {
    const wsUrl = injectedWs.trim();
    const wsToken = (globalThis?.xiaozhiConfig?.wsToken || storage.get(STORAGE_KEYS.WS_TOKEN) || "");
    storage.set(STORAGE_KEYS.WS_URL, wsUrl);
    if (wsToken) storage.set(STORAGE_KEYS.WS_TOKEN, wsToken);
    storage.set(STORAGE_KEYS.ACTIVATION_STATUS, "activated");
    return { wsUrl, wsToken, alreadyActivated: true, injected: true };
  }

  const cachedWs = storage.get(STORAGE_KEYS.WS_URL);
  const cachedToken = storage.get(STORAGE_KEYS.WS_TOKEN);
  const cachedStatus = storage.get(STORAGE_KEYS.ACTIVATION_STATUS);

  if (cachedWs && cachedToken && cachedStatus === "activated") {
    return { wsUrl: cachedWs, wsToken: cachedToken, alreadyActivated: true };
  }

  const { response } = await requestOta(storage);

  if (response.activation) {
    if (onActivationRequired) {
      await onActivationRequired(response.activation, async (progressCb) => {
        await performActivation(storage, response.activation, progressCb);
      });
    } else {
      await performActivation(storage, response.activation);
    }
    const second = await requestOta(storage);
    if (!second.response.websocket || !second.response.websocket.url) {
      throw new Error("Activation succeeded but no websocket URL");
    }
    return {
      wsUrl: second.response.websocket.url,
      wsToken: second.response.websocket.token,
      alreadyActivated: false
    };
  }

  if (response.websocket && response.websocket.url) {
    return {
      wsUrl: response.websocket.url,
      wsToken: response.websocket.token,
      alreadyActivated: true
    };
  }

  throw new Error("OTA response missing both activation and websocket fields");
}
