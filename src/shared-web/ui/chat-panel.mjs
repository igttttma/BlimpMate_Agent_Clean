import { createBackendForm } from "./backend-config-ui.mjs";

// Chat panel UI: toggle button + collapsible panel with connect, backend,
// mode, big PTT button, abort, subtitle area, settings.
export function createChatPanel({ onConnect, onDisconnect, onBackendApply, onBackendReset, onCallApply, onPress, onRelease, onAutoToggle, onAbort, onSendText, onModeChange }) {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "xz-panel-toggle";
  toggle.textContent = "Chat";
  document.body.appendChild(toggle);

  const statusIndicator = document.createElement("div");
  statusIndicator.className = "xz-agent-status xz-agent-status-starting";
  statusIndicator.setAttribute("role", "status");
  statusIndicator.setAttribute("aria-label", "Starting");
  statusIndicator.title = "Starting";
  statusIndicator.innerHTML = `<span class="xz-agent-status-ring"></span><span class="xz-agent-status-core"></span>`;
  document.body.appendChild(statusIndicator);

  const panel = document.createElement("aside");
  panel.className = "xz-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="xz-panel-scroll">
      <div class="xz-panel-header">
        <div class="xz-panel-title">
          <span class="xz-dot" id="xzDot"></span>
          <span id="xzConnState">Disconnected</span>
        </div>
        <button type="button" class="xz-btn xz-btn-small" id="xzClose">×</button>
      </div>

      <div class="xz-row">
        <button type="button" class="xz-btn" id="xzConnect">Connect</button>
        <button type="button" class="xz-btn" id="xzDisconnect">Disconnect</button>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Backend<span class="xz-backend-source" id="xzBackendSource"></span></div>
        <div id="xzBackendSlot"></div>
        <div class="xz-row" style="margin-top: 8px;">
          <button type="button" class="xz-btn" id="xzBackendApply">Apply</button>
          <button type="button" class="xz-btn" id="xzBackendReset" title="Forget the saved backend">Reset</button>
        </div>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Video calls<span class="xz-backend-source" id="xzCallStatus"></span></div>
        <input type="text" class="xz-input" id="xzCallUrl" spellcheck="false" autocomplete="off"
               placeholder="wss://203.0.113.7:8443/ws (empty = off)" />
        <div class="xz-backend-error" id="xzCallError" role="alert" hidden></div>
        <div class="xz-row" style="margin-top: 8px;">
          <button type="button" class="xz-btn" id="xzCallApply">Apply</button>
        </div>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Mode</div>
        <div class="xz-row">
          <button type="button" class="xz-btn" id="xzModeManual">Manual</button>
          <button type="button" class="xz-btn xz-active" id="xzModeAuto">Auto</button>
        </div>
      </div>

      <div class="xz-section" id="xzVolumeSection" hidden>
        <div class="xz-section-label">Maximum volume</div>
        <div class="xz-row">
          <button type="button" class="xz-btn" id="xzMaxVolumeOn" title="Media and call volume to max at start and when the mic opens">On</button>
          <button type="button" class="xz-btn" id="xzMaxVolumeOff" title="Leave the device's volumes alone">Off</button>
        </div>
      </div>

      <div class="xz-section">
        <button type="button" class="xz-talk" id="xzTalk">Start conversation</button>
        <button type="button" class="xz-btn" id="xzAbort">Stop</button>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Text</div>
        <div class="xz-row">
          <input type="text" class="xz-input" id="xzTextInput" placeholder="Type text, press Enter to send" />
        </div>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Captions</div>
        <div class="xz-subtitle"><span>Me:</span><div id="xzSttText"></div></div>
        <div class="xz-subtitle"><span>It:</span><div id="xzTtsText"></div></div>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Device</div>
        <div class="xz-meta"><span>Device-Id</span><code id="xzDeviceId"></code></div>
        <div class="xz-meta"><span>Emotion</span><code id="xzEmotion">-</code></div>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Display</div>
        <div class="xz-meta"><span>Current page</span><code id="xzDisplayPage">avatar</code></div>
        <div class="xz-state-title">Subtitle</div>
        <div id="xzDisplaySubtitle" class="xz-state-text"></div>
        <div class="xz-state-title">Card</div>
        <div id="xzDisplayCard" class="xz-state-text"></div>
        <div class="xz-state-title">Steps</div>
        <div id="xzDisplaySteps" class="xz-state-text"></div>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Privacy / audit</div>
        <div class="xz-meta"><span>Camera</span><code id="xzPrivacyCamera">off</code></div>
        <div class="xz-meta"><span>Microphone</span><code id="xzPrivacyMic">off</code></div>
        <div class="xz-meta"><span>Retention</span><code id="xzPrivacyData">Local</code></div>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">System summary</div>
        <div class="xz-meta"><span>Session</span><code id="xzSystemSession">Offline</code></div>
        <div class="xz-meta"><span>Host</span><code id="xzSystemHost">-</code></div>
        <div class="xz-meta"><span>Host audio</span><code id="xzSystemHostAudio">-</code></div>
        <div class="xz-meta"><span>Counts</span><code id="xzSystemCounts">-</code></div>
        <div class="xz-meta"><span>Risk</span><code id="xzSystemRisk">None</code></div>
        <div id="xzSystemAlerts" class="xz-system-alerts" aria-label="System alerts"></div>
      </div>

      <div class="xz-section">
        <div class="xz-section-label">Session log</div>
        <div id="xzSessionLog" class="xz-log" aria-live="polite"></div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(`#${id}`);
  const dotEl = $("xzDot");
  const stateEl = $("xzConnState");
  const sttEl = $("xzSttText");
  const ttsEl = $("xzTtsText");
  const emoEl = $("xzEmotion");
  const deviceIdEl = $("xzDeviceId");
  const talkBtn = $("xzTalk");
  const modeManual = $("xzModeManual");
  const modeAuto = $("xzModeAuto");
  const textInput = $("xzTextInput");
  const backendForm = createBackendForm();
  $("xzBackendSlot").appendChild(backendForm.el);
  const backendSourceEl = $("xzBackendSource");
  const backendResetBtn = $("xzBackendReset");
  const displayPageEl = $("xzDisplayPage");
  const displaySubtitleEl = $("xzDisplaySubtitle");
  const displayCardEl = $("xzDisplayCard");
  const displayStepsEl = $("xzDisplaySteps");
  const detachedStateTarget = () => document.createElement("code");
  const todoStateEl = detachedStateTarget();
  const memoryStateEl = detachedStateTarget();
  const mediaStateEl = detachedStateTarget();
  const reminderStateEl = detachedStateTarget();
  const musicStateEl = detachedStateTarget();
  const volumeStateEl = detachedStateTarget();
  const hostAudioStateEl = detachedStateTarget();
  const cameraStateEl = detachedStateTarget();
  const visionStateEl = detachedStateTarget();
  const faceStateEl = detachedStateTarget();
  const movementStateEl = detachedStateTarget();
  const callStateEl = detachedStateTarget();
  const flightStateEl = detachedStateTarget();
  const notificationStateEl = detachedStateTarget();
  const notificationLatestEl = detachedStateTarget();
  const privacyCameraEl = $("xzPrivacyCamera");
  const privacyMicEl = $("xzPrivacyMic");
  const privacyDataEl = $("xzPrivacyData");
  const systemSessionEl = $("xzSystemSession");
  const systemHostEl = $("xzSystemHost");
  const systemHostAudioEl = $("xzSystemHostAudio");
  const systemCountsEl = $("xzSystemCounts");
  const systemRiskEl = $("xzSystemRisk");
  const systemAlertsEl = $("xzSystemAlerts");
  const logEl = $("xzSessionLog");

  let mode = "auto";
  let pressing = false;
  let autoActive = false;
  const logs = [];

  toggle.addEventListener("click", (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; });
  $("xzClose").addEventListener("click", () => { panel.hidden = true; });
  panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { panel.hidden = true; });

  $("xzConnect").addEventListener("click", () => onConnect && onConnect());
  const applyBackend = () => {
    const cfg = backendForm.validate();
    if (cfg && onBackendApply) onBackendApply(cfg);
  };
  backendForm.onSubmit(applyBackend);
  $("xzBackendApply").addEventListener("click", applyBackend);
  backendResetBtn.addEventListener("click", () => onBackendReset && onBackendReset());
  const callErrorEl = $("xzCallError");
  $("xzCallApply").addEventListener("click", () => {
    const error = onCallApply ? onCallApply({ url: $("xzCallUrl").value }) : null;
    callErrorEl.textContent = error || "";
    callErrorEl.hidden = !error;
  });
  $("xzDisconnect").addEventListener("click", () => onDisconnect && onDisconnect());

  // Android app only: the native side keeps the setting (see CallModeVolume.java)
  const volumeBridge = globalThis.__nativeVolumeRaw;
  if (volumeBridge) {
    const on = $("xzMaxVolumeOn");
    const off = $("xzMaxVolumeOff");
    const show = (value) => {
      on.classList.toggle("xz-active", value);
      off.classList.toggle("xz-active", !value);
    };
    const set = (value) => {
      volumeBridge.setMaxVolume(value);
      show(value);
    };
    on.addEventListener("click", () => set(true));
    off.addEventListener("click", () => set(false));
    show(volumeBridge.getMaxVolume());
    $("xzVolumeSection").hidden = false;
  }
  $("xzAbort").addEventListener("click", () => onAbort && onAbort());

  const applyMode = (nextMode, active = false) => {
    mode = nextMode === "auto" ? "auto" : "manual";
    autoActive = mode === "auto" && !!active;
    modeManual.classList.toggle("xz-active", mode === "manual");
    modeAuto.classList.toggle("xz-active", mode === "auto");
    talkBtn.classList.toggle("xz-pressed", autoActive);
    talkBtn.textContent = mode === "manual"
      ? "Hold to talk"
      : autoActive ? "Stop conversation" : "Start conversation";
  };

  modeManual.addEventListener("click", () => {
    applyMode("manual");
    if (onModeChange) onModeChange("manual");
  });
  modeAuto.addEventListener("click", () => {
    applyMode("auto");
    if (onModeChange) onModeChange("auto");
  });

  const pressStart = (ev) => {
    ev.preventDefault();
    if (mode === "manual") {
      if (pressing) return;
      pressing = true;
      talkBtn.classList.add("xz-pressed");
      onPress && onPress();
    } else {
      autoActive = !autoActive;
      talkBtn.classList.toggle("xz-pressed", autoActive);
      talkBtn.textContent = autoActive ? "Stop conversation" : "Start conversation";
      if (autoActive) onPress && onPress();
      else onRelease && onRelease();
    }
  };
  const pressEnd = (ev) => {
    ev.preventDefault();
    if (mode === "manual") {
      if (!pressing) return;
      pressing = false;
      talkBtn.classList.remove("xz-pressed");
      onRelease && onRelease();
    }
  };
  talkBtn.addEventListener("mousedown", pressStart);
  talkBtn.addEventListener("mouseup", pressEnd);
  talkBtn.addEventListener("mouseleave", (e) => { if (pressing) pressEnd(e); });
  talkBtn.addEventListener("touchstart", pressStart, { passive: false });
  talkBtn.addEventListener("touchend", pressEnd, { passive: false });
  talkBtn.addEventListener("touchcancel", pressEnd);

  textInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && textInput.value.trim()) {
      const t = textInput.value.trim();
      textInput.value = "";
      onSendText && onSendText(t);
    }
  });

  return {
    setAgentStatus(status = "starting") {
      const labels = {
        starting: "Starting",
        wake: "Waiting for wake word",
        connecting: "Connecting",
        connected: "Connected",
        listening: "Listening",
        speaking: "Speaking",
        error: "Connection error"
      };
      const normalized = Object.hasOwn(labels, status) ? status : "starting";
      statusIndicator.className = `xz-agent-status xz-agent-status-${normalized}`;
      statusIndicator.setAttribute("aria-label", labels[normalized]);
      statusIndicator.title = labels[normalized];
    },
    setMode(nextMode, { active = false } = {}) {
      applyMode(nextMode, active);
    },
    setConversationActive(active) {
      applyMode(mode, active);
    },
    setConnected(c, reason = "") {
      dotEl.classList.toggle("xz-dot-on", !!c);
      stateEl.textContent = c ? "Connected" : (reason ? `Disconnected (${reason})` : "Disconnected");
    },
    setStt(text) { sttEl.textContent = text; },
    setTts(text) { ttsEl.textContent = text; },
    setEmotion(e) { emoEl.textContent = e || "-"; },
    setDeviceId(id) { deviceIdEl.textContent = id || ""; },
    // source: "saved" (chosen in the UI), "env" (Electron .env) or null.
    setBackend(config, source = null) {
      backendForm.setValue(config);
      backendSourceEl.textContent = source === "saved" ? "(saved)" : source === "env" ? "(from .env)" : "";
      backendResetBtn.disabled = source !== "saved";
    },
    showBackendError(msg) { backendForm.showError(msg); },
    setCallConfig(cfg) {
      $("xzCallUrl").value = cfg?.url || "";
    },
    setCallStatus(s) {
      const text = !s || s.state === "off" ? (s?.connected === false ? "(not connected)" : "(off)")
        : s.state === "idle" ? `(remote ${s.remote})` : `(${s.state.replace("_", " ")})`;
      $("xzCallStatus").textContent = text;
    },
    setDisplayState(state = {}) {
      const page = typeof state.page === "string" ? state.page : "avatar";
      const subtitle = typeof state.subtitle === "string" ? state.subtitle : "";
      const card = state.card || null;
      const steps = state.steps || null;

      displayPageEl.textContent = page || "avatar";
      displaySubtitleEl.textContent = subtitle || "-";

      if (card && typeof card === "object") {
        const lines = [];
        if (typeof card.title === "string" && card.title.trim()) lines.push(`Title: ${card.title}`);
        if (typeof card.body === "string" && card.body.trim()) lines.push(`Body: ${card.body}`);
        if (typeof card.image_url === "string" && card.image_url.trim()) lines.push(`Image: ${card.image_url}`);
        if (typeof card.card_type === "string" && card.card_type.trim()) lines.push(`Type: ${card.card_type}`);
        displayCardEl.textContent = lines.length > 0 ? lines.join("\n") : "-";
      } else {
        displayCardEl.textContent = "-";
      }

      if (steps && typeof steps === "object") {
        const title = typeof steps.title === "string" && steps.title.trim() ? steps.title : "Task steps";
        const items = Array.isArray(steps.items) ? steps.items : [];
        const lines = [`${title}`];
        if (items.length === 0) {
          lines.push("No steps yet");
        } else {
          items.forEach((item, idx) => {
            lines.push(`${idx + 1}. ${item}`);
          });
        }
        displayStepsEl.textContent = lines.join("\n");
      } else {
        displayStepsEl.textContent = "-";
      }
    },
    setTodoState(todos = null) {
      let total = 0;
      let pending = 0;

      if (Array.isArray(todos)) {
        total = todos.length;
        pending = todos.filter((item) => !item?.completed).length;
      } else if (todos && typeof todos === "object") {
        const rawTodos = Array.isArray(todos.todos) ? todos.todos : null;
        if (rawTodos) {
          total = Number(rawTodos.length) || 0;
          pending = rawTodos.filter((item) => !item?.completed).length;
        } else {
          total = Number(todos.total);
          pending = Number(todos.pending);
          total = Number.isFinite(total) ? Math.max(0, total) : 0;
          pending = Number.isFinite(pending) ? Math.max(0, pending) : 0;
        }
      } else if (typeof todos === "number") {
        total = Number.isFinite(todos) ? Math.max(0, Number(todos)) : 0;
      }

      if (total <= 0 && pending > 0) {
        total = pending;
      }
      const t = Number.isFinite(Number(total)) ? Number(total) : 0;
      const p = Number.isFinite(Number(pending)) ? Number(pending) : 0;
      todoStateEl.textContent = `${p}/${t}`;
    },
    setMemoryState({ count = 0 } = {}) {
      memoryStateEl.textContent = String(Number(count) || 0);
    },
    setMediaState(state = {}) {
      const kind = typeof state.kind === "string" ? state.kind : "none";
      const source = typeof state.source === "string" ? state.source : "";
      const visible = !!state.visible;
      mediaStateEl.textContent = `${kind}${visible ? " / visible" : ""}`;
      if (!source) return;
      if (mediaStateEl.title) {
        mediaStateEl.title = source;
      } else {
        mediaStateEl.setAttribute("title", source);
      }
    },
    setReminderState({ total = 0, pending = 0 } = {}) {
      reminderStateEl.textContent = `${pending}/${total}`;
    },
    setMusicState(state = {}) {
      const status = typeof state.status === "string" ? state.status : "unknown";
      const title = typeof state.title === "string" ? state.title.trim() : "";
      const artist = typeof state.artist === "string" ? state.artist.trim() : "";
      const source = typeof state.source === "string" ? state.source.trim() : "";
      const label = source || title || "idle";
      musicStateEl.textContent = `${status} - ${label}${artist ? ` (${artist})` : ""}`;
      if (musicStateEl.title) musicStateEl.title = source || label || "idle";
      else musicStateEl.setAttribute("title", source || label || "idle");
    },
    setVolumeState(state = {}) {
      const v = Number(state.volume);
      volumeStateEl.textContent = Number.isFinite(v) ? String(v) : "-";
    },
    setHostAudioState(state = {}) {
      const status = typeof state.status === "string" ? state.status : "idle";
      const title = typeof state.title === "string" ? state.title : "";
      const source = typeof state.source === "string" ? state.source : "";
      const pos = Number.isFinite(Number(state.positionSeconds))
        ? Math.max(0, Math.floor(Number(state.positionSeconds)))
        : 0;
      const label = status || "idle";
      hostAudioStateEl.textContent = `${label}${title ? ` / ${title}` : ""}${source ? ` / ${source}` : ""}${pos ? ` (${pos}s)` : ""}`;
      hostAudioStateEl.title = `${status}${title || source ? ` - ${title || source}` : ""}${source ? ` | ${source}` : ""}`;
    },
    setCameraState(state = {}) {
      const active = !!state.recording;
      const source = typeof state.source === "string" ? state.source : "";
      const snapshots = Number(state.totalSnapshots);
      const snapshotText = Number.isFinite(snapshots) ? ` / ${Math.max(0, snapshots)} shots` : "";
      cameraStateEl.textContent = `${active ? "Recording" : "Idle"}${snapshotText}`;
      const title = active ? `recording:${source || "default"}` : (source ? `source:${source}` : "camera");
      cameraStateEl.title = title;
    },
    setVisionState(state = {}) {
      const captures = Number(state.captures);
      const available = !!state.available;
      const food = typeof state.lastFoodAnalysis === "object" && state.lastFoodAnalysis?.food;
      const suffix = food ? ` / ${food}` : "";
      visionStateEl.textContent = `${available ? "Ready" : "Offline"} / ${Number.isFinite(captures) ? captures : 0}${suffix}`;
      if (state.lastScene?.scene_label) {
        visionStateEl.title = state.lastScene.scene_label;
      } else if (state.source) {
        visionStateEl.title = state.source;
      } else {
        visionStateEl.title = "vision";
      }
    },
    setVisionFaceState(state = {}) {
      const faces = Number.isFinite(Number(state.faces))
        ? Number(state.faces)
        : Array.isArray(state.faces)
          ? state.faces.length
          : Number.isFinite(Number(state.registered))
            ? Number(state.registered)
            : 0;
      const detection = state.last_detection || state.lastDetection || null;
      const detectionPerson = Array.isArray(detection?.faces) && detection?.faces[0]?.person
        ? detection.faces[0].person
        : detection?.person;
      const lastPerson = state.last_registered?.name || detectionPerson || "";
      const detectionCount = Number.isFinite(Number(detection?.count))
        ? Number(detection.count)
        : Array.isArray(detection?.faces)
          ? detection.faces.length
          : 0;
      const detecting = detection ? "Detecting" : "";
      const tail = detectionCount > 0 ? ` / ${detectionCount} people` : "";
      faceStateEl.textContent = `${faces} enrolled${tail}${detecting ? ` / ${detecting}` : ""}`.trim();
      if (lastPerson) {
        faceStateEl.title = `last=${lastPerson}${detection?.score ? ` / ${detection.score}` : ""}`;
      } else {
        faceStateEl.title = detecting || "face";
      }
    },
    setVisionMovementState(state = {}) {
      const enabled = !!state.enabled;
      const tracking = !!state.tracking;
      const status = enabled ? "On" : "Off";
      const remain = Number(state.durationSeconds);
      const remainText = Number.isFinite(remain) ? `${remain}s` : "N/A";
      movementStateEl.textContent = `${status}${tracking ? " / tracking" : ""}${enabled ? ` / ${remainText}` : ""}`.trim();
      const expires = state.expiresAt || "";
      const src = state.source || "";
      movementStateEl.title = expires || (src ? `source=${src}` : "movement");
    },
    setCallState(state = {}) {
      const isActive = !!state.active;
      const isRinging = !!state.ringing;
      const id = typeof state.activeCallId === "string" && state.activeCallId ? state.activeCallId : "";
      const status = isActive ? "In call" : isRinging ? "Ringing" : "Idle";
      callStateEl.textContent = `${status}${id ? ` ${id}` : ""}`;
      callStateEl.title = `${state.state || "idle"}${id ? ` | ${id}` : ""}`;
    },
    setFlightState(state = {}) {
      const armed = !!state.safetyArmed;
      const manual = !!state.manualMode;
      const activeIntent = state.activeIntent || state.intent || state.lastIntent;
      const modeText = manual ? "Manual" : "Auto";
      flightStateEl.textContent = `${armed ? "Armed" : "Disarmed"} / ${modeText}${activeIntent ? " / intent set" : ""}`;
      if (activeIntent && typeof activeIntent === "object" && activeIntent.intent) {
        flightStateEl.title = `${activeIntent.intent}${activeIntent.id ? ` | ${activeIntent.id}` : ""}`;
      } else if (typeof activeIntent === "string") {
        flightStateEl.title = activeIntent;
      } else {
        flightStateEl.title = state.state || "flight";
      }
    },
    setPrivacyState(state = {}) {
      const cameraActive = !!state.cameraActive;
      const micActive = !!state.micActive;
      const days = Number(state.telemetryRetentionDays);
      privacyCameraEl.textContent = cameraActive ? "ON" : "off";
      privacyMicEl.textContent = micActive ? "ON" : "off";
      privacyDataEl.textContent = Number.isFinite(days) ? `${days} days / local` : "Local";
      privacyCameraEl.title = cameraActive ? "camera capture/recording active" : "camera inactive";
      privacyMicEl.title = micActive ? "microphone capture active" : "microphone inactive";
      privacyDataEl.title = state.dataRetention || "local telemetry/audit logs";
    },
    setNotificationState({ total = 0, latest = null } = {}) {
      notificationStateEl.textContent = String(Number(total) || 0);
      if (latest && typeof latest === "object") {
        const title = typeof latest.title === "string" ? latest.title : "";
        const body = typeof latest.body === "string" ? latest.body : "";
        const text = `${title}${body ? " - " + body : ""}`;
        notificationLatestEl.textContent = text || "-";
        if (text) notificationLatestEl.title = text;
      } else {
        notificationLatestEl.textContent = "-";
        notificationLatestEl.removeAttribute("title");
      }
    },
    setSystemStatus({ summary = {}, alerts = [], privacy = null } = {}) {
      if (privacy) this.setPrivacyState(privacy);
      else if (summary.privacy) this.setPrivacyState(summary.privacy);
      const session = summary.session || {};
      const host = summary.host || {};
      const services = summary.services || {};
      const hostAudio = summary.hostAudio || {};
      const counts = summary.counts || {};
      const mode = typeof session.mode === "string" && session.mode.trim() ? session.mode : "auto";
      const protocolText = !!session.protocolConnected ? "RPC up" : "Offline";
      const sessionConnected = !!session.connected;
      systemSessionEl.textContent = `${sessionConnected ? "Up" : "Down"} / ${mode} / ${protocolText}`;
      const hostText = `${typeof host.platform === "string" ? host.platform : "-"} / ${typeof host.arch === "string" ? host.arch : "-"}`;
      systemHostEl.textContent = hostText || "-";
      const hostAudioStatus = typeof services.hostAudioStatus === "string" && services.hostAudioStatus.trim()
        ? services.hostAudioStatus
        : "unknown";
      const hostAudioSource = typeof hostAudio.source === "string" && hostAudio.source.trim()
        ? hostAudio.source.trim()
        : "";
      const hostAudioTitle = typeof hostAudio.title === "string" && hostAudio.title.trim()
        ? hostAudio.title.trim()
        : "";
      const hostAudioNote = `${hostAudioSource || hostAudioTitle || ""}`.trim() || hostAudioStatus;
      systemHostAudioEl.textContent = hostAudioNote || "unknown";
      systemHostAudioEl.title = `${hostAudioStatus}${hostAudioSource ? ` / ${hostAudioSource}` : ""}${hostAudioTitle ? ` / ${hostAudioTitle}` : ""}`;

      const todoTotal = Number(counts.todoTotal) || 0;
      const todoPending = Number(counts.todoPending) || 0;
      const reminderTotal = Number(counts.reminderTotal) || 0;
      const reminderPending = Number(counts.reminderPending) || 0;
      const notificationTotal = Number(counts.notificationTotal) || 0;
      const mediaVisible = counts.mediaVisible ? "Media" : "None";
      systemCountsEl.textContent = `Todos ${todoPending}/${todoTotal}; reminders ${reminderPending}/${reminderTotal}; notifications ${notificationTotal}; ${mediaVisible}`;

      const normalizedAlerts = Array.isArray(alerts) ? alerts : [];
      systemRiskEl.textContent = normalizedAlerts.length > 0 ? `${normalizedAlerts.length} items` : "None";
      systemAlertsEl.textContent = "";
      if (normalizedAlerts.length > 0) {
        normalizedAlerts.slice(0, 6).forEach((item) => {
          const level = typeof item?.level === "string" ? item.level : "warn";
          const msg = typeof item?.message === "string" ? item.message.trim() : "";
          if (!msg) return;
          const alertEl = document.createElement("div");
          alertEl.className = `xz-system-alert xz-system-alert-${level}`;
          alertEl.textContent = msg;
          systemAlertsEl.appendChild(alertEl);
        });
      } else {
        const noneEl = document.createElement("div");
        noneEl.className = "xz-system-alert xz-system-alert-ok";
        noneEl.textContent = "No high-priority alerts";
        systemAlertsEl.appendChild(noneEl);
      }
    },
    addLog(log) {
      if (!logEl) return;
      const entry = {
        ts: log?.ts || new Date().toISOString(),
        level: typeof log?.level === "string" ? log.level : "info",
        message: typeof log?.message === "string" ? log.message : String(log),
        detail: log?.detail || null
      };
      logs.push(entry);
      if (logs.length > 25) logs.shift();

      logEl.innerHTML = "";
      logs.forEach((item) => {
        const line = document.createElement("div");
        line.className = "xz-log-line";
        line.dataset.level = item.level;
        const summary = typeof item.detail?.summary === "string"
          ? item.detail.summary
          : typeof item.detail?.note === "string"
            ? item.detail.note
            : "";
        const tool = typeof item.detail?.tool === "string" ? item.detail.tool : "";
        const action = typeof item.detail?.action === "string" ? item.detail.action : "";
        const source = typeof item.detail?.source === "string" ? item.detail.source : "";
        const segments = [];
        if (source) segments.push(source);
        if (tool) segments.push(`tool=${tool}`);
        if (action) segments.push(`action=${action}`);
        const prefix = segments.length ? ` (${segments.join(", ")})` : "";
        const tail = summary ? ` - ${summary}` : "";
        line.textContent = `${new Date(item.ts).toLocaleTimeString()} [${item.level}] ${item.message}${prefix}${tail}`;
        logEl.appendChild(line);
      });
      logEl.scrollTop = logEl.scrollHeight;
    },
    open() { panel.hidden = false; },
    close() { panel.hidden = true; }
  };
}
