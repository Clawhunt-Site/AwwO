"""Download a PUBLISHED workshop capability and LAND it via the Node S4 super-workshop.

This is the missing orchestration that connects the marketplace to the Node landing — the
"download bridge" half of the capability workshop full chain. It supersedes the legacy
Python ``/api/plugins/install-workshop`` path (which landed plugins in the Python-only
``~/.superclaw/plugins/cache`` — a store the Node side does not manage, the "Node doesn't
know where it was downloaded" split).

H-architecture (owner's decision): the cosign verification + the R2 byte fetch stay in
Python (NEVER re-implemented in Node, to avoid a second cosign that could drift); the
capability LANDS through the Node S4 super-workshop installer, so plugin/skill/company all
end up in the single Node-managed store (Node DB + installDir / ``~/.superclaw/skills``),
not a parallel Python library.

Flow (all three kinds, one path):
  1. fetch the published entry from ``/v1/capabilities/published`` and verify its OFFICIAL
     co-signature against the baked official public key (fail-closed: an unendorsed /
     feed-poisoned entry installs nothing);
  2. resolve the entry's ``artifact_ref`` to its R2 object key (rejecting any local-path /
     scheme markers so a poisoned feed can't redirect the fetch off the object store);
  3. download the package bytes via authenticated R2 get-object (server-resolved bucket+key
     — no caller-supplied URL, no SSRF);
  4. verify the DOWNLOADED bytes are the officially-endorsed package: the recomputed
     capability digest + identity (kind/id/version) must equal the co-signed values;
  5. stage the bytes read-only, compute ``transport_sha256`` over them, and issue an
     HMAC-signed trust receipt (the same receipt the Node import re-verifies);
  6. POST the receipt to the co-launched Node ``/api/internal/workshop-import`` (loopback
     only) — Node re-verifies the HMAC + re-hashes the staged bytes (the authoritative
     integrity boundary) and routes to the S4 installer that lands it.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

import httpx

from superclaw.capability_cosign import verify_official_cosignature
from superclaw.capability_devtools import CapabilityDevtoolError, validate_capability_artifact
from superclaw.capability_r2 import CapabilityR2Error, fetch_r2_object, load_r2_config
from superclaw.capability_receipt import (
    WorkshopReceiptError,
    compute_file_sha256,
    issue_receipt,
    receipt_to_wire,
)
from superclaw.company_portability_loopback import (
    CompanyExportLoopbackError,
    resolve_node_base_url,
)
from superclaw.environment import app_environment, clawhunt_base_url, official_root_public_key
from superclaw.workshop_receipt_key import WorkshopReceiptKeyError, read_workshop_receipt_key

WORKSHOP_OBJECT_SCHEME = "superclaw-object://"
WORKSHOP_IMPORT_PATH = "/api/internal/workshop-import"
_PACKAGE_EXT = {"plugin": ".scplug", "skill": ".scskill", "company": ".sccompany"}
_VALID_KINDS = frozenset(_PACKAGE_EXT)
DEFAULT_TIMEOUT_SECONDS = 30.0


class WorkshopInstallBridgeError(RuntimeError):
    """The download→Node-land install failed (feed/cosign/R2/digest/loopback/import)."""


def _artifact_ref_to_r2_key(artifact_ref: Any) -> str | None:
    """Map a published ``artifact_ref`` to its R2 object key, or ``None`` if it is not a
    well-formed opaque capability object ref. Mirrors the apps/api guard: reject any
    local-path / scheme / traversal markers so a poisoned feed entry can never redirect
    the fetch off the object store."""
    if not isinstance(artifact_ref, str):
        return None
    ref = artifact_ref.strip()
    if not ref.startswith(WORKSHOP_OBJECT_SCHEME):
        return None
    key = ref[len(WORKSHOP_OBJECT_SCHEME):]
    if not key.startswith("capabilities/"):
        return None
    if "\\" in key or "file://" in key.lower() or any(part in {"", ".", ".."} for part in key.split("/")):
        return None
    return key


def _published_feed_url() -> str:
    return f"{clawhunt_base_url()}/v1/capabilities/published"


def _artifact_bucket_for_env(app_env: str) -> str:
    """The R2 artifact bucket STRICTLY derived from ``app_env`` — a staging run reads only
    ``clawhunt-capability-artifacts-staging`` and a production run only ``...-prod``.
    Deliberately NOT env-overridable: the "staging must never touch production object
    storage" isolation must not be defeatable by configuration (the co-signature/digest
    protect package authenticity, not environment separation). Fail closed on any value
    that is not a canonical env (a typo/unknown must NEVER silently fall through to prod)."""
    if app_env not in ("staging", "production"):
        raise WorkshopInstallBridgeError(f"unsupported app_env for artifact bucket: {app_env!r}")
    suffix = "staging" if app_env == "staging" else "prod"
    return f"clawhunt-capability-artifacts-{suffix}"


def fetch_published_entry(
    kind: str,
    capability_id: str,
    version: str,
    *,
    feed_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any] | None:
    """Fetch the live published entry for ``(kind, capability_id, version)`` from the
    public workshop feed, or ``None`` if it is not published. The feed is UNTRUSTED — the
    caller MUST verify the entry's official co-signature before acting on it."""
    url = feed_url or _published_feed_url()
    try:
        resp = httpx.get(url, timeout=timeout, trust_env=False, follow_redirects=False)
    except httpx.HTTPError as exc:
        raise WorkshopInstallBridgeError(f"workshop feed unavailable: {exc}") from exc
    if resp.status_code != 200:
        raise WorkshopInstallBridgeError(f"workshop feed returned HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise WorkshopInstallBridgeError(f"workshop feed returned non-JSON: {exc}") from exc
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        raise WorkshopInstallBridgeError("workshop feed has no entries list")
    matches = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and entry.get("kind") == kind
        and (entry.get("capability_id") or entry.get(f"{kind}_id")) == capability_id
        and entry.get("version") == version
    ]
    if len(matches) > 1:
        # The published feed collapses by identity; >1 match means a malformed/poisoned
        # feed. Reject rather than first-match (a bad entry placed first must not DoS, and
        # an ambiguous identity must never be silently resolved).
        raise WorkshopInstallBridgeError(
            f"workshop feed has {len(matches)} entries for {kind} {capability_id}@{version} (malformed)"
        )
    return matches[0] if matches else None


def _post_workshop_import(base_url: str, wire: dict[str, Any], timeout: float) -> dict[str, Any]:
    url = f"{base_url}{WORKSHOP_IMPORT_PATH}"
    try:
        resp = httpx.post(url, json=wire, timeout=timeout, trust_env=False, follow_redirects=False)
    except httpx.HTTPError as exc:
        raise WorkshopInstallBridgeError(f"node workshop-import loopback failed: {exc}") from exc
    if resp.status_code != 200:
        # Node returns a generic reason (never internals); surface status + body snippet.
        raise WorkshopInstallBridgeError(
            f"node workshop-import returned HTTP {resp.status_code}: {resp.text[:300]}"
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise WorkshopInstallBridgeError(f"node workshop-import returned non-JSON: {exc}") from exc


def install_published_capability(
    kind: str,
    capability_id: str,
    version: str,
    *,
    node_base_url: str | None = None,
    official_public_key: str | None = None,
    feed_url: str | None = None,
    hmac_key: bytes | None = None,
    app_env: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Download a published capability and land it via the Node S4 super-workshop.

    Returns the Node import outcome. Raises ``WorkshopInstallBridgeError`` on any
    fail-closed rejection (not published / not officially co-signed / unresolvable ref /
    download failure / digest or identity mismatch / no co-launched Node / import rejected).
    """
    if kind not in _VALID_KINDS:
        raise WorkshopInstallBridgeError(f"unsupported capability kind: {kind!r}")
    if not capability_id or not version:
        raise WorkshopInstallBridgeError("capability_id and version are required")

    # Normalize (alias-fold + validate) the env so a typo/unknown raises here rather than
    # silently falling through to the prod artifact bucket below.
    try:
        resolved_env = app_environment(app_env) if app_env is not None else app_environment()
    except ValueError as exc:
        raise WorkshopInstallBridgeError(f"invalid app_env: {exc}") from exc

    # Resolve the receipt-signing key from the 0600 key FILE (never the process env) when the
    # caller did not pass one, so the high-value HMAC secret never has to live in this
    # process's environment (where a Python-spawned agent/plugin subprocess could inherit it
    # and forge an official receipt). Tests pass hmac_key explicitly.
    #
    # Fail CLOSED if the file is absent: we must NOT fall through to
    # ``receipt_to_wire(key=None)``, whose ``_resolve_hmac_key`` reads
    # SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY from os.environ — that would reintroduce the exact
    # env-key dependency this bridge exists to avoid (and silently sign with an
    # attacker-injectable env var). File is the one and only key source on the Python side.
    if hmac_key is None:
        try:
            file_key = read_workshop_receipt_key()
        except WorkshopReceiptKeyError as exc:
            # Unsafe/malformed key file (symlink/perms/format) — fail closed, but wrap so callers
            # only ever see the bridge's error type (consistent error contract).
            raise WorkshopInstallBridgeError(f"workshop receipt signing key is unusable: {exc}") from exc
        if file_key is None:
            raise WorkshopInstallBridgeError(
                "workshop receipt signing key is not provisioned (expected the 0600 key file at "
                "SUPERCLAW_HOME/.secrets/workshop_hmac.key); refusing to sign from the process "
                "environment"
            )
        hmac_key = file_key.encode("utf-8")

    # (1) live published entry + (2) official co-signature (fail-closed).
    entry = fetch_published_entry(kind, capability_id, version, feed_url=feed_url, timeout=timeout)
    if entry is None:
        raise WorkshopInstallBridgeError(f"capability not published in workshop: {kind} {capability_id}@{version}")
    pub_key = official_public_key if official_public_key is not None else official_root_public_key()
    if not verify_official_cosignature(entry, official_public_key=pub_key):
        raise WorkshopInstallBridgeError("capability is not officially co-signed; refusing install")

    cosigned_digest = entry.get("package_digest")
    if not isinstance(cosigned_digest, str) or not cosigned_digest:
        raise WorkshopInstallBridgeError("published entry is missing a co-signed package_digest")
    r2_key = _artifact_ref_to_r2_key(entry.get("artifact_ref"))
    if r2_key is None:
        raise WorkshopInstallBridgeError("published entry has no resolvable artifact object ref")

    # Resolve the loopback Node BEFORE downloading (cheap fail-fast; loopback enforced).
    try:
        base_url = resolve_node_base_url(node_base_url)
    except CompanyExportLoopbackError as exc:
        raise WorkshopInstallBridgeError(str(exc)) from exc
    if base_url is None:
        raise WorkshopInstallBridgeError("no co-launched Node server found for workshop import")

    try:
        config = load_r2_config()
    except (CapabilityR2Error, OSError, ValueError) as exc:
        raise WorkshopInstallBridgeError(f"capability artifact store (R2) is not configured: {exc}") from exc

    # Bucket is STRICTLY env-derived (not config.artifact_bucket, whose default is the prod
    # bucket): a staging run must never read production object storage even if the feed +
    # co-signature verify.
    artifact_bucket = _artifact_bucket_for_env(resolved_env)

    workdir = Path(tempfile.mkdtemp(prefix="superclaw-workshop-install-"))
    staged = workdir / f"package{_PACKAGE_EXT[kind]}"
    try:
        # (3) authenticated R2 download.
        try:
            fetch_r2_object(artifact_bucket, r2_key, staged, config=config)
        except CapabilityR2Error as exc:
            raise WorkshopInstallBridgeError(f"artifact download from R2 failed: {exc}") from exc

        # (4) the downloaded bytes MUST be the officially-endorsed package: recomputed
        # digest + identity equal the co-signed values, else refuse (tampered/feed-skew).
        try:
            meta = validate_capability_artifact(kind, staged)
        except CapabilityDevtoolError as exc:
            raise WorkshopInstallBridgeError(f"downloaded package failed validation: {exc}") from exc
        if meta.artifact_digest != cosigned_digest:
            raise WorkshopInstallBridgeError(
                "downloaded package digest does not match the co-signed package_digest"
            )
        if meta.capability_id != capability_id or meta.version != version:
            raise WorkshopInstallBridgeError(
                f"downloaded package identity {meta.capability_id}@{meta.version} != {capability_id}@{version}"
            )

        # (5) freeze + receipt.
        transport_sha256 = compute_file_sha256(staged)
        try:
            receipt = issue_receipt(
                kind=kind,
                capability_id=capability_id,
                version=version,
                package_digest=cosigned_digest,
                transport_sha256=transport_sha256,
                staged_artifact=str(staged),
                artifact_ref=str(entry.get("artifact_ref")),
                app_env=resolved_env,
                official=True,
            )
            wire = receipt_to_wire(receipt, key=hmac_key)
        except WorkshopReceiptError as exc:
            raise WorkshopInstallBridgeError(f"failed to issue workshop receipt: {exc}") from exc

        # (6) loopback import → Node S4 lands it (Node re-verifies HMAC + transport digest).
        outcome = _post_workshop_import(base_url, wire, timeout)
    finally:
        # Node reads the staged bytes synchronously during the POST, so it is safe to drop
        # the staging dir once the import call has returned (success or failure).
        shutil.rmtree(workdir, ignore_errors=True)

    # Fail closed unless Node confirms it landed THIS exact identity, officially. A stray
    # loopback 200, a misrouted local service, or a regressed route returning a different
    # kind/id must never be reported as a successful install.
    if not isinstance(outcome, dict):
        raise WorkshopInstallBridgeError("node workshop-import returned a non-object outcome")
    if (
        outcome.get("kind") != kind
        or outcome.get("capabilityId") != capability_id
        or outcome.get("version") != version
    ):
        raise WorkshopInstallBridgeError(
            f"node import outcome identity {outcome.get('kind')}/{outcome.get('capabilityId')}@{outcome.get('version')} "
            f"!= {kind}/{capability_id}@{version}"
        )
    native_id = outcome.get("nativeId")
    if not isinstance(native_id, str) or not native_id.strip():
        raise WorkshopInstallBridgeError("node import outcome missing a nativeId; refusing to report success")
    if outcome.get("official") is not True:
        raise WorkshopInstallBridgeError("node import outcome is not official; refusing to report success")

    return {
        "ok": True,
        "kind": kind,
        "capability_id": capability_id,
        "version": version,
        "package_digest": cosigned_digest,
        "outcome": outcome,
    }
