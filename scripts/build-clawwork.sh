#!/usr/bin/env bash
# Build the internalized ClawWork harness, vendored at third_party/clawwork.
#
# ClawWork is a hard fork of earendil-works/pi v0.79.1, maintained inside
# SuperClaw (see third_party/clawwork/NOTICE). node_modules/ and dist/ are
# gitignored, so a fresh checkout must build the harness once before the
# ClawWork backend can spawn it. The backend then auto-discovers the bundled
# binary — no SUPERCLAW_CLAWWORK_EXECUTABLE / _GOVERNANCE_EXT wiring needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$ROOT/third_party/clawwork"

if [ ! -d "$HARNESS" ]; then
  echo "error: bundled harness not found at $HARNESS" >&2
  exit 1
fi

cd "$HARNESS"
echo "==> npm ci  ($HARNESS)"
npm ci

# Build each workspace in dependency order. CRITICAL: do NOT run the root
# `npm run build` — the `ai` package's build runs generate-models /
# generate-image-models, which fetch the catalog from the network (models.dev /
# OpenRouter / AI Gateway) and OVERWRITE the committed v0.79.1 models snapshot,
# silently changing the model catalog on every build (and shrinking it on a
# network failure). Compile `ai` from the COMMITTED generated catalog instead
# (tsgo only) so the build is offline-stable and reproducible. To intentionally
# refresh the catalog, run the generate scripts explicitly and commit the diff.
# Dependency order matters: `agent` and `coding-agent` import from `ai`
# (@earendil-works/pi-ai/*), so `ai` MUST be compiled to dist BEFORE `agent` —
# otherwise agent's tsgo fails with "Cannot find module '@earendil-works/pi-ai/base'"
# and a cascade of unresolved-type errors. `tui` is independent.
echo "==> build tui / ai (compile-only, no model regen) / agent / coding-agent"
( cd packages/tui && npm run build )
( cd packages/ai && npx tsgo -p tsconfig.build.json )
( cd packages/agent && npm run build )
( cd packages/coding-agent && npm run build )

# The build output (dist/cli.js) is the reliable artifact — the workspace bin
# symlink node_modules/.bin/clawwork is often absent on a fresh checkout (npm
# only links it when dist already exists at install time). The backend resolves
# the same dist/cli.js, so verify THAT.
CLI="$HARNESS/packages/coding-agent/dist/cli.js"
if [ ! -x "$CLI" ]; then
  echo "error: build finished but $CLI is missing or not executable" >&2
  exit 1
fi
echo "OK: ClawWork harness built — $("$CLI" --version)"
echo "The ClawWork backend auto-discovers it; run \`superclaw doctor\` to confirm."

# --- Node control-plane adapters (server/) ---
# `pnpm install` only LINKS workspace packages; it does NOT compile them, so a fresh
# checkout Node server crashes with ERR_MODULE_NOT_FOUND importing an adapter dist.
# Build the adapter packages so `superclaw service` can co-launch Node out of the box.
SERVER="$ROOT/server"
if [ -d "$SERVER" ] && command -v pnpm >/dev/null 2>&1; then
  echo "==> build Node control-plane adapters ($SERVER)"
  ( cd "$SERVER" && pnpm install --frozen-lockfile && pnpm --filter "@paperclipai/adapter-*..." build )
  echo "OK: Node adapter dist built"
else
  echo "note: skipping Node adapter build (server/ missing or pnpm not on PATH)" >&2
fi
