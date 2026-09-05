# Skill 双轨衔接 —— 设计交接（Track A 授权 ↔ Track B 可调用投影）

> **状态**：设计已定稿，待落地。本文是给 `feat/skill-flow-hardening`（Track B owner）
> 与后续整合者的交接规格，已经 Codex (gpt-5.5) + Antigravity (Gemini 3.1 Pro)
> 对抗式评审收敛。**落地分两段**：① Track B 落地时预留整合钩子；② Track B 合进
> `main` 后，由 orchestrator/team 域做一个干净的整合 PR。

## 0. 一句话

company / routine agent 配的 skill 现在**只进 prompt 文本、不可调用**（Track A）；
chat `@skill` 的 skill 走 run-scoped 投影、真可调用（Track B）。本设计把两轨接上：
**team-bound run 把 `equipment.skills.granted`（per-agent ∩ per-fire routine.context）
经一个 capability-aware 规划 choke point 投影成 `WorkerLimits.skill_ids`**，复用
Track B 既有的 run-scoped 投影 + fail-closed，让授权 skill 真生效，并使 per-fire
`routine.context` 收窄从「仅 prompt」变成「真收窄可调用范围」。

## 1. 两条轨（现状，已核对代码）

### Track A — per-agent/per-routine 授权（已在 `main`）
- `AgentProfile.skill_allowlist` → `team_kernel.resolve_equipment` 求
  `skills_granted = skill_allowlist ∩ available_skill_ids` → 写进
  `agent_run_context.equipment.skills.granted`。
- routine per-fire `routine.context.skill_ids`（PR #413/#414）运行期再 `∩` 收窄
  （`build_agent_run_context(issue_skill_constraint=)`）。
- **唯一消费点是 `agent_prompt.py`**（prompt 里 `Skills: x,y`）——不进任何可调用面。

### Track B — 可调用投影（`feat/skill-flow-hardening`，部分已并入 main）
- `skill_runtime.py` = **run-scoped 单 turn 解析 + 投影**：`SkillRunPlan` + `plan_skill_run`。
  - **prose skill**（`skill_store` 的 SKILL.md）→ 投影进 backend 的 run-scoped skill 目录
    （staging → digest 校验 → 两阶段 publish/rollback），model 原生可见。
  - **tool-skill**（`skill_build` 的 `skill_origin` plugin，`skill.<slug>`）→ 走注入的
    MCP server。
- `BackendSkillCapability`：MCP backend（claude/codex 家族）= prose + tool；非 MCP
  （ClawWork）= 仅 prose，tool-skill **fail-closed 拒跑**，绝不静默降级。
- 入口 = `WorkerLimits.skill_ids`（per-run）。`_skill_overlay_guard` fail-closed：本
  turn 任一 @skill 不可服务 → 拒整个 run。
- **关键现状**：`WorkerLimits.skill_ids` 只被 chat `@skill` 路径填（`chat_turn` /
  `apps/api/main`）；**team / company / routine 路径完全不填**。这是断点。

## 2. 已核实的命门

### 命名空间断层
`team_kernel.available_skill_ids()` 的全集 = **仅 gate-passing 的 `skill_origin`
plugin**（tool-skill），**不含 native prose skill（`skill_store`）**。而 `skill_runtime`
两类都解析（裸 slug 先查 prose，再 fallback `skill.<slug>`；带 `.` 按 plugin id）。

→ 直接把 `equipment.skills.granted` 喂进 `skill_ids` 只能送 **tool-skill**，接不上
prose。且 tool-skill 本就是 plugin，已可走 `plugin_allowlist`→MCP 这条**已生效**的轨，
塞进 skill 轨会变成同一 capability 的双重授权。

### backend 覆盖未闭合（Codex 实测）
今天 `WorkerLimits.skill_ids` 的**唯一真实消费者只有 ClawWork** 的 run-scoped 投影；
codex/claude direct chat 对 `@skill` 明确返回 unsupported。所以「喂 skill_ids 就
callable」对 claude/codex **现在不成立**。

## 3. 衔接设计（Codex + AGY 收敛裁决）

### 收口点
**在 orchestrator 选完 backend、构造 `WorkerLimits` 之前**做 capability-aware 规划
（不是在 `build_agent_run_context` 里——那只是 profile/equipment 解析层，拿不到
backend）。产出一个 `SkillRunPlan`，由它**同时**驱动：(a) `WorkerLimits.skill_ids` /
投影；(b) prompt 里 served/unavailable 的描述。

### 决策 1：fail-closed 按来源分治（两顾问独立得出同一结论）
- **来源 = agent profile `skill_allowlist`（能力池/ambient grant）**：遇 backend 不支持
  → **优雅丢弃 + 计入 `equipment.dropped` 审计 + 其余继续 run**。不能因为某 tool-skill
  落在非 MCP backend 就拒掉整个 fire（会把大量现有 team run 变成假性阻断）。
- **来源 = routine `routine.context.skill_ids`（任务硬约束，#414）**：遇不可服务
  → **严格 fail-closed，拒掉整个 fire**（硬依赖缺失会致死循环/脏数据）。抛
  `RoutineConstraintError`，并由 daemon 精确捕获 → 工单转 BLOCKED/FAILED，剥出重试循环
  （**不能**让它被当瞬态错无限 backoff 重试 = 毒丸）。

### 决策 2：prompt 交出渲染权（单一真相源）
- **删掉 `agent_prompt.py` 里直接打印 `skills.granted` 的逻辑**。Track A 只算权限，
  不管渲染。
- 由 `SkillRunPlan`（已做完 backend 降级 + 投影）反向提供 `render_active_skills()`，
  在组装 system prompt 时调用 → prompt 只声称**真生效**的 skill。否则 prompt 说有、
  runtime 没投 = 幻觉/契约漂移（违反 equipment.dropped 的诚实律）。

### 决策 3：命名空间 — 统一 resolver + 两轨分流
- 抽出**统一的 `resolve_skill_ids()`**，让 Track A 求 `granted ∩` 与 Track B 解析同源
  （否则静默漏权/匹配失败）。
- **分流**：native prose skill 走 skill 轨；tool-skill / `skill_origin` plugin 走
  **plugin 轨**（继续 `plugin_allowlist`→MCP proxy），不在 skill 轨再造并行授权。
  物理投影层去重合流：`run_mcp_whitelist = plugins.granted ∪ (skill_ids 里的 tool-skill)`。
  UI 可统一叫「Skills」，但授权面不混。
- **隐含决定**：要让 company/routine agent 真正 per-agent 地拿 **prose** skill，
  Track A 需要一个 **prose-skill 授权维度**（现状 `skill_allowlist` 实为
  tool-skill allowlist）。建议：明确语义，或新增 prose 维度。

### 决策 4：作用域逃逸加固（高危）
- run-scoped 方向对，但必须 **显式屏蔽/覆盖全局 skill 路径**（`~/.claude/skills`、
  CLI 默认域），否则 model 原生 loader 仍能扫到未授权全局 skill。
- tool-skill 的 MCP 必须 **run-scoped 受限实例**；MCP router 硬校验：不在本 run 最终
  whitelist 的 plugin/tool-skill 调用，直接拒（401）。绝不塞全局 all-plugin MCP 赌
  model 不调。
- 投影目录拒 symlink、整包 staging + digest 校验（Track B 已具备，保持）。

### 决策 5（借 Paperclip）：非原生 backend 的 cwd 相对 staging 兜底
对照 Paperclip（`third_party/open-design/apps/daemon/src/cwd-aliases.ts`）：它每 turn
把 active skill **拷进 cwd 的 `.od-skills/<id>/`**（per-project 私有拷贝 +
`dereference:true`，**明确否决 symlink**，防写放大），preamble 同时广告 cwd 相对路径
（主）+ 绝对路径（兜底），「staging 成不成 agent 都能用」。**这正是 backend 覆盖未闭合
的答案**：

- 对**有原生 skill 发现**的 backend → 走 Track B 原生投影（干净）。
- 对**没有原生发现**的 backend（claude/codex/gemini 当前）→ **不要 fail-closed 拒跑或
  静默无效**，而是学 Paperclip：把 prose skill 拷进 **run-scoped 的 cwd 相对目录**
  （私有拷贝 + dereference，拒 symlink）+ 在 prompt preamble 广告路径。
- 两条都 run-scoped、都按 grant 收窄、都不碰全局。

→ 把「fail-closed 拒整 run / 静默无效」换成「**分级投影：能原生就原生，不能就 cwd
兜底，永远 callable**」。注意：cwd 拷贝必须落在**已 gitignore** 的位置，且与源写隔离
（拷贝 + dereference，绝不 symlink 回 live 资源）。

### 决策 6（借 Paperclip）：prose-skill 内容 scanner
tool-skill 有签名/trust-chain，但 prose `SKILL.md` 照样能藏 prompt injection / exfil
指令。Paperclip 有内置 scanner；本架构当前缺。建议在 prose skill **注册/装备**时加一道
内容扫描（prompt-injection / 数据外泄模式），作为 prose 轨的准入门（与 tool 轨的签名门
并列）。列为可独立推进的安全增强。

### 决策 7：catalog 作用域
`available_skill_catalog`（autotrigger 名录）必须 `∩` 本 run 最终 `skill_ids`，绝不列
未授权 skill（否则诱导 model 调用 → 被 fail-closed 拒，白瞎 token/turn，或信息泄露）。

## 4. 落地清单（顺序，两顾问收敛 + 主代理裁定）

> 段 ①（Track B owner，落地前焊钩子）：

1. **统一 ID resolver**：抽 `resolve_skill_ids()`，Track A `team_kernel` 与 Track B
   `skill_runtime` 同源解析。
2. **定语义**：明确 `skill_allowlist` 是 tool-skill id（现实）还是新增 prose 维度。
3. **规划 choke point**：在 orchestrator 选完 backend、建 `WorkerLimits` 之前产出
   `SkillRunPlan`（capability-aware）；为 team 路径预留 skill_ids 入口。
4. **分级投影**：原生 backend → 原生投影；非原生 → cwd 相对 staging 兜底（决策 5）。
5. **MCP router 白名单硬校验** + 清全局 skill path 环境变量（决策 4）。

> 段 ②（Track B 合进 main 后，orchestrator/team 域整合 PR）：

6. **桥接**：team-bound run `WorkerLimits.skill_ids = SkillRunPlan(equipment.skills.granted)`。
7. **分治 fail-closed**：agent grant → 优雅丢 + 审计；routine 约束 → 拒整 fire
   （`RoutineConstraintError` + daemon 精确捕获转 BLOCKED，不重试）。
8. **收敛 prompt**：删 `agent_prompt.py` 硬编码，改 `SkillRunPlan.render_active_skills()`。
9. **catalog `∩`**：autotrigger 名录 = `all_catalog ∩ final_run_skill_ids`。

## 5. 验收要求（落地时）

- 每段走 Codex + Antigravity 双向对抗验收（缺一不可）。
- 本地全量门（远端 CI 暂停期）：两阶段 `pytest` + ruff + doctor + health。
- 对抗用例必须覆盖：① 授权 tool-skill 落非 MCP backend → 优雅丢 + dropped 审计（不拒
  run）；② routine 硬约束 skill 不可服务 → 拒 fire + 不重试；③ prompt 只列真生效 skill
  （drift 用例）；④ 未授权 skill 的 MCP 调用被 router 拒（提权用例）；⑤ 全局
  `~/.claude/skills` 不泄漏进 run（作用域逃逸用例）。

## 6. 对照 Paperclip 的取舍小结

| 维度 | Paperclip | 本架构 | 取向 |
|---|---|---|---|
| 隔离位置 | cwd 内 `.od-skills/`（私有拷贝 + dereference，拒 symlink） | run-scoped、cwd 外、0700、每 run 清 | 本架构更净；**借其 cwd 兜底补非原生 backend** |
| 可移植性 | cwd 相对路径，任何 runtime 可读 | 原生发现，backend 覆盖有限 | **借 Paperclip 兜底闭合** |
| 执行型治理 | 拷贝防写放大 + scanner | tool-skill 签名/trust-chain + MCP proxy | 本架构更强；**借其 prose scanner** |
| 授权粒度 | per-turn active skill | per-agent grant + per-fire routine.context | 本架构更细（待接缝生效） |
| 失败哲学 | 优雅降级（兜底路径） | fail-closed | **分治：ambient 优雅 / 硬约束严格** |

**结论**：设计深度本架构更扎实（run-scoped 隔离、密码学供应链、双轨、细粒度 grant、
fail-closed）；落地完成度与跨 runtime 务实性 Paperclip 更优。最优解 = 本架构骨架 +
吸收 Paperclip 的「cwd 相对 staging 兜底」与「prose scanner」两招。
