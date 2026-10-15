import { DeviceState, ListeningMode } from "../protocol/message-types.mjs";

export class StateManager extends EventTarget {
  constructor() {
    super();
    this._device = DeviceState.IDLE;
    this._mode = ListeningMode.MANUAL;
    this._aborted = false;
    this._connected = false;
  }

  get device() { return this._device; }
  get mode() { return this._mode; }
  get connected() { return this._connected; }

  setDevice(s) {
    if (this._device === s) return;
    const old = this._device;
    this._device = s;
    if (s === DeviceState.LISTENING) this._aborted = false;
    this.dispatchEvent(new CustomEvent("device", { detail: { old, new: s } }));
  }

  setMode(m) {
    if (this._mode === m) return;
    this._mode = m;
    this.dispatchEvent(new CustomEvent("mode", { detail: m }));
  }

  setConnected(v, reason = "") {
    if (this._connected === v) return;
    this._connected = v;
    this.dispatchEvent(new CustomEvent("connected", { detail: { connected: v, reason } }));
  }

  setAborted(v) { this._aborted = v; }
  get aborted() { return this._aborted; }
}
