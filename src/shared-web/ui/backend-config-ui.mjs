import {
  BackendMode,
  inferBackendMode,
  normalizeBackendConfig,
  validateBackendConfig
} from "../../xiaozhi/config/backend-config.mjs";

const PLACEHOLDERS = {
  [BackendMode.OTA]: "http://127.0.0.1:8003/xiaozhi/ota/",
  [BackendMode.WS]: "ws://127.0.0.1:8000/xiaozhi/v1/"
};

// Mode selector + URL + (websocket-only) token. Shared by the first-run
// dialog and the chat panel so both validate and save the same shape.
export function createBackendForm() {
  const el = document.createElement("div");
  el.className = "xz-backend-form";
  el.innerHTML = `
    <div class="xz-row xz-backend-modes" role="radiogroup" aria-label="Backend type">
      <button type="button" class="xz-btn" data-mode="${BackendMode.OTA}">OTA</button>
      <button type="button" class="xz-btn" data-mode="${BackendMode.WS}">WebSocket</button>
    </div>
    <div class="xz-backend-hint"></div>
    <input type="text" class="xz-input" data-field="url" spellcheck="false" autocomplete="off" />
    <input type="text" class="xz-input" data-field="token" spellcheck="false" autocomplete="off"
           placeholder="Token (optional)" />
    <div class="xz-backend-error" role="alert"></div>
  `;
  const modeButtons = [...el.querySelectorAll("[data-mode]")];
  const urlInput = el.querySelector('[data-field="url"]');
  const tokenInput = el.querySelector('[data-field="token"]');
  const hintEl = el.querySelector(".xz-backend-hint");
  const errorEl = el.querySelector(".xz-backend-error");
  let mode = BackendMode.OTA;
  let onSubmit = null;

  const setMode = (next) => {
    mode = next === BackendMode.WS ? BackendMode.WS : BackendMode.OTA;
    modeButtons.forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("xz-active", on);
      b.setAttribute("aria-checked", String(on));
    });
    urlInput.placeholder = PLACEHOLDERS[mode];
    tokenInput.hidden = mode !== BackendMode.WS;
    hintEl.textContent = mode === BackendMode.OTA
      ? "The server's OTA endpoint provides the websocket address, and may ask to bind this device."
      : "Connect straight to a known websocket address.";
  };

  const showError = (msg) => {
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  };

  modeButtons.forEach((b) => b.addEventListener("click", () => { setMode(b.dataset.mode); showError(""); }));
  urlInput.addEventListener("input", () => {
    const guessed = inferBackendMode(urlInput.value.trim());
    if (guessed && guessed !== mode) setMode(guessed);
    showError("");
  });
  [urlInput, tokenInput].forEach((input) => input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && onSubmit) onSubmit();
  }));

  setMode(BackendMode.OTA);
  showError("");

  return {
    el,
    getValue() {
      return normalizeBackendConfig({ mode, url: urlInput.value, token: tokenInput.value });
    },
    setValue(cfg) {
      const c = normalizeBackendConfig(cfg || {});
      setMode(cfg ? c.mode : BackendMode.OTA);
      urlInput.value = c.url;
      tokenInput.value = c.token;
      showError("");
    },
    // Returns the config when valid; otherwise shows why and returns null.
    validate() {
      const cfg = this.getValue();
      const err = validateBackendConfig(cfg);
      showError(err);
      if (err) urlInput.focus();
      return err ? null : cfg;
    },
    showError,
    focus() { urlInput.focus(); },
    onSubmit(cb) { onSubmit = cb; }
  };
}

// Modal shown when no backend is configured, or when the saved one failed.
export function createBackendSetupDialog() {
  const overlay = document.createElement("div");
  overlay.className = "xz-overlay";
  overlay.style.display = "none";
  overlay.innerHTML = `
    <div class="xz-dialog xz-backend-dialog">
      <div class="xz-dialog-title">Connect to a backend</div>
      <div class="xz-dialog-msg"></div>
      <div class="xz-backend-slot"></div>
      <div class="xz-dialog-row">
        <button type="button" class="xz-btn xz-btn-primary" data-action="save">Save and connect</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const msgEl = overlay.querySelector(".xz-dialog-msg");
  const form = createBackendForm();
  overlay.querySelector(".xz-backend-slot").appendChild(form.el);
  const saveBtn = overlay.querySelector('[data-action="save"]');

  return {
    // Resolves with a validated { mode, url, token } once the operator saves.
    ask({ initial = null, message = "", error = "" } = {}) {
      msgEl.textContent = message || "No backend is configured yet. Choose how this client reaches the xiaozhi server.";
      form.setValue(initial);
      if (error) form.showError(error);
      overlay.style.display = "flex";
      setTimeout(() => form.focus(), 0);
      return new Promise((resolve) => {
        const submit = () => {
          const cfg = form.validate();
          if (!cfg) return;
          saveBtn.removeEventListener("click", submit);
          form.onSubmit(null);
          overlay.style.display = "none";
          resolve(cfg);
        };
        saveBtn.addEventListener("click", submit);
        form.onSubmit(submit);
      });
    }
  };
}
