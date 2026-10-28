// The "Maximum volume" setting of the Android app: media + call volume to max at
// start and when the mic opens (CallModeVolume.java keeps it). Set from the Chat
// panel or the server portal; "change" tells the other one.

class MaxVolume extends EventTarget {
  get #bridge() {
    return globalThis.__nativeVolumeRaw;
  }

  /** Only the Android app has it. */
  get available() {
    return !!this.#bridge;
  }

  /** true | false, or null where there's no such setting. */
  get value() {
    return this.available ? !!this.#bridge.getMaxVolume() : null;
  }

  set(on) {
    if (!this.available) return false;
    this.#bridge.setMaxVolume(!!on);
    this.dispatchEvent(new CustomEvent("change", { detail: !!on }));
    return true;
  }
}

export const maxVolume = new MaxVolume();
