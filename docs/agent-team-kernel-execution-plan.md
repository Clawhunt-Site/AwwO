# Agent Team Kernel — 完整可执行 Plan（成本治理 + Paperclip 嫁接）

Status: 可执行规划（三方收敛：Claude 测绘 + Codex GPT‑5.5 + Gemini；第三轮纳入"成本治理"；第四轮纳入"A2A 闭环"并验收可行性）。2026-06-17 更新：`dev/roadmap` 已补齐 Paperclip 本地团队流水线的最后阻断项：bootstrap 不再停在 proposal，Team Workbench 不再是禁用壳。
Date: 2026-06-09
关系：本文 = **怎么做（可执行任务/文件/CLI/API/测试/验收矩阵）**；姊妹文 `agent-team-kernel-paperclip-adoption-plan.md` = **为什么/取舍（Paperclip 吸收的战略裁决）**。两者一致，以本文的任务分解为施工依据。
铁律：**CLI 是唯一事实来源**；SQLite 单机单租户；表层零新增语义、mutation 只走 API；Fail‑closed 默认。

---

## 0. 一句话总纲

> SuperClaw 的 **Chat、单次交付、团队成员**底下是同一种东西——**一次 agent run/turn**。我们把两根地基钉进这个 run 层：**①「角色行为契约 charter」让组织会运转（缺口 C）；②「CostEvent 成本账本」让每一次消耗可追溯**。然后在其上套 Paperclip 级的"建公司引导 + 组织可视化 + 成本视图"，每个动作都先过权限门与成本门。**先有账本和契约，再有漂亮 UI。**

**统一抽象（Codex 修正，已采纳）**：不要把"run"等于"花钱"。正确表述是 **"AgentRun/Turn 是审计容器，`CostEvent` 记录其中可计量的消耗"**。dry‑run/shell/纯工具调用是 run 但未必有 token 成本；付费插件/外部 API 可能花钱但不是模型 run。

---

## 1. 三方对成本治理的收敛（A–E 结论）

| 议题 | 收敛结论 |
|---|---|
| A. Chat=单 agent 退化态？ | ✅ 对（作为目标抽象）。**当前代码尚未兑现**：`/api/chat/stream` 普通 chat 无 `run_id`，只有 plugin task 建 inline run，direct chat 是 subprocess turn。→ P1 必须给每个 chat turn 分配 run/turn id。统一容器是 AgentRun/Turn，不是"花钱" |
| B. CostEvent 落点 | ✅ **独立 `cost_events` 表（append‑only 账本，唯一合格）** + `WorkerResult.cost: CostSnapshot\|None`（供 evidence 回读）。**不塞 `EvidenceBundle.backend_summary`**（那是"小票/环境摘要"，不可按 scope 聚合/幂等） |
| C. 采集点 | ✅ **backend 只返回 `CostSnapshot`，绝不直接写账本**（retry/fallback/并发会重复计数）。由 **orchestrator 在记 `worker_result` 的同一处**调用 `store.record_cost_event(...)`；chat turn 在 turn 结束的同一 recorder 里记。幂等键去重。usage 缺失 **fail‑open 但必须落 `usage_status=unavailable` 事件** |
| D. 预算治理 | ✅ P0 只记账；P1 软告警 + burn‑down；P2 硬停（超预算阻断新 costable run/checkout/chat plugin task → issue 置 blocked → 人审加额度）。`budget_seconds` 是墙钟 timeout **不是成本预算**，需拆字段。高危=**权限门 ∧ 成本门 都要过** |
| E. P 级 | ✅ **`cost_events` 从 P2 升 P0**（run 层承重墙，与 charter、CompanyProfile/WorkspaceProfile 并列）。硬停 = **P2**。价格表/USD/真实计费 = P3 |

---

## 2. 承重墙（P0）= 三根柱子并列

```
                 表层：Chat 侧边栏成本 · Team 工作台 · 成本视图（都只是 query view）
                                    │ 读
   ┌────────────────────────────────┴────────────────────────────────┐
   │  柱1 charter 进运行时        柱2 治理命名空间        柱3 成本账本   │  ← P0 run 层地基
   │  AgentProfile.charter        CompanyProfile         cost_events    │
   │  + parent_id 委派            WorkspaceProfile        + CostSnapshot │
   │  + orchestrator 注入         (替 hardcoded local)    + idempotency  │
   └────────────────────────────────┬────────────────────────────────┘
                            AgentRun/Turn（chat / delivery / team_member 共用）
                                     │
                            backend 调用（usage/tokens/seconds 真实来源）
```

---

## 2.6 A2A 闭环（用户内核 · 第四轮三方验收）

**可行性判定（Codex + Gemini 一致）：真实可行，不换底座**——用现有 `RunSession 树 + spawn_child_runs + WorkerResult + 成本账本` 做 **同步「树形函数调用 / Call-Stack A2A」**；不做常驻 daemon / 消息总线 / heartbeat 队列。**当前 P0 还不是闭环**（charter 零消费、无委派触发、子 run 不渲染 charter、装备未投影）。

**同步 vs 异步**：MVP = **同步**（父 run 提委派 → orchestrator 起子 run → 父等聚合）；异步（`delegate_sub_issue` 建 issue 等 checkout/queue runner）= P2 共存。

**委派触发协议（仲裁：采 Codex marker，非 MCP tool）**：模型在输出里**提议** `<superclaw_delegation_requests>[{assignee_agent_profile_id,title,description,aggregation,requires_now}]</...>`；**orchestrator（父进程）在 worker turn 结束后解析→校验→才执行**。理由：① 全后端通用（CLI `--print` 模式无法 mid-turn 阻塞等子结果，MCP tool 在独立 proxy 进程无法同步回调）；② **模型提议、内核裁决** = 严守"CLI 唯一事实源"。MCP tool `superclaw__delegate` 留 P1 给 MCP-capable 后端做更好 UX。

**闭环四件事（必须全做才算"机制真实可行"）**：
1. **charter 消费**：新建 `agent_prompt.py::compose_agent_system_prompt(agent_run_context, task, goal, ...)`；`WorkerLimits` 加 `agent_run_context`；所有 backend `_prompt()` 统一注入（CLI 后端作 prompt 前缀 / API 后端进 system role）。
2. **委派触发**：`DelegationRequest` dataclass + orchestrator `_parse/_validate/_execute_delegation_requests`；每 turn ≤1、assignee 存在、禁自派/环/越 workspace/超深度/未授权装备；解析失败只记 finding。
3. **以 B 身份执行**：解析后 `delegate_sub_issue`(审计 issue) + `spawn_child_runs(agent_profile_id=B)`；子 run 用 B 的 charter/backend/装备；`ChildExecution` 加 `agent_profile_id/issue_id`；写 `delegation.completed` 事件；evidence 聚合回父。
4. **装备投影（当前最大治理漏洞）**：`build_runtime_plugin_policy_addition(plugin_ids=granted)` + `_project_plugins_into_policy(allowed_plugin_ids=...)`——**只投影 granted 工具 schema**，granted 空则不投影任何插件，越权调用 MCP 层 fail-closed。

**A2A 治理（防 fork 炸弹/权限扩散/预算失控/循环）**：深度上限（复用 `max_subagent_depth`，MVP=2~3）；每 turn 1 委派；**只能上级→下级**（reports_to 方向）；循环检测（delegation_chain 查重）；预算沿树 `min(requested,parent_remaining,assignee,company,runtime)`，`CostEvent.from_snapshot` 补传 `parent_run_id`，归零熔断整树；同 workspace 委派 `max_concurrency=1`；跨 workspace/高危装备/支付/扫描走审批门。**P0 里 unknown profile 的 best-effort degrade 必须改 fail-closed**（A2A 不能悄悄继承父上下文）。

**最小可信 demo（验收）**：CEO agent 跑 "Build login flow"，charter="不写码、必要时委派 engineer" → 输出 delegation marker → orchestrator 解析+校验 → engineer **以自己 charter+backend+granted 装备**执行 → 聚合回 CEO → 成本账本 CEO/engineer 分别记账 → engineer 只见 granted 插件 → 深度/环/越权被拒。

**A2A 具体改动清单（P1，文件级）**：
- `models.py`：`DelegationRequest`；`ChildExecution` +`agent_profile_id/issue_id`；`CostEvent.from_snapshot` +`parent_run_id`。
- `agent_prompt.py`（新）：`compose_agent_system_prompt()` + marker 指令模板 + 单测。
- `backends.py`：`WorkerLimits` +`agent_run_context`；CLI/API `_prompt()` 注入；单测断言 transcript 含 charter、含 granted、不含 dropped。
- `orchestrator.py`：建 `WorkerLimits` 传 agent_run_context；`_parse/_validate/_execute_delegation_requests`；`_record_worker_cost` 填 parent_run_id；unknown profile 改 fail-closed。
- `team_kernel.py`：`delegate_sub_issue` 加治理校验 + `validate_delegation_policy()`。
- `plugin_runtime_projection.py` / `plugin_mcp_proxy.py`：granted-only 投影 + aggregate snapshot 只含 granted。
- `tests/test_a2a_mvp.py`（新）：端到端——fake CEO 出 marker、fake engineer 断言 prompt 含 charter、child run agent_profile_id=engineer、父 evidence 有 child、cost 分账、dropped 不在 snapshot、depth/cycle/unknown 被拒。

**多 SuperClaw 间 A2A（推迟执行,预留 schema）**：UUID + JSON 可序列化；`DelegationRequest` 预留 `external_target/protocol_version/trace_id/idempotency_key/source|target_*/remote_endpoint/remote_status/serialized_issue`；未来 HTTP adapter `POST /a2a/delegations`（签名 envelope）或 "A2A via Git"（issue envelope 入 repo/mailbox 分支）。现在**只做 envelope schema,不做执行**。

---

## 2.7 第五轮终审：整体一致性与完整性（三方独立走查后收敛 · 2026-06-10）

> 终判（三方一致）：**这套体系行得通**，但当前是"有公司外壳的多 agent 交付内核"，还不是"完整 agent company"。打分：架构自洽 7 / 完整性 6~8 / 可实施 7（拆 P1 后）。**三个断点必须先修，否则 OrgChart/模板/CEO 都只是好看的组织图。**

### 断点① 同步 A2A 与 Issue 状态机的死锁悖论（三方各自独立撞到）
矛盾：委派子 issue 若走完整状态机——父 run 已持 workspace 锁则子 checkout 撞锁；子 in_review 等人审则父阻塞、自治死掉。若不走——issue 退化为装饰账本。
**裁决（采 Codex typed issue + Gemini 边界原则）**：
- `Issue` 增 `kind: delivery | delegation | review | bug` 与 `review_policy: human_final | parent_accept | qa_accept | no_completion_gate`。
- **A2A delegation issue 走 checkout/lock/evidence/cost，但不默认走人类 final approval**——由父 agent（发包方）或 QA agent 验收关闭，状态由内核机器流转；同 workspace 子委派**继承父锁**不二次抢锁。
- **审批向上冒泡**：子触发高危 → 冻结整棵执行树、approval 挂到 root，不让子单独卡 in_review。
- **人审只守三处**：root delivery issue 的 in_review→done（交付出门）、权限扩张/高危副作用（支付/扫描/写越界/新装备/预算上调）、预算硬停解除。原则：**对内闭环，对外人审；人审管边界，不管过程**。
- charter 授权边界写死：charter 只能授权"如何思考/分工/在已授权限内执行"，**不能**授权获得新装备、扩预算、标记最终 done、高危副作用、绕过 workspace/network policy。

### 断点② 结果回流断裂 + Context 爆炸（最大运行时风险）
- 子结果目前只进父 evidence，**不进父后续 turn 的 prompt** → CEO 派完活看不见结果，QA 发现 bug 无法触发返工 → 公司退化成一次性 fanout。
- **Gemini 关键发现**：多轮委派下 CEO context = charter+需求+N 轮子结果 → 3-4 轮后撑爆/注意力崩塌（"CEO 智商衰减"）。
**裁决**：
1. 定义**父 resume payload**：子结果回流父下一 turn，但**强制压缩**——只回传 `{status: 成功/失败, summary, affected_files/context_pointers, cost}`，绝不塞子对话树原文。
2. **manager loop 拓扑**（新增 task topology）：CEO 单根节点多轮循环 turn→委派→收压缩结果→再 turn，直到宣布完成；`max_rounds` 上限熔断。
3. **标准错误协议**：子失败转成父可 Catch 的业务反馈 `[System: Child <Eng> failed: <reason>. Re-plan.]`；默认 bubble to parent → 父可重试一次或建 follow-up issue → 超策略进 `blocked` 等人/上级。
4. **QA bug loop 是核心工作流**（非前端增强）：状态机增 `needs_changes`/`reopened`；QA 建 bug child issue assign Eng、父 issue 退 `needs_changes`、Eng 修复、QA 复测、过了才 `in_review`。

### 断点③ 成本溯源 run-scope 与 issue-scope 割裂
**裁决（采 Codex 字段清单）**：CostEvent 冗余挂载 `issue_id + root_issue_id + parent_run_id + delegation_id/child_issue_id (+approval_id 可空)`——委派子 run 必须把 child_issue_id 注入 execution_context；Approval 反挂 `requested_by_run_id/affected_issue_id/cost_snapshot_at_request|decision`。否则只能算总数，答不了"登录功能含返工花了多少、责任在谁"。

### 完整性必补件（P1 内核级，不补就不是会运转的公司）
- **issue_events 极简事件流**（一张表，不要消息总线）：`event_id, issue_id, run_id, author_type, author_id, event_type(comment|question|answer|bug_report|status_change|delegation|review_note), body, created_at`——承载 B 问 A、QA 报 bug、人类中途补充。
- **共享上下文指针**：委派必须传 `context_pointers`（改了哪些文件等），可选轻量 team scratchpad（P2）。
- **人类中途介入内核命令**（UI 后做）：`comment / pause run / cancel run / resume with instruction / force block issue`。
- **并行合流策略**：同 workspace 委派 `max_concurrency=1`（锁排队或失败，绝不双写）；多 worktree 并行 P2。
- **chat run_id**：纯聊天必须有 run_id（company=local, agent=null, source=chat），否则统一账本在最常用入口不闭环。
- **模板导入审计**：保存 template id/version/digest、equipment diff、dropped 权限、budget clamp 结果、approval id——否则追不了"CEO 为什么有这些装备"。
- 推迟：公司知识库/跨 run 记忆(P2)、charter 自动进化(P3 且必人审)、多机 envelope(P3)、Project/routines(P3)、RBAC(继续砍)。

### P1 重切（原 P1 太肿必烂尾 → 四切，顺序硬依赖）
- **P1a Run Identity 闭环**：backend 真消费 execution_context；compose_agent_system_prompt 注入 charter/链/granted；child run 真以 B 身份执行；纯 chat 生成 run_id 落账；CostEvent 关联 parent_run/issue/company。验收：CEO/Eng 跑出的 system prompt、granted tools、成本归因**不同且可审计**；纯 chat 成本可查。
- **P1b 同步 A2A 最小闭环**：marker parser + delegation validator + **typed delegation issue/review_policy** + 压缩结果聚合回父 + failure bubble + 锁排队。验收：CEO 委派 Eng→Eng 产 evidence→父收结果继续；子任务不需人审、root delivery 必须人审；高危仍触发审批。
- **P1c Bootstrap 内核/API**：template→proposal→人审→seed；equipment diff；budget clamp；不可变导入审计。验收：core-exec-team 模板 CLI/API 建出 CEO/Eng/QA；未授权装备 dropped 且显示原因；未审批不落地。
- **P1d 最小前端**：BootstrapWizard、OrgChart 只读+granted/dropped、IssueBoard 显示 parent/child/kind/review_policy、CostOverview 基础汇总。**不做**复杂 IssueDetail/运营台/异步队列 UI。

### 最大风险（三方合一）
**"把组织图当成协作系统"**（Codex）×**"Context 爆炸 CEO 智商衰减"**（Gemini）：CEO/Eng/QA、reports_to、OrgChart 都有了，但若无 typed issue、压缩回流、QA 退回、事件流、成本归因，得到的是"看起来像公司"的 UI 而非能持续交付的公司。**先闭"CEO 委派 Eng→QA 打回→Eng 修复→最终人审→成本对账"这条链，Paperclip 式外壳才有价值。**

---

## 3. 数据契约（定稿）

### 3.1 `CostEvent`（`models.py` 新增 + `state.py` 新表 `cost_events`）
```python
@dataclass
class CostEvent:
    event_id: str                      # _id("cost")
    idempotency_key: str               # run_id+task_id+attempt_index+backend+invocation_id（缺 invocation 用 transcript_artifact_id；direct chat 用 chat_session_id+turn_id）
    occurred_at: float
    # scope / 溯源
    run_id: str | None = None
    parent_run_id: str | None = None
    chat_session_id: str | None = None
    chat_message_id: str | None = None
    task_id: str | None = None
    attempt_index: int | None = None
    agent_profile_id: str | None = None   # 纯 chat = None
    issue_id: str | None = None
    company_profile_id: str | None = None
    workspace_id: str | None = None
    # 计量
    source: str = "chat"               # chat | delivery | team_member | plugin_tool
    meter_kind: str = "model_tokens"   # model_tokens | wall_clock | external_tool
    backend: str = ""
    provider: str = "unknown"          # anthropic | openai | google | codex_cli | claude_code | local | unknown
    model: str | None = None
    invocation_id: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_input_tokens: int | None = None
    reasoning_tokens: int | None = None
    tool_call_count: int | None = None
    duration_seconds: float = 0.0
    usage_status: str = "unavailable"  # actual | estimated | unavailable | not_applicable
    usage_source: str = "local_timer"  # provider_response | stream_event | transcript | local_timer
    status: str = "completed"          # completed | failed | timed_out | cancelled
    raw_usage: dict | None = None      # 脱敏 JSON
```
`CostSnapshot` = 上表的"计量"子集，挂到 `WorkerResult.cost`，便于 evidence 回读。

### 3.2 各 backend usage 获取策略（采集真相，已核实）
| backend/路径 | usage 来源 | usage_status |
|---|---|---|
| Claude stream (`claude_stream.py`) | `ClaudeStreamResult.usage`（已存在，落在 transcript_extra）→ 转 CostSnapshot | actual |
| Claude batch | 解析 CLI JSON result，不靠自然语言 | actual / unavailable |
| Codex app-server (`codex_app_server.py`) | raw events / turn result 找正式 usage；拿不到 | actual / unavailable |
| Codex direct subprocess (`execute_direct_chat_turn`，目前唯一 chat 后端) | P0 大概率无 token | unavailable（记 duration） |
| Gemini/Anthropic API loop | API response usage | actual |
| local / dry-run / shell | 无 token | not_applicable（记 duration） |
**fail 策略**：P0/P1 缺 usage **fail‑open**，但必须落 `unavailable`/`not_applicable` 事件；P2 硬预算启用后，对声明 cost‑governed 的 provider 若长期 unavailable 才 fail‑closed 阻断。

### 3.3 预算字段拆分（`budget_seconds` 语义纠正）
`AgentProfile.budget_seconds` 现在其实是**墙钟 timeout**，不是成本预算。拆为：
`time_budget_seconds`（=原 budget_seconds，墙钟）/ `token_budget` / `run_count_budget` / `external_tool_budget`。
`BudgetSnapshot` = run 启动时固化 `min(company, workspace, agent, issue, runtime)`；CostEvent 求和按 scope 对账 snapshot，**不用实时配置重算历史 run**。

---

## 4. 可执行任务分解（按 P 级；映射真实文件 + CLI + API + 测试）

> 真实代码坐标（worktree `feat/agent-team-kernel`）：`packages/superclaw/src/superclaw/{models,state,orchestrator,backends,claude_stream,codex_app_server,team_kernel,cli,ui_contracts}.py`、`apps/api/main.py`、`apps/web/src/`。栈是 **dataclass + 裸 sqlite3**（非 SQLAlchemy）、JSON‑payload 列模式。

### 任务 1 — 统一 AgentRun 模型（P0/P1）
- 代码：`models.py` 增 `CostEvent` / `CostSnapshot` / `RunSource` 枚举。
- 代码：chat 普通 turn 也要有 `run_id`/`turn_run_id`（P1：`/api/chat/stream` 给每 turn 建 `RunSession`）。
- CLI：`superclaw run inspect RUN_ID`（看一次 run 的 cost 事件）。
- 测试：chat turn / delivery run / team member run 都能追到 run 容器。

### 任务 2 — Cost Tracing 内核账本（**P0 承重墙**）
- 代码：`state.py` 新表 `cost_events`（JSON payload + 索引列 run_id/chat_session_id/company_profile_id/agent_profile_id/issue_id/occurred_at）+ `record_cost_event`（按 `idempotency_key` INSERT OR IGNORE，幂等）/`list_cost_events`/`summarize_cost`。
- CLI：`superclaw cost list --run RUN_ID` / `superclaw cost summary --chat SESSION|--company|--agent|--today`。
- API：`GET /api/cost/events`、`GET /api/cost/summary`（控制 token 门）。
- 测试：**幂等键重复写不重复计数**；usage unavailable 仍落事件；local dry‑run 记 not_applicable。

### 任务 3 — Backend Usage 归一化（P0/P1）
- 代码：`backends.py` 给 `WorkerResult` 填 `cost: CostSnapshot|None`；`claude_stream.py` usage→CostSnapshot；`codex_app_server.py` 增 usage/raw_usage，拿不到则 unavailable。
- 测试：Claude stream actual tokens；Codex unavailable **不失败**；duration 永远记录。

### 任务 4 — Orchestrator 采集点（**P0，防重复计数**）
- 代码：`orchestrator.py` 抽出唯一 recorder `record_worker_result(...)`，**串行/并发/fanout 路径统一调用**（当前串行路径有重复 post‑run 逻辑，必须收敛到一处）。
- 测试：并发 frontier 不漏记；retry attempt 分开计；fallback 不双计。

### 任务 5 — Chat 成本接入（P1）
- 代码：`apps/api/main.py` 的 `/api/chat/stream` 普通 chat 分配 run/turn id；direct chat 结束后经同一 recorder 记 CostEvent。
- API：chat response/SSE 带 `run_id` 和 `cost_event_id`。
- 测试：普通 chat / plugin task / direct chat 都能按 session 汇总。

### 任务 6 — charter 进运行时（**P0 承重墙，缺口 C**）
- 代码：`AgentProfile` 增 `persona/charter/default_instructions/charter_source/charter_revision_id`；`team_kernel.delegate_sub_issue(parent_id,...)`；`orchestrator` 把 charter+`resolve_equipment().granted`+`reports_to` 指挥链注入 child run `execution_context` 并合成 system prompt（治理法则不可逾越 + 身份/charter + 指挥链 + 已授权工具）。
- CLI：`agent create-profile ... --charter-file AGENTS.md`、`agent update-charter`、`issue create --parent`、`issue delegate`。
- 测试：charter 落字段可 diff；委派子任务保留单一 assignee/锁/审批门；prompt 注入含装备 granted/dropped。

### 任务 7 — 治理命名空间（**P0**）
- 代码：`CompanyProfile`（替 hardcoded "local"）+ `WorkspaceProfile`（`repo_path/writable_paths/network_policy/default_permission_policy`——执行边界≠瞬时锁）。
- CLI：`company init/list/select`、`workspace create/list`。
- API：`/api/team/company`、`/api/team/workspaces`。
- 测试：缺 company/workspace fail‑closed；workspace 越界写/越界网络被挡。

### 任务 8 — Catalog Proposal 与 Approval Diff（P1）
- 代码：`team_catalog.py`/`catalog_import.py`：解析 agentcompanies/v1 包（COMPANY/TEAM/AGENTS/PROJECT/TASK/SKILL.md）为 **proposal**；装备过 `resolve_equipment` 出 granted/dropped/pending；预算 `min()` 只降不升；缺能力 **400 拒绝**；charter policy lint（禁"绕过审批/扩工具/自动支付"）；reports_to 无环校验。
- CLI：`team catalog inspect`、`team bootstrap --from-template ... --mode proposal`、`team bootstrap commit <proposal_id>`。
- API：`POST /api/team/catalog/preview`、`POST /api/team/bootstrap`（返回 would_create + equipment_resolution + **approvals_required（整单 + 高危逐条列**，用户已拍板））。
- 测试：未治理插件 dropped/pending；CEO 初始空装备低预算 dry‑run；高危项必生成 approval。

### 任务 9 — 预算治理（P1 软 / P2 硬）
- 代码：`BudgetSnapshot`/`BudgetPolicy` 轻量结构（不先做复杂引擎）；P1 summary 返回 soft warning + burn‑down；P2 run/chat/team checkout **preflight 硬阻断**（超预算 → 409 → issue 置 blocked → `superclaw approve` 加额度）。
- 治理双门：支付/扫描/发布 = **权限门 ∧ 成本门**；成本批准不能授权支付，支付批准不能突破预算。
- CLI：`superclaw budget summary`、`budget check --company`。
- 测试：多层 min；超预算 P1 warning、P2 409；高危需两门齐过。

### 任务 10 — UI/桌面表层（P2，聚焦"建公司+组织可视化闭环"，用户已拍板）
- 前端：拆 `App.tsx` 巨石 → `apps/web/src/team/`（`api.ts`/`BootstrapWizard.tsx`/`OrgChart.tsx`/`AgentDetail.tsx`/`ApprovalInbox.tsx`/`CostOverview.tsx`）。
- 移植：Paperclip `OnboardingWizard`(4 步壳) + `OrgChart`(layoutTree/forest+pan/zoom) **改皮直拿**；IssueDetail 聊天式留 P2 尾/P3。
- 契约：UI 只调 `/api/team/*` 和 `/api/cost/*`；**零新增语义；绝不乐观显示"已授权"**。
- 测试：UI mutation 可用 CLI 复现；成本视图按 chat/company/agent 过滤一致。

### 任务 11 — 验收矩阵（见 §6）

---

## 5. 治理双门（权限门 ⊥ 成本门）

| 动作 | 权限门 | 成本门 |
|---|---|---|
| 普通 chat / 普通 run | 装备投影收窄 | 记 CostEvent；P2 软/硬预算 |
| 写文件越界 / 网络扫描 / 支付 / 发布 / 未签名插件 | **必须 approval** | **必须预算足够** |
| 模板播种高危装备 | proposal→approval diff | min() 预算只降不升 |
结论：**两门正交、都要过**。成本批准≠支付批准；支付批准≠突破预算。

---

## 6. 验收矩阵

| 阶段 | 验收标准 |
|---|---|
| **P0 ✅ 已实现并验证 (2026-06-09)** | ① `cost_events` 表存在，**跑一次 delivery(local 非 dry) → 账本精确多出 5 条可幂等 CostEvent**（local=not_applicable；claude=actual token via _extract_cost_snapshot）；② `company init`/`workspace create` CLI/API 可读回，替掉 hardcoded local；③ `AgentProfile.charter` 落字段、`issue delegate` 建带 parent_id 子任务、orchestrator 注入 `agent_run_context`(charter+装备 granted+manager_chain)。测试 42 过；零回归。 |
| **P1 ✅ dev/roadmap 已实现并验证 (2026-06-17)** | ① chat/team 覆盖可幂等成本事件：pure chat/direct/streaming chat 生成 synthetic `run_id`/`turn_id` 并记录 `CostEvent`，usage 缺失也有 auditable unavailable 事件；② `team bootstrap --from-template` / `/api/team/bootstrap` 支持 side-effect-free proposal 与 governed `mode=commit`，clean proposal 原子写入 company/workspace/agents/seed issue，高危 proposal 只落 pending approval 并经 `team.bootstrap.commit` resume；③ budget policy 支持软 burn-down 与硬 gate 决策。 |
| **P2 ✅ dev/roadmap 已实现并验证 (2026-06-17)** | ① BootstrapWizard 已从 display-only shell 升级为可用四步流：catalog preview → proposal/risk review → commit/approval status；OrgChart、AgentDetail、CostOverview、board inbox 与 routines Workbench 视图已接入；② checkout/runtime 硬预算门返回结构化 409，team checkout 超预算不 claim issue、不产生 run mutation；③ board inbox resolve/assign 与 routine author/list API/CLI/Web 已落地。 |
| **P3** | Project 实体 / 价格表 USD/cents / mid-run streaming 级中断 / 外部插件付费结算 / routines 运营增强与生产观测硬化——仅真实痛点触发。 |

**最关键的单点验收**：先别写漂亮成本 UI——**先让每个 chat turn 和 backend worker 结束后都有一条可幂等查询的 `CostEvent`**。没这个，Chat 成本治理和 Paperclip 成本治理都是"看起来可推导、实际没账本"。

---

## 7. 坚决砍 / 推迟

heartbeat 自治、adapter 抽象（backend 统一接管不暴露 UI）、多租户 auth/RBAC、agent‑to‑agent 审批免检、cron routines（要例行用 OS crontab 调 `superclaw issue create`）、Postgres、SaaS billing/USD 硬计费（P3 才碰）、mid‑run streaming 级中断（P3，风险高）、Paperclip Secrets/InstanceSettings、`Project` 全层级（推迟 P3，先用 GoalSpec+Issue.parent_id）。`reports_to` 仅可视化 + prompt 指挥链注入，不做 HR 执行/权限继承。

---

## 8. 决策记录与开放问题

**已拍板（2026-06-09）**：本轮到规划为止不动手；P1 前端聚焦"建公司+组织可视化闭环"；bootstrap 整单审批+高危逐条列；`cost_events` 升 P0；硬停 P2。
**三方分歧裁决**：WorkspaceProfile **补**（含 network_policy=fail‑closed 网络/支付门所需，2:1）；Project **推迟 P2+**（已有 GoalSpec+parent_id，2:1）；CostEvent 落点 = **独立账本 + WorkerResult.cost 快照**（不塞 backend_summary，Codex+Gemini）；采集 = **orchestrator 统一 recorder**（非 backend 直写，Codex 关键）；统一抽象 = **AgentRun 是容器、CostEvent 记消耗**（非"run=花钱"，Codex 修正）。
**待实现期再定**：charter P0 是否直接吃 `--charter-file AGENTS.md`（建议是）；CEO 初始给只读 inventory 类安全装备 vs 全空（建议只读安全装备）；Phase 1+本 plan 何时合并提交。
