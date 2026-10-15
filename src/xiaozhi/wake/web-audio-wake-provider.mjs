function toWsUrl(httpUrl) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/wake_word/audio";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class WebAudioWakeProvider {
  constructor({ hostServiceUrl, audioCapture } = {}) {
    if (!audioCapture || typeof audioCapture.onFrame !== "function") {
      throw new Error("WebAudioWakeProvider requires the shared AudioCapture");
    }
    this.url = toWsUrl(hostServiceUrl || "http://127.0.0.1:5000");
    this.audioCapture = audioCapture;
    this.handlers = new Set();
    this.statusHandlers = new Set();
    this.socket = null;
    this.unsubscribeAudio = null;
    this.running = false;
    this.stopping = false;
    this.reconnectTimer = null;
    this.lastStatus = { running: false, mode: "stopped", transport: "web-audio" };
  }

  onWake(handler) {
    if (typeof handler === "function") this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler) {
    if (typeof handler === "function") this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  async start() {
    if (this.running && this.socket?.readyState === WebSocket.OPEN) return this.lastStatus;
    this.stopping = false;
    await this.audioCapture.start("wake-word");
    if (!this.unsubscribeAudio) {
      this.unsubscribeAudio = this.audioCapture.onFrame((frame) => this._sendFrame(frame));
    }
    return this._connect();
  }

  async stop() {
    this.stopping = true;
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.unsubscribeAudio) this.unsubscribeAudio();
    this.unsubscribeAudio = null;
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    await this.audioCapture.stop("wake-word");
    this._setStatus({ running: false, mode: "stopped", transport: "web-audio" });
    return this.lastStatus;
  }

  getStatus() {
    return this.lastStatus;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      socket.onopen = () => {
        this.running = true;
      };
      socket.onmessage = (event) => {
        let payload;
        try { payload = JSON.parse(String(event.data || "{}")); } catch { return; }
        if (payload.type === "wake") {
          for (const handler of this.handlers) handler(payload);
          return;
        }
        if (payload.type === "hello" || payload.type === "status") {
          this._setStatus({ ...payload, running: payload.running !== false, transport: "web-audio" });
          if (!settled) {
            settled = true;
            payload.running === false ? reject(new Error(payload.error || "wake engine unavailable")) : resolve(this.lastStatus);
          }
        }
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("wake audio websocket failed"));
        }
      };
      socket.onclose = () => {
        this.socket = null;
        this.running = false;
        if (!settled) {
          settled = true;
          reject(new Error("wake audio websocket closed during startup"));
        }
        if (!this.stopping) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this._connect().catch(() => {});
          }, 1000);
        }
      };
    });
  }

  _sendFrame(frame) {
    if (!this.running || this.socket?.readyState !== WebSocket.OPEN) return;
    const samples = frame instanceof Float32Array ? frame : new Float32Array(frame);
    try {
      this.socket.send(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength));
    } catch {}
  }

  _setStatus(status) {
    this.lastStatus = status;
    for (const handler of this.statusHandlers) handler(status);
  }
}
