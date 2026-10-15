"""Sherpa-ONNX keyword-spotter wrapper.

Loads the KWS zipformer model and accepts 16 kHz float32 PCM supplied by the
Web audio capture path. Python never opens an audio device.

If ``sherpa_onnx`` or the model is unavailable, construction raises
:class:`SherpaUnavailable` and the service reports a hard failure.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Callable, List

import numpy as np

class SherpaUnavailable(RuntimeError):
    """Raised when the sherpa-onnx package or model files are missing."""


class SherpaKwsEngine:
    """Run sherpa-onnx KWS in a background thread."""

    REQUIRED_FILES = (
        "tokens.txt",
        "keywords.txt",
        "encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
        "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
        "joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
    )

    def __init__(
        self,
        model_dir: Path,
        on_wake: Callable[[str], None],
        sample_rate: int = 16000,
        chunk_ms: int = 100,
        keywords_threshold: float = 0.1,
        keywords_score: float = 1.0,
    ) -> None:
        self.model_dir = Path(model_dir)
        self.on_wake = on_wake
        self.sample_rate = int(sample_rate)
        self.chunk_ms = int(chunk_ms)
        self.keywords_threshold = float(keywords_threshold)
        self.keywords_score = float(keywords_score)

        self._sherpa_stream = None
        self._spotter = None
        self._buffer: List[np.ndarray] = []
        self._last_wake_at: float = 0.0
        self._wake_count: int = 0
        self._cooldown_seconds: float = 1.5

        try:  # pragma: no cover - optional dep
            from sherpa_onnx.keyword_spotter import KeywordSpotter  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise SherpaUnavailable(
                f"sherpa_onnx is not installed: {exc}"
            ) from exc
        self._KeywordSpotter = KeywordSpotter

        missing = [
            name for name in self.REQUIRED_FILES if not (self.model_dir / name).is_file()
        ]
        if missing:
            raise SherpaUnavailable(
                "missing sherpa-onnx model files: " + ", ".join(missing)
            )

    # -- public API --------------------------------------------------------
    @property
    def last_wake_at(self) -> float:
        return self._last_wake_at

    @property
    def wake_count(self) -> int:
        return self._wake_count

    @property
    def audio_backend(self) -> str:
        return "web-audio" if self._spotter is not None else "stopped"

    def start(self) -> None:
        if self._spotter is not None:
            return
        self._spotter = self._build_spotter()
        self._sherpa_stream = self._spotter.create_stream()
        self._buffer = []

    def stop(self) -> None:
        self._spotter = None
        self._sherpa_stream = None
        self._buffer = []

    # -- internals ---------------------------------------------------------
    def _keywords_file(self) -> Path:
        """Resolve the keywords list.

        ``BM_SHERPA_KEYWORDS_FILE`` wins so the wake-word list (which must
        include the wake phrase ``Hey Blimp``) can live in a committed file and
        survive model re-downloads; the model dir is git-ignored. Falls back to
        the model's bundled keywords.txt.
        """
        override = os.environ.get("BM_SHERPA_KEYWORDS_FILE")
        if override:
            p = Path(override).expanduser()
            if p.is_file():
                return p
        project_keywords = Path(__file__).with_name("keywords.en.txt")
        if project_keywords.is_file():
            return project_keywords
        return self.model_dir / "keywords.txt"

    def _build_spotter(self):  # pragma: no cover - requires sherpa runtime
        return self._KeywordSpotter(
            tokens=str(self.model_dir / "tokens.txt"),
            encoder=str(self.model_dir / "encoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
            decoder=str(self.model_dir / "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
            joiner=str(self.model_dir / "joiner-epoch-12-avg-2-chunk-16-left-64.onnx"),
            keywords_file=str(self._keywords_file()),
            num_threads=1,
            sample_rate=self.sample_rate,
            feature_dim=80,
            max_active_paths=4,
            keywords_score=self.keywords_score,
            keywords_threshold=self.keywords_threshold,
            num_trailing_blanks=1,
            provider="cpu",
        )

    def accept_audio(self, samples: np.ndarray) -> None:
        if self._spotter is None:
            raise RuntimeError("wake-word engine is not started")
        frame = np.asarray(samples, dtype=np.float32).reshape(-1)
        if frame.size == 0:
            return
        self._buffer.append(frame)
        chunk_size = max(1, self.sample_rate // 10)  # 100 ms windows
        total = int(sum(arr.size for arr in self._buffer))
        while total >= chunk_size:
            flat = np.concatenate(self._buffer)
            chunk = flat[:chunk_size]
            remainder = flat[chunk_size:]
            self._buffer = [remainder] if remainder.size else []
            total = remainder.size
            self._process_chunk(chunk)

    def _process_chunk(self, chunk: np.ndarray) -> None:  # pragma: no cover
        spotter = self._spotter
        stream = self._sherpa_stream
        if spotter is None or stream is None:
            return
        try:
            stream.accept_waveform(self.sample_rate, chunk)
            while spotter.is_ready(stream):
                spotter.decode_stream(stream)
            result = spotter.get_result(stream)
        except Exception:
            return
        if not result:
            return
        word = str(result).strip().replace("_", " ")
        if not word:
            return
        now = time.time()
        if now - self._last_wake_at < self._cooldown_seconds:
            return
        self._last_wake_at = now
        self._wake_count += 1
        try:
            self.on_wake(word)
        except Exception:
            pass
        # Reset the spotter stream so the same keyword can fire again later.
        try:
            spotter.reset_stream(stream)
        except Exception:
            try:
                self._sherpa_stream = spotter.create_stream()
            except Exception:
                pass


def model_dir_from_env(default_root: Path) -> Path:
    """Resolve the Sherpa model directory from the environment.

    Order of precedence:
    1. ``BM_SHERPA_MODEL_DIR``
    2. ``<default_root>/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01``
    """
    override = os.environ.get("BM_SHERPA_MODEL_DIR")
    if override:
        return Path(override).expanduser()
    return Path(default_root) / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
