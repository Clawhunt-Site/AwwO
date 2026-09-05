# Agent Team Kernel × Paperclip 嫁接规划（Phase 2+）

Status: 战略裁决文档（三方收敛：Claude 测绘 `../paperclip-ref` + `feat/agent-team-kernel` worktree；Codex GPT‑5.5；Gemini）。**实施进度与最新裁决以姊妹文 `agent-team-kernel-execution-plan.md` 为准**（P0 三柱已实现并验收 ✅；§2.6 A2A 闭环规格；§2.7 第五轮终审已修订断点与 P1 四切）。2026-06-17 更新：`dev/roadmap` 已完成本地 Paperclip 团队流水线的 proposal→approval/commit→Workbench 闭环；Paperclip 的租户切换、成员邀请、RBAC 管理、SaaS billing/quota 与 Postgres tenancy 不进入本轮。
Date: 2026-06-09
铁律：**CLI 是唯一事实来源**。API/Web/Desktop 只是表层，不得新增内核没有的业务语义、不得绕过治理。Fail‑closed 默认。

---

## 0. 这份规划要解决什么

Phase 1 已落地 SuperClaw‑native Agent Team Kernel（角色/工单/锁/审批 + macOS app 跑通），但**功能简陋、尤其前端**。用户要 Paperclip **相对完整的"组织架构设计"功能**，并把"建公司引导流程"和前端丰富化做到位。

本规划回答：**哪些直接拿 / 哪些改造拿 / 哪些坚决砍**，并给出承重墙、实体补全、建公司契约、前端重构与 P0–P3 排期。

---

## 1. 一句话结论（三方一致）

> 用户"Paperclip 是纯组织设计、可完整拿过来"**只对一半**。可大幅复用的是它的**组织设计轴**（角色 charter → 指挥链 reportsTo → 委派 child issue → 工单 → 审批 → 成本观测）与**声明式组织包**理念和**前端信息架构**；但 Paperclip 的 **SaaS 多租户 / heartbeat 自治 / adapter 抽象 / cron routines / RBAC 邀请 / SaaS 计费 / Secrets / InstanceSettings** 是平台运行假设，**裸拿会撞碎 CLI‑单机‑单一事实源铁律**。
>
> **Phase 2 的承重墙不是先把前端做漂亮，而是先让"角色行为契约"真正进入 CLI/kernel/orchestrator 的运行事实源（缺口 C）。** 否则前端再丰富，也只是更好看的 Phase 1 看板，不是"会运转"的 Agent 组织。

**心智模型（不变，正交分层）**：Crew/公司层（组织·审批·预算） → Agent/角色层（**charter + 装备 + 指挥链**） → 装备层（plugin/skill 收窄投影） → 内核 harness（orchestrator·state·verifier）。

---

## 2. 战略判断（A）：可拿 / 不可拿分轴

| 可直接复用（真·组织设计） | 不可裸拿（Paperclip 平台运行假设） |
|---|---|
| OrgChart 交互树（reports_to 可视化） | Hire CEO 自动自治 / heartbeat 轮询引擎 |
| 角色详情页信息架构（多 tab） | adapter / model 抽象（SuperClaw 由 backend 统一接管，不暴露给 UI 选） |
| 建公司向导**流程壳**（4 步） | cron / webhook routines（要例行用 OS crontab 调 `superclaw issue create`） |
| 审批 payload 多态展示模式 | 多租户公司路由 / 成员邀请 / RBAC |
| 聊天式工单详情布局 | SaaS billing / quota / Stripe（改成本地 token/秒观测） |
| agentcompanies/v1 声明式包理念 | Paperclip Secrets / InstanceSettings feature flags（继续用 SuperClaw 既有体系） |
| teams‑catalog 模板播种理念 | agent‑to‑agent 审批免检（一律上报） |

---

## 3. 承重墙：缺口 C（B）—— 让角色行为契约进入运行时

**已独立验证（读 Paperclip 真实 persona 模板 + 核我们代码）**：Paperclip 让组织"会运转"靠的不是数据表，而是每个角色 `AGENTS.md` 正文的**行为契约（charter）**（例：engineer 的 "同一心跳内开干、用 child issues 委派、blocked 必须标 unblock owner"；CEO "委派、协调、走 reportsTo 指挥链"）。**SuperClaw 当前三处全缺**：

1. `AgentProfile`（models.py:880）没有 persona/charter/instructions 字段；
2. `Issue.parent_id` 有字段，但 CLI/API（cli.py:3121）没暴露子任务委派入口；
3. `orchestrator`（orchestrator.py:258）只读 `agent_profile_id` 的 backend/budget，**没把 charter + `resolve_equipment` 装备 + reports_to 指挥链注入 run 的 prompt 与工具投影**。

→ **三件套是 Phase 2 P0 承重墙，优先于丰富 UI。**

### 3.1 `AgentProfile` charter 字段（采纳 Codex 更可审计的字段集）
```python
@dataclass
class AgentProfile:
    ...                                  # 现有字段
    persona: str = ""                    # 身份/语气
    charter: str = ""                    # 行为契约/职责边界（来自 AGENTS.md 正文）
    default_instructions: str = ""       # 角色默认指令
    charter_source: str = "manual"       # manual | template | imported
    charter_revision_id: str = field(default_factory=lambda: _id("charterrev"))
```
**不要塞进 `metadata`** —— 一等字段才能可读/可 diff/可注入/可审计（铁律要求）。

### 3.2 `team_kernel` 暴露委派
```python
def delegate_sub_issue(store, parent_id, *, assignee_agent_profile_id, title,
                       description="", requested_by=None) -> Issue:
    # 校验：parent 存在；assignee 存在；reports_to 链或平级协同策略允许 requester 向 assignee 派单
    # 生成子 Issue（parent_id 指向 parent），沿用单一 assignee + 状态机
```

### 3.3 CLI 入口（最小）
```bash
superclaw agent create-profile NAME ROLE --charter-file AGENTS.md --persona "..."
superclaw agent update-charter PROFILE_ID --charter-file AGENTS.md
superclaw issue create TITLE --parent PARENT_ISSUE_ID --assignee AGENT_ID
superclaw issue delegate PARENT_ID --title ... --assignee ...
```

### 3.4 orchestrator 注入（承重墙核心）
child run 的 `execution_context` 必须携带内核字段，prompt 只能引用这些字段，工具投影只能用 `resolve_equipment(profile).granted` 收窄：
```json
{
  "agent_profile_id": "agent_x",
  "agent_persona": "...", "agent_charter": "...", "agent_default_instructions": "...",
  "reports_to": "agent_ceo", "manager_chain": ["agent_ceo"],
  "equipment": { "requested": [...], "granted": [...], "dropped": [...] }
}
```
合成 system prompt = **内核治理法则（不可逾越）** + 身份/charter + 指挥链 + 已授权工具上下文。**装备永远不由前端或模板直接授予**，只能经治理投影收窄。

---

## 4. 实体补全（D）—— 三方裁决后的最小集

| 实体 | 裁决 | 理由 |
|---|---|---|
| `AgentProfile.charter/persona/default_instructions` | ✅ **P0** | 承重墙（§3） |
| `Issue.parent_id` 的 CLI/API 入口 | ✅ **P0** | 委派（字段已存在，补入口） |
| `CompanyProfile` | ✅ **P0**（三方一致） | 现 `company_profile_id="local"` 是硬编码占位，建公司向导无内核落点 |
| `WorkspaceProfile` | ✅ **P0/P1**（Codex+Claude，2:1 否决 Gemini） | **执行边界 ≠ 瞬时锁**：承载 `repo_path`/`writable_paths`/`network_policy`——正是 fail‑closed 网络扫描/支付门所需 |
| `Project` | ⏸ **推迟 P2+**（Codex+Claude 否决 Gemini 的 P1） | 已有 `GoalSpec` + `Issue.parent_id`，P0/P1 用 goal+issue 承载；待看板宏观分组需求出现再加，避免一口气引入 Paperclip 全层级 |

```python
CompanyProfile(company_profile_id, name, goal, owner_id,
               default_budget_seconds, allowed_plugins, high_risk_policies,
               created_at, metadata)

WorkspaceProfile(workspace_id, company_profile_id, name, repo_path,
                 writable_paths, default_permission_policy, network_policy, metadata)
```

---

## 5. 功能去留总表（C）

| Paperclip 功能 | 裁决 | 落地说明 |
|---|---|---|
| **OrgChart 树** | ✅ 直接拿 | `layoutTree/layoutForest` 纯递归布局 + pan/zoom/触屏可整段移植；数据换 GET `/api/team/inventory`，语义只读 `reports_to` |
| **Approvals 多态 payload 渲染器** | ✅ 直接拿（UI 模式） | payload 来源必须是 `Approval.requested_permission/affects/resume_action`；映射我们三态 issue_completion/permission_grant/budget_override |
| **IssueDetail 布局** | 🔧 改造拿 | 聊天 thread + 属性面板 + artifacts 区块可拿；**mutation 全回 `/api/team/*`** |
| **shadcn/radix 基元（tabs/sheet/command⌘K/dialog/skeleton/badge/avatar）** | ✅ 直接拿 | 纯 UI |
| **OnboardingWizard 4 步** | 🔧 改造拿 | 保留 4 步壳；Hire CEO → "创建 CEO proposal + 审批清单"，不自动批准（§6） |
| **AgentDetail 多 tab** | 🔧 改造拿 | 留 Configuration/Runs/Permissions/Activity/Skills + **新增 Charter 视图**；**砍 Billing**；Permissions 只显示内核授权 + dropped |
| **Costs 预算** | 🔧 改造拿 | 先做**观测 dashboard**（来自 run/evidence/backend summary 的 token/budget_seconds 燃烧），**不做硬停引擎**，**不用 USD** |
| **agentcompanies/v1 包格式 + AGENTS.md charter** | 🔧 改造拿（拿核心） | 公司=可移植声明式包；导入结果是 **proposal 不是授权事实**；charter 进 AgentProfile；复用插件签名信任链 |
| **teams‑catalog 预置** | 🔧 改造拿 | 模板播种走治理 diff（§7）；前端预置列表本质是提交不同 template_id |
| **CompanyExport/Import** | 🔧 改造拿（P2） | 导入必须生成 proposal + approval，不直接改 live |
| **Routines（cron/webhook）** | ❌ 砍/推迟 P3+ | 要例行用 OS crontab 调 `superclaw issue create`；内核有调度+审批门后再议 |
| **CompanyAccess 成员/邀请/RBAC** | ❌ 砍 | 单机单用户，Human 永远是 root |
| **Paperclip Secrets / InstanceSettings** | ❌ 砍 | 继续用 SuperClaw plugin secret/config + secrets_scan + `.env` |
| **adapter 抽象 / heartbeat 自治 / agent‑to‑agent 审批 / SaaS billing/quota / Postgres** | ❌ 坚决不进 Phase 2 | 平台运行假设，撞铁律 |
| **reports_to** | 🔧 仅可视化 + 指挥链 prompt 注入 | 不做 HR 绩效/权限继承/自动指挥执行语义 |

---

## 6. 建公司引导（E）—— proposal + 人审门，不自动批准

**SuperClaw 版 4 步**：① 公司名+目标 → 创建 `CompanyProfile` proposal；② 设计 CEO（backend/model/budget/charter/plugin allowlist）→ 只生成 profile proposal + 审批清单；③ 播种首个任务（root issue proposal，如"Hire first engineer and create execution plan"）；④ **Review & Commit**——展示 granted/dropped/pending/high‑risk diff，**用户审批后才写入** profile/issues/workspace。CEO **初始空装备、低预算、dry‑run**。

### `POST /api/team/bootstrap`（mode=proposal）
请求（节选）：`{ company{name,goal}, workspace{name,repo_path,writable_paths,network_policy}, ceo{name,role,backend_policy,budget_seconds,plugin_allowlist,persona,charter}, seed_issue{title,description}, mode:"proposal" }`

返回：
```json
{
  "proposal_id": "bootstrap_x",
  "would_create": { "company_profile": {}, "workspace_profile": {}, "agent_profiles": [], "issues": [] },
  "equipment_resolution": [
    { "profile_id": "pending_ceo", "requested": [], "granted": [], "dropped": [], "pending_approval": [] }
  ],
  "approvals_required": [
    { "type": "permission_grant",
      "reason": "write access / network scan / payment / high-risk plugin / budget raise",
      "requested_permission": {}, "affects": {},
      "resume_action": { "kernel": "team.bootstrap.commit", "proposal_id": "bootstrap_x" } }
  ],
  "blocked": false
}
```
**高危门（全部 fail‑closed，必须生成 approval）**：写权限、网络扫描、支付、浏览器登录态、secret access、预算上调、未签名/未授权插件、workspace 越界。

**UI 表现**：点"建公司"→ 生成蓝图 → "等待 CLI root 授权"界面；用户终端 `superclaw approve <proposal_id>` → 前端轮询/事件解锁 → 进 Dashboard。

---

## 7. 模板治理（F）—— teams‑catalog / 包导入的 fail‑closed

- **模板是 proposal，不是授权事实源。** 装备过 `resolve_equipment` 出 `granted/dropped/pending_approval`，运行只看 granted。
- 预算 `effective = min(template, company, agent, runtime)`，**只降不升**。
- **缺能力即拒**：模板要求的工具连 `available_plugins()` 都没有 → bootstrap **400 拒绝**（宁可建公司失败，不可建出"自以为有工具实则残废"的幻觉 Agent → 死循环）。
- 模板必须带 **digest/source/revision**，导入记 `template_source`，否则不可审计。
- `reports_to` 导入校验：**无环、manager 存在、跨 company 禁止**。
- charter **静态 policy lint**：不得声明"绕过审批/扩大工具/自动支付/自行批准"；失败只允许存草稿。

---

## 8. 前端丰富化（G）—— 拆巨石、零新增语义

现状：`apps/web` 是 `App.tsx` 单文件巨石 + 极简 `TeamWorkbench.tsx`。重构为 `apps/web/src/team/` 子模块：
```
team/
  api.ts            # 封装 /api/team/* 的 react-query hooks（唯一写入口）
  types.ts
  TeamWorkspace.tsx # 顶层：company/workspace selector + KPI + 命令面板
  BootstrapWizard.tsx   # 空 team 时的第一屏（移植 OnboardingWizard 4 步壳）
  OrgChart.tsx          # 移植 layoutTree/forest + pan/zoom
  AgentDetail.tsx       # Configuration/Runs/Permissions/Activity/Skills + Charter；砍 Billing
  IssueBoard.tsx / IssueDetail.tsx   # 看板 + 聊天式详情 drawer
  ApprovalInbox.tsx / ApprovalPayload.tsx  # 多态渲染器
  CostOverview.tsx      # 观测，不执法
  components/            # shadcn 式基元
```
**可整段移植"改皮"**：视觉结构、tabs/sheets/dialogs、OrgChart 树图、payload renderer、skeleton/loading、command palette。
**必须重写**：所有 mutation 只走 `/api/team/*`；不得把 Paperclip 的 hire/project/member/secret/routine 语义塞进 Web。
**两条铁底线**：① 前端**零新增语义**——不自己算"A 能不能管 B"，只读 `reports_to` 做显示；② 乐观更新可显示 "Pending/Submitting"，**绝不可乐观显示"已授权"**——授权类变更必须等 API 200。

---

## 9. 路线图（H）

2026-06-17 执行口径：本轮照抄的是 Paperclip 的组织设计与运转流水线，不照抄 Paperclip 的 SaaS 租户产品面。`CompanyProfile`/`WorkspaceProfile` 是本地治理命名空间和审计边界，不代表多租户登录、成员邀请或 RBAC 管理能力。

**P0 — 承重墙（先于 UI 大改）**
`CompanyProfile` + `WorkspaceProfile` 实体；`AgentProfile.persona/charter/default_instructions`；`issue create --parent` + `issue delegate`；**orchestrator profile 注入**（charter + equipment.granted + reports_to chain）；bootstrap proposal + approvals_required 列表；CLI/API/tests 同步。

**P1 — 建公司引导 + 组织可视化**
`POST /api/team/bootstrap`；BootstrapWizard；OrgChart；AgentDetail 基础 tabs；teams‑catalog 导入为 proposal；approval payload renderer。已实现补齐：`mode=commit` 会把 clean proposal 原子落地为 company/workspace/agents/seed issue；高危 proposal 先进入 pending approval，批准后经同一路径 resume。

**P2 — 丰富工单工作台**
IssueDetail 聊天式 thread；parent/subissue/blocking 只读关系；artifacts/plan/run transcript 聚合；Inbox blocked 分组；CostOverview 观测图；Company export/import（proposal）。已实现补齐：Team Workbench 的 bootstrap 已可真实 preview/commit，不再是禁用展示壳；board inbox 与 routines 的 API/CLI/Web 基础面已接入。

**P3 — 谨慎扩展**
routines（仅在内核有调度+审批门后）；更完整 `Project` 实体；更细 workspace policy；更完整审计流。

**坚决砍/推迟**：heartbeat 自治、adapter 抽象、多租户 auth、agent‑to‑agent 审批、预算硬停引擎、cron routines、Postgres。`reports_to` 只做可视化 + prompt 指挥链注入。

---

## 10. 三方分歧与裁决（留痕）

| 议题 | Claude | Codex | Gemini | 裁决 |
|---|---|---|---|---|
| 战略"完整拿" | 半对/分轴 | 半对/分轴 | 半对/分轴 | **一致：分轴** |
| 缺口 C 优先级 | P0 承重墙 | P0 承重墙 | P0 承重墙（100%） | **一致：P0** |
| charter 字段形态 | 一等字段 | persona/charter/default_instructions/source/rev | charter+system_prompt_template | **采 Codex 字段集**（更可审计） |
| `WorkspaceProfile` | 补 | **补**（边界≠锁，含 network_policy） | 不补（=OS 目录） | **补**（2:1，安全相关） |
| `Project` 实体 | 不补 | 推迟（用 Goal+Issue） | P1 补 | **推迟 P2+**（2:1） |
| Routines | 砍/推迟 | 砍/推迟 | 坚决砍（用 OS cron） | **砍/推迟 P3+** |
| Costs | 观测非执法 | 观测非执法 | 本地 token/秒非 USD | **一致：观测 dashboard** |
| bootstrap | proposal+人审 | proposal+approvals_required | pending_approval 锁屏+CLI 审批 | **一致：proposal+人审门** |

---

## 11. 决策记录（用户已拍板 2026-06-09）

- **本轮范围**：✅ **到规划为止**，暂不动手实现 P0（实现排期以后再说）。
- **P1 前端范围**：✅ **聚焦"建公司 + 组织可视化"闭环**（BootstrapWizard 4 步向导 + OrgChart 树）；**IssueDetail 聊天式详情 + 审批多态留 P2**。
- **bootstrap 审批粒度**：✅ **整单审批 + 高危权限逐条列出**（整个公司蓝图一个 approval，高危项 itemize；未来可拆为分项）。

仍待拍板（实现期再定）：
1. **charter 来源**：P0 是否支持 `--charter-file AGENTS.md` 直接吃 agentcompanies/v1 正文？（建议是）
2. **CEO 初始装备**：空装备 dry‑run vs 给只读 inventory 类安全装备让它能"看"以便规划？（建议：只读安全装备）
3. **合并时机**：Phase 1 + 本规划何时合并提交到 `feat/agent-team-kernel`。
