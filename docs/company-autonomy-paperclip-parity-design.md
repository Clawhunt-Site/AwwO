# Agent 公司自治 —— 严格对齐 Paperclip 的"会自己干活 + 可见 + 无多余手动门"设计

状态：草案（待 Codex + agy 对抗式评审定形）。蓝本 = 官方 Paperclip（`/Users/leongong/Documents/paperclip-ref` @ d9ea1bf）。

## 0. 问题陈述（业主实测 + DB/日志实锤）

业主创建公司"香港热点公司"，给 CEO 派了"招聘第一位工程师并制定招聘计划"工单（delivery + human_final），但：
- 工单一直显示"就绪"，点"占用工作区"按钮没反应，公司状态不显示运行中，`@ceo` 评论无响应。

**DB/日志查证（`~/.superclaw/state.db` + artifacts）**：
- 该工单 assignment wakeup **确实触发**：`finished | issue_assigned:issue_cb20275613bb | ran:run_beae297c94a3:failed`。
- CEO 跑在 **codex（A-class）**（`execution_context.backend_policy=codex`），run **失败**，worker 日志 `exit_code=124`（超时）。
- CEO 做了大量**离线规划**（hiring-plan/packet/delegation packets），但结论："control-plane readiness: not proven；E2E delegation proof: not achieved"——即**没能经控制面真正委派/招人**，只写了文件。
- 整个 run + 失败 + 原因**在 UI 上完全不可见**。

## 1. 对齐 Paperclip 的三条事实（蓝本测绘）

| 维度 | Paperclip 蓝本 | SuperClaw 现状 |
|---|---|---|
| **agent 工具** | 统一 MCP 工具集，**所有 runtime 平等可调用**（`packages/mcp-server/src/tools.ts`），权限在业务层不在工具层 | B 类 in-loop + A 类经 `team_mcp_proxy` MCP（**已实现**，但本次 run 疑似没绑上/超时） |
| **执行态呈现** | `HEARTBEAT_RUN_STATUSES`(running/succeeded/**failed**/**timed_out**…) + `IssueRunLedger` 组件 + `StatusBadge` + `HeartbeatRun.error/errorCode/retryExhaustedReason`（shared/constants.ts:645） | **几乎不可见**：仅 `status==in_progress && execution_run_id` 才显示 RunTranscript（TeamWorkbench.tsx:1268），respond/失败/超时全静默 |
| **checkout 性质** | 原子认领 + `shouldWakeAssigneeOnCheckout` **立即唤醒执行**（routes/issues-checkout-wakeup.ts）；**无"只占锁不执行"** | "占用工作区"按钮**只加锁不启动执行**（team_kernel.checkout_issue + 提示文案明说"只加锁"），是 daemon 化前手动兜底 |
| **heartbeat 默认** | timer 心跳默认 **关**，但 **assignment 唤醒永远活跃** | 一致（§6.2 种子工单 assignment wakeup 首跑，heartbeat 默认关） |

## 2. 现状已实现（避免重造）
- `team_mcp_proxy.py`（PR-4）：stdio MCP server，投影 `COMPANY_COMMAND_TOOLS` 全集，ticket 验证 + scope 重派生（已实现）。
- `orchestrator._maybe_bind_team_mcp`（1152/1169-1408）：对 `_MCP_CAPABLE_BACKENDS={codex,codex-app-server,claude}` 且 `surfaces_company_tools_in_loop=False` 的 team run 注入 MCP config + ticket。
- `company_ticket.py`（PR-3）：run-bound ticket 签发/验证。
- 结论：**A-class 工具链路已存在**。本次失败疑似命中 bail（scope=`__unresolved_company__` / toggle / posture=plan / backend 判定）或该 run 早于 PR-4。

## 3. 设计：三块（严格照 Paperclip）

### 块 A：A-class CEO 工具端到端打通 + 首跑不超时
- **A1 实测**：跑一个全新 codex CEO team run（带 assignment wakeup），核验 worker 侧 `team_mcp.projected` 事件是否发出、codex 是否真起了 `superclaw-team` MCP 子进程、CEO 能否真调 `request_hire`/`issue_delegate`。
- **A2 修 bail**：若 `_maybe_bind_team_mcp` 因 scope/toggle/posture bail，定位并修（让 delivery+human_final 的 CEO 工单 run 满足绑定前置）。fail-closed 语义保留（unresolved company 仍拒）。
- **A3 首跑超时**：CEO 首跑预算/时间过小导致 exit 124。对齐 Paperclip 的 run 预算模型——延长首跑预算或把"规划→委派"拆成多轮 wakeup（避免一轮做完所有离线规划撞墙钟）。**待评审定**：改预算默认 vs 拆轮次。

### 块 B：Issue Run Ledger + 执行态可见（照搬 Paperclip）
- **B1 内核**：把每个 issue 关联的 run 状态（queued/running/succeeded/failed/timed_out）+ 失败原因（error/exit_code/timeout）做成可查投影（沿用 wakeup `detail` + run payload status，已有数据，只缺投影/端点）。
- **B2 API**：`GET /api/team/issues/{id}/runs`（或扩 issue 投影）返回该 issue 的 run ledger（含 respond run + work run + 失败原因）。契约进 `ui_contracts`。
- **B3 Web**：工单线程显示 Run Ledger（运行中闪三点 / 失败+原因 / 超时 / no_response），公司"运行中"计数纳入活跃 run（不只 in_progress issue）。对齐 Paperclip 的 `IssueRunLedger`+`StatusBadge`。
- 不变量：表层零新增语义，只投影内核已有事实（铁律）。

### 块 C：降级"占用工作区"按钮（**双审翻案**：不做"认领即唤醒"）
- **⚠️ 原 C 已否决**：agy 实证——operator checkout 把工单推 in_progress + 锁 holder 变 API token，再入队 wakeup，daemon 醒来 `_next_work` 扫到"in_progress 但无 pending continuation"→当残余项跳过→**agent 醒了立刻 idle 退出 = 死锁**。Codex 同警：synthetic run_id 与真实 run/锁 token 不一致会留"看似有 execution_run_id、实际无 run"的烂锁状态。
- **C1（正解）**：主路径纯净回归 Paperclip——`assign_issue` 自动发 assignment wakeup → daemon **自己** checkout → 执行。**不**把界面按钮做成触发剂。
- **C2**：把"占用工作区"在 UI 上降级为**高级/operator 手动兜底抢锁**（保留纯 claim 语义，文案讲清"只占锁不执行"）。
- 治理保留：checkout 四道 fail-closed 门不动；高危副作用仍人审（柱子1，PR-1 已实现）。

### 块 A 根因订正（A1 诊断 + 锁泄漏连锁）
- **A1 实测发现**：失败 run 的 codex worker 以 **`role=explore`** 执行（worker 日志 `role=explore`）+ **零工具调用**（transcript 无 tools/call）→ 写离线计划文件 → 撞预算墙 `exit_code=124`。即公司 agent 工单被降级成通用 explore worker，丢了 team 执行身份。需进一步实测全新 codex CEO run 是否真绑 `superclaw-team` MCP（A2）。
- **A3（双审一致）**：**不**全局加大首跑预算；改"首轮强约束做一个可验证控制面动作或明确失败，规划拆到后续 wakeup"。
- **A4（锁泄漏连锁，业主实测）**：失败/超时 run 泄漏单飞锁 → agent 卡死 `agent_busy` → 后续 @提及全 `agent_busy:deferred`/`reclaimed` 被静默 skip。须：失败/超时 run 干净释放锁；回收死锁时把触发的用户 @提及重排执行而非吞掉。

## 4. 实施顺序（每块原子 PR + Codex/agy 双 PASS + 本地全量门）
1. **块 A（功能核心）**：先实测定位（A1），再修 bail（A2）/超时（A3）。没有 A，公司还是干不成活。
2. **块 B（可见性）**：直击业主体感"没反应"。
3. **块 C（去多余门）**：最小，收尾。

## 5. 铁律对齐
- CLI 唯一事实源：run ledger/checkout-wake 能力先进 core，CLI/契约同源，Web 只投影。
- fail-closed：A-class 绑定的 unresolved-company/越权仍拒；hire 仍人审；checkout 四门不动。
- 表层零新增语义：B 块只呈现内核已有 run 事实，不新增业务语义。

## 6. 待评审/业主拍板
1. A3 首跑超时：调大首跑预算默认，还是拆成多轮 wakeup？哪个更对齐 Paperclip？
2. C：彻底移除"占用工作区"按钮，还是保留为"高级 operator 手动 claim（带唤醒）"？
3. 公司"运行中"状态：纳入 respond run 吗，还是只算 work run？
