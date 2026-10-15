// Wraps opus-recorder's encoderWorker (Ogg Opus output) and demuxes pages
// into raw Opus packets matching what the xiaozhi server expects.
//
// The worker is loaded from the shared-web folder via assetUrl(). The wasm
// is colocated next to the worker JS, the worker fetches it itself.
import { OggOpusDemuxer } from "./ogg-demuxer.mjs";
import { APP_CONFIG } from "../config/app-config.mjs";

export class OpusEncoder {
  constructor({ workerUrl, sampleRate = APP_CONFIG.AUDIO.INPUT_SAMPLE_RATE }) {
    this._worker = null;
    this._workerUrl = workerUrl;
    this._sampleRate = sampleRate;
    this._demuxer = new OggOpusDemuxer();
    this._onPacket = null;
    this._ready = null;
  }

  onPacket(cb) { this._onPacket = cb; }

  async init() {
    if (this._ready) return this._ready;
    this._ready = new Promise((resolve, reject) => {
      const worker = new Worker(this._workerUrl);
      this._worker = worker;
      worker.onmessage = (e) => {
        const data = e.data;
        // opus-recorder posts page data as { page: Uint8Array, samplePosition }
        if (data && data.page) {
          const u8 = data.page instanceof Uint8Array ? data.page : new Uint8Array(data.page);
          const packets = this._demuxer.feed(u8);
          if (this._onPacket) {
            for (const p of packets) this._onPacket(p);
          }
        } else if (data instanceof ArrayBuffer) {
          const packets = this._demuxer.feed(new Uint8Array(data));
          if (this._onPacket) {
            for (const p of packets) this._onPacket(p);
          }
        } else if (data && data.message === "ready") {
          resolve();
        }
      };
      worker.onerror = (err) => reject(err);
      worker.postMessage({
        command: "init",
        bufferLength: 4096,
        encoderApplication: 2048, // VOIP
        encoderFrameSize: APP_CONFIG.AUDIO.FRAME_DURATION_MS,
        encoderSampleRate: this._sampleRate,
        maxFramesPerPage: 1,       // small pages = low latency
        numberOfChannels: 1,
        originalSampleRate: this._sampleRate,
        resampleQuality: 3,
        streamPages: true
      });
    });
    return this._ready;
  }

  encode(float32Mono) {
    if (!this._worker) return;
    // encoderWorker expects { command:"encode", buffers:[Float32Array per channel] }
    this._worker.postMessage(
      { command: "encode", buffers: [float32Mono] },
      [float32Mono.buffer]
    );
  }

  async flush() {
    // Do NOT send "done" — opus-recorder destroys the encoder on "done",
    // breaking subsequent utterances. Server uses listen state + tail
    // silence to detect end of speech.
  }

  close() {
    if (this._worker) {
      try { this._worker.postMessage({ command: "close" }); } catch {}
      this._worker.terminate();
      this._worker = null;
    }
    this._demuxer.reset();
  }
}

let _decoderModulePromise = null;
async function loadOpusDecoderModule(scriptUrl) {
  if (_decoderModulePromise) return _decoderModulePromise;
  _decoderModulePromise = new Promise((resolve, reject) => {
    if (typeof window["opus-decoder"] === "object" && window["opus-decoder"].OpusDecoder) {
      resolve(window["opus-decoder"]);
      return;
    }
    const s = document.createElement("script");
    s.src = scriptUrl;
    s.async = true;
    s.onload = () => {
      const mod = window["opus-decoder"];
      if (mod && mod.OpusDecoder) resolve(mod);
      else reject(new Error("opus-decoder global missing"));
    };
    s.onerror = () => reject(new Error("opus-decoder script load failed"));
    document.head.appendChild(s);
  });
  return _decoderModulePromise;
}

export class OpusDecoder {
  constructor({ scriptUrl, sampleRate = APP_CONFIG.AUDIO.OUTPUT_SAMPLE_RATE }) {
    this._scriptUrl = scriptUrl;
    this._sampleRate = sampleRate;
    this._dec = null;
  }

  async init() {
    if (this._dec) return;
    const mod = await loadOpusDecoderModule(this._scriptUrl);
    this._dec = new mod.OpusDecoder({
      sampleRate: this._sampleRate,
      channels: 1
    });
    await this._dec.ready;
  }

  decode(packet) {
    if (!this._dec) return null;
    const result = this._dec.decodeFrame(packet);
    return result && result.channelData && result.channelData[0]
      ? result.channelData[0]
      : null;
  }

  close() {
    if (this._dec && typeof this._dec.free === "function") {
      try { this._dec.free(); } catch {}
    }
    this._dec = null;
  }
}
