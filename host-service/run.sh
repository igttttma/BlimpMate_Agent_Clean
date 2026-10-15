#!/usr/bin/env bash
# BlimpMate host-service launcher.
#
# Idempotent: creates the venv on first run, installs deps, then starts Flask.
# Re-running just starts the server (deps install is skipped if already present
# unless you pass --reinstall).
#
#   ./run.sh                 # start on the default port
#   ./run.sh --reinstall     # force `pip install -r requirements.txt` first
#   BM_HOST_SERVICE_PORT=5000 ./run.sh   # override port
#
# Port note: we default to 5050 because macOS Sonoma+ runs the AirPlay
# Receiver (ControlCenter) on TCP 5000, which would block the bind. 5050 is
# also free on the Orange Pi / Linux targets, so it is safe as a single default.
# The Electron host honours the SAME env var (BM_HOST_SERVICE_PORT) so both
# ends stay in sync.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Load repo-root .env (host-service lives one level down). Existing shell vars
# are preserved (only fills unset ones), matching the Electron loader's rule.
ENV_FILE="${BM_ENV_FILE:-$HERE/../.env}"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    if [ -z "${!key:-}" ]; then export "$line"; fi
  done < "$ENV_FILE"
fi

VENV="${BM_VENV_DIR:-$HERE/.venv}"
PY="${BM_PYTHON:-python3}"
export BM_HOST_SERVICE_PORT="${BM_HOST_SERVICE_PORT:-5050}"
export BM_HOST_SERVICE_HOST="${BM_HOST_SERVICE_HOST:-127.0.0.1}"

REINSTALL=0
[ "${1:-}" = "--reinstall" ] && REINSTALL=1

if [ ! -d "$VENV" ]; then
  echo "[run] creating virtualenv at $VENV"
  "$PY" -m venv "$VENV"
  REINSTALL=1
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

if [ "$REINSTALL" = "1" ]; then
  echo "[run] installing dependencies (required set)"
  python -m pip install --upgrade pip >/dev/null
  python -m pip install -r requirements.txt
fi

echo "[run] starting BlimpMate host-service on http://$BM_HOST_SERVICE_HOST:$BM_HOST_SERVICE_PORT"
exec python server.py
