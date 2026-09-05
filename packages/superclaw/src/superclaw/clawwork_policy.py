"""ClawWork policy snapshot (D4): one policy, two executors.

SuperClaw's permission/governance policy is defined ONCE in this Python kernel
and enforced in two places — the Python ``backends.py`` worker backends, and the
TypeScript ``superclaw-governance`` extension running inside ClawWork. Because
ClawWork is a separate process (and a separate language), the kernel cannot call
into it per tool; instead it serializes the policy into a signed JSON snapshot
the extension loads at startup and evaluates locally (zero per-call network hop).

The snapshot is the serializable form of the same posture the in-process
``_RealToolExecution`` backends enforce: permission mode, tool allow/deny lists,
and the pay-switch flag. It is HMAC-signed with a per-run secret so a tampered
snapshot cannot widen authority — the extension fails closed on a bad signature.

Wire contract (must stay in lockstep with ``extensions/superclaw-governance.ts``
in the clawwork repo):

    envelope = {"payload": "<json string>", "signature": "<hex hmac-sha256>"}
    payload  = {"version": 1, "mode", "allowed_tools", "disallowed_tools",
                "pay_switch": {"enabled": bool}, "issued_at": float, "run_id"}
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from dataclasses import dataclass

SNAPSHOT_VERSION = 1


def canonicalize_tool_names(names: list[str] | None) -> list[str]:
    """Lower-case, trim, and dedupe tool names (order-preserving).

    ClawWork tool names are all lower-case (``bash``, ``write``, ...) while
    SuperClaw callers often follow the Claude convention (``Bash``, ``Write``).
    A case-sensitive comparison would silently fail open for an explicit
    denylist entry like ``Bash``, so every list is canonicalized BEFORE it is
    signed into the snapshot (and the extension lower-cases again on its side
    as defense in depth)."""
    seen: list[str] = []
    for name in names or []:
        canonical = str(name).strip().lower()
        if canonical and canonical not in seen:
            seen.append(canonical)
    return seen


@dataclass(frozen=True)
class PolicySnapshotHandle:
    """What the backend injects into ClawWork's environment for one run."""

    path: str
    key: str  # per-run HMAC secret; never persisted, lives only in env

    def env(self) -> dict[str, str]:
        return {
            "SUPERCLAW_POLICY_SNAPSHOT": self.path,
            "SUPERCLAW_POLICY_SNAPSHOT_KEY": self.key,
        }


def build_policy_payload(
    *,
    mode: str,
    allowed_tools: list[str] | None,
    disallowed_tools: list[str] | None,
    pay_switch_enabled: bool,
    run_id: str,
    issued_at: float,
) -> dict[str, object]:
    """Build the snapshot payload dict (pre-serialization, pre-signing)."""
    return {
        "version": SNAPSHOT_VERSION,
        "mode": mode,
        "allowed_tools": canonicalize_tool_names(allowed_tools),
        "disallowed_tools": canonicalize_tool_names(disallowed_tools),
        "pay_switch": {"enabled": bool(pay_switch_enabled)},
        "issued_at": issued_at,
        "run_id": run_id,
    }


def sign_payload(payload: dict[str, object], key: str) -> str:
    """Serialize + HMAC-sign a payload. The serialized form signed here is the
    EXACT string the extension verifies, so both sides must use the same
    canonical dump (sorted keys, no extra whitespace)."""
    serialized = _canonical(payload)
    signature = hmac.new(key.encode("utf-8"), serialized.encode("utf-8"), hashlib.sha256).hexdigest()
    return signature


def _canonical(payload: dict[str, object]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def write_policy_snapshot(
    *,
    directory: str,
    mode: str,
    allowed_tools: list[str] | None,
    disallowed_tools: list[str] | None,
    pay_switch_enabled: bool,
    run_id: str,
    issued_at: float,
    key: str | None = None,
) -> PolicySnapshotHandle:
    """Write a signed snapshot file under ``directory`` and return its handle.

    The HMAC key is a fresh per-run secret unless one is supplied (tests). The
    file is written 0600 — it carries the run's governance authority and the
    signature alongside, so a world-readable copy would let another local user
    forge a wider policy for a run pointed at it.
    """
    os.makedirs(directory, exist_ok=True)
    secret = key or secrets.token_hex(32)
    payload = build_policy_payload(
        mode=mode,
        allowed_tools=allowed_tools,
        disallowed_tools=disallowed_tools,
        pay_switch_enabled=pay_switch_enabled,
        run_id=run_id,
        issued_at=issued_at,
    )
    serialized = _canonical(payload)
    signature = hmac.new(secret.encode("utf-8"), serialized.encode("utf-8"), hashlib.sha256).hexdigest()
    envelope = json.dumps({"payload": serialized, "signature": signature}, ensure_ascii=False)

    path = os.path.join(directory, f"clawwork-policy-{run_id}.json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, envelope.encode("utf-8"))
    finally:
        os.close(fd)
    return PolicySnapshotHandle(path=path, key=secret)
