# AwwO SaaS 前端对接与验收规范

本项目以现有前端交互为产品基准，由 Go 承接身份、租户、资源、持久化与运行治理，由 Pi 承接模型执行。本轮补齐原账户资料、邀请链接、语言主题、原画布只读挂载和平台配额/分页。源码接通与实际验收分别记录；不能将“API 可调用”表述为“真实模型及公网运行全部完成”。

本文基于 2026-09-07 的 `feat/awwo-go-pi-saas` 本地实现，前一文档基准为 `847d045e569d2b6c7bceb961f27b2c69aba0ec79`；实施 worktree 为 `/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-saas-20260907`。本轮代码、测试和浏览器结果以 [本地验收记录](awwo-saas-verification.md) 的新增记录为准，真实 provider 仍需本项目配置。

项目约束、分工与交付门见 [设计与开发规范](awwo-saas-design-standards.md)。

2026-09-07 Fable 整改更新：当前分支为 `feat/awwo-computer-use-acceptance-20260907`，整改基准 `a83d2acee3732e95c2f115b107f31af25c335c13`。新增列表分页、工作区创建、画布生命周期、账号配色及运行错误本地化；本轮证据与未通过边界以 [整改记录](awwo-fable-remediation-20260907.md) 为准，下面历史证据不自动代表新增功能完成 GUI 验收。

## 1. 现役入口与复用原则

### 1.1 两个实际入口

| 入口 | 实际调用链 | 当前意义 |
| --- | --- | --- |
| 原 Web 入口 | `apps/web/src/main.tsx` → `App.tsx` → `CanvasSurface.tsx` → `AgentWorkspace.tsx` → `SessionTile.tsx` / `InspectorPanel.tsx` | `App` 默认进入画布，已有工作台选择缓存可能改变打开的页面。原账户入口、语言/主题切换及运行设置由 `App` 注入画布。 |
| 新增 SaaS 入口 | `apps/web/saas.html` → `apps/web/src/saas/main.tsx` → `SaaSApp.tsx` → `CloudCanvas` → **同一个** `apps/web/src/canvas/CanvasSurface.tsx` | 新增登录、租户与画布列表、云端持久化、平台管理外壳。成员编辑画布仍使用原组件；`canvasBridge.ts` 把原调用契约映射为 Go API。 |
| SaaS 只读入口 | `SaaSApp.tsx` → `ReadOnlyCanvas` → **同一个** `CanvasSurface readOnly` | 复用原图与节点工作台，禁止写入/执行，保留浏览、历史和导出。viewer cache 与编辑草稿分开。 |

关键组件：`App`、`SaaSApp` 的 `CloudCanvas/ReadOnlyCanvas`、`CanvasSurface`。持续修改以组件和函数名定位，避免陈旧行号误导。

### 1.2 后续实现必须遵守

1. 保留原节点卡片、工作台、输入输出契约、会话侧栏、模板库、连线、规划助手和图运行交互。优先增加传输与状态注入点，不复制另一套画布。
2. 以“可见入口 → 用户动作 → 网络请求 → Go 状态 → Pi 执行 → 原 UI 回显”逐项验收。纯前端行为不必为了展示后端工作而增加 API。
3. 新增 SaaS 外壳要标明新增与替代范围。替代账户入口或只读画布时，不能自动宣称原入口所有能力已继承。
4. Go 是身份、成员权限、配额、资源和运行记录的权威来源；浏览器禁用按钮不构成授权。Pi 不拥有用户登录态，不决定租户权限。
5. 不把巨大历史 `App` 内没有当前调用链的功能纳入本轮迁移清单。仍由原画布入口实际打开的账户和设置能力，应登记差距，不能以“历史代码”略过。

## 2. 契约与状态约定

- 下表 `T` 表示 `/api/v1/tenants/{tenantId}`；其余 `/api/v1` 路径完整写出。所有源码路径均相对仓库根目录。
- **已接**：当前源码存在对应链路；并不表示真实 provider 已验收。**部分**：已有可用子集或替代视图，但未覆盖原交互或完整产品要求。**未接**：当前 SaaS 没有对应入口或服务端契约。纯前端行为在状态中另行注明。
- 集合通常返回 `{items:[]}`，错误为 `{error:{code,message}}`。401、403、404、409、413、429、503 分别需要显示登录、权限、资源、冲突、上下文、配额、运行服务问题；失败不得显示已保存或已完成。
- 六类租户资源和四类平台管理列表返回 `{items,nextCursor,snapshot}`。分页必须保留资源范围及过滤条件，切换用户/租户后重置并忽略旧响应；快照字段只是创建时间边界。
- 使用 HttpOnly `awwo_session` cookie；不将 token 写入 localStorage。节点、会话、运行、规划和成员操作都在 Go 校验租户关系及权限。
- 数据库列只描述逻辑实体，实际表结构以 Go 迁移为准。完整字段、状态与错误约定见 [API v1](awwo-saas-api.md)。

## 3. 前端能力与后端覆盖矩阵

### 3.1 原画布与节点工作台

| 前端可见能力 | 真实源文件位置 | Go API 与 Pi 职责 | 数据库或本地状态 | 当前状态 | 可观察验收 |
| --- | --- | --- | --- | --- | --- |
| 选择、创建云端画布 | `apps/web/src/saas/SaaSApp.tsx` 的 Workspace / CloudCanvas | `GET/POST T/canvases`、`GET T/canvases/{id}`；不调用 Pi | Go 保存画布归属、名称、document、外层 version | 已接；新增 SaaS 壳 | 创建后列表出现；切换浏览器页面重新打开仍有该画布；其他租户无法读取 ID。 |
| 模板库、添加 Agent、研发模板 | `apps/web/src/canvas/AgentWorkspace.tsx`；`CanvasSurface.tsx` 的 createTemplate / addAtViewCenter（均位于 `apps/web/`） | 模板生成在前端；统一 `PUT T/canvases/{id}`；不调用 Pi | 原 nodes、edges、contract、布局写入 document | 已接；复用原 UI，生成是纯前端行为 | 原研发模板产生 5 节点及对应连线，显示已同步后刷新结构一致；添加模板不会暗中执行模型。 |
| 拖拽、连线、缩放、适配、整理、撤销/重做、路标 | `apps/web/src/canvas/CanvasSurface.tsx` | 无独立动作 API；需持久化的 document 变化统一 CAS 保存；不调用 Pi | document 的节点、边、视图、路标；交互选择与撤销栈为前端状态 | 已接；主要为原前端行为 | 连线方向、端口与位置刷新可恢复；撤销按原语义改变图；不要求刷新恢复整个撤销栈。 |
| 自动保存与冲突提示 | `apps/web/src/saas/SaaSApp.tsx` 的 CloudCanvas；`canvasDraft.ts`；`apps/web/src/canvas/canvasStorage.ts` | `GET/PUT T/canvases/{id}`，PUT 携带读取到的 version，陈旧值 409 | Go document 为同步基准；草稿保存 document、baseVersion、dirty、revision | 已接；新增持久化适配 | 两页冲突后不覆盖新服务端版本；409 或断网后刷新仍可恢复/导出草稿；成功确认精确 revision 后才清理。 |
| 节点标题、角色、人格与契约编辑 | `apps/web/src/canvas/InspectorPanel.tsx`；`CanvasSurface.tsx` 的 saveInspector；`nodeThreads.ts` | 图配置走 CAS；绑定时 `POST T/agents`，人格写入 `PUT T/agents/{id}/instructions`；Pi 接收已保存指令 | document 保存节点配置及 binding；Go 保存 Agent 定义和 instructions | 已接；保留原重新绑定语义 | 修改已绑定运行配置后进入新绑定流程，旧会话身份不被覆盖；人格写入失败要显示错误，不能声称同步成功。 |
| 绑定 Agent | `apps/web/src/canvas/InspectorPanel.tsx` 的 bind / completeBinding；`apps/web/src/canvasHire.ts`；`apps/web/src/saas/canvasBridge.ts:77` | 原 hire 请求映射为 `POST T/agents`，得到 agentId 后保存 binding；Pi 此时不执行 | Go Agent；document binding 与 bindAttempt | 已接 | 点击绑定后实际创建租户 Agent；后续 session 使用该 ID；响应不确定显示待确认，不当作绑定成功。 |
| 运行环境与模型选择 | `apps/web/src/RuntimePicker.tsx`；`apps/web/src/canvasRuntimeReader.ts`；`apps/web/src/saas/canvasBridge.ts` | 原 inventory/models 请求映射 `GET /api/v1/runtime`；Go 返回服务端配置的 Pi 模型；Pi 使用该模型执行 | 节点与 Agent 保存选择；provider、凭据、模型配置在服务端 | 已接；目前只有服务端配置的模型 | 下拉来自 runtime 响应，不写死模型；不可用时明确提示；实际执行模型须与保存值一致。未声明支持的 effort 控件不显示。 |
| 新增和切换节点会话 | `apps/web/src/canvas/SessionTile.tsx:486`；`nodeThreads.ts`；`apps/web/src/saas/canvasBridge.ts:120` | 新空会话先是本地 thread；首次发送前 `POST T/sessions`，后续复用其 ID | document 保存 thread、草稿和 issueId→sessionId；Go 保存 session | 已接；复用原会话侧栏 | 新增空会话不产生模型调用；首条消息创建独立 session；切回旧会话恢复自己的草稿与历史，不串节点。 |
| 节点聊天与实时输出 | `apps/web/src/canvas/SessionTile.tsx:420`；`CanvasSurface.tsx` 的 startRun；`apps/web/src/canvasAgentChat.ts`；`apps/web/src/saas/canvasBridge.ts:120` | 先确认画布保存，再 `POST T/runs {sessionId,prompt,operationId}`，读取 `GET T/runs/{id}/events`；Go 管持久化和准入，Pi 推理 | Go user/assistant messages、run 与事件；前端流式展示 | 已接；真实 provider 待验收 | 用户输入受理后进入运行态；增量可见；仅 completed 才显示成功；失败保留可理解原因；重复 operationId 不重跑。 |
| 整图、选中节点、重跑与上游输入传递 | `apps/web/src/canvas/runGraph.ts`；`CanvasSurface.tsx`；RunControls | 浏览器按原依赖调度逐个提交 Go run；Pi 只执行当前节点请求，不自行调度整图 | 图与交付物在 document；单节点运行和消息在 Go；调度中间状态与 journal 在浏览器 | 部分：原图交互已接，长期后台整图调度未实现 | 实测多节点依赖依次满足、必填输入缺失或环路阻止执行；关闭页面后已有 run 可完成，但不能把尚未提交的下游节点说成已后台托管。 |
| 历史消息、刷新恢复运行 | `apps/web/src/canvas/SessionTile.tsx` 的 restoreHistory；`sessionTransport.ts`；`runJournal.ts`；`CanvasSurface.tsx` 的 recovery；`apps/web/src/saas/canvasBridge.ts:84` | `GET T/sessions/{id}/messages`、`GET T/runs?operationId=...`、`GET T/runs/{id}`；Go 提供持久输出/终态；不因恢复自动重新推理 | Go messages/run/output；document thread ID；本地 scoped journal | 已接 | 运行时刷新后回读同一 run；断线不冒充成功；completed、failed、cancelled、interrupted 区分；历史会话不自动重新发布为下游当前产出。 |
| 停止运行 | `apps/web/src/canvas/CanvasSurface.tsx` 的 stopRun；`sessionTransport.ts`；`apps/web/src/saas/canvasBridge.ts:103` | `POST T/runs/{id}/cancel` 并回读终态；Go 持久取消，Pi 终止当前执行 | Go run 终态、事件、部分输出；本地运行状态 | 已接 | 点击停止后以确认结果更新 UI；断开 SSE 不视作已取消；停止后下游不继续使用部分输出。 |
| AI 画布规划、取消、应用与撤销 | `apps/web/src/canvas/canvasPlanning.ts`；`canvasPlan.ts`；`CanvasSurface.tsx:1087`；`apps/web/src/saas/canvasBridge.ts:39` | `POST T/canvases/{id}/plan {prompt,context,operationId}`，复用 runs/SSE/cancel；Pi 返回计划，Go 验证 JSON/操作，前端再验 schema、引用、环路和版本后应用并 CAS 保存 | Go 持久规划 run；planning 会话在隔离本地缓存；应用结果存 document | 已接；真实 provider 待验收 | 合法计划应用到原画布；非法/陈旧/失败计划不改图；取消可观察；模型未配置或上下文超限显示原因，不伪造规划。 |
| 结构化输入、输出、手工发布与下游交付 | `apps/web/src/canvas/ContractFields.tsx`；`NodeDeliverables.tsx`；`runGraph.ts:215` | 前端构造输入/输出约束放入 prompt；Pi 返回文本；原 validator 验证后允许发布；产出随 CAS 保存 | document contract、outputValues、lastOutput；Go 同时保留原 run 文本 | 已接；复用原契约与交付面板 | number/boolean/必填字段错误阻止发布；有效输出进入指定下游端口；历史、手工与部分输出保持原有标记。 |
| 文件引用、复制及画布导出 | `apps/web/src/canvas/ContractFields.tsx`；`NodeDeliverables.tsx`；`apps/web/src/saas/SaaSApp.tsx` 的 ReadOnlyCanvas / exportLocal | 文件字段是字符串引用；复制与 JSON 导出由浏览器完成，不调用上传下载 API；Pi 不读取用户本地路径 | 引用在 document/文本；导出为浏览器下载文件 | 已接原引用展示/复制与编辑、只读、恢复视图的 JSON 导出；附件上传不在当前能力内 | 输入绝对路径只展示/复制，不能声称已上传或生成文件；reader 导出与服务端 document 一致，编辑导出及草稿导出保留当前本地内容。原画布没有通用附件上传能力，不登记为迁移遗失。 |

### 3.2 账户、设置与权限入口

| 前端可见能力 | 真实源文件位置 | Go API 与 Pi 职责 | 数据库或本地状态 | 当前状态 | 可观察验收 |
| --- | --- | --- | --- | --- | --- |
| 注册、登录、退出、身份显示 | 原 `apps/web/src/CanvasAccountControl.tsx`，SaaS 登录页与 WorkspaceControls | `POST /api/v1/auth/register`、`login`、`logout`，`GET /api/v1/auth/me`；Pi 无职责 | Go 用户、会话、成员关系；HttpOnly cookie | 已接；新增认证壳并复用原账户面板 | 注册后可进工作区；登录失败有错误；logout 后旧 cookie 失效；无租户的平台管理员仍可进管理端或退出。 |
| 租户切换与暂停提示 | `apps/web/src/saas/SaaSApp.tsx` 的 Workspace / WorkspaceControls | `/auth/me` 返回 memberships；租户 API 再授权；Pi 无职责 | Go tenant/member；URL 选择与缓存 scope | 已接；新增 SaaS 壳 | 多租户用户可切到其他 active 租户；suspended 页面保留切换/退出；不显示另一租户草稿或消息。 |
| 新建工作区、画布列表与改名/删除 | `SaaSApp.tsx`、`saas/CanvasList.tsx`、`ListPager.tsx` | `POST /api/v1/tenants`；`GET T/canvases?limit=50&cursor=...`；原 canvas PUT/DELETE | Go tenants/memberships/canvases；签名游标与 CAS | 已接；本轮新增 | 第 201 项可达；新建工作区后进入新 owner 范围；改名保留最新文档；409 不覆盖；删除确认后才提交，活动节点/规划 run 阻止删除，reader 无写按钮。 |
| 工作区资料编辑 | 原 `AccountWorkspacePanel` / `CanvasAccountControl`，注入 `saas/accountApi.ts` | `PATCH /api/v1/auth/profile {name}`；Pi 无职责 | Go user.name；profile.updated 审计 | 已接原资料交互 | 修改显示名称后顶部身份更新，刷新仍一致；空值/超长/未登录失败；不接受他人 ID。 |
| 成员列表、添加、角色变更、移除 | 原 `AccountWorkspacePanel` 的 SaaS 权限/角色注入 | `GET/POST T/members`、`PATCH/DELETE T/members/{userId}`；Pi 无职责 | Go memberships 与审计 | 已接；原入口统一管理 | owner/admin 管理授权范围；owner 不可移除或降级；admin 不可授予/移除 admin；reader 直接写 API 403。添加已注册邮箱与邀请链接分别命名。 |
| 邀请链接创建与加入 | 原 `AccountWorkspacePanel` 邀请区域；`saas/InviteAcceptance.tsx` | `GET/POST T/invites`、`DELETE T/invites/{id}`；`GET /api/v1/invites/{token}`、`POST .../accept` | tenant_invites 哈希凭据、角色、有效期、撤销/领取状态与审计 | 已接；复制链接，无邮件投递 | 创建/复制→登录或注册→明确确认加入→成员表可见；过期、撤销、他人已领、发行者失权均拒绝，现有成员不改角色。 |
| 成员及邀请分页 | 原 `AccountWorkspacePanel` → `saas/accountApi.ts` / `listPage.ts` | members/invites 的 limit/cursor；原管理 API | 当前页记录、nextCursor、历史页游标；切换范围清空 | 已接；本轮新增 | 超过 200 条仍能查看/操作后续页，角色更新合并当前页；翻页失败保留明确错误，不回退首 200 条伪装完整结果。 |
| 语言与主题切换 | `saas/preferences.tsx` 复用 `locale.ts` / `appearance.ts` 及原画布 i18n | 前端偏好，无需 Pi 或新增服务端 API | superclaw_locale / superclaw_theme；同页共享 Context | 已接原偏好机制 | 中英及浅深主题可见、刷新保留；画布、账户、只读、管理外壳一致；已知 API 错误本地化，未知服务错误保留原文。 |
| 原配色预设、自定义、导入导出 | 运行设置 → `saas/SaaSAppearance.tsx` → 原 `ColorSchemeDialog` | `GET/PUT /api/v1/appearance`；GET export 兼容同一 bundle；Pi 无职责 | Go user_appearance，按登录用户和 version；不用跨用户全局配色缓存 | 已接；本轮新增 | 11 预设、10 token、浅深色；保存后重载一致；账号切换不串色；连续修改串行；导入版本冲突明确指向配色；无效文件/下载失败可见；一次只有一个模态弹窗。 |
| 工作区运行设置 | 原设置按钮→`saas/RuntimeSettings.tsx`；原节点 `RuntimePicker/InspectorPanel` | `GET /api/v1/runtime`，可刷新；节点选择来自服务端 models | 服务管理员配置连接，节点保存实际 model/persona/contract | 已接 SaaS 运行设置边界 | 显示真实引擎、可用模型和原因；刷新配置状态；节点配置对执行有效；没有无效的秘密输入表单，配置就绪不冒充推理成功。 |
| reader 浏览与导出 | `ReadOnlyCanvas` → 原 `CanvasSurface readOnly` / `SessionTile` | 读取 canvas/session/messages；Go 独立拒绝 reader 业务写 | Go document/messages；独立 viewer cache，不覆盖写草稿 | 已接原画布布局与只读保护 | 原节点/边可见，历史可切换，JSON 可导出；快捷键、拖拽、绑定、规划、发送、发布和恢复不触发写入/执行。 |
| 平台管理、暂停/恢复租户 | `apps/web/src/saas/AdminPanel.tsx` | `GET /api/v1/admin/{tenants,users,runs,audit}`；`PATCH /api/v1/admin/tenants/{id}` 改 status；Go 鉴权并取消暂停租户活跃 run，Pi 响应取消 | Go tenant/user/run/audit | 已接基础管理；新增页面 | 普通用户/租户 owner 直接访问 API 403；管理员列表是真实数据；暂停/恢复状态和审计一致，恢复不自动重跑。 |
| 平台配额编辑与完整列表导出 | `saas/AdminPanel.tsx`、`adminData.ts` | PATCH 租户 maxConcurrentRuns/maxRunsPerDay；admin 四列表 limit/cursor/snapshot | Go 配额/审计；游标签名绑定列表和管理员 | 已接配额 UI、分页、全分页 JSON 导出 | 新额度影响后续准入；非法值失败；超过 200 条可全部遍历；取消/失败不下载半份文件；时间边界不等同数据库备份。 |

## 4. 运行、隔离与数据保护规范

### 4.1 保存必须先于执行

CloudCanvas 先读取服务端 document，再决定挂载原画布或展示草稿恢复。节点发送和 AI 规划都必须等待保存完成，确保 Go 校验的是当前画布真实存在的节点与 binding。外层 API `version` 是并发控制版本，不能与 document 自身格式版本混用。

未同步数据按用户、租户、画布、编辑页面隔离，包含 baseVersion、dirty、revision。发生 409 或网络错误后不得用服务端文档静默覆盖草稿，也不得自动把草稿覆盖到较新服务端版本。恢复、导出、明确丢弃是不同用户动作；晚到响应只确认它实际保存的 revision，StrictMode 重复挂载和同值初始化不能产生假冲突。

### 4.2 会话与运行必须保持真实身份

本地 thread ID 与 Go session ID 不是同一概念。原 `issueId` 在适配层承载 Go session ID；首次发送后写回 document。operationId 用于查明受理结果和避免重复运行，HTTP 202、SSE 断开、存在部分文本均不等于成功。恢复只读取原 run，不重发一个新 operationId 冒充恢复。

目前图调度仍由浏览器 `runGraph` 驱动。Go 能继续执行已经提交的节点 run；页面关闭后尚未提交的下游节点不是后台任务。若产品要求“关网页整图继续运行”，需要独立的服务端图执行设计与验收，不能仅增加一个前端 loading 提示。

### 4.3 Pi 和交付物的边界

Pi 当前承担模型对话与规划输出，服务端控制 provider/model、上下文预算、取消和超时。当前模式不向租户开放任意 shell、工具、扩展或文件系统访问。`runtime.available` 与配置健康检查不证明真实 provider 的账号、余额、模型或输出质量可用。

结构化交付沿用原前端契约验证；Go 保存 run 原文本与画布 document，并不是一个独立的服务端交付物校验/对象存储系统。`file` 字段是文件引用字符串，不等于上传完成、文件存在或 Pi 已经读取文件。真正上传、生成文件下载和工程目录执行属于新增产品能力，实施时须另外定义对象归属、访问权限、体积限制、保留与删除规则。

### 4.4 规划结果的应用时点

用户输入需求并点击“生成画布”后，合法结果通过 Go JSON/操作校验和原前端 schema、引用、环路及当前版本校验，随即应用到原画布并进入 CAS 保存。助手显示“已更新画布”，提供“撤销本次更改”；当前交互没有第二个确认/应用按钮。非法、失败、已取消或陈旧结果保持原图不变。此行为与邀请领取的显式确认是两个独立流程。

## 5. 本轮完成项与剩余工作

此前列为 P2 的原账户、邀请、偏好、只读和管理入口现已实施。本轮进一步修复普通列表截断、管理入口与原配色遗漏、运行错误未本地化的问题，见上表新增行。下表保留每项完成标准；具体测试及浏览器结果统一引用验收记录，避免把源码接入扩大为真实 provider 或生产验收。

| 顺序 / 当前状态 | 范围 | 当前实现或下一步 | DoD / 验收要求 |
| --- | --- | --- | --- |
| 验收前置 / 待配置 | 真实 provider 尚未验收 | 在本项目明确配置 provider/model 后，从原画布绑定、发送、整图及规划入口执行；仅使用该项目获准凭据 | 留下浏览器动作、实际模型标识、Go run/message/SSE、刷新恢复和结构化结果证据；记录失败/取消。fixture 或健康检查不能替代。 |
| P2-1 / 已实施 | 原账户资料编辑 | `CanvasAccountControl` → `AccountWorkspacePanel` → `saas/accountApi.ts` → `PATCH /auth/profile`；当前支持显示名称 | 修改名称→Go 持久化→顶部身份和刷新一致；空值/超长/未登录有明确失败；SaaS 面板不展示另一套外部账户身份。 |
| P2-2 / 已实施 | 原邀请链接 | 原面板创建、复制及撤销；`InviteAcceptance` 保留登录/注册前的 URL token，预览后明确确认领取 | 创建并复制链接→登录/注册→确认加入→成员可见；覆盖过期、撤销、重复领取、发行者降权；已有角色不因领取而提升。只复制链接，不声称发信。 |
| P2-3 / 已实施 | 语言、浅深主题 | `SaaSPreferencesProvider` 复用 `superclaw_locale`、`superclaw_theme` 和原画布词条；全页共享偏好 | 中英文及浅/深色可切换、刷新保留；账户、画布、只读、运行设置、管理外壳一致；已知服务错误本地化，未知错误保留原文。 |
| P2-4 / 已实施 | 原成员入口、reader、运行设置 | 原面板按 reader/member/admin/owner 约束管理成员；reader 挂载原 `CanvasSurface readOnly`；`RuntimeSettings` 查询服务端配置 | 成员不越权；只读历史切换仅改变浏览状态，禁止保存/绑定/执行/规划/恢复写入；viewer cache 不覆盖编辑草稿；运行设置刷新不等于模型推理验证。 |
| P2-5 / 已实施 | 平台配额、分页、导出 | `AdminPanel` / `adminData` 接 Go 配额 PATCH 与四列表 limit/cursor；显示每页 50，导出每次取 200 并遍历到末页 | 修改留审计并影响新 run 准入；非法值失败；下一页/返回页/刷新可用；导出失败或取消不下载半份文件，读取边界不冒充数据库一致性备份。 |
| 后续能力 / 未实施 | 关闭浏览器后继续整个图 | 将图任务、依赖、发布和节点派发状态交给 Go 持久调度；保留现有 runGraph 的语义和 UI 投影 | 中途关闭浏览器，未派发的下游仍按依赖执行；重启恢复不重复派发；取消/失败传播和版本固定可验收。当前仅已接收的 Go run 继续执行。 |
| 后续能力 / 未实施 | 真实附件、工程文件和下载 | 单独设计对象存储与引用契约，随后扩展原 ContractFields / NodeDeliverables | 文件从 UI 上传→租户对象→模型可用内容→结果下载的全链证据齐全；跨租户引用拒绝。当前只是引用，不是原上传功能的回归缺口。 |

实际 API 使用 SaaS reader/member/admin/owner 角色；原面板通过可注入 API、可分配角色和可编辑范围适配，历史调用默认行为保留。租户 owner 与平台 admin 为独立权限；邀请码不保存在 localStorage，复制链接不等于邮件邀请。

## 6. 验收证据与后续执行顺序

已有实际验收记录见 [本地验收记录](awwo-saas-verification.md)；安装、配置和启动见 [SaaS 开发说明](awwo-saas-development.md)；系统边界见 [架构设计](awwo-saas-architecture.md)。本轮新增结果单列在验收记录中，不扩大此前基础版本结果的证明范围。

| 证据层级 | 既有证据 | 可证明与不可证明 |
| --- | --- | --- |
| 源码核对 | 本文入口、组件和 API 对照 | 可证明已存在接入路径；不能证明 provider 实际可用或全部按钮均完成浏览器回归。 |
| 前端自动化 | SaaS、原账户、原画布相关测试，以及 typecheck/build；最新命令、文件和用例数以验收记录为准 | 可证明测试覆盖的隔离、持久草稿、账户/邀请/权限、运行和规划适配行为。旧批次用例数不代表本轮总量，不重复相加。 |
| 本地真实浏览器 | 原画布保存重载、账户改名重载、语言主题持久、邀请注册后确认 reader、原图只读、运行状态说明、平台配额及审计分页/JSON 下载 | 可证明验收记录中的实际 UI 链路；未从这些动作推导真实模型执行成功。 |
| 进程与协议 fixture | Go → Pi HTTP → 真实 Pi SDK/子进程 → 本地模型协议 fixture → PostgreSQL；浏览器 fixture 可从同一个原画布入口驱动此链路 | 可证明已执行记录中的真实进程协作、协议处理与 UI 回显；`--self-test` 仅验证 fixture 自身，fixture 输出不是商业或自建 provider 验收。 |
| 真实模型、部署 | 尚未执行真实 provider；公网与容器运行未验收 | 明确记为未执行/环境阻塞，不记为通过。 |

前端独立检查入口（仓库根目录）：

```sh
npm run test:saas --prefix apps/web
npm run typecheck:saas --prefix apps/web
npm run build:saas --prefix apps/web
```

原画布相关回归的精确命令及文件清单保留在 [本地验收记录](awwo-saas-verification.md)。历史默认 `npm test --prefix apps/web` 曾因未安装的 `server/ui` MDX 依赖启动失败；本轮实际原 Web 测试已通过 91 文件、1,005 项及 static-ui，详见 [整改记录](awwo-fable-remediation-20260907.md)。这仍不是所有工程、实际模型与浏览器验收的总通过结论。

每项工作按以下顺序关闭：先更新本表契约和状态 → 在原入口实施最小适配 → 补行为/权限/失败路径测试 → 真实浏览器按该行可观察验收执行 → 涉及模型的再做实际 provider 验收 → 更新证据及剩余差距。文档、代码提交、合并、推送与公网部署分别记录；本文不授权后几项操作。
