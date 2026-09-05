# 统一任务入口（Unified Task Entry）

> **状态：意图文档（intent）。记录架构方向与"过时标记"，先减复杂度，不做大重构。**

## 0. 一句话

**取消 `chat` / `task` / `delivery` 三分叉，所有输入统一走一条「task 路径 = 底层 agent runtime 路径」。** chat 入口回归"纯粹"：默认就是对底层 agent runtime 的**原生流式访问**；`@plugin` / `@skill` / ID 是在**同一条路径上额外叠加**的能力，最终都经 MCP proxy 服务到 runtime。`delivery` **现在略过、打过时标记**，以后做成"Agent 公司（多 agent 协作）"。输出继续用现有 **SSE 流式**。runtime **不锁死 codex**——入口统一、runtime 可插拔。

## 1. 为什么（动机）

- 现状是**一次 `classify_intent` 分出三条岔路**（chat / task / delivery），三条用了**三套不同的执行基座**（chat=codex 子进程 read-only / task=codex app-server 线程 / delivery=orchestrator 全管线），事件格式与回流路径各不相同——这是"复杂"的根源。
- 用户的目标是**先得到一个非常纯粹的 chat**：它本质就是"对底层 agent runtime 的一次原生流式访问"。在这个纯粹底座上，未来再叠加配置（如把 delivery 做成"Agent 公司"、多 agent 协作）。
- 如果现在就把 chat / delivery 在入口处分叉固化，未来要做"公司"会很难操作。**所以现在不分叉，统一到 task（agent runtime）这一条。**

## 2. 目标终态

```
任意输入  ──▶  统一入口（一条路径）  ──▶  底层 agent runtime（可插拔）  ──SSE──▶  流式输出
                    │
                    └── 叠加层（可选，额外能力，最终都服务到 runtime）：
                          @plugin:<id>   → 经 MCP proxy 投影 + 治理
                          @skill:<id>    → 同一套 MCP proxy（SKILL.md 只是指针）
                          其它 ID / 配置 → 同样落到 runtime
```

要点：
1. **入口只有一条**：不再有"chat vs delivery"的业务分叉。chat = 不带任何叠加层的纯 runtime 访问。
2. **runtime 可插拔**：codex 只是**第一个实现**；入口与具体 runtime 解耦，未来能接 claude / gemini 等的流式 runtime。
3. **plugin / skill 是叠加层**：原生路径不含它们；它们是"额外添加"，经统一的 MCP proxy + fail-closed 治理服务到 runtime。
4. **输出统一 SSE 流式**（沿用现有 `/api/chat/stream` 模式）。
5. **delivery → 公司**：重的多角色编排 + 验证以后表达为一个"Agent 公司"，不再是入口处的硬编码分叉。

## 3. 当前现状（已在真实代码核实）

### 3.1 三分叉与三套基座
- 分类：`chat_turn.classify_intent`（`chat_turn.py:25`）——纯关键字：`@delivery`/`/delivery`→delivery；`@plugin:`→task；其余→chat。
- 分发：`apps/api/main.py` 的 `/api/chat/stream`（~2509）：
  - `chat` → `execute_direct_chat_turn`（**codex 子进程**，`--sandbox read-only`，不进 orchestrator、无验证）。
  - `task` → `codex app-server` 长驻线程（流式、可工具调用、inline 单 IMPLEMENT run）。
  - `delivery` → `orchestrator.start_existing_goal`（后台线程，5 角色 + adversarial）。

### 3.2 插件参与的时机与机制（回答"plugin 何时、如何到 runtime"）
- **注入时机 = 建 codex 会话时（每会话一次，不是每 turn 重注）**：
  - `_chat_plugin_projection`（`main.py:~814`）→ `plugin_runtime_projection.build_runtime_plugin_policy_addition`：
    1. `available_plugins()` 是 **fail-closed 门**，先把"通不过验签/entitlement/policy"的插件**直接剔除**（投影时治理）。
    2. 写出自包含快照 `superclaw-plugin-set.json` + `superclaw-plugins.mcp.json`。
    3. 返回 `-c mcp_servers.superclaw...` 形式的 `extra_args`。
  - `_get_chat_codex_session`（`main.py:~759`）把 `extra_args` 传给 `CodexAppServerClient`，最终成为 `codex app-server --listen stdio:// -c mcp_servers.superclaw...` 的**命令行参数**。
  - 注：`extra_args` 变化（纯 chat ↔ 带插件）会**触发会话重建**。
- **所有插件调用都回流 MCP proxy 治理**：
  - runtime 调 `superclaw__<plugin_id>__<tool>` → `plugin_mcp_proxy` 的 stdio 进程 → `plugin_proxy.invoke_cached_plugin_tool` 跑 **10 层 fail-closed 治理门**：加载缓存包 → 验签/吊销 → 工具声明 → entitlement（pay-switch）→ runtime policy → 注入密钥 → ClawHunt 账户桥 → 沙箱 preflight → 执行 sidecar → 输出处理（图片提取/密钥脱敏/裁剪未声明字段/输出预算/schema 校验）。
  - **治理裁决两次**：投影时 filter（只 offer 通过门的）+ 执行时 re-check（纵深防御）。
  - codex app-server 收到 MCP elicitation 时 `accept_mcp_tool=True` 自动放行——**真正的治理在 proxy 执行那一步**，不是在 runtime 放行那一步。
- **skill 现状**：走**同一套 MCP proxy**。`SKILL.md` 只是 B-fast 指针（指向 MCP tool + schema），不自包含、不带可执行/密钥；执行仍回流 proxy 重新治理（`skill_sync.py` 的设计原则）。`@skill` 入口在统一路径下应与 `@plugin` 同构。

### 3.3 runtime 抽象的真实短板（关键约束）
- **目前只有 `codex app-server` 支持「流式 + persistent thread + MCP 注入」**（`codex_app_server.py`）。
- `ClaudeCliBackend` 走 CLI 子进程 + `--mcp-config`，**无 JSON-RPC 流式回调**；`Hermes`/`Bobo` 不支持 MCP；`local` 无。
- `local_agent_runtime.LocalAgentRuntimeSpec` 已有 runtime 能力描述（`kind`/`transport`/`session_strategy`/`supports_mcp_configs`），但流式 app-server 路径**只有 codex 一个实现**。
- **结论：用户要的"统一入口对接全套 runtime"目前并不存在——只有 codex 这一条流式通路。** 统一入口要做成 runtime 无关，但近期 codex 仍是唯一可用实现。

### 3.4 落地前发现的两个真实缺口（三方核实）
1. **纯 chat 现在并非零开销**：`/api/chat/stream`（`main.py:2610`）对**每个 turn 无条件**调 `_chat_plugin_projection`（默认 `SUPERCLAW_AUTO_PROJECT_PLUGINS=1`），即使消息里没有 `@plugin`，也会跑一遍 fail-closed 门扫描 + 写快照 + 把 `extra_args` 计入会话 key。**违背"纯 chat 零开销"目标**。→ 必须改 lazy：纯 chat 不投影（`extra_args=[]`），只有显式叠加层才 resolve。
2. **`@skill` 入口在分类层根本没解析**：`chat_turn.py:14` 只有 plugin marker 正则，没有 `@skill` resolver。文档说"skill 走同一套 MCP proxy"在执行层成立，但**入口层尚未把 `@skill` 解析成 overlay**。→ 不能文档说统一、代码只有 plugin，需补 `@skill` resolver。

## 4. 过时标记（先软废弃，不破坏行为）

以下被标记为**过时（deprecated）**，指向本文件，等统一入口落地后移除/改写：

- `chat_turn.classify_intent` 的 **`delivery` 分支** —— delivery 不再是入口分类，未来由"Agent 公司"承载。
- `chat_turn.classify_intent` 的 **`chat` vs `task` 二分** —— 目标是合并：纯 chat = 无叠加层的 task；`@plugin`/`@skill` = 带叠加层的 task。最终 `classify_intent` 退化为"是否带叠加层 + 叠加了什么"，不再产出三种业务 intent。
- `execute_direct_chat_turn`（codex 子进程 read-only 那条）—— 目标是**统一到 codex app-server 流式那条基座**，废弃这条并行子进程路径。
- `apps/api/main.py` 中 `intent == "delivery"` 的分发块、`_run_profile_for_intent` 的 delivery 分支 —— 随 delivery→公司 一并迁出。
- `SHELL_MODES` 里的 `"delivery"` 模式 —— 随上同。

> 软废弃方式：在 docstring/注释加 `DEPRECATED:`（指向本文件），**保留现有行为与路由名作为 alias**，不改测试，等统一入口落地再实际移除。

## 4.5 落地进度（实事求是）

**已落地（worktree `feat/unified-task-entry`，commits c825ed2 / dcc82c8 / d2a9d35）：**
- **PR-3 lazy overlay**：纯 chat 不再投影插件（`extra_args=[]`），恢复零开销原生 chat；仅 overlay турн才跑 fail-closed 门 + 快照。✅
- **PR-2 adapter 层（substrate）**：`agent_runtime.adapter` 的 `RuntimeCapabilities`/`AgentRuntimeAdapter`/`AgentRuntimeManager` + `CodexAppServerRuntimeAdapter`(full) + `ClaudeRuntimeAdapter`(declared-degraded)；handler 已用 manager 做 **runtime_id 解析 + 能力协商**（overlay 落非-MCP runtime → fail-closed；非-codex runtime 诚实拒绝、不静默回退 codex）。✅
- **parse_chat_route + `@skill` 解析器**：单 runtime turn + overlay 抽象就位；`classify_intent` 保留为弃用别名。✅
- **delivery 软废弃**：`@delivery` 仍跑旧编排，但发 `delivery.deprecated`（replacement=runtime_turn, future=agent_company）。✅
- 测试 +22 全过；全套 905 passed（2 个 pre-existing 基线失败 + 3 个 pre-existing skill_sync 收集错误，均与本改动无关）。

**第二增量已落地（commit bc12215）：**
- **执行委托**：chat turn 的执行现在走 `adapter.run_turn`（`RuntimeTurnRequest`→`RuntimeTurnResult`），handler 不再直接调 codex session——未来 runtime 可 drop-in。`ensure_started()` 保留给 `needs_history` 且与 adapter 内部 start 幂等。✅
- **`@skill` overlay 投影**：`@skill:<id>` 路由为 overlay task（投影 plugin/skill catalog），不设 sticky plugin。✅
- **`/api/chat/direct` 兼容壳**：标记为 deprecated legacy（响应带 `deprecated`/`replacement`）。✅

**第三增量已落地（commit 5be5173，经 Codex/Gemini 确认后实施）：**
- **`classify_intent` 改为 `parse_chat_route` 的 legacy 投影**：内核只有一个路由器；`forced mode → 该 mode；delivery 标记 → "delivery"；任一 overlay → "task"；否则 "chat"`。**`@skill` 在 CLI shell 与 Web/API 由构造保证路由一致**（铁律缺口闭合）。✅
- **"task" = overlay turn ≠ plugin turn**：skill-only turn 用专属 `_skill_task_prompt`（同一受治理 MCP proxy，但不带 plugin 的支付映射规则）；plugin prompt 仅在有 plugin/sticky id 时使用；API resolver 中重复的 @skill 解析已删除（表层不复制内核解析）。✅
- 投影等价性有 property 测试锁定（`classify_intent` 永不与 plan 分歧）。911 passed。

**第四增量（收尾）已落地（commit 935dbb1）：**
- **`/api/chat/direct` 真兼容壳**：新增 adapter `run_oneshot`（`RuntimeOneShotRequest`→`RuntimeTurnResult`）；codex adapter 用 `codex exec`（一次性 turn 的正确工具，非 app-server）。endpoint 经 manager 解析 runtime 后走 one-shot，fail-closed（未知/未接线 runtime），仍标记 deprecated——**执行路径不再分叉**。✅
- **delivery 隔离**：`@delivery` 分支抽成命名清晰的 `_run_legacy_delivery_turn` 助手，与统一 runtime 入口完全分离，便于将来改 Agent 公司时整块移除。✅

**剩余（第二阶段独立工程，非收尾，经 Codex/Gemini 明确分期）：**
- Claude/其他 runtime 的**实际流式执行未接线**（仅声明 capability，overlay/turn 落它们会 fail-closed `RUNTIME_CAPABILITY_UNSUPPORTED`，不静默降级）。
- CLI shell 的执行基座仍是 `_execute_direct_chat_turn` 子进程（**路由已与 Web 一致**；执行形态切 app-server 流式是独立工程）。
- delivery → 真正的"Agent 公司"（`company_runtime`/`multi_agent_runtime`）重写。

## 5. 落地方向（三方定稿，分 3 个 PR）

**总原则（Codex）**：先统一**产品入口与事件协议**，能力边界做成 **runtime-agnostic**，但**底层默认实现仍是 codex app-server**——诚实承认"runtime 无关"现在只是边界设计，不是能力事实。第一阶段不假装 Claude/Hermes 已等价。

### PR-1 路由收敛（Route cleanup）
- 把 `classify_intent` 从"决定执行路线"**降级**为"解析 turn overlay"，并改名 `parse_chat_route` / `plan_runtime_turn`。它**不再**返回 `chat/task/delivery` 拓扑，只产出 `RuntimeTurnPlan{ runtime_turn, overlays, deprecated_markers, budget_hint }`。`@plugin`/`@skill`/ID 只影响 overlay，不改执行管线。
- `/api/chat/stream` 默认只走一条：`resolve_runtime → resolve_overlays → open/reuse session → run_turn → 统一 SSE`。
- `_execute_direct_chat_turn`（`chat_turn.py:79`）与 `/api/chat/direct`（`main.py:~2791`）**改成兼容壳**：内部调同一 runtime service、收集最终文本返回；不立即删。
- `@delivery` 不再是默认主路径，降为 **legacy branch**：发 `delivery.deprecated` 事件、返回 `deprecated=true, replacement="runtime_turn", future="agent_company"`；旧编排保留为 `legacy_delivery_orchestrator`，**不混进**新 runtime 抽象。

### PR-2 Runtime adapter（可插拔边界）
- 补真正的可执行接口（不要继续扩大 `_get_chat_codex_session`）：
  ```python
  class AgentRuntimeAdapter:
      def spec(self) -> LocalAgentRuntimeSpec: ...
      def capabilities(self) -> RuntimeCapabilities: ...
      async def open_session(self, request: RuntimeSessionRequest) -> RuntimeSession: ...
      async def run_turn(self, session, request: RuntimeTurnRequest, event_sink) -> RuntimeTurnResult: ...
      async def close_session(self, session_id: str) -> None: ...
  ```
- **能力分项声明**（不要一刀切）：`supports_streaming / persistent_thread / mcp_config / mcp_hot_reload / tool_events / interrupt / history_replay / approval_policy / usage_events`。
- **一等 runtime 最低标准**：标准事件（`message.delta/tool.started/tool.completed/message.completed/error`）+ 可取消/超时 + session 语义（原生 persistent thread 或 SuperClaw history replay）+ 声明是否支持 MCP overlay + tool/plugin 事件归一到同一 SSE schema + **fail-closed 不静默降级**。
- **诚实能力矩阵**：codex app-server = 完整实现；Claude CLI = 部分（有 `stream-json`+`--mcp-config`，无 persistent JSON-RPC thread，见 `claude_stream.py`）；Hermes/Bobo = 非 plugin-capable。
- **硬降级规则**：纯 chat 可降级 batch/history replay；需 streaming 但不支持 → 一次性 `message.delta`+`message.completed` 且 metadata 标 `streaming=false`；**需 plugin/skill overlay 但不支持 MCP → 直接 `RUNTIME_CAPABILITY_UNSUPPORTED` 失败，不假装执行**；需 persistent thread 但不支持 → replay 最近 N 条且暴露 `session_strategy=history_replay`。
- **防锁死 codex**：API 参数用 `runtime_id`（不是 `direct_chat_backend`）；内部入口 `AgentRuntimeManager`；codex 专有逻辑全部关进 `CodexAppServerRuntimeAdapter`；SSE schema / overlay request / session request / capability negotiation 全部 runtime-neutral、独立定义。

### PR-3 Lazy overlay（兑现"纯 chat 零开销"）
- 默认纯 chat：**不投影任何 plugin/skill，`extra_args=[]`**（修 §3.4 缺口 1）。
- 只有显式 `@plugin` / sticky plugin / `@skill` / ID 引用才 resolve overlay；**粒度按需**（`@plugin:pay-switch` 只投影该插件；用户要"列出/选择插件"时才投影 dispatch catalog；sticky 保持到清除/切换）。
- 补 **`@skill` resolver**（修 §3.4 缺口 2）：把 skill 解析成 plugin-origin tool overlay 或 native skill prompt overlay。
- overlay 变化就重建 session（codex 暂不支持 MCP hot reload）——现有 `_get_chat_codex_session` 已按 `extra_args` 差异 close/rebuild + `resume_thread_id`，是可用的最小实现。
- 治理仍两层不变：投影 filter（`plugin_runtime_projection.py`）+ 执行 recheck（`plugin_proxy.invoke_cached_plugin_tool`）。

## 6. 已定的关键决策（三方一致）

- **`classify_intent` 终态**：改名 + 降级为 overlay 解析器，不再产出业务 intent。
- **delivery**：软废弃 = 兼容层（alias + warning metadata + legacy 事件），**不是新架构的一部分**；旧编排隔离为 `legacy_delivery_orchestrator`；"Agent 公司"未来另起 `company_runtime` / `multi_agent_runtime`，不借用 `delivery` 这个词扩写。
- **runtime 无关 = 边界设计，不是能力事实**：第一阶段统一入口 + 事件协议，codex 仍是唯一 full-capability runtime；第二阶段逐个补 Claude/Hermes 的 degraded adapter（但必须声明 capability，不偷偷换语义）。

## 7. 关键文件

| 关注点 | 文件 |
|---|---|
| 意图分类（待退化） | `packages/superclaw/src/superclaw/chat_turn.py` |
| chat 分发 / 插件投影 / 会话 | `apps/api/main.py`（`/api/chat/stream`、`_chat_plugin_projection`、`_get_chat_codex_session`、`_plugin_task_prompt`） |
| codex 流式 runtime | `packages/superclaw/src/superclaw/codex_app_server.py` |
| runtime 能力描述 | `packages/superclaw/src/superclaw/local_agent_runtime.py` |
| 后端矩阵 | `packages/superclaw/src/superclaw/backends.py` |
| MCP 投影 | `packages/superclaw/src/superclaw/plugin_mcp_proxy.py`、`plugin_runtime_projection.py` |
| 插件治理门 | `packages/superclaw/src/superclaw/plugin_proxy.py`（`invoke_cached_plugin_tool`） |
| 技能投影 | `packages/superclaw/src/superclaw/skill_sync.py` |
