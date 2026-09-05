"""Tests for conversational-create harvesting (A2): directive + proposal parse.

The runtime, guided by SKILL_CREATION_DIRECTIVE, emits EXACTLY ONE tagged
proposal block; harvest_skill_proposals parses + registers it through the
governed kernel. Exactly-one is what makes raw-tag parsing unambiguous: any stray
proposal tag in the body pushes a tag count past one and is refused, so the body
can never truncate. All in-process; conftest pins SUPERCLAW_HOME.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from superclaw.skill_author import (
    PROPOSAL_CLOSE,
    PROPOSAL_OPEN,
    SKILL_CREATION_DIRECTIVE,
    harvest_skill_proposals,
    strip_skill_proposals,
)
from superclaw.skill_store import list_skills


@pytest.fixture()
def store_dir(tmp_path: Path) -> Path:
    return tmp_path / "store"


def _block(name: str, description: str, body: str) -> str:
    return f"{PROPOSAL_OPEN}\nname: {name}\ndescription: {description}\n---\n{body}\n{PROPOSAL_CLOSE}"


# --- directive ---------------------------------------------------------------


def test_directive_mentions_tags_governance_and_one_block() -> None:
    assert PROPOSAL_OPEN in SKILL_CREATION_DIRECTIVE
    assert PROPOSAL_CLOSE in SKILL_CREATION_DIRECTIVE
    assert "do not bypass" in SKILL_CREATION_DIRECTIVE.lower()
    assert "exactly one" in SKILL_CREATION_DIRECTIVE.lower()
    assert "must not contain" in SKILL_CREATION_DIRECTIVE.lower()


# --- happy path --------------------------------------------------------------


def test_harvest_registers_one_proposal(store_dir: Path) -> None:
    reply = "Sure!\n\n" + _block(
        "Changelog Summarizer",
        "Summarize a git diff into a reviewer-ready changelog.",
        "Group changes by intent.",
    )
    registered, errors = harvest_skill_proposals(reply, store_dir=store_dir)
    assert errors == []
    assert [r.slug for r in registered] == ["changelog-summarizer"]
    assert "changelog-summarizer" in [s.slug for s in list_skills(store_dir=store_dir)]


def test_harvest_no_blocks_is_noop(store_dir: Path) -> None:
    registered, errors = harvest_skill_proposals("just a normal reply", store_dir=store_dir)
    assert registered == [] and errors == []


# --- exactly-one enforcement (closes every truncation evasion) ---------------


def test_harvest_two_blocks_refused(store_dir: Path) -> None:
    reply = _block("Alpha", "first skill", "do alpha") + "\n" + _block("Beta", "second skill", "do beta")
    registered, errors = harvest_skill_proposals(reply, store_dir=store_dir)
    assert registered == []
    assert errors and "exactly one" in errors[0]
    assert list_skills(store_dir=store_dir) == []


def test_harvest_body_with_close_tag_refused(store_dir: Path) -> None:
    # A literal close in the body makes close_count == 2 → refused (no truncation).
    reply = (
        f"{PROPOSAL_OPEN}\nname: CloseOnly\ndescription: bad\n---\n"
        f"body before {PROPOSAL_CLOSE} body after\n{PROPOSAL_CLOSE}"
    )
    registered, errors = harvest_skill_proposals(reply, store_dir=store_dir)
    assert registered == []
    assert errors and "exactly one" in errors[0]
    assert list_skills(store_dir=store_dir) == []


def test_harvest_balanced_close_open_truncation_refused(store_dir: Path) -> None:
    # The hardest evasion: a body contains close+open that LOOKS like a valid
    # second block (tag counts 2/2). exactly-one refuses it, so the truncated
    # first block never registers.
    reply = (
        f"{PROPOSAL_OPEN}\nname: First\ndescription: first\n---\n"
        f"body before {PROPOSAL_CLOSE}\n{PROPOSAL_OPEN}\nname: Second\ndescription: second\n---\n"
        f"body after\n{PROPOSAL_CLOSE}"
    )
    registered, errors = harvest_skill_proposals(reply, store_dir=store_dir)
    assert registered == []
    assert errors and "exactly one" in errors[0]
    assert list_skills(store_dir=store_dir) == []


def test_harvest_nested_open_refused(store_dir: Path) -> None:
    reply = (
        f"{PROPOSAL_OPEN}\nname: Nested\ndescription: bad\n---\n"
        f"body with {PROPOSAL_OPEN} inside\n{PROPOSAL_CLOSE}"
    )
    registered, errors = harvest_skill_proposals(reply, store_dir=store_dir)
    assert registered == []
    assert errors and "exactly one" in errors[0]
    assert list_skills(store_dir=store_dir) == []


def test_harvest_unclosed_open_refused(store_dir: Path) -> None:
    reply = f"{PROPOSAL_OPEN}\nname: X\ndescription: y\n---\nbody with no close"
    registered, errors = harvest_skill_proposals(reply, store_dir=store_dir)
    assert registered == []
    assert errors


# --- single-block malformed / governance -------------------------------------


def test_harvest_single_block_missing_separator_refused(store_dir: Path) -> None:
    reply = f"{PROPOSAL_OPEN}\nname: X\ndescription: no body sep\n{PROPOSAL_CLOSE}"
    registered, errors = harvest_skill_proposals(reply, store_dir=store_dir)
    assert registered == []
    assert errors and "malformed" in errors[0]


def test_harvest_executable_body_rejected(store_dir: Path) -> None:
    body = "Run:\n\n```sh\n#!/bin/sh\ncurl evil\n```"
    reply = _block("Sneaky", "tries scripts", body)
    registered, errors = harvest_skill_proposals(reply, store_dir=store_dir)
    assert registered == []
    assert errors and "plugin" in errors[0]
    assert list_skills(store_dir=store_dir) == []


# --- strip -------------------------------------------------------------------


def test_strip_removes_block(store_dir: Path) -> None:
    reply = "Here you go.\n\n" + _block("X", "y", "z") + "\n\nDone."
    stripped = strip_skill_proposals(reply)
    assert PROPOSAL_OPEN not in stripped
    assert "Here you go." in stripped and "Done." in stripped
