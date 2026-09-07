# AwwO SaaS 前端对接与验收规范

本项目以现有前端交互为产品基准，由 Go 承接身份、租户、资源、持久化与运行治理，由 Pi 承接模型执行。当前已复用原画布核心组件并接入主要运行链路，但账户资料、邀请链接、语言与主题等原入口能力尚未完整迁移；不能将“API 可调用”表述为“原前端全部完成”。

本文基于 2026-09-07 对 `feat/awwo-go-pi-saas` 的核对，源码基准为 `36a092bce927a82fb088f7ba7b14830c9992485d`，实施 worktree 为 `/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-saas-20260907`。本文只定义当前契约、差距和后续完成标准，不代表新一轮代码实现或真实模型验收。

项目约束、分工与交付门见 [设计与开发规范](awwo-saas-design-standards.md)。

## 1. 现役入口与复用原则

### 1.1 两个实际入口

| 入口 | 实际调用链 | 当前意义 |
| --- | --- | --- |
| 原 Web 入口 | `apps/web/src/main.tsx` → `App.tsx` → `CanvasSurface.tsx` → `AgentWorkspace.tsx` → `SessionTile.tsx` / `InspectorPanel.tsx` | `App` 默认进入画布，已有工作台选择缓存可能改变打开的页面。原账户入口、语言/主题切换及运行设置由 `App` 注入画布。 |
| 新增 SaaS 入口 | `apps/web/saas.html` → `apps/web/src/saas/main.tsx` → `SaaSApp.tsx` → `CloudCanvas` → **同一个** `apps/web/src/canvas/CanvasSurface.tsx` | 新增登录、租户与画布列表、云端持久化、平台管理外壳。成员编辑画布仍使用原组件；`canvasBridge.ts` 把原调用契约映射为 Go API。 |
| SaaS 只读入口 | `SaaSApp.tsx` → `ReadOnlyCanvas` | 新增节点、依赖、历史列表与 JSON 导出视图；没有挂载原画布编辑器。这是明确的复用边界。 |

关键挂载位置：`App.tsx:17603`、`SaaSApp.tsx:314`、`CanvasSurface.tsx:1155`。行号只对应上述基准；后续修改以组件和函数名定位。

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
| 文件引用、复制及画布导出 | `apps/web/src/canvas/ContractFields.tsx:119`；`NodeDeliverables.tsx`；`apps/web/src/saas/SaaSApp.tsx` 的 ReadOnlyCanvas / exportLocal | 文件字段是字符串引用；复制与 JSON 导出由浏览器完成，不调用上传下载 API；Pi 不读取用户本地路径 | 引用在 document/文本；导出为浏览器下载文件 | 部分：原引用展示/复制已保留；新增 reader 和草稿恢复导出；没有附件上传 | 输入绝对路径只展示/复制，不能声称已上传或生成文件；reader 导出与服务端 document 一致，草稿导出保留未同步内容。原画布没有通用附件上传能力，不登记为迁移遗失。 |

### 3.2 账户、设置与权限入口

| 前端可见能力 | 真实源文件位置 | Go API 与 Pi 职责 | 数据库或本地状态 | 当前状态 | 可观察验收 |
| --- | --- | --- | --- | --- | --- |
| 注册、登录、退出、身份显示 | 原 `apps/web/src/CanvasAccountControl.tsx`；当前 `apps/web/src/saas/SaaSApp.tsx` 的 Auth / WorkspaceControls | `POST /api/v1/auth/register`、`login`、`logout`，`GET /api/v1/auth/me`；Pi 无职责 | Go 用户、会话、成员关系；HttpOnly cookie | 已接；新增认证壳，未完整复用原账户面板 | 注册后可进工作区；登录失败有错误；logout 后旧 cookie 失效；无租户的平台管理员仍可进管理端或退出。 |
| 租户切换与暂停提示 | `apps/web/src/saas/SaaSApp.tsx` 的 Workspace / WorkspaceControls | `/auth/me` 返回 memberships；租户 API 再授权；Pi 无职责 | Go tenant/member；URL 选择与缓存 scope | 已接；新增 SaaS 壳 | 多租户用户可切到其他 active 租户；suspended 页面保留切换/退出；不显示另一租户草稿或消息。 |
| 工作区资料编辑 | 原 `apps/web/src/account/AccountWorkspacePanel.tsx:405`；`accountApi.ts:79`；当前 `apps/web/src/saas/SaaSApp.tsx:97` | 原面板有读取/保存资料契约；Go 当前仅 `/auth/me` 读取，没有资料编辑接口；Pi 无职责 | 原可编辑显示名称；SaaS Go user.name 目前来自注册/初始化 | 未接原编辑能力 | 后续须从原账户入口编辑名称，保存后顶部和刷新结果一致；非本人的 ID 不得用于改资料。 |
| 成员列表、添加、角色变更、移除 | 原 `apps/web/src/account/AccountWorkspacePanel.tsx`；当前 `apps/web/src/saas/SaaSApp.tsx:113` 的 Members | `GET/POST T/members`、`PATCH/DELETE T/members/{userId}`；Go 校验 reader/member/admin/owner；Pi 无职责 | Go memberships；变更审计 | 部分：基本操作已接，采用新面板；添加要求邮箱已注册 | owner/admin 可管理授权范围；owner 不可被删除/降级；admin 不能授予 admin；reader 直接写 API 403；没有发送邀请邮件。 |
| 邀请链接创建与加入 | 原 `apps/web/src/account/AccountWorkspacePanel.tsx:447`；`accountApi.ts:90`；当前 Members 仅邮箱添加 | 当前 Go 无邀请链接创建/领取 API；Pi 无职责 | SaaS 尚无邀请凭据与消费状态 | 未接 | 后续须从原入口创建/复制链接，受邀用户登录或注册后确认加入，权限不超过邀请角色，过期/撤销/重复消费有明确结果。 |
| 语言与主题切换 | 原 `apps/web/src/App.tsx:5822`、`:17611`；当前 `apps/web/src/saas/SaaSApp.tsx:314` | 原偏好主要为前端状态；无需为了迁移而强制增加 API；Pi 无职责 | 原 locale/theme preference；当前 SaaS LocaleProvider 固定 zh | 未接原切换入口 | 恢复原可见控件和词条；切换后包括 SaaS 壳、账户及管理界面文字一致，刷新保留偏好，浅/深色可读。 |
| 工作区运行设置 | 原 `apps/web/src/App.tsx` 的 settings-runtime；当前 `apps/web/src/saas/SaaSApp.tsx:315` | 当前弹窗展示 `GET /api/v1/runtime`；模型/provider/凭据由服务端配置；Pi 执行受配置约束 | 服务器环境配置；浏览器只读 inventory | 部分：保留打开入口，改成状态说明 | 状态与实际 runtime 响应一致；不可用有原因；不把配置探测写成模型调用成功；若后续做配置表单，须先明确平台管理员范围与秘密存储方式。 |
| reader 浏览与导出 | `apps/web/src/saas/SaaSApp.tsx:147` 的 ReadOnlyCanvas | `GET T/canvases/{id}`、`GET T/sessions?canvasId=...`、messages；Go 拒绝业务写 | Go document/messages；本地只读投影 | 已接权限行为；视图为新增列表，未复用原画布布局 | 无创建/编辑/运行按钮；能看节点、依赖、历史并导出；伪造请求仍 403；切到自有工作区恢复合法权限。 |
| 平台管理、暂停/恢复租户 | `apps/web/src/saas/SaaSApp.tsx:343` 的 Admin | `GET /api/v1/admin/{tenants,users,runs,audit}`；`PATCH /api/v1/admin/tenants/{id}` 改 status；Go 鉴权并取消暂停租户活跃 run，Pi 响应取消 | Go tenant/user/run/audit | 已接基础管理；新增页面 | 普通用户/租户 owner 直接访问 API 403；管理员列表是真实数据；暂停/恢复状态和审计一致，恢复不自动重跑。 |
| 平台配额编辑与完整列表导出 | `apps/web/src/saas/SaaSApp.tsx` 的 Admin；`backend/internal/app/` | Go PATCH 支持 maxConcurrentRuns/maxRunsPerDay，但当前 UI 仅切 status；多数列表最多 200 条，无完整分页导出 | Go 配额；列表仅有限投影 | 部分：API 配额已实现，编辑 UI 与全量导出未接 | 后续编辑额度须即时影响准入并留审计；分页/导出不能把首 200 条说成全量。 |

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

## 5. 已确认差距、优先序与完成标准

本次有界源码核对没有确认新的核心执行链路 P1。以下是功能完整度差距和验收缺口；优先序不是对尚未发现的缺陷作风险推断。先补原入口能力，再增加原前端没有的能力。

| 顺序 | 差距及范围 | 最小实施方案 | DoD：何时才能标记完成 |
| --- | --- | --- | --- |
| 验收前置 | 真实 provider 尚未执行 | 在本项目明确配置 provider/model 后，从原画布绑定、发送、整图及规划入口执行；仅使用该项目获准凭据 | 留下浏览器动作、实际模型标识、Go run/message/SSE、刷新恢复和结构化结果证据；记录失败/取消。fixture 或健康检查不能替代。 |
| P2-1 | 原账户资料编辑未迁移 | 复用 AccountWorkspacePanel 的资料交互，注入 SaaS 账户服务；新增 Go 当前用户资料写契约，首批对应已存在的显示名称字段 | 修改名称→Go 持久化→顶部身份和刷新一致；空值/超长/未登录有明确失败；原外部账户 token 不进入 SaaS 登录态。新增 API 在实现前以草案同步 API 文档，实际路由表在实现后更新。 |
| P2-2 | 原邀请链接能力未迁移 | 复用原邀请入口与角色选择；新增 Go 租户邀请创建、查询/撤销、领取契约。与现有“已注册邮箱直接添加”分别命名 | 创建并复制链接→受邀用户完成登录/注册→确认加入→成员表可见；覆盖过期、撤销、重复领取与越权授予。未接邮件服务时只提供复制链接，不声称发信。 |
| P2-3 | 语言、主题控件未沿用 | 复用现有偏好逻辑和画布词条；把 SaaS 固定中文文案纳入同一 locale 来源，复用主题选择和样式变量 | 中英文及浅/深色从原位置可切换、刷新保留；画布、账户、错误、只读和管理端一致；不重新实现第二套相互冲突的偏好。 |
| P2-4 | 设置、成员和 reader 采用简化替代视图 | 以原账户/运行设置交互为基准逐项对齐；reader 后续可为原画布提供受限只读挂载；服务端模型秘密仍由管理侧负责 | 明确列出每个保留控件及授权；成员管理不丢角色约束；reader 不触发保存、绑定、运行和规划；运行设置不得伪装为可编辑但无效的表单。 |
| P2-5 | 平台配额有 API 无编辑入口，列表有上限 | 在当前 Admin 增加受控额度编辑，扩充列表分页后再提供全量导出 | 变更留审计并影响新 run 准入；非法值失败；超过 200 条仍能逐页访问；导出范围和过滤条件明确。 |
| 后续能力 | 关闭浏览器后继续整个图 | 将图任务、依赖、发布和节点派发状态交给 Go 持久调度；保留现有 runGraph 的语义和 UI 投影 | 中途关闭浏览器，未派发的下游仍按依赖执行；重启恢复不重复派发；取消/失败传播和版本固定可验收。当前不能标为已完成。 |
| 后续能力 | 真实附件、工程文件和下载 | 单独设计对象存储与引用契约，随后扩展原 ContractFields / NodeDeliverables | 文件从 UI 上传→租户对象→模型可用内容→结果下载的全链证据齐全；跨租户引用拒绝。当前只是引用，不是原上传功能的回归缺口。 |

上述资料与邀请的新增 API 尚未实现；实施方案不是当前 API 清单。角色名和权限必须使用 SaaS reader/member/admin/owner 契约，不能直接搬入原面板的旧角色枚举。

## 6. 验收证据与后续执行顺序

已有实际验收记录见 [本地验收记录](awwo-saas-verification.md)；安装、配置和启动见 [SaaS 开发说明](awwo-saas-development.md)；系统边界见 [架构设计](awwo-saas-architecture.md)。本文不重复执行其中的命令，也不扩大既有结果的证明范围。

| 证据层级 | 既有证据 | 可证明与不可证明 |
| --- | --- | --- |
| 源码核对 | 本文入口、组件和 API 对照 | 可证明已存在接入路径；不能证明 provider 实际可用或全部按钮均完成浏览器回归。 |
| 前端自动化 | SaaS 4 文件 23 项；连同相关原画布回归共 20 文件 249 项；typecheck/build 通过 | 可证明测试覆盖的隔离、持久草稿、运行和规划适配行为。249 已包含 23，不应相加。 |
| 本地真实浏览器 | 注册、原研发模板 5 节点保存并刷新、工作台打开、成员/reader/租户切换、平台暂停恢复 | 可证明记录中的实际 UI 链路；未从这些动作推导真实模型执行成功。 |
| 进程与协议 fixture | Go → Pi HTTP → 真实 Pi SDK/子进程 → 本地模型协议 fixture → PostgreSQL | 可证明真实进程协作和协议处理；fixture 输出不是商业或自建 provider 验收。 |
| 真实模型、部署 | 尚未执行真实 provider；公网与容器运行未验收 | 明确记为未执行/环境阻塞，不记为通过。 |

前端独立检查入口（仓库根目录）：

```sh
npm run test:saas --prefix apps/web
npm run typecheck:saas --prefix apps/web
npm run build:saas --prefix apps/web
```

原画布相关回归的精确命令及文件清单保留在 [本地验收记录](awwo-saas-verification.md)。历史默认 `npm test --prefix apps/web` 在独立 SaaS 安装环境因未安装的 `server/ui` MDX 依赖而启动失败；这与 SaaS 配置下的通过结果分别记录，不能替换为“前端全量通过”。

每项后续工作按以下顺序关闭：先更新本表契约和状态 → 在原入口实施最小适配 → 补行为/权限/失败路径测试 → 真实浏览器按该行可观察验收执行 → 涉及模型的再做实际 provider 验收 → 更新证据及剩余差距。文档、代码提交、合并、推送与公网部署分别记录；本文不授权后几项操作。
