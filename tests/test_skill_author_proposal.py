"""Tests for the conversational-create control plane (register_skill_proposal).

All in-process; conftest pins SUPERCLAW_HOME so the default store is isolated.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from superclaw.skill_author import (
    MAX_BODY_LEN,
    MAX_DESCRIPTION_LEN,
    SkillProposalError,
    created_skill_receipt,
    register_skill_proposal,
)
from superclaw.skill_store import list_skills


@pytest.fixture()
def store_dir(tmp_path: Path) -> Path:
    return tmp_path / "store"


def test_register_prose_proposal_lands_in_store(store_dir: Path) -> None:
    record = register_skill_proposal(
        name="Changelog Summarizer",
        description="Summarize a git diff into a reviewer-ready changelog.",
        body="Group changes by intent and lead with the user-visible effect.",
        store_dir=store_dir,
    )
    assert record.slug == "changelog-summarizer"
    assert record.importer == "chat-author"
    slugs = [s.slug for s in list_skills(store_dir=store_dir)]
    assert "changelog-summarizer" in slugs


def test_register_refuses_side_effecting_body(store_dir: Path) -> None:
    # A fenced shebang is the store's executable signal → fail-closed to the
    # governed plugin flow, not an auto-created skill.
    body = "Run this:\n\n```sh\n#!/bin/sh\ncurl http://evil\n```\n"
    with pytest.raises(SkillProposalError) as exc:
        register_skill_proposal(
            name="Sneaky", description="tries to run a script", body=body, store_dir=store_dir
        )
    assert "plugin" in str(exc.value)
    assert list_skills(store_dir=store_dir) == []


@pytest.mark.parametrize(
    "name,description,body",
    [
        ("", "desc", "body"),
        ("name", "", "body"),
        ("name", "desc", ""),
        ("   ", "desc", "body"),
    ],
)
def test_register_rejects_empty_fields(store_dir: Path, name, description, body) -> None:
    with pytest.raises(SkillProposalError):
        register_skill_proposal(name=name, description=description, body=body, store_dir=store_dir)


def test_register_rejects_oversized_description(store_dir: Path) -> None:
    with pytest.raises(SkillProposalError):
        register_skill_proposal(
            name="ok",
            description="x" * (MAX_DESCRIPTION_LEN + 1),
            body="body",
            store_dir=store_dir,
        )


def test_register_existing_slug_requires_force(store_dir: Path) -> None:
    register_skill_proposal(name="Dup", description="first", body="one", store_dir=store_dir)
    with pytest.raises(SkillProposalError):
        register_skill_proposal(name="Dup", description="second", body="two", store_dir=store_dir)
    # force replaces it.
    record = register_skill_proposal(
        name="Dup", description="second", body="two", store_dir=store_dir, force=True
    )
    assert record.slug == "dup"


def test_register_description_round_trips_exactly(store_dir: Path) -> None:
    # The store's frontmatter parser strips quotes but does NOT unescape, so the
    # control plane sanitizes to a value that round-trips EXACTLY. Assert the
    # read-back description equals the sanitized form (no stray backslashes/quotes).
    register_skill_proposal(
        name="Quoter",
        description='handles "quotes" and \\ backslashes',
        body="do the thing",
        store_dir=store_dir,
    )
    loaded = {s.slug: s for s in list_skills(store_dir=store_dir)}
    desc = loaded["quoter"].description
    # " -> ' , \ dropped, whitespace runs folded; exact round-trip (no escape residue).
    assert desc == "handles 'quotes' and backslashes"
    assert "\\" not in desc and '"' not in desc


def test_register_name_with_executable_word_dup_reports_real_reason(store_dir: Path) -> None:
    # Regression: a name whose slug contains "executable" that already exists must
    # report the real "already exists" reason, NOT be mis-classified as a
    # side-effect refusal (typed exception, not substring match).
    register_skill_proposal(
        name="Executable Guide", description="a guide", body="prose", store_dir=store_dir
    )
    with pytest.raises(SkillProposalError) as exc:
        register_skill_proposal(
            name="Executable Guide", description="again", body="prose", store_dir=store_dir
        )
    assert "side-effecting" not in str(exc.value)
    assert "exists" in str(exc.value)


def test_register_rejects_oversized_body(store_dir: Path) -> None:
    # Cap is measured in bytes (multi-byte safe): a body of many multi-byte chars
    # whose byte length exceeds the cap is refused even if the char count is under.
    multibyte = "中" * (MAX_BODY_LEN // 3 + 10)  # each CJK char is 3 UTF-8 bytes
    assert len(multibyte) < MAX_BODY_LEN < len(multibyte.encode("utf-8"))
    with pytest.raises(SkillProposalError):
        register_skill_proposal(
            name="Big", description="huge body", body=multibyte, store_dir=store_dir
        )


@pytest.mark.parametrize(
    "raw_description,expected",
    [
        ('"quoted"', "quoted"),  # surrounding double-quotes → ' → stripped at ends
        ("ends'", "ends"),  # trailing single quote would be eaten by the parser
        ("'lead", "lead"),  # leading single quote
        ("mid'dle ok", "mid'dle ok"),  # inner quote is preserved
    ],
)
def test_register_scalar_round_trips_at_quote_boundaries(
    store_dir: Path, raw_description, expected
) -> None:
    register_skill_proposal(
        name="Boundary", description=raw_description, body="b", store_dir=store_dir
    )
    desc = {s.slug: s for s in list_skills(store_dir=store_dir)}["boundary"].description
    assert desc == expected


def test_register_rejects_field_emptied_by_sanitize(store_dir: Path) -> None:
    # A description of only characters the parser cannot carry sanitizes to empty
    # → fail-closed (it passed the raw non-empty check but has no safe content).
    with pytest.raises(SkillProposalError):
        register_skill_proposal(
            name="ok", description='"""', body="b", store_dir=store_dir
        )


def test_created_skill_receipt_is_honest_about_lifecycle() -> None:
    """C: the chat receipt must say registered-but-not-active and point at sync —
    never the overstated 'usable across runtimes' (created != active)."""
    msg = created_skill_receipt(["alpha", "beta"])
    assert "alpha, beta" in msg
    assert "Registered SuperClaw skill" in msg
    assert "Not active in any runtime yet" in msg
    assert "skill sync" in msg
    # The retired wording must not creep back in.
    assert "usable across runtimes" not in msg
    assert "Created SuperClaw skill" not in msg
