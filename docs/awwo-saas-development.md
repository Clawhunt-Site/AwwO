# AwwO SaaS 本地开发与部署说明

本入口运行 Go API、PostgreSQL、Pi worker 和复用原画布的 SaaS Web，独立于历史 `npm run dev` 的 Node/Codex 模式。架构与阶段边界见 [架构设计](awwo-saas-architecture.md)。

## 本地启动

要求 Node >=22.19（实际验证版本见验收报告）、npm、支持自动 toolchain 的 Go，以及 `initdb/pg_ctl/psql/createdb`。项目 go.mod 锁定 Go 工具链，不需要替换系统 Go。

```sh
npm run setup:saas
npm run dev:saas
```

默认地址 `http://127.0.0.1:5189/`，管理入口 `/admin`。Go 8087、Pi 8097、PostgreSQL 55483。启动前检查端口，不会停止已有服务。首次生成的数据库、内部服务和管理员密码只保存在当前 worktree 的 `.local/awwo-saas/.env`，管理员邮箱默认 `admin@awwo.local`。打开该本地文件查看初始密码；不要提交或分享该文件。

运行数据位于 `.local/awwo-saas/postgres`。启动器只操作该专属集群，退出时只停止本次启动的子进程。若集群已由 `node scripts/awwo-saas-dev.mjs --database-only` 启动，完整启动会复用它而不会在退出时停止它。不要将其他项目的数据库配置给此入口。数据库 schema 会在 API 启动时迁移。

修改 `.local/awwo-saas/.env` 后重启本次 dev 命令。首位管理员通过 bootstrap 配置建立；修改环境变量不等价于重置已有账号密码，后端的初始化行为以 API 文档为准。

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

服务端固定可用模型，租户不能通过前端指定任意 base URL、工作目录、环境变量或 shell。首版是无通用代码执行工具的 Agent 对话/结构化交付运行时；代码工程执行需在独立沙箱和交付物存储完成后开放。

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
| AWWO_PI_PROVIDER / MODEL / BASE_URL / API_KEY | 服务器端模型连接 |
| AWWO_PI_TIMEOUT_MS / MAX_CONCURRENCY / MAX_OUTPUT_BYTES | 运行时间、并发与输出限制（完整名称都有 AWWO_PI_ 前缀） |
| AWWO_BOOTSTRAP_ADMIN_EMAIL / PASSWORD | 受控创建平台管理员 |
| AWWO_SESSION_TTL / AWWO_RUN_TIMEOUT | 登录有效期与 Go 运行超时 |
| AWWO_PI_SESSION_WAIT | 取消后 Pi 同一会话清理的有界等待，默认 5s；只重试明确未受理的 SESSION_BUSY |
| AWWO_TRUSTED_PROXY_CIDRS | 精确的可信代理地址/CIDR，逗号分隔；默认不信任转发头 |

staging / production 使用同一配置 schema，要求 HTTPS Origin 与 Secure cookie，不复用开发账号、数据库、模型秘密。实例全局限流首版在单进程内生效，多副本时需要集中式配额/限流。

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

不能把没配置数据库而 skip 的测试算通过；真实 provider、HTTP 链路、浏览器和容器验证也分别记录。[验收报告](awwo-saas-verification.md)是实际结果的事实来源。

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
