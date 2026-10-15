const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, protocol, net, session, ipcMain, safeStorage } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const { randomUUID } = require("node:crypto");
const WebSocketLib = require("ws");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const PROJECT_ROOT = path.resolve(__dirname, "../../..");

// Lightweight .env loader (no dependency). Shell-exported vars always win, so
// `BM_HOST_SERVICE_PORT=5000 npm run demo` still overrides the file. Lets the
// operator persist BM_HOST_SERVICE_PORT / BM_XIAOZHI_* / BM_SHERPA_* in a repo
// .env instead of exporting them on every launch. Runs before the env-reading
// consts below, and before createWindow() so the renderer/preload inherit it.
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(PROJECT_ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined && process.env[key] !== "") continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch { /* no .env — use shell env / defaults */ }
})();

const DISPLAY_SERVER_PORT = Number(process.env.BM_DISPLAY_PORT || 8787);
const DISPLAY_VIEW_PATH = path.join(__dirname, "display-viewer.html");
const SHARED_WEB_ROOT = path.join(PROJECT_ROOT, "src/shared-web");
const STATIC_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff"
};
// Single source of truth for the host-service location. BM_HOST_SERVICE_PORT /
// BM_HOST_SERVICE_HOST are the SAME env vars the Flask server (server.py) reads,
// so exporting BM_HOST_SERVICE_PORT=5050 (to dodge the macOS AirPlay receiver on
// 5000) now points both the Flask bind and this Electron client at the same port.
// An explicit BM_HOST_SERVICE_BASE_URL still wins when set.
const HOST_SERVICE_HOST = (process.env.BM_HOST_SERVICE_HOST || "").trim() || "127.0.0.1";
const HOST_SERVICE_PORT = (process.env.BM_HOST_SERVICE_PORT || "").trim() || "5000";
const HOST_SERVICE_DEFAULT_URL = `http://${HOST_SERVICE_HOST}:${HOST_SERVICE_PORT}`;
const HOST_SERVICE_BASE_URL = (function resolveHostServiceBase() {
  const candidates = [
    process.env.BM_HOST_SERVICE_BASE_URL,
    process.env.BM_11_25_BASE_URL,
    process.env.BM_CONTROLLER_BASE_URL,
    process.env.BM_CONTROLLER_HOST,
    HOST_SERVICE_DEFAULT_URL
  ];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed.replace(/\/+$/, "");
    }
    if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(trimmed)) {
      return `http://${trimmed}`.replace(/\/+$/, "");
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
      return `http://${trimmed}:${HOST_SERVICE_PORT}`.replace(/\/+$/, "");
    }
    return trimmed.replace(/\/+$/, "");
  }
  return HOST_SERVICE_DEFAULT_URL;
})();
const HOST_SERVICE_TIMEOUT_MS = Math.max(1000, Number(process.env.BM_HOST_SERVICE_TIMEOUT_MS || 10000));

let mainWindow;
let displayServer = null;
let displayStateWss = null;
let displayWebrtcProxyWss = null;
let captureTick = null;
let snapshotTick = null;
let latestCapture = null;
let captureInFlight = false;
let lastStateBroadcast = null;
let hostServiceProcess = null;
let ownsHostServiceProcess = false;

function isLocalHostService() {
  return ["127.0.0.1", "localhost", "::1"].includes(HOST_SERVICE_HOST.toLowerCase());
}

function probeHostService() {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL("/wake_word/status", HOST_SERVICE_BASE_URL);
    } catch {
      resolve(false);
      return;
    }
    const request = http.get(target, { timeout: 800 }, (response) => {
      response.resume();
      resolve((response.statusCode || 500) < 500);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function ensureLocalHostService() {
  if ((process.env.BM_HOST_SERVICE_AUTOSTART || "1").trim() === "0") return false;
  if (!isLocalHostService()) return false;
  if (await probeHostService()) return true;

  const serviceRoot = path.join(PROJECT_ROOT, "host-service");
  const configuredPython = (process.env.BM_HOST_PYTHON || "").trim();
  const venvPython = process.platform === "win32"
    ? path.join(serviceRoot, ".venv", "Scripts", "python.exe")
    : path.join(serviceRoot, ".venv", "bin", "python");
  const python = configuredPython || (fs.existsSync(venvPython) ? venvPython : "python");
  const defaultModelDir = path.join(
    serviceRoot,
    "data",
    "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
  );
  const defaultKeywords = path.join(serviceRoot, "wake_word", "keywords.en.txt");
  const env = {
    ...process.env,
    BM_HOST_SERVICE_HOST: HOST_SERVICE_HOST,
    BM_HOST_SERVICE_PORT: HOST_SERVICE_PORT,
    BM_SHERPA_MODEL_DIR: process.env.BM_SHERPA_MODEL_DIR || defaultModelDir,
    BM_SHERPA_KEYWORDS_FILE: process.env.BM_SHERPA_KEYWORDS_FILE || defaultKeywords,
    PYTHONUNBUFFERED: "1"
  };

  hostServiceProcess = spawn(python, ["server.py"], {
    cwd: serviceRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  ownsHostServiceProcess = true;
  hostServiceProcess.stdout?.on("data", (data) => console.log(`[host-service] ${String(data).trimEnd()}`));
  hostServiceProcess.stderr?.on("data", (data) => console.warn(`[host-service] ${String(data).trimEnd()}`));
  hostServiceProcess.on("error", (error) => {
    console.error("[host-service] failed to start:", error?.message || error);
  });
  hostServiceProcess.on("exit", (code, signal) => {
    if (code && code !== 0) console.warn(`[host-service] exited: code=${code} signal=${signal || ""}`);
    hostServiceProcess = null;
    ownsHostServiceProcess = false;
  });

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await probeHostService()) return true;
    if (!hostServiceProcess) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.warn("[host-service] startup timed out; wake word will retry from the renderer");
  return false;
}

function stopOwnedHostService() {
  if (!ownsHostServiceProcess || !hostServiceProcess) return;
  try { hostServiceProcess.kill(); } catch {}
  hostServiceProcess = null;
  ownsHostServiceProcess = false;
}

const DISPLAY_STATE_KEYS = [
  "blimpmate.display_state_v1",
  "blimpmate.todos_v1",
  "blimpmate.reminders_v1",
  "blimpmate.memory_v1",
  "blimpmate.media_v1",
  "blimpmate.music_v1",
  "blimpmate.volume_v1",
  "blimpmate.host_audio_v1",
  "blimpmate.camera_v1",
  "blimpmate.notification_v1",
  "blimpmate.notifications_v1",
  "blimpmate.vision_v1",
  "blimpmate.face_v1",
  "blimpmate.movement_v1",
  "blimpmate.call_v1",
  "blimpmate.flight_v1",
  "blimpmate.system_status_v1"
];

function storagePath() {
  return path.join(app.getPath("userData"), "xiaozhi-storage.json");
}

function readStore() {
  try {
    const raw = fs.readFileSync(storagePath(), "utf8");
    return JSON.parse(raw);
  } catch { return {}; }
}

function writeStore(obj) {
  try { fs.writeFileSync(storagePath(), JSON.stringify(obj), "utf8"); }
  catch (err) { console.error("write store failed", err); }
}

function parseStoreValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildDisplaySnapshot(store = readStore()) {
  const state = {
    timestamp: new Date().toISOString()
  };
  for (const key of DISPLAY_STATE_KEYS) {
    const normalized = parseStoreValue(store[key]);
    if (normalized !== undefined) state[key] = normalized;
  }
  return state;
}

function safeJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendText(res, text, status = 200, type = "text/plain; charset=utf-8") {
  const body = String(text);
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

const WEBRTC_PROXY_PATHS = new Set([
  "/webrtc/sse",
  "/webrtc/send",
  "/webrtc/display/status",
  "/webrtc/signaling"
]);

function setWebrtcProxyCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendWebrtcProxyJson(res, payload, status = 502) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0");
  setWebrtcProxyCorsHeaders(res);
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendWebrtcProxyOptions(res) {
  res.statusCode = 204;
  setWebrtcProxyCorsHeaders(res);
  res.setHeader("Content-Length", "0");
  res.end();
}

function isAllowedWebrtcProxyHttp(method, pathname) {
  const verb = String(method || "GET").toUpperCase();
  if (verb === "OPTIONS") return WEBRTC_PROXY_PATHS.has(pathname);
  if (pathname === "/webrtc/send") return verb === "POST";
  if (pathname === "/webrtc/sse") return verb === "GET";
  if (pathname === "/webrtc/display/status") return verb === "GET";
  if (pathname === "/webrtc/signaling") return verb === "GET";
  return false;
}

function hostServiceUrlBase() {
  const raw = String(HOST_SERVICE_BASE_URL || "").trim();
  if (!raw) return new URL(HOST_SERVICE_DEFAULT_URL);
  if (/^https?:\/\//i.test(raw)) return new URL(raw);
  return new URL(`http://${raw}`);
}

function buildHostServiceHttpUrl(inboundUrl) {
  const base = hostServiceUrlBase();
  const target = new URL(`${inboundUrl.pathname}${inboundUrl.search || ""}`, base);
  if (target.protocol !== "http:") {
    throw new Error(`unsupported host-service protocol: ${target.protocol}`);
  }
  return target;
}

function buildHostServiceWebSocketUrl(search = "") {
  const base = hostServiceUrlBase();
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error(`unsupported host-service protocol: ${base.protocol}`);
  }
  const target = new URL(`/webrtc/signaling${search || ""}`, base);
  target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

function applyProxyResponseHeaders(res, proxyRes, isSse = false) {
  for (const [key, value] of Object.entries(proxyRes.headers || {})) {
    if (value !== undefined) res.setHeader(key, value);
  }
  setWebrtcProxyCorsHeaders(res);
  if (isSse) {
    res.setHeader("Content-Type", proxyRes.headers["content-type"] || "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
  }
}

function proxyWebrtcHttp(req, res, inboundUrl) {
  let target;
  try {
    target = buildHostServiceHttpUrl(inboundUrl);
  } catch (error) {
    sendWebrtcProxyJson(res, {
      success: false,
      error: "host_service_proxy_error",
      message: String(error?.message || error)
    }, 502);
    return;
  }

  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  delete headers["proxy-connection"];
  delete headers.upgrade;

  const isSse = inboundUrl.pathname === "/webrtc/sse";
  const proxyReq = http.request({
    hostname: target.hostname,
    port: target.port || "80",
    path: `${target.pathname}${target.search || ""}`,
    method: req.method,
    headers
  }, (proxyRes) => {
    proxyReq.setTimeout(0);
    res.statusCode = proxyRes.statusCode || 502;
    applyProxyResponseHeaders(res, proxyRes, isSse);
    proxyRes.on("error", (error) => {
      try { res.destroy(error); } catch {}
    });
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (error) => {
    if (res.headersSent) {
      try { res.destroy(error); } catch {}
      return;
    }
    sendWebrtcProxyJson(res, {
      success: false,
      error: "host_service_unreachable",
      message: String(error?.message || error)
    }, 502);
  });
  proxyReq.setTimeout(HOST_SERVICE_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error("host service timeout"));
  });
  req.on("aborted", () => {
    try { proxyReq.destroy(); } catch {}
  });
  req.on("error", () => {
    try { proxyReq.destroy(); } catch {}
  });

  if (String(req.method || "GET").toUpperCase() === "POST") {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function sendWebrtcProxyUpgradeError(socket, message, status = 502) {
  const body = JSON.stringify({
    success: false,
    error: "host_service_unreachable",
    message
  });
  const statusText = status === 502 ? "Bad Gateway" : "WebSocket Proxy Error";
  const headers = [
    `HTTP/1.1 ${status} ${statusText}`,
    "Content-Type: application/json; charset=utf-8",
    "Cache-Control: no-store, no-cache, max-age=0",
    "Access-Control-Allow-Origin: *",
    "Access-Control-Allow-Methods: GET, POST, OPTIONS",
    "Access-Control-Allow-Headers: content-type",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close"
  ];
  try { socket.write(`${headers.join("\r\n")}\r\n\r\n${body}`); } catch {}
  try { socket.destroy(); } catch {}
}

function closeWebSocketPeer(ws, code, reason) {
  if (!ws || ws.readyState === WebSocketLib.CLOSED) return;
  try {
    if (ws.readyState === WebSocketLib.CONNECTING) {
      ws.terminate();
    } else {
      ws.close(code, reason);
    }
  } catch {
    try { ws.terminate(); } catch {}
  }
}

function bridgeWebrtcSignalingSockets(clientWs, upstreamWs, pendingUpstreamMessages, earlyMessageHandler) {
  let closed = false;

  function forward(to, data, isBinary) {
    if (!to || to.readyState !== WebSocketLib.OPEN) return;
    try {
      to.send(data, { binary: Boolean(isBinary) });
    } catch {
      try { to.terminate(); } catch {}
    }
  }

  function closeBoth(source, target, code, reason) {
    if (closed) return;
    closed = true;
    closeWebSocketPeer(target, code || 1000, reason || "");
    if (source && source.readyState === WebSocketLib.OPEN) {
      try { source.close(code || 1000, reason || ""); } catch {}
    }
  }

  clientWs.on("message", (data, isBinary) => forward(upstreamWs, data, isBinary));
  upstreamWs.on("message", (data, isBinary) => forward(clientWs, data, isBinary));
  if (earlyMessageHandler) upstreamWs.off("message", earlyMessageHandler);
  for (const [data, isBinary] of pendingUpstreamMessages || []) {
    forward(clientWs, data, isBinary);
  }

  clientWs.on("close", (code, reason) => closeBoth(clientWs, upstreamWs, code, reason));
  upstreamWs.on("close", (code, reason) => closeBoth(upstreamWs, clientWs, code, reason));
  clientWs.on("error", () => closeBoth(clientWs, upstreamWs, 1011, "client websocket error"));
  upstreamWs.on("error", () => closeBoth(upstreamWs, clientWs, 1011, "host-service websocket error"));
}

function proxyWebrtcSignalingUpgrade(wss, req, socket, head, inboundUrl) {
  let targetUrl;
  try {
    targetUrl = buildHostServiceWebSocketUrl(inboundUrl.search || "");
  } catch (error) {
    sendWebrtcProxyUpgradeError(socket, String(error?.message || error));
    return;
  }

  const pendingUpstreamMessages = [];
  const upstreamWs = new WebSocketLib(targetUrl, { handshakeTimeout: HOST_SERVICE_TIMEOUT_MS });
  const earlyMessageHandler = (data, isBinary) => {
    pendingUpstreamMessages.push([data, isBinary]);
  };
  upstreamWs.on("message", earlyMessageHandler);

  let settled = false;
  const timer = setTimeout(() => {
    fail("host service websocket timeout");
  }, HOST_SERVICE_TIMEOUT_MS);

  function fail(message) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { upstreamWs.terminate(); } catch {}
    sendWebrtcProxyUpgradeError(socket, message);
  }

  function handleError(error) {
    fail(String(error?.message || error));
  }

  function handleUnexpectedResponse(_request, response) {
    fail(`host service websocket rejected: HTTP ${response?.statusCode || 0}`);
  }

  socket.on("close", () => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      try { upstreamWs.terminate(); } catch {}
    }
  });

  upstreamWs.once("error", handleError);
  upstreamWs.once("unexpected-response", handleUnexpectedResponse);
  upstreamWs.once("open", () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    upstreamWs.off("error", handleError);
    upstreamWs.off("unexpected-response", handleUnexpectedResponse);
    try {
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        bridgeWebrtcSignalingSockets(clientWs, upstreamWs, pendingUpstreamMessages, earlyMessageHandler);
      });
    } catch (error) {
      try { upstreamWs.terminate(); } catch {}
      try { socket.destroy(error); } catch {}
    }
  });
}

function readDisplayViewerTemplate() {
  try {
    return fs.readFileSync(DISPLAY_VIEW_PATH, "utf8");
  } catch {
    return null;
  }
}

function sendDisplayViewer(res) {
  const tpl = readDisplayViewerTemplate();
  if (!tpl) {
    sendText(res, "display viewer not found", 500);
    return;
  }
  const body = tpl.replace("__DISPLAY_PORT__", String(DISPLAY_SERVER_PORT));
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendCapture(res) {
  if (!latestCapture) {
    sendText(res, "capture not ready", 503);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0");
  res.setHeader("Content-Length", latestCapture.length);
  res.end(latestCapture);
}

function writeCaptureFromWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (captureInFlight) return;
  captureInFlight = true;
  mainWindow.webContents.capturePage().then((image) => {
    latestCapture = image.toJPEG(85);
  }).catch((err) => {
    console.error("[display-server] capture failed:", err);
  }).finally(() => {
    captureInFlight = false;
  });
}

function broadcastDisplayState() {
  if (!displayStateWss) return;
  const snapshot = buildDisplaySnapshot();
  const payload = JSON.stringify(snapshot);
  if (payload === lastStateBroadcast) return;
  lastStateBroadcast = payload;
  for (const client of displayStateWss.clients) {
    if (client.readyState === WebSocketLib.OPEN) {
      client.send(payload);
    }
  }
}

function serveSharedWebStaticPath(_req, res, pathname, { prefix, indexFile, redirectBare = false }) {
  if (pathname === prefix && redirectBare) {
    res.statusCode = 302;
    res.setHeader("Location", `${prefix}/`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end();
    return;
  }
  if (pathname.includes("\0")) {
    sendText(res, "forbidden", 403);
    return;
  }
  const prefixSlash = `${prefix}/`;
  const rel = pathname === prefix || pathname === prefixSlash
    ? indexFile
    : pathname.slice(prefixSlash.length) || indexFile;
  const resolved = path.resolve(SHARED_WEB_ROOT, rel);
  const rootResolved = path.resolve(SHARED_WEB_ROOT);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    sendText(res, "forbidden", 403);
    return;
  }
  let stat;
  try { stat = fs.statSync(resolved); } catch {
    sendText(res, "not found", 404);
    return;
  }
  if (stat.isDirectory()) { sendText(res, "not found", 404); return; }
  const ext = path.extname(resolved).toLowerCase();
  const contentType = STATIC_MIME_TYPES[ext] || "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const stream = fs.createReadStream(resolved);
  stream.on("error", (err) => {
    console.error("[display-server] stream error:", err && err.message ? err.message : err);
    try { res.destroy(); } catch {}
  });
  stream.pipe(res);
}

function serveSharedWebStatic(req, res, pathname) {
  serveSharedWebStaticPath(req, res, pathname, {
    prefix: "/app",
    indexFile: "index.html",
    redirectBare: true
  });
}

function serveDisplayReceiverStatic(req, res, pathname) {
  serveSharedWebStaticPath(req, res, pathname, {
    prefix: "/display",
    indexFile: "display-receiver.html"
  });
}

function startDisplayServer() {
  if (displayServer) return;
  const templatePath = fs.existsSync(DISPLAY_VIEW_PATH)
    ? DISPLAY_VIEW_PATH
    : null;
  if (!templatePath) {
    console.error("[display-server] missing viewer template:", DISPLAY_VIEW_PATH);
    return;
  }

  const server = http.createServer((req, res) => {
    const inboundUrl = new URL(req.url || "/", `http://localhost`);
    const pathname = inboundUrl.pathname;

    if (WEBRTC_PROXY_PATHS.has(pathname)) {
      if (String(req.method || "GET").toUpperCase() === "OPTIONS") {
        sendWebrtcProxyOptions(res);
        return;
      }
      if (!isAllowedWebrtcProxyHttp(req.method, pathname)) {
        sendWebrtcProxyJson(res, {
          success: false,
          error: "method_not_allowed"
        }, 405);
        return;
      }
      proxyWebrtcHttp(req, res, inboundUrl);
      return;
    }

    if (req.method !== "GET") {
      sendText(res, "method not allowed", 405);
      return;
    }

    if (pathname === "/" || pathname === "/view" || pathname === "/index.html") {
      sendDisplayViewer(res);
      return;
    }
    if (pathname === "/state") {
      safeJson(res, buildDisplaySnapshot());
      return;
    }
    if (pathname === "/health") {
      safeJson(res, { ok: true, service: "blimpmate-display-proxy" });
      return;
    }
    if (pathname === "/capture.jpg") {
      sendCapture(res);
      return;
    }
    if (pathname === "/app" || pathname.startsWith("/app/")) {
      serveSharedWebStatic(req, res, pathname);
      return;
    }
    if (pathname === "/display" || pathname.startsWith("/display/")) {
      serveDisplayReceiverStatic(req, res, pathname);
      return;
    }
    sendText(res, "not found", 404);
  });

  displayStateWss = new WebSocketLib.WebSocketServer({ noServer: true });
  displayWebrtcProxyWss = new WebSocketLib.WebSocketServer({ noServer: true });
  displayStateWss.on("connection", (socket, req) => {
    const ip = req?.socket?.remoteAddress || "unknown";
    console.log(`[display-server] client connected: ${ip}`);
    try {
      socket.send(JSON.stringify(buildDisplaySnapshot()));
    } catch {}
    socket.on("close", () => {
      console.log(`[display-server] client disconnected: ${ip}`);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    const pathname = new URL(req.url, `ws://localhost:${DISPLAY_SERVER_PORT}`).pathname;
    if (pathname === "/webrtc/signaling") {
      const inboundUrl = new URL(req.url, `ws://localhost:${DISPLAY_SERVER_PORT}`);
      proxyWebrtcSignalingUpgrade(displayWebrtcProxyWss, req, socket, head, inboundUrl);
      return;
    }
    if (pathname !== "/state-stream") {
      socket.destroy();
      return;
    }
    displayStateWss.handleUpgrade(req, socket, head, (ws) => {
      displayStateWss.emit("connection", ws, req);
    });
  });

  server.listen(DISPLAY_SERVER_PORT, "0.0.0.0", () => {
    console.log(`[display-server] listening on http://0.0.0.0:${DISPLAY_SERVER_PORT}`);
    const host = "0.0.0.0";
    const address = `${host}:${DISPLAY_SERVER_PORT}`;
    console.log(`[display-server] viewer: http://${address}/ (or replace host IP on Android)`);
    console.log("[display-server] state ws: ws://<host>:" + DISPLAY_SERVER_PORT + "/state-stream");
  });
  server.on("error", (err) => {
    console.error("[display-server] failed:", err && err.message ? err.message : String(err));
  });

  captureTick = setInterval(() => {
    writeCaptureFromWindow();
  }, 800);
  snapshotTick = setInterval(() => {
    broadcastDisplayState();
  }, 2000);
  snapshotTick.unref?.();
  captureTick.unref?.();

  displayServer = server;
}

function stopDisplayServer() {
  if (snapshotTick) clearInterval(snapshotTick);
  if (captureTick) clearInterval(captureTick);
  snapshotTick = null;
  captureTick = null;
  if (displayStateWss) {
    displayStateWss.close();
    displayStateWss = null;
  }
  if (displayWebrtcProxyWss) {
    displayWebrtcProxyWss.close();
    displayWebrtcProxyWss = null;
  }
  if (displayServer) {
    displayServer.close(() => {
      displayServer = null;
    });
  }
}

const SENSITIVE_KEYS = new Set(["xiaozhi.ws_token", "xiaozhi.hmac_key"]);

const AUDIO_STATE_KEYS = {
  idle: "idle",
  playing: "playing",
  paused: "paused",
  stopped: "stopped",
  failed: "failed"
};

const DEFAULT_AUDIO_VOLUME = 50;
const HOST_AUDIO_STATE_KEY = "blimpmate.host_audio_v1";

let hostAudioProcess = null;
let hostAudioSnapshot = null;
let hostAudioPlayer = null;
let hostAudioLastStartAt = 0;
let hostAudioBaseSeconds = 0;
let hostAudioStartTime = 0;
let hostAudioPausedAt = null;
let hostAudioStatePersisted = false;

const HOST_CAMERA_STATE_KEY = "blimpmate.host_camera_v1";
let hostControllerState = {
  recording: false,
  activeRecording: null,
  lastSession: null,
  lastSnapshot: null
};

function normalizeHostEndpoint(pathname = "") {
  const clean = String(pathname || "").trim();
  if (!clean) return "";
  const normalized = clean.replace(/^\/+/, "").replace(/\/+$/, "");
  return `/${normalized}`;
}

function hostServiceTextToJson(rawText) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function hostServiceErrorResult(endpoint, statusCode, message, detail = null) {
  return {
    ok: false,
    backend: "controller",
    reason: "host-service-error",
    note: `Host service ${endpoint} failed: ${message}`,
    status: "error",
    statusCode,
    data: detail,
    raw: detail
  };
}

function hostServiceSuccessResult(endpoint, data) {
  return {
    ok: true,
    backend: "controller",
    reason: "ok",
    status: "success",
    endpoint,
    statusCode: 200,
    note: `Host service ${endpoint} returned success`,
    data,
    raw: data
  };
}

function normalizeHostCameraSource(value, fallback = "front") {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) return fallback;
  return source;
}

function trimForBase64(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "") : "";
}

function hostServiceIsBase64(value) {
  const s = trimForBase64(value);
  return s.length > 80 && /^[A-Za-z0-9+/=]+$/.test(s);
}

function hostServiceFormatSceneHint(hint = "") {
  return (typeof hint === "string" ? hint.trim() : "");
}

function inferSceneFromHint(hint = "") {
  const source = String(hint || "").toLowerCase();
  if (source.includes("kitchen")) {
    return ["stove", "dishes", "food", "table", "cookware"];
  }
  if (source.includes("room")) {
    return ["table", "sofa", "person", "wall", "door"];
  }
  if (source.includes("outdoor")) {
    return ["trees", "road", "building", "pedestrian", "traffic"];
  }
  if (source.includes("indoor") || source.includes("indo")) {
    return ["person", "table", "prop", "door", "window"];
  }
  return ["person", "table", "furniture", "floor", "background"];
}

function persistHostControllerState() {
  const store = readStore();
  const state = {
    ...hostControllerState,
    updatedAt: new Date().toISOString(),
    lastSession: hostControllerState.lastSession ? { ...hostControllerState.lastSession } : null,
    activeRecording: hostControllerState.activeRecording ? { ...hostControllerState.activeRecording } : null,
    lastSnapshot: hostControllerState.lastSnapshot ? { ...hostControllerState.lastSnapshot } : null
  };
  store[HOST_CAMERA_STATE_KEY] = JSON.stringify(state);
  writeStore(store);
}

function hydrateHostControllerState() {
  const store = readStore();
  const raw = parseStoreValue(store[HOST_CAMERA_STATE_KEY]);
  if (!raw || typeof raw !== "object") return;
  hostControllerState = {
    recording: Boolean(raw.recording),
    activeRecording: raw.activeRecording || null,
    lastSession: raw.lastSession || null,
    lastSnapshot: raw.lastSnapshot || null
  };
}

function normalizeFoodRecordFromAnalyzer(rawResult, fallbackSource = "") {
  const result = rawResult && typeof rawResult === "object" ? rawResult : {};
  const foods = Array.isArray(result.foods) ? result.foods : [];
  if (!foods.length) {
    return {
      food: result.food_name || result.food || result.name || "unknown meal",
      confidence: 0.72,
      ingredients: result.ingredients || [],
      nutrition: {
        calories: Number(result.calories || 0),
        protein_g: Number(result.protein_g || 0),
        fat_g: Number(result.fat_g || 0),
        carbs_g: Number(result.carbs_g || 0)
      },
      image_source: fallbackSource || "",
      reasoning: result.reasoning,
      createdAt: new Date().toISOString()
    };
  }

  const merged = foods.reduce((acc, item) => {
    if (!item || typeof item !== "object") return acc;
    const calories = Number(item.calories || item.calorie || acc.calories);
    const protein = Number(item.protein_g || item.protein || acc.protein_g);
    const fat = Number(item.fat_g || item.fat || acc.fat_g);
    const carbs = Number(item.carbs_g || item.carbs || acc.carbs_g);
    if (Number.isFinite(calories)) acc.calories += calories;
    if (Number.isFinite(protein)) acc.protein_g += protein;
    if (Number.isFinite(fat)) acc.fat_g += fat;
    if (Number.isFinite(carbs)) acc.carbs_g += carbs;
    const name = item.food_name || item.food || item.name;
    if (name && !acc.ingredients.includes(name)) acc.ingredients.push(name);
    acc.count += 1;
    return acc;
  }, {
    calories: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    ingredients: [],
    count: 0
  });

  return {
    food: merged.ingredients.slice(0, 3).join(" + ") || "mixed meal",
    confidence: 0.8,
    ingredients: merged.ingredients.length ? merged.ingredients : ["mixed meal"],
    nutrition: {
      calories: Number(merged.calories.toFixed(2)),
      protein_g: Number(merged.protein_g.toFixed(2)),
      fat_g: Number(merged.fat_g.toFixed(2)),
      carbs_g: Number(merged.carbs_g.toFixed(2))
    },
    image_source: fallbackSource || "",
    reasoning: result.reasoning,
    count: merged.count,
    createdAt: new Date().toISOString()
  };
}

async function callHostServiceJson(endpoint, payload = {}, method = "POST") {
  const url = `${HOST_SERVICE_BASE_URL}${normalizeHostEndpoint(endpoint)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HOST_SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: method.toUpperCase(),
      headers: method.toUpperCase() === "GET" ? undefined : { "content-type": "application/json" },
      body: method.toUpperCase() === "GET" ? undefined : JSON.stringify(payload || {}),
      signal: ctrl.signal
    });
    const rawText = await response.text();
    const payloadData = hostServiceTextToJson(rawText);
    const payloadForReturn = payloadData === null ? rawText : payloadData;
    if (!response.ok) {
      return hostServiceErrorResult(
        endpoint,
        response.status,
        `HTTP ${response.status} ${response.statusText}`,
        payloadForReturn
      );
    }
    if (payloadData && typeof payloadData === "object" && "status" in payloadData && String(payloadData.status).toLowerCase() !== "success") {
      return hostServiceErrorResult(
        endpoint,
        response.status,
        payloadData.message || payloadData.error || `service returned status ${payloadData.status}`,
        payloadForReturn
      );
    }
    return hostServiceSuccessResult(endpoint, payloadForReturn);
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "request timeout"
      : String(error?.message || error);
    return hostServiceErrorResult(endpoint, 0, message);
  } finally {
    clearTimeout(timer);
  }
}

async function callHostServiceImageAsBase64(endpointOrUrl, timeoutMs = HOST_SERVICE_TIMEOUT_MS) {
  const rawUrl = endpointOrUrl && typeof endpointOrUrl === "string" ? endpointOrUrl.trim() : "";
  if (!rawUrl) {
    return { ok: false, reason: "invalid-url", raw: null };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(rawUrl, {
      method: "GET",
      signal: ctrl.signal
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: "http-error",
        statusCode: response.status,
        message: `HTTP ${response.status} ${response.statusText}`
      };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      ok: true,
      data: buffer.toString("base64"),
      size: buffer.length
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "timeout" : "fetch-error",
      message: String(error?.message || error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractImageSourceFromPayload(payload = {}) {
  if (typeof payload.image_source === "string" && payload.image_source.trim()) return payload.image_source.trim();
  if (typeof payload.image === "string" && payload.image.trim()) return payload.image.trim();
  if (typeof payload.image_base64 === "string" && payload.image_base64.trim()) return payload.image_base64.trim();
  if (typeof payload.source === "string" && payload.source.trim()) return payload.source.trim();
  return "";
}

async function resolveImageBase64FromSource(source = "") {
  const rawSource = String(source || "").trim();
  if (!rawSource) {
    return { ok: false, reason: "empty-image-source" };
  }

  if (rawSource.startsWith("data:")) {
    const match = rawSource.match(/base64,([^,]+)$/);
    const b64 = match ? match[1] : rawSource.split(",").pop();
    if (hostServiceIsBase64(b64)) {
      return { ok: true, image_base64: b64, source: rawSource };
    }
  }

  if (hostServiceIsBase64(rawSource)) {
    return { ok: true, image_base64: trimForBase64(rawSource), source: rawSource };
  }

  if (/^https?:\/\//i.test(rawSource)) {
    const imageResult = await callHostServiceImageAsBase64(rawSource);
    if (imageResult.ok) return { ok: true, image_base64: imageResult.data, source: rawSource };
    return { ok: false, reason: imageResult.reason || "download-failed", message: imageResult.message };
  }

  if (rawSource.startsWith("/")) {
    const full = `${HOST_SERVICE_BASE_URL}${rawSource}`;
    const imageResult = await callHostServiceImageAsBase64(full);
    if (imageResult.ok) return { ok: true, image_base64: imageResult.data, source: full };
    return { ok: false, reason: imageResult.reason || "download-failed", message: imageResult.message };
  }

  if (fs.existsSync(rawSource)) {
    try {
      const buffer = fs.readFileSync(rawSource);
      if (buffer.length) {
        return { ok: true, image_base64: buffer.toString("base64"), source: rawSource };
      }
      return { ok: false, reason: "empty-file" };
    } catch (error) {
      return { ok: false, reason: "read-file-failed", message: String(error.message || error) };
    }
  }

  return { ok: false, reason: "unsupported-source" };
}

function hostControllerSetRecording(rec) {
  hostControllerState.recording = true;
  hostControllerState.activeRecording = rec;
  hostControllerState.lastSession = rec;
  persistHostControllerState();
}

function hostControllerStopRecording() {
  hostControllerState.recording = false;
  hostControllerState.activeRecording = null;
  persistHostControllerState();
}

function hostControllerSetSnapshot(snapshot) {
  hostControllerState.lastSnapshot = snapshot;
  persistHostControllerState();
}

async function hostHandleCameraSnapshot(payload = {}) {
  const source = normalizeHostCameraSource(payload.source, "front");
  const filename = typeof payload.filename === "string" && payload.filename.trim()
    ? payload.filename.trim()
    : "";
  const takePhoto = await callHostServiceJson("/take_photo", {
    source,
    filename
  });
  if (!takePhoto.ok) {
    return takePhoto;
  }
  const data = takePhoto.data && typeof takePhoto.data === "object" ? takePhoto.data : {};
  const snapshot = {
    id: randomUUID(),
    source,
    filename: data.filename || filename || `photo_${Date.now()}.jpg`,
    label: typeof payload.label === "string" ? payload.label.trim() : "",
    source_url: data.source_url || "",
    filepath: data.filepath || "",
    createdAt: new Date().toISOString()
  };
  hostControllerSetSnapshot(snapshot);
  return hostServiceSuccessResult("take_photo", {
    snapshot,
    source,
    source_url: data.source_url || "",
    filepath: data.filepath || "",
    raw: data
  });
}

async function hostHandleCameraStartRecording(payload = {}) {
  const source = normalizeHostCameraSource(payload.source, "front");
  const quality = typeof payload.quality === "string" && payload.quality.trim() ? payload.quality.trim() : "medium";
  const request = {
    source,
    quality,
    label: typeof payload.label === "string" ? payload.label.trim() : ""
  };
  const serviceResult = await callHostServiceJson("/start_recording", request);
  if (!serviceResult.ok) {
    return serviceResult;
  }
  const data = serviceResult.data && typeof serviceResult.data === "object" ? serviceResult.data : {};
  const recording = {
    id: randomUUID(),
    source,
    quality,
    label: request.label || data.label || "",
    filename: data.filename || "",
    filepath: data.filepath || "",
    source_url: data.source_url || "",
    webrtc_url: data.webrtc_url || "",
    hls_playlist_url: data.hls_playlist_url || "",
    startAt: new Date().toISOString(),
    status: "recording"
  };
  hostControllerSetRecording(recording);
  return {
    ...hostServiceSuccessResult("/start_recording", { recording, ...data }),
    recording
  };
}

async function hostHandleCameraStopRecording(payload = {}) {
  const stopReason = typeof payload.stop_reason === "string" && payload.stop_reason.trim() ? payload.stop_reason.trim() : "manual";
  const serviceResult = await callHostServiceJson("/stop_recording", { stop_reason: stopReason });
  const active = hostControllerState.activeRecording
    ? { ...hostControllerState.activeRecording }
    : null;
  const stoppedAt = new Date().toISOString();
  if (!serviceResult.ok) {
    if (active) {
      const fallback = {
        ...active,
        stop_reason: stopReason,
        stopAt: stoppedAt,
        status: "stopped",
        error: serviceResult.note || serviceResult.reason
      };
      hostControllerState.lastSession = fallback;
      hostControllerSetSnapshot(active.snapshot || hostControllerState.lastSnapshot);
      hostControllerStopRecording();
      return {
        ...serviceResult,
        data: { recording: fallback, error: serviceResult.note, stop_reason: stopReason },
        raw: serviceResult.raw
      };
    }
    return serviceResult;
  }
  const data = serviceResult.data && typeof serviceResult.data === "object" ? serviceResult.data : {};
  const filename = data.filename || active?.filename || `video_${Date.now()}`;
  const stopRecord = {
    ...(active || {}),
    filename,
    stop_reason: stopReason,
    status: "stopped",
    stopAt: stoppedAt
  };
  hostControllerState.lastSession = stopRecord;
  hostControllerStopRecording();
  return {
    ...hostServiceSuccessResult("/stop_recording", { recording: stopRecord, ...data }),
    recording: stopRecord
  };
}

async function hostHandleVisionCaptureScene(payload = {}) {
  const source = normalizeHostCameraSource(payload.source, "default");
  const hint = hostServiceFormatSceneHint(payload.hint);
  const takePhoto = await callHostServiceJson("/take_photo", { source });
  if (!takePhoto.ok) {
    return {
      ...takePhoto,
      note: `capture_scene failed when taking photo: ${takePhoto.note}`
    };
  }
  const data = takePhoto.data && typeof takePhoto.data === "object" ? takePhoto.data : {};
  const now = new Date().toISOString();
  const label = hint || "scene recognition";
  const objects = inferSceneFromHint(hint);
  const capturedPath = data.source_url || data.filepath || data.filename || "";
  const scene = {
    id: randomUUID(),
    source,
    hint,
    scene_label: label,
    detected_objects: objects,
    detectedAt: now,
    confidence: 0.71,
    include_raw: Boolean(payload.include_raw),
    raw_path: capturedPath,
    source_url: capturedPath,
    filepath: data.filepath || "",
    filename: data.filename || ""
  };
  return {
    ...hostServiceSuccessResult("/capture_scene", { scene, capture: data }),
    data: { scene, capture: data },
    raw: { scene, capture: data }
  };
}

async function hostHandleVisionAnalyzeFood(payload = {}) {
  const includeThinking = Boolean(payload.enable_thinking || payload.include_thinking);
  const hint = typeof payload.food_hint === "string" ? payload.food_hint.trim() : "";
  const inputSource = extractImageSourceFromPayload(payload);
  let resolved = await resolveImageBase64FromSource(inputSource);
  let sourceUsed = resolved?.source || inputSource;

  if (!resolved.ok) {
    const photoResult = await callHostServiceJson("/take_photo", {});
    if (photoResult.ok) {
      const photoData = photoResult.data && typeof photoResult.data === "object" ? photoResult.data : {};
      const snapSource = photoData.source_url || "";
      if (snapSource) {
        const fromSnapshot = await resolveImageBase64FromSource(snapSource);
        if (fromSnapshot.ok) {
          resolved = fromSnapshot;
          sourceUsed = snapSource;
        }
      }
    }
  }

  if (!resolved.ok) {
    return {
      ok: false,
      backend: "controller",
      reason: "no-image-source",
      note: "No usable image source for food analysis",
      status: "error",
      data: resolved,
      raw: resolved
    };
  }

  const analyzeResult = await callHostServiceJson("/nutrition/analyze", {
    image: resolved.image_base64,
    enable_thinking: includeThinking
  });
  if (!analyzeResult.ok) return analyzeResult;

  const payloadData = analyzeResult.data && typeof analyzeResult.data === "object" ? analyzeResult.data : {};
  const result = payloadData.result && typeof payloadData.result === "object" ? payloadData.result : payloadData;
  const analyzed = normalizeFoodRecordFromAnalyzer(result, sourceUsed || "camera");
  return {
    ...hostServiceSuccessResult("/nutrition/analyze", {
      analysis: {
        ...analyzed,
        food_hint: hint || analyzed.food_hint || "",
        image_source: sourceUsed || analyzed.image_source,
        confidence: Number.isFinite(Number(analyzed.confidence)) ? analyzed.confidence : 0.82
      },
      raw: result,
      food_hint: hint
    }),
    endpoint: "/nutrition/analyze"
  };
}

async function hostHandleVisionRecognizeFaces(payload = {}) {
  const source = normalizeHostCameraSource(payload.source, "default");
  const recognitionThreshold = Number(payload.recognition_threshold || payload.threshold);
  const threshold = Number.isFinite(recognitionThreshold) ? Math.max(0, Math.min(1, recognitionThreshold)) : 0.5;
  const serviceResult = await callHostServiceJson("/face_recognition", { recognition_threshold: threshold });
  if (!serviceResult.ok) return serviceResult;
  const data = serviceResult.data && typeof serviceResult.data === "object" ? serviceResult.data : {};
  const result = data.success ? (data.result || data) : data;
  if (data.success === false) {
    return {
      ok: false,
      backend: "controller",
      reason: "service-error",
      note: data.error || "face recognition failed",
      status: "error",
      data,
      raw: data
    };
  }
  const faces = Array.isArray(result?.faces) ? result.faces : [];
  const count = Number.isFinite(Number(result?.total_faces_detected)) ? Number(result.total_faces_detected) : faces.length;
  const detection = {
    id: randomUUID(),
    source,
    threshold,
    faces,
    count,
    detectedAt: new Date().toISOString(),
    raw: result
  };
  return {
    ...hostServiceSuccessResult("/face_recognition", detection),
    data: { detection },
    raw: { detection, source, threshold }
  };
}

function clampHostAudioVolume(value, fallback = DEFAULT_AUDIO_VOLUME) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

function getPathCandidates(cmd) {
  const paths = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (process.platform === "win32") {
    return [
      `${cmd}.exe`,
      `${cmd}.cmd`,
      `${cmd}.bat`,
      cmd
    ].flatMap((candidate) => paths.map((p) => path.join(p, candidate)));
  }
  return paths.map((p) => path.join(p, cmd));
};

function commandExists(cmd) {
  const normalized = String(cmd || "").trim();
  if (!normalized) return null;
  for (const candidate of getPathCandidates(normalized)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function buildAudioPlayer() {
  if (hostAudioPlayer) return hostAudioPlayer;

  if (process.platform === "darwin") {
    const afplay = commandExists("afplay");
    if (afplay) {
      hostAudioPlayer = {
        command: afplay,
        buildArgs(source, volume) {
          const normalized = clampHostAudioVolume(volume);
          return ["-v", (normalized / 100).toFixed(3), source];
        }
      };
      return hostAudioPlayer;
    }
  }

  if (process.platform === "linux") {
    const ffplay = commandExists("ffplay");
    if (ffplay) {
      hostAudioPlayer = {
        command: ffplay,
        buildArgs(source, volume) {
          const normalized = clampHostAudioVolume(volume);
          return ["-nodisp", "-autoexit", "-loglevel", "error", "-volume", String(normalized), source];
        }
      };
      return hostAudioPlayer;
    }
  }

  hostAudioPlayer = false;
  return null;
}

function emitHostAudioState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToRenderer(mainWindow.webContents, "blimpmate-host-audio-state", getHostAudioState());
}

function persistHostAudioState(state) {
  const store = readStore();
  store[HOST_AUDIO_STATE_KEY] = JSON.stringify(state);
  writeStore(store);
}

function normalizeHostAudioState(raw = {}) {
  const normalized = {
    status: AUDIO_STATE_KEYS.idle,
    source: "",
    title: "",
    positionSeconds: 0,
    durationSeconds: 0,
    volume: DEFAULT_AUDIO_VOLUME,
    reason: "fallback-state",
    note: "",
    updatedAt: new Date().toISOString(),
    ...raw
  };

  normalized.status = typeof normalized.status === "string" && normalized.status ? normalized.status : AUDIO_STATE_KEYS.idle;
  normalized.positionSeconds = Number.isFinite(Number(normalized.positionSeconds))
    ? Math.max(0, Math.floor(Number(normalized.positionSeconds)))
    : 0;
  normalized.durationSeconds = Number.isFinite(Number(normalized.durationSeconds))
    ? Math.max(0, Math.floor(Number(normalized.durationSeconds)))
    : 0;
  normalized.volume = clampHostAudioVolume(normalized.volume, DEFAULT_AUDIO_VOLUME);
  return normalized;
}

function hydrateHostAudioState() {
  if (hostAudioStatePersisted) return;

  const store = readStore();
  const persisted = parseStoreValue(store[HOST_AUDIO_STATE_KEY]);
  if (persisted && typeof persisted === "object") {
    hostAudioSnapshot = normalizeHostAudioState({
      ...persisted,
      reason: persisted.reason || "restored"
    });
  } else {
    resetHostAudioState();
    persistHostAudioState(hostAudioSnapshot);
  }
  hostAudioStatePersisted = true;
}

function readHostAudioProcess() {
  if (!hostAudioProcess) return null;
  return {
    status: hostAudioProcess.exitCode === null ? hostAudioSnapshot?.status || AUDIO_STATE_KEYS.idle : AUDIO_STATE_KEYS.stopped,
    pid: hostAudioProcess.pid || null
  };
}

function getHostAudioState() {
  const state = {
    status: AUDIO_STATE_KEYS.idle,
    source: "",
    title: "",
    positionSeconds: 0,
    durationSeconds: 0,
    volume: DEFAULT_AUDIO_VOLUME,
    reason: "fallback-state",
    note: "",
    updatedAt: new Date().toISOString(),
    ...(hostAudioSnapshot || {})
  };
  if (!hostAudioSnapshot?.status) {
    state.status = AUDIO_STATE_KEYS.idle;
  }

  if (state.status === AUDIO_STATE_KEYS.playing && hostAudioStartTime) {
    const elapsed = Math.max(0, (Date.now() - hostAudioStartTime) / 1000);
    const paused = hostAudioPausedAt ? Math.max(0, (hostAudioPausedAt - hostAudioStartTime) / 1000) : 0;
    state.positionSeconds = Math.floor(
      Math.max(0, hostAudioBaseSeconds + elapsed - paused)
    );
  } else if (hostAudioSnapshot && Number.isFinite(hostAudioSnapshot.positionSeconds)) {
    state.positionSeconds = Math.floor(hostAudioSnapshot.positionSeconds);
  }

  return state;
}

function setHostAudioState(next) {
  const normalized = {
    ...hostAudioSnapshot,
    ...next,
    updatedAt: new Date().toISOString()
  };
  if (!normalized.title && normalized.source) {
    normalized.title = "Play audio";
  }
  normalized.volume = clampHostAudioVolume(normalized.volume, DEFAULT_AUDIO_VOLUME);
  hostAudioSnapshot = normalizeHostAudioState(normalized);
  persistHostAudioState(hostAudioSnapshot);
  emitHostAudioState();
  return getHostAudioState();
}

function resetHostAudioState() {
  hostAudioProcess = null;
  hostAudioSnapshot = {
    status: AUDIO_STATE_KEYS.idle,
    source: "",
    title: "",
    positionSeconds: 0,
    durationSeconds: 0,
    volume: DEFAULT_AUDIO_VOLUME,
    reason: "idle"
  };
  hostAudioLastStartAt = 0;
  hostAudioStartTime = 0;
  hostAudioBaseSeconds = 0;
  hostAudioPausedAt = null;
}

function stopHostAudioProcess() {
  if (!hostAudioProcess) return;
  try {
    hostAudioProcess.kill("SIGTERM");
  } catch {}
  try {
    if (!hostAudioProcess.killed) hostAudioProcess.kill();
  } catch {}
}

function ensureHostAudioState() {
  if (!hostAudioSnapshot) hydrateHostAudioState();
}

function safeStopHostAudioProcessAndState() {
  stopHostAudioProcess();
  hostAudioProcess = null;
  setHostAudioState({
    status: AUDIO_STATE_KEYS.stopped,
    positionSeconds: hostAudioBaseSeconds,
    reason: "stop"
  });
}

function normalizeAudioSource(source) {
  return typeof source === "string" ? source.trim() : "";
}

function buildHostAudioError(message) {
  return {
    ok: false,
    backend: "node",
    status: hostAudioSnapshot?.status || AUDIO_STATE_KEYS.idle,
    reason: "fallback-state",
    note: `host audio: ${message}`
  };
}

async function hostAudioPlay({ source, title = "", volume }) {
  ensureHostAudioState();
  const player = buildAudioPlayer();
  const normalizedSource = normalizeAudioSource(source);
  const normalizedVolume = clampHostAudioVolume(volume);
  if (!normalizedSource || !player || !player.command) {
    return buildHostAudioError("audio backend unavailable");
  }

  safeStopHostAudioProcessAndState();
  const args = player.buildArgs(normalizedSource, normalizedVolume);
  const proc = spawn(player.command, args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  hostAudioProcess = proc;
  hostAudioLastStartAt = Date.now();
  hostAudioStartTime = hostAudioLastStartAt;
  hostAudioBaseSeconds = 0;
  hostAudioPausedAt = null;
  setHostAudioState({
    source: normalizedSource,
    title: typeof title === "string" && title.trim() ? title.trim() : "Play audio",
    status: AUDIO_STATE_KEYS.playing,
    volume: normalizedVolume,
    positionSeconds: 0,
    reason: "host-audio",
    note: "Host audio backend started playback"
  });

  proc.on("error", (err) => {
    const detail = err && err.message ? err.message : String(err);
    setHostAudioState({
      status: AUDIO_STATE_KEYS.failed,
      reason: "failed",
      note: detail
    });
    emitHostAudioState();
  });
  proc.on("exit", (code, signal) => {
    const wasStopped = hostAudioStateIsIdle();
    hostAudioProcess = null;
    if (wasStopped) return;
    const finalStatus = code === 0 || signal ? AUDIO_STATE_KEYS.stopped : AUDIO_STATE_KEYS.failed;
    setHostAudioState({
      status: finalStatus,
      durationSeconds: Math.max(hostAudioBaseSeconds, hostAudioStatePositionSeconds()),
      reason: code === 0 ? "ended" : "failed",
      note: typeof signal === "string" ? `signal:${signal}` : (code === 0 ? "Playback finished" : `exit:${code}`)
    });
    hostAudioProcess = null;
    hostAudioPausedAt = null;
    hostAudioStartTime = 0;
    hostAudioBaseSeconds = getHostAudioState().positionSeconds || 0;
  });
  return {
    ok: true,
    backend: "node",
    status: AUDIO_STATE_KEYS.playing,
    reason: "host-audio",
    note: "Host audio backend started playback",
    source: normalizedSource,
    state: getHostAudioState()
  };
}

function hostAudioStatePositionSeconds() {
  return getHostAudioState().positionSeconds;
}

function hostAudioStateIsIdle() {
  const state = getHostAudioState();
  return state.status === AUDIO_STATE_KEYS.idle || state.status === AUDIO_STATE_KEYS.stopped;
}

function hostAudioPause() {
  ensureHostAudioState();
  if (!hostAudioProcess || !hostAudioProcess.pid) {
    return buildHostAudioError("no host audio process");
  }
  if (getHostAudioState().status !== AUDIO_STATE_KEYS.playing) {
    return {
      ok: true,
      backend: "node",
      status: getHostAudioState().status,
      reason: "host-audio",
      note: "No host audio is currently playing"
    };
  }
  try {
    hostAudioBaseSeconds = hostAudioStatePositionSeconds();
    hostAudioProcess.kill("SIGSTOP");
    hostAudioPausedAt = Date.now();
    setHostAudioState({
      status: AUDIO_STATE_KEYS.paused,
      positionSeconds: hostAudioBaseSeconds,
      reason: "host-audio",
      note: "Host audio paused"
    });
    return {
      ok: true,
      backend: "node",
      status: AUDIO_STATE_KEYS.paused,
      reason: "host-audio",
      note: "Playback paused"
    };
  } catch (err) {
    return {
      ok: false,
      backend: "node",
      status: getHostAudioState().status,
      reason: "fallback-state",
      note: `pause failed: ${err?.message || "unknown"}`
    };
  }
}

function hostAudioResume() {
  ensureHostAudioState();
  if (!hostAudioProcess || !hostAudioProcess.pid) {
    return buildHostAudioError("no host audio process");
  }
  if (getHostAudioState().status !== AUDIO_STATE_KEYS.paused) {
    return {
      ok: true,
      backend: "node",
      status: getHostAudioState().status,
      reason: "host-audio",
      note: "Host audio is not paused"
    };
  }
  try {
    hostAudioStartTime = Date.now();
    hostAudioPausedAt = null;
    hostAudioProcess.kill("SIGCONT");
    setHostAudioState({
      status: AUDIO_STATE_KEYS.playing,
      reason: "host-audio",
      note: "Host audio resumed"
    });
    return {
      ok: true,
      backend: "node",
      status: AUDIO_STATE_KEYS.playing,
      reason: "host-audio",
      note: "Playback resumed"
    };
  } catch (err) {
    return {
      ok: false,
      backend: "node",
      status: getHostAudioState().status,
      reason: "fallback-state",
      note: `resume failed: ${err?.message || "unknown"}`
    };
  }
}

function hostAudioStop() {
  ensureHostAudioState();
  if (!hostAudioProcess && !hostAudioLastStartAt) {
    return {
      ok: true,
      backend: "node",
      status: AUDIO_STATE_KEYS.idle,
      reason: "host-audio",
      note: "No playback is running"
    };
  }
  safeStopHostAudioProcessAndState();
  return {
    ok: true,
    backend: "node",
    status: AUDIO_STATE_KEYS.stopped,
    reason: "host-audio",
    note: "Playback stopped"
  };
}

function hostAudioSetVolume(volume) {
  ensureHostAudioState();
  const normalized = clampHostAudioVolume(volume);
  setHostAudioState({
    volume: normalized,
    reason: "host-audio",
    note: "Host audio volume applies on the next playback (this backend cannot change volume live)"
  });
  return {
    ok: true,
    backend: "node",
    status: getHostAudioState().status,
    reason: "fallback-state",
    note: "The host audio backend cannot change volume at runtime",
    volume: normalized
  };
}

function maybeDecrypt(key, value) {
  if (typeof value !== "string") return value;
  if (!SENSITIVE_KEYS.has(key)) return value;
  if (!value.startsWith("enc:")) return value;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
  } catch { return null; }
}

function maybeEncrypt(key, value) {
  if (typeof value !== "string") return value;
  if (!SENSITIVE_KEYS.has(key)) return value;
  if (!safeStorage.isEncryptionAvailable()) return value;
  try {
    return "enc:" + safeStorage.encryptString(value).toString("base64");
  } catch { return value; }
}

ipcMain.handle("xz-storage-get", (_e, key) => {
  const s = readStore();
  if (!(key in s)) return null;
  return maybeDecrypt(key, s[key]);
});
ipcMain.handle("xz-storage-set", (_e, key, value) => {
  const s = readStore();
  s[key] = maybeEncrypt(key, value);
  writeStore(s);
  if (DISPLAY_STATE_KEYS.includes(key)) {
    try { broadcastDisplayState(); } catch (err) {
      console.error("[display-server] broadcast failed:", err);
    }
  }
  return true;
});
ipcMain.handle("xz-storage-remove", (_e, key) => {
  const s = readStore();
  delete s[key];
  writeStore(s);
  return true;
});

// ============ WebSocket bridge ============
// Browser WebSocket can't set custom headers. xiaozhi.me server requires
// Authorization/Device-Id/Client-Id headers, so we open the WS from the main
// process using the ws package and bridge messages over IPC.

const wsSessions = new Map(); // id -> { ws, webContents }

function sendToRenderer(webContents, channel, payload) {
  if (!webContents || webContents.isDestroyed()) return;
  try { webContents.send(channel, payload); } catch {}
}

ipcMain.handle("xz-ws-open", (event, { id, url, headers }) => {
  if (wsSessions.has(id)) {
    try { wsSessions.get(id).ws.terminate(); } catch {}
    wsSessions.delete(id);
  }
  const ws = new WebSocketLib(url, {
    headers,
    perMessageDeflate: false,
    handshakeTimeout: 15000
  });
  wsSessions.set(id, { ws, webContents: event.sender });

  ws.on("open", () => {
    sendToRenderer(event.sender, `xz-ws-event-${id}`, { type: "open" });
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [data]);
      // electron IPC can transfer ArrayBuffer
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      sendToRenderer(event.sender, `xz-ws-event-${id}`, { type: "binary", data: ab });
    } else {
      const text = typeof data === "string" ? data : data.toString("utf8");
      sendToRenderer(event.sender, `xz-ws-event-${id}`, { type: "text", data: text });
    }
  });
  ws.on("close", (code, reason) => {
    sendToRenderer(event.sender, `xz-ws-event-${id}`, {
      type: "close",
      code,
      reason: reason ? reason.toString("utf8") : ""
    });
    wsSessions.delete(id);
  });
  ws.on("error", (err) => {
    sendToRenderer(event.sender, `xz-ws-event-${id}`, {
      type: "error",
      message: err && err.message ? err.message : String(err)
    });
  });
  return true;
});

ipcMain.handle("xz-ws-send-text", (_e, { id, text }) => {
  const s = wsSessions.get(id);
  if (!s) return false;
  try { s.ws.send(text); return true; } catch { return false; }
});

ipcMain.handle("xz-ws-send-binary", (_e, { id, data }) => {
  const s = wsSessions.get(id);
  if (!s) return false;
  try {
    const buf = Buffer.from(data);
    s.ws.send(buf, { binary: true });
    return true;
  } catch { return false; }
});

ipcMain.handle("xz-ws-close", (_e, { id }) => {
  const s = wsSessions.get(id);
  if (!s) return false;
  try { s.ws.close(); } catch {}
  wsSessions.delete(id);
  return true;
});

ipcMain.handle("xz-host-audio-info", () => {
  const player = buildAudioPlayer();
  return {
    available: Boolean(player && player.command),
    backend: "node",
    player: player?.command ? path.basename(player.command) : null
  };
});

ipcMain.handle("xz-host-audio-play", (_e, payload = {}) => {
  return hostAudioPlay(payload);
});
ipcMain.handle("xz-host-audio-pause", () => {
  return hostAudioPause();
});
ipcMain.handle("xz-host-audio-resume", () => {
  return hostAudioResume();
});
ipcMain.handle("xz-host-audio-stop", () => {
  return hostAudioStop();
});
ipcMain.handle("xz-host-audio-set-volume", (_e, { volume }) => {
  return hostAudioSetVolume(volume);
});
ipcMain.handle("xz-host-audio-get-state", () => {
  return getHostAudioState();
});

function hostServiceUnavailable(category, method) {
  return {
    ok: false,
    backendUsed: false,
    reason: "service-unavailable",
    note: `Host service ${category}.${method} unavailable in current Electron stub`
  };
}

ipcMain.handle("xz-host-camera-snapshot", (_e, payload = {}) => {
  return hostHandleCameraSnapshot(payload);
});
ipcMain.handle("xz-host-camera-start_recording", (_e, payload = {}) => {
  return hostHandleCameraStartRecording(payload);
});
ipcMain.handle("xz-host-camera-stop_recording", (_e, payload = {}) => {
  return hostHandleCameraStopRecording(payload);
});

ipcMain.handle("xz-host-vision-capture_scene", (_e, payload = {}) => {
  return hostHandleVisionCaptureScene(payload);
});
ipcMain.handle("xz-host-vision-analyze_food", (_e, payload = {}) => {
  return hostHandleVisionAnalyzeFood(payload);
});
ipcMain.handle("xz-host-vision-recognize_faces", (_e, payload = {}) => {
  return hostHandleVisionRecognizeFaces(payload);
});

// === scene (left-behind reminder + lab-safety) host bridge ===
// Proxies the MCP `vision.*` scene tools (via service-bridge `scene` category)
// to the Flask host-service `/scene/*` blueprint. Without this bridge the
// scene tools silently fall back to a weaker in-renderer mock and never reach
// the scene-aware host detectors.
function hostHandleSceneRegisterObject(payload = {}) {
  return callHostServiceJson("/scene/register_object", {
    name: payload.name,
    description: payload.description,
    importance_score: payload.importance_score,
    location_hint: payload.location_hint
  });
}
function hostHandleSceneListObjects() {
  return callHostServiceJson("/scene/list_objects", {}, "GET");
}
function hostHandleSceneDetectLeftBehind(payload = {}) {
  return callHostServiceJson("/scene/detect_left_behind", {
    trigger: payload.trigger || payload.trigger_reason,
    trigger_reason: payload.trigger_reason || payload.trigger,
    scene_hint: payload.scene_hint,
    max_alerts: payload.max_alerts
  });
}
function hostHandleSceneDetectSafetyHazard(payload = {}) {
  return callHostServiceJson("/scene/detect_safety_hazard", {
    scene_hint: payload.scene_hint,
    image: payload.image || payload.image_base64 || ""
  });
}
function hostHandleSceneDeleteObject(payload = {}) {
  const id = encodeURIComponent(String(payload.object_id || "").trim());
  if (!id) {
    return hostServiceErrorResult("/scene/object", 0, "object_id required");
  }
  return callHostServiceJson(`/scene/object/${id}`, {}, "DELETE");
}
function hostHandleSceneClearObjects() {
  return callHostServiceJson("/scene/clear_objects", {});
}
function hostHandleSceneMarkSeen(payload = {}) {
  const id = encodeURIComponent(String(payload.object_id || "").trim());
  if (!id) {
    return hostServiceErrorResult("/scene/mark_seen", 0, "object_id required");
  }
  return callHostServiceJson(`/scene/mark_seen/${id}`, {
    location_hint: payload.location_hint
  });
}

ipcMain.handle("xz-host-scene-register_object", (_e, payload = {}) => {
  return hostHandleSceneRegisterObject(payload);
});
ipcMain.handle("xz-host-scene-list_objects", () => {
  return hostHandleSceneListObjects();
});
ipcMain.handle("xz-host-scene-detect_left_behind", (_e, payload = {}) => {
  return hostHandleSceneDetectLeftBehind(payload);
});
ipcMain.handle("xz-host-scene-detect_safety_hazard", (_e, payload = {}) => {
  return hostHandleSceneDetectSafetyHazard(payload);
});
ipcMain.handle("xz-host-scene-delete_object", (_e, payload = {}) => {
  return hostHandleSceneDeleteObject(payload);
});
ipcMain.handle("xz-host-scene-clear_objects", () => {
  return hostHandleSceneClearObjects();
});
ipcMain.handle("xz-host-scene-mark_seen", (_e, payload = {}) => {
  return hostHandleSceneMarkSeen(payload);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    backgroundColor: "#0e1116",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // No application workflow requires a second Electron window. Denying page
  // popups also prevents target=_blank links and media helper pages from being
  // promoted into persistent BrowserWindows.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    if (
      permission === "media" ||
      permission === "audioCapture" ||
      permission === "microphone" ||
      permission === "display-capture"
    ) {
      cb(true);
    } else {
      cb(false);
    }
  });

  const mainWindowSession = mainWindow.webContents.session;
  // Least privilege: only grant display-capture ability when streaming is
  // explicitly enabled. With BM_DISPLAY_STREAM unset, getDisplayMedia is not
  // serviced at all (handler not installed) — "disabled" means "no capture
  // permission", not just "no sender".
  const displayStreamEnabled = (process.env.BM_DISPLAY_STREAM || "").trim() === "1";
  if (displayStreamEnabled && typeof mainWindowSession.setDisplayMediaRequestHandler === "function") {
    mainWindowSession.setDisplayMediaRequestHandler((request, callback) => {
      let didCallback = false;
      const finish = (streams = {}) => {
        if (didCallback) return;
        didCallback = true;
        try {
          callback(streams);
        } catch (err) {
          console.warn("[electron] display media callback failed:", err?.message || err);
        }
      };

      const frameMatches = (frame, expected) => {
        if (!frame || !expected) return false;
        if (frame === expected) return true;
        return !!(
          frame.frameTreeNodeId &&
          expected.frameTreeNodeId &&
          frame.frameTreeNodeId === expected.frameTreeNodeId
        );
      };

      let mainFrame = null;
      let requestFrame = null;
      let requestTopFrame = null;
      try {
        mainFrame = mainWindow?.webContents?.mainFrame || null;
        requestFrame = request?.frame || null;
        requestTopFrame = requestFrame?.top || requestFrame;
      } catch {
        // Detached/navigating frames are not trusted as deterministic capture sources.
      }

      const requestIsMainWindow = frameMatches(requestFrame, mainFrame) || frameMatches(requestTopFrame, mainFrame);

      if (
        !mainWindow ||
        mainWindow.isDestroyed?.() ||
        mainWindow.webContents.session !== mainWindowSession ||
        request?.videoRequested === false
      ) {
        finish({});
        return;
      }

      // Fail closed: a null/unattributable request frame (Electron may pass null
      // after navigation/destruction) must NOT fall through to the source-id
      // fallback — only a request that resolves to the main window is granted.
      if (!requestFrame || !requestIsMainWindow) {
        finish({});
        return;
      }

      // Stage 3 v1 intentionally captures mainWindow, including the operator UI.
      // We only reach here when the request resolves to the main window frame
      // (null / non-main frames were denied above). Grant the requesting
      // WebFrameMain so the renderer captures its own surface without a picker.
      // If granting request.frame isn't honored, fall back ONLY to an EXACT
      // getMediaSourceId() id match (no substring/title heuristic — that could
      // select the wrong window and is not a security boundary).
      finish({ video: requestFrame, audio: false });
    });
  }

  mainWindow.loadURL("app://localhost/src/shared-web/index.html");
  mainWindow.webContents.once("did-finish-load", () => {
    hydrateHostControllerState();
    hydrateHostAudioState();
    emitHostAudioState();
  });
}

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  protocol.handle("app", (request) => {
    const pathname = new URL(request.url).pathname.replace(/^\//, "");
    const filePath = path.join(PROJECT_ROOT, pathname);
    return net.fetch("file:///" + filePath.replace(/\\/g, "/"));
  });

  await ensureLocalHostService();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  safeStopHostAudioProcessAndState();
  stopOwnedHostService();
  stopDisplayServer();
  if (process.platform !== "darwin") app.quit();
});
