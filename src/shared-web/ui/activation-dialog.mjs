// The binding page comes from the server; there is no built-in default.
const withScheme = (u) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`);

export function createActivationDialog() {
  const overlay = document.createElement("div");
  overlay.className = "xz-overlay";
  overlay.innerHTML = `
    <div class="xz-dialog">
      <div class="xz-dialog-title">Device activation</div>
      <div class="xz-dialog-msg" id="xzActivationMsg">Waiting for the server...</div>
      <div class="xz-dialog-url-row" id="xzActivationUrlRow" style="display:none">
        <span id="xzActivationUrl"></span>
        <button type="button" class="xz-btn xz-btn-sm" id="xzCopyUrlBtn">Copy link</button>
      </div>
      <div class="xz-dialog-code" id="xzActivationCode"></div>
      <div class="xz-dialog-hint">Enter this code in your server's device console to finish pairing.<br/>This dialog closes after activation succeeds.</div>
      <div class="xz-dialog-progress" id="xzActivationProgress"></div>
      <div class="xz-dialog-error" id="xzActivationError" style="display:none;color:#f87171;font-size:13px;margin-top:6px"></div>
      <div class="xz-dialog-row">
        <button type="button" class="xz-btn xz-btn-primary" id="xzActivationDone">I have activated</button>
        <button type="button" class="xz-btn" id="xzActivationRetry" style="display:none">Retry</button>
        <button type="button" class="xz-btn" id="xzActivationCancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const codeEl = overlay.querySelector("#xzActivationCode");
  const msgEl = overlay.querySelector("#xzActivationMsg");
  const progressEl = overlay.querySelector("#xzActivationProgress");
  const errorEl = overlay.querySelector("#xzActivationError");
  const urlRow = overlay.querySelector("#xzActivationUrlRow");
  const urlEl = overlay.querySelector("#xzActivationUrl");
  const copyUrlBtn = overlay.querySelector("#xzCopyUrlBtn");
  const doneBtn = overlay.querySelector("#xzActivationDone");
  const retryBtn = overlay.querySelector("#xzActivationRetry");
  const cancelBtn = overlay.querySelector("#xzActivationCancel");

  let onCancel = null;
  let onDone = null;
  let onRetry = null;
  let verificationUrl = null;

  copyUrlBtn.addEventListener("click", () => {
    if (!verificationUrl) return;
    const url = withScheme(verificationUrl);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        copyUrlBtn.textContent = "Copied";
        setTimeout(() => { copyUrlBtn.textContent = "Copy link"; }, 1500);
      }).catch(() => {});
    }
  });

  doneBtn.addEventListener("click", () => { if (onDone) onDone(); });
  cancelBtn.addEventListener("click", () => { if (onCancel) onCancel(); });
  retryBtn.addEventListener("click", () => {
    errorEl.style.display = "none";
    retryBtn.style.display = "none";
    progressEl.textContent = "Retrying...";
    if (onRetry) onRetry();
  });

  function dispatchStatus(type, detail) {
    if (typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent("xz-activation-status", { detail: { type, ...detail } }));
    }
  }

  return {
    show(activation) {
      verificationUrl = activation.url || activation.verification_url || null;
      msgEl.textContent = activation.message || "Follow the instructions to activate";
      codeEl.textContent = activation.code || "------";
      urlEl.textContent = verificationUrl ? withScheme(verificationUrl) : "";
      urlRow.style.display = verificationUrl ? "flex" : "none";
      progressEl.textContent = "Waiting for activation...";
      errorEl.style.display = "none";
      retryBtn.style.display = "none";
      overlay.style.display = "flex";
      dispatchStatus("shown", { code: activation.code, url: verificationUrl });
    },
    updateProgress(attempt) {
      progressEl.textContent = `Waiting for activation (check ${attempt})...`;
      dispatchStatus("polling", { attempt });
    },
    showError(message) {
      errorEl.textContent = message || "Activation failed. Try again.";
      errorEl.style.display = "block";
      retryBtn.style.display = "";
      progressEl.textContent = "";
      dispatchStatus("error", { message });
    },
    hide() {
      overlay.style.display = "none";
      dispatchStatus("hidden", {});
    },
    onCancel(cb) { onCancel = cb; },
    onDone(cb) { onDone = cb; },
    onRetry(cb) { onRetry = cb; }
  };
}
