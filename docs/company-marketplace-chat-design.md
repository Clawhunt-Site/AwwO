# Marketplace-as-Company：把 delivery「验证·留证据」做成接单底座 设计

> **状态**：方向 + 实现进行中。P0 内核地基已交付（commit `a91c5bcd`，Codex gpt-5.5 + Antigravity Gemini 3.1 Pro 五轮对抗式验收通过）。P1–P4 待实现。
> **三方收敛**：主代理 + Codex + Antigravity（对抗式设计评审 + 五轮 P0 验收）。

## 0. 一句话

把原有 delivery 的「跑任务 + 多 Agent + 验证 + 留证据」能力做成 **company 接单底座**：在 Chat / CLI / API 里浏览 ClawHunt 市场、发布任务、**接单**——接到的单成为一次绑公司的可验收交付（多 Agent run + verifier + evidence），跑完经完成门后把 evidence 提交回 ClawHunt。能力先进内核（CLI 唯一事实源），表层只投影。

## 1. 不变量（铁律对齐）

- **能力先进内核再上表层**：所有 marketplace 业务能力先在内核 + CLI 暴露，API/Web 只投影同一份逻辑，不另写并行实现。
- **fail-closed 治理**：公开匿名浏览只留 Dock UI；governed agent 路径无 agent key 硬抛 `MarketplaceAuthError`（不降级公开数据）；任何花费/承诺/外发 = HIGH 人审；支付永不在默认路径。
- **scope 服务端注入**：authority 来自 `CompanyScope`，绝不信命令 body。
- **接单 = 一次可验收交付**：problem ↔ order(ledger) ↔ issue ↔ run ↔ evidence 四 id 对齐不漂移；运行经既有 orchestrator（多 Agent / verifier / evidence）。
- **完成门 ≠ 提交门**：run `completed` 不等于可提交；必须 issue 过 `review_policy` 完成门才进 `ready_to_submit`。

## 2. 分层架构

```
Chat / CLI / API（表层，零偏差投影）
  └─ marketplace_handler.execute_marketplace_command（单闸）
        validate → agent-key auth 门 → CompanyScope 门 → risk(读LOW/写HIGH)
        → 读直跑(browse/inspect) / 写建 MARKETPLACE_COMMAND 审批
  └─ apply_marketplace_command（grant 时唯一命中 ClawHunt 网络处）
        幂等再授权守卫 + claim/submit 双绑定 + 歧义态→BLOCKED
  └─ marketplace_saga.advance_marketplace_order（P1，幂等推进）
        claimed_remote → 建 delivery Issue → issue_bound → 起 run → run_started
        → 观察 run/issue 完成门 → review_pending → ready_to_submit
        → submit(末节点，复用 _apply_submit + EvidenceBundle)
  └─ ClawHuntClient（唯一远端事实源）
```

## 3. Saga 状态机（`MarketplaceOrderStatus`，已实现于 models.py）

```
claim_approval_pending → claiming → claimed_remote → issue_bound
  → run_started → review_pending → ready_to_submit
  → submit_approval_pending → submitting → submitted
失败/补偿: claim_failed(4xx,释放槽) / run_failed / blocked(歧义态或无远端release,保槽)
```
- 一活单一槽位：`(base_url, problem_id)` 分区唯一索引（排除 abandoned/claim_failed）。
- `abandoned`（释放槽位）经通用 save **不可达**——只有未来「证明远端 release」专用方法才能 abandoning→abandoned；现 abandon 停在 `blocked`（保槽，诚实 fail-closed）。
- 歧义态（网络异常 / 5xx / 408）→ `blocked`（保槽）；definitive 4xx → failed（claim 释放槽）。

## 4. 进度

### P0 — 内核地基　✅ 已交付（commit `a91c5bcd`）
- `marketplace_commands.py`（9 命令 + 注册表 + 工具名映射）、`marketplace_risk.py`（独立分级）、`marketplace_handler.py`（单闸 + grant-time apply + 幂等/双绑定/歧义态）、`models.py`（saga + ledger + ApprovalType）、`state.py`（ledger 表 + 原子 claim + 事务级单审批约束）、`team_kernel.py`（审批接线）、`cli.py`（`superclaw marketplace` 命令群）。
- 47 单测 + 186 相关回归全绿；五轮对抗验收逼出并修复 14 个真阻断项。

### P1 — 接单 saga 桥 + 收编旧路径　🔧 WIP（首版被双顾问验收驳回，6 阻断项待修）

> **首版状态**：`marketplace_saga.py` + `marketplace advance` CLI + legacy 弃用提示已写（worktree 未提交，8 saga 测试绿）。Codex+AGY 验收**不通过**，6 个真阻断项必须修后才能提交。下为施工图。

**6 个阻断项 → 修复（双顾问 2026-06-24）：**
1. **`advance` 非原子/非幂等**（并发产孤儿 issue/run + 绑定覆盖）→ bind 阶段用**单事务 store 方法**（re-check order==claimed_remote + INSERT issue + UPDATE order 一并提交）；run-start 阶段靠 `checkout_issue` 的 workspace 锁（一持有者）+ `anchor_run_on_issue` CAS 天然串行化（即 B3 的复用）。
2. **verify FAIL 当可交付**（`_observe_run` 只看 `run.status==completed`）→ 完成时读 `store.get_evidence(run_id).chain_verdict`；`== FAIL` → `run_failed`，仅非 FAIL 才开完成门。
3. **operator 直驱绕过 checkout 不变量** → `_start_delivery_run` 必须走 daemon 序列：`assign_issue`(给公司 agent，无 agent 则 fail-closed) → `checkout_issue(run_id=token, holder=agent, expected_assignee=agent)`(得 hold/budget/secret/lock 门) → `start_existing_goal/run_goal` → `anchor_run_on_issue(issue, run_id, expected_checkout_run_id=token)` CAS。token 存 order。
4. **完成门接线非 fail-closed**（issue 非 in_progress 仍推 review_pending → 死锁）→ 仅当 `submit_for_review` 真正成功（issue 进 in_review 或 no_gate 自完成）才推 review_pending；否则不推/标 blocked。捕获 `ClaimChangedError`/`IssueHeldError` 如 daemon。
5. **submit grant 未复核** → `marketplace_handler._apply_submit` grant 时必须复核：bound issue `done` + bound run==order.run_id + `evidence.chain_verdict != FAIL`，而非只信 ledger 状态。
6. **legacy 收编不够**（仅警告仍可绕过）→ CLI `clawhunt bid/claim/submit` **真禁用/硬路由**到 governed `marketplace`（非仅 stderr 警告）；API `run_and_maybe_submit` auto-submit + `/api/clawhunt/submit` 直发同样收编（Codex 要求现在封，不留 P2）。

复用锚点：daemon `service_once`(daemon.py:1526 checkout→1581 run_goal→1605 anchor→1626 submit) 是 race-safe 序列范本；`ChainVerdict`(models.py:15) FAIL/PASS/WARN；`anchor_run_on_issue`(state.py CAS)；`assign_issue`/`list_agent_profiles`(team_kernel)。
- **`marketplace_saga.py`**：幂等 `advance_marketplace_order(store, order_id, *, orchestrator)`：
  - `claimed_remote`：在 order 公司下建 `Issue(kind=delivery, review_policy=human_final)`（workspace 取 `list_workspace_profiles(company)` 首个或按需建），绑 `order.issue_id`，→ `issue_bound`。
  - `issue_bound`：`GoalSpec.from_clawhunt_problem(order.problem_snapshot)` + `orchestrator.start_existing_goal(execution_context_extra={company_profile_id, issue_id, order_id})`，`anchor_run_on_issue`，绑 `order.run_id`，→ `run_started`。
  - `run_started`：查 run/issue 终态。run completed **且** `issue.status==done`（过完成门）→ `review_pending`→`ready_to_submit`；run failed → `run_failed`。
- **触发点**：claim grant 成功后调一次 advance（建 issue + 起 run）；daemon `reconcile_marketplace_orders()` 续推（run 完成后 → ready_to_submit）；CLI `marketplace advance <order_id>` 手动推。
- **submit 完成门校验**：`_apply_submit` 已要求 order 在 `submit_approval_pending` + 有 bound run + evidence；P1 补「issue 过完成门才推到 ready_to_submit」，使「完成门→提交门」严格分离。
- **收编三条旧路径**（同 PR 删/改写）：
  - `apps/api/main.py:3209 run_and_maybe_submit` auto-submit（有 `CLAWHUNT_AGENT_API_KEY` 即自动提交）→ 改为经 order saga，禁默认自动提交。
  - `apps/api/main.py:7653 POST /api/clawhunt/submit` → 代理到 marketplace order/submit 服务（校验 order + 完成门）。
  - `cli.py:8443 submit` / `clawhunt submit/bid/claim` 直连 → 改走 governed handler 或标 legacy。
  - `/api/clawhunt/tasks` 保留为只读 projection（匿名 Dock）。

### P2 — API 层　📝
- `POST /api/marketplace/commands`（dispatch，服务端注入 scope，镜像 `/api/team/companies/commands`）+ order/ledger 查询端点 + saga advance 端点。

### P3 — Chat 能力投影　📝
- marketplace 读工具（browse/inspect）投进 B 类后端内建（无 key fail-closed，不降级公开）；`marketplace_post_task` 写工具→pending_approval。
- **接单走 delivery intent**：`@marketplace_order` context-ref 强制 `intent=delivery`（复用既有 `@company → start_existing_goal` 机制），返回 `{order_id, issue_id, run_id, problem_id}`；读=纯 chat(run_id=None)，接单=必产可轮询 run。
- A 类 MCP / ClawWork relay 对 mutating 工具 fail-closed（无 resolver/scope 不暴露）。
- 三诉求落点：查订单数=browse 读工具；发布=post_task 写工具(人审)；接单跑完=@order delivery intent → saga。

### P4 — Web 层　📝
- dock/@-mention 接 marketplace order + 受治理 UI 流（审批门可视化）；删旧裸跑 `startRunFromClawHuntTask` 接单路径（同 PR 收编）。

## 5. 关键文件锚点
- 内核：`marketplace_commands.py` / `marketplace_risk.py` / `marketplace_handler.py` / `marketplace_saga.py`(P1)
- 状态：`state.py`（`marketplace_orders` 表 + `create_marketplace_claim` / `open_marketplace_order_approval`）
- 模型：`models.py`（`MarketplaceOrderStatus` / `MarketplaceOrder` / `ApprovalType.MARKETPLACE_COMMAND`）
- 接线：`team_kernel.py`（`_apply_agent_approval` marketplace 分支 + reject 钩子）
- 既有可复用：`GoalSpec.from_clawhunt_problem`、`orchestrator.start_existing_goal`、`anchor_run_on_issue`、`build_clawhunt_submission_payload`、`EvidenceBundle.submitted_to_clawhunt`

## 6. 已知取舍（留痕）
- abandon 待 ClawHunt release endpoint 才能真正放槽（现 fail-closed 停 blocked）。
- 网关型 4xx（非 408）若结果不确定需单独收紧 `_is_ambiguous_status`。
- delivery Issue 的 workspace：P1 取公司现有 workspace 或按需建（需定 workspace 归属语义）。

## 7. 未来方向：交付物 →「可复用能力」资产化转卖（业主设想，待正式立项）

> **状态**：产品方向，业主 2026-06-26 提出。本节先把意图与硬约束记进路线图；正式设计前需三方（主代理 + Codex + Antigravity）对抗式评审与立项。**尚未实现**。

### 7.1 一句话
把 marketplace 一次「接单交付」的成果，在**可复用时**沉淀成工坊能力（plugin / skill / company）**上架转卖**，让后来的同类需求（含低成本的「实习生」agent）直接复用，降低边际交付成本、形成市场壁垒（飞轮）。

### 7.2 闭环位置（两端底座已就位，缺中间桥）
```
[已有] marketplace 接单交付（本设计 P0–P4，已 MERGED）
   → ❓「资产化桥」：交付物 → 可复用能力（本节，待建）
   → [已有] 能力工坊：build/validate → 开发者签名 + 官方联署 → R2 上架 → 下载安装
```
开发者签名链路已连通（`capabilities workshop submit-review` 默认用 escrow 私钥签名），工坊发布/验签/分发齐备；**唯一缺口是「交付物 → 能力」的抽象/打包/上架**。

### 7.3 硬约束（立项前必须想清，业主 2026-06-26 明确点出「完整性 + 可移植性」）
1. **资产化是可选、需判定的一步，非每单默认**。强上下文绑定的一次性交付（改某仓某 bug）不可复用；可资产化的只有**模式化成果**——可参数化工具（plugin）、可迁移方法论（skill）、可重雇团队蓝图（company）。
2. **完整性**：交付物必须自包含（代码 + 依赖 + 契约 + 证据），脱离原任务能独立运行——对齐工坊 `.scplug/.scskill/.sccompany` 打包契约与 L1 验收等级；资产化前必须过工坊 `build` + `validate`。
3. **可移植性（脱敏 / 泛化，关键命门）**：必须有**显式**「脱敏 + 泛化」工序——抽走任务特定数据、密钥、硬编码路径、客户私有信息，泛化成通用能力。**绝不自动把原始交付物直接上架**（会泄露客户数据或卖出一次性 hack）。这步由人或专门 agent 显式改造并审核，**不可省略、不可纯自动化**。
4. **治理 / 合规**：转卖涉及 IP 归属、原任务发布方署名、分成。上架须过工坊官方联署 + 开发者签名（复用已连通链路）。原 marketplace 任务发布者对其交付物的资产化权利需在合约层明确（本仓之外）。
5. **铁律对齐**：资产化是**新业务语义**，必须先进内核 + CLI（如 `marketplace asset promote <order_id>` 生成能力草稿），再上 API / Web 表层；表层不得自行拼装「交付物 → 能力」。

### 7.4 与能力工坊 IA 重构的交汇
资产化产出的能力最终在（重构后的）能力工坊展示 / 购买，**来源标记为「源自交付」(provenance)**，与开发者原创能力区分。工坊 IA 重构（见 `docs/` 工坊 IA 方向）需预留这一**来源维度**，并与「二级分类（category）下沉内核」一并设计。

### 7.5 分期（草拟，待正式立项细化）
- **A. 资产化判定 + 脱敏/泛化工序定义**（产品 + 内核契约）：什么交付可资产化、脱敏清单、泛化模板。
- **B. 内核 `marketplace asset promote`**：从一个 `done` 的 order + evidence 生成**能力草稿**，做自包含性 / 残留敏感信息检查（fail-closed）。
- **C. CLI / API 暴露 + 工坊「源自交付」来源 + 治理元数据**（署名 / 分成 / 原 order 溯源）。
- **D. Web**：交付详情页「资产化为能力」入口 + 工坊按「源自交付」来源筛选。

### 7.6 关键依赖
- 能力工坊 IA 重构（category / 来源维度）。
- 开发者签名链路（**已连通**）+ 官方联署（已有）。
- marketplace P0–P4（**已交付 MERGED**）。
- 内核可复用锚点：`EvidenceBundle`（交付证据）、`build_clawhunt_submission_payload`、工坊 `capability_devtools`（build/validate/sign）。
