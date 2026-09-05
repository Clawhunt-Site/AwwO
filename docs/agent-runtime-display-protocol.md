# Agent Runtime 显示协议（Display Protocol）

> 适配层（agent runtime adapter）↔ 表层（Web / Desktop / API SSE）之间的**规范化显示契约**。
> 经 Codex（gpt-5.5）+ Gemini 系（antigravity gemini-3.1-pro）两轮对抗式设计讨论定稿。
>
> **状态：设计定稿，未落地。** 本文件是"该长什么样"的权威设计；schema 的**代码事实源**是 Python core（见 §3），本文件不复制一份独立权威表。

## 0. 第一原则：充分显示（Full Disclosure）

**用户能看到的,必须是 agent runtime 真实发生的全部——首先是流式文本,其次是工具调用的名称、输入、输出、状态。**

落地为三条不可违背的规则：

1. **能拿到就必须显示。** runtime 能提供的字段（文本增量、工具名、入参、出参、状态），表层必须完整渲染，不得静默丢弃。今天的缺口（内核 MCP 工具只发 name、前端不监听 tool.* / 终态不补显）就是违反本条。
2. **拿不到必须诚实标注,不得伪装。** runtime 真拿不到的字段，置 `null` 并写进 `degraded_fields`，表层照常渲染工具卡片但标注"此 runtime 未提供入参/出参"。**禁止把"不支持"美化成"看起来支持"。**
3. **绝不伪造。** 不从自然语言 transcript "猜"工具痕迹拼成假流式（违反 CLI 唯一事实源 + fail-closed）。只有 runtime 输出**结构化** transcript 时才可投影，并标 `source="posthoc_structured_transcript"`。

"充分显示"与"诚实降级"不矛盾：前者要求**穷尽**真实信息，后者要求**不捏造**缺失信息。两者由**字段级能力矩阵**（§4）统一裁决。

## 1. 现状缺口（已代码核实）

| 层 | 缺口 | 证据 |
|---|---|---|
| 内核 | codex 的 mcpToolCall/dynamicToolCall 只发 `name`，丢 `arguments`/`result` | `codex_app_server.py:470,552` |
| 内核 | claude_stream `tool.completed` 连工具名都没有，只有 `tool_use_id`；`tool_use.input` 被丢 | `claude_stream.py:210,215,221` |
| 内核 | 各 runtime 各自手写 `_emit("tool.started", …)`，字段 shape 不统一、无 `call_id` → schema 漂移 | codex / claude 两处 |
| 表层 | 前端工具显示组件**为零**（全局 grep 零命中） | `apps/web/src/` |
| 表层 | run EventSource `watched` 白名单排除 tool.*/message.delta/reasoning.* | `App.tsx:6234` |
| 表层 | direct chat 回调只处理 message.*/chat.* | `App.tsx:7274` |
| 表层 | `loadRunDetail` 不加载 events，终态不补显 timeline | `App.tsx:6018` |
| 表层 | 命名错位：前端听 `command.started`（任务级），codex 发 `tool.started{tool:"command"}`（步骤级） | orchestrator vs codex_app_server |
| 文档 | `unified-task-entry.md:126-129` 只有叙事，无规范化 schema / 无"充分显示"原则 / 无渲染契约 | — |

## 2. 架构：reader → projector → validator → adapter → sink → SSE → 表层

归一化的**边界不放在 adapter 内部**（adapter 会变胖，schema 已在漂移），而是拆成独立的 runtime-specific projector，对齐仓库已有的 `plugin_runtime_projection.py` 范式：

```
runtime 原生协议
  │  (codex JSON-RPC item/* ; claude stream-json tool_use/tool_result ; …)
  ▼
① runtime reader        只解析原生协议，保留足够 raw 上下文
  ▼
② display projector      codex_display_projection.py / claude_display_projection.py
  │                       把 raw item 投成 canonical DisplayEvent
  ▼
③ contract validator     来自 Python core：required fields / truncation / redaction / degraded_fields
  ▼
④ adapter                只声明能力、启动 runtime、把 projector 输出交给 EventSink
  ▼
event_sink → SQLite events（run 通道）/ 内存队列（chat 通道）
  ▼
SSE 表层                  零语义原样透传 canonical DisplayEvent
  ▼
前端                      无语义渲染（绝不自己推断 command/file/mcp 语义）
```

**职责铁律**：前端**永远只见 canonical schema**，绝不见 runtime 专有形状，也绝不自己推断工具语义——语义在 ② projector 投影时就定死。

## 3. 契约事实源：`display_contracts.py`，由 `ui_contracts.py` re-export

- 新增 `packages/superclaw/src/superclaw/display_contracts.py`：schema（TypedDict/dataclass）、enums、validators、truncate/redact helpers。**这是唯一事实源。**
- `ui_contracts.py` re-export 并提供 `build_display_contract_payload()`，保证 UI 合同仍从契约集中点出（不让 `ui_contracts.py` 继续膨胀成垃圾桶）。
- 前端 TS 类型从 API contract / fixture **生成或测试锁定**，前端不另建语义源。
- 本 docs 只解释原则与引用字段，**不是 schema 事实源**。

## 4. 字段级能力矩阵（不是粗粒度三档）

粗粒度 FULL/PARTIAL/BATCH 无法表达"Claude 有 tool_use input 但没有 result"这种半真状态，所以能力**按字段拆**。`RuntimeCapabilities` 从布尔 `tool_events` 升级为分项：

```
streaming_text · tool_lifecycle · tool_input · tool_output · tool_output_delta
reasoning · usage · approval · nested_calls · persistent_thread · mcp_overlay
```

`capability_tier`（full/partial/batch）只是**从字段矩阵派生的用户可见摘要标签**，事实源是字段矩阵。

诚实降级映射（由字段矩阵推导）：

| Tier | 典型 runtime | 事件输出 | 界面渲染 |
|---|---|---|---|
| **FULL** | codex（command/file 已达；MCP 待补 args/result） | 完整 canonical 事件，无 degraded | 打字机文本 + 实时工具卡片（可展开 input/output） |
| **PARTIAL** | claude-cli（有 input，缺 result / 缺 name） | 缺省字段置 `null` + `degraded_fields:[…]` | 渲染工具卡片但相应区显示"此 runtime 未提供该字段" |
| **BATCH** | grok / bobo / cursor 等非流式 worker backend | **执行期不发任何 tool.* 事件**；只发 `adapter.diagnostic{streaming:false, tool_lifecycle:false}` + 最终 `message.completed` | 执行期转圈；**结束后**从 evidence / `loadRunDetail` 一次性**静态**渲染工具清单卡片（仅当 runtime 给结构化 transcript 才投影工具痕迹） |

## 5. Canonical 事件信封 + 事件目录

先定**信封**（不只是 payload）：

```
DisplayEvent {
  schema_version: 1
  type: string
  seq: int            # turn 内单调递增 —— 并发工具卡片排序的唯一依据
  ts: iso8601
  session_id?: string
  run_id?: string
  turn_id?: string
  runtime_id: string
  capability_tier: "full" | "partial" | "batch"
  payload: object
}
```

事件目录：

- **流式 runtime MUST**：`message.delta` · `message.completed` · `tool.started` · `tool.delta` · `tool.completed` · `error`
- **契约已知、能力门控（拿到才发，拿不到不伪造）**：`reasoning.delta` · `reasoning.completed` · `usage` · `approval.requested` · `approval.resolved` · `adapter.diagnostic`

约定：
- **不引入 `tool.failed` 新语义**；统一用 `tool.completed.status = "ok" | "error" | "cancelled"`（如需兼容旧 streamtest，`tool.failed` 仅作 alias，非 canonical）。
- `reasoning` / `usage` **不是 MUST**（隐私/供应商差异 + 很多 CLI 拿不到），在能力矩阵声明，能拿到就显示。
- `tool.delta.stream_type` 收窄为枚举：`stdout | stderr | patch | result | log | progress`（前端不靠字段名猜）。

## 6. ToolCall 域模型（typed common fields + JSON escape hatch + preview）

裸 `any` 太松（语义债转给前端）；全字段强类型化 MCP 又过度设计。折中：

```
ToolCall {
  call_id: string
  parent_call_id?: string        # 嵌套/子调用
  name: string | null
  kind: "command" | "file" | "mcp" | "builtin" | "approval" | "unknown"
  status: "running" | "ok" | "error" | "cancelled"
  input: JsonValue | null
  output: JsonValue | string | null
  display: { title, summary?, input_preview?, output_preview? }
  degraded_fields: string[]      # runtime 真拿不到的字段
  redacted_fields: string[]      # 被核心脱敏的字段
  truncated: { input: bool, output: bool }
  artifact_refs?: [...]          # 完整大输出走 artifact，不塞满 SSE
  exit_code?: int
  duration_ms?: int
}
```

- command/file 是**强类型投影**；MCP/plugin 保留 JSON，但必须统一走 redaction / truncation。
- 大 input/output：inline 只给 `*_preview` + `truncated` flag，完整内容走 artifact ref。**没有 artifact 时诚实显示"完整内容未保存"，不给"取完整"假承诺**（不加二次拉取接口，避免 API 缓存状态）。截断预算建议 10KB/字段。

## 7. 横切要求（Codex 补漏，全部 MUST）

1. **ordering**：`seq` turn 内单调递增——否则并发工具卡片乱序。
2. **并发/嵌套**：`call_id` / `parent_call_id` / `turn_id` 是一等字段。
3. **审批 / human gate**：`approval.requested` / `approval.resolved` 进 canonical，不只靠 `run.paused`。
4. **脱敏（redaction）**：工具 input/output 可能含 token、路径、账号、插件密钥——**核心先脱敏再 display**，记入 `redacted_fields`。对齐 `secrets-instance-settings-kernel` 与 fail-closed 治理。
5. **截断 / artifact**：大 stdout、diff、MCP result 统一预算 + artifact refs。
6. **terminal repair**：runtime 崩溃时，running 的 tool 必须合成 `tool.completed.status=error/cancelled` 或发 `adapter.diagnostic`——**UI 不能永远转圈**。对齐 `ghost-state-eradication`。
7. **durable vs ephemeral**：`message.delta` 不一定都进 SQLite；但终态 transcript/artifacts 必须可回放。
8. **两表面同一 display model**：direct chat（`/api/chat/stream` → `runDirectChat` 回调）与 run cockpit（`/api/runs/{id}/events` → watched）**共用同一 canonical 模型**，否则再次分叉。
9. **sink 失败不得静默吞**：现 `_emit` 静默吞 sink 异常（对"运行不中断"有理，但对显示协议不合格）——至少计数 / 发 `adapter.diagnostic`。

## 8. 前端渲染契约（MUST）

- **文本流式区**：复用现有 `message.delta` 渲染。
- **工具卡片**：按 `call_id` 聚合 started→delta*→completed 三相；显示 `name` + `kind` 图标 + `status`（running/ok/error/cancelled）+ 可展开 `input` + 可展开 `output`（command 显示 stdout 流式 + exit_code；file 显示 path/diff；mcp 显示 args/result）+ `duration_ms`。
- **降级标注**：`degraded_fields` 非空时显示"runtime 未提供该字段"；`redacted_fields` 显示"已脱敏"。
- **两通道分别接线**（不要混淆）：
  - **聊天**：工具卡片做在 `runDirectChat` 回调（`App.tsx:7078/7229`），捕获 canonical `tool.*` 事件渲染进当前 working turn。
  - **run cockpit**：把 canonical 事件加进 `watched` 白名单（`App.tsx:6234`），并解决终态补显（`loadRunDetail` 合入 events，或 events endpoint 回放）。
- **命名错位在内核源头归一**：chat 流只发 `tool.started{kind:"command"}`，前端不再认 `command.started`。

## 9. 落地顺序（每步可独立验收，不破坏现有 message.delta）

1. **契约先行**：`display_contracts.py` schema + enums + validator + fixtures；**不改 runtime 行为**。
2. **projector 单测**：codex command/file/mcp、claude tool_use/tool_result fixtures，锁 `call_id/input/output/degraded_fields`。
3. **接 codex projector**：补 `call_id`、command/file output、**MCP args/result**；保持现有 `message.delta` 不变。
4. **接前端最小工具卡**：direct chat 先显示 tool cards；run cockpit watched 加 canonical 事件；解决终态补显。
5. **接 Claude**：投影 `tool_use.input` 和 `tool_result.content`；拿不到 name/result 时标 `degraded`。
6. **batch runtime 收尾**：只发 explicit `adapter.diagnostic` + 最终 message，**不做自然语言重建**。
7. **文档收尾**：本文件记录 contract 来源 / 能力矩阵 / conformance checklist；`unified-task-entry.md` 只留架构链接；`hermes-style-agent-runtime.md` 留历史/性能背景。

## 10. 一致性检查清单（Conformance）

**adapter / projector 接入**：
- [ ] 是否把原生事件归一到 canonical DisplayEvent（含 envelope：schema_version/seq/turn_id/runtime_id/capability_tier）？
- [ ] 缺字段是否标 `degraded_fields` 而非静默丢？
- [ ] input/output 是否走统一 redaction + truncation + artifact ref？
- [ ] running tool 在 runtime 崩溃时是否做 terminal repair？

**SSE 表层**：
- [ ] 是否零语义原样透传 canonical 事件、不硬编码与内核不一致的列表？

**前端**：
- [ ] 两通道（chat 回调 / run watched）是否都接全部 canonical 事件？
- [ ] 工具卡片是否渲染 name/input/output/status/duration？
- [ ] `degraded_fields` / `redacted_fields` 是否标注？
- [ ] 是否有工具卡片渲染测试 + projector fixtures + validator 测试（防"事件存在但字段不够"的假通过）？

## 11. 关键文件

| 关注点 | 文件 |
|---|---|
| 契约事实源（新增） | `packages/superclaw/src/superclaw/display_contracts.py` |
| 契约 re-export | `packages/superclaw/src/superclaw/ui_contracts.py` |
| 能力声明（升级为字段级） | `packages/superclaw/src/superclaw/agent_runtime/adapter.py` |
| codex projector（新增） | `packages/superclaw/src/superclaw/codex_display_projection.py` |
| claude projector（新增） | `packages/superclaw/src/superclaw/claude_display_projection.py` |
| codex 原生事件源 | `packages/superclaw/src/superclaw/codex_app_server.py` |
| claude 原生事件源 | `packages/superclaw/src/superclaw/claude_stream.py` |
| SSE 表层 | `apps/api/main.py`（`/api/chat/stream`、`/api/runs/{id}/events`） |
| 前端渲染 | `apps/web/src/App.tsx`（`runDirectChat` 回调、run `watched`） |
| 相关设计 | `docs/unified-task-entry.md`、`docs/hermes-style-agent-runtime.md` |

## 12. 实现状态（截至落地，dev/roadmap）

> 本节记录 §9 落地顺序的真实结果，作为 §10 一致性检查清单的实测交底。**实际落地与 §11 设计预期有一处文件命名差异**：projector 没有拆成 `codex_display_projection.py` / `claude_display_projection.py` 两个独立文件，而是合并落在 **`packages/superclaw/src/superclaw/display_projection.py`**（`project_codex_event` / `project_claude_event` 两个纯函数）。这是有意收敛——两个 projector 共享同一 envelope 装配与 redaction/truncation 工具，拆两文件会重复胶水代码。其余文件与 §11 一致。

### 12.1 已落地（双 PASS）

| 步骤（§9） | 状态 | 落点 | 验收 |
|---|---|---|---|
| 1 契约先行 | ✅ done | `display_contracts.py`（PR-1，inert）+ `ui_contracts.py` re-export | schema/enums/validator/fixtures |
| 2 projector 单测 | ✅ done | `tests/test_display_projection.py` | 锁 `call_id`/input/output/`degraded_fields`；按 codex 真实 v2 协议字段（`item.rs`）校正 |
| 3 接 codex projector | ✅ done | `codex_app_server.py` 发 `de.type, de.to_dict()` | command/file/**MCP args+result**；`message.delta` 不变 |
| 4 前端工具卡 + run cockpit | ✅ done | `displayProtocol.ts` / `App.tsx` | chat 工具卡（fixture 驱动）+ run cockpit watched + 终态补显 |
| 5 接 Claude projector | ✅ done | `claude_stream.py` / claude adapter | `tool_use.input` / `tool_result.content`；缺 name/result 标 `degraded` |
| 6 batch runtime 收尾 | ✅ done | 仅 explicit `adapter.diagnostic` + 最终 message，无自然语言重建 | — |
| 7 文档收尾 | ✅ done（本节） | 本文件 §12 + 顾问留痕 ledger | — |

**run 通道持久化（§9 第 4 步在 run 侧的后端基础设施）：**
- `state.py`：`idx_events_run` 索引；`add_event` 为 **best-effort safe-write**（吞写入异常、计 `_event_write_failures`、打 stderr，绝不打断实时流）；`list_events_snapshot` 只排除 `*.delta`，保留工具卡/审批/诊断结构事件。
- `apps/api/main.py`：`GET /api/runs/{id}/events/snapshot`（经 `_snapshot_events_with_ids` 注入 SQLite `id`/`id_source`）；SSE `get_events` 的 `_frame` 注入 id + **G1 按终态收流**（有界轮询 + `for/else` 末窗补读，防最后一窗事件漏发）。
- **inline chat-task composed sink（DL10）**：inline 路径用复合 sink 双写——实时 chat SSE（`events_q`）+ 持久 run events（`store.add_event`），使 chat-linked run 在 cockpit `/events/snapshot` 能重放工具卡/审批/诊断；纯 chat（无 `inline_task_run_id`）只写实时队列、不落库。

**前端 run cockpit：**
- `displayProtocol.ts`：`classifyRunDisplayEvent`（card/approval/diagnostic）、`RUN_DISPLAY_EVENT_TYPES`、`snapshotRowToDisplayEvent`（把 snapshot 的 row-wrapped 形状归一回 live 的 envelope 形状）、`DisplayAccumulator` 按 `event.id` 去重。
- `App.tsx`：`SNAPSHOT_STATES` 路由终态 run 走快照重放；`applyRunDisplayEvent`；SSE watched 接全部 `RUN_DISPLAY_EVENT_TYPES`；`onerror` → `loadRunDetail`+`loadRuns`（G1 前端兜底）；cockpit 渲染 `TurnDisplay` + 审批（只读广播，`decided_by` 恒为内核，无客户端回写）+ BATCH 诊断。

### 12.2 §10 一致性检查清单实测结论

- adapter/projector 接入：canonical envelope ✅；缺字段标 `degraded_fields` ✅；input/output 走统一 redaction+truncation+artifact_refs（DL6 充分披露）✅；running tool 终态修复 ✅。
- SSE 表层：零语义原样透传、不硬编码与内核不一致的列表 ✅。
- 前端：两通道（chat 回调 / run watched）都接全部 canonical 事件 ✅；工具卡渲染 name/input/output/status/duration ✅；`degraded_fields`/`redacted_fields` 标注 ✅；工具卡渲染测试 + projector fixtures + validator 测试齐备 ✅（Python 115 + web 123 测试全绿，ruff clean）。

### 12.3 表层继承与 SCHEMA_VERSION 约束

- 上述 `display.*` 字段是 **API SSE 契约**（`/api/chat/stream`、`/api/runs/{id}/events`、`/events/snapshot`）。Web 直接消费；**Desktop 经冻结 backend 继承同一契约**——见 [[installed-app-frozen-backend]]：装机 app 跑的是打包冻结的 Python backend，改 display 投影/契约后，desktop 必须**重打包 + 重签热替换** backend 才能生效。
- **`DISPLAY_SCHEMA_VERSION` 任何变更都是破坏性的**：前端 `DisplayAccumulator`/projector 与后端 envelope 必须同版本；升级时需同步 web 构建与 desktop backend 重打包，否则旧 desktop 会按旧 schema 误解析。

### 12.4 已知非阻断 follow-up（backlog，不阻塞收敛）

1. **inline 路径端到端防回归测试**：composed sink 的持久化与 snapshot id 注入机制已分别被 `test_display_persistence` + `test_display_api` 锁定，但缺一条「mock codex adapter + intent=task → 断言 `/events/snapshot` 重放出 display 事件」的端到端测试。两顾问均判为 follow-up（非阻断）。
2. **SSE `onerror` 不自动重连**：活跃 run 上的瞬时网络错误不会自动重连（当前 → `loadRunDetail`+`loadRuns` 兜底）；可加退避重连。
3. **`add_event` 在 SQLite busy lock 下的延迟**：best-effort safe-write 不抛错，但写竞争时可能等到 `busy_timeout`（延迟，非正确性问题）。
4. `loadRunDetail` 竞态为站点既有问题（非本协议引入）；空 `reasoning.completed` 保留 deltas 为有意行为。
