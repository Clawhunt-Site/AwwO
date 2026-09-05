# 团队知识库 SaaS：用户系统与工作区权限契约 v1

任务：AWW-3；producer_node：U；contract_version：1.0；evidence_level：design；日期：2026-09-04。

输入：AWW-3 任务说明快照 `issue-source.json`，以及 AWW-2《团队知识库 SaaS：产品边界与架构需求 v1.1》：`architecture.md`。源文件 SHA-256 记录于 `validation-report.json`。

本交付定义用户身份、服务端授权与验收预期，供 U→B、U→F 使用。B 负责与 G 的文档状态和动作对齐，再经 B/F 传给 V；不增加画布节点或连接。没有实现认证服务、模拟登录成功、连接 IdP 或执行功能联调。所有运行验收均为 not_run。

## 1. 范围与取舍

首版采用固定角色 RBAC，并强制校验工作区、成员状态、资源状态；这不构成通用 ABAC 引擎。角色为 Owner、Admin、Editor、Viewer。首版没有单文档私有 ACL、集合独立授权、自定义角色、跨工作区共享、公开链接或匿名业务读取。

上游明确排除计费，因此 Owner 的计费权限只作未来扩展，不生成可用端点或按钮。集合是工作区内的逻辑组织单位，不成为第二层租户。暂不提供账户合并、目录自动同步、恢复、物理清除、API Key、移动端或第三方开放 API。

身份源尚未选定：保留单一 IdentityProvider 适配端口，不假设已有企业 IdP，也不擅自选邮箱密码或某个 SSO。具体供应商和参数由第 8 节决策表冻结；设计交付可以完成，真实认证验收须等相应选择和实现完成。

## 2. 身份、成员与状态

| 实体 | 最小字段及不变量 |
| --- | --- |
| User | user_id、status(pending/active/disabled/deletion_pending/deleted)、auth_epoch、created_at。全局账号与租户角色分离；内部 ID 不复用 |
| ExternalIdentity | identity_id、user_id、provider_key、provider_subject、verified_email。唯一(provider_key,provider_subject)，邮箱仅作已验证联系/邀请匹配，不以同邮箱自动合并账号 |
| Workspace | workspace_id、name、status(active/suspended)、revision。所有业务资源均属于一个工作区 |
| Membership | membership_id、workspace_id、user_id、role、status(active/disabled/removed)、membership_revision。唯一(workspace_id,user_id)，重邀复用该关系并递增版本，不恢复历史角色 |
| Invitation | invitation_id、workspace_id、normalized_email、proposed_role、token_hash、status(pending/accepted/revoked/expired)、expires_at、inviter_id、revision。邀请不是 Membership，不授予业务读取权 |
| Session | session_id 的哈希记录、user_id、auth_epoch、created_at、last_seen_at、absolute_expires_at、revoked_at、auth_time、assurance。服务端持久保存撤销状态 |

账号从 pending 经身份源可信验证成为 active；disabled、deletion_pending、deleted 均不得建立或继续业务会话。单个工作区的 Admin/Owner 只能禁用本工作区 Membership，不能停用全局 User，也不能改变该用户其他工作区的成员关系。全局账号停用只接受受控的身份管理流程；本轮不设计跨租户运维界面。外部 IdP 停用不会凭空同步，本地收到可信停用事件并提交后才适用即时失效保证，同步方式和延迟须单独验收。

创建工作区要求 active User；在同一事务创建 Workspace 与其 Owner Membership。本版采用恰好一名活跃 Owner，满足上游至少一名的要求。Owner 不能被普通成员接口禁用、降级、移除或自行退出。转移要求原 Owner 近期重新认证，目标为同工作区活跃且账号有效的成员，并已确认接受；提交时再次检查双方状态及 expected_revision，在同一事务将目标升级为 Owner、原 Owner 降为 Admin。并发转移只允许一个成功，其余 409，不能出现无 Owner 或双 Owner。

非 Owner 可主动退出工作区；Owner 必须先转移。自助注销先检查所有工作区的 Owner 责任；未转移返回 409 OWNER_TRANSFER_REQUIRED，不进入注销状态。通过检查后禁止新会话与加入/建工作区，撤销全部会话并移除成员关系；这与 Owner 转移/工作区创建串行化校验，防止并发绕过。账号标识保留为不可复用墓碑，文档不会随作者注销删除；个人资料清理与审计保留按待确认策略执行，不把本设计视作物理删除实现。

邀请：默认 Viewer；Owner 可邀请/调整 Admin、Editor、Viewer；Admin 只能邀请/管理 Editor、Viewer，不能修改自身或其他 Admin/Owner 的角色、状态。接受须登录并验证目标邮箱、工作区有效、令牌未过期未撤销未使用；事务内重新验证邀请人的当前授权。重复接受不新增关系；已有 active Membership 不因邀请自动升级。禁用成员恢复须有权限的管理员显式执行；removed 成员需重新邀请。管理员变更或离职导致邀请不再有合法授权时，拒绝接受并要求重发。展示无效邀请时不泄漏邀请邮箱、工作区成员或文档。

## 3. 登录、会话与服务接入

逻辑端口（由 B 映射为路由，并非已实现 SDK）：

```text
IdentityProvider.beginLogin(return_path) -> challenge
IdentityProvider.completeLogin(challenge, proof) -> VerifiedIdentity
VerifiedIdentity = {provider_key, provider_subject, verified_email, auth_time, assurance}
SessionService.issue(VerifiedIdentity) -> opaque_session_cookie
SessionService.authenticate(cookie) -> AuthenticatedSubject | AuthError
Authorization.resolveMembership(subject, workspace_id) -> Membership | NotFound
Authorization.authorize(AuthContext, action, resource) -> {allow, reason, policy_revision}
```

认证证明仅在服务端校验；不接受客户端提交的 subject、role、verified_email、assurance 或 auth_epoch 作为授权证据。单一身份适配器要校验本次登录挑战与响应的绑定、有效期、一次性、防重放和受信来源；若选择 OIDC，B/U 冻结其具体校验清单后才可验收。登录返回地址只允许站内路径。认证失败统一文案，限流与挑战配置在真实接入前冻结，故障不回退为模拟身份。

登录成功→映射 active User→签发新会话→列出该用户活跃成员关系→用户选择或创建工作区。无工作区时显示创建/接受邀请入口，不读取任意默认租户。邀请待接受者可完成登录和校验邀请，但此时不具有目标工作区业务权限。

浏览器方案基线为服务端不透明会话：Secure、HttpOnly、SameSite=Lax 的仅本主机 Cookie；HTTPS、固定 Path、不向脚本暴露凭证。变更请求校验 Origin 与 CSRF 令牌，避免将退出/邀请接受等写操作放到 GET；敏感响应使用 private,no-store。长效凭证不写入 localStorage、URL、前端埋点或日志。登录/重新认证时更换会话标识并撤销旧标识。

退出提交服务器撤销当前会话后清 Cookie，重复退出幂等；退出全部设备递增 auth_epoch 并撤销全部会话。浏览器清缓存不能替代服务端撤销。会话有空闲与绝对过期；续期不能延长绝对期限。需要重新认证的操作不得因原会话存在而跳过校验。默认不发浏览器 bearer access/refresh token；将来启用须增加轮换、重放检测和撤销测试，不能把未过期 JWT 视为仍有权限。

AuthContext：`{subject:user_id, session_id:internal_ref, session_state, workspace_id, membership_id, role, auth_epoch, membership_revision, policy_revision, auth_time, assurance, request_id}`。所有身份和权限字段由服务端构建；workspace_id 来自请求的候选值，须经活跃成员资格与工作区状态验证才可信。缓存键至少包含 workspace_id、user_id、membership_revision、policy_revision 与查询条件；缓存命中仍校验当前有效性。

成员禁用/移除/降级事务提交后，下一次受保护请求必须读到新的成员状态与版本，不依赖 TTL、前端刷新或异步索引清理。不能强一致确认状态时返回 503。变更只影响该工作区，其他工作区仍按各自成员关系裁决。全局账号停用/注销与退出全部设备影响全部会话。写事务提交前再次校验账号、会话、Membership 及版本，拒绝在授权后被撤销的写入；开始于撤销提交前且已发送的响应无法追回，不作追溯保密承诺。

通用原则采用每次请求检查权限、默认拒绝和服务端会话失效；参考 [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) 与 [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。本文具体角色、期限建议和业务不变量为本产品设计，不是标准强制值。

## 4. 角色 × 资源 × 动作矩阵

表中允许均附带 active User、有效 Session、active Workspace/Membership、同 workspace_id、资源可见等前提；资源负责人 owner_id 只是治理字段，不授予 Owner 角色或隐式越权。未列动作默认拒绝。

| 资源 / action | Owner | Admin | Editor | Viewer |
| --- | --- | --- | --- | --- |
| workspace.read | 允许 | 允许 | 允许 | 允许 |
| workspace.settings.update | 允许 | 拒绝 | 拒绝 | 拒绝 |
| workspace.owner.transfer | 允许且满足第 2 节 | 拒绝 | 拒绝 | 拒绝 |
| membership.read（含受控成员资料） | 允许 | 允许 | 仅 self | 仅 self |
| membership.invite / role.update / disable / enable / remove | 非 Owner，目标角色限 Admin/Editor/Viewer | 原/新目标均仅 Editor/Viewer，非 self | 拒绝 | 拒绝 |
| membership.leave | 拒绝，先转移 | 仅 self | 仅 self | 仅 self |
| collection.read / tag.read | 允许 | 允许 | 允许 | 仅发布视图投影 |
| collection.create / update / delete-empty | 允许 | 允许 | 拒绝 | 拒绝 |
| tag.create / update / delete-unused | 允许 | 允许 | 允许 | 拒绝 |
| document.read.published | 允许 | 允许 | 允许 | 允许 |
| document.read.draft / versions / governance | 允许 | 允许 | 允许 | 拒绝 |
| document.create / edit / tag.assign / metadata.update | 允许 | 允许 | 允许 | 拒绝 |
| document.publish / archive / soft-delete | 允许 | 允许 | 允许 | 拒绝 |
| governance.rules.update | 允许 | 允许 | 拒绝 | 拒绝 |
| search.query / dashboard.read.published | 允许 | 允许 | 允许 | 允许 |
| dashboard.read.governance | 允许 | 允许 | 允许 | 拒绝 |
| dashboard.config.update | 允许 | 允许 | 拒绝 | 拒绝 |
| audit.read（本工作区业务审计） | 允许 | 允许 | 拒绝 | 拒绝 |
| audit.create / update / delete（用户 API） | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| billing / resource ACL / public-share / restore / hard-delete / export | 不提供 | 不提供 | 不提供 | 不提供 |

Editor 可维护本工作区任意文档，首版无“仅自己创建”约束。发布仍需 G 的质检与版本条件；权限允许不代表业务校验通过。编辑已发布文档生成新草稿，Viewer 始终只能读当前发布版本；历史已发布版本也不对 Viewer 暴露版本列表。归档/软删除退出普通搜索、看板及正文访问；管理列表若提供只允许 Editor 及以上读取状态元数据，不恢复正文能力。集合删除仅限无文档关联、标签删除仅限未使用，否则 409；不得通过删除集合级联删除文档或绕过 G。

Viewer 的集合/标签候选、文档负责人显示与统计全部从当前可读发布数据投影，仅返回最少展示信息，不含完整成员邮箱、空私有结构、草稿标题或治理数量。父子资源（版本/正文引用/标签/集合）须逐一验证属于同工作区；请求体传入其他工作区的关联 ID 不得成功关联。

## 5. 授权顺序、错误与前端约定

顺序固定：验证 Session 和账号→验证候选 workspace 的成员关系及状态→以 workspace_id 限定查询资源→确定可见性→校验 action 与角色→校验业务状态/expected_revision→提交写入与审计。未知角色、未知动作、不完整上下文、无法获取策略均不放行。后端不能先做跨租户查找再依据结果决定是否返回名称。

| HTTP / code | 对外条件与行为 |
| --- | --- |
| 401 AUTH_REQUIRED / SESSION_INVALID | 未登录、过期、退出、账号停用/注销；失效具体原因只在授权的内部日志保留 |
| 403 FORBIDDEN | 对当前已知可见资源的动作无权，例如 Viewer 编辑可读的已发布文档；不含敏感策略细节 |
| 403 REAUTH_REQUIRED | 会话有效但敏感操作所需重新认证/MFA 不满足；F 引导再次认证 |
| 404 NOT_FOUND | 不存在或不可见 workspace/resource，包含非成员工作区、不可见草稿、归档/删除正文；统一响应不透露存在性 |
| 409 REVISION_CONFLICT / OWNER_TRANSFER_REQUIRED / RESOURCE_IN_USE | 并发版本冲突、Owner 责任未转移、集合/标签仍有关联；无部分写入 |
| 422 VALIDATION_FAILED / INVITATION_INVALID | 请求字段/质检不满足；邀请无效统一文案，不提示某邮箱是否已注册 |
| 429 RATE_LIMITED | 身份入口限流，按配置返回 Retry-After，不以限流响应区分账号是否存在 |
| 503 AUTH_DEPENDENCY_UNAVAILABLE / AUDIT_UNAVAILABLE | 无法验证当前授权，或关键变更不能持久化审计；不降级放行 |

统一响应：`{data,error,request_id}`；失败 `error={code,message,details,retryable}`，details 不放原始凭证、无权对象名称或内部账号状态。401/403/404/409/422 不自动重试；429/503 仅依 retryable、Retry-After 及幂等条件重试。request_id 必须可追踪；创建使用 idempotency_key，变更使用 expected_revision，并在事务内检查。

search 的 hits、snippet、facet、count、cursor 与 dashboard 均先按同一授权/发布状态过滤，再统计、排序、分页。Viewer 的治理字段必须省略，不用 0 掩盖与管理员视图的语义差异。打开文档/正文再次鉴权，存储引用不能作为永久公开下载地址。索引更新延迟不改变授权结果。

F 页面状态：登录中/失败/重新认证；无工作区/邀请有效与失效；加载/空结果/无权/资源不存在/服务不可用。切换工作区清除上一工作区缓存和选中资源；401 清理敏感本地状态并回登录，403 保留上下文显示无权，404 不透露对象详情。按钮可按服务端 capability 提示，但 B 必须独立鉴权。若 F 制作模拟页面必须标记 mock，不能把角色切换器当真实权限控制。

## 6. 审计与隔离边界

工作区审计记录邀请创建/重发/撤销/接受、成员启停/移除/退出/角色变更、所有权转移、设置/规则/看板配置变更、文档发布/归档/软删除、审计读取；成功与拒绝结果可区分。事件字段：event_id、server_time、request_id、actor_user_id 或受控系统身份、actor_type、workspace_id、action、resource_type/id、outcome、reason_code、policy_revision、允许列表内的 before/after（角色/状态/版本）及审计 schema_version。事件使用服务器生成的 actor 与 scope，禁止信任请求中的审计主体字段。

全局登录失败、会话创建/退出/过期、密码/MFA 操作（若启用）、全局账号停用是身份安全事件。它们不含某一工作区的全部阅读授权，仅限受控身份运维访问；工作区 Owner/Admin 不能读取其他工作区活动、用户全部会话或完整 IP/UA。跨租户越权尝试写安全日志，不自动在目标工作区审计中暴露外来用户身份。工作区只展示与自身有合法上下文的业务事件及必要 actor 展示信息。

任何用户角色都不能直接创建、修改或删除审计事件；只有受控应用 AuditSink 可追加。关键业务变更与审计 outbox 同事务提交，outbox 不可写则业务无变更并返回 503；下游审计存储临时不可用可保留 outbox 重试，使用 event_id 去重，不能静默丢失。审计读取事件走独立追加路径，不递归触发审计读取。安全撤销如退出必须优先持久化撤销，安全日志失败可排队重试且不能恢复会话；仅当撤销本身无法确认时返回 503，不宣称服务端已退出。

不记录密码、原始 session/token、邀请令牌、完整文档正文、敏感查询原文或无限制请求体；邮箱和网络标识按最少必要原则掩码/受控保留。用户注销后的可识别资料清理、审计保留期限、备份清除和运营访问授权待确认，不承诺已达到某项合规认证。

## 7. 验收定义与威胁追踪

以下 P0 为后续实现验收必须项；本次只做设计一致性校验，每项 runtime 状态均为 not_run，不能将表中“预期”填为实测结果。B 执行服务端验证、F 执行页面状态验证、V 经 B/F 汇总；U 对身份/权限契约缺陷负责。

| ID / 上游 AC | 威胁与验收步骤 | 预期与证据要求 |
| --- | --- | --- |
| U-01 / AC-02 | 有效/伪造/重放登录证明；伪造 subject、role、verified_email | 仅受信证明签发新 Session，其余拒绝；保存脱敏 request_id/实际响应 |
| U-02 / AC-02 | 退出、退出全部设备、空闲/绝对过期后重放旧 Cookie | 401；新登录仍可用；用服务端可控时钟覆盖边界 |
| U-03 / AC-02 | 全局账号停用/注销；单一工作区成员禁用 | 全局前者跨工作区均拒绝；后者仅目标租户失效 |
| U-04 / AC-03 | Viewer 直接调用各写 API；伪造 Owner 字段 | 可见资源写 403，草稿读取 404；数据库和审计无伪成功 |
| U-05 / AC-03 | 用户在 A 为 Admin、B 为 Viewer；遍历他租户 ID/版本/集合/标签/正文引用 | 不借 A 的角色访问 B；他租户读取统一 404，关联写失败且无跨租户关联 |
| U-06 / AC-03 | 移除/降级提交后用旧 Session/缓存重试；暂停写入再撤权再提交 | 下一请求即拒绝，撤权后的旧写入不能提交；无 TTL 宽限 |
| U-07 / AC-03 | 最后 Owner 自退/被移除/注销；并发转移与建工作区/注销竞争 | 普通移除拒绝，需转移时 409；每个 active workspace 恰一有效 Owner，无部分变更 |
| U-08 / AC-03 | 错误邮箱、未验证邮箱、过期/撤销/重复邀请，邀请人已降级 | 无非法成员关系、角色升级或邀请细节泄漏；有效首次接受仅一关系 |
| U-09 / AC-05 | Viewer 搜索草稿关键词；分页、分面、空集合、看板、直接正文读取 | 无草稿/旧权限标题、摘要、计数或元数据；统计可由同范围发布集重算 |
| U-10 / AC-02 | CSRF、外站 return_path、固定旧 Session、凭证出现在日志/URL | 拒绝非法请求、站外跳转；登录换 Session；脱敏审计/网络证据 |
| U-11 / AC-03 | Admin 修改自身、其他 Admin、Owner；Editor 访问审计；跨租户 audit ID | 无越权，403/404 按可见性规则；Owner/Admin 仅本租户审计 |
| U-12 / AC-02、03 | 授权状态服务失败、审计 outbox 写失败；审计下游暂时中断；退出时安全日志失败 | 前两种业务失败且不写；下游重试去重可回读；安全日志故障不撤销已成功退出 |
| U-13 / AC-06 | 工作区切换、401/403/404/503、无工作区、失效邀请、Viewer 看板 | 旧租户数据清理；状态文案与能力一致；mock 与真实接入分开记录 |
| U-14 / AC-07、08 | 静态核对来源、矩阵、全局与租户边界、输出字段、证据状态 | 仅 identity/permissions/checks 字符串且各 ≤1200 字；无运行通过声明 |
| U-15 / AC-02 | 选择认证方案后验证密码恢复/MFA/限流/外部身份停用路径 | 条件场景须执行或有已冻结范围的 not_applicable 理由，不能默默略过 |

固定测试夹具建议：同一用户 A/Admin、B/Viewer；另有 A/Owner、A/Editor、外部用户；两工作区都含发布、草稿、归档、删除样本和相同关键词。不得使用真实客户数据。runtime 记录必须包含版本/环境、身份与工作区夹具、步骤、预期/实际、request_id、脱敏响应与状态/数据库回读、passed/failed/not_run，失败写责任 B/F/U 及复验条件。

## 8. 待冻结决策与交接

以下是实现启动条件，不是本设计节点的未完成事项；本轮未创建实现任务或要求部署。

| 项目 | 当前契约 / 建议值 | 决策负责人及冻结时点 |
| --- | --- | --- |
| 身份源与注册 | 单一适配器；由用户选择邮箱密码或外部身份源；自助注册是否开放待定 | 产品用户与 U，在真实身份实现前 |
| 会话参数 | 建议空闲 30 分钟、绝对 8 小时、敏感操作认证新鲜度 5 分钟；均为建议，配置未冻结不得声称运行合格 | 产品用户/U/B，在真实身份验收前 |
| 邀请参数 | 建议 72 小时、单次接受、绑定已验证邮箱；交付未发送邀请或邮件 | 产品用户/U，在邀请实现前 |
| 密码（条件项） | 若自建，建议最低 15 字符、至少支持 64 字符、无静默截断、拒绝已泄漏密码；安全哈希和恢复流程在选型后冻结，不存明文 | U/B，在密码实现前 |
| MFA 与恢复 | 建议 Owner/Admin 必须 MFA，敏感操作重新认证；形式、恢复和紧急接管待确认；无 IdP 不伪造 assurance | 产品用户/U，在特权操作运行验收前 |
| 限流与身份停用同步 | 账号/IP 组合限流、统一失败文案；阈值、恢复期、可信停用通知与同步延迟待定 | U/B，在真实登录验收前 |
| 审计 | schema 与访问边界已定义；保留期限、掩码细则、平台、outbox 运维与删除策略待定 | 产品用户/U/运维，在运行验收前 |

密码、敏感操作重新认证和统一认证失败响应的通用依据见 [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)。以上建议值不是已批准配置或合规结论。

B 接收本契约后映射接口、事务隔离、错误和 U-01～12/15 用例，并核对 G 的 action 名及发布条件；F 接收身份状态、角色矩阵与 U-13，沿既定 U→F 接线消费。冲突通过现有任务回流 U，不新增 U→G 或 U→V 连接。下游携带本文引用、版本、source_revision 与 design 证据等级；未选身份源时继续契约/模拟页面工作，不冒充认证已打通。
