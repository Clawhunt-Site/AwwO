# 持久化 Chat — 基于 Paperclip Node 原生件的设计

> Status: **草案 v0.1（迭代中）** · Branch: `feat/server-coexist` · 底座: `origin/main(6f3a34b0)` + vendored Paperclip Node server
> 本文是讨论沉淀,逐节迭代。决策未定的地方标 **【待定】**。

## 0. 目标与原则

- **chat = 用户输入 → 走 Paperclip Node 原生 Agent 调用逻辑 → 持续对话**。执行完全在 Node 上,Python 不进 agent 路径。
- **确定性**:一轮输入 = 一轮执行 = 一轮回复。不要 heartbeat 那套"任务循环"语义(合并唤醒 / staleness / timer)。
- **不发明新抽象**:能用 Paperclip 现成原生函数就用,只在必要处做"抽核 / 加作用域层"。
- **skill / plugin 可注入**,且要支持**超越公司域的全局注入**(见 §4、§9)。
- **数据归口 super 全局目录**:所有持久化(Node home / 内置 pg / 全局 skill·plugin / chat)一律落在 **`~/.superclaw`**(`SUPERCLAW_HOME`,可覆盖)下,**不另起 `~/.paperclip-*`**。super 全局目录里**已有** `~/.superclaw/skills`、`~/.superclaw/plugins`、`~/.superclaw/chats`、`state.db` —— 全局来源直接复用,Node 的 `PAPERCLIP_HOME` 也收进 `~/.superclaw/<子目录>`。

## 1. 前提(来自 `server/docs/agents-runtime.md`,纠正了一个根本误解)

> "Agents in Paperclip do **not** run continuously. They run in **heartbeats**: short execution windows triggered by a wakeup."
> 持续性 = **session resume**:存 session id,下一轮自动 `--resume` 上一次会话。

**结论**:Paperclip 没有"常驻 agent"。"持久化" = 每轮一次 adapter 调用 + 跨轮 session resume。
所以 chat 在执行层去不掉"调一次 adapter";**能去掉的是包在外面的 issue/task 脚手架**。

## 2. 原生件清单(都在 `server/server/src`)

| 能力 | 原生函数/对象 | 位置 |
|---|---|---|
| 取 adapter | `getServerAdapter(type)` → `ServerAdapterModule` | adapters/registry.ts |
| 跑一轮 agent | `adapter.execute({ agent, runtime, config, context, onLog, authToken, ... })` | 各 adapter 的 `*Execute` |
| session 续接 | `adapter.sessionCodec.deserialize/serialize` | adapter.sessionCodec |
| skill 物化 | `adapter.syncSkills` / `listSkills` | adapter 上 |
| skill 解析注入 | `applyRunScopedMentionedSkillKeys` + `readPaperclipSkillSyncPreference` + `companySkills.listRuntimeSkillEntries(companyId)` → `config.paperclipRuntimeSkills` | heartbeat.ts:786 / 8990-9001 |
| plugin 工具 | `pluginWorkerManager` + `plugin-tool-dispatcher` | services/ |
| workspace/cwd | `realizeExecutionWorkspace({ base, config, issue, agent })` | workspace-runtime.ts:1214 |
| 对话存储 | `issues`(origin_kind="chat")+ `issueComments` | services/issues |
| 续接存储 | `agentTaskSessions.sessionParamsJson` | heartbeat.ts:4976/4990 读写 |

⚠️ **现状**:`adapter.execute` 的组参、session 读写、resume 解析**全内联在 heartbeat 里**(9640-9750 / 2077-2107 / 4976-4990),没有独立函数。这是 §8 要抽核的原因。

## 3. 持久化 Chat 链路(每轮,确定性,无 heartbeat)

```
用户输入
 1. 写 user turn      → issueService.addComment
 2. 解析作用域        → 全局域 ∪ company 域(见 §4)
 3. 组 config + skill → applyRunScopedMentionedSkillKeys
                        + (global skills ∪ companySkills.listRuntimeSkillEntries)
                        → config.paperclipRuntimeSkills
 4. plugin 工具       → pluginWorkerManager(global ∪ company)→ 工具
 5. 解析 cwd          → realizeExecutionWorkspace(base, issue:null, project_primary)
 6. resume sessionId  → agentTaskSessions[convId] → adapter.sessionCodec.deserialize
 7. 物化 skill        → adapter.syncSkills 进 cwd
 8. 跑一轮            → adapter.execute({ agent, runtime, config, context=历史+本轮,
                        resume, onLog → message.delta })     ← 唯一执行点
 9. 落库             → 新 sessionId upsert agentTaskSessions
                        + assistant reply addComment
 无 issue 派单 · 无 heartbeat run · 无 timer · 无 staleness · 无 git worktree provision
```

## 4. 作用域模型:**Global ▷ Company**（本设计的核心新增）

业主要求:**一个超越公司域的全局域**,skill/plugin 在全局域里定义后,**跨所有公司**注入。
运行期解析 = **全局域 ∪ 当前 company 域**(全局优先级/去重规则【待定】)。

```
Global scope（新增）           ← 跨公司:在任何 chat / 任何公司都注入
  ├─ global skills
  └─ global plugins
Company scope（现有,原生）     ← 仅该公司
  ├─ company_skills(companyId)
  └─ company plugins(pluginCompanySettings / pluginEntities)
```

chat 归属一个 company(个人=`local` 公司,@公司=真公司);runtime 解析技能/插件时,**先取全局域,再并上 company 域**。

## 5. 持久化语义

- **对话持久** = 一对话绑一个 `issue`(origin_kind="chat"),每轮一条 `issueComment` → 历史落库可重载。
- **续接持久** = 该对话在 `agentTaskSessions` 存 `sessionParamsJson` → 下轮 `sessionCodec` resume。
- 二者都是原生表,**不新建对话/会话存储**。

## 6. workspace 模型 ▷ 侧边栏两大分类（照 super 实际设计,§10.13 已定）

**核心模型**:照 super —— **一个保留的 `local` 公司,下面挂多个 workspace**。左侧侧边栏的两类都从 **local 公司的 workspaces** 投影;**其余公司 = real,本就被 `build_workspace_inventory` 过滤**(只列 `company_profile_id="local"`)→ 进 Team 工作台,不进 chat 侧栏。**不给 company 加 kind 列**,区分靠 workspace 字段。

| 侧边栏 | 来源 | 区分键 |
|---|---|---|
| **① Chat（对话）** | local 公司**内置 chat 工作区**(`metadata.builtin=="chat"`)下的 chat-issue;每对话 = 一 issue | `builtin_chat=true` |
| **② 项目（Projects）** | local 公司的**项目 workspace** = 接入的真实目录 | `kind=project` |
| **(隐藏)** | real 公司的 workspace(agent 团队) | `company_profile_id != "local"` → 不列 |

- **① 对话**:走 local 公司、每对话=一 issue(业主:难度/完整性最好);cwd = 内置 chat 工作区(scratch,恒信任,§10.12)。
- **② 项目**:接入真实目录 → 一个 `kind=project` workspace;cwd = 该目录;带**信任门**(§10.12);`realizeExecutionWorkspace`(`project_primary`,**不开 git worktree**)。
  - **可行性已验(Paperclip 原生支持)**:`projectWorkspaces.cwd` 收真实路径;`POST /api/projects/:id/workspaces { cwd }` 落库;agent 在该 cwd 执行;守卫(heartbeat.ts:1314/1342/1372)**拒绝跑偏到 fallback / cwd 不一致**。非 git 普通目录也可(:1143 "use as-is")。
- super 旧 `workspace_id` ↔ Paperclip 的 workspace/`projectWorkspaces`,B2 映射,UI 零改;底层接管落点细节待 §10.10。

## 6.5 super workspace 显示契约（"让底层去暴露"逐字段）

super 侧边栏**完全照搬** `ui_contracts.workspace_projection`(apps/web 注释:"renders trust from this contract, **never derives semantics itself**")。底层必须**为每个 workspace** 暴露下列字段;右列是 Paperclip Node 现状(`buildChatWorkspaceInventory` 大量 hardcode = 待暴露真值):

| 字段 | 含义 | Node 现状 |
|---|---|---|
| `workspace_id` / `name` | id / 名 | ✓ |
| `kind` | 类型(chat / project) | ⚠️ hardcode `"project"` |
| **`trust_status` / `is_trusted` / `trust_source`** | **SuperClaw 信任容器**:非 `active` → surface 显示信任屏障而非聊天框 | ❌ Paperclip 无此概念;hardcode `trusted` |
| `repo_path` | 工作目录 | ✓ `projectWorkspaces.cwd` |
| **`company_profile_id`** | 归属公司(**侧栏过滤键**) | ⚠️ 需暴露 company id |
| **`builtin_chat`** | `metadata.builtin=="chat"` → Chat 工作区 | ❌ hardcode `false` |
| **`containment_preset` / `effective_containment`** | **SuperClaw 风险围栏档**(risk-based floor) | ❌ Paperclip 无此概念 |
| `pinned` / `pinned_at` | 置顶 | ⚠️ hardcode `null` |
| `session_count` | 会话数 | ✓ 已算 |

**super 自身隔离不变量(= 你"真公司不进侧栏"的出处)**:`build_workspace_inventory` 只列 **`company_profile_id="local"`** 的 workspace;**"company workspace 是 agent 执行边界,属 Team 工作台,绝不漏进 chat grouping"**(workspace-sidebar-rework §4.2)。

**所以"让底层去暴露"的具体含义**:Paperclip `projectWorkspaces` 缺 **trust 容器 / containment 档 / builtin_chat / company_profile_id** 这些 SuperClaw 治理字段,现都被 stub。要让 super 显示逻辑真跑,**Node 底层必须按上表逐字段暴露真实值**(个人单算子环境可给恒定值,但要明确,不是默默 hardcode)。trust/containment 两组是 SuperClaw 独有治理概念 → Node 侧要么映射、要么按"个人 local = active/standard"恒定暴露【§10.12】。

## 6.6 前端流式契约 —— 已匹配,不改前端（缺口在 Node 侧）

**结论:apps/web 前端零改即可跑 Node `/api/chat/stream`。** 前端就是按 super 旧契约写的:
- **输出事件**(`onEvent` @ App.tsx:13104-13157)认 `chat.started / message.delta / message.completed / chat.completed` + `isChatDisplayEvent`(DisplayProtocol 工具/推理/用量卡片);Node 的 projector 全吐这些。`delivery` 事件前端 handle 但 **Node 纯 chat 永不发**(run_id=null)→ 优雅跳过。
- **流帧**:`event:`/`data:` + `\n\n`,`streamChatTurn` 通用解析,与 Node 一致。
- **输入**:前端每轮发 `message/session_id/model/effort/backend_policy/workspace_id/repo_path/budget_seconds/...`;Node 现只读子集,其余收下不报错。

**前端已超前对齐 §6**(13067-13071):有项目 → `workspace_id=项目id, repo_path=null`;纯 chat → 省略 `workspace_id`(落 Chat scratch)。

**前端发了、Node 没用的字段 —— 三种不同原因(别混为一谈)**:
- **`workspace_id`** → **漏接,待补**:§8.1 读它解析项目 cwd(§6;现 chat.ts 未读)。
- **`model`** → **漏接,待补**:Paperclip 原生支持(`modelProfile`),薄镜像没接;§8.1 读 `body.model → modelProfile`。`ensureChatAgent` 现只带 adapterType、不带 model。
- **`effort`** → **要补(之前误判为"Paperclip 无此概念",错)**:Paperclip 基座里有 effort 键的是 codex `modelReasoningEffort`(minimal/low/medium/high/xhigh,`-c model_reasoning_effort=`)、claude `effort`(low/medium/high/xhigh/max,`--effort`)、opencode `variant`(`--variant`);gemini/cursor 无。**更正(后续决策):grok 不暴露 effort** —— grok 基座 adapter 虽有 `reasoningEffort`/`--reasoning-effort` 键,但无 Grok 模型可靠按 reasoning_effort 响应(grok-4 拒;grok-3-mini 仅 low/high;grok-4-fast/4.3 仅 none/low/medium/high),无 claude 式统一 ladder,故 SuperClaw `supports_effort_selection=false` 且对显式 effort fail-closed(见 `GrokCliBackend` docstring)。**实际暴露 effort = codex/claude/opencode 三家**。`chat-runtime.ts` 改成**按 adapter 真实能力报**(满足 runtime 联动铁律:真支持才显示、档位来自契约)。执行链已通(`codex-args.ts:59` 从 runtimeConfig 读该键拼 `-c`)。
- **`mode`**(及 `dry_run`/`verification_policy`/`permission_preset`)→ **故意砍**:chat 纯单车道(run_id 恒 null,永不 delivery),这些是 SuperClaw delivery/intent 字段,chat 不需要。

**model/effort 设计(复用 Paperclip 原生,不在 runAgentTurn 里特殊透传)**:
- Paperclip 把 effort/model 存在 **agent 的 `adapterConfig`**(jsonb);UI「Thinking effort」表单写它;**`thinkingEffortKeyFor(adapterType)`** 做"通用→adapter 键"映射(codex `modelReasoningEffort` / claude `effort` / opencode `variant`;**grok 已下线 effort,不在此映射**);run 经 **`resolveAdapterConfigForRuntime`**(heartbeat:669)自动消费。`thinkingEffortOverride` 不是独立列,就是往 `adapterConfig` 写 `thinkingEffort`。
- chat 语义 = **runtime sticky per chat**(App.tsx:3459)= 每 chat 一 agent,model/effort 黏在该 agent。**与 Paperclip 的 per-agent adapterConfig 天然对齐。**
- ⇒ **chat 的 model/effort = 该 chat agent 的 `adapterConfig`**:composer 选 → 写进 chat agent 的 `adapterConfig`(`thinkingEffortKeyFor` 映射)→ run 经 `resolveAdapterConfigForRuntime` 原生消费,**零特殊透传**。
- **唯一要补**:`chat-runtime` 契约别 `false` 一刀切,改从 **`thinkingEffortOptionsFor(adapterType)`** 报真实档位 → composer 的 effort 选择器按 runtime 联动(满足铁律)。`gemini/cursor` 无 effort → 仍 false(正确)。
- ⚠️ model/effort **是 per-turn 动态**(可随时改 + 中途换 runtime 的 handoff/sticky/上下文接管)→ 完整规则见 **§6.7**(移植 `resolve_chat_runtime`);这里的 adapterConfig 只是"每轮投影后被消费"的那一环。

## 6.7 动态 runtime 切换 + 上下文接管 + skill/plugin 生命周期（移植 SuperClaw 设计）

model/effort **是 per-turn 动态的**(聊天框可随时改),不是设一次固定。直接**移植 SuperClaw `chat_runtime.py`** 的纯逻辑:

**① 每轮解析 `request > sticky > default`**(`resolve_chat_runtime`):
- sticky 存 **chat 会话(= issue)的 metadata `["runtime"] = {backend, model, effort}`**(chat 记住它的 runtime)。
- 本轮 `body.{backend_policy, model, effort}` 显式请求 > sticky > 默认。`""`=`REQUEST_CLEAR`(显式清除),`None`=本轮没请求(铁律已有此区分)。
- **落地链**:每轮解析出 `{backend, model, effort}` → 选/建该 backend 的 chat agent(`ensureChatAgent`)→ 用 `thinkingEffortKeyFor` 把 model/effort 投到该 agent 的 `adapterConfig` → run 经 `resolveAdapterConfigForRuntime` 原生消费(§6.6)。issue.metadata 是 sticky 真相源,每轮投影到 agent.adapterConfig。

**② 中途换 backend = 同 chat 内 in-chat handoff(不 fork)**:
- **model + effort 不跨切换**:`backend_switched` → drop(除非本轮显式重选);model id / effort 档都是 runtime 专属。
- 旧 backend 原生 session 不可续 → 换 agent = 天然全新 session(新 agent 对该 issue 无 `agentTaskSessions` → fresh)。
- 生成 **`handoff_note`** → 作为 **`system` issue-comment** 追加进 transcript。
- **上下文接管**:不能 resume → **把之前轮次(issue comments)replay 进新 runtime 的 prompt 上下文**(SuperClaw cli.py:929 "runtime 切没切都收到对话上下文")。

**③ skill/plugin 每轮 ephemeral 重算 + fail-closed 失效检查**(`skill_runtime.py` / `plugin_runtime_projection.py`):
- 每 run **临时 run-scoped 投影,用完即销**(无全局账本);plugin 集 = **`installed ∩ 签名有效 ∩ 未撤销 ∩ 已授权`,每 run 现算,撤销从不缓存**。
- **planning↔projection 之间被撤销/删除/篡改的一律 drop**(fail-closed)。
- 换 runtime 时尤其重算(新 runtime 的 skill/plugin 不同、旧的失效)。
- → Node 侧需确保 §3 每轮 skill/plugin 解析是**每轮现算 + 失效即 drop**(而非缓存一次),对齐 SuperClaw。

## 7. 边界:从 heartbeat 摘掉什么

保留(进 `runAgentTurn`,§8):adapter.execute、session resume 读写、skill 注入、plugin 工具、cwd 解析。
摘掉(chat 不进):issue 派单 + staleness 守卫、heartbeat run 账本、timer/wakeup 合并、workspace finalize barrier、git worktree provision。

## 8. 落地顺序

1. **抽 `runAgentTurn` 执行核**:把 heartbeat 里"组 execute args + 调 adapter.execute + 读写 agentTaskSessions session"抽成独立原生函数;heartbeat 与 chat 共用,**保证抽完 heartbeat 行为不变**(回归测试兜底)。
2. **chat orchestrator(作用域版)**:替掉 chat.ts 里的 `heartbeat.wakeup` → 解析作用域(全局∪公司)→ 解析 cwd → 注入 skill/plugin → 调 `runAgentTurn` → 落 issue/comment/session。
3. **全局作用域层**(§9 选型后):加 global skills/plugins 解析,并入 runtime 注入。
4. **workspace 绑定**:复用 `moveChatSession` + fallback。
5. **company 接入**:个人=local 公司;@公司=该公司域(intent 不再强制 delivery,而是"在该公司域里持续对话")。

## 9. 全局 skill/plugin —— **自建「来源(source)」维度 + 并集解析**（已定方向）

**核心模型(业主拍板)**:不跟 Paperclip 的 company_id 死磕,在我们这层加一个 **来源(source)** 维度:
- 每个 skill/plugin 标 **来源 = `company` 或 `global`**。
- chat 在公司 X 下解析 = **`[source=company ∧ owner=X]` ∪ `[source=global]`**。
- ⇒ **global 来源全公司可用;公司自己的 skill 自己可用**。两者并集,互不排斥。

**现状(已核实)**:
- Skill:`company_skills.company_id` **NOT NULL**(每个 skill 必属一公司);跨公司原生手段只有 fork(拷贝)/`publicShareToken`(公开分享)——都是"复制",无实时全局共享。
- Plugin:`pluginEntities.companyId` **允许 NULL = 全局实体**;插件代码 **instance 级加载**;已有 `feat/plugin-state-user-global` 分支。

**实现(已定):global 来源 = super 全局目录 `~/.superclaw/skills` + `~/.superclaw/plugins`**(不另造保留公司)。
- **global skill 源** = `~/.superclaw/skills`(super 现有文件式全局 skill)。
- **global plugin 源** = `~/.superclaw/plugins`(super 现有全局 plugin)。
- **company 来源**仍是 Paperclip 原生(DB `company_skills` / 公司域 plugin)。
- **解析层**(= §8.1 `runAgentTurn` 里组 skill/plugin 那步):**`company 来源(Paperclip DB)` ∪ `global 来源(~/.superclaw/skills|plugins)`**,各标 source 后并集 → `config.paperclipRuntimeSkills` / plugin 工具。
- **要解决的集成点【待定,§10.7】**:super 全局 skill 是**文件式**(`~/.superclaw/skills/<name>`),Paperclip company skill 是 **DB+物化式**(`company_skills` → `syncSkills` 进 cwd)。并集时要把文件式全局 skill 也喂进 adapter 的 skill 物化路径(`adapter.syncSkills` 的 `paperclipRuntimeSkills` 入参里加 file-sourced 条目),让两类 skill 统一进 cwd。plugin 类似(全局 plugin 目录 → plugin-loader 也吃 `~/.superclaw/plugins`)。

**冲突/优先级**:同 key 时 company 来源覆盖 global(本地特化优先)还是 global 优先?→ 见 §10.2【待定】。

## 10. 待定决策清单

1. ~~§9 全局 skill 选型 / 存哪~~ → **已定:source 维度 + 并集解析;global 来源 = super 全局目录 `~/.superclaw/skills`+`plugins`**。
2. 全局域与公司域**冲突/去重/优先级**规则(同 key 谁赢:company 特化优先 vs global 优先)?
3. session 续接 key:复用 `agentTaskSessions`(按对话 id)还是新维度?
4. chat cwd:默认 scratch,可选绑 project —— 默认行为确认?
5. plugin 生命周期:每轮用完即销 vs 会话内常驻(记忆里业主倾向"用完即销")?
6. `runAgentTurn` 抽核**不改变 heartbeat 行为**的验证方式(回归测试范围)?
7. **文件式全局 skill/plugin ↔ Paperclip DB/物化式的集成**:把 `~/.superclaw/skills|plugins` 的 file-sourced 条目喂进 `adapter.syncSkills` / `plugin-loader` 的具体接法(§9 集成点)。
8. ~~Node home 收口~~ → **已做:Node home = `~/.superclaw/node`**(归口 super 全局目录;原 `~/.paperclip-node-server-coexist` 弃用)。
9. ~~真公司标注方式~~ → **已定:`companies` 新增显式 `kind` 列(`personal|project|real`);侧边栏只列 personal+project,real 隐藏**(§6)。
10. **super workspace 接管细节**(§6):super 旧 `workspace_id` 落到 Paperclip `projectWorkspaces` 的具体接法(谁建、cwd 来源、绑定/解绑)。
11. ~~`project` 粒度~~ → **作废**(§10.13 定了照 super:一个 `local` 公司 + 多 workspace,`project` 是 workspace 不是 company)。
12. ~~trust/containment 怎么暴露~~ → **已定(分两种 workspace)**:**Chat 内置工作区** = 系统 scratch,恒定 `trust_status=active / containment=standard`,**不弹窗**;**项目(接入的真实目录)** = **保留 super 现成的"我信任此目录用于 agent 执行"信任门**(未信任→显示信任屏障不给聊天框;信任后 active/standard;外部来源压 `low_trust_review`)。trust_status 非 active = surface 显示屏障(ui_contracts:1742);UI 已存在(App.tsx:2826/2827/2810)。
13. ~~模型对齐~~ → **已定:照 super 实际模型走** —— **一个 `company="local"` + 多 workspace**(`builtin_chat`/`kind` 区分 chat vs 项目),其余公司 = real 隐藏(`build_workspace_inventory` 只列 `company_profile_id="local"`)。**放弃**之前"三种 company kind"的提法。

## 11. 实现进度（dynamic runtime 切换 + 上下文 + model/effort）

**✅ 已落地并验证(23 单测全过)**:
- `services/chat-runtime-selection.ts` —— 忠实移植 SuperClaw `chat_runtime.py`(`resolveChatRuntime`/`stickyChatRuntime`/`applyChatRuntime`/`REQUEST_CLEAR`/`handoffNote`)。12 测试:request>sticky>default、换 backend 掉 model+effort、显式重选保留、REQUEST_CLEAR、handoff、sticky 幂等。
- `services/adapter-effort.ts` —— 服务端 effort 能力+映射(镜像 server/ui):`adapterSupportsEffort`/`thinkingEffortOptionsFor`/`thinkingEffortKeyFor`/`applyEffortToAdapterConfig`(codex `modelReasoningEffort`/claude `effort`/opencode `variant`;gemini/cursor 无)。11 测试。

**接入事实(已查实)**:
- sticky 存 `issues.executionState.runtime`(jsonb)。
- 上下文 = heartbeat 把 issue comments **inline 进 wake context**(2832-2859,有上限)→ replay 原生支持,换 runtime 传全量轮次。
- model per-turn 覆盖走 `payload.modelProfile`(1766,不污染共享 agent)。
- effort:Node 侧**需补 effort→adapter键 映射**(server/ui 的 `thinkingEffortKeyFor` 只在前端)。

**✅ 已接通 chat.ts(dynamic runtime + handoff + replay + per-turn override)并端到端验证**:
- `routes/chat.ts` `/chat/stream` 重排:先定 session+读 `issue.executionState`(sticky)→ `resolveChatRuntime(state, body{backend/backend_policy, model, effort})` → `ensureChatAgent(backend)`。
- per-turn model/effort → `applyEffortToAdapterConfig` → `issue.assigneeAdapterOverrides.adapterConfig`(heartbeat 按 run 应用,不污染共享 agent);sticky → `applyChatRuntime` 写回 `issue.executionState.runtime`。
- 换 backend → `appendChatSystemNote`(handoff)+ wakeup `contextSnapshot.wakeCommentIds=[全量轮次]`(transcript replay)。
- `services/chat-compat.ts` 加 `appendChatSystemNote` + `persistChatTurnRuntime`。
- `routes/chat-runtime.ts` 契约:effort 从 `thinkingEffortOptionsFor` 按 adapter 真实档位报(§6.6)。
- **测试**:chat-compat-routes 含 2 个新行为用例(per-turn override / 换 backend handoff+replay+drop);chat 套件 55 测试全过;tsc 干净。
- **端到端(LIVE Node:3810)**:turn1 claude_local+model+effort → turn2 切 codex_local → 会话 transcript 出现 `[system] [runtime switched: claude_local → codex_local …]`,sticky 持久 + handoff + replay 真生效。

**残留(非本次引入,rides Paperclip 原生)**:skill/plugin 每轮现算+失效 drop = heartbeat 原生 per-run 解析(§6.7③);若要更严格的 per-turn fail-closed 重算,是 heartbeat/plugin-loader 侧的后续。

---
*规划主体已彻底完成并验证。提交前按铁律需走 Codex + Gemini 双顾问对抗式验收(尚未提交)。*
