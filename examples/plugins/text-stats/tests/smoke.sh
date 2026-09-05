#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUTPUT="$("$ROOT/bin/text-stats" mcp)"
test "$OUTPUT" = '{"words":9,"chars":43}'
