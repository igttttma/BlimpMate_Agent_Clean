import { APP_CONFIG } from "../config/app-config.mjs";

/**
 * Conversation microphone on Android: the audio of the wake word's native
 * recorder (window.nativeWakeWord), handed over instead of opening a WebView
 * microphone. That recorder is already open when "Hey Blimp" fires and stays
 * open between turns, so listening starts at once (the WebView mic took ~1.3 s
 * to open on the Blimp and lost the user's first words).
 *
 * Same interface as AudioCapture: onFrame / start / stop / isOpen.
 * Frames are 20 ms Float32 at 16 kHz, like the capture worklet's.
 *
 * Robustness (the stream must never silently stay dead):
 * - every start() asks the native side for the stream, even if this side
 *   believes it is already open (a call hand-off or a page reload can stop it
 *   underneath);
 * - a stream left running by a previous page is stopped when this one starts;
 * - while open, a watchdog asks for the stream again when no audio has arrived
 *   for STALL_MS, and reports it (onStall).
 */
export class NativeMicCapture {
  static STALL_MS = 1500;

  static isSupported(bridge = globalThis.nativeWakeWord) {
    return Boolean(bridge && typeof bridge.startStream === "function" && typeof bridge.onPcm === "function");
  }

  constructor({ bridge = globalThis.nativeWakeWord, onStall = null } = {}) {
    this._bridge = bridge;
    this._frameHandlers = new Set();
    this._owners = new Set();
    this._open = false;
    this._frameSize = APP_CONFIG.AUDIO.INPUT_FRAME_SIZE;
    this._pending = new Float32Array(0);
    this._lastChunkAt = 0;
    this._watchdog = null;
    this.onStall = onStall;
    this.lastOpenTiming = null;
    // The Blimp's mic hardware cancels the speaker's echo itself, so the mic
    // stays live while the Blimp speaks and the user can interrupt (barge-in).
    // (The Android echo canceller isn't used: switched on per conversation it
    // left the stream near-silent from the second conversation on.)
    this.echoCancelled = true;
    this._ctx = { sampleRate: APP_CONFIG.AUDIO.INPUT_SAMPLE_RATE }; // for logs
    this._unsubscribe = bridge.onPcm((chunk) => this._onChunk(chunk));
    // A previous page (reload mid-conversation) may have left the stream on
    try { bridge.stopStream?.(); } catch { /* not running */ }
  }

  get isOpen() { return this._open; }

  /** The native recorder's state ({ running, streaming, recording, audio_samples, ... }). */
  status() {
    try { return this._bridge.getStatus?.() || null; } catch { return null; }
  }

  onFrame(cb) {
    if (typeof cb === "function") this._frameHandlers.add(cb);
    return () => this._frameHandlers.delete(cb);
  }

  async start(owner = "default") {
    this._owners.add(owner);
    const t0 = performance.now();
    // Always ask: the native stream may have been stopped underneath us
    const status = this._bridge.startStream() || {};
    if (status.running === false) {
      this._owners.delete(owner);
      throw new Error(`native microphone unavailable: ${status.message || "unknown"}`);
    }
    if (!this._open) this._pending = new Float32Array(0);
    this._open = true;
    this._lastChunkAt = performance.now();
    this.lastOpenTiming = { native_mic: Math.round(performance.now() - t0) };
    this._startWatchdog();
  }

  async stop(owner = "default") {
    this._owners.delete(owner);
    if (this._owners.size > 0 || !this._open) return;
    this._open = false;
    this._stopWatchdog();
    this._pending = new Float32Array(0);
    try { this._bridge.stopStream(); } catch {}
  }

  /** Give the microphone up entirely (a video call is about to open its own). */
  release() {
    this._open = false;
    this._owners.clear();
    this._stopWatchdog();
    try { this._bridge.releaseMic?.(); } catch {}
  }

  async shutdown() {
    this._owners.clear();
    await this.stop("shutdown");
    this.release();
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  }

  _startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(() => {
      if (!this._open) return this._stopWatchdog();
      const silentFor = performance.now() - this._lastChunkAt;
      if (silentFor < NativeMicCapture.STALL_MS) return;
      // No audio at all from the native recorder: ask for the stream again
      // (restarts the recorder if it died) and say so
      const before = this.status();
      let after = null;
      try { after = this._bridge.startStream(); } catch { /* reported below */ }
      this._lastChunkAt = performance.now();
      console.warn("[audio] native mic stalled; restarting the stream", { silentFor, before, after });
      try { this.onStall?.({ silent_ms: Math.round(silentFor), before, after }); } catch { /* diagnostics only */ }
    }, 500);
  }

  _stopWatchdog() {
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = null;
  }

  _onChunk(chunk) {
    if (!this._open || !chunk || !chunk.length) return;
    this._lastChunkAt = performance.now();
    let buf = chunk;
    if (this._pending.length) {
      buf = new Float32Array(this._pending.length + chunk.length);
      buf.set(this._pending);
      buf.set(chunk, this._pending.length);
    }
    let offset = 0;
    while (buf.length - offset >= this._frameSize) {
      const frame = buf.slice(offset, offset + this._frameSize);
      offset += this._frameSize;
      for (const handler of this._frameHandlers) {
        try { handler(frame); } catch { /* one consumer must not block the others */ }
      }
    }
    this._pending = buf.slice(offset);
  }
}
