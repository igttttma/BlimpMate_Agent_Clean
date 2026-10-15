# BlimpMate Agent

BlimpMate is a minimal voice assistant with a Live2D avatar. The desktop app
supports basic Xiaozhi conversation, the `Hey Blimp` wake word, and facial
expression tools.

## Features

- Always-on `Hey Blimp` keyword spotting with Sherpa-ONNX.
- One shared Web Audio microphone stream for wake detection and conversation.
- Wake interruption, automatic conversation mode, and an explicit end-session
  action that returns to wake-word listening.
- A short internal activation prompt starts the conversation; the wake phrase
  is not forwarded as user text.
- Six browser-side MCP tools for Live2D expressions and emotion. No MCP tool
  calls Python.

## Architecture

```text
getUserMedia
  -> AudioWorklet (16 kHz Float32 PCM)
  -> WebSocket /wake_word/audio
  -> Python Sherpa-ONNX keyword spotting

The same Web Audio stream
  -> Opus encoder
  -> Xiaozhi conversation WebSocket
```

Python never opens an audio device. The only Python runtime is the local wake
service in `host-service/`.

The model can call these browser-side MCP tools:

- `self.list_expressions`
- `self.set_expression`
- `self.set_emotion`
- `self.clear_expression`
- `self.trigger_blink`
- `self.get_state`

## Windows Setup

```powershell
npm install
python -m venv host-service/.venv
host-service/.venv/Scripts/python.exe -m pip install -r host-service/requirements.txt
npm run demo
```

The Sherpa model must exist at:

```text
host-service/data/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
```

Electron starts and stops the wake service automatically. The default service
URL is `http://127.0.0.1:5000`.

## Validation

```powershell
npm run test:wake
npm run smoke:wake-web
npm run build:web
```

## Android Boundary

Conversation, Web Audio capture, UI synchronization, and expression MCP tools
are browser code and can run in an Android WebView. Android deployment only
needs a replacement wake provider, such as native Sherpa-ONNX or a reachable
wake service; conversation code does not change.
