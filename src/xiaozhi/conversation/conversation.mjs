import { WsProtocol } from "../protocol/ws-protocol.mjs";
import { ListeningMode, DeviceState, AbortReason } from "../protocol/message-types.mjs";
import { StateManager } from "./state-manager.mjs";
import { MouthDriver } from "./mouth-driver.mjs";
import { OpusEncoder, OpusDecoder } from "../audio/opus-codec.mjs";
import { AudioCapture } from "../audio/audio-capture.mjs";
import { AudioPlayer } from "../audio/audio-player.mjs";
import { SilenceVad } from "../audio/vad.mjs";
import { McpServer } from "../mcp/mcp-server.mjs";
import { registerAllTools } from "../mcp/tools/index.mjs";

// Well inside the server's idle limit (180 s with the default settings)
const IDLE_PING_MS = 60000;

export class Conversation extends EventTarget {
  constructor({ bridge, identity, wsUrl, wsToken, assetUrls }) {
    super();
    this.bridge = bridge;
    this.identity = identity;
    this.wsUrl = wsUrl;
    this.wsToken = wsToken;
    this.assetUrls = assetUrls;

    this.state = new StateManager();
    this.mouth = new MouthDriver(bridge);
    this.vad = new SilenceVad();
    this.mcp = new McpServer();
    this.mcp.setLogger((level, message, detail = {}) => {
      this._emitLog(level, `[MCP] ${message}`, {
        source: "mcp-server",
        ...(detail || {})
      });
    });
    registerAllTools(this.mcp, bridge, {
      // The AI ends the conversation; the link stays for the next one
      endSession: () => this.endSession({ disconnect: false })
    });

    this.protocol = null;
    this.encoder = null;
    this.decoder = null;
    this.capture = null;
    this.player = null;
    this._encInited = false;
    this._initialized = false;
    this._sendingFrames = false;
    this._autoSessionActive = false;
    // Interrupt (portal setting, sent over the control connection): auto sessions
    // keep the microphone on while the AI speaks
    this.bargeIn = false;
    this._listenThroughReplies = false;
    this._ttsTurn = false; // between tts start and its stop/abort: TTS owns the mouth
    // Wake greeting: the server streams it like a reply (tts start ... stop)
    this._greetingWaiter = null; // resolves the wake activation's wait for its greeting
    this._connecting = null; // the connect() under way; callers share it
    this._activations = 0; // wake activations under way (connecting, greeting)
    this._listenGen = 0; // bumped by stopListening(): a startListening() still starting gives up
    this._pingTimer = null;
    this._linkStale = false; // the server's settings changed since this link opened
    this._sttText = "";
    this._ttsText = "";
    this._connectionState = {
      isConnected: false,
      connectInFlight: false,
      connectedAt: null,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastDisconnectReason: "",
      lastReconnectAttemptAt: null,
      lastReconnectScheduledAt: null,
      lastConnectFailureAt: null,
      lastConnectFailureReason: "",
      reconnectAttempts: 0
    };
    this._logs = [];
    this._wakeClient = null;
    this._wakeUnsubscribe = null;
    this._disconnectRecovery = null;
  }

  _markNow(key) {
    return new Date().toISOString();
  }

  getSessionStatus() {
    const protocol = this.protocol;
    return {
      isConnected: this._connectionState.isConnected,
      connectInFlight: this._connectionState.connectInFlight,
      connectedAt: this._connectionState.connectedAt,
      lastConnectedAt: this._connectionState.lastConnectedAt,
      lastDisconnectedAt: this._connectionState.lastDisconnectedAt,
      lastDisconnectReason: this._connectionState.lastDisconnectReason,
      lastReconnectAt: this._connectionState.lastReconnectAttemptAt,
      lastReconnectScheduledAt: this._connectionState.lastReconnectScheduledAt,
      lastConnectFailureAt: this._connectionState.lastConnectFailureAt,
      lastConnectFailureReason: this._connectionState.lastConnectFailureReason,
      reconnectAttempts: this._connectionState.reconnectAttempts,
      lastReconnectAttemptAt: this._connectionState.lastReconnectAttemptAt,
      protocolState: protocol ? protocol.state : "closed",
      protocolAttempts: protocol && Number.isFinite(protocol._reconnectAttempts)
        ? protocol._reconnectAttempts
        : 0,
      protocolConnected: !!protocol,
      protocolUrl: protocol && protocol.url,
      protocolSessionId: protocol && protocol.sessionId
    };
  }

  _emitLog(level, message, detail = {}) {
    const item = {
      ts: new Date().toISOString(),
      level: level || "info",
      message: String(message || "log"),
      detail
    };
    this._logs.unshift(item);
    if (this._logs.length > 30) this._logs.length = 30;
    if (typeof CustomEvent !== "undefined") {
      this.dispatchEvent(new CustomEvent("xz-log", { detail: item }));
    }
    if (console && console[level]) {
      console[level]("[session]", item.message, item.detail);
    }
    return item;
  }

  async init() {
    if (this._initialized) return;
    this._emitLog("info", "conversation initialized");
    this.encoder = new OpusEncoder({ workerUrl: this.assetUrls.encoderWorker });
    this._dbgPackets = 0;
    this._dbgFrames = 0;
    this._dbgSent = 0;
    this.encoder.onPacket((packet) => {
      this._dbgPackets++;
      if (this._dbgPackets <= 3 || this._dbgPackets % 50 === 0) {
        console.log("[audio] encoder packet #" + this._dbgPackets + " bytes=" + packet.length + " sending=" + this._sendingFrames + " wsOpen=" + (this.protocol && this.protocol.isOpen()));
      }
      if (this._sendingFrames && this.protocol && this.protocol.isOpen()) {
        this.protocol.sendAudio(packet);
        this._dbgSent++;
      }
    });

    this.decoder = new OpusDecoder({ scriptUrl: this.assetUrls.decoderScript });
    await this.decoder.init();

    this.capture = new AudioCapture({ workletUrl: this.assetUrls.captureWorklet });
    this.capture.onFrame((frame) => {
      this._dbgFrames++;
      if (this._dbgFrames <= 3 || this._dbgFrames % 50 === 0) {
        console.log("[audio] capture frame #" + this._dbgFrames + " len=" + frame.length);
      }
      // No local VAD — server decides when to stop in auto mode (py-xiaozhi parity)
      this.dispatchEvent(new CustomEvent("level", { detail: { rms: 0 } }));
      if (this._sendingFrames && this.encoder) this.encoder.encode(frame);
    });

    this.player = new AudioPlayer({ workletUrl: this.assetUrls.playbackWorklet });
    this.player.onRms((rms) => {
      // The worklet reports RMS all the time (zeros when idle); only a TTS turn
      // may drive the mouth, or those zeros fight other speakers (portal audio).
      // The turn, not the device state: a reply can start while listening starts.
      if (this._ttsTurn) this.mouth.feedRms(rms);
    });
    await this.player.start();

    this.mcp.setSender((payload) => {
      if (this.protocol && this.protocol.isOpen()) this.protocol.sendMcp(payload);
    });

    this._initialized = true;
  }

  /** No conversation: not listening, not speaking, not starting one from the wake word. */
  get idle() {
    return !this._autoSessionActive && !this._sendingFrames && this._activations === 0 &&
      this.state.device === DeviceState.IDLE;
  }

  async connect() {
    if (!this._initialized) await this.init();
    if (this.protocol && this.protocol.isOpen()) return true;
    // One attempt at a time: the wake word, the ready keeper and the panels all connect
    if (!this._connecting) {
      this._connecting = this._connect().finally(() => { this._connecting = null; });
    }
    return this._connecting;
  }

  async _connect() {
    this._connectionState.connectInFlight = true;
    this._emitLog("info", "connecting session");
    this.dispatchEvent(new CustomEvent("xz-status", {
      detail: { phase: "connecting", message: "Connecting to the server..." }
    }));
    // The ready keeper reconnects (with backoff); a link the protocol brought
    // back on its own would run next to the one connect() opens
    if (this.protocol) {
      this.protocol.stopReconnecting();
      await this.protocol.close();
    }
    const protocol = new WsProtocol({ url: this.wsUrl, token: this.wsToken, identity: this.identity });
    protocol.stopReconnecting();
    this.protocol = protocol;
    const current = (fn) => (e) => { if (this.protocol === protocol) fn(e); };
    this.protocol.addEventListener("open", current(() => {
      this._linkStale = false;
      this._startIdlePing();
      this._emitLog("info", "session open");
      this._connectionState.isConnected = true;
      this._connectionState.connectInFlight = false;
      this._connectionState.connectedAt = this._markNow("connectedAt");
      this._connectionState.lastConnectedAt = this._connectionState.connectedAt;
      this._connectionState.lastDisconnectedAt = null;
      this._connectionState.lastDisconnectReason = "";
      this._connectionState.reconnectAttempts = 0;
      this.state.setConnected(true, "open");
      this.dispatchEvent(new CustomEvent("connected"));
      this.dispatchEvent(new CustomEvent("xz-status", {
        detail: { phase: "connected", message: "Connected" }
      }));
    }));
    this.protocol.addEventListener("close", current((event) => {
      this._stopIdlePing();
      const conversationWasActive = this._autoSessionActive || this._sendingFrames;
      this._connectionState.connectInFlight = false;
      this._connectionState.isConnected = false;
      this._emitLog("warn", "session closed");
      this._connectionState.lastDisconnectedAt = this._markNow("lastDisconnectedAt");
      const detailReason = event?.detail;
      if (detailReason) {
        this._connectionState.lastDisconnectReason = `${detailReason.code || "unknown"}${detailReason.reason ? `: ${detailReason.reason}` : ""}`;
      } else {
        this._connectionState.lastDisconnectReason = "close";
      }
      this.state.setConnected(false, "close");
      this.dispatchEvent(new CustomEvent("disconnected"));
      if (conversationWasActive) {
        this._recoverFromRemoteDisconnect(detailReason).catch((error) => {
          this._emitLog("error", "disconnect recovery failed", { error: String(error) });
        });
      }
    }));
    this.protocol.addEventListener("reconnecting", current((e) => {
      this._connectionState.reconnectAttempts = Math.max(this._connectionState.reconnectAttempts, Number(e?.detail?.attempt) || 0);
      this._connectionState.lastReconnectScheduledAt = this._markNow("lastReconnectScheduledAt");
      this._connectionState.lastReconnectAttemptAt = this._markNow("lastReconnectAttemptAt");
      this._emitLog("info", `session reconnecting #${e.detail.attempt}`, { delay: e.detail.delay });
      this.dispatchEvent(new CustomEvent("reconnecting", { detail: e.detail }));
    }));
    this.protocol.addEventListener("json", current((e) => this._onJson(e.detail)));
    this.protocol.addEventListener("audio", current((e) => this._onAudio(e.detail)));
    const ok = await protocol.connect();
    this._connectionState.connectInFlight = false;
    if (!ok) {
      this._connectionState.isConnected = false;
      this._connectionState.lastConnectFailureAt = this._markNow("lastConnectFailureAt");
      this._connectionState.lastConnectFailureReason = "connect_or_hello_timeout";
      this.dispatchEvent(new CustomEvent("xz-status", {
        detail: { phase: "failed", message: "Could not connect to the server. Try again later." }
      }));
    }
    this._emitLog(ok ? "info" : "warn", `connect ${ok ? "success" : "failed"}`);
    return ok;
  }

  async disconnect() {
    this._stopIdlePing();
    const protocol = this.protocol;
    this.protocol = null;
    if (protocol) await protocol.close();
    this._connectionState.isConnected = false;
    this._connectionState.connectInFlight = false;
    this._connectionState.lastDisconnectedAt = this._markNow("lastDisconnectedAt");
    this._connectionState.lastDisconnectReason = "user";
    this.state.setConnected(false, "user");
    this._emitLog("info", "manual disconnect");
  }

  // The server closes a link with no activity (close_connection_no_voice_time
  // + 60 s). Between conversations a ping keeps it open; never during one, or
  // the server's no-voice timeout could not end it.
  _startIdlePing() {
    this._stopIdlePing();
    this._pingTimer = setInterval(() => {
      if (this.idle && this.protocol?.isOpen()) this.protocol.sendPing();
    }, IDLE_PING_MS);
  }

  _stopIdlePing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  /**
   * The server's settings changed (portal Save). A connection takes them when
   * it opens, so the ready keeper reconnects once no conversation is going on.
   */
  markLinkStale() {
    if (!this.protocol?.isOpen()) return;
    this._linkStale = true;
    this.dispatchEvent(new CustomEvent("link-stale"));
  }

  async endSession({ disconnect = true } = {}) {
    this._autoSessionActive = false;
    if (this.protocol?.isOpen?.()) {
      await this.abort(AbortReason.USER_INTERRUPTION);
    }
    await this.stopListening();
    if (this.player) this.player.clear();
    this._endTtsMouth();
    this.state.setDevice(DeviceState.IDLE);
    if (disconnect) await this.disconnect();
    this._emitLog("info", "session ended; wake word remains active");
    this.dispatchEvent(new CustomEvent("session-ended"));
    this.dispatchEvent(new CustomEvent("xz-status", {
      detail: { phase: "session-ended", message: "Session ended; waiting for wake word" }
    }));
    return true;
  }

  async _recoverFromRemoteDisconnect(detail = {}) {
    if (this._disconnectRecovery) return this._disconnectRecovery;
    this._disconnectRecovery = (async () => {
      this._autoSessionActive = false;
      this._sendingFrames = false;
      await this.stopListening();
      if (this.player) this.player.clear();
      this._endTtsMouth();
      this.state.setDevice(DeviceState.IDLE);
      this._emitLog("warn", "remote session ended; returning to wake-word mode", {
        code: detail?.code,
        reason: detail?.reason || ""
      });
      this.dispatchEvent(new CustomEvent("session-ended", {
        detail: { reason: "remote-disconnect", ...detail }
      }));
      this.dispatchEvent(new CustomEvent("xz-status", {
        detail: { phase: "session-ended", message: "Disconnected. Waiting for the wake word." }
      }));
      return true;
    })();
    try {
      return await this._disconnectRecovery;
    } finally {
      this._disconnectRecovery = null;
    }
  }

  /**
   * Attach a WakeClient so that wake events trigger a listening session.
   * The WakeClient is expected to expose `onWake(handler)` returning an
   * unsubscribe function, plus `start()`, `stop()`, `disconnect()`.
   */
  attachWakeClient(wakeClient) {
    if (!wakeClient) return;
    if (this._wakeClient === wakeClient) return;
    if (this._wakeClient) this.detachWakeClient();
    this._wakeClient = wakeClient;
    const handler = (event) => this.activateFromWake(event);
    const unsubscribe = typeof wakeClient.onWake === "function"
      ? wakeClient.onWake(handler)
      : null;
    this._wakeUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;
    this._emitLog("info", "wake client attached");
  }

  async activateFromWake(event = {}, { beforeListen } = {}) {
    const word = event?.word || "Hey Blimp";
    this._emitLog("info", "wake word detected", { word, source: "wake-provider" });
    this.dispatchEvent(new CustomEvent("xz-status", {
      detail: { phase: "wake-triggered", message: "Waking...", word }
    }));
    this.dispatchEvent(new CustomEvent("wake", { detail: { ...event, word } }));

    this._activations++;
    try {
      const preparation = typeof beforeListen === "function"
        ? Promise.resolve(beforeListen(event))
        : Promise.resolve();

      if (this.protocol?.isOpen?.()) {
        await this.abort(AbortReason.WAKE_WORD_DETECTED);
      }
      if (this._sendingFrames || this.capture?._node) {
        await this.stopListening();
      }
      await preparation;

      if (!this.protocol || !this.protocol.isOpen()) {
        const ok = await this.connect();
        if (!ok) {
          this._emitLog("warn", "wake connect failed; skipping startListening");
          this.dispatchEvent(new CustomEvent("session-ended", {
            detail: { reason: "wake-connect-failed" }
          }));
          return false;
        }
      }
      // Report the wake event explicitly (`wake: true`); the server answers
      // with its greeting instead of treating the phrase as user input.
      const greeting = this._awaitGreeting();
      const reported = await this.sendText(word, { wake: true });
      if (reported) {
        // Listen once the greeting has played, so the microphone doesn't hear it
        await greeting;
      } else {
        this._resolveGreetingWait();
        this._emitLog("warn", "wake-word report failed; continuing with microphone", { word });
      }
      return await this.startListening(ListeningMode.AUTO_STOP);
    } catch (err) {
      this._emitLog("error", "wake trigger failed", { error: String(err) });
      return false;
    } finally {
      this._activations--;
    }
  }

  detachWakeClient() {
    const client = this._wakeClient;
    this._wakeClient = null;
    if (typeof this._wakeUnsubscribe === "function") {
      try { this._wakeUnsubscribe(); } catch { /* noop */ }
    }
    this._wakeUnsubscribe = null;
    if (client && typeof client.disconnect === "function") {
      try { client.disconnect(); } catch { /* noop */ }
    }
    if (client) this._emitLog("info", "wake client detached");
  }

  async _ensureEncoder() {
    if (this._encInited) return;
    await this.encoder.init();
    this._encInited = true;
  }

  async startListening(mode) {
    console.log("[audio] startListening mode=" + mode);
    // A stopListening() (session ended, link closed) while this one is still
    // starting wins: the late start must not reopen the microphone
    const gen = this._listenGen;
    const superseded = () => gen !== this._listenGen;
    if (!this.protocol || !this.protocol.isOpen()) {
      const ok = await this.connect();
      if (!ok) { console.warn("[audio] startListening: connect failed"); return false; }
      if (superseded()) return false;
    }
    this._emitLog("info", `start listening`, { mode });
    try {
      await this._ensureEncoder();
      console.log("[audio] encoder ready");
    } catch (e) {
      console.error("[audio] encoder init failed:", e);
      return false;
    }
    if (superseded()) return false;
    try {
      await this.capture.start("conversation");
      console.log("[audio] capture ready, ctx rate=" + (this.capture._ctx && this.capture._ctx.sampleRate));
    } catch (e) {
      console.error("[audio] capture start failed:", e);
      return false;
    }
    if (superseded() || !this.protocol?.isOpen()) {
      this._emitLog("info", "listening cancelled while starting");
      if (!this._sendingFrames) await this.capture.stop("conversation");
      return false;
    }
    this.vad.reset();
    this._sendingFrames = true;
    if (mode === ListeningMode.AUTO_STOP) this._autoSessionActive = true;
    // Interrupt (server setting): an auto session keeps the microphone on while
    // the AI speaks ("realtime"); the server cuts the reply when it hears speech
    this._listenThroughReplies = mode === ListeningMode.AUTO_STOP && this.bargeIn === true;
    if (this._listenThroughReplies) this._emitLog("info", "interrupt on: listening while the AI speaks");
    this.state.setMode(mode);
    // Listening through replies: a reply already playing stays "speaking"
    if (!(this._listenThroughReplies && this.state.device === DeviceState.SPEAKING)) {
      this.state.setDevice(DeviceState.LISTENING);
    }
    this.protocol.sendStartListening(
      this._listenThroughReplies || mode === ListeningMode.REALTIME ? "realtime" :
      mode === ListeningMode.AUTO_STOP ? "auto" : "manual"
    );
    return true;
  }

  async stopListening() {
    console.log("[audio] stopListening, frames=" + this._dbgFrames + " packets=" + this._dbgPackets + " sent=" + this._dbgSent);
    this._emitLog("info", "stop listening");
    this._listenGen++;
    this._sendingFrames = false;
    this._listenThroughReplies = false;
    if (this.encoder) await this.encoder.flush();
    if (this.protocol?.isOpen?.()) this.protocol.sendStopListening();
    if (this.capture) await this.capture.stop("conversation");
    if (this.state.device === DeviceState.LISTENING) {
      this.state.setDevice(DeviceState.IDLE);
    }
  }

  async sendText(text, { wake = false } = {}) {
    const normalizedText = typeof text === "string" ? text.trim() : "";
    if (!normalizedText) {
      this._emitLog("warn", "send text skipped: empty input");
      return false;
    }
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.protocol || !this.protocol.isOpen()) {
        const ok = await this.connect();
        if (!ok) {
          const canRetry = attempt < maxAttempts;
          const reason = this._connectionState.lastConnectFailureReason || "connect_fail";
          this._emitLog(
            canRetry ? "warn" : "error",
            `Session is not connected. Failed to send text (${canRetry ? "retry" : "abort"})`,
            {
              action: "send_text",
              attempt,
              maxAttempts,
              reason,
              suggested_action: "Check the network and connect, or try again later"
            }
          );
          if (!canRetry) {
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, 600));
          continue;
        }
      }
      try {
        const sent = await this.protocol.sendDetectWord(normalizedText, { wake });
        if (!sent) throw new Error("websocket send failed");
        this._emitLog("info", "send text", { text: normalizedText, attempt });
        return true;
      } catch (err) {
        const details = {
          action: "send_text",
          attempt,
          maxAttempts,
          error: err?.message || String(err)
        };
        this._emitLog(
          attempt < maxAttempts ? "warn" : "error",
          "Failed to send text",
          {
            ...details,
            suggested_action: "Check the session status and retry, or reconnect the session"
          }
        );
        if (attempt >= maxAttempts) return false;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    return false;
  }

  _beginTtsMouth() {
    this._ttsTurn = true;
    this.mouth.begin();
  }

  _endTtsMouth() {
    this._ttsTurn = false;
    this.mouth.end();
  }

  async abort(reason = AbortReason.USER_INTERRUPTION) {
    if (!this.protocol) return;
    this._emitLog("warn", "abort", { reason });
    this.protocol.sendAbort(reason);
    if (this.player) this.player.clear();
    this._endTtsMouth();
    this.state.setAborted(true);
    if (this.state.device !== DeviceState.IDLE) this.state.setDevice(DeviceState.IDLE);
  }

  // Resolves when the wake greeting has played; also when the server answers
  // the wake some other way (reply audio, nothing) or not at all
  _awaitGreeting(timeoutMs = 8000) {
    this._resolveGreetingWait();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this._resolveGreetingWait(), timeoutMs);
      this._greetingWaiter = () => { clearTimeout(timer); resolve(); };
    });
  }

  _resolveGreetingWait() {
    const resolve = this._greetingWaiter;
    this._greetingWaiter = null;
    if (resolve) resolve();
  }

  _onJson(msg) {
    const type = msg.type;
    console.log("[ws<-] json type=" + type, msg);
    if (type === "tts") {
      const st = msg.state;
      if (st === "start") {
        // In AUTO mode, server-initiated TTS means stop capturing (unless the
        // session listens through replies so speech can interrupt them)
        if (this.state.mode === ListeningMode.AUTO_STOP &&
            this.state.device === DeviceState.LISTENING && !this._listenThroughReplies) {
          this.stopListening().catch(() => {});
        }
        this.state.setDevice(DeviceState.SPEAKING);
        this._beginTtsMouth();
        if (this.player) this.player.resume();
      } else if (st === "stop") {
        this._endTtsMouth();
        if (this._greetingWaiter && !msg.interrupted) {
          // The server has answered the wake (greeting, or nothing). The wake
          // activation starts listening once the greeting has played out, so the
          // microphone doesn't hear it. (An interrupted stop answers the wake's
          // own abort, not the wake.)
          this.state.setDevice(DeviceState.IDLE);
          const waiter = this._greetingWaiter;
          (this.player ? this.player.drained() : Promise.resolve()).then(() => {
            if (this._greetingWaiter === waiter) this._resolveGreetingWait();
          });
        } else if (this._listenThroughReplies && this._sendingFrames) {
          // Still listening. A normal stop can arrive while the last ~100 ms
          // still play, so only an interrupt drops the buffered reply audio.
          // No new listen start: it would reset the server's audio mid-sentence.
          if (msg.interrupted && this.player) this.player.clear();
          this.state.setDevice(DeviceState.LISTENING);
        } else if (this.state.mode === ListeningMode.AUTO_STOP && this._autoSessionActive &&
                   this._activations === 0) {
          // After TTS in auto mode, resume listening for the next turn. (A wake
          // activation under way starts listening itself.)
          this.state.setDevice(DeviceState.IDLE);
          this.startListening(ListeningMode.AUTO_STOP).catch((e) =>
            console.warn("[audio] auto re-listen failed:", e));
        } else {
          this.state.setDevice(DeviceState.IDLE);
        }
      } else if (st === "sentence_start" || st === "sentence_end") {
        // ignore
      }
      if (typeof msg.text === "string") {
        this._ttsText = msg.text;
        this.dispatchEvent(new CustomEvent("tts-text", { detail: msg.text }));
      }
    } else if (type === "stt") {
      if (typeof msg.text === "string") {
        this._sttText = msg.text;
        this.dispatchEvent(new CustomEvent("stt-text", { detail: msg.text }));
      }
    } else if (type === "llm") {
      if (msg.emotion) {
        this.bridge.setTextEmotion(msg.emotion);
        this.dispatchEvent(new CustomEvent("emotion", { detail: msg.emotion }));
      }
    } else if (type === "mcp") {
      if (msg.payload) this.mcp.handleIncoming(msg.payload);
    } else if (type === "goodbye") {
      this.disconnect();
    }
  }

  _onAudio(bytes) {
    if (!this._dbgAudioIn) this._dbgAudioIn = 0;
    this._dbgAudioIn++;
    if (this._dbgAudioIn <= 3 || this._dbgAudioIn % 50 === 0) {
      console.log("[audio<-] opus frame #" + this._dbgAudioIn + " bytes=" + bytes.length);
    }
    if (!this.decoder) return;
    let pcm = null;
    try {
      pcm = this.decoder.decode(bytes);
    } catch (e) {
      console.warn("[audio<-] decode threw:", e);
      return;
    }
    if (pcm && this.player) {
      if (this._dbgAudioIn <= 3) {
        console.log("[audio<-] decoded pcm samples=" + pcm.length);
      }
      const copy = new Float32Array(pcm.length);
      copy.set(pcm);
      this.player.push(copy);
    } else if (!pcm && this._dbgAudioIn <= 3) {
      console.warn("[audio<-] decoder returned null");
    }
  }
}
