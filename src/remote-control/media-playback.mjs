import { DeviceState } from "../xiaozhi/index.mjs";

// "Play now" from the server portal, audio or video; one clip at a time (a
// new one replaces the current one). Playing takes the speaker from whatever
// has it, in this order:
//   video call (ringing, calling or in a call)  ended
//   wake activation in progress                 let finish (bounded), then
//   conversation (listening, thinking, speaking) ended; the server link closes
//   other page media and host audio             paused / stopped
// Ending the call or the conversation re-arms the wake word as usual, so it
// stays armed while the clip plays: "Hey Blimp", a new conversation or an
// incoming call stops the clip, paused or not (a paused clip still holds the
// screen and the speaker). Loop is a setting: it applies to the clip playing
// and to the next ones.
//
// Audio: the face says the clip like a TTS reply (no overlay, the clip's
// loudness drives the mouth). Video: full screen over the face, under the
// call screens.

const ACTIVATION_WAIT_MS = 3000;

const LIP_SYNC_MS = 40;

// Needs CORS on the audio (the server's signed links send it)
class LipSync {
  constructor(mouth) {
    this.mouth = mouth;
    this.ctx = null;
    this.source = null;
    this.timer = null;
  }

  start(audio) {
    this.stop();
    try {
      this.ctx ||= new AudioContext();
      this.ctx.resume().catch(() => {});
      const source = this.ctx.createMediaElementSource(audio);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyser.connect(this.ctx.destination);
      this.source = source;
      const buf = new Float32Array(analyser.fftSize);
      this.mouth.begin();
      this.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        this.mouth.feedRms(Math.sqrt(sum / buf.length));
      }, LIP_SYNC_MS);
    } catch {
      // No Web Audio: the clip still plays, the mouth stays still
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.source) return;
    try { this.source.disconnect(); } catch {}
    this.source = null;
    this.mouth.end();
  }
}

const VIDEO_STYLE = `
.bm-video { position: fixed; inset: 0; z-index: 800; background: #000; display: none; }
.bm-video.on { display: block; }
.bm-video video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
`;

// The full-screen layer; shown once the first frame is up, so the face stays
// until there is a picture to replace it
class VideoScreen {
  constructor() {
    this.el = null;
  }

  createVideo() {
    if (!this.el) {
      const style = document.createElement("style");
      style.textContent = VIDEO_STYLE;
      document.head.appendChild(style);
      this.el = document.createElement("div");
      this.el.className = "bm-video";
      document.body.appendChild(this.el);
    }
    const video = document.createElement("video");
    video.playsInline = true;
    video.preload = "auto";
    this.el.replaceChildren(video);
    return video;
  }

  show() {
    this.el?.classList.add("on");
  }

  hide() {
    if (!this.el) return;
    this.el.classList.remove("on");
    this.el.replaceChildren();
  }
}

export class MediaPlayback extends EventTarget {
  /**
   * @param {object} deps
   * @param {object} deps.conversation  xiaozhi Conversation
   * @param {() => object|null} deps.getWakeCoordinator
   * @param {object|null} deps.callController  video calls (busy, endCall())
   * @param {(level, message, detail?) => void} [deps.log]
   */
  constructor({ conversation, getWakeCoordinator, callController = null, log = () => {} }) {
    super();
    this.conversation = conversation;
    this.getWakeCoordinator = getWakeCoordinator;
    this.callController = callController;
    this.log = log;
    this.media = null; // the <audio> or <video> playing
    this.playback = null; // { kind, id, title, source, status, position, duration, reason?, error? }
    this.loop = false;
    this.lipSync = new LipSync(conversation.mouth);
    this.screen = new VideoScreen();
    this._gen = 0;
    this._queue = Promise.resolve();
    this._takingOver = false;
    this._clickedAt = 0;

    // Anything else that wants the speaker stops the clip
    conversation.addEventListener("wake", () => this.stop("wake word"));
    conversation.state.addEventListener("device", (e) => {
      // While taking over, a wake activation already under way is ended right after
      if (e.detail?.new !== DeviceState.IDLE && !this._takingOver) this.stop("conversation");
    });
    callController?.addEventListener("status", () => {
      if (callController.busy) this.stop("video call");
    });
  }

  /** A clip is loading, playing or paused. */
  get active() {
    return ["loading", "playing", "paused"].includes(this.playback?.status);
  }

  /** kind "audio" | "video"; source "cache" (local copy) or "stream". */
  play({ kind = "audio", id, title, url, source = "stream" }) {
    const gen = ++this._gen;
    this._clickedAt = performance.now();
    this._detach();
    this._update({ kind, id, title, source, status: "loading", position: 0, duration: 0 });
    this.log("info", `Play now: ${title}`, { kind, id, source });
    this._queue = this._queue.catch(() => {}).then(async () => {
      if (gen !== this._gen) return;
      this._takingOver = true;
      try { await this._takeSpeaker(); } finally { this._takingOver = false; }
      if (gen !== this._gen) return;
      let media;
      if (kind === "video") {
        media = this.screen.createVideo();
      } else {
        media = new Audio();
        media.preload = "auto";
        media.crossOrigin = "anonymous";
      }
      this.media = media;
      media.loop = this.loop;
      this._attach(media, gen);
      media.src = url;
      if (kind === "audio") this.lipSync.start(media);
      try {
        await media.play();
      } catch (err) {
        // A newer command or an interruption already handled this clip
        if (gen === this._gen && this.media === media && err?.name !== "AbortError") {
          this._end("failed", { error: err?.message || String(err) });
        }
      }
    }).catch((err) => {
      this.log("error", "Play now failed", { error: String(err?.message || err) });
      if (gen === this._gen) this._end("failed", { error: String(err?.message || err) });
    });
    return this._queue;
  }

  /** Stop the clip (portal Stop, or something else took the speaker). */
  stop(reason = "stopped") {
    if (!this.active) return;
    this._gen++;
    this.log("info", `Play now stopped: ${reason}`);
    this._end("stopped", { reason });
  }

  pause() {
    const media = this.media;
    if (this.playback?.status !== "playing" || !media) return false;
    // Status first: the pause event then isn't taken for an interruption
    this._update({ ...this.playback, status: "paused", ...this._position(media) });
    media.pause();
    this.log("info", `Play now paused: ${this.playback.title}`);
    return true;
  }

  resume() {
    const media = this.media;
    if (this.playback?.status !== "paused" || !media) return false;
    const gen = this._gen;
    this.log("info", `Play now resumed: ${this.playback.title}`);
    // "playing" fires once it runs again and sets the status
    media.play().catch((err) => {
      if (gen === this._gen && this.media === media && err?.name !== "AbortError") {
        this._end("failed", { error: err?.message || String(err) });
      }
    });
    return true;
  }

  setLoop(on) {
    this.loop = !!on;
    if (this.media) this.media.loop = this.loop;
    this.log("info", `Loop ${this.loop ? "on" : "off"}`);
    this._update(this.playback);
  }

  _position(media) {
    return {
      position: Number.isFinite(media.currentTime) ? media.currentTime : 0,
      duration: Number.isFinite(media.duration) ? media.duration : 0
    };
  }

  // ---- speaker ownership ----

  async _takeSpeaker() {
    if (this.callController?.busy) await this.callController.endCall();
    // A wake activation under way (connecting) would start listening after us
    const activation = this.getWakeCoordinator()?.activationQueue;
    if (activation) {
      await Promise.race([
        activation.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, ACTIVATION_WAIT_MS))
      ]);
    }
    const conv = this.conversation;
    if (conv.protocol?.isOpen?.() || conv._autoSessionActive || conv.state.device !== DeviceState.IDLE) {
      try { await conv.endSession(); } catch {}
    }
    for (const media of document.querySelectorAll("audio, video")) {
      try { media.pause(); } catch {}
    }
    try {
      const host = globalThis.hostAudio;
      if (host?.available && (await host.getState?.())?.status === "playing") await host.stop();
    } catch {}
  }

  // ---- the media element ----

  _attach(media, gen) {
    const mine = () => gen === this._gen && this.media === media;
    const position = () => this._position(media);
    media.onplaying = () => {
      if (!mine()) return;
      if (this.playback.kind === "video") this.screen.show();
      if (this.playback.status === "loading") {
        this.log("info", `Playing after ${Math.round(performance.now() - this._clickedAt)} ms`, {
          kind: this.playback.kind, source: this.playback.source
        });
      }
      this._update({ ...this.playback, status: "playing", ...position() });
    };
    media.ondurationchange = () => mine() && this._update({ ...this.playback, ...position() });
    // A seek, a stall or a loop back to the start changes where we are; resync the portal's clock
    media.onseeked = media.onwaiting = () => mine() && this.active && this._update({ ...this.playback, ...position() });
    media.onended = () => mine() && this._end("ended");
    media.onerror = () => mine() && this._end("failed", { error: media.error?.message || `media error ${media.error?.code || ""}`.trim() });
    // Paused by someone else (e.g. the wake word pausing page media)
    media.onpause = () => mine() && !media.ended && this.playback.status === "playing" && this._end("stopped", { reason: "interrupted" });
  }

  _detach() {
    const media = this.media;
    this.media = null;
    if (!media) return;
    this.lipSync.stop();
    media.onplaying = media.ondurationchange = media.onseeked = media.onwaiting = null;
    media.onended = media.onerror = media.onpause = null;
    try { media.pause(); } catch {}
    media.removeAttribute("src");
    media.load();
    if (media instanceof HTMLVideoElement) this.screen.hide();
  }

  _end(status, extra = {}) {
    const media = this.media;
    const pos = media && Number.isFinite(media.currentTime) ? media.currentTime : this.playback?.position || 0;
    this._detach();
    if (this.playback) this._update({ ...this.playback, status, position: pos, ...extra });
    if (status === "failed") this.log("warn", `Play now failed: ${extra.error || "unknown error"}`);
  }

  _update(playback) {
    this.playback = playback;
    this.dispatchEvent(new CustomEvent("change", { detail: playback }));
  }
}
