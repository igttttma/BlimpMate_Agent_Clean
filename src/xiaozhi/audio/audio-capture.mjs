import { APP_CONFIG } from "../config/app-config.mjs";

export class AudioCapture {
  constructor({ workletUrl }) {
    this._workletUrl = workletUrl;
    this._ctx = null;
    this._stream = null;
    this._node = null;
    this._frameHandlers = new Set();
    this._owners = new Set();
    this._gainNode = null;
    this._startPromise = null;
  }

  onFrame(cb) {
    if (typeof cb === "function") this._frameHandlers.add(cb);
    return () => this._frameHandlers.delete(cb);
  }

  async start(owner = "default") {
    this._owners.add(owner);
    if (this._node) return;
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

  async _open() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    this._stream = stream;
    try {
      this._ctx = new AudioContext();
      if (this._ctx.state === "suspended") await this._ctx.resume();
      await this._ctx.audioWorklet.addModule(this._workletUrl);
      const src = this._ctx.createMediaStreamSource(stream);
      this._node = new AudioWorkletNode(this._ctx, "xiaozhi-capture", {
        processorOptions: {
          targetSampleRate: APP_CONFIG.AUDIO.INPUT_SAMPLE_RATE,
          frameSize: APP_CONFIG.AUDIO.INPUT_FRAME_SIZE
        }
      });
      this._node.port.onmessage = (e) => {
        for (const handler of this._frameHandlers) {
          try { handler(e.data); } catch { /* one consumer must not block the audio bus */ }
        }
      };
      src.connect(this._node);
      // Worklet doesn't need to feed the speaker, but Chrome requires destination
      // connection for the worklet to run reliably. Use a silent gain.
      this._gainNode = this._ctx.createGain();
      this._gainNode.gain.value = 0;
      this._node.connect(this._gainNode).connect(this._ctx.destination);
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      this._stream = null;
      if (this._ctx) {
        try { await this._ctx.close(); } catch {}
        this._ctx = null;
      }
      throw error;
    }
  }

  async stop(owner = "default") {
    this._owners.delete(owner);
    if (this._startPromise) {
      try { await this._startPromise; } catch { return; }
    }
    if (this._owners.size > 0) return;
    if (this._node) try { this._node.disconnect(); } catch {}
    this._node = null;
    if (this._gainNode) try { this._gainNode.disconnect(); } catch {}
    this._gainNode = null;
    if (this._stream) {
      for (const t of this._stream.getTracks()) t.stop();
      this._stream = null;
    }
    if (this._ctx) {
      try { await this._ctx.close(); } catch {}
      this._ctx = null;
    }
  }

  async shutdown() {
    this._owners.clear();
    await this.stop("shutdown");
  }
}
