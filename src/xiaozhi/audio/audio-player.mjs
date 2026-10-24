import { APP_CONFIG } from "../config/app-config.mjs";

export class AudioPlayer {
  constructor({ workletUrl }) {
    this._workletUrl = workletUrl;
    this._ctx = null;
    this._node = null;
    this._onRms = null;
    this._lastRms = 0;
    this._queued = 0; // chunks the worklet still has to play (from its rms reports)
    this._drainWaiters = [];
  }

  onRms(cb) { this._onRms = cb; }

  async start() {
    if (this._node) return;
    this._ctx = new AudioContext();
    if (this._ctx.state === "suspended") await this._ctx.resume();
    await this._ctx.audioWorklet.addModule(this._workletUrl);
    this._node = new AudioWorkletNode(this._ctx, "xiaozhi-playback", {
      processorOptions: {
        sourceSampleRate: APP_CONFIG.AUDIO.OUTPUT_SAMPLE_RATE
      }
    });
    this._node.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === "rms") {
        this._lastRms = m.value;
        this._queued = m.queued || 0;
        if (this._onRms) this._onRms(m.value);
        for (const waiter of this._drainWaiters.slice()) waiter(this._queued);
      }
    };
    this._node.connect(this._ctx.destination);
  }

  push(float32Pcm) {
    if (!this._node) return;
    // Transfer ownership
    this._node.port.postMessage({ type: "push", data: float32Pcm }, [float32Pcm.buffer]);
  }

  clear() {
    if (this._node) this._node.port.postMessage({ type: "clear" });
  }

  /** Resolves once everything pushed so far has played (or after `timeoutMs`). */
  drained(timeoutMs = 5000) {
    if (!this._node) return Promise.resolve();
    return new Promise((resolve) => {
      // Two empty reports in a row: one already on its way may predate the last push
      let empty = 0;
      const finish = () => {
        clearTimeout(timer);
        this._drainWaiters = this._drainWaiters.filter((w) => w !== waiter);
        resolve();
      };
      const waiter = (queued) => {
        empty = queued === 0 ? empty + 1 : 0;
        if (empty >= 2) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this._drainWaiters.push(waiter);
    });
  }

  async resume() {
    if (this._ctx && this._ctx.state === "suspended") await this._ctx.resume();
  }

  async stop() {
    if (this._node) try { this._node.disconnect(); } catch {}
    this._node = null;
    if (this._ctx) {
      try { await this._ctx.close(); } catch {}
      this._ctx = null;
    }
  }
}
