# Wake-word models

On-device wake words for the Android app (`WakeWordBridge` / `OpenWakeWord.java`),
in the [openWakeWord](https://github.com/dscripka/openWakeWord) format. Gradle's
`syncWakeModel` copies this folder into the APK's `assets/wake-models/`.

| File | What |
|---|---|
| `melspectrogram.onnx`, `embedding_model.onnx` | openWakeWord's shared feature models (Apache-2.0) |
| `hey_blimp.onnx` | "Hey Blimp" (also "Hi Blimp") |
| `answer.onnx` | "answer" (also "answer it", "answer the call"), used while a call rings |
| `wakewords.json` | per word: `threshold` and `patience` (consecutive 80 ms frames at or above it) |

Each classifier takes the last 16 speech embeddings (`x`: `[1, 16, 96]`, about 2 s
of audio) and returns a score in [0, 1].

The models were trained from synthetic speech (Piper's 1,037 speakers including
accented L2-ARCTIC voices, and edge-tts voices with regional accents), mixed with
room echo, noise and other speech, against sounds-like phrases and general audio.
The training scripts are in `C:\Projects\wakeword-training\scripts`.

Held-out results at threshold 0.7, patience 3 (streaming, in background noise):

| | heard | sounds-like phrases | false wakes in continuous speech |
|---|---|---|---|
| hey_blimp | 95.2% | 8.2% | 0.37 per hour |
| answer | 94.8% | 10.2% | 0.75 per hour |

For comparison, openWakeWord's pretrained "alexa" model gets 2.6 false wakes per
hour on the same speech audio at its default threshold.
