"""Operator-facing local export of telemetry / audit data (P0c, Tier A).

A **pull-only, local-file** exporter for internal operators: read an existing
kernel ledger (currently the cost-event ledger), project each row through a
strict field **allowlist + redaction**, and stream it to a local file
(JSONL/CSV/SQLite) with a sidecar ``.manifest.json``.

This NEVER touches the network: ``--out`` rejects URLs (``resolve_out_path``)
and this module imports no HTTP client. Data leaves the machine only when an
operator copies the produced file — it is never pushed. Other Tier A kinds
(runs/secrets/evidence/audit) extend the same dispatch later; span/Tier B is a
later phase (needs the dedicated telemetry store).

Design (docs/observability-diagnostics-roadmap.md P0c): application-level
iterator over the source ledger (not a cross-source SQL view), deny-by-omission
allowlist (mirrors the relay-audit methodology), and a manifest recording what
was exported so a run is reproducible/auditable.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import sqlite3
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .secrets_scan import redact_secrets

EXPORT_SCHEMA_VERSION = 1
_VALID_FORMATS = ("jsonl", "csv", "sqlite")
_EXPORT_FILE_MODE = 0o600
_URL_SCHEME_PREFIXES = ("http:", "https:", "ftp:", "s3:", "gs:", "file:")

# Strict allowlist: attribution ids + metering + status + money + time only.
# NEVER raw_usage (the provider's raw payload) or any free text. This is the
# relay-audit *methodology* (deny by omission), not its field set.
_COST_FIELDS: tuple[str, ...] = (
    "event_id", "idempotency_key", "occurred_at",
    "run_id", "parent_run_id", "chat_session_id", "chat_message_id", "task_id",
    "attempt_index", "agent_profile_id", "issue_id", "company_profile_id", "workspace_id",
    "source", "meter_kind", "backend", "provider", "model", "invocation_id",
    "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens",
    "tool_call_count", "duration_seconds",
    "usage_status", "usage_source", "status",
    "cost_cents", "billing_lane",
)

_KIND_FIELDS: dict[str, tuple[str, ...]] = {"cost": _COST_FIELDS}


class ExportError(ValueError):
    """Export was refused (bad format, non-local out path, unknown kind)."""


def resolve_out_path(out: str | os.PathLike[str]) -> Path:
    """Validate ``--out`` is a LOCAL file path, never a URL (fail-closed)."""
    text = os.fspath(out)
    lowered = text.strip().lower()
    if "://" in text or lowered.startswith(_URL_SCHEME_PREFIXES):
        raise ExportError("--out must be a local file path, not a URL")
    return Path(text).expanduser()


def _scrub(value: Any) -> Any:
    # Redaction is mandatory and unconditional — the export surface has NO "off"
    # switch (defence in depth on top of the field allowlist).
    # bool is an int subclass — check it first so True/False stay as-is.
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return redact_secrets(value)
    return "<non-scalar>"  # containers (e.g. raw_usage) never leave raw


def _project(row: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {field: _scrub(row.get(field)) for field in fields}


def _iter_cost_rows(store: Any, *, since: float | None, until: float | None) -> Iterator[dict[str, Any]]:
    for event in store.list_cost_events(since=since, until=until):
        yield _project(event.to_dict(), _COST_FIELDS)


_KIND_ITERATORS = {"cost": _iter_cost_rows}


def _harden(path: Path) -> None:
    """Best-effort 0600 (export files may hold redacted-but-internal data)."""
    try:
        os.chmod(path, _EXPORT_FILE_MODE)
    except OSError:
        pass


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_jsonl(rows: Iterator[dict[str, Any]], out: Path) -> int:
    count = 0
    with out.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            count += 1
    return count


def _write_csv(rows: Iterator[dict[str, Any]], out: Path, fields: tuple[str, ...]) -> int:
    count = 0
    with out.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(fields))
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
            count += 1
    return count


def _write_sqlite(rows: Iterator[dict[str, Any]], out: Path, fields: tuple[str, ...], *, table: str) -> int:
    if out.exists():
        out.unlink()  # a stale db would otherwise duplicate/append rows
    conn = sqlite3.connect(str(out))
    try:
        cols = ", ".join(f'"{f}"' for f in fields)
        placeholders = ", ".join("?" for _ in fields)
        conn.execute(f'CREATE TABLE "{table}" ({cols})')
        count = 0
        for row in rows:
            conn.execute(
                f'INSERT INTO "{table}" ({cols}) VALUES ({placeholders})',
                [row.get(f) for f in fields],
            )
            count += 1
        conn.commit()
    finally:
        conn.close()
    return count


def export(
    store: Any,
    *,
    kind: str = "cost",
    out: str | os.PathLike[str],
    fmt: str = "jsonl",
    since: float | None = None,
    until: float | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """Export one ledger ``kind`` to a local file + sidecar manifest. Returns the manifest.

    Redaction is ALWAYS on (no parameter to disable it). Refuses (fail-closed)
    unknown formats/kinds and non-local ``out`` paths, and wraps any write/IO
    failure as ``ExportError`` so the surface never leaks a raw traceback.
    """
    if fmt not in _VALID_FORMATS:
        raise ExportError(f"unsupported format {fmt!r} (choose: {', '.join(_VALID_FORMATS)})")
    fields = _KIND_FIELDS.get(kind)
    if fields is None:
        raise ExportError(f"unknown export kind {kind!r} (available: {', '.join(sorted(_KIND_FIELDS))})")

    out_path = resolve_out_path(out)
    rows = _KIND_ITERATORS[kind](store, since=since, until=until)
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if fmt == "jsonl":
            row_count = _write_jsonl(rows, out_path)
        elif fmt == "csv":
            row_count = _write_csv(rows, out_path, fields)
        else:
            row_count = _write_sqlite(rows, out_path, fields, table=kind)
        _harden(out_path)
        content_hash = _sha256_file(out_path)
    except (OSError, sqlite3.Error) as exc:
        raise ExportError(f"failed to write export to {out_path}: {exc}") from exc

    source_db = getattr(store, "path", None)
    manifest: dict[str, Any] = {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "kind": kind,
        "format": fmt,
        "exported_at": now if now is not None else time.time(),
        "source_db": str(source_db) if source_db is not None else None,
        "window": {"since": since, "until": until},
        "redaction": "allowlist",
        "row_count": row_count,
        "content_sha256": content_hash,
        "output": out_path.name,
    }
    try:
        manifest_path = out_path.with_name(out_path.name + ".manifest.json")
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        _harden(manifest_path)
    except OSError as exc:
        raise ExportError(f"failed to write manifest for {out_path}: {exc}") from exc
    return manifest


def export_run_condition(
    store: Any,
    *,
    run_id: str,
    out: str | os.PathLike[str],
    operator_secret: str | None = None,
    telemetry_path: str | os.PathLike[str] | None = None,
    require_complete: bool = False,
    probe_external_tools: bool = True,
    now: float | None = None,
) -> dict[str, Any]:
    """Export a run's **condition manifest** (P1) to a LOCAL JSON file + sidecar envelope.

    Unlike the row-based ledger export, the payload is a single derived object built
    by ``condition_manifest.build_condition_manifest`` (allowlisted + redacted +
    HMAC-fingerprinted). This reuses the same export I/O contract: ``out`` rejects
    URLs (``resolve_out_path``), the file + sidecar are 0600, and any write failure
    is wrapped as ``ExportError``. The builder is fail-closed — an unknown run, or an
    incomplete manifest under ``require_complete``, raises ``ExportError`` before any
    file is written. The export surface opts into external tool probing by default
    (the builder itself stays pure-by-default).
    """
    from .condition_manifest import build_condition_manifest

    out_path = resolve_out_path(out)
    # Build first (fail-closed) so a bad run never leaves a half-written file behind.
    manifest = build_condition_manifest(
        store,
        run_id=run_id,
        telemetry_path=telemetry_path,
        operator_secret=operator_secret,
        now=now,
        probe_external_tools=probe_external_tools,
        require_complete=require_complete,
    )
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True), encoding="utf-8"
        )
        _harden(out_path)
        content_hash = _sha256_file(out_path)
    except OSError as exc:
        raise ExportError(f"failed to write condition manifest to {out_path}: {exc}") from exc

    envelope: dict[str, Any] = {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "kind": "run_condition",
        "format": "json",
        "run_id": run_id,
        "exported_at": now if now is not None else time.time(),
        "redaction": "allowlist",
        "completeness": manifest["completeness"]["status"],
        "content_sha256": content_hash,
        "output": out_path.name,
    }
    try:
        manifest_path = out_path.with_name(out_path.name + ".manifest.json")
        manifest_path.write_text(json.dumps(envelope, indent=2, ensure_ascii=False), encoding="utf-8")
        _harden(manifest_path)
    except OSError as exc:
        raise ExportError(f"failed to write manifest for {out_path}: {exc}") from exc
    return envelope


def export_diagnostic_bundle(
    store: Any,
    *,
    run_id: str,
    out: str | os.PathLike[str],
    operator_secret: str | None = None,
    telemetry_path: str | os.PathLike[str] | None = None,
    require_complete: bool = False,
    now: float | None = None,
) -> dict[str, Any]:
    """Export a run's **diagnostic context bundle** (P2a) to a LOCAL JSON file + sidecar.

    The payload is the redacted, allowlisted bundle built by
    ``diagnostic_bundle.build_diagnostic_bundle`` (span tree + timeline + governance
    decisions + cost + conditions + root-cause hints). It is *diagnostic context*,
    not decision replay (``_meta.decision_replay = "unavailable"``). Reuses the same
    export I/O contract as the cost/condition exports: ``out`` rejects URLs, file +
    sidecar are 0600, write failures wrap as ``ExportError``. Build-first so a bad run
    or an incomplete bundle under ``require_complete`` raises before any file exists.
    """
    from .diagnostic_bundle import build_diagnostic_bundle

    out_path = resolve_out_path(out)
    bundle = build_diagnostic_bundle(
        store,
        run_id=run_id,
        telemetry_path=telemetry_path,
        operator_secret=operator_secret,
        now=now,
        require_complete=require_complete,
    )
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(bundle, indent=2, ensure_ascii=False, sort_keys=True), encoding="utf-8"
        )
        _harden(out_path)
        content_hash = _sha256_file(out_path)
    except OSError as exc:
        raise ExportError(f"failed to write diagnostic bundle to {out_path}: {exc}") from exc

    envelope: dict[str, Any] = {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "kind": "run_diagnostic",
        "format": "json",
        "run_id": run_id,
        "exported_at": now if now is not None else time.time(),
        "redaction": "allowlist",
        # Mirror the builder's honest replay contract so a standalone sidecar reader
        # (without the payload) still sees WHY replay is unavailable.
        "decision_replay": bundle.get("_meta", {}).get("decision_replay", "unavailable"),
        "decision_replay_reason": bundle.get("_meta", {}).get("decision_replay_reason"),
        "completeness": bundle["completeness"]["status"],
        "content_sha256": content_hash,
        "output": out_path.name,
    }
    try:
        manifest_path = out_path.with_name(out_path.name + ".manifest.json")
        manifest_path.write_text(json.dumps(envelope, indent=2, ensure_ascii=False), encoding="utf-8")
        _harden(manifest_path)
    except OSError as exc:
        raise ExportError(f"failed to write manifest for {out_path}: {exc}") from exc
    return envelope
