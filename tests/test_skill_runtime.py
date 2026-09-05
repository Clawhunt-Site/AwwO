"""Unit tests for run-scoped skill resolution + projection (skill_runtime).

All in-process and hermetic: prose skills go through the real native store
(``import_skill``) and tool-skills through the real local build path
(``build_and_install_skill_plugin``). No subprocesses, no signing — a built
local skill is equippable sign-free, so the fail-closed gate admits it without a
public key. conftest pins a fresh ``SUPERCLAW_HOME`` per test.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from superclaw.skill_build import build_and_install_skill_plugin
from superclaw.skill_store import import_skill
from superclaw.skill_runtime import (
    BackendSkillCapability,
    ProjectedSkillFile,
    SkillClass,
    SkillRuntimeError,
    UnavailableReason,
    classify_skill,
    plan_skill_run,
    prepare_run_skills,
    project_prose_skills,
)

MCP = BackendSkillCapability.mcp_backend()
RELAY = BackendSkillCapability.relay_backend()

PROSE_SKILL = """---
name: changelog-summarizer
description: Summarize a git diff into a reviewer-ready changelog.
---

# Changelog Summarizer

Group changes by intent and lead with the user-visible effect.
"""

TOOL_SKILL = """---
name: greeter
description: Greet a user by name.
---

# Greeter

Return a friendly greeting.
"""


def _write_skill_dir(root: Path, name: str, content: str) -> Path:
    skill_dir = root / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
    return skill_dir


@pytest.fixture()
def store_dir(tmp_path: Path) -> Path:
    return tmp_path / "skill-store"


@pytest.fixture()
def cache_root(tmp_path: Path) -> Path:
    return tmp_path / "plugin-cache"


def _import_prose(tmp_path: Path, store_dir: Path, content: str = PROSE_SKILL) -> None:
    src = _write_skill_dir(tmp_path / "src", "prose", content)
    import_skill(src, store_dir=store_dir)


def _build_tool(tmp_path: Path, cache_root: Path, content: str = TOOL_SKILL) -> str:
    src = _write_skill_dir(tmp_path / "tool-src", "greeter", content)
    installed = build_and_install_skill_plugin(src / "SKILL.md", cache_root=cache_root)
    return installed.plugin_id


# --------------------------------------------------------------------------- #
# classify_skill
# --------------------------------------------------------------------------- #


def test_classify_prose_by_slug(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _import_prose(tmp_path, store_dir)
    resolved = classify_skill(
        "changelog-summarizer", store_dir=store_dir, cache_root=cache_root
    )
    assert resolved is not None
    assert resolved.skill_class is SkillClass.PROSE
    assert resolved.slug == "changelog-summarizer"
    assert resolved.plugin_id is None


def test_classify_tool_by_bare_slug_fallback(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _build_tool(tmp_path, cache_root)
    # No prose 'greeter' exists, so the bare slug falls back to the built tool-skill.
    resolved = classify_skill("greeter", store_dir=store_dir, cache_root=cache_root)
    assert resolved is not None
    assert resolved.skill_class is SkillClass.TOOL
    assert resolved.plugin_id == "skill.greeter"
    assert resolved.version


def test_classify_tool_by_explicit_plugin_id(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _build_tool(tmp_path, cache_root)
    resolved = classify_skill("skill.greeter", store_dir=store_dir, cache_root=cache_root)
    assert resolved is not None
    assert resolved.skill_class is SkillClass.TOOL
    assert resolved.plugin_id == "skill.greeter"


def test_classify_unknown_returns_none(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    assert classify_skill("does-not-exist", store_dir=store_dir, cache_root=cache_root) is None
    # A dotted unknown id is also unknown (resolved as a plugin id, not found).
    assert classify_skill("skill.nope", store_dir=store_dir, cache_root=cache_root) is None


def test_classify_prose_preferred_over_tool_for_bare_slug(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    # Pathological dual-existence: a prose skill and a tool-skill share a slug.
    # The bare slug must resolve to PROSE (runs on every backend) deterministically.
    same = PROSE_SKILL.replace("changelog-summarizer", "greeter")
    src = _write_skill_dir(tmp_path / "src", "prose", same)
    import_skill(src, store_dir=store_dir)
    _build_tool(tmp_path, cache_root)
    resolved = classify_skill("greeter", store_dir=store_dir, cache_root=cache_root)
    assert resolved is not None
    assert resolved.skill_class is SkillClass.PROSE
    # The explicit plugin id still reaches the tool-skill.
    explicit = classify_skill("skill.greeter", store_dir=store_dir, cache_root=cache_root)
    assert explicit is not None and explicit.skill_class is SkillClass.TOOL


# --------------------------------------------------------------------------- #
# plan_skill_run
# --------------------------------------------------------------------------- #


def test_plan_prose_available_on_non_mcp_backend(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    assert [s.slug for s in plan.prose] == ["changelog-summarizer"]
    assert plan.tool == ()
    assert not plan.has_unavailable


def test_plan_tool_available_on_mcp_backend(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _build_tool(tmp_path, cache_root)
    plan = plan_skill_run(
        ("greeter",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    assert [s.plugin_id for s in plan.tool] == ["skill.greeter"]
    assert plan.prose == ()
    assert not plan.has_unavailable


def test_plan_tool_fail_closed_on_non_mcp_backend(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _build_tool(tmp_path, cache_root)
    plan = plan_skill_run(
        ("greeter",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    assert plan.tool == ()
    assert plan.prose == ()
    assert plan.has_unavailable
    assert plan.unavailable[0].reason is UnavailableReason.TOOL_REQUIRES_MCP


def test_plan_unknown_is_unavailable(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    plan = plan_skill_run(
        ("ghost",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    assert plan.has_unavailable
    assert plan.unavailable[0].reason is UnavailableReason.UNKNOWN


def test_plan_dedups_by_slug(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer", "changelog-summarizer"),
        capability=RELAY,
        store_dir=store_dir,
        cache_root=cache_root,
    )
    assert len(plan.prose) == 1


def test_plan_mixed_prose_tool_and_unknown(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _import_prose(tmp_path, store_dir)
    _build_tool(tmp_path, cache_root)
    plan = plan_skill_run(
        ("changelog-summarizer", "skill.greeter", "ghost"),
        capability=MCP,
        store_dir=store_dir,
        cache_root=cache_root,
    )
    assert [s.slug for s in plan.prose] == ["changelog-summarizer"]
    assert [s.plugin_id for s in plan.tool] == ["skill.greeter"]
    assert [u.reason for u in plan.unavailable] == [UnavailableReason.UNKNOWN]
    assert plan.to_dict()["requested"] == ["changelog-summarizer", "skill.greeter", "ghost"]


# --------------------------------------------------------------------------- #
# project_prose_skills
# --------------------------------------------------------------------------- #


def test_project_prose_writes_skill_md(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    target = tmp_path / "run" / "skills"
    written = project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    dest = target / "changelog-summarizer" / "SKILL.md"
    assert dest.exists()
    assert "Changelog Summarizer" in dest.read_text(encoding="utf-8")
    assert any(isinstance(w, ProjectedSkillFile) and Path(w.destination) == dest for w in written)


def test_project_prose_copies_assets(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    src = _write_skill_dir(tmp_path / "src", "prose", PROSE_SKILL)
    (src / "assets").mkdir()
    (src / "assets" / "ref.md").write_text("# reference\n", encoding="utf-8")
    import_skill(src, store_dir=store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    target = tmp_path / "run" / "skills"
    project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    assert (target / "changelog-summarizer" / "assets" / "ref.md").exists()


def test_project_tool_only_plan_writes_nothing(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _build_tool(tmp_path, cache_root)
    plan = plan_skill_run(
        ("greeter",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    target = tmp_path / "run" / "skills"
    written = project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    assert written == []


def test_project_raises_if_planned_prose_vanished(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    # Skill removed from the store between planning and projection → fail-closed.
    import shutil

    shutil.rmtree(store_dir / "changelog-summarizer")
    with pytest.raises(SkillRuntimeError):
        project_prose_skills(plan, target_skills_dir=tmp_path / "run" / "skills", store_dir=store_dir)


def test_project_refuses_plan_with_unavailable_by_default(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    # fail-closed is ENFORCED: a plan with any unavailable skill is refused so a
    # surface cannot silently run a degraded subset by ignoring plan.unavailable.
    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer", "ghost"), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    assert plan.has_unavailable
    target = tmp_path / "run" / "skills"
    with pytest.raises(SkillRuntimeError):
        project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    # Nothing was published.
    assert not (target / "changelog-summarizer").exists()
    # Explicit opt-in projects the available prose subset.
    written = project_prose_skills(
        plan, target_skills_dir=target, store_dir=store_dir, allow_unavailable=True
    )
    assert (target / "changelog-summarizer" / "SKILL.md").exists()
    assert written


def test_project_clears_stale_files_on_reproject(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    # An asset present in the first projection must not linger after the skill is
    # re-imported without it (atomic replace of the whole <slug> dir).
    src = _write_skill_dir(tmp_path / "src", "prose", PROSE_SKILL)
    (src / "assets").mkdir()
    (src / "assets" / "old.md").write_text("# old\n", encoding="utf-8")
    import_skill(src, store_dir=store_dir)
    target = tmp_path / "run" / "skills"
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    assert (target / "changelog-summarizer" / "assets" / "old.md").exists()

    # Re-import the same slug WITHOUT the old asset, then re-project.
    src2 = _write_skill_dir(tmp_path / "src2", "prose", PROSE_SKILL)
    import_skill(src2, store_dir=store_dir, force=True)
    plan2 = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    project_prose_skills(plan2, target_skills_dir=target, store_dir=store_dir)
    assert (target / "changelog-summarizer" / "SKILL.md").exists()
    assert not (target / "changelog-summarizer" / "assets" / "old.md").exists()


def test_project_refuses_destination_symlink(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    _import_prose(tmp_path, store_dir)
    target = tmp_path / "run" / "skills"
    target.mkdir(parents=True)
    # An attacker-planted symlink where the slug dir would go must be refused, not
    # followed (which could let a write escape the run-scoped dir).
    outside = tmp_path / "outside"
    outside.mkdir()
    (target / "changelog-summarizer").symlink_to(outside, target_is_directory=True)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    with pytest.raises(SkillRuntimeError):
        project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)


def test_dual_request_slug_and_plugin_id_on_mcp_backend(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    # Codex-pinned semantic: requesting both the bare slug (prose) and the
    # explicit plugin id (tool) for a shared slug yields BOTH on an MCP backend —
    # the prose instructions AND the governed tool. Each is the user's explicit ask.
    same = PROSE_SKILL.replace("changelog-summarizer", "greeter")
    src = _write_skill_dir(tmp_path / "src", "prose", same)
    import_skill(src, store_dir=store_dir)
    _build_tool(tmp_path, cache_root)
    plan = plan_skill_run(
        ("greeter", "skill.greeter"), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    assert [s.slug for s in plan.prose] == ["greeter"]
    assert [s.plugin_id for s in plan.tool] == ["skill.greeter"]
    assert not plan.has_unavailable


def test_project_refuses_symlinked_target_dir(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    # The run-scoped target dir itself being a symlink would let writes escape it.
    _import_prose(tmp_path, store_dir)
    real = tmp_path / "elsewhere"
    real.mkdir()
    target = tmp_path / "run" / "skills"
    target.parent.mkdir(parents=True)
    target.symlink_to(real, target_is_directory=True)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    with pytest.raises(SkillRuntimeError):
        project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    assert not (real / "changelog-summarizer").exists()


def test_project_whole_plan_atomic_no_partial_on_failure(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    # Two prose skills planned; the second is removed from the store after
    # planning. Projection must publish NEITHER (no partial run dir).
    src_a = _write_skill_dir(tmp_path / "a", "prose", PROSE_SKILL)
    import_skill(src_a, store_dir=store_dir)
    second = PROSE_SKILL.replace("changelog-summarizer", "second-skill")
    src_b = _write_skill_dir(tmp_path / "b", "prose", second)
    import_skill(src_b, store_dir=store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer", "second-skill"),
        capability=RELAY,
        store_dir=store_dir,
        cache_root=cache_root,
    )
    import shutil

    shutil.rmtree(store_dir / "second-skill")
    target = tmp_path / "run" / "skills"
    with pytest.raises(SkillRuntimeError):
        project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    # Neither skill published, and no staging residue.
    assert not (target / "changelog-summarizer").exists()
    assert not (target / "second-skill").exists()
    leftovers = list(target.glob(".staging-*")) if target.exists() else []
    assert leftovers == []


def test_plan_prose_unavailable_when_backend_cannot_project(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    # A backend that supports neither prose projection nor MCP: prose skills must
    # land in unavailable (the capability axis is honest, not decorative).
    _import_prose(tmp_path, store_dir)
    nothing = BackendSkillCapability(supports_prose_projection=False, supports_mcp_tools=False)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=nothing, store_dir=store_dir, cache_root=cache_root
    )
    assert plan.prose == ()
    assert plan.has_unavailable
    assert plan.unavailable[0].reason is UnavailableReason.PROSE_UNSUPPORTED


def test_project_pins_plan_time_version(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    # If the same slug is re-imported with different content between planning and
    # projection, the plan-time digest no longer matches → fail-closed.
    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    changed = PROSE_SKILL.replace("Group changes by intent", "Totally different body")
    src2 = _write_skill_dir(tmp_path / "src2", "prose", changed)
    import_skill(src2, store_dir=store_dir, force=True)
    with pytest.raises(SkillRuntimeError):
        project_prose_skills(plan, target_skills_dir=tmp_path / "run" / "skills", store_dir=store_dir)


# --------------------------------------------------------------------------- #
# prepare_run_skills (sealed backend entry)
# --------------------------------------------------------------------------- #


def test_prepare_run_skills_projects_prose_and_returns_plan(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    _import_prose(tmp_path, store_dir)
    skills_dir = tmp_path / "run" / "skills"
    plan = prepare_run_skills(
        ("changelog-summarizer",),
        capability=RELAY,
        skills_dir=skills_dir,
        store_dir=store_dir,
        cache_root=cache_root,
    )
    assert [s.slug for s in plan.prose] == ["changelog-summarizer"]
    assert (skills_dir / "changelog-summarizer" / "SKILL.md").exists()


def test_prepare_run_skills_fail_closed_on_tool_for_relay_backend(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    _build_tool(tmp_path, cache_root)
    skills_dir = tmp_path / "run" / "skills"
    with pytest.raises(SkillRuntimeError):
        prepare_run_skills(
            ("greeter",),
            capability=RELAY,
            skills_dir=skills_dir,
            store_dir=store_dir,
            cache_root=cache_root,
        )
    # Nothing was projected.
    assert not skills_dir.exists() or not any(skills_dir.iterdir())


def test_resolve_overlay_inlines_prose_body(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    from superclaw.skill_runtime import resolve_skill_overlay_for_prompt

    _import_prose(tmp_path, store_dir)
    overlay = resolve_skill_overlay_for_prompt(
        ("changelog-summarizer",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    assert [p[0] for p in overlay.prose] == ["changelog-summarizer"]
    # The body (frontmatter stripped) is carried inline for prompt injection.
    assert "Group changes by intent" in overlay.prose[0][2]
    assert overlay.tool == ()
    assert overlay.unavailable == ()


def test_resolve_overlay_tool_for_mcp_unavailable_for_relay(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    from superclaw.skill_runtime import resolve_skill_overlay_for_prompt

    _build_tool(tmp_path, cache_root)
    mcp = resolve_skill_overlay_for_prompt(
        ("greeter",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    assert [t[1] for t in mcp.tool] == ["skill.greeter"]
    assert mcp.prose == ()
    relay = resolve_skill_overlay_for_prompt(
        ("greeter",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    assert relay.tool == () and relay.prose == ()
    assert relay.unavailable and relay.unavailable[0].reason is UnavailableReason.TOOL_REQUIRES_MCP


def test_resolve_overlay_unknown_is_unavailable(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    from superclaw.skill_runtime import resolve_skill_overlay_for_prompt

    overlay = resolve_skill_overlay_for_prompt(
        ("ghost",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    assert overlay.prose == () and overlay.tool == ()
    assert overlay.unavailable and overlay.unavailable[0].reason is UnavailableReason.UNKNOWN


def test_resolve_overlay_too_large_prose_is_unavailable(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    from superclaw.skill_runtime import MAX_INLINE_PROSE_BODY, resolve_skill_overlay_for_prompt

    big_body = "x " * (MAX_INLINE_PROSE_BODY // 2 + 100)
    src = _write_skill_dir(tmp_path / "big", "prose", PROSE_SKILL.split("# ")[0] + "# Big\n\n" + big_body)
    import_skill(src, store_dir=store_dir)
    overlay = resolve_skill_overlay_for_prompt(
        ("changelog-summarizer",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    # Not inlined (would swallow context); reported unavailable, fail-closed.
    assert overlay.prose == ()
    assert overlay.unavailable and overlay.unavailable[0].reason is UnavailableReason.PROSE_TOO_LARGE


def test_resolve_overlay_unreadable_prose_is_unavailable(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    import shutil

    from superclaw.skill_runtime import plan_skill_run, resolve_skill_overlay_for_prompt

    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(("changelog-summarizer",), capability=MCP, store_dir=store_dir, cache_root=cache_root)
    assert plan.prose  # planned cleanly
    # Now make the body unreadable (skill dir removed) between plan and resolve.
    shutil.rmtree(store_dir / "changelog-summarizer")
    overlay = resolve_skill_overlay_for_prompt(
        ("changelog-summarizer",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    assert overlay.prose == ()
    # Dropped from the store between plan and read → unknown or unreadable, but
    # NEVER silently absent.
    assert overlay.unavailable
    assert overlay.unavailable[0].reason in {
        UnavailableReason.PROSE_UNREADABLE,
        UnavailableReason.UNKNOWN,
    }


def test_prepare_run_skills_returns_tool_for_mcp_backend(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    _build_tool(tmp_path, cache_root)
    plan = prepare_run_skills(
        ("greeter",),
        capability=MCP,
        skills_dir=tmp_path / "run" / "skills",
        store_dir=store_dir,
        cache_root=cache_root,
    )
    assert [s.plugin_id for s in plan.tool] == ["skill.greeter"]


# --------------------------------------------------------------------------- #
# Same-name disambiguation: managed marker, foreign-overwrite guard, inspect
# --------------------------------------------------------------------------- #


def test_project_writes_managed_sidecar(tmp_path: Path, store_dir: Path, cache_root: Path) -> None:
    """A projected prose skill carries a SuperClaw marker so it is distinguishable
    from a same-named skill the runtime/user already had."""
    import json

    from superclaw.skill_runtime import MANAGED_SIDECAR_NAME

    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    target = tmp_path / "run" / "skills"
    project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    marker = target / "changelog-summarizer" / MANAGED_SIDECAR_NAME
    assert marker.is_file()
    data = json.loads(marker.read_text(encoding="utf-8"))
    assert data["managed_by"] == "superclaw"
    assert data["slug"] == "changelog-summarizer"
    assert data["kind"] == "native-prose-skill"
    assert data["store_digest"].startswith("sha256:")
    # The marker is bookkeeping, not part of the discovered skill payload.
    assert (target / "changelog-summarizer" / "SKILL.md").is_file()


def test_project_marker_excluded_from_written_report(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    from superclaw.skill_runtime import MANAGED_SIDECAR_NAME

    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    target = tmp_path / "run" / "skills"
    written = project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    assert not any(Path(w.destination).name == MANAGED_SIDECAR_NAME for w in written)


def test_project_refuses_to_overwrite_foreign_same_name(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    """The owner's '同名永不覆盖': a pre-existing non-SuperClaw skill of the same
    name is never clobbered — projection fails closed instead."""
    _import_prose(tmp_path, store_dir)
    target = tmp_path / "run" / "skills"
    # A foreign same-name skill already in the runtime dir (no SuperClaw marker).
    foreign = target / "changelog-summarizer"
    foreign.mkdir(parents=True)
    (foreign / "SKILL.md").write_text("# Not ours\nUser's own skill.\n", encoding="utf-8")
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    with pytest.raises(SkillRuntimeError, match="non-SuperClaw skill of the same name"):
        project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    # The foreign skill is left untouched.
    assert (foreign / "SKILL.md").read_text(encoding="utf-8") == "# Not ours\nUser's own skill.\n"


def test_project_replaces_our_own_prior_projection(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    """Re-projecting over our OWN earlier projection (carries the marker) is fine."""
    _import_prose(tmp_path, store_dir)
    target = tmp_path / "run" / "skills"
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    # Second projection must NOT raise (our marker is present from the first).
    project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    assert (target / "changelog-summarizer" / "SKILL.md").is_file()


def test_inspect_projected_skill_states(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    from superclaw.skill_runtime import inspect_projected_skill

    _import_prose(tmp_path, store_dir)
    target = tmp_path / "run" / "skills"
    # Absent.
    st = inspect_projected_skill(target, "changelog-summarizer")
    assert not st.present and not st.managed and not st.foreign
    # Ours after projection.
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    st = inspect_projected_skill(target, "changelog-summarizer")
    assert st.present and st.managed and not st.foreign
    assert st.store_digest and st.store_digest.startswith("sha256:")
    # Foreign same-name elsewhere.
    other = tmp_path / "other" / "skills" / "changelog-summarizer"
    other.mkdir(parents=True)
    (other / "SKILL.md").write_text("# foreign\n", encoding="utf-8")
    st = inspect_projected_skill(tmp_path / "other" / "skills", "changelog-summarizer")
    assert st.present and not st.managed and st.foreign


def test_marker_invalid_json_treated_as_foreign(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    """A coincidental/garbage marker that fails validation is treated as foreign
    (fail-closed: we refuse to overwrite)."""
    from superclaw.skill_runtime import MANAGED_SIDECAR_NAME, inspect_projected_skill

    target = tmp_path / "run" / "skills"
    d = target / "changelog-summarizer"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("# x\n", encoding="utf-8")
    (d / MANAGED_SIDECAR_NAME).write_text("not json", encoding="utf-8")
    st = inspect_projected_skill(target, "changelog-summarizer")
    assert st.present and not st.managed and st.foreign


def test_sidecar_write_failure_rolls_back_publish(
    tmp_path: Path, store_dir: Path, cache_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the marker write fails after os.replace, the published dir is rolled back —
    never left marker-less (which the foreign guard would later lock out)."""
    import superclaw.skill_runtime as sr

    _import_prose(tmp_path, store_dir)
    target = tmp_path / "run" / "skills"
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )

    def _boom(dest_root: Path, skill: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(sr, "_write_managed_sidecar", _boom)
    with pytest.raises(OSError, match="disk full"):
        project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)
    # The replaced dir must NOT linger (would be marker-less → permanently foreign).
    assert not (target / "changelog-summarizer").exists()


def test_marker_wrong_slug_treated_as_foreign(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    """A valid-looking marker whose slug names a DIFFERENT skill cannot vouch for
    this directory — it is foreign and must not be overwritten."""
    import json

    from superclaw.skill_runtime import (
        MANAGED_SIDECAR_NAME,
        MANAGED_SIDECAR_SCHEMA,
        inspect_projected_skill,
    )

    target = tmp_path / "run" / "skills"
    d = target / "changelog-summarizer"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("# foreign with copied marker\n", encoding="utf-8")
    (d / MANAGED_SIDECAR_NAME).write_text(
        json.dumps(
            {
                "schema_version": MANAGED_SIDECAR_SCHEMA,
                "managed_by": "superclaw",
                "kind": "native-prose-skill",
                "slug": "some-other-skill",  # marker copied from a different skill
                "name": "x",
                "store_digest": "sha256:" + "0" * 64,
            }
        ),
        encoding="utf-8",
    )
    st = inspect_projected_skill(target, "changelog-summarizer")
    assert st.present and not st.managed and st.foreign
    # And projection refuses to overwrite it.
    _import_prose(tmp_path, store_dir)
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    with pytest.raises(SkillRuntimeError, match="non-SuperClaw skill of the same name"):
        project_prose_skills(plan, target_skills_dir=target, store_dir=store_dir)


def test_inspect_symlinked_dir_not_managed(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    """A symlinked <slug> dir is never reported managed (read side matches the
    write side, which refuses symlinked destinations)."""
    from superclaw.skill_runtime import inspect_projected_skill

    _import_prose(tmp_path, store_dir)
    # Build a real managed projection in a 'real' dir, then point a symlink at it.
    real = tmp_path / "real" / "skills"
    plan = plan_skill_run(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    project_prose_skills(plan, target_skills_dir=real, store_dir=store_dir)
    link_parent = tmp_path / "linked" / "skills"
    link_parent.mkdir(parents=True)
    (link_parent / "changelog-summarizer").symlink_to(real / "changelog-summarizer")
    st = inspect_projected_skill(link_parent, "changelog-summarizer")
    assert not st.managed  # symlinked dir is not trusted as ours


# --------------------------------------------------------------------------- #
# prepare_inline_skill_overlay (fail-closed inline choke)
# --------------------------------------------------------------------------- #


def test_prepare_inline_overlay_returns_prose(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    from superclaw.skill_runtime import prepare_inline_skill_overlay

    _import_prose(tmp_path, store_dir)
    overlay = prepare_inline_skill_overlay(
        ("changelog-summarizer",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
    )
    assert [p[0] for p in overlay.prose] == ["changelog-summarizer"]
    assert overlay.unavailable == ()


def test_prepare_inline_overlay_fail_closed_on_unknown(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    from superclaw.skill_runtime import prepare_inline_skill_overlay

    with pytest.raises(SkillRuntimeError, match="unavailable skill"):
        prepare_inline_skill_overlay(
            ("ghost",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
        )


def test_prepare_inline_overlay_fail_closed_on_tool_for_non_mcp(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    """A tool-skill on a prose-only (relay) backend must refuse the whole run, never
    silently downgrade to a prose note."""
    from superclaw.skill_runtime import prepare_inline_skill_overlay

    _build_tool(tmp_path, cache_root)
    with pytest.raises(SkillRuntimeError, match="unavailable skill"):
        prepare_inline_skill_overlay(
            ("skill.greeter",), capability=RELAY, store_dir=store_dir, cache_root=cache_root
        )


def test_prepare_inline_overlay_tool_ok_on_mcp_backend(
    tmp_path: Path, store_dir: Path, cache_root: Path
) -> None:
    from superclaw.skill_runtime import prepare_inline_skill_overlay

    _build_tool(tmp_path, cache_root)
    overlay = prepare_inline_skill_overlay(
        ("skill.greeter",), capability=MCP, store_dir=store_dir, cache_root=cache_root
    )
    assert [t[1] for t in overlay.tool] == ["skill.greeter"]
    assert overlay.unavailable == ()


# --------------------------------------------------------------------------- #
# build_available_skill_catalog (semantic discovery, fail-closed, bounded)
# --------------------------------------------------------------------------- #


def test_catalog_empty_when_no_skills(tmp_path: Path, store_dir: Path) -> None:
    from superclaw.skill_runtime import build_available_skill_catalog

    cat = build_available_skill_catalog(store_dir=store_dir)
    assert cat.text == "" and cat.loaded == () and cat.index_only == ()


def test_catalog_lists_and_loads_body(tmp_path: Path, store_dir: Path) -> None:
    from superclaw.skill_runtime import build_available_skill_catalog

    _import_prose(tmp_path, store_dir)
    cat = build_available_skill_catalog(store_dir=store_dir)
    assert "changelog-summarizer" in cat.loaded
    assert cat.index_only == ()
    assert "changelog-summarizer" in cat.text
    assert "Group changes by intent" in cat.text  # body inlined
    assert "UNTRUSTED catalog DATA" in cat.text


def test_catalog_only_lists_real_registered_skills(tmp_path: Path, store_dir: Path) -> None:
    """A hallucinated slug can never appear — the catalog is built from the
    fail-closed store read, not from any model input."""
    from superclaw.skill_runtime import build_available_skill_catalog

    _import_prose(tmp_path, store_dir)
    cat = build_available_skill_catalog(store_dir=store_dir)
    assert "ghost" not in cat.text
    assert set(cat.loaded) | set(cat.index_only) == {"changelog-summarizer"}


def test_catalog_index_only_when_body_over_budget(tmp_path: Path, store_dir: Path) -> None:
    """A body that does not fit the budget is listed name+desc only and explicitly
    marked not-loaded (no fake-success)."""
    from superclaw.skill_runtime import build_available_skill_catalog

    big_body = "x " * 200
    content = (
        "---\nname: big-skill\ndescription: A big one.\n---\n\n# Big\n\n" + big_body + "\n"
    )
    src = _write_skill_dir(tmp_path / "src", "big", content)
    import_skill(src, store_dir=store_dir)
    cat = build_available_skill_catalog(store_dir=store_dir, total_body_budget=10)
    assert "big-skill" in cat.index_only
    assert "big-skill" not in cat.loaded
    assert "body budget exhausted" in cat.text
    assert not cat.truncated


def test_catalog_total_text_cap_truncates(tmp_path: Path, store_dir: Path) -> None:
    """A large store cannot blow up the prompt: past the total-text cap the rest are
    omitted (truncated) and only reachable via explicit @skill."""
    from superclaw.skill_runtime import build_available_skill_catalog

    for i in range(8):
        content = (
            f"---\nname: skill-{i:02d}\ndescription: Number {i} with a longish description "
            "to consume catalog text budget quickly.\n---\n\n# S\n\nBody here.\n"
        )
        import_skill(_write_skill_dir(tmp_path / f"src{i}", f"s{i}", content), store_dir=store_dir)
    cat = build_available_skill_catalog(store_dir=store_dir, total_text_budget=400)
    assert cat.truncated
    assert "omitted to bound context" in cat.text
    assert "skill-00" in cat.text  # deterministic: earliest slugs kept


def test_catalog_respects_total_text_budget(tmp_path: Path, store_dir: Path) -> None:
    """With a budget above header+one entry, the WHOLE rendered catalog (incl. the
    omitted footer) stays within total_text_budget — a real hard cap."""
    from superclaw.skill_runtime import build_available_skill_catalog

    for i in range(12):
        content = (
            f"---\nname: skill-{i:02d}\ndescription: Number {i} description text.\n---\n\n"
            "# S\n\nSome body content here for the skill.\n"
        )
        import_skill(_write_skill_dir(tmp_path / f"src{i}", f"s{i}", content), store_dir=store_dir)
    budget = 1500
    cat = build_available_skill_catalog(store_dir=store_dir, total_text_budget=budget)
    assert cat.truncated
    assert len(cat.text) <= budget


def test_catalog_sanitizes_description(tmp_path: Path, store_dir: Path) -> None:
    """Control chars / structure in a description are stripped (rendered as data),
    so a skill cannot inject prompt structure via its description."""
    from superclaw.skill_runtime import build_available_skill_catalog

    content = (
        "---\nname: tricky\ndescription: \"line1\\tINJECT\"\n---\n\n# T\n\nBody.\n"
    )
    src = _write_skill_dir(tmp_path / "src", "tricky", content)
    import_skill(src, store_dir=store_dir)
    cat = build_available_skill_catalog(store_dir=store_dir)
    assert "\t" not in cat.text  # tab stripped to space
