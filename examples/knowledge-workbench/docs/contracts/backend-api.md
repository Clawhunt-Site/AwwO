# 知识库后端业务与接口契约 v1

事项：AWW-6；producer_node：B；contract_version：1.0；evidence_level：design；2026-09-04。
artifact_ref：backend-api.md。

## 1. 来源、范围与交付状态

source_revision：P/AWW-2 v1.1、U/AWW-3 v1、G/AWW-4 v1；精确路径、SHA-256 及静态验证结果见 validation-report.json。本文只消费三份已声明上游产物，不读取其他节点私有上下文。

采用 P 的模块化单体逻辑边界：IdentityProvider、SessionService、Authorization、MetadataRepository、ContentStore、SearchIndex、AuditSink。逻辑模块不等于部署服务。本文定义设计及后续服务验收点；没有业务服务代码、数据库迁移、真实认证或运行通过记录。

首版：单一身份源适配、固定四角色、工作区、成员与邀请、文本/Markdown 文档、版本、分类标签集合、质检与发布、归档和软删除、关键词检索、数据看板、工作区业务审计。无计费、单文档 ACL、公开分享、跨租户迁移、向量问答、连接器、自动采集、文件上传、恢复、硬删除和导出 API。不安装依赖，不访问外部业务系统，不发送业务消息，不发布或部署。

上游存在的未定技术项不阻塞设计交付。第 11 节是相关实现前的决策条件，不能据本设计声称实现已获授权。

## 2. 模型映射与权威字段

| 聚合 / 数据 | 关系、约束和写入责任 |
| --- | --- |
| User / ExternalIdentity / Session | 完整沿用 U；唯一(provider_key,provider_subject)；身份/会话字段只由服务端构造，不重复建立账号体系 |
| Workspace / Membership / Invitation | 完整沿用 U；唯一(workspace_id,user_id)；active workspace 恰一有效 Owner；邀请不授予业务权限 |
| Document | 沿用 G：id、workspace_id、collection_id、title、category_id、owner_id、source_ref、language、visibility=workspace、state、双版本指针、revision、可信作者与时间；编辑投影不作为发布视图来源 |
| DocumentVersion | 沿用 G 不可变正文与 metadata_snapshot；唯一(workspace_id,document_id,version_no)；同文档线性 parent_version_id；quality_status 是可重算派生值 |
| Collection / Category / Tag / DocumentTag | 沿用 G；字典 active/retired；Category/Tag 规范名执行 NFKC、trim、casefold 并在工作区内唯一；集合不是授权边界 |
| Source | manual 或 markdown_import；创建文档同时登记；手动 origin_ref=internal:document/{id}；导入为内部文本收件引用，不去抓取 URL；更正来源建立新记录 |
| QualityRun / QualityFinding | 绑定 workspace/document/version/document_revision/ruleset_revision；每个实际执行规则一条结果；缺 blocker、error、unchecked 均不是 passed |
| AuditEvent / AuditOutbox | G 事件字段为持久化主名；补 U 的 actor_type、reason_code、schema_version 和允许列表 before/after；event_id 映射 id，server_time 映射 occurred_at，actor_user_id 映射 actor_id；outbox 可靠追加且按事件 ID 去重 |
| IdempotencyRecord（B 内部） | 唯一(workspace或身份作用域,subject,method,route,key)；保存请求指纹、运行状态和结果引用；不是客户端可编辑实体 |
| QuerySnapshot（B 内部逻辑） | 保存授权发布集的查询快照/水位与游标绑定；实现可以使用数据库快照或等效机制，方案待选；不作为永久访问凭证 |

所有租户实体及关联必须校验复合键 (workspace_id,resource_id)。版本还须校验 document_id。数据库约束与服务端校验共同保证同租户；数据库类型待选，本文不伪造 SQL 已生效。content_ref 仅内部保存，不返回桶名、签名链接、存储凭证或绕过文档权限的下载地址。

发布版本的 metadata_snapshot 具体投影为：title、category{id,name}|null、tags[{id,name}]、owner{user_id,display_name}|null、source{id,kind,origin_ref,source_uri}|null、language、collection{id,name}|null，同时保留 G 的 category_id、tag_ids、owner_id、source_ref、collection_id。正文、这些发布相关名称及来源信息一并冻结；分类/标签/集合改名不反向重写已发布版本。注销后的显示脱敏规则待 U/G 冻结；无权读取联系信息时不返回邮箱等附加字段。

Document.title 等最新投影只能出现在管理 DTO。版本正文及其来源明细继承文档权限；没有独立可枚举的 /sources 或 /content_ref API。最新草稿指针为空不代表无已发布内容。

## 3. U/G 权限动作对齐与空缺处理

| G 逻辑动作 | U 授权动作 / 裁决 |
| --- | --- |
| document.create | document.create |
| document.read_published / read_draft | document.read.published / document.read.draft |
| document.update | 正文=document.edit；元数据=document.metadata.update；标签=document.tag.assign；组合请求须全部允许 |
| document.publish / archive / delete | document.publish / document.archive / document.soft-delete |
| quality.read | document.read.governance；U 矩阵的 read.draft / versions / governance 统一展开为 document.read.draft / document.read.versions / document.read.governance |
| 主动质检 | U 未声明 quality.run，独立手动执行入口不开放；发布内质检作为 document.publish 的强制步骤 |
| taxonomy.manage：集合 | collection.create / update / delete-empty，仅 Owner/Admin |
| taxonomy.manage：标签 | tag.create / update / delete-unused，Owner/Admin/Editor |
| taxonomy.manage：分类 | U 未声明 category 写动作；默认拒绝。首版契约只提供分类候选读取，分类维护为待 U 确认的扩展，不以 taxonomy.manage 提权 |
| audit.read | audit.read，仅 Owner/Admin |

分类候选读取由 document.read.published 的发布投影或 document.metadata.update 的编辑辅助视图保护，不引入未授权 category.manage。初始有效分类的受控配置方式必须在实现前由 U/G/B 冻结；没有有效分类时允许保存草稿，发布返回 422，不能虚构默认分类。

G 的泛化字典权限由 U 的细分矩阵收敛：Editor 可以管理标签，不能管理集合或治理规则。未知角色、动作或缺失上下文默认拒绝。owner_id 为责任人，不是 Owner 角色；Editor 可编辑任何工作区文档，不因 created_by 或 owner_id 限定为本人。

Editor 仅有 membership.read self，因此不提供其全员列表或新增 owner-directory 权限。前端负责人选择基线为“自己或保留文档现有责任人”；Owner/Admin 可由受控成员列表选择任一活跃成员。Editor 提交已有合法上下文取得的 owner_id 时按 document.metadata.update 与同工作区活跃成员约束校验；不扩大成员资料读取权限，失败统一 INVALID_REFERENCE，不区分账号存在、停用或他租户。增加全员最小负责人候选需 U 明确授权后再开放。

## 4. HTTP、DTO、校验和错误约定

以下路径相对 /api/v1；所有 UUID 为不透明字符串。时间 UTC RFC3339；revision 正整数。请求/响应 JSON UTF-8。客户端可带 X-Request-Id（1–128 个字母数字或 -_.）；缺失或非法时服务端生成，响应始终返回可信 request_id。

浏览器使用 U 的服务端不透明主机 Cookie，Secure、HttpOnly、SameSite=Lax、固定 Path、HTTPS。所有变更校验 Origin 和 CSRF；读取 /session 获得非身份凭证的 csrf_token，用于 X-CSRF-Token；未登录的登录挑战也须绑定浏览器事务。业务响应 Cache-Control: private,no-store。F 使用 credentials:include，不保存会话到 localStorage。

成功：{data:<DTO>,error:null,request_id:string}。失败：{data:null,error:{code:string,message:string,details:object,retryable:boolean},request_id:string}。分页 data={items:DTO[],next_cursor:string|null}。删除、退出等成功仍为 200 JSON，不用 204 破坏统一信封。创建一般 201；异步账号注销接受为 202（仅持久化状态已提交时）。

输入限制为 B 的 v1 设计限额，不是已测容量：title≤200 Unicode 码点，字典 name 1–80，workspace name 1–100，language≤35，正文 UTF-8≤1 MiB，tag_ids≤20 且去重，query≤200，cursor≤4096，idempotency_key 为 UUID。limit 默认 20、范围 1–100。字符型字段禁止 NUL；title 可空草稿、发布 trim 后非空；正文不静默改写或截断，checksum 对保存字节计算；未知字段、枚举/类型错误、超限返回 422。所有身份、state、指针、checksum、revision 结果值及审计字段为只读，伪造输入返回 422。

版本创建输入 ContentInput={content_format:text|markdown,content:string,title:string,category_id:UUID|null,tag_ids:UUID[],owner_id:UUID|null,collection_id:UUID|null,language:string,source:{kind:manual|markdown_import,source_uri?:string}}。source_uri 只允许无 userinfo、无 query、无 fragment 的 http/https 引用，不自动访问；含敏感内容仍由提交者负责，本设计没有自动敏感识别能力。创建时各字段必传，可用明确空值保存草稿；更新采用完整替换，source 可替换为 source_ref 复用该文档已有来源，二者恰一。manual 的内部引用由服务端生成。缺失的发布必填项不禁止草稿，但任何非空关联必须合法且字典 active。

PublishedDocument={doc_id,workspace_id,version_id,title,content_format,content,category,tags,owner,source,collection,language,published_at,capabilities}；不含 revision、草稿指针、latest_updated_at、草稿质检或总版本数。SearchHit 为其无正文投影 {doc_id,version_id,title,snippet,category,tags,collection,published_at}；snippet 是≤240 码点纯文本，F 按文本呈现。实际展示 content/Markdown 时由 F 使用安全渲染，不直接执行 HTML。

ManagedDocument={doc_id,workspace_id,state,revision,latest_draft_version_id,current_published_version_id,latest_metadata,created_at,updated_at,published_at,capabilities}；latest_metadata 与第 2 节 metadata_snapshot 同形。仅 Editor+；归档/删除管理视图只返回 {doc_id,state,revision,archived_at,deleted_at}，不返回正文/标题/来源/版本列表。Version={version_id,document_id,version_no,parent_version_id,metadata_snapshot,content_format,content,checksum,quality_status,created_by,created_at}，只对 draft/published 文档有权管理者开放。VersionSummary={version_id,version_no,created_by,created_at,quality_status}。DictionaryItem={id,name,state,revision}；capabilities 为 U 当前允许动作字符串数组，只供 UI 提示，不是写入授权证据。

QualityResult={run_id,document_id,version_id,document_revision,ruleset_revision,checked_at,status:completed|error,quality_status:unchecked|passed|failed,findings:[{rule_id,severity,field,message,passed}],not_run_rules:[]}; finding 不包含无权对象名称或重复文档正文。

| HTTP / code | 场景 |
| --- | --- |
| 401 AUTH_REQUIRED / SESSION_INVALID | 缺会话或 U 判定失效；不公开账号停用等具体原因 |
| 403 FORBIDDEN / REAUTH_REQUIRED | 可见上下文动作无权 / 敏感操作缺重新认证 |
| 404 NOT_FOUND | 工作区/资源不存在或不可见；Viewer 草稿/版本及归档删除正文统一此值 |
| 409 REVISION_CONFLICT | expected_revision 与可管理实体不符；只有有管理权限者获得 current_revision |
| 409 IDEMPOTENCY_CONFLICT / REQUEST_IN_PROGRESS | 同 key 不同请求指纹 / 原请求尚未完成；均不自动重试 |
| 409 CURSOR_STALE / INVALID_STATE / RESOURCE_IN_USE / OWNER_TRANSFER_REQUIRED | 查询快照过期或绑定失效 / 状态不允许 / 被关联 / Owner 责任未转移 |
| 422 VALIDATION_FAILED / INVALID_REFERENCE / QUALITY_FAILED / INVITATION_INVALID | 字段校验 / 非法关联 / 阻断规则失败 / 邀请无效 |
| 429 RATE_LIMITED | 受控入口限流，返回 Retry-After，不区分账号存在性 |
| 503 AUTH_DEPENDENCY_UNAVAILABLE / AUDIT_UNAVAILABLE / CONTENT_UNAVAILABLE / QUALITY_UNAVAILABLE / SEARCH_UNAVAILABLE | 无法确认授权、事务审计/正文/质检/检索依赖故障；失败不推进状态 |

details 仅含安全字段路径、rule_id 等允许项；不得暴露跨租户 ID、名称、SQL、堆栈或凭证。401/403/404/409/422 retryable=false。429/503 仅可恢复故障设 true 并给 Retry-After；写入重试仍须同幂等 key 和相同请求，不能因 retryable 自动产生第二次业务变更。

## 5. 身份与工作区路由

方法、路径、请求体、响应 data 与鉴权如下；请求体未列出的字段拒绝。IdentityProvider 相关 proof/challenge 是选型前的逻辑不透明值，真实格式、验证清单、错误重定向与 callback 适配由 U/B 在选型后冻结；不会提供可用的模拟认证。

| 方法与路径 | 输入 → data / 成功码 | 权限与业务条件 |
| --- | --- | --- |
| POST /auth/login/start | {return_path} → {challenge_id,next_step} / 200 | 站内相对 return_path，拒绝 //、scheme、反斜杠与编码绕过；入口限流，绑定浏览器挑战 |
| POST /auth/login/complete | {challenge_id,proof} → {user:{user_id},requires_workspace_selection:true} / 200 + Set-Cookie | proof 可信、挑战一次性；active User；轮换会话；格式由适配器冻结 |
| GET /session | 无 → {user:{user_id},csrf_token,capabilities} / 200 | 有效会话；不返回 Cookie、hash 或内部 session_id |
| POST /auth/logout | {} → {revoked:true} / 200 | Origin/CSRF；撤销当前会话提交后清 Cookie；重复退出相同成功；撤销未知则 503 |
| POST /auth/logout-all | {idempotency_key} → {revoked:true} / 200 | 有效会话；auth_epoch 递增、全部会话撤销；已撤销会话重放返回 401 |
| POST /auth/reauth/start、/auth/reauth/complete | 与登录挑战类似 → {next_step} 或 {reauthenticated:true} / 200 | 必须原有效会话；服务端绑定同一主体，不允许切换账号冒充 reauth |
| POST /account/deletion | {idempotency_key} → {status:deletion_pending} / 202 | 有效会话、满足 U 重新认证；全部 Owner 责任已转移，撤销会话；不是物理删除完成 |
| GET /workspaces | {cursor?,limit?} query → Page<{workspace_id,name,role,revision}> / 200 | 仅当前用户 active Membership 的 active 工作区 |
| POST /workspaces | {name,idempotency_key} → {workspace_id,name,revision,role:Owner} / 201 | active User；创建 Workspace+Owner 原子提交，与注销串行化 |
| GET /workspaces/{wid} | 无 → {workspace_id,name,revision,role,capabilities} / 200 | workspace.read；无成员关系统一 404 |
| PATCH /workspaces/{wid} | {name,expected_revision,idempotency_key} → Workspace / 200 | workspace.settings.update，仅 Owner；不接受从普通设置接口 suspended/active 变更 |
| GET /workspaces/{wid}/members | {cursor?,limit?} query → Page<Member> / 200 | membership.read，Owner/Admin；Member={membership_id,user_id,display_name,masked_email,role,status,membership_revision} |
| GET /workspaces/{wid}/members/me | 无 → Member / 200 | membership.read self，四角色；不允许用此路径读取他人 |
| PATCH /workspaces/{wid}/members/{mid} | {role?,status?:active|disabled,expected_revision,idempotency_key} → Member / 200 | role.update/disable/enable 分别检查；至少一个变更；Owner 不可操作；Admin 原/新目标均为 Editor/Viewer 且非 self；removed 不可 enable |
| DELETE /workspaces/{wid}/members/{mid} | {expected_revision,idempotency_key} → {removed:true,membership_revision} / 200 | membership.remove；目标不为 Owner；Admin 限 Editor/Viewer 且非 self |
| POST /workspaces/{wid}/members/me/leave | {expected_revision,idempotency_key} → {removed:true} / 200 | membership.leave self；Owner 409，提交后本工作区失效 |
| POST /workspaces/{wid}/invitations | {email,role?:Admin|Editor|Viewer,idempotency_key} → {invitation_id,role,status:pending,revision,expires_at,delivery_status:pending} / 201 | membership.invite；默认 Viewer；Admin 不可邀 Admin；只持久化邀请，非已发送证明；不返回明文 token |
| GET /workspaces/{wid}/invitations | {cursor?,limit?} query → Page<{invitation_id,masked_email,role,status,revision,expires_at}> / 200 | membership.invite，Owner/Admin；无公开邀请目录 |
| POST /workspaces/{wid}/invitations/{iid}/revoke | {expected_revision,idempotency_key} → {status:revoked,revision} / 200 | 当前 membership.invite 和目标角色限制；拒绝撤销已接受邀请 |
| POST /invitations/accept | {token,idempotency_key} → {workspace_id,membership_id,role,membership_revision} / 200 | active 登录账号且邮箱可信匹配；复查邀请人权限；重复接受不新增或升级；token 不入 URL/日志 |
| POST /workspaces/{wid}/owner-transfer-intents | {target_membership_id,expected_revision,idempotency_key} → {intent_id,status:pending,revision} / 201 | 当前 Owner 近期 reauth；目标 active 非 Owner；intent 绑定双方、workspace revision，非直接修改角色 |
| POST /workspaces/{wid}/owner-transfer-intents/{iid}/accept | {expected_revision,idempotency_key} → {status:accepted,revision} / 200 | 仅绑定目标本人确认；不提前授予 Owner；这是 U 的“目标已确认接受”记录 |
| POST /workspaces/{wid}/owner-transfer-intents/{iid}/commit | {expected_revision,idempotency_key} → {workspace_revision,new_owner_membership_id} / 200 | workspace.owner.transfer，原 Owner 近期 reauth、双方及已接受 intent 仍有效；事务内目标 Owner、原 Owner Admin；revision 冲突 409 |

expected_revision 对 members 指 membership_revision，对 workspace/settings 指 Workspace.revision，对 invitation/intent 指本对象 revision；转移 commit 还校验 intent 捕获的 Workspace.revision 和双方 membership_revision。Owner/member 变更同步递增所需授权版本，使过时 intent 失效；intent 过期与 reauth 参数按 U 冻结后生效。邀请重发使用“撤销旧邀请并创建新邀请”，不复用旧 token，不自动发送邮件。

## 6. 文档、字典与治理路由

本节路径前缀为 /workspaces/{wid}。每次变更均带 idempotency_key；已有资源还带 expected_revision。

| 方法与路径 | 输入 → data | 权限与状态 |
| --- | --- | --- |
| POST /documents | ContentInput + idempotency_key → ManagedDocument / 201 | document.create；同事务 Document/Source/Version/Outbox；revision=1 |
| GET /documents/{did} | 无 → PublishedDocument / 200 | document.read.published；state=published 且发布指针存在；即使 Editor 也不自动改成草稿 |
| GET /documents/manage | {state?:draft|published|archived|deleted,cursor?,limit?} → Page<ManagedDocument> | document.read.draft；默认 draft,published；archived/deleted 返回最小状态 DTO |
| GET /documents/{did}/manage | 无 → ManagedDocument | document.read.draft；draft/published 正常；archived/deleted 仅状态元数据 |
| POST /documents/{did}/versions | ContentInput 或已有 source_ref + expected_revision + idempotency_key → {document:ManagedDocument,version_id} / 201 | document.edit / metadata.update / tag.assign 按变更项取交集；仅 draft/published；追加不可变快照，不改旧发布指针 |
| GET /documents/{did}/versions | {cursor?,limit?} → Page<VersionSummary> | document.read.versions；仅 draft/published，Viewer 404；summary 无正文；version_no 降序 |
| GET /documents/{did}/versions/{vid} | 无 → Version | document.read.versions + document.read.draft；版本属于 did/wid；归档删除统一 404 |
| GET /documents/{did}/quality-runs | {version_id?,cursor?,limit?} → Page<QualityResult> | document.read.governance；仅 draft/published；本工作区/文档精确绑定；独立 POST 执行路由未开放 |
| POST /documents/{did}/publish | {version_id,expected_revision,idempotency_key} → {document:ManagedDocument,published:PublishedDocument,quality_run_id} / 200 | document.publish；version_id 必须 latest_draft；同步复核阻断规则与动态约束后原子发布 |
| POST /documents/{did}/archive | {expected_revision,idempotency_key} → {doc_id,state:archived,revision} / 200 | document.archive；仅 published；保留历史但立即退出普通读取 |
| DELETE /documents/{did} | {expected_revision,idempotency_key} → {doc_id,state:deleted,revision} / 200 | document.soft-delete；draft/published/archived；逻辑删除，无恢复/清除 API |
| GET /collections、/tags | {view?:published|manage,cursor?,limit?} → Page<{id,name}> | 默认 published，四角色仅可读发布投影；manage=collection.read/tag.read，仅 Editor+；不返回成员或 ACL |
| GET /categories | 同上 → Page<{id,name}> | published 通过 document.read.published；manage 通过 document.metadata.update，返回 active 字典供编辑选择 |
| POST /collections、/tags | {name,idempotency_key} → {id,name,state:active,revision} / 201 | collection.create 限 Owner/Admin；tag.create 允许 Editor+ |
| PATCH /collections/{id}、/tags/{id} | {name?,state?:active|retired,expected_revision,idempotency_key} → DictionaryItem | collection.update 或 tag.update；至少一项；不回写历史发布快照；B 对可变字典增加 revision |
| DELETE /collections/{id}、/tags/{id} | {expected_revision,idempotency_key} → {deleted:true} | delete-empty/delete-unused；检查当前/历史所有引用，存在则 409；不得级联删除；不提供分类写入 |
| GET /governance/rules | 无 → {revision,ruleset_revision,rules,stale_after_days:null|integer} | document.read.governance；未配置的过期规则标 not_run |
| PUT /governance/config | {stale_after_days:integer,expected_revision,idempotency_key} → {revision,ruleset_revision,stale_after_days} | governance.rules.update，仅 Owner/Admin；建议合法值 1–3650，初值 null；不得关闭 blocker |
| GET /audit-events | {from,to,action?,actor_id?,resource_id?,cursor?,limit?} → Page<AuditEventView> | audit.read，仅 Owner/Admin，workspace 限定；[from,to) UTC，from<to，范围不超过 90 天；无全局身份日志 |

静态路由 /documents/manage 必须优先或与 /documents/{did} 的 UUID 参数校验消歧。以上 PATCH 的 revision 为 B 对可变配置的乐观锁补充；文档引用快照仍沿用 G。管理字典列表返回 DictionaryItem，故编辑者可取得 expected_revision；published 列表仍仅 id/name 投影。其他列表稳定排序：文档 created_at DESC、doc_id ASC；字典规范 name ASC、id ASC；版本 version_no DESC；质检 checked_at DESC、run_id ASC；审计 occurred_at DESC、id ASC；工作区/成员/邀请按各自服务端不透明 ID ASC，不假造上游未定义的 created_at。游标绑定主体/工作区/授权/过滤和对应集合的内部变更版本，集合发生变更后 409 CURSOR_STALE；普通 published 字典只绑定发布视图版本。成员/邀请/审计/质检等内部列表禁止向 Viewer 开放；Editor 的规则/质检列表按既定治理权限开放。

AuditEventView 使用第 2 节统一字段，before/after 只含允许的 role/state/version/revision，不含完整正文、查询词、邀请 token、会话或未授权 actor 资料。审计读取本身追加事件且不递归触发读取；本次读取审计追加在查询快照之后，不计入本次结果。对审计这类追加式历史列表，分页特别绑定首次查询的提交水位并排除水位之后追加的事件，不因读取自身追加的审计而使下一页失效；当前授权仍须重验。源文档删除不清除审计。全局登录/会话事件和无合法成员上下文的跨租户探测进入受控身份安全日志，不把外来主体身份写入目标工作区的可读业务审计。

## 7. 授权、事务、重试与索引一致性

执行顺序：验证 Session/账号 → 验证候选 workspace 的 active Membership/Workspace → 用 workspace_id 限定资源查询 → 判断可见性 → U.authorize(action,resource) → 校验字段/状态/revision → 事务提交前再次验证账号、会话、成员和策略版本 → 原子业务变更与审计 outbox → 返回结果。客户端 role、owner_id、capability 和缓存命中都不能跳过此顺序。

G 的“单文档拒绝 404”和 U 的“可见资源动作无权 403”统一为：不可见资源 404；Viewer 编辑其可读已发布文档 403；Viewer 请求草稿/版本 404；在已知工作区创建无权 403。跨租户关联输入仅 422 INVALID_REFERENCE，不查询/返回其真实所属工作区。

写入线性化保证由实现选用强一致事务/锁/版本检查实现，不能只在应用层先查后写。撤权事务与写提交必须共享可串行化的授权版本验证，使撤权先提交时旧写入失败；发布时同时重新确认 owner 仍 active、字典仍 active、来源/正文 checksum 完整。任何无法确认返回 503，不依赖权限 TTL。

版本保存先保证正文对象持久可读，再在元数据事务引用；元数据提交失败留下的未引用对象进入后续受控清理，不宣称已发布或擅自物理删除。发布先执行并可靠记录精确版本的 QualityRun 及质检审计；失败结果可保留供治理查看，不修改文档业务 revision 或指针。随后发布事务内绑定精确版本、ruleset_revision、document_revision 与动态依赖版本，复核仍有效的完整 blocker 结果，再更新 state、发布指针、清空草稿指针、published_at、revision+1 并写 outbox。依赖变化使已保存质检失效，须重新检查；旧 quality_status 不能替代复核。

全部 blocker 为 META_REQUIRED、CONTENT_REQUIRED、REF_INTEGRITY、CONTENT_INTEGRITY、OWNER_INACTIVE。warning 为 TITLE_DUPLICATE、CONTENT_DUPLICATE、STALE_CONTENT；无阈值或未启用时明确 not_run，不填 passed。重复检查仅本工作区且在调用者可管理范围，发现只给安全摘要。

幂等键作用域包含 subject、workspace（或全局身份操作作用域）、method、规范 route。请求指纹排除 request_id/CSRF，但包括完整业务输入及 expected_revision。相同 key/相同指纹已提交时重新认证授权，再返回相同资源和业务结果、不再写版本或审计；若结果含内容则按当前可见状态重新投影，删除/归档/撤权后不得重放旧正文。相同 key/不同指纹 409；处理中 409 REQUEST_IN_PROGRESS；响应 request_id 为本次请求，原操作 ID 仅内部关联。

去重记录保留窗口、服务故障处理租约在上线前冻结；未知原事务是否提交时不启动第二次执行。503 前确定回滚可用同 key 重试；提交后网络丢包通过原 key 找回结果。普通业务审计不可落 outbox 则业务回滚 503；下游 AuditSink 故障由 outbox 重试，不让已提交变更丢审计。退出/安全撤销遵循 U 特例：先可靠撤销，安全日志可排队；不能因日志失败恢复会话。

索引/缓存不是权限真相。检索候选须与当前权威状态、workspace 和 current_published_version_id 一致；归档/删除/成员变化提交后的请求不能返回旧内容、片段或统计。索引落后须回退权威数据查询或返回 503 SEARCH_UNAVAILABLE，不返回缺失新发布内容的伪精确 total。候选版本不一致也不能用旧词匹配后改展示新正文。无法得到完整一致候选范围时 503，而不是用“索引总数”填充。

G 写明工作区 AuditEvent 连续保留 90 天，P/U 对期限仍待确认：此为上游冲突，B 标注“G 提议 90 天，跨契约尚未冻结”，由产品/U/G/运维共同决定；不把 G 数值当成已获全局批准。审计查询单请求最多 90 天只是查询窗口限额，不授权清除，也不决定实际保留期。全局身份安全事件、正文、版本、Source、QualityRun 的保留/清除另行决策；本轮没有清除作业，不承诺永久保留。实际运维保留、法律保留和用户资料脱敏需运行验收前确认。

## 8. 检索契约

GET /workspaces/{wid}/search，action=search.query。query 参数：query:string（可空表示浏览）、category?:UUID、tags?:逗号分隔去重 UUID（最多20，同 tags 内 AND）、collection?:UUID、cursor?:opaque、limit?:1–100。不同维度 AND，缺维度表示不限。非法 UUID/超限 422；合法但不在当前可见投影的过滤值返回空集合，不透露是否存在草稿或别租户对象。

首版 keyword 语义由 B 定义为：对保存文本/标题做 Unicode NFKC 和大小写折叠后，query 按空白拆非空词，每词均需在标题或正文中做字面包含；无高级语法、通配、正则或向量。具体全文适配器必须实现等效集合，若未来改变分词语义须升 contract/query revision 并重新验收。正文为 text/Markdown 原文，snippet 输出纯文本；包含 Markdown 语法的搜索行为据此可预测。

排序固定 published_at DESC、doc_id ASC（UUID 规范小写字典序）；不声称具有未定义的相关性排名。空 query 与有 query 使用同排序。先建立当前授权发布快照集，再应用 query/filters，得到 R；同一 R 计算 hits、snippet、total、category/tag facets 后分页。facet 采用所有已应用过滤条件后的计数，不作隐含自排除维度；每文档同 tag/category 计一次。分页只能切 R，不能先取全局一页再过滤。

响应 data={scope:{workspace_id,view:published,filters},as_of,published_view_revision:string,consistency:authoritative_published_snapshot,index_watermark:null|string,total:integer,hits:SearchHit[],facets:{categories:[{id,name,count}],tags:[{id,name,count}]},next_cursor:null|string}。published_view_revision 是每工作区独立的服务端不透明发布视图版本，仅发布、归档、删除已发布文档或真实发布投影变更时原子递增；普通草稿编辑或纯管理配置变更不递增，不泄漏编辑活动。total 为该查询快照的精确文档数，不是索引未经验证总数。分类/标签改名历史快照仍可能存在不同名称；facet 按 (id,name) 分组，响应允许同 id 的多个历史名称项，过滤按 id 统一命中，避免任意选最新名称。看板采用相同规则。

cursor 为服务端签名不透明值，绑定 workspace、subject、membership_revision、policy_revision、过滤指纹、排序、limit、published_view_revision、last sort tuple、expiry。续页先核对当前授权；权限丢失返回 401/403/404，仍有权限但绑定/发布集已变化返回 409 CURSOR_STALE，前端重置首屏；禁止跨工作区复用。只有普通草稿编辑时 Viewer cursor 仍有效；签名损坏返回 422，不公开解码内容。游标寿命待实现配置冻结，不承诺永久快照。缓存键包含上述作用域且命中重新鉴权；普通读取的 updated 语义只用 published_at。

示例（占位的文档数据仅为契约示例，不是业务实测）：

```json
{"data":{"scope":{"workspace_id":"11111111-1111-4111-8111-111111111111","view":"published","filters":{"query":"入门","tags":[]}},"as_of":"2026-09-04T15:00:00Z","published_view_revision":"example-pub-view-1","consistency":"authoritative_published_snapshot","index_watermark":null,"total":0,"hits":[],"facets":{"categories":[],"tags":[]},"next_cursor":null},"error":null,"request_id":"example-search-empty"}
```

## 9. 看板契约

GET /workspaces/{wid}/dashboard，query={view?:published|governance,category?:UUID,tags?:CSV,collection?:UUID}；默认 published。dashboard.read.published 允许四角色；governance 另要求 dashboard.read.governance（Editor+），Viewer 请求治理视图返回 403，不默默把字段置零。

发布 data={scope:{workspace_id,view,filters},as_of,published_view_revision,metric_revision:"1",published_count,by_category:[{id,name,count}],definitions:{published_count:"distinct current published document",by_category:"same authorized published scope"}}。普通请求不含任何草稿、governance 或质量状态字段。发布计数对 state=published 且当前发布指针存在的 Document.id 去重，分类分布使用发布版本分类；与 search(query为空、相同过滤)在同一 published_view_revision 下应相等。零条可见文档 returned count=0，不借其他租户补齐。

governance 视图在以上字段外增加 governance={draft_count,blocked_draft_count,unchecked_draft_count,error_draft_count,passed_draft_count,published_findings:{documents_with_blockers,documents_with_warnings,checked_documents,unchecked_documents,error_documents,last_checked_at:null|timestamp},rules_not_run:[]}。发布发现的 blocker/warning 数仅覆盖 checked_documents，未检查与错误数分别列出；last_checked_at 为该范围最近执行时间，不能据此暗示所有文档均刚检查。草稿指标仅对调用者可管理且 state=draft/published 的 latest_draft_version_id 集合 D 计算，归档删除不入集合；治理 filters 在最新草稿快照上计算，scope 显式标明 draft_filter_basis=latest_draft_snapshot，与发布侧口径不同，不强行使二者和等于 published_count。

每文档最新有效质检状态互斥：无有效完成记录（含依赖变化的旧记录）→unchecked；最新有效执行 error→error；completed 且有 blocker false→blocked；completed 且 blocker 结果齐全且全部 true→passed；completed 缺 blocker 结果→unchecked。draft_count=四类之和。blocked_draft_count 对文档去重，不累计多条 finding；warning 失败不算 blocker。已发布内容 owner 失活/过期等治理发现单列 published_findings，不挤入草稿数。没有运行过的发布质检/过期检测不推算为“合格”，rules_not_run 和检查时间必须表达未检查范围。

看板一次查询采用一致水位，as_of 是该权威快照时间；独立两次请求可能因发布产生差异，验收须固定夹具/水位。无数据返回有定义的零值；数据源故障返回 503，不显示成功零值。首版无 dashboard.config.update 外部端点，固定指标契约，不假设提供自定义看板编辑器。

## 10. 服务验证点与 AC 交接

全部以下 runtime=not_run；此表是实现后的验证计划，不是测试通过记录。使用虚构夹具：租户 A/B；同一用户在 A=Admin、B=Viewer，另有 Owner/Editor/外部用户；每租户含发布、草稿、归档、删除和相同关键词样本。

| ID | 对应 AC / U | 测试与预期 / 证据 |
| --- | --- | --- |
| B-01 | AC-02 / U-01,10,15 | 伪造/重放登录证明、站外 return_path、CSRF、固定 session 失败；可信新登录轮换；保留脱敏 request_id 与 session 回读 |
| B-02 | AC-02 / U-02,03 | logout/all、到期、全局停用/注销后 401；单租户成员停用只影响本租户；使用可控时钟和两租户回读 |
| B-03 | AC-03 / U-04,05,11 | Viewer 修改可见发布文档 403、草稿/版本 404；跨租户关联 422；Editor 读审计拒绝；owner_id 不提权 |
| B-04 | AC-03 / U-06 | 在授权后暂停写，再撤权提交，再恢复写；旧写入失败；旧缓存/游标不能读已撤权内容；故障时 503 |
| B-05 | AC-03 / U-07 | 双 Owner 转移并发、Owner 自退/被移除/注销与建空间竞争；仅一个转移成功，恰一活跃 Owner，无部分提交 |
| B-06 | AC-03 / U-08 | 邀请人降级、邮箱不匹配、重复接受、disabled/removed 关系；不创建非法关系或提升已有角色，无邮箱存在泄漏 |
| B-07 | AC-04 | 空标题/分类/owner/来源/正文、失活 owner、retired 字典、错误 checksum、缺 blocker 结果不能发布；分别 422/503，原指针不变 |
| B-08 | AC-04 | 发布内容编辑生成新快照；旧 version 字节/元数据/作者不变；409 不覆盖原版；新草稿标题/标签/来源不出普通响应 |
| B-09 | AC-04 / U-12 | 正文写失败、元数据事务失败、outbox 失败、审计下游中断；无假成功发布，outbox 去重可回读；安全退出不因日志失败回滚 |
| B-10 | AC-04 | 相同 key 并发、不同 payload、提交后丢响应；仅一文档/版本/审计变更；同 key 重放前重新鉴权，删除后无旧正文 |
| B-11 | AC-05 / U-09 | 同一 R 重算 hits/total/facets；分页稳定不重不漏；发布/撤权后旧 cursor 失效；小 limit 不出现“先分页后过滤”少计问题 |
| B-12 | AC-05 | 暂停索引同步再归档/删除/重新发布：旧词不命中旧版，新授权状态立即生效；正文引用直读不能绕过鉴权 |
| B-13 | AC-05 | 标签/分类/集合改名后发布快照不变；facet 按 id/name 明确分组；Viewer 字典候选不含空结构、草稿或成员目录 |
| B-14 | AC-05 | 同水位 search 空 query 的 total=dashboard published_count；治理四状态互斥、blocked 按文档去重；Viewer 无治理字段；依赖失败不返回 0 |
| B-15 | AC-03,04 | Editor 可标签管理但不可集合/分类写；Editor owner 仅受控已有上下文或 self，INVALID_REFERENCE 不泄漏成员存在；字典仍被历史引用时删除 409 |
| B-16 | AC-06 / U-13 | F 映射 login/401/403/404/409/422/503、workspace 切换清状态、空结果、需要 reauth、发布与管理 DTO 分离；真实 UI 留给 F/V |
| B-17 | AC-01,07,08 / U-14 | 静态核对 7 节点/12 边、B→F/V 输入引用、AC-01～08、最终 api/implementation/checks 字符串≤1200、源哈希和 not_run 边界 |

运行证据应包含服务提交版本/环境、身份与数据夹具、步骤、expected/actual、request_id、脱敏响应、权威数据回读、passed/failed/not_run 和缺陷责任/复验条件；不能只用 HTTP 状态证明租户隔离或事务完成。

P 的 AC-01（结构）、AC-02（身份）、AC-03（授权）、AC-04（治理）、AC-05（检索/统计）、AC-06（前端与物料）、AC-07（证据）、AC-08（格式）完整沿 B→F、B→V 传递。固定节点 P/U/G/B/F/V/M；边 P→U/G/B/M、U→B/F、G→B/F、B→F/V、M→F、F→V。本文及内部复核子事项不改变画布接线，也不声称核验了真实 Session 绑定或其他节点执行结果。

## 11. 实现前决策与接收方

| 条件 | 当前处理 | 冻结责任 |
| --- | --- | --- |
| 语言/框架、数据库、事务隔离、ContentStore、索引/缓存/队列 | 仅定义端口和不变量，未选供应商/依赖 | B 与用户，相关实现前 |
| IdP、注册方式、密码/MFA、会话/邀请/reauth/intent 期限、限流 | 沿用 U 待定项，不能发模拟凭证；邀请发送另需实际授权 | 用户/U/B，身份实现与验收前 |
| 分类维护和初始化权限、Editor 全员 owner 候选、独立手动质检 | 分类写及手动 quality.run 默认拒绝；Editor self/已有合法上下文，无全员目录 | U/G/B，对应实现前 |
| 索引召回水位、游标寿命、幂等保留窗口、SLA/容量 | 未冻结数值，不作性能或更新延迟承诺；只保证不泄漏 | B/用户/运维，搜索和重试实现前 |
| 文本限额与展示语言、过期阈值 | 本文限额为 v1 设计值；stale_after_days 初始 null/not_run | G/B/用户，导入和规则实现前 |
| 审计保留与运维、脱敏、备份、正文/版本保留 | G 提议审计 90 天，与 P/U 待定项尚未统一；清除未实现 | 用户/G/U/运维，运行验收前 |
| 真实接线、页面、服务联调、上线 | 本轮均未执行，依原有 P/U/G/B/F/V/M 编排继续 | 编排方/F/V；部署另行授权 |

交付 F：路由/DTO、身份/权限、分页错误、发布与草稿分离及 mock 边界。交付 V：本节决策条件、B-01～17、AC 索引及 validation-report.json。B 本节点 design 完成不等于上述 runtime 通过；不存在后台继续实现服务的隐含任务。
