import { APP_CONFIG } from "../xiaozhi/config/app-config.mjs";

// Always-on control socket to the xiaozhi server (/xiaozhi/control/ on the
// conversation port, same device auth). The server shows the Blimp as online
// while it is open and sends portal commands over it (play, stop_audio,
// answer_call, decline_call, end_call).
//   4002  this device connected again elsewhere: don't reconnect (two copies
//         of the app would keep replacing each other)
//   4003  another Blimp owns the server (older servers allowed only one):
//         retry slowly, it may leave

const CLOSE_REPLACED = 4002;
const CLOSE_BLOCKED = 4003;
const PING_MS = 15000;
const PONG_TIMEOUT_MS = 10000;
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];
const BLOCKED_RETRY_MS = 30000;

/** The control URL next to the conversation websocket URL. */
export function controlUrl(wsUrl) {
  const url = new URL(wsUrl);
  url.pathname = "/xiaozhi/control/";
  return url.toString();
}

function getNativeWs() {
  return globalThis.nativeWs?.available ? globalThis.nativeWs : null;
}

export class ControlChannel extends EventTarget {
  constructor({ wsUrl, token, identity }) {
    super();
    this.url = controlUrl(wsUrl);
    this.token = token;
    this.identity = identity;
    this.connected = false;
    this.blocked = false;
    this._native = getNativeWs();
    this._sock = null; // { send(text), close() }
    this._closed = true;
    this._attempt = 0;
    this._retryTimer = null;
    this._pingTimer = null;
    this._pongTimer = null;
  }

  connect() {
    if (!this._closed) return;
    this._closed = false;
    this._open();
  }

  close() {
    this._closed = true;
    clearTimeout(this._retryTimer);
    this._teardown();
  }

  /** Send a message; false when not connected. */
  send(msg) {
    if (!this.connected || !this._sock) return false;
    this._sock.send(JSON.stringify(msg));
    return true;
  }

  _open() {
    const headers = {
      "Protocol-Version": APP_CONFIG.PROTOCOL_VERSION,
      "Device-Id": this.identity.mac,
      "Client-Id": this.identity.clientId
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const handlers = {
      open: () => this._onOpen(),
      text: (text) => this._onText(text),
      close: (code, reason) => this._onClose(code, reason)
    };
    this._sock = this._native ? this._openNative(headers, handlers) : this._openBrowser(headers, handlers);
  }

  _openNative(headers, on) {
    const native = this._native;
    let id = null;
    let closed = false;
    const sock = {
      send: (text) => id !== null && Promise.resolve(native.sendText(id, text)).catch(() => {}),
      close: () => {
        closed = true;
        if (id !== null) Promise.resolve(native.close(id)).catch(() => {});
      }
    };
    Promise.resolve(native.open(this.url, headers, (ev) => {
      if (closed || this._sock !== sock) return;
      if (ev.type === "open") on.open();
      else if (ev.type === "text") on.text(ev.data);
      else if (ev.type === "close") on.close(ev.code, ev.reason);
    })).then((nativeId) => {
      id = nativeId;
      if (closed) native.close(nativeId);
    }).catch(() => this._sock === sock && on.close(1006, "open failed"));
    return sock;
  }

  _openBrowser(headers, on) {
    // Browsers can't set headers: the server also reads them from the query
    const url = new URL(this.url);
    url.searchParams.set("device-id", headers["Device-Id"]);
    url.searchParams.set("client-id", headers["Client-Id"]);
    if (headers.Authorization) url.searchParams.set("authorization", headers.Authorization);
    const ws = new WebSocket(url);
    const sock = {
      send: (text) => ws.readyState === WebSocket.OPEN && ws.send(text),
      close: () => { try { ws.close(); } catch {} }
    };
    ws.addEventListener("open", () => this._sock === sock && on.open());
    ws.addEventListener("message", (e) => this._sock === sock && typeof e.data === "string" && on.text(e.data));
    ws.addEventListener("close", (e) => this._sock === sock && on.close(e.code, e.reason));
    return sock;
  }

  _onOpen() {
    this._pingTimer = setInterval(() => this._ping(), PING_MS);
  }

  _ping() {
    if (!this.send({ type: "ping" })) return;
    clearTimeout(this._pongTimer);
    this._pongTimer = setTimeout(() => this._onClose(1006, "no pong"), PONG_TIMEOUT_MS);
  }

  _onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg?.type === "pong") {
      clearTimeout(this._pongTimer);
    } else if (msg?.type === "welcome") {
      this._attempt = 0;
      this.connected = true;
      this.blocked = false;
      this._status("connected");
    } else if (msg?.type) {
      this.dispatchEvent(new CustomEvent("command", { detail: msg }));
    }
  }

  _onClose(code, reason) {
    const wasConnected = this.connected;
    this._teardown();
    if (this._closed) return;
    if (code === CLOSE_REPLACED) {
      this._closed = true;
      this._status("replaced", reason);
      return;
    }
    this.blocked = code === CLOSE_BLOCKED;
    const delay = this.blocked
      ? BLOCKED_RETRY_MS
      : RETRY_MS[Math.min(this._attempt++, RETRY_MS.length - 1)];
    if (this.blocked || wasConnected) this._status(this.blocked ? "blocked" : "disconnected", reason);
    this._retryTimer = setTimeout(() => !this._closed && this._open(), delay);
  }

  _teardown() {
    clearInterval(this._pingTimer);
    clearTimeout(this._pongTimer);
    const sock = this._sock;
    this._sock = null;
    this.connected = false;
    if (sock) sock.close();
  }

  _status(state, reason = "") {
    this.dispatchEvent(new CustomEvent("status", { detail: { state, reason: reason || "" } }));
  }
}
