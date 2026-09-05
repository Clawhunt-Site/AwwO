#!/usr/bin/env bash
#
# Local end-to-end telemetry-link smoke: spin up the REAL collection server,
# drive the REAL CLI uploader against it over real HTTP, and assert the data
# really landed in the server's database.
#
# This is the reproducible "is the link actually running?" gate, distinct from
# the in-process pytest e2e (tests/test_telemetry_e2e.py): here the server runs
# as a separate uvicorn process and the client uses the real `superclaw
# telemetry` CLI + real httpx TCP, so the full wire path is exercised.
#
#   sender:   superclaw telemetry enable/spool  (real CLI, real httpx)
#      |  http://127.0.0.1:<port>/v1/telemetry/ingest  (real TCP, bearer auth)
#      v
#   server:   apps.telemetry_server  (real uvicorn + SQLite)
#      |
#      v   asserted via /api/query (operator token)
#
# Everything is throwaway: a temp SQLite db for the server, a temp SUPERCLAW_HOME
# for the client, a loopback-only bind, and a trap that always tears the server
# down. Nothing touches your real ~/.superclaw state or any remote endpoint.
#
# Usage:
#   scripts/telemetry-local-e2e.sh                 # auto port 8911
#   TELEMETRY_E2E_PORT=8920 scripts/telemetry-local-e2e.sh
#
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# -- interpreter: a venv with the editable install + deps. Honor $PYTHON, else the
#    repo .venv; never silently fall back to a system Python that would lack
#    uvicorn/fastapi/httpx and make this gate lie. NOTE: a git worktree has no
#    .venv of its own (project rule — worktrees reuse the main checkout's .venv),
#    so from a worktree you MUST pass PYTHON=/path/to/main/.venv/bin/python. ------
if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif [ -x "$ROOT/.venv/bin/python" ]; then
  PY="$ROOT/.venv/bin/python"
else
  echo "FATAL: no interpreter at $ROOT/.venv — set \$PYTHON to a venv python that" >&2
  echo "       has the superclaw editable install (from a worktree, point it at" >&2
  echo "       the MAIN checkout's .venv/bin/python)." >&2
  exit 2
fi

SRC="$ROOT/packages/superclaw/src"
# The `superclaw` console-script lives next to the interpreter; PYTHONPATH=$SRC
# (set below) makes its `import superclaw` resolve to THIS tree, not wherever the
# editable install points. Fall back to `-m superclaw` if the script is absent.
SUPER_BIN="$(dirname "$PY")/superclaw"
if [ -x "$SUPER_BIN" ]; then
  SUPER=("$SUPER_BIN")
else
  SUPER=("$PY" -m superclaw)
fi

PORT="${TELEMETRY_E2E_PORT:-8911}"
INGEST_TOKEN="e2e-ingest-$$"
QUERY_TOKEN="e2e-query-$$"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tele-e2e.XXXXXX")"
SERVER_DB="$WORK/collector.db"
CLIENT_HOME="$WORK/client-home"
SERVER_LOG="$WORK/server.log"
mkdir -p "$CLIENT_HOME"

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; echo "--- server log ---" >&2; tail -20 "$SERVER_LOG" >&2 2>/dev/null; exit 1; }

echo "==> starting collection server on 127.0.0.1:$PORT (sqlite=$SERVER_DB)"
TELEMETRY_DATABASE_URL="sqlite:///$SERVER_DB" \
TELEMETRY_INGEST_TOKEN="$INGEST_TOKEN" \
TELEMETRY_QUERY_TOKEN="$QUERY_TOKEN" \
TELEMETRY_HOST=127.0.0.1 TELEMETRY_PORT="$PORT" TELEMETRY_ENV=local \
PYTHONPATH="$ROOT" \
  "$PY" -m uvicorn --factory apps.telemetry_server.main:create_app \
    --host 127.0.0.1 --port "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

echo "==> waiting for health"
ready=""
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/v1/telemetry/health" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then fail "server process died during startup"; fi
  sleep 0.25
done
[ -n "$ready" ] || fail "server did not become healthy in time"

echo "==> seeding one cost_event (Tier A) + one receipt (Tier B) into the client"
SUPERCLAW_HOME="$CLIENT_HOME" PYTHONPATH="$SRC" "$PY" - <<'PYEOF' || fail "seed failed"
import inspect
from superclaw.cli import _state_path
from superclaw.state import StateStore
from superclaw.models import CostEvent
from superclaw.diagnostics_store import DiagnosticsStore, resolve_telemetry_path

st = StateStore(_state_path())
sig = inspect.signature(CostEvent)
kw = {
    "idempotency_key": "e2e-1", "run_id": "run_e2e_smoke",
    "model": "claude-opus-4-8", "input_tokens": 321, "output_tokens": 123,
    "cost_cents": 8, "status": "completed",
}
st.record_cost_event(CostEvent(**{k: v for k, v in kw.items() if k in sig.parameters}))
print("  seeded Tier A run_e2e_smoke into", _state_path())

ds = DiagnosticsStore(resolve_telemetry_path())
ds.record(
    "governance.decision",
    {"decision": "denied", "tool_name": "shell", "reason": "scan_blocked"},
    critical=True,
)
ds.close()
print("  seeded Tier B governance.decision into", resolve_telemetry_path())
PYEOF

echo "==> CLI: enable consent + spool (real httpx upload)"
export SUPERCLAW_HOME="$CLIENT_HOME"
export SUPERCLAW_TELEMETRY_ENDPOINT="http://127.0.0.1:$PORT"
export SUPERCLAW_TELEMETRY_TOKEN="$INGEST_TOKEN"
export PYTHONPATH="$SRC"

"${SUPER[@]}" telemetry enable --agreement-version e2e-smoke >/dev/null || fail "telemetry enable failed"
SPOOL_OUT="$("${SUPER[@]}" telemetry spool --drain)" || fail "telemetry spool failed"
echo "  spool -> $SPOOL_OUT"
# One Tier A batch (1 cost row) + one Tier B batch (1 receipt row) = 2 batches / 2 rows.
case "$SPOOL_OUT" in
  *"batches=2 rows=2"*) : ;;
  *) fail "unexpected spool result: $SPOOL_OUT" ;;
esac

echo "==> asserting the row landed in the server DB (operator query)"
QUERY_OUT="$(curl -fsS -H "Authorization: Bearer $QUERY_TOKEN" \
  "http://127.0.0.1:$PORT/api/query?tier=A&limit=10")" || fail "query failed"
echo "  query -> $QUERY_OUT"
printf '%s' "$QUERY_OUT" >"$WORK/query.json"
QUERY_JSON="$WORK/query.json" WANT="run_e2e_smoke" "$PY" - <<'PYEOF' || fail "row not found in server DB"
import json, os
want = os.environ["WANT"]
with open(os.environ["QUERY_JSON"], encoding="utf-8") as fh:
    data = json.load(fh)
rows = data.get("rows", [])
hit = next((r for r in rows if r.get("run_id") == want), None)
if hit is None:
    print(f"  run_id {want!r} NOT in server DB ({data.get('count')} rows)")
    raise SystemExit(1)
assert hit["model"] == "claude-opus-4-8", hit
assert hit["cost_cents"] == 8.0, hit
print(f"  pass: {want} present (model={hit['model']} cost_cents={hit['cost_cents']})")
PYEOF

echo "==> asserting the Tier B receipt landed and mapped correctly"
TB_OUT="$(curl -fsS -H "Authorization: Bearer $QUERY_TOKEN" \
  "http://127.0.0.1:$PORT/api/query?tier=B&limit=10")" || fail "tier-B query failed"
echo "  query -> $TB_OUT"
printf '%s' "$TB_OUT" >"$WORK/query_b.json"
QUERY_JSON="$WORK/query_b.json" "$PY" - <<'PYEOF' || fail "Tier B receipt not found / mismapped"
import json, os
with open(os.environ["QUERY_JSON"], encoding="utf-8") as fh:
    data = json.load(fh)
rows = data.get("rows", [])
hit = next((r for r in rows if r.get("kind") == "governance.decision"), None)
if hit is None:
    print(f"  governance.decision NOT in server tier_b ({data.get('count')} rows)")
    raise SystemExit(1)
assert hit["decision_code"] == "denied", hit
assert hit["summary"] == "scan_blocked", hit
assert hit["receipt_class"] == "critical", hit
print(f"  pass: governance.decision present (decision_code={hit['decision_code']} summary={hit['summary']})")
PYEOF

echo "==> verifying auth gate (no token must be rejected)"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/stats")"
[ "$CODE" = "401" ] || fail "expected 401 for unauthenticated query, got $CODE"
echo "  ✓ unauthenticated query rejected (401)"

echo ""
echo "PASS: telemetry link is live end-to-end (real CLI -> real httpx -> real server -> real DB)"
