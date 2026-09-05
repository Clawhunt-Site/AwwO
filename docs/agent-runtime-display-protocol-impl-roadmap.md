# 最终决断 v14：Agent Runtime 显示协议（Display Protocol）实施方案

> ✅ **已冻结（FROZEN）**：经 12 轮（v2→v14）双顾问对抗验收，**Codex v14 + gemini-cli v14 双 PASS、无阻断**，准予冻结进入 PR-1 实施。Codex 的非阻断实施期提醒已并入正文（onerror 收口语义 / safe-write 全覆盖 / PR-4+PR-6 同发布栈）。
>
> **本文是「待实施的 PR 计划」，不是已落地代码。** changelog 里「已代码核实」= 核实了所引用的**当前现状行号/事实**（如「main.py:4655 当前仍是 `... and saw_terminal`」「snapshot 端点当前不存在」），**不代表修复已写进代码**——修复正是 §B 的 PR-1~PR-7 要做的事。验收请审「这套 PR 计划是否正确、自洽、可落地」，而非「修复是否已在 main 分支存在」。

## v13 → v14 关键纠正（Codex 第十一轮验收驱动）
| 阻断 | v14 决断 |
|---|---|
| Codex-G1-FE：G1 只修服务端 SSE 不挂死，但**端到端 UI 没收口**——safe-write 丢终态事件时 SSE 关闭但客户端收不到 `run.*`，前端 `onerror` 只 close 不刷新（App.tsx:6260/6277），run 卡在 UI running 态、`selectedRunStreamActive` 不翻 snapshot 分支 | **前端 SSE 关闭/错误时强制收口（DL9/PR-6）**：EventSource `onclose/onerror` → `loadRunDetail`+`loadRuns`；若刷新后 `status∈SNAPSHOT_STATES` 则拉 `/events/snapshot` 渲染终态卡。**后端补充**：status-terminal 但终态事件缺失时，发一个**非持久、由 run status 派生的 SSE status 控制帧**再关闭，给前端确定信号。测试覆盖「终态事件写失败/延迟但 status 已 completed → cockpit 退出 active 并加载 snapshot」 |
| Codex-U1-cover：U1-deep 须覆盖**所有**事务内 `_add_event_in_transaction`（lease acquired/released/**lost**/release_rejected），不只 happy path | DL8/PR-4 的 safe-write 拆分**枚举覆盖** lease 全生命周期事件（acquired/released/lost/release_rejected）+ run lifecycle，逐一从状态提交事务拆出 |

## v12 → v13 关键纠正（Codex 第十轮 + gemini-cli 验收驱动，均已代码核实）
| 阻断 | v13 决断 |
|---|---|
| U1-deep（Codex）：safe-write 不能只包 public `add_event`——`acquire/release_run_mutation_lease` 在**同一事务**内先 `_save_run_in_transaction` 再 `_add_event_in_transaction` 写 lease 事件（state.py:361/490/1998），events insert 失败会**回滚整个事务**连 lease/status 一起回滚，反杀执行/恢复/lease 路径 | **状态先提交、事件 best-effort 后写**：所有 run lifecycle/audit 事件写（含事务内 `_add_event_in_transaction` 调用点）从 status/lease 提交事务中**拆出**——先提交 run/lease 状态，再在该事务外 best-effort safe-write 事件（失败只计数+stderr，不回滚状态）。覆盖 lease.acquired/released 全路径 |
| G1（gemini）：safe-write 致 `run.completed/failed` 可能丢→ SSE `saw_terminal` 恒 False→ **SSE 永久挂死** | **SSE 按 status 强制收口**：`/events` 终止判定改为「`status in terminal` → 抽干最后一批 events 后强制 break」，**不再强求 `saw_terminal`**（main.py:4654）。与 DL10 统一：SSE 终止以 run **status** 为准，事件丢失不致挂死 |
| G2（双方）：DL8 说「run health 由 RunSession 可持久字段承载」，但 RunSession 当前只有 `status` 无 `health` 字段 | **用 `effective_status`（status + active_mutation_lease，均已持久，[[ghost-state-eradication]] 的 liveness 现成）**——run health = 计算值，**不新增字段、不动 to_dict/from_dict**；与 events 表解耦 |
| U2-inline（Codex）：inline task 是 `events_q`(chat SSE) + `store.add_event`(run persist) **双写**，v12 只定义 durable=SQLite id / chat-only=synthetic，未覆盖双写 | **chat SSE 通道一律 synthetic session-local id（含 inline 双写事件）；run SSE/snapshot 读取时再注入 SQLite id**。两 surface 的 reducer 可复用，但 id 空间**不混用**（chat=synthetic / run=SQLite） |

## v11 → v12 关键纠正（Codex 第九轮验收驱动，均已代码核实）
| 阻断 | v12 决断 |
|---|---|
| U1：DL8 mode B 过度承诺——当前生命周期事件 run.started/failed/completed/interrupted 都是**无保护 `store.add_event()`**（state.py:515/1998 不捕获，orchestrator.py:2023/2404/2487 无保护写），events 写失败会**抛异常反杀执行/恢复路径**，而非优雅降级为「events 不可见」 | **全局 safe event-write（U1，冻结前置）**：所有生命周期/display 的 `add_event` 经统一 safe wrapper（catch 写失败→计数+stderr，**绝不向 run 流程抛**）。run health 改由 RunSession 的可持久字段承载（与 events 表解耦），保证 events 表挂掉时 run status 仍能 save。PR-4 硬测：注入 events insert 失败 + runs save 成功，验证 delivery/inline 全路径不被 add_event 反杀 |
| U2：`event.id=SQLite events.id` 套到所有通道不自洽——chat 实时通道不落库、纯 chat 无 run event id（main.py:1068 chat SSE 只发 event/data，App.tsx:4714 streamChatTurn 不解析 id），与「chat v1 仅实时不持久化」矛盾，卡死 PR-5/PR-6 共用 reducer | **event.id 按通道分源（U2）**：envelope 带 `id` + `id_source`；**durable run 通道**=SQLite `events.id`；**chat-only 实时通道**=projector 合成的 session-local 单调 id（标 `id_source="synthetic"`）。reducer 按 `id` 去重（两通道各自 id 空间内唯一即可），不强求跨通道全局唯一。T4 fallback 重述：旧 `/events`+`list_events` 都给不了 id → fallback 是 **degraded shape**（reducer 容忍无 id、退化为顺序 append） |

## v10 → v11 关键纠正（Codex 第八轮验收驱动，均已代码核实）
| 阻断 | v11 决断 |
|---|---|
| T1：快照拉取时机漏 `WAITING_FOR_HUMAN_GATE`——前端把它当 active（App.tsx:1580/6215），但 SSE 服务端把它当 stream-terminal（main.py:4635）；按「active 订阅/终态拉快照」落地时 paused/gate run 会走 /events 全量回放破坏底座 | 新定义 `SNAPSHOT_STATES`（=SSE 服务端的 stream-closed 集：completed/failed/cancelled/WAITING_FOR_HUMAN_GATE），**不复用 ACTIVE_RUN_STATUSES**；前端按「status∈SNAPSHOT_STATES → 拉快照；否则订阅 SSE」分流，gate→running 转换时重订阅 |
| T2：active live 重连/重放无幂等——/events 每次从 last_id=0 读（main.py:4642）、SSE 只发 payload 无 id（main.py:4649）、前端盲 append（App.tsx:6260）；delta 持久化+reducer 聚合下重连会重复聚合历史 delta | **统一事件身份+幂等**：canonical envelope 带 `event.id`（=SQLite events.id）；SSE 发 `id:` 行并在 payload 内携带 event.id；前端 reducer **按 event.id 去重**（再按 call_id 聚合），重连从 0 重读幂等无重复。可选 honor Last-Event-ID |
| T3：DL8 store 故障分层仍过度承诺——SQLite 整体故障时经 liveness/run health 外显也不成立（liveness 读的也是同一 store） | DL8 **三模式**：A sink/projector 失败但 StateStore 可写→经 store 发一次；B events 写失败但 runs 表仍可读写→update run health/status + chat/inline 经 events_q；**C StateStore/SQLite 整体不可用→只 stderr+计数，带内与 run-health 均不可见，DB 恢复后由 reconcile 修复**（不承诺持久外显） |
| T4：快照 fallback 形状与契约不一致——snapshot 要 DisplayEvent 含 envelope/id，但 list_events 只返回 {type,payload} 无 id | `list_events_snapshot` 用 **id-reading SQL**（`SELECT id,type,payload ... NOT IN(deltas) ORDER BY id ASC`）总是带 id；旧 backend fallback 也用带 id 的 filtered 读；reducer 要求 id（无 id 则降级标记） |

> 经两轮三方讨论 + 5-lens 红队 + 八轮外部双顾问验收 + 一轮内部一致性红队，主代理做最终决断。
> 本文是**自洽的权威实施方案**（已清除历次演进的化石表述）。第一原则：**充分显示**——能拿到必须显示，拿不到必须诚实标注，绝不伪造。
> 演进留痕见项目记忆 [[streaming-tool-events-fix-plan]] + 顾问 transcript；设计文档 `docs/agent-runtime-display-protocol.md` 落地时同步本文。

## v9 → v10 关键纠正（Codex 第七轮 + antigravity 建议，均已代码核实）
| 阻断 | v10 决断 |
|---|---|
| S1：快照 HTTP 契约没锁死——v9 写「`?snapshot=true` 或快照端点」的「或」不够，且 query 参数混在 SSE 路由会破坏 FastAPI schema（StreamingResponse vs JSON）。两位顾问均要求锁独立端点 | **锁定独立非流式 JSON 端点** `GET /api/runs/{run_id}/events/snapshot` → 返回 `{run_id, events: list[DisplayEvent](排除*.delta，含 envelope/id), event_count, latest_event}`；前端**选中终态 run 时拉一次**喂进同一 ToolCallCard reducer。SSE 路由 `/events` 维持纯流式。旧冻结 desktop backend 缺 `list_events_snapshot`/端点时 API+前端**平滑降级**（filtered list_events + warning，不崩） |
| S2：DL8「sink 可见+只发一次」有不可实现路径——run cockpit 真相只来自 SQLite，store.add_event 连续失败时经同一 store 写的 diagnostic 也失败→读不到 | DL8 **按失败模式分层**（见下）：① sink-callback 失败但 store 健康→经 store 发一次 diagnostic（可见）；② **store 写失败**→chat/inline 经 events_q 兜底可见，delivery/cockpit **诚实承认 store-down 不可在带内显示**，降级为进程日志+计数，经 liveness/run health（[[ghost-state-eradication]]）外显，不假装带内可见 |

## v8 → v9 关键纠正（Codex 第六轮验收驱动，均已代码核实）
| 阻断 | v9 决断（统一底座：**终态快照读 = 排除 *.delta 的 events 读**） |
|---|---|
| A1：cockpit「id=0 重放终态快照」在现有前端不发生——前端只在 `selectedRunStreamActive`（活跃态）才订阅 /events，**终态 run 直接 early-return 不订阅**（App.tsx:6215）；`GET /api/runs/{id}` 不带 events（main.py:4488） | PR-6：**终态 run 主动 GET 独立端点 `/api/runs/{id}/events/snapshot`**（见 S1，非流式 JSON）渲染工具卡；活跃 run 仍走流式 SSE（含 delta）。「依赖 id=0 重放」改为「终态拉快照」 |
| A2：DL5「不删 delta」污染现有 `GET /api/chat/sessions/{id}` detail——它对 linked run 做**全量 `store.list_events`** 塞进响应（main.py:3299，state.py:522 无 limit）→ 长 run 响应暴涨，是**现有 API 回归**非 DB follow-up | PR-4：新增 `list_events_snapshot(run_id)`（**排除 *.delta**，只回终态/结构化事件）；**session detail 改用快照读**（不再吐 raw delta）。同一快照读供 A1 的 cockpit 终态重放复用 |

## v7 → v8 关键纠正（内部一致性红队驱动，均已代码核实）
| 问题 | v8 决断 |
|---|---|
| inline task 完成只发 `chat.task.completed/failed`（main.py:4301）不发 `run.*`；而 cockpit SSE 的 `saw_terminal` 只认 `run.*`（main.py:4636/4655）→ **inline run 的 /events SSE 永不 break，终态后每 1s 空转挂死**（既存 bug，被本设计的 cockpit 显示依赖暴露） | **inline 终态也发 `run.completed/run.failed`**（与 chat.task.* 并发，对齐 delivery 语义）→ retention/SSE 终止/cockpit 三处统一按 `run.*` 终态收口、零特例。PR-4 加「inline run /events SSE 终态后真正 break」断言 |
| Q3 延迟/后台裁剪 delta 过度设计且无基底：events 表无时间列（state.py:86 仅 id/run_id/type/payload）、reconcile sweeper 专扫执行中 run 不可复用（orchestrator.py:1189）、grace 期是时间窗竞态 | **v1 不物理删 delta**：retention 只靠 `idx_events_run` 索引 + 单行 `truncate_field`（10KB）。「重放=终态快照」靠卡片由 tool.completed.output 重建（delta buffer 兜底）实现，不需删行。**delta 行物理回收并入 transient-lane follow-up**，移出 v1。消除并发误删/grace 竞态/新 sweeper |
| PR-3 测试清单残留「cap 一致性」化石，与「claude 无 live 能力声明对象、不翻 flag」矛盾 | PR-3 去掉「cap 一致性」，只留发射面行为测试（stream 含 usage 必发 usage 事件） |

---

## A. 锁死的架构决断

### DL1. projector = emit-site 的 canonical builder，持显式 ctx
- 新增 `display_projection.py`：`project_codex_event(raw, caps, ctx)` / `project_claude_event(raw, caps, ctx)` 两个纯函数（无隐藏全局态/无 IO，但**显式读写传入 ctx**）。
- `ctx = ProjectionState{open_calls: dict[item_id, ToolCall], current_command_call_id, seq_counter, turn_id}`，由 `run_turn`/`run_claude_stream` 局部持有并跨 raw 事件传递。
- `codex_app_server.run_turn` / `claude_stream` 不再手写 flat `_emit("tool.started", …)`，改调 projector 产出 canonical DisplayEvent 再入 event_sink；adapter 仅透传。
- **call_id**：优先用 runtime 原生 id（codex `item.id`/`itemId`、claude `tool_use_id`），标 `call_id_source="runtime"`；缺失才 ctx 计数器合成，标 `"projector_synthesized"`+degraded。open_calls 按原生 id 索引，正确处理 interleaved/late-delta/terminal-repair。
- 理由：解析状态（command_parts/last_tool_at/tool_iterations）活在 run_turn；emit-site 才拿得到 ctx、才能做 terminal repair；测试本就在 run_turn 层调 on_event。

### DL2. 契约唯一事实源 = `display_contracts.py`，由 `ui_contracts.py` re-export
- `display_contracts.py`：DisplayEvent 信封、事件 enum、ToolCall、kind/status/stream_type enums、`SCHEMA_VERSION=1`、validators、`truncate_field`(10KB)、`redact_payload`。
- **零重依赖**：只 import stdlib + **轻模块 `superclaw.secrets_scan.redact_secrets`**（不经 runtime.py）；加 import-cycle 静态测试锁死。
- `ui_contracts.py` 增 `build_display_contract_payload()` + re-export；前端 TS 由 Python fixture 生成/测试锁定，不另建语义源。

### DL3. 能力按字段拆；保留 `streaming` 旧名
- `RuntimeCapabilities` 在现有字段基础上**新增** `tool_lifecycle/tool_input/tool_output/tool_output_delta/reasoning`；旧 `tool_events` 经 `__post_init__`/property **别名映射**到 tool_lifecycle（不破坏 test_agent_runtime:123）。**不改 `streaming` 名**。
- `capability_tier(caps)`：非 streaming→batch；streaming&tool_lifecycle&tool_input&tool_output→full；否则 partial。经 display_contracts 导出，前端不另算。
- **能力诚实**（不在 inert PR-1）：codex live adapter `usage_events` True→False 放 PR-2（codex 不发 usage）；claude 无 live 能力对象——usage 诚实靠**发射面行为**（PR-3 让 run_claude_stream 真发 usage 事件），**不翻任何 flag**，stub ClaudeRuntimeAdapter 保持 False 不动。「cap==发射」一致性断言只对 live adapter（codex）成立。

### DL4. BATCH runtime 绝不伪造流式
- BATCH（grok/cursor/opencode/bobo/hermes/openclaw/http/anthropic-api）执行期不发 tool.*，最多一次 `adapter.diagnostic{streaming:false, tool_lifecycle:false, reason}` + 最终 message.completed；工具卡只在 runtime 给**结构化** transcript 时事后投影，标 `source:"posthoc_structured_transcript"`；禁止自然语言 transcript 猜。

### DL5. 持久化 + 排序 + 重放
- **排序权威 = 到达顺序**：chat 通道=内存 FIFO 单 SSE 生成器；run 通道=SSE 按 `events.id ASC` 重放。`seq` 仅 tie-break/调试，不承载并发排序。
- **事件身份 + 幂等（T2，按通道分源 U2）**：canonical envelope 带 `id` + `id_source`。**durable run 通道**：`id`=SQLite `events.id`，SSE 发 `id:` 行 + payload 携带（当前 main.py:4649 只发 payload 无 id，需补）；reducer 按 `id` 去重——`/events` 每次从 last_id=0 读（main.py:4642），重连/重选会重读，去重保证幂等。**chat-only 实时通道**：不落库、无 SQLite id → `id`=projector 合成的 session-local 单调 id（`id_source="synthetic"`，当前 main.py:1068 chat SSE 只发 event/data、App.tsx:4714 不解析 id，需补）。reducer 在各通道 id 空间内去重 + 按 `call_id` 聚合，**不强求跨通道全局唯一**。可选 honor `Last-Event-ID`。
- **inline task 双写的 id 源（U2-inline）**：inline 是 `events_q`(chat SSE) + `store.add_event`(run persist) 双写。**chat SSE 通道一律用 synthetic id（含 inline 双写事件，避免「先写 store 才有 id」反过来卡住实时 SSE）；run SSE/snapshot 读取时再注入 SQLite id**。同一逻辑事件在两通道有两个 id 互不污染，两 surface reducer 复用但 id 空间隔离。
- **持久化**：run cockpit SSE 只读 SQLite（state.py:536）、EventBus 仅 doorbell 无 payload——故 run 通道**全部 canonical 事件落 SQLite**（沿用 orchestrator sink，orchestrator.py:264）。两条容量措施（v1 必做）：① PR-4 加 `CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id)`（run_id 过滤不再全扫）；② 每条 delta payload 经 `truncate_field`(10KB) 截断。**v1 不物理删 delta**（delta 行回收并入 transient-lane follow-up）。
- **终态快照读底座（A1/A2）**：新增 `StateStore.list_events_snapshot(run_id)`——**排除 *.delta**（tool.delta/reasoning.delta/message.delta），只回终态/结构化事件（tool.started/completed、message.completed、reasoning.completed、approval.*、adapter.diagnostic、run.* 等），足够重建卡片。**id-reading SQL（T4）**：`SELECT id,type,payload FROM events WHERE run_id=? AND type NOT IN(deltas) ORDER BY id ASC`——**总是带 `id`**（现有 `list_events` 只回 {type,payload} 无 id，state.py:522）；旧 backend 缺该方法时 fallback 走 filtered `list_events`（state.py:522 **给不了 id**）= **degraded shape**：随事件标 `id_source="none"`，前端 reducer **容忍无 id、退化为顺序 append**（不做去重，仅旧版兼容期）。**HTTP 契约锁定（S1）**：独立非流式端点 `GET /api/runs/{run_id}/events/snapshot` → `{run_id, events: list[DisplayEvent](含 envelope/id), event_count, latest_event}`，**不**用 query 参数混进流式 `/events`（FastAPI schema 冲突）。旧冻结 desktop backend 缺该方法/端点时 API 与前端**平滑降级**（filtered list_events + warning，不崩）。
- **全部 list_events 消费方审计（A2 扩展，不止 session detail）**：「不删 delta」会改变所有 `store.list_events` 消费方所见。逐个切：① `GET /api/chat/sessions/{id}` detail（main.py:3299，API 暴涨回归）→ 快照读；② CLI 事件展示（tui.py:206、cli.py:3963/4015）→ 快照读（否则刷屏 raw delta）；③ orchestrator `RunResult.events`（orchestrator.py:2004/2428/2441，CLI run 结果）→ 快照读；④ 类型扫描器 `_latest_pause_status`/`_stale_cancel_detail`（orchestrator.py:1331/1339，只匹配 run.* 类型，delta 被跳过）→ 功能不受影响，可选改 typed 查询省 perf。**唯一保留全量+delta 的是 live 流式 SSE（list_events_after）**。
- **重放/迟到语义 = 终态快照（诚实标注）**：run 进行中的 live reader 流式见全部 delta；**重连/replay/终态后迟到的 reader 得终态快照**（经上面的快照读）——由 tool.completed.output / message.completed 重建，历史 stdout/token 流不保证。因此 **projector 必须在 tool.completed 把已收集的 delta buffer 落进 output**（runtime 无 aggregatedOutput 时；terminal repair 把 open_calls 已收 partial 填进 output；reasoning 中断同理填 reasoning.completed）——最终显示事实不丢。前端区分「实时（delta 动画）」与「重放（终态卡片）」两态。

### DL6. ToolCall 域模型
```
ToolCall{ call_id, call_id_source("runtime"|"projector_synthesized"),
  name|null, kind(command|file|mcp|builtin|approval|unknown),
  status(running|ok|error|cancelled), input(JsonValue|null), output(JsonValue|string|null),
  degraded_fields[], redacted_fields[], truncated{input,output},
  artifact_refs?, exit_code?, duration_ms? }
```
- command/file 强类型投影；mcp 保留 JSON。**file 的 output=diff/patch**（codex 已收进 diff_parts，codex_app_server.py:504；不只发 path）。大 input/output inline 截断 10KB+truncated，完整走 artifact_ref；无 artifact 诚实显示「完整内容未保存」，不加二次拉取接口。先 redaction 后 display。
- **砍掉** display{} 子对象与 parent_call_id（前端按 kind 派生 title/summary/preview；嵌套调用 v1 无真实来源，follow-up）。

### DL7. 审批 = 内核单向广播回执（零新增语义）
- canonical `approval.requested{approval_id,tool_name,kind,redacted input_preview}` / `approval.resolved{approval_id,decided_by:"kernel",decision}`，**decided_by 恒 kernel**，display 通道**无 client→kernel 写回入口**。
- **approval_id** 优先用 runtime request `id`/params `itemId`（与 call_id 同源），缺失才合成。
- 两类审批姿态不同：**human-gate（run.paused 族）**= 真人审 → 可操作卡片，经现有 endpoint 解决；**codex 内部自动审批**（_handle_server_request:616 已拿 kernel decision）= 自动决 → 在 respond **前后成对** emit requested+resolved（只读、不可点），让 fail-closed 决策可见。

### DL8. terminal repair + sink 可见
- `codex_app_server.run_turn` 三条 break 路径 + `claude_stream` cancel/timeout：break 前遍历 `ctx.open_calls` 未关闭项，projector 合成 `tool.completed{status:cancelled|error}` 并把已收 partial 填进 output。
- `_emit`/event_sink 异常不静默吞（当前 codex_app_server.py:368 / claude_stream.py:149 / orchestrator.py:264 均吞）。**按失败模式分层定义可见路径（S2，不是口号）**：
  - **模式 A：sink-callback/projector 抛错但 store 健康**（如 sink 包装层 bug）→ 经 store 发**一次** `adapter.diagnostic{sink_dropped:n}`（turn 内 flag 去重）；run cockpit 可见。
  - **模式 B：events 表写失败但 runs 表仍可读写**（T3）→ **前提：状态先提交、事件 best-effort 后写（U1-deep）**——所有 run lifecycle/audit 事件写（含**事务内** `_add_event_in_transaction`，含 lease 全生命周期 acquired/released/lost/release_rejected + run lifecycle，state.py:361/490/1998）从 status/lease 提交事务中**拆出**：先提交 run/lease 状态，再事务外 best-effort safe-write 事件（catch→计数+stderr，不回滚状态、不向 run 流程抛）。当前 add_event 无保护、且事务内 insert 失败会回滚 lease/status，必须先收口。**safe-write 覆盖执行路径全部 `add_event`**（不止 terminal/lease，含 orchestrator.py:569 等所有调用点）。run health = **`effective_status`（status + active_mutation_lease，均已持久，[[ghost-state-eradication]] liveness 现成，不新增字段）**，与 events 表解耦，故 events 挂掉时 run status 仍 save：delivery/cockpit 经 effective_status 外显；chat/inline 另经 `events_q` 兜底发 diagnostic 可见。
  - **模式 C：StateStore/SQLite 整体不可用**（T3）→ events 与 runs 都写不了，liveness 读的也是同一 store，**带内与 run-health 均不可见**，只能 stderr+计数；DB 恢复后由 reconcile（[[ghost-state-eradication]]）修复。**不承诺 store-down 时的持久外显**（诚实边界）。
  - PR 硬测：模式 A「连续失败只发一次」；模式 B「events 写失败时 run status 仍更新 + inline 经 events_q 发出 diagnostic」；模式 C「store 全失败只 stderr+计数、不假装带内可见」。

### DL9. 两表面同一 display model
- chat：渲染在 `runDirectChat` 回调（App.tsx）。**v1 仅实时，不跨 reload 持久化**（ChatMessage 无 tool_calls 字段，扩展为 follow-up）。
- **状态分类（T1）**：新定义 `SNAPSHOT_STATES`=SSE 服务端的 stream-closed 集（completed/failed/cancelled/WAITING_FOR_HUMAN_GATE，对齐 main.py:4635），**不复用前端 ACTIVE_RUN_STATUSES**（它把 gate 当 active，会让 paused/gate run 误走流式全量回放）。前端：`status∈SNAPSHOT_STATES → 拉快照；否则订阅流式 SSE`；gate→running 转换时重订阅。
- run cockpit：**流式 run** canonical 事件加进 `watched`（含 delta 实时）；**SNAPSHOT_STATES 的 run** 主动 GET `/api/runs/{id}/events/snapshot` 一次渲染卡（A1/T1）。工具卡片由按 `event.id` 去重、按 `call_id` 聚合的 reducer 维护（T2，绕开 slice(-79) 有界数组）。
- 共用 React 组件 `<ToolCallCard>` + `<TurnStream>`。desktop（Tauri）复用 web bundle，无独立事件层，前端改动自动覆盖，零额外 PR。

### DL10. 统一 run 终态信号（修既存 inline bug）
- inline task 终态时**也发 `run.completed`/`run.failed`**（与现有 chat.task.* 并发），对齐 delivery 语义。→ SSE `saw_terminal` 终止判定、cockpit 显示统一按 `run.*` 终态收口，inline run 的 /events SSE 终态后正常 break（修 main.py:4636/4655 既存挂死 bug）。
- **必须覆盖所有 inline 终态早返回路径**（不止 happy path）：成功（main.py:4301）、runtime unsupported、codex missing（4168）、thread 异常（4095/4305/4316）——每条 inline 终结都配发 run.*。**顺序**：先 save 终态 status 再 best-effort 落 run.completed/run.failed。
- **SSE 按 status 强制收口（G1，修 safe-write 引入的挂死风险）**：`/events` 终止判定改为「`status in terminal` → 抽干最后一批 events 后强制 `break`」，**不再强求 `saw_terminal` 为真**（main.py:4654）。因为 safe-write 下终态 run.* 事件可能丢，若仍靠 saw_terminal 会永久挂死；以 run **status** 为终止权威，事件丢失也不挂死。
- composed sink：inline task event_sink 改为**实时 `events_q.put`（chat SSE）+ 持久 `store.add_event`（run replay）双写**，仅 `inline_task_run_id` 存在时写 run events，纯 chat 不写；store 写失败不吞掉实时 SSE。

### DL11. command 命名归一 + reasoning/usage v1 显示
- 步骤级命令工具发 canonical `tool.started{kind:"command"}`；任务级 orchestrator `command.started/completed` 保留为独立粗粒度 run 生命周期事件（不进工具卡渲染、不接 redaction 路径）。前端只改 watched/渲染分流。codex 终态 reasoning 用 canonical `reasoning.completed`（不混名）。
- reasoning：codex 已实时 reasoning.delta（codex_app_server.py:487）→ v1 前端折叠 thinking 区显示。
- usage：claude_stream 已解析 usage（claude_stream.py:231）→ PR-3 发独立 `usage` 事件，前端显示 token 用量；codex 拿不到 → degraded。成本($)换算 follow-up。
- **显示清单（「能拿到必须显示」审计）**：command stdout(含合并 stderr)、file diff/patch、mcp args/result、claude tool_use.input+tool_result.content、reasoning.delta+completed、usage、自动审批——逐项进 canonical，缺则 degraded。

---

## B. 实施计划（7 段原子 PR，每段独立 review/回滚，绝不破坏现有 message 文本流）

### PR-1 契约 + 能力结构（inert，零对外变化）
- 新增 `display_contracts.py`（信封/enums/ToolCall/validators/truncate_field/redact_payload 直接依赖 secrets_scan.redact_secrets）。
- `ui_contracts.py` re-export + `build_display_contract_payload()`。
- `RuntimeCapabilities` **只加**字段级 flags + `capability_tier()`（保留 streaming 名；tool_events 别名映射）；**不改任何 cap 值、不加依赖发射的测试**。
- 测试：validators/truncate/redact/tier 派生/**import-cycle 静态测试**。
- 验收门：ruff+pytest 绿；对外发射事件 payload 零变化。

### PR-2 codex projection（emit-site 替换）
- `display_projection.project_codex_event` + ProjectionState；补 MCP args/result、command output、**file diff/patch 作为 output**；用 runtime item id；terminal repair（partial 填 output）；codex 终态 reasoning→reasoning.completed。
- **自动审批 emit**：扩展 `_handle_server_request` 保留 request.id/itemId/payload preview；respond 前 emit approval.requested、后 emit approval.resolved。
- codex **usage_events True→False** + 断言「codex 不发 usage」。
- `codex_app_server.run_turn` 经 projector 发 canonical（替换 flat）。
- 测试：golden fixtures（command/file-diff/mcp/interleaved/terminal-repair/无aggregatedOutput靠buffer/approval 同 id）；**更新** test_codex_app_server_runtime 断言到 canonical（语义等价）。

### PR-3 claude projection（emit-site 替换）
- `project_claude_event`；补 tool_use.input/tool_result.content；缺 name/result 标 degraded；terminal repair（partial 填 output）。
- **usage（纯行为，不翻 flag）**：run_claude_stream 发独立 `usage` 事件（用现解析的 usage）。
- `claude_stream` 经 projector 发 canonical（live caller=chat_turn.py:602 / backends.py:1274；stub adapter 不动）。
- 测试：golden fixtures + **test_claude_stream 断言「stream 含 usage 必发 usage 事件」**（不做 cap 一致性测试——claude 无 live 能力对象）+ 更新现有断言到 canonical。

### PR-4 run 通道持久化 + 索引 + inline 统一终态 + 快照读（C1/N1/A1/A2/inline bug）
- 加索引 `CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id)`。
- **状态先提交、事件 best-effort 后写（U1-deep）**：所有 run lifecycle/audit 事件写（含**事务内** `_add_event_in_transaction`，含 lease 全生命周期 acquired/released/lost/release_rejected + run lifecycle，state.py:361/490/1998）从 status/lease 提交事务**拆出**——先提交状态，再事务外 best-effort safe-write 事件（catch→计数+stderr，不回滚状态、不向 run 流程抛）。run health = `effective_status`（status+lease，**不新增字段**）。
- **SSE 按 status 强制收口（G1）**：`/events` 终止判定改为 `status in terminal → 抽干末批后 break`，不再强求 `saw_terminal`（main.py:4654），防 safe-write 丢终态事件致挂死。
- 测试（U1/G1）：注入 events insert 失败 + runs/lease save 成功，验证 ① delivery/inline 全路径不被 add_event 反杀、lease 不回滚；② 终态事件丢失时 /events SSE 仍按 status 正常 break。
- **新增 `list_events_snapshot(run_id)`（排除 *.delta，A1/A2 共用底座，T4 id-reading SQL 总带 id）** + **独立端点 `GET /api/runs/{id}/events/snapshot`（S1，非流式 JSON：{run_id,events,event_count,latest_event}）**；旧冻结 backend 缺失时 fallback=filtered list_events（**给不了 id，degraded shape**，标 id_source=none，reducer 顺序 append）+warning。
- **SSE 补 event.id（T2）**：run 通道 `/events` 的 SSE 发 `id:` 行 + payload 内携带 `event.id`（修 main.py:4649 只发 payload 无 id），支撑前端 reducer 按 event.id 去重幂等。
- **切换所有 human/API-facing list_events 消费方到快照读**：session detail（main.py:3299）、CLI 展示（tui.py:206/cli.py:3963/4015）、orchestrator RunResult.events（2004/2428/2441）；type-scanner（1331/1339）功能不变（建议改 typed 查询省长 run perf）。唯一保留全量+delta 的是 live 流式 SSE。**命名诚实**：`cli watch` 切快照读后是「结构化事件 watch」非「raw delta live stream」，文档/帮助文案据实说明。
- DL10：inline task **所有终态路径**（成功+所有失败早返回）**也发 run.completed/failed**；composed sink（events_q + store.add_event 双写，仅 inline_task_run_id 写 run events）。
- 修 SSE 终止：inline run 的 /events 在终态后真正 break（统一按 run.* 终态）。
- **v1 不物理删 delta**（仅索引+单行截断保读写有界）。
- 测试：快照读排除 delta；session detail 不暴涨；**inline run（含各失败路径）/events SSE 终态后真正 break**；delivery+inline 两路落库一致；纯 chat 不写 run events；**U1：注入 events insert 失败 + runs save 成功，验证 delivery/inline 全路径不被 add_event 反杀、run status 仍更新**。

### PR-5 前端 chat 工具卡（fixture 驱动）
- `<ToolCallCard>` + 按 call_id 聚合 reducer，渲染在 `runDirectChat` 回调；reasoning 折叠区；usage 显示。
- degraded/redacted 诚实标注；command stdout 流式；mcp args/result；duration。
- 测试：组件三态 + reducer 聚合，用 PR-2/3 golden fixtures 作夹具。
- 验收门：npm test + preview 证据。v1 chat 卡片不跨 reload 持久化（已知限制）。

### PR-6 前端 run cockpit + 审批渲染 + BATCH 诊断
- **状态分类（T1）**：前端按 `SNAPSHOT_STATES`（completed/failed/cancelled/WAITING_FOR_HUMAN_GATE）分流，**不复用 ACTIVE_RUN_STATUSES**；流式 run 加进 `watched`，SNAPSHOT_STATES 的 run 主动 GET `/api/runs/{id}/events/snapshot` 渲染卡（A1，不靠流式订阅），gate→running 重订阅。
- 共用 `<ToolCallCard>`（按 `event.id` 去重 + `call_id` 聚合 reducer，T2，绕开 slice(-79)）。前端对端点缺失/404 平滑降级不崩。
- **SSE 关闭/错误强制收口（Codex-G1-FE）**：浏览器 EventSource 无可靠 `onclose`，用 **`onerror`→`close()`→`loadRunDetail`+`loadRuns`**（当前 App.tsx:6277 只 close 不刷新）；若刷新后 `status∈SNAPSHOT_STATES` 则拉 `/events/snapshot` 渲染终态卡——防 safe-write 丢终态事件时 run 卡在 UI running 态。后端补：status-terminal 但终态事件缺失时发**非持久、status 派生的 SSE 控制帧**再关闭（该帧不入 durable reducer、不污染 event.id 空间）。测试：终态事件写失败但 status 已 completed → cockpit 退出 active 并加载 snapshot。
- 修 command.started vs tool.started 混淆。
- 审批**渲染**（后端 emit 已在 PR-2）：human-gate→可操作卡片（现有 endpoint）；自动审批→只读成对 requested+resolved；断言 display 通道无写回内核裁决的路由/handler（物理单向）。
- terminal repair/sink 诊断呈现；BATCH adapter.diagnostic + 事后静态渲染。
- 测试 + 真实 run（delivery+inline 两路）preview 证据。

### PR-7 文档收尾
- 改正 `docs/agent-runtime-display-protocol.md`（与本文一致）；一致性检查清单；`unified-task-entry.md` 收成链接。
- 注明：display 字段属 API SSE 契约，desktop 经冻结 backend 继承，SCHEMA_VERSION 变更需重打包 desktop backend。

---

## C. 每段 PR 硬约束
1. 一段一事、可独立 review/回滚；每段提交前走 Codex+Gemini 双顾问对抗验收（铁律）。
2. 不引入 tool.failed 新语义；统一 tool.completed.status。
3. 表层零新增语义：审批 decided_by 恒 kernel、无写回；内核独占 pay-switch/扫描 fail-closed。
4. 契约只在 display_contracts.py（零重依赖）；前端不另建语义源。

## D. 已诚实标注的 v1 范围切割（非缺陷，是边界）
- chat 工具卡片不跨 reload 持久化（需 ChatMessage schema 扩展，follow-up）。
- nested/parent 调用：无 v1 真实来源（codex/claude 都平铺流），follow-up。
- 成本($)换算 follow-up；但 claude 原始 usage v1 就显示。
- **delta 行物理回收**（DB 体量）：follow-up，与 transient delta lane 合并；v1 仅靠索引+单行截断保读写有界，重连/replay 得终态快照。
- 重连/replay/迟到 reader 得终态快照，历史 delta 流不保证（诚实语义，非缺陷）。

## E. 请验收方重点挑错（v14；**本文是 PR 计划非已实现代码**，请审「计划是否正确可落地」非「修复是否已在 main 存在」）
1. Codex-G1-FE：safe-write 丢终态事件时，前端 SSE `onclose/onerror` 强制 `loadRunDetail`+若 status∈SNAPSHOT_STATES 拉 snapshot + 后端发 status 派生控制帧——run 卡在 UI running 态的端到端洞，这套**计划**补对了吗？
2. Codex-U1-cover：U1-deep safe-write 拆分枚举覆盖 lease acquired/released/lost/release_rejected 全生命周期——**计划**是否完整覆盖事务内写？
3. G1/G2/U2-inline/T1-T4（上轮，gemini 已确认 G2 effective_status 落地正确）的**计划**在 v14 仍自洽、没被本轮改动碰坏？
4. 全文内部一致性：DL/PR/changelog 之间有无自相矛盾？
5. 这套 7-PR 计划的**顺序与边界**是否可独立 review/回滚、不破坏现有 message 文本流？
6. 还有没有漏掉的「能拿到却没显示」、与铁律冲突、残留过度设计？
7. 整体**计划**是否可冻结、进入 PR-1 实施（实现+测试时再验真）？

直接给：通过 / 不通过 + 阻断性问题清单。不要捧场。
