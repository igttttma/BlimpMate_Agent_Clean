# BlimpMate Wake Service

Minimal local wake-word service for the desktop app. It runs the same trained
openWakeWord models as the Android app (`src/wake-models`: "Hey Blimp", and
"answer" while a video call rings) with the same thresholds. Microphone capture
stays in the renderer; Python only receives 16 kHz float32 PCM over WebSocket.
`BM_WAKE_MODEL_DIR` points it at another model folder.

## Run

```bash
pip install -r requirements.txt
python server.py
```

Electron starts this service automatically. The default endpoint is
`http://127.0.0.1:5000`.

## Endpoints

- `GET /health`
- `GET /wake_word/status`
- `POST /wake_word/start`
- `POST /wake_word/stop`
- `WS /wake_word/audio`: binary messages are audio; the text message
  `{"type": "keywords", "set": "wake" | "answer"}` switches the keyword set
