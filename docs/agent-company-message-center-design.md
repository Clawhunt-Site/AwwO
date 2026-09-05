# Agent 公司分级消息中心 —— 学 Paperclip 的三级聚合（设计 v4）

> v2（双顾问：agy PASS / Codex NOT-PASS→收紧）：A 内核单源 + 轮询优先（两者一致）；
> 并入 Codex 阻断——内核 read model 复用 approval scope（防 N+1/跨公司泄漏）、
> "完成未审"精确为 `in_review + pending issue_completion approval`（itemKey=`approval:<id>`，
> 不与 issue 双计）、共享 `build_company_messages_payload` 禁前端聚合、冻结 item schema、
> read state 自清理防 key 膨胀。

## 1. 需求（业主）

绿框「Agent 组」导航入口应成为**全公司消息的分级汇总/通知中心**:审批也是消息;上报分级——
- **全部公司**(all-companies)总览;
- **单个 company 的全部**(per-company);
- **company 内部细分**(完成 + 待审批 + …)。

## 2. Paperclip 蓝本(已读源码)

三级:L1 全公司 Dashboard(按状态计数)/ L2 导航 Sidebar Badge(未读 rollup 数)/ L3 Inbox 页(tab+分类+分组)。未读靠 `inbox_dismissals`(用户×公司×itemKey 持久化 dismissedAt;`dismissedAt ≥ 事件时间`即隐藏)+ localStorage。实时靠 per-company WebSocket `publishLiveEvent`。Badge = 可操作审批 + 失败 run + 待加入 + 未读工单 + 告警。

## 2.5 冻结的 message item schema（v2，Codex）

单条消息 = `{ source_type, source_id, company_profile_id, event_time, actionable, read_at }`。
- `source_type` ∈ {`approval`, `issue_blocked`}（M-1 最小集；PR-2 后加 `comment`/`deliverable`）。
- `source_id` = `approval:<id>` 或 `issue:<id>:blocked`（itemKey 即 read state 键）。
- `event_time` = 该事件**发生时刻**（approval.created_at / issue 进入 blocked 的时刻），**不是** `updated_at`（防评论/改 metadata 误触未读）。
- `actionable` = 是否需要用户动作（pending approval=True；blocked=True；done/已审=False 不入未读）。
- `read_at` = 该用户对此 item 的已读时刻；`unread = read_at is None or read_at < event_time`。

**blocked event_time 的权威来源（v3/v4，Codex #3+legacy）**：Issue 现无 `blocked_at`，`block_issue()` 只设 `updated_at`（评论/改 metadata 也会动 updated_at → 不能用）。M-1 新增 `Issue.status_changed_at`，在**每次 status 转换**时（含 block/unblock/submit/complete）写入；blocked 消息的 `event_time = status_changed_at`。**legacy/backfill（v4，Codex）**：新 issue 初始 `status_changed_at = created_at`；**历史缺字段读取必须确定性**——backfill 为 stored `updated_at`（或一次性迁移写入），**绝不** `default_factory=time`（否则读旧 issue 把 event_time 变"现在",未读乱跳）。

**issue-less approval 的 company scope（v4，Codex #1，跨依赖 PR-1）**：read model 复用 approval scope——issue-linked approval 以 issue 的 company 为权威；issue-less approval（hire/agent-config）fallback `affects.company_profile_id`。**但现状 `request_hire` 写的是 `affects={"spec":…}` 没 top-level `company_profile_id`**。M-1 前置：所有 company-scoped issue-less approval **创建时写 top-level `affects.company_profile_id`**（hire/agent-config…），并加迁移/兼容(旧 approval 缺该字段时按 spec/profile 解析一次回填或归"未分类"，不猜)。**此项触及 PR-1 的 request_hire 路径——M-1 与 autonomy 线在此交汇,实现时一并处理。**

**rollup 字段互斥（v3，Codex #2）**：`completed_unreviewed` = pending `issue_completion` approval 计数；`pending_approvals` = **其余** pending approval（hire/其它，**排除** issue_completion）计数；`blocked` = blocked issue 计数。三桶按 itemKey 不相交。`total_unread` = 三桶**唯一 itemKey 去重**后的未读数（completion approval 只在 completed_unreviewed 出现一次，绝不与 pending_approvals 双计）。

## 2.6 内核 read model（v2，Codex：防 N+1 / 跨公司泄漏）

`build_company_messages_payload()` 不做 naive `list_companies()→per-company list_*`。复用既有 **approval scope 规则**：issue-linked approval 以 **issue 的 company 为权威 scope**；issue-less approval 才 fallback `affects.company_profile_id`。一次归并，按 company 分桶，避免 O(C×rows) 与 approval N+1。

**M-1 最小三类消息**（精确语义）：
1. **pending approval（排除 completion）**：`approval.status==pending` 且 `type != issue_completion`（hire/其它），itemKey=`approval:<id>`，归 `pending_approvals` 桶，actionable。
2. **完成未审**：pending `issue_completion` approval —— itemKey=`approval:<id>`，归 `completed_unreviewed` 桶（**不进** pending_approvals，防双计）。`done`=已审完成，不入未读。
3. **blocked issue**：`issue.status==blocked`，itemKey=`issue:<id>:blocked`，event_time=`status_changed_at`，归 `blocked` 桶。

## 3. SuperClaw 映射(铁律:表现层投影内核事件,零新增业务语义)

**消息源(都已存在,聚合即可,不新增业务语义)**:
- **审批**(`list_approvals`,尤其 `agent_hire` pending——PR-1 已会产生);
- **工单完成 / 状态变化**(`list_issues` status:in_review/done/blocked);
- **(后续)agent 评论 / 交付物**(PR-2 落地后纳入)。
单用户模型:无 join_requests(单租户);cost 告警可选纳入(已有 cost summary)。

### L1 全公司总览(all-companies)
`build_company_messages_payload()`(§2.6 内核 read model)——**一次归并**:扫 pending approvals + in_review/blocked issues,用 approval scope 规则归到权威 company,**不** per-company 重复 `list_*`(避免 N+1/遍历)。每 company 输出 {pending_approvals, completed_unreviewed, blocked, unread_total}。CLI `superclaw company messages`(唯一事实源)→ API `GET /api/team/messages`(跨公司)→ Web。

### L2 导航 Badge(绿框「Agent 组」)
`GET /api/team/messages` 返回 `{ total_unread, by_company:[{company_id,name,unread,pending_approvals,completed}] }`;绿框渲染 `total_unread` 红点。

### L3 公司内细分
进某 company 后,既有 TeamWorkbench「审批」「工单」tab 即 L3;消息中心点 company → 跳该 company 的审批/工单。复用既有面板,不另造。

### 未读机制(v2)
新 kernel `message_read_state`:per-itemKey `read_at`,持久化进 StateStore。`unread = read_at is None or read_at < event_time`(event_time 见 §2.5,非 updated_at)。**单一事实源在内核**,CLI/API/Web 共用(非 Paperclip 前端 localStorage——内核单源更对齐铁律)。
- **mark-read 契约(v3/v4,Codex #4 防竞态 + 服务端快照)**:`POST /api/team/messages/mark-read {item_keys}` 或 `{company_profile_id, seen_as_of}`。**禁裸 company 全量**。**`seen_as_of` 必须是服务端发的快照(v4)**:`GET /api/team/messages` 返回 server-issued `snapshot_as_of`;mark-read 只能回传这个服务端快照值,服务端按 `event_time <= seen_as_of` 标记——新消息(event_time > snapshot)不受影响。**绝不**信前端本地时间/未来值。
- **自清理防 key 膨胀(agy),但读接口只读(v3,Codex 非阻断)**:prune 只在 **mark-read / 显式 maintenance** 时做(把已不在 live 消息集的 read_at 行删掉);**`build_company_messages_payload()`(GET/读路径)保持纯只读,prune 失败绝不影响消息读取**。actionable 消息本就瞬态小集合,key 集自然有界。

### 实时
复用既有 SSE(`streamRunEvents`),加 `company.message` 事件类型;无则前端轮询 `GET /api/team/messages`(与现有 team 面板自动刷新一致)。

## 4. 铁律对齐
- **能力先进内核**:`build_company_messages_payload()` + 读状态原语进 core;CLI 先行(`superclaw company messages`);API/Web 投影。
- **零新增业务语义**:纯聚合 + 未读读状态,不改审批/工单语义;审批仍走既有人审门(PR-1)。
- **契约集中**:消息中心 payload 形状进 `ui_contracts`。

## 5. 分阶段(每阶段双 PASS + 本地全量 ci.yml + 原子 PR;从最新 origin/main 切,Codex)
- **M-1(内核聚合 + 读状态)**:`build_company_messages_payload()`(§2.6 read model,复用 approval scope,一次归并)+ `message_read_state`(§未读,自清理)+ StateStore 持久化 + CLI `company messages` / `company mark-read`。**禁前端聚合**:Web 公司卡片数也改读这份共享投影,不再前端按 agents/issues 自算。core + 测试(跨公司不泄漏、完成未审不双计、blocked event_time、read_at 自清理、N+1 不发生)。
- **M-2(API)**:`GET /api/team/messages`(跨公司 rollup)+ `POST /api/team/messages/mark-read`。薄层 + 测试。
- **M-3(Web 导航 Badge + 消息中心)**:绿框「Agent 组」未读红点;点开 = 公司列表带未读/审批/完成数 → 跳对应 company 的审批/工单 tab。契约进 ui_contracts。
- **M-4(实时)**:SSE `company.message` 或轮询刷新 badge。

## 6. 待双顾问裁决
1. 未读读状态放内核 StateStore(单源,我倾向)vs 前端 localStorage(Paperclip 那样)——单用户本地工具哪个更对?
2. itemKey 粒度(approval/issue 级)与"完成未审"语义如何精确定义未读?
3. 实时用 SSE 扩展 vs 轮询——避免过度工程。
4. 与 in-progress autonomy PR(PR-2 扩契约后新增 comment/deliver 消息)如何不冲突地纳入。
