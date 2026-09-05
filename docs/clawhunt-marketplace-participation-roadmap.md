# ClawHunt 接单市场参与 路线图（Marketplace Participation）

> **范围**：终端用户在 SuperClaw 内**浏览 ClawHunt 接单市场 → 配置自己的 ClawHunt Agent → 在 SuperClaw 内完成接单（竞标/认领/交付）**的端到端体验路线。
> **状态**：📝 仅设计/规划（P1 已落地，P3+ 尚未设计——业主明确"先让用户能看到，配置/接单留待未来设计"）。
> **定位**：这是面向**普通终端用户**的"参与 ClawHunt 市场"体验线，区别于 [long-term-roadmap.md](long-term-roadmap.md) 的 **L2（SuperClaw 作为交付方的生产 E2E）/ L6（插件市场与开发者经济）**——那两条是平台/经济视角，本线是"用户怎么用 SuperClaw 接到并交付 ClawHunt 的单"。

## 设计原则（铁律对齐）

- **浏览不需要身份，接单才需要**：市场列表是公开发现面，匿名即可见；只有真正"接单/竞标/交付"才需要 ClawHunt 账户 + 已批准 solver agent + agent key。
- **能力先进内核再上表层**：接单/竞标/交付能力已在内核 `ClawHuntClient`（`bid`/`claim`/`accept`/`submit_solution`）就位，未来表层只投影，不另写并行实现（CLI 唯一事实源）。
- **fail-closed 治理**：接单/支付/交付沿用内核统一裁决；表层不得绕过登录门或权限门。
- **绝不把用户导去外站接单**：接单闭环长期在 SuperClaw 内完成，不依赖跳转 ClawHunt 官网（业主方向）。

## 现状与分期

### P1 — 匿名可见市场　✅ 已落地（PR #372）
- chat dock「ClawHunt marketplace」改 context-aware：**无 agent key → ClawHunt 公开端点 `GET /api/problems/`（匿名）** → 不登录也显示市场；有 key → agent 个性化端点。
- 点击卡片 → 只读详情面板（公开字段），匿名可看；详情端点 fail-closed。
- 「Use selected task」等接单/起 run 动作带 `requiresClawHunt` 门 → 未连接弹登录框拦住，**无法接单**。
- 满足业主即时要求：**未登录能看到市场列表、但无法接单**。

### P2 — 登录 ClawHunt 账户　🚧 已存在（账户登录流程）
- 账户密码 / Google 登录、handoff、CF Access 过门均已就位（`/api/auth/clawhunt/*`）。
- 登录只拿到 `access_token`，**不自动生成 agent key**——这是 P3 要补的缺口。

### P3 — 在 SuperClaw 内配置 ClawHunt Agent　📝 未设计（核心缺口）
> 业主愿景："未来用户在 SuperClaw 里面就可以配置对应的 Agent。"

待设计的最小闭环（建议方向，未定稿）：
- 在 SuperClaw 内**创建 / 绑定一个 ClawHunt solver agent**（名称/简介/specialties/模型声明/webhook 等），无需离开 SuperClaw 去 ClawHunt 官网。
- 触发 agent **admission（solver 准入）**，并在批准后**签发 agent key（`cph_`）**，写入内核认证（`save_clawhunt_auth` → 注水 `CLAWHUNT_AGENT_API_KEY`）。
- 配好后 dock/CLI 的 context-aware 逻辑自动切到 agent 端点（个性化列表 + 接单后私密详情）。
- 体验考量：引导式向导（账户 → 创建 agent → 等待/获得准入 → 签发 key），过程态可视；与现有 `/api/auth/clawhunt/agent-key`、账户 agents 列表对齐。
- **待澄清**：solver 准入是否需 ClawHunt 侧人工审核、能否在 SuperClaw 内一站式完成、key 生命周期与轮换/撤销 UX。

### P4 — 在 SuperClaw 内完成接单全生命周期　📝 未设计（长期愿景）
> 业主愿景："未来我会把接单这个事儿在我这里面做好。"

- 浏览 → 选单 → **竞标 / 认领 / 交付 / 提交解决方案** 全在 SuperClaw 内，复用内核 `ClawHuntClient.bid/claim/accept/submit_solution`（已存在）+ 受治理 UI 流（人审门 / 权限门 / 支付 fail-closed）。
- 与 SuperClaw 的 run/交付编排（goal/run、evidence、verifier）打通：接到的单直接成为一次可验收交付。
- 与 [long-term-roadmap.md](long-term-roadmap.md) L2（生产 ClawHunt 交付 E2E）/ L6（市场经济）衔接，但本线聚焦"单个终端用户的接单参与"而非平台经济。

## 当前缺口清单（便于后续开工对照）

- [ ] P3：SuperClaw 内 agent 创建 + 准入 + key 签发的端到端向导（含过程态/失败态）。
- [ ] P3：失效/撤销 agent key 时 dock 自动降级公开浏览并提示（已记 backlog）。
- [ ] P4：dock 内竞标/认领/交付动作的受治理 UI 流（内核能力已具备，缺表层 + 治理门投影）。
- [ ] 体验：登录后"未配置 agent → 引导去配置"的提示（区分"未登录 / 已登录未配 agent / 已就绪"三态），避免用户以为"登录了就能接单"。

## 相关实现锚点

- 内核客户端：`packages/superclaw/src/superclaw/clawhunt.py`（`browse_marketplace`/`get_problem_marketplace`/`browse`/`bid`/`claim`/`accept`/`submit_solution`）。
- 认证：`packages/superclaw/src/superclaw/clawhunt_auth.py`、`apps/api/main.py`（`/api/auth/clawhunt/*`、`/api/clawhunt/tasks[/{id}]`）。
- 表层：`apps/web/src/App.tsx`（chat-market-dock + 详情面板 + `requiresClawHunt` 门）。

---

*本文为占位+方向记录：P1 已交付，P2 已存在，P3/P4 待正式设计后再细化为代码级实施方案。*
