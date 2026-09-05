#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANVASPRO_REPO_URL="${AI_CANVASPRO_REPO_URL:-https://github.com/ashuoAI/AI-CanvasPro.git}"
CANVASPRO_DIR="${AI_CANVASPRO_SERVER_DIR:-$ROOT_DIR/.external/AI-CanvasPro}"
CANVASPRO_REF="${AI_CANVASPRO_REF:-}"
UPDATE_EXISTING="${AI_CANVASPRO_UPDATE:-0}"

if [ -z "${PYTHON_BOOTSTRAP_BIN:-}" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BOOTSTRAP_BIN="python3"
  else
    PYTHON_BOOTSTRAP_BIN="python"
  fi
fi

if [ -z "${AI_CANVASPRO_PYTHON_BIN:-}" ]; then
  CANVASPRO_PYTHON_BIN="$CANVASPRO_DIR/.venv/bin/python"
else
  CANVASPRO_PYTHON_BIN="$AI_CANVASPRO_PYTHON_BIN"
fi

case "$UPDATE_EXISTING" in
  1|true|True|TRUE|yes|Yes|YES)
    UPDATE_EXISTING="1"
    ;;
  *)
    UPDATE_EXISTING="0"
    ;;
esac

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

fail_missing_canvaspro_runtime() {
  cat >&2 <<EOF
AI CanvasPro runnable files were not found in:
  ${CANVASPRO_DIR}

Expected either:
  - index.html for a static CanvasPro web app
  - server.py for the native CanvasPro backend

The default public AI-CanvasPro checkout currently contains documentation and release metadata only.
Provide a real distributable/source location with one of:
  AI_CANVASPRO_STATIC_DIR=/path/to/static-app bash scripts/setup-canvaspro.sh
  AI_CANVASPRO_SERVER_DIR=/path/to/AI-CanvasPro-source bash scripts/setup-canvaspro.sh
  AI_CANVASPRO_REPO_URL=<private-source-repo-url> bash scripts/setup-canvaspro.sh

If ${CANVASPRO_DIR} is a stale docs-only checkout, move it away or point AI_CANVASPRO_SERVER_DIR
to another location before rerunning.
EOF
  exit 1
}

if [ -n "${AI_CANVASPRO_STATIC_DIR:-}" ]; then
  if [ ! -f "$AI_CANVASPRO_STATIC_DIR/index.html" ]; then
    echo "AI_CANVASPRO_STATIC_DIR is set, but index.html was not found: ${AI_CANVASPRO_STATIC_DIR}" >&2
    exit 1
  fi
  bash "$ROOT_DIR/scripts/prepare-canvaspro-static.sh"
  echo
  echo "AI CanvasPro static app is ready."
  echo "Start the integrated Studio with:"
  echo "  AI_CANVASPRO_STATIC_DIR=\"$AI_CANVASPRO_STATIC_DIR\" npm run dev"
  exit 0
fi

require_command git

mkdir -p "$(dirname "$CANVASPRO_DIR")"

if [ -d "$CANVASPRO_DIR/.git" ]; then
  echo "AI CanvasPro checkout exists at ${CANVASPRO_DIR}"
  if [ "$UPDATE_EXISTING" = "1" ]; then
    echo "Updating AI CanvasPro"
    git -C "$CANVASPRO_DIR" pull --ff-only
  fi
elif [ -d "$CANVASPRO_DIR" ] && [ -n "$(find "$CANVASPRO_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "Using existing AI CanvasPro directory at ${CANVASPRO_DIR}"
else
  echo "Cloning AI CanvasPro into ${CANVASPRO_DIR}"
  git clone "$CANVASPRO_REPO_URL" "$CANVASPRO_DIR"
fi

if [ -n "$CANVASPRO_REF" ]; then
  if [ ! -d "$CANVASPRO_DIR/.git" ]; then
    echo "AI_CANVASPRO_REF requires ${CANVASPRO_DIR} to be a git checkout." >&2
    exit 1
  fi
  echo "Checking out AI CanvasPro ref: ${CANVASPRO_REF}"
  git -C "$CANVASPRO_DIR" fetch --tags origin
  git -C "$CANVASPRO_DIR" checkout "$CANVASPRO_REF"
fi

HAS_STATIC_APP="0"
HAS_NATIVE_SERVER="0"
if [ -f "$CANVASPRO_DIR/index.html" ]; then
  HAS_STATIC_APP="1"
fi
if [ -f "$CANVASPRO_DIR/server.py" ]; then
  HAS_NATIVE_SERVER="1"
fi

if [ "$HAS_STATIC_APP" != "1" ] && [ "$HAS_NATIVE_SERVER" != "1" ]; then
  fail_missing_canvaspro_runtime
fi

if [ "$HAS_NATIVE_SERVER" = "1" ]; then
  require_command "$PYTHON_BOOTSTRAP_BIN"
  if [ -z "${AI_CANVASPRO_PYTHON_BIN:-}" ]; then
    if [ ! -x "$CANVASPRO_PYTHON_BIN" ]; then
      echo "Creating AI CanvasPro virtual environment at ${CANVASPRO_DIR}/.venv"
      "$PYTHON_BOOTSTRAP_BIN" -m venv "$CANVASPRO_DIR/.venv"
    fi
  else
    require_command "$CANVASPRO_PYTHON_BIN"
  fi

  if [ -f "$CANVASPRO_DIR/requirements.txt" ]; then
    echo "Installing AI CanvasPro Python dependencies with ${CANVASPRO_PYTHON_BIN}"
    "$CANVASPRO_PYTHON_BIN" -m pip install -r "$CANVASPRO_DIR/requirements.txt"
  else
    echo "requirements.txt was not found; skipping Python dependency install."
  fi
else
  echo "server.py was not found; skipping native CanvasPro Python dependency install."
fi

bash "$ROOT_DIR/scripts/prepare-canvaspro-static.sh"

echo
echo "AI CanvasPro is ready."
echo "Start the integrated Studio with:"
if [ "$HAS_NATIVE_SERVER" = "1" ]; then
  echo "  AI_CANVASPRO_SERVER_DIR=\"$CANVASPRO_DIR\" AI_CANVASPRO_PYTHON_BIN=\"$CANVASPRO_PYTHON_BIN\" npm run dev"
else
  echo "  AI_CANVASPRO_SERVER_DIR=\"$CANVASPRO_DIR\" npm run dev"
fi
