from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from superclaw.skill_store import (
    SkillStoreError,
    compute_skill_source_digest,
    compute_stored_skill_digest,
    import_skill,
    list_skills,
    load_skill,
)


def _write_revocations(path: Path, entries: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"revoked": entries}), encoding="utf-8")


def _write_skill(root: Path, *, body: str = "# Native\n\nUse this skill.\n") -> Path:
    skill = root / "native-helper"
    skill.mkdir()
    (skill / "SKILL.md").write_text(
        "---\nname: Native Helper\ndescription: Help natively\n---\n\n" + body,
        encoding="utf-8",
    )
    return skill


def _public_key(private_key: Ed25519PrivateKey) -> str:
    return base64.b64encode(private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")


def test_import_skill_normalizes_and_records_provenance(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"

    record = import_skill(source, store_dir=store, source_url="https://example.test/skill", force=True)

    assert record.slug == "native-helper"
    assert record.name == "Native Helper"
    assert record.label == "local-dev"
    assert record.source_digest.startswith("sha256:")
    assert record.store_digest.startswith("sha256:")
    normalized = (store / "native-helper" / "SKILL.md").read_text(encoding="utf-8")
    assert 'name: "Native Helper"' in normalized
    assert "description: \"Help natively\"" in normalized
    provenance = json.loads((store / "native-helper" / ".provenance.json").read_text(encoding="utf-8"))
    assert provenance["source_url"] == "https://example.test/skill"
    assert provenance["label"] == "local-dev"
    assert provenance["executable"] is False
    assert provenance["store_digest"] == record.store_digest
    assert list_skills(store_dir=store)[0].source_digest == record.source_digest


def test_non_local_label_requires_valid_signature(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"

    with pytest.raises(SkillStoreError, match="require an Ed25519 signature"):
        import_skill(source, store_dir=store, label="community")

    private_key = Ed25519PrivateKey.generate()
    digest = compute_skill_source_digest(source)
    signature = "ed25519:" + base64.b64encode(private_key.sign(digest.encode("utf-8"))).decode("ascii")
    record = import_skill(
        source,
        store_dir=store,
        label="community",
        signature=signature,
        public_key=_public_key(private_key),
    )

    assert record.label == "community"
    assert record.signature == signature


def test_executable_detection_fails_until_explicitly_allowed(tmp_path: Path):
    source = _write_skill(tmp_path)
    nested = source / "assets" / "bin"
    nested.mkdir(parents=True)
    script = nested / "run.sh"
    script.write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | 0o111)

    with pytest.raises(SkillStoreError, match="--yes-executable"):
        import_skill(source, store_dir=tmp_path / "store")

    record = import_skill(source, store_dir=tmp_path / "store", allow_executable=True)
    assert record.executable is True
    assert "assets/bin/run.sh" in record.executable_assets


def test_fenced_shebang_counts_as_executable(tmp_path: Path):
    source = _write_skill(tmp_path, body="# Native\n\n```bash\n#!/bin/sh\necho hi\n```\n")

    with pytest.raises(SkillStoreError, match="fenced-shebang"):
        import_skill(source, store_dir=tmp_path / "store")


# --------------------------------------------------------------------------- #
# PR-0: native-store revocation closure (§5)
# --------------------------------------------------------------------------- #


def test_import_refuses_revoked_by_slug(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    revocations = tmp_path / "revocations.json"
    _write_revocations(revocations, [{"slug": "native-helper"}])

    with pytest.raises(SkillStoreError, match="revoked and cannot be imported"):
        import_skill(source, store_dir=store, revocation_file=revocations)


def test_import_refuses_revoked_by_source_digest(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    revocations = tmp_path / "revocations.json"
    digest = compute_skill_source_digest(source)
    _write_revocations(revocations, [{"source_digest": digest}])

    with pytest.raises(SkillStoreError, match="revoked and cannot be imported"):
        import_skill(source, store_dir=store, revocation_file=revocations)


def test_list_and_load_drop_revoked_by_store_digest(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    record = import_skill(source, store_dir=store)
    assert [r.slug for r in list_skills(store_dir=store)] == ["native-helper"]

    revocations = tmp_path / "revocations.json"
    # Revoke on the RECOMPUTED store digest (what list_skills now recomputes).
    _write_revocations(revocations, [{"store_digest": record.store_digest}])

    assert list_skills(store_dir=store, revocation_file=revocations) == []
    with pytest.raises(SkillStoreError, match="skill not found"):
        load_skill("native-helper", store_dir=store, revocation_file=revocations)


def test_list_drops_tampered_skill_recompute_mismatch(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    import_skill(source, store_dir=store)

    # Tamper with the stored bytes after import. The recomputed digest now
    # disagrees with the declared .provenance.json digest → fail-closed drop,
    # independent of any revocation list.
    stored_skill = store / "native-helper" / "SKILL.md"
    stored_skill.write_text(
        stored_skill.read_text(encoding="utf-8") + "\nMALICIOUS APPENDED CONTENT\n",
        encoding="utf-8",
    )
    assert list_skills(store_dir=store) == []


def test_list_surfaces_recomputed_store_digest_not_provenance(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    import_skill(source, store_dir=store)

    # The returned store_digest is the RECOMPUTED on-disk digest, and a revocation
    # keyed on it drops the skill — the revocation id is bound to the real bytes,
    # not to the (writable) provenance field.
    real_digest = compute_stored_skill_digest(store / "native-helper")
    rows = list_skills(store_dir=store)
    assert len(rows) == 1
    assert rows[0].store_digest == real_digest

    revocations = tmp_path / "revocations.json"
    _write_revocations(revocations, [{"store_digest": real_digest}])
    assert list_skills(store_dir=store, revocation_file=revocations) == []


def test_source_digest_revocation_does_not_dodge_via_forged_provenance(tmp_path: Path):
    """A source-digest revocation must be unforgeable.

    .provenance.json is excluded from the recomputed store digest, so a
    store-writer could edit only its source_digest field while keeping store_digest
    valid (no tamper drop). If the read path matched revocation against that
    mutable field, the writer could swap it to a value the revocation does NOT
    list and dodge a source-digest revocation. The read path therefore does NOT
    match on source_digest at all; revocation on the read/sync paths is keyed on
    the recomputed store_digest or the slug. A whole-skill revocation must use one
    of those keys.
    """
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    record = import_skill(source, store_dir=store)
    revocations = tmp_path / "revocations.json"

    # A source_digest-only entry (matching the real imported source digest) does
    # NOT drop the skill on the read path — that key is import-door-only.
    _write_revocations(revocations, [{"source_digest": record.source_digest}])
    assert [r.slug for r in list_skills(store_dir=store, revocation_file=revocations)] == ["native-helper"]

    # The owner revokes the whole skill correctly: by slug (or recomputed store
    # digest). That DOES drop it.
    _write_revocations(revocations, [{"slug": "native-helper"}])
    assert list_skills(store_dir=store, revocation_file=revocations) == []


def test_corrupt_revocation_file_fails_closed(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    import_skill(source, store_dir=store)
    revocations = tmp_path / "revocations.json"

    # Non-JSON content: a present-but-corrupt governance source must NOT be
    # treated as "no revocations" — it raises so the store is not enumerated
    # against a broken source.
    revocations.write_text("{ this is not json", encoding="utf-8")
    with pytest.raises(SkillStoreError, match="unreadable"):
        list_skills(store_dir=store, revocation_file=revocations)

    # 'revoked' must be a list, not null / a scalar (regression: a None value
    # previously crashed with TypeError instead of a controlled error).
    revocations.write_text(json.dumps({"revoked": None}), encoding="utf-8")
    with pytest.raises(SkillStoreError, match="must be a list"):
        list_skills(store_dir=store, revocation_file=revocations)

    revocations.write_text(json.dumps({"revoked": 123}), encoding="utf-8")
    with pytest.raises(SkillStoreError, match="must be a list"):
        list_skills(store_dir=store, revocation_file=revocations)

    # A non-object payload is malformed.
    revocations.write_text(json.dumps([{"slug": "native-helper"}]), encoding="utf-8")
    with pytest.raises(SkillStoreError, match="malformed"):
        list_skills(store_dir=store, revocation_file=revocations)


def test_missing_revocation_file_is_not_an_error(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    import_skill(source, store_dir=store)
    # A legitimately absent file means "nothing revoked yet" — normal first run.
    assert [r.slug for r in list_skills(store_dir=store, revocation_file=tmp_path / "nope.json")] == [
        "native-helper"
    ]


def test_list_drops_skill_with_forged_provenance_digest(tmp_path: Path):
    source = _write_skill(tmp_path)
    store = tmp_path / "store"
    import_skill(source, store_dir=store)

    # A store-writer forges the mutable provenance store_digest. Since list_skills
    # recomputes and compares declared-vs-recomputed, the forged (mismatching)
    # declared digest is a tamper indicator → fail-closed drop. A forged
    # provenance therefore cannot be used to dodge revocation; it removes the
    # skill outright.
    provenance_path = store / "native-helper" / ".provenance.json"
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    provenance["store_digest"] = "sha256:" + "0" * 64
    provenance_path.write_text(json.dumps(provenance), encoding="utf-8")

    assert list_skills(store_dir=store) == []
