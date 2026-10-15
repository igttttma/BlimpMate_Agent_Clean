# BlimpMate Wake Service

Minimal local Sherpa-ONNX keyword spotting service. Microphone capture stays in
the WebView; Python only receives 16 kHz float32 PCM over WebSocket.

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
- `WS /wake_word/audio`
