"""Surface tests for the Capability Workshop download/install bridge (R2-backed).

``POST /api/plugins/install-workshop`` makes a published workshop capability
installable: ClawHunt's feed is metadata-only, so the bytes live in the configured
Cloudflare R2 artifact store. The published entry's ``artifact_ref`` maps 1:1 to the
R2 object key; the route fetches via authenticated get-object and admits only after
two fail-closed checks — (1) the live feed entry carries a valid official
co-signature, and (2) the downloaded package's content digest equals that co-signed
``package_digest``. These tests pin that orchestration + every fail-closed branch.

The official-co-signature CRYPTO is covered by test_capability_cosign.py and the R2
get-object transport by capability_r2 tests; here we stub both to exercise the
route's wiring (they are dependencies, not the unit under test).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.capability_devtools import build_capability_artifact
from superclaw.capability_r2 import CapabilityR2Config, CapabilityR2Error

PLUGIN_SRC = Path(__file__).resolve().parents[1] / "examples" / "plugins" / "text-stats"
PLUGIN_ID = "dev.leon.text-stats"
VERSION = "1.0.0"
ARTIFACT_REF = f"superclaw-object://capabilities/plugin/{PLUGIN_ID}/versions/{VERSION}/package.scplug"


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("upstream error", request=None, response=None)

    def json(self) -> dict[str, Any]:
        return self._payload


def _packaged(tmp_path: Path) -> tuple[bytes, str]:
    """Build the real text-stats .scplug and return (bytes, content_digest)."""
    result = build_capability_artifact("plugin", PLUGIN_SRC, dist_dir=tmp_path / "dist")
    return result.package_path.read_bytes(), result.metadata.artifact_digest


def _entry(digest: str, *, artifact_ref: str | None = ARTIFACT_REF, kind: str = "plugin") -> dict[str, Any]:
    entry = {
        "kind": kind,
        "capability_id": PLUGIN_ID,
        "version": VERSION,
        "status": "published",
        "package_digest": digest,
        "official_signature": "ed25519:" + "Zm9v",
        "official_signer_keyid": "sha256:" + "c" * 8,
    }
    if artifact_ref is not None:
        entry["artifact_ref"] = artifact_ref
    return entry


def _client(
    monkeypatch,
    tmp_path,
    *,
    entry,
    pkg_bytes,
    cosign=True,
    local_dev=True,
    feed_error=False,
    raw_feed=None,
    r2_unconfigured=False,
    r2_fetch_error=False,
    artifact_missing=False,
):
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("APP_ENV", "staging")
    if local_dev:
        monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "1")
    else:
        monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)

    def fake_get(url, params=None, follow_redirects=True, timeout=8.0):
        if feed_error:
            import httpx

            raise httpx.ConnectError("workshop feed down")
        if raw_feed is not None:
            return _FakeResponse(raw_feed)
        return _FakeResponse({"entries": [entry] if entry is not None else []})

    def fake_load_r2_config(*args, **kwargs):
        if r2_unconfigured:
            raise CapabilityR2Error("missing required R2 setting: R2_ENDPOINT")
        return CapabilityR2Config(endpoint_url="https://r2.test", access_key_id="ak", secret_access_key="sk")

    def fake_fetch_r2_object(bucket, key, dest, *, config=None, runner=None):
        if artifact_missing:
            # A publish-without-upload ghost: get-object fails with NoSuchKey.
            raise CapabilityR2Error(
                f"An error occurred (NoSuchKey) when calling the GetObject operation: "
                f"The specified key does not exist: {bucket}/{key}"
            )
        if r2_fetch_error:
            # A genuinely transient download failure (NOT a missing key).
            raise CapabilityR2Error("An error occurred (InternalError) (503): throttled, please retry")
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(pkg_bytes)
        return Path(dest)

    def fake_list_r2_object_keys(bucket, prefix, *, config=None, runner=None):
        # ``artifact_missing`` models a publish-without-upload ghost: the object is not
        # present in the bucket listing. Otherwise the entry's key is present.
        if artifact_missing:
            return set()
        return {ARTIFACT_REF.replace("superclaw-object://", "")}

    monkeypatch.setattr("apps.api.main.httpx.get", fake_get)
    monkeypatch.setattr("apps.api.main.load_r2_config", fake_load_r2_config)
    monkeypatch.setattr("apps.api.main.fetch_r2_object", fake_fetch_r2_object)
    monkeypatch.setattr("apps.api.main.list_r2_object_keys", fake_list_r2_object_keys)
    monkeypatch.setattr(
        "apps.api.main.verify_official_cosignature",
        lambda entry, official_public_key: cosign,
    )
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def _installed_ids(client) -> list[str]:
    return [p["id"] for p in client.get("/api/plugins/status").json().get("plugins", [])]


def _install(client):
    return client.post("/api/plugins/install-workshop", json={"plugin_id": PLUGIN_ID, "version": VERSION})


def test_workshop_distribution_lists_installable_when_r2_and_cosigned(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg)
    r = client.get("/api/plugins/workshop-distribution")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["r2_configured"] is True
    assert {"plugin_id": PLUGIN_ID, "version": VERSION} in body["plugins"]


def test_workshop_distribution_empty_when_r2_unconfigured(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, r2_unconfigured=True)
    body = client.get("/api/plugins/workshop-distribution").json()
    assert body["r2_configured"] is False
    assert body["plugins"] == []


def test_workshop_distribution_excludes_entry_without_uploaded_artifact(monkeypatch, tmp_path):
    # A published + co-signed entry whose bytes were never uploaded to R2 (HEAD fails)
    # must NOT be advertised as installable — that is the exact ghost that dead-ends at
    # a 502 NoSuchKey on click. R2 is configured; only the object is absent.
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, artifact_missing=True)
    body = client.get("/api/plugins/workshop-distribution").json()
    assert body["r2_configured"] is True
    assert body["plugins"] == []


def test_workshop_distribution_error_is_generic_no_internal_leak(monkeypatch, tmp_path):
    # An R2 list failure can carry internal context (endpoint/bucket/env path/AWS stderr); the
    # response error must be a fixed generic code, NOT the raw exception text (parity with the
    # neutral /api/capabilities/distribution).
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg)
    secret = "endpoint https://acct.r2.cloudflarestorage.com bucket=secret-prod stderr=/home/u/.r2.env"

    def boom(*args, **kwargs):
        raise CapabilityR2Error(secret)

    monkeypatch.setattr("apps.api.main.list_r2_object_keys", boom)  # overrides the _client stub
    body = client.get("/api/plugins/workshop-distribution").json()
    assert body["plugins"] == []
    assert body["error"] == "distribution_unavailable"
    assert "secret-prod" not in repr(body) and "r2.cloudflarestorage" not in repr(body) and ".r2.env" not in repr(body)


def test_install_workshop_happy_path(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True)
    r = _install(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["installed"] is True
    assert body["source"] == "clawhunt_workshop"
    assert body["digest"] == digest
    assert body["artifact_ref"] == ARTIFACT_REF
    assert PLUGIN_ID in _installed_ids(client)
    # Soft-retired: the legacy cache-install endpoint still works but is marked deprecated and
    # points at the neutral Node S4 path; behaviour above is unchanged.
    assert body["deprecated"] is True
    assert body["superseded_by"] == "/api/capabilities/install"


def test_install_workshop_rejects_uncosigned_entry(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=False)
    r = _install(client)
    assert r.status_code == 403, r.text
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_rejects_digest_mismatch_and_writes_nothing(monkeypatch, tmp_path):
    # Co-signed digest does NOT match the downloaded bytes (swapped/tampered asset).
    pkg, _digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry("sha256:" + "0" * 64), pkg_bytes=pkg, cosign=True)
    r = _install(client)
    assert r.status_code == 409, r.text
    # The probe ran cache=False, so nothing was ever written.
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_requires_version(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True)
    r = client.post("/api/plugins/install-workshop", json={"plugin_id": PLUGIN_ID})
    assert r.status_code == 400, r.text


def test_install_workshop_unknown_version_is_404_no_downgrade(monkeypatch, tmp_path):
    # A version absent from the live feed fails closed (404), never a silent fallback.
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True)
    r = client.post("/api/plugins/install-workshop", json={"plugin_id": PLUGIN_ID, "version": "2.0.0"})
    assert r.status_code == 404, r.text
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_not_published_is_404(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=None, pkg_bytes=pkg, cosign=True)
    r = _install(client)
    assert r.status_code == 404, r.text
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_missing_artifact_ref_is_502(monkeypatch, tmp_path):
    # A published entry with no resolvable artifact object ref cannot be located in R2.
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest, artifact_ref=None), pkg_bytes=pkg, cosign=True)
    r = _install(client)
    assert r.status_code == 502, r.text
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_rejects_non_plugin_kind(monkeypatch, tmp_path):
    # A co-signed skill/company must not be cached through the plugin pipeline.
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest, kind="skill"), pkg_bytes=pkg, cosign=True)
    r = _install(client)
    assert r.status_code == 400, r.text
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_github_rejects_skill_origin(monkeypatch, tmp_path):
    # Red line: install-github is another plugin install sink. A skill (here by the
    # "skill." id prefix — the kernel single source's fallback, since the github catalog
    # carries no skill_origin field) must be refused BEFORE any download, mirroring the
    # registry-install guard. Covers the last remaining install entry point.
    monkeypatch.setattr(
        "apps.api.main._github_plugin_entry",
        lambda plugin_id, version: {
            "plugin_id": "skill.evil",
            "version": "1.0.0",
            "url": "https://example.test/should-never-be-fetched.scplug",
        },
    )
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    r = client.post("/api/plugins/install-github", json={"plugin_id": "skill.evil", "version": "1.0.0"})
    assert r.status_code == 400, r.text
    assert "skill capability" in r.json()["detail"]


def test_install_workshop_rejects_skill_origin_drift(monkeypatch, tmp_path):
    # A drifted feed entry that is kind:'plugin' but skill_origin:true must STILL be
    # refused — kind alone (the old guard) was insufficient; now matches the kernel
    # single source is_skill_origin_plugin (Codex blocker).
    pkg, digest = _packaged(tmp_path)
    entry = _entry(digest)  # kind='plugin'
    entry["skill_origin"] = True
    client = _client(monkeypatch, tmp_path, entry=entry, pkg_bytes=pkg, cosign=True)
    r = _install(client)
    assert r.status_code == 400, r.text
    assert "skill" in r.json()["detail"]
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_rejects_skill_prefixed_capability_id(monkeypatch, tmp_path):
    # kind:'plugin' but a "skill." capability id is also a skill (id-prefix fallback).
    pkg, digest = _packaged(tmp_path)
    entry = _entry(digest)
    entry["capability_id"] = "skill.evil"
    client = _client(monkeypatch, tmp_path, entry=entry, pkg_bytes=pkg, cosign=True)
    r = client.post("/api/plugins/install-workshop", json={"plugin_id": "skill.evil", "version": VERSION})
    assert r.status_code == 400, r.text
    assert "skill" in r.json()["detail"]


def test_install_workshop_r2_unconfigured_is_503(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True, r2_unconfigured=True)
    r = _install(client)
    assert r.status_code == 503, r.text
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_r2_fetch_failure_is_502(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True, r2_fetch_error=True)
    r = _install(client)
    assert r.status_code == 502, r.text
    # A transient download failure must NOT be mislabeled as a publish-without-upload ghost.
    assert "publish-without-upload" not in r.json()["detail"]
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_missing_artifact_bytes_is_502_with_clear_reason(monkeypatch, tmp_path):
    # Direct API call for a publish-without-upload ghost: the entry is published +
    # co-signed but its object is absent (HEAD fails). The caller gets an actionable
    # "publish-without-upload" message, not a raw NoSuchKey, and nothing is installed.
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True, artifact_missing=True)
    r = _install(client)
    assert r.status_code == 502, r.text
    assert "publish-without-upload" in r.json()["detail"]
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_feed_outage_is_502_not_404(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True, feed_error=True)
    r = _install(client)
    assert r.status_code == 502, r.text
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_malformed_feed_is_502_not_404(monkeypatch, tmp_path):
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=None, pkg_bytes=pkg, cosign=True, raw_feed={"entries": "nope"})
    r = _install(client)
    assert r.status_code == 502, r.text
    assert PLUGIN_ID not in _installed_ids(client)


def test_install_workshop_post_commit_swap_is_rolled_back(monkeypatch, tmp_path):
    # Airtight TOCTOU backstop: if the bytes are swapped DURING the commit so the
    # CACHED package's digest != the co-signed digest, the post-commit bind must roll
    # the entry back and refuse (409). Simulated by a verify that binds on the probe
    # (cache=False) but returns a mismatched digest on the commit (cache=True).
    import apps.api.main as main_mod

    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True)

    class _Result:
        def __init__(self, dig):
            self.plugin_id = PLUGIN_ID
            self.version = VERSION
            self.digest = dig

    def fake_verify(path, *, cache=False, **kwargs):
        # probe binds to the co-signed digest; commit returns a DIFFERENT digest.
        return _Result(digest if not cache else "sha256:" + "e" * 64)

    rolled = {"called": False}

    def fake_uninstall(plugin_id, *, version, cache_root):
        rolled["called"] = True
        return {"removed": True, "versions": [version]}

    monkeypatch.setattr(main_mod, "verify_plugin_package", fake_verify)
    monkeypatch.setattr(main_mod, "uninstall_cached_plugin", fake_uninstall)

    r = _install(client)
    assert r.status_code == 409, r.text
    assert rolled["called"] is True


def test_install_workshop_fails_closed_without_trust_root_or_local_dev(monkeypatch, tmp_path):
    # No baked/explicit root key AND no local-dev trust: the unsigned remote package
    # is rejected by the install gate (it must never run without a real trust basis).
    pkg, digest = _packaged(tmp_path)
    client = _client(monkeypatch, tmp_path, entry=_entry(digest), pkg_bytes=pkg, cosign=True, local_dev=False)
    r = _install(client)
    assert r.status_code == 400, r.text
    assert PLUGIN_ID not in _installed_ids(client)
