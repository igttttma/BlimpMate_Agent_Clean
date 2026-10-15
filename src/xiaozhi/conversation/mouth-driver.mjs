// Drives the Live2D mouthOpen parameter from playback RMS.
// Applies smoothing + scaling to make it feel like talking.
export class MouthDriver {
  constructor(bridge, { gain = 6, maxOpen = 0.7, smoothing = 0.5, floor = 0.02, watchdogMs = 650 } = {}) {
    this.bridge = bridge;
    this.gain = gain;
    this.maxOpen = Math.min(1, Math.max(0, maxOpen));
    this.smoothing = smoothing;
    this.floor = floor;
    this.watchdogMs = watchdogMs;
    this._smoothed = 0;
    this._active = false;
    this._lastUpdate = 0;
    this._lastSignalAt = 0;
    this._watchdogTimer = null;
    this._forceClosed();
  }

  begin() {
    this._active = true;
    this._smoothed = 0;
    this._lastSignalAt = Date.now();
    this._armWatchdog();
  }

  end() {
    this._active = false;
    this._smoothed = 0;
    if (this._watchdogTimer) clearTimeout(this._watchdogTimer);
    this._watchdogTimer = null;
    // Keep the zero-value override active while silent. Releasing it here lets
    // an expression write MouthOpenY again on the next animation frame.
    this._forceClosed();
  }

  feedRms(rms) {
    if (!this._active) return;
    const raw = Math.min(this.maxOpen, Math.max(0, rms * this.gain - this.floor));
    if (raw > 0.005) this._lastSignalAt = Date.now();
    if (Date.now() - this._lastSignalAt >= this.watchdogMs) {
      this._forceClosed();
      return;
    }
    this._smoothed = this._smoothed * this.smoothing + raw * (1 - this.smoothing);
    if (this.bridge && this.bridge.setMouthOpen) {
      this.bridge.setMouthOpen(this._smoothed);
    }
  }

  _forceClosed() {
    this._smoothed = 0;
    if (this.bridge && this.bridge.setMouthOpen) {
      this.bridge.setMouthOpen(0);
    }
  }

  _armWatchdog() {
    if (this._watchdogTimer) clearTimeout(this._watchdogTimer);
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      if (!this._active) return;
      if (Date.now() - this._lastSignalAt >= this.watchdogMs) this._forceClosed();
      this._armWatchdog();
    }, this.watchdogMs);
  }
}
