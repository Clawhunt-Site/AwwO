#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/orchestrator/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

load_env_file() {
  local env_file="${STUDIO_ENV_FILE:-}"
  if [ -z "$env_file" ]; then
    if [ -f "$ROOT_DIR/.env.local" ]; then
      env_file="$ROOT_DIR/.env.local"
    elif [ -f "$ROOT_DIR/.env" ]; then
      env_file="$ROOT_DIR/.env"
    fi
  fi

  if [ -z "$env_file" ]; then
    return 0
  fi
  if [ ! -f "$env_file" ]; then
    echo "STUDIO_ENV_FILE was set, but the file was not found: $env_file" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
  echo "Loaded environment: $env_file"
}

load_env_file

if [ -z "${PYTHON_BIN:-}" ]; then
  if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
    PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    PYTHON_BIN="python"
  fi
fi

NPM_BIN="${NPM_BIN:-npm}"
BACKEND_PORT="${BACKEND_PORT:-${PORT:-8090}}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"
AI_CANVASPRO_PORT="${AI_CANVASPRO_PORT:-8777}"
AI_CANVASPRO_API_BASE="${AI_CANVASPRO_API_BASE:-http://127.0.0.1:${AI_CANVASPRO_PORT}}"
AI_CANVASPRO_SERVER_DIR="${AI_CANVASPRO_SERVER_DIR:-}"
AI_CANVASPRO_PYTHON_BIN="${AI_CANVASPRO_PYTHON_BIN:-}"

BACKEND_PID=""
FRONTEND_PID=""
CANVASPRO_PID=""
BACKEND_MANAGED="0"
FRONTEND_MANAGED="0"
CANVASPRO_MANAGED="0"

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [ "$FRONTEND_MANAGED" = "1" ] && [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [ "$BACKEND_MANAGED" = "1" ] && [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi

  if [ "$CANVASPRO_MANAGED" = "1" ] && [ -n "$CANVASPRO_PID" ] && kill -0 "$CANVASPRO_PID" 2>/dev/null; then
    kill "$CANVASPRO_PID" 2>/dev/null || true
  fi

  if [ "$FRONTEND_MANAGED" = "1" ] && [ -n "$FRONTEND_PID" ]; then
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [ "$CANVASPRO_MANAGED" = "1" ] && [ -n "$CANVASPRO_PID" ]; then
    wait "$CANVASPRO_PID" 2>/dev/null || true
  fi

  if [ "$BACKEND_MANAGED" = "1" ] && [ -n "$BACKEND_PID" ]; then
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

require_frontend_deps() {
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "Frontend dependencies are not installed."
    echo "Run: cd frontend && npm install"
    exit 1
  fi
}

require_backend_deps() {
  if ! "$PYTHON_BIN" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
    echo "Backend dependencies are not installed for ${PYTHON_BIN}."
    echo "Run: cd orchestrator/backend && ${PYTHON_BIN} -m pip install -r requirements.txt"
    exit 1
  fi
}

prepare_canvaspro_static() {
  bash "$ROOT_DIR/scripts/prepare-canvaspro-static.sh" --optional
}

wait_for_backend() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS "${BACKEND_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi

    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      echo "Backend exited before becoming ready."
      wait "$BACKEND_PID" || true
      exit 1
    fi

    sleep 0.5
  done

  echo "Backend did not become ready at ${BACKEND_URL}."
  exit 1
}

canvaspro_health_url() {
  printf "%s/api/v2/runtime/info" "${AI_CANVASPRO_API_BASE%/}"
}

find_canvaspro_server_dir() {
  if [ -n "$AI_CANVASPRO_SERVER_DIR" ]; then
    if [ -f "$AI_CANVASPRO_SERVER_DIR/server.py" ]; then
      printf "%s\n" "$AI_CANVASPRO_SERVER_DIR"
    else
      echo "AI_CANVASPRO_SERVER_DIR is set, but server.py was not found: ${AI_CANVASPRO_SERVER_DIR}" >&2
    fi
    return 0
  fi

  local candidate
  for candidate in \
    "$ROOT_DIR/.external/AI-CanvasPro" \
    "$ROOT_DIR/.external/ai-canvaspro" \
    "$ROOT_DIR/../AI-CanvasPro" \
    "$ROOT_DIR/../AI-CanvasPro-main" \
    "$ROOT_DIR/../ai-canvaspro"; do
    if [ -f "$candidate/server.py" ]; then
      printf "%s\n" "$candidate"
      return 0
    fi
  done
}

wait_for_canvaspro() {
  local attempt
  for attempt in $(seq 1 40); do
    if curl -fsS "$(canvaspro_health_url)" >/dev/null 2>&1; then
      return 0
    fi

    if ! kill -0 "$CANVASPRO_PID" 2>/dev/null; then
      echo "CanvasPro native API exited before becoming ready."
      wait "$CANVASPRO_PID" || true
      CANVASPRO_MANAGED="0"
      return 1
    fi

    sleep 0.5
  done

  return 1
}

start_canvaspro_api() {
  case "${AI_CANVASPRO_AUTOSTART:-auto}" in
    0|false|False|FALSE|no|No|NO)
      echo "CanvasPro native API autostart disabled; Studio compatibility fallback is enabled."
      return 0
      ;;
  esac

  if curl -fsS "$(canvaspro_health_url)" >/dev/null 2>&1; then
    echo "CanvasPro native API already ready"
    return 0
  fi

  local server_dir
  server_dir="$(find_canvaspro_server_dir)"
  if [ -z "$server_dir" ]; then
    echo "CanvasPro native API server.py not found; Studio compatibility fallback is enabled."
    echo "To enable native generation, set AI_CANVASPRO_SERVER_DIR=/path/to/AI-CanvasPro."
    return 0
  fi

  local canvaspro_python_bin
  canvaspro_python_bin="$AI_CANVASPRO_PYTHON_BIN"
  if [ -z "$canvaspro_python_bin" ]; then
    if [ -x "$server_dir/.venv/bin/python" ]; then
      canvaspro_python_bin="$server_dir/.venv/bin/python"
    else
      canvaspro_python_bin="$PYTHON_BIN"
    fi
  fi

  require_command "$canvaspro_python_bin"
  echo "Starting CanvasPro native API from ${server_dir}"
  (
    cd "$server_dir"
    PORT="$AI_CANVASPRO_PORT" AI_CANVASPRO_PORT="$AI_CANVASPRO_PORT" "$canvaspro_python_bin" server.py
  ) &
  CANVASPRO_PID=$!
  CANVASPRO_MANAGED="1"

  if wait_for_canvaspro; then
    echo "CanvasPro native API ready"
  else
    echo "CanvasPro native API did not report ready; Studio compatibility fallback remains available."
  fi
}

require_command "$PYTHON_BIN"
require_command "$NPM_BIN"
require_command curl
require_frontend_deps
require_backend_deps
prepare_canvaspro_static

trap cleanup EXIT INT TERM

echo "Starting MyShell Studio local dev environment"
echo "Backend:  ${BACKEND_URL}"
echo "Frontend: ${FRONTEND_URL}"
echo "CanvasPro API: ${AI_CANVASPRO_API_BASE} via Studio backend proxy"
echo

if curl -fsS "${BACKEND_URL}/api/health" >/dev/null 2>&1; then
  echo "Backend already ready"
else
  (
    cd "$BACKEND_DIR"
    PORT="$BACKEND_PORT" AI_CANVASPRO_API_BASE="$AI_CANVASPRO_API_BASE" "$PYTHON_BIN" main.py
  ) &
  BACKEND_PID=$!
  BACKEND_MANAGED="1"

  wait_for_backend
  echo "Backend ready"
fi

start_canvaspro_api

(
  cd "$FRONTEND_DIR"
  VITE_DREAMY_ORCHESTRATOR_BASE_URL="${VITE_DREAMY_ORCHESTRATOR_BASE_URL:-}" \
  VITE_DREAMY_ORCHESTRATOR_PROXY_TARGET="$BACKEND_URL" \
  VITE_AI_CANVASPRO_PROXY_TARGET="${VITE_AI_CANVASPRO_PROXY_TARGET:-}" \
  AI_CANVASPRO_API_BASE="" \
  "$NPM_BIN" run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT" --strictPort
) &
FRONTEND_PID=$!
FRONTEND_MANAGED="1"

echo "Frontend starting"
echo
echo "Open Studio: ${FRONTEND_URL}/dreamy"
echo "CanvasPro is available inside the Studio workspace switch."
echo "Press Ctrl+C to stop both services."
echo

while true; do
  if [ "$BACKEND_MANAGED" = "1" ]; then
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      echo "Backend process stopped."
      wait "$BACKEND_PID" || true
      exit 1
    fi
  elif ! curl -fsS "${BACKEND_URL}/api/health" >/dev/null 2>&1; then
    echo "Backend at ${BACKEND_URL} is no longer reachable."
    exit 1
  fi

  if [ "$CANVASPRO_MANAGED" = "1" ]; then
    if ! kill -0 "$CANVASPRO_PID" 2>/dev/null; then
      echo "CanvasPro native API process stopped; Studio compatibility fallback remains available."
      wait "$CANVASPRO_PID" || true
      CANVASPRO_MANAGED="0"
    fi
  fi

  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "Frontend process stopped."
    wait "$FRONTEND_PID" || true
    exit 1
  fi

  sleep 1
done
