import { APP_CONFIG } from "../config/app-config.mjs";
import { resumeContext } from "./resume-context.mjs";

/**
 * Microphone capture: getUserMedia -> AudioWorklet (resample + 20 ms frames).
 *
 * The audio engine (AudioContext + worklet) is built on the first open and kept,
 * suspended, between sessions; each open only asks for a new microphone stream.
 * Rebuilding it on every wake made the Blimp's slow CPU open the mic late after
 * the greeting, so the user's first words were lost.
 */
export class AudioCapture {
  constructor({ workletUrl }) {
    this._workletUrl = workletUrl;
    this._ctx = null;
    this._node = null;      // worklet node (kept between sessions)
    this._gainNode = null;
    this._stream = null;    // current microphone stream (per session)
    this._source = null;
    this._frameHandlers = new Set();
    this._owners = new Set();
    this._startPromise = null;
    // How long the last open took, in ms: { mic, engine } (engine 0 when reused)
    this.lastOpenTiming = null;
  }

  onFrame(cb) {
    if (typeof cb === "function") this._frameHandlers.add(cb);
    return () => this._frameHandlers.delete(cb);
  }

  get isOpen() { return Boolean(this._source); }

  async start(owner = "default") {
    this._owners.add(owner);
    if (this._source) return;
    if (this._startPromise) {
      try {
        await this._startPromise;
      } catch (error) {
        this._owners.delete(owner);
        throw error;
      }
      return;
    }

    this._startPromise = this._open();
    try {
      await this._startPromise;
    } catch (error) {
      this._owners.delete(owner);
      throw error;
    } finally {
      this._startPromise = null;
    }
  }

  async _ensureEngine() {
    if (this._node) return;
    const ctx = new AudioContext();
    try {
      await resumeContext(ctx, "microphone");
      await ctx.audioWorklet.addModule(this._workletUrl);
      const node = new AudioWorkletNode(ctx, "xiaozhi-capture", {
        processorOptions: {
          targetSampleRate: APP_CONFIG.AUDIO.INPUT_SAMPLE_RATE,
          frameSize: APP_CONFIG.AUDIO.INPUT_FRAME_SIZE
        }
      });
      node.port.onmessage = (e) => {
        for (const handler of this._frameHandlers) {
          try { handler(e.data); } catch { /* one consumer must not block the audio bus */ }
        }
      };
      // Worklet doesn't need to feed the speaker, but Chrome requires destination
      // connection for the worklet to run reliably. Use a silent gain.
      const gain = ctx.createGain();
      gain.gain.value = 0;
      node.connect(gain).connect(ctx.destination);
      this._ctx = ctx;
      this._node = node;
      this._gainNode = gain;
    } catch (error) {
      try { await ctx.close(); } catch {}
      throw error;
    }
  }

  async _open() {
    const t0 = performance.now();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const t1 = performance.now();
    try {
      const reused = Boolean(this._node);
      await this._ensureEngine();
      if (reused) await resumeContext(this._ctx, "microphone");
      this._source = this._ctx.createMediaStreamSource(stream);
      this._source.connect(this._node);
      this._stream = stream;
      this.lastOpenTiming = {
        mic: Math.round(t1 - t0),
        engine: reused ? 0 : Math.round(performance.now() - t1)
      };
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      throw error;
    }
  }

  async stop(owner = "default") {
    this._owners.delete(owner);
    if (this._startPromise) {
      try { await this._startPromise; } catch { return; }
    }
    if (this._owners.size > 0) return;
    if (this._source) try { this._source.disconnect(); } catch {}
    this._source = null;
    if (this._stream) {
      for (const t of this._stream.getTracks()) t.stop();
      this._stream = null;
    }
    // Keep the engine for the next session; suspended it costs no CPU
    if (this._ctx && typeof this._ctx.suspend === "function") {
      try { await this._ctx.suspend(); } catch {}
    }
  }

  async shutdown() {
    this._owners.clear();
    await this.stop("shutdown");
    if (this._node) try { this._node.disconnect(); } catch {}
    if (this._gainNode) try { this._gainNode.disconnect(); } catch {}
    this._node = null;
    this._gainNode = null;
    if (this._ctx) {
      try { await this._ctx.close(); } catch {}
      this._ctx = null;
    }
  }
}
