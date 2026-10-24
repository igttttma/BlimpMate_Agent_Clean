"""Flask blueprint that exposes the wake-word engine to browser clients.

Endpoints
---------
* ``POST /wake_word/start``  - start the openWakeWord engine.
* ``POST /wake_word/stop``   - stop the engine and disconnect subscribers.
* ``GET  /wake_word/status`` - JSON snapshot of the manager state.
* ``GET  /wake_word/events`` - real-time wake-event stream. Speaks WebSocket
  when ``flask_sock`` is available; otherwise falls back to Server-Sent
  Events (``text/event-stream``) so browser clients always have a way to
  receive wake events.

Browser clients send 16 kHz float32 PCM through ``/wake_word/audio``, and pick
the keyword set there with a text message ``{"type": "keywords", "set":
"wake" | "answer"}`` ("answer" while a video call rings), as on Android.
"""
from __future__ import annotations

import json
import queue
import threading
import time
from typing import Any, Dict, List, Optional

from flask import Blueprint, Response, jsonify, stream_with_context
import numpy as np

from wake_word import OpenWakeWordEngine, WakeModelsUnavailable
from wake_word.openwakeword_engine import model_dir_from_env


wake_word_bp = Blueprint("wake_word", __name__, url_prefix="/wake_word")


# Optional WebSocket backend ------------------------------------------------
try:  # pragma: no cover - optional dep
    from flask_sock import Sock  # type: ignore

    _sock = Sock()
    _HAVE_SOCK = True
except Exception:  # noqa: BLE001
    _sock = None
    _HAVE_SOCK = False


class _WakeWordManager:
    """Holds the active engine, subscriber queues, and runtime metadata."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._engine: Any = None
        self._mode: str = "stopped"
        self._reason: str = ""
        self._last_wake_at: float = 0.0
        self._last_wake_word: str = ""
        self._wake_count: int = 0
        self._audio_frames: int = 0
        self._audio_samples: int = 0
        self._last_audio_at: float = 0.0
        self._last_audio_rms: float = 0.0
        self._keywords: str = "wake"
        self._subscribers: List["queue.Queue[Dict[str, Any]]"] = []
        self._sub_lock = threading.Lock()

    # -- engine lifecycle --------------------------------------------------
    def start(self) -> Dict[str, Any]:
        with self._lock:
            if self._engine is not None:
                return self._status_locked()
            mode = "openwakeword"
            reason = ""
            engine: Any = None
            try:
                engine = OpenWakeWordEngine(model_dir=model_dir_from_env(), on_wake=self._on_wake)
            except WakeModelsUnavailable as exc:
                reason = str(exc)
                engine = None
            except Exception as exc:  # noqa: BLE001
                reason = f"openWakeWord init failed: {exc}"
                engine = None
            if engine is None:
                self._mode = "stopped"
                self._reason = reason or "openWakeWord engine unavailable"
                return {
                    **self._status_locked(),
                    "error": self._reason,
                }
            engine.set_keywords(self._keywords)
            self._engine = engine
            self._mode = mode
            self._reason = reason
            return self._status_locked()

    def stop(self) -> Dict[str, Any]:
        with self._lock:
            if self._engine is not None:
                self._engine = None
                self._mode = "stopped"
            status = self._status_locked()
        # Wake subscribers so their long-polls / sockets exit cleanly.
        self._broadcast({"type": "stopped", "timestamp": time.time()})
        return status

    def set_keywords(self, keywords: str) -> Dict[str, Any]:
        """Listen for "wake" (Hey Blimp) or "answer"; starts from fresh audio."""
        with self._lock:
            self._keywords = "answer" if keywords == "answer" else "wake"
            if self._engine is not None:
                self._engine.set_keywords(self._keywords)
            return self._status_locked()

    # -- status ------------------------------------------------------------
    def status(self) -> Dict[str, Any]:
        with self._lock:
            return self._status_locked()

    def accept_audio(self, payload: bytes) -> None:
        if not payload or len(payload) % 4 != 0:
            return
        with self._lock:
            engine = self._engine
        if engine is None or not hasattr(engine, "accept_audio"):
            return
        samples = np.frombuffer(payload, dtype="<f4")
        with self._lock:
            self._audio_frames += 1
            self._audio_samples += int(samples.size)
            self._last_audio_at = time.time()
            self._last_audio_rms = float(np.sqrt(np.mean(np.square(samples))))
        engine.accept_audio(samples)

    def _status_locked(self) -> Dict[str, Any]:
        running = self._engine is not None
        return {
            "running": running,
            "mode": self._mode if running else "stopped",
            "keywords": self._keywords,
            "recent_peak_score": self._engine.recent_peak_score if running else 0.0,
            "reason": self._reason,
            "last_wake_at": self._last_wake_at,
            "last_wake_word": self._last_wake_word,
            "wake_count": self._wake_count,
            "audio_frames": self._audio_frames,
            "audio_samples": self._audio_samples,
            "last_audio_at": self._last_audio_at,
            "last_audio_rms": self._last_audio_rms,
            "audio_backend": "web-audio" if running else None,
            "transport": "websocket" if _HAVE_SOCK else "sse",
        }

    # -- subscribers -------------------------------------------------------
    def subscribe(self) -> "queue.Queue[Dict[str, Any]]":
        q: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=64)
        with self._sub_lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: "queue.Queue[Dict[str, Any]]") -> None:
        with self._sub_lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    def _broadcast(self, event: Dict[str, Any]) -> None:
        with self._sub_lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                # Drop the oldest event to make room.
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except Exception:  # noqa: BLE001
                    pass

    # -- engine callback ---------------------------------------------------
    def _on_wake(self, word: str, keywords: str) -> None:
        # Called from accept_audio(), which runs outside self._lock
        ts = time.time()
        self._last_wake_at = ts
        self._last_wake_word = word
        self._wake_count += 1
        self._broadcast(
            {"type": "wake", "word": word, "keywords": keywords, "timestamp": ts}
        )


manager = _WakeWordManager()


# -- HTTP endpoints ---------------------------------------------------------
@wake_word_bp.post("/start")
def wake_word_start() -> Response:
    status = manager.start()
    code = 200 if status.get("running") else 500
    return jsonify(status), code


@wake_word_bp.post("/stop")
def wake_word_stop() -> Response:
    return jsonify(manager.stop())


@wake_word_bp.get("/status")
def wake_word_status() -> Response:
    return jsonify(manager.status())


@wake_word_bp.get("/events")
def wake_word_events_sse() -> Response:
    """Server-Sent Events stream for browser clients without WS support."""

    def _gen():
        q = manager.subscribe()
        try:
            # Initial hello so the client knows the stream is live.
            yield "event: hello\ndata: " + json.dumps(manager.status()) + "\n\n"
            while True:
                try:
                    event = q.get(timeout=15.0)
                except queue.Empty:
                    yield ": keepalive\n\n"
                    continue
                yield "event: wake\ndata: " + json.dumps(event) + "\n\n"
                if event.get("type") == "stopped":
                    yield "event: stopped\ndata: {}\n\n"
        finally:
            manager.unsubscribe(q)

    return Response(
        stream_with_context(_gen()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# -- optional WebSocket endpoint -------------------------------------------
if _HAVE_SOCK and _sock is not None:  # pragma: no cover - optional dep

    @_sock.route("/audio", bp=wake_word_bp)
    def wake_word_audio_ws(ws):  # type: ignore[no-untyped-def]
        status = manager.start()
        ws.send(json.dumps({"type": "hello", **status}))
        if not status.get("running"):
            return
        q = manager.subscribe()
        try:
            while True:
                payload = ws.receive()
                if payload is None:
                    break
                if isinstance(payload, (bytes, bytearray, memoryview)):
                    manager.accept_audio(bytes(payload))
                else:
                    try:
                        message = json.loads(payload)
                    except (TypeError, ValueError):
                        message = {}
                    if message.get("type") == "keywords":
                        ws.send(json.dumps({"type": "status", **manager.set_keywords(str(message.get("set")))}))
                while True:
                    try:
                        event = q.get_nowait()
                    except queue.Empty:
                        break
                    ws.send(json.dumps(event))
        finally:
            manager.unsubscribe(q)

    @_sock.route("/ws", bp=wake_word_bp)
    def wake_word_ws(ws):  # type: ignore[no-untyped-def]
        q = manager.subscribe()
        try:
            ws.send(json.dumps({"type": "hello", **manager.status()}))
            while True:
                try:
                    event = q.get(timeout=15.0)
                except queue.Empty:
                    try:
                        ws.send(json.dumps({"type": "ping", "timestamp": time.time()}))
                        continue
                    except Exception:  # noqa: BLE001
                        break
                try:
                    ws.send(json.dumps(event))
                except Exception:  # noqa: BLE001
                    break
                if event.get("type") == "stopped":
                    break
        finally:
            manager.unsubscribe(q)


def init_app(app) -> None:
    """Register the blueprint plus the optional WebSocket backend.

    Call this from ``server.py`` after constructing ``app`` and applying
    CORS. The function is idempotent and safe to call even when
    ``flask_sock`` is not installed (it will simply skip the WS init).
    """
    app.register_blueprint(wake_word_bp)
    if _HAVE_SOCK and _sock is not None:
        try:
            _sock.init_app(app)
        except Exception as exc:  # noqa: BLE001
            app.logger.warning("flask_sock init failed: %s", exc)
