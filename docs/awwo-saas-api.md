# AwwO SaaS API v1

实现：`backend/internal/app/`。本地前端同源代理 `/api/v1`；直接访问 Go 默认为 `http://127.0.0.1:8087/api/v1`。所有业务端点使用 `awwo_session` HttpOnly cookie。JSON 写请求使用 `Content-Type: application/json`。请求携带 Origin 时必须与 `AWWO_PUBLIC_ORIGIN` 一致，跨站 Fetch 请求被拒绝；非浏览器客户端可省略 Origin，仍需有效登录 cookie。不会返回模型密钥或原始 session token。

集合响应通常为 `{"items":[]}`，单对象直接返回。错误结构为 `{"error":{"code":"not_found","message":"Resource not found"}}`。跨租户资源返回 404；权限不足 403；未登录 401；CAS/幂等/会话占用冲突 409；当前提示词和指令超过模型保守上下文预算时返回 413 / context_limit；配额或限流 429；模型不可用 503。多数列表首版至多 200 条；不能把此上限列表当作全量导出接口。

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
| POST /agents | name, role?, title?, model?, instructions?, adapterType? | adapterType 仅允许 pi；role 是 Agent 工作角色文本，不是用户权限 |
| GET /agents/{id} | 无 | 已保存的 Agent 定义 |
| PUT /agents/{id} | 同创建字段 | 更新定义 |
| PUT /agents/{id}/instructions | content | 保存纯文本指令，不能上传可执行扩展 |
| DELETE /agents/{id} | 无 | 已被 session 引用时拒绝 |
| GET /runtime（不带 tenant 前缀） | 无 | engine, configured, available, models[], reason?；登录即可 |

服务器保存的 `model` 必须与当前服务端配置一致才能运行。前端不能在 Agent 定义中提供工具、模型 URL、工作目录或环境变量。`runtime.available` 表示 Pi 服务配置探测通过，真实推理是否可用需实际执行验证。

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

运行状态：queued、running、completed、failed、cancelled、interrupted。`terminal` 是状态派生值；`outputAvailable` 仅说明有文本，部分输出不等于成功。服务重启产生 interrupted，不能把它自动归为 completed。

SSE 的 `id` 是数据库事件序号，`data` JSON 中的 type 包括 queued、running、text_delta、completed、failed、cancelled、interrupted；文本增量使用 delta 字段。关闭 SSE 不等价于取消，取消必须走 cancel API。重连只补读事件，不重新执行任务。普通 HTTP 接受请求也不等价于运行完成。

## 平台管理

| 方法与路径 | 请求 | 说明 |
| --- | --- | --- |
| GET /admin/summary | 无 | tenantCount、userCount、activeRuns、completedRuns、failedRuns |
| GET /admin/tenants | 无 | 平台租户与状态/配额 |
| GET /admin/users | 无 | 用户和平台角色，不返回密码 hash |
| GET /admin/runs | 无 | 平台运行检查 |
| GET /admin/audit | 无 | 关键变更审计记录 |
| PATCH /admin/tenants/{id} | status?, maxConcurrentRuns?, maxRunsPerDay? | status=active/suspended；至少提供一项 |

以上全部要求 platformRole=admin。租户 owner 并不能访问平台后台。暂停租户禁止新增业务写入，并取消当前活跃运行、记录事件；保留历史供只读查看。恢复不自动重新执行取消过的任务。

首版不提供支付、邮箱验证/找回、OIDC、文件上传下载、独立长期后台图调度接口；这些在架构实施顺序中另列，不能通过假数据端点替代。
