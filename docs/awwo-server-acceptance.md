# AwwO 私有空服务器验收

后续发布：v0.3.1 将已验收的服务器、回合协议和对话体验修复纳入正式源码。版本检查及本轮 Gemini 豁免见 [v0.3.1 发布记录](releases/0.3.1-verification.md)。下文 v0.3.0 / acceptance.1 保留为首次安装的历史步骤；已有状态的服务器必须使用新 release 目录升级，不能重跑初装。

这份流程将已发布的 **v0.3.0** 安装到独立 Ubuntu 24.04 x86_64 服务器。应用只监听 loopback，使用 SSH 登录与隧道作为外层访问控制。它是 **单操作员画布验收环境**：当前 Gateway 没有向全部上游 HTTP / WebSocket 请求传递工作区用户身份，不能把这个环境称为多租户隔离或已完成用户鉴权的公网服务。账户注册、邀请和成员权限需要在另一套临时、`authenticated` 控制面实例独立验收。

部署脚本不会创建云服务器、选择现有业务主机、修改安全组或复制任何 Codex 登录文件。取得已确认的空服务器后才执行下面的安装。文档与脚本完成不代表远端服务或真实 Agent 已通过验收。

## 准备服务器和不可变源码

需要运行中的 systemd、Node **24**（本次工具链准备使用 24.20.0）、pnpm **9.15.4**、Codex CLI（本次使用 0.153.3），以及 git、curl、python3、make、g++。由管理员创建独立非 root 账户 `awwo`，提供其可写 home。Node 与 Codex 默认可执行文件为 `/usr/local/bin/node`、`/usr/local/bin/codex`，可以传入明确的其他绝对路径。

由操作者先确认实例 ID、区域、磁盘和 SSH 指纹，检查它没有需要保留的应用或数据。安全组只允许指定操作员来源的 SSH，不开放 3100、8796、5188 或 54329。不要关闭其他业务服务器或复用生产数据库。

从已验证的 Git 标签生成纯源码归档，记录并在服务器上比对 SHA-256：

- commit：`6e1dc158a79e2f18c7bdf82610a353883b883f31`
- source tree：`449259d15edc3a5130df538fad4f0f19bba95614`
- 标签：`v0.3.0`

解压到 `/srv/awwo/releases/v0.3.0`，让 `awwo` 拥有该独立目录；不要把当前工作树的 `.env`、`.local`、node_modules、数据库、浏览器状态或凭据上传。部署脚本属于后续部署工具变更，应单独传到服务器；它不是不可变 v0.3.0 源码的一部分。

**在首次安装前应用已验证的锁文件修复。** 原 v0.3.0 锁文件不能通过 npm 11.19.0 的完整性检查。将本次部署分支的 `apps/web/package-lock.json` 单独传为 `/srv/awwo/incoming/awwo-web-package-lock.json`，先核对下列 SHA-256；它只新增四个缺失条目，所有原有条目不变。修复说明见 [锁文件修复](awwo-linux-lock-fix.md)。创建新的 acceptance 目录，原始目录保持不变：

```sh
set -eu
test ! -e /srv/awwo/releases/v0.3.0-acceptance.1
test ! -e /srv/awwo/acceptance-data
printf '%s  %s\n' \
  c48a2100241a95aa313151080dc5fc09f6450d8fe49bae1d1f5071309859580b \
  /srv/awwo/incoming/awwo-web-package-lock.json | sha256sum -c -
sudo cp -a /srv/awwo/releases/v0.3.0 /srv/awwo/releases/v0.3.0-acceptance.1
sudo install -m 644 -o awwo -g awwo \
  /srv/awwo/incoming/awwo-web-package-lock.json \
  /srv/awwo/releases/v0.3.0-acceptance.1/apps/web/package-lock.json
```

这些步骤仅用于全新安装；如果目录已存在，应先检查已有安装和日志，不能再次复制覆盖。

## 首次安装

```sh
sudo bash /path/to/awwo-private-acceptance.sh \
  --repo /srv/awwo/releases/v0.3.0-acceptance.1 \
  --state /srv/awwo/acceptance-data \
  --user awwo
```

可以先添加 `--check-inputs` 只检查参数，不安装任何内容。完整参数见 `--help`。路径只接受无空格、无 shell/systemd 展开的规范绝对路径；状态与源码必须分离。运行时用户不能为 root，四个端口必须互不相同。安装器拒绝已有状态或任何同名 systemd 单元，也不自动清理失败安装，避免覆盖数据库或服务。

脚本以 `awwo` 执行仓库既有的 `npm run setup`，使用经上一步核对的完整锁文件进行冻结安装，再执行 `npm run build:web`。Web 构建的 `APP_ENV` 与 `VITE_APP_ENV` 均为 `staging`。安装依赖时不会传入运行密钥。下表列出脚本默认值；上面的显式 `--state` 会将状态及其子目录改为 `/srv/awwo/acceptance-data`：

| 项目 | 默认值 |
| --- | --- |
| Node 控制面 | `127.0.0.1:3100`，tsx loader 加载既有托管入口 |
| Gateway | `127.0.0.1:8796`，运行其构建产物 |
| Web | `127.0.0.1:5188`，Vite preview 服务已构建的 Web |
| PostgreSQL | `127.0.0.1:54329`，native embedded-postgres，真实 PostgreSQL 进程 |
| 状态 | `/srv/awwo/data`，目录权限 0700 |
| 环境 | `/srv/awwo/data/.env`，权限 0600 |
| PostgreSQL 数据 | `/srv/awwo/data/postgres` |
| 本地加密主密钥 | `/srv/awwo/data/secrets/master.key`，权限 0600 |
| Agent 工作目录 | 在 `/srv/awwo/data/workspaces` 为各节点另建独立目录 |

Agent JWT 与加密主密钥分别随机生成，值不输出到安装日志。没有 `DATABASE_URL` 或生产凭据。`local_trusted/private` 由 SSH 外层访问控制限定为单操作员使用；原生 PostgreSQL 的本地凭据也不能作为多用户系统的数据库隔离边界。定时 heartbeat、数据库自动备份、遥测、浏览器自动打开和跨公司自治关闭，ClawHunt SSO 未配置，画布规划显式选择 Codex。

Vite preview 使用原有代理配置：`/paperclip-api` 到 Node，`/gateway-api` 到 Gateway，网关令牌由服务器侧读取并注入，浏览器不持有令牌。不要直接把静态 dist 扔到一个没有这些代理的 HTTP 服务，也不要把这个 preview 端口开放到公网。

构建后仅在生成的 `dist/index.html` 标题加上 `[STAGING]`，生成 `robots.txt` 的 `Disallow: /`，并在状态目录写一个复用原 Vite 配置的 preview 配置，为响应加上 `X-Robots-Tag: noindex, nofollow`。这些是测试构建产物和私有部署配置，不修改 v0.3.0 源文件。爬虫标记不替代 SSH 访问控制。

安装器启动并检查三个服务、Gateway 的 `upstream.reachable`，并检查全部应用与 PostgreSQL 监听地址。它不会自动发起 Agent 任务。依赖安装或服务启动失败时，保留目录与日志，先诊断；不要反复执行安装器或删除数据库来让它通过。

## SSH 隧道和 Codex 登录

Ubuntu 24.04 的默认 AppArmor 用户命名空间限制可能拦截 Codex 自带的 bwrap。开始真实 Agent 验收前，先按 [Linux 沙箱检查](awwo-linux-sandbox.md) 检查准确的程序路径和所有权；如命中已记录的拒绝，只为 root 管理的该可执行文件安装精确 AppArmor 规则，并验证目录内可写、目录外不可写。保留系统全局限制和 Codex 沙箱，不要以关闭它们来让测试通过。

从操作员电脑建立隧道，替换密钥、服务器用户和 IP：

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:5188:127.0.0.1:5188 -i /path/to/key ubuntu@SERVER_IP
```

在这个 SSH 进程保持运行时访问 `http://127.0.0.1:5188/`。本机该端口被占用时，将左侧本地端口改成一个空闲端口，例如 `15188`，然后访问 `http://127.0.0.1:15188/`。使用新的浏览器配置文件，防止混入之前本地实例的画布、Session 和语言状态。

在服务器上，以服务账户直接使用 Codex 自己的登录流程：

```sh
sudo -u awwo -H /usr/local/bin/codex --version
sudo -u awwo -H /usr/local/bin/codex login --device-auth
sudo -u awwo -H /usr/local/bin/codex login status
```

默认由账户所有者在终端提示的官方页面完成登录；不要把设备码、token、auth.json 或登录输出贴入 Git/报告。设备登录不可用时先使用 CLI 支持的其他登录方式，不得擅自复制本机凭证。本次操作者于 2026-09-06 明确要求复用本机当前 Codex 登录，因此仅向已批准的独立验收机，通过校验主机密钥的 SSH 流同步当前认证文件，未复制其他配置。文件在服务账户 home 中原子写入为 `0600`，本机文件不变；不含凭证值的回执单独保存在忽略目录。该授权只适用于本次操作，不是默认安装步骤。

服务明确使用 `/home/awwo/.codex`（实际值随账户 home 变化）。登录成功后绑定节点，运行配置的 `command` 使用同一个 Codex 路径，`cwd` 使用该节点独立的 `/srv/awwo/data/workspaces/<node>`。保留 `workspace-write`，不启用审批或沙箱绕过。

如果设备代码授权未启用，可以使用 CLI 原生浏览器登录。在本机确认 1455 端口空闲后，另开 SSH 隧道，将本机 `127.0.0.1:1455` 转发到服务器的 `127.0.0.1:1455`；在服务器以相同服务账户运行 `codex login`，在本机浏览器打开该次命令给出的官方授权 URL。成功回调会通过隧道到达服务器，登录文件直接保存在服务账户 home。授权 URL、回调查询参数和凭据不得写入版本库。完成后关闭这条登录隧道，保留应用隧道即可。

`codex login status` 成功只证明身份已授权。还需要以相同账户核对额度，并执行真实请求；如果 CLI 返回额度耗尽，不能将其算作规划、节点执行或交付成功，也不要自动消费额度重置或购买额度。

## 本次安装记录（2026-09-06）

首次使用 Node 24.20.0 / npm 11.19.0 安装 v0.3.0 时，Web 锁文件缺失四个可选依赖条目。原目录和日志保留；仅补齐锁文件后，在新的 `/srv/awwo/releases/v0.3.0-acceptance.1` 目录完成实际 Linux 安装与 Web 构建。详见 [锁文件修复](awwo-linux-lock-fix.md)。此目录是 v0.3.0 加锁文件修复，不能称为逐字相同的原始标签。实际运行状态目录为 `/srv/awwo/acceptance-data`，不是上文默认示例 `/srv/awwo/data`。

当前验收进展见 [服务器验收记录](awwo-server-acceptance-results-2026-09-06.md)。测试记录区分已观测的服务器、账户和浏览器结果，以及仍需真实 Codex 完成的画布链路。

## 实际验收和维护

安装检查不等同于实际验收。至少保存下列不含凭据的证据：

1. SSH 保护、全部监听地址、源码归档 SHA-256、服务启动及重启结果。
2. 浏览器空状态、中文/英文切换、个性化节点模板，以及 AI 创建和修改两节点依赖图。
3. 两个节点绑定真实 Codex、独立目录和 Session；整图执行后回读两边实际交付文件与状态。
4. 合同校验拒绝、指定节点修复、Stop 的原生取消、同 Session 续聊、运行中刷新和双标签页防重复派发。
5. 服务重启后数据库和 Session 持久化、运行恢复及孤儿进程检查。画布文档仍有浏览器本地状态，不能用数据库存活冒充跨设备画布同步。
6. 单独临时 `authenticated` 控制面的注册、登录、邀请、成员和权限测试，明确与本单操作员画布结果分开。

```sh
sudo systemctl status awwo-acceptance-node awwo-acceptance-gateway awwo-acceptance-web
sudo journalctl -u awwo-acceptance-node -u awwo-acceptance-gateway -u awwo-acceptance-web --since '10 minutes ago'
sudo ss -ltnp
curl -fsS http://127.0.0.1:3100/api/health
curl -fsS http://127.0.0.1:8796/health
```

服务以 `KillMode=mixed` 让入口先完成 PostgreSQL/子进程关闭，45 秒后清理本服务控制组的残留进程。维护重启先停止 Web、Gateway、Node，再依次启动 Node、Gateway、Web，并重新读回健康状态。数据库自动备份在测试中关闭；需要保留验收数据时，分别备份数据库、runtime/gateway/storage 状态和原加密主密钥，限制副本访问权限。不要将密钥与验收日志一起发布。

后续升级应使用新的 release 目录，审阅 schema 变化并先备份。这份脚本不执行升级、回滚、销毁或覆盖现有服务。

本地部署工具检查：

```sh
node --test scripts/deploy/awwo-private-acceptance.test.mjs
```

这些检查验证 Bash 语法、拒绝危险输入，以及真实配置生成器的端口、密钥和 PostgreSQL 配置；没有替代 Ubuntu/systemd、原生 PostgreSQL、Codex 登录或浏览器远端验收。
