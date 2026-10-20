import { APP_CONFIG, STORAGE_KEYS } from "../config/app-config.mjs";
import { ensureDeviceIdentity, computeHmacSha256 } from "../config/device-identity.mjs";
import { BackendMode } from "../config/backend-config.mjs";

const RETRY_INTERVAL_MS = 5000;
const MAX_RETRY = 60;

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

export async function requestOta(storage, otaUrl) {
  if (!otaUrl) throw new Error("OTA URL is not configured");
  const identity = await ensureDeviceIdentity(storage);
  let status, data;
  try {
    ({ status, data } = await postJson(otaUrl, buildOtaBody(identity), buildOtaHeaders(identity)));
  } catch (err) {
    throw new Error(`Cannot reach OTA endpoint ${otaUrl} (${err?.message || err})`);
  }

  if (status !== 200 || !data) {
    throw new Error(`OTA endpoint ${otaUrl} returned HTTP ${status}`);
  }

  if (data.websocket && data.websocket.url) {
    storage.set(STORAGE_KEYS.WS_URL, data.websocket.url);
    storage.set(STORAGE_KEYS.WS_TOKEN, data.websocket.token || "");
    storage.set(STORAGE_KEYS.WS_SOURCE_OTA, otaUrl);
    storage.set(STORAGE_KEYS.ACTIVATION_STATUS, "activated");
  }

  return { identity, response: data };
}

export async function performActivation(storage, otaUrl, activation, onProgress) {
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

  const url = otaUrl.replace(/\/$/, "") + "/activate";

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


// Resolve the websocket endpoint for the operator-chosen backend
// (see config/backend-config.mjs). Direct mode needs no round-trip; OTA mode
// asks the server every launch and runs device activation when it demands it.
export async function ensureActivated(storage, backend, onActivationRequired) {
  if (!backend || !backend.url) throw new Error("No backend configured");

  if (backend.mode === BackendMode.WS) {
    return { wsUrl: backend.url, wsToken: "", alreadyActivated: true };
  }

  const otaUrl = backend.url;
  let response;
  try {
    ({ response } = await requestOta(storage, otaUrl));
  } catch (err) {
    // OTA unreachable: reuse the endpoint this same OTA URL handed out last time.
    const cachedWs = storage.get(STORAGE_KEYS.WS_URL);
    if (cachedWs && storage.get(STORAGE_KEYS.WS_SOURCE_OTA) === otaUrl) {
      return { wsUrl: cachedWs, wsToken: storage.get(STORAGE_KEYS.WS_TOKEN) || "", alreadyActivated: true, cached: true };
    }
    throw err;
  }

  if (response.activation) {
    if (onActivationRequired) {
      await onActivationRequired(response.activation, async (progressCb) => {
        await performActivation(storage, otaUrl, response.activation, progressCb);
      });
    } else {
      await performActivation(storage, otaUrl, response.activation);
    }
    const second = await requestOta(storage, otaUrl);
    if (!second.response.websocket || !second.response.websocket.url) {
      throw new Error("Activation succeeded but no websocket URL");
    }
    return {
      wsUrl: second.response.websocket.url,
      wsToken: second.response.websocket.token || "",
      alreadyActivated: false
    };
  }

  if (response.websocket && response.websocket.url) {
    return {
      wsUrl: response.websocket.url,
      wsToken: response.websocket.token || "",
      alreadyActivated: true
    };
  }

  throw new Error("OTA response missing both activation and websocket fields");
}
