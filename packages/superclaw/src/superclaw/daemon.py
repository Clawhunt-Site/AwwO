"""Heartbeat daemon — the engine that makes an Agent Team run by itself.

Phase 2 of the daemon pivot (docs/agent-team-kernel-daemon-pivot.md §7). The
design is copied from Paperclip's heartbeat service: a transactional DB queue
is the scheduler's memory, every agent carries its own heartbeat policy, and a
wakeup is serviced through a fail-closed claim gate before any model runs.

Loop shape (one process, kernel-side, surfaces only observe):

    tick_timers()  -> enqueue_wakeup(source="timer")   per due agent
    service_once() -> claim queued wakeup -> gates -> pick issue -> checkout
                     -> run as the bound profile -> submit for review
                     -> persist runtime state / task session / finish wakeup

Gate order mirrors Paperclip's ``claimQueuedRun`` with SuperClaw's governance
inserted: invokability → concurrency cap → budget hard stop → workspace lock.
Every skip is durable (wakeup.status="skipped" + detail) — silence is never an
outcome. The daemon owns no policy of its own: charters, equipment, approval
gates and the pay/network hard gates all stay where they already live.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import shutil
import socket
import stat
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from superclaw import team_kernel
from superclaw.context_pointers import ContextPointersCapture
from superclaw.environment import default_artifact_dir
from superclaw.liveness import ACTIVE_RUN_STATUSES, effective_run_state
from superclaw.models import (
    AgentProfile,
    AgentRuntimeState,
    AgentTaskSession,
    AgentWakeupRequest,
    IssueComment,
    IssueStatus,
    WakeupSource,
    _id,
)
from superclaw.state import StateStore

# Heartbeat policy defaults: a role is NOT heartbeat-driven until its profile
# opts in (fail-closed default), but an opted-in role wakes on events too.
DEFAULT_HEARTBEAT_POLICY: dict[str, Any] = {
    "enabled": False,
    "interval_sec": 300,
    "wake_on_demand": True,
    "max_concurrent_runs": 1,
}

_ISSUE_PRIORITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
_BROKER_SCOPE_MATERIALIZE = "plugin:materialize"
_SENSITIVE_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "credential",
    "password",
    "private_key",
    "secret",
    "token",
}


def heartbeat_policy(profile: AgentProfile) -> dict[str, Any]:
    """The effective heartbeat policy for a profile (defaults + overrides)."""
    raw = profile.runtime_config.get("heartbeat") if isinstance(profile.runtime_config, dict) else None
    policy = dict(DEFAULT_HEARTBEAT_POLICY)
    if isinstance(raw, dict):
        policy.update({k: raw[k] for k in DEFAULT_HEARTBEAT_POLICY if k in raw})
    return policy


@dataclass(frozen=True)
class BrokerSession:
    """Audit-safe daemon broker session metadata."""

    session_id: str
    issued_at: float
    expires_at: float
    subject: str | None = None

    def to_status_payload(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "subject": self.subject,
        }


@dataclass(frozen=True)
class BrokerTokenMetadata:
    """Token metadata that is safe to log or return in status payloads."""

    token_id: str
    session_id: str
    scopes: tuple[str, ...]
    issued_at: float
    expires_at: float
    subject: str | None = None

    def to_status_payload(self) -> dict[str, Any]:
        return {
            "token_id": self.token_id,
            "session_id": self.session_id,
            "scopes": list(self.scopes),
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "subject": self.subject,
        }


@dataclass(frozen=True)
class BrokerMaterialization:
    """Audit-safe record for one governed plugin view."""

    materialization_id: str
    session_id: str
    plugin_id: str
    path: Path
    created_at: float
    file_count: int

    def to_status_payload(self) -> dict[str, Any]:
        return {
            "materialization_id": self.materialization_id,
            "session_id": self.session_id,
            "plugin_id": self.plugin_id,
            "path": str(self.path),
            "created_at": self.created_at,
            "file_count": self.file_count,
        }


@dataclass
class _BrokerTokenRecord:
    metadata: BrokerTokenMetadata
    secret_digest: str = field(repr=False)
    active: bool = field(default=True, repr=False)


@dataclass
class _BrokerSessionRecord:
    metadata: BrokerSession
    active: bool = field(default=True, repr=False)
    materializations: list[BrokerMaterialization] = field(default_factory=list)


class DaemonBroker:
    """Transport-independent daemon broker/session primitive.

    The broker is intentionally in-process and fail-closed. Transports can layer
    sockets or CLI commands on top later, but they should only receive the
    opaque token once; records and status payloads expose metadata only.
    """

    def __init__(
        self,
        *,
        temp_root: str | Path | None = None,
        clock: Callable[[], float] | None = None,
        session_ttl_seconds: float = 300.0,
        token_ttl_seconds: float = 60.0,
    ) -> None:
        self.temp_root = Path(temp_root) if temp_root is not None else None
        self.clock = clock or time.time
        self.session_ttl_seconds = float(session_ttl_seconds)
        self.token_ttl_seconds = float(token_ttl_seconds)
        self._sessions: dict[str, _BrokerSessionRecord] = {}
        self._tokens: dict[str, _BrokerTokenRecord] = {}
        self._lock = threading.RLock()

    def open_session(
        self, *, subject: str | None = None, ttl_seconds: float | None = None
    ) -> BrokerSession:
        """Create an audit-safe broker session with an explicit expiry."""
        ttl = self.session_ttl_seconds if ttl_seconds is None else float(ttl_seconds)
        if ttl <= 0:
            raise ValueError("session ttl must be positive")
        with self._lock:
            now = float(self.clock())
            self._reap_expired_locked(now)
            session = BrokerSession(
                session_id=f"broker_session_{secrets.token_urlsafe(12)}",
                issued_at=now,
                expires_at=now + ttl,
                subject=subject,
            )
            self._sessions[session.session_id] = _BrokerSessionRecord(metadata=session)
            return session

    def issue_token(
        self,
        session_id: str,
        scopes: list[str] | tuple[str, ...],
        *,
        ttl_seconds: float | None = None,
        subject: str | None = None,
    ) -> tuple[str, BrokerTokenMetadata]:
        """Issue a short-lived scoped token.

        The returned token is the only secret. The stored record hashes only the
        secret segment, and the metadata returned here is safe to audit.
        """
        normalized_scopes = tuple(sorted({str(scope) for scope in scopes if str(scope)}))
        if not normalized_scopes:
            raise ValueError("token must have at least one scope")
        ttl = self.token_ttl_seconds if ttl_seconds is None else float(ttl_seconds)
        if ttl <= 0:
            raise ValueError("token ttl must be positive")
        with self._lock:
            now = float(self.clock())
            self._reap_expired_locked(now)
            session = self._active_session_locked(session_id, now=now)
            if session is None:
                raise ValueError("session is not active")
            expires_at = min(now + ttl, session.metadata.expires_at)
            if expires_at <= now:
                raise ValueError("session expires before token can be used")
            token_id = f"broker_token_{secrets.token_urlsafe(12)}"
            secret = secrets.token_urlsafe(32)
            metadata = BrokerTokenMetadata(
                token_id=token_id,
                session_id=session_id,
                scopes=normalized_scopes,
                issued_at=now,
                expires_at=expires_at,
                subject=subject,
            )
            self._tokens[token_id] = _BrokerTokenRecord(
                metadata=metadata,
                secret_digest=self._digest(secret),
            )
            return f"sclw-broker.{token_id}.{secret}", metadata

    def validate_token(
        self, token: str, *, required_scope: str, now: float | None = None
    ) -> BrokerTokenMetadata | None:
        """Return metadata only when token, session, expiry, and scope all pass."""
        with self._lock:
            token_id, secret = self._parse_token(token)
            if token_id is None or secret is None:
                return None
            checked_at = float(self.clock()) if now is None else float(now)
            self._reap_expired_locked(checked_at)
            record = self._tokens.get(token_id)
            if record is None or not record.active:
                return None
            if checked_at >= record.metadata.expires_at:
                return None
            if self._active_session_locked(record.metadata.session_id, now=checked_at) is None:
                return None
            if required_scope not in record.metadata.scopes:
                return None
            if not hmac.compare_digest(record.secret_digest, self._digest(secret)):
                return None
            return record.metadata

    def materialize_plugin_view(
        self,
        token: str,
        *,
        plugin_id: str,
        manifest: Mapping[str, Any],
        files: Mapping[str, str | bytes] | None = None,
    ) -> BrokerMaterialization:
        """Materialize a governed plugin view into a private session directory."""
        with self._lock:
            metadata = self.validate_token(token, required_scope=_BROKER_SCOPE_MATERIALIZE)
            if metadata is None:
                raise PermissionError("invalid broker token")
            self._assert_safe_component(plugin_id, label="plugin_id")
            root = self._new_materialization_root(plugin_id)
            session = self._sessions[metadata.session_id]
            try:
                governed_manifest = self._governed_manifest(plugin_id, manifest)
                manifest_path = root / "superclaw-plugin.json"
                manifest_path.write_text(
                    json.dumps(governed_manifest, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                os.chmod(manifest_path, 0o600)
                file_count = 1
                for relative_path, content in (files or {}).items():
                    target = self._safe_materialized_path(root, relative_path)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if isinstance(content, bytes):
                        target.write_bytes(content)
                    elif isinstance(content, str):
                        target.write_text(content, encoding="utf-8")
                    else:
                        raise TypeError("materialized file content must be str or bytes")
                    os.chmod(target, 0o600)
                    file_count += 1
            except Exception:
                shutil.rmtree(root, ignore_errors=True)
                raise
            materialized = BrokerMaterialization(
                materialization_id=f"broker_mat_{secrets.token_urlsafe(12)}",
                session_id=metadata.session_id,
                plugin_id=plugin_id,
                path=root,
                created_at=float(self.clock()),
                file_count=file_count,
            )
            session.materializations.append(materialized)
            return materialized

    def close_session(self, session_id: str) -> None:
        """Revoke session tokens and remove all session materializations."""
        with self._lock:
            self._close_session_locked(session_id)

    def status_payload(self) -> dict[str, Any]:
        """Return only audit-safe records, never token secrets or digests."""
        with self._lock:
            self._reap_expired_locked(float(self.clock()))
            return {
                "sessions": [
                    record.metadata.to_status_payload()
                    for record in self._sessions.values()
                    if record.active
                ],
                "tokens": [
                    record.metadata.to_status_payload()
                    for record in self._tokens.values()
                    if record.active
                ],
                "materializations": [
                    item.to_status_payload()
                    for record in self._sessions.values()
                    for item in record.materializations
                ],
            }

    def _active_session_locked(
        self, session_id: str, *, now: float | None = None
    ) -> _BrokerSessionRecord | None:
        session = self._sessions.get(session_id)
        if session is None or not session.active:
            return None
        checked_at = float(self.clock()) if now is None else float(now)
        if checked_at >= session.metadata.expires_at:
            return None
        return session

    def _reap_expired_locked(self, now: float) -> None:
        for session_id, session in list(self._sessions.items()):
            if now >= session.metadata.expires_at:
                self._close_session_locked(session_id)
        for token_id, token in list(self._tokens.items()):
            if now >= token.metadata.expires_at:
                self._tokens.pop(token_id, None)

    def _close_session_locked(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is None:
            return
        session.active = False
        for token_id, token in list(self._tokens.items()):
            if token.metadata.session_id == session_id:
                token.active = False
                self._tokens.pop(token_id, None)
        for materialized in list(session.materializations):
            shutil.rmtree(materialized.path, ignore_errors=True)
        session.materializations.clear()

    @staticmethod
    def _digest(secret: str) -> str:
        return hashlib.sha256(secret.encode("utf-8")).hexdigest()

    @staticmethod
    def _parse_token(token: str) -> tuple[str | None, str | None]:
        parts = str(token).split(".", 2)
        if len(parts) != 3 or parts[0] != "sclw-broker":
            return None, None
        return parts[1], parts[2]

    @staticmethod
    def _assert_safe_component(value: str, *, label: str) -> None:
        raw = str(value)
        if not raw or raw in {".", ".."} or any(char in raw for char in ("/", "\\", "\0")):
            raise ValueError(f"unsafe {label}")

    def _new_materialization_root(self, plugin_id: str) -> Path:
        if self.temp_root is not None:
            self.temp_root.mkdir(parents=True, exist_ok=True)
            os.chmod(self.temp_root, 0o700)
        parent = str(self.temp_root) if self.temp_root is not None else None
        root = Path(tempfile.mkdtemp(prefix=f"superclaw-broker-{plugin_id}-", dir=parent))
        os.chmod(root, 0o700)
        return root

    @classmethod
    def _safe_materialized_path(cls, root: Path, relative_path: str) -> Path:
        rel = Path(str(relative_path))
        if rel.is_absolute() or not str(relative_path).strip():
            raise ValueError("unsafe materialization path")
        if any(part in {"", ".", ".."} for part in rel.parts):
            raise ValueError("unsafe materialization path")
        target = root / rel
        root_resolved = root.resolve()
        target_resolved = target.resolve()
        if not target_resolved.is_relative_to(root_resolved):
            raise ValueError("unsafe materialization path")
        return target

    @classmethod
    def _governed_manifest(cls, plugin_id: str, manifest: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "id": plugin_id,
            "version": str(manifest.get("version") or "0.0.0"),
            "name": str(manifest.get("name") or plugin_id),
            "description": str(manifest.get("description") or ""),
            "runtime": cls._scrub(manifest.get("runtime") or {}),
            "tools": cls._scrub(manifest.get("tools") or []),
            "governance": {
                "source": "daemon_broker",
                "materialized": True,
            },
        }

    @classmethod
    def _scrub(cls, value: Any) -> Any:
        if isinstance(value, Mapping):
            safe: dict[str, Any] = {}
            for key, item in value.items():
                key_str = str(key)
                if key_str.lower() in _SENSITIVE_KEYS:
                    continue
                safe[key_str] = cls._scrub(item)
            return safe
        if isinstance(value, list):
            return [cls._scrub(item) for item in value]
        if isinstance(value, tuple):
            return [cls._scrub(item) for item in value]
        return value


class LocalDaemonBrokerControl:
    """Small local control surface over :class:`DaemonBroker`.

    This is deliberately not a remote transport. It gives CLI/API callers a
    persistent local broker lifecycle while preserving the broker's fail-closed
    token semantics; the state file stores token digests, never raw tokens.
    """

    def __init__(
        self,
        *,
        state_file: str | Path,
        temp_root: str | Path,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.state_file = Path(state_file)
        self.temp_root = Path(temp_root)
        self.clock = clock or time.time
        self._lock = threading.RLock()

    def open_session(
        self, *, subject: str | None = None, ttl_seconds: float | None = None
    ) -> BrokerSession:
        with self._lock:
            broker = self._load_broker()
            session = broker.open_session(subject=subject, ttl_seconds=ttl_seconds)
            self._save_broker(broker)
            return session

    def issue_token(
        self,
        session_id: str,
        scopes: list[str] | tuple[str, ...],
        *,
        ttl_seconds: float | None = None,
        subject: str | None = None,
    ) -> tuple[str, BrokerTokenMetadata]:
        with self._lock:
            broker = self._load_broker()
            token, metadata = broker.issue_token(
                session_id,
                scopes,
                ttl_seconds=ttl_seconds,
                subject=subject,
            )
            self._save_broker(broker)
            return token, metadata

    def validate_token(self, token: str, *, required_scope: str) -> BrokerTokenMetadata | None:
        with self._lock:
            broker = self._load_broker()
            metadata = broker.validate_token(token, required_scope=required_scope)
            self._save_broker(broker)
            return metadata

    def materialize_plugin_view(
        self,
        token: str,
        *,
        plugin_id: str,
        manifest: Mapping[str, Any],
        files: Mapping[str, str | bytes] | None = None,
    ) -> BrokerMaterialization:
        with self._lock:
            broker = self._load_broker()
            materialized = broker.materialize_plugin_view(
                token,
                plugin_id=plugin_id,
                manifest=manifest,
                files=files,
            )
            self._save_broker(broker)
            return materialized

    def close_session(self, session_id: str) -> None:
        with self._lock:
            broker = self._load_broker()
            broker.close_session(session_id)
            self._save_broker(broker)

    def status_payload(self) -> dict[str, Any]:
        with self._lock:
            broker = self._load_broker()
            payload = broker.status_payload()
            self._save_broker(broker)
            return payload

    def _load_broker(self) -> DaemonBroker:
        broker = DaemonBroker(temp_root=self.temp_root, clock=self.clock)
        if not self.state_file.exists():
            return broker
        try:
            payload = json.loads(self.state_file.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError("daemon broker state is unreadable") from exc
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise ValueError("daemon broker state version is unsupported")
        for raw_session in payload.get("sessions") or []:
            if not isinstance(raw_session, dict):
                continue
            metadata = BrokerSession(
                session_id=str(raw_session["session_id"]),
                issued_at=float(raw_session["issued_at"]),
                expires_at=float(raw_session["expires_at"]),
                subject=raw_session.get("subject"),
            )
            materializations = []
            for item in raw_session.get("materializations") or []:
                if not isinstance(item, dict):
                    continue
                materialized_path = Path(str(item["path"]))
                try:
                    materialized_path.resolve().relative_to(self.temp_root.resolve())
                except ValueError as exc:
                    raise ValueError("daemon broker state contains unsafe materialization path") from exc
                materializations.append(
                    BrokerMaterialization(
                        materialization_id=str(item["materialization_id"]),
                        session_id=str(item["session_id"]),
                        plugin_id=str(item["plugin_id"]),
                        path=materialized_path,
                        created_at=float(item["created_at"]),
                        file_count=int(item["file_count"]),
                    )
                )
            broker._sessions[metadata.session_id] = _BrokerSessionRecord(
                metadata=metadata,
                active=bool(raw_session.get("active", True)),
                materializations=materializations,
            )
        for raw_token in payload.get("tokens") or []:
            if not isinstance(raw_token, dict):
                continue
            metadata = BrokerTokenMetadata(
                token_id=str(raw_token["token_id"]),
                session_id=str(raw_token["session_id"]),
                scopes=tuple(str(scope) for scope in raw_token.get("scopes") or []),
                issued_at=float(raw_token["issued_at"]),
                expires_at=float(raw_token["expires_at"]),
                subject=raw_token.get("subject"),
            )
            secret_digest = str(raw_token.get("secret_digest") or "")
            if secret_digest:
                broker._tokens[metadata.token_id] = _BrokerTokenRecord(
                    metadata=metadata,
                    secret_digest=secret_digest,
                    active=bool(raw_token.get("active", True)),
                )
        broker.status_payload()
        return broker

    def _save_broker(self, broker: DaemonBroker) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.temp_root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.state_file.parent, 0o700)
        os.chmod(self.temp_root, 0o700)
        payload = {
            "version": 1,
            "sessions": [
                {
                    **record.metadata.to_status_payload(),
                    "active": record.active,
                    "materializations": [
                        item.to_status_payload() for item in record.materializations
                    ],
                }
                for record in broker._sessions.values()
            ],
            "tokens": [
                {
                    **record.metadata.to_status_payload(),
                    "secret_digest": record.secret_digest,
                    "active": record.active,
                }
                for record in broker._tokens.values()
            ],
        }
        tmp_path = self.state_file.with_suffix(f"{self.state_file.suffix}.tmp")
        fd = os.open(tmp_path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True)
                handle.write("\n")
        except Exception:
            Path(tmp_path).unlink(missing_ok=True)
            raise
        os.replace(tmp_path, self.state_file)
        os.chmod(self.state_file, 0o600)


class LocalDaemonBrokerIPCUnsupportedError(RuntimeError):
    """Raised when the requested local broker IPC transport is unavailable."""


def _ipc_ok(**payload: Any) -> dict[str, Any]:
    return {"ok": True, **payload}


def _ipc_error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def _optional_float(value: Any, *, label: str) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number") from exc


def _require_str(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _require_mapping(value: Any, *, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be an object")
    return value


def _require_string_mapping(value: Any, *, label: str) -> Mapping[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be an object")
    safe: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(item, str):
            raise ValueError(f"{label} values must be strings")
        safe[str(key)] = item
    return safe


class _LocalDaemonBrokerIPCDispatcher:
    """JSON request dispatcher for the local daemon broker control surface."""

    def __init__(self, control: LocalDaemonBrokerControl) -> None:
        self.control = control

    def dispatch(self, request: Any) -> dict[str, Any]:
        if not isinstance(request, Mapping):
            return _ipc_error("invalid_request", "request must be an object")
        action = request.get("action")
        if not isinstance(action, str) or not action:
            return _ipc_error("invalid_request", "action must be a non-empty string")
        payload = request.get("payload", request)
        if not isinstance(payload, Mapping):
            return _ipc_error("invalid_request", "payload must be an object")
        try:
            if action in {"open_session", "create_session", "create"}:
                response = self._open_session(payload)
            elif action == "issue_token":
                response = self._issue_token(payload)
            elif action in {"validate_token", "validate"}:
                response = self._validate_token(payload)
            elif action in {"materialize_plugin_view", "materialize"}:
                response = self._materialize_plugin_view(payload)
            elif action == "close_session":
                response = self._close_session(payload)
            elif action == "status":
                response = _ipc_ok(status=self.control.status_payload())
            elif action in {"list_sessions", "list"}:
                response = _ipc_ok(sessions=self.control.status_payload()["sessions"])
            else:
                response = _ipc_error("unsupported_action", "unsupported daemon broker IPC action")
        except PermissionError as exc:
            response = _ipc_error("permission_denied", str(exc))
        except (KeyError, TypeError, ValueError) as exc:
            response = _ipc_error("invalid_request", str(exc))
        except Exception:
            response = _ipc_error("internal_error", "daemon broker IPC action failed")
        if "id" in request:
            if not isinstance(request["id"], str):
                response = _ipc_error("invalid_request", "id must be a string")
            else:
                response = {"id": request["id"], **response}
        return response

    def _open_session(self, request: Mapping[str, Any]) -> dict[str, Any]:
        session = self.control.open_session(
            subject=request.get("subject"),
            ttl_seconds=_optional_float(request.get("ttl_seconds"), label="ttl_seconds"),
        )
        return _ipc_ok(session=session.to_status_payload())

    def _issue_token(self, request: Mapping[str, Any]) -> dict[str, Any]:
        session_id = _require_str(request.get("session_id"), label="session_id")
        scopes = request.get("scopes")
        if not isinstance(scopes, list | tuple):
            raise ValueError("scopes must be a list")
        token, metadata = self.control.issue_token(
            session_id,
            [str(scope) for scope in scopes],
            ttl_seconds=_optional_float(request.get("ttl_seconds"), label="ttl_seconds"),
            subject=request.get("subject"),
        )
        return _ipc_ok(token=token, metadata=metadata.to_status_payload())

    def _validate_token(self, request: Mapping[str, Any]) -> dict[str, Any]:
        token = _require_str(request.get("token"), label="token")
        required_scope = _require_str(request.get("required_scope"), label="required_scope")
        metadata = self.control.validate_token(token, required_scope=required_scope)
        return _ipc_ok(metadata=None if metadata is None else metadata.to_status_payload())

    def _materialize_plugin_view(self, request: Mapping[str, Any]) -> dict[str, Any]:
        materialized = self.control.materialize_plugin_view(
            _require_str(request.get("token"), label="token"),
            plugin_id=_require_str(request.get("plugin_id"), label="plugin_id"),
            manifest=_require_mapping(request.get("manifest"), label="manifest"),
            files=_require_string_mapping(request.get("files"), label="files"),
        )
        return _ipc_ok(materialization=materialized.to_status_payload())

    def _close_session(self, request: Mapping[str, Any]) -> dict[str, Any]:
        session_id = _require_str(request.get("session_id"), label="session_id")
        self.control.close_session(session_id)
        return _ipc_ok(closed=True, session_id=session_id)


class UnixDaemonBrokerIPCPath:
    """Safety checks for explicit local Unix-domain socket paths."""

    def __init__(self, socket_path: str | Path) -> None:
        self.path = Path(socket_path)

    def prepare_for_bind(self) -> Path:
        if os.name != "posix" or not hasattr(socket, "AF_UNIX"):
            raise LocalDaemonBrokerIPCUnsupportedError("Unix-domain sockets are unavailable")
        self._validate_explicit_path()
        self._ensure_safe_parent()
        self._prepare_socket_file()
        return self.path

    def validate_for_client(self) -> Path:
        if os.name != "posix" or not hasattr(socket, "AF_UNIX"):
            raise LocalDaemonBrokerIPCUnsupportedError("Unix-domain sockets are unavailable")
        self._validate_explicit_path()
        self._ensure_parent_not_symlink()
        return self.path

    def cleanup(self) -> None:
        try:
            mode = self.path.lstat().st_mode
        except FileNotFoundError:
            return
        if stat.S_ISSOCK(mode):
            self.path.unlink()

    def _validate_explicit_path(self) -> None:
        raw = str(self.path)
        if "\0" in raw or not raw:
            raise ValueError("unsafe daemon IPC socket path")
        if not self.path.is_absolute():
            raise ValueError("daemon IPC socket path must be absolute")
        if self.path.name in {"", ".", ".."}:
            raise ValueError("unsafe daemon IPC socket path")

    def _ensure_safe_parent(self) -> None:
        parent = self.path.parent
        for current in self._parent_components(parent):
            try:
                mode = current.lstat().st_mode
            except FileNotFoundError:
                current.mkdir(mode=0o700)
                os.chmod(current, 0o700)
                mode = current.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise ValueError("unsafe daemon IPC socket directory")
        parent_mode = parent.lstat().st_mode
        if parent_mode & 0o022:
            raise ValueError("daemon IPC socket directory must not be group/world writable")

    def _ensure_parent_not_symlink(self) -> None:
        for current in self._parent_components(self.path.parent):
            try:
                mode = current.lstat().st_mode
            except FileNotFoundError as exc:
                raise ValueError("daemon IPC socket directory does not exist") from exc
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise ValueError("unsafe daemon IPC socket directory")

    def _prepare_socket_file(self) -> None:
        try:
            mode = self.path.lstat().st_mode
        except FileNotFoundError:
            return
        if stat.S_ISLNK(mode):
            raise ValueError("unsafe daemon IPC socket path")
        if stat.S_ISSOCK(mode):
            if self._socket_accepts_connections():
                raise ValueError("daemon IPC socket path is already in use")
            self.path.unlink()
            return
        raise ValueError("daemon IPC socket path already exists")

    def _socket_accepts_connections(self) -> bool:
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.1)
            probe.connect(str(self.path))
            return True
        except OSError:
            return False
        finally:
            probe.close()

    @staticmethod
    def _parent_components(parent: Path) -> list[Path]:
        components: list[Path] = []
        current = parent
        while True:
            components.append(current)
            if current.parent == current:
                break
            current = current.parent
        return list(reversed(components))


class LocalDaemonBrokerIPCServer:
    """Unix-domain socket JSONL server for :class:`LocalDaemonBrokerControl`.

    This transport is intentionally local and POSIX-only. Windows named-pipe
    support is isolated below as unsupported rather than faking untested
    production behavior from macOS tests.
    """

    def __init__(
        self,
        *,
        control: LocalDaemonBrokerControl,
        socket_path: str | Path,
    ) -> None:
        self.control = control
        self.socket_path = Path(socket_path)
        self._dispatcher = _LocalDaemonBrokerIPCDispatcher(control)
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._socket: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._startup_error: BaseException | None = None

    def serve_forever(self) -> None:
        path = UnixDaemonBrokerIPCPath(self.socket_path).prepare_for_bind()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._socket = listener
        try:
            listener.bind(str(path))
            os.chmod(path, 0o600)
            listener.listen()
            listener.settimeout(0.1)
            self._ready.set()
            while not self._stop.is_set():
                try:
                    connection, _addr = listener.accept()
                except TimeoutError:
                    continue
                except OSError:
                    if self._stop.is_set():
                        break
                    raise
                with connection:
                    try:
                        self._handle_connection(connection)
                    except OSError:
                        pass
        finally:
            self._ready.set()
            try:
                listener.close()
            finally:
                if self._socket is listener:
                    self._socket = None
                UnixDaemonBrokerIPCPath(self.socket_path).cleanup()

    def start_in_thread(self, *, timeout_seconds: float = 5.0) -> threading.Thread:
        if self._thread is not None and self._thread.is_alive():
            raise RuntimeError("daemon broker IPC server is already running")
        self._stop.clear()
        self._ready.clear()
        self._startup_error = None
        self._thread = threading.Thread(
            target=self._thread_main,
            name="superclaw-daemon-broker-ipc",
            daemon=True,
        )
        self._thread.start()
        if not self._ready.wait(timeout_seconds):
            self.shutdown()
            raise TimeoutError("daemon broker IPC server did not start")
        if self._startup_error is not None:
            raise self._startup_error
        return self._thread

    def shutdown(self, *, timeout_seconds: float = 5.0) -> None:
        self._stop.set()
        listener = self._socket
        if listener is not None:
            try:
                listener.close()
            except OSError:
                pass
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout_seconds)
        UnixDaemonBrokerIPCPath(self.socket_path).cleanup()

    def _thread_main(self) -> None:
        try:
            self.serve_forever()
        except BaseException as exc:
            self._startup_error = exc
            self._ready.set()

    def _handle_connection(self, connection: socket.socket) -> None:
        connection.settimeout(5.0)
        try:
            request_line = self._recv_line(connection)
            response = self._dispatch_line(request_line)
        except ValueError as exc:
            response = _ipc_error("invalid_request", str(exc))
        except OSError:
            return
        encoded = json.dumps(response, sort_keys=True).encode("utf-8") + b"\n"
        try:
            connection.sendall(encoded)
        except OSError:
            pass

    def _dispatch_line(self, line: bytes) -> dict[str, Any]:
        try:
            request = json.loads(line.decode("utf-8"))
        except Exception:
            return _ipc_error("invalid_json", "request must be valid JSON")
        return self._dispatcher.dispatch(request)

    @staticmethod
    def _recv_line(connection: socket.socket) -> bytes:
        chunks: list[bytes] = []
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if sum(len(item) for item in chunks) > 8 * 1024 * 1024:
                raise ValueError("daemon broker IPC request is too large")
            if b"\n" in chunk:
                break
        raw = b"".join(chunks)
        if b"\n" in raw:
            raw = raw.split(b"\n", 1)[0]
        return raw


class LocalDaemonBrokerIPCClient:
    """Small JSONL client for the local daemon broker Unix socket."""

    def __init__(self, *, socket_path: str | Path, timeout_seconds: float = 5.0) -> None:
        self.socket_path = Path(socket_path)
        self.timeout_seconds = float(timeout_seconds)

    def request(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return self.request_raw(json.dumps(dict(payload), sort_keys=True).encode("utf-8") + b"\n")

    def request_raw(self, payload: bytes) -> dict[str, Any]:
        UnixDaemonBrokerIPCPath(self.socket_path).validate_for_client()
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.settimeout(self.timeout_seconds)
            client.connect(str(self.socket_path))
            client.sendall(payload)
            line = LocalDaemonBrokerIPCServer._recv_line(client)
        finally:
            client.close()
        try:
            response = json.loads(line.decode("utf-8"))
        except Exception as exc:
            raise ValueError("daemon broker IPC response is invalid JSON") from exc
        if not isinstance(response, dict):
            raise ValueError("daemon broker IPC response must be an object")
        return response


class WindowsNamedPipeDaemonBrokerIPCServer:
    """Placeholder for a future Windows named-pipe broker IPC endpoint.

    The macOS/POSIX implementation above is real and tested. Windows named-pipe
    behavior is deliberately unsupported here until it can be implemented and
    validated on Windows.
    """

    def serve_forever(self) -> None:
        raise LocalDaemonBrokerIPCUnsupportedError(
            "Windows named-pipe daemon broker IPC is not implemented"
        )


@dataclass
class ServiceOutcome:
    """What one service pass did — returned for observability and tests."""

    wakeup_id: str
    agent_profile_id: str
    status: str  # finished | skipped
    detail: str
    run_id: str | None = None
    issue_id: str | None = None


class HeartbeatDaemon:
    """Single-process heartbeat engine over the kernel state store."""

    def __init__(
        self,
        store: StateStore,
        orchestrator: Any = None,
        *,
        repo_path: str | Path = ".",
        artifact_dir: str | Path | None = None,
        default_budget_seconds: int = 300,
    ) -> None:
        self.store = store
        if orchestrator is None:
            from superclaw.orchestrator import SuperClawOrchestrator

            orchestrator = SuperClawOrchestrator(store)
        self.orchestrator = orchestrator
        self.repo_path = Path(repo_path)
        # Default the artifacts root under the HOME data root (~/.superclaw/artifacts),
        # not cwd-relative — see default_artifact_dir().
        self.artifact_dir = Path(artifact_dir) if artifact_dir is not None else default_artifact_dir()
        self.default_budget_seconds = int(default_budget_seconds)
        # Backoff before a deferred (busy/locked) wakeup becomes visible again.
        self.retry_backoff_seconds = 30.0

    # --- master switch -------------------------------------------------------

    def heartbeats_enabled(self) -> bool:
        """Instance-level master switch for the timer scheduler (fail-closed).

        Default OFF: a fresh instance does NOT run the autonomous heartbeat
        scheduler until an operator explicitly enables it
        (``superclaw instance set general heartbeat_enabled true``). A settings
        read failure also returns False — a broken governance store must never
        be the thing that lets agents run unattended. Event-driven wakeups
        (assignment / mention) are still serviced; this gates only the
        timer-driven autonomous loop.
        """
        try:
            settings = self.store.get_instance_settings()
            return bool(settings.general.get("heartbeat_enabled", False))
        except Exception:
            return False

    # --- startup -------------------------------------------------------------

    # Grace before a still-`claimed` wakeup is eligible for stale reclaim: long
    # enough for a freshly-claimed run to establish its mutation lease (so a
    # just-started run is never mistaken for a dead one), short enough that a real
    # orphan recovers quickly. Mirrors Paperclip's reaper running on a liveness
    # signal rather than a fixed per-run duration cap.
    _STALE_CLAIM_GRACE_SECONDS = 120.0

    # Grace before a checkout (``workspace:``/``issue:``) lock with NO run yet is
    # eligible for orphan reclaim. A held lock with no run is an AMBIGUOUS state — it
    # is EITHER a worker still between checkout and run-creation (live), OR a worker
    # that crashed before creating its run (orphan); the two are indistinguishable
    # from state alone, so — exactly like Paperclip's 5-minute reaper staleThreshold —
    # we wait long enough that any live setup would already have a (stamped, findable)
    # run. checkout→create_run is milliseconds, so a lock still run-less after 5 min
    # is a dead worker that will not resume to double-execute. Longer than the agent
    # grace because the agent reaper keys on a claimed wakeup whose run is provably
    # not-live, whereas here "no run at all" needs the time-based liveness proxy.
    _STALE_CHECKOUT_GRACE_SECONDS = 300.0

    def startup_self_heal(self) -> int:
        """Reconcile stale runs AND reclaim stale per-agent locks before scheduling
        anything (zombie cleanup). Reconcile FIRST so reclaim's liveness decisions
        run on the CONVERGED run view (a dead run already flipped out of
        ACTIVE_RUN_STATUSES → correctly no longer protects its wakeup)."""
        try:
            results = self.orchestrator.reconcile_stale_runs()
        except Exception:
            # Reconcile failed → the run view is NOT confirmed converged. Skip startup
            # reclaim (fail-closed: never release locks on an unconverged view); the
            # continuous run_forever sweep reclaims later once things stabilize.
            return 0
        self.reclaim_stale_agent_locks()
        # Same converged-run-view requirement as the agent reaper: reconcile FIRST
        # so orphan/liveness decisions run on the converged view (a dead run has
        # already left ACTIVE_RUN_STATUSES and no longer protects its lock).
        self.reclaim_stale_workspace_locks()
        return len(results or [])

    @staticmethod
    def _run_agent_profile_id(ec: Mapping[str, Any]) -> str | None:
        """Extract the agent a run belongs to (None for a non-team/operator run)."""
        ctx = ec.get("agent_run_context")
        run_agent = ctx.get("agent_profile_id") if isinstance(ctx, Mapping) else None
        if not run_agent:
            run_agent = ec.get("agent_profile_id")
        return run_agent if isinstance(run_agent, str) and run_agent else None

    def _live_protection(self) -> tuple[set[str], set[str]] | None:
        """Compute what the reaper must NOT free, keyed two ways (fail-CLOSED):
          * ``wakeups`` — ``wakeup_id``s whose spawned run is live/unverifiable. This
            is the EXACT link a claim has to its work: Gate 2 takes the lock with
            ``run_id = wakeup_id`` and every daemon-spawned run stamps
            ``execution_context["wakeup_id"]`` with the same id (work + respond
            paths), so a corrupt/operator/empty ``execution_context`` cannot defeat
            it via fuzzy attribution.
          * ``agents`` — fallback for a live run we could NOT key to a wakeup
            (``wakeup_id`` missing/malformed) but which DOES carry an agent id: we
            cannot prove it doesn't back a stuck claim → protect that whole agent.
            Non-team/operator runs (no agent id) are ignored — they hold no
            ``agent:<id>`` lock, so they over-protect nothing.

        Returns ``None`` if runs cannot be listed at all — liveness is then wholly
        unassessable, so the caller reaps NOTHING this cycle (fail-closed). A
        per-run liveness error protects that run too (also fail-closed)."""
        try:
            # Materialize INSIDE the guard so a lazy/generator store impl that does its
            # I/O during iteration (not at the call) still fails closed here, not by an
            # exception escaping mid-loop below. A None/!iterable result also lands here.
            runs = list(self.store.list_runs())
        except Exception:
            return None  # cannot assess any liveness → caller must reap nothing
        wakeups: set[str] = set()
        agents: set[str] = set()
        for run in runs:
            try:
                if run.status not in ACTIVE_RUN_STATUSES:
                    continue
                # Liveness FIRST (it reads status/lease, not execution_context): a
                # not-live active run protects nothing, so its possibly-corrupt ec is
                # harmless → skip it without aborting the whole sweep. Only a LIVE run
                # needs keying, so only a LIVE run with an unreadable/corrupt ec forces
                # the conservative global fail-closed below (a far narrower trigger than
                # "any active run", so one dead leftover never stalls all reclaim).
                try:
                    live = bool(effective_run_state(run)["is_live"])
                except Exception:
                    live = True  # cannot prove not-live → treat as live (fail closed)
                if not live:
                    continue
                # A missing execution_context is legitimate (→ {}); a PRESENT but
                # non-Mapping one on a LIVE run is corrupt and unkeyable (it may be a
                # live lock-holder we'd wrongly free) → fail closed, reap nothing.
                raw_ec = getattr(run, "execution_context", None)
                if raw_ec is None:
                    ec: Mapping[str, Any] = {}
                elif isinstance(raw_ec, Mapping):
                    ec = raw_ec
                else:
                    return None  # corrupt ec on a LIVE run → unclassifiable → fail closed
                wid = ec.get("wakeup_id")
                if isinstance(wid, str) and wid:
                    wakeups.add(wid)
                    continue
                # Live run we cannot key to a wakeup → protect its agent (if any).
                agent_id = self._run_agent_profile_id(ec)
                if agent_id:
                    agents.add(agent_id)
            except Exception:
                # An ACTIVE run we cannot classify (status unreadable, etc.) might be
                # live AND holding a lock we'd otherwise free → fail CLOSED for the whole
                # sweep: abort and reap nothing this cycle (None), never fail-open by
                # skipping it. Genuinely dead runs leave ACTIVE via reconcile, so this
                # stalls reclaim only while an unclassifiable run is still active.
                return None
        return wakeups, agents

    def reconcile_marketplace_orders(self) -> int:
        """Auto-advance claimed marketplace orders between the human gates (OPT-IN).

        OFF by default (fail-closed): autonomous marketplace delivery spends budget
        and runs the company's agent, so the operator must explicitly enable it via
        ``SUPERCLAW_MARKETPLACE_AUTO_ADVANCE=1``. When on, the daemon drives the
        saga's NON-gate progressions so接单 runs to completion without manual
        ``marketplace advance``: after a human GRANTS a claim it builds the company
        delivery issue, runs it (the multi-role delivery engine), and opens the
        issue completion gate; after the human GRANTS completion it advances to
        ``ready_to_submit``. It NEVER auto-claims or auto-submits — both remain
        human-gated (payment/commitment never on the default path). Best-effort +
        fail-soft per order: one bad order never kills the scheduler loop. Returns
        the count of orders whose status advanced this tick.
        """
        if os.environ.get("SUPERCLAW_MARKETPLACE_AUTO_ADVANCE") != "1":
            return 0  # fail-closed: autonomous delivery is opt-in
        from superclaw.marketplace_saga import advance_marketplace_order
        from superclaw.models import MarketplaceOrderStatus as _S

        advanceable = {
            _S.CLAIMED_REMOTE.value,
            _S.ISSUE_BOUND.value,
            _S.RUN_STARTED.value,
            _S.REVIEW_PENDING.value,
        }
        advanced = 0
        try:
            orders = [
                o for o in self.store.list_marketplace_orders() if o.status in advanceable
            ]
        except Exception:  # pragma: no cover - hygiene must never crash the loop
            return 0
        for order in orders:
            try:
                after = advance_marketplace_order(
                    self.store, order.order_id, orchestrator=self.orchestrator,
                    requested_by="daemon",
                )
                if after.status != order.status:
                    advanced += 1
            except Exception:  # pragma: no cover - one bad order never stops the loop
                continue
        return advanced

    def reclaim_stale_agent_locks(self, *, now: float | None = None) -> int:
        """Free per-agent single-flight locks stranded by a crash, restart, or a
        hung run, so an agent is NEVER permanently stuck ``agent_busy``.

        Paperclip-native shape: reap by run LIVENESS, continuously (called from
        startup AND every scheduler cycle), not by a fixed per-run time cap. A
        wakeup still ``claimed`` past the grace period whose agent has NO live run
        (lease expired — dead process OR a hung turn that stopped renewing) is
        orphaned: its claim holds the ``agent:<profile_id>`` lock (Gate 2), which
        has no TTL and would otherwise block that agent's queue forever (observed:
        a respond run interrupted by an app restart leaked the CEO's lock → every
        later @CEO deferred ``agent_busy``). Release the lock and finish the claim
        (skipped). The run reconciler converges the run record separately. Whole
        body guarded — reclaim is best-effort hygiene and must never crash the loop
        or startup. Returns the count reclaimed."""
        moment = time.time() if now is None else now
        reclaimed = 0
        try:
            # Claimed-FIRST so the common idle path is cheap: no stuck claim past the
            # grace window ⇒ return without scanning runs at all (no-burn). Only when
            # there is at least one reclaim candidate do we pay one run scan.
            # list_wakeups is ORDER BY requested_at ASC, so the OLDEST claims — exactly
            # the stale orphans — sort to the FRONT; the limit only truncates the
            # NEWEST (still grace-protected) claims, caught once they age next cycle.
            def _past_grace(w: AgentWakeupRequest) -> bool:
                claimed_at = w.claimed_at or w.requested_at
                if not claimed_at:
                    return True
                # A future/negative delta (sub-second clock skew between the claim's
                # writer and this node) is treated as STILL WITHIN grace: protect a
                # just-claimed run whose lease may not have registered yet rather than
                # reap it on a clock difference. This self-corrects — once wall-clock
                # advances past claimed_at + grace the claim becomes eligible, so a
                # genuinely stale claim is never protected forever.
                return (moment - claimed_at) >= self._STALE_CLAIM_GRACE_SECONDS

            candidates = [w for w in self.store.list_wakeups(status="claimed", limit=1000)
                          if _past_grace(w)]
            if not candidates:
                return 0  # idle / all fresh → no run scan
            # One run scan per cycle (NOT per wakeup): build the protection sets once,
            # then O(1) lookups below. None ⇒ runs unlistable ⇒ reap nothing (fail-closed).
            protection = self._live_protection()
            if protection is None:
                return 0
            protected_wakeups, protected_agents = protection
            for wakeup in candidates:
                # Skip if THIS claim's own run is live, or its agent has a live run we
                # could not key to a wakeup (fail-closed: we cannot tell this claim from
                # that live run, so we neither free nor finish it).
                if wakeup.wakeup_id in protected_wakeups or wakeup.agent_profile_id in protected_agents:
                    continue
                lock_key = f"agent:{wakeup.agent_profile_id}"
                try:
                    lock = self.store.get_workspace_lock(lock_key)
                except Exception:  # pragma: no cover - could not read → leave the claim
                    continue
                # Free the lock only if it is held by a NON-live owner. The lock is keyed
                # by run_id == the wakeup that acquired it (Gate 2). If lock.run_id is in
                # protected_wakeups the holder is LIVE → leave the lock alone. Either way
                # we still FINISH this claim below: we are here because W.wakeup_id is NOT
                # in protected_wakeups, so W's own run is not live and (since the lock,
                # if any, is held by a DIFFERENT run_id) W does not hold the lock. W is a
                # dead/duplicate claim; finish_wakeup keys strictly on W.wakeup_id so it
                # can NEVER touch the live owner's row — leaving it `claimed` would only
                # leak it forever while the agent stays busy.
                if lock is not None and lock.run_id not in protected_wakeups:
                    # Non-live holder (dead/mismatched/corrupt run_id): free it with an
                    # ATOMIC compare-and-delete on ITS OWN run_id (a concurrent re-acquire
                    # changes run_id → no-op, never deleting a live owner's lock; a
                    # corrupt/mismatched run_id is still recovered). A raced re-acquire
                    # (release returns None) just means a NEWER run now holds the lock —
                    # that run has its OWN claim which drives its own reclaim, so we do not
                    # chase it; we still finish THIS dead claim below.
                    try:
                        self.store.release_workspace_lock(lock_key, expected_run_id=lock.run_id)
                    except Exception:  # pragma: no cover - could not act atomically
                        continue  # store erroring → leave the claim for the next sweep
                # Finish the dead claim regardless of who (if anyone) holds the lock now:
                # W does not hold it (its run is not live / not the current holder) and
                # finish_wakeup keys strictly on W.wakeup_id, so it can never touch a live
                # or newer owner's row. Not finishing would leak W forever on a busy agent.
                try:
                    # expected_status guard: never overwrite a wakeup a concurrent path
                    # just transitioned out of `claimed` (e.g. its run completing).
                    result = self.store.finish_wakeup(
                        wakeup.wakeup_id, status="skipped",
                        detail="reclaimed:stale_claim_no_live_run", expected_status="claimed",
                    )
                except Exception:  # pragma: no cover - best-effort
                    continue
                # Count only a claim WE actually transitioned (the expected_status guard
                # no-ops on a concurrent completion, returning the unchanged row → not
                # counted, so the metric never inflates on a race).
                if (result is not None and result.status == "skipped"
                        and result.detail == "reclaimed:stale_claim_no_live_run"):
                    reclaimed += 1
        except Exception:  # pragma: no cover - reclaim must never crash the loop
            pass
        return reclaimed

    def reclaim_stale_workspace_locks(self, *, now: float | None = None) -> int:
        """Free TRUE-orphan ``workspace:``/``issue:`` checkout locks and re-drive
        their issue, so a crash/restart between checkout and run-anchor never
        strands an issue ``in_progress`` with a lock no live run backs (observed:
        a 42h leak where every later checkout deferred ``workspace already
        locked``). Symmetric to :meth:`reclaim_stale_agent_locks` — reap by run
        LIVENESS, continuously, never by a fixed duration cap — but here the
        leaked resource is the workspace checkout lock, not the per-agent lock.

        Conservative, fail-CLOSED, no-burn-preserving. A lock is reclaimed ONLY
        when ALL hold:
          * key prefix is ``workspace:`` / ``issue:`` (NEVER touches ``agent:``);
          * its ``run_id`` is a daemon wakeup (``get_wakeup`` finds it) — an
            operator/CLI run's lock (``run_id == run_*``, absent from the wakeup
            table) is OUT OF SCOPE and skipped;
          * past the ``_STALE_CHECKOUT_GRACE_SECONDS`` grace (5 min, Paperclip's
            reaper staleThreshold — longer than the agent grace because a run-less
            checkout lock is an ambiguous live-setup-vs-orphan state resolved by time);
          * NO run record references the lock's wakeup_id OR its issue_id — i.e. it
            is a genuine orphan, not an active occupant, not terminal wreckage
            (no-burn: a failed run's lock is left so it is not silently re-driven),
            and not a persisted-but-not-yet-anchored run;
          * the lock carries an issue_id (a workspace lock with no issue is outside
            this reaper's recovery model — left for the conservative path).
        ``list_runs`` raising aborts the WHOLE cycle (reap nothing): liveness is
        unassessable, so never free a lock on an unknown run view. The whole body
        is guarded — reclaim is best-effort hygiene and must never crash the loop
        or startup.

        Benign residual window (intentional, not a no-burn violation): a run that
        crashes BETWEEN ``create_run_session`` and stamping its wakeup_id/issue_id
        leaves a ``queued`` run carrying neither — indistinguishable from an
        orphan, so it may be reaped and the issue re-driven. That run did ZERO
        work, never executed, and anchored no issue, so re-driving IS the correct
        recovery; no extra cleanup is added for it.

        Returns the count reclaimed.
        """
        moment = time.time() if now is None else now
        reclaimed = 0
        try:
            locks = [
                lock
                for lock in self.store.list_workspace_locks()
                if lock.lock_key.startswith(("workspace:", "issue:"))
            ]
            if not locks:
                return 0  # no checkout locks at all → nothing to scan
            # Materialize the run view fail-CLOSED: if runs are unlistable we
            # cannot prove orphanhood, so reap NOTHING this cycle (never free a
            # lock on an unknown run view). One scan per cycle → O(1) lookups below.
            try:
                runs = list(self.store.list_runs())
            except Exception:
                return 0
            run_wakeup_ids = {
                wid
                for run in runs
                if isinstance(
                    (wid := (run.execution_context or {}).get("wakeup_id")), str
                )
            }
            run_issue_ids = {
                iid
                for run in runs
                if isinstance(
                    (iid := (run.execution_context or {}).get("issue_id")), str
                )
            }
            for lock in locks:
                run_id = lock.run_id
                issue_id = lock.issue_id
                lock_key = lock.lock_key
                # No real holder id → cannot key it to a run; leave it.
                if not (isinstance(run_id, str) and run_id):
                    continue
                # Operator/CLI lock (run_id is a run_*, not a wakeup) → out of scope.
                if self.store.get_wakeup(run_id) is None:
                    continue
                # Grace: a just-taken lock whose run is still establishing must not
                # be mistaken for dead (mirrors the agent reaper; a future/negative
                # delta from sub-second skew counts as still-within-grace).
                if (moment - (lock.acquired_at or 0)) < self._STALE_CHECKOUT_GRACE_SECONDS:
                    continue
                # ANY associated run (by wakeup_id OR issue_id) → NOT an orphan:
                # covers an active occupant, terminal wreckage (no-burn: leave it),
                # and a persisted-but-not-yet-anchored run. Skip.
                if run_id in run_wakeup_ids or (issue_id and issue_id in run_issue_ids):
                    continue
                # A workspace lock with no issue is outside this reaper's recovery
                # model (no issue to reset / re-drive) → conservatively skip.
                if not issue_id:
                    continue
                # True orphan: reset the issue + re-drive via its assignee. The
                # store applies the atomic ABA guard, so a concurrent re-checkout
                # (a NEW run grabbed this issue/lock since our read) is rejected.
                try:
                    issue = self.store.get_issue(issue_id)
                except KeyError:
                    continue  # issue vanished → nothing to reset
                if self.store.reclaim_orphaned_checkout(
                    issue_id,
                    expected_wakeup_id=run_id,
                    expected_lock_key=lock_key,
                    retry_agent_profile_id=issue.assignee_agent_profile_id or "",
                    retry_wakeup_id=_id("wake"),
                    retry_company_profile_id=issue.company_profile_id,
                ):
                    reclaimed += 1
        except Exception:  # pragma: no cover - reclaim must never crash the loop
            logging.getLogger(__name__).warning(
                "reclaim_stale_workspace_locks swept with an error", exc_info=True
            )
        return reclaimed

    # --- scheduling ----------------------------------------------------------

    def tick_timers(self, now: float | None = None) -> list[AgentWakeupRequest]:
        """Enqueue a timer wakeup for every agent whose interval elapsed.

        Per-agent watermark, not a global cron: each profile compares its own
        ``last_heartbeat_at`` against its own ``interval_sec``. The watermark
        moves at enqueue time so a slow service pass never causes a thundering
        herd of duplicate timer wakeups (the queue coalesces regardless).
        """
        now = time.time() if now is None else float(now)
        if not self.heartbeats_enabled():
            return []
        enqueued: list[AgentWakeupRequest] = []
        for profile in self.store.list_agent_profiles():
            policy = heartbeat_policy(profile)
            if not policy.get("enabled"):
                continue
            runtime = self.store.get_agent_runtime_state(profile.profile_id)
            baseline = (runtime.last_heartbeat_at if runtime else None) or profile.created_at
            if now - float(baseline) < float(policy.get("interval_sec") or 0):
                continue
            request, coalesced = self.store.enqueue_wakeup(
                AgentWakeupRequest(
                    agent_profile_id=profile.profile_id,
                    company_profile_id=profile.company_profile_id,
                    source=WakeupSource.TIMER.value,
                    reason="interval_elapsed",
                    idempotency_key=f"timer:{profile.profile_id}:{int(baseline)}",
                    context_snapshot={"baseline": baseline, "now": now},
                )
            )
            runtime = runtime or AgentRuntimeState(agent_profile_id=profile.profile_id)
            runtime.last_heartbeat_at = now
            self.store.save_agent_runtime_state(runtime)
            if not coalesced:
                enqueued.append(request)
        return enqueued

    def tick_scheduled_triggers(
        self, now: float | None = None, *, max_claims: int = 32
    ) -> list[AgentWakeupRequest]:
        """Claim due routine schedules into durable wakeups.

        Routines are explicit scheduled definitions, separate from per-agent
        heartbeat timers. The StateStore advances each routine slot, materializes
        a fresh ``todo`` issue from the routine's seed, and queues its wakeup in
        ONE transaction, so repeated daemon ticks cannot enqueue duplicate work
        for the same due time (the slot claim is the dedupe).

        A claim may advance a routine's slot WITHOUT materializing work (the seed
        drifted out of scope, or the routine's last fire is still in flight — see
        ``StateStore._materialize_routine_issue_in_conn``). That returns
        ``(schedule, None)``: no wakeup is queued, but the loop CONTINUES so other
        due routines this tick are still serviced (the skipped routine's slot has
        already advanced, so it will not re-select).
        """
        now = time.time() if now is None else float(now)
        if not self.heartbeats_enabled():
            return []
        enqueued: list[AgentWakeupRequest] = []
        for _ in range(max(0, int(max_claims))):
            claimed = self.store.claim_due_routine_wakeup(now=now)
            if claimed is None:
                break  # nothing due
            _, wakeup = claimed
            if wakeup is not None:
                enqueued.append(wakeup)
            # wakeup is None → slot advanced but this fire materialized no work;
            # keep draining other due routines.
        return enqueued

    def enqueue_assignment_wakeup(self, profile_id: str, issue_id: str) -> AgentWakeupRequest | None:
        """Event-driven wake: an issue was just assigned to this agent."""
        try:
            profile = self.store.get_agent_profile(profile_id)
        except KeyError:
            return None
        request, _ = self.store.enqueue_wakeup(
            AgentWakeupRequest(
                agent_profile_id=profile.profile_id,
                company_profile_id=profile.company_profile_id,
                source=WakeupSource.ASSIGNMENT.value,
                reason=f"issue_assigned:{issue_id}",
                idempotency_key=f"assignment:{profile_id}:{issue_id}",
                context_snapshot={"issue_id": issue_id},
            )
        )
        return request

    # --- the claim gate + service pass ----------------------------------------

    def service_once(self, *, now: float | None = None) -> ServiceOutcome | None:
        """Claim and service one visible wakeup; None when the queue is empty.

        Gate order (every outcome is a durable row, never silence):
        invokability → per-agent claim lock (hard, cross-process) → budget hard
        stop → work available → workspace lock. Transient conditions (busy
        agent, held workspace) defer: the wakeup terminates as ``skipped`` for
        audit AND a retry wakeup with a future visibility time is enqueued, so
        an event-driven wake is never silently lost.
        """
        wakeup = self.store.claim_next_wakeup(now=now)
        if wakeup is None:
            return None
        try:
            return self._service(wakeup)
        except Exception as exc:  # the engine must outlive a bad wakeup
            self.store.finish_wakeup(wakeup.wakeup_id, status="skipped", detail=f"error:{exc}")
            return ServiceOutcome(
                wakeup_id=wakeup.wakeup_id,
                agent_profile_id=wakeup.agent_profile_id,
                status="skipped",
                detail=f"error:{exc}",
            )

    def _skip(self, wakeup: AgentWakeupRequest, detail: str) -> ServiceOutcome:
        self.store.finish_wakeup(wakeup.wakeup_id, status="skipped", detail=detail)
        return ServiceOutcome(
            wakeup_id=wakeup.wakeup_id,
            agent_profile_id=wakeup.agent_profile_id,
            status="skipped",
            detail=detail,
        )

    def _defer(self, wakeup: AgentWakeupRequest, detail: str) -> ServiceOutcome:
        """Transient condition: durable skip for audit + a deferred retry row.

        Event wakeups are not reproducible (no timer will re-fire them), so a
        busy agent or a held workspace must never evaporate one — the retry
        carries the original source/context and becomes visible after a
        backoff. Coalescing keeps repeated deferrals to a single open row.
        """
        retry = AgentWakeupRequest(
            agent_profile_id=wakeup.agent_profile_id,
            company_profile_id=wakeup.company_profile_id,
            source=wakeup.source,
            reason=f"retry:{detail}",
            idempotency_key=f"retry:{wakeup.agent_profile_id}:{wakeup.source}",
            context_snapshot=dict(wakeup.context_snapshot),
            requested_at=time.time() + self.retry_backoff_seconds,
        )
        self.store.enqueue_wakeup(retry)
        return self._skip(wakeup, f"{detail}:deferred")

    def _service(self, wakeup: AgentWakeupRequest) -> ServiceOutcome:
        # Gate 1: invokability. The profile must exist and the wake channel
        # must be open for this source (timer needs enabled, events need
        # wake_on_demand). These are terminal skips: they only change when a
        # human edits the profile, and editing re-fires its own wakeups later.
        try:
            profile = self.store.get_agent_profile(wakeup.agent_profile_id)
        except KeyError:
            return self._skip(wakeup, "profile_missing")
        policy = heartbeat_policy(profile)
        autonomous_sources = {WakeupSource.TIMER.value, WakeupSource.ROUTINE.value}
        # An autonomous wakeup runs only if BOTH the per-agent policy is enabled AND
        # the instance master switch is on — so disabling the master switch
        # stops already-queued timer/routine wakeups too, not just new enqueues.
        # Event wakeups (assignment / mention) deliberately bypass the master switch.
        if wakeup.source in autonomous_sources and (
            not policy.get("enabled") or not self.heartbeats_enabled()
        ):
            return self._skip(wakeup, "heartbeat_disabled")
        if wakeup.source not in autonomous_sources and not policy.get("wake_on_demand"):
            return self._skip(wakeup, "wake_on_demand_disabled")

        # Gate 2: per-agent claim lock — the HARD concurrency gate. The durable
        # lock table is cross-process atomic, so two daemons (or a daemon and a
        # `daemon tick`) can never double-run one agent. v1 enforces single
        # flight per agent; max_concurrent_runs > 1 is reserved.
        agent_lock_key = f"agent:{profile.profile_id}"
        try:
            self.store.acquire_workspace_lock(
                agent_lock_key,
                workspace_id=profile.workspace_id,
                holder=profile.profile_id,
                issue_id=None,
                run_id=wakeup.wakeup_id,
            )
        except Exception:
            return self._defer(wakeup, "agent_busy")

        try:
            # Gate 3: budget hard stop — serialized under the agent lock, so
            # the read-check-spend sequence cannot race with itself.
            blocked = self._budget_block(profile)
            if blocked:
                # Budgets do not self-heal; a human raises the ceiling. Terminal.
                return self._skip(wakeup, blocked)

            # Gate 3.5: thread reply. A @mention / comment wake names its own issue
            # in the wake context (post_issue_comment stamps issue_id + comment_id).
            # Such a wake drives a RESPOND run on THAT issue — the agent reads the
            # thread and replies — instead of going through work selection, which
            # would idle when the named issue is not claimable work (the bug where a
            # human @mention woke the agent but it never answered). Mirrors
            # Paperclip's ``shouldAutoCheckoutIssueForWake`` returning false for a
            # comment-mention wake: a respond run never checks out / claims / moves
            # the issue — it only reads + comments (governance gates at the tool
            # layer still bound any other action).
            respond_issue = self._thread_directed_issue(wakeup, profile)
            if respond_issue is not None:
                return self._respond(wakeup, profile, respond_issue)

            # Gate 4: work. Ordinary selection runs FIRST so continuation debt
            # keeps the priority _next_work gives it: rework (an in_progress issue
            # whose workspace lock this agent already holds — a QA rejection bounced
            # it back, or a child-done awaits integration) and debt-bearing todos
            # outrank any plain todo. A routine fire's freshly-materialized issue
            # may take the slot over a PLAIN todo (or when the agent would otherwise
            # idle) — anti-starvation / Paperclip per-fire parity — but must NEVER
            # preempt that debt. An idle wake finishes cleanly (idle is not an error).
            issue, needs_checkout = self._next_work(profile)
            selected_is_debt = issue is not None and (
                not needs_checkout  # rework: an in_progress continuation
                or self._pending_continuations(issue)  # a debt-bearing todo
            )
            if not selected_is_debt:
                directed = self._routine_directed_work(wakeup, profile)
                if directed is not None:
                    issue, needs_checkout = directed
            if issue is None:
                self.store.finish_wakeup(wakeup.wakeup_id, status="finished", detail="idle")
                return ServiceOutcome(
                    wakeup_id=wakeup.wakeup_id,
                    agent_profile_id=profile.profile_id,
                    status="finished",
                    detail="idle",
                )

            # Gate 5: workspace lock (kernel checkout — atomic, durable). A
            # held workspace defers: the issue stays todo and the retry row
            # tries again after backoff. Rework skips checkout — the claim and
            # its lock are already this agent's.
            if needs_checkout:
                try:
                    issue = team_kernel.checkout_issue(
                        self.store, issue.issue_id, run_id=wakeup.wakeup_id,
                        holder=profile.profile_id, expected_assignee=profile.profile_id,
                    )
                except team_kernel.ReassignedError:
                    # The issue was reassigned between _next_work and checkout.
                    # Not our work anymore — finish cleanly, the new assignee's
                    # own wakeup will claim it.
                    return self._skip(wakeup, "reassigned")
                except Exception:
                    return self._defer(wakeup, "workspace_locked")

            # All gates passed — run as the bound profile (charter, model and
            # granted equipment ride the run; phase 1 machinery).
            return self._execute(wakeup, profile, issue, is_rework=not needs_checkout)
        finally:
            self.store.release_workspace_lock(agent_lock_key, holder=profile.profile_id)

    def _execute(
        self, wakeup: AgentWakeupRequest, profile: AgentProfile, issue: Any, *, is_rework: bool = False
    ) -> ServiceOutcome:
        run_id: str | None = None
        # The claim token identifies THIS checkout. For a fresh checkout it is
        # this wakeup's id; for a rework pass (no re-checkout) it is the original
        # checkout's token already on the issue. Anchoring against it (not the
        # current wakeup) closes the ABA race without breaking rework.
        claim_token = issue.checkout_run_id
        # Read-only prep happens BEFORE any guard is taken: nothing between the
        # guard acquisition and the try/finally-style releases may raise.
        description = issue.description or issue.title
        if self._pending_continuations(issue):
            # The worker must know WHY it is running again: rejection reasons /
            # finished children and the thread tail ride the goal description
            # (backend-agnostic, same channel the charter prefix uses). This
            # applies to held-lock rework AND a fresh re-claim — the trigger is
            # the pending thread fact, not the lock state.
            description = f"{description}\n\n{self._rework_brief(issue, profile)}"
        exec_repo, guard_key = self._execution_isolation(issue)
        if guard_key is not None:
            # Un-isolatable per_issue workspace: serialize execution defensively.
            try:
                self.store.acquire_workspace_lock(
                    guard_key,
                    workspace_id=issue.workspace_id,
                    holder=profile.profile_id,
                    issue_id=issue.issue_id,
                    run_id=wakeup.wakeup_id,
                )
            except Exception:
                try:
                    team_kernel.abort_checkout(self.store, issue.issue_id, holder=profile.profile_id)
                except Exception:  # pragma: no cover - best-effort unwind
                    pass
                return self._defer(wakeup, "workspace_guard_busy")
        try:
            result = self.orchestrator.run_goal(
                title=issue.title,
                description=description,
                source="team",
                backend_policy=profile.backend_policy,
                permission_policy=self._permission_policy_for(profile),
                repo_path=exec_repo,
                budget_seconds=profile.budget_seconds or self.default_budget_seconds,
                artifact_dir=self.artifact_dir,
                agent_profile_id=profile.profile_id,
                execution_context_extra={
                    "issue_id": issue.issue_id,
                    "company_profile_id": issue.company_profile_id,
                    "workspace_id": issue.workspace_id,
                    "wakeup_id": wakeup.wakeup_id,
                },
            )
            run_id = result.session.run_id
            run_status = result.session.status
            # Anchor the run with a COMPARE-AND-SET (transactional): record the
            # run only if the issue is still in_progress. A human who blocked /
            # requeued / cancelled it during the run wins — the daemon never
            # clobbers that decision (a non-transactional re-read could not
            # close this race; anchor_run_on_issue does it in one transaction).
            anchored = self.store.anchor_run_on_issue(
                issue.issue_id, run_id, expected_checkout_run_id=claim_token
            )
            if anchored is None:
                moved = self.store.get_issue(issue.issue_id)
                detail = f"ran:{run_id}:{run_status}:issue_moved_to_{moved.status}"
                if guard_key is not None:
                    self.store.release_workspace_lock(guard_key, holder=profile.profile_id)
                self.store.finish_wakeup(wakeup.wakeup_id, status="finished", detail=detail)
                return ServiceOutcome(
                    wakeup_id=wakeup.wakeup_id,
                    agent_profile_id=profile.profile_id,
                    status="finished",
                    detail=detail,
                    run_id=run_id,
                    issue_id=issue.issue_id,
                )
            issue = anchored

            if run_status == "completed":
                try:
                    team_kernel.submit_for_review(
                        self.store,
                        issue.issue_id,
                        requested_by=profile.profile_id,
                        summary=f"heartbeat run {run_id} ({run_status})",
                        expected_checkout_run_id=claim_token,
                    )
                except team_kernel.ClaimChangedError:
                    # A requeue + re-checkout landed between anchor and submit —
                    # this run's claim is stale; do NOT submit the new claim's
                    # work. Respect the current owner and finish cleanly.
                    detail = f"ran:{run_id}:claim_changed_before_submit"
                    if guard_key is not None:
                        self.store.release_workspace_lock(guard_key, holder=profile.profile_id)
                    self.store.finish_wakeup(wakeup.wakeup_id, status="finished", detail=detail)
                    return ServiceOutcome(
                        wakeup_id=wakeup.wakeup_id,
                        agent_profile_id=profile.profile_id,
                        status="finished",
                        detail=detail,
                        run_id=run_id,
                        issue_id=issue.issue_id,
                    )
                except team_kernel.IssueHeldError:
                    # A hold landed on the issue while the run was in flight (a
                    # hold does not change status, so the anchor CAS above could
                    # not catch it). The completed work stays in_progress + held;
                    # the operator decides on unhold. Finish cleanly — never
                    # advance a frozen issue to review.
                    detail = f"ran:{run_id}:held_before_submit"
                    if guard_key is not None:
                        self.store.release_workspace_lock(guard_key, holder=profile.profile_id)
                    self.store.finish_wakeup(wakeup.wakeup_id, status="finished", detail=detail)
                    return ServiceOutcome(
                        wakeup_id=wakeup.wakeup_id,
                        agent_profile_id=profile.profile_id,
                        status="finished",
                        detail=detail,
                        run_id=run_id,
                        issue_id=issue.issue_id,
                    )
                # A continuation pass answers its triggers: resolve consumed
                # rejections AND child-done notifications so neither can loop
                # forever on a stale interaction.
                for trigger in self.store.list_issue_interactions(
                    issue_id=issue.issue_id, status="pending", kind="qa_rejection"
                ):
                    self.store.resolve_issue_interaction(trigger.interaction_id)
                for trigger in self.store.list_issue_interactions(
                    issue_id=issue.issue_id, status="pending", kind="completion"
                ):
                    if trigger.continuation_policy == "notify_parent":
                        self.store.resolve_issue_interaction(trigger.interaction_id)
                detail = f"ran:{run_id}:submitted_for_review"
            elif run_status == "WAITING_FOR_HUMAN_GATE":
                # The run's OWN human gate is pending — that is a waiting state,
                # not delivered work. Submitting it for completion review would
                # conflate two different approvals (fail-closed: don't). The
                # issue stays in_progress; the approval decision resumes it.
                detail = f"ran:{run_id}:waiting_human_gate"
            else:
                # A failed run keeps the issue in_progress (and the lock held)
                # so a human or the next wakeup can look at the wreckage —
                # auto-releasing would silently drop a half-done workspace.
                if is_rework:
                    # One rejection buys ONE rework attempt. A failed rework
                    # spends its rejections (resolved, with the failed run in
                    # the payload), otherwise every later heartbeat would
                    # re-pick the same scene and burn budget forever; reviving
                    # the loop takes a fresh human rejection or `issue requeue`.
                    for rejection in self.store.list_issue_interactions(
                        issue_id=issue.issue_id, status="pending", kind="qa_rejection"
                    ):
                        rejection.payload["rework_failed_run_id"] = run_id
                        self.store.save_issue_interaction(rejection)
                        self.store.resolve_issue_interaction(rejection.interaction_id)
                detail = f"ran:{run_id}:{run_status}"

            # Leave a durable, readable trace of the run IN THE THREAD (Paperclip
            # parity): the agent's own message is the conversation, so a reader sees
            # what it did without depending on a live transcript stream. Record-only
            # (no mention/assignee continuations) so it can never spawn a wake/loop.
            self._post_run_record(issue, profile, run_id, run_status)
            self._persist_session_state(profile, issue, run_id, run_status)
            if guard_key is not None:
                self.store.release_workspace_lock(guard_key, holder=profile.profile_id)
            self.store.finish_wakeup(wakeup.wakeup_id, status="finished", detail=detail)
            return ServiceOutcome(
                wakeup_id=wakeup.wakeup_id,
                agent_profile_id=profile.profile_id,
                status="finished",
                detail=detail,
                run_id=run_id,
                issue_id=issue.issue_id,
            )
        except Exception as exc:
            if run_id is None:
                # run_goal can raise AFTER persisting the run (the orchestrator
                # fail-closes the session and re-raises on execution errors), so
                # "no local run_id" does not mean "no run". Recover the anchor
                # by the wakeup marker before deciding.
                recovered = self._find_run_for_wakeup(wakeup.wakeup_id)
                if recovered is not None:
                    run_id = recovered.run_id
            if run_id is None:
                # The run truly never established: nothing to inspect, so
                # un-claim — release the workspace lock and put the issue back
                # to todo. Stranding the claim here would deadlock the
                # workspace on a run that does not exist.
                try:
                    team_kernel.abort_checkout(
                        self.store, issue.issue_id, holder=profile.profile_id
                    )
                except Exception:  # pragma: no cover - best-effort unwind
                    pass
            else:
                # Real wreckage: a run exists and failed. Anchor it for
                # inspection ONLY if the issue is still in_progress — a human
                # who moved it mid-run still wins (CAS, never clobber).
                try:
                    self.store.anchor_run_on_issue(
                        issue.issue_id, run_id, expected_checkout_run_id=claim_token
                    )
                except Exception:  # pragma: no cover - anchor is best-effort
                    pass
            if is_rework:
                # Same rule as the failed-status branch: one rejection buys ONE
                # rework attempt, whether the run died by status or by raise —
                # otherwise the persisted-run-exception path re-picks the scene
                # on every heartbeat and burns budget forever.
                try:
                    for rejection in self.store.list_issue_interactions(
                        issue_id=issue.issue_id, status="pending", kind="qa_rejection"
                    ):
                        rejection.payload["rework_failed_run_id"] = run_id
                        self.store.save_issue_interaction(rejection)
                        self.store.resolve_issue_interaction(rejection.interaction_id)
                except Exception:  # pragma: no cover - spend is best-effort
                    pass
            if guard_key is not None:
                try:
                    self.store.release_workspace_lock(guard_key, holder=profile.profile_id)
                except Exception:  # pragma: no cover
                    pass
            self.store.finish_wakeup(
                wakeup.wakeup_id, status="skipped", detail=f"run_error:{exc}"
            )
            return ServiceOutcome(
                wakeup_id=wakeup.wakeup_id,
                agent_profile_id=profile.profile_id,
                status="skipped",
                detail=f"run_error:{exc}",
                run_id=run_id,
                issue_id=issue.issue_id,
            )

    def _execution_isolation(self, issue: Any) -> tuple[Path, str | None]:
        """(repo_path, guard_lock_key) for executing this issue.

        per_issue workspaces isolate execution: a git repo gets ONE worktree
        per issue (reused across rework passes so the working state survives a
        bounce); a non-git repo cannot isolate, so a defensive workspace guard
        lock serializes execution anyway — the per-issue checkout lock alone
        must never let two runs write the same un-isolated directory.
        """
        try:
            workspace = self.store.get_workspace_profile(issue.workspace_id)
        except Exception:
            return self.repo_path, None
        if workspace.concurrency != "per_issue":
            return self.repo_path, None
        base = Path(workspace.repo_path) if str(workspace.repo_path or ".") != "." else self.repo_path
        if not (base / ".git").exists():
            return base, f"workspace-guard:{workspace.workspace_id}"
        worktree = base / ".superclaw" / "worktrees" / issue.issue_id
        if worktree.exists():
            # Trust only a REAL attached worktree (a `.git` file pointing back
            # to the repo). A half-created plain directory must not silently
            # become the execution target — fall through to the guard.
            if (worktree / ".git").exists():
                return worktree, None
            return base, f"workspace-guard:{workspace.workspace_id}"
        try:
            import subprocess

            worktree.parent.mkdir(parents=True, exist_ok=True)
            branch = f"issue/{issue.issue_id}"
            created = subprocess.run(
                ["git", "-C", str(base), "worktree", "add", "-b", branch, str(worktree)],
                capture_output=True, text=True, timeout=60,
            )
            if created.returncode != 0:
                # The branch may already exist (a recovered issue): attach to it.
                created = subprocess.run(
                    ["git", "-C", str(base), "worktree", "add", str(worktree), branch],
                    capture_output=True, text=True, timeout=60,
                )
            if created.returncode == 0:
                return worktree, None
        except Exception:  # pragma: no cover - isolation failure falls through
            pass
        # Could not isolate: fail safe to the guard-serialized base repo.
        return base, f"workspace-guard:{workspace.workspace_id}"

    def _permission_policy_for(self, profile: AgentProfile) -> Any:
        """The run's tool posture for this agent (fail-closed, projection-proof).

        Precedence: an EXPLICIT profile ``permission_policy`` wins outright (it
        does not inherit — so a read-only agent stays read-only even in a
        permissive workspace); an empty profile policy inherits the workspace's
        ``default_permission_policy``; if both are empty the floor is an
        explicit read-only ``plan`` mode — NOT None.

        Why an explicit floor instead of None: the orchestrator's plugin
        projection turns a None policy into ``PermissionPolicy()`` (mode
        ``default``) when MCP plugins are projectable, silently punching
        through fail-closed. An explicit ``plan`` mode survives projection
        (replace() preserves the mode; only mcp_configs are appended), so a
        no-grant agent can reason/read but never freely write or run shell.

        Grants: both ``ask`` and ``allow`` -> bypassPermissions (the runtime is
        a pure execution engine handed max permission; see permissions.py
        doctrine). The explicit ``plan`` floor above and the pay/scan hard gates
        stay independent of this posture.
        """
        from superclaw.runtime import PermissionPolicy

        fields = {"mode", "allowed_tools", "disallowed_tools", "mcp_configs", "plugin_dirs", "session_id"}
        raw = dict(profile.permission_policy or {})
        if not raw:
            try:
                ws = self.store.get_workspace_profile(profile.workspace_id)
                raw = dict(ws.default_permission_policy or {})
            except Exception:
                raw = {}
        if not raw:
            raw = {"mode": "plan"}  # fail-closed floor: read-only, projection-proof
        # A stored policy with an unknown/empty mode must not silently become a
        # permissive 'default' — fail closed to read-only.
        valid_modes = {"plan", "default", "acceptEdits", "auto", "bypassPermissions", "dontAsk"}
        if str(raw.get("mode") or "") not in valid_modes:
            raw["mode"] = "plan"
        return PermissionPolicy(**{k: v for k, v in raw.items() if k in fields})

    def _pending_continuations(self, issue: Any) -> list[Any]:
        """Pending thread facts that demand a continuation pass on this issue."""
        rejections = self.store.list_issue_interactions(
            issue_id=issue.issue_id, status="pending", kind="qa_rejection"
        )
        child_done = [
            i
            for i in self.store.list_issue_interactions(
                issue_id=issue.issue_id, status="pending", kind="completion"
            )
            if i.continuation_policy == "notify_parent"
        ]
        return rejections + child_done

    def _prior_pass_context(self, profile: AgentProfile, issue: Any) -> list[str]:
        """Session continuity (layer 2 consumption): what the last pass did.

        The task session anchors the issue's previous run; its status and
        verdict ride the continuation brief so a resumed pass builds on the
        prior working state (the worktree, preserved by 3c) instead of
        starting cold. Native backend session resume stays a follow-up —
        this is the backend-agnostic floor.
        """
        session = self.store.get_agent_task_session(profile.profile_id, issue.issue_id)
        if session is None or not session.last_run_id:
            return []
        lines = [f"- Prior pass: run {session.last_run_id}"]
        if session.session_ref:
            lines.append(f"  Resume pointer: {session.session_ref}")
        try:
            run = self.store.get_run(session.last_run_id)
            lines[-1] += f" finished {run.status}"
        except KeyError:
            if session.last_run_status:
                lines[-1] += f" finished {session.last_run_status}"
            pass
        backlog = session.backlog_summary or {}
        if backlog.get("pending_continuations"):
            lines.append(
                f"  Backlog: {backlog['pending_continuations']} pending continuation(s)"
            )
        if backlog.get("pending_kinds"):
            lines.append(f"  Pending kinds: {', '.join(backlog['pending_kinds'])}")
        # Paperclip-style "Files Touched": the changed-file pointers from the issue's
        # OWN last run. The rework brief already surfaces CHILD pointers (delegated
        # completions) but not the issue's own, so a resumed pass could not see what
        # it had already changed. Reuses the captured git-diff pointers (same source
        # as the A2A / completion handoffs); absent/unreadable → skipped, and
        # render_brief renders a failed/unavailable capture explicitly ("UNKNOWN —
        # re-scan"), never a misleading empty.
        pointer_brief = None
        try:
            evidence = self.store.get_evidence(session.last_run_id)
            raw_pointers = (evidence.backend_summary or {}).get("context_pointers")
            if raw_pointers is not None:
                # render_brief carries its own context-specific prefix (no double
                # prefix); it is type-defensive, but the whole read+render stays in
                # this guard so a brief never crashes the resumed pass (fail-open).
                pointer_brief = ContextPointersCapture.from_dict(raw_pointers).render_brief(
                    prefix="Files you changed last pass"
                )
        except Exception:  # pragma: no cover - a brief is an aid, never a gate
            pointer_brief = None
        if pointer_brief:
            lines.append(f"  {pointer_brief}")
        lines.append(
            "  Your previous working state is preserved in the workspace — continue from it."
        )
        return lines

    def _rework_brief(self, issue: Any, profile: AgentProfile | None = None) -> str:
        """The continuation context block: prior pass, rejections, finished children, thread tail."""
        lines = ["## Continuation context"]
        if profile is not None:
            lines.extend(self._prior_pass_context(profile, issue))
        for rejection in self.store.list_issue_interactions(
            issue_id=issue.issue_id, status="pending", kind="qa_rejection"
        ):
            reason = str(rejection.payload.get("reason") or "").strip()
            lines.append(f"- Review was REJECTED: {reason or '(no reason given)'}")
        for done in self.store.list_issue_interactions(
            issue_id=issue.issue_id, status="pending", kind="completion"
        ):
            if done.continuation_policy == "notify_parent":
                line = (
                    f"- Delegated child finished: {done.payload.get('child_title')} "
                    f"({done.payload.get('child_issue_id')}) — integrate its result and decide what's next."
                )
                # If the child's changed-file pointers rode the completion, show
                # them so the parent integrates incrementally (§2.7 ②). Only when
                # the key is actually present — an absent key (e.g. a completion
                # predating this feature) must NOT render a misleading "UNKNOWN".
                raw_pointers = done.payload.get("context_pointers")
                if raw_pointers is not None:
                    brief = ContextPointersCapture.from_dict(raw_pointers).render_brief()
                    if brief:
                        line += f"\n  {brief}"
                lines.append(line)
        comments = self.store.list_issue_comments(issue.issue_id)
        if comments:
            lines.append("Recent thread:")
            for comment in comments[-5:]:
                lines.append(f"- [{comment.author_type}:{comment.author_id}] {comment.body}")
        lines.append("Address the items above before resubmitting for review.")
        return "\n".join(lines)

    def _find_run_for_wakeup(self, wakeup_id: str) -> Any:
        """The run a wakeup's execution established, if any (newest first).

        ``execution_context_extra`` stamps every daemon-started run with its
        wakeup_id before execution begins, so a run that persisted and then
        died is always discoverable here.
        """
        try:
            candidates = [
                session
                for session in self.store.list_runs()
                if (session.execution_context or {}).get("wakeup_id") == wakeup_id
            ]
            candidates.sort(key=lambda s: getattr(s, "created_at", 0.0), reverse=True)
            return candidates[0] if candidates else None
        except Exception:  # pragma: no cover - recovery probe is best-effort
            return None

    # --- gate helpers ----------------------------------------------------------

    def _budget_block(self, profile: AgentProfile) -> str | None:
        """Hard budget gate: token and run-count ceilings from the profile.

        0 = unbounded at this layer. The relay lane's server-side quota is a
        separate authority — when the relay refuses, the run itself fails —
        this gate is the local fail-safe that stops scheduling *before* spend.
        """
        if profile.token_budget and profile.token_budget > 0:
            summary = self.store.summarize_cost(agent_profile_id=profile.profile_id)
            if int(summary.get("total_tokens") or 0) >= profile.token_budget:
                return f"budget_exceeded:tokens:{summary.get('total_tokens')}>={profile.token_budget}"
        if profile.run_count_budget and profile.run_count_budget > 0:
            summary = self.store.summarize_cost(agent_profile_id=profile.profile_id)
            if int(summary.get("event_count") or 0) >= profile.run_count_budget:
                return f"budget_exceeded:runs:{summary.get('event_count')}>={profile.run_count_budget}"
        return None

    # Loop backstop for thread replies: an agent will not start another respond
    # run on an issue it commented on within this window. Breaks an A<->B @-reply
    # chain even when budgets are unlimited (the default 0), without blocking a
    # genuine later reply once the conversation has paused.
    _RESPOND_COOLDOWN_SECONDS = 45.0

    def _routine_directed_work(
        self, wakeup: AgentWakeupRequest, profile: AgentProfile
    ) -> tuple[Any, bool] | None:
        """The fresh routine issue THIS wake should run (needs checkout), or None.

        A ``source="routine"`` wake carries the ``issue_id`` of the issue its
        claim just materialized (``StateStore.claim_due_routine_wakeup``). Driving
        that issue directly — instead of letting ``_next_work`` pick the globally
        oldest/highest-priority plain todo — is what makes a routine fire run the
        work it created (Paperclip per-fire run parity), so a busy agent's older
        plain-todo backlog cannot starve the scheduled work. The CALLER only
        consults this AFTER ``_next_work`` so continuation debt still wins (see
        Gate 4); this helper never reorders ahead of rework.

        The returned issue can only ever be a legitimate target: same-company,
        assigned to THIS agent, still a fresh unclaimed ``todo``, not held. Any
        other condition (not a routine wake, missing/foreign issue, already moved
        on, or administratively held) returns None and the caller falls back to
        ``_next_work``'s ordinary pick — so the directed path can only NARROW the
        choice to a legitimate own todo, never authorize an issue the agent could
        not otherwise claim.
        """
        if (wakeup.source or "") != WakeupSource.ROUTINE.value:
            return None
        snapshot = wakeup.context_snapshot or {}
        issue_id = snapshot.get("issue_id")
        if not issue_id:
            return None
        try:
            issue = self.store.get_issue(str(issue_id))
        except Exception:  # missing issue / store hiccup → fall back, never crash
            return None
        if issue.company_profile_id != profile.company_profile_id:
            return None
        if issue.assignee_agent_profile_id != profile.profile_id:
            return None
        # Only a still-fresh, unclaimed todo is directed work. If a prior wake
        # already moved it (in_progress/in_review/done) or an operator paused it,
        # defer to ordinary selection so we never double-checkout or fight a hold.
        if issue.status != IssueStatus.TODO.value:
            return None
        if self.store.issue_is_held(issue.issue_id):
            return None
        return issue, True  # fresh todo → needs checkout

    def _thread_directed_issue(self, wakeup: AgentWakeupRequest, profile: AgentProfile) -> Any | None:
        """The issue an explicit @mention wake should drive a RESPOND run on, or None.

        ONLY an explicit ``@mention`` wake (reason ``mention:<issue>``) drives a
        respond run. A bare ``comment:`` (assignee) wake is deliberately NOT a
        respond trigger — it stays on the normal work path, because the kernel also
        raises a ``comment:`` wake for SYSTEM audit comments (``[review rejected]`` /
        ``[revision requested]``). Treating those as respond runs hijacked the
        rework path and re-burned a spent rejection (one rejection = one attempt) —
        the no-burn-loop regression. Returns the issue only when:
          * the wake is an explicit ``mention:`` with an issue in context,
          * the issue resolves in the agent's OWN company (fail-closed otherwise),
          * the issue has NO pending continuation. A pending qa_rejection /
            notify_parent means the issue is in active rework/integration — the
            WORK path owns that wake (it reads the recent thread anyway); a respond
            run must not pre-empt it (defence in depth on the no-burn invariant)."""
        reason = wakeup.reason or ""
        if not reason.startswith("mention:"):
            return None
        snapshot = wakeup.context_snapshot or {}
        issue_id = snapshot.get("issue_id")
        if not issue_id:
            return None
        try:
            issue = self.store.get_issue(str(issue_id))
        except Exception:  # missing issue / store hiccup → fail-closed, never crash the daemon
            return None
        if issue.company_profile_id != profile.company_profile_id:
            return None
        if self._pending_continuations(issue):
            # In rework/integration — the work path owns this wake (no re-burn).
            return None
        return issue

    # A run record posted to the thread is capped so a long model turn cannot
    # bloat the conversation (the full output stays on the run's event channel).
    _RUN_RECORD_MAX_CHARS = 4000

    def _run_output_text(self, run_id: str | None) -> str:
        """The agent's final message text for a run, reconstructed from its durable
        ``message.completed`` display events (the same text the live transcript
        shows). Best-effort: returns '' on any miss so a run record never fails the
        run. Capped to keep the thread readable."""
        if not run_id:
            return ""
        parts: list[str] = []
        try:
            for event in self.store.list_events(run_id):
                if not isinstance(event, dict) or event.get("type") != "message.completed":
                    continue
                payload = event.get("payload")
                text = payload.get("text") if isinstance(payload, dict) else None
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        except Exception:  # any extraction hiccup → no record, never raise
            return ""
        joined = "\n\n".join(parts).strip()
        if len(joined) > self._RUN_RECORD_MAX_CHARS:
            joined = joined[: self._RUN_RECORD_MAX_CHARS].rstrip() + "\n\n… (truncated; full output on the run)"
        return joined

    def _post_run_record(self, issue: Any, profile: AgentProfile, run_id: str | None, run_status: str) -> None:
        """Post the agent's run output to the issue thread as a durable, readable
        message — so the thread IS the conversation (Paperclip parity), visible live
        or after, independent of any live transcript stream.

        Written with ``add_issue_comment`` (NOT ``post_issue_comment``): a record is
        not a fresh ping, so it fires NO mention/assignee continuation and can never
        spawn a wake or a respond loop. Authored by the agent (it is the agent's own
        message). Skipped when there is no output text (nothing to say)."""
        # The ENTIRE body is guarded (including _run_output_text): a thread record
        # is best-effort decoration on the run-completion tail — it must NEVER raise
        # there (it runs before _persist_session_state / lock release / finish_wakeup,
        # so a raise could strand the lock or skip finishing the wake).
        try:
            body = self._run_output_text(run_id)
            if not body:
                return
            self.store.add_issue_comment(
                IssueComment(
                    issue_id=issue.issue_id,
                    company_profile_id=issue.company_profile_id,
                    body=body,
                    author_type="agent",
                    author_id=profile.profile_id,
                )
            )
        except Exception:  # pragma: no cover - a record must never fail the run
            pass

    def _respond_brief(self, issue: Any) -> str:
        """The goal a respond run carries: the thread + an instruction to reply."""
        lines = [
            f"You were notified on issue {issue.issue_id}: {issue.title}",
            (issue.description or "").strip(),
            "",
            "## Recent thread",
        ]
        for comment in self.store.list_issue_comments(issue.issue_id)[-8:]:
            lines.append(f"- [{comment.author_type}:{comment.author_id}] {comment.body}")
        lines.append("")
        lines.append(
            "Read the thread above and respond IN THE THREAD: post a comment on this "
            "issue that @-mentions the person who pinged you, with your answer or "
            "status. You have NOT checked this issue out — do not change its status, "
            "assignee, or files; your job on this wake is to reply. (Acting on work "
            "you own is a separate, assigned run.)"
        )
        return "\n".join(line for line in lines if line is not None)

    def _respond_repo(self, wakeup: AgentWakeupRequest) -> Path:
        """Repo for a respond run: an ISOLATED throwaway dir, never the shared
        workspace. A reply is not exclusive work — running it in the live workspace
        (with no checkout / no lock) would risk dirty reads/writes against a
        concurrent work run, so the respond run gets its own scratch dir. The reply
        context is the thread (carried in the brief), not the repo. Falls back to a
        fresh temp dir, never to the live workspace."""
        base = Path(self.artifact_dir) / "respond" / wakeup.wakeup_id
        try:
            base.mkdir(parents=True, exist_ok=True)
            return base
        except Exception:  # pragma: no cover - artifact dir unwritable
            return Path(tempfile.mkdtemp(prefix="superclaw-respond-"))

    def _recent_respond_attempt(self, profile_id: str, issue_id: str, now: float) -> bool:
        """True if this agent ATTEMPTED a respond run on this issue within the
        cooldown. Counts finished respond runs (detail ``ran:…``) — an attempt that
        left no comment must still cool down, otherwise a ``no_response`` run could
        be re-burned immediately under an unlimited (default 0) budget. This is the
        per-ATTEMPT loop / Denial-of-Wallet backstop (not per successful comment)."""
        try:
            recent = self.store.list_wakeups(agent_profile_id=profile_id, status="finished", limit=500)
        except Exception:
            return False
        for w in recent:
            # str-normalize: a snapshot value deserialized as int must still match a
            # str issue_id (else the cooldown silently misses → DoW bypass).
            if str((w.context_snapshot or {}).get("issue_id")) != str(issue_id):
                continue
            reason = w.reason or ""
            if not (reason.startswith("mention:") or reason.startswith("comment:")):
                continue
            if not (w.detail or "").startswith("ran:"):
                continue  # only real runs count — a prior skip burned nothing
            if w.finished_at and (now - w.finished_at) < self._RESPOND_COOLDOWN_SECONDS:
                return True
        return False

    # A reply is short work; cap it hard so a hung model turn cannot hold the
    # per-agent lock indefinitely (the run budget is also the backend request
    # timeout, so a bounded budget makes a stuck turn time out and release the
    # lock). NEVER unlimited — a respond run ignores a 0/unset profile budget here.
    # This is the COST/duration backstop that complements the liveness reaper:
    # liveness frees locks of dead/crashed runs; this bound makes a hung-but-still-
    # leasing respond turn terminate so its lock is freed too (Paperclip keeps both
    # a budget and a liveness reaper, not one or the other).
    _RESPOND_BUDGET_CAP_SECONDS = 180

    def _respond_budget_seconds(self, profile: AgentProfile) -> int:
        # int-coerce defensively: a budget loaded as a string ("120") must not make
        # the comparison raise; a malformed value degrades to the hard cap.
        try:
            configured = int(profile.budget_seconds or self.default_budget_seconds or 0)
        except (TypeError, ValueError):
            configured = 0
        if configured <= 0:
            return self._RESPOND_BUDGET_CAP_SECONDS
        return min(configured, self._RESPOND_BUDGET_CAP_SECONDS)

    def _respond(
        self, wakeup: AgentWakeupRequest, profile: AgentProfile, issue: Any
    ) -> ServiceOutcome:
        """Run the agent to REPLY to a thread-directed wake — no checkout, no claim,
        no disposition change, in an isolated scratch repo (Paperclip's no-checkout
        mention run). Governance gates still bind every tool action (company_autonomy
        / pay / scan), so a reply on a non-owned issue can comment but cannot mutate
        it; disposition/files are out of reach (no checkout + scratch repo)."""
        now = time.time()
        # Per-attempt loop / Denial-of-Wallet backstop.
        if self._recent_respond_attempt(profile.profile_id, issue.issue_id, now):
            return self._skip(wakeup, "respond_cooldown")

        try:
            existing_ids = {c.comment_id for c in self.store.list_issue_comments(issue.issue_id)}
        except Exception:
            existing_ids = set()

        run_id: str | None = None
        try:
            result = self.orchestrator.run_goal(
                title=f"Respond on issue {issue.issue_id}",
                description=self._respond_brief(issue),
                source="team",
                backend_policy=profile.backend_policy,
                permission_policy=self._permission_policy_for(profile),
                repo_path=self._respond_repo(wakeup),
                budget_seconds=self._respond_budget_seconds(profile),
                artifact_dir=self.artifact_dir,
                agent_profile_id=profile.profile_id,
                execution_context_extra={
                    "issue_id": issue.issue_id,
                    "company_profile_id": issue.company_profile_id,
                    "workspace_id": issue.workspace_id,
                    "wakeup_id": wakeup.wakeup_id,
                    "respond_mode": True,
                },
            )
            run_id = result.session.run_id
        except Exception as exc:  # the engine must outlive a bad respond run
            return self._skip(wakeup, f"respond_error:{exc}")

        # Did the agent actually reply? A NEW comment it authored (by id, not a
        # clock comparison) means responded; otherwise record no_response (NEVER
        # idle — the wake DID drive a run, and silence is a signal we must not hide).
        try:
            after = self.store.list_issue_comments(issue.issue_id)
        except Exception:
            after = []
        replied = any(
            c.author_id == profile.profile_id and c.comment_id not in existing_ids
            for c in after
        )
        if not replied:
            # The agent ran but posted no reply of its own — still surface its output
            # in the thread (record-only) so a reader sees what it said, instead of a
            # silent no_response. If it DID reply, that comment is already the content.
            self._post_run_record(issue, profile, run_id, "responded")
        detail = f"ran:{run_id}:{'responded' if replied else 'no_response'}"
        self.store.finish_wakeup(wakeup.wakeup_id, status="finished", detail=detail)
        return ServiceOutcome(
            wakeup_id=wakeup.wakeup_id,
            agent_profile_id=profile.profile_id,
            status="finished",
            detail=detail,
            run_id=run_id,
            issue_id=issue.issue_id,
        )

    def _next_work(self, profile: AgentProfile) -> tuple[Any, bool]:
        """(issue, needs_checkout) — rework before new claims.

        Rework = an in_progress issue assigned to this agent whose workspace
        lock the agent still holds for that issue (a QA rejection sent it
        back; the claim never released). It executes without a re-checkout.
        A fresh claim = the oldest highest-priority todo issue.
        """
        mine = [
            issue
            for issue in self.store.list_issues(company_profile_id=profile.company_profile_id)
            if issue.assignee_agent_profile_id == profile.profile_id
            # A held issue is administratively paused — skip it for BOTH fresh
            # pickup and rework (checkout would refuse it anyway; this keeps the
            # daemon from spinning on a tree the operator paused).
            and not self.store.issue_is_held(issue.issue_id)
        ]
        rework = [i for i in mine if i.status == IssueStatus.IN_PROGRESS.value]
        rework.sort(key=lambda i: (_ISSUE_PRIORITY_RANK.get(i.priority, 4), i.created_at))
        for issue in rework:
            # Look up by the PINNED key: the lock the claim actually holds,
            # immune to any later concurrency-declaration drift.
            lock = self.store.get_workspace_lock(team_kernel.issue_release_key(issue, store=self.store))
            if lock is None or lock.issue_id != issue.issue_id or lock.holder != profile.profile_id:
                continue
            # Only explicitly-continued work re-executes. A failed run's
            # wreckage also sits in_progress under its lock, but auto-retrying
            # it would destroy the inspection scene — continuation needs a
            # pending thread fact: a qa_rejection (bounce-back) or a
            # notify_parent completion (a delegated child finished and the
            # manager must integrate / decide what's next).
            if self._pending_continuations(issue) and not self._issue_has_live_run(issue):
                return issue, False
        todo = [i for i in mine if i.status == IssueStatus.TODO.value]
        # Debt first: an issue with pending continuation facts (a finished
        # child waiting to be integrated, a rejection to answer) outranks any
        # plain todo — a child_done wakeup must converge on the parent even
        # when older or higher-priority fresh work exists.
        todo.sort(
            key=lambda i: (
                0 if self._pending_continuations(i) else 1,
                _ISSUE_PRIORITY_RANK.get(i.priority, 4),
                i.created_at,
            )
        )
        return (todo[0], True) if todo else (None, False)

    def _issue_has_live_run(self, issue: Any) -> bool:
        """Whether the issue's pinned run still OCCUPIES it (is non-terminal).

        Uses the canonical ACTIVE_RUN_STATUSES, which includes
        WAITING_FOR_HUMAN_GATE: a run parked at a human gate is paused, not dead —
        it still owns the issue. Excluding it would let the rework loop treat the
        run as crashed and spawn a SECOND executor on the same issue, racing the
        operator and bypassing the human gate. Only a terminal run frees the issue
        for re-pickup.
        """
        if not issue.execution_run_id:
            return False
        try:
            run = self.store.get_run(issue.execution_run_id)
        except KeyError:
            return False
        return run.status in ACTIVE_RUN_STATUSES

    def _persist_session_state(
        self, profile: AgentProfile, issue: Any, run_id: str, run_status: str
    ) -> None:
        """Layers 1+2 of session continuity (best-effort, never blocks)."""
        try:
            summary = self.store.summarize_cost(agent_profile_id=profile.profile_id)
            runtime = self.store.get_agent_runtime_state(profile.profile_id) or AgentRuntimeState(
                agent_profile_id=profile.profile_id
            )
            runtime.last_run_id = run_id
            runtime.last_run_status = run_status
            runtime.total_input_tokens = int(summary.get("input_tokens") or 0)
            runtime.total_output_tokens = int(summary.get("output_tokens") or 0)
            runtime.total_cost_cents = int(summary.get("total_cost_cents") or 0)
            self.store.save_agent_runtime_state(runtime)
            self.store.save_agent_task_session(
                AgentTaskSession(
                    agent_profile_id=profile.profile_id,
                    task_key=issue.issue_id,
                    company_profile_id=profile.company_profile_id,
                    backend=profile.backend_policy,
                    session_ref=self._session_ref(profile, run_id),
                    last_run_id=run_id,
                    last_run_status=run_status,
                    backlog_summary=self._backlog_summary(issue),
                )
            )
        except Exception:  # pragma: no cover - continuity must not block
            pass

    def _session_ref(self, profile: AgentProfile, run_id: str) -> str:
        """Best available resume pointer for a task session.

        Native backend resume remains backend-specific. The daemon stores the
        strongest durable pointer it can derive now: a native id if the run
        recorded one, otherwise the SuperClaw run id as an auditable anchor.
        """
        try:
            run = self.store.get_run(run_id)
            ctx = run.execution_context or {}
        except Exception:
            ctx = {}
        for key in ("native_session_id", "codex_thread_id", "thread_id", "session_id"):
            value = ctx.get(key)
            if isinstance(value, str) and value:
                return f"{profile.backend_policy}:{value}"
        return f"run:{run_id}"

    def _backlog_summary(self, issue: Any) -> dict[str, Any]:
        """Compact pending-work facts to carry over daemon interruptions."""
        pending = self._pending_continuations(issue)
        return {
            "issue_id": issue.issue_id,
            "issue_status": issue.status,
            "pending_continuations": len(pending),
            "pending_kinds": sorted({str(item.kind) for item in pending}),
            "pending_interaction_ids": [item.interaction_id for item in pending],
            "comment_count": len(self.store.list_issue_comments(issue.issue_id)),
        }

    # --- the loop ---------------------------------------------------------------

    def run_forever(
        self,
        *,
        interval_seconds: float = 15.0,
        stop_check: Callable[[], bool] | None = None,
        max_services_per_cycle: int = 8,
        worker_threads: int = 4,
    ) -> None:
        """The daemon main loop: heal, then tick + drain until stopped.

        Service passes run on a small thread pool so one long model run never
        freezes the scheduler: the per-agent claim lock and the workspace lock
        (both cross-process atomic) are what serialize work, not the loop.
        The scheduler thread itself only ticks timers and dispatches.
        """
        from concurrent.futures import ThreadPoolExecutor

        self.startup_self_heal()
        # Telemetry gets its OWN single-thread executor, isolated from the
        # agent-servicing pool: a slow/stuck collector can occupy ONLY this
        # dedicated thread, never an agent-servicing worker — so wakeup dispatch
        # is unaffected even with worker_threads=1.
        with ThreadPoolExecutor(max_workers=max(1, int(worker_threads))) as pool, \
                ThreadPoolExecutor(max_workers=1, thread_name_prefix="telemetry-spool") as tele_pool:
            in_flight: list[Any] = []
            while not (stop_check and stop_check()):
                try:
                    self.tick_timers()
                    self.tick_scheduled_triggers()
                    # Continuously reap stale per-agent locks (Paperclip-native: by
                    # run liveness, not a fixed run-duration cap) so an agent never
                    # stays stuck agent_busy — recovers WITHOUT a restart. Cheap when
                    # nothing is stuck (no `claimed` wakeups → no run scan).
                    self.reclaim_stale_agent_locks()
                    # Continuously reap TRUE-orphan workspace/issue checkout locks
                    # (Paperclip-native: by run liveness, not a duration cap) so an
                    # issue never strands in_progress behind a lock no live run backs
                    # — recovers WITHOUT a restart. Cheap when nothing is stuck
                    # (no checkout locks → no run scan).
                    self.reclaim_stale_workspace_locks()
                    # Auto-advance claimed marketplace orders between the human gates
                    # (opt-in via SUPERCLAW_MARKETPLACE_AUTO_ADVANCE=1; cheap no-op
                    # otherwise). Makes接单 run to completion without a manual
                    # `marketplace advance`, while claim/submit stay human-gated.
                    self.reconcile_marketplace_orders()
                    self._maybe_spool_telemetry(time.time(), tele_pool)
                    # Autonomous goal continuation (PR8) — OFF-THREAD on the worker
                    # pool so a goal run never freezes the scheduler, and a strict
                    # no-op while the flag is off. One pass in flight at a time.
                    self._maybe_continue_goals(pool)
                    in_flight = [f for f in in_flight if not f.done()]
                    queued = len(self.store.list_wakeups(status="queued", limit=max_services_per_cycle))
                    capacity = max(0, max_services_per_cycle - len(in_flight))
                    for _ in range(min(queued, capacity)):
                        in_flight.append(pool.submit(self.service_once))
                except Exception:  # pragma: no cover - the loop must survive
                    pass
                time.sleep(max(1.0, float(interval_seconds)))

    def tick_goal_continuation(self, *, max_goals: int = 1) -> list[str]:
        """Run one autonomous goal-continuation pass — auto-start CONFIRMED active goals
        with no live run (PR8). A strict no-op while the ``goal_autonomous_continuation``
        flag is off (fail-closed default). Daemon-safe single-flight + each run's own
        governance live in the kernel; this is the daemon's entry to that tick."""
        from superclaw import goal_mode

        # Forward the daemon's OWN execution context (operator-selected repo, artifacts
        # root, budget) so an autonomously-continued goal runs in the right place with
        # the right budget — never the daemon process cwd / the kernel fallbacks.
        return goal_mode.continue_active_goals(
            self.orchestrator,
            max_goals=max_goals,
            repo_path=self.repo_path,
            budget_seconds=self.default_budget_seconds,
            artifact_dir=self.artifact_dir,
        )

    def _maybe_continue_goals(self, pool: Any) -> None:
        """Dispatch a goal-continuation pass on the worker pool, never the scheduler
        thread, with at most one pass in flight. Fail-soft: a tick error is swallowed so
        autonomous continuation can never break the daemon. Cheap no-op when the flag is
        off (the kernel tick early-returns before any run)."""
        prior = getattr(self, "_goal_continuation_future", None)
        if prior is not None and not prior.done():
            return  # a previous continuation pass is still running
        self._goal_continuation_future = pool.submit(self._continue_goals_once)

    def _continue_goals_once(self) -> None:
        try:
            self.tick_goal_continuation()
        except Exception:  # pragma: no cover - autonomy must never break the daemon
            pass

    def _maybe_spool_telemetry(self, now: float, pool: Any) -> None:
        """Throttled, OFF-THREAD, FAIL-SOFT periodic telemetry upload. The actual
        ``tick()`` (real network I/O, up to its own timeout) runs on the worker
        ``pool`` — NEVER on the scheduler thread — so a stuck collector cannot
        delay wakeup dispatch. Throttled (~5 min) and skipped while a prior spool
        is still in flight, so it never piles up. Wiring it here is what makes a
        staging bundle "install and it reports" without a separate cron; the
        spooler's own fail-closed gate keeps it a cheap no-op on every other
        build (non-staging / no endpoint)."""
        interval = float(os.environ.get("SUPERCLAW_TELEMETRY_SPOOL_INTERVAL_SECONDS", "300") or 300)
        if interval <= 0:
            return
        prior = getattr(self, "_telemetry_future", None)
        if prior is not None and not prior.done():
            return  # a previous spool is still running — don't queue another
        last = getattr(self, "_telemetry_last_spool", 0.0)
        if now - last < interval:
            return
        self._telemetry_last_spool = now
        self._telemetry_future = pool.submit(self._spool_telemetry_once)

    def _spool_telemetry_once(self) -> None:
        """Run one telemetry spool on a worker thread. FAIL-SOFT: any error
        (network, deserialization, cursor write) is swallowed — telemetry must
        never break the daemon."""
        try:
            spooler = getattr(self, "_telemetry_spooler", None)
            if spooler is None:
                from .telemetry_upload import TelemetryConfig, UploadSpooler

                spooler = UploadSpooler(self.store, TelemetryConfig.from_env())
                self._telemetry_spooler = spooler
            spooler.tick()
        except Exception:  # pragma: no cover - telemetry must never break the daemon
            pass
