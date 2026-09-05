#!/bin/sh
# Cloud Run entrypoint for the Node-on image (B2).
#
# `superclaw service` co-launches the Node control plane + gateway as CHILD processes whose
# stdout/stderr go to log FILES under the run dir (node-server.log etc.) — invisible to Cloud Run,
# which only captures the main process's stdout/stderr. This wrapper tails those Node logs to stdout
# so control-plane / gateway startup, migrations and crashes are observable in Cloud Run logs, then
# exec's the service as PID 1 (so signals/teardown behave). A one-time startup check confirms the
# node binary + built artifacts are present.
set -e

STATE_PATH="${SUPERCLAW_STATE_PATH:-/data/superclaw.db}"
RUN_DIR="$(dirname "$STATE_PATH")/run"
mkdir -p "$RUN_DIR"

# Cloud SQL Auth Proxy for durable state. The control plane reads DATABASE_URL (which the
# service binds from the PAPERCLIP_DATABASE_URL secret) and that URL targets 127.0.0.1:5432,
# so the proxy must be listening BEFORE the Node child dials the DB or it dies on
# "ECONNREFUSED 127.0.0.1:5432" and the whole control plane refuses to boot.
#
# Fail CLOSED when a DB was actually requested: if DATABASE_URL is set we require the proxy to
# accept connections, because falling through would silently start on ephemeral PGlite and
# quietly serve an EMPTY world that looks fine but loses every write on restart. With no
# CLOUD_SQL_INSTANCE we skip the proxy entirely (PGlite path, unchanged).
if [ -n "$CLOUD_SQL_INSTANCE" ]; then
  echo "[entrypoint] starting cloud-sql-proxy for ${CLOUD_SQL_INSTANCE} on 127.0.0.1:5432"
  cloud-sql-proxy --address 127.0.0.1 --port 5432 "$CLOUD_SQL_INSTANCE" 2>&1 | sed 's/^/[sql-proxy] /' &
  i=0
  until python3 -c "import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(0 if s.connect_ex(('127.0.0.1',5432))==0 else 1)" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 45 ]; then
      echo "[entrypoint] cloud-sql-proxy did NOT accept connections after ${i}s"
      if [ -n "$DATABASE_URL" ]; then
        echo "[entrypoint] DATABASE_URL is set -> refusing to start on ephemeral storage. Exiting."
        exit 1
      fi
      echo "[entrypoint] no DATABASE_URL -> continuing on the PGlite path"
      break
    fi
    sleep 1
  done
  # Must be an if/fi, not `[ ] && echo`: under `set -e` a false test as the last command
  # of the block would exit the container instead of continuing on the PGlite path.
  if [ "$i" -lt 45 ]; then
    echo "[entrypoint] cloud-sql-proxy accepting connections on 127.0.0.1:5432 (after ${i}s)"
  fi
fi

echo "[entrypoint] node:            $(command -v node || echo MISSING) $(node --version 2>&1 || true)"
echo "[entrypoint] control-plane:   $(ls -l /app/server/server/dist/index.js 2>&1 || true)"
echo "[entrypoint] gateway:         $(ls -l /app/apps/gateway/dist/index.js 2>&1 || true)"
echo "[entrypoint] run dir:         $RUN_DIR"

# One-line sidecar resolution check. start_node_sidecar_if_enabled's own fail-open warnings are
# emitted BEFORE create_app configures logging, so they never reach Cloud Run — surface the decision
# inputs here instead (this is how the "mode='off'" service-env override was caught). Best-effort.
python3 -c "
from superclaw import node_runtime as nr
print('[diag] mode=%r server_dir=%r node_bin=%r' % (nr.node_server_mode(), nr.resolve_node_server_dir(), nr.resolve_node_executable()))
" 2>&1 || true

# Robustly surface each Node log: wait until it is non-empty, DUMP it in full (tail -F raced the
# file's creation and missed the boot output), then follow new lines. Guarantees the boot crash is
# visible in Cloud Run logs.
dump_and_follow() {
  logfile="$1"; tag="$2"
  ( i=0
    while [ ! -s "$logfile" ] && [ "$i" -lt 40 ]; do sleep 1; i=$((i + 1)); done
    echo "[$tag] ===== $logfile (bytes=$(wc -c < "$logfile" 2>/dev/null || echo 0)) ====="
    sed "s/^/[$tag] /" "$logfile" 2>/dev/null || true
    tail -n0 -f "$logfile" 2>/dev/null | sed "s/^/[$tag] /"
  ) &
}
dump_and_follow "$RUN_DIR/node-server.log" node-log
dump_and_follow "$RUN_DIR/gateway.log" gw-log

exec superclaw service --host 0.0.0.0 --port 8080 --sidecar-host 127.0.0.1 --log-level info
