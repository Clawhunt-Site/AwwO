"""Run **condition manifest** — derive "under what conditions did this run execute?"
(P1, observability/diagnostics).

A *pure, derive-only* builder: given a ``run_id`` it reads the kernel ledgers
(state.db runs/events/cost, the telemetry span store, the version contract, the
dependency/environment surface) and projects them into a single JSON-safe dict
describing the run's **conditions** — for condition reconstruction, a decision
timeline, and root-cause analysis. It is explicitly **not** a byte-for-byte
reproduction (``_meta.reconstructable = false``).

Privacy is the whole point and is fail-closed by construction:

* ``execution_context`` is the largest cleartext black hole (it carries the raw
  goal prompt, ``agent_run_context``, delegate results, tool args and repo
  paths). We NEVER dump it — only a strict allowlist of scalar **run parameters**
  is projected; every identifier (principal / workspace / company / issue /
  path) is an HMAC fingerprint, never cleartext.
* Environment **values** never appear in cleartext — only a per-key HMAC
  fingerprint, with the four states (absent / empty / set / defaulted)
  distinguished. ``_meta.contains_cleartext_environment`` is hard-coded false.
* The telemetry store is opened **read-only** (``mode=ro``) — we never let
  ``DiagnosticsStore`` create or migrate it. A missing / pruned / unreadable
  telemetry store degrades to ``completeness.status = "incomplete"`` (it is a
  diagnostic source), it is NOT a hard failure unless ``require_complete``.

This module performs NO file output of its own; the export surface
(``operator_export.export_run_condition``) reuses ``resolve_out_path`` / 0600 /
``ExportError`` / sidecar ``content_sha256`` to write it locally. This module
imports no HTTP client and never touches the network.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import platform
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any
from urllib.request import pathname2url

from .diagnostics_store import SCHEMA_VERSION as TELEMETRY_SCHEMA_VERSION
from .diagnostics_store import resolve_telemetry_path
from .operator_export import ExportError
from .secrets_scan import redact_secrets

CONDITION_MANIFEST_SCHEMA_VERSION = 1

# Env key that holds the operator's local HMAC fingerprint secret. When unset,
# fingerprints are still computed but marked ``weak_hash`` (a plain digest is
# not dictionary-resistant) — we never silently pretend to be strong.
OPERATOR_SECRET_ENV = "SUPERCLAW_OPERATOR_FINGERPRINT_SECRET"

# Domain-separation labels so a value fingerprint can never collide with the
# key-id derivation or an env-name fingerprint.
_FP_VALUE_INFO = b"superclaw/condition-manifest/value/v1"
_FP_KEYID_INFO = b"superclaw/condition-manifest/key-id/v1"
_FP_NAME_INFO = b"superclaw/condition-manifest/env-name/v1"

# ---------------------------------------------------------------------------
# execution_context: the ONLY runtime parameters we project (deny by omission).
# Everything else in execution_context (goal text, agent_run_context, delegate
# results, tool args, child waits) is intentionally dropped.
# ---------------------------------------------------------------------------
# Scalar run parameters — copied through with string redaction only.
_EXEC_SCALAR_PARAMS: tuple[str, ...] = (
    "backend_policy",
    "model",
    "effort",
    "concurrency",
    "max_concurrency",
    "budget_seconds",
    "token_budget",
    "run_count_budget",
    "external_tool_budget",
    "task_topology",
    "verification_policy",
    "harness_policy",
)
# containment_policy.to_dict() is all scalar enums (no free text / no paths) — safe to keep.
_CONTAINMENT_FIELDS: tuple[str, ...] = (
    "preset",
    "permission_mode_floor",
    "network_egress",
    "max_delegation_depth",
    "filesystem",
    "strictness",
)

# Identifiers projected as HMAC fingerprints (never cleartext). These are the
# principal / tenant / locator / path fields the blueprint mandates hashing.
_EXEC_IDENTIFIER_KEYS: tuple[str, ...] = (
    "principal",
    "workspace_id",
    "company_profile_id",
    "issue_id",
    "agent_profile_id",
    "repo_path",
    "artifact_dir",
)

# ---------------------------------------------------------------------------
# Lifecycle events: only these scalar payload keys survive (decision-timeline
# signals). Free text (reason, goal, output, execution_context, ...) is dropped.
# ---------------------------------------------------------------------------
_SAFE_EVENT_KEYS: frozenset[str] = frozenset(
    {
        "status",
        "reason_code",
        "blocked",
        "attempt_index",
        "depth",
        "dry_run",
        "task_topology",
        "exit_code",
        "timed_out",
        "cancelled",
        "verdict",
        "decision",
        "mode",
    }
)
_EVENT_STR_MAX = 128
_MAX_EVENT_FIELDS = 24

# ---------------------------------------------------------------------------
# Environment fingerprint.
# ---------------------------------------------------------------------------
# Curated, NON-secret config keys: the NAME is shown in cleartext, the VALUE is
# only ever an HMAC fingerprint. ``has_default`` distinguishes absent vs defaulted.
_ENV_CONFIG_KEYS: tuple[tuple[str, bool], ...] = (
    ("SUPERCLAW_BACKEND", False),
    ("SUPERCLAW_LOG_LEVEL", True),
    ("SUPERCLAW_LOG_FORMAT", True),
    ("SUPERCLAW_LOG_FILE", False),
    ("SUPERCLAW_TELEMETRY_PATH", True),
    ("SUPERCLAW_TELEMETRY_RETENTION_DAYS", True),
    ("SUPERCLAW_TELEMETRY_MAX_DIAG_ROWS", True),
    ("SUPERCLAW_TELEMETRY_RETENTION_INTERVAL", True),
    ("SUPERCLAW_RELEASE_CHANNEL", True),
    ("SUPERCLAW_GIT_SHA", False),
    ("SUPERCLAW_BUNDLED_CORE_VERSION", False),
    ("SUPERCLAW_DESKTOP_SHELL_VERSION", False),
    ("SUPERCLAW_DAEMON_AUTOSTART", True),
)
# Any env key whose NAME matches this is treated as secret-bearing: the name is
# fingerprinted (never cleartext) and only its state + value fingerprint recorded.
_SECRET_NAME_RE = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)", re.IGNORECASE)

# External CLI tools whose ``--version`` is part of the run condition.
_EXTERNAL_TOOLS: tuple[str, ...] = ("git", "codex", "claude", "uv", "node", "npm")


# ---------------------------------------------------------------------------
# Fingerprinting
# ---------------------------------------------------------------------------
class _Fingerprinter:
    """Per-build HMAC fingerprinter. Equal inputs → equal fingerprints (so an
    operator can tell two runs shared a principal / secret), but never reversible."""

    def __init__(self, secret: str | None) -> None:
        self._secret = secret.encode("utf-8") if secret else None
        self.weak = self._secret is None

    def fingerprint(self, value: Any, *, info: bytes = _FP_VALUE_INFO) -> str:
        material = str(value).encode("utf-8")
        if self._secret is not None:
            return hmac.new(self._secret, info + b":" + material, hashlib.sha256).hexdigest()
        # No operator secret: a plain salted digest. Marked weak (not dictionary-
        # resistant) so the manifest never overstates its privacy guarantee.
        return hashlib.sha256(info + b":" + material).hexdigest()

    def key_id(self) -> str | None:
        """Stable id of the secret in use (so two builds can be compared), or
        None when no secret is configured."""
        if self._secret is None:
            return None
        return hmac.new(self._secret, _FP_KEYID_INFO, hashlib.sha256).hexdigest()[:16]

    def fingerprint_id(self, value: Any) -> str | None:
        """Fingerprint an identifier, or None for an absent/empty value."""
        if value is None:
            return None
        text = str(value)
        if text == "":
            return None
        return self.fingerprint(text)


def _resolve_secret(operator_secret: str | None) -> str | None:
    if operator_secret:
        return operator_secret
    env_secret = os.environ.get(OPERATOR_SECRET_ENV)
    return env_secret or None


# ---------------------------------------------------------------------------
# execution_context projection
# ---------------------------------------------------------------------------
_PARAM_STR_MAX = 128

# A filesystem path / URL / Windows-drive / UNC / parent-traversal SIGNATURE,
# matched anywhere in the string (not just a prefix). Combined with the
# whitespace rule below, this turns ``_scrub_scalar`` into an allowlist of
# enum/id-shaped tokens: anything that looks like free text or carries a path
# is redacted, while bare slugs (e.g. ``anthropic/claude-opus``) survive.
_PATHISH_RE = re.compile(
    r"""(
          ^[~/]                                                # leading ~ or / (abs / home path)
        | ~[\\/]                                               # embedded ~/ or ~\ (e.g. path=~/.ssh)
        | \.\.[\\/]                                            # ../ or ..\ traversal
        | ://                                                  # scheme://host
        | [A-Za-z]:[\\/]                                       # C:\ or C:/ drive path
        | \\                                                   # any backslash (UNC / windows)
        | /(?:Users|home|var|tmp|etc|root|private|mnt|opt|srv|data|usr|dev|sys|Volumes|Library)/  # abs unix roots
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def _scrub_scalar(value: Any, *, maxlen: int = _PARAM_STR_MAX) -> Any:
    """Scrub an allowlisted scalar param to an enum/id-shaped token. Defence in
    depth — even a whitelisted field (e.g. ``model``) is user/env-controllable, so
    it must never carry a cleartext absolute path / URL or unbounded free text.

    Rules (redact FIRST, then evaluate — truncate-then-redact can split a secret
    so its pattern no longer matches and the fragment leaks):
      * a secret pattern → already replaced by ``redact_secrets``;
      * any WHITESPACE → free text, not an enum/id → ``<redacted>``
        (legitimate params — model/backend/topology/policy/status — never contain
        spaces, so this catches e.g. ``"error at /Users/a/x"``);
      * a path/URL/drive/UNC/traversal signature → ``<path-redacted>``;
      * otherwise the (capped) token is kept."""
    # bool is an int subclass — keep True/False as-is before the int branch.
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if not isinstance(value, str):
        return "<non-scalar>"  # never let a container through raw
    cleaned = redact_secrets(value)
    if any(ch.isspace() for ch in cleaned):
        return "<redacted>"
    if _PATHISH_RE.search(cleaned):
        return "<path-redacted>"
    return cleaned[:maxlen]


def _project_containment(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    return {field: _scrub_scalar(raw.get(field)) for field in _CONTAINMENT_FIELDS}


def _project_permission(raw: Any) -> dict[str, Any] | None:
    """permission_policy.to_dict() carries cleartext PATHS (mcp_configs /
    plugin_dirs) and a session id — so we project ONLY the mode plus the
    CARDINALITY of each list, never the path/pattern/id values themselves."""
    if not isinstance(raw, dict):
        return None

    def _count(key: str) -> int:
        value = raw.get(key)
        return len(value) if isinstance(value, list) else 0

    return {
        "mode": _scrub_scalar(raw.get("mode")),
        "allowed_tool_count": _count("allowed_tools"),
        "disallowed_tool_count": _count("disallowed_tools"),
        "mcp_config_count": _count("mcp_configs"),
        "plugin_dir_count": _count("plugin_dirs"),
        "has_session_id": bool(raw.get("session_id")),
    }


def _project_execution_parameters(ec: dict[str, Any]) -> dict[str, Any]:
    params: dict[str, Any] = {key: _scrub_scalar(ec.get(key)) for key in _EXEC_SCALAR_PARAMS}
    params["containment_policy"] = _project_containment(ec.get("containment_policy"))
    params["permission_policy"] = _project_permission(ec.get("permission_policy"))
    return params


def _project_identifiers(ec: dict[str, Any], fp: _Fingerprinter) -> dict[str, str | None]:
    return {f"{key}_fp": fp.fingerprint_id(ec.get(key)) for key in _EXEC_IDENTIFIER_KEYS}


# ---------------------------------------------------------------------------
# Lifecycle events (decision timeline)
# ---------------------------------------------------------------------------
def _safe_event_fields(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    fields: dict[str, Any] = {}
    for key in _SAFE_EVENT_KEYS:
        if key not in payload:
            continue
        value = payload.get(key)
        if isinstance(value, bool) or isinstance(value, (int, float)):
            fields[key] = value
        elif isinstance(value, str):
            # redact-then-truncate (via _scrub_scalar): truncating first could
            # split a secret so its pattern no longer matches and the fragment leaks.
            fields[key] = _scrub_scalar(value, maxlen=_EVENT_STR_MAX)
        # containers are dropped by omission
        if len(fields) >= _MAX_EVENT_FIELDS:
            break
    return fields


def _project_lifecycle_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    timeline: list[dict[str, Any]] = []
    for event in events:
        if not isinstance(event, dict):
            continue  # totality: a dirty/legacy non-dict row must not crash the build
        timeline.append(
            {
                "seq": event.get("id"),
                "type": _scrub_scalar(event.get("type")),
                "fields": _safe_event_fields(event.get("payload")),
            }
        )
    return timeline


# ---------------------------------------------------------------------------
# Telemetry spans (read-only; degrade, never fail)
# ---------------------------------------------------------------------------
_TELEMETRY_SPAN_COLUMNS = (
    "occurred_at",
    "kind",
    "receipt_class",
    "span_id",
    "parent_span_id",
    "request_id",
)


def _read_telemetry_spans(path: Path, run_id: str) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Read this run's telemetry receipts via a strictly **read-only** connection.

    Returns ``(spans, None)`` on success, or ``(None, reason)`` when the store is
    absent / unreadable / a newer schema — telemetry is a degradable source, so a
    failure here yields ``completeness = incomplete``, never a hard error.
    """
    if not path.exists():
        return None, "telemetry_db_absent"
    uri = "file:" + pathname2url(str(path.resolve())) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    except sqlite3.Error:
        return None, "telemetry_db_unreadable"
    try:
        conn.row_factory = sqlite3.Row
        user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if user_version > TELEMETRY_SCHEMA_VERSION:
            return None, "telemetry_schema_newer"
        cols = ", ".join(_TELEMETRY_SPAN_COLUMNS)
        rows = conn.execute(
            f"SELECT {cols}, payload FROM receipts WHERE run_id = ? ORDER BY occurred_at ASC, id ASC",
            (run_id,),
        ).fetchall()
    except sqlite3.Error:
        return None, "telemetry_query_failed"
    finally:
        conn.close()

    spans: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except (ValueError, TypeError):
            payload = {}
        # request_id / span_id / parent_span_id can originate at an HTTP boundary
        # (X-Request-Id, W3C traceparent) and are externally controllable; kind /
        # receipt_class are written by our own engine but scrubbed anyway. Every
        # string column goes through _scrub_scalar (path/secret/free-text guard +
        # cap); occurred_at stays numeric.
        span = {
            col: _scrub_scalar(row[col]) if isinstance(row[col], str) else row[col]
            for col in _TELEMETRY_SPAN_COLUMNS
        }
        # P1 is STRICTER than the live telemetry redactor: that allowlist keeps
        # span ``attributes`` (arbitrary keys) and ``error`` (free text up to 1KB),
        # which could carry a prompt / output / business text. The condition
        # manifest projects ONLY fixed low-cardinality fields plus structural
        # counts — never the attribute values or the error message.
        span["span"] = _project_span_payload(payload)
        spans.append(span)
    return spans, None


_SPAN_ENUM_FIELDS = ("name", "span_kind", "error_type")


def _project_span_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    projected: dict[str, Any] = {}
    for key in _SPAN_ENUM_FIELDS:
        value = payload.get(key)
        if isinstance(value, str):
            projected[key] = _scrub_scalar(value)
    duration = payload.get("duration_ms")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool):
        projected["duration_ms"] = duration
    attributes = payload.get("attributes")
    if isinstance(attributes, dict):
        projected["attribute_key_count"] = len(attributes)
    projected["has_attributes"] = bool(attributes)
    projected["has_error"] = bool(payload.get("error") or payload.get("error_type"))
    return projected


# ---------------------------------------------------------------------------
# Environment fingerprint
# ---------------------------------------------------------------------------
def _env_state(name: str, has_default: bool) -> str:
    if name not in os.environ:
        return "defaulted" if has_default else "absent"
    return "empty" if os.environ[name] == "" else "set"


def _build_environment_fingerprint(fp: _Fingerprinter) -> dict[str, Any]:
    config: dict[str, Any] = {}
    for name, has_default in _ENV_CONFIG_KEYS:
        state = _env_state(name, has_default)
        entry: dict[str, Any] = {"state": state}
        # Only a non-empty value carries entropy worth fingerprinting; an empty
        # value's fingerprint is a known constant (pure noise), so skip it.
        if state == "set":
            entry["value_fp"] = fp.fingerprint(os.environ[name])
        config[name] = entry

    # Secret-bearing keys: NAME is fingerprinted, never cleartext. Scan all of
    # os.environ so we capture "an API key was present" without naming it.
    config_names = {name for name, _ in _ENV_CONFIG_KEYS}
    secret_entries: list[dict[str, Any]] = []
    for name, value in os.environ.items():
        if name in config_names or name == OPERATOR_SECRET_ENV:
            continue
        if not _SECRET_NAME_RE.search(name):
            continue
        entry: dict[str, Any] = {
            "name_fp": fp.fingerprint(name, info=_FP_NAME_INFO),
            "state": "empty" if value == "" else "set",
        }
        if value != "":
            entry["value_fp"] = fp.fingerprint(value)
        secret_entries.append(entry)
    # Stable order (no cleartext name to sort on; sort by the name fingerprint).
    secret_entries.sort(key=lambda e: e["name_fp"])

    return {
        "fingerprint_key_id": fp.key_id(),
        "weak_hash": fp.weak,
        "config": config,
        "secret_keys": secret_entries,
        "secret_key_count": len(secret_entries),
    }


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
def _sha256_text_file(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _build_lock_fingerprint(repo_root: Path) -> dict[str, Any]:
    locks: dict[str, Any] = {}
    for name in ("requirements.txt", "pyproject.toml", "uv.lock"):
        candidate = repo_root / name
        try:
            present = candidate.is_file()
        except OSError:
            present = False
        locks[name] = (
            {"present": True, "sha256": _sha256_text_file(candidate)}
            if present
            else {"present": False, "sha256": None}
        )
    return locks


def _installed_distributions() -> dict[str, str]:
    from importlib import metadata

    installed: dict[str, str] = {}
    try:
        dists = metadata.distributions()
    except Exception:  # noqa: BLE001 - best-effort dependency snapshot
        return installed
    for dist in dists:
        try:
            name = dist.metadata["Name"]
        except Exception:  # noqa: BLE001 - a broken dist must not abort the snapshot
            continue
        if not name:
            continue
        installed[str(name)] = str(dist.version)
    return dict(sorted(installed.items()))


def _probe_tool_version(tool: str) -> str | None:
    from .runtime import _version as _tool_version

    try:
        raw = _tool_version(tool)
    except Exception:  # noqa: BLE001 - external probe is best-effort
        return None
    if raw is None:
        return None
    # A hostile same-named binary on PATH could print a path / token as its
    # "--version" output. ``_version`` already secret-scrubs + caps at 200, but
    # scrub once more through the param guard (path/URL guard + length cap).
    cleaned = _scrub_scalar(raw)
    return cleaned if isinstance(cleaned, str) else None


def _build_dependencies(repo_root: Path, fp: _Fingerprinter, *, probe_external_tools: bool) -> dict[str, Any]:
    external: dict[str, str | None] = {}
    if probe_external_tools:
        for tool in _EXTERNAL_TOOLS:
            external[tool] = _probe_tool_version(tool)
    return {
        "lock": _build_lock_fingerprint(repo_root),
        "installed": _installed_distributions(),
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable_fp": fp.fingerprint(sys.executable),
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "external_tools": external,
        "external_tools_probed": probe_external_tools,
    }


# ---------------------------------------------------------------------------
# Version contract
# ---------------------------------------------------------------------------
# git_sha / bundled_core / desktop_shell are ENV-driven. _scrub_scalar is a
# slug-PRESERVING guard (it would pass an opaque token like "build_SENTINEL"
# through), so for these env-sourced fields we FORMAT-VALIDATE instead: only a
# real sha / semver-shaped value survives, anything else is redacted — honouring
# _meta.contains_cleartext_environment=false even for opaque env values.
_GIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")
# Semver/PEP440-ish: a numeric core, then an OPTIONAL pre-release/build suffix that
# MUST start with '-' or '+' (never '.', which would let "0.1.0SENTINEL" parse as
# core "0.1" + suffix ".0SENTINEL" and leak the trailing token).
_VERSION_RE = re.compile(r"^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$")


def _validate_field(value: Any, pattern: re.Pattern[str]) -> Any:
    if value is None:
        return None
    text = str(value)
    # Secret-scan FIRST: a value that is semver-SHAPED can still smuggle a secret in
    # its build metadata (e.g. "1.2.3+sk-proj-..."). If redaction changes it, drop it.
    if redact_secrets(text) != text:
        return "<redacted>"
    return text if pattern.fullmatch(text) else "<redacted>"


def _build_version_contract() -> dict[str, Any]:
    from .version_contract import build_version_contract

    try:
        contract = build_version_contract()
    except Exception as exc:  # noqa: BLE001 - never let a misconfigured channel abort the manifest
        # Keep the failure CLASS (e.g. a bad release channel) as a root-cause
        # signal, but never echo the raw exception message into the manifest.
        return {"available": False, "error_code": type(exc).__name__}
    # FORMAT-VALIDATE (not slug-scrub): git_sha must be a real sha and the version
    # fields semver-shaped, else "<redacted>". A slug-preserving scrub would let an
    # opaque env value (e.g. SUPERCLAW_GIT_SHA=build_xyz) pass through, breaking the
    # _meta.contains_cleartext_environment=false contract. Integer dimensions and
    # the enum-validated channel are safe by construction.
    return {
        "available": True,
        "product_version": _validate_field(contract.product_version, _VERSION_RE),
        "cli_core": _validate_field(contract.cli_core, _VERSION_RE),
        "bundled_core": _validate_field(contract.bundled_core, _VERSION_RE),
        "desktop_shell": _validate_field(contract.desktop_shell, _VERSION_RE),
        "api_contract": contract.api_contract,
        "state_schema": contract.state_schema,
        "plugin_contract": contract.plugin_contract,
        "projection_schema": contract.projection_schema,
        "git_sha": _validate_field(contract.git_sha, _GIT_SHA_RE),
        "channel": contract.channel,
    }


# ---------------------------------------------------------------------------
# Sources metadata
# ---------------------------------------------------------------------------
def _state_db_user_version(path: Path) -> int | None:
    try:
        uri = "file:" + pathname2url(str(path.resolve())) + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
    except sqlite3.Error:
        return None
    try:
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    except sqlite3.Error:
        return None
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Public builder
# ---------------------------------------------------------------------------
def _meta_block(now: float) -> dict[str, Any]:
    return {
        "schema_version": CONDITION_MANIFEST_SCHEMA_VERSION,
        "kind": "run_condition",
        "purpose": "condition_reconstruction",
        # Honest boundaries — hard-coded so the manifest can never claim more than
        # it delivers (avoids operator_export's "reproducible" semantics).
        "reconstructable": False,
        "contains_cleartext_environment": False,
        "contains_tier_c": False,
        "built_at": now,
        "limitations": [
            "Runtime parameters are an allowlisted projection; goal text, tool "
            "arguments, agent_run_context and delegate results are excluded.",
            "Identifiers (principal/workspace/company/issue/paths) are HMAC "
            "fingerprints, not reversible to cleartext.",
            "Environment values are never stored in cleartext — only per-key HMAC "
            "fingerprints, with absent/empty/set/defaulted distinguished.",
            "This records the CONDITIONS a run executed under for reconstruction "
            "and root-cause analysis; it is NOT a byte-for-byte reproduction.",
            "Telemetry spans are best-effort: when the telemetry store is absent "
            "or pruned, completeness.status is 'incomplete', not a failure.",
            "When no operator secret is configured (weak_hash=true), identifier "
            "fingerprints are unkeyed domain-separated SHA-256, not keyed HMAC: a "
            "low-entropy identifier (e.g. a short principal name) is still guessable "
            "by dictionary attack. Set SUPERCLAW_OPERATOR_FINGERPRINT_SECRET for keyed "
            "fingerprints.",
        ],
    }


_BUCKET_METRIC_KEYS = (
    "events",
    "cost_cents",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "duration_seconds",
)
# A corrupt/hostile ledger could roll up into an unbounded number of distinct
# labels (DoS via manifest size); cap and record how many were dropped.
_MAX_BUCKETS = 200


def _cap_buckets(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(rows) <= _MAX_BUCKETS:
        return rows
    capped = rows[:_MAX_BUCKETS]
    capped.append({"label": "<truncated>", "dropped": len(rows) - _MAX_BUCKETS})
    return capped


def _scrub_metric_buckets(buckets: Any) -> list[dict[str, Any]]:
    """Convert a ``{label: metrics}`` roll-up into a list with SCRUBBED labels and
    numeric-only metrics. The bucket keys (model / provider / billing_lane) come
    from cost-event fields and bypass value redaction — a corrupt/controlled event
    could otherwise inject a secret / path / prompt as a JSON KEY. The list form is
    injection-proof and the label is scrubbed like any other param."""
    if not isinstance(buckets, dict):
        return []
    out: list[dict[str, Any]] = []
    for label, metrics in buckets.items():
        row: dict[str, Any] = {"label": _scrub_scalar(str(label))}
        row["metrics"] = (
            {
                key: value
                for key, value in metrics.items()
                if key in _BUCKET_METRIC_KEYS and isinstance(value, (int, float)) and not isinstance(value, bool)
            }
            if isinstance(metrics, dict)
            else {}
        )
        out.append(row)
    return _cap_buckets(out)


def _scrub_count_map(counts: Any) -> list[dict[str, Any]]:
    if not isinstance(counts, dict):
        return []
    out = [
        {
            "label": _scrub_scalar(str(label)),
            "count": count if isinstance(count, int) and not isinstance(count, bool) else 0,
        }
        for label, count in counts.items()
    ]
    return _cap_buckets(out)


def build_condition_manifest(
    store: Any,
    *,
    run_id: str,
    telemetry_path: str | os.PathLike[str] | None = None,
    operator_secret: str | None = None,
    repo_root: str | os.PathLike[str] | None = None,
    now: float | None = None,
    probe_external_tools: bool = False,
    require_complete: bool = False,
) -> dict[str, Any]:
    """Build the condition manifest for ``run_id`` (pure, derive-only).

    Raises ``ExportError`` (fail-closed) when the run does not exist or any state
    read / projection fails. A missing/pruned telemetry store degrades to
    ``completeness.status = "incomplete"`` unless ``require_complete`` is set.

    ``probe_external_tools`` defaults to **False** so the builder stays pure: it
    runs no PATH binaries unless an explicit caller (the export surface) opts in.
    """
    built_at = now if now is not None else time.time()
    fp = _Fingerprinter(_resolve_secret(operator_secret))

    try:
        session = store.get_run(run_id)
    except KeyError as exc:
        raise ExportError(f"run {run_id!r} not found") from exc
    except Exception as exc:  # noqa: BLE001 - any state read failure is fail-closed
        # Type only — a SQLite/store exception message can carry a DB path / SQL /
        # token. The raw cause is preserved on __cause__ for local debugging.
        raise ExportError(f"failed to read run {run_id!r} ({type(exc).__name__})") from exc

    # A corrupt/legacy payload could carry a non-dict execution_context; never let
    # an AttributeError escape — degrade to an empty projection (fail-closed = no params).
    ec = session.execution_context if isinstance(session.execution_context, dict) else {}

    try:
        events = store.list_events_snapshot(run_id)
    except Exception as exc:  # noqa: BLE001 - the core state source must be readable
        raise ExportError(
            f"failed to read lifecycle events for {run_id!r} ({type(exc).__name__})"
        ) from exc

    # Cost: a curated, id-free subset of the aggregate (drop by_agent — its keys
    # are agent ids; model/provider/lane keys are non-sensitive names).
    try:
        cost = store.summarize_cost(run_id=run_id)
        cost_summary = {
            "event_count": cost.get("event_count"),
            "input_tokens": cost.get("input_tokens"),
            "output_tokens": cost.get("output_tokens"),
            "total_tokens": cost.get("total_tokens"),
            "duration_seconds": cost.get("duration_seconds"),
            "total_cost_cents": cost.get("total_cost_cents"),
            "usage_status_counts": _scrub_count_map(cost.get("usage_status_counts")),
            "by_model": _scrub_metric_buckets(cost.get("by_model")),
            "by_provider": _scrub_metric_buckets(cost.get("by_provider")),
            "by_billing_lane": _scrub_metric_buckets(cost.get("by_billing_lane")),
        }
    except Exception as exc:  # noqa: BLE001 - cost is informative, not load-bearing
        # Only the failure CLASS — a raw message could carry a DB path / SQL / token.
        cost_summary = {"available": False, "error_code": type(exc).__name__}

    telemetry_p = Path(telemetry_path) if telemetry_path is not None else resolve_telemetry_path()
    spans, telemetry_reason = _read_telemetry_spans(telemetry_p, run_id)

    repo = Path(repo_root) if repo_root is not None else Path(__file__).resolve().parents[4]
    state_path = Path(getattr(store, "path", "")) if getattr(store, "path", None) else None

    missing: list[dict[str, str]] = []
    if spans is None:
        missing.append({"source": "telemetry_db", "reason": telemetry_reason or "unavailable"})
    status = "complete" if not missing else "incomplete"
    if require_complete and status != "complete":
        raise ExportError(
            "condition manifest is incomplete and --require-complete was set: "
            + ", ".join(f"{m['source']}({m['reason']})" for m in missing)
        )

    # Wrap the whole projection/assembly: a corrupt session field (e.g. a depth
    # that won't int(), a lazy-load DB error) or dirty event row must surface as a
    # fail-closed ExportError, never a raw exception escaping the builder.
    try:
        manifest: dict[str, Any] = {
            "_meta": _meta_block(built_at),
            "run": {
                "run_id": run_id,
                "status": _scrub_scalar(session.status),
                "dry_run": bool(session.dry_run),
                "depth": int(session.depth or 0),
                "parent_run_id": _scrub_scalar(session.parent_run_id),
                "chat_session_id_fp": fp.fingerprint_id(session.chat_session_id),
            },
            "execution_parameters": _project_execution_parameters(ec),
            "identifiers": _project_identifiers(ec, fp),
            "version_contract": _build_version_contract(),
            "dependencies": _build_dependencies(repo, fp, probe_external_tools=probe_external_tools),
            "environment_fingerprint": _build_environment_fingerprint(fp),
            "lifecycle_events": _project_lifecycle_events(events),
            "telemetry_spans": spans,
            "cost_summary": cost_summary,
            "sources": {
                "state_db": {
                    "present": state_path is not None,
                    "path_fp": fp.fingerprint(str(state_path)) if state_path is not None else None,
                    "declared_schema_version": _declared_state_schema(),
                    "user_version": _state_db_user_version(state_path) if state_path is not None else None,
                    "event_row_count": len(events),
                },
                "telemetry_db": {
                    # ``exists`` (the file is on disk) is distinct from ``usable``
                    # (we read spans): a present-but-newer-schema / unreadable DB is
                    # exists=True, usable=False with a reason.
                    "exists": telemetry_reason != "telemetry_db_absent",
                    "usable": spans is not None,
                    "path_fp": fp.fingerprint(str(telemetry_p)),
                    "declared_schema_version": TELEMETRY_SCHEMA_VERSION,
                    "span_row_count": len(spans) if spans is not None else None,
                    "reason": telemetry_reason,
                },
            },
            "completeness": {"status": status, "missing": missing},
        }
    except Exception as exc:  # noqa: BLE001 - fail-closed: never leak a raw traceback
        # Type only — a tainted field (e.g. a depth that won't int()) could carry
        # sensitive text in the raw exception message.
        raise ExportError(
            f"failed to assemble condition manifest for {run_id!r} ({type(exc).__name__})"
        ) from exc
    return manifest


def _declared_state_schema() -> int | None:
    try:
        from .state import StateStore

        return int(StateStore.SCHEMA_VERSION)
    except Exception:  # noqa: BLE001 - metadata only
        return None


__all__ = [
    "CONDITION_MANIFEST_SCHEMA_VERSION",
    "OPERATOR_SECRET_ENV",
    "build_condition_manifest",
]
