import { WebAudioWakeProvider } from "./web-audio-wake-provider.mjs";

class NativeWakeProvider {
  constructor(bridge) {
    this.bridge = bridge;
    this.handlers = new Set();
    this.unsubscribe = null;
  }

  onWake(handler) {
    if (typeof handler === "function") this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start() {
    if (!this.unsubscribe && typeof this.bridge.onWake === "function") {
      const unsubscribe = this.bridge.onWake((event) => {
        // Native Android KWS owns AudioRecord. Release it before the WebView
        // starts conversation capture, then re-arm it when the session ends.
        Promise.resolve(this.bridge.stop?.()).catch(() => {});
        for (const handler of this.handlers) handler(event || { word: "Hey Blimp" });
      });
      this.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;
    }
    return this.bridge.start();
  }

  async stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    return this.bridge.stop();
  }
}

export function createWakeProvider({ hostServiceUrl, audioCapture, nativeBridge } = {}) {
  const bridge = nativeBridge || globalThis.nativeWakeWord;
  if (bridge && typeof bridge.start === "function" && typeof bridge.onWake === "function") {
    return new NativeWakeProvider(bridge);
  }
  if (audioCapture) {
    return new WebAudioWakeProvider({ hostServiceUrl, audioCapture });
  }
  throw new Error("Wake-word provider requires Web Audio or a native bridge");
}

export class WakeCoordinator extends EventTarget {
  constructor({ provider, conversation, beforeListen } = {}) {
    super();
    if (!provider) throw new Error("WakeCoordinator requires a provider");
    if (!conversation || typeof conversation.activateFromWake !== "function") {
      throw new Error("WakeCoordinator requires a wake-capable conversation");
    }
    this.provider = provider;
    this.conversation = conversation;
    this.beforeListen = typeof beforeListen === "function" ? beforeListen : null;
    this.running = false;
    this.unsubscribe = null;
    this.activationQueue = Promise.resolve();
  }

  /** Start a conversation as if the wake word was heard (also used by the portal). */
  activate(event = {}) {
    this.activationQueue = this.activationQueue
      .catch(() => {})
      .then(() => this.conversation.activateFromWake(event, {
        beforeListen: this.beforeListen
      }));
    return this.activationQueue;
  }

  async start() {
    if (this.running) return this.provider.getStatus?.() || { running: true };
    if (!this.unsubscribe) {
      this.unsubscribe = this.provider.onWake((event) => this.activate(event));
    }
    const status = await this.provider.start();
    this.running = status?.running !== false;
    this.dispatchEvent(new CustomEvent("status", { detail: status || { running: this.running } }));
    return status;
  }

  async stop() {
    this.running = false;
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    const status = await this.provider.stop?.();
    this.dispatchEvent(new CustomEvent("status", { detail: status || { running: false } }));
    return status;
  }
}
