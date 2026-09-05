#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUTPUT="$("$ROOT/bin/repo-scanner" mcp "$ROOT/tests/fixture-repo")"
case "$OUTPUT" in
  *'"finding_count":0'*) exit 0 ;;
  *) printf '%s\n' "$OUTPUT" >&2; exit 1 ;;
esac
