# Spike A — Chat-on-Paperclip resume-loop feasibility gate

状态:**GATE — 结论 GO(有条件)**。本文是动手前的可行性门,不含产线代码。
分支 `feat/chat-compat-layer`(基:`dev/server-refactor` @ vendored Paperclip `f3f50e2`)。
所有 `server/...` 行号基于该 vendor。

---

## 0. 方向(业主拍板,作为公理)

super WebUI chat **整体落到 Paperclip 原生对话链路**:引擎换成 Paperclip,前端 `/api/chat/*` 契约不变。**复用表、不新增表**。每个 chat **锚定一个稳定 `issueId`**——它同时是 `agent_task_sessions` 续接的 `taskKey`,也是新输入的 comment 注入点(一石二鸟)。映射:`agent_task_sessions`(续接)+ `issue_comments`(线程)+ `heartbeat_runs`(run)+ live-events WS(流)+ plugin/skill 注入。

**Spike A 要回答的门问题:** 在不新增表的前提下,能否用 Paperclip 现有件,让一个 chat 锚定到稳定 issueId、跨轮 resume 适配器原生会话、把每轮存成 comments、流式回前端?

---

## 1. resume 闭环 —— 可行(已逐行核实)

`agent_task_sessions`(`server/packages/db/src/schema/agent_task_sessions.ts`):列 `companyId/agentId/adapterType/taskKey/sessionParamsJson/sessionDisplayId/lastRunId/lastError`,**唯一键 `(companyId,agentId,adapterType,taskKey)`**。

机制(`server/server/src/services/heartbeat.ts`):
- `taskKey` 推导 `deriveTaskKey`(`:2287`)优先级:`contextSnapshot.taskKey → taskId → issueId → payload.*`。**取 `payload.issueId` 即得"每 chat 一稳定 taskKey"**。
- run **前**:`getTaskSession(companyId,agentId,adapterType,taskKey)`(`:3775`)→ `sessionCodec.deserialize(sessionParamsJson)` → 喂 `runtimeForAdapter.sessionParams/sessionDisplayId`(`:9405`)→ `adapter.execute`(`:9721`)。
- run **后**:`resolveNextSessionState({codec,adapterResult,previousParams})`(`:3381`)→ `upsertTaskSession(sessionParamsJson=serialize(...))`(`:4958`/`:10095`)。
- `sessionCodec`(`adapter-utils/src/types.ts:105`)`serialize/deserialize/getDisplayId`,经 `getAdapterSessionCodec`(`:3342`)取每 adapter 实现,缺省回退 `defaultSessionCodec`。

**结论:续接是现成的、与 chat 无关的原语。** 锚 `taskKey=issueId` 即可零改内核复用。

## 2. chat = issue + comments —— 可行

- **issue 最小创建**:`issues` 必填仅 `companyId + title`(`projectId` 可空,`status` 默认 backlog)——`issueService.create`(`server/server/src/services/issues.ts:5006`)。可建"chat 伪 issue",无需 board/project 仪式。`issue.id`(uuid)或 `issue.identifier`(PAP-N)都稳定;**锚用 `issue.id`**(uuid,直接作 taskKey,免 prefix 依赖)。
- **turn 存 comments**:`issue_comments`(`schema/issue_comments.ts`)`body`(必)+`authorType`(user/agent/system)+`metadata`(jsonb 结构化 sections)+`createdByRunId`+`presentation`。`addComment(issueId, body, actor, options)`(`services/issues.ts:6175`)。
- **新输入注入**:发 user comment → `heartbeat.wakeup(agentId, {payload:{issueId, commentId}})`(通用 wakeup 转发 payload 在 `routes/agents.ts:3294-3299`)→ `buildPaperclipWakePayload` 取 comment 正文进 wake 上下文 → agent run。**issueId 一锚两用印证**。
- **流式**:run 的 `onLog` → `publishLiveEvent({type:"heartbeat.run.log"})`(`heartbeat.ts:9563`)→ 订阅经 **WS** `GET /api/companies/{companyId}/events/ws`(`realtime/live-events-ws.ts`)。**无 HTTP SSE,仅 WS。**

## 3. 摩擦点与复用化解(坚持"不新增表")

| 摩擦 | 化解(复用,不新增表) |
|---|---|
| **个人 chat 无 company**(`issues.companyId` NOT NULL) | 挂到单例 **"local" 公司**的 issue —— 正是 Super 既有 `personal_only = unassigned + company="local"` 语义(`App.tsx:10361` 注释)。开机 ensure 一个 local 公司即可。**非阻断**。 |
| **per-turn usage / elapsed / context_refs / status** | 进 `issue_comments.metadata` 结构化 sections + `presentation.kind`;`run_id` → `comment.createdByRunId`。**comment 自带,零新表**。 |
| **message role(assistant vs agent)** | `authorType` + `presentation.kind` 区分 assistant_turn / user_input / system_event。 |
| **archived** | `issues.hiddenAt`(软删时间戳)→ `archived = hiddenAt IS NOT NULL`。 |
| **pinned_at** | 复用既有偏好层(`sidebar_preferences`/`sidebarPreferenceService`)或 issue `metadata`;**避免 ALTER 核心 vendored 表**(vendor drift)。建 slice 时定,但不新增表。 |
| **sticky runtime(backend/model/effort)** | 进 issue/comment `metadata.runtime`(对齐 Super `to_dict` 的 `metadata.runtime`),或 agent 的 runtimeConfig。不新增列优先。 |

> 注:vendor 是**死拷贝**,凡能用 metadata/既有偏好表承载的 UI-only 字段,**一律不 ALTER 核心表**,以免合回上游时漂移。

## 4. `/api/chat/*` 映射(前端契约不变)

前端调用(`apps/web/src/App.tsx`):`GET /api/chat/sessions?personal_only&include_archived`、`POST /api/chat/sessions/:id/{pin,archive,move}`、`POST /api/chat/stream`(SSE 解析 `event:` 名)。`BackendChatSession`/`BackendChatMessage` 形态见 `:762`/`:785`。

| `/api/chat/*` | Paperclip 落点 |
|---|---|
| `GET /sessions` (personal_only) | 列 local 公司(或选定公司)下的 chat-issue + 各自 comments → 旧 wire shape |
| `GET /sessions/:id` | issue + 全部 comments |
| `POST /sessions/:id/pin·archive·move` | pin=偏好层;archive=`hiddenAt`;move=改 issue 的 workspace 绑定 |
| `POST /stream` | **per-turn SSE 桥**:存 user comment → `heartbeat.wakeup(issueId,commentId)` → 订阅该 run 的 live-events(`heartbeat.run.log`)+ adapter `onLog` → 翻译成 `chat.started/message.delta/message.completed/chat.completed`;存 assistant comment |

**关键桥**:前端要 SSE,Paperclip 原生是 WS。`/api/chat/stream` 自己持一条 SSE 连接,内部订阅 `subscribeCompanyLiveEvents` 过滤本 run 事件,再以 chat 事件名重发。这是表现层桥,不改内核语义。

## 5. 门结论:**GO(有条件)**

- ✅ resume 闭环、issue 锚、comments 线程、wakeup 注入、live-events 流——**全部现成,不新增表**。
- ✅ 个人 chat 经 "local" 公司化解(Super 既有语义)。
- ⚠️ **三个待定(不阻断 GO,建 slice 时定)**:
  1. **adapter.execute 流式粒度**:`onLog` 在 claude 路径成立,其它 adapter 的增量粒度需逐一验证;不支持的退化为终态返回(非流式),需在 `capability_tier` 标注。
  2. **"桥第 6 类 display 事件"**:前端 DisplayProtocol(`display_contract.fixture.json`)的 tool/reasoning/usage 事件如何从 run 的 `heartbeat.run.log` 投影——需复用 adapter 的 `ui-parser`,单列一刀。
  3. **pin/runtime 承载**:定"偏好表 vs metadata",坚持不 ALTER 核心 vendored 表。
  4. **issue_comments 语义两点(Codex 验门发现,已核实,非阻断)**:① `listComments` 不滤 `deletedAt`、删除项经 `redactIssueComment` 变空 body tombstone(`services/issues.ts:3376/6062`)——chat 读投影**必须自己滤 `deletedAt IS NULL`**,否则历史里冒空轮;② 用户名脱敏是**读侧**且受 `censorUsernameInLogs` 开关控(`redactCurrentUserText`,`:3395`),**存储为原文**——本地单操作者该开关通常关,chat 读不被改写;若开,需走不脱敏的读路径或接受。两点都在 read 面那一刀处理。

## 6. 建议 build slices(GO 之后,逐刀 Codex 门)

1. **Spike A 验证刀(可选但建议)**:进程内/真 DB 证明 `upsert→get→sessionCodec 往返`保真 + 建 chat-issue + 写两条 comments 读回(证明持久化闭环),无需真模型。
2. **read 面**:`GET /api/chat/sessions[/:id]` 从 local 公司 chat-issues + comments 投影旧 wire shape。
3. **stream 面**:`POST /api/chat/stream` = 存 user comment → wakeup → live-events→SSE 翻译 → 存 assistant comment;`run_id` 来自 heartbeat run。
4. **管理面**:pin/archive/move 复用偏好层/`hiddenAt`/workspace 绑定。
5. **DisplayProtocol 桥**:tool/reasoning/usage 事件投影(复用 ui-parser)。
6. **skill/plugin 注入**:复用 `paperclipRuntimeSkills` + `ensureRuntimeServicesForRun`(原生 adapter→runtime,见记忆配方)。

---

**一句话:门通过。** chat 能在不新增表的前提下,锚到 issue、用 agent_task_sessions 续接、comments 当线程、heartbeat 跑 run、WS→SSE 桥流式;个人 chat 走 "local" 公司。下一步从 slice 1(验证刀)或直接 read 面起,逐刀走 Codex 门 + 本地原子提交。
