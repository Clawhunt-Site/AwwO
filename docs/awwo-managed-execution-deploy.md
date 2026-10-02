# AwwO 内置执行助手上线步骤

适用于 Go SaaS：`apps/web/saas.html`、`backend`、Pi/OpenAI Agents workers 和 `apps/openmaus-worker`。本文件是发布操作方案；本次完成状态见 [2026-10-02 发布记录](awwo-managed-execution-release-20261002.md)。2026-10-01 的本地功能验收见 [验收记录](knowledge-workbench-acceptance.md)。

## 推荐部署方式

已有 systemd SaaS 实例继续保留域名、反向代理、PostgreSQL 和用户凭证库，新增一个内部 `awwo-saas-openmaus` 服务，以及它使用的 Docker daemon 和 workspace 镜像。不要在升级功能时同时迁移整套数据库和入口。

用户始终只在 AwwO「我的引擎」维护模型连接。内部服务令牌、Docker 和镜像属于部署配置，不向最终用户提供 OpenMaus 登录、配对或二次密钥配置。

请求路径：浏览器 → 现有入口 → Go API → OpenMaus worker → 临时 Docker 工作区。模型请求通过 Go 的本次任务租约返回既有 Pi/OpenAI worker；真正的模型密钥不传给 OpenMaus 核心或工作区。

`deploy/saas/compose.yml` 可用于独立的新环境，但不是既有 systemd 实例的原地升级命令。`scripts/deploy-canvas.sh` 和 `scripts/deploy/awwo-private-acceptance.sh` 属于其他旧运行路径，不用于本次发布。

## 1. 固定发布代码和验收门

1. 在 detached worktree 中整合最新 GitHub `main` 与知识工作台、内置执行助手提交。保留其他已发布功能，不使用强制推送。整合后的 SHA 才是发布版本。
2. 运行对应前端、后端、两个模型 worker、共享模型代理和 OpenMaus 检查。SaaS CI 已拆分后端、模型 worker、网页、既有容器和独立 Linux amd64 OpenMaus 检查，全部通过后才构建完整原生发布包；旧版本 CI 绿灯不能代替本次发布检查。
3. 在隔离验收环境验证真实模型连接：执行、审批、拒绝、取消、四格式产物回传、知识归档和重启读回。固定模型 fixture 证明协议和执行链路，不能替代真实提供商的能力验收。
4. 前次验收中的全后端超时、旧 worker deadline 失败，以最终整合版本的对应检查重新验证；保留历史失败记录，单独记录本次结论，不能把旧失败改写为当时通过。

2026-10-02 的候选源码为 `a16098b365c78f63e4a87c4d6e64db4772ec8bac`。[SaaS CI 36963830059](https://github.com/Clawhunt-Site/AwwO/actions/runs/36963830059) 的五项检查已通过；第一次原生打包虽然执行成功，但 manifest 的 `publicClawHuntURL` 为空，该包不用于上线。已补仓库变量并重跑原生打包 job，第二次通过 artifact ID `11208339294` 下载并核对 `publicClawHuntURL=https://clawhunt.store/` 和归档校验和。同名 artifact 仍保留第一次产物，不能只按名称取首个结果。独立的通用 CI、真实提供商验收、生产切换和浏览器检查均已完成，详细范围见上述发布记录。

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

本环境还要求 GitHub 仓库变量 `AWWO_CLAWHUNT_SITE_URL=https://clawhunt.store`，CI 将它传入构建用的 `VITE_CLAWHUNT_SITE_URL`。下载后必须核对 `release.json` 的 `publicClawHuntURL` 为 `https://clawhunt.store/`；尾斜杠是 URL 标准化结果。变量缺失、值错误或修改前生成的旧 artifact 都不能替代此次验值。记录 workflow run、attempt、完整源码 SHA、归档 SHA256 和 workspace image ID，避免同一次 run 重跑后的产物混用。

## 3. 准备内部运行环境

本次原生包在 Linux amd64、Node 24 下安装依赖并验证运行时；候选 Pi、OpenAI Agents 和 OpenMaus 服务统一使用已核验的 `/usr/local/bin/node`（24.20.0），切换前必须核对 major 仍为 24。不要把目标 Node 24 的依赖直接交给旧 Node 26 可执行文件运行。主机还需要 Docker 和预加载 workspace 镜像；2026-10-02 已准备 Docker 29.8.2 amd64。执行时使用 `--pull=never`，缺镜像会明确失败，服务启动不会替你下载。

为 broker 使用专门的服务账号和数据目录。仅受信任 broker 获得 Docker daemon 权限；Web/API、模型凭证文件和工作区容器不需要 Docker socket。Docker 控制权限本身属于主机高权限，不能把“工作区无网络”解释为 broker 没有主机权限，见 [Docker 官方安全说明](https://docs.docker.com/engine/security/)。

本机已准备 `awwo-openmaus` 专用账号，主组同名、附加组为 `docker`，不加入 `awwo` 凭证组。数据目录为 `/var/lib/awwo-openmaus`，权限 `0700`；内部配置目录为 `/etc/awwo-openmaus`，由 root 持有、权限 `0700`。既有 API、网页和两个模型 worker 继续使用 `awwo-saas:awwo`，API 账号不加入 `docker`。账号与 Docker 就绪不代表候选 broker 已启动或生产已切换。

首发建议 `AWWO_OPENMAUS_MAX_CONCURRENT=1`，根据实测 CPU、内存和任务等待时间再提升。每个工作区已限制 1 CPU、1 GiB 内存，broker 自身仍需额外资源。跨主机扩容应另做私网、鉴权和 TLS 设计。

同机 systemd 的新增配置如下，尖括号是待部署人员填入的值，不能原样使用：

```dotenv
# 仅 API 的私有配置文件
AWWO_OPENMAUS_URL=http://127.0.0.1:8109
AWWO_OPENMAUS_TOKEN=<内部随机令牌，至少32字符>
AWWO_COMPUTER_MODEL_PROXY_URL=http://127.0.0.1:8087/api/internal/computer-model/v1

# 仅新增 OpenMaus worker 的私有配置文件
AWWO_OPENMAUS_HOST=127.0.0.1
AWWO_OPENMAUS_PORT=8109
AWWO_OPENMAUS_TOKEN=<与API相同的内部令牌>
AWWO_OPENMAUS_DOCKER=/usr/bin/docker
AWWO_OPENMAUS_WORKSPACE_IMAGE=<已加载到此daemon的不可变image ID或digest>
AWWO_OPENMAUS_MODEL_PROXY_ORIGINS=http://127.0.0.1:8087
AWWO_OPENMAUS_DATA_DIR=/var/lib/awwo-openmaus/runs
AWWO_OPENMAUS_MAX_CONCURRENT=1
```

API 新增 env 只包含上面三个托管执行变量。实测现网 `AWWO_CREDENTIAL_MODE=operator`，必须保留它及已配置引擎，并继续允许原有个人连接；不能在此次升级时切成 `user`。保留原 `api.env`、`api-typesafe.env` 以及两个模型 worker 的环境文件和 `95-model-catalog.env`，不重写提供商配置。内部令牌在主机生成，API 与 broker 的 env 文件由 root 持有、权限 `0600`，不输出到日志或提交到仓库。

新 broker unit 的 `ExecStart` 使用固定 Node 路径和本次 release 下的 `apps/openmaus-worker/server.ts`；`WorkingDirectory` 指向 release 根，临时数据写在 release 外；设置正常退出宽限至少 30 秒。API、Pi、OpenAI Agents 使用独立 drop-in 切换候选路径，三个服务的 `Description` 都写完整发布 SHA，并读回有效 `ExecStart`、`WorkingDirectory`、`Description` 和环境文件列表。原 unit、旧 Node 路径和配置继续保留用于回滚。只让本机 API 访问 8109，不改变安全组以公开它。先以 broker 账号验证 `docker image inspect` 和真实工作区创建、清理，不能仅用 root 测试代替服务账号权限验收。

同时以该账号验证 release 父目录可遍历、源码和 `.runtime/core/dist-server/` 可读。只授予必要的 release 读取权限，不为了启动方便而开放既有数据库目录或凭证配置目录。

保留既有 `AWWO_CREDENTIAL_ENCRYPTION_KEY` 及恢复副本，不能升级时重新生成，否则现有个人模型连接无法解密。OpenMaus env 不复制 API、数据库、SMTP 或模型提供商凭证。Compose 的 socket GID 默认值 `999` 也必须按实际 socket 核实。

## 4. 数据库变更与切换

迁移为 019 knowledge、020 legacy dispatch ledger、021 source origins、022 managed execution。019/022 会修改 `node_sessions` 约束；021 有历史来源回填，先在隔离数据库测时长和锁影响。

项目默认要求数据库操作经过 Bytebase。2026-10-02 操作者已明确授权“允许本次使用内置迁移器”，此次采用 API 启动前的 `Migrate()`；这是本次发布例外，不是对直接 SQL 或后续迁移的通用授权。所有待执行变更在一个事务内，启动初始化上下文为 30 秒。不要只运行 DDL 或伪造已应用记录。

候选生产 API 启动前，必须同时提供显式 `--migration-approved` 与验证通过的恢复证明。证明须为 root 持有的 `0600` 文件，绑定完整旧/新 SHA、冷备归档路径和 SHA256，并确认 `databaseStoppedForBackup`、`vaultKeyIncluded`、`restoreValidated`、`migrationValidated`、`rollbackCompatible` 均为 true，包含独立恢复证据路径。隔离恢复时只启动复制的 PostgreSQL 数据目录与独立端口，先让候选 API 迁移，再验证旧 API 启动和完整 SHA 健康响应；不能把生产数据库作为排练目标，也不能据此推断所有业务场景都支持降级。

发布顺序：

1. 记录当前 API 可执行路径、网页 root、各 worker 路径、服务文件、配置和镜像 ID。分组件记录，现网可能本来就使用不同 release。
2. 完成数据库可恢复备份及恢复检查。本次使用停写、停 API、正常停止 PostgreSQL 后的物理冷备，归档包含数据目录、原配置与凭证库恢复材料；归档持久化后立即恢复旧服务。冷备步骤自行临时开启并恢复任务入口维护，不能先执行后述独立 `enable-maintenance` 再冷备。EBS 快照请求仅为补充，未核实 completed 与恢复能力的快照不能作为已验证回滚点。
3. 在独立数据库和隔离环境完成候选迁移、旧版本启动兼容与所需功能验收，生成恢复证明。准备完整发布包并校验字节、架构、公开 URL 和镜像；再次核对线上完整 SHA，若其他发布已改变基线就退出。
4. 单独执行 `enable-maintenance`，拒绝新建运行、规划、初始化、图运行、电脑执行、知识整理及旧桥接任务；保留读取、取消和答复。连续三次、间隔 20 秒确认 API 写入和任务指标、Pi/OpenAI 活跃任务均为零，写 root 私有的 `maintenance-proof.json`。切换与备份/维护命令共用主机部署锁。需要取消任务时明确记录任务及结果。
5. 保存各组件原命令、工作目录、描述、环境文件、网页 root 及校验和。写入候选 drop-in 与新增 broker 配置，检查有效配置和 nginx；启动 OpenMaus worker，确认带鉴权的内部健康真实 ready。
6. 明确停止旧 API，再重启使用 Node 24 的候选 Pi/OpenAI workers 并验证健康；在迁移授权和恢复证明均通过后启动候选 API。现有执行租约不支持同库双 API 直接蓝绿运行。保持原 `operator` 模式与 vault key，并读回确认。
7. 网页只切换 AwwO 对应的 root 行，保留独立 TypeSafe root 与维护块；以 `awwo-saas` 运行 nginx 配置检查后重启网页服务。不要广泛替换所有 `saas-` 路径。配置有非本次变更时退出，不覆盖其他部署。
8. 读回原点与公网健康接口的完整 SHA、实际运行路径和 bundle，通过现有鉴权路径完成只读验收后，再用同一份维护证明执行 `disable-maintenance`。只移除本次维护块，保留新 root。不得仅凭命令返回成功宣称已经上线。

## 5. 验收和回滚

上线后先检查原点，再通过现有 Cloudflare Access 的实际鉴权路径检查健康接口和浏览器。匿名 302/403 只说明外层访问状态，不能证明上线成功。

- API：`status=ok`、正确 environment、准确发布 SHA。
- worker：带内部鉴权的 `/health` 返回真实 ready；不把 HTTP 进程存活当作 Docker 和镜像就绪。
- AwwO：已连接模型的账号可读到共享模型；没有模型的账号只出现「我的引擎」配置提示。
- 四窗：HTML、3D、PDF、IDE 及已有产物保持可见；历史、知识来源和修订版本可读。
- 生产只做只读冒烟；模型执行、审批和写产物等验收在隔离环境完成，避免把测试任务写入用户生产数据。

回滚先暂停新任务并让已启动工作区结束或取消，确认清理，再恢复记录的 API/Web/worker 配置与发布包。保留新增知识和执行表，不能为了恢复旧界面而直接删表。旧 API 对新会话的读取兼容性需在隔离副本验证；未经验证不能承诺任意降级安全。恢复备份是单独的数据恢复操作，要评估备份后的新增数据。

本次切换失败会尝试有配置校验和保护的自动回滚：恢复原 API、模型 worker 可执行路径、描述、环境文件和网页 root，停止新 broker，保留数据库新增结构与维护块。确认旧完整 SHA 恢复后，以原来的候选 `--to-revision` 和同一份维护证明，给 `disable-maintenance` 加 `--after-rollback`，只解除维护。正常完成时不加此标志。若上线后才决定手动回滚，须先重新启用维护、核对包括 OpenMaus 在内的任务已结束，再执行回滚；不能跳过维护或只看 Pi/OpenAI 空闲。

进程被强杀或主机掉电可能留下容器；按 `awwo.workspace-sandbox=true` 标签与任务归属逐一核对，避免删除活跃任务。重启时活动任务可能被标记 interrupted，而不会自动续跑。

源码合入、远程推送、服务器配置和生产切换是独立步骤。本方案及本机测试不代表任何一个线上步骤已执行；真正发布应保留最终 SHA、迁移记录、备份标识、分组件回滚目标和原点/公网读回证据。

### 本次 Docker 镜像存储兼容

新装 Docker 29 默认使用 containerd image store，本次 CI 归档记录的是经典存储的 config image ID。主机在零容器且仅有本次导入镜像时，将 `/etc/docker/daemon.json` 设置为 `{"features":{"containerd-snapshotter":false}}`，重启新 Docker 服务并重新导入受校验归档。随后按 manifest 的完整 `sha256:` ID 验证成功，工作区使用该不可变 ID。现有 AwwO 服务不依赖此次新装 daemon；没有切换其他容器工作负载。存储机制与切换行为见 [Docker 官方说明](https://docs.docker.com/engine/storage/containerd/)。

本机原有 Python worker 已占用 loopback 8099，因此托管执行 broker 使用 8109；本机 API 内部 URL 与 broker 监听端口一起配置，不停止或覆盖原有 Python 服务。第一次切换在 broker 就绪检查处因端口占用自动回退，旧服务与任务入口均恢复后才准备重试。

### PDF.js 模块的正式站 MIME

保留 `X-Content-Type-Options: nosniff`，并将 `.mjs` 作为 JavaScript 提供。原生主机在 `/etc/nginx/mime.types` 的既有 JavaScript 行补充 `mjs`，备份旧字节并以原服务账号通过 nginx 配置检查和 reload；公开 PDF worker 返回 `application/javascript` 后，浏览器真实渲染通过。容器模板 `deploy/saas/nginx.conf` 为 `/assets/*.mjs` 明确设置类型，缺失模块返回 404，不回退到 SaaS HTML；该原配置已通过实际 nginx 容器 HTTP 冒烟。
