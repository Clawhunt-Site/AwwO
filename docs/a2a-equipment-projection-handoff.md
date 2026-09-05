# 交接：Agent Team Kernel §2.6 item4「装备投影」治理漏洞 — 分层修复

> 状态：**第 1 层（投影层收窄）+ 第 2 层（proxy 执行层 grant gate）已完成并经 Codex + agy 三轮对抗验收双通过 → 本 PR(#279) 交付。** 第 3 层（cross-runtime 委派 plugin grant）**单独 PR 跟进**（连带修一个既存 bug，见下）。
> 第 1+2 层闭合了 **team-bound 单 runtime** 的装备投影漏洞：team agent 的可投影/可调用插件面被收窄到 `equipment.granted`，越权在 proxy 执行层 fail-closed。第 3 层是 cross-runtime 委派路径，未在本 PR 范围。

## 漏洞（审计 main 6c93622 发现）
设计 `docs/agent-team-kernel-execution-plan.md` §2.6 item4 要求"只投影 granted 工具 schema，granted 空则不投影，越权调用 MCP 层 fail-closed"——**未实现**：
- `build_runtime_plugin_policy_addition` 投影**全部** `available_plugins`，不按 agent `equipment.granted` 收窄。
- proxy `entitlement_file` 是**全局**信任链（签名/吊销/policy），**不查 per-agent grant**。
- `equipment.granted` / cross-runtime `delegated_tools` 算了存了显示了，**从不收窄实际投影出去的 MCP 工具面**。
→ 只授予插件 X 的 team agent 实际拿到所有已签名插件并能调用。

## 已做（第 1 层 · 投影层收窄 + fail-closed，本分支）
文件：`plugin_runtime_projection.py`、`orchestrator.py`、`tests/test_plugin_runtime_projection.py`（24 passed，零回归，ruff 干净）。
1. `build_runtime_plugin_policy_addition(..., allowed_plugin_ids)`：非 None 则按 plugin_id 收窄；**空集→不投影任何插件（fail-closed）**；None→非 team run 全集（零变化）。
2. `_project_plugins_into_policy(..., allowed_plugin_ids)` 透传；**team-bound 时 replace（非 append）mcp_configs 并清 plugin_dirs**——剥离已有/注入的 single-plugin config，不让未授予插件经旧 config 重新暴露（Codex finding 3）。
3. `_granted_plugin_ids(session)`：非 team run→None（全集）；team-bound→`equipment.granted`（空集也 fail-closed）；**有 agent_profile_id 但 context 缺失/损坏→frozenset() 不放行全集**（Codex finding 2）。

## 已做（第 2 层 · proxy 执行层 grant gate + fail-closed，本 PR）
文件：`plugin_proxy.py`、`plugin_mcp_proxy.py`、`plugin_runtime_projection.py`、`orchestrator.py`、`tests/test_plugin_equipment_enforcement.py`、`tests/test_plugin_runtime_projection.py`。
1. **choke point**：`invoke_cached_plugin_tool(..., granted_plugin_ids)` —— 所有调用路径（aggregate / single proxy / 直调）汇聚于此；非 None 且 `plugin_id ∉ granted` → 在 `_load_cached_package` **之前** fail-closed 返回 `PLUGIN_NOT_GRANTED`（未授权 id 不触发 install/签名/entitlement 侧信道）。
2. **可信源**：grant 经权威 `--allowed-plugins` argv 注入（已启动进程参数不可篡改）；`plugin-set.json` 的 `granted_plugin_ids` 仅 snapshot **fallback**（在 run artifact dir，full-shell 可改）；argv 优先；空串 = fail-closed 空 grant；畸形 snapshot 值 → `frozenset()`（fail-closed）。
3. **single-plugin proxy**：`_grant_denied()` 在 `_projected_tools`/`_tool_route` 的 load **之前** gate（不 load 未授权包）；`main serve` 启动层拒未授权 `plugin_id`（`return 1`）。
4. **team-bound 投影早退 fail-closed**：`_team_bound_surface_stripped` 统一 4 个早退点（auto-project 关 / 非 MCP backend / 投影异常 / 空 grant）——team-bound 一律 strip 旧 `mcp_configs`/`plugin_dirs`，非 team(None) 零行为变化。
5. **纵深**：`AggregatePluginMcpProxyServer._build_catalog` 类级 `plugins⊆granted` 跳过（direct construction 也不 load 未授权）。

**诚实边界声明**：第 2 层对 **contained agent**（不能篡改 orchestrator 生成的启动配置）闭合。**full-shell agent**（能改 plugin-set / 自启 proxy / 调 operator CLI）**不在此闭合** —— 那是 backend **containment contract（T11）** 的职责，per-agent grant 不假装密闭。`cli.py plugin call` 是 operator 旁路，不做基于 env 的自动收窄（伪安全）。

验收：Codex(gpt-5.5) + agy(gemini-3.1-pro) 三轮对抗验收，R1 抓 single proxy gate-too-late、R2 抓 team-bound 早退 fail-open（均已修），**R3 双通过**。

## 待做（第 3 层 · cross-runtime 委派 plugin grant，单独 PR）
- **既存 bug（本 PR 揭示，非本 PR 引入）**：`authorize_delegation_request` 里 `child_tools = parent_effective_tools ∩ profile_grants`，但 `parent_effective_tools` 是核心工具名（`read_file` 等），`profile_grants` 是 `plugin_allowlist + skill_allowlist`（插件/技能 id）——两者语义不同源，**交集恒空 → 任何指定 profile 的 cross-runtime 委派当前都被拒**（`equipment intersection is empty`）。
- **修法（双顾问设计裁定）**：双轨分离。核心工具轨（`delegated_tools`）与 plugin grant 轨独立；给 `authorize_delegation_request` 引入 `parent_effective_plugins`；`child_plugin_grants = parent_effective_plugins ∩ profile.plugin_allowlist`（no-profile 继承 parent）；plugin grant 走 canonical `agent_run_context.equipment.granted`；删 `_granted_plugin_ids` 的 `delegated_tools` 分支（不再把核心工具名当 plugin_id）；改测试里 `plugin_allowlist=["read_file"]` 的错误语义。

## Backlog（非阻断，验收记录）
- **team-bound startup 仍全量枚举本地包**：`build_runtime_plugin_policy_addition` 先 `available_plugins()` 枚举所有本地包再按 `allowed_plugin_ids` 过滤——不是 agent 可触发路径、不暴露未授权工具（Codex R3 判非阻断）；若未来铁律升级为"team-bound startup 绝不触碰未授权 package"则需前置过滤。
- **argv 逗号分隔**：`--allowed-plugins` 用逗号拼装；plugin_id 命名规范禁逗号故安全（agy R3 判非阻断）；若命名规范放宽需换分隔。
