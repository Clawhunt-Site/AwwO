#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUTPUT="$("$ROOT/bin/github-scanner" mcp)"
case "$OUTPUT" in
  *'"PLUGIN_CONFIG_REQUIRED"'*) exit 0 ;;
  *) printf '%s\n' "$OUTPUT" >&2; exit 1 ;;
esac
