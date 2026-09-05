# Canvas Mission Control —— 无限画布多公司指挥台（设计 v1）

> **状态**：设计定稿 + P0 实现中（分支 `feat/canvas-mission-control`，stacked on `feat/fleet-canvas`）。
> **业主愿景（2026-07-08 拍板开工）**：一个 agent 下面可以开无数个 agent 互相工作；一个大组 = company，可以有 A/B/C/D/E 多家公司合作分工；用无限画布展示；每条对话触发 company 构建；SuperClaw lead 一个任务后自动规划成多条线、自己找需要的 company 对齐、多 agent 推进落地；画布上建立每家 company 的人设与分工。
> **前置审计（2026-07-08，5-agent 工作流 + 契约对抗校验）**：见 §2。

---

## 1. 一句话

把已有的 Fleet Canvas 原型（`apps/fleet-canvas`，无限画布公司指挥台）从「模拟世界 + 退役 Python 规划」升级为 **SuperClaw Node 内核的真实投影 + gateway 任务编排**：画布永远只是投影，事实源永远在内核，全部 mutation 走既有治理门。

## 2. 背景与审计结论（为什么是这个方案）

### 2.1 双库审计（2026-07-08）

- **myshell-studio-orchestrator (dev)**：活跃但 7 月 4 日硬转向 —— 自研 Studio 无限画布（1462 行 canvasWorkspace + 423 行 canvasGraph）被移出 UI，只剩第三方 AI-CanvasPro iframe。它的 SuperClaw 桥（`/api/studio/superclaw`，11 路由）经逐条对照校验 **17 项假设 14 MATCHES / 3 PARTIAL**，但 runs 面完全押在**退役中的 Python FastAPI**（`/api/goals`、`/api/runs`、SSE）。Python cockpit 退役即断。
- **SuperClaw Node 内核**（vendored `server/`）：已是完整多公司编排内核 —— companies → agents（`reportsTo` 组织树）→ issues（`requestDepth` 委派树）→ heartbeat_runs（adapter 拉起 runtime CLI）；招聘经 `agents:create` + `hire_agent` 审批门；teams catalog 一键装整队；五层调度（routines/cron、进程内 scheduler tick、issue monitors、plugin jobs、gateway chat automations）。**Node 侧没有** `/api/goals`、`/api/runs`、SSE run events（只有 heartbeat-runs JSON 轮询 + WebSocket live events）。
- **apps/web**：无任何画布/节点图 UI；公司数据读路径已迁 `/paperclip-api` → Node 控制面（`paperclipBridge.ts`，fail-soft）。

### 2.2 fleet-canvas 原型现状（本方案的接续基础）

`feat/fleet-canvas`（5 commits，~5100 行）已交付：无限画布（pan/zoom/拖拽/小地图/播放控制）、五家**模拟**常设公司 A–E（人设/分工/mandate）、本地规划器 + 四拓扑、现场组建特遣公司、跨任务 agent 抢占（load 均衡）、活动流叙事、嵌入 apps/web 为 `fleet-canvas` workspace surface。内核集成点只有两处、且都指向**退役 Python**：`/api/goals/plan`（规划）与 `/api/goals/{id}/confirm`（确认执行）。执行本体是模拟（诚实标注）。

### 2.3 结论

愿景的 70% 地基（多公司/招聘/委派/治理/调度）在 Node 内核已存在；缺的是 ① 画布接真实世界（投影），② SuperClaw-lead 的跨公司任务编排（gateway），③ 对话触发公司构建的 fail-closed 提案流，④ 跨公司协作原语。fleet-canvas 提供了现成的画布壳。**方案 = 接续 fleet-canvas，逐相位把模拟件替换成内核真实投影，绝不在退役 Python 上加新依赖。**

## 3. 不变量（治理对齐，全相位有效）

1. **画布 = 投影，内核 = 事实源**。画布不自己算业务、不持久化公司状态；本地只留视图态（位置/缩放/选中）。
2. **零治理旁路**：全部 mutation 走既有 Node 端点与审批门（`POST /companies`、`agent-hires` + `hire_agent` approval、issues、approvals）。画布绝不直写 DB、绝不新开侧门。招聘/建司类动作在画布上只能以「提案 → pending → 人审批准」呈现（fail-closed，同内核哲学）。
3. **诚实呈现**：模拟执行与真实内核状态永远可区分（UI 标注）；连接失败显示离线并回退，绝不假成功。
4. **落点纪律**：H 宿主层（`apps/fleet-canvas`、`apps/web`）+ `apps/gateway`（Super 自有 Node 服务，chat-automation 同款落点）。**零 `server/` C-layer 改动；零新增 Python**；不在退役 Python `/api/goals`/`/api/runs` 上新建能力（现存两处集成点在 P1 迁移）。
5. **命名去 paperclip**：新代码一律 SuperClaw/中性词；`/paperclip-api` 代理前缀与 `paperclipBridge.ts` 属既有宿主层标识符（对接上游的事实性引用），沿用不新造。

## 4. 相位路线

### P0 —— 真实世界投影（本 PR 系列，零服务端改动）

画布新增「真实公司世界」：从 Node 控制面拉真实 companies + agents + live-runs，映射成画布公司卡。

**数据契约**（全部既有端点，经 `/paperclip-api` 同源代理；desktop 由 Python front door 按同一 `node_routes.json` 转发）：

| 用途 | 端点 | 映射 |
|---|---|---|
| 公司列表 | `GET /companies` | → 画布 Company（人设卡：名称/编制/状态） |
| 公司编制 | `GET /companies/{id}/agents` | → 画布 Agent（name/title/role 启发式映射到五角色；terminated 过滤；卡面 roster 截前 8） |
| 实时脉冲 | `GET /companies/{id}/live-runs` | → 卡面「运行中 ×N」徽标（status ∈ queued/running），轮询 ~5s |

**实现要点**：
- 新引擎模块 `apps/fleet-canvas/src/engine/liveWorld.ts`：fail-soft（超时/非 2xx → null，调用方保留 last-known 并亮离线），角色启发式（role/title 关键词 → explore/plan/implement/verify/review，默认 implement），accent/glyph 由 id 确定性派生，环形布点。
- `Composer` 增加世界源切换（演示世界 A–E ↔ 真实公司世界）；切换即重置任务（两个世界的 agent id 空间不同，不跨界引用）。
- 任务对齐（alignPlan）在真实世界照常工作（strengths = 该公司 agents 映射角色的并集）；**执行仍为模拟**并如实标注 —— 真实执行是 P1 的事。
- `embed.tsx` 接受 `nodeApiBase`；apps/web 传 `paperclipApiBase()`（复用 desktop `__SUPERCLAW_PY_ORIGIN__` 机制）；standalone vite 加 `/paperclip-api → :3100/api` 代理。
- 测试：投影纯函数（角色映射/公司映射/过滤/聚合/fail-soft）进 `apps/web/tests/fleet-canvas-live-world.test.ts`（挂进 apps/web vitest 清单）。

### P1 —— Mission 规划编排（SuperClaw-as-lead，落 apps/gateway）✅ 已交付（P1a+P1b）

**P1a — gateway mission API（只读规划 + 真实公司能力匹配）**：`apps/gateway/src/mission/`。`POST /api/missions/plan {prompt, topology}` → 确定性 planner 拆 5 角色 track（4 拓扑，与画布 1:1）→ upstream-reader 读真实 companies/agents 派生能力 → matcher 按能力把每 track 匹配到最合适公司（负载均衡 + 确定性），无覆盖角色进 `unmatchedRoles`（P2 提案 seam）。**只读**（不建 issue/run/company）；fail-closed 治理同 automation（loopback + control token）；对齐 vendored server 真实词表（agent 可用性 = 非 paused/pending/terminated，默认 idle 计入；公司排除 paused/archived；单公司名册读失败→`unreadableCompanies` 且不谎报 `fullyMatched`）。34 测试；Codex 两轮验收通过。

**P1b — 画布迁移，去 Python `/api/goals`**：删 `engine/kernel.ts`（`checkKernel`/`planViaKernel`/`confirmGoal`/`getGoalRecord`）+ `executeMission` + Mission 的 kernel* 字段。「接入内核」→「接入 SuperClaw 规划」经 `engine/mission.ts` → `/gateway-api/missions/plan`；网关的 company 匹配作为「内核对齐」叙事呈现。响应 shape fail-fast（topology 漂移回退请求值、畸形 track 抛错→回退本地）。standalone vite 去 `/api→:8765`(Python)、加 `/gateway-api→:8796`；embed 增 `gatewayApiBase`（apps/web 传，token 由 proxy 注入）。10 mission 测试；Codex 两轮验收通过；浏览器实测网关规划+真实公司对齐（暂停 agent 正确不计入）与离线回退。

**留作 P2 的执行落地**：把已规划+已对齐的 mission 真正交给 agent（确认 + 驱动 heartbeat-run、走审批门）——本 P1 只做规划+匹配（只读），执行明确留 P2，画布内推进为诚实标注的模拟。gateway 的 `unmatchedRoles` 是 P2「提案新公司」的 seam。

### P2 —— 对话触发公司构建（fail-closed）

chat / 画布 composer 一句话 → mission 规划 → 画布出现「公司提案卡」（pending 态，含拟定人设/编制/分工）→ 用户画布上批准 → 才调 `POST /companies` + `agent-hires`（后者天然走 `hire_agent` 审批）。规划自动、落地过人审门，与内核招聘哲学同构。

**P2a — 提案生成 + 提案卡（只读）✅ 已交付**：`apps/gateway/src/mission/proposal.ts` 的 `proposeCompany(unmatchedRoles)` —— mission 有覆盖缺口时，SuperClaw 提议组建一家新公司（persona name/mandate + 每缺口角色一名 roster agent），进 `MissionPlanResult.proposal`（仅当有缺口）。画布 `engine/mission.ts` 透传（`mapProposal` 防御式映射），存到 `Mission.proposal`，Inspector 渲染「公司提案 · 待批准」卡（缺口角色 + 拟定 persona + roster + 诚实说明「批准前不创建任何东西」）+ 活动叙事。**纯只读、零 mutation**。gateway 46 测试 + 画布 mapProposal 测试；Codex 验收；浏览器实测（verify 缺口→提案「特遣补位队（验证）」卡）。

**P2b — 批准 → 真实创建（mutation，未做，下一步）**：提案卡加「批准」→ 真正 `POST /companies`（建司，`{name}` 即可）+ 逐 roster `POST /companies/:id/agent-hires`（招人，走内核 `hire_agent` 审批门）。**注意**：招人需 `adapterType`（runtime），触发 runtime/model/effort 联动选择器铁律（见 `CLAUDE.md`），属治理敏感面，需专门处理。这是首个真实 mutation 相位。

### P3 —— 画布三能力：模块互链 · 运行可见 · 单模块对话

> **业主 2026-07-09 追加需求**：无限画布上「① 模块之间能互相链接；② 每个模块运行中 + 运行结束后的东西都能看见；③ 每个模块能单独对话」。
> **前置审计（2026-07-09，6-agent 工作流：5 路只读调研 + 1 完整性/矛盾审查）**：三能力的近期子相位**全部零 `server/` 改动**——运行可见所需端点在 Node 控制面已全部存在（经 `/paperclip-api` 前门）；单模块对话复用 `/api/chat/stream` + RuntimePicker（契约单一源）；annotational 互链纯前端。真正触碰 vendored `server/` 的（真实 per-agent 会话、真实跨公司委派、按公司列会话历史）拆到 deferred，需业主定边界 + 双顾问。

**能力边界（画布内渲染 vs apps/web 富交互 vs 后端）**：

| 能力 | 画布内 | apps/web 宿主 | 后端 |
|---|---|---|---|
| ① 模块互链（annotational） | 连线渲染（复用 `companyAnchor`/`bezierPath` + SVG 边层）+ 拖拽建链 + 按 world 剪枝孤儿 | 极薄（localStorage 持久化） | 无（server 无公司关系端点，铁律禁新增） |
| ② 运行可见 | live-run 富投影（fail-soft）+ 卡面脉冲 + Inspector run 列表 | run-detail/交付物面板（HireRosterDialog 同款 target-state） | **零新增**——`live-runs`/`heartbeat-runs/:id/log,events`/`companies/:id/artifacts` 已存在 |
| ③ 单模块对话 | 「💬 对话」按钮 + `onOpenChat` 意图（仅 live 世界，绝不在画布内放 runtime 选择器） | `CompanyChatPanel`：复用 RuntimePicker + `streamChatTurn` | 复用 `/api/chat/stream`（company 维度），fail-closed 由 `chat.ts` 兜底 |

**子相位（每个 = 一次可交付 + 单顾问对抗验收 + 原子提交，粒度同 P2a/b/c）**：

- **P3a —— 运行中可见（company-scoped run 投影，零 server）✅ 本相位**：`liveWorld.ts` 用 `fetchLiveRunSnapshots` 替换 `fetchLiveRunCounts`（保留 fail-soft/reachability：全失败→null=offline、单公司失败→omit key 保留 last-known），新增 `projectLiveRuns`（防御式投影 real 字段：status/agentName/adapterType/currentStatusMessage/livenessState/lastOutputAt，时间戳兼容 epoch+ISO，无 id 行丢弃、缺字段留 null 绝不编造）。卡面脉冲徽标 = 数组长度（FleetCanvas 接口不变，App 派生 counts memo）。Inspector `CompanyPanel` 新增「运行中 · Live runs」列表（status/agent·adapter/statusMessage/liveness/输出 age），仅 `company.live && !offline` 时渲染，空则「当前没有排队/运行中的 run」。**离线诚实**：offline → `companyLiveRuns=undefined` → 整段隐藏 + 徽标清零，绝不留 stale/假 run。28 投影测试；fleet-canvas tsc+build 绿；apps/web 全量 42 文件 499 绿；浏览器 E2E 四态实测（富渲染 / 缺字段省略 / 空态 / 离线隐藏）。
- **P3b —— 运行结束可见（apps/web run-detail/交付物面板）**：宿主层面板（HireRosterDialog 同款 target-state 驱动）读 `/paperclip-api/companies/:id/artifacts`（交付物）+ `/heartbeat-runs/:runId/log|events`（输出/轨迹），bare `/api` 产物路径 re-prefix 到 `/paperclip-api`（否则落到退役 Python catch-all）。canvas embed 加 `onOpenRunDetail(companyId, runId)`。fail-soft：读失败绝不呈现为「空但完成」的交付物。依赖 P3a 的 run 列表入口。
- **P3d —— 单模块对话（per-company，零 server）**：embed 加 `onOpenChat`（对称 `onHireRoster`），仅 live 世界（真实 uuid，demo id `A..E` 会被 `/chat/stream` fail-closed 拒）。Inspector 「💬 对话」按钮。apps/web `CompanyChatPanel`（HireRosterDialog 骨架）：复用 RuntimePicker（一个 runtime→model→effort，契约单一源，铁律6）+ `streamChatTurn`，payload `company_id`=真实 uuid，面板自持会话 id（首轮 omit 让后端建司内会话，续轮带回）。per-agent 点击**诚实降级**为公司对话 + agent 作语境标注（后端 `/chat/stream` 只绑按 adapter 合成的 chat agent，非具名 agent——不谎称独立 agent 会话）。**绝不**复用 `board-chat.ts`（硬编码 sonnet、无 runtime 联动、实验门——违铁律6）。
- **P3e —— 模块互链（annotational，前端 only）**：`types.ts` 加 `CanvasLink`（discriminated module ref `{kind:company|hub|agent,id}` + kind + origin:manual|auto）；App 持 `links` 状态 + localStorage（按 world source keyed）；FleetCanvas SVG 组新增 persistent-link 边族（复用 `companyAnchor`/`bezierPath`）；CompanyCard header 连接手柄拖拽建链（区别于 move-drag）。公司级 id only（agent 级 index 随 live 名册重排漂移 → 后续按 id 解析）。**严格 annotational**：链接绝不触发/暗示执行或 mission handoff（真实交接仍 mission + 审批门）；world toggle/clearAll 按 world 剪枝孤儿。引擎测试进 apps/web vitest。⚠️ **决策 fork**：annotational 链接（前端零后端、可立即交付）vs 真实跨公司委派（P3g，治理 mutation、大爆炸半径）是两个同名不同物的能力——先做 annotational，真实委派留 P3g，绝不让前者悄悄变成后者。
- **P3c/P3f/P3g —— deferred（触 vendored `server/` 或需业主定边界 + 双顾问）**：**P3c** 实时流（fleet-canvas 代理补 `ws:true` + canvas 自有 WS helper 订阅 `/companies/:id/events/ws` 的 `heartbeat.run.log/progress`，token/membership 授权，fail-soft 回退轮询；代理改动非 server/，但 WS 授权成本高，轮询已够用）。**P3f** 按 `company_id` 列 chat 会话历史（现 `GET /chat/sessions` 只列个人公司；需 server C-layer 或 gateway/前端会话索引）。**P3g** 真实 per-agent 会话（`/chat/stream` 接受目标 agent）+ 真实跨公司委派（gateway relations 只读读模型 + 治理 Node mutation tri-state + 真实 issue 状态词表，复用 FleetCanvas c2c 渲染，仅换数据源）。三者最后做。

> 分级消息中心（设计 v4）承接跨公司通知留待 P3g 之后。

### P4 —— orchestrator 仓库对齐

myshell-studio-orchestrator 的 SuperClaw 桥从 Python `/api/goals`+`/api/runs` 迁到 gateway mission API；顺手修三个 PARTIAL（`WAITING_FOR_HUMAN_GATE` 卡 UI、automations `sessionIssueId` 必须 Node UUID、返回体形状）。

## 5. 风险与对策

- **投影性能**：公司×agents×runs 全量轮询是 N+1（每公司 2 个请求）。P0 限流（公司数 cap + 5s 轮询 + fail-soft 跳过）；P1 起改 read-model 聚合端点（gateway 聚合，不动 server/）。
- **角色映射失真**：真实 agent 的 role/title 是自由文本，启发式必有误判。对策：映射规则可测试、可迭代；卡面显示真实 title，映射只影响对齐候选。
- **两套世界的引用泄漏**：demo/live 切换必须整体重置任务与负载（agent id 空间不同）。
- **desktop 打包路径**：`/paperclip-api` 在 desktop 走 Python front door 转发（paperclipBridge 同款约束）；front door 缺失时 fail-soft 离线，不crash。

## 6. 验收口径（P0）

- 相关测试绿（新投影测试 + apps/web 既有清单）；apps/web `npm run build` 过；fleet-canvas `tsc` 过。
- Codex 对抗验收无阻断（本分支单顾问口径）。
- 真实环境自检：Node server 起时画布能看到真实公司/编制/运行脉冲；Node 不在时亮离线回退演示世界，无假成功。
