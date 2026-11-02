// Live camera view for the stream server's /camera page. The Android app
// streams the camera natively (CameraView.java: Camera2 -> hardware H.264 ->
// its own connection to the stream server), only while someone watches.
//
// The view is the camera's lowest-priority user. Everything else on the page
// that opens the camera (the AI's photo tool, video calls) wraps it in hold():
// the view closes the camera first and opens it again after release(), and the
// watchers see "paused" meanwhile. Elsewhere (desktop) this is a no-op.
import { BLIMP_PASSWORD } from "./call-config.mjs";

const bridge = () => globalThis.__nativeCameraViewRaw || null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const cameraView = {
  /** Only the Android app has it. */
  get available() {
    return !!bridge();
  },

  /** The stream server ({ url }, as for calls); an empty url turns the view off. */
  configure(cfg) {
    bridge()?.configure(cfg?.url || "", BLIMP_PASSWORD);
  },

  /**
   * Takes the camera from the view (reason: photo | call) and waits until it
   * is closed. Returns an id for release().
   */
  async hold(reason) {
    const b = bridge();
    if (!b) return null;
    const id = b.hold(reason);
    const deadline = Date.now() + Number(b.closeTimeoutMs?.() || 3000);
    while (!b.isFree() && Date.now() < deadline) await sleep(30);
    return id;
  },

  release(id) {
    if (id) bridge()?.release(id);
  },

  /** Runs fn with the camera taken from the view, then gives it back. */
  async withCamera(reason, fn) {
    const id = await this.hold(reason);
    try {
      return await fn();
    } finally {
      this.release(id);
    }
  },

  get status() {
    try {
      return JSON.parse(bridge()?.getStatus() || "null");
    } catch {
      return null;
    }
  }
};
