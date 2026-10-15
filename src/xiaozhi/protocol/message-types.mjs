export const ServerMsg = Object.freeze({
  HELLO: "hello",
  TTS: "tts",
  STT: "stt",
  LLM: "llm",
  MCP: "mcp",
  IOT: "iot",
  GOODBYE: "goodbye"
});

export const ClientMsg = Object.freeze({
  HELLO: "hello",
  LISTEN: "listen",
  ABORT: "abort",
  MCP: "mcp",
  IOT: "iot"
});

export const ListenState = Object.freeze({
  START: "start",
  STOP: "stop",
  DETECT: "detect"
});

export const ListeningMode = Object.freeze({
  REALTIME: "realtime",
  AUTO_STOP: "auto",
  MANUAL: "manual"
});

export const DeviceState = Object.freeze({
  IDLE: "idle",
  LISTENING: "listening",
  SPEAKING: "speaking"
});

export const AbortReason = Object.freeze({
  NONE: "none",
  WAKE_WORD_DETECTED: "wake_word_detected",
  USER_INTERRUPTION: "user_interruption"
});
