"""Minimal local service for openWakeWord wake-word detection."""
from __future__ import annotations

import os

from flask import Flask, jsonify
from flask_cors import CORS

from blueprints.wake_word import init_app as init_wake_word


HOST = os.environ.get("BM_HOST_SERVICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("BM_HOST_SERVICE_PORT", "5000"))

app = Flask(__name__)
CORS(app)
init_wake_word(app)


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "blimpmate-wake-word"})


def main() -> None:
    app.run(host=HOST, port=PORT, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
