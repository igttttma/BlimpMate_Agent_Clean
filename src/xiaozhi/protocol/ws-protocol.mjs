import { APP_CONFIG } from "../config/app-config.mjs";
import { ClientMsg, ListenState } from "./message-types.mjs";

const STATE = {
  CLOSED: "closed",
  CONNECTING: "connecting",
  HELLO_SENT: "hello_sent",
  OPEN: "open"
};

// Returns the nativeWs bridge if available (Electron preload). On Android
// WebView, browsers, etc. this returns null and we fall back to browser WS.
function getNativeWs() {
  return (typeof globalThis !== "undefined" && globalThis.nativeWs && globalThis.nativeWs.available)
    ? globalThis.nativeWs
    : null;
}

export class WsProtocol extends EventTarget {
  constructor({ url, token, identity }) {
    super();
    this.url = url;
    this.token = token;
    this.identity = identity;
    this.sessionId = "";
    this.state = STATE.CLOSED;
    this._closing = false;
    this._helloTimer = null;
    this._reconnectAttempts = 0;
    this._autoReconnect = true;

    // Either this._ws (browser) or this._nativeId (electron bridge) is set.
    this._ws = null;
    this._nativeId = null;
    this._native = getNativeWs();
  }

  isOpen() {
    if (this.state !== STATE.OPEN) return false;
    if (this._native) return this._nativeId !== null;
    return this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  async connect() {
    if (this.state !== STATE.CLOSED) {
      return this.state === STATE.OPEN;
    }

    this._closing = false;
    this.state = STATE.CONNECTING;

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      if (this._native) {
        this._connectNative(finish);
      } else {
        this._connectBrowser(finish);
      }
    });
  }

  _connectNative(finish) {
    const headers = {
      "Authorization": this.token ? `Bearer ${this.token}` : "",
      "Protocol-Version": APP_CONFIG.PROTOCOL_VERSION,
      "Device-Id": this.identity.mac,
      "Client-Id": this.identity.clientId
    };
    if (!headers.Authorization) delete headers.Authorization;

    this._native.open(this.url, headers, (ev) => this._onNativeEvent(ev, finish))
      .then((id) => { this._nativeId = id; })
      .catch((err) => {
        console.error("[ws] native open threw:", err);
        finish(false);
      });
  }

  _onNativeEvent(ev, finish) {
    if (ev.type === "open") {
      this._sendClientHello();
      this.state = STATE.HELLO_SENT;
      this._helloTimer = setTimeout(() => {
        if (this.state !== STATE.OPEN) {
          console.warn("[ws] hello timeout");
          this._fail("hello timeout");
          finish(false);
        }
      }, 10000);
    } else if (ev.type === "text") {
      this._handleTextMessage(ev.data, finish);
    } else if (ev.type === "binary") {
      this.dispatchEvent(new CustomEvent("audio", { detail: new Uint8Array(ev.data) }));
    } else if (ev.type === "close") {
      if (!ev.wasClean || ev.code !== 1000) {
        console.warn("[ws] close code=%d reason=%s", ev.code, ev.reason);
      }
      this._handleClose(ev.code, ev.reason);
      if (finish) finish(false);
    } else if (ev.type === "error") {
      console.warn("[ws] error:", ev.message);
    }
  }

  _connectBrowser(finish) {
    try {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this._ws = ws;

      ws.addEventListener("open", () => {
        this._sendClientHello();
        this.state = STATE.HELLO_SENT;
        this._helloTimer = setTimeout(() => {
          if (this.state !== STATE.OPEN) {
            console.warn("[ws] hello timeout");
            this._fail("hello timeout");
            finish(false);
          }
        }, 10000);
      });

      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          this._handleTextMessage(ev.data, finish);
        } else if (ev.data instanceof ArrayBuffer) {
          this.dispatchEvent(new CustomEvent("audio", { detail: new Uint8Array(ev.data) }));
        }
      });

      ws.addEventListener("close", (ev) => {
        if (!ev.wasClean || ev.code !== 1000) {
          console.warn("[ws] close code=%d reason=%s", ev.code, ev.reason);
        }
        this._handleClose(ev.code, ev.reason);
        if (finish) finish(false);
      });

      ws.addEventListener("error", () => {});
    } catch (err) {
      console.error("[ws] connect threw", err);
      this._fail(`connect exception: ${err.message}`);
      finish(false);
    }
  }

  _handleTextMessage(text, finishConnect) {
    let msg;
    try { msg = JSON.parse(text); }
    catch { return; }

    if (msg.type === "hello") {
      if (this._helloTimer) { clearTimeout(this._helloTimer); this._helloTimer = null; }
      this.state = STATE.OPEN;
      this._reconnectAttempts = 0;
      if (msg.session_id) this.sessionId = msg.session_id;
      this.dispatchEvent(new CustomEvent("open", { detail: msg }));
      if (finishConnect) finishConnect(true);
      return;
    }

    if (msg.session_id) this.sessionId = msg.session_id;
    this.dispatchEvent(new CustomEvent("json", { detail: msg }));
  }

  _handleClose(code, reason) {
    const wasOpen = this.state === STATE.OPEN;
    this.state = STATE.CLOSED;
    if (this._helloTimer) { clearTimeout(this._helloTimer); this._helloTimer = null; }
    this._ws = null;
    this._nativeId = null;
    this.dispatchEvent(new CustomEvent("close", { detail: { code, reason, wasOpen } }));

    if (!this._closing && this._autoReconnect && this._reconnectAttempts < APP_CONFIG.RECONNECT.MAX_ATTEMPTS) {
      this._reconnectAttempts += 1;
      const delay = Math.min(
        APP_CONFIG.RECONNECT.BACKOFF_BASE_MS * this._reconnectAttempts,
        APP_CONFIG.RECONNECT.BACKOFF_MAX_MS
      );
      this.dispatchEvent(new CustomEvent("reconnecting", { detail: { attempt: this._reconnectAttempts, delay } }));
      setTimeout(() => {
        if (!this._closing) this.connect();
      }, delay);
    }
  }

  _fail(reason) {
    if (this._ws) try { this._ws.close(); } catch {}
    if (this._native && this._nativeId !== null) {
      this._native.close(this._nativeId).catch(() => {});
    }
    this.dispatchEvent(new CustomEvent("error", { detail: { reason } }));
  }

  _sendClientHello() {
    const audio = APP_CONFIG.AUDIO;
    const hello = {
      type: ClientMsg.HELLO,
      version: 1,
      // greeting_url: the wake greeting comes as a link to play, not as reply audio
      features: { mcp: true, greeting_url: true },
      transport: "websocket",
      audio_params: {
        format: "opus",
        sample_rate: audio.INPUT_SAMPLE_RATE,
        channels: audio.CHANNELS,
        frame_duration: audio.FRAME_DURATION_MS
      }
    };
    this._sendText(hello);
  }

  _sendText(obj) {
    const json = JSON.stringify(obj);
    if (this._native && this._nativeId !== null) {
      return this._native.sendText(this._nativeId, json)
        .then((sent) => sent !== false)
        .catch(() => false);
    }
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(json); return true; } catch { return false; }
    }
    return false;
  }

  sendAudio(bytes) {
    if (!this.isOpen()) return false;
    if (this._native && this._nativeId !== null) {
      // bytes is Uint8Array — pass the underlying buffer
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this._native.sendBinary(this._nativeId, ab).catch(() => {});
      return true;
    }
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(bytes); return true; } catch { return false; }
    }
    return false;
  }

  sendStartListening(mode) {
    return this._sendText({ session_id: this.sessionId, type: ClientMsg.LISTEN, state: ListenState.START, mode });
  }
  sendStopListening() {
    return this._sendText({ session_id: this.sessionId, type: ClientMsg.LISTEN, state: ListenState.STOP });
  }
  // `wake: true` marks a locally detected wake word, so the server doesn't
  // have to guess it from the text (typed chat input uses the same message).
  sendDetectWord(text, { wake = false } = {}) {
    const msg = { session_id: this.sessionId, type: ClientMsg.LISTEN, state: ListenState.DETECT, text };
    if (wake) msg.wake = true;
    return this._sendText(msg);
  }
  sendAbort(reason) {
    const msg = { session_id: this.sessionId, type: ClientMsg.ABORT };
    if (reason) msg.reason = reason;
    return this._sendText(msg);
  }
  sendMcp(payload) {
    return this._sendText({ session_id: this.sessionId, type: ClientMsg.MCP, payload });
  }

  stopReconnecting() {
    this._autoReconnect = false;
  }

  async close() {
    this._closing = true;
    this._autoReconnect = false;
    if (this._ws) try { this._ws.close(); } catch {}
    if (this._native && this._nativeId !== null) {
      this._native.close(this._nativeId).catch(() => {});
    }
    this._ws = null;
    this._nativeId = null;
    this.state = STATE.CLOSED;
  }
}
