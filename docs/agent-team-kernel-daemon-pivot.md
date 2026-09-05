# Agent Team Kernel：Daemon 化转向裁决（路线 B）

Status: 正式架构裁决（2026-06-12，用户拍板）。本文修订并部分推翻
`agent-team-kernel-paperclip-adoption-plan.md` 与 `agent-team-kernel-execution-plan.md`
中的既有裁决；冲突之处以本文为准。

## 0. 一句话

Agent 公司放弃"同步内核 + 无常驻进程"形态，引入**本地常驻 daemon + heartbeat
调度**，以**官方 Paperclip 为蓝本尽可能完整照抄**（允许针对本项目优化），
让公司真正"自己会干活"。

## 1. 裁决经过（三次收口）

1. **路线裁决**：经 Codex(gpt-5.5) + Gemini 交叉验证，同步内核版被定性为
   "组织登记处而非协作系统"（charter 注入无消费方、AgentProfile 无 model/skill
   字段、workspace 单锁致并发瘫痪、checkout 不启动执行、无 issue 沟通流）。
   用户裁决走路线 B：daemon 化对齐 Paperclip。原"坚决砍 heartbeat 自治"作废。
2. **范围裁决**：第一版设计原则为**默认全抄 Paperclip，例外需论证**（举证
   责任反转）。原"不抄"清单逐项改判，见 §4。
3. **蓝本裁决**：蓝本 = **官方 Paperclip**（`paperclipai/paperclip`），本地
   参照 checkout `../paperclip-ref` 已钉死在 master `d9ea1bf`（2026-06-12）。
   官方迭代极快（观测：4 天 +6.5 万行），蓝本按钉死版本实施，定期吸收上游。

## 2. 铁律修订口径

- **保留：CLI 是唯一事实来源。** daemon 是**内核新组件**（`superclaw daemon
  start/stop/status/logs`），全部逻辑在 core harness；API/Web/Desktop 仍只是表层。
- **保留：fail-closed 治理。** pay-switch、网络扫描门、插件投影、审批门原样
  插进 daemon 的认领（claim）闸门序列；daemon 不拥有放行权。
- **推翻：仅"无常驻进程"一条。**
- **唯一不可让渡红线**：高危副作用（支付执行、网络扫描、越权写、预算硬停解除）
  必须人审。注意这与 Paperclip 不冲突——其 board 级审批同样人审；hire 在
  Paperclip 本就走 `approval(type=hire_agent)`（SPEC-implementation.md §812），
  原规划"坚决砍 hire 自动化"砍的是一个不存在的东西，属事实错误，撤销。

## 3. 引擎照抄蓝图（来源：paperclip-ref@d9ea1bf 实测绘）

Paperclip 引擎无外部队列依赖，秘诀 = **事务性 DB 工作队列 + per-agent 心跳
策略 + context snapshot 续会话**；每次心跳起新进程跑一轮即退出。

**Tier 1 五件套（必须照抄）**：
1. wakeup queue（`agent_wakeup_requests` 等价表；source: timer/assignment/
   on_demand/automation；幂等键 + 合并计数）；
2. per-agent heartbeat policy（`runtime_config.heartbeat = {enabled,
   intervalSec, wakeOnDemand, maxConcurrentRuns}`，逐 agent 比对
   `lastHeartbeatAt`，非全局 cron）；
3. 事务性工单认领锁（SQLite 以 `BEGIN IMMEDIATE` + WAL 替代 `FOR UPDATE`；
   认领闸门序列 = 可调用性 → 预算 → 暂停锁 → **SuperClaw 治理门** → 工单事务锁）；
4. context snapshot 持久化（每次唤醒上下文落库，支撑续会话与审批恢复）；
5. 三层会话状态（`agent_runtime_state` per-agent + `agent_task_sessions`
   per-agent-per-task + run snapshot）。

**已有资产直接映射（不重写）**：backends 14 渠道 = adapters；分级 resume 守卫 =
session continuity；`liveness.py` lease/reconcile = run 判活与僵尸自愈；
`CostEvent` 幂等账本照用；`Approval.resume_action` 对接"批准 → automation 来源
wakeup"恢复执行。

## 4. "不抄"清单的逐项改判（默认全抄原则下）

| 项 | 改判 | 要点 |
|---|---|---|
| hire 自动化 | **全抄** | Paperclip hire 本就走审批收件箱（hire_agent → 人批 → onHireApproved 落地）；agent 可发起招聘提案 |
| agent 免检审批 | **抄分级审批真实语义** | 产出验收可 agent 化（parent/QA accept）；board 级四类（hire_agent / approve_ceo_strategy / budget_override_required / request_board_approval）人审 |
| 多租户 | **v1 不抄产品语义；只保留本地治理命名空间** | `company_id`/`workspace_id` 只用于本地审计、预算、装备与工作区边界；不实现租户切换、成员邀请、RBAC 管理、RLS 或 SaaS 管理台。后续 B 端若要做托管多租户，必须单独立项和迁移评审，不能混入当前 Paperclip Team Kernel 闭环。 |
| SaaS 计费 | **货币化抄、结算不抄** | `cost_cents` + 模型单价表照抄；Stripe/支付执行不进默认路径（Pay-Switch 铁律）。计费按 §5 双车道 |
| Postgres | **唯一维持不抄**（工程成本，非价值否定） | SQLite+WAL；三条纪律：schema 命名镜像 Paperclip、禁 SQLite 特有特性、一切走 StateStore 抽象，B 端里程碑加 Postgres backend |
| Secrets/InstanceSettings | **大部分抄**，见 §6 | 保留自有 `secrets_scan` 叠加 |

## 5. 计费：双车道模型（用户已确认）

- **relay 车道（计费）**：登录态 → 中转站服务器供模型 → 驱动定制 harness
  （ClawWork）。**计量事实源在服务器侧**；本地 `cost_events` 为对账副本
  （`usage_status=actual`，幂等键对应服务器账单行）。daemon 预算硬停在此车道
  查**服务器配额/余额**。
- **byo 车道（观测）**：用户自配 agent runtime 只做本地观测（token + 单价表
  折算参考价），**永不进结算**。
- CostEvent 增车道标记（`billing_lane: relay | byo`，可由 provider 推导）。
  本地永不执行支付动作；B 端 chargeback = relay 车道按 company/agent/issue 聚合。

## 6. Secrets / InstanceSettings 拿取清单

| Paperclip 表 | 裁决 |
|---|---|
| `company_secrets`（台账：provider=local_encrypted、版本、轮换戳、创建者 actor） | ✅ 抄 |
| `company_secret_bindings`（声明式绑定 secret→target/configPath；required 缺失 → agent 不可调用，接 invokability 闸门） | ✅ 抄（精华） |
| `secret_access_events`（访问审计，关联 run/issue/plugin） | ✅ 抄 |
| `company_secret_versions` | ✅ 抄简化版（版本号+时间戳） |
| `instance_settings`（单例：general/experimental 两 JSON 桶） | ✅ 照抄结构，装 daemon 全局配置 |
| `board_api_keys` / `agent_api_keys`（key 哈希存储） | ✅ 抄模式；board key = 中转站登录态→daemon 鉴权对应物 |
| `company_secret_provider_configs`（外部 vault） | ⏸ B 端里程碑；本地只要 local_encrypted |
| `environments` / `environment_leases` | ⏸ 本地 v1 用 git worktree 隔离；云端环境租约推后 |

## 7. 四阶段计划

- **阶段 0（本文 + 止血）**：本裁决文档；「签出」改"占用工作区"并加机制说明
  （只加锁不启动执行）；工单卡渲染 description/priority。
- **阶段 1（身份地基）**：AgentProfile 增 `model`（backend 纳管配置，过治理门，
  不裸拍字符串）+ skill 维度（对齐官方新表 `company_skills`，复用 skill 双轨 +
  fail-closed 枚举）+ charter 真消费（`agent_prompt.py::compose_agent_system_prompt`，
  backends 统一注入，工具只投 `equipment.granted`）+ 预埋 heartbeat policy 字段；
  **schema 级决策在此锁定**：company_id 严格作用域、memberships/instance_user_roles、
  cost_cents+单价表。验收：CEO/Eng 各跑一单，prompt/model/granted tools/成本归因可证不同。
- **阶段 2（daemon 骨架）✅ 已落地**：`superclaw daemon start/stop/status/tick`
  （O_EXCL 原子 pidfile + stop 等待退出 + logfile，tick 为 cron 友好单轮）+
  Tier 1 五件套（`daemon.py`：wakeup queue 幂等合并「仅 queued 行、同 source
  才吸收、被吸收触发留 absorbed 审计」/ per-agent heartbeat policy 含水位防
  thundering herd / BEGIN IMMEDIATE 认领含可见时间（requested_at 兼作
  not-before）+ 闸门序列「可调用性→**per-agent 持久认领锁（跨进程硬并发门，
  v1 单飞）**→预算硬停（锁内序列化）→有活可干→workspace 锁」/ context
  snapshot / agent_runtime_state + agent_task_sessions 双层会话状态）。
  关键语义：瞬态失败（agent 忙/工作区被锁）**defer 不蒸发**——原 wakeup skip
  留审计 + 入队带退避可见时间的 retry 行；run 状态仅 `completed` 才
  submit_for_review，`WAITING_FOR_HUMAN_GATE` 是等待态不混入完成审批；
  run 未建立的异常走 `team_kernel.abort_checkout`（新内核原语：放锁+回 todo，
  状态机新增 in_progress→todo 转移）防孤儿锁死锁，真有 run 的失败仍持锁留勘；
  主循环线程池调度（默认 4 worker），串行化靠双持久锁而非循环本身。
  验收用例 `test_heartbeat_drives_issue_to_review_unattended` 通过：定时唤醒→
  认领 todo 工单→以 profile 身份执行→submit review→成本/会话状态落账，全程
  无人点击；24 项 daemon 测试含两轮双顾问阻断的全部回归用例。
  备注：task_session 的 session_ref 续会话消费归阶段 3；max_concurrent_runs>1
  与 pidfile pid-reuse 弱探活为已知边界（并发正确性不依赖 pidfile）。
- **阶段 3（异步组织循环）✅ 已落地（3a/3b/3c/3d 四子阶段，每段双顾问验收）**：
  3a 事件流内核（issue_comments/issue_thread_interactions、@-mention 公司域解析
  重名 fail-closed、非 assignee 评论唤醒 assignee、block/unblock 归还认领、
  decide_approval crash-safe 顺序+apply_approval_decision 单事务翻转、QA 打回
  闭环含返工 brief/一次打回一次返工/失败现场不自动重跑；CLI issue
  comment/comments/block/unblock/requeue）。
  3b 委派闭环（origin_kind/origin_run_id 溯源、三重墙=深度8+每父活跃25+树级
  活跃100、分派/委派即唤醒、完成回流 pre-flip 落 pending fact+单一唤醒+
  manager continuation 真闭环、欠账优先调度保证定向收敛、父无 assignee
  escalate_to_board；CLI delegate --origin-run-id）。
  3c 锁粒度拆分（WorkspaceProfile.concurrency 治理声明、Issue.lock_key 钉死
  取放一致、save_workspace_profile 单事务 mid-claim 防翻转、per-issue worktree
  隔离含 .git 验真、非 git 漂移 guard 串行、同 agent 单飞跨 agent 并行）。
  3d 续会话消费（prior-pass 上下文进 continuation brief，原生 backend resume
  留 follow-up）+ 端到端验收剧本 test_phase3_full_company_loop_unattended：
  CEO 心跳认领→委派 Eng→Eng 独立 worktree 交付→人批子单→流回唤醒 CEO→QA 打回
  root→CEO 携'打回原因+子单完成+上次 pass'三重上下文无人值守返工→重提→终审
  done；全程锁清零、线程审计完整（delegation/qa_rejection/completion），人手
  仅 3 次审批决定。
  **已知边界（非闭环项，归阶段 4/follow-up）**：escalate_to_board 目前仅产生
  审计可见的 pending 事实，没有 board 消费者（阶段 4 审批收件箱/管理面承接）；
  原生 backend session resume（session_ref 接分级 resume 守卫）未接，现为
  prior-pass 文本地板 + worktree 现场保留。
- **阶段 4（表层收口）✅ dev/roadmap 已完成可集成闭环**：向导/工作台已覆盖
  model、skill、心跳策略、预算、workspace 配置与 bootstrap proposal 标识；
  Team Workbench 已有组织图、daemon 状态、成本、审批/返工 lanes 和工单讨论线程。
  本轮 Phase 4 补齐两块 Paperclip 缺口：① durable routines 调度内核
  (`TeamRoutineSchedule` + 原子 due-slot claim + daemon `tick_scheduled_triggers`)；
  ② board escalation 消费面（`/api/team/board-inbox` + Workbench board inbox +
  pending/needs-changes/accepted/rejected lanes）。后续 dev/roadmap 集成已补齐
  routine authoring API/CLI/Web、board escalation 的状态化关闭/指派端点、
  chat cost ledger 与硬预算 409 表面。2026-06-17 completion pass 又补齐
  bootstrap proposal→approval/commit 的原子落地路径，以及可真实 preview/commit
  的 Team Workbench 四步向导；Paperclip 多租户/SaaS 产品面继续排除。非阻断
  backlog 保留为多进程 daemon 真实共享 SQLite 的 soak 测试、routines 运营增强与
  生产观测硬化。

**B 端里程碑（不进 v1）**：认证与成员邀请、RLS/租户隔离、Postgres backend、
结算后端（中转站套餐对接）、托管部署形态。

## 8. 工程风险

1. **SQLite 单写者**：daemon 成为主要写者后，CLI/API 写操作必须短事务；
   WAL + busy_timeout；禁长事务。
2. **失控烧钱**：预算硬停与调度器同阶段上线（认领闸门内前置）。
3. **僵尸 run**：复用 liveness lease/reconcile，daemon 启动先自愈。
4. **上游漂移**：蓝本钉 `d9ea1bf`；吸收上游作为独立、显式的 rebase 任务。

## 9. Ship-readiness 硬化（2026-06-13，36-agent 对抗式复审后）

阶段 0-4 落地后跑了一次 36-agent 对抗式 ship-readiness review（5 维度 reviewer →
逐项 refute 验证，29 候选 refute 掉 10），确认 335+83 测试全过但抓出 6 个真阻断，
已全部修复并经 Codex/Gemini 双 PASS：

1-3. **心跳总开关 fail-closed**：`HeartbeatDaemon.heartbeats_enabled()` 默认 False、
   存储异常 return False（坏治理存储绝不放行自治）；CLI/API 的 daemon status 同步。
   总开关只 gate **timer 调度循环**；事件驱动唤醒（assignment/mention）照常 service。
   **运维变化**：纯 timer 自治需先 `superclaw instance set general heartbeat_enabled true`；
   `daemon tick/start` 在 OFF 时打 stderr 提示。assign→tick 事件路径不受影响。
4. **_execute re-read 防覆盖**：run 完成后 save 前 re-read issue，若人已 block/requeue
   则不覆盖（记 `issue_moved_to_{status}` 审计、finish、return）。
5. **submit_for_review 原子化**：新增 `StateStore.submit_issue_for_review` 单事务翻转
   issue+写 approval（关闭"卡 in_review 无 approval 可批"的孤儿态）。
6. **重分派 guard**：`checkout_issue(expected_assignee=...)` + `ReassignedError`；daemon
   传 expected_assignee 并 skip "reassigned"；operator 直接 checkout 省略该参数保留自由。

**真机冒烟（live，真模型真产物）**：claude CLI OAuth 过期→Opus 4.8 三路 unavailable；
改用 codex backend(gpt-5.5，doctor 唯一可写可认证) 跑通完整环：human 建单→daemon tick
认领→codex CEO 真实执行→hello.py 真产物(内容精确+可运行)→submitted_for_review→人审
approve→done→锁清零(0 locks)；cost 5 事件 backend=codex/lane=byo 归因正确。Opus 4.8
变体代码路径字节同一，仅差模型 auth。

**backlog（非阻断，待后续）**：submit/decide retry 的重复评论幂等、CLI comment body /
block reason 缺 min_length、WAITING_FOR_HUMAN_GATE 手动 resume、stub orchestrator 测试
覆盖盲点（失败/恢复/wreckage 路径未经真实 run-status walk）、12 个预存 ruff 债、
多进程 daemon 真实共享 SQLite 的跨进程竞态未经执行验证（仅代码审查+单进程单测）。
