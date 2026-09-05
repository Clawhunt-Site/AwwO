from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from superclaw.capability_registry import DEFAULT_CAPABILITY_REGISTRY_NAME

DEFAULT_R2_ENV_FILE = Path("~/.config/superclaw/cloudflare-r2.env").expanduser()
DEFAULT_REGISTRY_BUCKET = "clawhunt-capability-registry-prod"
DEFAULT_ARTIFACT_BUCKET = "clawhunt-capability-artifacts-prod"
DEFAULT_SUBMISSIONS_BUCKET = "clawhunt-capability-submissions-prod"


class CapabilityR2Error(ValueError):
    """Raised when production R2 publication or fetch fails."""


@dataclass(frozen=True)
class CapabilityR2Config:
    endpoint_url: str
    access_key_id: str
    secret_access_key: str
    region: str = "auto"
    registry_bucket: str = DEFAULT_REGISTRY_BUCKET
    artifact_bucket: str = DEFAULT_ARTIFACT_BUCKET
    submissions_bucket: str = DEFAULT_SUBMISSIONS_BUCKET


def load_r2_config(
    *,
    env_file: Path | None = None,
    registry_bucket: str | None = None,
    artifact_bucket: str | None = None,
    submissions_bucket: str | None = None,
) -> CapabilityR2Config:
    env = dict(os.environ)
    chosen_env_file = env_file or Path(env.get("SUPERCLAW_R2_ENV_FILE") or DEFAULT_R2_ENV_FILE)
    if chosen_env_file.exists():
        env.update(_read_env_file(chosen_env_file))
    endpoint_url = _required_env(env, "R2_ENDPOINT", "AWS_ENDPOINT_URL_S3")
    access_key_id = _required_env(env, "R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID")
    secret_access_key = _required_env(env, "R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
    return CapabilityR2Config(
        endpoint_url=endpoint_url.rstrip("/"),
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        region=str(env.get("AWS_DEFAULT_REGION") or env.get("R2_REGION") or "auto"),
        registry_bucket=registry_bucket
        or env.get("SUPERCLAW_R2_REGISTRY_BUCKET")
        or env.get("R2_REGISTRY_BUCKET")
        or DEFAULT_REGISTRY_BUCKET,
        artifact_bucket=artifact_bucket
        or env.get("SUPERCLAW_R2_ARTIFACT_BUCKET")
        or env.get("R2_ARTIFACT_BUCKET")
        or DEFAULT_ARTIFACT_BUCKET,
        submissions_bucket=submissions_bucket
        or env.get("SUPERCLAW_R2_SUBMISSIONS_BUCKET")
        or env.get("R2_SUBMISSIONS_BUCKET")
        or DEFAULT_SUBMISSIONS_BUCKET,
    )


def publish_local_capability_cloud_to_r2(
    cloud_root: Path,
    *,
    config: CapabilityR2Config,
    prefix: str = "",
    registry_key: str = DEFAULT_CAPABILITY_REGISTRY_NAME,
    dry_run: bool = False,
    runner: Any | None = None,
) -> dict[str, Any]:
    root = Path(cloud_root)
    registry_path = root / "registry" / DEFAULT_CAPABILITY_REGISTRY_NAME
    if not registry_path.exists():
        raise CapabilityR2Error(f"local capability registry does not exist: {registry_path}")
    _load_registry_json(registry_path)

    key_prefix = _normalize_prefix(prefix)
    remote_registry_key = _join_key(key_prefix, registry_key)
    commands: list[list[str]] = []
    commands.append(
        _aws_command(
            config,
            "put-object",
            "--bucket",
            config.registry_bucket,
            "--key",
            remote_registry_key,
            "--body",
            os.fspath(registry_path),
            "--content-type",
            "application/json; charset=utf-8",
            "--cache-control",
            "no-cache",
        )
    )

    artifact_uploads: list[dict[str, str]] = []
    artifacts_root = root / "artifacts" / "capabilities"
    if artifacts_root.exists():
        for digest_dir in sorted(path for path in artifacts_root.iterdir() if path.is_dir()):
            artifact_root = digest_dir / "artifact"
            if not artifact_root.exists():
                continue
            for file_path in _iter_artifact_files(artifact_root):
                rel = file_path.relative_to(artifact_root).as_posix()
                key = _join_key(key_prefix, "capabilities", digest_dir.name, "artifact", rel)
                artifact_uploads.append({"digest": digest_dir.name, "key": key, "path": os.fspath(file_path)})
                commands.append(
                    _aws_command(
                        config,
                        "put-object",
                        "--bucket",
                        config.artifact_bucket,
                        "--key",
                        key,
                        "--body",
                        os.fspath(file_path),
                        "--content-type",
                        _content_type(file_path),
                    )
                )

    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "registry": {"bucket": config.registry_bucket, "key": remote_registry_key},
            "artifacts": artifact_uploads,
            "artifact_count": len(artifact_uploads),
        }

    active_runner = runner or _run_aws
    for command in commands:
        active_runner(command, config=config)

    _head_object(config, config.registry_bucket, remote_registry_key, runner=active_runner)
    verified_artifacts = 0
    for item in artifact_uploads:
        _head_object(config, config.artifact_bucket, item["key"], runner=active_runner)
        verified_artifacts += 1

    return {
        "ok": True,
        "dry_run": False,
        "registry": {
            "bucket": config.registry_bucket,
            "key": remote_registry_key,
            "source": f"r2://{config.registry_bucket}/{remote_registry_key}",
        },
        "artifacts": [{"digest": item["digest"], "bucket": config.artifact_bucket, "key": item["key"]} for item in artifact_uploads],
        "artifact_count": len(artifact_uploads),
        "verified_artifact_count": verified_artifacts,
    }


def fetch_r2_object(
    bucket: str,
    key: str,
    dest: Path,
    *,
    config: CapabilityR2Config | None = None,
    runner: Any | None = None,
) -> Path:
    """Download a single R2 object (any bytes) to ``dest`` via authenticated
    ``s3api get-object``. Bucket/key are validated (no path escapes). Returns dest."""
    safe_bucket = _safe_bucket(bucket)
    safe_key = _safe_key(key)
    resolved = config or load_r2_config()
    active_runner = runner or _run_aws
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    active_runner(
        _aws_command(resolved, "get-object", "--bucket", safe_bucket, "--key", safe_key, os.fspath(dest)),
        config=resolved,
    )
    return dest


def list_r2_object_keys(
    bucket: str,
    prefix: str,
    *,
    config: CapabilityR2Config | None = None,
    runner: Any | None = None,
) -> set[str]:
    """The set of object keys under ``prefix`` in ``bucket``, via a single
    authenticated ``s3api list-objects-v2`` (the aws CLI auto-paginates, so this is
    one logical call regardless of object count).

    Callers use this to test membership of MANY candidate keys with one R2 round-trip
    instead of one ``head-object`` per key (which would be O(N) subprocesses on a
    catalog page). Raises ``CapabilityR2Error`` on a list failure so the caller can
    fail closed (treat installability as unknown) rather than silently reporting an
    empty catalog as authoritative."""
    safe_bucket = _safe_bucket(bucket)
    resolved = config or load_r2_config()
    active_runner = runner or _run_aws
    completed = active_runner(
        _aws_command(resolved, "list-objects-v2", "--bucket", safe_bucket, "--prefix", prefix, "--output", "json"),
        config=resolved,
    )
    stdout = (getattr(completed, "stdout", "") or "").strip()
    if not stdout:
        return set()
    try:
        payload = json.loads(stdout)
    except (ValueError, TypeError) as exc:
        raise CapabilityR2Error("could not parse R2 list-objects-v2 response") from exc
    contents = payload.get("Contents") if isinstance(payload, dict) else None
    if not isinstance(contents, list):
        return set()
    return {item["Key"] for item in contents if isinstance(item, dict) and isinstance(item.get("Key"), str)}


def get_r2_object_text(uri: str, *, config: CapabilityR2Config | None = None, runner: Any | None = None) -> str:
    bucket, key = parse_r2_uri(uri)
    resolved = config or load_r2_config()
    with tempfile.TemporaryDirectory(prefix="superclaw-r2-") as tmpdir:
        target = fetch_r2_object(bucket, key, Path(tmpdir) / "object.json", config=resolved, runner=runner)
        return target.read_text(encoding="utf-8")


def parse_r2_uri(uri: str) -> tuple[str, str]:
    value = str(uri).strip()
    if not value.startswith("r2://"):
        raise CapabilityR2Error("R2 registry source must start with r2://")
    rest = value.removeprefix("r2://")
    bucket, sep, key = rest.partition("/")
    if not sep or not bucket or not key:
        raise CapabilityR2Error("R2 registry source must be r2://bucket/key")
    _safe_bucket(bucket)
    return bucket, _safe_key(key)


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    # Normalize a filesystem fault (unreadable/locked env file, etc.) into a
    # CapabilityR2Error so every caller's ``except CapabilityR2Error`` fails closed to
    # "R2 unconfigured" instead of leaking an OSError up as a raw 500.
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CapabilityR2Error(f"could not read R2 env file {path}: {exc}") from exc
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        if not key:
            continue
        try:
            parsed = shlex.split(value, posix=True)
        except ValueError:
            parsed = [value.strip().strip("'\"")]
        values[key] = parsed[0] if parsed else ""
    return values


def _required_env(env: dict[str, str], *names: str) -> str:
    for name in names:
        value = str(env.get(name) or "").strip()
        if value:
            return value
    raise CapabilityR2Error(f"missing required R2 setting: {' or '.join(names)}")


def _run_aws(command: list[str], *, config: CapabilityR2Config) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "AWS_ACCESS_KEY_ID": config.access_key_id,
        "AWS_SECRET_ACCESS_KEY": config.secret_access_key,
        "AWS_DEFAULT_REGION": config.region,
        "AWS_PAGER": "",
    }
    try:
        return subprocess.run(command, check=True, text=True, capture_output=True, env=env)
    except FileNotFoundError as exc:
        raise CapabilityR2Error("aws CLI is required for R2 publication") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "aws command failed").strip()
        # ``from None``: do NOT chain the original CalledProcessError — its
        # __cause__/__context__ retains the RAW (unredacted) stderr/stdout, which a
        # traceback-formatting logger could leak. Only the redacted message survives.
        raise CapabilityR2Error(_redact_secretish(detail, config)) from None


def _aws_command(config: CapabilityR2Config, operation: str, *args: str) -> list[str]:
    return ["aws", "s3api", operation, "--endpoint-url", config.endpoint_url, *args]


def _head_object(config: CapabilityR2Config, bucket: str, key: str, *, runner: Any) -> None:
    runner(_aws_command(config, "head-object", "--bucket", bucket, "--key", key), config=config)


def _iter_artifact_files(root: Path) -> list[Path]:
    if root.is_file():
        return [root]
    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise CapabilityR2Error(f"refusing to publish symlinked artifact file: {path}")
        if path.is_file():
            files.append(path)
    return files


def _load_registry_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CapabilityR2Error(f"capability registry is not valid JSON: {path}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("entries"), list):
        raise CapabilityR2Error("capability registry must be a JSON object with an entries list")
    return payload


def _normalize_prefix(prefix: str) -> str:
    value = str(prefix).strip().strip("/")
    if not value:
        return ""
    return _safe_key(value)


def _join_key(*parts: str) -> str:
    return "/".join(part.strip("/") for part in parts if part and part.strip("/"))


def _safe_bucket(bucket: str) -> str:
    if "/" in bucket or "\\" in bucket or not bucket.strip():
        raise CapabilityR2Error("invalid R2 bucket name")
    return bucket


def _safe_key(key: str) -> str:
    value = str(key).strip().lstrip("/")
    if not value or "\\" in value or any(part in {"", ".", ".."} for part in value.split("/")):
        raise CapabilityR2Error("invalid R2 object key")
    return value


def _content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".json":
        return "application/json; charset=utf-8"
    if suffix in {".md", ".txt"}:
        return "text/plain; charset=utf-8"
    if suffix in {".zip", ".scplug", ".scskill", ".sccompany"}:
        return "application/octet-stream"
    return "application/octet-stream"


def _redact_secretish(text: str, config: CapabilityR2Config) -> str:
    redacted = text
    for secret in (config.access_key_id, config.secret_access_key):
        if secret:
            redacted = redacted.replace(secret, "[redacted]")
    return redacted
