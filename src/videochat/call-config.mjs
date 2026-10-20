// Where the stream server is ({ url, token }), kept apart from the xiaozhi
// backend: in deployment it runs on its own VPS. The url is the signaling
// websocket, e.g. wss://203.0.113.7:8443/ws (an https:// page address is accepted too).
const STORAGE_KEY = "blimpmate.videochat_v1";

export function normalizeCallConfig(cfg) {
  let url = typeof cfg?.url === "string" ? cfg.url.trim() : "";
  if (/^https?:\/\//i.test(url)) {
    const u = new URL(url);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    if (u.pathname === "/" || u.pathname === "") u.pathname = "/ws";
    url = u.toString();
  }
  const token = typeof cfg?.token === "string" ? cfg.token.trim() : "";
  return { url, token };
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
  // Electron: optional BM_VIDEO_CHAT_URL / BM_VIDEO_CHAT_TOKEN from .env
  const env = globalThis?.xiaozhiConfig;
  return normalizeCallConfig({ url: env?.videoChatUrl || "", token: env?.videoChatToken || "" });
}

export function saveCallConfig(storage, cfg) {
  const normalized = normalizeCallConfig(cfg);
  storage.set(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

/** Signaling URL with the Blimp role and token. */
export function signalingUrl({ url, token }) {
  const u = new URL(url);
  u.searchParams.set("role", "blimp");
  if (token) u.searchParams.set("token", token);
  return u.toString();
}
