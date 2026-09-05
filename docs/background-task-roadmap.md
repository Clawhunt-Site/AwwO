# 后台任务路线图（Background Task Roadmap）

> 本文讨论 SuperClaw 是否、以及如何引入"后台任务"能力。**当前状态：仅规划留痕，不开发。** 后续任一实施 PR 仍须按项目 CLAUDE.md 铁律重新走 Codex + Gemini 验收门。
>
> **评审留痕**：本方向经过**两轮**独立对抗式评审。第一轮题目（"整个 run 脱离前台 detach 执行"）经核实后判定**问错了题**；第二轮修正为真问题（"学 Codex/Claude Code 那种 harness 给 agent 的会话内后台任务原语"）。两轮均由 Codex（gpt-5.5）与 Gemini 独立评审。简报见 `/tmp/superclaw-bgtask-brief.md`、`/tmp/superclaw-bgtask-brief-v2.md`，transcript 落 `.codex-cli-advisor/`、`.gemini-cli-advisor/`（已 gitignore）。
>
> 关联文档/记忆：[[capability-workshop-roadmap]]（方向四升迁、方向五 live todo）、[[daemon-pivot-decision]]（Team Kernel daemon）、[[unified-task-entry]]（一切皆 task/agent-runtime）、[[ghost-state-eradication]]（幽灵 running 根除 / liveness 判活）、[[cross-runtime-delegation-plan]]（委派）。

---

## 0. 北极星原则（裁决后的总纲）

> **后台并发与生命周期的掌控权，必须留在内核（RunSupervisor / 图引擎 / 调度器），绝不以"任意命令后台化"的 MCP 工具形式下放给 agent 的黑盒循环。SuperClaw 是 shell-out harness，不拥有 claude/hermes/grok 等 backend 的 turn 循环，照搬 Codex/Claude Code 的会话内后台原语必遭三连灾难：治理泄漏 + 生命周期失控 + 通知能力硬分叉。**

由此派生护栏（每个分期逐条核对）：

1. **后台能力必须受内核治理**：任何对 agent 暴露的并行/后台能力都要经 pay-switch / 扫描 / 人审门、留 evidence、有 lease/liveness、记预算账本。backend 原生后台（codex/claude 子进程内部自起）逃逸这一切，是**今天就存在的治理泄漏**，必须显式标记为 unmanaged 并尽力封堵。
2. **生命周期必须与会话对齐**：禁止"无主游离进程"（父 run 死后后台命令继续跑 → 复活幽灵 running）；也禁止"父 run 结束强杀"导致半成品状态破损。必须有显式 `ephemeral / session / durable` 三级策略。
3. **通知能力分级、不假装统一**：`list / poll / cancel / output` 可全 backend 统一；`completion notification` **不能**全 backend 统一（只有拥有 turn 循环或 event_sink 的 backend 能做到"完成即唤醒"）。UI 必须显式暴露 `notification_mode = realtime | next_turn | poll_only`，不许抹平鸿沟伪装一致（否则违反铁律2）。
4. **不造第 5 个 task 实体**：系统已有 RunSession / Team Issue / ExecutionGraph Node / TaskSession。后台任务只能是对它们的**只读投影 + 统一账本**，不得新建 durable `BackgroundJob` 表。
5. **并发/资源必须有硬上限**：默认并发 1 可接受，但必须有预算上限、唯一的预算归属、per-session/backend/user 的并发与资源闸门，不允许无界 spawn 打爆本机。

**最大单点风险（两路一致）**：把"后台"当成一个交给 agent 自由调用的工具，会让"并发调度"从内核漂移到黑盒 agent 手里 → 安全门被绕过、生命周期失控、跨 backend 行为分叉。本路线图的全部分期都服务于规避这一风险。

---

## 1. 问题的重新定义（关键转折）

用户原始诉求："Codex 和 Claude Code 本身支持后台任务，但我其它 backend 不一定支持；有些任务是不是应该后台运行？"

**核实代码后发现两个不同的问题，必须分清：**

- **伪命题（第一轮误读）**："我的 backend 进程能否脱离前台跑。" —— 在 SuperClaw 里这**不是 backend 能力，而是内核能力，且 80% 已存在**（async run + SSE-resume + daemon，详见 §2 表）。backend 只要"阻塞跑到结束返回"（全都是），内核就能用线程/daemon 后台化。这条不构成新需求。
- **真问题（第二轮）**："学 Codex/Claude Code 那种 **harness 给 agent 的会话内后台任务原语**" —— agent 在一次运行中能把活儿丢后台、自己继续、完成时收到通知、并有任务列表。codex/claude CLI **自带**这个（但运行在 SuperClaw 子进程内部，看不见管不着）；其它 backend（hermes/grok/anthropic-agent/pydantic）**没有**。

### Codex / Claude Code 的真实实现（已核实）

| | Claude Code (v2.1.177, 打包 JS) | Codex CLI (v0.137.0, Rust 二进制) |
|---|---|---|
| 后台命令 | `Bash(run_in_background=true)` detached 跨轮跑 + `BashOutput`/`KillShell`/`Monitor` 工具 | `tui/src/app/background_requests.rs` 本地后台 |
| 后台子 agent | `spawn_agent(run_in_background)` | `cloud-tasks` 云端持久任务 |
| 通知 | **完成自动 re-invoke 模型 + `task-notification` 事件** | HTTP 回调 / WebSocket / 轮询 |
| 持久化 | 会话内存 + `latestBashOutputUUID`，随会话结束终止 | SQLite + 文件系统（`codex-taskItems-v2-*`/`codex-taskDetails-v1-*`/`codex-environments-*`），跨会话跨设备 |
| 守护进程 | 无 | `app-server-daemon` |

**核心差异**：Claude Code = 会话内、轻量、re-invoke 通知；Codex = 云端任务队列、跨会话持久、有 daemon + environment 隔离。

**两种后台任务必须分开看**：
- **(a) 后台命令**：丢长命令/构建/测试/下载到后台。
- **(b) 后台 agent/子任务**：委派给另一 agent 实例。

---

## 2. 现状基线（已用代码核实，file:line）

| 维度 | 现状 | 关键事实 |
|---|---|---|
| **CLI `superclaw run`** | 前台同步阻塞 | `cli.py:3265` → `orchestrator.run_goal()` → `execute_existing_session()`（`orchestrator.py:1958`）完全阻塞；**无 `--detach`/`--background`** |
| **API 异步 run** | ✅ 已有 | `POST /api/runs?async_execution=true`（`main.py:4419`）→ `orchestrator.start_existing_goal()`（`orchestrator.py:1008`）起 daemon 后台线程；默认同步 |
| **SSE 重连** | ✅ 已有 | `GET /api/runs/{id}/events`（`main.py:4627`）用 `list_events_after(run_id, last_id)`（`state.py:536`），断开可用 last_id 续看 |
| **Team Kernel daemon** | ✅ 已落地 | `daemon.py`：`service_once()` 轮询 `claim_next_wakeup` → 门控链（invokability/per-agent 锁/budget/原子 checkout）→ `_execute()` 内 `orchestrator.run_goal()`（`daemon.py:358`）后台执行；durable（SQLite wakeup/lease/lock）；heartbeat 默认 `enabled=False`，`max_concurrent_runs=1` |
| **run 状态机 + 持久化** | ✅ 已有 | `models.py:53` 八态（created/queued/running/verifying/completed/failed/cancelled/WAITING_FOR_HUMAN_GATE）；run/event/evidence 全落 state.db（WAL） |
| **liveness 判活** | ✅ 已有 | `liveness.py:67` `effective_run_state`：lease + 进程活检(`os.kill pid 0`) + TTL 120s；stale→effective=FAILED, is_live=False；`RunMutationLeaseRenewer`（`orchestrator.py:75`）每 40s 续租。幽灵 running 已根除，表层只认 is_live |
| **MCP 工具注入** | ✅ 已有能力 | 插件经 `plugin_mcp_proxy` → `invoke_cached_plugin_tool` 的 10 层 fail-closed 门注入各 runtime；治理两次（投影 filter + 执行 recheck）。**内核已具备"把治理过的工具统一注入任意 runtime"的能力** |
| **backend 执行** | 全阻塞 | `backends.py` 各 backend `run()` 阻塞跑到结束返回 `WorkerResult`；仅 `CodexAppServerBackend` 有 `on_event=limits.event_sink` 流式回调 |
| **任务列表 CLI/API** | ⚠️ 缺 | 无 `superclaw run list`/`superclaw tasks`；API 有 `GET /api/runs`（列全部，无筛选/分页）、`GET /api/runs/{id}`、`GET /api/team/wakeups` |
| **backend 原生后台** | ⚠️ 治理黑洞 | codex/claude CLI 自带后台原语，运行在 SuperClaw 子进程内部 → **逃出 pay-switch/扫描门 + evidence + liveness + cancel + 预算账本** |

**核心判断**：底座比预期好（async run + SSE-resume + daemon + MCP 注入 + liveness 都在），但"agent 会话内后台原语"是一条**不该照搬**的路；真正紧迫的反而是 backend 原生后台的**治理泄漏**。

---

## 3. 两轮评审裁决

### 第一轮（detach 整个 run）—— 经核实问错了题
两路一致：若真要做 run 级 detach，detach 必须 durable（不能用随 CLI 退出而死的 in-process 线程），但不能盲塞进现有 team daemon（会饿死工单），应抽**通用 RunSupervisor / durable run queue**（team daemon 是它的一种调度模式）。该结论作为 §4 的承载层基础保留。

### 第二轮（会话内后台原语）—— 真问题

**两路一致的"不要"（共识，均判定原方案不通过）：**

1. **不要把"后台子 agent"映射到 Team Kernel 委派**：语义错配。Team Kernel issue 是公司级宏观工单（7 态/锁/预算/QA/审批/回流），适合 durable delegation；agent 想要的是高频轻量、强父子绑定的并行子任务。硬套 = Codex 所称"产品语义造假"。
2. **治理泄漏是真问题、严重度高（最重要发现）**：agent 在 codex/claude 子进程里自起的后台 `curl`/`pip`/扫描，逃出内核治理 + evidence + liveness。前台良性请求过审、后台外发数据，账本干净。直接撕毁铁律5。**与建不建新功能无关，是今天就存在的安全缺口。**
3. **生命周期是阻断缺口**：父 run 结束时后台命令——强杀=半成品破损；逃逸=无主游离进程（复活幽灵 running）。必须显式 `ephemeral/session/durable` 三级策略。
4. **通知不能全 backend 统一（驳回"诚实降级"说）**：Claude Code 能 re-invoke 是因为它拥有 agent loop；SuperClaw shell-out 不拥有非流式 backend 的 turn 循环，做不到中途唤醒。在非流式 backend 上 agent 发起后台任务后只能傻站着结束 turn → 业务语义硬分叉，违反铁律2。
5. **不造第 5 个 task 概念 + 资源无底洞**：已有 4 套 task 概念；无并发上限会被幻觉 agent 无限 spawn 打爆本机。

**分歧：**
- **Gemini（更绝对）**："不要给猴子发枪"，并发/调度权死攥内核图引擎，**完全不建** agent 后台工具。替代：堵泄漏 + 引导 agent 出 PlanGraph（方向五）由内核切分 + 提供**批量同步工具**（内核底层并发、对外一次同步返回）。
- **Codex（更细，做一半）**：现在就把 Team Kernel durable 委派**统一工具化 + 任务账本投影**（高 ROI、复用治理）；后台命令原语**设计但暂缓**，等 RunSupervisor 生命周期/资源/取消/证据闭环再上，且永不开放任意命令；通知必须分级 `realtime/next_turn/poll_only`。

**主代理裁决**：两人比看起来更接近——**都同意"现在不建 agent 可调用的任意后台命令工具"**，分歧只在"durable 委派要不要现在工具化"。采纳"先做两路都同意的、高价值低风险部分，durable 委派工具化与后台命令归 RunSupervisor 设计先行、建设延后"。三管齐下见 §4。

---

## 4. 裁决后的方案（按价值/风险排序）

### 方向一　堵 backend 原生后台的治理泄漏（头等、最先做）
**目标**　消除"agent 在 codex/claude 子进程内部自起后台任务、逃逸内核治理"的安全缺口。这是唯一**今天就存在、不依赖任何新功能**的真问题。

**方案**
- 核实并清点：SuperClaw 在每个 backend 的启动参数/tool schema 里，实际给 agent 放行了哪些原生后台能力（codex 的 background shell、claude 的 `run_in_background`、各自的 spawn）。
- 显式标记 backend 原生后台为 **unmanaged capability**，**绝不计入** SuperClaw 受治理任务账本，UI 不得展示为"已治理"。
- 可配置处**收紧/禁用**原生后台 tool schema；进程组回收（reap）backend 子进程产生的僵尸/游离进程。
- **要宣称 fail-closed 必须有真 enforcement**：进程组、wrapper shell、cwd/env/net 权限、工具白名单、审计、超时、kill 验证——不能靠 prompt 自觉。
- 铁律5 红线：pay-switch/扫描类不能"尽量走治理"，必须 fail-closed。

### 方向二　内核批量/并行同步工具（满足"并行子活儿"的真实需求）
**目标**　agent 想"并行查这三个文件 / 并行 grep / 并行分析"时，由内核底层多线程并发执行，对 agent 表现为**一次同步返回多结果**。

**为什么这是最干净的解**
- 无后台语义暴露 → 无通知难题、无生命周期难题。
- 全 backend 统一（同步返回，不依赖 turn 循环/event_sink）。
- 完全受内核治理（每个子调用过同一权限门、留 evidence）。
- **覆盖了 agent 想要"后台"的绝大多数真实场景。**

**方案**　内核提供 batch tool（如 `batch.read` / `batch.search` / `batch.invoke`），底层受控并发 + 资源上限，结果聚合同步返回；并发/超时/资源闸门在内核。

### 方向三　长任务归内核规划，不归 agent 随手丢后台
**目标**　长构建/测试/下载/扫描等真正需要"挂后台"的活儿，由**内核规划**承接，而非 agent 运行时随性 spawn。

**方案（诚实模型：统一任务账本 + 分级通知）**
- 长任务规划为一个 **RunSupervisor 调度单元**（承接第一轮共识，team daemon 是其一种消费模式）或 **Team Kernel durable 委派**（durable 场景）。
- **生命周期三级**：`ephemeral`（父 run/session 结束即 cancel，后台命令默认）/ `session`（父 run 结束仍可同会话 list/poll，有 TTL）/ `durable`（跨会话，升级为 Team Kernel issue 语义）。默认：后台命令 kill-on-session-close + TTL + 资源预算；后台 agent durable 走 Team Kernel。
- **统一任务账本（只读投影，非新实体）**：`task_id / type / lifecycle / status / owner / parent_run_id / source_kind / capabilities / evidence / cancelability / notification_mode / managed=true|false`。保留 `source_kind/owner/run_id/issue_id/is_live/effective_state/allowed_actions`，否则 UI 必把"工单状态"伪装成"执行状态"。
- **分级通知**：codex app-server/event_sink → `realtime`；非流式 backend → `next_turn`（turn 边界注入上下文）或 `poll_only`。UI 必须显式展示 `notification_mode`，**不假装一致**。
- CLI parity（铁律1/2）：CLI 先有 `run list --status --backend --limit --cursor`（带筛选/分页）、`run attach`/`run logs`（基于 events+last_id）、`run cancel`（best-effort，杀不掉的远端任务在状态里暴露），Web/Desktop 只做只读投影。
- 列表一律用 `effective_run_state`/`is_live`（liveness 推导），不信裸存储 `running`。

**始终不做**：把 Team Kernel issue 包装成轻量 session child agent（语义造假）；开放任意后台命令给 agent；无法封堵 backend 原生逃逸时谎称已 fail-closed；新建第 5 个 durable task 实体。

---

## 5. 分期（构建顺序 ≠ 用户直觉顺序，表层一律最后）

```
P0 治理泄漏核实与封堵（方向一）────────────────────────────────┐
  · 清点各 backend 放行的原生后台能力；标 unmanaged；收紧 tool schema
  · 进程组回收 + 真 enforcement 雏形；pay-switch/扫描 fail-closed 复核
        │  （不依赖任何新功能，纯安全收口）
        ▼
P1 批量/并行同步工具（方向二）──────────────────────────────────┐
  · 内核 batch tool + 受控并发 + 资源上限 + 同步聚合返回
  · 全 backend 统一、受治理、无后台语义（吃掉多数"并行"需求）
        │
        ▼
P2 统一任务账本契约（方向三 契约先行）──────────────────────────┐
  · ui_contracts.py 定义 task projection（含 managed/notification_mode/lifecycle）
  · 对现有 RunSession/Team Issue 的只读投影，零新增 durable 实体
        │
        ▼
P3 CLI parity + 只读 Activity 表层 ────────────────────────────┐
  · superclaw run list/attach/logs/cancel；Web/Desktop 只读投影
  · 列表用 is_live；非流式 backend 不展示假实时 token
        │
        ▼
P4 通用 RunSupervisor 基座（承接第一轮共识）────────────────────┐
  · supervisor 状态机/lease/pid+进程组/artifact stdout/预算/TTL/crash recovery/cancel proof
  · team daemon 降为其一种调度模式
        │
        ▼
P5 受限后台命令（方向三 建设；依赖 P4）
  · 仅白名单类别（test/build/lint/download），过同一权限门
  · 默认 session-scoped + TTL kill，不允许无主持久化
        │
        ▼
P6 durable 委派工具化（Codex 的"做一半"；接 Team Kernel）
  · delegate.create/task.list/task.get/task.cancel，诚实呈现为 durable delegated task，不伪装成 session child agent
        │
        ▼
P7 通知分级落地 + 完成通知（依赖方向四升迁通道做无人值守续跑）
```

**与无人值守的依赖**：后台任务撞 pay-switch/扫描/人审门时，detached 模式没有前台交互审批 → MVP 必须 fail-closed park（撞门即停、留证据、用户手动 requeue）；真正"后台异步审批后自动续跑"是 [[capability-workshop-roadmap]] **方向四（升迁通道 EscalationEnvelope）** 的硬依赖。方向四没落地前不要承诺"后台任务可无人值守完成"。

---

## 6. 完整性缺口清单（建设前必须闭环，Codex 强调）

- 资源隔离：每 session/user/backend/task 的并发、CPU、内存、磁盘、网络、超时上限。
- 预算归属：后台任务消耗算父 run / session / workspace / Team budget？**必须唯一。**
- cancel 语义：本地进程 kill、进程组 kill、远端 job cancel、不可取消任务的状态表示。
- 崩溃恢复：supervisor 重启后从 pid/lease/started_at/stdout/evidence 重建状态（主动扫描器，非被动读）。
- 输出截断：后台输出不能无限写 state.db；需 artifact 文件 + tail + 摘要 + 敏感信息过滤。
- 权限重审：spawn 时审批一次不够，执行前（尤其延迟执行）必须 recheck。
- unified-task-entry 冲突：[[unified-task-entry]] 的"一切皆 task"理念下，不得再造第 5 套 task 概念。
- 可见性：CLI/API/Web/Desktop 必须同一 task id、状态机、错误码、evidence path。
- 原生 backend 逃逸：至少标记 unmanaged，不得混入 governed list。
- 通知机制：完成怎么告知用户？非流式 backend 退而求其次 = 可查询账本，不是"agent 自动收到通知并继续"。

---

## 7. 评审结论与留痕

- **第二轮草案判定**：Codex（gpt-5.5）"该做一半，按现说法不通过"；Gemini"严重跑偏，不应做 agent 后台工具"。两路一致的阻断点：治理泄漏 / 生命周期失控 / 通知能力硬分叉 / 概念爆炸。
- **主代理裁决**：采纳两路共识——不建 agent 可调用的任意后台命令工具；先做"堵泄漏 + 批量同步工具"（两路都同意、高价值低风险），durable 委派工具化与后台命令归 RunSupervisor 设计先行、建设延后；通知分级、不假装统一。
- **一句话总判**：你想要的"Codex/Claude Code 那种后台任务"，在 SuperClaw 里**不该原样照搬成 agent 工具**（shell-out harness 不拥有那些 backend 的 turn 循环 → 治理泄漏 + 生命周期灾难 + 通知硬分叉）。正确做法：**先堵 backend 原生后台的治理泄漏 → 用内核批量同步工具吃掉"并行子活儿" → 长任务归 RunSupervisor/Team Kernel 用"统一账本 + 分级通知"承接**。并发权死攥内核，不下放 agent。
- **本文状态**：仅规划留痕，**暂不开发**。任一实施 PR 仍须重新走 Codex + Gemini 验收门。
- **transcript**：`.codex-cli-advisor/transcripts/bgtask*.jsonl`、`.gemini-cli-advisor/transcripts/bgtask.jsonl`（已 gitignore）。

---

## 8. 与现有规划的衔接

- 方向一（堵泄漏）：与 [[capability-workshop-roadmap]] 方向四（升迁/治理）、铁律5（fail-closed）同源；可作为独立安全收口先行。
- 方向二（批量同步工具）：纯内核能力，无表层依赖，最先可落。
- 方向三（长任务归内核）：承接第一轮 RunSupervisor 共识 + [[capability-workshop-roadmap]] 方向五（PlanGraph/ExecutionGraph 执行轨迹）+ [[daemon-pivot-decision]]（Team Kernel durable 委派）+ [[unified-task-entry]]（一切皆 task）。
- 无人值守续跑：硬依赖 [[capability-workshop-roadmap]] 方向四（EscalationEnvelope durable 异步人审）。
- 委派语义：与 [[cross-runtime-delegation-plan]] 的"受治理委派"对齐，durable 委派工具化（P6）应复用其控制面，不另起路由引擎。
