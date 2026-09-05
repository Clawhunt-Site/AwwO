# Display Protocol · run cockpit 轨道 顾问验收留痕

> 本文件留痕 run cockpit 轨道（PR-4 后端持久化/快照/SSE event.id、PR-6 前端 cockpit、inline composed sink 收敛修复）历次 Codex(gpt-5.5) + Gemini 对抗验收的**初始意见、阻断项、修复、复核结论**。
> 目的：审计时可回溯每一轮顾问意见（含最初的），确认无遗漏。chat 链路（PR-1/2/3/5）的留痕见 `docs/agent-runtime-display-protocol-advisor-ledger.md`。
> 顾问 transcript 落 `.codex-cli-advisor/` 与 `.gemini-cli-advisor/`（`.gitignore` 已忽略），可复查。

## 收敛背景

run cockpit 轨道（PR-4/PR-6/PR-7）原在隔离 clone `superclaw-pr2-fix`（分支 `fix/display-pr2-correctness`）开发并双 PASS，随后 cherry-pick 迁入收敛 worktree `dev/roadmap`，**在本地 main 基线上重验证**（115 Python + 123 web 测试全绿、ruff clean、web build 绿），并在收敛基底上对「inline composed sink」缺口做了二次对抗复核。

## PR-4 · run 通道持久化 / 快照读 / SSE event.id

**设计意图**：run 终态后 cockpit 能从持久 events 表重放 canonical display 事件（DL5 持久通道用 SQLite id；DL8 安全写）。

### 阻断项与修复（历轮）
1. **SSE 竞态（Codex，连 5 轮）**：
   - 第 1 轮 stale-doorbell：doorbell 唤醒后读不到刚写入的事件 → 改**有界轮询**。
   - 第 2 轮早退性能：每轮全表扫描 → hoist `saw_terminal_event` 标志。
   - 第 3 轮**末窗盲区**（最关键）：终态判定与最后一窗事件读取间存在窗口，最后一批事件可能漏发 → `for/else` **末窗补读** + 确定性 monkeypatch 测试锁定。
2. **best-effort safe-write（DL8）**：`add_event` 吞写入异常、计 `_event_write_failures`、打 stderr，**绝不打断实时流**（Gemini 核验通过）。
3. **快照只排除 delta**：`list_events_snapshot` 仅排除 `*.delta`，保留工具卡/审批/诊断结构事件（否则 cockpit 重放缺卡）。

### 结论
Codex + Gemini 双 PASS。落点：`state.py`（`idx_events_run`/`add_event`/`list_events_snapshot`）、`apps/api/main.py`（`/events/snapshot`、`_snapshot_events_with_ids`、SSE `_frame` + G1 终态收流）。dev/roadmap 提交 `8c0651a`。

## PR-6 · 前端 run cockpit / 审批渲染 / BATCH 诊断

**设计意图**：cockpit 两通道（snapshot 重放 + live SSE）同一 display model（DL9）；审批只读广播（DL7）。

### 阻断项与修复（历轮）
1. **snapshot 与 live wire 形状不一致**（关键）：snapshot 端点返回 row-wrapped `{id,type,payload:<envelope>}`，live SSE `data` 直接是 envelope → 前端误解析 → 新增 `snapshotRowToDisplayEvent` 把 row 归一回 envelope；`DisplayAccumulator` 按 `event.id` 去重，snapshot+live 混合不重复。
2. **G1 前端兜底**：SSE `onerror` → `loadRunDetail`+`loadRuns`（Codex-G1-FE），避免终态后前端不收口。
3. **审批只读**：`decided_by` 恒为内核，cockpit 不提供客户端回写（DL7，符合铁律「表层不新增内核没有的语义」）。
4. **BATCH 诊断**：只渲染 explicit `adapter.diagnostic`，不做自然语言重建（DL：砍假流式）。

### 结论
Codex + Gemini 双 PASS。落点：`displayProtocol.ts`（`classifyRunDisplayEvent`/`RUN_DISPLAY_EVENT_TYPES`/`snapshotRowToDisplayEvent`）、`App.tsx`（`SNAPSHOT_STATES`/`applyRunDisplayEvent`/cockpit 渲染）。dev/roadmap 提交 `d1f3094`。

## 收敛复核 · inline chat-task composed sink（DL10）

**触发**：在 dev/roadmap 收敛基底（含 chat 链路）上做基底复核时，**Codex 发现新阻断**——inline chat-task run 的 display 事件只进临时 chat SSE 队列（`events_q`）、**未持久化到 run events 表**，导致 chat-linked run 在 cockpit `/events/snapshot` 重放不出工具卡/审批/诊断（delivery 路径正确，inline 路径漏）。

> **自我交底（供审计）**：此缺口是我在 PR-4 时以「SSE 已统一终态」为由 deferred 的 DL10 持久化部分，当时把「SSE 终态收流」与「事件持久化」混为一谈、deferral 理由不充分。收敛复核把它正确暴露为阻断并修复。

### 修复
inline 路径 `lambda t,p: events_q.put((t,p))` → **composed sink**：实时 chat SSE（`events_q`）+ 持久 run events（`store.add_event`）双写；`store.add_event` 为 best-effort（PR-4 safe-write），持久化失败绝不打断实时 chat 流；纯 chat（无 `inline_task_run_id`）只写实时队列。wire 形状与 delivery 路径一致（`de.to_dict()` envelope）。

### 复核结论（二次对抗，session rc-conv2）
- **Codex（gpt-5.5）：通过，无残留阻断**。核验：`inline_task_run_id` 仅 `intent==task` 赋值、纯 chat 为 `None`；composed sink 先写 `events_q` 再有条件写库；`add_event` 吞异常不抛；wire 形状一致；`list_events_snapshot` 只排除 delta。inline e2e 测试缺口判为 **follow-up（非阻断）**；run cockpit 可标 done，待用户/浏览器实测 UI 成卡。小 caveat：SQLite busy lock 延迟（非正确性）。
- **Gemini：通过，无残留阻断**。同样确认 composed sink 正确解除阻断、best-effort 与纯 chat 隔离、wire 一致；inline e2e 判为 follow-up；run-cockpit 可标 Done（待集成环境验证）。

### 结论
Codex + Gemini 双 PASS。落点：`apps/api/main.py` inline chat-task 路径 `_inline_display_sink`。dev/roadmap 提交 `1a62693`。

## 已知非阻断 follow-up（两顾问一致，记入 backlog）
1. inline 路径端到端防回归测试（mock codex adapter + intent=task → 断言 `/events/snapshot` 重放出 display 事件）。
2. SSE `onerror` 不自动重连（当前靠 `loadRunDetail`+`loadRuns` 兜底）。
3. `add_event` 在 SQLite busy lock 下的写延迟（best-effort，非正确性）。
4. `loadRunDetail` 竞态（站点既有，非本协议引入）；空 `reasoning.completed` 保留 deltas（有意）。

## 待用户验证（收口前置）
run cockpit 轨道代码 + 测试 + 双 PASS 已完成，**待 Leon 在集成/浏览器环境实测确认 cockpit 工具卡/审批/诊断成卡**后，由用户 merge 进本地 `main`（dev/roadmap 公约第 5 条）。
