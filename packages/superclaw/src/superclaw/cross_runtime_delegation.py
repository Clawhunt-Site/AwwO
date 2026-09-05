"""Cross-runtime delegation — admission layer (向内 P1-0).

设计源:docs/cross-runtime-delegation.md §2/§3 + Codex(gpt-5.5)+Gemini 架构设计双裁决。

核心范式:**委派 = 受控上下文切出**。编排模型(chat 主 agent)proposes 一次
`delegate(subtask, runtime?, model_tier?, profile?)`;内核 disposes——所有校验/spawn/
等待/结果封装由 orchestrator-owned broker 完成,backend 工具层只能"上传意图"。

本模块是 **P1-0:admission only** —— spawn 前的 fail-closed 准入校验层(纯函数,不
spawn、不异步)。后续阶段消费它:
- P1-1:gemini/anthropic 的 `_exec_tool` 注入 `delegate` 工具(仅 delegation_eligible
  且 depth==0 且开关开),识别后抛 DelegationRequested(意图),orchestrator broker catch。
- P1-2:durable 异步(WAITING_FOR_CHILD_DELEGATION 状态 + child 嵌套流 + resume idempotency)。
- P1-3:child completion review gate(禁模型自批);P2:native/MCP。

⚠️与 team_kernel 的 issue 委派(`delegate_sub_issue`)同名不同物:那是组织层工单树,
本模块是 runtime 层"把子任务甩给另一个 runtime"。
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

# 防衔尾蛇(Ouroboros):委派深度上限。depth==0 的父 turn 才能发起;child(depth>=1)
# 物理上不注入 delegate 工具(P1-1),broker 再按此硬校验兜底(双层)。
DELEGATION_MAX_DEPTH = 1

# 合格的**发起方** backend = SuperClaw 内核自管工具循环(_RealToolExecution:经
# `_exec_tool` 能识别/拦截 delegate)。native runtime(codex/claude/cursor/opencode)
# 工具循环原生自管、不经 _exec_tool,P1 一律不合格(否则其 native Task/spawn 会成为
# 绕过 depth/principal/budget 的旁路);它们经 MCP 注入是 P2 深水区。未知 = 不合格。
# 这是 capability descriptor,与 inventory 的 `strengths`(只给模型选路、不作 eligibility)
# 严格区分——见双顾问裁决:"strengths 不可作 eligibility"。
#
# Note: ``anthropic`` is the single-completion backend, not the SuperClaw-owned
# tool loop. The real Messages-API tool-loop backend is ``anthropic-agent``.
_DELEGATION_ELIGIBLE_BACKENDS = frozenset({"gemini", "anthropic-agent"})


def delegation_eligible(backend_name: str | None) -> bool:
    """该 backend 能否作为委派**发起方**(注入 delegate 工具)。未知一律 False(fail-closed)。"""
    return (backend_name or "") in _DELEGATION_ELIGIBLE_BACKENDS


@dataclass(frozen=True)
class DelegationRequest:
    """模型 proposes 的委派请求(结构化 tool-call 参数;绝不接受自由文本)。"""

    subtask: str
    runtime: str | None = None       # 目标 runtime(被委派执行者);None 由 broker 据 inventory 选
    model_tier: str | None = None    # opus/sonnet/haiku 或具体模型名
    profile: str | None = None       # agent profile id(可选,收窄 equipment)
    budget_seconds: int | None = None  # 模型可提议收窄预算;None 由 broker 据 parent 剩余兜底


@dataclass(frozen=True)
class DelegationRequested(Exception):
    """Structured escape hatch from the backend tool loop to the orchestrator broker.

    The api-agent backend must not spawn child runs directly. It raises this once
    a model calls the injected ``delegate`` tool; the orchestrator-owned broker is
    the only layer allowed to authorize, persist, spawn, wait, and package result.
    """

    request: DelegationRequest
    parent_tool_call_id: str | None = None

    def __str__(self) -> str:
        return f"cross-runtime delegation requested: {self.request.subtask[:80]}"


@dataclass(frozen=True)
class DelegationDecision:
    """内核 disposes 的准入裁决。authorized=False 时 reason 给拒绝原因(fail-closed)。

    authorized=True 时 child_spec 是交给 orchestrator `spawn_child_runs` 的 child 规格
    (已注入继承的 depth/trace_id/origin_principal/origin_run_id 与收窄后的 equipment/budget)。
    """

    authorized: bool
    reason: str
    child_spec: dict[str, Any] | None = None


def parse_delegation_request(raw: Mapping[str, Any]) -> DelegationRequest | None:
    """严格解析 tool-call 参数 → DelegationRequest;任何形状不符返回 None(fail-closed)。"""
    if not isinstance(raw, Mapping):
        return None
    subtask = raw.get("subtask")
    if not isinstance(subtask, str) or not subtask.strip():
        return None

    _MISSING = object()

    def _opt_str(key: str):
        # 缺省(键不存在或值为 None)→ None;提供但非 str 或空白 → _MISSING(令整体拒绝),
        # 绝不把非法可选字段静默规整为 None——那会让 profile=123 / runtime=" " 绕过
        # 后续 profile/runtime 校验与 equipment 收窄(Codex 指出的 fail-open)。
        if key not in raw or raw[key] is None:
            return None
        val = raw[key]
        if not isinstance(val, str) or not val.strip():
            return _MISSING
        return val.strip()

    runtime = _opt_str("runtime")
    model_tier = _opt_str("model_tier")
    profile = _opt_str("profile")
    if runtime is _MISSING or model_tier is _MISSING or profile is _MISSING:
        return None

    # budget_seconds:模型可提议收窄。缺省→None(broker 据 parent 兜底);提供但非
    # 正整数(含 bool/负/0/非 int)→ 整体 fail-closed 拒,绝不静默吞掉非法提议。
    budget_raw = raw.get("budget_seconds")
    if budget_raw is None:
        budget_seconds: int | None = None
    elif isinstance(budget_raw, bool) or not isinstance(budget_raw, int) or budget_raw <= 0:
        return None
    else:
        budget_seconds = budget_raw

    return DelegationRequest(
        subtask=subtask.strip(),
        runtime=runtime,
        model_tier=model_tier,
        profile=profile,
        budget_seconds=budget_seconds,
    )


def _deny(reason: str) -> DelegationDecision:
    return DelegationDecision(authorized=False, reason=reason, child_spec=None)


def authorize_delegation_request(
    request: DelegationRequest,
    *,
    source_backend: str | None,
    enabled: bool,
    depth: int,
    origin_principal: str | None,
    origin_run_id: str,
    parent_tool_call_id: str | None,
    inventory: Mapping[str, Mapping[str, Any]],
    parent_effective_tools: frozenset[str],
    parent_effective_plugins: frozenset[str] | None,
    parent_allows_privileged: bool,
    parent_budget_remaining_seconds: int,
    profile_lookup: Callable[[str], Mapping[str, Any] | None],
    pay_scan_classifier: Callable[[str], bool],
    trace_id: str,
) -> DelegationDecision:
    """spawn 前 admission —— fail-closed 准入链(双顾问裁定的校验顺序)。

    纯函数:不 spawn、不触网、不改状态;所有依赖经参数注入(orchestrator broker 在
    捕获 DelegationRequested 后调用,测试可构造)。任一关卡不过即 deny,绝不 fail-soft。
    """
    # 1. 开关(P0 fail-closed):必须严格 True;关 / 非 bool 脏值(如 "false" 字符串 truthy)一律拒。
    if enabled is not True:
        return _deny("cross-runtime delegation is disabled")
    # 2. 发起方 backend 合格性:broker admission 自己兜底,绝不依赖"注入层只给 gemini/anthropic"。
    #    native(codex/claude/cursor/...)/未知 backend 一律拒——否则其原生自管工具循环/Task
    #    会成为绕过 depth/principal/budget 的旁路(Codex 指出的"无 broker 兜底")。
    if not delegation_eligible(source_backend):
        return _deny(f"backend {source_backend!r} is not eligible to originate delegation")
    # 3. 防衔尾蛇:depth 必须是非 bool 整数且 ∈ [0, MAX);只有顶层(0)能发起,child(>=1)
    #    既物理不注入 delegate、此处再硬拒。负数/bool/非 int 一律拒(防 depth=-1 伪造 top-level)。
    if isinstance(depth, bool) or not isinstance(depth, int) or depth < 0 or depth >= DELEGATION_MAX_DEPTH:
        return _deny(f"delegation depth must be an int in [0, {DELEGATION_MAX_DEPTH}) to originate, got {depth!r}")
    # 3. principal 必须是继承来的本地 human owner(绝不接受模型经参数传入)。
    if not isinstance(origin_principal, str) or not origin_principal.strip():
        return _deny("missing or invalid origin principal (must be a non-empty str bound to local human owner)")
    # 审计链标识符:origin_run_id / trace_id 必填非空 str(写进 child_spec 用于追踪/防衔尾蛇);
    # parent_tool_call_id 可 None。脏值即拒(防审计链污染)。
    if not isinstance(origin_run_id, str) or not origin_run_id.strip():
        return _deny("origin_run_id must be a non-empty string")
    if not isinstance(trace_id, str) or not trace_id.strip():
        return _deny("trace_id must be a non-empty string")
    if parent_tool_call_id is not None and (
        not isinstance(parent_tool_call_id, str) or not parent_tool_call_id.strip()
    ):
        return _deny("parent_tool_call_id must be a non-empty string or None")
    # 4. request 字段形状复核(authorizer 不假设来自 parse——DelegationRequest 可被直接构造,
    #    profile=123 / model_tier=[] / subtask 非 str 都须在中央准入拦下,与 parser 边界一致)。
    if not isinstance(request.subtask, str) or not request.subtask.strip():
        return _deny("subtask must be a non-empty string")
    for _field_name, _value in (
        ("runtime", request.runtime),
        ("profile", request.profile),
        ("model_tier", request.model_tier),
    ):
        if _value is not None and (not isinstance(_value, str) or not _value.strip()):
            return _deny(f"{_field_name} must be a non-empty string or None, got {_value!r}")
    # 5. pay/scan 保守硬拒(不靠模型分类;child 执行期 escalation gate 仍会再拦一层)。
    # 分类器必须严格返回 False 才放行;True/None/0/任何脏值一律拒(安全分类 fail-closed)。
    if pay_scan_classifier(request.subtask) is not False:
        return _deny("subtask classified as pay/scan/network-sensitive or classifier returned non-False — denied (fail-closed)")
    # 6. 目标 runtime:若指定,必须 inventory 实时可用。
    target_runtime = request.runtime
    if target_runtime is not None:
        entry = inventory.get(target_runtime)
        if not isinstance(entry, Mapping):
            return _deny(f"unknown runtime {target_runtime!r}")
        if entry.get("available") is not True:
            return _deny(f"runtime {target_runtime!r} is not available")
    # 7. profile fail-closed:指定则必须存在(不许 unknown profile fail-soft)。
    #    profile_lookup 的契约形状是 {"tool_grants": [...], "allows_privileged": bool}。
    #    ⚠️ P1-1 留痕:原生 AgentProfile 字段名不同(plugin_allowlist + permission_policy.mode),
    #    broker 必须显式写 adapter 投影成此契约(尤其定义 allows_privileged ← mode in {full,bypass}),
    #    否则裸喂 AgentProfile.__dict__ 会令 tool_grants 恒空、触发第 8 步空交集硬拒(Gemini advisory)。
    # 7. profile fail-closed:指定则必须存在(不许 unknown profile fail-soft)。
    #    layer 3:plugin 装备轨独立——profile 只投影 plugin_grants(plugin_allowlist),与核心
    #    工具彻底解耦(根治"核心工具名 ∩ plugin/skill id 恒空"的既存 bug)。核心工具不由 profile
    #    收窄(profile 管装备,核心工具归 posture/containment)。
    profile_specified = request.profile is not None
    profile_plugin_grants: frozenset[str] = frozenset()
    profile_allows_privileged = False
    if profile_specified:
        prof = profile_lookup(request.profile)
        if not isinstance(prof, Mapping):
            return _deny(f"profile {request.profile!r} is unknown or invalid (fail-closed)")
        # plugin 轨:缺键/None = "无 plugin 装备"(合法:子得空 plugin grant=fail-closed 不投影,
        # 但核心工具委派仍进行);非集合/脏元素即拒(绝不清洗 = fail-open)。
        raw_plugins = prof.get("plugin_grants")
        if raw_plugins is None:
            profile_plugin_grants = frozenset()
        elif not isinstance(raw_plugins, (list, tuple, set, frozenset)):
            return _deny(f"profile {request.profile!r} plugin_grants must be a collection of strings or None (fail-closed)")
        elif not all(isinstance(p, str) and p.strip() for p in raw_plugins):
            return _deny(f"profile {request.profile!r} has invalid plugin grant entries (fail-closed)")
        else:
            profile_plugin_grants = frozenset(raw_plugins)
        # 特权位必须是严格 bool(非 bool 脏值如 "false" 一律拒,不降级继续)。
        raw_priv = prof.get("allows_privileged", False)
        if not isinstance(raw_priv, bool):
            return _deny(f"profile {request.profile!r} allows_privileged must be a bool (fail-closed)")
        profile_allows_privileged = raw_priv
    # 8. 核心工具轨:parent_effective_tools 是核心权限边界,必须是 set/frozenset of 非空 str
    #    (形状不符即拒)。profile 不收窄核心工具(双轨分离)。
    if not isinstance(parent_effective_tools, (set, frozenset)):
        return _deny("parent_effective_tools must be a set/frozenset of strings (fail-closed)")
    if not all(isinstance(t, str) and t.strip() for t in parent_effective_tools):
        return _deny("parent_effective_tools has invalid entries (fail-closed)")
    child_core_tools = frozenset(parent_effective_tools)
    if not child_core_tools:
        return _deny("parent grants no core tools (fail-closed)")
    # 8b. plugin 装备轨(layer 3):child_plugins ⊆ parent_plugins(不提权)。
    #     parent_effective_plugins None = 非 team 父(不收窄);frozenset = 父 granted 集。
    if parent_effective_plugins is not None:
        if not isinstance(parent_effective_plugins, (set, frozenset)):
            return _deny("parent_effective_plugins must be a set/frozenset of strings or None (fail-closed)")
        if not all(isinstance(p, str) and p.strip() for p in parent_effective_plugins):
            return _deny("parent_effective_plugins has invalid entries (fail-closed)")
    if profile_specified:
        # 父 None(非 team 父)→ 仅 profile 收窄;否则 父 ∩ profile(强制 child ⊆ parent,
        # 即便指定高权 profile 也不提权)。
        child_plugin_grants: frozenset[str] | None = (
            profile_plugin_grants
            if parent_effective_plugins is None
            else frozenset(parent_effective_plugins) & profile_plugin_grants
        )
    else:
        # no-profile:显式继承父(父 None → None = 非 team 兼容,不收窄)。
        child_plugin_grants = None if parent_effective_plugins is None else frozenset(parent_effective_plugins)
    # 9. 权限不提升:child 不得获得比 parent 更高的特权(尤其 full/bypass)。
    # child 要特权时,parent 必须严格 True(parent flag truthy 脏值如 "false" 也拒,防特权绕过)。
    if profile_allows_privileged and parent_allows_privileged is not True:
        return _deny("child would escalate privilege beyond parent (privileged grant requires a fresh human gate)")
    # 10. budget 封顶:authorizer 自己 fail-closed 校验类型(绝不假设 request 来自 parse,
    #     也不假设 broker 传干净的 parent 预算——DelegationRequest 可被直接构造、parent
    #     预算 bool/float 会绕过封顶,Codex 两轮指出)。模型提议优先、缺省继承 parent。
    if (
        isinstance(parent_budget_remaining_seconds, bool)
        or not isinstance(parent_budget_remaining_seconds, int)
        or parent_budget_remaining_seconds <= 0
    ):
        return _deny(f"invalid parent budget remaining: {parent_budget_remaining_seconds!r}")
    requested_budget = request.budget_seconds
    if requested_budget is None:
        budget = parent_budget_remaining_seconds
    elif isinstance(requested_budget, bool) or not isinstance(requested_budget, int):
        return _deny(f"budget must be a positive integer, got {requested_budget!r}")
    elif requested_budget <= 0:
        return _deny("non-positive delegation budget")
    else:
        budget = requested_budget
    if budget <= 0:
        return _deny("non-positive delegation budget")
    if budget > parent_budget_remaining_seconds:
        return _deny(f"requested budget {budget}s exceeds parent remaining {parent_budget_remaining_seconds}s")

    # 准入通过 → child_spec(继承 depth+1 / trace / principal / origin_run,收窄 equipment+budget)。
    child_spec: dict[str, Any] = {
        "title": f"delegated: {request.subtask[:60]}",
        "description": request.subtask,
        "backend_policy": target_runtime,
        "model": request.model_tier,
        "budget_seconds": budget,
        "agent_profile_id": request.profile,
        "execution_context": {
            "delegation_depth": depth + 1,
            "trace_id": trace_id,
            "origin_principal": origin_principal,
            "origin_run_id": origin_run_id,
            "parent_tool_call_id": parent_tool_call_id,
            "delegated_tools": sorted(child_core_tools),
            # layer 3:plugin 装备轨,独立于 delegated_tools(核心工具语义)。list=收窄集(含空集
            # = fail-closed 不投影任何插件);None=非 team 父继承(不收窄,与非 team run 一致)。
            # 绝不与 delegated_tools 混用。落地:profile 委派由 _create_linked_child 约束
            # equipment.granted(单一源);no-profile 委派由 _granted_plugin_ids 直接读本字段。
            "delegated_plugin_grants": (
                None if child_plugin_grants is None else sorted(child_plugin_grants)
            ),
        },
    }
    return DelegationDecision(authorized=True, reason="authorized", child_spec=child_spec)


# ---------------------------------------------------------------------------
# P1-1:profile adapter + DelegationBroker 准入编排(消费 P1-0 admission)
# ---------------------------------------------------------------------------

# 特权姿态 = SuperClaw 真实 PermissionMode 词表里的 unrestricted 档:runtime.py 的
# PermissionMode Literal + backends.py 全程 `mode in {bypassPermissions, dontAsk}` 判 full
# posture,与 PRESET "allow"→"bypassPermissions" 对齐。绝不是臆造的 {full, bypass}(那不在词表,
# 会令 bypassPermissions 投影成非特权 = fail-open)。
_PRIVILEGED_MODES = frozenset({"bypassPermissions", "dontAsk"})


def project_agent_profile(profile: Any) -> dict[str, Any]:
    """把原生 AgentProfile 投影成 authorize 期望的契约。

    回应 P1-0 留痕(authorize 的 profile_lookup 契约与原生 AgentProfile 字段名错位):
    - ``tool_grants`` ← ``plugin_allowlist`` + ``skill_allowlist``(保留:历史装备清单)。
    - ``plugin_grants`` ← ``plugin_allowlist``(**layer 3 新增**:plugin 装备轨独立于
      skill/core-tool;cross-runtime 委派的 plugin 收窄只看它,与核心工具名彻底解耦,
      根治"核心工具名 ∩ plugin/skill id 恒空"的既存 bug)。
    - ``allows_privileged`` ← ``permission_policy.mode in {bypassPermissions, dontAsk}``。

    duck typing:接受任何带这些属性的对象。**绝不"清洗"脏 profile 数据**:plugin/skill 非
    list/tuple → 对应 grants=None,脏元素原样保留,统统交下游 authorize 的 schema 校验整体
    硬拒。非 Mapping policy 当无特权。
    """
    plugin = getattr(profile, "plugin_allowlist", None)
    skill = getattr(profile, "skill_allowlist", None)
    plugin = plugin if plugin is not None else []
    skill = skill if skill is not None else []
    if isinstance(plugin, (list, tuple)) and isinstance(skill, (list, tuple)):
        tool_grants: list[Any] | None = [*plugin, *skill]
    else:
        tool_grants = None
    # plugin 轨独立:只投影 plugin_allowlist。list/tuple → 干净 list;**脏形状(str/dict/int)
    # 保留原值交 authorize 形状校验 deny(绝不折叠成 None,否则被当合法"无插件"放行 = 洗白腐化
    # 的 profile 治理输入,Codex 阻断)**;缺失(plugin_allowlist=None,L348 已 →[])→ 空 list(合法无插件)。
    plugin_grants: Any = list(plugin) if isinstance(plugin, (list, tuple)) else plugin
    policy = getattr(profile, "permission_policy", None)
    mode = policy.get("mode") if isinstance(policy, Mapping) else None
    return {
        "tool_grants": tool_grants,
        "plugin_grants": plugin_grants,
        "allows_privileged": mode in _PRIVILEGED_MODES,
    }


def authorize_delegation_for_parent(
    request: DelegationRequest,
    *,
    parent_session: Any,
    source_backend: str | None,
    enabled: bool,
    inventory: Mapping[str, Mapping[str, Any]],
    profile_loader: Callable[[str], Any | None],
    pay_scan_classifier: Callable[[str], bool],
    parent_effective_tools: frozenset[str],
    parent_effective_plugins: frozenset[str] | None,
    parent_allows_privileged: bool,
    parent_budget_remaining_seconds: int,
    trace_id: str,
    parent_tool_call_id: str | None,
) -> DelegationDecision:
    """broker 准入编排:从 parent RunSession 提取治理 context(depth / principal / origin_run_id)
    + profile adapter,再调 P1-0 ``authorize_delegation_request``。

    ``parent_effective_tools`` / ``parent_allows_privileged`` / budget / ``trace_id`` 由
    orchestrator 算后注入(它们涉及 parent run 的 PermissionPolicy/plugin 投影与预算账本,
    P1-1 后续接驳)。本函数是纯逻辑:不 spawn、不改状态。

    principal 从 ``execution_context["principal"]`` 继承:**缺失(None)**回退本地 ``local_user``
    (顶层 run 正常语义,同 orchestrator `_principal_of`);**存在却脏**(非 str / 空白)不回退,
    原样交 authorize 硬拒,绝不掩盖污染。
    """
    ec = getattr(parent_session, "execution_context", None) or {}
    # depth 缺失 = 正常顶层 run(委派 child 的 execution_context 由 spawn 显式写 delegation_depth=1,
    # 会被提取后由 authorize 的 depth 硬拒);存在却脏(非 int)原样传给 authorize 拒。
    depth = ec.get("delegation_depth", 0)
    raw_principal = ec.get("principal")
    # 缺失(None / 未设)= 正常顶层 run,回退本地 owner(与 orchestrator `_principal_of` 一致);
    # 但"存在却脏"(非 str / 空白)= 数据损坏,原样传给 authorize 由其硬拒,绝不回退掩盖污染。
    principal = "local_user" if raw_principal is None else raw_principal
    origin_run_id = getattr(parent_session, "run_id", None)

    def _profile_lookup(pid: str) -> Mapping[str, Any] | None:
        prof = profile_loader(pid)
        return project_agent_profile(prof) if prof is not None else None

    return authorize_delegation_request(
        request,
        source_backend=source_backend,
        enabled=enabled,
        depth=depth,
        origin_principal=principal,
        origin_run_id=origin_run_id,
        parent_tool_call_id=parent_tool_call_id,
        inventory=inventory,
        parent_effective_tools=parent_effective_tools,
        parent_effective_plugins=parent_effective_plugins,
        parent_allows_privileged=parent_allows_privileged,
        parent_budget_remaining_seconds=parent_budget_remaining_seconds,
        profile_lookup=_profile_lookup,
        pay_scan_classifier=pay_scan_classifier,
        trace_id=trace_id,
    )
