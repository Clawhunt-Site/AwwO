# Chat API 比对 / 零缺口审计 —— legacy `/api/*` → Node 后端

目的:Super 的 Python 服务器将被彻底淘汰,未来只剩一个 Node 后端。本文把**前端 chat 链条依赖的每一个 API**(去掉 delivery/run)逐个比对到后端落点——**复用上游原生 API,或在其函数/模块上做兼容层**——保证**零缺口 + 请求/响应格式与类型逐字匹配**。

**契约权威源**:
- **前端依赖(不可破)**:`apps/web/src/App.tsx`(下表 file:line 为前端调用点)。这是最终幸存的契约。
- **legacy Python 契约(要复刻的形态)**:`apps/api/main.py` + `models.py`/`ui_contracts.py`。
- **上游 Node 原生 API 文档**:运行期 `GET /api/openapi.json`(由 `server/server/src/routes/openapi.ts` 生成,OpenAPI 3.0 / Zod)。

**总判定**:前端的 `/api/chat/*`、`/api/backends`、`/api/agents*`、`/api/workspaces`、`/api/relay/*`、`/api/team/*`、`/v1/skills`、`/api/preview/*`、`/api/onboarding`、control-token —— 上游**无一同路径同形态**(上游是 `/api/companies/:id/issues`、`/api/issues/:id/comments`、`/api/adapters`、`/api/companies/:id/events/ws` 等)。⇒ **几乎全部需"兼容层端点"**:保留 legacy 路径+形态给前端,内部调上游 service/表。下表逐个给出落点、匹配、缺口。

图例:**复用**=直接转发上游;**兼容层**=新建 legacy 路径、内部翻译;**丢弃**=delivery/run,不要了;**stub**=保留端点但返回空/降级。

---

## A. 核心 chat 会话(读 + 管理)

| legacy 端点 | 前端用?(file:line) | 后端落点 | 请求匹配 | 响应匹配 | 缺口 |
|---|---|---|---|---|---|
| `GET /api/chat/sessions?personal_only&include_archived` | ✅ `App.tsx:10368` | **兼容层** → 列 `originKind="chat"` issues(personal_only=local 公司)+ 各自 `issue_comments`(滤 `deletedAt`),投影 `BackendChatSession[]` | query `personal_only/include_archived/workspace/unassigned` 照搬 | 须输出 `{sessions:[{session_id,title,created_at,updated_at,messages[],metadata,workspace_id,archived,pinned_at}]}`(epoch 秒)——见 §D | **无原生**;兼容层必建 |
| `GET /api/chat/sessions/:id` | ⚠️ 前端当前**不单独拉**(list 带 messages) | **兼容层**(仍建,detail+全 comments) | 照搬 | 同上 + 完整 messages | 兼容层建,低优先 |
| `POST /api/chat/sessions/:id/pin` `{pinned}` | ✅ `:7873` | **兼容层** → pin 偏好(复用偏好层/metadata,不 ALTER 核心表) | body `{pinned:bool}` | 返回 `BackendChatSession` | 兼容层 |
| `POST /api/chat/sessions/:id/archive` `{archived}` | ✅ `:7893/:8005` | **兼容层** → `issues.hiddenAt`(set/clear) | body `{archived:bool}` | 同上 | 兼容层(`updateIssue{hiddenAt}` 可复用) |
| `POST /api/chat/sessions/:id/move` `{workspace_id,acknowledge_boundary_change}` | ✅ `:8039` | **兼容层** → 改 issue 的 workspace 绑定 + 存在性校验(404)+ 边界 409 | body `{workspace_id,acknowledge_boundary_change}` | 同上 + `execution_boundary_changed` | 兼容层(注:边界 409 待 stream 刀有 resume 状态再全实现) |

## B. chat 回合(流式)—— **核心**

| legacy 端点 | 前端用? | 后端落点 | 请求匹配 | 响应匹配 | 缺口 |
|---|---|---|---|---|---|
| `POST /api/chat/stream` (SSE) | ✅ `:8407` | **兼容层桥**:存 user comment → `heartbeat.wakeup(agentId,{payload:{issueId,commentId}})` → 订阅 `subscribeCompanyLiveEvents` 过滤本 run 的 `heartbeat.run.log` + adapter `onLog` → 翻译成 chat SSE 事件 → 存 assistant comment | **请求体须收全** `ChatTurnRequest` 子集:`message,session_id,mode,model,effort,backend_policy,repo_path,workspace_id,budget_seconds,verification_policy,permission_preset,context_refs[],attachments[]`(§D 类型) | **SSE 事件名须逐字**:`chat.started{session_id,...}`、`message.delta{text}`、`message.completed{text}`、`chat.completed{status,response,failure_reason?,run_id?,backend?,usage?,elapsed_ms?}`;能力够则 `tool.*/reasoning.*/usage/adapter.diagnostic`(DisplayProtocol 信封)| **无原生**(上游 `board-chat.ts` 是 `start/chunk/done` 不兼容);兼容层必建 + DisplayProtocol 桥(slice ⑤) |
| `POST /api/chat/turn`(非流式) | 兼容性入口 | **兼容层** 同上非流式版 | 同 `ChatTurnRequest` | `{intent,session_id,run_id,turn_id,status,backend,response,failure_reason,display_events}` | 兼容层(stream 落地后薄包) |
| `POST /api/chat` / `/api/chat/direct` | legacy 兜底 | **兼容层** 薄包(direct=无 session 一发) | 见 legacy | 见 legacy | 低优先兼容层 |
| **`delivery` SSE 事件 / intent=delivery** | — | **丢弃** | — | — | 业主拍板去掉 |

## C. composer 运行时选择(model/effort/backend)

| legacy 端点 | 前端用?(读什么) | 后端落点 | 缺口 |
|---|---|---|---|
| `GET /api/backends` → `BackendInfo[]` | ✅ `:9034` | **兼容层** → 上游 `GET /api/adapters`(+capabilities)投影成 `BackendInfo`(name/label/supports_model_selection/default_model/suggested_models/supports_effort_selection/effort_levels/effort_input_mode/default_effort/uses_relay_packages/chat_capable/chat_tier)| 上游 `/api/adapters` 形态**不同**,须翻译 |
| `GET /api/agents` → agents+summary | ✅ `:9263` | **兼容层** → 同上 + `{summary:{count,ready_count}}` | 上游 `/api/companies/:id/agents` 是公司 agent,非 runtime 清单——**语义不同**,兼容层须由 adapters 投影 |
| `GET /api/agents/:backend/models?refresh` → `{models,source}` | ✅ `:6048` | **兼容层** → 上游 `GET /api/companies/:id/adapters/:type/models` | 路径/参数不同,翻译 |
| `GET /api/relay/packages` | ✅ `:6065` | **复用/移植**:relay 套餐(core/plus/max)逻辑(super 专属,非上游)——需在 Node 重做或经 LLMgate | 上游无;**自建** |
| `GET /api/relay/usage` `/api/relay/status` `/api/relay/balance` | ✅ `:6098` | **自建**(super relay-key 链,经 LLMgate) | 上游无;自建 |
| `GET /api/agents/probe?backend` → `{probes}` | ✅ `:8621` | **兼容层** → 上游 adapter test-environment(`POST /api/companies/:id/adapters/:type/test-environment`)投影 | 路径/形态不同,翻译 |

## D. workspace / sidebar / 其它 chat 表面依赖

| legacy 端点 | 前端用? | 后端落点 | 缺口 |
|---|---|---|---|
| `GET /api/workspaces` → `{count,workspaces[],unassigned_session_count}` | ✅ `:8079` | **兼容层** → 由 `project_workspaces`/`execution_workspaces` + chat-issue 计数投影 `WorkspaceInfo`(workspace_id/name/kind/pinned_at/builtin_chat/...)| 上游有 workspace 系列但形态不同;翻译 |
| `POST /api/workspaces` / `:id/pin` / `PATCH :id` / `DELETE :id` | ✅ `:8079/:7943/:7960/:7979` | **兼容层** → 上游 project-workspace CRUD + 偏好 | 翻译 |
| `GET /api/team/messages` → `{total_unread}` | ✅ `:6838` | **兼容层/复用** → 上游 sidebar-badges/inbox 未读聚合 | 翻译 |
| `GET /api/team/companies` → `{companies[]}` | ✅ `:6866` | **复用** → 上游 `GET /api/companies` 投影 | 翻译字段名 |
| `GET /v1/skills` → `{skills[]}` | ✅ `:6896` | **兼容层** → 上游 company-skills / skills catalog 投影 | 翻译 |
| `POST /api/runtime/control-token/rotate` → `{control_token}` | ✅ `:8475` | **自建**(local 单操作者 token);或 desktop sidecar 层 | 上游用 Better-Auth,自建 |
| `POST /api/preview/tickets` + `GET /api/preview/:ticket` | ✅ `:8327/:8339` | **移植**(reference-viewer 服务端净化快照,super 专属) | 自建/移植 |
| `GET /api/onboarding` + `POST /api/onboarding/complete` | ✅ `:6645/:6658` | **兼容层** → 存 instance-settings/偏好 | 翻译 |
| **live 更新 WS** | 经 chat.stream SSE(本设计) | **复用** 上游 `GET /api/companies/:id/events/ws`(`heartbeat.run.log`),由 stream 桥消费 | 复用 |

## E. 丢弃(delivery / run,业主拍板)

`GET /api/runs`、`GET /api/runs/:id/events`、`/events/snapshot`、`/evidence`、`/cancel`、`/human-gate`、`/resume`、`/fanout`、`/expand`、`/artifacts`、`/files`、`delivery` SSE、intent=delivery —— **全部不要**。
- ⚠️ 前端仍会调 `GET /api/runs`(轮询在飞 run,`App.tsx:9016`)与 run cockpit SSE(`:8457`)。chat-only 下无 delivery run ⇒ **`/api/runs` 返回空数组 stub**、run-events 不接;确认前端对空/404 优雅降级(try/catch 已有)。
- 注:新 issue-centric 模型里 chat 回合内部仍会起一个 heartbeat run(有 run_id)。**契约取舍**:`chat.completed` 是否暴露该 run_id?legacy 纯 chat=run_id null。建议 stream 刀**对纯 chat 仍报 run_id=null**(隐藏内部 heartbeat run),只在前端不发 `delivery` 事件即不进 cockpit——保持 legacy 语义。

## F. 须逐字复刻的类型(摘 §A/B 关键,防类型不匹配)

```
BackendChatSession = { session_id:string; title:string; created_at:number(epoch秒);
  updated_at:number; messages:BackendChatMessage[]; metadata?:object;
  activity?:{status,is_live,run_id?,effective_run_status?,reason?,legacy_incomplete_tail?};
  workspace_id?:string|null; archived?:boolean; pinned_at?:number|null }
BackendChatMessage = { role:'user'|'assistant'|'system'; content:string; status?:string;
  run_id?:string|null; created_at?:number; context_refs?:ComposerContextRef[];
  usage?:Record<string,number>|null; elapsed_ms?:number|null }   // 注:前端无 message_id 字段,多发无害
ComposerContextRef = { type:'chat_session'|'run'|'evidence'|'plugin'|'message'|'artifact'|'file'|'company'|'company_create';
  id:string; label?:string; source?:string; visible_token:string; metadata?:object }
ChatAttachment = { kind:'file'|'image'|'local_path'; name?; path?; mime?; size?:int; data_url?; source? }
BackendInfo = { name; label?; supports_model_selection?; default_model?; suggested_models?;
  supports_effort_selection?; effort_levels?; effort_input_mode?:'select'|'text'|null;
  default_effort?; uses_relay_packages?; chat_capable?; chat_tier?; config_state?; model_state?; ... }
```
- **认证**:前端发 `X-SuperClaw-Token` 头(非 cookie)。兼容层须接受它→映射 local board actor(上游 `local_trusted` 自动给 `local_implicit` board);并自建 control-token rotate。
- **SSE 事件名/字段逐字**:见 §B(`chat.started/message.delta{text}/message.completed{text}/chat.completed{...}`)。DisplayProtocol 信封 `schema_version/seq/ts/runtime_id/capability_tier/payload`,前端 `display_contract.fixture.json` 锁死——接 tool/reasoning 时必须对齐。

## G. 缺口总账(零缺口要建/移植的清单)

**必建兼容层端点**(legacy 路径+形态,内部翻译上游):
1. `GET /api/chat/sessions[/:id]`、`POST /api/chat/sessions/:id/{pin,archive,move}`
2. `POST /api/chat/stream`(+ `/turn`、`/api/chat`、`/api/chat/direct` 薄包)+ DisplayProtocol 桥
3. `GET /api/backends`、`GET /api/agents`、`GET /api/agents/:backend/models`、`GET /api/agents/probe`(由上游 `/api/adapters*` 投影)
4. `GET /api/workspaces` + workspace CRUD/pin、`GET /api/team/messages`、`GET /api/team/companies`、`GET /v1/skills`、`GET/POST /api/onboarding`
**须自建/移植**(上游无对应):
5. `GET /api/relay/{packages,usage,status,balance}`(super relay-key/LLMgate)
6. `POST /api/runtime/control-token/rotate`、`POST /api/preview/tickets`+`GET /api/preview/:ticket`
**复用上游**:
7. live-events WS(`/api/companies/:id/events/ws`)、issues/comments/adapters/companies/project-workspaces 作为兼容层的内部后端
**丢弃**:
8. 全部 `/api/runs*` + delivery(`/api/runs` stub 空数组兜底前端)

**结论**:无不可弥合的缺口。chat 链条可 100% 在 Node 后端上复刻——绝大多数走兼容层(legacy 形态薄壳 + 上游 service),少数 super 专属(relay/preview/control-token)自建/移植,delivery/run 丢弃。按 slice 顺序逐刀落地 + Codex 门。
