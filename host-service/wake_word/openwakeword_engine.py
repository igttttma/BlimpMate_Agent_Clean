"""openWakeWord detection, the same as the Android app's (OpenWakeWord.java).

Every 80 ms of 16 kHz audio gives 8 mel frames, the last 76 frames give one
speech embedding, and a word's classifier scores the last 16 embeddings (about
2 s). A word fires once its score stays at or above its threshold for
``patience`` chunks in a row (both in wakewords.json). The models are the
trained ones in src/wake-models (see its README); Python never opens an audio
device, it gets float32 PCM from the renderer's capture.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Callable, Dict

import numpy as np

CHUNK = 1280  # 80 ms
MEL_CONTEXT = 480  # 3 extra hops so a chunk yields 8 frames
MEL_BINS = 32
MEL_WINDOW = 76
EMBEDDING = 96
FEATURE_WINDOW = 16

# Keyword sets: "wake" (Hey Blimp) or "answer" (incoming calls), as on Android
MODELS = {"wake": "hey_blimp", "answer": "answer"}
PHRASES = {"wake": "Hey Blimp", "answer": "answer"}


class WakeModelsUnavailable(RuntimeError):
    """Raised when onnxruntime or the model files are missing."""


def model_dir_from_env() -> Path:
    """``BM_WAKE_MODEL_DIR``, else the repo's src/wake-models."""
    override = os.environ.get("BM_WAKE_MODEL_DIR")
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parents[2] / "src" / "wake-models"


class OpenWakeWordEngine:
    def __init__(self, model_dir: Path, on_wake: Callable[[str, str], None]) -> None:
        self.model_dir = Path(model_dir)
        self.on_wake = on_wake
        try:
            import onnxruntime as ort  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise WakeModelsUnavailable(f"onnxruntime is not installed: {exc}") from exc
        names = ["melspectrogram", "embedding_model", *MODELS.values()]
        missing = [n for n in names if not (self.model_dir / f"{n}.onnx").is_file()]
        if not (self.model_dir / "wakewords.json").is_file():
            missing.append("wakewords.json")
        if missing:
            raise WakeModelsUnavailable(
                f"missing wake-word model files in {self.model_dir}: " + ", ".join(missing)
            )
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = lambda name: ort.InferenceSession(  # noqa: E731
            str(self.model_dir / f"{name}.onnx"), options, providers=["CPUExecutionProvider"]
        )
        self._melspec = session("melspectrogram")
        self._embedding = session("embedding_model")
        self._classifiers = {word: session(word) for word in MODELS.values()}
        self._tuning: Dict[str, dict] = json.loads(
            (self.model_dir / "wakewords.json").read_text(encoding="utf-8")
        )
        self._lock = threading.Lock()
        self.keywords = "wake"
        self.recent_peak_score = 0.0
        self._chunks = 0
        self.reset()

    def reset(self) -> None:
        """Forget all audio heard so far (after a detection or a keyword switch)."""
        self._raw = np.zeros(CHUNK + MEL_CONTEXT, dtype=np.float32)
        self._pending = 0
        self._mel = np.ones((MEL_WINDOW, MEL_BINS), dtype=np.float32)
        self._features = np.zeros((FEATURE_WINDOW, EMBEDDING), dtype=np.float32)
        self._real_features = 0
        self._streak = 0

    def set_keywords(self, keywords: str) -> None:
        keywords = "answer" if keywords == "answer" else "wake"
        with self._lock:
            if keywords != self.keywords:
                self.keywords = keywords
                self.reset()

    def accept_audio(self, samples: np.ndarray) -> None:
        """Feeds float32 samples in [-1, 1] at 16 kHz."""
        # The models take int16-range floats
        pcm = np.asarray(samples, dtype=np.float32).reshape(-1) * 32768.0
        with self._lock:
            at = 0
            while at < pcm.size:
                take = min(CHUNK - self._pending, pcm.size - at)
                start = MEL_CONTEXT + self._pending
                self._raw[start:start + take] = pcm[at:at + take]
                self._pending += take
                at += take
                if self._pending == CHUNK:
                    self._step()
                    # Keep the last 480 samples as context for the next chunk's frames
                    self._raw[:MEL_CONTEXT] = self._raw[CHUNK:]
                    self._pending = 0
                    if self._score_chunk():
                        return

    def _step(self) -> None:
        # Mel frames for this chunk, scaled like openWakeWord (x / 10 + 2)
        frames = self._melspec.run(None, {self._melspec.get_inputs()[0].name: self._raw[None, :]})[0]
        frames = frames.reshape(-1, MEL_BINS) / 10.0 + 2.0
        n = frames.shape[0]
        self._mel = np.concatenate([self._mel[n:], frames.astype(np.float32)])
        vector = self._embedding.run(
            None, {self._embedding.get_inputs()[0].name: self._mel[None, :, :, None]}
        )[0].reshape(EMBEDDING)
        self._features = np.concatenate([self._features[1:], vector[None, :]])
        if self._real_features < FEATURE_WINDOW:
            self._real_features += 1

    def _score_chunk(self) -> bool:
        """Scores the chunk just completed; True when the word fired."""
        word = MODELS[self.keywords]
        score = 0.0
        if self._real_features >= FEATURE_WINDOW:
            classifier = self._classifiers[word]
            score = float(classifier.run(
                None, {classifier.get_inputs()[0].name: self._features[None, :, :]}
            )[0].reshape(-1)[0])
        # The highest score in about the last second, for tuning thresholds
        if self._chunks % 12 == 0:
            self.recent_peak_score = 0.0
        self._chunks += 1
        self.recent_peak_score = max(self.recent_peak_score, score)
        tuning = self._tuning[word]
        self._streak = self._streak + 1 if score >= float(tuning["threshold"]) else 0
        if self._streak < int(tuning.get("patience", 1)):
            return False
        keywords = self.keywords
        self.reset()
        try:
            self.on_wake(PHRASES[keywords], keywords)
        except Exception:  # noqa: BLE001
            pass
        return True
