import { CallClient } from "./call-client.mjs";
import { CallView } from "./call-view.mjs";
import { signalingUrl } from "./call-config.mjs";

// Video calls on the Blimp, voice-only and kept simple:
//   idle     the agent owns the mic (wake word "Hey Blimp" → conversation)
//   ringing  incoming call: the xiaozhi session is closed, Blimp rings, and the
//            wake-word engine listens for "answer"
//   calling  outgoing call: ringback; "Hey Blimp" cancels
//   in_call  WebRTC owns mic, camera and speaker; no wake word
// Any end of a call hands the mic back to the agent's wake word.

const BLIMP_MEDIA = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  // The Blimp display and camera are 16:9 landscape
  video: {
    facingMode: "user",
    width: { ideal: 1280 },
    height: { ideal: 720 },
    aspectRatio: { ideal: 16 / 9 },
    frameRate: { ideal: 24 }
  }
};

const END_MESSAGES = {
  declined: "Call declined",
  cancelled: "Call cancelled",
  no_answer: "No answer",
  hangup: "Call ended",
  peer_left: "Call ended",
  connection_lost: "Call dropped"
};

export class CallController extends EventTarget {
  /**
   * @param {object} deps
   * @param {object} deps.conversation  xiaozhi Conversation (endSession())
   * @param {() => object|null} deps.getWakeCoordinator  the agent's wake coordinator (start/stop)
   * @param {object|null} deps.wakeProvider  wake provider (desktop fallback keyword source)
   * @param {object|null} deps.nativeWake  Android bridge with startKeywords(set)
   * @param {(level, message, detail?) => void} [deps.log]
   */
  constructor({ conversation, getWakeCoordinator, wakeProvider = null, nativeWake = null, log = () => {} }) {
    super();
    this.conversation = conversation;
    this.getWakeCoordinator = getWakeCoordinator;
    this.wakeProvider = wakeProvider;
    this.nativeWake = nativeWake;
    this.log = log;
    this.client = null;
    this.state = "off";
    this.view = new CallView({
      onHangup: () => this.end("touch"),
      onAnswer: () => this.answer("touch"),
      onEnd: () => this.end("touch")
    });
    this._ownsAudio = false;
    this._stopKeywords = null;
    this._queue = Promise.resolve();
  }

  /** A call is ringing or in progress: the agent must not take the mic. */
  get busy() {
    return this.state === "ringing" || this.state === "calling" || this.state === "in_call";
  }

  get status() {
    return {
      state: this.state,
      connected: !!this.client?.connected,
      remote: this.client?.connected ? this.client.presence.remote : "unknown"
    };
  }

  /** Connect to the stream server ({ url }); an empty url turns calls off. */
  configure(cfg) {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this._setState("off");
    if (!cfg?.url) return;
    let url;
    try {
      url = signalingUrl(cfg);
    } catch (err) {
      this.log("error", "Video call server address is invalid", { error: String(err) });
      return;
    }
    const client = new CallClient({
      url,
      getMedia: () => navigator.mediaDevices.getUserMedia(BLIMP_MEDIA)
    });
    this.client = client;
    client.addEventListener("status", (e) => {
      if (this.client !== client) return;
      this.log(e.detail.connected ? "info" : "warn",
        e.detail.connected ? "Video call server connected" : "Video call server disconnected",
        { reason: e.detail.reason });
      if (e.detail.connected && this.state === "off") this._setState("idle");
      if (!e.detail.connected && !this.busy) this._setState("off");
      this._emitStatus();
    });
    client.addEventListener("presence", () => this._emitStatus());
    client.addEventListener("call", (e) => this.client === client && this._onCall(e.detail));
    // No self-view on the Blimp: only the remote stream is shown
    client.addEventListener("remote-stream", (e) => this.view.setRemoteStream(e.detail));
    client.addEventListener("error", (e) => {
      if (this.client !== client) return;
      this.log("warn", `Video call: ${e.detail.error}`);
      // An invite the server refused: there will be no call state change
      if (this.state === "calling" && (e.detail.error === "peer_offline" || e.detail.error === "busy")) {
        this._run(() => this._finish(e.detail.error === "busy" ? "Line busy" : "The remote user is offline"));
      }
    });
    client.connect();
  }

  /**
   * Call the remote user (the agent's call.start tool). Returns at once; the
   * call starts after `delayMs` so the tool result reaches the server before
   * the xiaozhi session is closed.
   */
  placeCall({ delayMs = 300 } = {}) {
    const client = this.client;
    if (!client?.connected) return { ok: false, reason: "not_connected" };
    if (this.busy) return { ok: false, reason: "busy" };
    const remote = client.presence.remote;
    if (remote !== "online") return { ok: false, reason: remote === "in_call" ? "busy" : "offline" };
    this._setState("calling");
    setTimeout(() => this._run(async () => {
      if (this.state !== "calling") return;
      this.view.calling("Hey Blimp");
      await this._takeAudio();
      this.view.startTone("outgoing");
      if (!client.invite()) return this._finish("Not connected");
      this._listenFor("wake", () => {
        this.log("info", "Video call: cancelled by wake word");
        client.hangup();
      });
    }), delayMs);
    return { ok: true };
  }

  hangup() {
    this.client?.hangup();
  }

  /**
   * End the call the normal way (decline if ringing, else hang up); the server's
   * idle state then shows the end card. Portal "End call" and the touch buttons.
   */
  end(by = "touch") {
    if (!this.busy) return false;
    this.log("info", `Video call: ended by ${by}`);
    if (this.state === "ringing") this.client?.decline();
    else this.client?.hangup();
    return true;
  }

  /** Decline a ringing call; otherwise no-op. */
  decline(by = "touch") {
    if (this.state !== "ringing") return false;
    return this.end(by);
  }

  /**
   * End any call at once because something else takes the speaker (portal
   * "play now"). Finishes locally, so the server's later idle state is a no-op.
   */
  async endCall() {
    if (!this.busy) return;
    this.log("info", "Video call: ended for another task");
    if (this.state === "ringing") this.client?.decline();
    else this.client?.hangup();
    await this._run(() => this.busy && this._finish("Call ended"));
    this.view.hide();
  }

  // ---- call state ----

  _onCall(call) {
    if (call.state === "ringing" && call.direction === "incoming") {
      this._run(() => this._ringing());
    } else if (call.state === "in_call") {
      this._run(() => this._inCall());
    } else if (call.state === "idle" && (this.busy || this._ownsAudio)) {
      this._run(() => this._finish(END_MESSAGES[call.reason] || "Call ended"));
    }
  }

  async _ringing() {
    this._setState("ringing");
    this.log("info", "Video call: incoming");
    this.view.ringing("answer");
    await this._takeAudio();
    if (this.state !== "ringing") return;
    this.view.startTone("incoming");
    this._listenFor("answer", () => this.answer("voice"));
  }

  /** Pick up a ringing call (spoken "answer", or the portal's fallback button); otherwise no-op. */
  answer(by = "voice") {
    if (this.state !== "ringing") return false;
    this.log("info", `Video call: answered by ${by}`);
    this._stopListening();
    this.view.stopTone();
    this.client?.accept();
    return true;
  }

  async _inCall() {
    this._stopListening();
    this.view.stopTone();
    this._setState("in_call");
    this.log("info", "Video call: connected");
    this.view.inCall();
    this.view.setRemoteStream(this.client?.remoteStream || null);
  }

  async _finish(message) {
    this._stopListening();
    this.view.stopTone();
    this.log("info", `Video call: ${message}`);
    this._setState(this.client?.connected ? "idle" : "off");
    this.view.setRemoteStream(null);
    this.view.ended(message);
    await this._releaseAudio();
  }

  // ---- audio ownership ----

  async _takeAudio() {
    if (this._ownsAudio) return;
    this._ownsAudio = true;
    try { await this.getWakeCoordinator()?.stop(); } catch {}
    // Closes the xiaozhi connection (if any) and its microphone capture
    try { await this.conversation.endSession(); } catch {}
  }

  async _releaseAudio() {
    if (!this._ownsAudio) return;
    this._ownsAudio = false;
    try { await this.getWakeCoordinator()?.start(); } catch {}
  }

  /** Listen for a keyword set ("answer" or "wake") on the wake-word engine. */
  _listenFor(set, onHit) {
    this._stopListening();
    const native = this.nativeWake;
    let off;
    if (typeof native?.startKeywords === "function") {
      off = native.onWake((e) => {
        if ((e?.keywords || "wake") === set) onHit(e);
      });
      native.startKeywords(set);
      this._stopKeywords = () => { off(); native.stop(); };
    } else if (this.wakeProvider) {
      // The desktop engine only knows "Hey Blimp"; it stands in for "answer"
      off = this.wakeProvider.onWake(onHit);
      this.wakeProvider.start().catch(() => {});
      this._stopKeywords = () => { off(); this.wakeProvider.stop?.().catch?.(() => {}); };
    }
  }

  _stopListening() {
    const stop = this._stopKeywords;
    this._stopKeywords = null;
    if (stop) try { stop(); } catch {}
  }

  // ---- helpers ----

  _run(fn) {
    this._queue = this._queue.catch(() => {}).then(fn).catch((err) => {
      this.log("error", "Video call error", { error: String(err?.message || err) });
    });
    return this._queue;
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emitStatus();
  }

  _emitStatus() {
    this.dispatchEvent(new CustomEvent("status", { detail: this.status }));
  }
}
