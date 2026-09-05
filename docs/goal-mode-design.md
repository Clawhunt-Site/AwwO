# Goal Mode（计划模式）+ 多 agent —— 设计文档

> 状态：设计定稿（Codex + Gemini 双顾问对抗评审均已完成并并入，可进入实现）。
> 评审：Codex(gpt-5.5) + Gemini/agy(3.1 Pro High) 双路对抗评审完成；分歧由主代理裁决（见 §9）。
> 范围：把 codex 的 goal 方法论嫁接进 SuperClaw 多 agent 体系。

## 0. 动机与一句话定位

codex 的 goal 框架（`codex-rs/ext/goal`、`core/src/goals.rs`、`state` 的 `thread_goals` 表）是一个
**单 thread、单 agent 的「自主续航 + 预算治理」层**：一个 thread 一个 goal（PK=thread_id），6 态状态机
（Active/Paused/Blocked/UsageLimited/BudgetLimited/Complete），agent 用 `create_goal`/`update_goal`/`get_goal`
三个工具驱动，核心是「空闲续航」（goal Active 且无活跃 turn 时系统自动起续航 turn 推进目标）。它**明确排除
subagent**（`ext/goal/src/extension.rs:93-97`），根本不是多 agent 编排。

SuperClaw 反过来：已有完整多 agent 内核（`GoalSpec`→`TaskGraph.from_goal(topology)`→`RunSession`→orchestrator；
`team_kernel.delegate_sub_issue()` A2A；Issue + review_policy 完成门；WorkspaceLock 单飞锁），但**没有 goal 的
lifecycle ledger**——`goals(goal_id, payload)` 表（`state.py:223`）只把 `GoalSpec` 存成惰性 JSON blob
（`INSERT OR REPLACE`，无 status/revision/budget/usage/完成门列）。没有 goal 状态机、没有 goal 级预算、没有续航。

**一句话：codex 缺的多 agent 扇出 super 有；super 缺的 goal 脊梁 codex 有。本设计是嫁接——把 codex 的 goal 脊梁
（持久 lifecycle ledger + 状态机 + 预算 + 自主续航）装进 super，并从「一 goal 绑一 thread」反向扇成「一 goal → 多 agent」。**

## 1. 业主诉求

1. chat 里有开关，把**本次 chat 转换成 goal（计划模式）**，对标 codex 把 chat 转 goal 的开关。
2. 开启后本次 chat 即 goal 模式。
3. 开启时**弹窗让用户确认本次可用的 agent 及其 model**——因为 super 是**多 agent**。
4. 多 agent「想象空间很大」要打开。

## 2. 必守铁律（违反即否决）

- 铁律1 能力先进内核：goal 层进 core harness + `ui_contracts.py`，**CLI 先行**再上 API/Web。
- 铁律2 CLI/APP 零偏差：行为/参数/校验/人审门/错误码一致。
- 铁律3 契约单一源：goal 状态机/预算档位/agent 清单进契约，表层不硬编码。
- 铁律5 治理内核裁决：fail-closed；支付/扫描需人审；表层不放行。
- 铁律6 runtime 联动 model+effort：弹窗多 agent 选型必须 runtime 联动响应式下拉；effort 仅
  `supports_effort_selection` 真才显示；default_effort 绝不回填；切 runtime 重置。
- 完成门铁律：delivery 完成由 review_policy 裁决，**agent 不能自我放行**（区别于 codex 允许 agent `update_goal(complete)`）。
- 流程铁律：worktree 隔离 / 本地全量门 / Codex+Gemini 双 PASS 才提交。

## 3. Codex 评审挑出、已源码核实的会崩点（设计已并入）

1. **别新增平行 goal 表**：已有 `goals(goal_id,payload)`（`state.py:223`、写入 `state.py:663`、读 `get_goal`/`list_goals`）。
   扩展成 typed `GoalRecord` 并迁移旧 payload；**禁止继续用 `INSERT OR REPLACE` 覆盖 lifecycle**（会冲掉状态机）。
2. **goal 状态不能塞 `RunSession.execution_context`**：确认前没有 run；一个 goal 会多次 run/resume/rework。
   关系是 **`GoalRecord` 1:N `RunSession`**（run 是执行尝试，非 goal 本体）。
3. **`confirmed_goal_id` 幂等不够**：必须绑 `goal_id + revision + plan_hash + roster_hash + nonce`，在
   `BEGIN IMMEDIATE` 事务里单次消费。否则双 tab / 换 roster 后重放旧确认 → 启动错的 agent 组合。
4. **裸 backend 不得直接投影成 `WorkerLimits` 冒充 company agent**：裸选只能是 `source="backend"` 的 transient
   roster entry，权限/预算默认收窄，**绝不写进 `agent_profiles`**。
5. **plan 阶段绝不 bolt 在 delivery 分支尾巴**（那里 append message + 立即 `start_existing_goal`）：plan 阶段只
   创建/更新 draft goal，**绝不启动 run**。
6. **codex 6 态不够**：super 还需 `draft / awaiting_confirmation / review_pending / cancelled`，否则 plan 审批、
   人审完成门、预算耗尽会被硬塞进 Active/Blocked/Complete，状态机不可审计。

## 4. 硬问题定稿答案

| # | 问题 | 裁决 |
|---|---|---|
| 4.1 | 路由形态 | 新开显式 `mode="goal"`，**底层复用同一 planner/orchestrator 内核**；delivery 保持"立即执行"语义不被污染。 |
| 4.2 | 持久化 | 扩展现有 `goals`→`GoalRecord`（status/revision/plan/roster/budget/usage/completion_gate）；`GoalRecord` 1:N `RunSession`。 |
| 4.3 | 多 agent 映射 | 用户**只选池子 + 可选角色 pin**，不直接编排 TaskNode。内核生成 `GoalPlan`（task slots：role/count/required_capabilities/aggregation/review_policy）+ allocator 把 roster 映射进 slots；不足则 fail-closed 报缺哪个 role/capability。**P0 只自动分配，P1 加 pin**。 |
| 4.4 | 计划模式 | **是 plan-then-execute**。确认弹窗 = 审批面（计划预览 + 任务图/拓扑 + roster + model/effort + budget + risk flags + completion gate），批准后才进 `active` 并启 run。 |
| 4.5 | 无 company | **绝不自动建 ephemeral company**（污染组织事实源）。无 company 时建 `GoalRosterSnapshot`：entry `source="backend"`，equipment 空，permission/budget 收窄，不写 `agent_profiles`。有 `@company` 才用 company roster 且以 profile id 为身份源。 |
| 4.6 | 完成门 | goal complete **不由 agent 自报**：delivery goal 绑 root delivery issue `review_policy=human_final`；goal complete = root issue done + 所有关联 non-cancelled issue terminal + 无 pending approval/hold/live run + evidence gate pass。agent 只能关 `parent_accept` 子 issue（现有 kernel 约束，不上移到 root goal）。预算耗尽进 `budget_limited`（非 complete 非 failed），禁自动续航；仅人类 budget override 产生新 revision 回 `active`。 |
| 4.7 | 自主续航 | **P2，默认关**。触发条件：`autonomy_policy.idle_continuation=false` 默认；仅 `active`、无 pending human gate、无 active hold、预算未超、无 live run 时触发；goal-level lease 防多 daemon；frontier 幂等键 `goal:<id>:rev:<n>:frontier:<hash>`；支付/市场/提交/扫描/外部写/提权/hire&config change 全部强制人审；只推进已批准 plan frontier，不偷改 plan/roster/budget。复用 `AgentWakeupRequest` 队列能力，但不复用"一 agent 一 wake"当 goal 编排事实源。 |
| 4.8 | 契约 | `ui_contracts.py` 新增 `GOAL_MODE_SPEC / GOAL_STATUS_SPEC / GOAL_CONFIRMATION_SPEC / GOAL_ROSTER_ENTRY_SPEC / GOAL_BUDGET_SPEC / GOAL_AUTONOMY_POLICY_SPEC`；model/effort **继续引用** `AGENT_CONTROL_SPECS` + `/api/agents/{backend}/models`，不复制清单；default_effort display-only、切 runtime 重置。CLI 弹窗等价物：`superclaw goal plan --message … --json` / `superclaw goal confirm <goal_id> --revision N --roster-file roster.json`（交互式可 prompt，非交互全 flag/json 可复现）。 |

## 5. 数据模型草案

### 5.1 GoalRecord（扩展 `goals` 表）
```
goal_id            TEXT PRIMARY KEY
spec_payload       JSON        -- 原 GoalSpec
status             TEXT        -- 状态机（见 5.2）
revision           INTEGER     -- 每次 plan/roster/budget 变更 +1
plan_payload       JSON        -- GoalPlan（task slots / 拓扑）
roster_snapshot    JSON        -- GoalRosterSnapshot（参与 agent + model/effort + source）
budget_policy      JSON        -- token / wall-clock / 上限
usage_rollup       JSON        -- 跨 run 聚合的 token + 墙钟
completion_gate    JSON        -- root issue id + review_policy + evidence gate 状态
created_at         TEXT
updated_at         TEXT
```
迁移：旧行 `payload` → `spec_payload`，`status=draft`（或据是否已有 run 推断），`revision=0`。
写入改 CAS（`UPDATE … WHERE goal_id=? AND revision=?`），**移除 `INSERT OR REPLACE` 的 lifecycle 覆盖**。

### 5.2 Goal 状态机
```
draft → awaiting_confirmation → active → review_pending → complete
                 │                 │            │
                 │                 ├→ budget_limited (仅人类 override 回 active)
                 │                 ├→ blocked
                 └→ cancelled ←────┴────────────┘
```
- 终端：`complete` / `cancelled`。
- `budget_limited` 半终端：禁自动续航，人类 override → 新 revision → `active`。
- `complete` 仅由完成门聚合裁决（5.x），agent 不可直接置。

### 5.3 GoalPlan / task slots
```
GoalPlan { goal_id, topology, slots: [ TaskSlot ] }
TaskSlot { role, count, required_capabilities, aggregation, review_policy, pinned_agent_id? }
```

### 5.4 GoalRosterSnapshot
```
GoalRosterSnapshot { entries: [ RosterEntry ] }
RosterEntry {
  source: "company" | "backend"
  agent_profile_id?      -- 仅 company；身份源
  backend                -- runtime
  model?                 -- 经 AGENT_CONTROL_SPECS 校验
  effort?                -- 仅 supports_effort_selection
  permission_scope       -- backend 来源默认收窄
}
```

## 6. 落地路线图（8 原子 PR，CLI 先行）

### P0 —— 打底三件套（高价值低风险）
- **PR1 Goal ledger 内核**：`goals`→`GoalRecord` 状态机 + revision + 字段 + 迁移；禁 `INSERT OR REPLACE` 覆盖 lifecycle。
  测试：状态迁移、旧数据读取、并发确认 CAS。
- **PR2 Planner + CLI 基准**：从 `delivery_goal_from_chat` 抽纯 planner；`goal plan/inspect/confirm/cancel` CLI；
  confirm 启 `start_existing_goal()`（单 run，无续航）。CLI 是行为基准。
- **PR3 API parity**：`POST /api/goals/plan`、`POST /api/goals/{id}/confirm`、`GET /api/goals/{id}`；
  `/api/chat/turn mode=goal` 只返回 `confirmation_required` 不执行；错误码对齐（409 revision/hash、422 roster、404 missing）。

### P1 —— 弹窗与完成门（你要的可见功能）
- **PR4 Roster allocator**：`GoalRosterSnapshot`、company vs backend roster、role slots、自动分配、可选 pin；不建 ephemeral company。
  测试：无 company / 有 company / agent unavailable / model unsupported / effort unsupported。
- **PR5 完成门聚合**：goal 绑 root issue；goal status 从 issue/run/approval/evidence 聚合；budget 从 run 级上卷到 `budget_limited`。
  测试：root human gate、子 issue parent_accept、pending approval 不 complete、budget 不 complete。
- **PR6 Web 确认弹窗**：前端只渲染契约；runtime/model/effort 联动从 `/api/agents`、`/api/agents/{backend}/models`。
  测试：切 runtime 清 model/effort、default_effort 不回填、unsupported effort 不显示。

### P2 —— 自主续航与高级多 agent（高风险，最后）
- **PR7 自主续航 daemon**：显式开 + goal lease + frontier 幂等 + risk gate + 人审阻断 + budget 阻断；只推进已批准 plan。
  测试：race、crash-resume。
- **PR8 高级多 agent**：review consensus、explore/implement fanout 的 agent 级分配、quorum、variance review。
  （P0 不做，否则把 ledger/UI/allocator/完成门耦死。）

## 7. P0 最低验收（Codex 底线）
"做完"标准**不是 Web 弹窗**，而是 CLI/API 能证明：
1. 同一 chat goal 先生成 draft plan；
2. 重复 confirm 不重复启动 run；
3. 改 roster 后旧 confirmation 被拒（409）；
4. budget blocked 不 complete；
5. delivery root 不能被 agent 自关。
Web 只能在这些契约稳定后接上。

## 8. 待决 / 风险
- Gemini(agy) 侧补一轮对抗评审后，本设计才进入实现（铁律：Codex+Gemini 双 PASS）。
- planner 从 chat 抽取 GoalSpec 的拆解质量（topology 选择）需要后续打磨——P0 先用现有 `TaskGraph.from_goal` 拓扑。
- 自主续航（PR7）治理边界是全设计最高风险点，单独 PR + 单独对抗验收。

## 9. Gemini(agy) 补评审 + 主代理裁决（修订并入）

Gemini 3.1 Pro 这轮抓出 4 个 Codex/主代理都漏掉的阻断/盲点，并在 §4.3 与 Codex 相左。按铁律，分歧由主代理综合裁决并写明理由。

### 9.1 新增阻断项（全部采纳，已上升设计约束）
1. **并发预算穿透（最致命）**：Codex 的"goal 级预算上卷"是**事后累加**，但 super 的 `EXPLORE_FANOUT`/`IMPLEMENT_FANOUT` 是**真并发**——N 个 worker 同时各读到"剩余 X"，各花 X，瞬间穿透 → **真实账单侧漏**（属铁律5 fail-closed 范畴）。
   **约束**：预算改**预先拨备（reservation/quota allocation）**：Goal 派发并发分支时把剩余总额按硬上限**切片下推**给每个 RunSession（`max_tokens_per_run`），单 worker 触碰拨备上限**自我 block 交还控制权**。事后累加只作审计，不作防线。
2. **状态严格派生投影**：执行期 `Goal.status`（active/blocked/review_pending/complete）**绝不能是独立 mutate 的字段**，必须是底层 TaskGraph/Issues 状态的**computed projection**（仅 `draft`/`awaiting_confirmation`/`cancelled` 是独立态）。杜绝"Goal=Complete 但 Issue=Running"脏数据。比 §4.6 的"聚合"更强：不是同步两套状态，而是执行期 goal 态**由 issue 树派生求值**，无独立写路径。
3. **确认 TOCTOU**：plan 生成（awaiting_confirmation）与 confirm 之间可能隔很久，工作树/后端可能已变。§4.1 的 `BEGIN IMMEDIATE` 消费除校验 `plan_hash`+`roster_hash`+`nonce` 外，**追加校验工作树/状态快照摘要（worktree/state digest）**；不匹配 fail-closed 退回 `draft` 要求 replan。
4. **Replanning（修订回路）**：确认弹窗/CLI 必须支持"修订"——用户对计划不满，提交意见 → 状态从 `awaiting_confirmation` 回滚 `draft` 重走 Phase A，而非只能"选/取消"。状态机补这条回边。

### 9.2 分歧裁决：§4.3 多 agent 映射 —— 采纳 agy 的"角色绑定"，但锚在 Codex 的"slot"粒度
- **Codex**：用户选池子 + 内核自动分配（P0），P1 再加 pin。
- **agy**：自动分配是灾难（异构角色下内核可能让无能力 agent 干核心节点必崩）→ Phase A 返回**带语义角色占位的拓扑**，Phase B **把具体 Agent+Model+Effort 显式绑定到角色**（弹窗 = "招募板/选兵台"）。
- **主代理裁决（采纳 agy 为主，融合 Codex 的 slot 抽象）**：
  - Phase A 产出 **role slots**（沿用 Codex 的 `TaskSlot{role,count,required_capabilities,aggregation,review_policy}`，但带语义角色，如 EXPLORE/PLAN/IMPLEMENT/VERIFY/REVIEW）。
  - Phase B 弹窗/CLI 把 agent **绑定到 slot/角色**（不是裸资源池，也**不是**细到每个 TaskNode——以 slot 为粒度，既释放多 agent 想象空间又不爆炸）。
  - 提供**合理的自动建议绑定**作默认（简单场景不繁琐），但绑定**显式可改**。`required_capabilities` 不满足时 fail-closed 报缺哪个角色/能力。
  - 理由：业主明确要"多 agent 想象空间很大"，纯池子自动分配是弱抽象、且异构角色下有真实质量风险；slot 粒度的显式绑定是"选兵台"的正确形态，又比 per-node 编排克制。

### 9.3 分歧裁决：预算拨备的 PR 排期 —— 上升 P0，并设硬门
- **agy**：把并发预算拨备提到 P0（PR2）。**Codex**：预算聚合放 P1（PR5）。
- **主代理裁决（采纳 agy）**：账单侧漏是 fail-closed 治理问题，不能等 P1。但拆解为可控两步：
  - **P0 执行只允许非并发拓扑（LINEAR/单 worker）**——串行下 goal 级预算"上卷 + 上限拦截"即安全，先不需要拨备。
  - **设硬门**：**任何并发 fanout 拓扑（EXPLORE/IMPLEMENT_FANOUT）上线前，预算拨备（reservation 切片下沉）必须先落地**；并发与拨备**同一 PR 不可拆**。即"绝不在没有拨备的情况下放出并发"。这把 agy 的 P0 诉求落成一条不可违反的排期约束，而非一定要在第一个 PR 写完拨备引擎。

### 9.4 一致确认（Codex 与 agy 同向，无需裁决）
- 路由：都主张**新 intent / 专用端点**（`/api/goals/plan` + `/api/goals/{id}/confirm|execute`），不污染 delivery。
- 持久化：都主张扩展 `goals`→typed ledger、`Goal` 1:N `RunSession`、挂在 Issue 树之上（`Goal → TaskGraph → Issues → RunSessions`）。
- 无 company：都主张 transient roster 序列化进 goal payload + RunSession 挂 `WorkerLimits`，**不碰 `agent_profiles`**。
- 完成门：都主张 agent 不能自报 goal complete，由 orchestrator/完成门裁决。
- 自主续航：都主张 P2、默认关、强人审。

### 9.5 修订后的路线图（取代 §6 排期；范围不变，顺序/边界按裁决调整）
- **P0 PR1 Goal ledger 内核**：`goals`→`GoalRecord`（7 态：draft/awaiting_confirmation/active/blocked/budget_limited/complete/cancelled + replan 回边）；revision；迁移；禁 `INSERT OR REPLACE` 覆盖 lifecycle；执行期态为 issue 树派生投影。测：迁移/旧数据/CAS/投影一致性。
- **P0 PR2 Planner + CLI 基准（含 role slots + 串行执行）**：抽纯 planner 产出带语义角色的 `GoalPlan`；`goal plan/inspect/list/revise/replan/confirm/start/cancel` CLI（replan 闭合 revise 回路防僵尸 draft；start 承接 active 防 liveness 死胡同 + 崩溃恢复幂等）；confirm 在 `update_goal_record` 的 `BEGIN IMMEDIATE` 内**原子**校验 **plan_hash**（`expected_plan_hash`）+ revision CAS，并写 `confirmation_nonce`；confirm/start **两处**都拒绝非 LINEAR；run 的 runtime 取自**已确认 roster**（approved A=executed A）；start 用 `goal_has_live_run` 防重复 run。**执行限 LINEAR/单 worker**（规避并发预算 race）。
  - **`roster_hash` + `worktree_digest` 推迟到 PR4**：两者分别需真 roster allocator（PR4）与 repo 绑定（PR4/PR6）才有意义；PR2 的 roster 是 confirm 当场构造的单 entry、CLI 不绑工作树，故此二者在 PR2 无 TOCTOU 面。字段已在 `GoalRecord` 预留，PR4 接 allocator/repo 时并入同一 `BEGIN IMMEDIATE` 校验。
- **P0 PR3 API parity**：专用一等资源端点 `POST /api/goals/plan`（返回 confirmation_required + 的 awaiting_confirmation 记录）、`POST /api/goals/{id}/confirm|start|revise|replan|cancel`、`GET /api/goals`（list records）、`GET /api/goals/{id}/record`、`GET /api/goal-status-contract`（状态机契约单一源）。全部薄投影同一 `goal_mode` 内核（零偏差）。错误码：404 missing / 409 revision|conflict(`GoalRevisionConflict`/`GoalConflict`) / 422 roster(`GoalRosterError`)。
  - **路由避让**：已有 legacy `GET /api/goals/{goal_id}`（返回裸 GoalSpec）单段路由会抢匹配，故 Goal-Mode 的 record 走 2 段 `/{id}/record`、契约走顶层 `/api/goal-status-contract`，不触碰 legacy。
  - **chat 集成形态**：业主诉求的"chat 计划模式开关"由 Web composer 在 toggle 开启时直接 `POST /api/goals/plan`（goal 作一等资源），而非重载 `/api/chat/turn`——避免动庞大 chat_turn_unified、且 goal 是独立可查资源；"只返 confirmation_required 不执行"语义由 plan 返回 awaiting_confirmation 记录天然表达。
- **P1 PR4 Roster allocator + 角色绑定**：transient roster（company/backend，不写 profiles）；slot↔agent 显式绑定 + 自动建议默认；能力不足 fail-closed。
- **P1 PR5 完成门派生投影**：goal 绑 root issue；执行期 goal 态严格由 issue/run/approval/evidence 派生；预算耗尽→budget_limited（仅人类 override 回 active）。
- **P1 PR6 Web 确认弹窗（选兵台）**：纯渲染契约；两段式（计划预览→角色绑定）；含"修订"回路；铁律6 runtime 联动 model/effort。
- **P2 PR7 并发预算拨备 + fanout 解锁 + 原子 run-lease**（**硬门：与并发同 PR**）：reservation 切片下沉 + worker 自我 block；解锁 EXPLORE/IMPLEMENT_FANOUT。测：并发预算不穿透、worker 触顶 block。
  - **原子 start run-lease**：PR2 的 `goal start` 用 revision-CAS claim 封住"同 revision 并发 start"（现实的双提交），但 goal-mode root run **不取 workspace lock**（那是 issue checkout 的原语），故"两个严格顺序到达、在一次 claim 提交与其 run 行创建之间的微窗口内各自创建 run"这一窄竞态未完全封死。完整封死需要带 liveness 的 start-lease（持久 'starting' 标记 + 按 run 存活回收，复用 [[agent-lock-liveness-reclaim]] 的回收范式），与并发执行同属 PR7；PR2 单 LINEAR、设计上不并发驱动，此窄窗在 PR2 不构成实际风险。
- **P2 PR8 自主续航 daemon**：显式开 + goal lease + frontier 幂等 + 叶子 issue 限定 + 单次极小预算切片 + 全 risk/人审/budget 阻断。
- **P2 PR9 高级多 agent**：review consensus / quorum / variance review。

> 注：原 §6 的 8-PR 在此扩为 9-PR——把"并发预算拨备"从隐含项提升为独立 P2 PR7 并与 fanout 解锁绑死，体现 §9.3 硬门。
