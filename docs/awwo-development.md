# AwwO 本地开发

当前 Agent 画布由三个本地进程提供服务：Web `5188`、网关 `8796`、Node 控制面 `3100`。每个节点绑定真实 Agent，每个 Session 使用独立 issue / runtime session。安装和启动命令不会创建 Agent 或提交任务；使用者在画布中确认绑定并发送后才执行。

## 从干净克隆开始

准备 Node.js **22.x 的 22.13 或以上版本，或 24+**（推荐 24），以及可用的 `pnpm` 命令。该范围与当前 Web 依赖的 Node 要求一致，不包含 Node 23。根目录及 `server/package.json` 都声明 **pnpm 9.15.4**；通过 Corepack 或本地工具链使用该项目版本，无需修改用户已有的全局 pnpm。若 Node 安装包含 Corepack，可先运行 `corepack enable`。然后在仓库根目录执行：

```sh
npm run setup
npm run dev
```

`setup` 依次运行下面的锁定安装与构建；任意一步失败立即以非零状态退出：

```sh
pnpm -C server install --frozen-lockfile
pnpm -C server run preflight:workspace-links
pnpm -C server --filter @paperclipai/plugin-sdk ensure-build-deps
npm ci --prefix apps/web
npm ci --prefix apps/gateway
npm run build --prefix apps/gateway
```

安装器通过 `pnpm -C server --version` 检查实际工作区工具链；全局默认版本与工作区版本不同不会被误判为错误。

`server/` 是完整 vendored 源码目录，包含工作区清单、锁文件和必需补丁；它不是需要另外初始化的 Git submodule。`node_modules` 和 `dist` 不随仓库分发。Web 同时编译 `server/ui`，所以不能省略服务端工作区安装；插件 SDK 的 exports 指向生成的 `dist`，也不能省略 `ensure-build-deps`。

普通 Codex 节点运行不需要额外的项目插件 MCP 桥。若明确启用该桥，先运行上游提供的可选构建命令：

```sh
pnpm -C server --filter @paperclipai/mcp-server build
```

缺少该包生成的 `dist` / bin 时，插件桥处于 disabled 状态；默认安装与画布验收不代表所有历史插件都已构建或验证。

启动器只使用当前仓库内安装的 Node 入口，不依赖旧工作树或主目录的依赖链接。Windows 下网关独立启动，明确禁用 Vite 的 sidecar；不通过 `.bin/tsx` 的 Unix shim 启动服务。

启动前会确认三个监听端口均未占用。控制面健康、网关上游可达、Web 已响应之后才显示 `AwwO ready`。已有进程不会被启动器接管或停止。退出按 Ctrl+C；启动失败或子服务退出会停止本次启动的其他服务，返回非零退出码。启动器不会删除数据库或日志。

## 本地数据与配置

默认运行态在仓库内 `.local/awwo/`，启动器会创建忽略规则：

| 路径 | 用途 |
| --- | --- |
| `runtime/` | 原生 PostgreSQL 数据、运行实例和 Agent 工作目录 |
| `runtime/instances/default/.env` | 官方初始化函数生成的 Agent JWT secret |
| `gateway/` | 网关令牌、索引、调度存储与运行标记 |
| `storage/` | 交付文件存储 |
| `logs/` | 控制面日志 |
| `.env` | 可选的本地启动参数，由启动器读取；进程环境变量优先 |

默认使用上游已有的 **native embedded-postgres** 分支，它运行真正的 PostgreSQL 进程；`SUPERCLAW_DESKTOP_PGLITE=0` 明确关闭 PGlite。保留依赖安装脚本和平台可选依赖，以便 native PostgreSQL 二进制可用。也可以通过 `DATABASE_URL` 使用自行准备的专用本地 PostgreSQL；启动器只接受 loopback PostgreSQL 地址。首次启动会应用当前 schema 迁移，因此不要使用含有其他项目数据的数据库。

JWT secret 通过 vendored CLI 的 `ensureAgentJwtSecret` 生成，不写进源码、不打印其值。不要把运行目录、`.env`、数据库、Codex 登录文件或生成交付物加入 Git。新克隆不会自带旧公司的绑定与聊天历史；应在新实例中创建工作区并重新绑定。

下列现有变量可在 `.local/awwo/.env` 或启动终端中配置。此入口只支持 `development` 和 loopback；staging / production 使用独立部署流程。

| 变量 | 默认或作用 |
| --- | --- |
| `APP_ENV` / `VITE_APP_ENV` | 都为 `development` |
| `PORT` | 控制面 `3100` |
| `SUPERCLAW_GATEWAY_PORT` | 网关 `8796` |
| `VITE_SUPERCLAW_WEB_PORT` | Web `5188` |
| `HOST` / `SUPERCLAW_GATEWAY_HOST` / `VITE_SUPERCLAW_WEB_HOST` | `127.0.0.1` |
| `SUPERCLAW_GATEWAY_UPSTREAM_URL` / `VITE_NODE_API_TARGET` | 根据控制面监听端口生成；显式配置必须与监听端口一致 |
| `VITE_GATEWAY_API_TARGET` | 根据网关监听端口生成；不读取旧 Node service marker |
| `DATABASE_URL` / `DATABASE_MIGRATION_URL` | 可选的专用本地 PostgreSQL URL；不配置则使用 native embedded PostgreSQL |
| `PAPERCLIP_HOME` / `PAPERCLIP_CONFIG` / `PAPERCLIP_INSTANCE_ID` | 可覆盖默认运行实例路径；指定已有配置前先确认其中的数据库与数据目录 |
| `SUPERCLAW_HOME` | 网关状态目录；Vite 与网关使用同一个值 |
| `PAPERCLIP_LOG_DIR` / `PAPERCLIP_STORAGE_LOCAL_DIR` | 可覆盖日志、文件存储目录 |
| `CODEX_HOME` | 可选；使用本机已有 Codex 登录目录，不复制凭据 |
| `SUPERCLAW_CANVAS_PLANNER_CLI_PATH` | 画布规划使用的 Codex 可执行文件，默认从 PATH 找 `codex` |
| `SUPERCLAW_CANVAS_PLANNER_MODEL` | 可选模型，未设置则沿用 Codex 默认配置 |
| `SUPERCLAW_CANVAS_PLANNER_PROVIDER` | 开发默认 `codex`，可显式设 `disabled` |
| `SUPERCLAW_CANVAS_PLANNER_TIMEOUT_MS` | 规划超时，默认 `120000` |

启动器固定关闭定时 heartbeat、DB 自动备份及浏览器自动打开，并使用明确的网关上游地址。它不会清理其他运行实例或自动派发任何新任务。显式复用一个已有数据库时，数据库中原有的任务状态依旧存在。

## 接入本机真实 Codex

先在同一账户确认 CLI 可运行且已登录：

```sh
codex --version
codex login status
```

若本机同时安装了多个版本，为画布规划设置 `SUPERCLAW_CANVAS_PLANNER_CLI_PATH`；绑定节点时，在运行配置的 `command` 中使用同一个可执行文件。登录由 Codex 自己管理。

Windows 若创建托管登录目录时遇到 `EPERM symlink auth.json`，在节点运行配置的 `env.CODEX_HOME` 中填写已有 Codex home 的绝对路径。保持每个 Agent 独立的 `cwd`；共享登录目录不会合并节点的工作目录或 Session。不要复制 token，也不要为绕过这个问题修改系统权限。

节点默认使用 `workspace-write`，不打开审批或沙箱绕过选项。选择公司、Codex 运行环境及模型后绑定，再从节点 Session 发送任务。整图执行会按依赖关系传递节点的结构化输出。后续对已完成 / 阻塞 issue 续聊使用官方 `resume` 门禁；依赖未完成时会显示真实阻塞原因。

浏览器画布文档与 Session 显示还有本地状态：从其他 HTTP 客户端启动的运行不会自动写入当前打开标签页的交付物面板。不要把单独 API 运行当成该标签页已同步的证明。

## 验证入口

在已安装依赖的仓库根目录运行当前 AwwO 相关检查：

```sh
npm run test:scripts
npm run test:web
npm run test:gateway
npm run build:web
npm run build:gateway
```

完整 Node 控制面仍有自己的工作区门禁，应在 Linux CI 执行官方 runner，保留 general / serialized 的隔离顺序：

```sh
pnpm -C server run typecheck:build-gaps
pnpm -C server run test:run:general
pnpm -C server run test:run:serialized
pnpm -C server build
```

如果检查完整历史项目而非仅 Agent 画布，还要安装 Python 3.12 的开发依赖，运行根目录 `ruff` / `pytest` / CLI doctor，以及 `.github/workflows/ci.yml` 中的独立 Studio backend、frontend 和 Docker 构建检查。现有 `scripts/run-ci-tests.ps1` / `.sh` 不覆盖上述所有检查，不能用其结束文案替代每条命令的退出状态。

健康检查地址：控制面 `http://127.0.0.1:3100/api/health`，网关 `http://127.0.0.1:8796/health`，Web `http://127.0.0.1:5188/`。网关的 `ok: true` 只表示自身存活，必须同时看到 `upstream.reachable: true`。健康检查不证明 Codex 已登录或真实任务已执行；真实验收需要绑定并运行节点，回读 run 状态、Session 输出与实际交付文件。

浏览器画布启动通过 `/paperclip-api/health` 和 `/gateway-api/health` 检查这两个服务，不依赖旧 Python `/api/runtime/status` 或审批队列；桌面与旧工作台仍保留原有启动链路。没有公司或未配置 Agent 不会阻止进入画布。服务未就绪或健康请求挂起超过 8 秒时，页面会显示连接失败和重试入口，不会把网关自身存活当作上游已就绪。
