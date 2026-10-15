import { APP_CONFIG } from "../config/app-config.mjs";

export class AudioPlayer {
  constructor({ workletUrl }) {
    this._workletUrl = workletUrl;
    this._ctx = null;
    this._node = null;
    this._onRms = null;
    this._lastRms = 0;
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
        if (this._onRms) this._onRms(m.value);
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
