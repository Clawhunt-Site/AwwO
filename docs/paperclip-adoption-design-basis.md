# Paperclip 采纳设计基准（Design Basis / Constitution）— v4

> 本文档把业主（2026-06-26/27 多轮对话）确认的方向，固化为「把 Paperclip 作为底层支撑框架最大限度采纳进 SuperClaw Python 内核」这条工作的**设计基准**，是后续 skill / plugin / worktree / adapter 重做判定的唯一基准。
>
> **修订史**：v1 经 Codex（gpt-5.5）+ AGY（Gemini 3.1 Pro）两路对抗验收**双判不通过**（生命周期矛盾/无硬门过宽/one-shot 未裁）。v2 修订后 Codex 复审**仍判不通过**，指出 4 个真阻断：§4 RPC 表不完整且误折叠 UI RPC、§原则2 secrets 边界是声明非可证强制（实测 `plugin_proxy.py:74` 现在就含 `HOME`）、§5 兼容红线漏权限/session/projection、§2.3 缺迁移门。**v3 已用源码穷举把这 4 项补实**（§4 全协议矩阵、§原则2 改为"目标+验收证据+点名当前缺口"、§5 六大类红线、§2.3 G1–G10 迁移门、附录 A secrets 边界真相）。v3 复审：**AGY Pro 判通过**；**Codex 仍指 §4 Worker→Host 矩阵不全**（漏 `entities.upsert/list`/`events.emit`/`activity.log`/`metrics.write`/`telemetry.track`/`log`/`companies.list/get`/`projects.list/get`，且 `streams.*` 误分类为 method、实为 notification）。v3-final 复审：AGY 通过；Codex 指出**两个 checkout 版本分叉**——它按更新的官方 `Documents/paperclip-ref@6756ae8`（2026-06-18）核对，§4 仍漏 `access.*`/`authorization.*`/`executionWorkspaces`/`projects.managed` 等族。**业主裁定改用更新 checkout 为权威源**。**本版（v4）**：§4 已对 `paperclip-ref@6756ae8` 重建为**全量矩阵（20 Host→Worker 方法 + 2 Host→Worker 通知 + 93 Worker→Host 方法 + 4 Worker→Host 通知，正确行号）**并显式标版本锚；新增 **§7 authorization 子系统评估**（**业主裁定本轮不实现、仅路线图声明为未来项**，推荐未来 partial-adopt）。改后须再经两路审（对 `paperclip-ref` 核）至双 PASS 方为定稿。
>
> **✅ 定稿（2026-06-27）**：经 9 轮对抗迭代，**Codex（gpt-5.5）+ AGY（Gemini 3.1 Pro）双 PASS**。Codex 核实 `notifyHost`={log,streams×3}、`notifyWorker`={onEvent,agents.sessions.event}、`HostToWorkerMethods`=20、`WorkerToHostMethods`=`METHOD_CAPABILITY_MAP`=93、W→H 通知=4，全文计数一致 **20+2+93+4=119 协议面零遗漏**；AGY 确认七原则自洽、§5 红线/G1–G11/附录 A/§7 裁决全部闭环。**本文档为 skill/plugin/worktree/adapter 重做的唯一设计基准。** 实现待业主点头后另起干净 worktree 分阶段进行（每阶段原子 PR + 双顾问验收 + 本地全量门）。

## 0. 北极星（一切服务于此）

```
Chat（理解用户意图）→ Skill / Plugin / Company / 扩展（能力层）→ Adapter（操控底层 runtime）→ Agent Runtime
```

判断任何设计是否正确，唯一标准：**它是否让这条"chat→意图→能力层→adapter→runtime"路径更简单、更健壮、更可扩展，且最大限度复用 Paperclip 已有成熟设计。**

## 1. 七条基准原则

1. **Paperclip = 可信底座，最大限度保留。** super 现有 `plugin_proxy` 门 / `containment` / worktree 只是**最早为"把功能跑起来"的实现，不是公理、不是最佳设计**。冲突处先质疑"我们的"能否交付业主要的功能，而非拿"我们的"否决 Paperclip；亦允许质疑 Paperclip 某处（例：claude adapter 最佳参照是 claude CLI 原生 stream-json，非 vendored Paperclip，§2.3）。

2. **Worktree = 每个 session 干活的默认首选 + 一道「文件系统 + 环境变量/密钥」边界——但这是 TARGET，不是当前已成立的事实。**
   - 属性①（已成立）：基于最新项目 worktree 改动 → 可回撤、不波及系统其他部分。
   - 属性②（**目标，需实现+验收**）：worktree 是**真实强制**的 fs+env/secrets 边界——worktree 内执行**不能读到 worktree 外的宿主密钥**（无宿主 `HOME`/密钥库可达性，OS 级 fs 作用域且跟随执行目标）。
   - **诚实现状（v3 关键更正，详见附录 A）**：此边界**当前尚未真正强制**。实测 `SAFE_SIDECAR_PASSTHROUGH_ENV_NAMES` 仍含 `HOME`（`plugin_proxy.py:74`）并从宿主拷贝（`:607-615`），sidecar 因此拿到宿主 HOME → 可达 `~/.superclaw` 等密钥目录；`plugin_proxy` 自承"full-shell agent 不在此关闭，真边界是 backend containment 契约"（`:169-175`）；静态 preflight 只是补充非真沙箱（`:836`）。**当前真正成立的是"低信任执行被 fail-closed 拒绝（而非被围栏）"+ 命名密钥注入白名单门**；"worktree 是真实读隔离边界"是**待实现目标**。
   - **强制靠机制不靠 prompt**：`prompt_contracts.py:43` 明确 prompt envelope 不是授权边界。落地见附录 A 的"关闭缺口工作"（移除 HOME 出白名单+作用域化 HOME、OS 级 fs 沙箱、claude 读围栏 canary）。

3. **远程 / SSH / 云沙箱 / 联网 / 服务控制 = 全部作为能力保留，不困住底层 runtime 自由。** 边界**跟着执行走**：本地→worktree 边界；远程/沙箱→该 sandbox/远程 cwd 等价边界（同含 fs+env/secrets 作用域）。绝不因"离开本地盒子"砍能力。这些能力在 Paperclip 由 `environment.*` 驱动 → super 映射到 **adapter execution-target**（§4），不走常驻 worker。

4. **持续对话 = 必须；底层 runtime 调用模型 = 每轮 one-shot 进程 + `--resume`（UX 连续、底层不常驻）。** 与 `backends.py` 现有 per-invocation + DEVNULL-stdin 共享路径一致，保留其子进程生命周期/超时治理。`persistent_thread` 是**显式声明**的能力（`adapter.py:53`），不是默认假设。"one-shot"在插件层另有专指（§3），两层不可混。

5. **联网 = 以业主自己的准则为准，不新增 blanket 网络沙箱。** 唯一联网**策略规则**是业主的规则（支付不默认/对外扫描需审批，可放宽）。但 super 现有**承重硬门保留**：entitlement、凭证守卫、命名密钥注入/脱敏、命名空间（`plugin_proxy.py:178/527/617`）——这些恰服务"不读密钥/支付不默认"。准确表述：**不新增"拦一切出网"的 blanket 沙箱；既有密钥/计费/entitlement 门不动。**

6. **澄清语义 ≠ 权限语义，严格分离。**（两路确认成立）`AskUserQuestion`（模型问用户 2-4 选项）是**内容/澄清**通道；`permissions.py:15-77` 无 UI 审批器、ask/allow 直转 `--print/--yolo`，与权限通路彻底隔离。

7. **被裁剪/重映射项（明确不采纳为默认形态）：① per-plugin sandbox（业主早先拍板）；② Paperclip 常驻 worker 插件模型（§3 双路裁定）。** 其余 Paperclip 能力按 §4 矩阵逐项"保留/适配/重映射/丢弃"。

## 2. 逐主题校准

### 2.1 Worktree（§原则 2/3）
见原则 2 + 附录 A。强制靠 OS 级 fs 作用域 + env 白名单（移除 HOME），不靠 prompt。

### 2.2 联网治理（§原则 5）
不新增 blanket 网络沙箱；既有 entitlement/凭证/密钥门保留；业主规则可放宽。

### 2.3 Claude adapter 目标（§原则 4/6）——探针门控里程碑 + G1–G10 迁移门
- **现状**：super claude backend = `--print` + `stdin=DEVNULL`（`backends.py:2228`）；`agent_runtime/adapter.py:321` 的 `ClaudeRuntimeAdapter` 是**声明式降级 stub**（`mcp_config=False`/`persistent_thread=False`，exec 方法抛 `RuntimeCapabilityError`）。
- **目标（里程碑，非默认）**：保持"每轮 one-shot 进程 + resume"不变，**单轮内**启用 `--input-format stream-json` 双向 stdin，使 claude 原生 AskUserQuestion 在本轮内一问一答（`tool_result` 经 stdin 回喂）。**不引入跨轮常驻进程**；跨轮连续性仍由 `--resume` 提供。（stdin 流只替换"prompt 投递机制"argv→stdin JSON，不替换任何策略门。）
- **G1–G10 迁移验收门（新增 stdin/stream-json 路径绝不可绕过；全部 file:line in `backends.py`）**：
  - [ ] **G1 containment fail-closed**：低信任仍被拒（`:2084`/`:2132`），stdin 路径须在该 guard 下游，不得新开绕过入口；不得以"换了输入通道"为由重新放行 claude 低信任。
  - [ ] **G2 plugin-dir 禁用**：`policy.plugin_dirs` 非空 → `PLUGIN_RUNTIME_CONFIG_INVALID`（`:2158`），super 插件只走 MCP proxy；stream-json 不得复活 `--plugin-dir`。
  - [ ] **G3 secret-free MCP config**：`_secret_free_mcp_servers`（`:2170`，拒带 `env` 块 `:382`）须在建 stdin 信封**前**校验，任何带 env 的 MCP server 不得经任一通道到达 claude。
  - [ ] **G4 preset→bypassPermissions**：ask/allow 都映射 `--permission-mode bypassPermissions`（`:2074`）+ `--allowed/disallowedTools`，与 prompt 通道无关，须继续附加。
  - [ ] **G5 untrusted 围栏完整性**：现 `-- <prompt>` 终止符（`:2228`）防 argv 误解析；移到 stdin `user` 消息后，须**证明等价属性**——untrusted fenced prompt 只作消息 content、绝不入 argv、绝不并进 system 通道；`--append-system-prompt`（可信系统文本）留 argv 侧。
  - [ ] **G6 system 通道 append 不 replace**：`--append-system-prompt`（`:2202`/`:2228`）保留 claude 默认 system，不得覆盖。
  - [ ] **G7 model/effort + 非法 effort fail-closed**：`_resolve_model`/`_resolve_effort`（`:2121`），effort 不在 `EFFORT_LEVELS` 即 `_invalid_effort_result` 前置返回（`:2123`）；`--model`/`--effort` 须照附加。
  - [ ] **G8 skill-overlay guard**：`_skill_overlay_guard` 短路在前（`:2119`），`skill_capability=prose_only`（tool-skill 在 inline 路径 fail-closed 无 MCP 投影），stdin 入口须在其下游。
  - [ ] **G9 无 policy 锁定**：`policy is None` → `--no-session-persistence --tools=`（`:2193`）；`--input-format stream-json` 不得在无 policy 时偷偷重启 tools/session 持久化（也是"per-turn one-shot+resume、非常驻"的锚点）。
  - [ ] **G10 stream 解析 + batch 回退对等**：streaming 仅当 `event_sink` 非空（`:2130`）；零可解析事件回退 batch `--output-format json`（`:2259`）。两分支都过 `_build_command`，迁移须让 stdin 信封穿过两者或完整回退 argv（围栏+`--` 保留）。
  - [ ] **G11 spawn invariant 收紧（Codex v3 点名）**：`run_claude_stream` 当前也是 `stdin=DEVNULL` + scrub env（`claude_stream.py:87`）。迁移到 `--input-format stream-json` 必须把 stdin 从 DEVNULL 改为受控 JSON 流的**同时**，保持 operator-authority env 擦除不变；写死"stdin 改造仅影响 prompt 投递通道，不松动进程组/env 擦除/超时"这条 spawn 不变量，并在 streaming 与 batch 两路一致。
- **非阻断 backlog（留痕，两路顾问建议性优化，不阻塞定稿）**：① 作用域化 HOME 落地时加一份**安全白名单拷贝**基础工具配置（`.gitconfig`、已授权的 AWS/NPM 凭证），免得 fs 隔离把 git/npm 工具链弄断（AGY）；② G5 stdin stream-json 输入侧做**严格 JSON Schema 强校验**，防恶意 user prompt 构造 JSON 闭合在 envelope 内篡改同级 `tools`/`system_prompt` 字段（AGY）；③ G11 spawn 不变量在实现时落成显式测试用例（Codex）。
- **跨 runtime parity**：保留 runtime 无关 `ask_user_questions` MCP 工具（Paperclip `mcp-server/src/tools.ts:508`）给 codex/gemini 等无原生 AskUserQuestion 的 runtime。
- **对账更正**：业主早前贴的"--input-format stream-json + AskUserQuestionCard + POST /api/runs/:id/tool-result"经核实**不符 vendored Paperclip**（全仓无 `--input-format`；Paperclip claude adapter 实为 `--print -`+`--output-format stream-json`+`--resume`，`claude-local/src/server/execute.ts:691/767`），那套精确对应 **Claude Code 自身**。机制真实可用、是该借目标，但最佳参照是 claude CLI 原生。

### 2.4 会话记忆 vs worktree 边界
长会话记忆/上下文积累**不得钉在临时 worktree**（worktree 是 per-issue、可回收）。会话记忆由内核会话层持有（HOME 数据根 `~/.superclaw`，见 [[home-data-root]]）；worktree 只承载本次干活的项目文件隔离。生命周期解耦。

## 3. one-shot 分层真相 + 裁决

**第 1 层 — runtime 调用（每轮）：已收敛。** Paperclip（`codex exec`/`claude --print` + `--resume`）与 super 同构 → **保持"每轮 one-shot 进程 + resume"**，不引入跨轮常驻进程。

**第 2 层 — plugin 执行：双路裁定 = 保留 super one-shot sidecar，否决 Paperclip 常驻 worker。**
- Paperclip 插件 = 常驻 worker（`startWorkerRpcHost` `worker-rpc-host.ts:215`，暴露 `runJob`/`handleWebhook` `protocol.ts:594/596` + `agents.sessions.*`）= 有状态 SaaS 形态。
- super 插件 = 一次性 sidecar（`invoke_cached_plugin_tool` `plugin_proxy.py:135`，`_run_sidecar :784`，过 grant/entitlement/schema/redaction/evidence 门 + finally cleanup）。
- **裁决（Codex+AGY 一致选 (a)）**：常驻 worker 的 job/webhook 对 super「本地/单用户/CLI/chat」场景是伪需求+SaaS 包袱，放弃零功能损失；one-shot 无状态最安全（杜绝资源泄露/僵尸/跨轮污染）；持续性归内核会话；长任务归专门 daemon；将来真需 webhook/job → 另开独立 service/job adapter，**绝不替换默认 tool sidecar**。

## 4. Paperclip 插件 RPC 协议——完整取舍矩阵（v4：钉到权威 checkout，源码穷举）

> **权威源锚**：`/Users/leongong/Documents/paperclip-ref` @ **`6756ae8`**（2026-06-18）。本矩阵行号一律基于此 checkout（非旧 `Desktop/LeonProject/paperclip`）。计数（已对源核准）：**Host→Worker 20 方法 + Host→Worker 2 通知 + Worker→Host 93 方法 + Worker→Host 4 通知 = 全量逐项处置**。
> 文件：`packages/plugins/sdk/src/protocol.ts`（接口 `HostToWorkerMethods` ~:582–633、`WorkerToHostMethods` ~:680–1345、`WorkerToHostNotifications` ~:1360+）；gate 映射 `host-client-factory.ts` `METHOD_CAPABILITY_MAP` ~:354–488；UI bridge `ui/src/plugins/bridge.ts`。处置词汇：`保留=one-shot-sidecar-tool` / `保留=受治理 host-RPC` / `丢弃=drop-saas(常驻/job/webhook/UI-slot/stream)` / `重映射=super-kernel-MCP` / `重映射=内核store` / `重映射=内核可观测` / `归 adapter execution-target`。
> **承重守卫（务必在重映射的 MCP 面保留）**：所有 company-scoped 方法过 `requireInvocationCompanyScope`（`host-client-factory.ts:556–591`）的 fail-closed 作用域门。

### A. Host→Worker（`HostToWorkerMethods`，20：3 required + 17 optional，:582–633）
| RPC | 作用 | 处置 |
|---|---|---|
| `initialize`(:582) / `health`(:584) | 握手(交 manifest/config/instanceInfo/db namespace)/存活探测 | **保留=折叠进一次性 sidecar bootstrap**：每次调用随上下文传 config/manifest |
| `shutdown`(:586) | 优雅停 worker | **丢弃 drop-saas**：一次性 sidecar 自然退出 |
| `validateConfig`(:588) | 按 schema 校验 operator 配置 | **保留=受治理 host-RPC**：install/configure 时一次性校验 |
| `configChanged`(:590) | 向运行中 worker 推新配置 | **丢弃 drop-saas**：下次调用直接收新 config |
| `onEvent`(:592) | 推域事件进常驻 worker | **丢弃 drop-saas**：域事件归内核 |
| `runJob`(:594) | 跑定时/后台 job | **丢弃 drop-saas(job)**：周期工作归内核 routines |
| `handleWebhook`(:596) | 派入站 webhook | **丢弃 drop-saas(webhook)**：需常驻监听端点 |
| `handleApiRequest`(:598) | 派插件自注册 HTTP 路由 | **丢弃 drop-saas(SaaS-server)** |
| `getData`(:600，bridge `usePluginData` bridge.ts:340) | 驱动插件 UI 数据面板 | **丢弃=UI-slot-bridge**：非 agent 工具；super 无插件 UI-slot |
| `performAction`(:602，bridge `usePluginAction` bridge.ts:432) | 驱动插件 UI 按钮/动作 | **丢弃=UI-slot-bridge**：非 agent 工具；agent 的"做"走 `executeTool`（如有非 UI 动作应建模为 executeTool） |
| `executeTool`(:604，`ToolRunContext` agentId/runId) | **真正的 agent 工具入口** | **保留=one-shot-sidecar-tool**：唯一直接映射 `invoke_cached_plugin_tool` |
| `environment{ValidateConfig,Probe,AcquireLease,ResumeLease,ReleaseLease,DestroyLease,RealizeWorkspace,Execute}`(:605–633，共 8) | 执行环境驱动(local/remote/SSH/sandbox)校验/探测/租约/工作区实现/执行 | **归 adapter execution-target**（能力保留 §原则3）：`RealizeWorkspace`/`Execute` 正是 fs+env/secrets 边界须**真实强制**处（附录 A）；`Probe` 仍过 fail-closed 扫描门；`ResumeLease` 对齐"per-turn one-shot+resume"(resume 的是执行目标非常驻进程) |

### B. Worker→Host（`WorkerToHostMethods`，93（=`METHOD_CAPABILITY_MAP` 条目数），:680–1345；gate 列=`METHOD_CAPABILITY_MAP` 字面值，`null`=无门。下表按族分组，覆盖全部 93 项）
| RPC 族（gate） | file:line | 处置 |
|---|---|---|
| `config.get`(null) | :682 | **保留=受治理 host-RPC**：每次随上下文传入 |
| `localFolders.declarations`(**null**) | :685 | **保留=受治理**：列声明的受信任文件夹（无门） |
| `localFolders.{configure,status,list,readText,writeTextAtomic,deleteFile}`(`local.folders`) | :689–721 | **保留=受治理 + 归 fs 边界**：受 worktree fs 作用域强制（附录 A），越界拒绝 |
| `state.{get,set,delete}`(`plugin.state.read/write`) | :727–735 | **重映射=内核 store**：经内核 state 层，无插件私库 |
| `db.{namespace,query,execute}`(`database.namespace.read/write`) | :741–749 | **重映射=内核 store**：内核托管命名空间 |
| `entities.{upsert,list}`(null，按设计插件作用域) | :755/:778 | **重映射=内核 store**：作用域实体落内核托管存储 |
| `events.emit`(`events.emit`) | :802 | **重映射=内核事件(受治理 emit)**：经内核事件面发，**无常驻订阅** |
| `events.subscribe`(`events.subscribe`) | :806 | **丢弃 drop-saas**：常驻订阅需常驻监听者 |
| `http.fetch`(`http.outbound`) | :812 | **保留=能力**(§原则3/5)：受联网准则；扫描/探测 fail-closed 需审批 |
| `secrets.resolve`(`secrets.read-ref`) | :818 | **保留=受治理**：映射现有命名密钥注入门（fail-closed `plugin_proxy.py:617`） |
| `activity.log`(`activity.log.write`) | :824 | **重映射=内核可观测**：经内核 activity 账本，非插件私写 |
| `metrics.write` · `telemetry.track` · `log`(后者 null；**`log` 主传输是 notification，见 §4.C**) | :836/:848/:854 | **重映射=内核可观测**：默认永不离机（除非遥测上报门 [[remote-telemetry-upload]]） |
| `companies.{list,get}`(`companies.read`) | :866/:870 | **重映射=super-kernel-MCP**（读核心域；过 `requireInvocationCompanyScope`） |
| `projects.{list,get,listWorkspaces,getPrimaryWorkspace,getWorkspaceForIssue}`(`projects.read`/`project.workspaces.read`) | :876–892 | **重映射=super-kernel-MCP**（读核心域+工作区） |
| `executionWorkspaces.get`(`execution.workspaces.read`) | :896 | **重映射=super-kernel-MCP**：工作区**元数据**读；执行本身仍走 adapter |
| `projects.managed.{get,reconcile,reset}`(`projects.managed`) | :903–911 | **重映射=super-kernel-MCP**：company-as-code 受管项目，经内核 |
| `routines.managed.{get,reconcile,reset,update,run}`(`routines.managed`) | :915–948 | **重映射=super-kernel-MCP**：company-as-code 受管 routine |
| `skills.managed.{get,reconcile,reset}`(`skills.managed`) | :954–962 | **重映射=super-kernel-MCP**：受管 skill |
| `issues.{list,get,create,update}` + `issues.relations.{get,setBlockedBy,addBlockers,removeBlockers}` + `issues.{assertCheckoutOwner,getSubtree,requestWakeup,requestWakeups}` + `issues.summaries.getOrchestration` + `issues.{listComments,createComment,createInteraction}` + `issues.documents.{list,get,upsert,delete}`(`issues.*`) | :968–1162 | **重映射=super-kernel-MCP**：核心域工单读写/依赖图/checkout 归属/唤醒/评论/文档，绝不插件私写并行实现（CLI 唯一事实源） |
| `agents.{list,get,pause,resume,invoke}` + `agents.managed.{get,reconcile,reset}`(`agents.*`) | :1164–1198 | **重映射=super-kernel-MCP**：核心域 agent 读/控/受管 |
| `agents.sessions.{create,list,sendMessage,close}` | :1200–1216 | **丢弃 drop-saas**：持久会话否决；续接=per-turn one-shot + `--resume` |
| `goals.{list,get,create,update}`(`goals.*`) | :1218–1245 | **重映射=super-kernel-MCP**：核心域目标读写 |
| `access.members.{list,get,update}` · `access.invites.{create,list,revoke}`(`access.*`) | :1248–1286 | **丢弃（单用户不适用）**：多租户成员/邀请/join 流，super 单用户无第二人可邀（§7） |
| `authorization.grants.{list,set}` · `authorization.policies.{summary,get,update,previewAssignment,explainAssignment}` · `authorization.audit.search`(`authorization.*`) | :1292–1331 | **DEFERRED（本轮不实现，路线图未来项）**：保持 super 现有 `is_admin`+子树+escalation 治理不变；未来推荐 partial-adopt（取 preview/explain+可解释决策，弃 grant 表/角色），见 §7 |

### C. Worker→Host Notifications（4，经 `notifyHost(...)` fire-and-forget 推送；`grep notifyHost` 全集=这 4 条）
| Notification | host 发出 / 接收 | 处置 |
|---|---|---|
| `streams.emit` / `streams.open` / `streams.close`（typed `WorkerToHostNotifications`） | `worker-rpc-host.ts:1224/1228/1233`→`plugin-worker-manager.ts:663-665` | **丢弃 drop-saas（常驻流）**：流式输出走 super `EventSink=(event_type,payload)`（`adapter.py:29`），非插件 streams |
| `log`（**同名 typed method §4.B，但其主传输是 notification**；Codex 补漏） | `worker-rpc-host.ts:1265-1274` `notifyHost("log")`→`plugin-worker-manager.ts:623/628`（"log notification is the primary case"） | **重映射=内核可观测**：与 §4.B `log` 方法同处置（经内核日志），其 notification 传输路径一并归内核可观测，非插件私通道 |

### D. Host→Worker Notifications（非 typed interface，经 `notifyWorker(...)` 推送的 fire-and-forget；Codex final 补漏）
| Notification | host 发出 / worker 接收 | 处置 |
|---|---|---|
| `onEvent` | `server/.../plugin-host-services.ts:1211` / notification dispatch `worker-rpc-host.ts:1759` | **丢弃 drop-saas**：与 §4.A 的 `onEvent` 同一语义（向常驻 worker 推域事件），其 **notification 传输路径**随之丢弃；域事件归内核 |
| `agents.sessions.event` | `plugin-host-services.ts:2658/2670/2681` / `worker-rpc-host.ts:1755`；`AgentSessionEvent` 注释"Delivered via JSON-RPC notifications" `types.ts:1515` | **丢弃 drop-saas（持久会话）**：持久 agent 会话的流式事件推送，随 `agents.sessions.*`（§4.B）一并丢弃；会话续接=per-turn one-shot + `--resume` |

> 诚实结论：**唯一原生匹配 super 的是 `executeTool`**（→`invoke_cached_plugin_tool`）+ `initialize/health/validateConfig` 折叠进 sidecar bootstrap；`shutdown/configChanged/onEvent/runJob/handleWebhook/handleApiRequest/events.subscribe/agents.sessions.*/streams.*` = 常驻/job/webhook/SaaS-server/常驻流形态→丢弃；`getData/performAction`=UI-slot→丢弃；`environment*`(8)→adapter execution-target；核心域(issues/agents/goals/companies/projects/executionWorkspaces/projects.managed/routines/skills)→内核 MCP（过 `requireInvocationCompanyScope`）；state/db/entities→内核托管 store；activity/metrics/telemetry/log→内核可观测；events.emit→受治理内核 emit；secrets/http/config/localFolders→既有受治理门+fs 边界；**access.*/authorization.* 14 项→见 §7**；**Host→Worker notification（`onEvent`/`agents.sessions.event`，§4.D）随对应常驻/持久会话形态丢弃**。**全 20 方法 + 2 H→W 通知 + 93 方法 + 4 W→H 通知（streams.*+log）已逐项处置，无遗漏。**

## 5. 接口兼容红线——「重做时绝不许破坏」（v3 补全，六大类）

### A. 权限/治理契约（Codex 点名缺口）
- `PermissionPreset` 仅 `ask/allow` 两值（`permissions.py:36`，`REQUIRED_PRESETS:38`）：恰两个面向用户 preset，**不得引入逐动作审批分类法/决策引擎作默认**（加第三个破 `check_preset_map:127`）。
- `PRESET_TO_MODE` 都→`bypassPermissions`（`permissions.py:81`）：两 preset 都映射 runtime MAX（纯透传）；Paperclip 自身审批系统**不得**成为治理层；`ask` 不得真去 prompt（否则 surface 欺诈 `:41`）。
- `PresetRealization` 形状（`permissions.py:90`，`check_preset_map:127`，`serialize:151`）：新/迁移 backend 必须经 `make_presets` 声明 `PresetMap`，字段名+冻结 dataclass 是被各 surface 消费的契约。
- `Posture`+`posture_for_mode`+`_MUTATING_/_READONLY_TOOLS`（`permissions.py:164-205`）：仅 `plan→readonly`；每个进程内工具须分类入恰一集合，否则只读 posture 被静默绕过；新增 mutating 工具须分类。

### B. Agent-runtime adapter 契约（降级 stub 红线）
- `AgentRuntimeAdapter` Protocol 六方法（`spec/capabilities/open_session/run_turn/close_session/run_oneshot`，`adapter.py:145`）：迁移/新增 runtime 须全实现；`run_turn(session, RuntimeTurnRequest, event_sink)` 签名承重。
- `RuntimeCapabilities` 字段级矩阵（`adapter.py:53`，`streaming/persistent_thread/mcp_config/tool_events↔tool_lifecycle/...`）：能力须**诚实声明**（无 one-size flag）；不能桥 MCP 的 runtime 须声明 `mcp_config=False`。
- `RuntimeCapabilityError`（`RUNTIME_CAPABILITY_UNSUPPORTED`，`adapter.py:35`，`require_overlay_support:180`，surfaced `main.py:6358`）：overlay/streaming 要求**fail-closed**，绝不静默降级语义。
- **`ClaudeRuntimeAdapter` 降级 stub 契约（`adapter.py:321`）**：当前声明 `mcp_config=False/persistent_thread=False`、exec 方法抛错。红线：Paperclip 真 claude runtime 接通时须**遵从同一 negotiation**——诚实声明能力、对做不到的 fail-closed，**不得**静默换成 persistent-thread/MCP 桥的分叉形态；`claude-cli` runtime_id+alias 须仍归一到内核 backend `claude`。
- `RuntimeTurnRequest(prompt:str,…)`（`adapter.py:105`）：`prompt` 是**字符串** turn 载荷 + 可选 `prompt_envelope/effort`；per-turn one-shot 语义。
- `EventSink=Callable[[str,dict],None]`（`adapter.py:29`）：`(event_type,payload)` 是通用流式 seam；须经它路由工具/文本事件，**不走 Paperclip UI-slot bridge**。

### C. 插件执行 = one-shot sidecar（非常驻 worker）
- `invoke_cached_plugin_tool(...)` 签名+策略序（`plugin_proxy.py:135`，"执行 choke point :167"）：per-invocation 一次性 sidecar；策略序（grant→installed→tool→entitlement→config→sidecar→schema）+ `granted_plugin_ids` fail-closed 收窄（`:178`）须保留。
- `PluginProxyResult` 字段（`plugin_proxy.py:118`）+ 错误码分类法（`PLUGIN_NOT_GRANTED/SANDBOX_VIOLATION/TIMEOUT…` `:100`）：稳定契约。

### D. Worker backend / 内核执行契约
- `WorkerBackend` Protocol（`name/available/run/permission_presets/supports_containment`，`backends.py:216`）：`run(task,goal,session,limits)->WorkerResult` 是内核执行契约；`supports_containment` 默认 fail-closed（不能证明低信任围栏就**拒跑**，绝不降级）。
- `WorkerResult` 字段（`models.py:898`）：`stdout/stderr==""`（"已填充但确为空"→surface 不得回退 merged output）语义承重。
- **`WorkerLimits` 字段集（`backends.py:93`）**：`event_sink/escalation_gate/native_approval_broker/containment_policy/company_command_resolver/marketplace_command_resolver/company_read_resolver/model_override/effort_override/prompt_envelope/skill_ids/protected_cwd/native_session_*` ——**这是 prompt 字符串之外的运行时状态契约**；各带 fail-closed 语义（override 不支持须 fail-closed`:131`；resolver 为 None 须 fail-closed 且绝不抛进 agent loop）。"保 prompt 但丢/改这些字段"=破治理+投影。
- per-invocation `DEVNULL`-stdin `run_command`（`backends.py:629`，`stdin=DEVNULL:664`，`start_new_session:674`，`scrub_operator_authority_env:680`）：一次性子进程、stdin 关闭、新进程组、operator 权限 env 擦除——迁移须保**一次性进程**形态+env 擦除。
- `_resolve_model/_resolve_effort` 优先级（`backends.py:264`）：override>env>default；surface 不设就绝不强加。

### E. Chat-session / native-session / projection 状态契约（`main.py`）
- `_CHAT_CODEX_SESSIONS` 持久 codex 线程注册 + 重建键（`main.py:1817`，`extra_args/model/permission_mode/cwd` 变即重建 `:1889`）：须保"变更即重建"纪律（活会话烤入 MCP/model/sandbox/cwd）。
- `_CHAT_NATIVE_LOCKS` 每会话 native-turn 串行（`main.py:1828`）：两并发 turn 绝不 fork/交错同一 native 会话。
- `_chat_plugin_projection`→codex `-c mcp_servers` overlay（`main.py:1956`）：唯一 MCP 插件投影路径；非 MCP runtime fail-closed（`:6353`）；投影文件落 HOME 数据根（repo-hash 命名空间 `:1977`）。
- MCP 投影→`available_plugins` tool-skill 门（`main.py:1995`）：tool-skill 仅当本轮真投影且 plugin id 在可投影集才对模型广告（不得指示未接线的调用）；Pay-Switch dry-run/execute 映射是治理契约。
- `get/set_chat_native_session`（`state.py:1962`）+ `get/set_chat_codex_thread_id`（`state.py:1834`）+ capability-surface resume guard（`state.py:2055`，HARD_BLOCK on 权限放大）：native/codex 会话绑定、`last_seen_message_id` 水位、repo-move/授权放大即弃线程——破 resume 须**退绑**不得静默起空会话。
- `_CHAT_RUN_HANDLE`：纯 chat→`run_id=None`（`main.py:6010` 等）；内部 cost-ledger id 绝不外泄为 `run_id`。

### F. 事件/SSE/display/db schema
- SSE 帧 `event:<type>\ndata:<json>\n\n`（`main.py:1844`）+ chat 事件词汇（`chat.started/completed`、`delivery`、`chat.task.queued/failed` `:6282+`）：wire+surface 契约。
- Display Protocol 事件类型+envelope schema（`display_contracts.py:48`，`message.delta`/`tool.started/delta/completed`，`schema_version/seq/runtime_id/capability_tier`）：跨 surface 契约；BATCH runtime 须发 adapter diagnostic 不得伪造 live 工具事件。
- `state.db` schema（chat_sessions/runs/events/cost_events/agent_profiles/issues/company_profiles/workspace_profiles/marketplace_orders/approvals/+native-session/codex-thread/capability-surface 列）：仅增不毁（`CREATE TABLE IF NOT EXISTS`）；不得删/改名这些契约读取的列。

## 6. 给评审者的对抗任务（Codex + AGY 各自独立做，交叉验证）

阅读本文档 + 双方真实源码核实（**Paperclip 权威源=`/Users/leongong/Documents/paperclip-ref` @`6756ae8`**，super 最新 main=`packages/superclaw/src/superclaw` 与 `apps/api/main.py`），批判性验收（挑错不夸奖、不骑墙）：

1. **v2 的 4 个阻断是否真消除**：§4 全协议矩阵是否完整且处置正确（尤其 getData/performAction=UI-slot、executeTool=唯一保留、environment*=adapter、核心域=内核 MCP）？§原则2 是否已从"声明"改为"目标+验收证据+点名 HOME 缺口"（附录 A）？§5 是否补齐权限/adapter-capability/session-projection 三类？§2.3 G1–G10 是否覆盖现有 claude 策略门？
2. **七条原则自洽性**：原则 2（fs+env/secrets 目标边界）与原则 3（远程/联网自由）、原则 5（不新增 blanket 沙箱）是否一致可落地？
3. **§4 矩阵有无 RPC 误判处置**？有无遗漏方法？
4. **§5 红线有无仍遗漏的承重契约**？
5. **§2.3 G1–G10 是否足以防 stream-json 路径绕过安全语义**？有无未列门？
6. **覆盖盲区**：有无漏掉影响北极星路径的 Paperclip 模块/语义？

判据 fail-closed：发现任一真实阻断（自相矛盾/技术不可落地/违反业主既定方向/致命遗漏/破坏兼容）明确说"不通过"并指 file:line。建议性优化另列不阻塞。

---

## 7. Authorization / Access 子系统评估（**业主裁定：本轮不实现，记入路线图为未来项**）

> **决定（业主 2026-06-27）**：authorization 子系统**本轮不实现、不纳入本次设计的实现范围**；仅在路线图中**声明为未来项**。super 现有 `is_admin` + reports_to 子树 + `escalation` 人审票据治理**保持不动**。下面的评估作为**未来落地时的推荐形态记录**（推荐 partial-adopt：取可解释决策 + preview/explain，弃 RBAC 底座），不驱动本轮任何改动。§4 的 `access.*`/`authorization.*` 14 行据此按"不引入新权限模型"处置（见各行 DEFERRED 标注）。

新 checkout `paperclip-ref@6756ae8` 多出一整套企业级授权子系统（§4.B `access.*`/`authorization.*` 14 项）。业主关心"权限管理"该不该采纳它替代 super 早期 fail-closed。深挖结论如下（**记录用，非本轮实现项**）。

### 7.1 它实际是什么
**一套 grant-based RBAC 引擎**：over (company × principal × permission-key × scope) + 策略/信任 overlay + 成员/邀请生命周期 + 审计投影。多租户、多用户、服务端。
- **Principal** = `user|agent`（都是一等主体，持成员资格+grant）。**Membership** 状态 `pending|active|suspended|archived`，active 是任何 grant 生效前提（`server/src/services/authorization.ts:462`）。**Role**（仅人类 owner/admin/operator/viewer）**决策时不读**，只 seed 默认 grant（`company-member-roles.ts:21`）。
- **Permission keys 只有 8 个**（`agents:create/environments:manage/users:invite/users:manage_permissions/tasks:assign/tasks:assign_scope/tasks:manage_active_checkouts/joins:approve`，`constants.ts:725`）。**Grant** = `(company,principal,permissionKey,scope)`，scope 是自由 JSON（认 projectId/agentId/manager-subtree/prefix:，忽略未知键）。
- **决策引擎** `authorizationService.decide({actor,action,resource,scope})`（`authorization.ts:853`）：返回**富可解释结果** `{allowed, reason∈~18 枚举, explanation, grant?}`；`local_implicit` board（单机桌面业主）= 全放行；`cloud_tenant` 永不获 instance-admin。
- **亮点 = `previewAssignment`/`explainAssignment`**（`plugin-host-services.ts:2483`）：调 `decide(...)` 返回完整决策结果**但不执行动作** = "能不能让 X 接 Y、以及为什么" 的 dry-run API。**audit.search** = 在 activityLog 上按 actor/entity/action/**decision** 过滤的投影（非独立 authz 库）。
- **诚实坑**：此 checkout 里 `ensurePluginAvailableForCompany` 是 **no-op stub**（`plugin-host-services.ts:593`）——插件→宿主的 method gate **本快照里没强制**；真强制在 HTTP route 层。**引擎本身是资产，但 per-plugin 作用域门基本缺位**。

### 7.2 与 super 现状的差异
super 权限是**两个不相干的半边**，且**都不是** grant 引擎：
- **半 A 运行时 preset**（`permissions.py`）：ask/allow 都→`bypassPermissions`，**故意无决策引擎/无逐动作审批**（`:15`）。管"runtime 怎么被沙箱"，与 authorization **零重叠，别碰**。
- **半 B 公司治理**（`company_autonomy.py`+`company_scope.py`+`escalation.py`）：**派生式非 grant 式**——`is_admin`（服务端派生绝不自报）+ ownership/reports_to 子树（live 算）+ per-issue 单次消费授权。privileged 变更走 escalation（签名单次 fail-closed 人审票据）。
- **真差距**：super **无** grant 表 / 无离散 permission-key 词汇 / 无 role 档 / **无 preview-explain（决策是 throw-or-pass，无内省）** / 无结构化 authz 审计查询 / 无多用户成员邀请（**单用户设计**）。**super 更强处**：escalation 人审票据（Paperclip 无）+ **已强制**的 plugin_proxy 装备收窄（Paperclip 此处是 stub）。

### 7.3 未来推荐形态（路线图记录，**本轮不实现**）：**PARTIAL-ADOPT——移植"引擎形态"，拒绝"RBAC 底座"**
> 业主已裁定本轮不实现；以下为将来若实现时的推荐形态。

**采纳（高价值、治理自洽）**：
1. **结构化可解释 `AuthorizationDecision`**（`{allowed, reason∈枚举, explanation}`）：把 super 治理从"deny 时抛字符串"重构为"返回带 reason 码的 typed 决策"——纯增益（可测/可呈现"为何被拒"/可审计），**不改任何 allow/deny 结果**。
2. **`previewAssignment`/`explainAssignment` 作为内核 MCP RPC**（"dry-run 这条命令，返回 allow/deny+reason，不执行"）：直接落在北极星（chat→意图→内核 MCP），给表层诚实预检（"这 agent 接不了这工单,因为它在子树外"）。
3. **authorization-decision 审计投影**架在 super 可观测层（对齐 activity/metrics→内核可观测）。

**不采纳（治理不合 / 违锁定）**：
- **grant 表 + role 档(owner/admin/operator/viewer) + 成员/邀请/join-request**：这些解多租户多人 RBAC；super **显式单用户**（`is_admin` 二元）。引入会造**第二个权威事实源**与 `is_admin`+子树派生**重复**——违 CLI 唯一事实源铁律,单用户里是治理表演。**`access.invites`/join 流整条丢弃**。
- **Paperclip 的 plugin→host authz(它是 stub) + 它没有的人审票据**：super 的 escalation + plugin_proxy 装备收窄**更强且已强制**,采纳反而是回归。

**治理适配裁决（go/no-go 要点）**：payment/scan 门**正交不受影响** ✅；plugin_proxy 仍是强制者、被采纳的 preview 是只读不执行 ✅；**单用户是决定性过滤器**——引擎形态合身、RBAC 底座不合身 → partial ✅ / full ❌；CLI 唯一源 = preview/explain 必须内核原生(CLI 命令+MCP 投影) ✅。
- **额外佐证**：super `permissions.py:17` **已记录**"permission-broker 决策引擎被考虑过并因单用户过度工程而否决"——**full-adopt = 重新引入已废弃的复杂度**;partial-adopt 只取**可解释层**是高杠杆低风险。

**关键文件（供业主复核）**：Paperclip 引擎 `paperclip-ref/server/src/services/authorization.ts:853/454/315`、preview/explain `plugin-host-services.ts:2483`、**stub 门** `:593`；super `permissions.py`(运行时 preset 别碰)、`company_autonomy.py:94/151`(真 analog)、`escalation.py:16`(人审票据=super 优势)、`plugin_proxy.py:178`(已强制装备收窄=super 优势)。

---

## 附录 A — secrets/worktree 边界真相（源码核验，支撑 §原则 2）

**当前真正成立（true today）**：
- 命名密钥注入 allowlist 门控 + fail-closed（plugin 仅当 manifest 声明才得某 secret env；缺→`PLUGIN_CONFIG_REQUIRED`，`plugin_proxy.py:617-639`）。
- PATH 锁定 `SAFE_SIDECAR_PATH=/usr/bin:/bin:/usr/sbin:/sbin`（`plugin_proxy.py:71`，应用 `:611`）+ 禁字节码写。
- 低信任/未信任执行被 **fail-closed 拒绝**（claude 低信任拒跑 `backends.py:2084/2132`，低信任 review 路由到 B 类 backend 在进程内 enforce `containment_denies_read_path`）。

**尚未成立（the gap）**：
- `SAFE_SIDECAR_PASSTHROUGH_ENV_NAMES` 含 `HOME`（`plugin_proxy.py:74`）并从宿主拷贝（`:607-615`）→ sidecar 拿到宿主 HOME → 可达 `~/.superclaw`/`~/.config/superclaw`/`~/.payagent` 等密钥目录。**无真实 fs 作用域**，worktree 未作为 sidecar 的 fs 边界强制。
- `plugin_proxy` 自承 full-shell agent 不在此关闭（`:169-175`），静态 preflight 非真沙箱（`:836`），且对 `external_mcp` 整个跳过（`:848`）。
- 净：当前 enforced 属性是"未信任执行被**拒绝**而非被**围栏**"+命名密钥门；"worktree 是真实读隔离 fs/env 边界"是**待实现**。

**关闭缺口的具体工作**：
1. 从 passthrough allowlist 移除 `HOME`（并重审 `USER/LOGNAME/TMPDIR`），在 `_build_sidecar_environment`（`:607`）显式把 `HOME` 设为指向本 run worktree/tmp 的**作用域化 HOME**，使 sidecar 解析不到 `~/.superclaw`。
2. 给 sidecar/runtime 加 **OS 级 fs 作用域**（container/WASI/`sandbox-exec`/bubblewrap，或至少 chroot 式 scoped HOME + worktree 外读拒绝），让"worktree=真实 fs+env/secrets 边界"成立；静态 preflight 仅留 defense-in-depth。
3. claude 读围栏 **canary**（真二进制证 `Read()` 密钥拒绝对齐真 matcher，`backends.py:2096`）通过后才重新放行 claude 低信任；否则保持 fail-closed 拒绝。
4. 把 containment 扩展到 full-shell agent，使 `plugin_proxy.py:169-175` 的诚实承认由 backend 级 fs/env 围栏（跟随执行目标 local/SSH/sandbox）兜底。
