import assert from "node:assert/strict";
import { WakeCoordinator } from "../wake-coordinator.mjs";
import { Conversation } from "../../conversation/conversation.mjs";
import { AbortReason, ListeningMode } from "../../protocol/message-types.mjs";

class FakeProvider {
  constructor() {
    this.handlers = new Set();
  }
  onWake(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async start() { return { running: true, mode: "sherpa" }; }
  async stop() { return { running: false, mode: "stopped" }; }
  emit(event) {
    for (const handler of this.handlers) handler(event);
  }
}

async function testCoordinatorSerializesWakeEvents() {
  const provider = new FakeProvider();
  const seen = [];
  const conversation = {
    async activateFromWake(event, options) {
      seen.push(event.word);
      await options.beforeListen(event);
    }
  };
  const coordinator = new WakeCoordinator({
    provider,
    conversation,
    beforeListen: async (event) => seen.push(`pause:${event.word}`)
  });
  await coordinator.start();
  provider.emit({ word: "Hey Blimp" });
  provider.emit({ word: "Hey Blimp" });
  await coordinator.activationQueue;
  assert.deepEqual(seen, [
    "Hey Blimp", "pause:Hey Blimp",
    "Hey Blimp", "pause:Hey Blimp"
  ]);
  await coordinator.stop();
}

async function testConversationWakeInterruptOrder() {
  const calls = [];
  const conversation = {
    protocol: { isOpen: () => true },
    _sendingFrames: true,
    capture: { _node: {} },
    _emitLog() {},
    dispatchEvent() {},
    _awaitGreeting() { return Promise.resolve(); },
    _resolveGreetingWait() {},
    async abort(reason) { calls.push(`abort:${reason}`); },
    async stopListening() { calls.push("stop-listening"); this._sendingFrames = false; },
    async connect() { calls.push("connect"); return true; },
    async sendText(text, opts) { calls.push(`detect:${text}${opts?.wake ? ":wake" : ""}`); return true; },
    async startListening(mode) { calls.push(`listen:${mode}`); return true; }
  };
  const result = await Conversation.prototype.activateFromWake.call(
    conversation,
    { word: "Hey Blimp" },
    { beforeListen: async () => calls.push("pause-media") }
  );
  assert.equal(result, true);
  assert.deepEqual(calls, [
    "pause-media",
    `abort:${AbortReason.WAKE_WORD_DETECTED}`,
    "stop-listening",
    "detect:Hey Blimp:wake",
    `listen:${ListeningMode.AUTO_STOP}`
  ]);
}

async function testSendTextReportsTransportFailure() {
  const logs = [];
  const conversation = {
    protocol: {
      isOpen: () => true,
      async sendDetectWord() { return false; }
    },
    _connectionState: {},
    _emitLog(level, message, detail) { logs.push({ level, message, detail }); }
  };

  const result = await Conversation.prototype.sendText.call(conversation, "Hey Blimp");
  assert.equal(result, false);
  assert.equal(logs.some((entry) => entry.message === "send text"), false);
  assert.equal(logs.at(-1).level, "error");
}

async function testEndSessionLifecycle() {
  const calls = [];
  const conversation = {
    _autoSessionActive: true,
    protocol: { isOpen: () => true },
    player: { clear: () => calls.push("clear-player") },
    mouth: { end: () => calls.push("mouth-end") },
    state: { setDevice: (state) => calls.push(`device:${state}`) },
    _emitLog() {},
    _endTtsMouth() { Conversation.prototype._endTtsMouth.call(this); },
    dispatchEvent(event) { calls.push(`event:${event.type}`); },
    async abort(reason) { calls.push(`abort:${reason}`); },
    async stopListening() { calls.push("stop-listening"); },
    async disconnect() { calls.push("disconnect"); }
  };

  const result = await Conversation.prototype.endSession.call(conversation);
  assert.equal(result, true);
  assert.equal(conversation._autoSessionActive, false);
  assert.deepEqual(calls, [
    `abort:${AbortReason.USER_INTERRUPTION}`,
    "stop-listening",
    "clear-player",
    "mouth-end",
    "device:idle",
    "disconnect",
    "event:session-ended",
    "event:xz-status"
  ]);
}

async function testRemoteDisconnectReturnsToWakeMode() {
  const calls = [];
  const conversation = {
    _disconnectRecovery: null,
    _autoSessionActive: true,
    _sendingFrames: true,
    player: { clear: () => calls.push("clear-player") },
    mouth: { end: () => calls.push("mouth-end") },
    state: { setDevice: (state) => calls.push(`device:${state}`) },
    async stopListening() { calls.push("stop-listening"); },
    _emitLog(level, message) { calls.push(`log:${level}:${message}`); },
    _endTtsMouth() { Conversation.prototype._endTtsMouth.call(this); },
    dispatchEvent(event) { calls.push(`event:${event.type}`); }
  };

  const result = await Conversation.prototype._recoverFromRemoteDisconnect.call(
    conversation,
    { code: 1000, reason: "session timeout" }
  );

  assert.equal(result, true);
  assert.equal(conversation._autoSessionActive, false);
  assert.equal(conversation._sendingFrames, false);
  assert.deepEqual(calls, [
    "stop-listening",
    "clear-player",
    "mouth-end",
    "device:idle",
    "log:warn:remote session ended; returning to wake-word mode",
    "event:session-ended",
    "event:xz-status"
  ]);
}

await testCoordinatorSerializesWakeEvents();
await testConversationWakeInterruptOrder();
await testSendTextReportsTransportFailure();
await testEndSessionLifecycle();
await testRemoteDisconnectReturnsToWakeMode();
console.log("wake coordinator tests: ok");
