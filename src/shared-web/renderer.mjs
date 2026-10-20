import { initLive2D } from "./live2d-renderer.mjs";
import { Live2DControlCore } from "../core/live2d-control-core.mjs";
import { createLocalHostBridge } from "../bridge/host-bridge.mjs";
import { createXiaozhiAgent, ListeningMode, DeviceState, AbortReason } from "../xiaozhi/index.mjs";
import {
  resolveBackendConfig,
  saveBackendConfig,
  clearBackendConfig
} from "../xiaozhi/config/backend-config.mjs";
import { createBackendSetupDialog } from "./ui/backend-config-ui.mjs";
import { createChatPanel } from "./ui/chat-panel.mjs";
import { createActivationDialog } from "./ui/activation-dialog.mjs";
import { createWakeProvider, WakeCoordinator } from "../xiaozhi/wake/wake-coordinator.mjs";
import { CallController } from "../videochat/call-controller.mjs";
import { loadCallConfig, saveCallConfig, validateCallConfig } from "../videochat/call-config.mjs";
import { registerVideoCallTools } from "../xiaozhi/mcp/tools/video-call.mjs";
import { startRemoteControl } from "../remote-control/index.mjs";

window.addEventListener("unhandledrejection", (e) => {
  console.error("[xz] unhandled rejection:", e.reason);
});

function assetBase() {
  if (globalThis.__APP_ASSET_BASE__) return globalThis.__APP_ASSET_BASE__;
  if (globalThis.location?.hostname === "appassets.androidplatform.net") {
    return "https://appassets.androidplatform.net/assets/";
  }
  return "app://localhost/";
}

function isAndroidAssetBase() {
  return globalThis.location?.hostname === "appassets.androidplatform.net";
}

function vendorUrl(file) {
  return isAndroidAssetBase()
    ? `${assetBase()}vendor/${file}`
    : `${assetBase()}src/shared-web/vendor/${file}`;
}

function workletUrl(file) {
  return isAndroidAssetBase()
    ? `${assetBase()}xiaozhi/audio/worklet/${file}`
    : `${assetBase()}src/xiaozhi/audio/worklet/${file}`;
}

function readJsonStorage(storage, key) {
  try {
    const raw = storage?.get?.(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function activeNotificationsFromState(raw) {
  const now = Date.now();
  if (!raw || !Array.isArray(raw.notifications)) return [];
  return raw.notifications
    .filter((item) => item && typeof item === "object" && item.title)
    .filter((item) => !item.dismissed)
    .filter((item) => !item.expiresAt || Number(item.expiresAt) > now)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

function createMediaLayer(storage) {
  const layer = document.createElement("section");
  layer.className = "xz-media-layer";
  layer.setAttribute("aria-live", "polite");
  layer.setAttribute("role", "region");
  layer.innerHTML = `
    <article class="xz-media-card">
      <div class="xz-media-card-head">
        <span id="xzMediaLayerKind">Media</span>
        <button id="xzMediaClose" type="button" class="xz-media-close" aria-label="Close media">×</button>
      </div>
      <div class="xz-media-subtitle" id="xzMediaLayerTitle">-</div>
      <img id="xzMediaImage" alt="" class="xz-media-image" />
      <video id="xzMediaVideo" class="xz-media-video" playsinline controls></video>
    </article>
  `;
  layer.hidden = true;
  document.body.appendChild(layer);

  const kindEl = layer.querySelector("#xzMediaLayerKind");
  const titleEl = layer.querySelector("#xzMediaLayerTitle");
  const imgEl = layer.querySelector("#xzMediaImage");
  const videoEl = layer.querySelector("#xzMediaVideo");
  const closeBtn = layer.querySelector("#xzMediaClose");

  closeBtn.addEventListener("click", () => {
    const clearedState = {
      kind: "none",
      title: "",
      source: "",
      startedAt: new Date().toISOString(),
      autoPlay: false,
      visible: false
    };
    layer.hidden = true;
    videoEl.pause();
    imgEl.removeAttribute("src");
    videoEl.removeAttribute("src");
    storage?.set?.("blimpmate.media_v1", JSON.stringify(clearedState));
    globalThis.dispatchEvent(new CustomEvent("blimpmate-media-state", {
      detail: clearedState
    }));
  });

  return {
    layer,
    kindEl,
    titleEl,
    imgEl,
    videoEl,
    setState(state = {}) {
      const kind = typeof state.kind === "string" ? state.kind : "none";
      const title = typeof state.title === "string" ? state.title : "Media";
      const visible = !!state.visible;
      const source = typeof state.source === "string" ? state.source : "";
      const autoPlay = !!state.autoPlay;

      if (!visible || kind === "none" || !source) {
        layer.hidden = true;
        videoEl.pause();
        imgEl.removeAttribute("src");
        videoEl.removeAttribute("src");
        return;
      }

      kindEl.textContent = `Media (${kind})`;
      titleEl.textContent = title || "Media";
      layer.hidden = false;
      imgEl.hidden = true;
      videoEl.hidden = true;

      if (kind === "image") {
        imgEl.src = source;
        imgEl.hidden = false;
      } else if (kind === "video") {
        videoEl.src = source;
        videoEl.hidden = false;
        if (autoPlay) {
          videoEl.play().catch(() => {});
        }
      }
    }
  };
}

function createNotificationLayer() {
  const layer = document.createElement("section");
  layer.className = "xz-notification-layer";
  layer.setAttribute("aria-live", "polite");
  layer.setAttribute("role", "log");
  const list = document.createElement("div");
  list.className = "xz-notification-list";
  layer.appendChild(list);
  layer.hidden = true;
  document.body.appendChild(layer);

  let timers = [];
  const clearTimers = () => {
    timers.forEach((id) => clearTimeout(id));
    timers = [];
  };

  return {
    layer,
    list,
    setState(raw = {}) {
      const notifications = activeNotificationsFromState(raw);
      const alive = notifications
        .slice(0, 3)
        .map((item) => ({
          id: String(item.id || `${item.createdAt || Date.now()}`),
          title: typeof item.title === "string" ? item.title : "Notice",
          body: typeof item.body === "string" ? item.body : "",
          level: typeof item.level === "string" ? item.level : "info",
          ttlSeconds: Number(item.ttlSeconds) || 8
        }));

      clearTimers();
      list.textContent = "";
      if (alive.length === 0) {
        layer.hidden = true;
        return;
      }

      layer.hidden = false;
      alive.forEach((item) => {
        const toast = document.createElement("article");
        toast.className = `xz-notification-toast xz-notification-${item.level}`;
        toast.dataset.notificationId = item.id;
        const title = document.createElement("div");
        title.className = "xz-notification-title";
        title.textContent = item.title;
        const body = document.createElement("div");
        body.className = "xz-notification-body";
        body.textContent = item.body;
        toast.append(title, body);
        list.appendChild(toast);
        const ttlMs = Math.max(1000, item.ttlSeconds * 1000);
        timers.push(setTimeout(() => {
          const target = list.querySelector(`[data-notification-id="${item.id}"]`);
          if (target) target.remove();
          if (!list.children.length) layer.hidden = true;
        }, ttlMs));
      });
    }
  };
}

function safeGetArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function normalizeDisplayPage(value = "avatar") {
  const page = typeof value === "string" ? value.trim() : "";
  switch (page.toLowerCase()) {
    case "mjpeg":
    case "home":
      return "avatar";
    case "clock":
    case "todo":
    case "noti":
    case "notification":
    case "media":
    case "image":
    case "video":
    case "lyric":
      return page === "lyric" ? "media" : page.toLowerCase();
    case "card":
    case "steps":
      return page.toLowerCase();
    default:
      return page.toLowerCase() === "avatar" ? "avatar" : "avatar";
  }
}

function readTodosFromStore(storage) {
  const raw = readJsonStorage(storage, "blimpmate.todos_v1");
  if (Array.isArray(raw)) return raw;
  return safeGetArray(raw?.todos || null, []);
}

function readNotificationsFromStore(storage) {
  const raw = readJsonStorage(storage, "blimpmate.notifications_v1") || {};
  return activeNotificationsFromState(raw);
}

function formatClockText(now = new Date()) {
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const date = now.toLocaleDateString([], { year: "numeric", month: "short", day: "2-digit" });
  const week = now.toLocaleDateString([], { weekday: "short" });
  return { time, date, week };
}

function createDisplayPageLayer(storage) {
  const layer = document.createElement("section");
  layer.className = "xz-page-layer";
  layer.setAttribute("aria-live", "polite");
  layer.hidden = true;
  layer.innerHTML = `
    <article class="xz-page-card">
      <header class="xz-page-card-head">
        <div class="xz-page-card-title">
          <span id="xzPageName">Page</span>
          <span id="xzPageSubtitle">-</span>
        </div>
        <button id="xzPageClose" type="button" class="xz-page-close" aria-label="Close page">×</button>
      </header>
      <div id="xzPageBody" class="xz-page-body"></div>
    </article>
  `;
  document.body.appendChild(layer);

  const pageNameEl = layer.querySelector("#xzPageName");
  const subtitleEl = layer.querySelector("#xzPageSubtitle");
  const bodyEl = layer.querySelector("#xzPageBody");
  const closeBtn = layer.querySelector("#xzPageClose");

  let displayState = {
    page: "avatar",
    subtitle: "",
    card: null,
    steps: null
  };
  let mediaState = {
    kind: "none",
    source: "",
    title: "",
    visible: false
  };

  let clockTimer = null;

  const clearClock = () => {
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };

  closeBtn.addEventListener("click", () => {
    const nextState = {
      ...displayState,
      page: "avatar",
      subtitle: "",
      updatedAt: new Date().toISOString()
    };
    displayState = nextState;
    layer.hidden = true;
    clearClock();
    storage?.set?.("blimpmate.display_state_v1", JSON.stringify(nextState));
    globalThis.dispatchEvent(new CustomEvent("blimpmate-display-state", {
      detail: nextState
    }));
  });

  const renderRow = (label, value) => {
    const row = document.createElement("div");
    row.className = "xz-page-row";
    row.innerHTML = `<span class="xz-page-row-label">${label}</span><span class="xz-page-row-value">${value}</span>`;
    bodyEl.appendChild(row);
  };

  const renderClock = () => {
    bodyEl.innerHTML = "";
    const now = formatClockText(new Date());
    const block = document.createElement("div");
    block.className = "xz-page-clock";
    block.innerHTML = `
      <div class="xz-page-clock-time">${now.time}</div>
      <div class="xz-page-clock-date">${now.date} · ${now.week}</div>
    `;
    bodyEl.appendChild(block);
  };

  const renderTodo = () => {
    bodyEl.innerHTML = "";
    const todos = readTodosFromStore(storage);
    const pending = todos.filter((item) => !item?.completed);
    if (pending.length === 0) {
      renderRow("Status", "No todos");
      return;
    }
    pending
      .slice(0, 8)
      .forEach((item, idx) => {
        const row = document.createElement("div");
        row.className = "xz-page-item";
        const due = typeof item?.due_date === "string" ? item.due_date : "";
        const dueTime = typeof item?.due_time === "string" ? item.due_time : "";
        row.innerHTML = `<div class="xz-page-item-title">${idx + 1}. ${item?.title || "Untitled"}</div>` +
          `<div class="xz-page-item-meta">${item?.note ? `${item.note}` : ""}${due || dueTime ? ` · ${[due, dueTime].filter(Boolean).join(" ")}` : ""}</div>`;
        bodyEl.appendChild(row);
      });
  };

  const renderNotification = () => {
    bodyEl.innerHTML = "";
    const notifications = readNotificationsFromStore(storage);
    if (notifications.length === 0) {
      renderRow("Status", "No notifications");
      return;
    }
    notifications.slice(0, 8).forEach((item) => {
      const row = document.createElement("div");
      row.className = "xz-page-item";
      const level = item?.level || "info";
      row.innerHTML = `<div class="xz-page-item-title xz-page-item-${level}">${item.title || "Reminder"}</div>` +
        `<div class="xz-page-item-meta">${item.body || ""}</div>`;
      bodyEl.appendChild(row);
    });
  };

  const renderMedia = () => {
    const hasSource = typeof mediaState?.source === "string" && mediaState.source.trim();
    if (!hasSource) {
      renderRow("Media", "No source");
      return;
    }
    const modeText = mediaState.kind === "video" ? "Video" : "Image";
    renderRow("Type", modeText);
    renderRow("Title", mediaState.title || "-" );
    renderRow("Link", mediaState.source);
    if (mediaState.kind === "image") {
      const img = document.createElement("img");
      img.className = "xz-page-media-preview";
      img.alt = "media preview";
      img.src = mediaState.source;
      bodyEl.appendChild(img);
      return;
    }
    if (mediaState.kind === "video") {
      const video = document.createElement("video");
      video.className = "xz-page-media-preview";
      video.src = mediaState.source;
      video.controls = false;
      video.autoplay = false;
      video.loop = true;
      bodyEl.appendChild(video);
    }
  };

  const renderCard = () => {
    bodyEl.innerHTML = "";
    const card = displayState?.card || {};
    renderRow("Title", card.title || "Untitled");
    if (card.card_type) {
      renderRow("Type", card.card_type);
    }
    if (card.body) {
      const body = document.createElement("div");
      body.className = "xz-page-card-body";
      body.textContent = card.body;
      bodyEl.appendChild(body);
    }
    if (card.image_url) {
      const img = document.createElement("img");
      img.className = "xz-page-media-preview";
      img.alt = "card image";
      img.src = card.image_url;
      bodyEl.appendChild(img);
    }
  };

  const renderSteps = () => {
    bodyEl.innerHTML = "";
    const steps = displayState?.steps || {};
    const title = typeof steps?.title === "string" && steps.title.trim()
      ? steps.title
      : "Task steps";
    const items = safeGetArray(steps?.items, []);
    renderRow("Title", title);
    if (!items.length) {
      renderRow("Status", "No steps yet");
      return;
    }
    items.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "xz-page-item";
      row.innerHTML = `<div class="xz-page-item-title">${idx + 1}. ${item}</div>`;
      bodyEl.appendChild(row);
    });
  };

  const renderAvatar = () => {
    layer.hidden = true;
    clearClock();
  };

  const render = (page) => {
    const activePage = normalizeDisplayPage(page);
    pageNameEl.textContent = activePage;
    subtitleEl.textContent = displayState?.subtitle || "";
    bodyEl.textContent = "";

    if (activePage === "avatar") {
      renderAvatar();
      return;
    }

    clearClock();
    layer.hidden = false;

    if (activePage === "clock") renderClock();
    else if (activePage === "todo") renderTodo();
    else if (activePage === "notification") renderNotification();
    else if (activePage === "media" || activePage === "image" || activePage === "video") renderMedia();
    else if (activePage === "card") renderCard();
    else if (activePage === "steps") renderSteps();
    else renderRow("Notice", "Page is not defined");

    if (activePage === "clock") {
      clockTimer = setInterval(renderClock, 1000);
    }
  };

  return {
    layer,
    setDisplayState(next = {}) {
      displayState = {
        ...displayState,
        ...next,
        page: normalizeDisplayPage(next?.page || displayState.page || "avatar")
      };
      render(displayState.page);
    },
    setMediaState(next = {}) {
      mediaState = {
        ...mediaState,
        ...next
      };
      if (normalizeDisplayPage(displayState.page) === "media" ||
          normalizeDisplayPage(displayState.page) === "image" ||
          normalizeDisplayPage(displayState.page) === "video") {
        render(displayState.page);
      }
    },
    refresh() {
      render(displayState.page);
    }
  };
}

if (!window.hostBridge) {
  window.hostBridge = createLocalHostBridge(new Live2DControlCore());
}

const panel          = document.getElementById("debugPanel");
const panelToggle    = document.getElementById("panelToggle");
const panelClose     = document.getElementById("panelClose");
const expressionBtns = document.getElementById("expressionButtons");
const snapshotEl     = document.getElementById("snapshot");
const currentExpr    = document.getElementById("currentExpr");
const targetExpr     = document.getElementById("targetExpr");
const eyeValue       = document.getElementById("eyeValue");
const mouthValue     = document.getElementById("mouthValue");

const blinkMin    = document.getElementById("blinkMin");
const blinkMax    = document.getElementById("blinkMax");
const eyeRange    = document.getElementById("eyeRange");
const eyeSpeed    = document.getElementById("eyeSpeed");
const mouthRange  = document.getElementById("mouthRange");
const eyeToggle   = document.getElementById("eyeToggle");
const browToggle  = document.getElementById("browToggle");
const mouthToggle = document.getElementById("mouthToggle");
const recoverToggle = document.getElementById("recoverToggle");
const mediaLayer = createMediaLayer(window.hostBridge.storage);
const notificationLayer = createNotificationLayer();
const displayLayer = createDisplayPageLayer(window.hostBridge.storage);

document.getElementById("blinkBtn").addEventListener("click", () => window.hostBridge.triggerBlink());
document.getElementById("clearBtn").addEventListener("click", () => window.hostBridge.clearExpression());

panelToggle.addEventListener("click", (event) => { event.stopPropagation(); panel.hidden = !panel.hidden; });
panelClose.addEventListener("click", (event) => { event.stopPropagation(); panel.hidden = true; });
panel.addEventListener("click", (event) => { event.stopPropagation(); });
document.addEventListener("click", () => { panel.hidden = true; });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") panel.hidden = true; });

blinkMin.addEventListener("input", syncSettings);
blinkMax.addEventListener("input", syncSettings);
eyeRange.addEventListener("input", syncSettings);
eyeSpeed.addEventListener("input", syncSettings);
mouthRange.addEventListener("input", syncSettings);

eyeToggle.addEventListener("change",    () => window.hostBridge.setRandomEyeMovement(eyeToggle.checked));
browToggle.addEventListener("change",   () => window.hostBridge.setRandomBrowMovement(browToggle.checked));
mouthToggle.addEventListener("change",  () => window.hostBridge.setRandomMouthMovement(mouthToggle.checked));
recoverToggle.addEventListener("change",() => window.hostBridge.setAutoRecoverExpression(recoverToggle.checked));

function syncSettings() {
  const s = window.hostBridge.getSettings();
  window.hostBridge.setBlinkSettings(Number(blinkMin.value), Number(blinkMax.value), s.blinkDuration);
  window.hostBridge.setEyeMovementSettings({
    interval: s.eyeMovementInterval,
    speed: Number(eyeSpeed.value),
    range: Number(eyeRange.value),
    returnDelay: s.eyeReturnDelay
  });
  window.hostBridge.setMouthMovementRange(Number(mouthRange.value));
}

for (const name of window.hostBridge.getExpressionTypes()) {
  if (name === "None") continue;
  const btn = document.createElement("button");
  btn.className = "expr-btn";
  btn.type = "button";
  btn.textContent = name;
  btn.addEventListener("click", () => {
    window.hostBridge.setExpression(name);
    refreshExpressionButtons(name);
  });
  expressionBtns.append(btn);
}

syncSettings();
refreshExpressionButtons("None");

function render() {
  const snap = window.hostBridge.getSnapshot();
  currentExpr.textContent  = snap.expression;
  targetExpr.textContent   = snap.targetExpression;
  eyeValue.textContent     = `${snap.eyeX.toFixed(2)} / ${snap.eyeY.toFixed(2)}`;
  mouthValue.textContent   = `${snap.mouthForm.toFixed(2)} / ${snap.mouthOpen.toFixed(2)}`;
  snapshotEl.textContent = JSON.stringify(snap, null, 2);
}

function refreshExpressionButtons(active) {
  expressionBtns.querySelectorAll("button").forEach(btn => {
    btn.classList.toggle("active", btn.textContent === active);
  });
}

initLive2D(
  document.getElementById("modelFrame"),
  () => window.hostBridge.getLive2DParameters(),
  (dt) => {
    window.hostBridge.tick(dt);
    render();
  }
);

// === Xiaozhi agent boot ===
const BASE = assetBase();
const assetUrls = {
  encoderWorker:    vendorUrl("encoderWorker.min.js"),
  decoderScript:    vendorUrl("opus-decoder.min.js"),
  captureWorklet:   workletUrl("capture-processor.js"),
  playbackWorklet:  workletUrl("playback-processor.js")
};

const activationDialog = createActivationDialog();
const backendSetupDialog = createBackendSetupDialog();
const chatPanel = createChatPanel({
  onConnect: async () => {
    if (!window.__xz?.conversation) return;
    await window.__xz.conversation.connect();
  },
  // Backend changes re-run startup (OTA mode may need activation), so save
  // and reload rather than patching the live conversation.
  onBackendApply: (cfg) => {
    saveBackendConfig(window.hostBridge.storage, cfg);
    location.reload();
  },
  onBackendReset: () => {
    clearBackendConfig(window.hostBridge.storage);
    location.reload();
  },
  onCallApply: (cfg) => {
    const error = validateCallConfig(cfg);
    if (error) return error;
    const saved = saveCallConfig(window.hostBridge.storage, cfg);
    window.__xz?.callController?.configure(saved);
    return null;
  },
  onDisconnect: async () => {
    if (!window.__xz) return;
    await window.__xz.conversation.endSession();
  },
  onPress: async () => {
    if (!window.__xz) return;
    await window.__xz.wakeClient?.stop?.();
    const mode = window.__xz.mode === "auto" ? ListeningMode.AUTO_STOP : ListeningMode.MANUAL;
    await window.__xz.conversation.startListening(mode);
  },
  onRelease: async () => {
    if (!window.__xz) return;
    if (window.__xz.mode === "auto") {
      await window.__xz.conversation.endSession({ disconnect: false });
    } else {
      await window.__xz.conversation.stopListening();
      await window.__xz.wakeClient?.start?.();
    }
  },
  onAbort: async () => {
    if (!window.__xz) return;
    await window.__xz.conversation.abort(AbortReason.USER_INTERRUPTION);
  },
  onSendText: async (text) => {
    if (!window.__xz) return;
    await window.__xz.conversation.sendText(text);
  },
  onModeChange: (m) => {
    if (!window.__xz) window.__xz = {};
    window.__xz.mode = m;
    const conv = window.__xz.conversation;
    if (conv?.state) {
      conv.state.setMode(m === "auto" ? ListeningMode.AUTO_STOP : ListeningMode.MANUAL);
      if (m === "manual" && conv._autoSessionActive) {
        conv.endSession({ disconnect: false }).catch(() => {});
      }
    }
  }
});

if (window.hostBridge && window.hostBridge.storage) {
  const savedDisplay = readJsonStorage(window.hostBridge.storage, "blimpmate.display_state_v1");
  if (savedDisplay) chatPanel.setDisplayState(savedDisplay);
  if (savedDisplay) displayLayer.setDisplayState(savedDisplay);

  const savedTodosForDisplay = readJsonStorage(window.hostBridge.storage, "blimpmate.todos_v1");
  if (savedTodosForDisplay && displayLayer && typeof displayLayer.refresh === "function") {
    displayLayer.refresh();
  }

  const savedTodos = readJsonStorage(window.hostBridge.storage, "blimpmate.todos_v1");
  if (savedTodos) {
    chatPanel.setTodoState(savedTodos);
    displayLayer.refresh();
  }

  const savedMemories = readJsonStorage(window.hostBridge.storage, "blimpmate.memory_v1");
  if (savedMemories?.memories) {
    chatPanel.setMemoryState({ count: Array.isArray(savedMemories.memories) ? savedMemories.memories.length : 0 });
  }

  const savedMedia = readJsonStorage(window.hostBridge.storage, "blimpmate.media_v1");
  if (savedMedia) {
    chatPanel.setMediaState(savedMedia);
    mediaLayer.setState(savedMedia);
    displayLayer.setMediaState(savedMedia);
  }

  const savedNotifications = readJsonStorage(window.hostBridge.storage, "blimpmate.notifications_v1");
  if (savedNotifications) {
    const activeNotifications = activeNotificationsFromState(savedNotifications);
    chatPanel.setNotificationState({
      total: activeNotifications.length,
      latest: activeNotifications[0] || null
    });
    notificationLayer.setState({ notifications: activeNotifications });
  }

  const savedReminders = readJsonStorage(window.hostBridge.storage, "blimpmate.reminders_v1");
  if (savedReminders && typeof savedReminders === "object") {
    const reminders = Array.isArray(savedReminders.reminders) ? savedReminders.reminders : [];
    const pending = reminders.filter((item) => !item?.completed).length;
    chatPanel.setReminderState({ total: reminders.length, pending });
  }

  const savedMusic = readJsonStorage(window.hostBridge.storage, "blimpmate.music_v1");
  if (savedMusic) chatPanel.setMusicState(savedMusic);

  const savedSystemStatus = readJsonStorage(window.hostBridge.storage, "blimpmate.system_status_v1");
  if (savedSystemStatus) {
    chatPanel.setSystemStatus(savedSystemStatus);
  }

  const savedVolume = readJsonStorage(window.hostBridge.storage, "blimpmate.volume_v1");
  if (savedVolume) chatPanel.setVolumeState(savedVolume);

  const savedHostAudio = readJsonStorage(window.hostBridge.storage, "blimpmate.host_audio_v1");
  if (savedHostAudio) chatPanel.setHostAudioState(savedHostAudio);

  const savedCamera = readJsonStorage(window.hostBridge.storage, "blimpmate.camera_v1");
  if (savedCamera) chatPanel.setCameraState(savedCamera);

  const savedVision = readJsonStorage(window.hostBridge.storage, "blimpmate.vision_v1");
  if (savedVision) chatPanel.setVisionState({
    ...savedVision,
    captures: Array.isArray(savedVision.captures) ? savedVision.captures.length : 0,
    total: Array.isArray(savedVision.captures) ? savedVision.captures.length : 0
  });

  const savedFaces = readJsonStorage(window.hostBridge.storage, "blimpmate.face_v1");
  if (savedFaces) {
    chatPanel.setVisionFaceState({
      ...savedFaces,
      lastDetection: savedFaces.last_detection || savedFaces.lastDetection || null
    });
  }

  const savedMovement = readJsonStorage(window.hostBridge.storage, "blimpmate.movement_v1");
  if (savedMovement) chatPanel.setVisionMovementState(savedMovement);

  const savedCall = readJsonStorage(window.hostBridge.storage, "blimpmate.call_v1");
  if (savedCall) chatPanel.setCallState(savedCall);

  const savedFlight = readJsonStorage(window.hostBridge.storage, "blimpmate.flight_v1");
  if (savedFlight) chatPanel.setFlightState(savedFlight);

  window.addEventListener("blimpmate-display-state", (e) => {
    chatPanel.setDisplayState(e.detail || {});
    displayLayer.setDisplayState(e.detail || {});
  });
  window.addEventListener("blimpmate-todo-state", (e) => {
    chatPanel.setTodoState(e.detail || {});
    displayLayer.refresh();
  });
  window.addEventListener("blimpmate-memory-state", (e) => {
    chatPanel.setMemoryState(e.detail || {});
  });
  window.addEventListener("blimpmate-media-state", (e) => {
    const state = e.detail || {};
    chatPanel.setMediaState(state);
    mediaLayer.setState(state);
    displayLayer.setMediaState(state);
  });
  window.addEventListener("blimpmate-notification-state", (e) => {
    const state = e.detail || {};
    chatPanel.setNotificationState({
      total: state.total || 0,
      latest: state.latest || null
    });
    notificationLayer.setState(state);
    displayLayer.refresh();
  });
  window.addEventListener("blimpmate-reminder-state", (e) => {
    chatPanel.setReminderState(e.detail || {});
  });
  window.addEventListener("blimpmate-music-state", (e) => {
    chatPanel.setMusicState(e.detail || {});
  });
  window.addEventListener("blimpmate-volume-state", (e) => {
    chatPanel.setVolumeState(e.detail || {});
  });
  window.addEventListener("blimpmate-host-audio-state", (e) => {
    const state = e.detail || {};
    chatPanel.setHostAudioState(state);
    try {
      window.hostBridge?.storage?.set?.("blimpmate.host_audio_v1", JSON.stringify(state));
    } catch {}
  });
  window.addEventListener("blimpmate-camera-state", (e) => {
    chatPanel.setCameraState(e.detail || {});
  });
  window.addEventListener("blimpmate-vision-state", (e) => {
    const visionState = e.detail || {};
    chatPanel.setVisionState({
      ...visionState,
      captures: Array.isArray(visionState.captures) ? visionState.captures.length : 0
    });
  });
  window.addEventListener("blimpmate-face-state", (e) => {
    const state = e.detail || {};
    chatPanel.setVisionFaceState({
      ...state,
      lastDetection: state.last_detection || state.lastDetection || null
    });
  });
  window.addEventListener("blimpmate-movement-state", (e) => {
    chatPanel.setVisionMovementState(e.detail || {});
  });
  window.addEventListener("blimpmate-call-state", (e) => {
    chatPanel.setCallState(e.detail || {});
  });
  window.addEventListener("blimpmate-flight-state", (e) => {
    const state = e.detail || {};
    const intent = state.intent || null;
    chatPanel.setFlightState({
      ...state,
      activeIntent: intent
    });
  });
  window.addEventListener("blimpmate-system-status", (e) => {
    chatPanel.setSystemStatus(e.detail || {});
  });
}

(async () => {
  try {
    if (typeof window.hostReady === "function") {
      await window.hostReady();
    }


    const onActivationRequired = async (activation, runActivation) => {
      activationDialog.show(activation);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn) => {
          if (settled) return;
          settled = true;
          activationDialog.hide();
          fn();
        };

        const runOnce = async () => {
          try {
            await runActivation((p) => {
              activationDialog.updateProgress(p.attempt);
            });
            finish(() => resolve());
          } catch (err) {
            if (settled) return;
            const msg = err && err.message ? err.message : String(err || "Activation failed");
            activationDialog.showError(msg);
            chatPanel.addLog({
              ts: new Date().toISOString(),
              level: "error",
              message: `Activation failed: ${msg}`,
              detail: { source: "activation" }
            });
          }
        };

        activationDialog.onCancel(() => {
          finish(() => reject(new Error("Activation cancelled by user")));
        });
        activationDialog.onDone(() => {
          finish(() => resolve());
        });
        activationDialog.onRetry(() => {
          runOnce();
        });

        runOnce();
      });
    };

    // Saved config > host env (.env) > ask. If the chosen backend fails to
    // start (e.g. OTA unreachable), ask again with the error shown.
    const storage = window.hostBridge.storage;
    let resolved = resolveBackendConfig(storage);
    if (!resolved) {
      const cfg = await backendSetupDialog.ask();
      resolved = { config: saveBackendConfig(storage, cfg), source: "saved" };
    }
    chatPanel.setBackend(resolved.config, resolved.source);

    let agent;
    try {
      agent = await createXiaozhiAgent({
        bridge: window.hostBridge,
        assetUrls,
        backend: resolved.config,
        onActivationRequired
      });
    } catch (err) {
      const msg = err?.message || String(err);
      chatPanel.setConnected(false, "Backend unavailable");
      chatPanel.showBackendError(`Could not start: ${msg}`);
      const cfg = await backendSetupDialog.ask({
        initial: resolved.config,
        message: "Could not reach the configured backend. Check the address, or save to retry.",
        error: msg
      });
      saveBackendConfig(storage, cfg);
      location.reload();
      return;
    }

    window.__xz = { conversation: agent.conversation, identity: agent.identity, mode: "auto" };
    chatPanel.setDeviceId(agent.identity.mac);

    // --- Always-on wake word -------------------------------------------
    // The provider is HTTP/Sherpa on desktop and can be a native bridge on
    // Android. Conversation and media interruption stay platform-neutral.
    try {
      const wakeHost =
        globalThis.hostInfo?.hostServiceUrl ||
        `http://${globalThis.location?.hostname || "127.0.0.1"}:${globalThis.hostInfo?.hostServicePort || 5000}`;
      const wakeProvider = createWakeProvider({
        hostServiceUrl: wakeHost,
        audioCapture: agent.conversation.capture
      });
      const pauseMediaForWake = async () => {
        for (const media of document.querySelectorAll("audio, video")) {
          try { media.pause(); } catch {}
        }
      };
      const wakeCoordinator = new WakeCoordinator({
        provider: wakeProvider,
        conversation: agent.conversation,
        beforeListen: pauseMediaForWake
      });
      window.hostBridge.wakeClient = wakeProvider;
      window.__xz.wakeClient = wakeProvider;
      window.__xz.wakeCoordinator = wakeCoordinator;

      wakeProvider.onWake?.((evt) => {
        chatPanel.addLog({
          ts: new Date().toISOString(),
          level: "info",
          message: `Wake word: ${evt?.word || "Hey Blimp"}`,
          detail: { source: "wake", ...evt }
        });
      });

      if (globalThis.hostInfo?.wakeWord?.enabled !== false) {
        wakeCoordinator.start()
          .then(() => chatPanel.setAgentStatus("wake"))
          .catch((err) => {
            chatPanel.setAgentStatus("error");
            console.warn("[xz] wake start fallback:", err?.message || err);
          });
      }
    } catch (wakeErr) {
      console.warn("[xz] wake setup failed:", wakeErr);
    }

    const conv = agent.conversation;
    conv.addEventListener("wake", () => {
      window.__xz.mode = "auto";
      chatPanel.setMode("auto", { active: true });
      chatPanel.setAgentStatus("connecting");
    });
    conv.addEventListener("session-ended", () => {
      chatPanel.setConversationActive(false);
      chatPanel.setAgentStatus("wake");
      // A ringing or active video call owns the microphone; it re-arms the wake word itself
      if (window.__xz.callController?.busy) return;
      window.__xz.wakeClient?.start?.().catch?.(() => {});
    });
    conv.state.addEventListener("mode", (e) => {
      const mode = e.detail === ListeningMode.AUTO_STOP ? "auto" : "manual";
      window.__xz.mode = mode;
      chatPanel.setMode(mode, { active: mode === "auto" && conv._autoSessionActive });
    });
    conv.state.addEventListener("device", (e) => {
      if (e.detail?.new === DeviceState.LISTENING) chatPanel.setAgentStatus("listening");
      else if (e.detail?.new === DeviceState.SPEAKING) chatPanel.setAgentStatus("speaking");
      else if (conv._autoSessionActive) chatPanel.setAgentStatus("connected");
    });
    conv.addEventListener("connected", () => {
      chatPanel.setConnected(true);
      chatPanel.setAgentStatus("connected");
    });
    conv.addEventListener("disconnected", () => {
      chatPanel.setConnected(false, "Disconnected");
      chatPanel.setAgentStatus("error");
    });
    conv.addEventListener("reconnecting", (e) => {
      chatPanel.setConnected(false, `Reconnecting #${e.detail.attempt}`);
      chatPanel.setAgentStatus("connecting");
    });
    conv.addEventListener("stt-text", (e) => chatPanel.setStt(e.detail));
    conv.addEventListener("tts-text", (e) => chatPanel.setTts(e.detail));
    conv.addEventListener("emotion", (e) => chatPanel.setEmotion(e.detail));
    conv.addEventListener("xz-log", (e) => chatPanel.addLog(e.detail));
    conv.addEventListener("xz-status", (e) => {
      const detail = e.detail || {};
      const phase = typeof detail.phase === "string" ? detail.phase : "";
      const message = typeof detail.message === "string" ? detail.message : "";
      if (phase === "connecting") {
        chatPanel.setConnected(false, message || "Connecting...");
        chatPanel.setAgentStatus("connecting");
      } else if (phase === "connected") {
        chatPanel.setConnected(true);
        chatPanel.setAgentStatus("connected");
      } else if (phase === "failed") {
        chatPanel.setConnected(false, message || "Connection failed");
        chatPanel.setAgentStatus("error");
      }
      chatPanel.addLog({
        ts: new Date().toISOString(),
        level: phase === "failed" ? "warn" : "info",
        message: message || `Status: ${phase}`,
        detail: { source: "conversation", phase }
      });
    });

    // --- Video calls (separate server; see src/videochat) -----------------
    const callController = new CallController({
      conversation: conv,
      getWakeCoordinator: () => window.__xz.wakeCoordinator || null,
      wakeProvider: window.__xz.wakeClient || null,
      nativeWake: globalThis.nativeWakeWord || null,
      log: (level, message, detail = {}) => chatPanel.addLog({
        ts: new Date().toISOString(), level, message, detail: { source: "video-call", ...detail }
      })
    });
    window.__xz.callController = callController;
    registerVideoCallTools(conv.mcp, callController);
    callController.addEventListener("status", (e) => chatPanel.setCallStatus(e.detail));
    const callConfig = loadCallConfig(window.hostBridge.storage);
    chatPanel.setCallConfig(callConfig);
    callController.configure(callConfig);

    // --- Server portal control (online status, "play now") ---------------
    window.__xz.remoteControl = startRemoteControl({
      conversation: conv,
      identity: agent.identity,
      callController,
      getWakeCoordinator: () => window.__xz.wakeCoordinator || null,
      avatar: window.hostBridge,
      log: (level, message, detail = {}) => chatPanel.addLog({
        ts: new Date().toISOString(), level, message, detail: { source: "remote-control", ...detail }
      })
    });

    conv.connect().catch((err) => console.error("[xz] ws connect failed:", err));
  } catch (err) {
    console.error("[xz] init failed:", err);
    chatPanel.setConnected(false, "Init failed");
  }
})();
