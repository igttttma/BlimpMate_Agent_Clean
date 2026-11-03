import assert from "node:assert/strict";
import { NativeMicCapture } from "../native-mic-capture.mjs";

const calls = [];
let pcmHandler = null;
const bridge = {
  onPcm(cb) { pcmHandler = cb; return () => { pcmHandler = null; }; },
  startStream() { calls.push("start"); return { running: true }; },
  stopStream() { calls.push("stop"); return {}; },
  releaseMic() { calls.push("release"); return {}; },
  getStatus() { return { running: true, streaming: true }; }
};

assert.equal(NativeMicCapture.isSupported(bridge), true);
assert.equal(NativeMicCapture.isSupported({ start() {} }), false);

const capture = new NativeMicCapture({ bridge });
assert.deepEqual(calls, ["stop"], "a stream left by a previous page is stopped");
const frames = [];
capture.onFrame((f) => frames.push(f));

// Audio before start is dropped
pcmHandler(new Float32Array(1280));
assert.equal(frames.length, 0);

await capture.start("conversation");
assert.equal(capture.isOpen, true);
assert.equal(capture.echoCancelled, true, "hardware AEC: the mic stays live while the Blimp speaks");

// 80 ms chunk -> four 20 ms frames; a partial chunk carries over
pcmHandler(Float32Array.from({ length: 1280 }, (_, i) => i));
assert.equal(frames.length, 4);
assert.equal(frames[0].length, 320);
assert.equal(frames[3][319], 1279);
pcmHandler(new Float32Array(200));
assert.equal(frames.length, 4);
pcmHandler(new Float32Array(120));
assert.equal(frames.length, 5);

// Already open: still asks the native side (it may have stopped underneath)
await capture.start("conversation");
await capture.stop("conversation");
assert.equal(capture.isOpen, false);
pcmHandler(new Float32Array(1280));
assert.equal(frames.length, 5, "no frames after stop");

capture.release();
assert.deepEqual(calls, ["stop", "start", "start", "stop", "release"]);

// Watchdog: no audio while open -> asks for the stream again and reports it
NativeMicCapture.STALL_MS = 50;
const stalls = [];
calls.length = 0;
const watched = new NativeMicCapture({ bridge, onStall: (info) => stalls.push(info) });
await watched.start("conversation");
await new Promise((r) => setTimeout(r, 650));
assert.ok(stalls.length >= 1, "a stalled stream is reported");
assert.ok(calls.filter((c) => c === "start").length >= 2, "and restarted");
await watched.stop("conversation");
const after = stalls.length;
await new Promise((r) => setTimeout(r, 650));
assert.equal(stalls.length, after, "no watchdog after stop");

// A bridge that can't record makes start() fail and leaves it closed
const broken = new NativeMicCapture({ bridge: { ...bridge, startStream: () => ({ running: false, message: "microphone_permission_required" }) } });
await assert.rejects(broken.start("conversation"), /microphone_permission_required/);
assert.equal(broken.isOpen, false);

console.log("native mic capture test: ok");
