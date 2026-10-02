# AwwO 内置执行助手上线步骤

适用于 Go SaaS：`apps/web/saas.html`、`backend`、Pi/OpenAI Agents workers 和 `apps/openmaus-worker`。本文件是发布操作方案，不是已上线声明。2026-10-01 的本地功能验收见 [验收记录](knowledge-workbench-acceptance.md)。

## 推荐部署方式

已有 systemd SaaS 实例继续保留域名、反向代理、PostgreSQL 和用户凭证库，新增一个内部 `awwo-saas-openmaus` 服务，以及它使用的 Docker daemon 和 workspace 镜像。不要在升级功能时同时迁移整套数据库和入口。

用户始终只在 AwwO「我的引擎」维护模型连接。内部服务令牌、Docker 和镜像属于部署配置，不向最终用户提供 OpenMaus 登录、配对或二次密钥配置。

请求路径：浏览器 → 现有入口 → Go API → OpenMaus worker → 临时 Docker 工作区。模型请求通过 Go 的本次任务租约返回既有 Pi/OpenAI worker；真正的模型密钥不传给 OpenMaus 核心或工作区。

`deploy/saas/compose.yml` 可用于独立的新环境，但不是既有 systemd 实例的原地升级命令。`scripts/deploy-canvas.sh` 和 `scripts/deploy/awwo-private-acceptance.sh` 属于其他旧运行路径，不用于本次发布。

## 1. 固定发布代码和验收门

1. 在 detached worktree 中整合最新 GitHub `main` 与知识工作台、内置执行助手提交。保留其他已发布功能，不使用强制推送。整合后的 SHA 才是发布版本。
2. 运行对应前端、后端、两个模型 worker、共享模型代理和 OpenMaus 检查。SaaS CI 已拆分后端、模型 worker、网页、既有容器和独立 Linux amd64 OpenMaus 检查，全部通过后才构建完整原生发布包；旧版本 CI 绿灯不能代替本次发布检查。
3. 在隔离验收环境验证真实模型连接：执行、审批、拒绝、取消、四格式产物回传、知识归档和重启读回。固定模型 fixture 证明协议和执行链路，不能替代真实提供商的能力验收。
4. 前次验收中的全后端超时、旧 worker deadline 失败仍需在最终整合版本上解决或明确记录发布判断，不得作为通过项。

Linux 验收节点应显式设置 Docker context；下面的 `default` 必须是实际目标 daemon：

```sh
npm ci --ignore-scripts --prefix apps/openmaus-worker
npm run setup --prefix apps/openmaus-worker
npm run typecheck --prefix apps/openmaus-worker
npm run check:saas:computer-model
npm run test:saas:computer-model
docker build -f deploy/saas/workspace/Dockerfile -t awwo-workspace:release-check .
AWWO_OPENMAUS_REAL_TEST=1 \
  AWWO_TEST_DOCKER_EXECUTABLE=/usr/bin/docker \
  AWWO_TEST_DOCKER_CONTEXT=default \
  AWWO_TEST_WORKSPACE_IMAGE=awwo-workspace:release-check \
  npm run test:saas:openmaus
```

在单独 CI job 中构建 `deploy/saas/openmaus.Dockerfile` 并验证实际 amd64 容器，避免继续把所有检查塞入原来的 30 分钟任务。不要把 Mac 的 arm64 镜像或 `node_modules` 直接拷到 x86_64 主机。

## 2. 构建一份完整的不可变发布包

从干净的最终发布 SHA 构建并记录 `SOURCE_SHA`、所有文件 SHA256、目标架构和 OpenMaus upstream revision。包内至少包含：

| 内容 | 发布要求 |
| --- | --- |
| `awwo-api` | linux/amd64，编译注入 `awwo/backend/internal/app.buildRevision` |
| `html/` | `apps/web/dist-saas` 原样复制，入口保留 `saas.html` |
| `apps/pi-worker/` | 新版服务和在目标 Linux 安装的锁定依赖 |
| `apps/openai-agents-worker/` | 新版服务、sandbox helper 和目标 Linux 依赖 |
| `apps/computer-model.ts`、`apps/user-models.ts` | 两个模型 worker 的相对导入必需；保持 `apps/` 层级 |
| `apps/openmaus-worker/` | TS 源码、package.json、构建后的 `.runtime/core/dist-server/` 及 manifest |
| 许可文件 | OpenMaus LICENSE、NOTICE、third_party 保留在核心构建产物中 |
| workspace 镜像 | 在执行服务实际使用的 daemon 预先加载，记录不可变 digest/image ID |

现有 API 的正确原生构建方式：

```sh
release_sha=$(git rev-parse HEAD)
mkdir -p .local/managed-release
(cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
  -ldflags "-s -w -X awwo/backend/internal/app.buildRevision=$release_sha" \
  -o ../.local/managed-release/awwo-api ./cmd/api)
npm run build:saas --prefix apps/web
```

API Dockerfile 已支持 `AWWO_REVISION` build arg，Compose 会传入该值。构建时必须提供完整发布 SHA；只在运行时设置同名环境变量不会改变编译进健康接口的 revision。

Linux CI 调用 `node scripts/awwo-saas-release.ts --output .local/saas-release --docker-context default` 生成 `awwo-saas-<完整SHA>-linux-amd64` artifact。校验归档 `.sha256` 后解压，再在 release 根执行 `sha256sum --quiet -c SHA256SUMS`。加载 `images/workspace.tar`，读回镜像 ID 并与 `WORKSPACE_IMAGE_ID` 完全匹配后，才提供给 broker。打包器从提交导出干净源代码，在 Linux 安装锁定依赖，不带开发机 node_modules、.env 或运行数据。

## 3. 准备内部运行环境

主机需要 Node ≥24、Docker 和预加载 workspace 镜像。执行时使用 `--pull=never`，缺镜像会明确失败，服务启动不会替你下载。

为 broker 使用专门的服务账号和数据目录。仅受信任 broker 获得 Docker daemon 权限；Web/API、模型凭证文件和工作区容器不需要 Docker socket。Docker 控制权限本身属于主机高权限，不能把“工作区无网络”解释为 broker 没有主机权限，见 [Docker 官方安全说明](https://docs.docker.com/engine/security/)。

首发建议 `AWWO_OPENMAUS_MAX_CONCURRENT=1`，根据实测 CPU、内存和任务等待时间再提升。每个工作区已限制 1 CPU、1 GiB 内存，broker 自身仍需额外资源。跨主机扩容应另做私网、鉴权和 TLS 设计。

同机 systemd 的新增配置如下，尖括号是待部署人员填入的值，不能原样使用：

```dotenv
# 仅 API 的私有配置文件
AWWO_CREDENTIAL_MODE=user
AWWO_OPENMAUS_URL=http://127.0.0.1:8099
AWWO_OPENMAUS_TOKEN=<内部随机令牌，至少32字符>
AWWO_COMPUTER_MODEL_PROXY_URL=http://127.0.0.1:8087/api/internal/computer-model/v1

# 仅新增 OpenMaus worker 的私有配置文件
AWWO_OPENMAUS_HOST=127.0.0.1
AWWO_OPENMAUS_PORT=8099
AWWO_OPENMAUS_TOKEN=<与API相同的内部令牌>
AWWO_OPENMAUS_DOCKER=/usr/bin/docker
AWWO_OPENMAUS_WORKSPACE_IMAGE=<已加载到此daemon的不可变image ID或digest>
AWWO_OPENMAUS_MODEL_PROXY_ORIGINS=http://127.0.0.1:8087
AWWO_OPENMAUS_DATA_DIR=<仅此服务账号可写的绝对目录>
AWWO_OPENMAUS_MAX_CONCURRENT=1
```

新 unit 的 `ExecStart` 使用固定 Node 路径和本次 release 下的 `apps/openmaus-worker/server.ts`；`WorkingDirectory` 指向 release 根，临时数据写在 release 外；设置正常退出宽限至少 30 秒。只让本机 API 访问 8099，不改变安全组以公开它。先以该服务账号验证 `docker image inspect` 和真实工作区创建、清理，不能仅用 root 测试代替服务账号权限验收。

同时以该账号验证 release 父目录可遍历、源码和 `.runtime/core/dist-server/` 可读。只授予必要的 release 读取权限，不为了启动方便而开放既有数据库目录或凭证配置目录。

保留既有 `AWWO_CREDENTIAL_ENCRYPTION_KEY` 及恢复副本，不能升级时重新生成，否则现有个人模型连接无法解密。OpenMaus env 不复制 API、数据库、SMTP 或模型提供商凭证。Compose 的 socket GID 默认值 `999` 也必须按实际 socket 核实。

## 4. 数据库变更与切换

迁移为 019 knowledge、020 legacy dispatch ledger、021 source origins、022 managed execution。019/022 会修改 `node_sessions` 约束；021 有历史来源回填，先在隔离数据库测时长和锁影响。

依照本项目操作要求，生产数据库查询和迁移须经过 Bytebase。当前会话没有 Bytebase 工具，尚未查询生产迁移版本或执行数据库变更。不要绕过此门直接启动候选 API：它会在监听前自动调用 `Migrate()`，所有待执行变更在一个事务内，启动初始化上下文为 30 秒。预先应用迁移时必须同时匹配现有 migration identity/版本记录，不能只运行 DDL 或伪造已应用记录。

发布顺序：

1. 记录当前 API 可执行路径、网页 root、各 worker 路径、服务文件、配置和镜像 ID。分组件记录，现网可能本来就使用不同 release。
2. 完成数据库可恢复备份及恢复检查；若采用 EBS 快照，先准备一致性备份方案并等待快照 completed，不能把已提交快照请求当作可用回滚点。
3. 在独立数据库和隔离环境完成候选版本验收，再安排生产维护窗口。
4. 暂停新任务入口，等待运行中任务结束；需要取消时明确记录任务及结果。只读页面可保留。所有配置和发布包已经准备好后才开始切换。
5. 启动已准备的 OpenMaus worker，更新 Pi/OpenAI workers 到同一兼容版本，先核对内部健康状态。
6. 停止旧 API，经数据库变更门后启动新 API。现有执行租约不支持同库双 API 直接蓝绿运行；旧 API 退出、新 API 启动的顺序必须明确。
7. 将网页 root 切到新 bundle。按原运行账号验证 nginx 配置，只改对应 root 行；失败立即恢复原配置。不要广泛替换所有 `saas-` 路径。
8. 读回健康接口中的最终 SHA、真实运行路径和 bundle，再恢复新任务入口。

## 5. 验收和回滚

上线后先检查原点，再通过现有 Cloudflare Access 的实际鉴权路径检查健康接口和浏览器。匿名 302/403 只说明外层访问状态，不能证明上线成功。

- API：`status=ok`、正确 environment、准确发布 SHA。
- worker：带内部鉴权的 `/health` 返回真实 ready；不把 HTTP 进程存活当作 Docker 和镜像就绪。
- AwwO：已连接模型的账号可读到共享模型；没有模型的账号只出现「我的引擎」配置提示。
- 四窗：HTML、3D、PDF、IDE 及已有产物保持可见；历史、知识来源和修订版本可读。
- 生产只做只读冒烟；模型执行、审批和写产物等验收在隔离环境完成，避免把测试任务写入用户生产数据。

回滚先暂停新任务并让已启动工作区结束或取消，确认清理，再恢复记录的 API/Web/worker 配置与发布包。保留新增知识和执行表，不能为了恢复旧界面而直接删表。旧 API 对新会话的读取兼容性需在隔离副本验证；未经验证不能承诺任意降级安全。恢复备份是单独的数据恢复操作，要评估备份后的新增数据。

进程被强杀或主机掉电可能留下容器；按 `awwo.workspace-sandbox=true` 标签与任务归属逐一核对，避免删除活跃任务。重启时活动任务可能被标记 interrupted，而不会自动续跑。

源码合入、远程推送、服务器配置和生产切换是独立步骤。本方案及本机测试不代表任何一个线上步骤已执行；真正发布应保留最终 SHA、迁移记录、备份标识、分组件回滚目标和原点/公网读回证据。
