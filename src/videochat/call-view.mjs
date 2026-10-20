// Full-screen call screens over the Live2D face, plus ring tones.
// The Blimp display is small and low-resolution, 16:9 landscape: everything is
// sized from the viewport height and kept large. No self-view: the Blimp's own
// camera image isn't shown on its screen. Styled after the iOS Phone app: flat
// dark background, large type, labelled round buttons in the system colors.

const STYLE = `
.bm-call { position: fixed; inset: 0; z-index: 900; display: none; overflow: hidden; color: #fff; background: #000;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", Roboto, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; letter-spacing: -.01em; }
.bm-call[data-mode]:not([data-mode="hidden"]) { display: block; }

/* ---- ringing / calling / ended: text top left, round buttons bottom right ---- */
.bm-call-screen { position: absolute; inset: 0; padding: 9vh 8vh; }
.bm-call[data-mode="in_call"] .bm-call-screen { display: none; }
.bm-call-info { display: flex; flex-direction: column; align-items: flex-start; }
.bm-call-kicker { font-size: 7vh; font-weight: 500; }
.bm-call-kicker:empty { display: none; }
.bm-call-title { margin-top: 1.5vh; font-size: 14vh; line-height: 1.05; font-weight: 600; letter-spacing: -.025em; }
.bm-call-sub { margin-top: 2vh; font-size: 7vh; font-weight: 500; font-variant-numeric: tabular-nums; }
.bm-call-sub:empty { display: none; }
.bm-call-hint { display: flex; align-items: center; gap: 2vh; margin-top: 5vh; font-size: 7vh; font-weight: 500;
  }
.bm-call-hint:empty { display: none; }
.bm-call-hint svg { width: 7vh; height: 7vh; fill: currentColor; flex: none; }
.bm-call-hint q { quotes: "\\201C" "\\201D"; color: #fff; font-weight: 600; }

/* Touch fallback for the voice commands: answer / decline / cancel */
.bm-call-actions { position: absolute; right: 8vh; bottom: 7vh; display: none; gap: 9vh; }
.bm-call[data-mode="ringing"] .bm-call-actions, .bm-call[data-mode="calling"] .bm-call-actions { display: flex; }
.bm-call-action { display: flex; flex-direction: column; align-items: center; gap: 2vh; font-size: 6vh; font-weight: 500; }
.bm-call-action.accept { display: none; }
.bm-call[data-mode="ringing"] .bm-call-action.accept { display: flex; }
.bm-call-btn { width: 19vh; height: 19vh; border-radius: 50%; border: 0; padding: 0; display: grid; place-items: center;
  cursor: pointer; -webkit-tap-highlight-color: transparent; }
.bm-call-btn:active, .bm-call-hangup:active { filter: brightness(.8); }
.bm-call-btn svg, .bm-call-hangup svg { width: 46%; height: 46%; fill: #fff; }
.bm-call-btn.accept { background: #34c759; }
.bm-call-btn.end, .bm-call-hangup { background: #ff3b30; }
.bm-call-btn.end svg, .bm-call-hangup svg { transform: rotate(135deg); }

/* ---- in call: remote video fills the screen ---- */
.bm-call-remote { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; display: none; }
.bm-call[data-mode="in_call"] { background: #000; }
.bm-call[data-mode="in_call"] .bm-call-remote { display: block; }
.bm-call-bar { position: absolute; left: 4vh; top: 4vh; display: none; padding: 1.4vh 3.6vh; border-radius: 999px;
  background: rgba(28,28,30,.65); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
  font-size: 7vh; font-weight: 600; font-variant-numeric: tabular-nums; }
.bm-call[data-mode="in_call"] .bm-call-bar { display: block; }
.bm-call-hangup { position: absolute; right: 4vh; bottom: 4vh; width: 17vh; height: 17vh; border-radius: 50%; border: 0;
  padding: 0; display: none; place-items: center; -webkit-tap-highlight-color: transparent; }
.bm-call[data-mode="in_call"] .bm-call-hangup { display: grid; }
`;

const ICON_MIC = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 0 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.9V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.6a6 6 0 0 0 5-5.9Z"/></svg>`;
const ICON_PHONE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8Z"/></svg>`;

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export class CallView {
  /** onAnswer: pick up (ringing); onEnd: decline or cancel (ringing, calling); onHangup: end a connected call. */
  constructor({ onHangup, onAnswer, onEnd } = {}) {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);
    this.el = document.createElement("div");
    this.el.className = "bm-call";
    this.el.dataset.mode = "hidden";
    this.el.innerHTML = `
      <video class="bm-call-remote" autoplay playsinline></video>
      <div class="bm-call-bar"><span class="bm-call-timer">0:00</span></div>
      <button type="button" class="bm-call-hangup" aria-label="Hang up">${ICON_PHONE}</button>
      <div class="bm-call-screen">
        <div class="bm-call-info">
          <div class="bm-call-kicker"></div>
          <div class="bm-call-title"></div>
          <div class="bm-call-sub"></div>
          <div class="bm-call-hint"></div>
        </div>
        <div class="bm-call-actions">
          <div class="bm-call-action end">
            <button type="button" class="bm-call-btn end" aria-label="End call">${ICON_PHONE}</button>
            <span class="bm-call-end-label"></span>
          </div>
          <div class="bm-call-action accept">
            <button type="button" class="bm-call-btn accept" aria-label="Answer">${ICON_PHONE}</button>
            <span>Accept</span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(this.el);
    this.remoteVideo = this.el.querySelector(".bm-call-remote");
    this.el.querySelector(".bm-call-hangup").addEventListener("click", () => onHangup?.());
    this.el.querySelector(".bm-call-btn.accept").addEventListener("click", () => onAnswer?.());
    this.el.querySelector(".bm-call-btn.end").addEventListener("click", () => onEnd?.());
    this._audioCtx = null;
    this._toneTimer = null;
    this._hideTimer = null;
    this._clockTimer = null;
    this._connectedAt = 0;
  }

  get mode() { return this.el.dataset.mode; }

  // ---- screens ----

  /** Incoming call; `keyword` is what to say to pick up. */
  ringing(keyword = "answer") {
    this._screen("ringing", {
      kicker: "Video call", title: "Incoming call", endLabel: "Decline",
      hint: `${ICON_MIC}<span>Say <q>${keyword}</q> to pick up</span>`
    });
  }

  /** Outgoing call waiting for an answer. */
  calling(cancelPhrase = "Hey Blimp") {
    this._screen("calling", {
      kicker: "Video call", title: "Calling…", endLabel: "Cancel",
      hint: `${ICON_MIC}<span>Say <q>${cancelPhrase}</q> to cancel</span>`
    });
  }

  inCall() {
    clearTimeout(this._hideTimer);
    this.el.dataset.mode = "in_call";
    this._connectedAt = Date.now();
    const timer = this.el.querySelector(".bm-call-timer");
    timer.textContent = "0:00";
    clearInterval(this._clockTimer);
    this._clockTimer = setInterval(() => { timer.textContent = formatDuration(Date.now() - this._connectedAt); }, 1000);
  }

  /** End card (reason, plus duration if the call connected), then back to the face. */
  ended(reason, ms = 3500) {
    const duration = this._connectedAt ? formatDuration(Date.now() - this._connectedAt) : "";
    this._stopClock();
    this._screen("ended", { kicker: "Video call", title: reason, sub: duration });
    this._hideTimer = setTimeout(() => this.hide(), ms);
  }

  hide() {
    clearTimeout(this._hideTimer);
    this._stopClock();
    this.stopTone();
    this.el.dataset.mode = "hidden";
    this.setRemoteStream(null);
  }

  setRemoteStream(stream) {
    if (this.remoteVideo.srcObject === stream) return;
    this.remoteVideo.srcObject = stream;
    if (stream) this.remoteVideo.play().catch(() => {});
  }

  _screen(mode, { kicker = "", title = "", sub = "", hint = "", endLabel = "" }) {
    clearTimeout(this._hideTimer);
    if (mode !== "ended") this._connectedAt = 0;
    this.el.dataset.mode = mode;
    const q = (sel) => this.el.querySelector(sel);
    q(".bm-call-kicker").textContent = kicker;
    q(".bm-call-title").textContent = title;
    q(".bm-call-sub").textContent = sub;
    q(".bm-call-hint").innerHTML = hint;
    q(".bm-call-end-label").textContent = endLabel;
  }

  _stopClock() {
    clearInterval(this._clockTimer);
    this._clockTimer = null;
  }

  // ---- tones (generated; no audio assets) ----

  _ctx() {
    this._audioCtx ||= new AudioContext();
    if (this._audioCtx.state === "suspended") this._audioCtx.resume().catch(() => {});
    return this._audioCtx;
  }

  _beep(freqs, seconds, volume) {
    const c = this._ctx();
    const gain = c.createGain();
    gain.gain.value = volume;
    gain.connect(c.destination);
    for (const f of freqs) {
      const osc = c.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start();
      osc.stop(c.currentTime + seconds);
    }
  }

  /** "incoming": two short bursts every 3s; "outgoing": ringback, 2s on / 4s off. */
  startTone(kind) {
    this.stopTone();
    // Incoming stays quiet-ish: the wake-word engine listens for "answer" meanwhile
    const play = kind === "incoming"
      ? () => { this._beep([480, 620], 0.35, 0.05); setTimeout(() => this._beep([480, 620], 0.35, 0.05), 550); }
      : () => this._beep([440, 480], 2, 0.05);
    play();
    this._toneTimer = setInterval(play, kind === "incoming" ? 3000 : 6000);
  }

  stopTone() {
    clearInterval(this._toneTimer);
    this._toneTimer = null;
  }
}
