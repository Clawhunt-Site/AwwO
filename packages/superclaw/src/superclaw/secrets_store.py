"""Company secrets + instance settings kernel（Paperclip 拿取清单 §6，本地 v1）。

Schema/语义镜像官方 Paperclip：company_secrets 台账 + company_secret_versions
（简化版）+ company_secret_bindings（声明式授权，required 缺失 → 不可调用，接
invokability 闸门）+ secret_access_events（append-only 审计，denied 也记）+
instance_settings 单例（general/experimental 两 JSON 桶）。

Provider 本地 v1 仅 ``local_encrypted``（AES-256-GCM）：
  - master key 来源（优先级）：``SUPERCLAW_SECRETS_MASTER_KEY``（32 字节，
    base64/hex/原文均可）> ``~/.superclaw/secrets.key``（自动生成，0600）。
  - 外部 vault（provider_configs）/ environments 租约推 B 端里程碑。

安全硬约束：
  - 明文只在 ``resolve_secret`` / ``resolve_env_for_target`` 的返回值里出现，
    任何摘要/列表/审计/异常信息都只有掩码与哈希；
  - 解析必须经 binding 授权（fail-closed）：无 binding → 拒绝并落 denied 审计；
  - 归档的 secret 不可解析；required binding 指向缺失/归档 secret → 目标不可调用。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import secrets as _pysecrets
from dataclasses import dataclass
from pathlib import Path
from time import time
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from superclaw.models import (
    CompanySecret,
    CompanySecretBinding,
    CompanySecretVersion,
    InstanceSettings,
    SecretAccessEvent,
)
from superclaw.state import StateStore

MASTER_KEY_ENV = "SUPERCLAW_SECRETS_MASTER_KEY"
KEY_PATH_ENV = "SUPERCLAW_SECRETS_KEY_PATH"
DEFAULT_KEY_PATH = Path.home() / ".superclaw" / "secrets.key"
SCHEME = "local_encrypted_v1"
PROVIDER = "local_encrypted"

# binding 目标类型白名单（v1）。镜像 Paperclip 的消费方语义，收窄到本地已有实体。
BINDING_TARGET_TYPES = ("agent_profile", "plugin", "backend", "company", "runtime")


class SecretStoreError(RuntimeError):
    """User-facing, actionable error. NEVER carries secret plaintext."""


def mask_value(value: str) -> str:
    """Mask for display: short values are fully hidden; longer ones keep a
    4-char prefix. Mirrors the relay-key masking posture (never length-revealing
    beyond the bucket)."""
    if not value:
        return "unset"
    if len(value) < 8:
        return "set"
    return f"{value[:4]}…({hashlib.sha256(value.encode('utf-8')).hexdigest()[:8]})"


# --- master key ------------------------------------------------------------


def _key_path() -> Path:
    raw = os.environ.get(KEY_PATH_ENV, "").strip()
    return Path(raw) if raw else DEFAULT_KEY_PATH


def _decode_master_key(raw: str) -> bytes | None:
    candidate = raw.strip()
    if not candidate:
        return None
    try:
        decoded = base64.b64decode(candidate, validate=True)
        if len(decoded) == 32:
            return decoded
    except (binascii.Error, ValueError):
        pass
    try:
        decoded = bytes.fromhex(candidate)
        if len(decoded) == 32:
            return decoded
    except ValueError:
        pass
    encoded = candidate.encode("utf-8")
    if len(encoded) == 32:
        return encoded
    return None


def load_master_key(*, create: bool = True) -> bytes:
    """Resolve the 32-byte master key: env override > key file (auto-generated).

    The env escape hatch mirrors relay-key semantics: explicit operator config
    always wins. The file is created 0600 and must be backed up together with
    the state DB — ciphertext without this key is unrecoverable by design."""
    env_raw = os.environ.get(MASTER_KEY_ENV, "")
    if env_raw.strip():
        key = _decode_master_key(env_raw)
        if key is None:
            raise SecretStoreError(
                f"{MASTER_KEY_ENV} is set but not a 32-byte key (base64/hex/raw accepted)"
            )
        return key
    path = _key_path()
    if path.exists():
        return _read_key_file(path)
    if not create:
        raise SecretStoreError(f"secrets key file {path} does not exist")
    key = _pysecrets.token_bytes(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        # The 0o600 mode on os.open below is ignored by NTFS and the permissive-
        # mode check in _read_key_file is POSIX-only, so harden the dir to the
        # current user via ACL FIRST — the O_EXCL key file is then created inside
        # an already-owner-only directory.
        from superclaw.secure_fs import harden_path

        harden_path(path.parent, is_dir=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # Lost the creation race: another process initialised first — its key
        # is THE key (two competing keys would strand half the ciphertexts).
        return _read_key_file(path)
    try:
        os.write(fd, base64.b64encode(key) + b"\n")
    finally:
        os.close(fd)
    if os.name == "nt":
        harden_path(path, is_dir=False)  # owner-only ACL for the master key file
    return key


def _read_key_file(path: Path) -> bytes:
    """Read the key file fail-closed: refuse symlinks and permissive modes —
    a swapped or world-readable key file is an attack, not a config style."""
    info = os.lstat(path)
    import stat as _stat

    if _stat.S_ISLNK(info.st_mode):
        raise SecretStoreError(f"secrets key file {path} is a symlink (refusing to follow)")
    if os.name == "posix" and (info.st_mode & 0o077):
        raise SecretStoreError(
            f"secrets key file {path} is group/world-accessible (mode {info.st_mode & 0o777:o}); chmod 600 it"
        )
    key = _decode_master_key(path.read_text(encoding="utf-8"))
    if key is None:
        raise SecretStoreError(f"secrets key file {path} is corrupt (expected 32-byte base64)")
    return key


# --- local_encrypted provider ----------------------------------------------


def _encrypt(value: str) -> dict[str, str]:
    key = load_master_key()
    iv = _pysecrets.token_bytes(12)
    sealed = AESGCM(key).encrypt(iv, value.encode("utf-8"), None)
    ciphertext, tag = sealed[:-16], sealed[-16:]
    return {
        "scheme": SCHEME,
        "iv": base64.b64encode(iv).decode("ascii"),
        "tag": base64.b64encode(tag).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
    }


def _decrypt(material: dict[str, Any]) -> str:
    if material.get("scheme") != SCHEME:
        raise SecretStoreError(f"unsupported secret material scheme: {material.get('scheme')!r}")
    key = load_master_key(create=False)
    try:
        iv = base64.b64decode(material["iv"])
        tag = base64.b64decode(material["tag"])
        ciphertext = base64.b64decode(material["ciphertext"])
        return AESGCM(key).decrypt(iv, ciphertext + tag, None).decode("utf-8")
    except SecretStoreError:
        raise
    except Exception as exc:  # wrong key / tampered material — never echo details
        raise SecretStoreError(f"secret decryption failed: {type(exc).__name__}") from exc


# --- ledger lifecycle -------------------------------------------------------


def _summary(secret: CompanySecret) -> dict[str, Any]:
    return {
        "secret_id": secret.secret_id,
        "name": secret.name,
        "company_profile_id": secret.company_profile_id,
        "provider": secret.provider,
        "description": secret.description,
        "current_version": secret.current_version,
        "archived": secret.archived,
        "created_at": secret.created_at,
        "rotated_at": secret.rotated_at,
    }


def create_secret(
    store: StateStore,
    *,
    name: str,
    value: str,
    company_profile_id: str = "local",
    actor: str = "local_user",
    description: str = "",
) -> dict[str, Any]:
    name = name.strip()
    if not name:
        raise SecretStoreError("secret name must be non-empty")
    if not value:
        raise SecretStoreError("secret value must be non-empty")
    if store.find_secret_by_name(name, company_profile_id=company_profile_id) is not None:
        raise SecretStoreError(f"secret '{name}' already exists (use rotate to change its value)")
    secret = CompanySecret(
        name=name,
        company_profile_id=company_profile_id,
        description=description,
        current_version=1,
        created_by=actor,
    )
    # Encrypt BEFORE any ledger write: if the master key is unusable this raises
    # here and the DB stays untouched — never a "live" secret without material.
    # Version-then-ledger ordering keeps the failure mode harmless the other way
    # too (an orphan version row is invisible; a ledger row without material is
    # a broken secret).
    material = _encrypt(value)
    store.save_secret_version(
        CompanySecretVersion(
            secret_id=secret.secret_id,
            version=1,
            material=material,
            value_sha256=hashlib.sha256(value.encode("utf-8")).hexdigest(),
        )
    )
    store.save_secret(secret)
    store.record_secret_access_event(
        SecretAccessEvent(
            secret_id=secret.secret_id,
            action="create",
            company_profile_id=company_profile_id,
            version=1,
            actor=actor,
        )
    )
    return _summary(secret)


def rotate_secret(
    store: StateStore,
    *,
    name: str,
    value: str,
    company_profile_id: str = "local",
    actor: str = "local_user",
) -> dict[str, Any]:
    if not value:
        raise SecretStoreError("secret value must be non-empty")
    secret = store.find_secret_by_name(name, company_profile_id=company_profile_id)
    if secret is None:
        raise SecretStoreError(f"secret '{name}' not found")
    if secret.archived:
        raise SecretStoreError(f"secret '{name}' is archived; unarchive before rotating")
    secret.current_version += 1
    secret.rotated_at = time()
    # Same ordering discipline as create: encrypt first, version row next,
    # ledger pointer (current_version bump) last.
    material = _encrypt(value)
    store.save_secret_version(
        CompanySecretVersion(
            secret_id=secret.secret_id,
            version=secret.current_version,
            material=material,
            value_sha256=hashlib.sha256(value.encode("utf-8")).hexdigest(),
        )
    )
    store.save_secret(secret)
    store.record_secret_access_event(
        SecretAccessEvent(
            secret_id=secret.secret_id,
            action="rotate",
            company_profile_id=company_profile_id,
            version=secret.current_version,
            actor=actor,
        )
    )
    return _summary(secret)


def set_secret_archived(
    store: StateStore,
    *,
    name: str,
    archived: bool,
    company_profile_id: str = "local",
    actor: str = "local_user",
) -> dict[str, Any]:
    secret = store.find_secret_by_name(name, company_profile_id=company_profile_id)
    if secret is None:
        raise SecretStoreError(f"secret '{name}' not found")
    secret.archived = archived
    store.save_secret(secret)
    store.record_secret_access_event(
        SecretAccessEvent(
            secret_id=secret.secret_id,
            action="archive" if archived else "unarchive",
            company_profile_id=company_profile_id,
            actor=actor,
        )
    )
    return _summary(secret)


def delete_secret(
    store: StateStore,
    *,
    name: str,
    company_profile_id: str = "local",
    actor: str = "local_user",
) -> dict[str, Any]:
    secret = store.find_secret_by_name(name, company_profile_id=company_profile_id)
    if secret is None:
        raise SecretStoreError(f"secret '{name}' not found")
    # The audit event is recorded BEFORE deletion (events survive the ledger row).
    store.record_secret_access_event(
        SecretAccessEvent(
            secret_id=secret.secret_id,
            action="delete",
            company_profile_id=company_profile_id,
            actor=actor,
            detail=f"name={secret.name}",
        )
    )
    store.delete_secret(secret.secret_id)
    return _summary(secret)


def list_secret_summaries(
    store: StateStore, *, company_profile_id: str | None = None
) -> list[dict[str, Any]]:
    return [_summary(s) for s in store.list_secrets(company_profile_id=company_profile_id)]


# --- bindings + governed resolution -----------------------------------------


def bind_secret(
    store: StateStore,
    *,
    name: str,
    target_type: str,
    target_id: str,
    config_path: str,
    required: bool = True,
    company_profile_id: str = "local",
    actor: str = "local_user",
) -> CompanySecretBinding:
    if target_type not in BINDING_TARGET_TYPES:
        raise SecretStoreError(
            f"unknown binding target type '{target_type}' (expected one of {', '.join(BINDING_TARGET_TYPES)})"
        )
    config_path = config_path.strip()
    if not config_path:
        raise SecretStoreError("config_path (destination, e.g. an env var name) must be non-empty")
    secret = store.find_secret_by_name(name, company_profile_id=company_profile_id)
    if secret is None:
        raise SecretStoreError(f"secret '{name}' not found")
    binding = CompanySecretBinding(
        secret_id=secret.secret_id,
        company_profile_id=company_profile_id,
        target_type=target_type,
        target_id=target_id,
        config_path=config_path,
        required=required,
    )
    store.save_secret_binding(binding)
    store.record_secret_access_event(
        SecretAccessEvent(
            secret_id=secret.secret_id,
            action="bind",
            company_profile_id=company_profile_id,
            actor=actor,
            target_type=target_type,
            target_id=target_id,
            detail=f"config_path={config_path} required={required}",
        )
    )
    return binding


def unbind_secret(store: StateStore, *, binding_id: str, actor: str = "local_user") -> bool:
    bindings = [b for b in store.list_secret_bindings() if b.binding_id == binding_id]
    removed = store.delete_secret_binding(binding_id)
    if removed and bindings:
        b = bindings[0]
        store.record_secret_access_event(
            SecretAccessEvent(
                secret_id=b.secret_id,
                action="unbind",
                company_profile_id=b.company_profile_id,
                actor=actor,
                target_type=b.target_type,
                target_id=b.target_id,
                detail=f"config_path={b.config_path}",
            )
        )
    return removed


def resolve_secret(
    store: StateStore,
    *,
    name: str,
    target_type: str,
    target_id: str,
    company_profile_id: str = "local",
    actor: str = "local_user",
    run_id: str | None = None,
    issue_id: str | None = None,
) -> str:
    """Return the plaintext for ONE consumer, fail-closed.

    The consumer must hold a binding for this secret; otherwise the resolution
    is refused AND recorded (action=denied). Archived secrets never resolve."""
    secret = store.find_secret_by_name(name, company_profile_id=company_profile_id)
    if secret is None:
        raise SecretStoreError(f"secret '{name}' not found")

    def _audit(action: str, detail: str = "") -> None:
        store.record_secret_access_event(
            SecretAccessEvent(
                secret_id=secret.secret_id,
                action=action,
                company_profile_id=company_profile_id,
                version=secret.current_version,
                actor=actor,
                target_type=target_type,
                target_id=target_id,
                run_id=run_id,
                issue_id=issue_id,
                detail=detail,
            )
        )

    grants = store.list_secret_bindings(
        secret_id=secret.secret_id,
        target_type=target_type,
        target_id=target_id,
        company_profile_id=company_profile_id,
    )
    if not grants:
        _audit("denied", "no binding grants this consumer access")
        raise SecretStoreError(
            f"access denied: no binding grants {target_type}:{target_id} access to secret '{name}'"
        )
    if secret.archived:
        _audit("denied", "secret is archived")
        raise SecretStoreError(f"access denied: secret '{name}' is archived")
    version = store.get_secret_version(secret.secret_id, secret.current_version)
    value = _decrypt(version.material)
    _audit("resolve")
    return value


def resolve_env_for_target(
    store: StateStore,
    *,
    target_type: str,
    target_id: str,
    company_profile_id: str = "local",
    actor: str = "local_user",
    run_id: str | None = None,
    issue_id: str | None = None,
) -> dict[str, str]:
    """Resolve every binding of one consumer into {config_path: plaintext}.

    Optional bindings whose secret is archived are skipped; a required binding
    that cannot resolve raises (the invokability gate should have refused the
    consumer earlier — this is the second, last-line check)."""
    env: dict[str, str] = {}
    for binding in store.list_secret_bindings(
        target_type=target_type, target_id=target_id, company_profile_id=company_profile_id
    ):
        try:
            secret = store.get_secret(binding.secret_id)
        except KeyError:
            if binding.required:
                raise SecretStoreError(
                    f"required secret binding {binding.binding_id} points at a deleted secret"
                ) from None
            continue
        if secret.archived:
            if binding.required:
                raise SecretStoreError(
                    f"required secret '{secret.name}' is archived; {target_type}:{target_id} is not invokable"
                )
            continue
        env[binding.config_path] = resolve_secret(
            store,
            name=secret.name,
            target_type=target_type,
            target_id=target_id,
            company_profile_id=company_profile_id,
            actor=actor,
            run_id=run_id,
            issue_id=issue_id,
        )
    return env


def find_audit_secret_id(
    store: StateStore, *, name: str, company_profile_id: str = "local"
) -> str | None:
    """Resolve a secret NAME to the id its audit trail lives under, company-scoped.

    Live secrets resolve through the ledger; deleted ones recover their id from
    the delete event (its detail records the name). Single definition point for
    every surface (CLI / API) — the ghost-recovery rule must never fork."""
    found = store.find_secret_by_name(name, company_profile_id=company_profile_id)
    if found is not None:
        return found.secret_id
    ghosts = [
        e
        for e in store.list_secret_access_events(limit=1000)
        if e.action == "delete"
        and e.detail == f"name={name}"
        and e.company_profile_id == company_profile_id
    ]
    return ghosts[0].secret_id if ghosts else None


@dataclass
class InvokabilityResult:
    """Outcome of the required-bindings gate for one consumer."""

    ok: bool
    missing: tuple[str, ...] = ()

    def reason(self) -> str:
        if self.ok:
            return ""
        return "missing required secrets: " + ", ".join(self.missing)


def check_invokability(
    store: StateStore, *, target_type: str, target_id: str, company_profile_id: str = "local"
) -> InvokabilityResult:
    """The invokability gate: every ``required`` binding must point at a live
    (existing, non-archived) secret whose current version actually DECRYPTS,
    otherwise the consumer is NOT invokable. Resolvability is verified for real
    (missing version row, corrupt material, unusable master key all fail the
    gate) — passing a consumer whose secret cannot resolve would just move the
    failure into the middle of a run. The decrypted plaintext is discarded and
    no access event is recorded: the gate is admission control, not consumption
    (denied checkouts surface in the checkout error itself)."""
    missing: list[str] = []
    for binding in store.list_secret_bindings(
        target_type=target_type, target_id=target_id, company_profile_id=company_profile_id
    ):
        if not binding.required:
            continue
        try:
            secret = store.get_secret(binding.secret_id)
        except KeyError:
            missing.append(f"{binding.config_path} (secret deleted)")
            continue
        if secret.archived:
            missing.append(f"{secret.name} (archived)")
            continue
        try:
            _decrypt(store.get_secret_version(secret.secret_id, secret.current_version).material)
        except KeyError:
            missing.append(f"{secret.name} (version v{secret.current_version} material missing)")
        except SecretStoreError as exc:
            missing.append(f"{secret.name} (unresolvable: {exc})")
    return InvokabilityResult(ok=not missing, missing=tuple(missing))


# --- instance settings -------------------------------------------------------


def get_instance_settings(store: StateStore) -> dict[str, Any]:
    return store.get_instance_settings().to_dict()


def update_instance_settings(
    store: StateStore, *, bucket: str, patch: dict[str, Any]
) -> dict[str, Any]:
    """Shallow-merge ``patch`` into one bucket; a key set to None is removed."""
    if bucket not in InstanceSettings.BUCKETS:
        raise SecretStoreError(
            f"unknown instance settings bucket '{bucket}' (expected one of {', '.join(InstanceSettings.BUCKETS)})"
        )
    settings = store.get_instance_settings()
    target = dict(getattr(settings, bucket))
    for key, value in patch.items():
        if value is None:
            target.pop(key, None)
        else:
            target[key] = value
    setattr(settings, bucket, target)
    settings.updated_at = time()
    store.save_instance_settings(settings)
    return settings.to_dict()
