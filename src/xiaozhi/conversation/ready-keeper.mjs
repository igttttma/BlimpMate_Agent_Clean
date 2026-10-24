// Keeps the Blimp ready while nothing else is going on, like a built-in
// assistant: connected to the server and listening for the wake word, with no
// click needed. Whatever ended last (a conversation, portal media, a video
// call, the app coming back to the front, a dropped link) it checks right
// after, and every few seconds anyway. A video call or a conversation owns the
// microphone and the link while it lasts; the keeper leaves those alone.
//
// It is the one place that reconnects: the conversation's own protocol never
// does, so two links can't race each other.

const CHECK_MS = 5000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;

export class ReadyKeeper {
  /**
   * @param {object} deps
   * @param {object} deps.conversation  xiaozhi Conversation (idle, connect())
   * @param {() => object|null} deps.getWakeCoordinator  null: no wake word to keep
   * @param {() => boolean} [deps.isBusy]  a video call holds the mic
   * @param {(level, message, detail?) => void} [deps.log]
   */
  constructor({ conversation, getWakeCoordinator, isBusy = () => false, log = () => {} }) {
    this.conversation = conversation;
    this.getWakeCoordinator = getWakeCoordinator;
    this.isBusy = isBusy;
    this.log = log;
    this._timer = null;
    this._scheduled = false;
    this._checking = false;
    this._retryMs = RETRY_MIN_MS;
    this._nextConnectAt = 0;
    this._failing = false;
  }

  start() {
    if (this._timer) return;
    const conv = this.conversation;
    const check = () => this.check();
    conv.addEventListener("session-ended", check);
    conv.addEventListener("disconnected", check);
    conv.addEventListener("link-stale", check);
    conv.state.addEventListener("device", check);
    // Back in front, or the network is back: try at once, not after the backoff
    const now = () => { this._nextConnectAt = 0; this._retryMs = RETRY_MIN_MS; this.check(); };
    globalThis.document?.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "visible") now();
    });
    globalThis.addEventListener?.("online", now);
    this._timer = setInterval(check, CHECK_MS);
    this.check();
  }

  /** Check soon; calls in a burst make one check. */
  check() {
    if (this._scheduled) return;
    this._scheduled = true;
    setTimeout(() => {
      this._scheduled = false;
      this._run();
    }, 0);
  }

  _free() {
    return !this.isBusy() && this.conversation.idle;
  }

  async _run() {
    if (this._checking) return;
    this._checking = true;
    try {
      if (!this._free()) return;
      await this._keepConnected();
      // Connecting takes a while: a wake word or a call may have come meanwhile
      if (!this._free()) return;
      await this._keepWakeWord();
    } catch (err) {
      this.log("warn", "Ready check failed", { error: String(err?.message || err) });
    } finally {
      this._checking = false;
    }
  }

  async _keepConnected() {
    const conv = this.conversation;
    if (conv.protocol?.isOpen?.()) {
      this._retryMs = RETRY_MIN_MS;
      if (!conv._linkStale) return;
      // New server settings (voice, language, prompt...) apply to a new link
      this.log("info", "Server settings changed; reconnecting to apply them");
      await conv.disconnect();
    }
    if (Date.now() < this._nextConnectAt) return;
    const ok = await conv.connect();
    if (ok) {
      if (this._failing) this.log("info", "Server connection is back");
      this._failing = false;
      this._retryMs = RETRY_MIN_MS;
      this._nextConnectAt = 0;
      return;
    }
    this._failing = true;
    this._nextConnectAt = Date.now() + this._retryMs;
    this.log("warn", `Server unreachable; retrying in ${Math.round(this._retryMs / 1000)} s`);
    this._retryMs = Math.min(this._retryMs * 2, RETRY_MAX_MS);
  }

  async _keepWakeWord() {
    const wake = this.getWakeCoordinator();
    if (!wake) return;
    if (!wake.running) {
      this.log("info", "Wake word re-armed (it was off)");
      await wake.start();
      return;
    }
    // Armed as far as the coordinator knows; the detector stops itself on a
    // hit and may have been stopped for a conversation that never re-armed it
    // Only when it is off: starting up, or a retry the native side has
    // scheduled after an error, is left alone
    const status = wake.provider.getStatus?.();
    if (status && status.running === false && (status.message || "stopped") === "stopped") {
      this.log("info", "Wake word re-armed", { was: status.message || "stopped" });
      await wake.provider.start();
    }
  }
}
