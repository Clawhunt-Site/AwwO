#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUTPUT="$("$ROOT/bin/hello-world" mcp)"
test "$OUTPUT" = '{"text":"hello from SuperClaw"}'
