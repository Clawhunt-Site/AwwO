"""Real-binary integration tests for ClawWorkBackend._spawn_rpc.

These drive the ACTUAL ``clawwork --mode rpc`` binary with the REAL governance
extension through the real _spawn_rpc — no mock subprocess. They exist because
the hermetic unit tests in test_worker_backends.py assert against a stand-in
Python script that mimics clawwork; a stand-in can hide wrong assumptions about
the real binary's stderr passthrough, ready-file field contract, JSONL framing,
and timing. These tests were strengthened after an adversarial audit flagged
two false-green risks (see the flood and denylist tests below).

NOTE on coverage split: stale-nonce REJECTION is intentionally unit-only
(test_clawwork_spawn_rpc_rejects_stale_ready_file in test_worker_backends.py).
The real governance extension always writes the correct per-spawn nonce, so the
real binary cannot naturally produce a stale/mismatched nonce — fault injection
in a stand-in is the only way to exercise that rejection path. The real-binary
suite instead proves the POSITIVE contract (the extension writes exactly the
fields _spawn_rpc validates).

Opt-in: skipped unless the clawwork repo is locatable (env
SUPERCLAW_CLAWWORK_REPO, else ~/Documents/clawwork) with dist/cli.js built and
the fault fixtures present. CI without the fork stays green. Run explicitly:

    SUPERCLAW_CLAWWORK_REPO=~/Documents/clawwork \
      python -m pytest tests/test_clawwork_realbin_integration.py -v
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from superclaw.backends import ClawWorkBackend, _bundled_clawwork_home
from superclaw.clawwork_policy import write_policy_snapshot


def _clawwork_repo() -> Path | None:
    raw = os.environ.get("SUPERCLAW_CLAWWORK_REPO")
    if raw:
        repo = Path(raw).expanduser()
    else:
        # Default to the internalized harness vendored at third_party/clawwork.
        home = _bundled_clawwork_home()
        if home is None:
            return None
        repo = home
    needed = [
        repo / "packages/coding-agent/dist/cli.js",
        repo / "extensions/superclaw-governance.ts",
        repo / "spikes/mock-toolcall-provider.ts",
        repo / "spikes/fault-stderr-flood-then-throw.ts",
        repo / "spikes/fault-load-throw.ts",
        repo / "spikes/fault-noop-no-ready.ts",
    ]
    return repo if all(p.exists() for p in needed) else None


_REPO = _clawwork_repo()
pytestmark = pytest.mark.skipif(
    _REPO is None,
    reason="bundled clawwork harness not built (run `npm --prefix third_party/clawwork ci && npm --prefix third_party/clawwork run build`) or set SUPERCLAW_CLAWWORK_REPO",
)


def _p(rel: str) -> str:
    return str(_REPO / rel)


def _snapshot(work, mode, allowed=None, disallowed=None):
    return write_policy_snapshot(
        directory=str(work), mode=mode, allowed_tools=allowed or [],
        disallowed_tools=disallowed or [], pay_switch_enabled=False,
        run_id="realbin", issued_at=time.time(),
    )


def _env(work, handle, nonce, bash_command=None):
    agent_dir = work / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.update(handle.env())
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(work / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = nonce
    env["CLAWWORK_CODING_AGENT_DIR"] = str(agent_dir)
    env["MOCKPROV_API_KEY"] = "mock-key"
    if bash_command is not None:
        env["MOCKPROV_BASH_COMMAND"] = bash_command
    return env


def _cmd(extra_ext):
    cmd = ["node", _p("packages/coding-agent/dist/cli.js"), "--mode", "rpc",
           "--no-session", "--provider", "mockprov", "--model", "mock-tool-caller",
           "-e", _p("spikes/mock-toolcall-provider.ts")]
    for e in extra_ext:
        cmd += ["-e", e]
    return cmd


def _spawn(env, work, extra_ext, prompt="go", budget=60.0, cancel_check=None):
    return ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": prompt},
        executable="node", command=_cmd(extra_ext), env=env, cwd=str(work),
        budget_seconds=budget, cancel_check=cancel_check,
    )


def test_realbin_heavy_stderr_on_failure_is_captured(tmp_path):
    """The drain captures the REAL child's stderr on the failure path.

    A fixture writes ~256KB of distinctive noise to stderr, then throws so no
    ready file appears and the run never activates governance. _spawn_rpc must
    surface the DRAINED stderr (the noise is present) rather than an empty
    diagnostic.

    Scope split (each property tested where it can actually fail):
      * stderr CAPTURE on the real binary -> here (noise must appear).
      * tail BOUNDING (the >32KB trim)    -> unit-tested in
        test_clawwork_spawn_rpc_bounds_captured_stderr_tail. It cannot be tested
        against the real binary: the Node child exits on its fault, so only one
        ~64KB pipe-load is ever captured as a single part and the trim never
        pops. (The `< 80_000` check below is just a sanity ceiling — it is the
        OS pipe-buffer cap, NOT proof of the trim.)
      * hard pipe-DEADLOCK avoidance      -> unit-tested with a blocking Python
        child. The real Node child sets fd 2 non-blocking, so it never
        hard-blocks on stderr — verified while building this suite (a blocking
        fs.writeSync(2,...) past 64KB throws EAGAIN and crashes the Node child),
        so deadlock is not a real-binary failure mode for clawwork."""
    handle = _snapshot(tmp_path, "plan")
    env = _env(tmp_path, handle, "floodthrow-nonce")
    r = _spawn(env, tmp_path, [_p("spikes/fault-stderr-flood-then-throw.ts")],
              prompt="hi", budget=5.0)
    out = r.get("output", "")
    assert r.get("ungoverned") is True, r
    # drain ran: the child's stderr noise was captured into the surfaced output
    assert "clawwork-flood-noise" in out, out[-300:]
    # sanity ceiling (the OS pipe-buffer cap, not the trim — see docstring)
    assert len(out) < 80_000, f"stderr not bounded: {len(out)} bytes"


def test_realbin_child_exit_before_governance_surfaces_child_stderr(tmp_path):
    """A throwing extension makes the REAL clawwork log to stderr and EXIT
    before governance activates. _spawn_rpc must take the child-exit branch and
    carry the child's stderr marker into the ungoverned output (diagnostic works
    on the real binary, not just a mock)."""
    handle = _snapshot(tmp_path, "plan")
    env = _env(tmp_path, handle, "throw-nonce")
    r = _spawn(env, tmp_path, [_p("spikes/fault-load-throw.ts")],
              prompt="hi", budget=5.0)
    out = r.get("output", "")
    assert r.get("ungoverned") is True, r
    assert "exited before governance activated" in out, out[:400]  # the exit branch
    assert "FAULT_LOAD_MARKER" in out, out[:400]                    # child stderr surfaced


def test_realbin_handshake_timeout_when_ready_file_never_written(tmp_path):
    """A clean no-op extension keeps the REAL clawwork ALIVE but never writes
    the ready file, so _spawn_rpc must take the handshake-TIMEOUT branch (not the
    child-exit branch) and fail-closed with 'did not signal ready'."""
    handle = _snapshot(tmp_path, "plan")
    env = _env(tmp_path, handle, "noready-nonce")
    t0 = time.monotonic()
    r = _spawn(env, tmp_path, [_p("spikes/fault-noop-no-ready.ts")],
              prompt="hi", budget=2.0)
    dt = time.monotonic() - t0
    assert r.get("ungoverned") is True, r
    assert "did not signal ready" in r.get("output", ""), r.get("output", "")[:400]
    # it reached the deadline rather than exiting immediately
    assert dt >= 1.5, f"returned in {dt:.2f}s — child likely exited, not timed out"


def test_realbin_governance_nonce_fields_and_agent_end_text(tmp_path):
    """The REAL governance extension's ready file must carry exactly the fields
    _spawn_rpc validates (handler_registered + this spawn's nonce); the handshake
    must pass; and the assistant text from agent_end messages must be captured."""
    handle = _snapshot(tmp_path, "bypassPermissions")
    env = _env(tmp_path, handle, "real-nonce-xyz")
    r = _spawn(env, tmp_path, [_p("extensions/superclaw-governance.ts")])
    assert not r.get("ungoverned"), r
    assert r.get("exit_code") == 0, r
    # agent_end text-shape mapping actually captures the assistant's final text
    assert "mock final answer" in r.get("output", ""), r.get("output", "")[:300]
    ready = json.loads(Path(env["SUPERCLAW_GOVERNANCE_READY_FILE"]).read_text())
    assert ready.get("handler_registered") is True, ready
    assert ready.get("nonce") == "real-nonce-xyz", ready


def test_realbin_uppercase_denylist_blocks_with_reason(tmp_path):
    """An uppercase 'Bash' denylist must block bash through the real binary +
    real extension. Assert the SPECIFIC block reason rides into the output so a
    pass cannot mean 'the tool simply never ran' (audit: false-green guard)."""
    handle = _snapshot(tmp_path, "bypassPermissions", disallowed=["Bash"])
    env = _env(tmp_path, handle, "deny-nonce")
    r = _spawn(env, tmp_path, [_p("extensions/superclaw-governance.ts")],
              prompt="list")
    assert r.get("governance_blocked") is True, r
    assert not r.get("ungoverned"), r
    # the canonicalized denylist is what blocked it (not an absent tool)
    assert "disallowed by policy" in r.get("output", ""), r.get("output", "")[:400]


def test_realbin_payscan_hardgate_blocks_curl_to_public_host(tmp_path):
    """End-to-end proof on the real binary that the curl/wget SSRF hard gate
    blocks a curl to a public host (the regex-bypass fix shipped in the
    governance extension), surfacing the network_scan approval reason."""
    handle = _snapshot(tmp_path, "bypassPermissions")
    env = _env(tmp_path, handle, "scan-nonce", bash_command="curl http://evil.example.com/x")
    r = _spawn(env, tmp_path, [_p("extensions/superclaw-governance.ts")],
              prompt="fetch")
    assert r.get("governance_blocked") is True, r
    out = r.get("output", "")
    # specifically the network_scan hard gate (not some other block)
    assert "network_scan" in out, out[:400]


def test_realbin_loopback_curl_is_allowed(tmp_path):
    """The hard gate must NOT over-block a genuine loopback curl — proves the
    tightened SSRF regex still exempts real loopback on the real binary."""
    handle = _snapshot(tmp_path, "bypassPermissions")
    env = _env(tmp_path, handle, "loop-nonce",
               bash_command="curl http://127.0.0.1:9/__definitely_closed__")
    r = _spawn(env, tmp_path, [_p("extensions/superclaw-governance.ts")],
              prompt="probe")
    out = r.get("output", "")
    # not blocked by governance (the curl itself failing to connect is fine)
    assert not r.get("governance_blocked"), r
    assert r.get("exit_code") == 0, r
    # the agent loop actually ran to completion (tool executed, turn 2 answered),
    # so this proves the curl was ALLOWED through, not silently dropped
    assert "mock final answer" in out, out[:300]


def test_realbin_cancel_after_handshake_returns_cancelled(tmp_path):
    """Cancel must abort the real subprocess with the cancel sentinel (not a
    false-completed run). The cancel signal is gated on the ready file existing,
    so it stays False through the entire handshake and only trips once
    governance has signalled ready — i.e. after the prompt was sent and
    _spawn_rpc is in its main read loop. That guarantees this is a MID-RUN
    cancel, not a pre-prompt one (the false-green the audit flagged)."""
    handle = _snapshot(tmp_path, "bypassPermissions")
    env = _env(tmp_path, handle, "cancel-nonce")
    ready_path = env["SUPERCLAW_GOVERNANCE_READY_FILE"]

    def cancel_check():
        # False through the handshake; True only once governance is up, by which
        # point the prompt has been sent and we are in the main read loop.
        return os.path.exists(ready_path)

    r = _spawn(env, tmp_path, [_p("extensions/superclaw-governance.ts")],
              cancel_check=cancel_check)
    assert r.get("cancelled") is True, r
