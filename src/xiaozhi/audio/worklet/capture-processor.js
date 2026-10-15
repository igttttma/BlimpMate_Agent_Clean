// AudioWorklet processor: receives device-rate mono PCM,
// resamples to targetSampleRate (16000) using linear interpolation,
// and posts fixed-size frames (320 samples = 20ms) to main thread.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 16000;
    this.frameSize = opts.frameSize || 320;
    this._ratio = sampleRate / this.targetRate;
    this._resamplePos = 0;
    this._inBuf = new Float32Array(0);
    this._outBuf = new Float32Array(this.frameSize);
    this._outFill = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    // Append to internal buffer
    const merged = new Float32Array(this._inBuf.length + ch.length);
    merged.set(this._inBuf, 0);
    merged.set(ch, this._inBuf.length);
    this._inBuf = merged;

    while (true) {
      const nextSampleIdx = Math.floor(this._resamplePos);
      if (nextSampleIdx + 1 >= this._inBuf.length) break;
      const frac = this._resamplePos - nextSampleIdx;
      const s0 = this._inBuf[nextSampleIdx];
      const s1 = this._inBuf[nextSampleIdx + 1];
      const sample = s0 + (s1 - s0) * frac;
      this._outBuf[this._outFill++] = sample;
      this._resamplePos += this._ratio;
      if (this._outFill >= this.frameSize) {
        const out = this._outBuf.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this._outBuf = new Float32Array(this.frameSize);
        this._outFill = 0;
      }
    }

    // Trim input buffer at integer sample boundary
    const drop = Math.floor(this._resamplePos);
    if (drop > 0) {
      this._inBuf = this._inBuf.subarray(drop);
      this._resamplePos -= drop;
    }
    return true;
  }
}

registerProcessor("xiaozhi-capture", CaptureProcessor);
