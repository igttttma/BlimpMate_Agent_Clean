import assert from "node:assert/strict";
import { ReadyKeeper } from "../ready-keeper.mjs";
import { Conversation } from "../conversation.mjs";
import { DeviceState, ListeningMode } from "../../protocol/message-types.mjs";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeConversation({ open = false, connectOk = true } = {}) {
  const conv = new EventTarget();
  conv.state = new EventTarget();
  conv.idle = true;
  conv.connects = 0;
  conv.protocol = { isOpen: () => open };
  conv.connect = async () => {
    conv.connects++;
    if (connectOk) open = true;
    return connectOk;
  };
  return conv;
}

function fakeWake({ running = true, status = { running: true, message: "listening" } } = {}) {
  const wake = {
    running,
    starts: 0,
    providerStarts: 0,
    async start() { wake.starts++; wake.running = true; },
    provider: {
      getStatus: () => status,
      async start() { wake.providerStarts++; }
    },
    setStatus(next) { status = next; }
  };
  return wake;
}

function keeper(conv, wake, { busy = false } = {}) {
  const k = new ReadyKeeper({ conversation: conv, getWakeCoordinator: () => wake, isBusy: () => busy });
  return k;
}

async function testConnectsWhenIdle() {
  const conv = fakeConversation();
  const wake = fakeWake();
  const k = keeper(conv, wake);
  k.check();
  await tick();
  assert.equal(conv.connects, 1);
  k.check();
  await tick();
  assert.equal(conv.connects, 1, "already connected: no second connect");
}

async function testLeavesBusyAndConversationsAlone() {
  const conv = fakeConversation();
  const wake = fakeWake({ running: false });
  const busy = keeper(conv, wake, { busy: true });
  busy.check();
  await tick();
  assert.equal(conv.connects, 0, "a video call owns the link");
  assert.equal(wake.starts, 0, "a video call owns the mic");

  conv.idle = false;
  const k = keeper(conv, wake);
  k.check();
  await tick();
  assert.equal(conv.connects, 0, "a conversation owns the link");
  assert.equal(wake.starts, 0, "a conversation owns the mic");
}

async function testBacksOffWhileUnreachable() {
  const conv = fakeConversation({ connectOk: false });
  const k = keeper(conv, fakeWake());
  k.check();
  await tick();
  assert.equal(conv.connects, 1);
  k.check();
  await tick();
  assert.equal(conv.connects, 1, "waits out the backoff");
  k._nextConnectAt = 0;
  k.check();
  await tick();
  assert.equal(conv.connects, 2);
  assert.equal(k._retryMs, 8000, "2 s, then 4 s, then 8 s");
}

async function testRearmsWakeWord() {
  const conv = fakeConversation({ open: true });
  const off = fakeWake({ running: false });
  keeper(conv, off).check();
  await tick();
  assert.equal(off.starts, 1, "coordinator was stopped");

  const stopped = fakeWake({ status: { running: false, message: "stopped" } });
  keeper(conv, stopped).check();
  await tick();
  assert.equal(stopped.providerStarts, 1, "detector stopped after a hit and never re-armed");

  for (const message of ["starting", "AudioRecord read failed: -6"]) {
    const wake = fakeWake({ status: { running: false, message } });
    keeper(conv, wake).check();
    await tick();
    assert.equal(wake.providerStarts, 0, `left alone while ${message}`);
  }
}

// Portal Save: the open link has the old settings; reconnect once idle, not mid-conversation
async function testReconnectsStaleLinkWhenIdle() {
  let open = true;
  const conv = fakeConversation({ open: true });
  conv.protocol = { isOpen: () => open };
  conv.connect = async () => { conv.connects++; open = true; conv._linkStale = false; return true; };
  conv.disconnect = async () => { conv.disconnects = (conv.disconnects || 0) + 1; open = false; };
  conv._linkStale = true;
  conv.idle = false;
  const k = keeper(conv, fakeWake());
  k.check();
  await tick();
  assert.equal(conv.disconnects, undefined, "a conversation keeps its link");
  conv.idle = true;
  k.check();
  await tick();
  assert.equal(conv.disconnects, 1);
  assert.equal(conv.connects, 1);
  assert.equal(conv._linkStale, false);
}

// The server closes the link right as a reply ends: the reply's "listen again"
// must not reopen the microphone after the close stopped listening
async function testLateStartListeningGivesUp() {
  let releaseCapture;
  const captureStarted = new Promise((resolve) => { releaseCapture = resolve; });
  const calls = [];
  const conv = {
    _listenGen: 0,
    _sendingFrames: false,
    _autoSessionActive: false,
    protocol: { isOpen: () => true, sendStartListening: () => calls.push("listen-start") },
    state: { device: DeviceState.IDLE, setMode() {}, setDevice(d) { this.device = d; } },
    vad: { reset() {} },
    _emitLog() {},
    async _ensureEncoder() {},
    capture: {
      async start() { calls.push("capture-start"); await captureStarted; },
      async stop() { calls.push("capture-stop"); }
    }
  };
  const starting = Conversation.prototype.startListening.call(conv, ListeningMode.AUTO_STOP);
  await tick();
  // The close: what stopListening() does
  conv._listenGen++;
  conv._sendingFrames = false;
  releaseCapture();
  assert.equal(await starting, false);
  assert.equal(conv._sendingFrames, false);
  assert.equal(conv._autoSessionActive, false);
  assert.deepEqual(calls, ["capture-start", "capture-stop"]);
}

await testConnectsWhenIdle();
await testLeavesBusyAndConversationsAlone();
await testBacksOffWhileUnreachable();
await testRearmsWakeWord();
await testReconnectsStaleLinkWhenIdle();
await testLateStartListeningGivesUp();
console.log("ready keeper tests: ok");
