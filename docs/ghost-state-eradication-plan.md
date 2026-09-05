# 根除"幽灵进行中"状态：设计与落地计划

> 状态：已定稿（Claude + Codex gpt-5.5 + Gemini 两轮交叉质询收敛）。待实施。
> 咨询转录：`.codex-cli-advisor/transcripts/ghost-state.jsonl`、`.gemini-cli-advisor/transcripts/ghost-state.jsonl`

## 问题定义

**幽灵进行中状态（ghost in-progress state）**：存储里声称 running/pending，但实际没有任何活的执行者在干活。表现为侧栏历史会话永远转圈，刷新/重启不消失。

已确诊的两个缺陷实例：

1. **悬空用户消息 → 永久 pending**：前端 `chatSessionActivityStatus`（`apps/web/src/App.tsx:794`）从"最后一条非用户消息的 status"推导会话状态；会话以用户消息结尾（turn 失败/中断/关 app 时失败路径不落 assistant 消息）→ 永久 `pending` → spinner。内核 `ChatMessage` 根本没有 status 字段，前端读的是 undefined fallback——整个状态是表层编造的。
2. **run 卡死 RUNNING**：`orchestrator.execute_existing_session`（`orchestrator.py:2179`）只捕获 lease-lost 一种 RuntimeError，其它异常逃逸后 status 留在 running、lease 在 finally 被释放（实测卡死 run 的 `active_mutation_lease` 为空）；没有任何自动 reconcile 触发点（`reconcile_run()` 已存在但只能手动调）。

## 核心原则（三方共识）

> **"进行中"不是静态属性，而是需要持续证明的动态契约。**

1. **存储状态 ≠ 活性**。`status=running` 只表示"最后一次持久化到的阶段"；对外的"是否在跑"必须由内核在读取时结合 lease 活性计算出 `effective_status` + `is_live`。任何 read model 不得因为存储字段就声称在运行。
2. **复用现有 `RunMutationLease`，绝不新建第二套活性机制**。已有 lease_id/worker_pid/worker_host/TTL/`_run_mutation_lease_stale_reason()`/`reconcile_run()`（fail-closed + resume frontier 语义），缺的只是续约 + 自动触发。新建 lease 表或 `last_heartbeat_at` 并行字段 = 双源事实（split-brain）。
3. **chat 状态唯一事实源 = 关联 run 的 effective liveness**。不新建 chat_turn 表、不给 ChatMessage 加 status（那是把错误模式制度化）。配合 unified-task-entry 方向：每个用户 turn 创建时即绑定 run_id；messages 退化为纯 transcript，不再承担状态机职责。
4. **transcript 绝对诚实**。禁止给历史悬空会话补伪造的 assistant failed 消息；崩溃了 assistant 就是没说话，这是事实。中断状态由 read model 表达（`activity_status=interrupted` / `legacy_incomplete_tail=true`），UI 渲染系统级中断提示，不伪造聊天气泡。如需 transcript 闭环，用 system/error event，不用 assistant message。
5. **表层防御不违反"表层不加业务语义"铁律**。违反铁律的恰恰是现状：前端从消息尾部发明 pending。正确边界：内核输出 `effective_status/is_live/stale_reason`，前端 spinner 只认 `is_live=true`。SSE 断开只影响订阅展示（"连接断开"），不得宣判 run 死亡（run 可能还在后台跑），以 REST 状态为准。

## 关键机制裁决

### Lease 续约（heartbeat）
- 给 `RunMutationLease` 加 `last_renewed_at` 字段（**不要**复用 `acquired_at`，租约取得时间不应被心跳覆盖）。
- 只有 run owner（实际干活的线程/loop）renew；renew 间隔 = TTL/3 + jitter（如 TTL 60s → 20s renew）；在状态变更/event/evidence 落库时顺手 coalesce renew 减少额外写。WAL 模式下 <1 TPS，无锁风险。
- **为什么 pid 检测不够**：worker 是线程时 `os.kill(pid,0)` 只证明进程活着；线程死锁、future 丢失、协程被取消但 API 进程仍在，pid 检测全部误判为 live。心跳必须由干活的执行体发出（证明它还有 CPU 调度）。
- 判活谓词：`status ∈ active_states` 且存在未 released、未超 TTL（按 last_renewed_at 算）、owner 进程活着的 lease ⇒ `is_live=true`；否则 effective 为 `failed(worker_lost)`/abandoned。终态永远覆盖 lease。

### 终态保证（纵深防御，四层）
`kill -9`/断电无法保证"终态一定写入"，能保证的是"读取永不撒谎"：
1. **执行入口统一兜底**：扩大异常捕获面（`Exception` + `CancelledError` + `KeyboardInterrupt`，不再只认 lease-lost）；finally 里"仍持有同一 lease 且状态非终态"才收口为 failed，不得覆盖 completed/cancelled/lease-lost（CAS 语义）。API `/api/chat` 等入口外层同样必须 catch 落终态。
2. **startup reconcile**：API lifespan / CLI init 扫 active status + 无 lease/stale lease 的 run，逐个调 `reconcile_run()`。
3. **lazy reconcile（读时触发，限量）**：GET 发现疑似 stale → 同步返回计算出的 non-live view（不阻塞 GET），并触发走 `reconcile_run()` 的写回（受 mutation lease 互斥；列表接口限量/去抖，避免一次 GET 批量写锁抖动）。**禁止裸 `UPDATE status='failed'`**——必须走 reconcile_run 保留"可重建 resume frontier 则 queued，否则 failed"的语义。
4. **periodic sweeper**：后台周期（~60s）扫一遍，兜住"无人读取"的场景。

（Gemini 主张读时只算不写、写全交 sweeper；Codex 主张读时触发 reconcile 否则 CLI/SQL 永远看到旧谎言。合成：读路径**计算即时返回** + **异步限量触发标准 reconcile**，两边的风险都消掉。）

### 存量数据自愈
- 1 个卡死 run：startup reconcile 自动转 failed(worker_lost)/queued。
- 5 个悬空会话：read model 判定 `legacy_incomplete_tail` → UI 显示"已中断"，不动 DB、不补消息。

## 不变量（必须写进测试）
1. 对外显示 running 的 run 必有未过期、owner 活着的 lease。
2. 终态 run 不得拥有 active lease。
3. active status + 无效 lease 经读取后必须呈现为非 live，不得继续 running。
4. chat 会话活性不得由尾部消息推导；显示进行中的会话必关联 live run 或 human gate。
5. CLI/API/Web/Desktop 对同一 run/session 的 effective_status 一致。

测试策略：TTL/CAS 边界单测；异常/timeout/CancelledError 集成测试；**crash 注入**（子进程跑 run 后 `kill -9`，重启后断言不转圈）；**死锁注入**（线程卡死、进程活着，断言心跳断裂判死）；时间旅行测试（拨快时钟断言 stale）；legacy 迁移测试（构造悬空会话 + 卡死 run，自愈）；前端 Vitest 断言 spinner 只来自 `is_live`，mock 任何消息形状都不转圈；Tauri installed-bundle 重启冒烟。

## PR 序列（5 个，PR1-PR2 为阻塞主线）

| PR | 内容 | 验收 |
|---|---|---|
| PR1 `fix(core)` | lease renew（last_renewed_at）+ 执行入口异常收口（CAS finally）+ `effective_run_state()` | 异常/cancel/长任务持续 renew 均无 ghost；死锁注入判死 |
| PR2 `fix(core)` | startup + lazy（限量、走 reconcile_run）+ periodic sweeper | 构造 stale run 重启/GET 后按 frontier 规则转 queued/failed；并发 GET 只产生一次有效 reconcile |
| PR3 `fix(api)` | session payload 输出 `activity_status/is_live/legacy_incomplete_tail/reason`；新 turn 绑定 run_id；废除 message.status 假设 | 5 个悬空会话不再 pending；transcript 零污染 |
| PR4 `fix(web)` | 删 `chatSessionActivityStatus` 尾部推导；spinner 只认 `is_live`；SSE 断开显示连接态不判死 | 刷新/重启/断流/legacy 均不无限转圈 |
| PR5 `fix(desktop)` | 桌面启动路径确保 startup reconcile 生效 + installed-bundle 冒烟 | 装机 app 重启后历史侧栏无幽灵 spinner |

注意装机 app 跑的是冻结 backend（见 memory: installed-app-frozen-backend），PR5 验收必须含重打包冒烟。
