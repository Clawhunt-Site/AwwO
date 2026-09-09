# AwwO Fable 验收整改

2026-09-07（Asia/Shanghai）。本轮在 `feat/awwo-computer-use-acceptance-20260907` 隔离工作树修复，基准 `a83d2acee3732e95c2f115b107f31af25c335c13`。工作目录 `/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-saas-20260907`。本文区分实现、自动测试、真实接口链和 Computer Use，未将缺少的验收写作通过。

## 已修复的代码缺口

| 项目 | 实现与可观察行为 | 验证 |
| --- | --- | --- |
| 普通列表超过 200 条被截断 | 六类租户列表提供签名游标；画布、成员、邀请每页 50 条，保留过滤条件，切换范围重置。历史恢复精确查 session，停止查询只取活动 run | 六类真实 PG 超过 200 条、同时间戳、范围绑定及角色撤销回归；组件第 201 项可达；实际 HTTP 小页遍历 |
| 原管理入口缺失 | 新建工作区；画布改名保留最新文档并使用版本 CAS；删除前确认级联范围，Go 拒绝删除含 node/planner queued/running 的画布 | 组件确认取消、reader 禁写、失败保留名称、CAS 不覆盖文档；PG 四种活动运行删除拒绝 |
| 运行错误未随语言切换 | 已知 API/运行错误码按当前中英偏好显示，未知详情保留；HTTP 状态/码及恢复记录错误码不丢失 | HTTP quota、SSE failed、未知错误和动态语言回归 |
| 原配色能力未接 SaaS | 复用原配色弹窗、11 预设、10 颜色锚点及 JSON 导入导出；Go 按用户保存，版本冲突需重新加载，连续操作串行提交，账号切换清除旧颜色 | PG 用户隔离/版本/白名单/读回；8 项组件回归，含坏响应、晚响应、连续颜色、原格式导入导出及真实 RuntimeSettings 入口单弹窗 |
| 负向场景难以复现 | 独立 fixture 精确注入一次性 HTTP 失败/延迟、SSE 断连、非法规划和上游失败；控制器不进入业务 Go 或部署代码 | 13 项新脚本测试 + 原启动器 8 项；实际 HTTP 负向链 14 项 |
| 真实模型没有独立验收入口 | 项目配置预检及显式 `--run`，检查 Go→Pi SDK 真实两轮、历史、SSE、持久化与清理，无 fixture 回退 | 预检按缺配置返回 BLOCKED/exit 2；真实推理仍未执行 |

## API 与保存契约

`GET /api/v1/tenants/{tenantId}/{members,canvases,agents,sessions,runs,invites}?limit=1..200&cursor=opaque` 保留 `items`，增加 `nextCursor` 和 `snapshot`。游标绑定账号、租户、资源及规范化过滤条件；篡改、跨范围或实例重启后失效返回 `400 invalid_cursor`，非法分页参数返回 `400 invalid_pagination`。排序为不可变创建时间和 ID 降序，改名不移动画布页次。`snapshot` 是创建时间边界，不是数据库一致性备份；旧事务晚提交和删除仍可能影响遍历。

Session 可按 `canvasId` 与精确 `sessionId` 联合过滤；run 支持 `sessionId`、`operationId`、`active=true`（queued/running）。`POST /tenants {name}` 创建 owner 工作区，不授予平台权限。改名读当前记录再以原文档和版本 PUT，409 不自动覆盖；删除前由 Go 在租户锁内检查活动任务，拒绝返回 `409 resource_in_use`。

配色 `GET/PUT /api/v1/appearance` 归当前登录用户，PUT 为 `{active_preset,custom:{light:{},dark:{}},version}`。初始 version 0，每次成功加一，旧版本 409。仅原目录中的预设、颜色 token 和合法 hex 可写；自定义 CSS、用户 ID、主机路径和秘密不能输入。迁移 006 存入 PostgreSQL，迁移 005 增加成员创建时间。导出保留原 `superclaw.appearance / 0.1.0` bundle，不含版本与身份；导入提交当前已加载版本。网络丢失响应时不能断言保存未发生，需重新加载核对。

## 本轮执行证据

| 检查 | 结果及范围 |
| --- | --- |
| `npm run test:saas:backend` | 26 顶层 + 22 子测试通过，真实 PostgreSQL + race + vet，零失败、零跳过 |
| `npm exec vitest -- run --config vitest.saas.config.mjs tests/saas- tests/canvas- tests/awwo-workspace.test.tsx tests/account-workspace.test.tsx`（apps/web） | 65 文件、606 项通过；之后追加两项配色测试、统一导入冲突文案并补入现有 CAS 测试，配色文件最新 8/8 通过，未把追加测试说成再次全量运行 |
| `npm test`（apps/web） | 91 文件、1,005 项 + static-ui 通过；与上一行有重叠，不相加当去重总数 |
| `typecheck:saas`、`build:saas` | 通过；最终 SaaS JS 738.78 kB/gzip 230.34 kB，有大 chunk 提示；原测试 jsdom Window.open 提示不代表浏览器控制台结果 |
| 三个脚本测试文件 | 21/21 通过：新故障/真实 provider 验收脚本 13 项 + 原 SaaS 启动器 8 项 |
| 独立真实 HTTP 负向链 | 14 PASS、0 FAIL：分页、真实 quota 429、非法 planner、provider 503/断连、保存 503 恢复与 CAS、SSE 重放、配色导出/导入/CAS/用户隔离 |
| HTTP 链执行来源 | 实际 Go→Pi SDK→本地明确 fixture，共 7 个 run：2 completed、2 预期 cancelled、3 预期 failed；不是外部模型认证或质量证明。第三并发拒绝时无 run 行 |
| Compose 配置 | `docker compose --env-file deploy/saas/.env.example -f deploy/saas/compose.yml config --quiet` 通过；docker info 无 server version、收到 SIGPIPE，容器构建/运行仍未验证 |
| 独立审查 | 冻结生产源码及最后导入冲突文案/测试/文档增量均经 Codex gpt-5.5/high 与 Gemini 3.1 Pro (High) 双 PASS。Claude Code 2.1.263 实际调用 claude-fable-5/high，两次均退出 0：代码整改可接受，增量 API 文档/配色修复 PASS，原始全面验收仍 FAIL（部分满足） |

原始日志在忽略目录 `.local/awwo-saas/`：`fable-backend-pagination-tests-final.log`、`fable-fix-saas-expanded-final.log`、`fable-fix-legacy-final.log`、`fable-fix-appearance-final.log`、`fable-fix-typecheck-final.log`、`fable-fix-build-final.log`、`fable-fix-script-tests-final.log`、`http-negative-9a65e549aba5-results.json`、`http-negative-9a65e549aba5-provider.json`。日志是本地证据，不随代码自动分发；凭据文件不提供给顾问。

独立审查原件：`fable-remediation-review-r1-result.json` 记录两个顾问的实际模型、原始输出和冻结哈希。Gemini 曾提出与实际 SQL 不符的问题，收到精确源码与真实 PG 证据后明确撤回并给出 PASS，原 FAIL 与复核记录均保留。`fable-remediation-final-report.md` 为 Claude Code Fable 原文；其指出 API 文档仍描述旧列表上限，本轮已同步 API 表、分页/配色契约、前端对照和架构说明。Fable 同段称 POST /tenants 缺失，该路由文档实际此前已存在，未据此重复实现接口。活动 run 翻页期间终态变化可能使其不再进入后续页，已在 API 文档注明。

最终增量的双顾问原件为 `fable-remediation-review-r2-codex-report.md` 与 `fable-remediation-review-r2-gemini-raw.json`（response 字段）；`fable-remediation-delta-report.md` 是 Fable 对修订后的 API 文档、配色冲突提示和剩余边界的补充复核。它们都是源码/已有日志评估，不是顾问亲自执行 GUI 或真实 provider 测试。

## Computer Use 本轮边界

本轮直接使用正常 Chrome profile（良），未复制 profile，未以 Playwright 或 API 操作冒充 Computer Use。独立 fixture 首次打开返回 403，定位到测试代理只接受自身 Host，拒绝了 Vite 保留的 Web Host；已修复为仅 API 路由允许本实例 Web Host，控制/provider/证据路由仍严格验证 Host/token，并加真实 HTTP 回归。

修复后在 Chrome 看到了登录和注册表单，填写本地合成账号并点击注册。此后 Computer Use 多次只返回窗口标题、空 accessibility tree 和 `screenshot: null`，不能确认注册后的 UI，也没有继续盲点。后续工作区、配色、分页和负向 GUI 场景仍未取得本轮有效证据；14 项 HTTP 和组件测试不替代它们。历史 GUI 矩阵继续保留在 `awwo-computer-use-matrix-20260907.md`，其部分/未执行状态没有被本轮自动测试改为绿。

收尾时再次读取完整 Chrome 状态仍只有窗口标题、无 AX 内容及截图。`fable-fix-cu-observations.json` 保留观察边界，三张本轮原截图分别为代理 403、登录及注册表单。测试 fixture 已正常退出 0，端口 52548–52551 无监听，临时 schema `awwo_browser_75b23bbbb5d17d9b` 与其目录已移除；原有 PostgreSQL PID 8866、端口 55483 保留，核查见 `fable-fix-cleanup.json`。

## 本地提交

以下提交依次落在同一隔离分支，代码和测试文件保持已审/已测内容，未合并到本地主仓库，也未推远端。

| 提交 | 独立范围 |
| --- | --- |
| `75fcc444ea9eae9ddacdf3f12c08065475bcd983` | 租户分页、迁移 005、权限/过滤/生命周期回归 |
| `d8d432c963c30c2944b086f2dc1b9ddc36c90764` | 账号配色 API/迁移 006、原弹窗接入、串行 CAS 与测试 |
| `b64482c79d833d30bf8e65c7e2e02d0c0559c9c3` | 工作区创建、画布管理、成员/邀请分页与测试 |
| `1129ba7cb010dadf80c8ae7e320ffad1e82dec44` | 会话恢复、错误状态/码保留与本地化 |
| `d07e4be28f0fe8ac458d93ad39c15e9845a5eb42` | 隔离故障注入和真实 provider 验收工具 |

本报告、API、架构、前端契约、开发说明与 CHANGELOG 随后以独立文档提交收尾。该记录不表示源代码在新的远端前端之上通过整合验收。

## 尚未关闭的边界

1. 真实模型配置：已请求本项目 provider/model 及本地凭据文件路径，目前未获得。预检缺配置明确阻塞，未读取其他项目秘密或全局登录凭据作替代。
2. 工程执行语义：当前 Pi 是文本/结构化交付模式，没有服务端通用文件读写、shell 或浏览器关闭后继续调度整张 DAG。已请求澄清“项目承建”是否包含这些能力；没有业主确认前不能把当前文本模式等同工程执行平台。
3. GUI：需恢复可观察的 Computer Use 会话，逐条完成原矩阵未覆盖分支及本轮新入口、错误恢复和下载结果。
4. 容器、HTTPS、公网资源、备份恢复仍是未运行的上线验收项。未执行发布，也未声称公网可用。
5. 远端整合：主仓库本地 `main@6e1dc158a79e2f18c7bdf82610a353883b883f31`；本轮 fetch 后 `origin/main@fc5cbda9e4028837009369471ec2d54b94a985a5`，尚未整合。当前分支 VERSION 0.3.0，远端 0.3.1；合并须提供精确源/目标 SHA 与冲突风险，再取得该次人工批准。没有 merge/push/PR/deploy。
