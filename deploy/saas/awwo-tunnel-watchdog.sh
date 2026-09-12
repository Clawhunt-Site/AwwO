#!/usr/bin/env bash
# AwwO tunnel watchdog.
#
# Why this exists: on 2026-09-10 the QUIC paths for this tunnel failed
# ("timeout: no recent network activity"); connections 0-2 died and never
# re-registered, Cloudflare stopped routing, and awwo.clawhunt.store served 502
# for hours. Nothing noticed, because the cloudflared Prometheus gauge
# `cloudflared_tunnel_ha_connections` still reported 4. The /ready endpoint
# reports the real registration count, so that is what this checks.
#
# It only ever manages the tunnel. If the origin is down the fault is not the
# tunnel, so it logs and leaves the web/API units to their own Restart= policy
# rather than masking a different problem with a tunnel bounce.
set -uo pipefail

TUNNEL_UNIT=${TUNNEL_UNIT:-cloudflared-awwo}
READY_URL=${READY_URL:-http://127.0.0.1:20241/ready}
ORIGIN_URL=${ORIGIN_URL:-http://127.0.0.1:5188/}
ORIGIN_HOST=${ORIGIN_HOST:-awwo.clawhunt.store}
MIN_CONNECTIONS=${MIN_CONNECTIONS:-1}
COOLDOWN_SECONDS=${COOLDOWN_SECONDS:-600}
STATE_FILE=${STATE_FILE:-/run/awwo-tunnel-watchdog.last-restart}
# Optional true end-to-end check. Set EDGE_URL to a path that Cloudflare Access
# does NOT gate (a Bypass policy on e.g. /api/v1/health), or supply Access
# service-token headers in ACCESS_HEADER_FILE (curl -K format, mode 0600).
# Without one of those, no request can pass Access and only local checks run.
EDGE_URL=${EDGE_URL:-}
ACCESS_HEADER_FILE=${ACCESS_HEADER_FILE:-}

log() { logger -t awwo-tunnel-watchdog -- "$*"; echo "awwo-tunnel-watchdog: $*"; }

# The origin must be healthy before any tunnel conclusion is drawn.
origin_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: ${ORIGIN_HOST}" "${ORIGIN_URL}" 2>/dev/null || echo 000)
if [ "${origin_code}" != "200" ]; then
  log "origin ${ORIGIN_URL} returned ${origin_code}; not a tunnel fault, leaving the tunnel alone"
  exit 0
fi

ready_body=$(curl -s --max-time 8 "${READY_URL}" 2>/dev/null || true)
ready_connections=$(printf '%s' "${ready_body}" | grep -o '"readyConnections":[0-9]*' | head -1 | cut -d: -f2)
[ -n "${ready_connections:-}" ] || ready_connections=-1

verdict=ok
if [ "${ready_connections}" -lt 0 ]; then
  verdict="unreachable readiness endpoint"
elif [ "${ready_connections}" -lt "${MIN_CONNECTIONS}" ]; then
  verdict="only ${ready_connections} ready connection(s)"
fi

# An end-to-end check catches the case the local view cannot see: the edge no
# longer routing to a connector that still believes it is registered.
if [ "${verdict}" = ok ] && [ -n "${EDGE_URL}" ]; then
  args=(-s -o /dev/null -w '%{http_code}' --max-time 15)
  [ -n "${ACCESS_HEADER_FILE}" ] && [ -r "${ACCESS_HEADER_FILE}" ] && args+=(-K "${ACCESS_HEADER_FILE}")
  edge_code=$(curl "${args[@]}" "${EDGE_URL}" 2>/dev/null || echo 000)
  case "${edge_code}" in
    2*|3*) : ;;
    *) verdict="edge returned ${edge_code} while the origin is healthy" ;;
  esac
fi

if [ "${verdict}" = ok ]; then
  exit 0
fi

now=$(date +%s)
last=0
[ -r "${STATE_FILE}" ] && last=$(cat "${STATE_FILE}" 2>/dev/null || echo 0)
case "${last}" in ''|*[!0-9]*) last=0 ;; esac
if [ $((now - last)) -lt "${COOLDOWN_SECONDS}" ]; then
  log "would restart ${TUNNEL_UNIT} (${verdict}) but a restart happened $((now - last))s ago; waiting out the ${COOLDOWN_SECONDS}s cooldown"
  exit 0
fi

log "restarting ${TUNNEL_UNIT}: ${verdict} (origin is healthy)"
printf '%s\n' "${now}" > "${STATE_FILE}"
systemctl restart "${TUNNEL_UNIT}"
sleep 12
after=$(curl -s --max-time 8 "${READY_URL}" 2>/dev/null | grep -o '"readyConnections":[0-9]*' | head -1 | cut -d: -f2)
log "after restart readyConnections=${after:-unknown}"
