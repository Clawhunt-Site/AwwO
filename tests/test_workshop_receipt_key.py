"""Slice 2a-1: the workshop receipt HMAC key provisioner (0600, owner-checked, fail-closed,
race-hardened). Covers Codex's adversarial findings: final-path O_EXCL, fd-validated reads,
.secrets parent safety, lexists (not exists) probing, strict 64-hex format."""

from __future__ import annotations

import os
import stat

import pytest

from superclaw.workshop_receipt_key import (
    WorkshopReceiptKeyError,
    ensure_workshop_receipt_key,
    read_workshop_receipt_key,
    workshop_receipt_key_path,
)


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path))
    return tmp_path


def test_ensure_generates_0600_64hex_then_idempotent():
    key = ensure_workshop_receipt_key()
    assert len(key) == 64 and all(c in "0123456789abcdef" for c in key)
    path = workshop_receipt_key_path()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert ensure_workshop_receipt_key() == key  # idempotent


def test_read_returns_none_when_absent():
    assert read_workshop_receipt_key() is None


def test_read_returns_provisioned_key():
    key = ensure_workshop_receipt_key()
    assert read_workshop_receipt_key() == key


def test_ensure_reads_winner_when_key_already_present():
    # simulate losing the create race: a valid key already exists → ensure() reads it
    path = workshop_receipt_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    import secrets as _s

    existing = _s.token_hex(32)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(fd, (existing + "\n").encode())
    os.close(fd)
    assert ensure_workshop_receipt_key() == existing


def test_ensure_exercises_filenotexist_then_exists_race(monkeypatch):
    # Force ensure() PAST the lexists fast-path so the final-path O_EXCL create actually
    # raises FileExistsError (the real lost-race branch), then reads the winner.
    import secrets as _s

    import superclaw.workshop_receipt_key as mod

    path = workshop_receipt_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    winner = _s.token_hex(32)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.write(fd, (winner + "\n").encode())
    os.close(fd)
    monkeypatch.setattr(mod.os.path, "lexists", lambda _p: False)  # skip fast-path → hit O_EXCL
    assert ensure_workshop_receipt_key() == winner  # FileExistsError → read winner


def test_fails_closed_on_hard_linked_key(tmp_path):
    ensure_workshop_receipt_key()
    path = workshop_receipt_key_path()
    try:
        os.link(path, tmp_path / "alias")  # nlink → 2
    except (OSError, NotImplementedError):
        pytest.skip("hard links unsupported")
    with pytest.raises(WorkshopReceiptKeyError, match="hard-link"):
        read_workshop_receipt_key()


def test_read_fails_closed_on_group_other_readable():
    ensure_workshop_receipt_key()
    workshop_receipt_key_path().chmod(0o644)
    with pytest.raises(WorkshopReceiptKeyError, match="0600"):
        read_workshop_receipt_key()


def test_read_fails_closed_on_owner_exec_bit():
    ensure_workshop_receipt_key()
    workshop_receipt_key_path().chmod(0o700)  # owner-exec is not allowed for a key
    with pytest.raises(WorkshopReceiptKeyError, match="0600"):
        read_workshop_receipt_key()


def test_ensure_fails_closed_on_widened_existing_key():
    ensure_workshop_receipt_key()
    workshop_receipt_key_path().chmod(0o640)
    with pytest.raises(WorkshopReceiptKeyError):
        ensure_workshop_receipt_key()


def test_fails_closed_on_symlink_key(tmp_path):
    path = workshop_receipt_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    real = tmp_path / "real-key"
    real.write_text("a" * 64, encoding="utf-8")
    real.chmod(0o600)
    try:
        os.symlink(real, path)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported")
    # a symlink (even to a valid key) is an anomaly, NOT silently followed/absent
    with pytest.raises(WorkshopReceiptKeyError, match="symlink"):
        read_workshop_receipt_key()


def test_broken_symlink_key_is_anomaly_not_absent(tmp_path):
    path = workshop_receipt_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    try:
        os.symlink(tmp_path / "does-not-exist", path)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported")
    with pytest.raises(WorkshopReceiptKeyError):  # lexists=True → not treated as absent
        read_workshop_receipt_key()


def test_fails_closed_on_weak_but_long_key():
    path = workshop_receipt_key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    path.write_text("x" * 64 + "\n", encoding="utf-8")  # 64 chars but not hex
    path.chmod(0o600)
    with pytest.raises(WorkshopReceiptKeyError, match="64-hex"):
        read_workshop_receipt_key()


def test_secrets_dir_is_0700():
    ensure_workshop_receipt_key()
    assert stat.S_IMODE(workshop_receipt_key_path().parent.stat().st_mode) == 0o700


def test_fails_closed_on_symlinked_secrets_dir(tmp_path):
    parent = workshop_receipt_key_path().parent
    real = tmp_path / "real-secrets"
    real.mkdir()
    os.chmod(real, 0o700)
    try:
        os.symlink(real, parent, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported")
    with pytest.raises(WorkshopReceiptKeyError, match="symlink"):
        ensure_workshop_receipt_key()


def test_fails_closed_on_widened_secrets_dir():
    parent = workshop_receipt_key_path().parent
    parent.mkdir(parents=True, exist_ok=True)
    os.chmod(parent, 0o777)  # group/other-accessible parent
    with pytest.raises(WorkshopReceiptKeyError, match="0700"):
        ensure_workshop_receipt_key()
