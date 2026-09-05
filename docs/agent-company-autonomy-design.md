# Agent 公司自治管理 —— 把运行中 agent 接进内核动作（参考 Paperclip，v4 定稿）

> v4 决策（Codex + Gemini 双顾问一致）：**采纳 Paperclip 核心原则**（权限来自认证身份、不可自报、agent 只持受限身份），**产品路线选 B**（本地单用户工具：operator CLI 保持 ambient admin，不加凭证摩擦；agent 只经 run-bound ticket 受限通道，best-effort 隔离出 ambient —— 同 UID 非硬边界，见柱子 0 option 1）。**否决路线 A**。柱子 0 据此重写（见下）。
> v3.1：Codex v3 复审 B/C 已闭合，A 曾收紧为三态 actor proof + 厘清 ticket 只堵 MCP 冒名。
> v3：纳入 Codex v2 复审 3 条阻断（CLI/shell 绕过、comment/deliver/submit 未入契约、issue_create root 门）。
> v2：纳入业主决策（Paperclip 路线 / 自主招聘走人审）+ Codex v1 6 条。v1 前提错误已纠正（§2）。

## 1. 目标运营模型（业主拍板）

对齐 Paperclip：**人只在审批门介入，门与门之间 agent 靠唤醒循环自动推进**。
- 招聘 / 归档 / 跨域 / 高风险 → agent **发起 → 待人审 → 批准才生效**（守红线）。
- 门之间全自动：批准后新 agent 被 assignment wakeup 唤醒接活；CEO 靠 heartbeat/assignment 推进下一步。
- "辅助一次完整流程后自动推进" = 不手把手推每步，只在审批门点头；agent 之间靠 wakeup 自滚。

## 2. 现状（纠正 v1 的前提错误）

**v1 错误**：v1 说"运行中 agent 完全没有公司工具"。**实测纠正**：
- 公司管理工具**已存在**，但**只投影给 B-class 后端**（anthropic-agent / gemini）：`backends.py:4220/4605` 调 `_maybe_add_company_tools`，经 `WorkerLimits.company_command_resolver`（`orchestrator.py:1071` 绑定）→ `execute_company_command`（`company_handler.py`）。
- **A-class 原生后端（codex / claude）零 company-tools 引用**（`codex_app_server.py` / `claude_stream.py` 无）。
- 业主的 CEO 跑在 **codex（A-class）→ 拿不到工具 → 无法招聘**；叠加 heartbeat 默认关、未自动唤醒。

**现有 scope 已对齐 Paperclip**：`_company_scope_for_run`（`orchestrator.py:872`）对 team run 给**受限身份**（`is_admin=False`、`allowed_company_ids={home}`、未解析 → `__unresolved_company__` fail-closed）；direct chat 才 `is_admin=True`。

**现有 hire 是直接建（红线缺口）**：`HireAgentCommand → team_kernel.create_agent_from_spec`（`company_handler.py:334`），注释依据"用户拥有公司、用户触发即允许"。该前提**对自主 agent 不成立**。

## 3. 四根柱子

### 柱子 0：路线 B —— operator 保持 ambient，agent 隔离出 ambient（理想；现状 best-effort，见条件 4）

**问题**：CLI `company hire-agent`（`cli.py:6132`）硬编码 operator admin scope（`cli.py:5829` `is_admin=True`）→ 直接建。**自主 agent 若有宿主 shell，可直接 `superclaw company hire-agent`，或更狠——直接用 SQLite 写穿本地 StateStore，绕过 PR-1 红线 + handler + approval + scope**。

**决策（路线 B，否决 A）**：真人本地 CLI 继续 ambient operator admin（不加凭证摩擦；安全收益主要是防 agent 而非防同机真人；Paperclip 自身也区分 `local_trusted` 免登录）。**侧门改由"把 agent 从 ambient 隔离"来堵，而非给 operator 加凭证**——理想是彻底隔离，**现状（option 1）是 best-effort**（见条件 4，同 UID 非硬边界）。

**B 的目标条件（理想；标注现状达成度）**：
1. **agent 不持 ambient（理想目标）**：理想下自主 team run 运行时不暴露 `superclaw` CLI、不暴露本地 StateStore 路径/SQLite、不暴露 operator auth/env，改公司状态只经内核 MCP/tool resolver + run-bound ticket。**现状（option 1，best-effort）**：子进程 env 不继承 `SUPERCLAW_CONTROL_TOKEN`（operator auth）+ 直接工具面拦截 `superclaw`/`python -m superclaw` + credential_guard 路径黑名单；**非硬隔离**，同 UID shell/解释器间接是已知残留（条件 4）。彻底隔离留未来 OS 级。
2. **（严格理想，未来 OS 隔离）StateStore 直写**：理想下 containment 应禁止 agent 进程读写 `~/.superclaw` 状态目录（DB/JSON）。**现状（option 1）**：`credential_guard` 已把 `~/.superclaw/state.db` + sidecars（`state.db*`）+ 凭证材料列入黑名单（realpath/inode 防 `../`/符号链接），挡住**直接 file-tool/路径-token** 形式的读写；解释器/shell 间接形式属同 UID best-effort 残留。
3. **（严格理想，未来 OS 隔离）可证明边界，证明不了就拒跑**：理想下若 backend 不能证明 readonly-state / no-ambient-CLI / no-egress 就拒绝执行。**现状（option 1）不做硬拒**（否则 CEO 在所有同 UID 本地后端都跑不了，砸掉目标）；改为下条的 best-effort 实现。此严格模式留给未来 OS 级隔离 + authenticated 模式（§5 开关）。
4. **（现状实现 = 业主拍板 option 1，best-effort）**：同 UID 不是硬边界。**PR-1b 实际做的**：① 全部 4 个 agent backend spawn 点（LocalShell/ClawWork/Claude stream/Codex app-server）从子进程 env **洗掉 `SUPERCLAW_CONTROL_TOKEN`**（防 curl 本地 API 冒充 operator）；② `assert_command_allowed` 拦截 **直接 tokenized** 调用 `superclaw` / `python -m superclaw`；③ `credential_guard` 路径黑名单挡 state.db/凭证直接访问。**不是**可证明 containment、**不是**"禁止本地 API 可达本身"、**不是**"证明不了就拒"。同 UID 下 shell/解释器间接（`sh -c`、`python -c "import superclaw…"`）明确记为**已知残留**（参 `plugin_proxy.py:149`）。核心红线"招人必审"由 PR-1（内核 choke point）+ ticket 通道（PR-3）守。
5. **ticket 非普通 env 串**：短期、不可伪造、单 run/单 agent/单 audience、绑 `run_id+agent_profile_id+company_id+allowed_actions+expiry`；每次 mutation 服务端从 ticket+profile **重算 scope**，`is_admin` 恒 False、不可自报（柱子 2）。
6. **不止 gate hire**：`update-agent`/`approve grant`/secret binding/archive/release/workspace-containment 改动都是同类 mutation 面，统一走 `company_handler` 单 choke point，不开 API/Desktop/script 侧门。
7. **预留 A-style authenticated 模式开关**：一旦变局域网/远程/多用户，切到"operator 也要凭证"的 authenticated 模式（非现在本地单用户默认）。

### 柱子 1：自主 agent 的招聘 → 人审门（红线核心，所有路径必需）

在 `execute_company_command` 的 `HireAgentCommand` 分支按 **actor 类型分流**：
- **actor 是人/operator**（`scope.is_admin=True`，你本人 chat 触发）→ 维持现状直接建（`create_agent_from_spec`）。
- **actor 是自主 agent**（`scope.is_admin=False`，team run）→ 路由到 `team_kernel.request_hire`，**只开 `ApprovalType.AGENT_HIRE` pending 审批，不建 profile**；人批准后经既有 `agent.hire` resume 路径建（`team_kernel.py:1056`）。
- 同理审计其余命令：归档/跨域已有门；assign/delegate 收紧到**组织子树**（见柱子 1b）。

**单一 choke point**：分流逻辑写在 `execute_company_command`（或其调用的 `company_handler`）内，CLI/B-class/A-class 三表层共用，零分叉。`is_admin` 不可被 agent 自报（由 `_company_scope_for_run` 从 **agent profile** 派生，已 fail-closed）。

### 柱子 1b：扩契约 + 每个写动作补 run/issue/组织链/预算校验（Codex #4、v2 #B、v2 #C）

- **扩共享契约（v2 #B，必须）**：现有 `company_commands` 只有 8 个命令，**不含**评论/交付/提交评审。要"零分叉复用 `execute_company_command`"，必须把它们加成**一等命令模型**：`issue.comment`（→`post_issue_comment`）、`work_product.attach`（→`attach_work_product`）、`issue.submit_review`（→`submit_for_review`），并同步 `ui_contracts` schema → handler → CLI → 测试。否则会出第二套 MCP-only 语义（违铁律）。
- **`issue_create` root 门（v2 #C，必须）**：`issue_create` 是 **root runnable work 创建**；自主 agent **不得随意建 root 工单**（fan-out + 逃逸 tree）。team 上下文里 agent 拆活走 **`issue_delegate`**（当前 tree 内子工单）；root `issue_create` 由 agent 发起须 run/tree gate 或人审。
- `assign_issue` / `delegate_sub_issue`：当前仅同公司约束 → 收紧为**仅直接下属 / 组织子树内**（`reports_to` 链），非"本公司任意角色"。
- 新增的 `issue.comment` / `work_product.attach` / `issue.submit_review`：校验 actor 与目标 issue 的绑定；`issue.submit_review` 必须传并校验 `expected_checkout_run_id`（`team_kernel.py:871`），否则 agent 知道 issue_id 就能提交不属于自己的工单。
- **预算 fan-out 门（Codex #5）**：agent 建 runnable work / 触发 wakeup / 委派**前**先过预算（预留），不等下游 checkout 才失败。

### 柱子 2：把公司契约投影给 A-class 原生后端 via MCP

新增 `superclaw.team_mcp_proxy`（镜像 `plugin_mcp_proxy`，stdio MCP server），**仅注入 `source="team"` 的 A-class run**（B-class 仍走 in-loop resolver，不重复）。每个工具 dispatch 到**同一个** `execute_company_command`（复用柱子 1 的门），零分叉。工具 schema 复用 `ui_contracts.build_company_command_tool_schema`（B-class 同源）。

**actor 防冒名用 run-bound 票据（Codex #2，硬要求）**：
- 不靠子进程 argv 自报身份。bootstrap run 时内核签发一张 **run-bound ticket**，绑定 `run_id + agent_profile_id + company_id + workspace + 到期 + 允许的工具集`，写 StateStore。
- `team_mcp_proxy` 每次 call 携带 ticket；内核**查 StateStore 验证**（票据有效 + 未过期 + 工具在允许集 + scope 匹配）才执行。argv 只当 hint。
- **ticket 只堵 MCP 层冒名**（伪造 argv 启自己的 proxy / 自报身份）；它**不**负责堵"agent 用 shell 调 operator CLI"——那条由柱子0 的 containment（agent 够不到 operator CLI）+ CLI proof 三态门处理。两件事分清，别让 ticket 背它扛不动的边界（`plugin_proxy.py:113/149` 明确 full-shell 调 operator CLI 不在 proxy 边界内）。

### 柱子 3：唤醒循环（自动推进）

- 种子工单 **assignment wakeup** 让 CEO 首跑（已有机制，验证它真把 codex/B-class run 跑起来）。
- 批准 hire 后，新 agent 经 assignment wakeup 接活（既有）。
- heartbeat 默认仍**关**（不偷偷自治空转）；业主可显式开让 CEO 周期自推。
- 唤醒前过既有 5 层 fail-closed（公司活跃 / invokability / 预算 / heartbeat 策略 / issue-tree 冻结）。

## 4. 分阶段实现（core 先行，Codex #6；每阶段双 PASS + 本地全量 ci.yml + 原子 PR）

- **PR-1（红线核心，✅ 已完成双 PASS：`decc50ba`）**：`execute_company_command` hire 按 actor 分流——operator(`scope.is_admin=True`)→直接建；自主 agent(`is_admin=False`)→既有 high-risk approval（人授批后建）；`is_admin` 内核派生不可自报；忘传→fail-closed HIGH。**路线 B 下 operator CLI 保持 ambient,不加 actor-proof（A 已否决）。**
- **PR-1b（best-effort 隔离 = option 1，✅ 已完成双 PASS：`30e36194`）**：把 agent 从 ambient operator 权限隔离开（best-effort，非可证明 containment）。实际做的三件事：① 全部 4 个 agent backend spawn 点洗子进程 env 的 `SUPERCLAW_CONTROL_TOKEN`（防 curl 本地 API 冒充 operator）；② `assert_command_allowed` 拦截**直接 tokenized** 调 `superclaw`/`python -m superclaw`；③ `credential_guard` 路径黑名单（`state.db*`+凭证材料，realpath/inode 防绕）。**明确不是**可证明边界、**不是**"禁本地 API 可达本身"、**不是**"证明不了就拒"。core + 测试（`superclaw`/`python -m superclaw` 拒、look-alike+普通 python 放行、control-token scrub 幂等）。诚实残留（option 1）：同 UID 非硬边界，shell/解释器间接是 best-effort；自定义 `SUPERCLAW_STATE_PATH` 须置于 agent 够不到处；严格 OS 级隔离 + refuse-if-unprovable 留未来。
- **PR-2（扩契约 + 写动作收紧）**：新增 `issue.comment`/`work_product.attach`/`issue.submit_review` 命令模型（→ui_contracts→handler→CLI）；`issue_create` team 上下文 root 门 + 拆活走 `issue_delegate`；assign/delegate 组织子树约束；submit 校验 `expected_checkout_run_id`；预算 fan-out 门。core + CLI + 测试（cross-company、stale-run-submit、non-report-delegate、budget-exhausted、agent-root-issue-gated）。
- **PR-3（run-bound ticket）**：内核签发/验证 ticket 原语 + StateStore 持久化 + 过期/工具集/scope 校验。core + 测试。
- **PR-4（team_mcp_proxy + 接 A-class run）**：MCP server 复用 `execute_company_command`（含 PR-2 新命令）+ 携 ticket；`run_goal` 对 A-class team run 注入其 config（与插件 MCP 聚合）。集成测试。
- **PR-5（唤醒收尾 + e2e）**：验证种子工单唤醒 CEO 首跑；e2e：建公司 → CEO 首跑 → 调 `issue_delegate`/`request_hire` → 人审 → 建 agent → 新 agent 唤醒接活的完整闭环。

## 5. 铁律对齐

- **CLI 唯一事实源**：能力先进 core（PR-1/2/3），CLI/契约同源；MCP 是最后的薄投影，复用 `execute_company_command`，零新增业务语义（Codex #6 / #3）。
- **fail-closed 治理**：自主 agent 招聘必人审；越界/跨公司/超预算/stale-run 拒绝；actor 由 profile 派生 + ticket 验，不可冒名。
- **表层零新增语义**：A-class MCP 与 B-class in-loop 投影**同一份** `execute_company_command`，不产生第二套语义。

## 6. §6 设计问题的定稿答案（采纳 Codex 判断）

1. **直接生效 vs 人审边界**：评论/交付/**委派子工单(`issue_delegate`)**/(当前 tree 内)状态推进**可直接生效**，但只限当前公司 + 当前 issue/tree + 当前 run + 直接下属/组织子树；**root `issue_create`**、招聘/权限/跨公司/预算提升/归档/删除/冻结/外部副作用**一律 gate(run/tree)或人审或拒绝**。
2. **CEO 首跑**：只用种子工单 assignment wakeup；heartbeat 默认关。
3. **actor 绑定**：必须 run-bound ticket，argv 不够。
4. **assign/delegate**：仅直接下属 / 组织子树内，非本公司任意角色。
5. **预算归属**：记当前运行 agent + company + root/current issue；下游 run 记实际 assignee，但**创建方先过预算**防免费 fan-out。
