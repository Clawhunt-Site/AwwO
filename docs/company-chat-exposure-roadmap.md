# Company 能力对 Chat 暴露完整度 —— 缺口分析与补全路线图

> 状态：草案 / 待实现 · 日期：2026-06-25 · 验收：Codex(gpt-5.5) + agy(Gemini 3.1 Pro) 双路对抗 + 本地代码核验

## 0. 一句话结论

在 SuperClaw 的 **chat 聊天**里 @ 一个公司后，用户能"指挥 AI **改**公司"（11 个写工具，已接通、与 CLI/API 零偏差），但 AI 基本"**看不见**"公司——**没有任何只读/查询工具**。暴露严重失衡：**重写轻读**。用户期望的"@了就能充分查询/管理"**不成立**。本路线图补齐"读/发现"侧，并收敛一处 API 治理旁路。

---

## 1. 背景与评审方法

业主问题：chat 里 @ 公司后，是否就能"充分"对公司做查询 / 管理 / 创建等所有 company 相关操作？

评审方法（遵循项目铁律"Codex + Gemini 批判性验收"）：
- 三路 Explore 勘察 chat / CLI-API / Web 三表层的 company 暴露面；
- 主代理本地 grep + 读码核验关键事实；
- Codex(gpt-5.5) 与 agy(Gemini 3.1 Pro) 两路独立对抗式批判；
- 分歧点由主代理以本地代码为准裁决。

---

## 2. 已核实的事实（带证据）

### A. chat 可调用的 company 工具 = 11 个，**全是写/变更**
源：`packages/superclaw/src/superclaw/ui_contracts.py:1792-2010`（`COMPANY_COMMAND_TOOLS`）+ `company_commands.py:482-519`，import 期断言两表一致。

`company_create / company_update / company_archive · agent_hire / agent_update · issue_create / issue_assign / issue_delegate / issue_comment · work_product_attach / issue_submit_review`

全部经唯一内核入口 `company_handler.execute_company_command`，**已真实接通**（运行时调用者：`orchestrator.py:1044/1200` 绑定 `WorkerLimits.company_command_resolver`、`team_mcp_proxy.py:435` A 类 MCP 代理、`cli.py:6451`、`apps/api/main.py:9329`）。HIGH-risk 走 `pending_approval` 人审门。

> 裁决：agy 据 `company_handler.py:35/138` 注释 "NOT YET WIRED to chat" 断言写工具未接通——经本地核验，该注释是 **PR-A 时期遗留的陈旧 docstring**，PR-F 早已接通。**注释本身是该清理的 doc-rot**。

### B. chat **没有任何只读/查询工具**
grep 全仓确认：11 个工具全是 mutation，**无** `company_list / company_show / list_agents / get_agent / list_issues / read_issue_thread / read_work_product / list_approvals / dashboard` 之类。
→ AI 无法主动：枚举公司、列 agent 花名册、查 agent 配置（model/effort/budget/permission）、看审批队列、读 issue 完整评论线程 / 交付物、查成本、看组织结构。

### C. chat「查询」的唯一来源 = @ 时的静态上下文注入（极薄）
源：`apps/api/main.py:2206-2231`。@ 一个公司只注入：公司一行 `id (name): status=…` + 一句引导语 + **最近 5 条 issue**（仅 `issue_id/title/status/assignee`，`list_issues[:5]`，无分页/过滤/评论/交付物）。**没有** roster、预算/成本、审批、组织结构、workspace。

### D. 发现性缺口
不 @ 公司时，chat agent 没有工具或基线上下文发现"有哪些公司"。前端 @ 菜单把 team companies 列给**用户**挑（`App.tsx:6913`），不是给 **agent** 的能力。

### E. 完全不在 chat 暴露的 company 操作
logo 设置/清除、export company-as-code、消息中心/mark-read、`company init`（建公司同时绑 workspace）——CLI/API 有，chat 无。

### F. （治理）API 双写旁路
`POST /api/team/companies/commands` 走 handler（`main.py:9329`）；但 `POST /api/team/companies`（`:9237`）、`POST /api/team/issues`→`store.save_issue`（`:9203`）、`POST /api/team/agents`→`store.save_agent_profile`（`:8970`）**直写不过 handler**，绕过风险分级 / scope / autonomy 门；issue comment 直写端点还接受 request 里的 author，而 handler 是服务端注入身份。仅 `require_control_token` 门控。属铁律 2（表层零偏差）的风险面。

### G. 「写充分」要收紧（Codex 纠正，已采纳）
11 个工具只覆盖 company/profile/agent/issue/work-product/review 的核心 command vocabulary，**不覆盖** workspace 创建/信任/containment、routine、charter、checkout、block/hold/requeue/tree、成本查询等运营面。所以是"核心写齐了"，不是"所有 company 操作齐了"。

### H. @公司投射工具有前提条件（Codex 发现，已核实 `main.py:2090-2110`）
仅 **auto 模式** 才把 @company 路由到 `delivery` 并投射工具；**非 auto 模式**（task/chat）下 @公司只带引导文本、**无任何 company 工具**。即"@了能管理"隐含三前提：auto 路由 + `company_tools_enabled()` 开 + resolver 绑定成功（`backends.py:4242`）。

---

## 3. 覆盖矩阵

| 维度 | chat 暴露 | 证据 |
|---|---|---|
| 创建公司 | ✅ `@company:create` → `company_create` | `App.tsx:6964`, `main.py:2232` |
| 写/管理（11 个核心 command） | ✅ 经唯一 handler，零偏差 | `ui_contracts.py:1792`, `orchestrator.py:1044` |
| 只读 / 查询 | ❌ **零工具** | grep 全仓 |
| @ 时上下文 | ⚠️ 极薄（状态 + 5 条 issue 标题） | `main.py:2206` |
| 发现性（列公司） | ❌ | 无 `company_list` 工具 |
| 运营写面（workspace/routine/charter/checkout/block-hold-requeue） | ❌ | 不在 11 工具内 |
| logo/export/messages/init | ❌ | CLI/API only |
| @公司在非 auto 模式 | ❌ 无工具 | `main.py:2090-2110` |

---

## 4. Paperclip 对照：它暴露了什么我们没暴露的

参考项目 `/Users/leongong/Documents/paperclip-ref`。Paperclip 把公司管理暴露给 agent 的机制：**skill 指令 agent 直接调 REST API（curl）**，API 即 agent 的工具面。

> 精度提醒（Codex 纠正）：对照时必须把三层分开，否则会被指为夸大——
> - **(L1) `paperclip-board` skill 直接要求的能力**：列公司、dashboard、approvals、issues、comments、agents、config-revisions、costs、work products（`paperclip-board/SKILL.md:30,367,583`）——这是 SuperClaw "chat 管理公司"的**直接对等面**，下面 §4.2 对照的就是这一层。
> - **(L2) `paperclip` heartbeat skill 的 agent 自身能力**：`/api/agents/me`、`inbox-lite`、`heartbeat-context`（`paperclip/SKILL.md:36,47,70`）——agent 自治视角。
> - **(L3) Paperclip 全产品 API 面**：goals/projects/routines/interactions/attachments 等（`paperclip/references/api-reference.md:925,949`）——"可暴露"不等于"board skill 已暴露"。

两个关键 skill：
- `skills/paperclip/SKILL.md` —— agent 在 heartbeat 里自治协调（L2）；
- `skills/paperclip-board/SKILL.md` —— **"以董事身份通过 chat 管理公司"**（L1），正是 SuperClaw "chat 管理公司"的对等面。

### 4.1 决定性差异：Paperclip 是"读优先"，会话启动先盘点
`paperclip-board` skill 的 **Session Startup 第一步**（`paperclip-board/SKILL.md:36-52`）就是：
1. 若无 `COMPANY_ID` → **list companies**（发现）；
2. 若有 → **`GET /api/companies/{id}/dashboard`** 理解当前状态；
3. 读 "Board Operations" issue 的 decision-log 重建上下文；
4. 用**状态摘要**问候用户。

`dashboard` 端点 = "health summary: agent/task counts, spend, stale tasks"（`paperclip/references/api-reference.md:478,985`）——即 Codex 建议的 P0 "scoped company snapshot"。**SuperClaw chat 完全没有等价物**：它既不能列公司、也没有 dashboard、AI 进来两眼一抹黑只能等用户 @ 喂饭。

### 4.2 Paperclip 暴露给 agent 的【只读/发现】端点（SuperClaw chat 全缺）

| Paperclip 只读端点 | 含义 | SuperClaw chat 是否有 |
|---|---|---|
| `GET /api/agents/me` | 自身身份 + role + **chainOfCommand（组织结构）** + budget | ❌ |
| `GET /api/agents/me/inbox-lite`、`/inbox/mine` | 我的任务收件箱（发现待办） | ❌ |
| `GET /api/companies/{id}/dashboard` | **概览盘点**：agent/任务计数、花费、停滞任务 | ❌ |
| `GET /api/companies/{id}/agents` | **agent 花名册** | ❌ |
| `GET /api/companies/{id}/agent-configurations` | 全员配置 | ❌ |
| `GET /api/agents/{id}/configuration`、`/config-revisions`、`/skills` | **某 agent 的配置/历史/技能** | ❌ |
| `GET /api/companies/{id}/issues?assigneeAgentId=&status=` | **带过滤的 issue 列表（看板查询）** | ❌（仅注入 5 条） |
| `GET /api/issues/{id}/comments` | **完整评论线程** | ❌ |
| `GET /api/issues/{id}/attachments` | **交付物/附件** | ❌ |
| `GET /api/issues/{id}/heartbeat-context` | issue 富上下文 | ❌ |
| `GET /api/companies/{id}/approvals?status=pending` | **审批队列** | ❌ |
| `GET /api/companies/{id}/goals`、`/projects`、`/routines` | 目标 / 项目 / 例程 | ❌ |
| `GET /api/skills/catalog`、`/companies/{id}/skills` | 技能目录 / 公司技能 | ❌ |
| `GET /api/.../costs/by-agent`、`/by-project` | **成本穿透下钻**（董事看账单管 budget，agy 补） | ❌ |
| `GET /api/agents/{id}/config-revisions` | **配置历史追溯**（改别人配置时看版本变更，agy 补） | ❌ |
| `GET /api/issues/{id}/heartbeat-context` + interaction 卡片族 | **读富上下文 + 结构化治理交接**（`request_checkbox_confirmation`/`ask_user_questions` 强制状态机流转，比裸 comment 强，agy+Codex 补） | ❌ |

### 4.3 Paperclip 暴露给 agent 的【写】端点（SuperClaw chat 缺的运营面）
SuperClaw 11 工具大体对齐 Paperclip 的 issue/agent/approval 写操作；但 Paperclip 还对 agent 开放了 SuperClaw chat 没有的运营写面：
- **项目**：`POST /api/companies/{id}/projects`、`POST /api/projects/{id}/workspaces`；
- **例程/触发器**：`POST /api/companies/{id}/routines`、`/routines/{id}/run`、`/routines/{id}/triggers`；
- **技能管理**：install-catalog / import / sync / audit / reset；
- **导入导出**：exports / imports preview+apply；
- **附件上传**：`POST /api/issues/{id}/attachments`；
- **交互式协作**：`POST /api/issues/{id}/interactions[/accept|/reject]`（agent 间结构化交接）。

### 4.4 一句话对照
> **Paperclip 给 agent 的是一个"读写对称、会话启动先盘点"的控制面；SuperClaw chat 给 agent 的是一个"只能写、看不见、要用户喂上下文"的半边控制面。** 我们缺的不是某个具体写操作，而是**整个"读/发现"维度** + dashboard 概览 + 运营写面。

---

## 5. 补全路线图

设计铁律（必须遵守，已升级为验收项——两路顾问要求写硬）：
- **能力先进内核再上表层**：只读查询能力同样要先在内核 / `ui_contracts.py` 定义契约，CLI/API/chat 共用同一份投影，禁止前端硬编码。
- **【验收项】读工具复用统一 scope gate + fail-closed**：只读工具必须经 `assert_command_in_scope` **同一个** scope 门，绝不另起只读特权旁路；confined agent 读自身公司，operator 读其 home scope。每个读工具都要有跨公司读被拒的回归测试。
- **【验收项】单独验收"chat 真能看到这些工具"**：写侧已有 `auto` 路由 + `company_tools_enabled()` + resolver 绑定三前提（`main.py:2097`）；只补内核/API 不够，必须端到端验证 chat/runtime 真的把读工具投射进了模型的 tool 列表。
- **【验收项】snapshot 必须底层高效吐 DTO**（agy 风险点）：`company_snapshot` **禁止**在 API/chat 层拉全量 issues+agents 现场 reduce（N+1/OOM 炸弹）；必须在 `store` 建能高效返回 snapshot DTO 的底层契约，可能涉及内核查询重构。
- **【验收项】读工具的截断/降级策略**（agy 风险点）：`read_work_product` / `read_issue_thread` 必须界定上界——交付物若是图片/PDF/大 zip，只返回 metadata（类型/大小/文件名），**绝不**把内容全 dump 进 prompt。设计之初敲定截断策略。
- **表层零新增语义**：只读工具是"投影既有 REST 读端点 / store 查询"，不新增业务语义。

### P0 —— 发现 + 盘点 + 止血（没有它"@了能查"根本不成立）
1. **`company_list`**（发现）：列出当前 principal 可见的公司及状态。让"列出我有哪些公司"成立，补 D。
2. **`company_snapshot`**（盘点，对标 Paperclip dashboard）：单个只读聚合工具，返回 scoped 公司的 roster 摘要、active/pending issues 计数、pending 审批/消息计数、成本摘要、停滞任务。**有界、稳定、可审计的 schema，不是垃圾桶**（细节走 P1 下钻）。两路顾问一致：**先 snapshot 后细粒度**——没有聚合 snapshot，模型第一轮仍要盲拼多次查询，达不到 Paperclip"进场先盘点"的体验。补 B/C。
3. **封堵 F 的 API 双写旁路**：`POST /api/team/issues`、`/api/team/agents`、`/api/team/companies` 切回 `execute_company_command`，或在文档/代码中明确界定哪些是 Web-only kernel surface 并加注；issue comment 直写端点的 author 必须服务端注入。两路顾问一致：F 是 P0 止血项，非次要。
4. **修 H（Codex 要求从 P1 升 P0）**：非 auto 模式 @公司**静默给上下文却无工具**是**能力暴露语义错误**，与 snapshot 同级——要么也投射工具，要么明确告知"该模式不支持 company 工具"，不留静默断点。

### P1 —— 让"@公司后充分查询"达到最低线 ✅ 已实现
5. ✅ **`agent_list` / `agent_show`**：花名册 + 某 agent 配置（model/effort/budget/permission/skills/granted tools）。
6. ✅ **`issue_list`**（status/assignee 过滤 + SQL LIMIT 有界）/ **`issue_show`**（描述 excerpt）。
7. ✅ **`read_issue_thread`**（评论线程，body 截断）/ **`read_work_products`**（交付物 metadata + summary excerpt，绝不 dump 原始字节）/ **`approval_list`**：补齐审查闭环。
8. ✅ **`messages_read`**：消息中心**读**（复用 `build_company_messages_payload`，scope 过滤）；`mark-read` 仍 P3。
9. ✅ **清理** `company_handler.py` 的 "NOT YET WIRED" 陈旧注释。

> 8 个 P1 读工具复用 P0 基础设施（同一 resolver/派发/投射/A 类 proxy/单一源契约）；entity-anchored 读解析实体公司后经同一 `scope.permits` 门校验，confined 跨公司读 fail-closed；free-text 一律 `_TEXT_EXCERPT_CHARS` 截断 + 标记。共 10 读工具（2 P0 + 8 P1）。

### P2 —— 运营写面（决定公司是否"可运行"，非仅查资料）
9. workspace 管理、routine author/schedules、`company init`（创建即可工作的公司）的 chat 暴露（对标 Paperclip projects/routines/workspaces）。先评估是否进内核 command vocabulary（铁律 1）。

### P3 —— 表现层差异（三方一致：不补进 chat）
- `logo set/clear`（资产/视觉）、`export`（运维打包）、`messages **mark-read**`（信箱红点，AI 是 event 驱动不需模拟"已读消除"）。这些是表现层，AI 不需要在 chat 里做。
- 注意：仅 `mark-read` 留 P3；**messages 读已升 P1**（见上 #8）——两路顾问一致反对把"读"和"消红点"打包成一档。

---

## 6. 验收记录

- **核心结论**（"查询是短板 / 重写轻读"）：Codex 与 agy **双方明确成立**，非夸大。
- **Codex 贡献**：收紧"写充分"（仅 11 command vocabulary）；发现 H（非 auto 无工具）；判 F 被低估。
- **agy 贡献**：判 F 为 P0 级"零偏差"风险；指出审查闭环断裂（有 submit_review 无读交付物工具）。
- **主代理裁决**：agy 的 "NOT YET WIRED"（写工具未接通）**经本地核验为误**（陈旧 docstring）；写工具确已接通——但该注释应清理。
- **Paperclip 对照**：确认我们缺的是整个"读/发现"维度 + dashboard + 运营写面，而非个别写操作。

### 6.1 第二轮：Paperclip 对照 + 路线图复审（2026-06-25）
两路顾问对**完整路线图 + Paperclip 对照**再次表态：

- **agy（Gemini 3.1 Pro）**：**完全同意推进**。对照"极准无夸大"；snapshot 聚合优于细粒度（context/token/延迟更省，避免模型漏抓）；P3 砍 mark-read "坚决同意"。补 3 能力（成本穿透、配置历史、富交互卡片）+ 2 执行风险（snapshot 内核性能炸弹、read_work_product 截断降级）——均已吸收为上面验收项。
- **Codex（gpt-5.5）**：**总体同意**，要求收紧 4 处（已全部吸收）：① Paperclip 对照拆成 L1/L2/L3 三层，别把 board-skill 直接暴露 / agent heartbeat / 全产品 API 混写（否则被指夸大）；② **H 升 P0**；③ **messages 读升 P1**（mark-read 留 P3）；④ 把"读工具复用统一 scope gate""单独验收 chat 真投射工具"写硬成验收项。snapshot vs 细粒度：明确"先 snapshot 后细粒度"。
- **共识**：核心结论（重写轻读 / 查询是短板）双方第二轮再次确认；P0 = `company_list` + `company_snapshot` + 封堵 F + 修 H；snapshot-first；logo/export/mark-read 不补。
- **分歧裁决**：无相互冲突的阻断意见；Codex 的升档（H→P0、messages-read→P1）与 agy 的补充能力/风险不矛盾，主代理全部采纳。

> 本路线图为评估产物，尚未实现。实现时每个 P0/P1 工具按铁律走"内核契约 → CLI/API/chat 三表层 → Codex+agy 双 PASS → 原子提交"。
