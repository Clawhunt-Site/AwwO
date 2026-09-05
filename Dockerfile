# SuperClaw canvas — Cloud Run deployable (Stage 2: Python front door + web UI + Node control
# plane + gateway ON, so the unified Studio canvas projects REAL companies and hire/dispatch/chat
# reach a live backend).
#
# Serving model: the Python front door (apps.api.main, uvicorn :8080) is the public bind. It
# reverse-proxies /paperclip-api → the vendored Node control plane (127.0.0.1:3100) and
# /gateway-api → the automation gateway (127.0.0.1:8796); both proxies are marker-gated + fail-
# closed (503 when Node is down, never falling through to the legacy Python engine). The Node
# sidecars are co-launched by `superclaw service` (SUPERCLAW_NODE_SERVER/SUPERCLAW_GATEWAY=on).
# The control plane runs on in-process PGlite (auto-selected by the supervisor for a fresh install
# with no legacy cluster) — no native postmaster, boots in seconds, auto-applies migrations.
# --sidecar-host 127.0.0.1 keeps the control plane on loopback (it refuses non-loopback in
# local_trusted mode) while uvicorn serves 0.0.0.0.
#
# State (SQLite + the PGlite datadir under /data) is EPHEMERAL on Cloud Run — accepted for a test
# deploy; a fresh revision starts with an empty company world until companies are created.
# Deploy-side (not baked): --set-secrets for the relay/Anthropic key (real agent RUNS), and
# --memory 2Gi --cpu 2 (Node + PGlite + Python co-resident). Startup probe: TCP :8080 (uvicorn) —
# Node readiness is independent, proxied prefixes 503 until it's up.

# ---- Stage 1: node build — apps/web + Node control plane (server/server) + gateway ----
FROM node:22-bookworm-slim AS nodebuild
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# server workspace: install once, then build the control plane + its workspace deps only
# (--filter "@paperclipai/server..." = that package AND its dependencies — avoids building the
# unrelated ui/cli/plugin workspaces). apps/web's vite ALSO reads ../../server/ui/{src,node_modules}
# at config-load, so this same install satisfies the web build below.
COPY server /app/server
RUN pnpm -C server install --frozen-lockfile
RUN pnpm -C server --filter "@paperclipai/server..." run build
# Every @paperclipai/* workspace package exposes DEV entry points (exports -> ./src/*.ts) and keeps
# its production ones in publishConfig (exports -> ./dist/*.js), which pnpm applies only on
# publish/deploy. We copy the RAW workspace into the runtime, so without this `node dist/index.js`
# resolves @paperclipai/db to TypeScript SOURCE and dies:
#   ERR_MODULE_NOT_FOUND: Cannot find module '.../packages/db/src/client.js'
#     imported from '.../packages/db/src/index.ts'
# Apply each package's own publishConfig in place (build-time only; the repo's vendored server/ tree
# is untouched) so every workspace dep resolves to its BUILT output. Fail-closed: exits 1 if it
# patches nothing.
COPY scripts/apply-workspace-publish-config.mjs /app/scripts/apply-workspace-publish-config.mjs
RUN node /app/scripts/apply-workspace-publish-config.mjs /app/server

# apps/web build: needs node_routes.json (vite config-load gate) and nothing else. It used to also
# need the sibling fleet-canvas / creative-canvas embed SOURCES; the session-canvas rebuild made
# apps/web self-contained (src/canvas/ owns the whole surface), so those COPYs are gone.
# (apps/creative-canvas still exists for the myshell orchestrator, which copies it in its own image.)
COPY packages/superclaw/src/superclaw/node_routes.json /app/packages/superclaw/src/superclaw/node_routes.json
COPY apps/web /app/apps/web
RUN npm ci --prefix apps/web
RUN npm run build --prefix apps/web

# gateway build (standalone npm project; only prod dep is express). Install (incl. tsc/tsx dev deps)
# and build to dist/index.js; the small node_modules is carried to the runtime as-is.
COPY apps/gateway /app/apps/gateway
RUN npm install --prefix apps/gateway
RUN npm run build --prefix apps/gateway

# Claude Code CLI — the control plane's claude_local adapter SPAWNS the `claude` binary for chat /
# agent runs; without it every claude_local run dies with `Command not found in PATH: "claude"`.
# Installed globally here and copied into the runtime stage (which has node but no npm). Auth needs
# nothing baked: the adapter routes the CLI through the ClawHunt relay by default using the
# SUPERCLAW_RELAY_* env the supervisor injects (adapters/claude-local execute.ts relay-by-default).
RUN npm install -g @anthropic-ai/claude-code \
  && /usr/local/bin/claude --version

# ---- Stage 2: Python runtime + Node ----
FROM python:3.12-slim

# Node 22 runtime: copy the binary from the matching bookworm-slim image + the one shared lib it
# needs beyond python-slim's base (libstdc++6). No npm/node_modules global needed at runtime.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
# git: the Claude CLI (and other local agent CLIs) shell out to it for repo work; ca-certificates
# for their HTTPS; procps (ps) for process supervision niceties.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libstdc++6 git ca-certificates procps curl \
  && rm -rf /var/lib/apt/lists/* \
  && node --version

# Cloud SQL Auth Proxy — the durable-state path. The control plane picks its DB in
# server/server/src/index.ts: an external Postgres if DATABASE_URL is set, else in-process
# PGlite (which is EPHEMERAL: every revision restart wipes the whole world). The stored
# PAPERCLIP_DATABASE_URL secret targets 127.0.0.1:5432, so durable state needs something
# listening there. Two alternatives were ruled out by testing the real image in a Cloud Run
# Job: Cloud Run's /cloudsql unix-socket mount is rejected by the code's own URL parser
# ("TypeError: Invalid URL" in packages/db inspectMigrations), and rewriting the secret to a
# socket/TCP form would mean handling the DB password by hand. Running the proxy in-container
# keeps the existing secret correct as-is. Auth is ADC via the runtime service account
# (needs roles/cloudsql.client); the entrypoint starts it only when CLOUD_SQL_INSTANCE is set,
# so an unset instance still falls back to PGlite rather than dying.
RUN curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
  https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.linux.amd64 \
  && chmod +x /usr/local/bin/cloud-sql-proxy \
  && cloud-sql-proxy --version

# Claude Code CLI from the build stage: the global package + npm's own bin link, copied verbatim
# (same /usr/local layout, so a relative symlink still resolves — no hand-crafted paths that a CLI
# release could silently break). `claude --version` fail-closes the image if the copy is ever
# incomplete. claude_local runs then work in-container via the relay creds the supervisor injects —
# no interactive login, no baked secrets.
COPY --from=nodebuild /usr/local/lib/node_modules/@anthropic-ai /usr/local/lib/node_modules/@anthropic-ai
COPY --from=nodebuild /usr/local/bin/claude /usr/local/bin/claude
RUN claude --version

WORKDIR /app
COPY pyproject.toml README.md /app/
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
COPY packages /app/packages
COPY apps /app/apps
# Built web SPA + the Node control plane (built dist + workspace node_modules — pnpm symlinks
# preserved within /app/server) + the built gateway (dist + node_modules overlaid on its source).
COPY --from=nodebuild /app/apps/web/dist /app/apps/web/dist
COPY --from=nodebuild /app/server /app/server
COPY --from=nodebuild /app/apps/gateway/dist /app/apps/gateway/dist
COPY --from=nodebuild /app/apps/gateway/node_modules /app/apps/gateway/node_modules
RUN pip install --no-cache-dir -e .

# Run as a NON-ROOT user: the Claude Code CLI hard-refuses `--dangerously-skip-permissions` under
# root ("cannot be used with root/sudo privileges for security reasons"), which is exactly how the
# claude_local adapter invokes it — so as root every chat/agent run failed with exit code 1. A
# non-root uid makes the CLI run. Every writable path is pinned under /data (state db, run-dir
# markers, the pglite datadir via SUPERCLAW_NODE_HOME, artifacts) and /data is chowned to the user,
# so nothing needs to write the root-owned /app tree at runtime.
RUN useradd --create-home --uid 1001 appu \
  && mkdir -p /data /data/node-runtime /data/artifacts \
  && chown -R appu:appu /data

ENV APP_ENV=production
ENV HOME=/home/appu
ENV SUPERCLAW_STATE_PATH=/data/superclaw.db
ENV SUPERCLAW_NODE_HOME=/data/node-runtime
ENV SUPERCLAW_ARTIFACT_DIR=/data/artifacts
ENV SUPERCLAW_EVAL_ROOT=/data/evals
# /app is root-owned; nothing writes there at runtime, and Python's bytecode cache would try to —
# disable it so a non-root process never trips on an unwritable __pycache__.
ENV PYTHONDONTWRITEBYTECODE=1
# `superclaw service` reaches the FastAPI app via `from apps.api.main import create_app`. Unlike
# the Stage-1 `uvicorn apps.api.main:app` CMD (uvicorn injects cwd into sys.path), a console-script
# entrypoint does not, so /app must be on PYTHONPATH for the `apps` source package to import.
ENV PYTHONPATH=/app
# Turn the Node sidecars ON (control plane defaults to auto; the gateway defaults OFF in a source
# run, so it MUST be enabled explicitly). PGlite + auto-migrate are chosen by the supervisor.
ENV SUPERCLAW_NODE_SERVER=on
ENV SUPERCLAW_GATEWAY=on
# Pin the sidecar artifact locations explicitly (a container is not a source checkout to walk up,
# nor a frozen bundle): the built control plane, the node binary, and the built gateway.
ENV SUPERCLAW_NODE_SERVER_DIR=/app/server/server
ENV SUPERCLAW_NODE_BIN=/usr/local/bin/node
ENV SUPERCLAW_GATEWAY_DIR=/app/apps/gateway
EXPOSE 8080
# Drop to the non-root user for the actual runtime (see the useradd block above): required so the
# claude_local adapter's `claude --dangerously-skip-permissions` does not hit the root guard.
USER appu
# The entrypoint tails the Node/gateway log files to stdout (Cloud Run observability) then exec's
# `superclaw service` (uvicorn on 0.0.0.0:8080; Node control plane + gateway on loopback 127.0.0.1).
CMD ["/app/docker-entrypoint.sh"]
