import { APP_CONFIG } from "../config/app-config.mjs";

export class SilenceVad {
  constructor() {
    this.reset();
  }

  reset() {
    this._silenceMs = 0;
    this._voiceMs = 0;
    this._spokeOnce = false;
  }

  feed(float32Frame, frameDurationMs = APP_CONFIG.AUDIO.FRAME_DURATION_MS) {
    let sum = 0;
    for (let i = 0; i < float32Frame.length; i++) sum += float32Frame[i] * float32Frame[i];
    const rms = Math.sqrt(sum / float32Frame.length);
    if (rms > APP_CONFIG.VAD.SILENCE_RMS) {
      this._voiceMs += frameDurationMs;
      this._silenceMs = 0;
      if (this._voiceMs >= APP_CONFIG.VAD.MIN_VOICE_DURATION_MS) {
        this._spokeOnce = true;
      }
    } else {
      this._silenceMs += frameDurationMs;
    }
    return {
      rms,
      voiceMs: this._voiceMs,
      silenceMs: this._silenceMs,
      shouldStop: this._spokeOnce && this._silenceMs >= APP_CONFIG.VAD.SILENCE_DURATION_MS
    };
  }
}
