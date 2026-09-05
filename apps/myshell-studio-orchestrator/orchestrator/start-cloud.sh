#!/bin/bash

export MYSHELL_CDP_URL="${MYSHELL_CDP_URL:-http://127.0.0.1:9222}"
MYSHELL_CDP_URL="${MYSHELL_CDP_URL%/}"
MYSHELL_CDP_ENDPOINT="${MYSHELL_CDP_URL#http://}"
MYSHELL_CDP_ENDPOINT="${MYSHELL_CDP_ENDPOINT#https://}"
MYSHELL_CDP_HOST="${MYSHELL_CDP_ENDPOINT%%[:/]*}"
MYSHELL_CDP_REMAINDER="${MYSHELL_CDP_ENDPOINT#"$MYSHELL_CDP_HOST"}"
MYSHELL_CDP_PORT="9222"
if [[ "$MYSHELL_CDP_REMAINDER" =~ ^:([0-9]+) ]]; then
  MYSHELL_CDP_PORT="${BASH_REMATCH[1]}"
fi
export MYSHELL_COOKIE_INJECTION_STATUS_PATH="${MYSHELL_COOKIE_INJECTION_STATUS_PATH:-/app/.studio/cookie-injection-status.json}"

write_cookie_injection_status() {
  local status="$1"
  local message="$2"
  local cookie_count="${3:-0}"
  python3 - "$MYSHELL_COOKIE_INJECTION_STATUS_PATH" "$status" "$message" "$cookie_count" <<'PY'
import json
import os
import sys
from datetime import UTC, datetime

path, status, message, cookie_count = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
with open(path, "w", encoding="utf-8") as status_file:
    json.dump(
        {
            "status": status,
            "message": message,
            "cookieCount": cookie_count,
            "energyDisplay": "",
            "checkedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        },
        status_file,
        ensure_ascii=False,
    )
PY
}

# Launch Chrome headless in background (don't block server startup)
google-chrome-stable \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=${MYSHELL_CDP_PORT} \
  --remote-debugging-address=${MYSHELL_CDP_HOST} \
  --user-data-dir=/app/chrome-data \
  --window-size=1280,900 \
  > /dev/null 2>&1 &

# Inject cookies in background after Chrome is ready
(
  chrome_ready=0
  for i in $(seq 1 30); do
    if curl -s "$MYSHELL_CDP_URL/json" > /dev/null 2>&1; then
      chrome_ready=1
      echo "Chrome ready, injecting cookies..."
      python3 /app/inject_cookies.py 2>&1 || echo "Cookie injection failed"
      break
    fi
    sleep 1
  done
  if [ "$chrome_ready" -ne 1 ]; then
    echo "Chrome CDP was not ready after 30s"
    write_cookie_injection_status "failed" "Chrome CDP was not ready after 30s" 0
  fi
) &

# Start the Python backend immediately (don't wait for Chrome)
exec python3 main.py
