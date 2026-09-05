# @superclaw/gateway

SuperClaw's Node front door. It is the external listen surface for the
SuperClaw backend and proxies to the vendored upstream server (`server/`) as a
**loopback-only internal dependency**.

See `docs/super-node-server-migration-basis.md` for the full layered design.
This package is **layer L1** (and the boundary to L3). It is the Node successor
to the Python `apps/api` front door, built **alongside** it during the
migration — nothing in the vendored `server/` tree is modified.

## Status: P0 (接电 / wiring)

P0 establishes the topology only:

- the gateway binds the external surface (default `127.0.0.1:8788`, mirroring the
  Python `superclaw service` default);
- it proxies `/health` to an **externally-started** loopback upstream and returns
  an aggregated payload that mirrors the Python `/health` shape plus upstream
  reachability — the end-to-end "接电" proof;
- every upstream address (host, probe URL, health path) is asserted **loopback /
  path-only** at config load (fail-closed): the upstream must never be directly
  reachable, so SuperClaw governance gates can sit in front of it (added in P1).

**Out of P0 scope (deferred to P0.5):** the gateway spawning and supervising the
upstream lifecycle. That needs a readiness + port-identity handshake to be
fail-closed (the vendored server auto-drifts its port via `detectPort` when the
requested one is busy), so a half-built supervisor is intentionally left out. For
now, start the upstream out-of-band (e.g. `pnpm -C server start`, bound to
loopback) and point the gateway at it.

Governance (P1), the execution adapter (P2), the super data store (P3) and the
super-only domains (P4: relay/fusion/media/evals/clawhunt/marketplace/preview/
harnesses/onboarding/desktop) all land in this gateway in later phases.

## Configuration (env, neutral names, fail-closed)

| Variable | Default | Notes |
|---|---|---|
| `SUPERCLAW_GATEWAY_HOST` | `127.0.0.1` | external bind host |
| `SUPERCLAW_GATEWAY_PORT` | `8788` | external bind port |
| `SUPERCLAW_GATEWAY_UPSTREAM_HOST` | `127.0.0.1` | upstream host (**must be loopback**) |
| `SUPERCLAW_GATEWAY_UPSTREAM_PORT` | `3100` | upstream port (vendored default) |
| `SUPERCLAW_GATEWAY_UPSTREAM_URL` | `http://<host>:<port>` | overrides the derived upstream URL; **its host is still asserted loopback** |
| `SUPERCLAW_GATEWAY_UPSTREAM_HEALTH_PATH` | `/api/health` | upstream health route (vendored mounts it under `/api`); **must be a server-rooted path**, never a URL |
| `SUPERCLAW_GATEWAY_UPSTREAM_TIMEOUT_MS` | `15000` | per-request upstream timeout |

## Scripts

```bash
npm install
npm test        # vitest (unit + app-level, no real upstream needed)
npm run typecheck
npm run build   # tsc -> dist/
npm run dev     # tsx src/index.ts
```
