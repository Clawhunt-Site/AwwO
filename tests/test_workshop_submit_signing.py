"""Developer-signing of capability-workshop submissions (super upload side).

Covers the gap that previously made every workshop upload unsigned: the
``submit-review`` path now signs the canonical ``capability_signed_core`` with the
developer's escrowed Ed25519 key and attaches ``signature``/``signer_keyid``, which
ClawHunt verifies against the registered public key. These tests pin:

* the signature verifies cross-repo (super signs, the byte-identical verifier accepts);
* the signature BINDS kind/id/version/digest/artifact_ref (tamper → reject);
* the payload carries both fields all-or-nothing and survives the secret scanner;
* ``submit_capability_for_review`` wires a provided key through to the wire payload;
* malformed keys fail closed (never emit an unsigned-but-claimed payload).
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)

from superclaw.capability_devtools import (
    CapabilityDevtoolError,
    build_review_submission_payload,
    sign_capability_submission,
    submit_capability_for_review,
    validate_capability_artifact,
)
from superclaw.secrets_scan import contains_secret
from superclaw.trust_contracts import (
    KEYTYPE_ED25519,
    SCHEME_ED25519,
    TrustContractError,
    capability_signed_core,
    compute_keyid,
    generate_ed25519_keypair,
    verify_envelope,
)

_EXAMPLE_PLUGIN = Path(__file__).resolve().parents[1] / "examples" / "plugins" / "text-stats"
_REF = "superclaw-object://capabilities/plugin/dev.leon.text-stats/versions/1.0.0/package.scplug"


def _mint_key() -> tuple[str, str]:
    """Return ``(private_material, public_material)`` both as ``ed25519:<base64>``."""
    private_key, public_material = generate_ed25519_keypair()
    raw = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    return "ed25519:" + base64.b64encode(raw).decode("ascii"), public_material


def _metadata():
    return validate_capability_artifact("plugin", _EXAMPLE_PLUGIN)


def _verify(meta, sig, public_material, *, artifact_ref):
    core = capability_signed_core(
        kind=meta.kind,
        capability_id=meta.capability_id,
        version=meta.version,
        package_digest=meta.artifact_digest,
        artifact_ref=artifact_ref,
    )
    envelope = {"signed": core, "signatures": [{"keyid": sig["signer_keyid"], "sig": sig["signature"]}]}
    keys = {sig["signer_keyid"]: {"public_key": public_material, "keytype": KEYTYPE_ED25519, "scheme": SCHEME_ED25519}}
    try:
        return sig["signer_keyid"] in verify_envelope(envelope, keys, threshold=1)
    except TrustContractError:
        return False  # a non-verifying (e.g. tampered) envelope is a clean reject


def test_signature_verifies_cross_repo():
    meta = _metadata()
    private_material, public_material = _mint_key()
    sig = sign_capability_submission(meta, artifact_ref=_REF, signing_private_key=private_material)
    assert sig["signer_keyid"] == compute_keyid(public_material)
    assert sig["signature"].startswith("ed25519:")
    assert _verify(meta, sig, public_material, artifact_ref=_REF)


def test_signature_binds_artifact_ref():
    meta = _metadata()
    private_material, public_material = _mint_key()
    sig = sign_capability_submission(meta, artifact_ref=_REF, signing_private_key=private_material)
    # A different artifact_ref (redirecting at other bytes) must not verify.
    assert not _verify(meta, sig, public_material, artifact_ref=_REF.replace("text-stats", "evil"))


def test_payload_carries_both_fields_and_survives_secret_scan():
    meta = _metadata()
    private_material, _ = _mint_key()
    sig = sign_capability_submission(meta, artifact_ref=_REF, signing_private_key=private_material)
    payload = build_review_submission_payload(
        meta, artifact_ref=_REF, developer_ref="leon",
        signature=sig["signature"], signer_keyid=sig["signer_keyid"],
    )
    assert payload["signature"] == sig["signature"]
    assert payload["signer_keyid"] == sig["signer_keyid"]
    assert not contains_secret(json.dumps(payload))


def test_payload_partial_signature_fails_closed():
    meta = _metadata()
    # A signature without its keyid (or vice versa) is a malformed claim → raise,
    # never silently downgrade to an unsigned submission.
    with pytest.raises(CapabilityDevtoolError):
        build_review_submission_payload(meta, artifact_ref=_REF, signer_keyid="sha256:" + "a" * 64)
    with pytest.raises(CapabilityDevtoolError):
        build_review_submission_payload(meta, artifact_ref=_REF, signature="ed25519:" + "A" * 86 + "==")


def test_unsigned_payload_unchanged():
    meta = _metadata()
    payload = build_review_submission_payload(meta, artifact_ref=_REF)
    assert "signature" not in payload and "signer_keyid" not in payload


@pytest.mark.parametrize("bad", ["ed25519:not!!base64", "ed25519:" + base64.b64encode(b"short").decode(), ""])
def test_malformed_key_fails_closed(bad):
    meta = _metadata()
    with pytest.raises(CapabilityDevtoolError):
        sign_capability_submission(meta, artifact_ref=_REF, signing_private_key=bad)


class _FakeResp:
    def __init__(self, payload: dict):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    def __init__(self, captured: dict):
        self._captured = captured

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, url, json):  # noqa: A002 - mirror httpx.Client.post signature
        self._captured["payload"] = json
        return _FakeResp({"ok": True, "submission_id": "sub_test", "status": "pending"})


def test_submit_wires_signature_through_to_payload():
    meta_private, _ = _mint_key()
    captured: dict = {}
    result = submit_capability_for_review(
        "plugin",
        _EXAMPLE_PLUGIN,
        api_url="https://example.test",
        artifact_ref=_REF,
        developer_ref="leon",
        signing_private_key=meta_private,
        client_factory=lambda **_kw: _FakeClient(captured),
    )
    assert result.ok
    assert captured["payload"]["signature"].startswith("ed25519:")
    assert captured["payload"]["signer_keyid"].startswith("sha256:")


def test_resolve_signing_key_reads_cache(tmp_path, monkeypatch):
    from superclaw import cli

    key_file = tmp_path / "developer-signing-key.ed25519"
    private_material, _ = _mint_key()
    key_file.write_text(private_material + "\n", encoding="utf-8")
    monkeypatch.setattr("superclaw.developer_identity.developer_key_path", lambda: key_file)
    assert cli._resolve_workshop_signing_key() == private_material


def test_resolve_signing_key_none_when_absent_and_logged_out(tmp_path, monkeypatch):
    from superclaw import cli

    monkeypatch.setattr("superclaw.developer_identity.developer_key_path", lambda: tmp_path / "missing.ed25519")
    monkeypatch.setattr("superclaw.clawhunt_auth.load_clawhunt_auth", lambda: {})
    assert cli._resolve_workshop_signing_key() is None


def test_submit_without_key_stays_unsigned():
    captured: dict = {}
    submit_capability_for_review(
        "plugin",
        _EXAMPLE_PLUGIN,
        api_url="https://example.test",
        artifact_ref=_REF,
        client_factory=lambda **_kw: _FakeClient(captured),
    )
    assert "signature" not in captured["payload"]
    assert "signer_keyid" not in captured["payload"]


def _fake_submit_capture(captured: dict):
    from superclaw.capability_devtools import CapabilitySubmissionResponse

    def _fake(kind, artifact_path, **kwargs):  # noqa: ANN001 - mirror the real signature loosely
        captured.update(kwargs)
        return CapabilitySubmissionResponse(
            ok=True, submission_id="sub_cli", status="pending", response={}, request={}
        )

    return _fake


def test_cli_default_signs_with_cached_key(monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    material, public = _mint_key()
    monkeypatch.setattr("superclaw.developer_identity._read_local_key_material", lambda _p: (material, public))
    captured: dict = {}
    monkeypatch.setattr("superclaw.cli.submit_capability_for_review", _fake_submit_capture(captured))
    result = CliRunner().invoke(
        app,
        ["capabilities", "workshop", "submit-review", "plugin", str(_EXAMPLE_PLUGIN),
         "--api-url", "https://example.test", "--artifact-ref", _REF, "--json"],
    )
    assert result.exit_code == 0, result.output
    assert captured["signing_private_key"] == material


def test_cli_no_sign_passes_no_key(monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    captured: dict = {}
    monkeypatch.setattr("superclaw.cli.submit_capability_for_review", _fake_submit_capture(captured))
    result = CliRunner().invoke(
        app,
        ["capabilities", "workshop", "submit-review", "plugin", str(_EXAMPLE_PLUGIN),
         "--api-url", "https://example.test", "--artifact-ref", _REF, "--no-sign", "--json"],
    )
    assert result.exit_code == 0, result.output
    assert captured["signing_private_key"] is None


def test_cli_missing_key_errors_with_correct_command(monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    monkeypatch.setattr("superclaw.developer_identity._read_local_key_material", lambda _p: None)
    monkeypatch.setattr("superclaw.clawhunt_auth.load_clawhunt_auth", lambda: {})
    result = CliRunner().invoke(
        app,
        ["capabilities", "workshop", "submit-review", "plugin", str(_EXAMPLE_PLUGIN),
         "--api-url", "https://example.test", "--artifact-ref", _REF],
    )
    assert result.exit_code == 1
    assert "account-login" in result.output
    assert "login-password" not in result.output
