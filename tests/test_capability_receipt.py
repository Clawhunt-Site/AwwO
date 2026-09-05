"""Unit tests for the workshop trust receipt + immutable archive staging (S1)."""

from __future__ import annotations

import hashlib
import stat
from pathlib import Path

import pytest

from superclaw.capability_receipt import (
    MAX_RECEIPT_TTL_SECONDS,
    WORKSHOP_RECEIPT_HMAC_KEY_ENV,
    WorkshopReceiptError,
    compute_file_sha256,
    compute_receipt_mac,
    issue_receipt,
    receipt_to_wire,
    remove_staged_artifact,
    stage_immutable_archive,
    verify_wire,
)

_KEY = b"unit-test-receipt-key"
_D1 = "sha256:" + "ab" * 32
_D2 = "sha256:" + "cd" * 32


def _receipt(**overrides: object):
    base = dict(
        kind="plugin",
        capability_id="acme.tool",
        version="1.2.3",
        package_digest=_D1,
        transport_sha256=_D2,
        staged_artifact="/tmp/staged/plugin/acme.tool/cd.scplug",
        artifact_ref="superclaw-object://capabilities/plugin/acme.tool",
        app_env="staging",
        official=True,
        issued_at=1000,
        ttl_seconds=120,
    )
    base.update(overrides)
    return issue_receipt(**base)  # type: ignore[arg-type]


# --- receipt sign / verify -------------------------------------------------


def test_sign_verify_roundtrip() -> None:
    receipt = _receipt()
    wire = receipt_to_wire(receipt, key=_KEY)
    verified = verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")
    assert verified.receipt_id == receipt.receipt_id
    assert verified.official is True
    assert verified.package_digest == receipt.package_digest


def test_tampered_field_fails_mac() -> None:
    wire = receipt_to_wire(_receipt(), key=_KEY)
    wire["version"] = "9.9.9"
    with pytest.raises(WorkshopReceiptError, match="mac verification failed"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")


def test_official_string_coercion_rejected() -> None:
    # Codex blocker 6: bool("false") == True must NOT pass. Strict type check rejects it.
    wire = receipt_to_wire(_receipt(official=False), key=_KEY)
    wire["official"] = "false"
    with pytest.raises(WorkshopReceiptError, match="wrong type"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")


def test_int_field_coercion_rejected() -> None:
    wire = receipt_to_wire(_receipt(), key=_KEY)
    wire["issued_at"] = "1000"
    with pytest.raises(WorkshopReceiptError, match="wrong type"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")


def test_bool_is_not_accepted_as_int() -> None:
    wire = receipt_to_wire(_receipt(), key=_KEY)
    wire["issued_at"] = True
    with pytest.raises(WorkshopReceiptError, match="must be an int"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")


def test_extra_fields_rejected() -> None:
    wire = receipt_to_wire(_receipt(), key=_KEY)
    wire["evil"] = "x"
    with pytest.raises(WorkshopReceiptError, match="unexpected fields"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")


def test_wrong_key_fails() -> None:
    wire = receipt_to_wire(_receipt(), key=_KEY)
    with pytest.raises(WorkshopReceiptError, match="mac verification failed"):
        verify_wire(wire, key=b"other-key", now=1050, expected_app_env="staging")


def test_expired_receipt_rejected() -> None:
    wire = receipt_to_wire(_receipt(issued_at=1000, ttl_seconds=120), key=_KEY)
    with pytest.raises(WorkshopReceiptError, match="expired"):
        verify_wire(wire, key=_KEY, now=1120, expected_app_env="staging")


def test_future_issued_at_rejected() -> None:
    wire = receipt_to_wire(_receipt(issued_at=10000, ttl_seconds=120), key=_KEY)
    with pytest.raises(WorkshopReceiptError, match="not yet valid"):
        verify_wire(wire, key=_KEY, now=1000, expected_app_env="staging")


def test_ttl_over_max_rejected() -> None:
    # Forge an over-long window on a re-signed receipt so only the TTL-bound check fires.
    forged = _receipt(issued_at=1000, ttl_seconds=MAX_RECEIPT_TTL_SECONDS)
    object.__setattr__(forged, "expires_at", 1000 + MAX_RECEIPT_TTL_SECONDS + 50)
    wire = receipt_to_wire(forged, key=_KEY)
    with pytest.raises(WorkshopReceiptError, match="ttl exceeds"):
        verify_wire(wire, key=_KEY, now=1100, expected_app_env="staging")


def test_app_env_mandatory() -> None:
    wire = receipt_to_wire(_receipt(app_env="staging"), key=_KEY)
    with pytest.raises(WorkshopReceiptError, match="expected_app_env is required"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="")


def test_app_env_binding_enforced() -> None:
    wire = receipt_to_wire(_receipt(app_env="staging"), key=_KEY)
    with pytest.raises(WorkshopReceiptError, match="app_env"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="production")


def test_missing_key_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(WORKSHOP_RECEIPT_HMAC_KEY_ENV, raising=False)
    with pytest.raises(WorkshopReceiptError, match="required"):
        compute_receipt_mac(_receipt())


def test_empty_explicit_key_rejected() -> None:
    with pytest.raises(WorkshopReceiptError, match="must not be empty"):
        compute_receipt_mac(_receipt(), key=b"")


def test_env_key_used_when_no_explicit_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(WORKSHOP_RECEIPT_HMAC_KEY_ENV, "env-key")
    wire = receipt_to_wire(_receipt())
    verify_wire(wire, now=1050, expected_app_env="staging")


def test_unsupported_receipt_version_rejected() -> None:
    wire = receipt_to_wire(_receipt(), key=_KEY)
    wire["receipt_version"] = "999"
    with pytest.raises(WorkshopReceiptError, match="receipt_version"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")


def test_missing_mac_rejected() -> None:
    wire = _receipt().signed_core()
    with pytest.raises(WorkshopReceiptError, match="missing mac"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")


@pytest.mark.parametrize("bad_mac", ["sha256:é", "", "not-a-mac", "sha256:short", "abc"])
def test_malformed_mac_fails_closed(bad_mac: str) -> None:
    # Codex round-3 blocker: a non-ASCII mac must NOT raise a raw TypeError out of
    # hmac.compare_digest — it must stay a WorkshopReceiptError (fail-closed).
    wire = receipt_to_wire(_receipt(), key=_KEY)
    wire["mac"] = bad_mac
    with pytest.raises(WorkshopReceiptError, match="mac"):
        verify_wire(wire, key=_KEY, now=1050, expected_app_env="staging")


@pytest.mark.parametrize(
    "bad",
    [
        {"kind": "bogus"},
        {"version": ""},
        {"capability_id": ""},
        {"app_env": ""},
        {"package_digest": "not-a-digest"},
        {"transport_sha256": "sha256:short"},
        {"ttl_seconds": 0},
        {"ttl_seconds": MAX_RECEIPT_TTL_SECONDS + 1},
    ],
)
def test_issue_receipt_validation(bad: dict[str, object]) -> None:
    with pytest.raises(WorkshopReceiptError):
        _receipt(**bad)


@pytest.mark.parametrize("bad_official", ["false", "0", 0, 1, None])
def test_issue_receipt_rejects_nonbool_official(bad_official: object) -> None:
    # Codex re-review blocker 2: signer must not coerce a non-bool into official.
    with pytest.raises(WorkshopReceiptError, match="official must be a bool"):
        _receipt(official=bad_official)


# --- transport sha256 ------------------------------------------------------


def test_compute_file_sha256(tmp_path: Path) -> None:
    blob = tmp_path / "pkg.scplug"
    blob.write_bytes(b"hello-workshop")
    expected = "sha256:" + hashlib.sha256(b"hello-workshop").hexdigest()
    assert compute_file_sha256(blob) == expected


# --- immutable archive staging ---------------------------------------------


def _make_archive(tmp_path: Path, data: bytes = b"PK-fake-scplug") -> tuple[Path, str]:
    archive = tmp_path / "package.scplug"
    archive.write_bytes(data)
    return archive, compute_file_sha256(archive)


def test_stage_copies_and_freezes(tmp_path: Path) -> None:
    archive, sha = _make_archive(tmp_path)
    root = tmp_path / "staging"
    staged = stage_immutable_archive(
        archive, staging_root=root, kind="plugin", capability_id="acme.tool", transport_sha256=sha
    )
    assert staged.parent == root / "plugin" / "acme.tool"
    assert compute_file_sha256(staged) == sha
    assert stat.S_IMODE(staged.stat().st_mode) & stat.S_IWUSR == 0  # read-only
    remove_staged_artifact(staged, staging_root=root)
    assert not staged.exists()


def test_stage_rejects_sha_mismatch(tmp_path: Path) -> None:
    archive, _ = _make_archive(tmp_path)
    with pytest.raises(WorkshopReceiptError, match="do not match transport_sha256"):
        stage_immutable_archive(
            archive, staging_root=tmp_path / "s", kind="plugin",
            capability_id="acme.tool", transport_sha256=_D1,  # wrong sha
        )


def test_stage_rejects_symlink_source(tmp_path: Path) -> None:
    archive, sha = _make_archive(tmp_path)
    link = tmp_path / "link.scplug"
    link.symlink_to(archive)
    with pytest.raises(WorkshopReceiptError, match="regular file"):
        stage_immutable_archive(
            link, staging_root=tmp_path / "s", kind="plugin",
            capability_id="acme.tool", transport_sha256=sha,
        )


def test_stage_is_idempotent(tmp_path: Path) -> None:
    archive, sha = _make_archive(tmp_path)
    root = tmp_path / "staging"
    first = stage_immutable_archive(
        archive, staging_root=root, kind="plugin", capability_id="acme.tool", transport_sha256=sha
    )
    second = stage_immutable_archive(
        archive, staging_root=root, kind="plugin", capability_id="acme.tool", transport_sha256=sha
    )
    assert first == second
    remove_staged_artifact(first, staging_root=root)


def test_stage_rejects_preplanted_mismatch(tmp_path: Path) -> None:
    # Codex blocker 1: a pre-planted file at the target with different bytes is refused.
    archive, sha = _make_archive(tmp_path, b"good-bytes")
    root = tmp_path / "staging"
    digest_hex = sha[len("sha256:"):]
    target_dir = root / "plugin" / "acme.tool"
    target_dir.mkdir(parents=True)
    (target_dir / f"{digest_hex}.scplug").write_bytes(b"evil-preplanted")
    with pytest.raises(WorkshopReceiptError, match="hash mismatch"):
        stage_immutable_archive(
            archive, staging_root=root, kind="plugin", capability_id="acme.tool", transport_sha256=sha
        )


def test_stage_sanitizes_capability_id(tmp_path: Path) -> None:
    archive, sha = _make_archive(tmp_path)
    root = tmp_path / "staging"
    staged = stage_immutable_archive(
        archive, staging_root=root, kind="skill", capability_id="../../etc/evil", transport_sha256=sha
    )
    assert root in staged.parents
    assert ".." not in staged.relative_to(root).parts
    remove_staged_artifact(staged, staging_root=root)


@pytest.mark.parametrize("bad_id", [".", "..", ""])
def test_stage_rejects_dot_segments(tmp_path: Path, bad_id: str) -> None:
    archive, sha = _make_archive(tmp_path)
    with pytest.raises(WorkshopReceiptError, match="unsafe path segment"):
        stage_immutable_archive(
            archive, staging_root=tmp_path / "s", kind="plugin",
            capability_id=bad_id, transport_sha256=sha,
        )


def test_stage_rejects_symlinked_parent(tmp_path: Path) -> None:
    # Codex re-review blocker 1: a symlinked staging path component escaping the
    # root must be refused (mkdir(exist_ok=True) would otherwise accept it).
    archive, sha = _make_archive(tmp_path)
    root = tmp_path / "staging"
    (root / "plugin").mkdir(parents=True)
    outside = tmp_path / "attacker"
    outside.mkdir()
    (root / "plugin" / "acme.tool").symlink_to(outside, target_is_directory=True)
    with pytest.raises(WorkshopReceiptError, match="symlink"):
        stage_immutable_archive(
            archive, staging_root=root, kind="plugin", capability_id="acme.tool", transport_sha256=sha
        )


def test_stage_rejects_symlinked_kind_component(tmp_path: Path) -> None:
    archive, sha = _make_archive(tmp_path)
    root = tmp_path / "staging"
    root.mkdir()
    outside = tmp_path / "attacker"
    outside.mkdir()
    (root / "plugin").symlink_to(outside, target_is_directory=True)
    with pytest.raises(WorkshopReceiptError, match="symlink"):
        stage_immutable_archive(
            archive, staging_root=root, kind="plugin", capability_id="acme.tool", transport_sha256=sha
        )


def test_stage_rejects_symlinked_root(tmp_path: Path) -> None:
    archive, sha = _make_archive(tmp_path)
    real_root = tmp_path / "real"
    real_root.mkdir()
    link_root = tmp_path / "linkroot"
    link_root.symlink_to(real_root, target_is_directory=True)
    with pytest.raises(WorkshopReceiptError, match="symlink"):
        stage_immutable_archive(
            archive, staging_root=link_root, kind="plugin", capability_id="acme.tool", transport_sha256=sha
        )


def test_remove_refuses_outside_staging_root(tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("x", encoding="utf-8")
    with pytest.raises(WorkshopReceiptError, match="outside staging root"):
        remove_staged_artifact(outside, staging_root=tmp_path / "staging")
