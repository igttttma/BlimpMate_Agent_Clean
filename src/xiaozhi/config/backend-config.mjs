import { STORAGE_KEYS } from "./app-config.mjs";

// Which backend the client talks to. There is deliberately no built-in
// default: a saved config wins, then host-injected env (Electron .env), and
// with neither the UI asks the operator on first launch.
//   ota: POST the OTA endpoint; it returns the websocket URL/token and may
//        require device activation (binding) first.
//   ws:  connect straight to a known websocket URL. No token: the server
//        doesn't check one with auth off; with auth on, use OTA mode.
export const BackendMode = Object.freeze({ OTA: "ota", WS: "ws" });

export function normalizeBackendConfig(cfg) {
  const mode = cfg?.mode === BackendMode.WS ? BackendMode.WS : BackendMode.OTA;
  const url = typeof cfg?.url === "string" ? cfg.url.trim() : "";
  return { mode, url };
}

// Returns an error message, or null when the config is usable.
export function validateBackendConfig(cfg) {
  const { mode, url } = normalizeBackendConfig(cfg);
  if (!url) return "Enter the backend URL.";
  if (mode === BackendMode.OTA && !/^https?:\/\/\S+$/i.test(url)) {
    return "An OTA URL must start with http:// or https://";
  }
  if (mode === BackendMode.WS && !/^wss?:\/\/\S+$/i.test(url)) {
    return "A websocket URL must start with ws:// or wss://";
  }
  return null;
}

// Guess the mode from what was typed, so pasting a URL picks the right option.
export function inferBackendMode(url) {
  if (/^wss?:\/\//i.test(url || "")) return BackendMode.WS;
  if (/^https?:\/\//i.test(url || "")) return BackendMode.OTA;
  return null;
}

export function loadSavedBackendConfig(storage) {
  const raw = storage?.get?.(STORAGE_KEYS.BACKEND);
  if (!raw) return null;
  try {
    const cfg = normalizeBackendConfig(typeof raw === "string" ? JSON.parse(raw) : raw);
    return validateBackendConfig(cfg) ? null : cfg;
  } catch {
    return null;
  }
}

export function saveBackendConfig(storage, cfg) {
  const normalized = normalizeBackendConfig(cfg);
  storage.set(STORAGE_KEYS.BACKEND, JSON.stringify(normalized));
  return normalized;
}

export function clearBackendConfig(storage) {
  storage?.remove?.(STORAGE_KEYS.BACKEND);
}

// Host-injected config (Electron preload exposes .env as globalThis.xiaozhiConfig).
// A websocket URL beats an OTA URL, matching the previous env fast-path.
export function envBackendConfig() {
  const env = globalThis?.xiaozhiConfig;
  const wsUrl = typeof env?.wsUrl === "string" ? env.wsUrl.trim() : "";
  const otaUrl = typeof env?.otaUrl === "string" ? env.otaUrl.trim() : "";
  const cfg = wsUrl
    ? { mode: BackendMode.WS, url: wsUrl }
    : otaUrl ? { mode: BackendMode.OTA, url: otaUrl } : null;
  return cfg && !validateBackendConfig(cfg) ? normalizeBackendConfig(cfg) : null;
}

// { config, source: "saved" | "env" } or null when the operator must be asked.
export function resolveBackendConfig(storage) {
  const saved = loadSavedBackendConfig(storage);
  if (saved) return { config: saved, source: "saved" };
  const env = envBackendConfig();
  if (env) return { config: env, source: "env" };
  return null;
}
