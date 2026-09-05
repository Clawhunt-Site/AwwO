"""Layer 3 of §2.6 item4 — cross-runtime delegation plugin-grant consumption.

Covers ``SuperClawOrchestrator._granted_plugin_ids`` dual-track priority: a profile
delegation reads ``agent_run_context.equipment.granted`` (single source, already
capped to parent ∩ profile); a no-profile delegation reads the kernel field
``delegated_plugin_grants``; a delegation signal with no usable grant fails closed;
``delegated_tools`` (core-tool names) is NEVER read as plugin ids.
"""

from __future__ import annotations

from types import SimpleNamespace

from superclaw.orchestrator import SuperClawOrchestrator


def _g(ec):
    return SuperClawOrchestrator._granted_plugin_ids(SimpleNamespace(execution_context=ec))


def test_profile_delegation_uses_equipment_granted():
    g = _g(
        {
            "agent_profile_id": "p",
            "delegation_depth": 1,
            "agent_run_context": {"equipment": {"granted": ["plugin-a", "plugin-b"]}},
        }
    )
    assert g == frozenset({"plugin-a", "plugin-b"})


def test_no_profile_delegation_uses_delegated_plugin_grants():
    g = _g({"delegation_depth": 1, "origin_run_id": "r", "delegated_plugin_grants": ["plugin-a"]})
    assert g == frozenset({"plugin-a"})


def test_no_profile_non_team_parent_inherits_unrestricted():
    # 非 team 父继承:delegated_plugin_grants=None → None(不收窄,非 team 兼容)。
    g = _g({"delegation_depth": 1, "delegated_plugin_grants": None})
    assert g is None


def test_delegation_signal_without_grant_fails_closed():
    # 有 delegation 信号但无 plugin grant 字段 → fail-closed(绝不回落全集)。
    assert _g({"delegation_depth": 1, "origin_run_id": "r"}) == frozenset()


def test_never_reads_delegated_tools_as_plugin_ids():
    # delegated_tools 是核心工具名;只有它而无 plugin grant → fail-closed(不当 plugin id)。
    g = _g({"delegation_depth": 1, "delegated_tools": ["read_file", "run_shell"]})
    assert g == frozenset()
    assert g != frozenset({"read_file", "run_shell"})


def test_malformed_delegated_plugin_grants_fails_closed():
    assert _g({"delegation_depth": 1, "delegated_plugin_grants": "all"}) == frozenset()
    assert _g({"delegation_depth": 1, "delegated_plugin_grants": 123}) == frozenset()


def test_malformed_equipment_fails_closed():
    assert _g({"agent_run_context": {"equipment": "nope"}}) == frozenset()
    assert _g({"agent_run_context": {"equipment": {"granted": "nope"}}}) == frozenset()


def test_mixed_malformed_collection_fails_closed():
    # 混合脏集合(含非 str / 空白元素)→ fail-closed frozenset(),绝不静默过滤把脏 state 洗成
    # 可用 grant(Codex 阻断:laundering)。两轨都覆盖。
    assert _g({"agent_run_context": {"equipment": {"granted": ["plugin-a", 5, ""]}}}) == frozenset()
    assert _g({"delegation_depth": 1, "delegated_plugin_grants": ["plugin-a", 5]}) == frozenset()
    assert _g({"delegation_depth": 1, "delegated_plugin_grants": ["plugin-a", "  "]}) == frozenset()


def test_profile_signal_without_equipment_never_downgrades_to_cap():
    # Codex R2 阻断:profile 委派(agent_profile_id 信号)若 agent_run_context 缺失/空/畸形
    # (build_agent_run_context 被 except 吞异常),绝不降级到 delegated_plugin_grants(=parent∩
    # profile,比 resolve∩cap 的 equipment.granted 宽)→ 必须 fail-closed frozenset()。
    base = {"agent_profile_id": "p", "delegation_depth": 1, "delegated_plugin_grants": ["plugin-a"]}
    assert _g(base) == frozenset()  # agent_run_context 缺失
    assert _g({**base, "agent_run_context": {}}) == frozenset()  # 空 dict
    assert _g({**base, "agent_run_context": "bad"}) == frozenset()  # 畸形非 dict


def test_non_team_non_delegated_returns_none():
    assert _g({}) is None
    assert _g({"some": "unrelated"}) is None


def test_profile_equipment_takes_priority_over_delegated_plugin_grants():
    # profile 委派同时有 agent_run_context(已含 cap)+ delegated_plugin_grants(cap)→ 用前者
    # (单一源,_create_linked_child 已把 equipment.granted 约束成 parent ∩ profile)。
    g = _g(
        {
            "delegation_depth": 1,
            "agent_run_context": {"equipment": {"granted": ["plugin-a"]}},
            "delegated_plugin_grants": ["plugin-a", "plugin-b"],
        }
    )
    assert g == frozenset({"plugin-a"})


def _authorize_no_profile(parent_plugins):
    # 真实 authorize 输出(no-profile 委派),用于端到端契约验证。
    from superclaw.cross_runtime_delegation import DelegationRequest, authorize_delegation_request

    return authorize_delegation_request(
        request=DelegationRequest(subtask="x", runtime="gemini", profile=None, budget_seconds=100),
        source_backend="gemini",
        enabled=True,
        depth=0,
        origin_principal="owner",
        origin_run_id="r",
        parent_tool_call_id=None,
        inventory={"gemini": {"available": True}},
        parent_effective_tools=frozenset({"read_file"}),
        parent_effective_plugins=parent_plugins,
        parent_allows_privileged=False,
        parent_budget_remaining_seconds=600,
        profile_lookup=lambda pid: None,
        pay_scan_classifier=lambda s: False,
        trace_id="t",
    )


def test_end_to_end_authorize_output_consumed_by_granted_plugin_ids():
    # 端到端契约(agy 验收触发的缺口):authorize 写的 child_spec.execution_context 经
    # _create_linked_child 的 dict-update(无 schema 过滤,#283 typed gate 只作用于 Issue 层)
    # 落进 child_session,被 _granted_plugin_ids 正确消费。字段名/语义跨 authorize→落地→消费 一致。
    dec = _authorize_no_profile(frozenset({"plugin-a", "plugin-b"}))
    assert dec.authorized is True
    child_ec = dict(dec.child_spec["execution_context"])  # 模拟 L1108 execution_context.update
    assert _g(child_ec) == frozenset({"plugin-a", "plugin-b"})  # no-profile 继承父


def test_end_to_end_child_capped_to_parent_no_escalation():
    # child ⊆ parent 端到端:父只有 plugin-a → no-profile 子继承得 {plugin-a}(不提权)。
    dec = _authorize_no_profile(frozenset({"plugin-a"}))
    child_ec = dict(dec.child_spec["execution_context"])
    assert _g(child_ec) == frozenset({"plugin-a"})


def test_granted_unions_skills_granted_for_tool_skill_projection():
    # F3 (Codex R10): a tool-skill equipped via skill_allowlist executes through the
    # SAME aggregate MCP proxy as a plugin, so its id must be projected. _granted_plugin_ids
    # unions equipment.skills.granted into the allowed set (plugin grant ∪ skill grant).
    # The plugin grant itself excludes skill-origin ids (resolve_equipment), so this never
    # grants a skill AS plugin equipment — it only lets a skill_allowlist-granted tool-skill
    # be MCP-projected for a team-bound run.
    g = _g(
        {
            "agent_run_context": {
                "equipment": {"granted": ["plugin-a"], "skills": {"granted": ["skill.greeter"]}}
            }
        }
    )
    assert g == frozenset({"plugin-a", "skill.greeter"})


def test_granted_skills_block_is_optional_and_fails_closed():
    # No skills block ⇒ just the plugin grant (back-compat with the old shape).
    assert _g({"agent_run_context": {"equipment": {"granted": ["plugin-a"]}}}) == frozenset({"plugin-a"})
    # Malformed skills block / dirty skill id ⇒ fail closed (laundering parity with granted).
    assert _g({"agent_run_context": {"equipment": {"granted": ["plugin-a"], "skills": "nope"}}}) == frozenset()
    assert (
        _g({"agent_run_context": {"equipment": {"granted": ["plugin-a"], "skills": {"granted": "nope"}}}})
        == frozenset()
    )
    assert (
        _g({"agent_run_context": {"equipment": {"granted": ["plugin-a"], "skills": {"granted": ["x", 5]}}}})
        == frozenset()
    )
