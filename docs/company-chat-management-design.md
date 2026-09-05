# 设计:让 SuperClaw 主 chat 完整管理 company(白名单 fail-closed + 风险分级 ask)

> 状态:**设计级双顾问对抗评审已通过**(Codex gpt-5.5 + Gemini 3.1 Pro/agy,6 轮修订 v1→v7,双方明确 PASS)。可进入实现。
> 本文是 CLI 唯一事实源 + fail-closed 治理铁律下的落地设计;实现按 §7 相位拆原子 PR,每个 PR 另走一轮实现态验收。

## 1. 目标与治理姿态

让 SuperClaw **自己的主 chat(agent runtime)** 能**完整管理 company**(建/改/招 agent/派工单/解散),而非只能靠人在 CLI/Web 手动操作。能力先进内核、再投影给聊天表层(符合"CLI 唯一事实源 / 表层零新增语义")。

治理姿态(业主拍板):**白名单 default-deny + 风险分级 ask** —— 日常正常工作直行不拦截,只有危险/跨界/未知操作弹人审(ask)。`dissolve` 改为 `archive`(软删 + 级联熔断,不硬删)。

> **威胁模型重定(业主 2026-06-22,优先级最高,覆盖下文与旧版冲突处)**:本产品是**单用户、本地、agent 是用户自己的助手、做的是用户让它做的事**。核心原则:**"只要是用户触发的,就该允许去做"**。因此:
> 1. **不防"流氓 agent 背着用户自批"**——那是错配的威胁模型,且为它上重型认证根(硬件在场签名 / 内核验签 / operator_proof challenge)是用高性能/复杂度成本换一个本产品不需要的防护。**整套硬件/内核签名认证根(原 PR-C)作废,不实现。**(C-1 软件 challenge 已撤;`operator_proof` 痕迹清除。)
> 2. 真正要防的是**误操作 / agent 误解用户的话造成不可逆损失**。所以保留一个**轻量人工确认("你确定?")仅用于不可逆/破坏性操作**(`archive`/dissolve);日常(建/改/招/派单)用户触发 → **直接执行,零确认**。
> 3. 这个"确认"= 复用现有 Approval 的人审 UI(人在 Web/CLI 点确认),**无密码学、无硬件、近零成本**;它是防手滑的 UX speed-bump,不是防敌对 agent 的安全边界。
> 4. **保留的 PR-A 地基**(命令模型 / scope / 生命周期 / 写门 / 凭证拉黑 / 风险分级)都是**近零成本的"防错 + 结构"层**,继续保留;只把**风险门的 HIGH 阈值收窄到"不可逆操作"**。
> 下文 B1/B3 等中"防 in-process agent 自批 / 硬件签名 / operator_proof"相关内容据此**降级为历史背景**,不再实现。

## 2. 核心安全契约(评审逼出的 8+ 条不可妥协约束)

### B1. 能力投影 fail-closed + 风险门=白名单(default-deny)
- `company_*` 工具的注入由内核 capability grant 控制,**默认 fail-closed**;仅当 `ExecutionContext` 携带已认证 operator scope 且显式授予 company-management capability 时才注入。
- `classify_company_action(cmd, ctx) -> RiskVerdict`:**只有命中白名单的窄操作判 low(直行),其余一律 high(挂起 ask)**。未知字段/未知操作 = high。
- **不用 LLM/自然语言意图做安全边界**(可被 prompt 注入绕过)。`create_issue` 的风险**只由硬约束判定**:issue 是 **core-owned 闭集 registry 的结构化 kind** 且其绑定的 **tool allowlist + 沙盒能力** 证明 benign(零网络出口/零高危命令/零 secret/零外部写、仅本公司内部状态)→ low;否则 high。issue freeform 正文永不影响风险档。
  - **能力来自执行者,不来自 issue 本身**:一个 issue 在被**指派 + 检出 + 由某 agent 执行**之前**挂载零能力**;能力完全来自执行的 assignee 的装备,而**指派是独立命令(`AssignIssueCommand`)、独立过风险门**(assignee 非 minimal → high)。因此:
    - **未指派的结构化 issue = 绑定 tool allowlist 为空 = B1 的平凡 benign(空 allowlist)情形 → low**(组合安全:危险的一步「指派给有能力的 agent」被独立 gate 为 high,建 issue 本身不授予任何能力)。
    - **带 assignee 的 create_issue → high**(不得绕过 assign 门);**带显式 workspace 且无法确证属本公司 → high**。
    - **per-kind capability-bundle 绑定**(issue-kind → 固定 capability bundle)是对「已指派/按 kind 预绑能力」情形的**后续收紧**,不改变「未指派=零能力=low」这一平凡情形。

### B2. 风险按"有效权限闭包"判 + run-start 二次门
- 判级输入 = 结果状态 delta + effective permission closure + 后续可执行路径(agent equipment / issue intent / delegate depth / reports_to 链 / workspace lock / reserved_path / network egress / token-secret 访问 / 外部写目标)。
- "无特殊权限"= effective permissions 计算为 empty/minimal(非"缺显式字段")。
- 改 agent `system_prompt`/`instructions`/`equipment`/`reports_to`/permissions **一律 high**(防提权/僵尸化)。
- `company_assign_issue` low **仅当 assignee 本身 minimal**(闭包含继承的 company/workspace 模板默认值)。
- **classify 期与 run-start 期复用同一个 capability resolver**(单一实现);run-start/checkout 拿到完整待装载 context 后再硬校验一次(兜延迟提权)。
- 速率/配额门:`company_create`/`hire_agent` 即便单次 low 也过 per-operator rate limit + quota,超限 → high/forbidden(防 DoS/费用爆炸)。
- `company_create` 仅纯 metadata create 才可能 low;带 bootstrap workspace/template/agent 副作用 → high。

### B3. 人类专属审批:独立 operator-auth authority + 每次 mutation 人在场签名
- **两个结构性独立的签发源**(非"同 token 两种 caller_type"):
  - **Operator Auth Authority**:只签 `HumanSessionToken`,签发必须经一次交互式人类认证事件;身份用强类型结构承载(JWT claims `role:"operator"` 或后端 session 表独立 enum 列),**不靠前缀字符串区分**。
  - **Agent Token Authority**(内核 runtime spawn 路径):只签 `AgentToken`(`role:"agent"`,极短 TTL,绑 issue_id/session_id,带 issued_company_epoch);**该路径结构上无法签 operator role**——agent 即便攻陷自身,也只能再 mint agent-role token。
- **operator 批准 = 代理不可读的交互式人在场签名事件,无落盘 bearer**:
  - 批准动作发生在与 agent 隔离的信任域(人类浏览器 Web 会话 / 要求实时人在场手势的交互确认)。
  - 证明 = 由**硬件级/Secure-Enclave/钥匙串 user-presence ACL 持有、agent 无法导出**的密钥,对**本次 mutation 的 canonical action digest** 签名;内核验签通过才落 approve。
  - **删除 `0600 文件` 作为 operator 凭证存储**(0600 只挡别的 OS 用户,不挡同账户 agent)。keyring 仅当带 user-presence ACL(每次访问需人在场)才允许。
  - **防重放**:被签 payload 含全局单调 nonce + 严格 timestamp + company epoch 绑定。
  - **不支持硬件在场时严禁降级**:无 Touch ID/user-presence 的环境**绝不** `fallback_to_plaintext_file`;强制抛异常并降级到 Web 端人类会话域审批。
- **API/CLI Default-Deny**:审批/决策端点要求 `role==operator`;`AgentToken`/非 operator → 403,路由层硬断;**禁止 `if not agent: treat as human` 回退**。runtime mode(auto/acceptEdits/dontAsk/bypassPermissions)对 company high 门**无效**。
- `decide_approval` high 风险 company 治理项断言 caller credential class == operator;agent 决策路径仅限非治理 issue-completion,禁用于 hire/archive/permission/跨界。
- **纵深防御**:File/Command 工具底层拦截器**硬拉黑** operator 凭证目录(`~/.superclaw`/`~/.config/superclaw`/钥匙串读取命令等);**判断前 `os.path.realpath` 归一化**,挡 `../../` 穿越与 symlink 绕过(按真实 inode 阻断)。operator 高权凭证仅存 UI 进程内存。

### B4. 统一内核 approval ledger + maintenance gate 全局写冻结 cutover
> **实现范围裁决(业主 2026-06-22)**:本功能(聊天管理 company)**不做** escalation+approval 的全量合并迁移。company 高风险审批**复用现有 Approval 系统**(`team_kernel.decide_approval` + `models.Approval`,语义即现有 `AGENT_HIRE`/`AGENT_CONFIG_CHANGE` 族),不引入新状态机、不动 escalation、不碰现有审批测试。下文的"统一 ledger + 单事务 cutover 迁移"是**独立立项**的全系统重构(A.5 写门已为其备好 cutover 安全原语);本功能只承接其中**已落地的 maintenance 写门(A.5)**,合并迁移本身缓做。company 命令的 LOW→直接执行 / HIGH→创建 Approval 走现有人审,由 company 命令 handler 承接。
- (全量合并目标,独立立项)取消"escalation respond 与 decide_approval 各跑一套",统一为单一内核 approval ledger(工具 escalation / hire / issue completion / archive 全进同一账本、同一状态机、同一审计字段);表层只订阅同一类事件 + 回应。
- **maintenance gate = kernel/store/orchestrator 层的统一写守卫 `assert_writes_allowed()`**:所有改 approval/escalation/run-state/ledger/治理对象的写 choke point(API / CLI / TUI / daemon / orchestrator 内部 / 直接 kernel 调用)进入实际写前必经它;maintenance 期间一律 **纯硬拒绝**(返回 `MAINTENANCE_IN_PROGRESS`,调用方迁移后自行重试),**绝不排队/缓存/后台重试**(排队会把旧语义带到 cutover 后重放,污染幂等与审计)。
- **必须落最深写 sink**(`save_run`/`_save_run_in_transaction`/`save_approval`/`create_escalation`/`resolve_escalation`/任何内部 `mutate_*` 包装器);"全局静止切片"口径下顺带纳入 `save_issue`/`save_company_profile`/`save_agent_profile`,杜绝"ledger 冻了但治理对象还在变"灰区。
- cutover 序列:进入 maintenance(全 surface 写冻结)→ 静默期等 in-flight 事务 drain → 单事务迁移(旧 `request_id`/`approval_id`/ticket 兼容键 + pending 守恒断言)→ flip 新 ledger + 旧入口按旧 ID 幂等转发 → 退出 maintenance。

### B5. company epoch/fencing(防 archive TOCTOU 穿透)
- `CompanyProfile` 增 `status`(ACTIVE/FROZEN/DISSOLVED)+ `epoch`(单调递增);freeze/archive/restore 时 epoch++。
- **所有可恢复对象签发时持久化 `issued_company_epoch`**,apply/resume/execute 前经统一 `assert_company_active(obj, ctx)` 校验 `issued_company_epoch == current && status==ACTIVE`,不符 fail-closed。覆盖:run(含挂起 turn)/approval/escalation ticket/resume token/delegation review token/equipment lease/AgentToken;**别漏** pending interaction queue / child-delegation wait record / review inbox / continuation receipt / 未来 timer-cron。
- restore 到 `ACTIVE@N+1` 后所有 `epoch==N` 旧 token/审批/pending turn 一律失效,须重新签发。
- 网关熔断:需 agent auth 的端点断言 `agent.company.status==ACTIVE`,否则 401(即便 kill 信号未达、worker 还在跑也被拒收)。

### B6. 中心 command registry,全 backend/CLI/API parity(零偏差)
- 工具注册来自单一中心 registry/contract;backend 只是 adapter;CLI 命令、API payload、chat tool schema 全部从同一核心规格生成/校验。
- 不支持工具注入的 surface → 返回统一错误码(如 `CAPABILITY_UNSUPPORTED_ON_SURFACE`),不静默缺能力;补能力矩阵 parity 测试(CLI 与 chat 对同一非法输入得同一错误码)。

### B7. 单源 typed command models（dataclass，非 Pydantic）
- core 定义 typed command models（`CompanyCreateCommand`/`CompanyUpdateCommand`/`HireAgentCommand`/`UpdateAgentCommand`/`CreateIssueCommand`/`AssignIssueCommand`/`DelegateIssueCommand`/`CompanyArchiveCommand`）。实现用 **dataclass**（匹配 `models.py` 既有惯例，不引入 Pydantic）；API payload / 工具 JSON schema / CLI argparser 全由这份模型派生；所有 mutation 走同一 `team_kernel` command handler 做最终校验 + 授权。
- command 层 `from_dict` **fail-closed 拒绝未知字段**（不同于 `models.py` 通用模型的"过滤"惯例——mutation 契约静默吞字段会让被批准/摘要的动作与原始请求不一致）。`validate()` 是**无状态**业务校验的单源（字段白名单、permission_policy mode、枚举闭集、allowlist 元素类型）；依赖 DB 的**有状态**校验（reports_to 成环/深度、manager 同公司）留在 apply 期内核（分层边界，非漂移）。
- canonical action digest 对**无序集合先排序归一**再 hash（必须进测试）；补 null/omitted/default/empty list/未知字段拒绝行为一致性测试。**归一须 schema-aware**（盲排嵌套开放 blob 的列表会破坏顺序敏感数据），故 canonical_payload 与 digest 落在其**消费者增量（B3/PR-C 签名）**，而非 command-models 地基增量。

### B8. ExecutionContext 强制 scope,跨界 forbidden(防 IDOR)
- principal / workspace scope / allowed company ids 由 server-side `ExecutionContext` 注入;模型传来的 `company_id`/`workspace_id` 只当请求目标,绝不当权限依据。
- 跨 company/跨 workspace → 直接 `PermissionDenied`(forbidden,不弹 ask);仅 operator 具 admin scope 才可跨界且仍走 high 人审。
- scope 校验覆盖**嵌套 ref**(`profile_id`/`issue_id`/`approval_id`/resume token 关联对象同源校验),不只顶层。
- 新 company owner = 当前 operator principal(server 注入)。

## 3. archive(替代 dissolve)生命周期
- `request_company_archive` 两阶段:freeze(epoch++)→ 人审 → `apply_archive`。
- apply 落地:`status=DISSOLVED`;吊销下属 agent runtime token/equipment lease;终止运行中 run;pending approvals 标 superseded;open issues/work products/cost events/audit log **只读保留**;agent tombstone;`company_id` 永不复用;restore 可选(后续)。
- benign tool 集严苛审计:防 SSRF/路径穿越(禁读 `169.254.169.254`/宿主 `/etc/*`/workspace 外 secret);fs 限沙盒;网络走白名单 proxy。
- `company_create` 幂等 key + 防重名 + 并发 owner 创建竞争(单 choke point CAS)。

## 4. 现有可复用地基(已 grep 核实)
- 工具投影模板:`backends.py:3707 _maybe_add_delegate_tool()`(`delegation_enabled()` 默认 False fail-closed)。
- escalation 闭环模板:工具触发 → `EventType.APPROVAL_REQUESTED` SSE → Web `EscalationGate.tsx` → `/api/escalations/{id}/respond`。
- 审批原语:`team_kernel.py:1226 decide_approval`、`submit_issue_for_review`(869)、`request_hire`(1006)、`request_config_change`(969)、`state.py:1805 list_approvals`。
- CRUD:`save_company_profile`(state.py:2547)、`save_agent_profile`(1559)、`save_issue`(1622)、`delegate_sub_issue`(team_kernel.py:1690)、`assign_issue`(358)。
- 需改造的直写面(maintenance gate 必须覆盖):`cli.py:6529 approve`、`cli.py:6682 escalation respond`、`tui.py:1088 resume_run`、`apps/api/main.py:6112 resume_run`/`6131 delegation-review`;最深 sink `state.py:534/1907/2057/2273`。
- 现 auth 现实:全局单一 `require_control_token`(apps/api/main.py:1990;审批入口 3054/8068)→ B3 要替换为独立 operator authority。

## 5. APP 独有(表现层,零新增语义)
聊天 panel 内渲染审批按钮(复用 `EscalationGate.tsx`/`ApprovalPayload.tsx`),决策永远内核裁决;SSE 广播覆盖所有 pending 类别。

## 6. 实现相位(fail-closed 排序,工具投影最后)
- **PR-A 内核地基**:typed dataclass command models(单源,非 Pydantic)+ 中心 registry + `classify_company_action` 白名单 + ExecutionContext scope(嵌套 ref)+ `CompanyProfile.status/epoch` + `assert_company_active` + `assert_writes_allowed()` 统一写守卫(最深 sink)+ File/Command 凭证目录硬拉黑(realpath 归一)。
- **PR-B 统一 ledger + cutover**:新 ledger + maintenance gate 全 surface 写冻结 + 旧 ID 兼容映射 + 单事务迁移(pending 守恒)+ 旧入口幂等转发。
- **PR-C 认证根 + 人审硬门**:Operator Auth Authority(每次 mutation 人在场签名 + nonce/timestamp/epoch 防重放 + 无落盘 bearer + 不支持则强制 Web)+ Agent Token Authority(结构上无法签 operator)+ API/CLI Default-Deny/403 + `decide_approval` operator-only + 网关 status==ACTIVE/401。
- **PR-D CLI parity**:`superclaw company ...` 全子命令(含 archive、operator login)走同一 handler + 规范化一致性测试。
- **PR-E archive 生命周期**:两阶段 + 级联熔断 + epoch fence 全 artifact 绑定。
- **PR-F 工具投影(最后)**:中心 registry fail-closed 注入 `company_*`;不支持 surface 统一错误码。**治理全坐实后,聊天才拿到写能力。**

## 7. 评审留痕
- 6 轮 Codex(gpt-5.5)+ agy(Gemini 3.1 Pro)对抗式设计评审,session-key `company-chat-design`,transcript 落 `.codex-cli-advisor/` 与 `.antigravity-cli-advisor/`。
- 逐版闭合:v1(8 阻断)→ v2(默认开/黑名单/自批/双状态机/硬删/单 backend/校验漂移/IDOR)→ v3(白名单硬能力/assignee 闭包)→ v4(epoch 绑定/独立认证根/pending 迁移)→ v5(代理不可读签名通道/全局写冻结)→ v6(写冻结下沉 kernel/store)→ v7(纯硬拒绝,删"或排队")→ 双 PASS。
