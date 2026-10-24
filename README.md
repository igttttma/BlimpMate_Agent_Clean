# BlimpMate Agent

BlimpMate is a minimal voice assistant with a Live2D avatar. The desktop app
supports basic Xiaozhi conversation, the `Hey Blimp` wake word, and facial
expression tools.

## Features

- Always-on `Hey Blimp` wake word: trained openWakeWord models
  (`src/wake-models`), the same on Windows and Android.
- Always ready while idle: connected to the server and listening for the wake
  word after every conversation, media clip and video call
  (`src/xiaozhi/conversation/ready-keeper.mjs`).
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
  -> Python openWakeWord (host-service, models from src/wake-models)

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

The wake-word models are committed in `src/wake-models`. Electron starts and stops the wake service automatically. The default service
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
runs the same models natively (`WakeWordBridge` / `OpenWakeWord.java`);
conversation code does not change.
