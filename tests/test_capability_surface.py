"""Tests for the capability-surface fingerprint and graded resume guard."""

from __future__ import annotations

from superclaw.capability_surface import (
    CapabilitySurface,
    SurfaceDiffAction,
    classify_surface_diff,
    compute_capability_surface,
    render_capability_change_notice,
    resolve_resume_action,
)
from superclaw.state import StateStore


def _surface(**overrides) -> CapabilitySurface:
    base = dict(
        skill_digests={"~/.claude/skills/foo": "d_foo"},
        plugin_tool_digests={"superclaw__bar": "t_bar"},
        permission_mode="ask",
        backend="codex",
        model="gpt-x",
        revocation_epoch="rev0",
    )
    base.update(overrides)
    return compute_capability_surface(**base)


# --------------------------------------------------------------------------- #
# Fingerprint stability                                                         #
# --------------------------------------------------------------------------- #


def test_combined_is_stable_for_same_inputs():
    assert _surface().combined == _surface().combined


def test_combined_is_order_independent():
    a = compute_capability_surface(
        skill_digests={"a": "1", "b": "2"}, plugin_tool_digests={"x": "9", "y": "8"}
    )
    b = compute_capability_surface(
        skill_digests={"b": "2", "a": "1"}, plugin_tool_digests={"y": "8", "x": "9"}
    )
    assert a.combined == b.combined


def test_combined_changes_when_any_component_changes():
    base = _surface().combined
    assert _surface(permission_mode="allow").combined != base
    assert _surface(backend="claude").combined != base
    assert _surface(model="other").combined != base
    assert _surface(revocation_epoch="rev1").combined != base
    assert _surface(skill_digests={"~/.claude/skills/foo": "CHANGED"}).combined != base
    assert _surface(plugin_tool_digests={"superclaw__bar": "CHANGED"}).combined != base


def test_roundtrip_to_dict_from_dict():
    s = _surface()
    assert CapabilitySurface.from_dict(s.to_dict()).combined == s.combined


def test_no_diff_when_unchanged():
    assert classify_surface_diff(_surface(), _surface()) == []
    assert resolve_resume_action([]) is SurfaceDiffAction.SILENT_NOTE


# --------------------------------------------------------------------------- #
# Grading matrix                                                                #
# --------------------------------------------------------------------------- #


def test_ask_allow_switch_is_not_a_privilege_change():
    # Max-permission doctrine: ask and allow both run at max (equal authority),
    # so switching either direction is NOT a widening — no permission_mode diff
    # is emitted and the native session is preserved (no hard-block, no reset).
    for old_mode, new_mode in (("ask", "allow"), ("allow", "ask")):
        diffs = classify_surface_diff(_surface(permission_mode=old_mode), _surface(permission_mode=new_mode))
        assert not any(d.kind == "permission_mode" for d in diffs), (old_mode, new_mode)
        assert resolve_resume_action(diffs) is not SurfaceDiffAction.HARD_BLOCK, (old_mode, new_mode)


def test_plugin_tool_removed_injects_notice():
    old = _surface(plugin_tool_digests={"superclaw__bar": "t_bar"})
    new = _surface(plugin_tool_digests={})
    diffs = classify_surface_diff(old, new)
    assert resolve_resume_action(diffs) is SurfaceDiffAction.INJECT_NOTICE
    assert any(d.kind == "plugin_tool" and d.action is SurfaceDiffAction.INJECT_NOTICE for d in diffs)


def test_plugin_tool_added_is_silent():
    old = _surface(plugin_tool_digests={})
    new = _surface(plugin_tool_digests={"superclaw__bar": "t_bar"})
    diffs = classify_surface_diff(old, new)
    assert resolve_resume_action(diffs) is SurfaceDiffAction.SILENT_NOTE


def test_plugin_tool_schema_change_confirms():
    old = _surface(plugin_tool_digests={"superclaw__bar": "t_bar"})
    new = _surface(plugin_tool_digests={"superclaw__bar": "t_bar_v2"})
    diffs = classify_surface_diff(old, new)
    assert resolve_resume_action(diffs) is SurfaceDiffAction.CONFIRM


def test_skill_removed_injects_notice():
    old = _surface(skill_digests={"foo": "d"})
    new = _surface(skill_digests={})
    diffs = classify_surface_diff(old, new)
    assert any(d.kind == "skill" and d.action is SurfaceDiffAction.INJECT_NOTICE for d in diffs)


def test_skill_content_change_confirms():
    old = _surface(skill_digests={"foo": "d1"})
    new = _surface(skill_digests={"foo": "d2"})
    diffs = classify_surface_diff(old, new)
    assert resolve_resume_action(diffs) is SurfaceDiffAction.CONFIRM


def test_backend_change_confirms():
    diffs = classify_surface_diff(_surface(backend="codex"), _surface(backend="claude"))
    assert resolve_resume_action(diffs) is SurfaceDiffAction.CONFIRM


def test_model_change_is_silent():
    diffs = classify_surface_diff(_surface(model="a"), _surface(model="b"))
    assert resolve_resume_action(diffs) is SurfaceDiffAction.SILENT_NOTE


def test_revocation_epoch_change_falls_back_to_silent_note():
    # Epoch moved but no tool/skill diff explains it → still surfaced, not silent.
    diffs = classify_surface_diff(_surface(revocation_epoch="rev0"), _surface(revocation_epoch="rev1"))
    assert resolve_resume_action(diffs) is SurfaceDiffAction.SILENT_NOTE
    assert any(d.kind == "revocation" for d in diffs)


def test_revocation_epoch_does_not_double_report_when_tool_removed():
    old = _surface(plugin_tool_digests={"superclaw__bar": "t"}, revocation_epoch="rev0")
    new = _surface(plugin_tool_digests={}, revocation_epoch="rev1")
    diffs = classify_surface_diff(old, new)
    # The removed tool already explains the epoch move; no extra revocation note.
    assert not any(d.kind == "revocation" for d in diffs)
    assert resolve_resume_action(diffs) is SurfaceDiffAction.INJECT_NOTICE


# --------------------------------------------------------------------------- #
# strict-resume promotion                                                       #
# --------------------------------------------------------------------------- #


def test_strict_promotes_revocation_to_hard_block():
    old = _surface(plugin_tool_digests={"superclaw__bar": "t"})
    new = _surface(plugin_tool_digests={})
    diffs = classify_surface_diff(old, new)
    assert resolve_resume_action(diffs, strict=False) is SurfaceDiffAction.INJECT_NOTICE
    assert resolve_resume_action(diffs, strict=True) is SurfaceDiffAction.HARD_BLOCK


def test_strict_does_not_invent_block_when_only_additions():
    old = _surface(plugin_tool_digests={})
    new = _surface(plugin_tool_digests={"superclaw__new": "t"})
    diffs = classify_surface_diff(old, new)
    assert resolve_resume_action(diffs, strict=True) is SurfaceDiffAction.SILENT_NOTE


# --------------------------------------------------------------------------- #
# Notice rendering                                                              #
# --------------------------------------------------------------------------- #


def test_notice_frames_revocation_imperatively():
    old = _surface(plugin_tool_digests={"superclaw__bar": "t"}, skill_digests={})
    new = _surface(plugin_tool_digests={}, skill_digests={})
    notice = render_capability_change_notice(classify_surface_diff(old, new))
    assert "Do NOT" in notice
    assert "superclaw__bar" in notice


def test_notice_empty_when_no_diffs():
    assert render_capability_change_notice([]) == ""


# --------------------------------------------------------------------------- #
# State persistence (metadata-backed, idempotent)                              #
# --------------------------------------------------------------------------- #


def test_state_surface_roundtrip_and_idempotent(tmp_path):
    store = StateStore(tmp_path / "state.db")
    session = store.create_chat_session("t")
    assert store.get_chat_capability_surface(session.session_id) is None

    surface = _surface().to_dict()
    store.set_chat_capability_surface(session.session_id, surface)
    loaded = store.get_chat_capability_surface(session.session_id)
    assert loaded is not None
    assert loaded["combined"] == surface["combined"]

    # Idempotent: re-setting the same surface does not bump updated_at.
    before = store.get_chat_session(session.session_id).updated_at
    store.set_chat_capability_surface(session.session_id, surface)
    after = store.get_chat_session(session.session_id).updated_at
    assert before == after

    # A changed surface is persisted.
    changed = _surface(permission_mode="allow").to_dict()
    store.set_chat_capability_surface(session.session_id, changed)
    assert store.get_chat_capability_surface(session.session_id)["combined"] == changed["combined"]


# --------------------------------------------------------------------------- #
# collect_revocation_epoch (B): a native-skill revocation must register as a
# surface change even though it lives in its own list, separate from plugins.
# A revoked native skill's already-projected SKILL.md lingers in the runtime dir
# until the next sync — the resume guard can only flag it if the epoch folds in
# the native-skill revocation list.
# --------------------------------------------------------------------------- #


def test_revocation_epoch_folds_in_native_skill_list(tmp_path):
    from superclaw.capability_surface import collect_revocation_epoch

    plugin_rev = tmp_path / "plugins" / "revocations.json"
    skill_rev = tmp_path / "skills" / "revocations.json"
    plugin_rev.parent.mkdir(parents=True)
    skill_rev.parent.mkdir(parents=True)

    # Neither list present → "none".
    assert collect_revocation_epoch(plugin_rev, skill_rev) == "none"

    # A native-skill revocation alone must change the epoch off "none".
    skill_rev.write_text('{"revoked": [{"plugin_id": "smoke"}]}', encoding="utf-8")
    epoch_skill = collect_revocation_epoch(plugin_rev, skill_rev)
    assert epoch_skill not in ("none", "")

    # Mutating the native-skill list must change the epoch again (the guard sees it).
    skill_rev.write_text('{"revoked": [{"plugin_id": "smoke"}, {"plugin_id": "other"}]}', encoding="utf-8")
    assert collect_revocation_epoch(plugin_rev, skill_rev) != epoch_skill


def test_revocation_epoch_domain_separates_the_two_lists(tmp_path):
    """An identical entry in the plugin list vs the skill list must not collide."""
    from superclaw.capability_surface import collect_revocation_epoch

    a_plugin = tmp_path / "a_plugin.json"
    a_skill = tmp_path / "a_skill.json"
    b_plugin = tmp_path / "b_plugin.json"
    b_skill = tmp_path / "b_skill.json"
    payload = '{"revoked": [{"plugin_id": "x"}]}'
    # Case A: entry sits in the plugin list. Case B: same entry in the skill list.
    a_plugin.write_text(payload, encoding="utf-8")
    b_skill.write_text(payload, encoding="utf-8")

    assert collect_revocation_epoch(a_plugin, a_skill) != collect_revocation_epoch(b_plugin, b_skill)
