# Chat × Routine（定时任务）+ Goal（计划模式）—— 设计文档

> **⚠️ v4 架构定稿（2026-06-30，Codex gpt-5.5 桥选型对抗评审 + 业主拍板，覆盖 v2/v3 的「采纳上游 routine 引擎」实现路线）**
>
> **不再用上游 routine 引擎做 chat 定时任务。** Codex 裁决（已源码核实）：上游 routine 引擎的核心产物**就是** `routine_execution` 独立 issue（`routines.ts:1542`，源码禁改删不掉），永远变不成「在同一 chat 会话续聊」——拿它做 chat 定时任务从第一步就错配。镜像（A）/双执行（B）/disabled-routine 当存储（D）逐一否决。
>
> **定稿 = C'：Super 自持一等 chat automation，完全不碰上游 routine fire。**
> - **载体**：起 **`apps/gateway`**（Super 自己的 Node 前门服务，`feat/super-node-bff-p0` 的 L1 骨架，build-alongside Python `apps/api`，不改上游 `server/`、不新增 Python）当 ticker 的家。业主拍板。
> - **机制**：gateway 内一个最小 **schedule 存储 + Node ticker**（`setInterval`）。schedule = `{sessionIssueId, chatAgentId, prompt, cron, timezone, enabled, nextRunAt, lastFireKey, approvalState}`，恒挂 `LOCAL_CHAT_COMPANY_ID`。
> - **续聊 primitive**：到点 → 走 **chat turn 路径（`/api/chat/stream`：校验 session→追加 user comment→assign chat agent→`{issueId,commentId}` wakeup）** 把「任务 prompt」作为**同一 chat 会话的一条新 user turn** 注入 → agent 在**原线程**续聊。**不**直接戳 `/agents/:id/wakeup`（它非完整 chat-turn，需已有 comment + `{issueId,commentId}`）。无 routine_execution 泄漏、无双执行。
> - **idempotency**：fire key `chat-automation:${id}:${scheduledAt}`；重启 catch-up、单实例锁、失败重试、disabled 不 fire。
>
> **C' PR 计划（de-risk 优先）**：
> - **PR1 续聊 primitive de-risk（最高优先）—— ✅ 已验证通过（2026-06-30）**：用上游 vitest + 嵌入式 Postgres（`startEmbeddedPostgresTestDatabase`）写一次性 de-risk 测试（跑完即删，上游树字节不变，遵硬门2），实证 `appendUserTurn(db, chatIssueId, prompt)`（chat turn 路径的注入原语，`chat-compat.ts:294`）：① 注入的 turn 落在**同一 `originKind="chat"` issue 线程**（comment.issueId === chatIssueId）；② **创建 0 个 `routine_execution` issue**；③ 总 issue 仍只有那一个 chat 会话（无副线程）；④ **fail-closed**：对非 chat issue（manual / routine_execution）注入直接抛错——ticker 不可能泄漏进工作/routine 线程。**结论：C' 续聊 primitive 成立，整模型 GO。**（注：本 de-risk 证结构事实；活体 agent 回复走的是 chat 既有生产链路，本就 work。）
> - **PR2 起 apps/gateway + schedule/ticker**：landing gateway 进 dev/server-refactor；加 schedule 存储 + ticker + automation API。验：due exactly-once、重启不重复、disabled 不 fire、限 Personal Chat。
> - **PR3 composer 开关 + 侧栏徽标**：composer 勾选「设为定时任务」调 gateway automation API（**不**调 `/routines/.../triggers`）；侧栏 badge 从 automation 状态来。前端测试明确断言**不创建上游 enabled schedule trigger**。
> - **PR4 治理 fail-closed**：扫描/支付/外部写入类 prompt 进 pending approval，人审过才允许下次 tick。
>
> **已回退**：v2/v3 实现的 `chatRoutines.ts`（接上游 routine）+ ChatRoutinePanel + 'routine' tab + 测试 = Codex 判错路线（`:199` enabled trigger 会真建 routine_execution），已 `git checkout`/`rm` 清除，只留本设计文档。§4.5 company 隔离不变量在 C' 下不变（schedule 恒挂 Personal Chat、不碰真实公司）。
>
> 以下 v2/v3 正文保留作决策留痕（事实核实仍有效；「采纳上游 routine 引擎」实现路线已被 C' 取代）。

---

# Chat × Routine（定时任务）+ Goal（计划模式）—— 设计文档（v3 背景）

> **⚠️ v3 转向（2026-06-30 业主锁定产品模型，覆盖 v2 的 UI 形态）**：定时任务**不是**独立 Routines 面板/线程，而是**「会话即定时任务」**：
> 1. 在 chat composer 输入任务，勾选「设为定时任务」；
> 2. **当前这个 chat 会话**即被标记为自动化任务（或据此新建一个会话）；
> 3. 左侧侧栏对话列表给它一个**「自动化」徽标**；
> 4. 到点后 agent **在同一个 chat 会话里持续对话**（不另起线程）。
>
> **实现映射（复用已有 + 不改上游源码）**：
> - 「设为定时任务」= 给当前会话 issue 创建一个上游 routine（`parentIssueId` = 本会话），存 cron + 任务 prompt。
> - 侧栏徽标 = 会话列表项查「是否有绑定的 routine」。
> - 「在本会话续聊」= 一座**桥**：routine 到点 → 对本会话 issue 调 `heartbeat.wakeup(prompt)`（`server/server/src/services/chat-compat.ts:133` 已验证此 primitive 能程序化驱动 chat 会话 agent 续聊）→ agent 在**原线程**回复。**这座桥是本设计最难点**：上游 routine 默认到点新建 `routine_execution` 独立 issue（源码禁改），需 super 侧把「调度时钟」翻译成「chat 会话 wakeup」。
>
> **v2 的「独立 Routines tab」（PR1 已实现的 ChatRoutinePanel + 'routine' 会话 tab）= 废弃形态**：与业主模型不符。`chatRoutines.ts` bridge 层（list/create/run + Personal Chat 隔离）**复用**；UI 从「独立 tab」改为「composer 开关 + 侧栏徽标 + 会话内续聊」。
>
> **修订 PR 计划（v3）**：
> - **PR1'（桥可行性 + 会话绑定 bridge）**：扩 `chatRoutines.ts`：创建「绑定到某 chat 会话」的 routine（parentIssueId=session）；验证 routine 到点能否经 super 桥触发 `heartbeat.wakeup` 对该会话续聊（这是最高风险点，先 de-risk）。
> - **PR2'（composer 开关）**：composer 加「设为定时任务」+ cadence 输入；勾选→对当前会话创建绑定 routine。
> - **PR3'（侧栏徽标）**：会话列表项渲染「自动化」标识（查会话是否有绑定 routine）。
> - **PR4'（续聊桥 + 治理门）**：到点 wakeup 本会话 + 扫描/支付 fail-closed 人审（硬门2 下写前拦截）。
> - §4.5 company 体系隔离不变量**全程不变**（routine 仍挂 Personal Chat 公司、不碰真实公司）。
>
> 以下 v2 正文保留作背景（事实核实、隔离不变量、契约仍有效；仅「独立 tab」UI 形态被 v3 取代）。

---

# Chat × Routine（定时任务）+ Goal（计划模式）—— 设计文档 v2（背景，UI 形态已被 v3 取代）

> **⚠️ v2 转向（2026-06-30 业主裁定）**：v1 把 routine/goal 锚在 Python 内核（`goal_mode.py`/`team_routines.py`）当事实源——**踩反方向，作废**。业主明确：**Python 不再出现在任何新增功能里，只会慢慢被弃**。对齐 [[upstream-backend-adoption-posture]] 三桶分治：goal/routine/chat 控制面属桶 A，走 Node 上游底座。本设计全面改为 **Node-first**。
>
> 状态：设计草案（Codex gpt-5.5 一轮已并入并据 v2 转向重审；待 Gemini/agy 补评审 + 双 PASS 后升定稿）。
> 范围：**routine-first MVP**（业主裁定）——先把"chat 创建/关联定时任务并把生命周期投影回 chat"做出来，**采纳上游 Node routine 引擎**；**goal 的 codex 式生命周期引擎延后为独立项目**（见 §6）。
> 基线：`dev/server-refactor`（file:line 对齐该分支 tip，commit 漂移时以 grep 核验为准）。
> 关联：[[upstream-backend-adoption-posture]]、[[server-refactor-to-node-chat-compat]]、[[chat-webui-on-paperclip]]、`docs/goal-mode-design.md`（Python 版 codex goal，现降为 legacy/弃用候选）、记忆 [[routine-issue-materialization]]、[[goal-mode-multi-agent]]。

## 0. 一句话定位

> **chat 的"定时任务"= 从 chat 创建/关联一个受治理的后台 routine，采纳上游 Node 已有的生产级 cron 引擎；因为 chat 本身就是上游 issue+heartbeat 底座下「Personal Chat」公司里的一个 issue，routine 触发产生的执行 issue 天然落在同一底座、同一公司，生命周期自然回流进 chat——无需任何 Python 投影桥。super 只在前面叠一层 fail-closed 治理门（桶 C），不改上游源码、不新增 Python。goal 的 codex 式自主续航引擎延后单独立项。**

## 1. 业主诉求

1. chat 能"做成定时任务"——从 chat 创建一个按 cadence 自动跑的后台任务，产出回流进本 chat。
2. chat 能"做成 goal 模式"——codex 式 plan→确认→自主续航（**本期只做 MVP 占位，引擎延后**，见 §6）。
3. 认知锚：**Paperclip 的 goal ≠ codex 的 goal**——上游 goal 是无引擎静态 label；codex 式生命周期当前只在 Python，且 Python 待弃，故 codex goal 引擎需在 Node 侧重建（延后）。
4. **Python 不进新功能**：本设计零新增 Python；既有 Python `goal_mode.py`/`team_routines.py` 沦为 legacy，不扩、待弃。

## 2. 必守铁律（违反即否决）

- **铁律1（v2 重读）能力先进内核——但内核正迁 Node**：新业务能力落 Node 上游控制面（桶 A）+ super 治理层；**不得新增 Python**，不得扩 `goal_mode.py`/`team_routines.py`。
- **硬门2 上游源码绝不改动**（`server/` 树等于钉定 vendor commit）：routine/goal 能力只能**采纳上游 API** + 经 **adapter/plugin seam 或 super 前置治理层** 扩展，**禁止**改 `server/server/src/services/routines.ts` 等。
- **硬门1 只增不删 build-alongside**：新旧并存；收口旧 Python 路径需业主另行点头。
- **铁律2 CLI/APP 零偏差**：chat 创建的 routine 与 CLI/company 创建的，走同一上游控制面 + 同一治理门、同一错误码。
- **铁律3 契约单一源**：chat-origin 绑定、cadence 档位、治理门档位进契约（`ui_contracts.py` 仍可作 super 侧契约镜像，但**不新增 Python 业务逻辑**，仅声明）；表层禁硬编码。
- **桶 C 治理红线保留、禁被上游等价物替换**：扫描/探测/支付类 routine 一律 fail-closed + 人审 + 已批准权限；上游 routine 引擎**没有**这层，必须由 super 前置门补齐。
- **铁律6 runtime 联动 model+effort**：routine 指派 agent 处，model 走 runtime 联动响应式下拉；effort 仅 `supports_effort_selection` 真才显示；`default_effort` 绝不回填；切 runtime 重置。

## 3. 已核实事实（dev/server-refactor，grep 实证）

### 3A. 上游 Node routine = 生产级真引擎（采纳目标）
- 调度：`server/server/src/index.ts` 每 30s `setInterval`→`tickScheduledTriggers()`（`server/server/src/services/routines.ts`）；真 cron + IANA 时区、三触发器（schedule/webhook/api）、并发策略（coalesce/skip/always）、catch-up（cap 25）、乐观锁 CAS 防重复触发。
- 触发即物化 **linked issue**（`originKind=routine_execution`，`originId=routine.id`）→ 起 heartbeat run → issue thread 即 agent 对话上下文。
- REST：`server/server/src/routes/routines.ts` —— `/companies/:id/routines` CRUD、`/routines/:id/run`、`/routines/:id/triggers` 等。
- 绑定粒度：company（可选挂 project/goal）+ `assigneeAgentId`。

### 3B. chat = Personal Chat 公司下的 issue（关键：缺口①已天然解决）
- `server/server/src/services/chat-compat.ts:119` 定义 `LOCAL_CHAT_COMPANY_ID`（`:202` 自动创建 name="Personal Chat"）；chat 会话是该公司下 `originKind=CHAT_SESSION_ORIGIN_KIND` 的 issue（`:226/:249/:262`）。
- 故 **Codex 担心的"chat 缺 company/workspace/agent 映射"在 Node 侧不存在**——chat 本来就在一个真公司里。routine 绑到 Personal Chat 公司 + chat-origin 元数据即可落地，**无需新造 personal company/agent 映射**。
- 同底座：chat issue 与 routine_execution issue 都是同一公司下的 issue → **执行回流不分裂**（v1 §4.1 担心的 Python↔Node 双执行域问题随全 Node 消失）。

### 3C. 上游 goal = 纯 label（codex 引擎缺位 → 延后）
- `server/packages/db/src/schema/goals.ts` 仅 `goals` 表（id/title/status/level/parentId）+ CRUD（`server/server/src/routes/goals.ts`）。**零编排引擎**：无 scheduler、无 decompose、无 progress rollup、无状态机驱动。
- 故本期 goal **只用上游 label 语义**（在 chat 里标注/关联一个战略目标，routine 可挂 `goalId`）；codex 式 plan→确认→自主续航**不在本期**。

### 3D. 治理前置层现状
- 当前 super 前门是 `packages/superclaw/src/superclaw/node_front_door.py`（Python ASGI middleware，命中 Node 路由 fail-closed 不回落）。`apps/gateway`（[[super-node-gateway-p0]]）**未并入** dev/server-refactor tip。
- 上游 routine 引擎**自身无** super 的扫描/支付 fail-closed 门 → 治理必须前置在创建路径上（见 §4.4）。

## 4. 架构：routine-on-chat（全 Node）

### 4.1 数据底座
chat 会话 = Personal Chat 公司下的 chat issue（Node，已存在）。routine = 同公司下的一等 routine 记录（上游 schema）。两者经 `companyId` 同域。

### 4.2 创建路径（chat → 治理门 → 上游 routine API）
1. 用户在 chat composer 发起"挂定时任务"（MVP：结构化 affordance，非自然语言自动创建）。
2. 请求先过 **super 前置治理门**（§4.4）：解析 cadence、agent 指派（铁律6 联动）、风险分级；扫描/探测/支付类 → fail-closed 要求人审。
3. 门通过后，调**上游 Node routine API** 创建 routine：绑定 `companyId=LOCAL_CHAT_COMPANY_ID`、`assigneeAgentId`、`origin` 元数据（记 chat issue id），cadence→上游 trigger（schedule/cron）。
4. 返回**真实 readback**（schedule 状态 + 上游 scheduler 是否在跑），UI **不许乐观显示"已创建"**。

### 4.3 执行与回流（天然，无桥）
routine 到点 → 上游 `tickScheduledTriggers` 物化 `routine_execution` issue + heartbeat run（同 Personal Chat 公司）→ 该 issue/run 事件经既有 chat live-events（`subscribeCompanyLiveEvents` / SSE）就能投影进 chat 视图。**因 chat 与 routine 执行同底座，无需 v1 设计的 Python 幂等投影桥。** 需补的只是 chat 视图把"本会话 origin 的 routine 执行 issue"聚合展示。

### 4.4 治理叠加层（本设计最关键、且因硬门2 受约束）
上游源码禁改，故 super 的桶 C 治理**不能塞进 `routines.ts`**，只能前置：
- **方案 a（推荐）**：super 不直接放行 chat→上游 routine 创建；在 `node_front_door` 或一个 super 治理前门对 `POST /companies/:id/routines`（及 `/run`）做**写前拦截**：分级 + fail-closed + 人审票据，过审才转发上游。
- **方案 b**：走上游 `server/adapter-plugin.md` 的 adapter/plugin seam，在创建/触发 hook 上挂治理校验。
- 二者都不改上游源码。**待实现期与 Codex 论证选型**（涉及上游是否暴露可拦截的 create/dispatch hook）。

## 4.5 company 体系零影响（硬隔离不变量，业主第一约束）

> 业主明令"确保不影响 company 体系"——压在硬门1（绝不改既有可用逻辑，尤其 company 整套）+ 硬门2（上游源码禁改）上。本期 chat routine **必须**满足以下硬不变量，逐 PR 核验：

1. **chat routine 只挂 Personal Chat 系统公司**：`companyId` 恒为 `LOCAL_CHAT_COMPANY_ID`（`chat-compat.ts:119`），**绝不**写入任何真实业务公司；创建/列举/触发一律带此 company scope，越界即 fail-closed。
2. **Personal Chat 从所有 company 面显式过滤**：目录 / workbench / 成本汇总 / 审批 / 公司选择器等**任何面向用户的 company 视图**必须排除 `LOCAL_CHAT_COMPANY_ID`。今天靠"Python company 目录不读 Node `/api/companies`"偶然隔离；**本期立为显式不变量**——一旦 company 目录迁 Node 读上游 `companies.list`（`companies.ts:254` 不自过滤），过滤责任在 super 表层/前置层，不改上游源码。
3. **零碰 company 代码路径**：不改 `companies.ts`/`routines.ts`（硬门2）；不碰 Python `/api/team/*` 公司 routine 路径（其旧前端消费者 `TeamWorkbench.tsx` 已删除，由 `CompanyBoard` 取代）——chat routine 是**独立 chat 表层**，与公司看板互不引用。
4. **成本/预算不串**：Personal Chat 公司用自身（零/默认）预算；chat routine 的 cost 落 Personal Chat，**绝不**计入或扣减任何真实公司预算，不进 company 成本汇总。
5. **调度器共用但隔离**：上游 `tickScheduledTriggers` 是全局 tick（跨公司扫 due trigger，逐条 CAS），chat routine 与 company routine **不互相饿死/覆盖**；但 chat routine 数量受控（防 Personal Chat 下 routine 爆量给全局 tick 加压）。

**验收清单（每 PR 跑）**：① 列公司的端点结果**不含** Personal Chat；② company workbench/成本/审批视图**不出现** chat routine；③ `git diff` 不含 `server/`、不含 `companies.ts`/`team` company 路径；④ chat routine cost 不进任何真实公司账。

## 5. Codex 三个前置缺口 —— 按 v2（全 Node）重审

| Codex 缺口（v1，Python 语境） | v2（Node 语境）状态 |
|---|---|
| ① chat 缺 company/workspace/agent 映射 → "chat 专属 routine"是伪概念 | **已解决**：chat 本就在 Personal Chat 公司下（`chat-compat.ts:202`），routine 绑该公司即可 |
| ② Python cadence ≠ 完整 cron（无 IANA/webhook） | **已解决**：采纳上游引擎，本就有完整 cron/IANA/webhook/api |
| ③ scheduler 受门控，关了 UI 显示"已创建"却不跑 | **仍在**（换 Node 语境）：上游 scheduler 是 `index.ts` 的 setInterval（config `heartbeatSchedulerIntervalMs` 门控）；UI 必须 readback + 暴露 scheduler 在跑状态 |
| 附：goal confirm 须解析 workspace/repo 防错 cwd 回归 | goal 引擎延后，本期不涉及；留待 codex-goal-on-node 立项 |

净结论：**采纳上游引擎反而消解了 2/3 缺口**；剩一个（scheduler 状态可见性）+ 一个新增关键点（治理前置层 §4.4，因硬门2）。

## 6. Goal —— MVP 范围 + 延后项

- **本期（MVP）**：chat 里 goal 只用**上游 label 语义**——可在 chat 关联/创建一个上游 goal（CRUD），routine 可挂 `goalId` 表"此定时任务服务于某目标"。**不做** plan→确认→自主续航。
- **延后独立项目：codex-goal-on-node**。因上游 goal 无引擎、Python 待弃、上游源码禁改，codex 式 7 态生命周期 / 选兵确认 / 预算拨备 / 完成门 / 自主续航需**在 Node 侧作为新 adapter/plugin 重建**（参考 `docs/goal-mode-design.md` 的语义，但落点全改 Node）。单独立项、单独对抗验收。本设计不展开。

## 7. 落地路线图（routine-first，全 Node，最小增量）

> **复盘修正**：早先的 6-PR 是过度分解。底座（chat 链路 / 上游 routine 引擎 / Personal Chat 公司 / `/paperclip-api` 透传 / 现成 routines UI 模式）全已就绪且 web 已能够上游，真实增量是**"在现有基础上改"，~1-2 PR、几乎全前端接线**。
>
> **唯一不能踩的坑**：旧的 routines UI（已删除的 `TeamWorkbench.tsx` 里 `teamRoutinesPath()`→`/api/team/routines`）连的是 **Python 老引擎**。本期必须接 **上游 Node**（`/paperclip-api/companies/<id>/routines`），**绝不复用那条 Python 路径**（否则把待弃的 Python 又养大）。

- **PR1 chat routine（读 + 创建 + run once，最小可用）**：
  - 读：chat 表层加 routine 视图，调 `/paperclip-api/companies/<LOCAL_CHAT_COMPANY_ID>/routines` 列出 + 其最近 runs；执行 issue（`routine_execution`，同公司）经既有 chat SSE 天然回流，前端聚合显示。
  - 写：chat affordance 创建 routine（cadence→上游 trigger）+ `/routines/:id/run` 单次触发；铁律6 agent 指派联动；UI **readback schedule 真实态 + 暴露上游 scheduler 门控状态**（缺口③），**不许乐观显示"已创建/会跑"**。
  - 范围限**无害 cadence**（如周期总结）；高风险门留 PR2。
  - 测：调上游非 Python `/api/team/routines`；readback；执行 issue 回流进本 chat；Personal Chat 单公司下按 chat-origin 过滤不串味。
- **PR2 治理前置门（你自己的铁律）**：扫描/探测/支付/对外网络类 routine → fail-closed `requires_approval` + 人审票据单次消费；因硬门2（上游源码禁改）治理只能**写前拦截**（`node_front_door` 或 adapter seam，与 Codex 论证选型）。测：危险 routine 不自动 enable、人审过才放行。
- **PR3（可选）goal label MVP**：chat 关联/创建上游 label-goal + routine 挂 goalId 展示。（codex 自主续航引擎仍为独立延后项 codex-goal-on-node。）

每个 PR：接上游 Node 不碰 Python 老路径、build-alongside 不删旧、提交前 `git diff|grep -i paperclip` 去名自查、Codex+Gemini 双 PASS。

## 8. 治理门 / fail-closed 清单（逐 PR 核对）
- chat→上游 routine 创建/触发**必经 super 前置门**（硬门2 下治理不能进上游源码）。
- 扫描/探测/支付/对外网络类 routine → `requires_approval`，不自动 enable。
- 人审票据：双签单次消费（复用 escalation 范式 [[escalation-framework-p0d1]]）。
- UI 绝不乐观显示"已创建/会运行"；必须 readback schedule + scheduler 门控状态。
- 上游源码零改动；扩展只走前置门 / adapter seam；提交去名自查。

## 9. 待决 / 风险
- §4.4 治理前置选型：上游是否暴露可拦截的 create/dispatch hook（决定方案 a vs b）——实现期与 Codex 论证。
- chat 视图聚合"本 origin 的 routine 执行"：用 origin 元数据反查，还是用上游 issue 关系？需看上游 issue origin 字段能否承载 chat 回链。
- 上游 scheduler 门控（`heartbeatSchedulerIntervalMs`）在 super 桌面/打包形态下是否默认开、谁负责拉起——影响"创建了会不会真跑"。
- Personal Chat 单公司下 routine 数量/隔离：多 chat 会话共用一个公司，routine 如何按会话过滤展示而不串味。
- goal 引擎延后期间，chat 里 label-goal 的用户预期管理（别让用户以为是 codex 自主 goal）。

## 10. 评审留痕
- **Codex（gpt-5.5）一轮对抗评审**（v1 语境）：确认执行回流断点、routine 单一 SoT、goal 绑 chat 非"只差 UI"、3 前置缺口、MVP 渐进序。transcript：`.codex-cli-advisor/transcripts/chat-routine-goal.jsonl`。
- **v2 转向（业主 2026-06-30）**：Python 不进新功能、将弃 → 全面改 Node-first；routine 采纳上游引擎（消解缺口①②）；goal 引擎延后。Codex 评审的"治理前置""readback""人审渐进"结论在 v2 仍有效，已并入 §4.4/§7/§8。
- **待办**：Gemini/agy 按 v2（全 Node、硬门2 上游禁改、治理前置层）补一轮对抗评审；双 PASS 后升定稿，方可实现。
