import assert from "node:assert/strict";
import { AudioCapture } from "../audio-capture.mjs";

let getUserMediaCalls = 0;
let trackStops = 0;
let resolveMedia;

const stream = {
  getTracks: () => [{ stop: () => { trackStops += 1; } }]
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: () => {
        getUserMediaCalls += 1;
        return new Promise((resolve) => { resolveMedia = () => resolve(stream); });
      }
    }
  }
});

class FakeNode {
  constructor() { this.port = {}; }
  connect(target) { return target; }
  disconnect() {}
}

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
  }
  createMediaStreamSource() { return new FakeNode(); }
  createGain() {
    const node = new FakeNode();
    node.gain = { value: 1 };
    return node;
  }
  async close() {}
}

globalThis.AudioContext = FakeAudioContext;
globalThis.AudioWorkletNode = FakeNode;

const capture = new AudioCapture({ workletUrl: "capture-worklet.mjs" });
const wakeStart = capture.start("wake-word");
const conversationStart = capture.start("conversation");

assert.equal(getUserMediaCalls, 1, "concurrent owners must share one getUserMedia request");
resolveMedia();
await Promise.all([wakeStart, conversationStart]);

await capture.stop("conversation");
assert.equal(trackStops, 0, "the wake owner must keep the shared microphone alive");
await capture.stop("wake-word");
assert.equal(trackStops, 1, "the last owner must release the microphone");

console.log("audio capture ownership test: ok");
