"""Cross-runtime delegation admission (向内 P1-0) 测试。

覆盖双顾问(Codex+Gemini)裁定必须 fail-closed 拒绝的全部准入关卡 + 通过路径。
P1-0 是纯校验层(不 spawn、不异步),所有依赖经参数注入。
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from superclaw.cross_runtime_delegation import (
    DELEGATION_MAX_DEPTH,
    DelegationRequest,
    authorize_delegation_for_parent,
    authorize_delegation_request,
    delegation_eligible,
    parse_delegation_request,
    project_agent_profile,
)


# ----------------------------------------------------------------------------
# delegation_eligible:发起方 capability descriptor(未知=False fail-closed)
# ----------------------------------------------------------------------------
@pytest.mark.parametrize(
    "name,expected",
    [
        ("gemini", True),
        ("anthropic-agent", True),
        ("anthropic", False),   # single-completion backend, not the owned tool loop
        ("codex", False),       # native 工具循环,不经 _exec_tool
        ("claude", False),      # native
        ("cursor", False),
        ("opencode", False),
        ("unknown-xyz", False),
        ("", False),
        (None, False),
    ],
)
def test_delegation_eligible(name, expected):
    assert delegation_eligible(name) is expected


# ----------------------------------------------------------------------------
# parse_delegation_request:严格解析,形状不符 → None
# ----------------------------------------------------------------------------
def test_parse_valid_full():
    req = parse_delegation_request(
        {"subtask": " do X ", "runtime": "gemini", "model_tier": "opus", "profile": "p1", "budget_seconds": 120}
    )
    assert req == DelegationRequest(
        subtask="do X", runtime="gemini", model_tier="opus", profile="p1", budget_seconds=120
    )


def test_parse_valid_minimal():
    req = parse_delegation_request({"subtask": "do X"})
    assert req == DelegationRequest(
        subtask="do X", runtime=None, model_tier=None, profile=None, budget_seconds=None
    )


@pytest.mark.parametrize("bad_budget", [-1, 0, True, False, 1.5, "300", []])
def test_parse_illegal_budget_denies(bad_budget):
    # budget 提供但非正整数(含 bool/float/str)→ 整体 fail-closed 拒,绝不静默吞掉
    assert parse_delegation_request({"subtask": "x", "budget_seconds": bad_budget}) is None


def test_parse_budget_absent_is_none():
    assert parse_delegation_request({"subtask": "x"}).budget_seconds is None


@pytest.mark.parametrize(
    "raw",
    [
        {},                                  # 缺 subtask
        {"subtask": ""},                     # 空 subtask
        {"subtask": "   "},                  # 空白 subtask
        {"subtask": 123},                    # 非 str
        "not a mapping",                     # 非 Mapping
        {"subtask": "ok", "runtime": ""},    # 可选字段空白 → 整体拒(fail-closed)
        {"subtask": "ok", "runtime": "  "},  # 可选字段空白
        {"subtask": "ok", "profile": 123},   # 可选字段非 str
        {"subtask": "ok", "model_tier": ""},
    ],
)
def test_parse_invalid_or_blanked(raw):
    # 可选字段提供但非法 → 整体 fail-closed 拒,绝不静默规整为 None
    assert parse_delegation_request(raw) is None


def test_parse_optional_none_is_missing():
    # 可选字段显式 None 等价缺省(不报错)
    req = parse_delegation_request({"subtask": "x", "runtime": None, "profile": None})
    assert req == DelegationRequest(
        subtask="x", runtime=None, model_tier=None, profile=None, budget_seconds=None
    )


# ----------------------------------------------------------------------------
# authorize_delegation_request:准入链
# ----------------------------------------------------------------------------
def _ctx(**overrides):
    """构造一份默认会**通过**的 authorize kwargs;各用例只改要测的关卡。"""
    base = dict(
        request=DelegationRequest(
            subtask="run the linter", runtime="gemini", model_tier="opus", profile=None, budget_seconds=300
        ),
        source_backend="gemini",
        enabled=True,
        depth=0,
        origin_principal="local-human-owner",
        origin_run_id="run-parent",
        parent_tool_call_id="call-1",
        inventory={"gemini": {"available": True}, "anthropic": {"available": True}},
        parent_effective_tools=frozenset({"run_shell", "read_file", "write_file"}),
        parent_effective_plugins=None,
        parent_allows_privileged=False,
        parent_budget_remaining_seconds=600,
        profile_lookup=lambda pid: None,
        pay_scan_classifier=lambda subtask: False,
        trace_id="trace-1",
    )
    base.update(overrides)
    return base


def test_authorize_happy_path():
    dec = authorize_delegation_request(**_ctx())
    assert dec.authorized is True
    spec = dec.child_spec
    assert spec is not None
    assert spec["description"] == "run the linter"
    assert spec["backend_policy"] == "gemini"
    assert spec["budget_seconds"] == 300
    ctx = spec["execution_context"]
    assert ctx["delegation_depth"] == 1          # depth+1 继承
    assert ctx["trace_id"] == "trace-1"
    assert ctx["origin_principal"] == "local-human-owner"
    assert ctx["origin_run_id"] == "run-parent"
    assert ctx["parent_tool_call_id"] == "call-1"
    assert ctx["delegated_tools"] == ["read_file", "run_shell", "write_file"]


@pytest.mark.parametrize("bad_enabled", [False, "false", "true", 0, 1, None])
def test_authorize_disabled_denies(bad_enabled):
    # 开关必须严格 True;truthy 脏值(如 "false"/"true" 字符串、1)也拒
    dec = authorize_delegation_request(**_ctx(enabled=bad_enabled))
    assert dec.authorized is False
    assert "disabled" in dec.reason


def test_authorize_depth_denies():
    # 防衔尾蛇:child(depth>=MAX)不得再委派
    dec = authorize_delegation_request(**_ctx(depth=DELEGATION_MAX_DEPTH))
    assert dec.authorized is False
    assert "depth" in dec.reason


def test_authorize_missing_principal_denies():
    dec = authorize_delegation_request(**_ctx(origin_principal=None))
    assert dec.authorized is False
    assert "principal" in dec.reason


@pytest.mark.parametrize("classifier_ret", [True, None, 0, 1, "yes"])
def test_authorize_pay_scan_denies(classifier_ret):
    # 分类器必须严格返回 False 才放行;True/None/0/脏值一律拒
    dec = authorize_delegation_request(**_ctx(pay_scan_classifier=lambda s: classifier_ret))
    assert dec.authorized is False
    assert "pay/scan" in dec.reason


def test_authorize_unknown_runtime_denies():
    dec = authorize_delegation_request(
        **_ctx(request=DelegationRequest(subtask="x", runtime="nope"))
    )
    assert dec.authorized is False
    assert "unknown runtime" in dec.reason


@pytest.mark.parametrize("bad_available", [False, "false", "true", 1, 0, None])
def test_authorize_unavailable_runtime_denies(bad_available):
    # available 必须严格 True;truthy 脏值(如 "false" 字符串、1)也当不可用拒
    dec = authorize_delegation_request(
        **_ctx(inventory={"gemini": {"available": bad_available}})
    )
    assert dec.authorized is False
    assert "not available" in dec.reason


@pytest.mark.parametrize("bad_entry", ["a string", 123, ["list"]])
def test_authorize_runtime_entry_non_mapping_denies(bad_entry):
    # inventory 项非 Mapping → 当未知 runtime 拒(防 entry.get 抛 AttributeError)
    dec = authorize_delegation_request(**_ctx(inventory={"gemini": bad_entry}))
    assert dec.authorized is False
    assert "unknown runtime" in dec.reason


def test_authorize_runtime_none_skips_runtime_check():
    # runtime=None(由 broker 据 inventory 选)不应触发 runtime 校验
    dec = authorize_delegation_request(
        **_ctx(request=DelegationRequest(subtask="x", runtime=None))
    )
    assert dec.authorized is True
    assert dec.child_spec["backend_policy"] is None


def test_authorize_unknown_profile_denies():
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="ghost"),
            profile_lookup=lambda pid: None,
        )
    )
    assert dec.authorized is False
    assert "unknown or invalid" in dec.reason


def test_authorize_core_tools_not_narrowed_by_profile():
    # layer 3 双轨:profile 不收窄核心工具(根治"核心工具名 ∩ plugin id 恒空"的既存 bug)。
    # delegated_tools = parent_effective_tools 全集(核心工具归 posture/containment,非 profile);
    # plugin 轨独立按 parent_effective_plugins ∩ profile.plugin_grants 收窄。
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="ro"),
            profile_lookup=lambda pid: {"plugin_grants": ["plugin-a"]},
            parent_effective_plugins=frozenset({"plugin-a", "plugin-b"}),
        )
    )
    assert dec.authorized is True
    ctx = dec.child_spec["execution_context"]
    assert ctx["delegated_tools"] == ["read_file", "run_shell", "write_file"]
    assert ctx["delegated_plugin_grants"] == ["plugin-a"]


def test_authorize_plugin_grant_capped_to_parent():
    # 核心不变量 child ⊆ parent:profile 请求超出父的插件,被父 cap 收窄(即便指定高权 profile 也不提权)。
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="greedy"),
            profile_lookup=lambda pid: {"plugin_grants": ["plugin-a", "plugin-x", "plugin-y"]},
            parent_effective_plugins=frozenset({"plugin-a"}),
        )
    )
    assert dec.authorized is True
    assert dec.child_spec["execution_context"]["delegated_plugin_grants"] == ["plugin-a"]


def test_authorize_no_profile_inherits_parent_plugins():
    # no-profile 委派:显式继承父 effective plugins(非悄悄继承;child=parent,不提权)。
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile=None),
            parent_effective_plugins=frozenset({"plugin-a", "plugin-b"}),
        )
    )
    assert dec.authorized is True
    assert dec.child_spec["execution_context"]["delegated_plugin_grants"] == ["plugin-a", "plugin-b"]


def test_authorize_non_team_parent_no_profile_unrestricted():
    # 非 team 父(parent_effective_plugins=None)+ no-profile → None(不收窄,与非 team run 兼容)。
    dec = authorize_delegation_request(
        **_ctx(request=DelegationRequest(subtask="x", runtime="gemini", profile=None))
    )
    assert dec.authorized is True
    assert dec.child_spec["execution_context"]["delegated_plugin_grants"] is None


def test_authorize_non_team_parent_with_profile_uses_profile_grants():
    # 非 team 父(parent_effective_plugins=None)+ **指定 profile** → 子按 profile 收窄(非 None,
    # 不绕过 profile 限制)。profile 指定时永远收窄,只有 no-profile 才继承父的 None。
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="ro"),
            profile_lookup=lambda pid: {"plugin_grants": ["plugin-a"]},
            parent_effective_plugins=None,
        )
    )
    assert dec.authorized is True
    assert dec.child_spec["execution_context"]["delegated_plugin_grants"] == ["plugin-a"]


def test_authorize_plugin_disjoint_grants_empty_not_deny():
    # layer 3:profile 的插件与父不交 → child 得空 plugin grant(fail-closed 不投影任何插件),
    # 但**不再 deny 整个委派**(核心工具委派独立于插件装备进行;修正旧"恒 deny"语义)。
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="disjoint"),
            profile_lookup=lambda pid: {"plugin_grants": ["plugin-z"]},
            parent_effective_plugins=frozenset({"plugin-a"}),
        )
    )
    assert dec.authorized is True
    ctx = dec.child_spec["execution_context"]
    assert ctx["delegated_plugin_grants"] == []
    assert ctx["delegated_tools"] == ["read_file", "run_shell", "write_file"]


@pytest.mark.parametrize("dirty_parent_priv", [False, "false", "true", 1, 0, None])
def test_authorize_privilege_escalation_denies(dirty_parent_priv):
    # child profile 要特权时,parent 必须严格 True;truthy 脏值(如 "false"/1)也拒(权限不提升)
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="priv"),
            profile_lookup=lambda pid: {"tool_grants": ["run_shell"], "allows_privileged": True},
            parent_allows_privileged=dirty_parent_priv,
        )
    )
    assert dec.authorized is False
    assert "escalate privilege" in dec.reason


def test_authorize_privilege_ok_when_parent_privileged():
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="priv"),
            profile_lookup=lambda pid: {"tool_grants": ["run_shell"], "allows_privileged": True},
            parent_allows_privileged=True,
        )
    )
    assert dec.authorized is True


def test_authorize_budget_exceeds_parent_denies():
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", budget_seconds=9999),
            parent_budget_remaining_seconds=600,
        )
    )
    assert dec.authorized is False
    assert "exceeds parent remaining" in dec.reason


def test_authorize_non_positive_budget_denies():
    # 防御性:即使绕过 parse 直接构造 budget_seconds=0
    dec = authorize_delegation_request(
        **_ctx(request=DelegationRequest(subtask="x", runtime="gemini", budget_seconds=0))
    )
    assert dec.authorized is False
    assert "non-positive" in dec.reason


def test_authorize_budget_defaults_to_parent_remaining():
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", budget_seconds=None),
            parent_budget_remaining_seconds=450,
        )
    )
    assert dec.authorized is True
    assert dec.child_spec["budget_seconds"] == 450


def test_authorize_empty_subtask_denies():
    # 防御性:即使绕过 parse 直接构造空 subtask
    dec = authorize_delegation_request(**_ctx(request=DelegationRequest(subtask="   ")))
    assert dec.authorized is False
    assert "subtask must be a non-empty string" in dec.reason


@pytest.mark.parametrize(
    "field,value",
    [
        ("runtime", 123), ("runtime", ""), ("runtime", "  "),
        ("profile", 123), ("profile", []), ("profile", ""),
        ("model_tier", []), ("model_tier", 1.5), ("model_tier", ""),
    ],
)
def test_authorize_bad_optional_field_shape_denies(field, value):
    # 防御性:直接构造 DelegationRequest 绕过 parse 的非法 optional 字段,authorizer 也须拒
    req = replace(
        DelegationRequest(subtask="x", runtime="gemini", profile=None, model_tier=None),
        **{field: value},
    )
    dec = authorize_delegation_request(
        **_ctx(request=req, profile_lookup=lambda pid: {"tool_grants": ["run_shell"]})
    )
    assert dec.authorized is False
    assert field in dec.reason


@pytest.mark.parametrize("backend", ["codex", "claude", "cursor", "opencode", "unknown", None])
def test_authorize_ineligible_backend_denies(backend):
    # broker admission 自己兜底发起方合格性,不依赖注入层
    dec = authorize_delegation_request(**_ctx(source_backend=backend))
    assert dec.authorized is False
    assert "not eligible to originate" in dec.reason


@pytest.mark.parametrize("bad_depth", [-1, True, 1.0, "0", 1])
def test_authorize_bad_depth_denies(bad_depth):
    # depth 必须非 bool int 且 ∈ [0, MAX);depth=-1/bool/float/str/>=MAX 一律拒
    dec = authorize_delegation_request(**_ctx(depth=bad_depth))
    assert dec.authorized is False
    assert "depth must be" in dec.reason


def test_authorize_profile_empty_plugins_allowed():
    # layer 3:profile 无插件装备(plugin_grants 空)→ 不 deny;子得空 plugin grant(fail-closed
    # 不投影任何插件),核心工具委派仍进行(根治旧"恒 deny"语义)。
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="empty"),
            profile_lookup=lambda pid: {"plugin_grants": []},
        )
    )
    assert dec.authorized is True
    assert dec.child_spec["execution_context"]["delegated_plugin_grants"] == []


def test_authorize_profile_missing_plugins_key_allowed():
    # 缺 plugin_grants 键 = 无插件装备(合法,非 deny);delegated_plugin_grants=[]。
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="bare"),
            profile_lookup=lambda pid: {},
        )
    )
    assert dec.authorized is True
    assert dec.child_spec["execution_context"]["delegated_plugin_grants"] == []


@pytest.mark.parametrize("bad_prof", [["not", "mapping"], "string", 123])
def test_authorize_profile_lookup_non_mapping_denies(bad_prof):
    # profile_lookup 返回非 Mapping → 拒(防 prof.get 抛 AttributeError)
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="weird"),
            profile_lookup=lambda pid: bad_prof,
        )
    )
    assert dec.authorized is False
    assert "unknown or invalid" in dec.reason


@pytest.mark.parametrize("bad_priv", ["false", "true", 1, 0, []])
def test_authorize_profile_non_bool_privileged_denies(bad_priv):
    # profile allows_privileged 非 bool → 拒(不降级继续)
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="dirty"),
            profile_lookup=lambda pid: {"tool_grants": ["run_shell"], "allows_privileged": bad_priv},
        )
    )
    assert dec.authorized is False
    assert "allows_privileged must be a bool" in dec.reason


@pytest.mark.parametrize("bad_plugins", [{"a": 1}, "plugin-a", 123, ["plugin-a", 5], ["plugin-a", ""]])
def test_authorize_profile_bad_plugin_grants_denies(bad_plugins):
    # plugin_grants 非字符串集合 / 含脏元素 → 拒(不静默忽略脏元素;None 是合法"无插件"不在此列)。
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="bad"),
            profile_lookup=lambda pid: {"plugin_grants": bad_plugins},
        )
    )
    assert dec.authorized is False


@pytest.mark.parametrize("bad_tools", ["read_file", ["read_file"], {"read_file": True}, 123, {"read_file", 5}])
def test_authorize_bad_parent_tools_denies(bad_tools):
    # parent_effective_tools 必须 set/frozenset of 非空 str;list/dict/str/脏元素 → 拒
    dec = authorize_delegation_request(**_ctx(parent_effective_tools=bad_tools))
    assert dec.authorized is False


@pytest.mark.parametrize("bad_budget", [True, 1.5])
def test_authorize_bad_budget_type_denies(bad_budget):
    # 防御性:直接构造 DelegationRequest 绕过 parse 的 bool/float budget,authorizer 也须拒
    dec = authorize_delegation_request(
        **_ctx(request=DelegationRequest(subtask="x", runtime="gemini", budget_seconds=bad_budget))
    )
    assert dec.authorized is False
    assert "budget must be a positive integer" in dec.reason


@pytest.mark.parametrize("bad_principal", ["", "   ", 123, {"id": "human"}])
def test_authorize_bad_principal_denies(bad_principal):
    # principal 必须非空 str(空白/非 str truthy 也不行)——绑定本地 human owner
    dec = authorize_delegation_request(**_ctx(origin_principal=bad_principal))
    assert dec.authorized is False
    assert "origin principal" in dec.reason


@pytest.mark.parametrize("field", ["origin_run_id", "trace_id"])
@pytest.mark.parametrize("bad", ["", "  ", 123, None])
def test_authorize_bad_audit_id_denies(field, bad):
    # 审计链标识符必须非空 str(写进 child_spec)
    dec = authorize_delegation_request(**_ctx(**{field: bad}))
    assert dec.authorized is False
    assert field in dec.reason


@pytest.mark.parametrize("bad_tcid", ["", "  ", 123, []])
def test_authorize_bad_parent_tool_call_id_denies(bad_tcid):
    dec = authorize_delegation_request(**_ctx(parent_tool_call_id=bad_tcid))
    assert dec.authorized is False
    assert "parent_tool_call_id" in dec.reason


def test_authorize_parent_tool_call_id_none_ok():
    dec = authorize_delegation_request(**_ctx(parent_tool_call_id=None))
    assert dec.authorized is True
    assert dec.child_spec["execution_context"]["parent_tool_call_id"] is None


@pytest.mark.parametrize("bad_parent_budget", [True, 1.5, 0, -1, "600"])
def test_authorize_bad_parent_budget_denies(bad_parent_budget):
    # parent 剩余预算本身非 bool 正整数 → 拒(防 fallback 继承时绕过封顶/抛 TypeError)
    dec = authorize_delegation_request(
        **_ctx(
            request=DelegationRequest(subtask="x", runtime="gemini", budget_seconds=None),
            parent_budget_remaining_seconds=bad_parent_budget,
        )
    )
    assert dec.authorized is False
    assert "parent budget" in dec.reason


# ----------------------------------------------------------------------------
# P1-1:profile adapter
# ----------------------------------------------------------------------------
def test_project_agent_profile_maps_fields():
    prof = SimpleNamespace(
        plugin_allowlist=["a", "b"], skill_allowlist=["s1"], permission_policy={"mode": "bypassPermissions"}
    )
    out = project_agent_profile(prof)
    assert set(out["tool_grants"]) == {"a", "b", "s1"}
    assert out["allows_privileged"] is True


@pytest.mark.parametrize(
    "mode", ["ask", "acceptEdits", "plan", "default", "auto", None, "", "full", "bypass", "BYPASSPERMISSIONS"]
)
def test_project_agent_profile_non_privileged_modes(mode):
    # 真实词表外的值(含臆造的 full/bypass、大小写变体)一律非特权
    prof = SimpleNamespace(plugin_allowlist=["a"], skill_allowlist=[], permission_policy={"mode": mode})
    assert project_agent_profile(prof)["allows_privileged"] is False


@pytest.mark.parametrize("mode", ["bypassPermissions", "dontAsk"])
def test_project_agent_profile_privileged_modes(mode):
    prof = SimpleNamespace(plugin_allowlist=["a"], skill_allowlist=[], permission_policy={"mode": mode})
    assert project_agent_profile(prof)["allows_privileged"] is True


def test_project_agent_profile_empty_failclosed():
    prof = SimpleNamespace(plugin_allowlist=[], skill_allowlist=[], permission_policy={})
    out = project_agent_profile(prof)
    assert out["tool_grants"] == []
    assert out["allows_privileged"] is False


def test_project_agent_profile_preserves_dirty_entries_for_authorize():
    # 不清洗:脏元素原样保留,交下游 authorize 整体拒(绝不静默过滤掩盖污染)
    prof = SimpleNamespace(plugin_allowlist=["ok", "", 5, None], skill_allowlist=None, permission_policy=None)
    out = project_agent_profile(prof)
    assert out["tool_grants"] == ["ok", "", 5, None]
    assert out["allows_privileged"] is False


def test_project_agent_profile_non_list_grants_is_none():
    # plugin/skill 非 list/tuple → tool_grants=None(交 authorize 的 collection 校验拒)
    prof = SimpleNamespace(plugin_allowlist="run_shell", skill_allowlist=[], permission_policy={})
    assert project_agent_profile(prof)["tool_grants"] is None


# ----------------------------------------------------------------------------
# P1-1:DelegationBroker 准入编排
# ----------------------------------------------------------------------------
def _parent(execution_context=None, run_id="run-parent"):
    return SimpleNamespace(
        execution_context=execution_context if execution_context is not None else {"principal": "alice"},
        run_id=run_id,
    )


def _broker(**overrides):
    base = dict(
        request=DelegationRequest(subtask="x", runtime="gemini", budget_seconds=100),
        parent_session=_parent(),
        source_backend="gemini",
        enabled=True,
        inventory={"gemini": {"available": True}},
        profile_loader=lambda pid: None,
        pay_scan_classifier=lambda s: False,
        parent_effective_tools=frozenset({"run_shell"}),
        parent_effective_plugins=None,
        parent_allows_privileged=False,
        parent_budget_remaining_seconds=600,
        trace_id="t1",
        parent_tool_call_id="c1",
    )
    base.update(overrides)
    return base


def test_broker_happy_path():
    dec = authorize_delegation_for_parent(**_broker())
    assert dec.authorized is True
    ec = dec.child_spec["execution_context"]
    assert ec["origin_principal"] == "alice"
    assert ec["origin_run_id"] == "run-parent"
    assert ec["delegation_depth"] == 1


def test_broker_extracts_depth_from_parent_blocks_nested():
    # parent 已是 depth=1 的 child → 防衔尾蛇硬拒
    dec = authorize_delegation_for_parent(
        **_broker(parent_session=_parent(execution_context={"principal": "alice", "delegation_depth": 1}))
    )
    assert dec.authorized is False
    assert "depth" in dec.reason


@pytest.mark.parametrize("dirty", [123, "  ", {"id": "x"}, []])
def test_broker_dirty_principal_denies(dirty):
    # principal 存在却脏 → 不回退掩盖,原样交 authorize 硬拒(采纳 Codex fail-closed)
    dec = authorize_delegation_for_parent(
        **_broker(parent_session=_parent(execution_context={"principal": dirty}))
    )
    assert dec.authorized is False
    assert "origin principal" in dec.reason


def test_broker_malformed_plugin_allowlist_shape_denied():
    # 脏形状 plugin_allowlist(非 list,如 str)经 project → authorize 形状校验 deny;绝不折叠成
    # None 当合法"无插件"放行(Codex 阻断:洗白腐化治理输入)。
    prof = SimpleNamespace(plugin_allowlist="plugin-a", skill_allowlist=[], permission_policy={})
    dec = authorize_delegation_for_parent(
        **_broker(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="p"),
            profile_loader=lambda pid: prof,
        )
    )
    assert dec.authorized is False
    assert "must be a collection" in dec.reason


def test_broker_dirty_profile_grants_rejected_by_authorize():
    # adapter 不清洗:脏 profile plugin grants 经 broker → authorize 整体拒(P1-0 兜底未被削弱)
    prof = SimpleNamespace(plugin_allowlist=["ok", 5], skill_allowlist=[], permission_policy={})
    dec = authorize_delegation_for_parent(
        **_broker(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="p"),
            profile_loader=lambda pid: prof,
        )
    )
    assert dec.authorized is False
    assert "invalid plugin grant" in dec.reason


def test_broker_missing_principal_falls_back_local_user():
    dec = authorize_delegation_for_parent(**_broker(parent_session=_parent(execution_context={})))
    assert dec.authorized is True
    assert dec.child_spec["execution_context"]["origin_principal"] == "local_user"


def test_broker_profile_adapter_integration_narrows_plugins():
    # profile_loader 返回 AgentProfile-like → adapter 投影 plugin_grants → plugin 轨按
    # parent_effective_plugins ∩ profile 收窄;核心工具不被 profile 收窄(layer 3 双轨)。
    prof = SimpleNamespace(plugin_allowlist=["plugin-a"], skill_allowlist=[], permission_policy={"mode": "ask"})
    dec = authorize_delegation_for_parent(
        **_broker(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="p1"),
            profile_loader=lambda pid: prof,
            parent_effective_tools=frozenset({"read_file", "write_file"}),
            parent_effective_plugins=frozenset({"plugin-a", "plugin-b"}),
        )
    )
    assert dec.authorized is True
    ctx = dec.child_spec["execution_context"]
    assert ctx["delegated_plugin_grants"] == ["plugin-a"]
    assert sorted(ctx["delegated_tools"]) == ["read_file", "write_file"]


def test_broker_profile_privilege_escalation_blocked():
    # profile 要 bypassPermissions 特权但 parent 无 → 拒(adapter+authorize 联合堵提权)
    prof = SimpleNamespace(
        plugin_allowlist=["run_shell"], skill_allowlist=[], permission_policy={"mode": "bypassPermissions"}
    )
    dec = authorize_delegation_for_parent(
        **_broker(
            request=DelegationRequest(subtask="x", runtime="gemini", profile="p1"),
            profile_loader=lambda pid: prof,
            parent_allows_privileged=False,
        )
    )
    assert dec.authorized is False
    assert "escalate privilege" in dec.reason


def test_broker_ineligible_source_backend_blocked():
    dec = authorize_delegation_for_parent(**_broker(source_backend="codex"))
    assert dec.authorized is False
    assert "not eligible to originate" in dec.reason
