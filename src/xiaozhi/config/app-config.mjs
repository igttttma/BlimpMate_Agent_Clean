export const APP_CONFIG = Object.freeze({
  APP_NAME: "l2d-face-control",
  APP_VERSION: "0.1.0",
  BOARD_TYPE: "web",
  OTA_URL: "https://api.tenclass.net/xiaozhi/ota/",
  PROTOCOL_VERSION: "1",
  AUDIO: Object.freeze({
    INPUT_SAMPLE_RATE: 16000,
    OUTPUT_SAMPLE_RATE: 24000,
    CHANNELS: 1,
    FRAME_DURATION_MS: 20,
    get INPUT_FRAME_SIZE() { return (this.INPUT_SAMPLE_RATE * this.FRAME_DURATION_MS) / 1000; }
  }),
  VAD: Object.freeze({
    SILENCE_RMS: 0.012,
    SILENCE_DURATION_MS: 800,
    MIN_VOICE_DURATION_MS: 300
  }),
  RECONNECT: Object.freeze({
    MAX_ATTEMPTS: 5,
    BACKOFF_BASE_MS: 2000,
    BACKOFF_MAX_MS: 30000
  })
});

export const STORAGE_KEYS = Object.freeze({
  MAC: "xiaozhi.mac_address",
  SERIAL: "xiaozhi.serial_number",
  HMAC_KEY: "xiaozhi.hmac_key",
  CLIENT_ID: "xiaozhi.client_id",
  ACTIVATION_STATUS: "xiaozhi.activation_status",
  WS_URL: "xiaozhi.ws_url",
  WS_TOKEN: "xiaozhi.ws_token"
});
