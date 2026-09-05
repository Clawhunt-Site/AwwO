from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from superclaw.environment import superclaw_data_path


def default_plugin_evidence_dir() -> Path:
    """Default plugin-evidence root under the HOME data root (``~/.superclaw/artifacts/plugins``).

    A function (not a module constant) so the path resolves at call time — honoring the
    current ``SUPERCLAW_HOME`` / legacy cwd fallback — instead of freezing at import.
    """
    return superclaw_data_path("artifacts", "plugins")


DEFAULT_SUCCESS_RETENTION_DAYS = 7
DEFAULT_SLOW_CALL_MS = 30_000
DEFAULT_FAILURE_RATE_THRESHOLD = 0.5
DEFAULT_FAILURE_RATE_MIN_INVOCATIONS = 3
DEFAULT_SANDBOX_KILL_THRESHOLD = 2
LOCKED_STATUSES = {"denied", "error", "timeout"}
LOCKED_POLICY_CODES = {"PLUGIN_REVOKED", "PLUGIN_SANDBOX_VIOLATION"}


@dataclass(frozen=True)
class PluginEvidencePruneResult:
    deleted: list[str]
    kept: list[str]
    locked: list[str]
    missing: list[str]


def list_plugin_evidence(artifact_dir: Path | None = None) -> list[dict[str, Any]]:
    root = _artifact_root(artifact_dir)
    if not root.exists():
        return []
    rows: list[dict[str, Any]] = []
    for path in sorted(root.glob("*.json")):
        record = _read_record(path)
        if record is None:
            continue
        rows.append(_evidence_summary(path, root, record))
    return rows


def prune_plugin_evidence(
    artifact_dir: Path | None = None,
    *,
    retention_days: int = DEFAULT_SUCCESS_RETENTION_DAYS,
    now: datetime | None = None,
) -> PluginEvidencePruneResult:
    if retention_days < 0:
        raise ValueError("retention_days must be non-negative")
    root = _artifact_root(artifact_dir)
    cutoff = _normalize_now(now) - timedelta(days=retention_days)
    deleted: list[str] = []
    kept: list[str] = []
    locked: list[str] = []
    if not root.exists():
        return PluginEvidencePruneResult(deleted=[], kept=[], locked=[], missing=[])
    for path in sorted(root.glob("*.json")):
        record = _read_record(path)
        if record is None:
            kept.append(path.stem)
            continue
        artifact_id = _artifact_id(path, record)
        if _is_locked(record):
            locked.append(artifact_id)
            continue
        finished_at = _parse_time(record.get("finished_at") or record.get("started_at"))
        if finished_at is None or finished_at > cutoff:
            kept.append(artifact_id)
            continue
        path.unlink()
        deleted.append(artifact_id)
    return PluginEvidencePruneResult(deleted=deleted, kept=kept, locked=locked, missing=[])


def clear_plugin_evidence(
    artifact_ids: list[str],
    artifact_dir: Path | None = None,
) -> PluginEvidencePruneResult:
    root = _artifact_root(artifact_dir)
    deleted: list[str] = []
    kept: list[str] = []
    locked: list[str] = []
    missing: list[str] = []
    for artifact_id in artifact_ids:
        safe_id = _safe_artifact_id(artifact_id)
        path = root / f"{safe_id}.json"
        if not path.exists():
            missing.append(safe_id)
            continue
        record = _read_record(path)
        if record is None or _is_locked(record):
            locked.append(safe_id)
            continue
        path.unlink()
        deleted.append(safe_id)
    return PluginEvidencePruneResult(deleted=deleted, kept=kept, locked=locked, missing=missing)


def diagnose_plugin_runtime(
    artifact_dir: Path | None = None,
    *,
    slow_call_ms: int = DEFAULT_SLOW_CALL_MS,
    failure_rate_threshold: float = DEFAULT_FAILURE_RATE_THRESHOLD,
    failure_rate_min_invocations: int = DEFAULT_FAILURE_RATE_MIN_INVOCATIONS,
    sandbox_kill_threshold: int = DEFAULT_SANDBOX_KILL_THRESHOLD,
) -> dict[str, Any]:
    """Summarize local plugin runtime health from invocation evidence.

    This is a local diagnostics surface only. It intentionally reports artifact
    ids and aggregate counters, not raw plugin inputs, outputs, paths, or logs.
    """
    if slow_call_ms < 0:
        raise ValueError("slow_call_ms must be non-negative")
    if not 0 <= failure_rate_threshold <= 1:
        raise ValueError("failure_rate_threshold must be between 0 and 1")
    if failure_rate_min_invocations < 1:
        raise ValueError("failure_rate_min_invocations must be at least 1")
    if sandbox_kill_threshold < 1:
        raise ValueError("sandbox_kill_threshold must be at least 1")

    root = _artifact_root(artifact_dir)
    records = _load_records(root)
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    findings: list[dict[str, Any]] = []
    slow_calls = 0
    total_failures = 0
    sandbox_kills = 0

    for path, record in records:
        artifact_id = _artifact_id(path, record)
        plugin_id = str(record.get("plugin_id") or "unknown")
        plugin_version = str(record.get("plugin_version") or "unknown")
        tool_name = str(record.get("tool_name") or "unknown")
        status = str(record.get("status") or "unknown")
        group_key = (plugin_id, plugin_version, tool_name)
        group = groups.setdefault(
            group_key,
            {
                "plugin_id": plugin_id,
                "plugin_version": plugin_version,
                "tool_name": tool_name,
                "total": 0,
                "failures": 0,
                "sandbox_kills": 0,
                "slow_calls": 0,
                "artifact_ids": [],
            },
        )
        group["total"] += 1
        group["artifact_ids"].append(artifact_id)
        if status != "ok":
            group["failures"] += 1
            total_failures += 1
        if _is_sandbox_kill(record):
            group["sandbox_kills"] += 1
            sandbox_kills += 1
        duration_ms = _duration_ms(record)
        if duration_ms is not None and duration_ms >= slow_call_ms:
            group["slow_calls"] += 1
            slow_calls += 1
            findings.append(
                {
                    "code": "PLUGIN_RUNTIME_SLOW_CALL",
                    "severity": "warning",
                    "plugin_id": plugin_id,
                    "plugin_version": plugin_version,
                    "tool_name": tool_name,
                    "artifact_id": artifact_id,
                    "duration_ms": duration_ms,
                    "threshold_ms": slow_call_ms,
                }
            )

    for group in groups.values():
        failure_rate = group["failures"] / group["total"] if group["total"] else 0.0
        if group["total"] >= failure_rate_min_invocations and failure_rate >= failure_rate_threshold:
            findings.append(
                {
                    "code": "PLUGIN_RUNTIME_HIGH_FAILURE_RATE",
                    "severity": "high",
                    "plugin_id": group["plugin_id"],
                    "plugin_version": group["plugin_version"],
                    "tool_name": group["tool_name"],
                    "failures": group["failures"],
                    "total": group["total"],
                    "failure_rate": round(failure_rate, 4),
                    "threshold": failure_rate_threshold,
                    "sample_artifact_ids": group["artifact_ids"][-5:],
                }
            )
        if group["sandbox_kills"] >= sandbox_kill_threshold:
            findings.append(
                {
                    "code": "PLUGIN_RUNTIME_REPEATED_SANDBOX_KILLS",
                    "severity": "critical",
                    "plugin_id": group["plugin_id"],
                    "plugin_version": group["plugin_version"],
                    "tool_name": group["tool_name"],
                    "sandbox_kills": group["sandbox_kills"],
                    "threshold": sandbox_kill_threshold,
                    "sample_artifact_ids": group["artifact_ids"][-5:],
                }
            )

    return {
        "ok": not findings,
        "artifact_count": len(records),
        "summary": {
            "plugins": len({(record.get("plugin_id"), record.get("plugin_version")) for _path, record in records}),
            "tools": len(groups),
            "failures": total_failures,
            "slow_calls": slow_calls,
            "sandbox_kills": sandbox_kills,
        },
        "thresholds": {
            "slow_call_ms": slow_call_ms,
            "failure_rate_threshold": failure_rate_threshold,
            "failure_rate_min_invocations": failure_rate_min_invocations,
            "sandbox_kill_threshold": sandbox_kill_threshold,
        },
        "findings": findings,
    }


def _artifact_root(artifact_dir: Path | None) -> Path:
    return Path(artifact_dir) if artifact_dir else default_plugin_evidence_dir()


def _load_records(root: Path) -> list[tuple[Path, dict[str, Any]]]:
    if not root.exists():
        return []
    records: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(root.glob("*.json")):
        record = _read_record(path)
        if record is not None:
            records.append((path, record))
    return records


def _read_record(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _evidence_summary(path: Path, root: Path, record: dict[str, Any]) -> dict[str, Any]:
    return {
        "artifact_id": _artifact_id(path, record),
        "relative_path": path.relative_to(root).as_posix(),
        "plugin_id": record.get("plugin_id"),
        "plugin_version": record.get("plugin_version"),
        "tool_name": record.get("tool_name"),
        "status": record.get("status"),
        "started_at": record.get("started_at"),
        "finished_at": record.get("finished_at"),
        "entitlement_id": record.get("entitlement_id"),
        "locked": _is_locked(record),
        "lock_reason": _lock_reason(record),
    }


def _artifact_id(path: Path, record: dict[str, Any]) -> str:
    return str(record.get("evidence_artifact_id") or path.stem)


def _is_locked(record: dict[str, Any]) -> bool:
    return _lock_reason(record) is not None


def _lock_reason(record: dict[str, Any]) -> str | None:
    if _active_retention_lock(record):
        return "retention_lock"
    status = str(record.get("status") or "")
    if status in LOCKED_STATUSES:
        return status
    policy_decision = str(record.get("policy_decision") or "")
    for code in LOCKED_POLICY_CODES:
        if code in policy_decision:
            return code
    return None


def _active_retention_lock(record: dict[str, Any]) -> bool:
    lock = record.get("retention_lock")
    if lock is True:
        return True
    return isinstance(lock, dict) and lock.get("active") is True


def _parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _duration_ms(record: dict[str, Any]) -> int | None:
    started = _parse_time(record.get("started_at"))
    finished = _parse_time(record.get("finished_at"))
    if started is None or finished is None:
        return None
    return max(0, int((finished - started).total_seconds() * 1000))


def _is_sandbox_kill(record: dict[str, Any]) -> bool:
    policy_decision = str(record.get("policy_decision") or "")
    status = str(record.get("status") or "")
    return "PLUGIN_SANDBOX_VIOLATION" in policy_decision or status == "sandbox_violation"


def _normalize_now(value: datetime | None) -> datetime:
    now = value or datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    return now.astimezone(UTC)


def _safe_artifact_id(value: str) -> str:
    artifact_id = str(value)
    if not artifact_id or "/" in artifact_id or "\\" in artifact_id or ".." in Path(artifact_id).parts:
        raise ValueError(f"unsafe evidence artifact id: {value}")
    return artifact_id
