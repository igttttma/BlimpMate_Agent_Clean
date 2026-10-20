// Where the stream server is ({ url }), kept apart from the xiaozhi backend:
// in deployment it runs on its own VPS. The url is the signaling websocket,
// e.g. wss://203.0.113.7:8443/ws (an https:// page address is accepted too).
const STORAGE_KEY = "blimpmate.videochat_v1";
// The Blimp signs in to the stream server with this fixed password (the
// server's BLIMP_TOKEN, also "blimpmate" by default); fine for the demo
export const BLIMP_PASSWORD = "blimpmate";

export function normalizeCallConfig(cfg) {
  let url = typeof cfg?.url === "string" ? cfg.url.trim() : "";
  if (/^https?:\/\//i.test(url)) {
    const u = new URL(url);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    if (u.pathname === "/" || u.pathname === "") u.pathname = "/ws";
    url = u.toString();
  }
  return { url };
}

// Returns an error message, or null when usable (an empty url means "off").
export function validateCallConfig(cfg) {
  const { url } = normalizeCallConfig(cfg);
  if (url && !/^wss?:\/\/\S+$/i.test(url)) return "Use wss://host:port/ws (or the https:// page address).";
  return null;
}

export function loadCallConfig(storage) {
  const raw = storage?.get?.(STORAGE_KEY);
  if (raw) {
    try {
      const cfg = normalizeCallConfig(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!validateCallConfig(cfg)) return cfg;
    } catch {}
  }
  // Electron: optional BM_VIDEO_CHAT_URL from .env
  const env = globalThis?.xiaozhiConfig;
  return normalizeCallConfig({ url: env?.videoChatUrl || "" });
}

export function saveCallConfig(storage, cfg) {
  const normalized = normalizeCallConfig(cfg);
  storage.set(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

/** Signaling URL with the Blimp role and password. */
export function signalingUrl({ url }) {
  const u = new URL(url);
  u.searchParams.set("role", "blimp");
  u.searchParams.set("token", BLIMP_PASSWORD);
  return u.toString();
}
