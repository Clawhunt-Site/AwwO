# 跨 Runtime 委派规划（Cross-Runtime Delegation）

> 本文规划 SuperClaw 的"委派（delegation）"能力，覆盖两个正交方向：
> - **向内（inward）**：在一个 chat session 里，主 agent runtime 根据对话内容、按标准格式发起一次**受治理的跨 runtime 子任务委派**（如 Claude chat 把一段子任务甩给 Codex / Gemini，并为目标 runtime 选定模型）。
> - **向外（outward）**：把 SuperClaw 这层**受治理的交付能力**，作为 MCP server / 工具暴露给外部代理（外部 Codex / Claude Code）调用。
>
> 两个方向**共用同一条 spawn 治理通道**（`spawn_child_runs` + Intent 拦截 + equipment 收窄 + depth/budget 封顶 + 人审门），绝不各起炉灶。
>
> **评审留痕**：向外方向（§4）的设计已经过 Codex（gpt-5.5）与 Gemini 两路独立对抗式评审（简报 `/tmp/superclaw-subagent-brief.md`，transcript 落 `.codex-cli-advisor/`、`.gemini-cli-advisor/`），两位均判"该做但必须改名改边界"，本文已吸收其全部阻断性意见。向内方向（§2、§3）与委派开关控制面（§5）为**待验收草案**，实施前每个 PR 仍须按项目 CLAUDE.md 铁律重新走 Codex+Gemini 验收门。
>
> **Roadmap integration status（2026-06-16）**：Cross-runtime P1 review/hardening 已在 `codex/roadmap-cross-runtime-p1-integrate` worker branch 上集成到 `dev/roadmap` 基线：P1-2a durable broker suspension、P1-2b/P1-3 child result review gate、API/CLI review surface、parent-state RMW hardening 均进入本分支。向外 MCP/P2 仍未实现，不能据此标记 Cross-runtime delegation 全量完成。
>
> 关联：[[unified-task-entry]]、[[runtime-selector-chain]]、[[agent-team-kernel-execution-plan]]、[[permission-mode-framework]]、[[streaming-tool-events-fix-plan]]、[[capability-workshop-roadmap]]。

---

## 0. 北极星原则

> **委派的价值不在"能孵化 agent"（这是 commodity，底层 runtime 原生就有），而在那层受治理的控制面：实时可用性、跨 runtime、equipment 只能收窄、预算/深度封顶、pay·scan fail-closed、人审完成门、evidence。委派只是"模型 proposes、内核 disposes"——模型读事实清单提议，内核独占裁决与执行。**

派生护栏（每条都对照铁律）：

1. **不重造通用 spawner。** 多数底层 coding-agent runtime（claude-code/cursor/opencode 等，以 inventory 的 `task_spawn` 为准；codex exec 与 SuperClaw 的 gemini/anthropic **API-agent loop** 则不原生 spawn）已能孵化子 agent；SuperClaw 复用它们的裸 fork 能力（经 adapter 归一化成统一 TaskEvent），**但每一次 spawn 都必须被内核治理包裹**。绝不允许底层 runtime 绕过内核自己拉起带 I/O 的"幽灵进程"。
2. **强制门是"工具的有无"，不是 prompt 的措辞。** 委派关闭 → `delegate` 工具根本不注入，模型物理上调不了；开启 → 工具注入 + 能力说明引导。靠 prompt 写"你不许委派"是靠模型听话，不是 fail-closed。
3. **标准格式 = 结构化 tool-call，这是治理的唯一拦截缝。** 自由文本"帮我在 codex 上跑这个"没有拦截点 = 治理形同虚设。必须是 `delegate(...)` 结构化调用，内核在 tool-call 缝强制校验。
4. **CLI 唯一事实源。** 委派开关是内核配置（`RuntimeConfigSpec`），不是前端独有滑块；可用 runtime 清单是 `build_agent_inventory` 这一份事实，所有表层只投影。
5. **fail-closed 默认。** 委派默认**关**（爆炸半径变大）；pay·scan 类任务的委派一律拒绝/人审；depth、budget、walltime 硬封顶；principal 绑定本地人类 owner。

---

## 1. 现状基线（已用代码核实，file:line 可信）

| 地基 | 状态 | 证据 |
|---|---|---|
| **实时可用 runtime 探测** | ✅ 已存在 | 每个 backend 有 `available()` → `BackendAvailability(available/executable/version/reason)`，做 `shutil.which`+版本探针+codex CLI 模式检测（`backends.py:53`）；16 backend 注册于 `default_backends()`（`backends.py:4166`）；`doctor` 逐个探活（`cli.py:1642`）|
| **统一可用 runtime 投影契约** | ✅ 已存在 | `build_agent_inventory()` 聚合：实时可用性 + `label` + `chat_capable`/`chat_tier` + `maturity` + `permission_presets`（含诚实 `interactive` 位）（`ui_contracts.py:251`）|
| **选 runtime 时选模型** | ✅ 已存在 | inventory 带 `supports_model_selection`/`default_model`/`suggested_models`（`ui_contracts.py:282`）；分层别名 `MODEL_ALIASES`（opus/sonnet/haiku→各 runtime 具体模型，`harness.py:312`）+ `resolve_model()`（`harness.py:373`）|
| **per-chat runtime/model 选择链** | ✅ 已存在 | runtime-selector-chain：direct chat 跟随 resolved runtime，sticky 由实际执行 turn 持久化 |
| **底层 runtime 是否原生 spawn 子 agent** | ✅ P0 已折叠进 inventory | `HARNESS_CAPABILITIES.task_spawn`：**codex=False**（codex exec 单 agent，无原生子 spawn）、**claude-code=True**、cursor/opencode=True。**P0 已由 `build_agent_inventory` 按 backend→harness 映射折叠投影**；无映射的 backend（含 gemini/anthropic backend——它们是 API-agent loop，**不是** Gemini/Anthropic CLI harness）诚实置 `task_spawn=None`，绝不臆造 True（`harness.py:151`、`ui_contracts.py`）|
| **治理 spawn 通道** | ✅ 已存在 | `spawn_child_runs` 接受 `agent_profile_id`，child 可带自己 backend/budget；additive、向后兼容（见 `docs/agent-team-kernel.md` Orchestrator integration）|
| **能力说明注入范式** | ✅ 已存在（可复用） | 插件投影开关（`runtime_config.py:170`）开启后投插件成工具 + 注入 `_capabilities_note`（`plugin_runtime_projection.py:247`）。委派开关是其架构同胞 |
| **任务适配画像（哪个 runtime 擅长什么）** | ✅ P0 已加 | P0 给每个 backend 加了简短 `strengths` 自由文本并经 `build_agent_inventory` 投影（判断线索，非路由规则）。早期 `HARNESS_CAPABILITIES.notes` 只是格式怪癖（如"skill 体≤8KB"）非任务强项 |
| 🔴 **任务→runtime 路由器** | ❌ 不存在 | `select_backends(policy)` 按 policy 字符串选，非按任务内容/适配选（`backends.py:4187`）|
| 🔴 **chat 内可触发的委派工具** | ❌ 不存在 | `spawn_child_runs` 未暴露成聊天模型可调的受治理 delegate 工具 |
| 🔴 **向外 MCP 委派入口** | ❌ 不存在 | 无 `submit_governed_task` 类 MCP/CLI 同义入口 |

**核心判断**：最基础那层——**实时可用 runtime 清单 + 每个 runtime 的模型选择**——已扎实存在（`build_agent_inventory` 即事实源）。真正缺的是上层四块：**适配画像、任务路由、chat 委派工具、向外 MCP 入口**。委派规划主要是"串联已有地基 + 补委派工具 + fail-closed 治理"，而非从零造。

---

## 2. 向内委派：四个逻辑问题的答案

用户提出的委派逻辑链，逐个对照地基：

| 问题 | 状态 | 方案 |
|---|---|---|
| **Q1 何时委派？** | 缺触发点 | 新增 chat 可触发的 `delegate` 工具（P1）。委派开关开启时才注入 |
| **Q2 委派逻辑？** | ✅ 地基就绪 | 包一层 `spawn_child_runs`（治理）：child 带 backend/budget + equipment 收窄 + 人审门。非新造 |
| **Q3 选哪个 runtime / 怎么知道它适合？** | ✅ P0 已补 strengths | **让编排模型自己读 inventory 选**，不建路由引擎。P0 已给 inventory 补简短 `strengths` 自由文本字段当判断依据 |
| **Q4 选什么模型？** | ✅ 地基就绪 | `suggested_models`/`default_model` + `MODEL_ALIASES` 分层别名 + `resolve_model()`。委派时传"目标 runtime + 模型档位" |

**关于 Q3 的关键裁决（待顾问验收）**：`build_agent_inventory` 已是一份机器可读事实清单（谁可用、能跑什么 model、chat_capable、task_spawn）。最符合"CLI 唯一事实源"的做法是 **让编排层模型读这份 inventory 自行决定委派目标**，内核只校验"该 runtime 真可用 + 治理放行 + 解析模型"。这样 Q3 那个"没有适配画像"的缺口，从**阻断项降级为可选增强**——P0 已补一个简短 `strengths` 文本（**不建路由引擎**）。静态规则路由（"凡 X 类任务一律走 Y runtime"）是虚假确定性，默认不做。

**关于"底层 runtime 是否会 spawn 子 agent"（用户单独问的点）**：经 SuperClaw CLI 调用时——
- **codex**（`codex exec`）：`task_spawn=False`，单 agent 执行，不会自发孵化子 agent。
- **claude-code**：`task_spawn=True`，可经 Task 工具原生孵化子 agent。
- 含义：当底层 runtime **会**自发 spawn 时（claude-code/cursor/opencode；以 inventory `task_spawn` 为准），必须在 adapter 层把"子 agent 诞生"当成 Intent 拦截上报、记一条带父 ID 的 run、强制套 equipment 收窄（护栏 1）；当**不会**时（codex exec、SuperClaw 的 gemini/anthropic API-agent loop），委派只能由 SuperClaw 这层显式发起。

---

## 3. 向内委派：落地设计

### 委派工具（标准格式）
聊天模型可调：`delegate(subtask, runtime?, model_tier?, profile?)`
- 模型 proposes：要委派的子任务 + 可选目标 runtime + 可选模型档位（opus/sonnet/haiku 或具体名）+ 可选 profile。
- 内核 disposes：读 `build_agent_inventory` 校验 runtime 实时可用 → equipment 收窄（profile.allowlist ∩ 治理投影）→ depth≤1 → budget/walltime 封顶 → pay·scan fail-closed → 才 `spawn_child_runs`。

### 实现为 tool-call → tool-result，不是"冻结 session"
父 turn 吐 `delegate` 工具调用 → 内核 spawn 受治理 child run（可跑别的 runtime）→ child 的 TaskEvent **作为嵌套任务流进同一个 chat session** → 父 turn 拿到 child 结果当 tool-result 继续。语义上"挂起等子结果"没错，但**实现上是标准工具循环，不是 session 冻结**。

### 两个硬约束（来自向外方向的双顾问裁决，向内同样适用）
1. **防衔尾蛇**：每个委派带 `trace_id`/`delegation_depth`/`origin_principal`；`delegation_depth ≤ 1`；禁止 SuperClaw worker 回调同一委派入口（防无限 fan-out/重复计费）。
2. **principal 绑定本地人类 owner**：预算/token/审批记其名下；委派结果完成仍走 `in_review → done` 人审门，禁止模型自批准。

### 硬依赖：流式
向内委派的体验完全压在"嵌套任务的 tool-event 能否在 chat 里实时显示"上——即 [[streaming-tool-events-fix-plan]] 的 Display Protocol。**流式不补完，委派工具上线就是"卡住不知道子 agent 在干嘛"。故 P1 排在 Display Protocol 落地之后。**

---

## 4. 向外委派：MCP 受治理任务委派（已过双顾问验收）

> 顾问一致结论：**把"暴露子 Agent 体系"这个词划掉**。对外部代理而言，SuperClaw 只是一个高可靠、需人审、能跑长链任务的**异步工具/函数**。该做的是暴露"任务委派（Issue delegation）"，不是"借你几个 agent 用"。内部是单体大模型还是拆 10 个子 agent，对外**100% 透明不可见**。

### 边界（fail-closed）
- **只暴露**：`submit_governed_task`（= 映射 `superclaw issue create`，字段白名单：workspace/title/description/requested_profile_id/budget_cap/permission_preset，全经 core 校验）+ 只读 `get_task_status`/`get_task_events`/`get_evidence_bundle`/`cancel_task`（cancel 也走 core 状态机，不许直接杀 worker 或改 DB）。
- **MCP handler 必须弱智化**：不碰 DB、不调底层库、不加独特业务语义；本质是 core command path / CLI 的薄包装；连 JSON 美化都得沉淀到 CLI formatter。一旦 MCP 有独特语义 = 第二治理入口 = 破铁律 1。
- **审批本地化**：外部代理只能 `get_status`/订阅，**无 approve 能力**；审批主体是本地物理人类 reviewer，禁止大模型自动点 yes。（顾问点名：`await_approval` 这个名字错，外部不应拥有 approval。）
- **principal 链**：至少区分四个身份——外部调用者 / SuperClaw workspace owner / 被委派 profile / 底层 runtime account；预算/权限/审批/日志全绑这条链。
- **预算硬封顶**：每个委派 task 有 max runs / max child depth / max tokens·cost / max walltime / max workspace locks；超限自动挂起到人审。

### 必须延后的深水区
外部直接 spawn child agents / 外部创建·改 profile / 外部传自定义 tools·equipment / 把 streaming 反抽回外部上下文 / 跨 SuperClaw 实例委派 / 自动审批 / pay·scan 类外部入口 / 多租户·组织级 ACL——全部 fail-closed 推迟。

---

## 5. 委派开关 + 能力说明注入（控制面，待验收草案）

### 滑块 = 内核配置，不是前端独有
落成 `runtime_config.py` 一条新 `RuntimeConfigSpec`（像 `configured_shell_*`）。Web 是滑块、CLI 是 shell 内 `/config set delegation true`（值仅接受 `true/false/1/0`，内核 fail-closed 校验；无 top-level `superclaw config set` 命令）——**同一份事实**，CLI/Web/Desktop 都投影。绝不只在前端加 React 滑块。

### 强制门 = 工具有无，prompt = 引导
- **关**（默认）：`delegate` 工具不注入，模型物理调不了。
- **开**：工具注入 + 能力说明注入（复用 `_capabilities_note` 范式）。

开关切换改变"能力面"，应触发 `capability_surface.py` 的 resume 守卫（能力变了，session 重新冻结）。

### 注入的能力说明至少含四块
1. **可用 runtime 清单 + 各自 strengths**（取自 `build_agent_inventory` + 新增 strengths 字段）——让模型有判断依据，自己读着选。
2. **精确工具格式**（`delegate` 的 schema、model_tier 取值）。
3. **何时该 / 何时别委派**——别为琐碎任务委派（浪费 token+延迟）；只在"另一个 runtime 明显更适合"时委派。
4. **硬边界**——depth≤1、不能自批准、完成仍走人审门。

### 粒度
默认 **per-chat**（与 runtime 选择器同级，每对话各自决定开关），可选一个全局默认值兜底。

---

## 6. 跨方向分期（共用一条 spawn 治理通道）

```
P0 地基收口（纯内核，低风险）
  · 把 harness.py 的 task_spawn/parallel_agents 等能力位并进 build_agent_inventory 统一投影
    —— 消除"两套能力描述符并行"（harness.py HARNESS_CAPABILITIES vs ui_contracts AGENT_CONTROL_SPECS）碎片化
  · 每个 runtime 加简短 strengths 自由文本字段（声明式，进 ui_contracts，CLI/Web 共享）
  · 新增 superclaw runtime list（JSON 输出：可用性∩模型∩能力∩strengths 一次出齐，CLI 事实源；沿用现有 runtime 子命令的 JSON-only 惯例，不另加 --json 旗标）
  · 委派开关 RuntimeConfigSpec（默认关）
        ▼
P1 向内 chat 受治理委派工具（核心价值）
  · delegate(subtask, runtime?, model_tier?, profile?) 工具 + 能力说明注入（开关开启时）
  · 内核：读 inventory 校验可用 → spawn_child_runs 治理包裹（equipment 收窄/depth≤1/budget·walltime 封顶/pay·scan fail-closed）
  · 实现为 tool-call → tool-result，嵌套 TaskEvent 流进同一 chat
  · 2026-06-16 roadmap worker integration: 已集成 durable child broker wait、child result 人审 gate、API/CLI delegate-review surface、parent-state RMW hardening；仍限向内 P1 review/hardening
  · ★ 依赖 Display Protocol 流式落地，排其后
        ▼
P2 向外 MCP 受治理任务委派
  · submit_governed_task + 只读查询/cancel，全经同一 core command path
  · MCP handler 弱智化、审批本地化、principal 链、预算硬封顶
        ▼
P3 适配辅助（增强，非必需）
  · 模型读 strengths 自选（先做这个，省掉路由引擎）；选不动则**不委派**、留在当前 chat runtime（fail-closed：拿不准就不扩大爆炸半径，绝不"猜一个 runtime"开委派）
  · 静态规则路由：默认不做；真做也标"非约束建议"
```

---

## 7. 评审留痕

- **向外方向（§4）**：Codex（gpt-5.5）+ Gemini 均判"该做但必须改名改边界：做外部提交受治理任务，不做外部调用子 agent 体系"；本文已吸收全部阻断性意见。无阻断性分歧。transcript：`.codex-cli-advisor/transcripts/subagent-roadmap.jsonl`、`.gemini-cli-advisor/transcripts/subagent-roadmap.jsonl`。
- **向内 P0 地基已实现**（PR #238，分支 `feat/cross-runtime-delegation-p0`，Codex+Gemini 双 PASS）：inventory 折叠 harness 能力位（`task_spawn`/`parallel_agents`，无 harness 映射者诚实置 `None`）+ 每 runtime `strengths` 自由文本 + `superclaw runtime list` CLI 事实源 + shell-scoped `delegation` 开关（`delegation_enabled()` fail-closed bool，默认关）。纯内核地基，无委派工具（P1）。
- **向内方向（§2/§3）委派工具**：待验收草案。核心判断 = "让模型读 inventory 自选、而非建路由引擎"。实施前每个 PR 须按 CLAUDE.md 铁律重新走 Codex+Gemini 验收门。
- **共识基线**：委派价值 = 受治理控制面而非 spawn 本身；两方向共用一条 spawn 治理通道；强制门 = 工具有无；标准格式 = 结构化 tool-call；fail-closed 默认关。
