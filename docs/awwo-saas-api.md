# AwwO SaaS API v1

实现：`backend/internal/app/`。本地前端同源代理 `/api/v1`；直接访问 Go 默认为 `http://127.0.0.1:8087/api/v1`。所有受保护端点使用 `awwo_session` HttpOnly cookie；health、注册和登录不要求已有会话。JSON 写请求使用 `Content-Type: application/json`，未声明的字段会被拒绝。请求携带 Origin 时必须与 `AWWO_PUBLIC_ORIGIN` 一致，跨站 Fetch 请求被拒绝；非浏览器客户端可省略 Origin，仍需有效登录 cookie。不会通过 JSON 返回模型密钥或原始登录 session token；邀请创建响应单独返回一次邀请凭据。

集合响应通常为 `{"items":[]}`，单对象直接返回。错误结构为 `{"error":{"code":"not_found","message":"Resource not found"}}`。跨租户资源返回 404；权限不足 403；未登录 401；CAS/幂等/会话占用冲突 409；当前提示词和指令超过模型保守上下文预算时返回 413 / context_limit；配额或限流 429；模型不可用 503。租户资源列表首版仍有条数上限。平台管理列表的分页契约见下文；不能把其他上限列表当作全量导出接口。

## 当前用户资料与邀请

此节与 Go 实现和本轮真实 PostgreSQL 回归相对应，浏览器使用同一契约。实际验证范围见本地验收记录。

| 方法与路径（省略 /api/v1） | 输入 | 结果与权限 |
| --- | --- | --- |
| PATCH /auth/profile | `{name}`，trim 后 1–120 Unicode 字符 | 200，当前登录者资料 `{id,email,name,isPlatformAdmin}`；不接受其他用户 ID；写入审计 |
| GET /tenants/{tenantId}/invites | 无 | admin/owner 可查 `{items:[{id,role,createdBy,createdAt,expiresAt,status,acceptedBy,acceptedAt,revokedAt}]}`；后三项未发生时为 null；不返回 token/hash |
| POST /tenants/{tenantId}/invites | `{role,expiresInHours?}` | role=reader/member/admin；仅 owner 可授 admin；默认 72 小时，整数 1–168；201 `{id,role,expiresAt,inviteUrl,token}` |
| DELETE /tenants/{tenantId}/invites/{id} | 无 | 204，admin/owner 撤销邀请；只有 owner 可撤销 admin 邀请；已撤销重试幂等，已消费返回 409 / invite_used |
| GET /invites/{token} | 登录态 | `{tenantId,tenantName,role,expiresAt,status}`，供加入前确认；不通过 GET 消费 |
| POST /invites/{token}/accept | 登录态 | `{tenantId,role}`；单次领取，同领取者重试幂等；已有成员保留已有角色 |

`PATCH /auth/profile` 使用 `isPlatformAdmin:boolean`，而 `/auth/me` 的 user 仍使用 `platformRole:'user'|'admin'`。原账户面板的 SaaS 适配器仅合并成功返回的 name，不将这两种字段混为同一响应。

邀请 URL 为 `AWWO_PUBLIC_ORIGIN + /?invite=TOKEN`。注册或登录保留 URL 参数，但不会自动领取。新用户注册仍创建自己的工作区，之后再确认加入受邀工作区。数据库仅保存 token 哈希，明文只在创建响应及复制链接中出现，列表不能重新找回原链接；浏览器不将邀请码写入 localStorage。没有邮件投递。

预览 GET 不消费凭据：已知 token 返回 200 与 `status=active|expired|revoked|accepted|unavailable|suspended`；未知 token 返回 404。`unavailable` 表示发行者当前已无权授予该角色。领取 POST 对未消费的过期/撤销邀请分别返回 410 / invite_expired、invite_revoked，他人已领取返回 409 / invite_used，发行者失权返回 403 / invite_unavailable，暂停租户返回 403 / tenant_suspended。有效领取返回数据库中的当前 role，已有成员不被提升或降级。同领取者仍有成员资格时重试幂等，即使邀请后来已过期；若该用户已被移出工作区则返回 409 / invite_membership_removed，旧链接不能重新赋权。

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
| GET /tenants/{tenantId}/members | 无 | 成员列表；reader 以上 |
| POST /tenants/{tenantId}/members | 已注册用户 email, role | admin 以上；只有 owner 可任命 admin |
| PATCH /tenants/{tenantId}/members/{userId} | role | 204；不允许通过此 API 改动 owner |
| DELETE /tenants/{tenantId}/members/{userId} | 无 | 204；受保护角色不能被低权限成员移除 |

可分配角色为 reader、member、admin；owner 由租户创建产生，首版不提供所有权转移。这里的添加成员要求目标用户已注册，不会发送邮件邀请。平台管理员由 `AWWO_BOOTSTRAP_ADMIN_EMAIL/PASSWORD` 配置在 API 启动时创建；若相同邮箱已是普通用户，启动拒绝自动提权。已有管理员不会被启动参数静默重置密码。

## 画布与 Agent

以下路径均以 `/tenants/{tenantId}` 开头。读需 reader，业务写需 member。

| 方法与后缀 | 请求 | 说明 |
| --- | --- | --- |
| GET /canvases | 无 | 当前租户画布 |
| POST /canvases | name, document | 创建画布，201 |
| GET /canvases/{id} | 无 | id, tenantId, name, document, version, createdAt, updatedAt |
| PUT /canvases/{id} | name, document, version | version 必须是上次读取值；成功递增，陈旧值 409 |
| DELETE /canvases/{id} | 无 | 活跃关联运行阻止删除 |
| POST /canvases/{id}/plan | prompt, context, operationId | 202，创建持久规划 run；空画布也可使用，共享运行限额和 SSE |
| GET /agents | 无 | Pi Agent 列表 |
| POST /agents | name, role?, title?, model?, adapterConfig?:{model}, instructions?, adapterType? | adapterType 省略或为 pi；model 非空时优先，否则取 adapterConfig.model；role 是 Agent 工作角色文本，不是用户权限 |
| GET /agents/{id} | 无 | 已保存的 Agent 定义 |
| PUT /agents/{id} | 同创建字段 | 更新定义 |
| PUT /agents/{id}/instructions | content | 保存纯文本指令，不能上传可执行扩展 |
| DELETE /agents/{id} | 无 | 已被 session 引用时拒绝 |
| GET /runtime（不带 tenant 前缀） | 无 | engine, configured, available, plannerAvailable, models[{id,provider}], modelConnectivityVerified, limits, reason?；登录即可 |

Agent 响应包含 `{id,tenantId,name,status:'active',model,role,title,instructions,adapterType:'pi',adapterConfig:{model},createdAt}`；原绑定适配器使用 adapterConfig.model。服务器保存的非空 model 必须与当前服务端配置一致才能运行。前端不能在 Agent 定义中提供工具、模型 URL、工作目录或环境变量。内部 planner Agent 与 session 不出现在普通 Agent / session 列表。

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

## Session 与运行

以下仍以 `/tenants/{tenantId}` 开头：

| 方法与后缀 | 请求 / 查询 | 说明 |
| --- | --- | --- |
| GET /sessions | 可选 canvasId | 会话列表 |
| POST /sessions | canvasId, nodeId, agentId, title? | 三者必须在同一租户且节点确实存在于已保存画布 |
| GET /sessions/{id} | 无 | 会话元数据 |
| GET /sessions/{id}/messages | 无 | items[{id,sessionId,role,content,createdAt}] |
| POST /runs | sessionId, prompt, operationId | 202；operationId 必须 8–200 字节，也可用 Idempotency-Key header |
| GET /runs | 可选 sessionId, operationId | 运行列表，用于恢复受理结果不确定的请求 |
| GET /runs/{id} | 无 | status/output/terminal/error 等 |
| GET /runs/{id}/events | Last-Event-ID 或 after 查询参数 | text/event-stream，持久事件重放 |
| POST /runs/{id}/cancel | 无 | 幂等取消；状态以回读运行记录为准 |

同一个 operationId 与同样 session/prompt 返回既有 run；相同 key 换内容返回 409，不启动第二次模型执行。不同 operationId 对同一活跃 session 返回 session_busy。租户每日调用数和并发上限由后端检查。

run 对象包含 `{id,tenantId,sessionId,operationId,status,output,outputAvailable,terminal,error,createdAt,updatedAt}`。运行状态：queued、running、completed、failed、cancelled、interrupted。`terminal` 是状态派生值；`outputAvailable` 仅说明有文本，部分输出不等于成功。服务重启产生 interrupted，不能把它自动归为 completed。

SSE 的 `id` 是数据库事件序号，`data` JSON 中的 type 包括 queued、running、text_delta、completed、failed、cancelled、interrupted；文本增量使用 delta 字段。关闭 SSE 不等价于取消，取消必须走 cancel API。重连只补读事件，不重新执行任务。普通 HTTP 接受请求也不等价于运行完成。

## 平台管理

| 方法与路径（省略 /api/v1） | 请求 / 查询 | 说明 |
| --- | --- | --- |
| GET /admin/summary | 无 | tenantCount、userCount、activeRuns、completedRuns、failedRuns |
| GET /admin/tenants | limit?, cursor? | `{items,nextCursor,snapshot}`；租户状态/配额/createdAt |
| GET /admin/users | limit?, cursor? | `{items,nextCursor,snapshot}`；用户和平台角色，不返回密码 hash |
| GET /admin/runs | limit?, cursor? | `{items,nextCursor,snapshot}`；标准 run 对象 |
| GET /admin/audit | limit?, cursor? | `{items,nextCursor,snapshot}`；id,actorId,tenantId,action,resourceId,createdAt |
| PATCH /admin/tenants/{id} | status?, maxConcurrentRuns?, maxRunsPerDay? | 至少一项；status=active/suspended，并发整数 1–100，每日整数 1–100000；200 返回更新的 tenant |

以上全部要求 platformRole=admin。租户 owner 并不能访问平台后台。配额影响后续运行准入，每日限额按 UTC 日期计算，降低额度不终止已受理 run。暂停租户禁止新增业务写入，并取消当前活跃运行、记录事件；Go 保留历史读取权限，当前 SaaS 暂停页提供切换工作区与退出。恢复不自动重新执行取消过的任务。

reader 可读取原画布、会话及历史；业务写入由 Go 独立拒绝，原 CanvasSurface 的只读模式不发起保存、绑定、运行、规划或恢复写入。语言和浅深主题是浏览器偏好，无服务端偏好 API。

首版不提供支付、邮箱验证/找回、OIDC、文件上传下载或工具/工程文件执行，也没有独立长期后台图调度接口。页面关闭只允许已接收的 Go run 继续，尚未提交的下游 DAG 节点不会自动调度。真实 provider 尚未验收；本地协议 fixture 不替代真实模型或生产验收。
