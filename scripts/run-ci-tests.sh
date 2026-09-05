#!/usr/bin/env bash
#
# Two-phase test runner — the local "full ci.yml" gate, made fast without flaking.
#
# Runs the SAME tests as a plain `pytest -q`, split into two phases:
#
#   Phase 1 (serial):    the subprocess-heavy plugin/signing/sidecar family,
#                        one test at a time — run FIRST, while the machine is
#                        coolest (before the parallel phase heats it up).
#   Phase 2 (parallel):  everything else, under `-n auto --dist worksteal`.
#
# Why split + this order: the plugin / capability / skill family spawns REAL
# signing-crypto and sidecar-MCP subprocesses with tight ~10s wall-clock budgets.
# Under xdist fan-out — OR merely on a host already heated by 16 parallel workers
# — those children get CPU-starved past their budget and flake (PLUGIN_TIMEOUT /
# "sidecar timed out"). Running them serially AND first (coolest machine) keeps
# them green. The rest of the suite is parallel-safe and ~10x faster under xdist.
# (The deeper fix is widening those plugin timeouts so load can't blow them; until
# then, serial-first is the robust local-gate shape.)
#
# On a clean CI runner (idle host) a blanket `-n auto --dist worksteal` would
# likely be green too; this script exists for the local gate on a loaded box.
#
# Usage:
#   scripts/run-ci-tests.sh                # run the whole suite, two-phase
#   SUPERCLAW_TEST_JOBS=8 scripts/run-ci-tests.sh   # cap phase-1 worker count
#
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

JOBS="${SUPERCLAW_TEST_JOBS:-auto}"

# Use the project-local interpreter so the pinned pytest-xdist extra is present.
# Honor an explicit $PYTHON override, else the repo .venv. NEVER silently fall
# back to a system Python: it would likely lack pytest-xdist + the editable
# install and make the local gate lie. Fail closed with guidance instead.
if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif [ -x "$ROOT/.venv/bin/python" ]; then
  PY="$ROOT/.venv/bin/python"
else
  echo "ERROR: no project interpreter found." >&2
  echo "  Set PYTHON=/path/to/python, or create the repo venv:" >&2
  echo "    python -m venv .venv && .venv/bin/pip install -e '.[dev]'" >&2
  echo "  (A bare system Python is refused — it would run the gate without pytest-xdist.)" >&2
  exit 2
fi
# Verify the chosen interpreter actually has pytest-xdist (the pinned dev extra).
if ! "$PY" -c "import xdist" >/dev/null 2>&1; then
  echo "ERROR: $PY lacks pytest-xdist. Install the dev extra: '$PY -m pip install -e .[dev]'." >&2
  exit 2
fi

# The fork-sensitive family that MUST run serially. Intentionally generous (the
# whole plugin/capability/skill family + the few non-plugin files that spawn real
# CLIs/sidecars), so a nondeterministically-flaky sibling can never leak into the
# parallel phase. Serial cost of the whole family is only ~75s.
SERIAL_GLOBS=(
  "tests/test_plugin_"*.py
  "tests/test_capability_"*.py
  "tests/test_skill_"*.py
  "tests/test_relay_key.py"
  "tests/test_evals.py"
  "tests/test_local_agent_runtime.py"
  "tests/test_claude_stream.py"
  "tests/test_external_mcp_plugin.py"
  # Real-binary integration: drives the ACTUAL clawwork --mode rpc subprocess and
  # waits for its RPC response (completion-bound) — must never run in parallel.
  "tests/test_clawwork_realbin_integration.py"
  # Mixed file: the argv-assertion bulk is in-process (fast), but it also keeps
  # real subprocess timeout/cancel/forced-kill + _spawn_rpc liveness tests that
  # are completion-bound. Serialize the whole file per "宁可多放" — the faked
  # bulk still runs fast serially, and no real-subprocess test can leak into the
  # parallel phase.
  "tests/test_worker_backends.py"
  # Diagnostics queue back-pressure: test_diagnostic_drop_on_full_queue_is_counted
  # asserts the writer falls behind and drops are counted; under xdist worksteal
  # the writer thread gets enough CPU to drain the queue (no drop) → false failure.
  # Timing-sensitive, so serialize per the same "宁可多放" rule.
  "tests/test_diagnostics_store.py"
  # Node co-launch: mostly in-process argv/env/marker/gate assertions (fast), but
  # also keeps ONE real-subprocess integration test that spawns a stub server and
  # group-kills it on teardown — completion-bound, so serialize the whole file.
  "tests/test_node_runtime.py"
)

# Expand globs to an existing-file list.
SERIAL_FILES=()
for g in "${SERIAL_GLOBS[@]}"; do
  for f in $g; do
    [ -e "$f" ] && SERIAL_FILES+=("$f")
  done
done

# --ignore each serial file out of the parallel phase.
IGNORE_ARGS=()
for f in "${SERIAL_FILES[@]}"; do
  IGNORE_ARGS+=("--ignore=$f")
done

echo "==> Phase 1/2: serial    (${#SERIAL_FILES[@]} plugin/signing/sidecar files, cool machine first)  [py=$PY]"
"$PY" -m pytest -q -p no:cacheprovider "${SERIAL_FILES[@]}"
rc1=$?

echo "==> Phase 2/2: parallel  (-n ${JOBS} --dist worksteal, excluding ${#SERIAL_FILES[@]} fork-sensitive files)"
"$PY" -m pytest -q -p no:cacheprovider -n "${JOBS}" --dist worksteal "${IGNORE_ARGS[@]}"
rc2=$?

echo "==> Phase 1 exit=${rc1}  Phase 2 exit=${rc2}"
if [ "${rc1}" -eq 0 ] && [ "${rc2}" -eq 0 ]; then
  echo "==> ALL GREEN"
  exit 0
fi
echo "==> FAILURES present (phase1=${rc1} phase2=${rc2})"
exit 1
