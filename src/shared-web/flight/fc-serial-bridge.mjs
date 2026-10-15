// Source of truth: src/shared-web/flight/fc-serial-bridge.mjs
// Gradle syncSharedWeb copies src/shared-web/ -> Android assets/app/, so on
// device this loads as assets/app/flight/fc-serial-bridge.mjs (import it from a
// page under assets/app/ as "./flight/fc-serial-bridge.mjs"). Do NOT author the
// copy under assets/ directly — assets/ is gitignored and rebuilt every build.
export const MSP_API_VERSION = 1;
export const MSP_STATUS = 101;
export const MSP_RAW_IMU = 102;
export const MSP_ANALOG = 110;
export const MSP_SET_RAW_RC = 200;
export const MSP_REQUEST_PREAMBLE = "$M<";

export const DEFAULT_ALLOWED_MSP_COMMANDS = Object.freeze([
  MSP_SET_RAW_RC,
  MSP_API_VERSION,
  MSP_STATUS,
  MSP_RAW_IMU,
  MSP_ANALOG
]);

const MSP_PREAMBLE = Object.freeze([0x24, 0x4d, 0x3c]); // "$M<"
const DEFAULT_DEADLINE_MS = 200;
const DEFAULT_RC_MIN = 1000;
const DEFAULT_RC_MAX = 2000;
const DEFAULT_RC_NEUTRAL = 1500;
const DEFAULT_RC_CHANNELS = 8;
const DEFAULT_ARM_CHANNEL_INDEX = 4; // AUX1 in the default 8-channel map.
const DEFAULT_DISARM_VALUE = 1000;
const MAX_RC_CHANNELS = 18;
const TELEMETRY_REQUEST_COMMANDS = new Set([
  MSP_API_VERSION,
  MSP_STATUS,
  MSP_RAW_IMU,
  MSP_ANALOG
]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function clampByte(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new RangeError(`${name} must be an integer byte: ${value}`);
  }
  return n;
}

function clampUint16(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite: ${value}`);
  const i = Math.trunc(n);
  if (i < 0 || i > 0xffff) throw new RangeError(`${name} must be uint16: ${value}`);
  return i;
}

function utf8Bytes(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "utf8"));
  throw new Error("TextEncoder is not available in this environment");
}

function bytesToBase64(bytes) {
  const data = toUint8Array(bytes);
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  throw new Error("no base64 encoder is available in this environment");
}

function base64ToBytes(value) {
  const text = String(value).trim();
  if (text.length === 0) return new Uint8Array();
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  if (typeof atob === "function") {
    const binary = atob(text + pad);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;
    return out;
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text + pad, "base64"));
  throw new Error("no base64 decoder is available in this environment");
}

function looksLikeBase64(value) {
  const text = String(value).trim();
  return text.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (Array.isArray(value)) return new Uint8Array(value.map((v) => clampByte("byte", v)));
  throw new TypeError("expected bytes as Uint8Array, ArrayBuffer, TypedArray, or byte array");
}

function normalizeFrameBytes(envelope) {
  if (!envelope || typeof envelope !== "object") throw new TypeError("envelope must be an object");
  if (envelope.mspFrameB64 !== undefined) return base64ToBytes(envelope.mspFrameB64);
  if (envelope.mspFrameBase64 !== undefined) return base64ToBytes(envelope.mspFrameBase64);
  if (envelope.mspFrame === undefined) throw new TypeError("envelope.mspFrame is required");
  if (typeof envelope.mspFrame === "string") {
    if (looksLikeBase64(envelope.mspFrame)) {
      try {
        return base64ToBytes(envelope.mspFrame);
      } catch {
        return utf8Bytes(envelope.mspFrame);
      }
    }
    return utf8Bytes(envelope.mspFrame);
  }
  return toUint8Array(envelope.mspFrame);
}

function checksum(size, cmd, payload) {
  let out = (size ^ cmd) & 0xff;
  for (const byte of payload) out = (out ^ byte) & 0xff;
  return out;
}

export function encodeMspRequest(cmd, payload = new Uint8Array()) {
  const data = toUint8Array(payload);
  const size = clampByte("payload size", data.length);
  const command = clampByte("cmd", cmd);
  const out = new Uint8Array(6 + data.length);
  out[0] = MSP_PREAMBLE[0];
  out[1] = MSP_PREAMBLE[1];
  out[2] = MSP_PREAMBLE[2];
  out[3] = size;
  out[4] = command;
  out.set(data, 5);
  out[5 + data.length] = checksum(size, command, data);
  return out;
}

export function parseMspRequest(frameBytes) {
  const frame = toUint8Array(frameBytes);
  if (frame.length < 3 || frame[0] !== MSP_PREAMBLE[0] || frame[1] !== MSP_PREAMBLE[1]) {
    return { ok: false, reason: "non_msp" };
  }
  if (frame[2] !== MSP_PREAMBLE[2]) {
    return { ok: false, reason: "invalid_direction" };
  }
  if (frame.length < 6) return { ok: false, reason: "short_frame" };
  const size = frame[3];
  const total = 6 + size;
  if (frame.length < total) return { ok: false, reason: "truncated" };
  if (frame.length > total) return { ok: false, reason: "extra_bytes" };
  const cmd = frame[4];
  const payload = frame.slice(5, 5 + size);
  const expected = checksum(size, cmd, payload);
  const actual = frame[5 + size];
  if (actual !== expected) {
    return { ok: false, reason: "bad_checksum", cmd, expected, actual };
  }
  return { ok: true, cmd, payload, frame };
}

export function decodeRawRcPayload(payload) {
  const data = toUint8Array(payload);
  if (data.length === 0 || data.length % 2 !== 0 || data.length / 2 > MAX_RC_CHANNELS) {
    return { ok: false, reason: "invalid_rc_payload" };
  }
  const channels = [];
  for (let i = 0; i < data.length; i += 2) {
    channels.push(data[i] | (data[i + 1] << 8));
  }
  return { ok: true, channels };
}

function encodeRawRcPayload(channels, rcMin, rcMax) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > MAX_RC_CHANNELS) {
    throw new RangeError(`MSP_SET_RAW_RC requires 1..${MAX_RC_CHANNELS} channels`);
  }
  const out = new Uint8Array(channels.length * 2);
  for (let i = 0; i < channels.length; i += 1) {
    const clamped = clampChannel(channels[i], rcMin, rcMax);
    out[i * 2] = clamped & 0xff;
    out[i * 2 + 1] = (clamped >> 8) & 0xff;
  }
  return out;
}

export function encodeRawRcRequest(channels, options = {}) {
  const rcMin = clampUint16("rcMin", options.rcMin ?? DEFAULT_RC_MIN);
  const rcMax = clampUint16("rcMax", options.rcMax ?? DEFAULT_RC_MAX);
  if (rcMin > rcMax) throw new RangeError("rcMin must be <= rcMax");
  return encodeMspRequest(MSP_SET_RAW_RC, encodeRawRcPayload(channels, rcMin, rcMax));
}

function clampChannel(value, rcMin, rcMax) {
  const n = clampUint16("channel", value);
  if (n < rcMin) return rcMin;
  if (n > rcMax) return rcMax;
  return n;
}

function makeCounter() {
  return Object.create(null);
}

function bump(counter, reason) {
  counter[reason] = (counter[reason] || 0) + 1;
}

function copyCounter(counter) {
  return Object.assign({}, counter);
}

function normalizeSequence(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeAllowedCommands(value) {
  const commands = value === undefined ? DEFAULT_ALLOWED_MSP_COMMANDS : value;
  const out = new Set();
  for (const cmd of commands) out.add(clampByte("allowed MSP cmd", cmd));
  return out;
}

function buildFailsafeFrame(config) {
  let channels;
  if (config.failsafeChannels !== undefined) {
    channels = Array.from(config.failsafeChannels);
  } else {
    channels = Array.from({ length: config.channelCount }, () => config.neutral);
  }
  if (channels.length < 1 || channels.length > MAX_RC_CHANNELS) {
    throw new RangeError(`failsafe channel count must be 1..${MAX_RC_CHANNELS}`);
  }
  if (config.armChannelIndex < 0 || config.armChannelIndex >= channels.length) {
    throw new RangeError("armChannelIndex must point to a failsafe channel");
  }
  channels[config.armChannelIndex] = config.disarmValue;
  return encodeRawRcRequest(channels, { rcMin: config.rcMin, rcMax: config.rcMax });
}

function normalizeConfig(options) {
  const rcMin = clampUint16("rcMin", options.rcMin ?? DEFAULT_RC_MIN);
  const rcMax = clampUint16("rcMax", options.rcMax ?? DEFAULT_RC_MAX);
  if (rcMin > rcMax) throw new RangeError("rcMin must be <= rcMax");
  const neutral = clampChannel(options.neutral ?? DEFAULT_RC_NEUTRAL, rcMin, rcMax);
  const disarmValue = clampChannel(options.disarmValue ?? DEFAULT_DISARM_VALUE, rcMin, rcMax);
  const channelCount = Number(options.channelCount ?? DEFAULT_RC_CHANNELS);
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_RC_CHANNELS) {
    throw new RangeError(`channelCount must be 1..${MAX_RC_CHANNELS}`);
  }
  const armChannelIndex = Number(options.armChannelIndex ?? DEFAULT_ARM_CHANNEL_INDEX);
  if (!Number.isInteger(armChannelIndex)) throw new RangeError("armChannelIndex must be an integer");
  const deadlineMs = Number(options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) throw new RangeError("deadlineMs must be a non-negative number");
  // Absolute on-arrival age limit: a control envelope whose own timestamp is
  // already older than this (relative to now()) is rejected outright, so a
  // queued/delayed command cannot reassert thrust after a link stall. Defaults
  // to the freshness deadline; requires a monotonic shared PC/bridge clock.
  const maxAgeMs = Number(options.maxControlAgeMs ?? deadlineMs);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new RangeError("maxControlAgeMs must be a non-negative number");
  return {
    deadlineMs,
    maxAgeMs,
    rcMin,
    rcMax,
    neutral,
    disarmValue,
    channelCount,
    armChannelIndex,
    failsafeChannels: options.failsafeChannels,
    allowedCommands: normalizeAllowedCommands(options.allowedCommands)
  };
}

function isDisarmedRcChannels(channels, config) {
  // A recovery control frame must explicitly carry the arm channel at (or below)
  // the disarmed value — proving the operator/PC has commanded disarm — before
  // the bridge will leave failsafe silence and forward armed setpoints again.
  if (!Array.isArray(channels)) return false;
  const arm = channels[config.armChannelIndex];
  return typeof arm === "number" && arm <= config.disarmValue;
}

function validateTransport(transport) {
  if (!transport || typeof transport.write !== "function") {
    throw new TypeError("createFcSerialBridge requires transport.write(bytes)");
  }
}

function transportWrite(transport, frame) {
  const result = transport.write(new Uint8Array(frame));
  if (result === false) throw new Error("transport.write returned false");
}

function validateForForwarding(parsed, config) {
  if (!config.allowedCommands.has(parsed.cmd)) {
    return { ok: false, reason: "command_not_whitelisted" };
  }
  if (parsed.cmd === MSP_SET_RAW_RC) {
    const decoded = decodeRawRcPayload(parsed.payload);
    if (!decoded.ok) return decoded;
    // Enforce the configured channel count exactly: a short/partial RC frame
    // (e.g. 1 or 4 channels under an 8-channel map) is syntactically valid MSP
    // but does not carry this bridge's control map and could leave the arm /
    // axis channels undefined at the FC. Reject it rather than forward it.
    if (decoded.channels.length !== config.channelCount) {
      return { ok: false, reason: "rc_channel_count_mismatch" };
    }
    return {
      ok: true,
      cmd: parsed.cmd,
      channels: decoded.channels,
      frame: encodeRawRcRequest(decoded.channels, { rcMin: config.rcMin, rcMax: config.rcMax })
    };
  }
  // The ONLY non-RC commands that may forward are the explicit telemetry
  // requests, and only with an empty payload. Anything else that happens to be
  // in a custom allowedCommands set is rejected here — no arbitrary-payload
  // passthrough is ever permitted (defends against a misconfigured whitelist).
  if (!TELEMETRY_REQUEST_COMMANDS.has(parsed.cmd)) {
    return { ok: false, reason: "command_not_forwardable" };
  }
  if (parsed.payload.length !== 0) {
    return { ok: false, reason: "unexpected_payload" };
  }
  return { ok: true, cmd: parsed.cmd, frame: parsed.frame };
}

export function createAndroidFcSerialTransport(nativeSerial) {
  const native = nativeSerial || globalThis.window?.__nativeFcSerialBridgeRaw || globalThis.window?.__nativeFcSerialBridge;
  if (!native) throw new Error("Android FcSerialBridge native interface is not installed");

  function lastError() {
    try {
      return typeof native.getLastError === "function" ? native.getLastError() : "";
    } catch {
      return "";
    }
  }

  return {
    open(path = "/dev/ttyAS2", baud = 115200) {
      if (typeof native.open !== "function") throw new Error("native FcSerialBridge.open is unavailable");
      const ok = native.open(String(path), Number(baud));
      if (!ok) throw new Error(lastError() || "native FcSerialBridge.open failed");
      return true;
    },
    write(bytes) {
      if (typeof native.write !== "function") throw new Error("native FcSerialBridge.write is unavailable");
      const ok = native.write(bytesToBase64(bytes));
      if (!ok) throw new Error(lastError() || "native FcSerialBridge.write failed");
      return true;
    },
    close() {
      if (typeof native.close !== "function") return false;
      return !!native.close();
    }
  };
}

/**
 * Android Phase-D page seam:
 *
 *   import { createAndroidFcSerialTransport, createFcSerialBridge } from "./flight/fc-serial-bridge.mjs";
 *
 *   window.nativeFcSerial = createAndroidFcSerialTransport(window.__nativeFcSerialBridgeRaw);
 *   const fcBridge = createFcSerialBridge({
 *     transport: window.nativeFcSerial,
 *     now: () => performance.now(),
 *     onStatus: (status) => window.nativeWs?.send?.(JSON.stringify({ type: "fc_serial_status", status }))
 *   });
 *   setInterval(() => fcBridge.tick(), 25);
 *
 * The Java side invokes window.__nativeFcSerialBridgeOnBytes(base64) for bytes
 * read from the FC once the real /dev/ttyAS2 UART open is added in Phase-D.
 */
export function createFcSerialBridge(options = {}) {
  const { transport, now = () => Date.now(), onStatus = null } = options;
  validateTransport(transport);
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (onStatus !== null && typeof onStatus !== "function") throw new TypeError("onStatus must be a function");

  const config = normalizeConfig(options);
  const failsafeFrame = buildFailsafeFrame(config);
  const rejectedByReason = makeCounter();
  const droppedByReason = makeCounter();

  let accepted = 0;
  let rejected = 0;
  let dropped = 0;
  let failsafeFired = 0;
  let lastSeq = null;
  let lastTsMs = null;
  let lastControlAtMs = null; // freshness clock: ONLY MSP_SET_RAW_RC updates this
  let lastForwardedCmd = null;
  let silent = false;

  function getStatus() {
    return {
      accepted,
      rejected,
      dropped,
      failsafeFired,
      rejectedByReason: copyCounter(rejectedByReason),
      droppedByReason: copyCounter(droppedByReason),
      lastSeq,
      lastTsMs,
      lastControlAtMs,
      lastForwardedCmd,
      silent,
      deadlineMs: config.deadlineMs
    };
  }

  function emitStatus(event) {
    if (!onStatus) return;
    try {
      onStatus(Object.assign({ event }, getStatus()));
    } catch {}
  }

  function reject(reason, detail = undefined) {
    rejected += 1;
    bump(rejectedByReason, reason);
    emitStatus(`rejected:${reason}`);
    return { ok: false, action: "rejected", reason, detail };
  }

  function drop(reason) {
    dropped += 1;
    bump(droppedByReason, reason);
    emitStatus(`dropped:${reason}`);
    return { ok: false, action: "dropped", reason };
  }

  function orderingDrop(seq, tsMs) {
    if (lastSeq !== null && seq === lastSeq) return "duplicate";
    if (lastSeq !== null && seq < lastSeq) return "out_of_order";
    if (lastTsMs !== null && tsMs <= lastTsMs) return "stale";
    return null;
  }

  function accept(envelope) {
    let seq;
    let tsMs;
    let raw;
    try {
      if (!envelope || typeof envelope !== "object") return reject("invalid_envelope");
      seq = normalizeSequence(envelope.seq, "seq");
      tsMs = normalizeSequence(envelope.tsMs, "tsMs");
      raw = normalizeFrameBytes(envelope);
    } catch (err) {
      return reject("invalid_envelope", String(err?.message || err));
    }

    let parsed;
    try {
      parsed = parseMspRequest(raw);
    } catch (err) {
      return reject("malformed_bytes", String(err?.message || err));
    }
    if (!parsed.ok) return reject(parsed.reason, parsed);

    const forward = validateForForwarding(parsed, config);
    if (!forward.ok) return reject(forward.reason, forward);

    const isControl = forward.cmd === MSP_SET_RAW_RC;

    const acceptedAtMs = Number(now());
    if (!Number.isFinite(acceptedAtMs)) return reject("clock_error");

    // Absolute on-arrival freshness: a control frame whose own timestamp is
    // already older than maxAgeMs is stale on arrival (queued/delayed by a link
    // stall) and must never actuate, regardless of seq ordering.
    if (isControl && Number.isFinite(tsMs) && acceptedAtMs - tsMs > config.maxAgeMs) {
      return drop("control_too_old");
    }

    // Failsafe silence is LATCHED. Once the bridge has fired its failsafe frame,
    // it must not resume forwarding armed setpoints just because new control
    // frames arrive — that would let resumed/queued thrust defeat the FC's
    // RX-loss failsafe. Silence is only cleared by an explicit DISARMED control
    // frame (a low arm channel), i.e. a deliberate disarm-first re-arm handshake.
    // Non-control (telemetry) frames are always dropped while silent.
    if (silent) {
      if (!isControl) return drop("silent_non_control");
      if (!isDisarmedRcChannels(forward.channels, config)) return drop("silent_armed_control");
      // a disarmed control frame is the recovery handshake: fall through, forward
      // it, and clear silence below so subsequent armed control can resume.
    }

    const staleReason = orderingDrop(seq, tsMs);
    if (staleReason) return drop(staleReason);

    try {
      transportWrite(transport, forward.frame);
    } catch (err) {
      return reject("transport_write_failed", String(err?.message || err));
    }

    accepted += 1;
    lastSeq = seq;
    lastTsMs = tsMs;
    lastForwardedCmd = forward.cmd;
    // Only a CONTROL setpoint refreshes the failsafe deadline and clears
    // silence. Telemetry requests are forwarded but must NOT reset the control
    // freshness clock — otherwise a telemetry poll at/above the deadline cadence
    // would indefinitely suppress the disarm frame.
    if (isControl) {
      lastControlAtMs = acceptedAtMs;
      silent = false;
    }
    emitStatus(isControl ? "accepted_control" : "accepted_telemetry");
    return { ok: true, action: "forwarded", cmd: forward.cmd, seq, tsMs, bytes: new Uint8Array(forward.frame) };
  }

  function fireFailsafe(reasonEvent, ageMs) {
    // Send exactly one configured disarm frame, then go silent regardless of
    // whether that final write succeeds (a dead link still yields RX-loss at
    // the FC). Silence can only be broken by a fresh control setpoint.
    let sent = false;
    try {
      transportWrite(transport, failsafeFrame);
      sent = true;
    } catch (err) {
      bump(rejectedByReason, "failsafe_write_failed");
      rejected += 1;
    }
    failsafeFired += 1;
    silent = true;
    emitStatus(reasonEvent);
    return { ok: true, action: "failsafe", sent, bytes: new Uint8Array(failsafeFrame), ageMs };
  }

  function tick() {
    // Deadline is measured from the last accepted CONTROL setpoint, never from
    // telemetry. Until a control frame has ever been accepted, or once silent,
    // there is nothing to time out.
    if (lastControlAtMs === null || silent) return { ok: true, action: "idle" };
    const currentMs = Number(now());
    // A non-finite or backward clock is a fail-closed condition, not "fresh":
    // fire the single failsafe and go silent rather than spam clock_error or
    // treat a negative age as still-fresh.
    if (!Number.isFinite(currentMs)) return fireFailsafe("failsafe_clock_error", null);
    const ageMs = currentMs - lastControlAtMs;
    if (!isFiniteNumber(ageMs) || ageMs < 0) return fireFailsafe("failsafe_clock_backward", ageMs);
    if (ageMs < config.deadlineMs) {
      return { ok: true, action: "fresh", ageMs };
    }
    return fireFailsafe("failsafe_fired", ageMs);
  }

  function close() {
    if (transport && typeof transport.close === "function") return transport.close();
    return undefined;
  }

  return {
    accept,
    handleEnvelope: accept,
    tick,
    close,
    getStatus,
    get failsafeFrame() {
      return new Uint8Array(failsafeFrame);
    }
  };
}
