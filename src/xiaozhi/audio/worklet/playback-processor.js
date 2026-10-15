// Playback worklet: pulls Float32 chunks from a queue, computes per-frame RMS
// and posts it back. Resamples queue samples to audioContext rate via linear.
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.sourceRate = opts.sourceSampleRate || 24000;
    this._ratio = this.sourceRate / sampleRate;
    this._queue = [];      // array of Float32Array
    this._readIdx = 0;     // float index within current chunk
    this._rmsAcc = 0;
    this._rmsCount = 0;
    this._rmsReportInterval = Math.max(1, Math.floor(sampleRate / 30));
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === "push" && m.data instanceof Float32Array) {
        this._queue.push(m.data);
      } else if (m && m.type === "clear") {
        this._queue.length = 0;
        this._readIdx = 0;
      }
    };
  }

  _readSample() {
    while (this._queue.length > 0) {
      const cur = this._queue[0];
      const baseIdx = Math.floor(this._readIdx);
      if (baseIdx + 1 < cur.length) {
        const frac = this._readIdx - baseIdx;
        const s0 = cur[baseIdx];
        const s1 = cur[baseIdx + 1];
        this._readIdx += this._ratio;
        return s0 + (s1 - s0) * frac;
      }
      // need to advance to next chunk
      const remain = cur.length - baseIdx;
      this._readIdx -= baseIdx;
      this._queue.shift();
      if (this._queue.length === 0) {
        this._readIdx = 0;
        return null;
      }
      // glue: position into the new chunk
      // (lose at most 1 sample of resample fraction continuity — acceptable)
      this._readIdx = 0;
    }
    return null;
  }

  process(_, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    let lastValid = 0;
    for (let i = 0; i < out.length; i++) {
      const s = this._readSample();
      if (s === null) {
        out[i] = 0;
      } else {
        out[i] = s;
        lastValid = s;
      }
      this._rmsAcc += s ? s * s : 0;
      this._rmsCount += 1;
      if (this._rmsCount >= this._rmsReportInterval) {
        const rms = Math.sqrt(this._rmsAcc / this._rmsCount);
        this.port.postMessage({ type: "rms", value: rms, queued: this._queue.length });
        this._rmsAcc = 0;
        this._rmsCount = 0;
      }
    }
    // suppress unused-var lint
    void lastValid;
    return true;
  }
}

registerProcessor("xiaozhi-playback", PlaybackProcessor);
