# Layer 3 设计：cross-runtime 委派 plugin grant（§2.6 item4）

> 状态：设计定稿（Codex gpt-5.5 + agy gemini-3.5-flash 双顾问 + 路线图 + 主代理综合裁定）。实现于 `feat/a2a-cross-runtime-equipment`。

## 目标（路线图 §2.6 item4 / L62 / L64）
cross-runtime 委派的子 run 必须**只见自己 granted 的插件，不继承父全集，越权 fail-closed**。unknown profile 不 best-effort 继承父上下文。

## 当前 main 现状（已核验）
- `delegated_tools` = 核心工具名（read_file/run_shell/...），**不是 plugin_id**；child_spec 不写任何 plugin grant。
- 既存 bug：`child_tools = parent_effective_tools(核心工具) ∩ profile_grants(plugin+skill id)` 恒空 → 指定 profile 的委派**总被拒**（测试用错误 mock 掩盖）。
- `_granted_plugin_ids`：no-profile 委派 → 无 team 信号 → `None`（**全集 fail-open**）；profile 委派 → `equipment.granted = profile.allowlist ∩ 全局`（**缺父约束，可能提权**）。

## 核心安全不变量
**子 run 的 plugin grant 绝不超过父**（`child_plugins ⊆ parent_plugins`）——取交集天然保证，即便 agent 伪造高权 profile_id 也不能提权。

## 定稿方案（双轨分离，plugin grant 绝不复用 delegated_tools）

### 1. core-tool 轨（修既存 bug）
`child_core_tools = parent_effective_tools`（profile 不收窄核心工具——profile 管装备[plugin/skill]，核心工具归 posture/containment）。存 `delegated_tools`。`profile_grants` 空**不再** deny 整个委派；保留 fail-closed 形状校验（missing/非 list/脏元素 deny，显式空 list 允许）。

### 2. plugin 轨
- `authorize_delegation_request` + `authorize_delegation_for_parent` 加参数 `parent_effective_plugins: frozenset|None`（父 granted plugins；None=非 team 父）。
- `project_agent_profile` 拆出 `plugin_grants`（只 `plugin_allowlist`，独立于 skill；用 resolved equipment 非 raw allowlist）。
- `child_plugin_grants`：
  - profile 指定：`parent_effective_plugins ∩ profile_resolved_plugins`（父 None → 仅 profile，因父无 cap）。
  - no-profile：继承 `parent_effective_plugins`（父 None → None，非 team 兼容）。
- **落地（两条互斥路径，避免双源漂移）**：
  - **profile 委派**：改 `build_agent_run_context(..., parent_plugin_constraint)`，令 `equipment.granted = resolve_equipment(profile).granted ∩ parent_plugins`（**单一源**，含父约束，防漂移+防提权）。
  - **no-profile 委派**：写内核字段 `execution_context["delegated_plugin_grants"] = sorted(parent_plugins)`（因 no-profile 无 agent_run_context；这是内核 state 字段非表层 API，不违反"表层零新增语义"）。

### 3. `_granted_plugin_ids`（消费，单一判定）
优先级：① `agent_run_context.equipment.granted`（profile/team run）；② `delegated_plugin_grants`（no-profile 委派，plugin_id 语义）；③ team/delegation 信号存在但 grant 缺失/畸形 → `frozenset()`（**fail-closed**，不回落 None）；④ 非 team 非委派 → `None`。**绝不读 `delegated_tools` 当 plugin id**。delegation 信号 = `delegation_depth`/`origin_run_id` 存在。

### 4. 可信源 / 防伪造
`delegated_plugin_grants` + child agent_run_context 只由 broker（`_create_linked_child`）生成写入 state；`spawn_child_runs` 的用户/API spec **不接受伪造** plugin grant 字段。child ⊆ parent 不变量兜底。

### 5. 诚实边界
layer 3 只收窄 **plugin 装备**。**核心工具（shell 等）的收窄归 PermissionPolicy/containment**（agy Q6 后门提醒）——layer 3 不声称收窄核心工具，与 layer 2「full-shell 归 T11」边界声明一致。parent full/bypass + profile 非特权时核心权限收窄是 PermissionPolicy 的 min 规则，不在本 PR。

## 顾问分歧与裁定留痕
- **no-profile（Q1/Q2）**：Codex「继承父」vs agy「fail-closed 空」→ 裁定「显式继承父+缺字段 fail-closed+child⊆parent」（调和两者，受控继承非 fail-open）。
- **新字段（Q4）**：agy 反对（误引表层铁律）vs Codex 新字段→ 裁定「profile 走 equipment.granted 单一源，no-profile 走内核字段 delegated_plugin_grants」（互斥不双源）。

## 测试覆盖
no-profile team 父继承、non-team+profile、profile 插件超出父被收窄（防提权）、unknown profile deny、缺失/畸形 delegated_plugin_grants fail-closed、prompt 不漂移（equipment.granted 与投影一致）、既存 mock 错误语义修正。
