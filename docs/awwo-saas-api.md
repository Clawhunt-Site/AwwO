# AwwO SaaS API v1

适用分支：`codex/awwo-node-setup-20260908`；worktree：`/Users/dev-user/Desktop/projects/workspace/awwo-node-setup-20260908`。更新日期：2026-09-08。本文记录实现契约，不代表本轮真实模型或生产验收已通过。

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

画布列表另接受 `view=summary`（2026-10-17）：每项的其余字段与完整视图相同，但以 `outline` 代替 `document`。`outline` 正是列表卡片缩略图所画的内容：前 60 个有字符串 id 的节点的 `{id,x,y,w,h}`（缺省字段省略）、两端都在其中的边的 `{fromNode,toNode}`，以及全部这类节点的 `nodeCount`。工作区首页的画布列表用它，避免一次下载每张画布的完整文档（含每个节点的输出）。两种视图翻页同一集合、顺序相同，同一 cursor 可用于任一视图；`view` 的其他取值或重复出现返回 400 / invalid_pagination；其他列表忽略该参数。列表项从不是可编辑的画布：改名等写操作先读取完整画布。

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
| POST /tenants | name | 201，创建租户，当前用户成为 owner；`AWWO_MAX_OWNED_WORKSPACES`>0 时，非平台管理员已拥有不少于该数量的工作区则 403 / workspace_limit（注册与首次 ClawHunt 登录自动创建的工作区不受此限） |
| GET /tenants/{tenantId}/members | limit?, cursor? | `{items,nextCursor,snapshot}`；reader 以上 |
| GET /tenants/{tenantId}/route-usage | 无 | reader 以上；今日（UTC）额度 `{limited,daily:{limit,used},routes?:{gate|bedrock|media:{limit,used}},planner?:{limit,used},interested,resetsAt}`；每日总数与本工作区的路由次数按准入的算法计数（`not_incurred` 不占路由次数但占每日次数）；画布助手在运营方规划模型上的改画布调用不占每日次数（免费版与套餐都一样），单独计入 `planner`（本工作区今日已用 / `AWWO_PLANNER_PER_WORKSPACE_PER_DAY`，默认 20；未配置规划模型时不返回）；不含全站上限、每个工作区与全站的媒体生成上限以及模型清单，准入仍可能拒绝；没有 routeLimits 或 routeLimits 为 `{}`（且所有者没有套餐）的工作区 `limited:false` 且无 `routes`；活动期间（`AWWO_PROMO_UNTIL` 之前）被活动抬高的免费工作区另返回 `promo{until,daily,routes?}`（活动的下限；`daily`/`routes` 已包含活动与今日签到），member 以上且可签到时另返回 `checkin{available,checkedIn,taken?,elsewhere?,bonus{daily,media},today?{daily,media},streak,endsAt}`（`taken`=本工作区今天已由其他成员签到，`elsewhere`=本人今天已在其他工作区签到，`today`=本工作区今天签到加上的次数，`streak`=本人连续签到天数）；所有者有付费套餐的工作区返回 `plan{id,credits{granted,spent,carried,remaining}}`（carried 为上一个计费期超出点数的部分、从本期扣除，实时计算，上期迟结算的调用仍算回上期；没有 routeLimits 的旧工作区不走套餐）（所有者另见 `periodEnd`、`cancelAtPeriodEnd`；reader 不返回 plan）、无 `routes`，`daily` 为整个账号今日默认模型的调用次数与套餐的每日次数 |
| GET /billing | `?refresh=1` | 已登录；套餐目录 `catalog[{id,priceUsd,credits,dailyCalls,concurrentAgents,workspaces,mediaPerDay}]`、`checkoutEnabled`、本账号套餐 `plan{id,status,periodStart,periodEnd,cancelAtPeriodEnd,entitled}`（无订阅为 null）、本期点数 `credits{granted,spent,carried,remaining}`（有权益时）、`stale`；套餐由 ClawHunt 经后台通道告知（`paid` 为本期已付款发票按套餐计的美分，点数 = 实付金额换算，期中升级按补差价加点；续费未付款时保留上一个已付款的计费期，宽限 1 天；本期全额退款或被争议时点数为 0；ClawHunt 说已无订阅时套餐结束、记录保留为 `canceled`），超过 5 分钟或 `refresh=1` 时先向 ClawHunt 查询，查不到时显示已存的套餐并 `stale:true`；ClawHunt 说授权已结束则 401 并退出；另有后台同步按 subject 在续费前后、每小时以及结账/门户之后 24 小时内重读套餐 |
| POST /billing/checkout | `{plan}` | 已登录（ClawHunt 账号）；plan=pro/max；开关 `AWWO_BILLING_CHECKOUT_ENABLED` 关闭时 403 `checkout_closed`；ClawHunt 开 Stripe Checkout，200 `{url}`（只放行 `https://checkout.stripe.com/`）；已有订阅（含未付款完成的）409 `already_subscribed`；同一账号正在打开另一个结账 429 `rate_limited`；密码账号 404；ClawHunt 不可用 503 |
| POST /billing/portal | `{}` | 已登录（ClawHunt 账号）；Stripe 账单门户，200 `{url}`（只放行 `https://billing.stripe.com/`）；没有订阅 404 `no_subscription` |
| POST /tenants/{tenantId}/checkin | `{}` | member 以上，暂停的工作区 403；活动期间给免费工作区签到（所有者有套餐、平台管理员的工作区、每日总数被管理员调低到新工作区默认值以下的工作区不参与），每人每天一次、每个工作区每天一次（UTC 日）；当天的每日总数与图片/视频/3D 次数加上 `AWWO_CHECKIN_BONUS`（加量记在签到行上；图片/视频路由被调低到默认值以下或关闭为 0 的工作区只加每日总数，`bonus.media` 为 0）；200 `{checkin}`（同上，当天再按一次不再加、返回同样的状态）；409 `checkin_unavailable`（没有活动或不参与）、`checkin_taken`（本工作区今天已由其他成员签到）、`checkin_elsewhere`（本人今天已在其他工作区签到） |
| POST /tenants/{tenantId}/upgrade-interest | `{}` | reader 以上，暂停的工作区 403；服务端按上面的计数记录提出时已用完的额度（`daily`=每日总数，或额度大于 0 且已用完的路由；额度为 0 的路由不记），每人每个工作区一行，多次提出取并集；距上次超过 10 分钟才把 `clicks` 加 1；200 `{recorded:true,clicks}`；不改变任何额度 |
| POST /tenants/{tenantId}/members | 已注册用户 email, role | admin 以上；只有 owner 可任命 admin |
| PATCH /tenants/{tenantId}/members/{userId} | role | 204；不允许通过此 API 改动 owner |
| DELETE /tenants/{tenantId}/members/{userId} | 无 | 204；受保护角色不能被低权限成员移除 |

可分配角色为 reader、member、admin；owner 由租户创建产生，首版不提供所有权转移。这里的添加成员要求目标用户已注册，不会发送邮件邀请。平台管理员由 `AWWO_BOOTSTRAP_ADMIN_EMAIL/PASSWORD` 配置在 API 启动时创建；若相同邮箱已是普通用户，启动拒绝自动提权。已有管理员不会被启动参数静默重置密码。

统一登录（ClawHunt）首次登录建号可加两项限制，只拦新建账号，已有账号、用密码确认的账号关联和之后的登录都不受影响：`AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY`（不设或 0 = 不限）按客户端地址（与登录限流相同的 `AWWO_TRUSTED_PROXY_CIDRS` 解析，IPv6 按 /64）每个 UTC 日最多新建几个账号，超出时回到 `/?sso=error&reason=signup_limited`；`AWWO_REQUIRE_VERIFIED_EMAIL=true` 时 ClawHunt 报告邮箱未验证（`email_verified` 为 false 或缺省）的身份不建账号，回到 `reason=email_unverified`。计数只存当日与地址的带密钥哈希（迁移 027），详见 [clawhunt-identity.md](clawhunt-identity.md)。

## 画布与 Agent

以下路径均以 `/tenants/{tenantId}` 开头。读需 reader，业务写需 member。

| 方法与后缀 | 请求 | 说明 |
| --- | --- | --- |
| GET /canvases | limit?, cursor?, view? | 当前租户画布，`{items,nextCursor,snapshot}`；`view=summary` 时每项以 `outline` 代替 `document` |
| POST /canvases | name, document | 创建画布，201 |
| GET /canvases/{id} | 无 | id, tenantId, name, document, version, createdAt, updatedAt |
| PUT /canvases/{id} | name, document, version | version 必须是上次读取值；成功递增，陈旧值 409 |
| POST /canvases/{id}/initialize | documentVersion, scope? | 根据已保存文档准备节点 Agent / Session，200 返回完整 canonical 画布；不执行模型 |
| DELETE /canvases/{id} | 无 | 成功 204；关联节点或规划 run 为 queued/running 时 409 / resource_in_use，拒绝时不改运行、事件或审计 |
| POST /canvases/{id}/plan | prompt, context, operationId | 202，创建持久规划 run；空画布也可使用，共享运行限额和 SSE。context 超过 120000 个 UTF-16 码元（中文一字一个，与 worker 的传输上限同一计法）、连同请求超过 128000 个码元、或超过所选模型的保守预算时返回 413 `context_limit`（模型预算按 worker 在 `/health` 公布的 `proseBytesPerToken` 估算 token 计：中文、普通文字和代码按该模型实测的每 token 字节数，数字、长串（base64、URL、压缩代码）、标点和符号（中文和全角的除外）、超过 32 个的连续空白和其他文字仍按一字节一 token；没公布的模型仍按字节），`error.details.contextRoom` 为同一请求的 context 最多可占的字节数（按该 context 自身每估算 token 的字节数换算；为因长度被省略的个性化设置留出空间，创建 run 时的长度与预算检查也为因长度被省略的节点上限留出，读取节点上限之前的码元检查不留；只因输入超过 `AWWO_PLANNER_MAX_INPUT_BYTES` 而没用上运营方规划模型时（该模型当天的工作区与部署次数都还有余，先于长度检查；且工作区可以使用它：DeepSeek 规划模型须在工作区的模型清单里），取能换用该模型的长度与默认模型长度中较大者；0 表示请求本身、它附带的文件或选中的资料已占满，再短的 context 也放不下）；页面据此发送更短的画布视图，不创建 run、不计次（首次规划时创建的规划会话照常保留）。服务端在 context 之后、个性化设置和请求之前加一段 `Node limits`（2026-10-22 起，`planning_limits.go`）：工作区可用的每个模型单次回答最多的输出 token 数（含思考；取 openai-agents 与 Pi 两个 worker 在 `/health` 公布的 `maxOutputTokens`，两个都提供该模型时取较小者，因为绑定工作区 Agent 的节点沿用该 Agent 的运行时；提供该模型却没公布上限、或公布的不是整数的 worker 按规划指令自己的假定算 16000，这一段随之写明；至多写 100 个模型，其余的只写它们中最小的上限，作为其余每个模型该取的上限）、未选模型的节点所用的工作区默认模型（`"default"`，取 openai-agents 的）和单次运行的时限；页面读到画布的模型目录和读者的选择之后（`AssistantExecutionHost.componentModelRead`），另起一行写明规划新增、未用 `set_model` 的 Agent 节点将使用的模型（读者为画布助手选的模型，DeepSeek 也写；这些节点用工作区默认模型时写 `"default"`；读到之前，例如从首页转来的请求，以及没有模型目录的桌面版，不写），这些节点随后使用规划所依据的那个模型（`assistantModel.ts` `planComponentModel`）：规划帧的 `newNodeModel` 取自其 run 所依据的、保存的请求的 context，续接的规划、或另一个标签页发起的规划也一样，而不是读者之后改选的；`"default"` 让它们留在默认模型；请求没写（本次发布之前保存的，或在上述读取之前发出的），或写的模型现在用不了（不再提供、没有就绪的运行时，或工作区套餐不再包含）时，用规划完成时读者的选择；只有用户能选的模型（DeepSeek）只在规划完成时读者仍选着它才用，因为隐私条款只在选了 DeepSeek 时才把请求发给它。这些只在请求通过权限检查后才读取 worker；它在请求哈希之后加入，上限变了以后的重试仍是同一规划；完整的一段会让请求超出提示长度上限、或仅因它而超出运营方规划模型的输入上限（`AWWO_PLANNER_MAX_INPUT_BYTES`）时，改用简短的一段（默认模型的上限，也按它自己的 id 写出；上限比它低的模型，至多 12 个、从小到大；其余模型中最小的上限，作为其余每个模型该取的上限；没有默认模型时只写所有模型中最小的上限，作为每个模型该取的上限），连这段也放不下时不加；两个 worker 都一个上限也没公布时也不加。规划指令据此把每个节点的交付控制在其模型上限的一半以内（代码六分之一，只拼接现成部分的节点三分之二），更大的任务按章节、模块或批次拆成并行的部分节点，每部分写明范围和它在用户总量里的份额，并保持在规划的操作数上限内；前端节点自身的代码超过其模型上限的六分之一时，拆成代码模块节点和一个只拼接的组装节点 |
| POST /canvases/{id}/ui-events | `{name}` | member 以上，暂停的工作区 403；记一次按钮点击，供运营统计：name 只能是 `review.next_steps`（运行完成提示里的「看下一步」）、`review.open_report`（「接下来」里的「查看验收报告」）或 `assistant.local_answer`（画布助手在页面上直接回答、没用调用的提问），其他名字或多余字段 400；不是本工作区的画布 404；每次点击写一条审计事件（action `ui.<name>`，resourceId 为画布 id，不带画布内容和 metadata），平台管理员在 `/admin/audit` 可见；同一人 2 秒内在同一画布重复点同一按钮只记一次，写入时成员身份已失效也不记；200 `{recorded}` |
| GET /canvases/{id}/artifacts | cursor? | 画布已存的交付文件（不含字节，上传与工作区快照除外），新的在前，每页至多 500 个：`{items,truncated,nextCursor}`。`truncated` 为真表示后面还有，带 `cursor=nextCursor` 读下一页，直到 `truncated` 为假、`nextCursor=null`。游标签名绑定当前账号、租户、这张画布和首页的读取时刻：之后存入的文件比已列出的都新，不进这次列表的后续页。列表不是表的快照：列表进行中再次存入的文本交付物、或列表开始前就已开始的事务存入的文件，可能不在这次列表里，重新列一次即可看到。首页仍是最新的 500 个，只是同一时刻存入的文件改按 id 降序，页尾落在其中时取到的可能是其中另几个；空值、重复、伪造、别的账号或别的画布的 cursor 返回 400 / invalid_cursor，无法解析的查询返回 400 / invalid_pagination |
| GET /agents | limit?, cursor? | Pi Agent 列表，`{items,nextCursor,snapshot}` |
| POST /agents | name, role?, title?, model?, effort?, adapterConfig?:{model,effort}, instructions?, adapterType? | adapterType 省略时为 pi，也可为 openai-agents；model 与 effort 非空时优先，否则取 adapterConfig 中的同名字段；effort 为空表示不显式设置思考强度（由供应商默认），非空时必须是小写标识符，是否被该模型支持在节点初始化与运行准入时校验；role 是 Agent 工作角色文本，不是用户权限 |
| GET /agents/{id} | 无 | 已保存的 Agent 定义 |
| PUT /agents/{id} | 同创建字段 | 更新定义 |
| PUT /agents/{id}/instructions | content | 保存纯文本指令，不能上传可执行扩展 |
| DELETE /agents/{id} | 无 | 已被 session 引用时拒绝 |
| GET /runtime | 无 | Pi 兼容字段及 runtimes[{id,name,configured,available,supportsEffortSelection,effortInputMode:"select",tools,reason?}]、models[{id,name,provider,runtime,reasoningEfforts[],defaultReasoningEffort,route,requiresUpgrade?}]；route 为准入对该模型的分类（`free` 免费默认模型、`gate`、`bedrock`），requiresUpgrade 仅在本工作区当前套餐不含该模型时为 true（免费版、有路由限额且该路由为 0；或该模型在部署设置 `AWWO_PLAN_ONLY_MODELS` 里（默认 Claude Opus 5.5，只给付费套餐），而工作区没有付费套餐、也不归平台管理员所有；有套餐的工作区从不出现），前端据此在选择器里标「Pro」，`GET /computer-runtime` 的 models 同样带这两个字段；supportsEffortSelection 仅在该 runtime 至少一个模型发布了思考强度档位时为 true，档位按模型给出且是封闭枚举，defaultReasoningEffort 只用于展示、不会写入请求；reader 即可读，目录已按本工作区模型清单过滤 |

Agent 写入（POST / PUT `/agents`）在保存前按本工作区模型清单授权：清单外的 model 返回 `403 model_not_allowed`。这是授权检查而非可用性检查，只读数据库、不探测 worker，所以 worker 故障不会阻挡编辑；模型是否真实存在仍由运行准入判定。

Agent 响应包含 `{id,tenantId,name,status:'active',model,role,title,instructions,runtime,adapterType,adapterConfig:{model},createdAt}`，其中 runtime 与 adapterType 同为 `pi | openai-agents`；原绑定适配器使用 adapterConfig.model。更新请求省略 adapterType 时保留既有 runtime；已有 session 的 Agent 不允许原地切换 runtime，应通过节点初始化创建新 Agent/Session。服务器保存的非空 model 必须属于对应 runtime 的服务端模型目录才能运行。前端不能在 Agent 定义中提供工具、模型 URL、工作目录或环境变量。内部 planner Agent 与 session 不出现在普通 Agent / session 列表。

每个 `runtimes[].available` 表示对应 worker 配置健康探测通过；`plannerAvailable` 表示 Pi 可读**且**本工作区在其清单内至少解析出一个可用模型（planner Agent 不带显式 model）。工作区被限制到无模型时 `available` 仍为 true（服务本身健康），但 `models` 为空且 `reason` 为 `No model is available to this workspace`。本路由**没有**不带 tenant 前缀的版本：没有工作区就无法套用其模型清单，旧客户端请求 `/api/v1/runtime` 会得到 404。`modelConnectivityVerified` 当前固定为 false，不在探测时执行推理。models 按 runtime 归属，tools 只包含对应 health 实际启用的固定 ID。Pi 兼容 `limits` 在 Pi 可读时返回，不可读时可为 null。RuntimeSettings 展示两个框架的配置、服务状态、模型和原因并支持刷新；模型连接仍由服务管理员配置，不提供浏览器秘密写接口。真实 provider 是否可用必须另做实际运行验收。

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

`documentVersion` 必填、整数且至少为 1，必须匹配当前 API 外层版本。省略 `scope` 处理全部 session 节点；传入时必须为 1–400 个已有、不重复的 session 节点 ID，空数组、null、form 节点和未知 ID 返回 `400 invalid_scope`。form 节点本身不需要初始化。

Go 在事务中重新检查 member 以上权限、租户 active 状态及画布归属，锁定画布并比较版本。过期版本返回 `409 version_conflict`；当前画布存在 queued/running 的图、节点或规划任务时返回 `409 resource_in_use`。已有 Agent 绑定必须属于当前租户；当前及历史会话还需属于当前画布和节点，并与声明的 Agent 引用一致。伪造或跨范围引用返回 `404 not_found`。选中节点全部成功后才提交，有任一错误则整体回滚。

选中 session 节点时需要其节点和成员涉及的所有 worker health 可读，失败返回 `503 runtime_unavailable`，健康检查不会执行推理。空 runtime 解析为 `pi`，空 model 解析为有效 runtime 当前默认模型，非空 model 必须属于该 runtime 目录；支持 `llm` 与 `coding`，不接受图像类型或其他 runtime。effort 为空表示不显式设置；非空 effort 必须是该节点模型在 worker 目录中发布的档位（团队成员按各自 runtime 与模型校验），否则拒绝而不是静默丢弃，默认档位也不会被回填。团队成员留空模型而继承节点模型时，一并继承节点的思考强度；成员指定自己的模型时只使用成员自己的档位。非法节点、团队、模型、思考强度或工具返回 `400 invalid_node_setup`。初始化不占用模型调用次数，也不证明供应商真实推理连通。

响应为 `{id,tenantId,name,document,version,createdAt,updatedAt}`。document 回填实际 `runtime/model/binding/issueId/activeThreadId/threads`；客户端必须使用这份 canonical 文档及其版本继续执行。首次准备创建 Agent 与 node Session；与已初始化的有效配置快照相比，名称、类型、模型、思考强度、人格或团队变化会建立新的 Agent / 当前会话，保留历史身份与消息，清空新会话的旧交付。成员继承值在 `node_sessions.setup_snapshot` 中按实际值比较；仅把“继承”改写为相同显式值不会额外分叉。team 仍为节点级配置，旧 run 的执行快照保持不变。

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
| POST /runs | sessionId, prompt, operationId | 202；prompt 最多 128000 个 UTF-16 码元（中文一字一个，与 worker 的传输上限同一计法），operationId 必须 8–200 字节，也可用 Idempotency-Key header |
| GET /runs | 可选 sessionId、operationId、active、limit、cursor | 运行列表，用于恢复受理结果不确定的请求与查询活动运行 |
| GET /runs/{id} | 无 | status/output/terminal/error 等 |
| GET /runs/{id}/turns | 无 | `{items}`，按 ordinal 排序的团队成员回合；含成员、模型、状态、输出及输入审计，详见下文；单 Agent 返回空列表 |
| GET /runs/{id}/events | Last-Event-ID 或 after 查询参数 | text/event-stream，持久事件重放 |
| POST /runs/{id}/cancel | 无 | 幂等取消；状态以回读运行记录为准 |

同一个 operationId 与同样 session/prompt 返回既有 run；相同 key 换内容返回 409，不启动第二次模型执行。不同 operationId 对同一活跃 session 返回 session_busy。租户每日调用数和并发上限由后端检查；团队每一次实际成员模型调用都单独占用和核算额度。运行接收时冻结节点团队配置，后续编辑不改变已受理运行。

团队手动运行还在准入事务中冻结同租户、同 Session 已 `completed` 的问答；整图则在图准入时冻结每个节点的对应历史。快照中的历史不随晚到结果或 Agent 编辑变化。`shared` 可接收这些问答及本次已成功成员的输出，`task` 不接收此前问答或普通前人成果；汇总、审核、第二轮起返工仍需注入该操作必需的成员结果。这些显式操作数不取消 task 的跨运行历史隔离。历史只恢复用户提问与该 run 的最终结果，不恢复过去每名成员的完整过程。

SaaS 普通聊天按输入原文提交 prompt，不自动附加旧节点任务或 JSON 输出要求，聊天回答不覆盖节点交付物。“执行节点任务”、局部和整图入口继续构造节点任务及字段契约。两种入口不增加 `/runs` 请求字段；服务器始终从持久画布和会话读取团队配置。

run 对象包含 `{id,tenantId,sessionId,operationId,status,output,outputAvailable,terminal,error,createdAt,updatedAt}`。运行状态：queued、running、completed、failed、cancelled、interrupted。`terminal` 是状态派生值；`outputAvailable` 仅说明有文本，部分输出不等于成功。服务重启产生 interrupted，不能把它自动归为 completed。

SSE 的 `id` 是数据库事件序号，`data` JSON 中的 type 包括 queued、running、text_delta、progress、completed、failed、cancelled、interrupted；文本增量使用 delta 字段。规划 run 不发布 text_delta：方案在通过校验前不公开，流式期间改为约每秒一条（阶段变化、新增节点/连线/模板、正在写的操作或其所属节点变化时立即一条）的 `progress`，只含计数 `{stage:"thinking"|"streaming",characters,nodes,edges,reasoning,template?,operation?,target?}`——`characters` 为已写出的方案字符数，`nodes`/`edges` 为已声明的节点与连线数，`reasoning` 为模型思考字符数（从不包含思考内容），`template` 为最新声明节点的模板 ID，`operation` 为方案正在写的最新操作类型（固定操作集合；只认根对象 `operations` 数组中操作对象自身的 `type`，嵌套对象、字符串里写得像操作的内容都不算），`target` 为该操作所属单个节点的模板 ID（仅对作用于单个节点的操作、且该节点由本次方案声明时才能对应；连线类操作不带 `target`；ref、节点 ID 等模型文本只在进程内用于对应，从不发布）。`template`/`operation`/`target` 仅在属于固定集合时出现。这些都是实测值，不是完成比例。关闭 SSE 不等价于取消，取消必须走 cancel API。重连只补读事件，不重新执行任务。普通 HTTP 接受请求也不等价于运行完成。

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
| POST /canvases/{id}/graph-runs | operationId, documentVersion?, scope? | 新建 202，幂等回放 200；前端先保存并提交确认的 documentVersion，版本陈旧 409。受理会先冻结范围内每个媒体节点的模型与参数，若因某个节点自身已保存的状态被拒（`media_params_invalid`、`node_setup_required`、`model_unavailable`、`model_not_allowed`），`error.details.nodeId` 给出该节点 id，供前端指明是哪个节点；部署自身的拒绝（未配置生成、无存储空间）不给节点，节点标题属用户内容、不出现在接口错误里 |
| GET /canvases/{id}/graph-runs | operationId? | `{items}`，最近 50 个运行的摘要（状态、范围、时间与各节点 state，重试过的节点另带 attempts；不含受理时的 document 与节点输出）；可按操作 ID 找回响应丢失的提交，再按 graphId 读取整图 |
| GET /canvases/{id}/graph-runs/{graphId} | document? | 权威整图状态、受理时 document/documentVersion/scope 和 nodes；`?document=false` 时只省去受理时冻结的 document，其余不变（document 受理后不再改写，已读过它的读者如画布对进行中运行的轮询、运行记录面板的重读只需读一次），`true` 同默认，其他取值、重复给出或查询串无法解析时 400 |
| POST /canvases/{id}/graph-runs/{graphId}/cancel | 空对象 | 幂等取消；保留已完成及部分输出，回读确认最终状态 |
| POST /canvases/{id}/graph-runs/operations/{operationId}/cancel | 空对象 | 写入取消墓碑并与创建互斥；即使创建响应丢失也可阻止延迟提交，返回 confirmed/status 及可选 graphId |

整图状态为 queued、running、completed、failed、cancelled、interrupted；节点状态为 waiting、running、done、failed、blocked、cancelled、cached。节点记录含 nodeId、runId、sessionId、output、detail；使用 runId 读取成员回合。成员模型调用通过 `model_invocations` 记录，失败、取消及重启均释放活跃占用。终态数据库写入的短暂故障只重试数据库事务，不重发模型请求。

Go 负责依赖就绪、分支并行、汇合和下游执行。关闭网页后已受理整图继续执行；重新打开会恢复输出及成员记录。当前为单 API 实例执行与数据库租约，尚未实现水平多执行器调度。服务重启会将已受理但结果不确定的模型调用标记 interrupted；可继续尚未受理且依赖成功的节点，不自动重放未知调用。

## 技能、记忆、网页读取与视频渲染

以下路径以 `/tenants/{tenantId}` 开头；读取需 reader，写入需 member。四项能力都由服务器裁决：前端只在 `GET /capabilities` 报告开启时提供入口，关闭的能力返回 503，不会被前端放行。

| 方法与后缀 | 请求 / 查询 | 说明 |
| --- | --- | --- |
| GET /capabilities | 无 | `{skills,skillRegistry,memory,webReader,render}`：各项 enabled、上限，以及 webReader/render 今日已用次数 |
| GET /skills | 无 | `{items,limits}`：40 个内置技能（`builtin:<name>`）与本工作区技能（`workspace:<id>`）的摘要，不含正文 |
| GET /skills/{ref} | 无 | 一个技能的全文；已归档或属于其他工作区的技能统一 404 |
| POST /skills | name, title, description, body, category?, applies? 或 markdown（SKILL.md） | 201；正文 ≤ 12 KiB，名称在工作区内唯一（`skill_name_conflict`），最多 100 个（`skill_limit`）；隐藏字符一律拒绝 |
| PUT /skills/{id} | version + 要改的字段 | 比较并交换，版本陈旧 409；每个版本都保留在 `tenant_skill_revisions` |
| DELETE /skills/{id} | 无 | 归档（保留行与历史版本）；仍挂着它的节点在受理时被 `skill_unavailable` 拒绝 |
| GET /skills/registry/search | q（2–100 个字符） | 需 member。`{query,items,source}`：skills.sh 上来自 GitHub 仓库的技能（最多 20 个，id、source、slug、name、installs、url、repoUrl） |
| GET /skills/registry/preview | id（owner/repo/skill） | 需 member。SKILL.md 全文（超过 64 KiB 只给前 64 KiB，`truncated`）、skills.sh 副本的 hash、附带文件清单、notes（`extra_files`、`runs_commands`）、来源仓库的许可证与星标（`repository.checked`）、skills.sh 公布的安全审计（`audits`，读不到为 null）、默认导入字段 `skill`、`license`（`status`：open / unknown / restricted，`spdx`，技能的许可证与声明文件，以及提到条款的 README，`files`：path、notice、readme、text（最多 16 KiB）、truncated），以及 `problem`（`blocking` 为真表示正文本身不能导入）；`hash` 覆盖 SKILL.md、这些文件、文件夹的 README 和仓库许可证 |
| POST /skills/registry/import | id, hash, name?, title?, description?, category?, applies?, licenseConfirmed? | 需 member。201，存为工作区技能并记下来源（`attribution`）；许可证不是宽松开源许可时须 `licenseConfirmed: true`，否则 409 `skill_registry_license_unconfirmed`；hash 与预览不同（技能、许可证与声明文件或仓库许可证变了）409 `skill_registry_changed`；正文过大 413 `skill_registry_too_large`，含隐藏字符 422 `skill_registry_hidden_text`，说明块读不出 422 `skill_registry_unreadable`，没有正文 422 `skill_registry_empty`；文件夹超过 4 MiB 或 500 个文件为 502 `skill_registry_folder_too_large`；其余与 POST /skills 相同 |
| GET /memory | canvasId?, status?（active,proposed 默认；archived；all）, q? | `{items}`：工作区记忆与该画布的记忆，置顶在前 |
| POST /memory | title, body?, kind?, canvasId?, pinned?, status?（active / proposed）, source? | 201；同一范围内容相同的记忆返回已有记录（200）；每个范围最多 200 条（`memory_limit`） |
| PATCH /memory/{id} | version + title/body/kind/pinned/status | 比较并交换，版本陈旧 409 |
| DELETE /memory/{id} | 无 | 204，删除记忆；已受理的运行仍保留快照里冻结的副本 |
| POST /knowledge/sources/web | url, title?, operationId | 读取一个公开网页并存为原始资料（201；同一正文已有资料时 200）；`web_reader_unavailable` 503、`web_reader_busy` 503（同时读取已满，不计次）、`web_read_quota` 429、`web_read_in_progress` 409（同一 operationId 仍在读取）、`web_<原因>` 见下 |
| GET /canvases/{id}/renders | nodeId? | `{items}`：最近 30 次渲染 |
| POST /canvases/{id}/renders | operationId, nodeId, html, width, height, fps, seconds, loop?, gif?, contact? | 202 受理；同一 operationId 只属于一个画布，幂等回放同一渲染；每个工作区同时只能有一个（`render_busy`）、每日次数（`render_quota`）、页面 ≤ 6 MiB（`render_too_large`） |
| GET /canvases/{id}/renders/{renderId} | 无 | status（queued/running/completed/failed/cancelled）、errorCode、result（mode、frames、distinctFrames、warnings、outputs） |
| POST /canvases/{id}/renders/{renderId}/cancel | 空对象 | 幂等取消 |

**技能** 写在节点的 `document.nodes[].skills`（最多 4 个引用，合计 ≤ 20 KiB）。受理运行时，服务器把每个技能的全文、版本和内容 hash 冻结进执行快照，放在节点指令之后、带边界说明的系统提示里（正文中的 `</skill` 被转义）；之后修改技能只影响新的运行。没有技能的节点请求逐字节不变。

**从 skills.sh 查找技能** 默认关闭（`AWWO_SKILL_REGISTRY=on` 开启）。只有 API 向外请求：skills.sh 的公开接口（`/api/search`、`/api/download/<owner>/<repo>/<skill>`、`/api/v1/skills/audit/...`，与它的命令行工具相同）和 GitHub 的仓库接口（许可证、星标），经网页读取器的客户端（只连公开地址、不经代理、不带 cookie），以 `AwwO-Skills/1.0` 如实标识，最多跟随一次本域与 www. 之间的跳转。每个答复在服务器的 4 个请求槽之一里读完，只留成员能看到的部分的副本（SKILL.md 最多 64 KiB、每个许可证文件 16 KiB、文件名 100 个）再缓存，缓存时长：搜索 1 分钟、技能 5 分钟、仓库 6 小时、审计 30 分钟；GitHub 连不上或匿名额度用完时，沿用过期不超过一天的仓库答复，GitHub 给出别的答复（例如拒绝访问）时仓库记为未查询。预览先读技能，skills.sh 没有的技能不再问 GitHub，再依次读仓库和审计。每个账号每分钟最多 20 个计数，按实际要取的答复计：搜索 1；预览与导入对技能、仓库和（预览的）审计中缓存里没有、对方也没有要求暂停请求的每项计 1，至少 1；同时最多 2 个请求，超出 429 `skill_registry_rate_limited`；全站对两家合计每分钟 120 次（可突发 30 次）；skills.sh 返回 429 或 GitHub 的匿名额度用完时，按对方给的时间停止请求（最长 1 小时）。导入只保存 SKILL.md 的文字，检查与上传文件相同；附带的脚本等文件只列出，不保存、不运行。导入的技能记下 skills.sh 条目、来源仓库和导入时得知的许可证（`tenant_skills.attribution`，迁移 041），之后编辑也保留。许可证判定（先去掉不显示的字符再读：隐藏格式字符、软连字符、变体选择符等；换行、连续空格和不换行空格都当作一个空格；markdown 去掉词语之间的标记——强调、HTML 实体与标签——并按 CommonMark 的规则把代码块当作示例跳过）：SKILL.md 声明的许可证（任何层级、license / licence 任何写法，含续行与空行后的续行）出现专有、禁止商用、禁止演绎、保密、不得再分发或 CC BY-NC / BY-ND，或者许可证与声明文件里出现这类条款的说法（专有许可、专有软件、非商业用途等；许可证文件里宽松许可那种“可用于任何目的，商业或非商业均可”不算；GNU 许可证正文不按这些字眼判断，因为它本身就提到专有程序），为 restricted；SKILL.md 在说明块顶层声明了 AwwO 认得的宽松许可（MIT、Apache-2.0、BSD、ISC、0BSD、Unlicense、CC0-1.0、CC-BY-4.0 等；列表的每一项须相同），或者没有声明而 GitHub 认出来源仓库是这些许可之一，并且技能里没有别的条款，才为 open：没有别的提到许可证、条款或权利的键（更深层的 license、`licenses:`、`license-file:`、`Terms of Use:`、`restrictions:`、行内映射里的 license），说明块的注释和技能自身字段以外的键的值读不出条款，没有任何名字的自带许可证文件（名字里任何一个词是 license / licence / eula / terms / legal / agreement 等：LICENSE、LICENSE2.txt、COMMERCIAL-LICENSE.md、COMM-LICENSE.txt、UNLICENSE、ACME_EULA.pdf、ACMELicense.pdf、LEGAL.md、TERMS.md、ACME_TERMS_OF_USE.md、读得出条款的 ACME_TERMS.md（术语表之类不算）、LICENSE.cs 这样的译本、LICENSES/ 与 legal/ 文件夹里的任何文件，以及下一层文件夹里以许可证命名的文件——fonts/、data/、templates/ 等素材文件夹除外，docs/、references/ 等内容文件夹只看名为 LICENSE、COPYING、EULA 的文件；源文件头、模板和 license_check.sh 这类代码文件不算），正文和文件夹的 README（任何语言版本）里没有点明许可证、版权或条款的行（相关标题，含带表情或编号的；`**License:**`、`License – …`、`Legal:` 这样的标签或链接；表格单元格；“Licensed …”、“Terms and conditions”；`© 2026`、`Copyright Acme`；markdown 与 HTML 写法都算；把 license 当动词或字段名用的不算），全文没有 SPDX 行、“保留所有权利”、“商业或非商业用途”的说法或许可条款，声明文件（NOTICE、COPYRIGHT、第三方声明）只是致谢、不提专有、不是 GNU 许可证，许可证与声明文件合计不超过 5 个；其余（没有许可证、GPL / MPL / CC BY-SA 等附带条件的许可、自带许可证文件、互相矛盾、查不到）为 unknown。自带的许可证文件全文展示，但不会单凭它判为 open：一份文本可以写着宽松许可的字句，又附带自己的条款。只有 open 可以直接导入，其余须成员读过条款后确认，来源里会注明是成员确认后导入的。skills.sh 的使用条款允许合理使用其公开接口并鼓励缓存；它的 robots.txt 不许爬取 /api/，AwwO 只在成员搜索或选择时请求。

**记忆** 只由人写入或确认（proposed 需确认才生效），不会静默采集。受理时取置顶记忆和与任务最相关的记忆（最多 12 条、4 KiB）冻结进快照，作为带引号的背景资料放在用户消息里，系统提示说明它不是指令、与任务冲突时以任务为准。没有记忆的工作区请求逐字节不变。

**网页读取** 默认关闭（`AWWO_WEB_READER=on` 开启；`AWWO_WEB_READS_PER_DAY` 默认 30、`AWWO_WEB_READS_SITE_PER_DAY` 默认 2000）。只读 http(s) 标准端口上的公开主机名：连接时逐个检查解析出的地址，拒绝本机、内网、链路本地、保留与 IPv4 映射地址，每次跳转重新校验并重查 robots.txt（RFC 9309，以 `AwwO-Reader` 身份如实标识）；20 秒总时限、5 MiB 上限；人机验证等防护页直接拒绝（`web_blocked_by_site_protection`），不绕过。提取正文（或 RSS/Atom 条目）后，读取记录（请求与最终地址、跳转、时间、状态码、原始字节 hash、robots 结论）写入资料的 provenance。先记录再读取，失败的读取也计入每日次数。

**视频渲染** 需要单独部署 `apps/render-worker`（Playwright + Chromium + ffmpeg，见其 README），并配置 `AWWO_RENDER_URL`、`AWWO_RENDER_TOKEN` 和 `AWWO_MEDIA_DIR`（`AWWO_RENDERS_PER_DAY` 默认 20、`AWWO_RENDERS_SITE_PER_DAY` 默认 300、`AWWO_RENDER_TIMEOUT` 默认 8m）。前端发送成果工作台里构建好的页面文档；页面定义 `window.renderAt(t)` 时逐帧精确（渲染约定），否则在虚拟时钟下运行。渲染器一次只渲染一个：其他工作区的渲染保持 queued 排队，渲染器仍在释放上一个时会重试；渲染器没有接手的渲染（忙、不可用、服务重启、排队时被停止）不计入每日次数。MP4（以及可选的 GIF、帧缩略图）全部校验 hash 与文件类型后，与完成状态在同一事务里存为画布的媒体文件，随画布删除与清理；渲染记录本身是每日次数的账本，画布删除后仍保留，画布在渲染排队或进行中时不能删除。服务重启或关闭时排队或进行中的渲染标记为 `interrupted`，不会重复渲染。

## 本机版连接（云端中转）

AwwO 本地版可以让线上站点替它调用线上提供的模型，每次调用计入一个线上工作区（`relay.go`、`relay_call.go`、`relay_completion.go`、`relay_limits.go`）。默认关闭：`AWWO_RELAY=on` 开启，并须设置 `AWWO_RELAY_WORKER_URL`（本机回环上的 Pi 执行器：中转只提供它目录里的 Bedrock 模型，且只在 `/health` 报告 `computerBedrock` 时提供；Pi 执行器自己的默认模型总在目录第一位、不会是 Bedrock 模型，中转从不提供它，与 ClawHunt 隐私政策第 08 条说的一致，报告的 `maxConcurrency` 是中转同时运行的调用数，建议 16）、`AWWO_RELAY_WORKER_TOKEN`（≥ 32 个字符）和 `AWWO_TRUSTED_PROXY_CIDRS`（API 前面的代理；不设时所有调用者共用代理的地址，按地址计的限制会落到所有人头上）。本地版与个人 Key 模式下拒绝启动。

| 方法与路径（省略 /api/v1） | 请求 | 说明 |
| --- | --- | --- |
| GET /auth/relay-keys | 无 | 登录会话。`{items,limit}`：本账号的有效密钥与最近撤销的 20 个（id、name、prefix、tenant、createdAt、expiresAt、lastUsedAt、revokedAt），不含密钥本身 |
| POST /auth/relay-keys | name?（≤ 80 字，默认「AwwO 本地版」）, tenantId | 登录会话。201 `{key,item}`：密钥（`awwo_rk_` 加 43 个字符）只在这次返回，只保存其 SHA-256，90 天后失效；须是该工作区的成员、管理员或所有者，工作区正常（否则 404 `tenant_not_found`）；每个账号最多 5 个有效密钥（409 `relay_key_limit`）；会话在此期间结束（例如密码刚被修改）时 401 |
| DELETE /auth/relay-keys/{id} | 无 | 204 撤销；不是本账号的或已撤销的 404 |
| GET /relay/v1/models | `Authorization: Bearer <密钥>` | `{object:"list",data}`：工作区可用的模型（按其 entitlement），每个带 `context_window`、`max_output_tokens`、`prose_bytes_per_token`、`max_request_bytes`（504 KiB）和空的 `reasoning_efforts` |
| POST /relay/v1/chat/completions | Chat Completions，`stream:true` | SSE：开头一行 `: awwo relay`，模型工作时每 15 秒一行 `: keep-alive`，然后答复块、用量块与 `[DONE]`；失败时一个 `error` 帧，只说明类别 |

**密钥** 由程序使用：带任何 Origin 的请求一律拒绝（403 `relay_browser_refused`），网页拿到密钥也用不了。密钥只对创建它的工作区有效，每次认证与准入都核对它仍有效、成员仍是 member 以上、工作区正常；成员被移出工作区或降为只读、密码被修改或重设时，相应的密钥一并撤销，之后恢复角色也不会复活。

**请求** 在准入之前按执行器的规则检查，执行器会拒绝的请求不进入账本：角色；文本内容（content parts 合并为文本，图片与文件拒绝，`unsupported_content`）；工具定义（函数名、对象 schema、最多 64 个；参数里的数字按 JavaScript 的写法转发与计量）；工具调用与结果配对，历史中调用过而本次没有定义的工具补上定义；Bedrock 模型还须符合 Converse 的规则（工具名以字母开头、最多 64 个字符；调用 id 只含字母、数字、`_`、`-`；对话以用户消息开头和结束，开头的助手问候按执行器的方式并入系统提示）；按执行器的估算不超过模型窗口减输出上限再减 256（400 `context_length_exceeded`）；请求超过 504 KiB 时 413，同样是 `context_length_exceeded`，两者的说明都以执行器认得的「maximum context length」写成，本地版据此把调用当作超出模型容量，而不是服务故障。不支持：非流式调用（`stream_required`：前面的边缘会切断约 100 秒没有输出的响应）、`n` > 1、指定工具、`text` 以外的 `response_format`、`stop`、`none` 以外的 `reasoning_effort`；`tool_choice:"none"` 不能跟在工具调用之后；`parallel_tool_calls:false` 时只给出第一个工具调用。

**准入与计费** 与线上自己的模型调用相同，在工作区行锁下：工作区 entitlement、需要套餐的工作区与仅限套餐的模型；所有者有套餐时按套餐的同时智能体数、免费模型每日次数与点数（按站点的定价；未定价的模型 503 `model_unpriced`），没有套餐时按工作区的同时运行数、每日次数与付费路线额度（`quota_exceeded` 等，带 `x-should-retry: false`）。每次调用记一行 `model_invocations`（`relay_key_id`，迁移 042），用量照常结算；线上不保存调用内容。执行器在任何工作之前拒绝的调用不计次数也不收费：调用者自己的（请求不合规则、超长）与平台一侧的快速拒绝（Bedrock 限流、凭据、服务不可用）；Bedrock 拒绝请求本身（400）照常计入。同一密钥一分钟内超过 20 次调用者自己的这类拒绝后，那一分钟里的调用都被拒绝（429 `relay_rate_limited`）。

**站点承受能力**（单进程计数）：每个密钥每分钟 120 个请求；每个地址（IPv6 按 /64）每分钟 30 次查不到的密钥，已撤销的密钥不算，表满时只限制已计数的地址；同时处理的调用全站 32 个、每个工作区 8 个，超出时 429 `relay_busy`（`Retry-After: 5`）；同时准入 6 个（每个占一个数据库连接）；准入后的调用占中转执行器的一个名额直到结束，每个工作区最多占一半，等待工作区或套餐名额的调用不占；等待超过 60 秒同样 `relay_busy`。处理者已不在的运行中调用每分钟清理一次，只在本进程持有工作锁时。

## 平台管理

| 方法与路径（省略 /api/v1） | 请求 / 查询 | 说明 |
| --- | --- | --- |
| GET /admin/summary | 无 | tenantCount、userCount、activeRuns、completedRuns、failedRuns |
| GET /admin/tenants | limit?, cursor? | `{items,nextCursor,snapshot}`；租户状态/配额/createdAt |
| GET /admin/users | limit?, cursor? | `{items,nextCursor,snapshot}`；用户和平台角色，不返回密码 hash |
| GET /admin/runs | limit?, cursor? | `{items,nextCursor,snapshot}`；标准 run 对象 |
| GET /admin/audit | limit?, cursor? | `{items,nextCursor,snapshot}`；id,actorId,tenantId,action,resourceId,createdAt |
| GET /admin/interests | limit?, cursor? | `{items,nextCursor,snapshot}`；付费意向：id,userId,email,userName,tenantId,tenantName,routes（提出时已用完：daily/gate/bedrock/media）,clicks,createdAt（首次）,lastAt；按首次时间分页 |
| PATCH /admin/tenants/{id} | status?, maxConcurrentRuns?, maxRunsPerDay?, allowedModels?, routeLimits? | 至少一项；status=active/suspended，并发整数 1–100，每日整数 1–100000；200 返回更新的 tenant（含 allowedModels、routeLimits） |

`allowedModels` 是本工作区的模型清单（entitlement），三态：字段缺省=不改动；`null`=解除限制；数组=替换为该清单。最多 64 个 ID，每个 ID 非空、≤200 字节、不含空白、控制字符或逗号；服务器去重并排序后存储。`null`（即未限制）表示 worker 公布的全部模型都可选，所有现存工作区默认如此；`[]` 表示禁止全部模型。清单是过滤器而非注册表：列了但 worker 未公布的 ID 既不会被提供也不会被运行。写入清单**不取消任何运行**：每次模型调用在扣减配额的同一事务里按 tenants 当前行重新授权（`FOR UPDATE`），被移除的模型无法再被调用一次——排队中的运行、图节点子运行、团队后续成员、重启后恢复的图，全部在各自的准入处以 `model_not_allowed` 终止；而已经发出的调用是在旧清单下被授权的，不会被追溯终止，需要立即掐断在途调用请改用暂停工作区。原始清单只在平台管理端投影（`GET /admin/tenants`、本 PATCH 的响应）出现；工作区成员通过 `GET /tenants/{tenantId}/runtime` 读取已与 worker 实际公布目录求交的结果。部署设置 `AWWO_NEW_WORKSPACE_ALLOWED_MODELS`（逗号分隔，校验与本字段相同；仅限 operator 凭据模式，personal 模式的目录按连接命名模型，启动时拒绝）与 `AWWO_NEW_WORKSPACE_MAX_RUNS_PER_DAY` 只为此后新建的工作区预置清单与每日额度，不改动已有工作区，之后仍可用本 PATCH 修改。

`routeLimits` 是本工作区按付费模型路由的每日次数（在每日额度之内），同样三态：字段缺省=不改动；`null`=取消路由次数（工作区也不走付费套餐）；对象=替换，例如 `{"gate":3,"bedrock":1,"media":1}`；空对象 `{}` 不限任何路由、不受也不计入任何全站上限，但工作区仍走付费套餐（运营方自己的不限次工作区）；没有套餐时不显示免费额度。存储的对象只含本版本不认识的路由时，所有路由关闭。路由按模型 ID 判定：`bedrock.*` 为 `bedrock`，`rh.*`（图像与视频）为 `media`，其余文本模型为 `gate`，部署设置 `AWWO_ROUTE_FREE_MODELS` 列出的自托管默认模型不计入任何路由、只占每日额度。键只能是这三个，值为 0–100000 的整数（0 表示关闭该路由），其他写法返回 400。文本调用在准入时超出本工作区路由次数，运行以 `premium_quota_exceeded` 失败；超出部署设置 `AWWO_ROUTE_TOTAL_PER_DAY` 给所有带路由次数的工作区设的全站每日上限（对象里没写的路由也算；`{}` 除外），以 `premium_capacity_exceeded` 失败；图像与视频分别返回 `429 media_quota_exceeded` / `media_capacity_exceeded`。部署设置 `AWWO_FREE_MODEL_TOTAL_PER_DAY`（不设或 0 = 不限）给 `AWWO_ROUTE_FREE_MODELS` 列出的默认模型设全站每日上限，计数和受限的工作区与路由全站上限相同（带路由次数的工作区，`{}` 除外，没有 routeLimits 的不算），超出时运行以 `free_capacity_exceeded` 失败；付费套餐的调用与运营方规划模型的调用既不计入也不受限，`not_incurred` 的调用不占名额。没有 routeLimits（null）的工作区既不受路由次数限制，也不计入全站上限。部署设置 `AWWO_NEW_WORKSPACE_ROUTE_LIMITS` 只为此后新建的工作区预置路由次数。所有者有付费套餐的带路由次数工作区改按套餐计：付费模型扣点数（用完以 `credits_exhausted` 失败），不占路由次数与全站上限；本工作区的并发数与每日次数也不再适用，改为账号级的套餐上限：同时运行的智能体（所有者所有套餐工作区合计，每个运行占一个名额、运行内并行的其他调用各占一个，运行的第一个调用不等待；用满时新运行返回 `429 plan_busy`）、默认模型每日次数、每日图片 / 视频生成（`429 plan_media_quota_exceeded`）；超出套餐工作区数的工作区返回 `402 plan_required`。暂停仍然生效。

以上全部要求 platformRole=admin。租户 owner 并不能访问平台后台。每日限额按 UTC 日期计算；降低额度不主动中断正在进行的模型调用，但团队后续成员调用需再次通过准入。暂停租户禁止新增业务写入，并取消当前活跃运行、记录事件；Go 保留历史读取权限，当前 SaaS 暂停页提供切换工作区与退出。恢复不自动重新执行取消过的任务。

reader 可读取原画布、会话及历史；业务写入由 Go 独立拒绝，原 CanvasSurface 的只读模式不发起保存、初始化、运行、规划或恢复写入。reader 仍可保存自己的账号配色；语言和浅深主题是浏览器偏好。

当前不提供支付、邮箱验证/找回、OIDC、文件上传下载或工具/工程文件执行。节点团队以 Pi 文本推理为范围；协议 fixture、真实模型、本地浏览器及生产验收须分别报告，实际验收范围以对应日期的报告为准。
