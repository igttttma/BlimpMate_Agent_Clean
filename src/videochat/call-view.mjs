// Full-screen call screens over the Live2D face, plus ring tones.
// The Blimp display is small and low-resolution, 16:9 landscape: everything is
// sized from the viewport height and kept large. No self-view: the Blimp's own
// camera image isn't shown on its screen.

const STYLE = `
.bm-call { position: fixed; inset: 0; z-index: 900; display: none; overflow: hidden; color: #fff;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
.bm-call[data-mode]:not([data-mode="hidden"]) { display: block; }

/* ---- ringing / calling / ended: a phone-call screen ---- */
.bm-call-screen { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  gap: 7vw; padding: 6vh 6vw; background: radial-gradient(120% 140% at 25% 30%, #24324a 0%, #0f1520 55%, #07090d 100%); }
.bm-call[data-mode="ringing"] .bm-call-screen { background: radial-gradient(120% 140% at 25% 30%, #1d4a3a 0%, #0d1c17 55%, #060a08 100%); }
.bm-call[data-mode="ended"] .bm-call-screen { background: radial-gradient(120% 140% at 25% 30%, #3a2228 0%, #170e10 55%, #080506 100%); }
.bm-call[data-mode="in_call"] .bm-call-screen { display: none; }

.bm-call-avatar { position: relative; flex: none; width: 46vh; height: 46vh; }
.bm-call-avatar-core { position: absolute; inset: 0; border-radius: 50%; display: grid; place-items: center;
  background: linear-gradient(145deg, #4c6fff, #7c4dff); box-shadow: 0 2vh 6vh rgba(0,0,0,.45); }
.bm-call[data-mode="ringing"] .bm-call-avatar-core { background: linear-gradient(145deg, #22c55e, #0ea5a4); }
.bm-call[data-mode="ended"] .bm-call-avatar-core { background: linear-gradient(145deg, #6b7280, #374151); }
.bm-call-avatar svg { width: 56%; height: 56%; fill: rgba(255,255,255,.95); }
.bm-call-ring { position: absolute; inset: 0; border-radius: 50%; border: .9vh solid rgba(255,255,255,.55); opacity: 0; }
.bm-call[data-mode="ringing"] .bm-call-ring, .bm-call[data-mode="calling"] .bm-call-ring {
  animation: bm-call-ripple 2.4s cubic-bezier(.2,.6,.3,1) infinite; }
.bm-call-ring:nth-child(2) { animation-delay: .8s !important; }
.bm-call-ring:nth-child(3) { animation-delay: 1.6s !important; }
@keyframes bm-call-ripple { 0% { transform: scale(1); opacity: .7; } 100% { transform: scale(1.75); opacity: 0; } }
.bm-call[data-mode="ringing"] .bm-call-avatar-core { animation: bm-call-shake 2.4s ease-in-out infinite; }
@keyframes bm-call-shake { 0%, 60%, 100% { transform: rotate(0); } 64% { transform: rotate(-7deg); } 68% { transform: rotate(7deg); }
  72% { transform: rotate(-7deg); } 76% { transform: rotate(7deg); } 80% { transform: rotate(0); } }

.bm-call-info { display: flex; flex-direction: column; align-items: flex-start; gap: 3vh; min-width: 0; }
.bm-call-sub { font-size: 8vh; font-weight: 600; color: rgba(255,255,255,.75); font-variant-numeric: tabular-nums; }
.bm-call-sub:empty { display: none; }
.bm-call-status-dot { width: 4.5vh; height: 4.5vh; border-radius: 50%; background: #9ca3af; flex: none; }
.bm-call-bar .bm-call-status-dot { width: 3.2vh; height: 3.2vh; }
.bm-call[data-mode="ringing"] .bm-call-status-dot { background: #4ade80; animation: bm-call-blink 1s ease-in-out infinite; }
.bm-call[data-mode="calling"] .bm-call-status-dot { background: #60a5fa; animation: bm-call-blink 1s ease-in-out infinite; }
.bm-call[data-mode="ended"] .bm-call-status-dot { background: #f87171; }
@keyframes bm-call-blink { 50% { opacity: .25; } }
.bm-call-title { display: flex; align-items: center; gap: 3.5vh; font-size: 15vh; line-height: 1.02; font-weight: 800;
  letter-spacing: -.01em; white-space: nowrap; }
.bm-call-hint { display: inline-flex; align-items: center; gap: 2.4vh; margin-top: 2vh; padding: 2.4vh 4.4vh;
  border-radius: 999px; background: rgba(255,255,255,.14); border: .4vh solid rgba(255,255,255,.22);
  font-size: 7.5vh; font-weight: 700; }
.bm-call-hint:empty { display: none; }
.bm-call-hint svg { width: 7.5vh; height: 7.5vh; fill: currentColor; flex: none; }
.bm-call[data-mode="ringing"] .bm-call-hint { background: rgba(74,222,128,.22); border-color: rgba(74,222,128,.6);
  animation: bm-call-glow 1.6s ease-in-out infinite; }
@keyframes bm-call-glow { 50% { box-shadow: 0 0 0 1.6vh rgba(74,222,128,.18); } }
.bm-call-hint q { quotes: "\\201C" "\\201D"; font-weight: 900; }

/* Touch fallback for the voice commands: answer / decline / cancel */
.bm-call-actions { display: none; gap: 6vh; margin-top: 2vh; }
.bm-call[data-mode="ringing"] .bm-call-actions, .bm-call[data-mode="calling"] .bm-call-actions { display: flex; }
.bm-call-btn { width: 17vh; height: 17vh; border-radius: 50%; border: 0; display: grid; place-items: center; cursor: pointer;
  box-shadow: 0 1vh 3vh rgba(0,0,0,.45); -webkit-tap-highlight-color: transparent; }
.bm-call-btn:active { transform: scale(.94); }
.bm-call-btn svg { width: 55%; height: 55%; fill: #fff; }
.bm-call-btn.accept { background: #22c55e; display: none; }
.bm-call[data-mode="ringing"] .bm-call-btn.accept { display: grid; animation: bm-call-glow-btn 1.2s ease-in-out infinite; }
@keyframes bm-call-glow-btn { 50% { box-shadow: 0 0 0 2.4vh rgba(34,197,94,.3); } }
.bm-call-btn.end { background: #e5484d; }
.bm-call-btn.end svg { transform: rotate(135deg); }

/* ---- in call: remote video fills the screen ---- */
.bm-call-remote { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; display: none; }
.bm-call[data-mode="in_call"] { background: #000; }
.bm-call[data-mode="in_call"] .bm-call-remote { display: block; }
.bm-call-bar { position: absolute; left: 3vh; top: 3vh; display: none; align-items: center; gap: 2.4vh;
  padding: 1.6vh 3.6vh 1.6vh 2.4vh; border-radius: 999px; background: rgba(0,0,0,.55);
  font-size: 6.5vh; font-weight: 700; }
.bm-call[data-mode="in_call"] .bm-call-bar { display: flex; }
.bm-call-bar .bm-call-status-dot { background: #4ade80; }
.bm-call-timer { font-variant-numeric: tabular-nums; color: rgba(255,255,255,.85); font-weight: 600; }
.bm-call-hangup { position: absolute; right: 3vh; bottom: 3vh; width: 17vh; height: 17vh; border-radius: 50%; border: 0;
  display: none; place-items: center; background: #e5484d; box-shadow: 0 1vh 3vh rgba(0,0,0,.45); }
.bm-call[data-mode="in_call"] .bm-call-hangup { display: grid; }
.bm-call-hangup svg { width: 55%; height: 55%; fill: #fff; transform: rotate(135deg); }
`;

const ICON_PERSON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.4 0-8 2.3-8 5.2V21h16v-1.8c0-2.9-3.6-5.2-8-5.2Z"/></svg>`;
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
      <div class="bm-call-bar"><span class="bm-call-status-dot"></span><span class="bm-call-timer">0:00</span></div>
      <button type="button" class="bm-call-hangup" aria-label="Hang up">${ICON_PHONE}</button>
      <div class="bm-call-screen">
        <div class="bm-call-avatar">
          <span class="bm-call-ring"></span><span class="bm-call-ring"></span><span class="bm-call-ring"></span>
          <div class="bm-call-avatar-core">${ICON_PERSON}</div>
        </div>
        <div class="bm-call-info">
          <div class="bm-call-title"><span class="bm-call-status-dot"></span><span class="bm-call-title-text"></span></div>
          <div class="bm-call-sub"></div>
          <div class="bm-call-hint"></div>
          <div class="bm-call-actions">
            <button type="button" class="bm-call-btn accept" aria-label="Answer">${ICON_PHONE}</button>
            <button type="button" class="bm-call-btn end" aria-label="End call">${ICON_PHONE}</button>
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
    this._screen("ringing", "Incoming call", "", `${ICON_MIC}<span>Say <q>${keyword}</q> to pick up</span>`);
  }

  /** Outgoing call waiting for an answer. */
  calling(cancelPhrase = "Hey Blimp") {
    this._screen("calling", "Calling…", "", `${ICON_MIC}<span>Say <q>${cancelPhrase}</q> to cancel</span>`);
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
    this._screen("ended", reason, duration, "");
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

  _screen(mode, title, sub, hintHtml) {
    clearTimeout(this._hideTimer);
    if (mode !== "ended") this._connectedAt = 0;
    this.el.dataset.mode = mode;
    this.el.querySelector(".bm-call-title-text").textContent = title;
    this.el.querySelector(".bm-call-sub").textContent = sub;
    this.el.querySelector(".bm-call-hint").innerHTML = hintHtml;
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
