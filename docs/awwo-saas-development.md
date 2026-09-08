# AwwO SaaS 本地开发与部署说明

本入口运行 Go API、PostgreSQL、Pi worker 和复用原画布的 SaaS Web，独立于历史 `npm run dev` 的 Node/Codex 模式。架构见 [架构设计](awwo-saas-architecture.md)；2026-09-08 新增节点团队、独立成员模型和 Go 后台整图的完整契约见 [节点团队设计](awwo-node-teams.md)。本文给出操作步骤，不代替本轮实际验收报告。

## 本地启动

要求 Node >=22.19（实际验证版本见验收报告）、npm、支持自动 toolchain 的 Go，以及 `initdb/pg_ctl/psql/createdb`。项目 go.mod 锁定 Go 工具链，不需要替换系统 Go。

```sh
npm run setup:saas
npm run dev:saas
```

默认地址 `http://127.0.0.1:5189/`，管理入口 `/admin`。Go 8087、Pi 8097、PostgreSQL 55483。启动前检查端口，不会停止已有服务。首次生成的数据库、内部服务和管理员密码只保存在当前 worktree 的 `.local/awwo-saas/.env`，管理员邮箱默认 `admin@awwo.local`。打开该本地文件查看初始密码；不要提交或分享该文件。

运行数据位于 `.local/awwo-saas/postgres`。启动器只操作该专属集群，退出时只停止本次启动的子进程。若集群已由 `node scripts/awwo-saas-dev.mjs --database-only` 启动，完整启动会复用它而不会在退出时停止它。不要将其他项目的数据库配置给此入口。数据库 schema 会在 API 启动时迁移。

修改 `.local/awwo-saas/.env` 后重启本次 dev 命令。首位管理员通过 bootstrap 配置建立；修改环境变量不等价于重置已有账号密码，后端的初始化行为以 API 文档为准。

## 当前前端入口

SaaS 使用 `apps/web/saas.html → src/saas/main.tsx → SaaSApp`，通过 CloudCanvas 复用原 `CanvasSurface / AgentWorkspace / SessionTile`，不需要历史 `server/ui` 安装。reader 同样打开原画布，浏览节点、历史会话和导出 JSON，写入、绑定、规划及运行入口禁用；只读缓存不覆盖编辑草稿。

顶部账户按钮打开原 `CanvasAccountControl / AccountWorkspacePanel`，已接显示名称编辑、已注册邮箱添加成员、角色变更/移除和邀请创建/复制/撤销。SaaS 只显示当前 Go 工作区身份。邀请链接在登录或注册后保留，需受邀人明确确认加入；注册仍先创建其个人工作区。owner/admin 的角色范围由 Go 再次校验，复制链接不发送邮件。

中英与浅深主题沿用 `superclaw_locale` / `superclaw_theme`，同页画布、账户、邀请、运行设置和平台管理共用偏好，刷新后保留。原设置按钮打开 SaaS `RuntimeSettings`，读取并刷新实际服务配置、模型和不可用原因；模型连接秘密仍由服务管理员配置。

工作区首页提供新建工作区、画布改名和删除。画布、成员和邀请按每页 50 条翻页；切换工作区、权限变化或过滤条件变化时重置游标。改名以服务端最新文档执行版本比较，冲突保留名称输入；删除需确认，Go 拒绝删除含活动运行或规划的画布。

运行设置内的“配色设置”复用原配色弹窗、11 个预设、10 个颜色锚点和 JSON 导入导出。选择保存在 Go/PostgreSQL 当前用户下，切换账号会清除上个账号的颜色并重新读取，不使用无账号归属的浏览器配色缓存。浅深主题使用同一份配置；连续颜色变更按序保存，旧版本冲突要重新加载配色。导入接受原 `superclaw.appearance / 0.1.0` 格式；下载内容只含已确认配置。浏览器下载是否落盘仍需 GUI 验证。

`/admin` 的 `AdminPanel` 提供租户暂停/恢复、配额编辑、租户/用户/运行/审计分页及 JSON 导出。界面每页 50 条，导出按 200 条遍历，失败或取消不下载部分结果；API 重启导致游标失效时刷新列表。无租户的平台管理员仍可进入管理端或退出；暂停租户页面保留切换其他工作区和退出。

## 模型连接

启动本身不会运行模型。未配置 Pi 时仍可注册、登录和编辑保存画布；模型运行必须返回明确的不可用错误。

在本地 `.env` 中添加以下配置，不向前端传递密钥：

```dotenv
AWWO_PI_PROVIDER=openai
AWWO_PI_MODEL=YOUR_MODEL_ID
AWWO_PI_BASE_URL=https://YOUR_MODEL_ENDPOINT/v1
AWWO_PI_API_KEY=YOUR_PRIVATE_KEY
```

`openai` 表示 OpenAI 兼容接口，实际协议以服务支持为准。Anthropic 使用 `AWWO_PI_PROVIDER=anthropic`；本地 Ollama 使用 `ollama`，base URL 默认 `http://127.0.0.1:11434/v1`，配置已安装的模型，不需要虚构密钥。模型名必须与服务实际提供的一致；ready 表示配置齐备，不表示真实推理已经通过。

`AWWO_PI_CONTEXT_WINDOW` 与 `AWWO_PI_MAX_TOKENS` 分别声明实际模型上下文和单次输出上限，默认 32768 / 4096。Pi 按 UTF-8 字节保守预留输出与消息开销，这不是精确 tokenizer；上下文超限返回明确错误，不能为消除错误而声明模型不支持的容量。复杂画布应选择足够上下文的模型，或精简规划上下文。

服务端维护可用模型目录，节点及团队成员从目录选择。成员模型空值继承已绑定主 Agent 的模型，主 Agent 使用默认模型时再落到服务默认。租户不能指定任意 base URL、工作目录、秘密环境变量或 shell。当前执行范围为 Pi 文本推理与结构化交付，成员 tools 为空；工程文件需要独立沙箱和存储。

默认配置外可增加模型档案，以下仅为占位示例，不含真实秘密：

```dotenv
AWWO_PI_MODELS_JSON=[{"id":"reviewer","provider":"anthropic","model":"YOUR_APPROVED_MODEL_ID","apiKeyEnv":"AWWO_REVIEWER_API_KEY","contextWindow":32768,"maxTokens":4096}]
AWWO_REVIEWER_API_KEY=YOUR_PRIVATE_KEY
```

目录最多 32 个额外档案；id 在前端可见，model 是实际上游名称，二者可不同。非 Ollama 用 apiKeyEnv 引用环境变量，不能在 JSON 内放 apiKey。每项还可配置 baseURL，容量需符合实际模型。默认档案仍须配置完整；额外档案非法会明确报错，缺少所需秘密不会静默改用其他模型。修改本项目 `.env` 后重启拥有的 Go/Pi 进程，再刷新运行设置与成员模型下拉。Compose 的 Pi 服务使用项目 `.env` 注入档案引用的变量，详见部署示例；staging/production 独立填值。

真实模型验收先运行 `node scripts/awwo-saas-real-provider-acceptance.mjs --check`。它只从本项目配置文件读取模型配置，缺配置以 exit 2 标记阻塞。明确执行 `--run --env-file <本项目配置路径>` 后，脚本在独立 schema 启动 Go/Pi，校验真实两轮响应、历史、SSE 和持久化，失败或清理失败均非成功；不会改用 fixture。不要把模型密钥放入命令参数或聊天记录。

需要可重复的本地负向验收时，使用 `node scripts/awwo-saas-browser-fixture.mjs --start`。输出的 0600 credentials 文件含随机管理员与控制 token；`scripts/awwo-saas-fixture-control.mjs --credentials <file> --rules <json>` 只为该 fixture 设置一次性精确方法/路径故障。Go API 和生产部署不加载此控制器。支持非法规划、上游 503/断连、HTTP 失败/延迟和 SSE 断连，普通请求仍经过实际 Go/Pi。详见 [整改验收记录](awwo-fable-remediation-20260907.md)。

原画布规划助手在点击“生成画布”后提交持久规划 run；合法结果自动应用并显示“已更新画布”，支持撤销，没有额外应用确认按钮。planner 尚不创建或修改 team。SaaS 整图运行则先保存画布，再提交固定文档版本及 scope，由 Go 持久调度；关闭页面后已受理图继续运行，后台记录面板可查询节点与成员结果。原本机模式仍由浏览器 runGraph 调度。

节点属性中启用团队，配置 1–8 位成员并保存；review 至少 2 位。顺序模式按序一次，parallel 前 N−1 位独立执行后由最后一位汇总，debate 按轮次讨论后额外总结，review 每轮执行者工作后由最后一位给出严格 JSON 批准/返工。maxTurns 是调用次数上限，不是 token 或货币预算；timeoutSeconds 与 Go/Pi 外层超时共同限制执行。精确上下文、调用估算及审核格式以节点团队设计为准。

## 配置边界

| 变量 | 用途 |
| --- | --- |
| APP_ENV | development / staging / production；本地启动器只允许 development |
| AWWO_DATABASE_URL | 专属 PostgreSQL DSN；本地启动器默认生成 |
| AWWO_LISTEN_ADDR / AWWO_API_PORT | Go bind 地址 / 本地端口 |
| AWWO_PUBLIC_ORIGIN | 写请求 Origin 校验与浏览器入口 |
| AWWO_API_TARGET | 本地 Vite 代理的 Go 地址 |
| VITE_AWWO_WEB_HOST / VITE_AWWO_WEB_PORT | 本地 Web 监听 |
| AWWO_LOCAL_DB_PORT / AWWO_LOCAL_DB_PASSWORD | 启动器专属 PostgreSQL |
| AWWO_PI_URL / AWWO_PI_HOST / AWWO_PI_PORT | 内部执行服务地址与监听 |
| AWWO_PI_TOKEN | Go 与 Pi 独立认证秘密，至少 32 字符 |
| AWWO_PI_PROVIDER / MODEL / BASE_URL / API_KEY | 默认模型连接（完整名称都有 AWWO_PI_ 前缀） |
| AWWO_PI_MODELS_JSON / 其中 apiKeyEnv 引用变量 | 可选额外模型目录与独立秘密；JSON 只存秘密引用，每环境分别配置 |
| AWWO_PI_CONTEXT_WINDOW / AWWO_PI_MAX_TOKENS | 真实模型上下文与输出预算，默认 32768 / 4096；按 Pi health 的 limits 做保守输入检查 |
| AWWO_PI_TIMEOUT_MS / MAX_CONCURRENCY / MAX_OUTPUT_BYTES | 运行时间、并发与输出限制（完整名称都有 AWWO_PI_ 前缀） |
| AWWO_BOOTSTRAP_ADMIN_EMAIL / PASSWORD | 受控创建平台管理员 |
| AWWO_SESSION_TTL / AWWO_RUN_TIMEOUT | 登录有效期与 Go 运行超时 |
| AWWO_PI_SESSION_WAIT | 取消后 Pi 同一会话清理的有界等待，默认 5s；只重试明确未受理的 SESSION_BUSY |
| AWWO_TRUSTED_PROXY_CIDRS | 精确的可信代理地址/CIDR，逗号分隔；默认不信任转发头 |

staging / production 使用同一配置 schema，要求 HTTPS Origin 与 Secure cookie，不复用开发账号、数据库、模型秘密。Go 单实例协调图和团队任务；租户模型准入次数持久化，实例认证限流及执行所有权仍不具备多副本协调能力。

## 后台图与服务恢复

Go 启动自动应用迁移 007。升级前保留数据库备份；旧 run 按既有准入记录迁移到 model_invocations，不重新执行历史任务。已受理 run、成员轮次与模型调用在 Go 重启后标 interrupted；图读取持久节点状态，未受理且依赖已满足的节点继续，受中断影响的下游被阻断。观察或恢复不重放不确定调用，需重跑时由用户明确发起新任务。

后台运行与协作记录面板读取最近 50 个图任务和选中节点成员记录，不是全历史分页导出。丢失提交响应时按原 operationId 查询；立即停止可按 operationId 写取消记录，避免延迟请求在停止确认后被受理。配置变更后旧图结果不会自动覆盖新输入。单实例数据库锁不是分布式 worker 或高可用承诺。

## 验证

```sh
npm run test:saas:scripts
npm run test:saas:pi
npm run test:saas:backend
npm run test:saas:stack
npm run test:saas --prefix apps/web
npm run typecheck:saas --prefix apps/web
npm run build:saas
# dev:saas 正在运行时，另一个终端执行：
npm run test:saas:smoke
```

`test:saas:backend` 自动使用本项目专属 PostgreSQL，并执行真实数据库测试、race 和 vet；每次测试创建独立 schema 并清理。`test:saas:stack` 使用临时端口、独立数据库 schema、真实 Go/Pi 进程及本地模型协议 fixture，覆盖持久 SSE、历史、幂等、取消、规划和重启。`test:saas:smoke` 访问正在运行的本地服务，创建名称带 Acceptance 的验收用户和工作区，保留这些样例供查看。

不能把没配置数据库而 skip 的测试算通过；真实 provider、HTTP 链路、浏览器和容器分别记录。[基础验收](awwo-saas-verification.md)和[此前真实模型验收](awwo-real-provider-acceptance-20260908.md)有各自快照与范围，本次团队及后台图结果单独报告。团队相关组件/持久化、图恢复、Go 模式与数据库、Pi 多模型测试需随本次实现执行，不能沿用旧用例数判绿。

### 原画布浏览器协议 fixture

`scripts/awwo-saas-browser-fixture.mjs` 是显式的本地协议验收入口，用确定性响应替代模型服务，供同一个原画布 UI 驱动真实 Go → Pi HTTP → Pi SDK/独立子进程 → PostgreSQL 链路。它不调用真实 provider，不使用或替换本项目保存的模型连接配置，也不使用其他项目的凭据。

在仓库根执行：

```sh
# 只检查 fixture 文本、历史/人格摘要、结构化输出和规划形状；无服务或数据库写入
node scripts/awwo-saas-browser-fixture.mjs --self-test

# 先完成 setup:saas；需要本项目 loopback PostgreSQL 正在运行
# 若尚未启动数据库，可先运行：
node scripts/awwo-saas-dev.mjs --database-only

# 启动独立的浏览器协议验收实例
node scripts/awwo-saas-browser-fixture.mjs --start
```

`--start` 只接受 development 和 loopback PostgreSQL。它只读当前 worktree 的 `.local/awwo-saas/.env`，使用 `AWWO_TEST_DATABASE_URL`（若设置）或本项目 `AWWO_DATABASE_URL`，在该数据库新建随机 `awwo_browser_*` schema，不另启/停止现有 PostgreSQL。Go、Pi、Web 和协议服务使用动态 loopback 端口，避开常规开发端口；不会覆盖或停止 5189 / 8087 / 8097 的已有服务。需要已安装的 SaaS Web/Pi 依赖、Go 和 psql。

启动成功打印 `webURL`、`apiURL`、`piURL`、`requestSummaryURL`、`requestSummaryFile` 和临时 schema。打开打印的 webURL，注册专用测试账号；固定模型名为 `awwo-protocol-fixture`，此临时实例不 bootstrap 平台管理员。可从原入口执行：

1. 输入需求并“生成画布”：fixture 返回两节点、一连接的合法计划，原前端校验后自动应用；分别绑定该固定模型并设置人格，再运行整图。
2. 节点会话发送 `first-turn`、`second-turn`，检查历史和人格进入同一 session；运行结果中的字符串、number、boolean、file 等类型来自固定协议规则，不是模型理解能力。
3. 提示中加入 `[fixture:slow]`，获得约 15 秒刷新恢复窗口；加入 `[fixture:hold]`，收到部分输出后等待在原 UI 明确取消，再在同一会话继续运行。
4. 通过打印的摘要地址或临时 `requests.jsonl` 对照模型名、角色顺序、文本长度、SHA256 与截取的测试文本；它不保存请求 headers、API key 或数据库 DSN。只输入专用测试内容。

Ctrl-C 只清理本次 fixture 的进程组、随机 schema 和 `.local/awwo-saas/browser-fixture-*` 临时产物，原开发服务与数据保持原状；需要保留的非秘密验收结果应在退出前记录。该临时实例的数据不用于日常开发。

`--self-test` 通过只证明 fixture 自身规则；`--start` 只证明实例就绪，浏览器动作与数据库结果须实际执行后另记。fixture 使用确定性协议与测试容量，不证明真实 provider 的推理、容量、计费或可用性；file 为 `fixture://.../no-file-created` 引用，不创建附件或工程文件。此前真实模型结果见独立报告，其范围不自动包含新增节点团队。

## 容器部署模板

`deploy/saas/compose.yml` 提供独立 web、api、pi、database 服务。只有 Web 端口默认映射至宿主 loopback，数据库和 Pi 不发布端口。Pi 运行在非 root、只读文件系统、受限 tmpfs、无额外 capabilities 的容器内；没有 Docker socket 或宿主工程目录挂载。

先将 `deploy/saas/.env.example` 复制为忽略的 `deploy/saas/.env` 并填写专属资源，再在需要的环境执行：

```sh
docker compose --env-file deploy/saas/.env -f deploy/saas/compose.yml config --quiet
docker compose --env-file deploy/saas/.env -f deploy/saas/compose.yml build
docker compose --env-file deploy/saas/.env -f deploy/saas/compose.yml up -d
```

这些命令是部署手册，不表示本次已在公网执行。HTTPS 由宿主入口或云负载均衡终止并转发到 Web 8189；staging 必须加外层访问门。初版 Go 不支持多个实例同时工作，不能直接 `--scale api=2`。

公网入口必须正确设置客户端 IP 链：外层代理追加实际客户端 IP，nginx 继续追加自己的对端地址，Go 从右向左跳过 `AWWO_TRUSTED_PROXY_CIDRS` 中的已知代理。配置只包括实际入口/内部 nginx 地址，不使用全网 CIDR。未配置时按直接对端限流，会导致代理后的用户共享登录限额；在开放公网前验证两个真实客户端分别限流，以及伪造转发头不能绕过限流。

数据库默认管理员账号便于本地/Compose启动；上线前应拆分迁移账号与最小权限运行账号，确认备份、恢复、迁移和回滚方案。不要执行 `docker compose down -v` 来更新版本，它会删除持久卷。升级保留数据库卷，先备份并验证迁移，再替换镜像；DB schema 回滚需要独立策略，不能用旧镜像覆盖已变更的数据契约。
