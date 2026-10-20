import { contextBridge, ipcRenderer } from "electron";
import { Live2DControlCore } from "../../core/live2d-control-core.mjs";
import { createLocalHostBridge } from "../../bridge/host-bridge.mjs";

const DISPLAY_SENDER_PEER_ID = "bm-display-sender";
const DISPLAY_RECEIVER_PEER_ID = "bm-display-receiver";

const core = new Live2DControlCore();

// In-memory cache so synchronous storage.get works during identity bootstrap.
const cache = new Map();

async function preloadStore(keys) {
  for (const k of keys) {
    try {
      const v = await ipcRenderer.invoke("xz-storage-get", k);
      if (v !== null && v !== undefined) cache.set(k, v);
    } catch {}
  }
}

const storage = {
  get(key) {
    return cache.has(key) ? cache.get(key) : null;
  },
  set(key, value) {
    cache.set(key, value);
    ipcRenderer.invoke("xz-storage-set", key, value).catch(() => {});
  },
  remove(key) {
    cache.delete(key);
    ipcRenderer.invoke("xz-storage-remove", key).catch(() => {});
  }
};

const hostServices = {
  camera: {
    async snapshot(payload = {}) {
      return ipcRenderer.invoke("xz-host-camera-snapshot", payload);
    },
    async start_recording(payload = {}) {
      return ipcRenderer.invoke("xz-host-camera-start_recording", payload);
    },
    async stop_recording(payload = {}) {
      return ipcRenderer.invoke("xz-host-camera-stop_recording", payload);
    }
  },
  vision: {
    async capture_scene(payload = {}) {
      return ipcRenderer.invoke("xz-host-vision-capture_scene", payload);
    },
    async analyze_food(payload = {}) {
      return ipcRenderer.invoke("xz-host-vision-analyze_food", payload);
    },
    async recognize_faces(payload = {}) {
      return ipcRenderer.invoke("xz-host-vision-recognize_faces", payload);
    }
  },
  scene: {
    async register_object(payload = {}) {
      return ipcRenderer.invoke("xz-host-scene-register_object", payload);
    },
    async list_objects(payload = {}) {
      return ipcRenderer.invoke("xz-host-scene-list_objects", payload);
    },
    async detect_left_behind(payload = {}) {
      return ipcRenderer.invoke("xz-host-scene-detect_left_behind", payload);
    },
    async detect_safety_hazard(payload = {}) {
      return ipcRenderer.invoke("xz-host-scene-detect_safety_hazard", payload);
    },
    async delete_object(payload = {}) {
      return ipcRenderer.invoke("xz-host-scene-delete_object", payload);
    },
    async clear_objects(payload = {}) {
      return ipcRenderer.invoke("xz-host-scene-clear_objects", payload);
    },
    async mark_seen(payload = {}) {
      return ipcRenderer.invoke("xz-host-scene-mark_seen", payload);
    }
  }
};

const STORAGE_KEYS = [
  "xiaozhi.mac_address",
  "xiaozhi.serial_number",
  "xiaozhi.hmac_key",
  "xiaozhi.client_id",
  "xiaozhi.activation_status",
  "xiaozhi.ws_url",
  "xiaozhi.ws_token",
  "xiaozhi.ws_source_ota",
  "blimpmate.backend_v1"
];

// Block exposure until cache is hydrated so xiaozhi bootstrap sees stored ids.
const readyPromise = preloadStore(STORAGE_KEYS);

const bridge = createLocalHostBridge(core, {
  storage,
  hostInfo: { platform: process.platform, arch: process.arch }
});
bridge.services = hostServices;

// Surface the host-service port to the renderer so browser-side clients
// (WebRTC signaling, wake-word) target the same port the Electron main process
// and Flask server use. Preload runs with Node access, so process.env is safe.
const hostServicePort = (process.env.BM_HOST_SERVICE_PORT || "").trim() || "5000";
const hostServiceHost = (process.env.BM_HOST_SERVICE_HOST || "").trim() || "127.0.0.1";
const hostServiceUrl = `http://${hostServiceHost}:${hostServicePort}`;

function envPositiveNumber(name, fallback) {
  const value = Number((process.env[name] || "").trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const displayStream = {
  enabled: (process.env.BM_DISPLAY_STREAM || "").trim() === "1",
  signalingUrl: `ws://${hostServiceHost}:${hostServicePort}/webrtc/signaling`,
  senderPeerId: (process.env.BM_DISPLAY_SENDER_ID || "").trim() || DISPLAY_SENDER_PEER_ID,
  receiverPeerId: (process.env.BM_DISPLAY_RECEIVER_ID || "").trim() || DISPLAY_RECEIVER_PEER_ID,
  sessionId: (process.env.BM_DISPLAY_SESSION_ID || "").trim(),
  constraints: {
    width: envPositiveNumber("BM_DISPLAY_WIDTH", 1280),
    height: envPositiveNumber("BM_DISPLAY_HEIGHT", 720),
    frameRate: envPositiveNumber("BM_DISPLAY_FPS", 15)
  }
};

const wakeWord = {
  enabled: (process.env.BM_WAKE_WORD_ENABLED || "1").trim() !== "0",
  phrase: (process.env.BM_WAKE_WORD_PHRASE || "Hey Blimp").trim()
};

// The renderer's direct-HTTP MCP tools (flight-tools `callFlight`, audio-tools
// `callHost`) read `hostServiceUrl` off this bridge. Without it they fall back
// to http://127.0.0.1:5000 — which on macOS is the AirPlay receiver — and then
// silently degrade to mock. Set it so they reach the real Flask port.
bridge.hostServiceUrl = hostServiceUrl;

// Xiaozhi backend from .env (env -> renderer): a websocket endpoint
// (BM_XIAOZHI_WS_URL) or an OTA endpoint (BM_XIAOZHI_OTA_URL). A backend saved
// from the UI wins over these; with neither, the renderer asks the operator on
// first launch.
const xiaozhiConfig = {
  otaUrl: (process.env.BM_XIAOZHI_OTA_URL || "").trim() || null,
  wsUrl: (process.env.BM_XIAOZHI_WS_URL || "").trim() || null,
  // Video-call server (separate from xiaozhi); a config saved in the UI wins
  videoChatUrl: (process.env.BM_VIDEO_CHAT_URL || "").trim() || null
};

contextBridge.exposeInMainWorld("hostBridge", bridge);
contextBridge.exposeInMainWorld("hostServices", hostServices);
contextBridge.exposeInMainWorld("xiaozhiConfig", xiaozhiConfig);
contextBridge.exposeInMainWorld("hostInfo", {
  platform: process.platform,
  arch: process.arch,
  hostServicePort,
  hostServiceHost,
  hostServiceUrl,
  displayStream,
  wakeWord
});
contextBridge.exposeInMainWorld("hostReady", () => readyPromise);

ipcRenderer.on("blimpmate-host-audio-state", (_event, payload) => {
  window.dispatchEvent(new CustomEvent("blimpmate-host-audio-state", {
    detail: payload
  }));
});

// === Native WebSocket bridge ===
// Exposes a minimal API the renderer's WsProtocol can use to open a WS in
// the main process with custom headers.
// Ids are prefixed per page load: a reload restarts the counter, and reusing
// an id would route the old socket's late events into the new page.
const _wsIdPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let _nextWsId = 1;
const _wsListeners = new Map();

contextBridge.exposeInMainWorld("nativeWs", {
  available: true,
  async open(url, headers, onEvent) {
    const id = `${_wsIdPrefix}-${_nextWsId++}`;
    _wsListeners.set(id, onEvent);
    const channel = `xz-ws-event-${id}`;
    const handler = (_e, payload) => {
      const cb = _wsListeners.get(id);
      if (cb) cb(payload);
    };
    ipcRenderer.on(channel, handler);
    await ipcRenderer.invoke("xz-ws-open", { id, url, headers });
    return id;
  },
  sendText(id, text) {
    return ipcRenderer.invoke("xz-ws-send-text", { id, text });
  },
  sendBinary(id, data) {
    return ipcRenderer.invoke("xz-ws-send-binary", { id, data });
  },
  close(id) {
    _wsListeners.delete(id);
    return ipcRenderer.invoke("xz-ws-close", { id });
  }
});

contextBridge.exposeInMainWorld("hostAudio", {
  available: true,
  play(payload = {}) {
    return ipcRenderer.invoke("xz-host-audio-play", payload);
  },
  pause() {
    return ipcRenderer.invoke("xz-host-audio-pause");
  },
  resume() {
    return ipcRenderer.invoke("xz-host-audio-resume");
  },
  stop() {
    return ipcRenderer.invoke("xz-host-audio-stop");
  },
  setVolume(volume) {
    return ipcRenderer.invoke("xz-host-audio-set-volume", { volume });
  },
  getState() {
    return ipcRenderer.invoke("xz-host-audio-get-state");
  },
  getInfo() {
    return ipcRenderer.invoke("xz-host-audio-info");
  }
});
