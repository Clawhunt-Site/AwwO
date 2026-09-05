"""Developer signing identity (super side): server-escrowed keypair + local cache."""
from __future__ import annotations

import base64
import stat
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from superclaw import developer_identity as di
from superclaw.clawhunt_auth import ClawHuntAccountClient, ClawHuntAccountSettings


def _fresh_pair() -> tuple[str, str]:
    """Return ``(private_material, public_material)`` as 'ed25519:<b64>' strings."""
    priv = Ed25519PrivateKey.generate()
    raw_priv = priv.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    raw_pub = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return (
        "ed25519:" + base64.b64encode(raw_priv).decode("ascii"),
        "ed25519:" + base64.b64encode(raw_pub).decode("ascii"),
    )


class _FakeEnsureClient:
    """Mirrors ClawHuntAccountClient's {status_code, ok, body} wrapper for ensure."""

    def __init__(self, *, status_code=200, body=None):
        self.calls = []
        self._status_code = status_code
        self._body = body if body is not None else {}

    def ensure_hosted_developer_key(self, access_token, developer_id, *, private_key=None, public_key=None):
        self.calls.append(
            {
                "access_token": access_token,
                "developer_id": developer_id,
                "private_key": private_key,
                "public_key": public_key,
            }
        )
        return {
            "status_code": self._status_code,
            "ok": 200 <= self._status_code < 300,
            "body": self._body,
        }


@pytest.fixture(autouse=True)
def _isolate_home(tmp_path: Path, monkeypatch):
    # developer_key_path() = clawhunt_auth_path().parent / "developer-signing-key.ed25519"
    monkeypatch.setattr(di, "clawhunt_auth_path", lambda: tmp_path / "clawhunt-auth.json")


def test_keygen_is_idempotent_and_private_key_is_0600(tmp_path: Path):
    key1, pub1 = di.load_or_create_developer_key()
    key2, pub2 = di.load_or_create_developer_key()
    assert pub1 == pub2  # same key reused, not regenerated
    path = di.developer_key_path()
    assert path.is_file()
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600
    assert path.read_text().startswith("ed25519:")


def test_public_key_is_base64_raw_32_bytes():
    import base64

    _key, pub = di.load_or_create_developer_key()
    raw = base64.b64decode(pub, validate=True)
    assert len(raw) == 32  # Ed25519 raw public key


@pytest.mark.parametrize(
    "account_user,expected",
    [
        ({"id": 123}, "clawhunt-123"),
        ({"username": "bob"}, "clawhunt-bob"),
        ({"id": "a/b c"}, "clawhunt-a-b-c"),  # sanitized to the server grammar
        ({"email": "x@y.z"}, "clawhunt-x@y.z"),
        ({}, None),
        (None, None),
    ],
)
def test_developer_id_derivation(account_user, expected):
    assert di.developer_id_for_account(account_user) == expected


def test_ensure_not_logged_in():
    assert di.ensure_developer_key_registered(None, {"id": 1})["reason"] == "not_logged_in"


def test_ensure_no_account_identity():
    assert di.ensure_developer_key_registered("tok", {})["reason"] == "no_account_identity"


def test_ensure_escrows_and_caches_server_pair():
    priv_material, pub_material = _fresh_pair()
    body = {"private_key": priv_material, "public_key": pub_material, "keyid": "sha256:" + "0" * 64, "created": True}
    client = _FakeEnsureClient(body=body)
    result = di.ensure_developer_key_registered("tok-123", {"id": 7}, client=client)
    assert result["ok"] is True
    assert result["developer_id"] == "clawhunt-7"
    assert result["keyid"].startswith("sha256:")
    assert result["created"] is True
    # The SERVER private key is cached locally at 0600.
    path = di.developer_key_path()
    assert path.read_text().strip() == priv_material
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    # No local material existed → none offered to the server; token forwarded.
    assert client.calls[0]["private_key"] is None
    assert client.calls[0]["public_key"] is None
    assert client.calls[0]["access_token"] == "tok-123"
    assert client.calls[0]["developer_id"] == "clawhunt-7"


def test_ensure_offers_local_material_for_adoption():
    # Pre-seed a legacy per-device key; ensure must offer it so the server can adopt
    # or backfill it (one-key-per-user migration).
    di.load_or_create_developer_key()
    material = di._read_local_key_material(di.developer_key_path())
    assert material is not None
    body = {"private_key": material[0], "public_key": material[1], "keyid": "sha256:" + "1" * 64, "created": True}
    client = _FakeEnsureClient(body=body)
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=client)
    assert result["ok"] is True
    sent = client.calls[0]
    assert sent["private_key"] == material[0]
    assert sent["public_key"] == material[1]


def test_ensure_backs_up_divergent_local_key_to_legacy():
    # Local key A exists; the server returns a DIFFERENT authoritative key B (e.g. this
    # is a second device). The cache becomes B and A is preserved at .legacy.
    di.load_or_create_developer_key()
    path = di.developer_key_path()
    old = path.read_text().strip()
    new_priv, new_pub = _fresh_pair()
    body = {"private_key": new_priv, "public_key": new_pub, "keyid": "sha256:" + "2" * 64, "created": False}
    client = _FakeEnsureClient(body=body)
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=client)
    assert result["ok"] is True
    assert path.read_text().strip() == new_priv
    legacy = path.with_name(path.name + ".legacy")
    assert legacy.read_text().strip() == old
    assert stat.S_IMODE(legacy.stat().st_mode) == 0o600


def test_ensure_server_rejection_fails_closed():
    # 409 reset_required / 503 escrow-off etc. must report ok=False (no fake success).
    client = _FakeEnsureClient(status_code=409, body={"detail": "reset required"})
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=client)
    assert result["ok"] is False
    assert "409" in result["error"]


def test_ensure_missing_material_fails_closed():
    client = _FakeEnsureClient(body={"keyid": "sha256:" + "0" * 64})  # no key material
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=client)
    assert result["ok"] is False
    assert "missing key material" in result["error"]


def test_ensure_rejects_malformed_private_material_not_cached():
    # Server returns non-base64 private material → must fail closed, never cache it.
    _priv, pub = _fresh_pair()
    body = {"private_key": "ed25519:not-base64!!", "public_key": pub, "keyid": "sha256:" + "0" * 64}
    client = _FakeEnsureClient(body=body)
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=client)
    assert result["ok"] is False
    assert "inconsistent" in result["error"]
    assert not di.developer_key_path().is_file()  # nothing corrupt was cached


def test_ensure_rejects_mismatched_pair_not_cached():
    # private_key derives a DIFFERENT public key than the stated public_key.
    priv, _pub = _fresh_pair()
    _other_priv, other_pub = _fresh_pair()
    body = {"private_key": priv, "public_key": other_pub, "keyid": "sha256:" + "0" * 64}
    client = _FakeEnsureClient(body=body)
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=client)
    assert result["ok"] is False
    assert "inconsistent" in result["error"]
    assert not di.developer_key_path().is_file()


def test_store_key_backup_failure_preserves_prior_key():
    # If the .legacy backup cannot be written, the prior (possibly only) local key must
    # NOT be overwritten — no silent key loss.
    di.load_or_create_developer_key()  # local key A
    path = di.developer_key_path()
    old = path.read_text().strip()
    # Make .legacy un-writable as a target by occupying it with a directory.
    (path.with_name(path.name + ".legacy")).mkdir()
    new_priv, new_pub = _fresh_pair()  # server's divergent key B
    body = {"private_key": new_priv, "public_key": new_pub, "keyid": "sha256:" + "3" * 64, "created": False}
    client = _FakeEnsureClient(body=body)
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=client)
    # Backup failed → main key preserved (not lost) AND ensure fails closed rather than
    # reporting success with a stale local key (no fake-success).
    assert path.read_text().strip() == old
    assert result["ok"] is False
    assert "cache write failed" in result["error"]
    assert result["source"] == "local_cache"  # the preserved key can still sign offline


def test_ensure_survives_corrupt_binary_local_key(tmp_path: Path):
    # A pre-existing key file with non-UTF-8 binary garbage must NOT crash login: it is
    # not a usable key, so the authoritative server key overwrites it (best-effort).
    path = di.developer_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xfe\x00\x01 not utf-8 \x80")
    priv_material, pub_material = _fresh_pair()
    body = {"private_key": priv_material, "public_key": pub_material, "keyid": "sha256:" + "4" * 64, "created": False}
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=_FakeEnsureClient(body=body))
    assert result["ok"] is True  # did not crash; overwrote the corrupt file
    assert path.read_text().strip() == priv_material


def test_store_key_leaves_no_stray_temp_files():
    priv_material, pub_material = _fresh_pair()
    body = {"private_key": priv_material, "public_key": pub_material, "keyid": "sha256:" + "0" * 64, "created": True}
    di.ensure_developer_key_registered("tok", {"id": 7}, client=_FakeEnsureClient(body=body))
    parent = di.developer_key_path().parent
    assert not list(parent.glob(".*tmp")), "atomic write must clean up its temp file"


class _RawShapeEnsureClient:
    """Returns a non-wrapper dict (no {status_code, ok, body}) — must fail closed."""

    def ensure_hosted_developer_key(self, *a, **k):
        return {"keyid": "sha256:" + "0" * 64}  # looks successful but is the wrong shape


def test_ensure_unexpected_shape_fails_closed():
    result = di.ensure_developer_key_registered("tok", {"id": 7}, client=_RawShapeEnsureClient())
    assert result["ok"] is False
    assert "unexpected" in result["error"]


class _RaisingEnsureClient:
    def ensure_hosted_developer_key(self, *a, **k):
        raise httpx.ConnectError("network down")


def test_ensure_offline_fallback_uses_local_cache():
    di.load_or_create_developer_key()  # a local cache exists
    result = di.ensure_developer_key_registered("tok", {"id": 1}, client=_RaisingEnsureClient())
    assert result["ok"] is False  # server never confirmed
    assert result["source"] == "local_cache"  # but signing still works this session
    assert "network down" in result["error"]


def test_ensure_network_error_without_cache_has_no_fallback():
    result = di.ensure_developer_key_registered("tok", {"id": 1}, client=_RaisingEnsureClient())
    assert result["ok"] is False
    assert "source" not in result  # nothing to fall back to
    assert "network down" in result["error"]


def test_existing_wide_permission_key_is_tightened(tmp_path: Path):
    # Seed a key file with world/group-readable perms; loading must self-heal to 0600.
    key1, pub1 = di.load_or_create_developer_key()
    path = di.developer_key_path()
    path.chmod(0o644)
    key2, pub2 = di.load_or_create_developer_key()
    assert pub2 == pub1  # same key adopted, not regenerated
    assert stat.S_IMODE(path.stat().st_mode) == 0o600  # tightened


def test_existing_key_path_self_heals_wide_directory(tmp_path: Path):
    # Create the key (dir becomes 0700), then loosen the dir to 0755 and reload via
    # the existing-key path: the storage directory must be re-tightened to 0700.
    di.load_or_create_developer_key()
    parent = di.developer_key_path().parent
    parent.chmod(0o755)
    di.load_or_create_developer_key()  # existing-key path
    assert stat.S_IMODE(parent.stat().st_mode) == 0o700


def test_register_developer_key_uses_short_timeout(monkeypatch):
    seen = {}

    def fake_post(url, **kwargs):
        seen["timeout"] = kwargs.get("timeout")
        return httpx.Response(201, json={"keyid": "sha256:" + "0" * 64}, request=httpx.Request("POST", "https://h/x"))

    client = ClawHuntAccountClient(
        settings=ClawHuntAccountSettings(base_url="https://hunt.example"),
        transport=httpx.MockTransport(lambda r: httpx.Response(201, json={})),
    )
    monkeypatch.setattr(client._client, "post", fake_post)
    client.register_developer_key("tok", "clawhunt-7", "ed25519:AAAA")
    assert seen["timeout"] == 5.0  # short, explicit — never the 20s client default


def test_ensure_hosted_developer_key_posts_pair_with_bearer():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        seen["body"] = request.content.decode()
        return httpx.Response(
            200,
            json={
                "developer_id": "clawhunt-7",
                "public_key": "ed25519:AAAA",
                "private_key": "ed25519:BBBB",
                "keyid": "sha256:" + "0" * 64,
                "created": True,
            },
        )

    client = ClawHuntAccountClient(
        settings=ClawHuntAccountSettings(base_url="https://hunt.example"),
        transport=httpx.MockTransport(handler),
    )
    out = client.ensure_hosted_developer_key(
        "tok-9", "clawhunt-7", private_key="ed25519:PPPP", public_key="ed25519:QQQQ"
    )
    assert out["ok"] is True
    assert out["body"]["private_key"] == "ed25519:BBBB"
    assert seen["url"].endswith("/v1/capabilities/developers/key/ensure")
    assert seen["auth"] == "Bearer tok-9"
    assert "clawhunt-7" in seen["body"] and "ed25519:PPPP" in seen["body"]


def test_register_developer_key_posts_to_endpoint_with_bearer():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        seen["body"] = request.content.decode()
        return httpx.Response(201, json={"developer_id": "clawhunt-7", "keyid": "sha256:" + "0" * 64, "created": True})

    client = ClawHuntAccountClient(
        settings=ClawHuntAccountSettings(base_url="https://hunt.example"),
        transport=httpx.MockTransport(handler),
    )
    out = client.register_developer_key("tok-9", "clawhunt-7", "ed25519:AAAA")
    assert out["ok"] is True
    assert out["body"]["keyid"].startswith("sha256:")
    assert seen["url"].endswith("/v1/capabilities/developers/register")
    assert seen["auth"] == "Bearer tok-9"
    assert "clawhunt-7" in seen["body"] and "ed25519:AAAA" in seen["body"]
