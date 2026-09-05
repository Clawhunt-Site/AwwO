# 原生审批归一化 + 延迟响应异步 broker 设计（Escalation 方向四 P2 + D5）

> **状态**：设计已经 Codex(gpt-5.5) + Gemini **设计级双顾问咨询判定 SOUND、可进入实现**（2026-06-15，无方向性阻断缺陷；下列「必修点」为两位提出、已纳入）。本文是实现基线，每个相位仍按铁律走 Codex+Gemini 代码级双 PASS。

## 0. 问题
codex app-server(A 类)的原生 `requestApproval` 回调目前在 `codex_app_server.py:_handle_server_request` 被**静态策略即时自动应答**（`CodexApprovalDecision`），人看不到、不能答（权限模式框架 §4 矩阵的 ❌：「回调存在但被策略自动应答；待审批队列落地才可为 ✅」）。审批队列(escalation D1/D2/D3)已落地。目标：
- **P2**：把原生回调归一化成 `EscalationEnvelope`(kind=`runtime_tool`)进同一队列/弹窗；**默认 decline，绝不自动 accept**。
- **D5**：能在 handler 侧挂起等人答 —— 但**此前被 defer**，理由：在 handler 内同步阻塞会让外层 timeout/cancel/retire 停摆。

## 1. 关键可行性（已读 codex_app_server.py 核实）
- `CodexAppServerClient._read_stdout` 是**独立后台线程**，只把 server-request/notification **入队**；等待审批**不阻塞 codex 输出 drain**。
- `run_turn` 主循环**每轮**查 `cancel_check()`、`now>=deadline`、post-tool stall、`is_alive()`，再非阻塞 `take_server_request(timeout=0)` 取审批。
- → **把「阻塞式 D5」改成「延迟响应异步 broker」**：审批**不立即 respond**，记成挂起项，让 run_turn 循环继续转（本就每轮查 cancel/deadline），每轮轮询「被人答了吗」，答了/超时/cancel 再 respond。**外层 timeout/cancel 照常生效，不阻塞、不死锁。** 旧的「在 `_handle_server_request` 内同步等人答」仍是阻断缺陷，不采用。

## 2. 设计

### 2.1 内核（escalation.py / state.py，加法、inert）
- 复用已 reserved 的 `EscalationKind.RUNTIME_TOOL`。新增 `make_runtime_tool_escalation(*, run_id, session_id, principal, method, action_digest, prompt_text, reserved_path=None, ttl_seconds, ...)`：双签名、PENDING 入库，沿用 D1 的 `validate_new_envelope`/单次票据/`consumed_grants` 机制（**授权核心零改**）。
- **必修(Codex)**：`grant_authorizes` 现仅接受 `PERMISSION` kind，**不能直接松绑**。加 **runtime_tool 专用 typed authorizer/consume**（或把 verifier 参数化但 **kind 分支硬隔离**）。
- 决策查询：runtime_tool 专用 `resolve`/poll —— 查这条 escalation 是否 approved(有未消费 grant)/denied/expired。

### 2.2 broker（codex_app_server.py run_turn 循环内）
取到 `*/requestApproval` 或 `mcpServer/elicitation/request` 时：
1. 经 broker 建 `RUNTIME_TOOL` EscalationEnvelope(durable→/api/escalations 队列 + D3 弹窗)；发 `approval.requested` 显示事件。
2. **不 respond**。记入 `pending_native_approvals`：**按 `codex_request_id` 为键的 dict**（必修(Gemini)：可能并发多审批）。`continue`。
3. **每轮** `_poll_pending_approvals()`（在已有的 cancel/deadline/alive 检查之后）：
   - approved → `client.respond(codex_request_id, accept-shape)` + 消费 grant + **此时才发 `approval.resolved`**（必修(Codex)：resolved 延到真实 respond 后，来源 human/kernel）+ 清除。
   - denied/expired/超 per-approval 上界 → `respond(decline-shape)` + resolved(decline) + 清除。
4. **退出路径**（cancel/deadline/stall/exit/turn 结束，break/return 前）：对所有仍挂起的 `codex_request_id` **best-effort decline-respond** 再退（必修：不悬空 codex 请求）。**respond 失败不得覆盖原始 timeout/cancel** —— 记录后 **retire session**；进程已死则 retire 是唯一安全结果。
5. **必修(两位都提)：stall-timeout 冲突** —— 挂起审批期间**暂停/豁免 `post_tool_quiet_timeout` 静默计时**（否则慢人答被 30s 提前 decline）；挂起期间只由 **per-approval 上界 + run deadline** 控制。total deadline 继续走（人离开 2h→turn 超时→全部 fail-closed decline 是正确韧性行为）。
- **per-approval 上界** = `min(escalation TTL, SUPERCLAW_NATIVE_APPROVAL_TIMEOUT, 剩余 budget)`，且**必须 ≤ C0 spike 实测的 codex 容忍窗**。

### 2.3 wiring（orchestrator→codex backend→session，gated，back-compat）
- broker 由 orchestrator 注入（它有 store+run+principal），沿用 B 类 `escalation_gate` 注入风格：`limits` 加 `native_approval_broker`。
- **gating 精确（必修(Codex)）**：
  - **仅 `default`/`ask` 姿态 + 有 operator(broker 注入) + flag** → 启用 broker(P2+D5)。
  - `allow`/`dontAsk`/`bypass`：approval_policy=never，不发 requestApproval，不进 broker。
  - **`acceptEdits`/`auto`：维持现状静态决策（当前 auto-accept file/MCP），不被「有 broker」误改成人审**（除非未来明确改语义）。
  - broker 未注入(纯 chat/测试/headless) → 维持现状静态 `_handle_server_request`（零回归）。
- flag：`SUPERCLAW_NATIVE_APPROVAL_BROKER`（默认关，fail-closed 读取）。

### 2.4 digest 绑定（必修(两位)）
`action_digest` 必须绑**完整原始语义 payload**（非 UI preview），改一字节即失效：
- **command**：完整 command + cwd（+ reason）。
- **fileChange**：绝对路径 + **patch/diff**；若 codex 只给 path → 只能批「路径级文件变更」或 fail-closed。
- **permissions**：只能返回 requested permissions 的**子集**；digest 绑 scope + 具体权限。
- **mcp elicitation**：区分「确认工具调用」vs「真要用户输入内容」；后者**不能用空 `{}` 假装回答**。
- 建议 digest 组成：`method + threadId + turnId + item/request id + canonical(params) + policy snapshot`。

## 3. fail-closed 不变量
- broker 引擎下**绝不自动 accept**：仅当内核存在「对这条精确动作、由绑定 principal 批准的、未消费单次 grant」才 accept；其余(无人答/超时/cancel/断连/未知 method/digest 不符)一律 decline。
- 退出/中断时挂起审批一律 decline-respond，不悬空；respond 失败→retire。
- broker 未注入→静态回落(back-compat，非放宽)。

## 4. 分期（都在 feat/native-approval，各双 PASS）
- **C0 spike（gating，先做）**：真 codex app-server 延迟 respond 容忍度实测 —— 分别延迟 5s/60s/300s 后 respond，覆盖 command/file/permissions/mcp，以及 interrupt 后 late respond。**定 `SUPERCLAW_NATIVE_APPROVAL_TIMEOUT` 默认值 ≤ codex 容忍窗。若实测 codex 完全不容忍 delayed approval → 回 P2-only(建 envelope+可见+fail-closed 即时 decline，不等人) 并重新评审。**
  - **✅ C0 已做(2026-06-15,真 codex-cli 0.137.0)**:`approval_policy=on-request`+`sandbox=workspace-write` 触发 `item/commandExecution/requestApproval`;**延迟 30s 后 respond accept → codex `turn/completed`(status=completed,duration 42s,连接存活)**。→ **核心假设成立:codex 容忍 ≥30s 延迟审批并正常完成**,延迟响应 broker 可行,无阻断。默认 `SUPERCLAW_NATIVE_APPROVAL_TIMEOUT` 取保守值(如 120s)+ 可配;ceiling(60/300s)+ file/permissions/mcp 四 method + interrupt-后-late-respond 留实现期细化(非 gating,机制已证)。
- **C1 内核**：`make_runtime_tool_escalation` + runtime_tool typed authorizer/consume（纯加法 inert）。
- **C2 broker + run_turn 集成**：pending dict + 每轮 poll + 退出 decline-all + stall 豁免 + resolved 延后；fake-client 单测。
- **C3 wiring**：orchestrator 注入；gating(仅 default/ask+operator+flag);其它静态回落。
- **C4 表层**：D3 弹窗复用(runtime_tool kind)；补 method-specific 文案 + digest/decision 审计。

## 5. 留痕
- 设计级咨询：Codex(gpt-5.5) plan-mode 判 SOUND（强调 C0 spike 是唯一可能翻盘点 + 上列必修）；Gemini plan-mode 判 SOUND（强调 stall 豁免 + pending dict + 退出清理）。transcript 落 `.codex-cli-advisor/`、`.gemini-cli-advisor/`。

## 6. 实现状态(2026-06-15,feat/native-approval,stacked on feat/escalation-d1-d2)

- **C0 spike** ✅ 真 codex 0.137 容忍 30s 延迟审批正常完成(commit 9234fe9)。
- **C1 内核** ✅ `make_runtime_tool_escalation` + runtime_tool typed authorizer(kind 双向硬隔离)+ validate 泛化(commit 5977d42,双 PASS)。
- **C2 broker + C3 wiring** ✅ run_turn 延迟响应 broker(timeout 优先不消费/stall 豁免/退出 decline-all/last_event_at 重置)+ StoreNativeApprovalBroker + consume_runtime_tool_grant + WorkerLimits/backend 穿线 + orchestrator gating(flag+非full posture)(commit 5dbd82e,两轮双 PASS,首轮 5+2 阻断闭合)。
- **C4 表层** ✅ **无需新代码**:D3 的 `EscalationGate` 弹窗按 prompt_text+options kind 无关渲染,runtime_tool escalation 自动进 `/api/escalations` 队列并弹出;method 文案由 broker 的 prompt_text 提供。post-merge(D3 + native-approval 均合 main 后)端到端验证。

**flag**:`SUPERCLAW_NATIVE_APPROVAL_BROKER`(默认关=零回归)。**默认超时**:`SUPERCLAW_NATIVE_APPROVAL_TIMEOUT`(默认 120s)。**未推**,待 Leon 验证。
