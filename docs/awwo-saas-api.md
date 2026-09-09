# AwwO SaaS API v1

适用分支：`codex/awwo-node-setup-20260908`；worktree：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-node-setup-20260908`。更新日期：2026-09-08。本文记录实现契约，不代表本轮真实模型或生产验收已通过。

实现：`backend/internal/app/`。本地前端同源代理 `/api/v1`；直接访问 Go 默认为 `http://127.0.0.1:8087/api/v1`。所有受保护端点使用 `awwo_session` HttpOnly cookie；health、注册和登录不要求已有会话。JSON 写请求使用 `Content-Type: application/json`，未声明的字段会被拒绝。请求携带 Origin 时必须与 `AWWO_PUBLIC_ORIGIN` 一致，跨站 Fetch 请求被拒绝；非浏览器客户端可省略 Origin，仍需有效登录 cookie。不会通过 JSON 返回模型密钥或原始登录 session token；邀请创建响应单独返回一次邀请凭据。

集合响应保留 `{"items":[]}`；六类租户资源列表和四类平台管理列表增加 `nextCursor`、`snapshot`，客户端必须翻页才能取得后续记录。单对象直接返回。错误结构为 `{"error":{"code":"not_found","message":"Resource not found"}}`。跨租户资源返回 404；权限不足 403；未登录 401；CAS/幂等/会话占用冲突 409；当前提示词和指令超过模型保守上下文预算时返回 413 / context_limit；配额或限流 429；模型不可用 503。分页契约见下文，其他未声明分页的集合不自动获得此契约。

## 当前用户资料与邀请

此节与 Go 实现和本轮真实 PostgreSQL 回归相对应，浏览器使用同一契约。实际验证范围见本地验收记录。

| 方法与路径（省略 /api/v1） | 输入 | 结果与权限 |
| --- | --- | --- |
| PATCH /auth/profile | `{name}`，trim 后 1–120 Unicode 字符 | 200，当前登录者资料 `{id,email,name,isPlatformAdmin}`；不接受其他用户 ID；写入审计 |
| GET /tenants/{tenantId}/invites | limit?, cursor? | admin/owner 可查 `{items:[{id,role,createdBy,createdAt,expiresAt,status,acceptedBy,acceptedAt,revokedAt}],nextCursor,snapshot}`；后三项未发生时为 null；不返回 token/hash |
| POST /tenants/{tenantId}/invites | `{role,expiresInHours?}` | role=reader/member/admin；仅 owner 可授 admin；默认 72 小时，整数 1–168；201 `{id,role,expiresAt,inviteUrl,token}` |
| DELETE /tenants/{tenantId}/invites/{id} | 无 | 204，admin/owner 撤销邀请；只有 owner 可撤销 admin 邀请；已撤销重试幂等，已消费返回 409 / invite_used |
| GET /invites/{token} | 登录态 | `{tenantId,tenantName,role,expiresAt,status}`，供加入前确认；不通过 GET 消费 |
| POST /invites/{token}/accept | 登录态 | `{tenantId,role}`；单次领取，同领取者重试幂等；已有成员保留已有角色 |

`PATCH /auth/profile` 使用 `isPlatformAdmin:boolean`，而 `/auth/me` 的 user 仍使用 `platformRole:'user'|'admin'`。原账户面板的 SaaS 适配器仅合并成功返回的 name，不将这两种字段混为同一响应。

邀请 URL 为 `AWWO_PUBLIC_ORIGIN + /?invite=TOKEN`。注册或登录保留 URL 参数，但不会自动领取。新用户注册仍创建自己的工作区，之后再确认加入受邀工作区。数据库仅保存 token 哈希，明文只在创建响应及复制链接中出现，列表不能重新找回原链接；浏览器不将邀请码写入 localStorage。没有邮件投递。

预览 GET 不消费凭据：已知 token 返回 200 与 `status=active|expired|revoked|accepted|unavailable|suspended`；未知 token 返回 404。`unavailable` 表示发行者当前已无权授予该角色。领取 POST 对未消费的过期/撤销邀请分别返回 410 / invite_expired、invite_revoked，他人已领取返回 409 / invite_used，发行者失权返回 403 / invite_unavailable，暂停租户返回 403 / tenant_suspended。有效领取返回数据库中的当前 role，已有成员不被提升或降级。同领取者仍有成员资格时重试幂等，即使邀请后来已过期；若该用户已被移出工作区则返回 409 / invite_membership_removed，旧链接不能重新赋权。

## 租户列表分页

`/tenants/{tenantId}/{members,canvases,agents,sessions,runs,invites}` 接受 `limit`（整数 1–200，默认 200）与不透明 `cursor`，返回 `{items,nextCursor,snapshot}`；末页 `nextCursor=null`。首次省略 cursor，后续保留同一过滤条件。游标签名绑定当前账号、租户、资源、规范化过滤条件和首次创建时间边界。空值、重复、伪造、跨范围或 API 重启后的 cursor 返回 400 / invalid_cursor；非法 limit 返回 400 / invalid_pagination。每页重新检查当前权限，不能凭旧游标绕过成员撤销。

记录按不可变创建时间与 ID 降序，成员使用 membership.createdAt/userId；改名不改变分页位置。sessions 可同时使用 `canvasId`、精确 `sessionId`；runs 可使用 `sessionId`、`operationId` 与 `active=true`（queued/running），`active=false` 不限制运行状态。活动 run 若在翻页期间结束，将不再满足后续页的活动过滤。`snapshot` 是创建时间边界，不会冻结更新，也不隔离晚提交的旧事务，因此不是数据库一致性快照。画布、成员与邀请 UI 每页 50 条；历史恢复优先查询确切 session，不依赖首 200 条。

## 当前账号配色

| 方法与路径（省略 /api/v1） | 输入 | 结果与权限 |
| --- | --- | --- |
| GET /appearance | 登录态 | 原配色目录（11 预设、10 token）及 active_preset、custom、version；仅当前账号 |
| PUT /appearance | `{active_preset,custom:{light:{},dark:{}},version}` | 成功返回完整状态且 version 加一；初始为 0，陈旧值 409 / version_conflict；非法值 400 / invalid_appearance |
| GET /appearance/export | 登录态 | `{kind:'superclaw.appearance',schema_version:'0.1.0',active_preset,custom}`，无身份和版本 |

迁移 006 按 user_id 保存到 PostgreSQL。仅目录中的预设、token 和合法 hex 色值可写，不接受自定义 CSS、其他用户 ID 或额外字段。SaaS 复用原配色弹窗，按登录用户载入、切换账号清除旧配色，连续操作串行保存；冲突由用户重新加载后决定下一次修改。导入原格式 bundle 后用当前已加载 version 调用 PUT。浏览器导出已确认的服务端状态，网络响应丢失时不得断言保存未发生。语言与浅深主题仍为浏览器偏好，配色为账号级状态。

## 平台列表分页

四类平台列表 `/admin/tenants`、`/admin/users`、`/admin/runs`、`/admin/audit` 接受 `limit`（整数 1–200，默认 200）及不透明 `cursor`，返回 `{items,nextCursor,snapshot}`；`nextCursor=null` 表示结束，首次请求省略 cursor。排序为 `(createdAt DESC,id DESC)`；游标签名绑定列表、当前管理员、最后一项和首次读取时间边界。非法 limit 返回 400 / invalid_pagination，空值、重复、伪造、跨列表或跨管理员 cursor 返回 400 / invalid_cursor。API 重启后旧签名失效，客户端需刷新列表重新开始。

范围按 `createdAt <= snapshot` 限定；晚提交但 createdAt 较早的事务仍可能在后续页可见。`AdminPanel` 界面每页 50 条，`adminData.collectAdminExport` 按 200 条逐页读取到 nextCursor=null，下载 `{resource,insertionBoundary,exportedAt,count,items}`。已有记录字段仍可能在读取过程中变化，这不是数据库一致性快照或备份。失败与取消不下载半份结果，服务端不能返回密码哈希或会话/模型秘密。

## 身份与工作区

| 方法与路径（省略 /api/v1） | 请求 | 响应 / 权限 |
| --- | --- | --- |
| GET /health | 无 | 数据库健康与 environment，公开 |
| POST /auth/register | email, password, name, tenantName | 201，设置 cookie，返回 user/tenants；密码至少 12 字节 |
| POST /auth/login | email, password | 200，设置 cookie，返回 user/tenants |
| POST /auth/logout | 无 | 204，服务端 session 失效并清 cookie |
| GET /auth/me | 无 | user{id,email,name,platformRole}, tenants[] |
| GET /tenants | 无 | 当前用户的租户列表 |
| POST /tenants | name | 201，创建租户，当前用户成为 owner |
| GET /tenants/{tenantId}/members | limit?, cursor? | `{items,nextCursor,snapshot}`；reader 以上 |
| POST /tenants/{tenantId}/members | 已注册用户 email, role | admin 以上；只有 owner 可任命 admin |
| PATCH /tenants/{tenantId}/members/{userId} | role | 204；不允许通过此 API 改动 owner |
| DELETE /tenants/{tenantId}/members/{userId} | 无 | 204；受保护角色不能被低权限成员移除 |

可分配角色为 reader、member、admin；owner 由租户创建产生，首版不提供所有权转移。这里的添加成员要求目标用户已注册，不会发送邮件邀请。平台管理员由 `AWWO_BOOTSTRAP_ADMIN_EMAIL/PASSWORD` 配置在 API 启动时创建；若相同邮箱已是普通用户，启动拒绝自动提权。已有管理员不会被启动参数静默重置密码。

## 画布与 Agent

以下路径均以 `/tenants/{tenantId}` 开头。读需 reader，业务写需 member。

| 方法与后缀 | 请求 | 说明 |
| --- | --- | --- |
| GET /canvases | limit?, cursor? | 当前租户画布，`{items,nextCursor,snapshot}` |
| POST /canvases | name, document | 创建画布，201 |
| GET /canvases/{id} | 无 | id, tenantId, name, document, version, createdAt, updatedAt |
| PUT /canvases/{id} | name, document, version | version 必须是上次读取值；成功递增，陈旧值 409 |
| POST /canvases/{id}/initialize | documentVersion, scope? | 根据已保存文档准备节点 Agent / Session，200 返回完整 canonical 画布；不执行模型 |
| DELETE /canvases/{id} | 无 | 成功 204；关联节点或规划 run 为 queued/running 时 409 / resource_in_use，拒绝时不改运行、事件或审计 |
| POST /canvases/{id}/plan | prompt, context, operationId | 202，创建持久规划 run；空画布也可使用，共享运行限额和 SSE |
| GET /agents | limit?, cursor? | Pi Agent 列表，`{items,nextCursor,snapshot}` |
| POST /agents | name, role?, title?, model?, adapterConfig?:{model}, instructions?, adapterType? | adapterType 省略或为 pi；model 非空时优先，否则取 adapterConfig.model；role 是 Agent 工作角色文本，不是用户权限 |
| GET /agents/{id} | 无 | 已保存的 Agent 定义 |
| PUT /agents/{id} | 同创建字段 | 更新定义 |
| PUT /agents/{id}/instructions | content | 保存纯文本指令，不能上传可执行扩展 |
| DELETE /agents/{id} | 无 | 已被 session 引用时拒绝 |
| GET /runtime（不带 tenant 前缀） | 无 | engine, configured, available, plannerAvailable, models[{id,provider}], modelConnectivityVerified, limits, reason?；登录即可 |

Agent 响应包含 `{id,tenantId,name,status:'active',model,role,title,instructions,adapterType:'pi',adapterConfig:{model},createdAt}`；原绑定适配器使用 adapterConfig.model。服务器保存的非空 model 必须属于服务端模型目录才能运行；目录包含默认模型与 `AWWO_PI_MODELS_JSON` 配置档。前端不能在 Agent 定义中提供工具、模型 URL、工作目录或环境变量。内部 planner Agent 与 session 不出现在普通 Agent / session 列表。

`runtime.available` 和 `plannerAvailable` 表示 Pi 配置健康探测通过；`modelConnectivityVerified` 当前固定为 false，不在探测时执行推理。Pi health 可读时 `limits` 含 `contextWindow`、`maxOutputTokens`、`maxContextTextBytes`、`messageOverheadBytes` 及 `promptChars/systemPromptChars/historyMessageChars/historyMessages/totalTextChars/bodyBytes` 传输限制，不可读时可为 null。RuntimeSettings 展示引擎、服务状态、模型和原因并支持刷新；模型连接仍由服务管理员配置，不提供浏览器秘密写接口。真实 provider 是否可用必须另做实际运行验收。

规划返回标准 run。Go 在规划完成并验证 JSON/操作白名单后才发布规范化 JSON 到 completed.text / run.output，不把未验证规划 delta 暴露给前端；原画布随后验证 schema、图引用、环路和当前版本，合法结果直接应用并保存，提供撤销，没有第二个应用确认按钮。

画布创建示例：

```json
{
  "name": "项目画布",
  "document": {
    "version": 2,
    "updatedAt": 0,
    "nodes": [],
    "edges": [],
    "waypoints": [],
    "view": null
  }
}
```

画布 document 的实际前端结构以 `canvas/canvasDoc.ts` 为准，API 外层 version 与 document 自身格式版本不同。

### 节点初始化与配置保存

`POST /tenants/{tenantId}/canvases/{id}/initialize` 只读取已保存画布，不接受另一份 document、Agent 定义或供应商连接信息。请求示例：

```json
{"documentVersion":12,"scope":["research-node","review-node"]}
```

`documentVersion` 必填、整数且至少为 1，必须匹配当前 API 外层版本。省略 `scope` 处理全部 session 节点；传入时必须为 1–200 个已有、不重复的 session 节点 ID，空数组、null、form 节点和未知 ID 返回 `400 invalid_scope`。form 节点本身不需要初始化。

Go 在事务中重新检查 member 以上权限、租户 active 状态及画布归属，锁定画布并比较版本。过期版本返回 `409 version_conflict`；当前画布存在 queued/running 的图、节点或规划任务时返回 `409 resource_in_use`。已有 Agent 绑定必须属于当前租户；当前及历史会话还需属于当前画布和节点，并与声明的 Agent 引用一致。伪造或跨范围引用返回 `404 not_found`。选中节点全部成功后才提交，有任一错误则整体回滚。

选中 session 节点时需要 Pi health 可读，失败返回 `503 runtime_unavailable`，健康检查不会执行推理。空 runtime 解析为 `pi`，空 model 解析为 Pi 当前默认模型，非空 model 必须在服务目录；支持 `llm` 与 `coding`，不接受图像类型、其他 runtime 或非空 effort。非法节点、团队或模型返回 `400 invalid_node_setup`。初始化不占用模型调用次数，也不证明供应商真实推理连通。

响应为 `{id,tenantId,name,document,version,createdAt,updatedAt}`。document 回填实际 `runtime/model/binding/issueId/activeThreadId/threads`；客户端必须使用这份 canonical 文档及其版本继续执行。首次准备创建 Agent 与 node Session；与已初始化的有效配置快照相比，名称、类型、模型、人格或团队变化会建立新的 Agent / 当前会话，保留历史身份与消息，清空新会话的旧交付。成员继承值在 `node_sessions.setup_snapshot` 中按实际值比较；仅把“继承”改写为相同显式值不会额外分叉。team 仍为节点级配置，旧 run 的执行快照保持不变。

规范化后的文档无需变化时，初始化返回相同版本，不重复创建 Agent / Session，不仅为了复制新的预览而改写当前 thread。文档变化时版本加一并记录 `canvas.initialized`。这是按当前状态与 CAS 实现的重复调用保护，不提供 operationId 回放：响应丢失后用旧版本重试可能返回 409，应先 GET 核对 canonical 文档。

SaaS 属性面板的“保存并准备运行”先完成画布保存，再调用此接口，成功后关闭；整图、局部运行和节点手动发送也会在执行前准备对应 session 节点，并以返回文档重新预检。浏览器用同一保存队列、工作区身份和执行锁串行处理。明确拒绝保留草稿供修正；网络断开、超时、版本冲突或迟到响应不说明事务未提交，前端保留本地草稿、暂停继续覆盖，要求重新加载核对云端版本。直接调用 runs / graph-runs API 的客户端仍须提供已准备好的有效节点，不自动绕过绑定校验。

## Session 与运行

以下仍以 `/tenants/{tenantId}` 开头：

| 方法与后缀 | 请求 / 查询 | 说明 |
| --- | --- | --- |
| GET /sessions | 可选 canvasId、sessionId、limit、cursor | 会话列表；两个身份过滤可联合使用 |
| POST /sessions | canvasId, nodeId, agentId, title? | 三者必须在同一租户且节点确实存在于已保存画布 |
| GET /sessions/{id} | 无 | 会话元数据 |
| GET /sessions/{id}/messages | 无 | items[{id,sessionId,runId,role,content,createdAt}]；runId 关联原运行与团队过程 |
| POST /runs | sessionId, prompt, operationId | 202；operationId 必须 8–200 字节，也可用 Idempotency-Key header |
| GET /runs | 可选 sessionId、operationId、active、limit、cursor | 运行列表，用于恢复受理结果不确定的请求与查询活动运行 |
| GET /runs/{id} | 无 | status/output/terminal/error 等 |
| GET /runs/{id}/turns | 无 | `{items}`，按 ordinal 排序的团队成员回合；含成员、模型、状态、输出及输入审计，详见下文；单 Agent 返回空列表 |
| GET /runs/{id}/events | Last-Event-ID 或 after 查询参数 | text/event-stream，持久事件重放 |
| POST /runs/{id}/cancel | 无 | 幂等取消；状态以回读运行记录为准 |

同一个 operationId 与同样 session/prompt 返回既有 run；相同 key 换内容返回 409，不启动第二次模型执行。不同 operationId 对同一活跃 session 返回 session_busy。租户每日调用数和并发上限由后端检查；团队每一次实际成员模型调用都单独占用和核算额度。运行接收时冻结节点团队配置，后续编辑不改变已受理运行。

团队手动运行还在准入事务中冻结同租户、同 Session 已 `completed` 的问答；整图则在图准入时冻结每个节点的对应历史。快照中的历史不随晚到结果或 Agent 编辑变化。`shared` 可接收这些问答及本次已成功成员的输出，`task` 不接收此前问答或普通前人成果；汇总、审核、第二轮起返工仍需注入该操作必需的成员结果。这些显式操作数不取消 task 的跨运行历史隔离。历史只恢复用户提问与该 run 的最终结果，不恢复过去每名成员的完整过程。

SaaS 普通聊天按输入原文提交 prompt，不自动附加旧节点任务或 JSON 输出要求，聊天回答不覆盖节点交付物。“执行节点任务”、局部和整图入口继续构造节点任务及字段契约。两种入口不增加 `/runs` 请求字段；服务器始终从持久画布和会话读取团队配置。

run 对象包含 `{id,tenantId,sessionId,operationId,status,output,outputAvailable,terminal,error,createdAt,updatedAt}`。运行状态：queued、running、completed、failed、cancelled、interrupted。`terminal` 是状态派生值；`outputAvailable` 仅说明有文本，部分输出不等于成功。服务重启产生 interrupted，不能把它自动归为 completed。

SSE 的 `id` 是数据库事件序号，`data` JSON 中的 type 包括 queued、running、text_delta、completed、failed、cancelled、interrupted；文本增量使用 delta 字段。关闭 SSE 不等价于取消，取消必须走 cancel API。重连只补读事件，不重新执行任务。普通 HTTP 接受请求也不等价于运行完成。

### 成员输入审计

`GET /tenants/{tenantId}/runs/{id}/turns` 返回 `{items: [...]}`，每项包含：

| 字段 | 类型与含义 |
| --- | --- |
| `id, memberId, memberName, role` | string；本次回合身份、成员标识、显示名称与职责 |
| `round, ordinal` | integer；团队轮次与本次 run 中的调用顺序 |
| `status, output, error` | string；成员状态、已持久输出及错误；终态与 run 使用相同状态集合 |
| `model, runtime, config` | 已解析的公开模型、运行时及成员配置；不含密钥或供应商连接秘密 |
| `createdAt, updatedAt` | 服务端时间 |
| `prompt` | string；该回合真实保存的当前输入，包含实际选入的带来源成员结果及操作要求 |
| `systemPrompt` | string 或 null；实际准备的成员系统指令，旧记录没有证据时为 null |
| `messages` | `{role,content}[]` 或 null；role 为 user 或 assistant，content 为 string；实际准备的历史消息，task 为 `[]`，旧记录为 null |
| `context` | 以下审计对象或 null；旧记录为 null |

`context` 的固定形状为：

```json
{
  "version": 1,
  "mode": "shared",
  "historyMessages": 2,
  "historyAvailable": 6,
  "historyTruncated": true,
  "upstreamMembers": [
    {"memberId": "worker-1", "memberName": "执行者", "round": 1, "ordinal": 1}
  ],
  "upstreamAvailable": 1,
  "upstreamTruncated": false,
  "purpose": "review"
}
```

这是字段示例，不是某次实测结果。`mode` 为成员的 `task/shared`；`purpose` 为 `work/aggregate/review/revise`。`historyMessages` 是实际发送的历史消息条数，一对完整问答为 2 条；`historyAvailable` 是受理时该共享 Session 的已完成消息总数，task 为 0。`upstreamMembers` 只列实际选入的本次成员结果来源，`upstreamAvailable` 是该阶段可使用的上游结果数量。两个 `Truncated` 布尔值表示按容量或历史窗口丢弃过完整上下文，并不表示发送了文本片段；这些数量不是 token 用量或价格。

成员模型分别应用自己的预算：先保留当前任务及完整系统指令，普通共享上下文保留能放入的近期完整成员结果，再选入近期完整问答对。历史快照最多 50 对，并受 262144 字节上限约束；单条消息超过 Pi 的 32768 个 UTF-16 单元限制时丢弃整对。团队图节点不按未调用的主模型提前裁掉大容量成员可用的历史。必要审核/汇总/返工操作数不能完整放入时，run 以 `context_limit` 失败，不额外调用模型；受理 `202` 不能被当作这些成员已完成容量检查或已执行。

系统指令中的成员名称是显示标签，职责说明工作范围，成员专属指令定义的人格优先于显示标签和父节点人格。历史 assistant 消息标明是此前团队结果；上游成员输出以带来源的 JSON 数据呈现，不将别人的发言当作当前成员的身份或系统指令。审计展示准备并冻结的实际请求字段，不能仅凭 queued 回合存在就宣称已经调用了供应商。

迁移 `009_team_turn_inputs.sql` 的三个新列可空；旧 prompt 原样保留，旧 `systemPrompt/messages/context` 返回 null。客户端不得把 null 渲染成“实际没有历史”，也不得用当前配置重建并冒充当时输入。接口不含整个 run 的 status，观察端同时读取 `GET /runs/{id}`，终态后停止轮询。消息列表的 `runId` 可将重新加载的用户/助手消息关联回此接口，不需要猜测“最新运行”。所有读取继续验证当前租户与资源权限。

运行状态读取成功后立即更新，不等待成员接口成功。成员读取失败或格式无效时暂停读取并提供重试；保留的数据明确显示为旧记录，不继续宣称自动更新。运行状态本身读取失败时标明“上次确认状态”；401/403/404 清空已缓存记录。

## 节点团队与后台整图

节点 `document.nodes[].team` 是可选配置，支持顺序执行、并行汇总、多轮讨论、审核返工；省略则保留原单 Agent 行为。字段、范围、模型继承和审核 JSON 协议见 [节点团队设计](awwo-node-teams.md)。配置保存在画布文档内，服务器独立验证后才执行，不能通过前端选择任意密钥或执行器。

以下路径仍以 `/tenants/{tenantId}` 开头；读取需 reader，创建与取消需 member。

| 方法与后缀 | 请求 / 查询 | 说明 |
| --- | --- | --- |
| POST /canvases/{id}/graph-runs | operationId, documentVersion?, scope? | 新建 202，幂等回放 200；前端先保存并提交确认的 documentVersion，版本陈旧 409 |
| GET /canvases/{id}/graph-runs | operationId? | `{items}`，最近 50 个运行快照；可按操作 ID 恢复响应丢失的提交 |
| GET /canvases/{id}/graph-runs/{graphId} | 无 | 权威整图状态、受理时 document/documentVersion/scope 和 nodes |
| POST /canvases/{id}/graph-runs/{graphId}/cancel | 空对象 | 幂等取消；保留已完成及部分输出，回读确认最终状态 |
| POST /canvases/{id}/graph-runs/operations/{operationId}/cancel | 空对象 | 写入取消墓碑并与创建互斥；即使创建响应丢失也可阻止延迟提交，返回 confirmed/status 及可选 graphId |

整图状态为 queued、running、completed、failed、cancelled、interrupted；节点状态为 waiting、running、done、failed、blocked、cancelled、cached。节点记录含 nodeId、runId、sessionId、output、detail；使用 runId 读取成员回合。成员模型调用通过 `model_invocations` 记录，失败、取消及重启均释放活跃占用。终态数据库写入的短暂故障只重试数据库事务，不重发模型请求。

Go 负责依赖就绪、分支并行、汇合和下游执行。关闭网页后已受理整图继续执行；重新打开会恢复输出及成员记录。当前为单 API 实例执行与数据库租约，尚未实现水平多执行器调度。服务重启会将已受理但结果不确定的模型调用标记 interrupted；可继续尚未受理且依赖成功的节点，不自动重放未知调用。

## 平台管理

| 方法与路径（省略 /api/v1） | 请求 / 查询 | 说明 |
| --- | --- | --- |
| GET /admin/summary | 无 | tenantCount、userCount、activeRuns、completedRuns、failedRuns |
| GET /admin/tenants | limit?, cursor? | `{items,nextCursor,snapshot}`；租户状态/配额/createdAt |
| GET /admin/users | limit?, cursor? | `{items,nextCursor,snapshot}`；用户和平台角色，不返回密码 hash |
| GET /admin/runs | limit?, cursor? | `{items,nextCursor,snapshot}`；标准 run 对象 |
| GET /admin/audit | limit?, cursor? | `{items,nextCursor,snapshot}`；id,actorId,tenantId,action,resourceId,createdAt |
| PATCH /admin/tenants/{id} | status?, maxConcurrentRuns?, maxRunsPerDay? | 至少一项；status=active/suspended，并发整数 1–100，每日整数 1–100000；200 返回更新的 tenant |

以上全部要求 platformRole=admin。租户 owner 并不能访问平台后台。每日限额按 UTC 日期计算；降低额度不主动中断正在进行的模型调用，但团队后续成员调用需再次通过准入。暂停租户禁止新增业务写入，并取消当前活跃运行、记录事件；Go 保留历史读取权限，当前 SaaS 暂停页提供切换工作区与退出。恢复不自动重新执行取消过的任务。

reader 可读取原画布、会话及历史；业务写入由 Go 独立拒绝，原 CanvasSurface 的只读模式不发起保存、初始化、运行、规划或恢复写入。reader 仍可保存自己的账号配色；语言和浅深主题是浏览器偏好。

当前不提供支付、邮箱验证/找回、OIDC、文件上传下载或工具/工程文件执行。节点团队以 Pi 文本推理为范围；协议 fixture、真实模型、本地浏览器及生产验收须分别报告，实际验收范围以对应日期的报告为准。
