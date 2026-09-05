# AWS 部署 — SuperClaw Canvas（clawhunt-app-1 / EC2 + docker 模式）

> 2026-08-26 起部署目标从 Cloud Run 切到 AWS（业主决定）。本文是已验证跑通的流程沉淀。
> 账号 563688183799 · region **us-east-2** · CLI 一律 `--profile clawhunt`（env 钉着的
> default profile 是 Bedrock-only key + us-east-1，会 AccessDeny 一切——不要用）。

## 架构

- 复用既有模式：镜像跑在 EC2 **clawhunt-app-1**（i-08b823f76bd4a44ae, r7i.large/amd64），
  nginx 反代（TLS 证书全局配置），SG 只开 80/443/22。
- 容器：根 `Dockerfile`（含全部 B2 修复），单入口 :8080 → 宿主 **:8085**。
- vhost：`/etc/nginx/conf.d/canvas.clawhunt.store.conf` → 127.0.0.1:8085。
- DNS：clawhunt.store 在 **Cloudflare**（remy/adele.ns.cloudflare.com）——
  `canvas.clawhunt.store` 需在 CF 加 A 记录 → 16.58.241.212（与其他子域同模式）。
- DB：PGlite（`SUPERCLAW_DESKTOP_PGLITE=1`）+ 持久卷 `/opt/superclaw-canvas/data:/data`。
  单实例单写者。换 RDS 时直接设 `DATABASE_URL=postgres://…`（**不要**移植 GCP 的
  cloud-sql-proxy 形状）。

## 密钥（AWS SSM Parameter Store, SecureString, us-east-2）

从 GCP Secret Manager 迁移（原值未变）：

| SSM 参数 | 注入为 | 原 GCP secret |
|---|---|---|
| `/superclaw/canvas/relay-api-key` | `SUPERCLAW_RELAY_API_KEY` | SUPERCLAW_PLATFORM_RELAY_KEY |
| `/superclaw/canvas/webhook-secret` | `SUPERCLAW_WEBHOOK_SECRET` | SUPERCLAW_WEBHOOK_SECRET |
| `/superclaw/canvas/agent-jwt-secret` | `PAPERCLIP_AGENT_JWT_SECRET` | BETTER_AUTH_SECRET |

实例角色 `clawhunt-ec2-role` 已能 `ssm:GetParameter`（运行脚本在启动时取值注入，
不落盘不进镜像）。

## 部署流程（全程 SSM，无需本机 Docker）

```bash
# 1) 干净树打包源码 → S3（在 feature worktree，HEAD 即部署内容）
git archive --format=tar.gz -o /tmp/src.tar.gz HEAD
aws s3 cp /tmp/src.tar.gz s3://clawhunt-data-563688183799/deploy/superclaw-canvas/src-<tag>.tar.gz --profile clawhunt --region us-east-2

# 2) app-1 上构建（SSM send-command；构建约 25 分钟，nohup + build.log 轮询）
#    tar 解到 /opt/superclaw-canvas/build/src && docker build -t clawhunt-superclaw-canvas:<tag> .

# 3) 启动：bash /opt/superclaw-canvas/run.sh（脚本源 s3://…/run-canvas.sh）
#    - SSM 取三个密钥注入 env
#    - SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL=https://clawhunt.store（生产 SSO）
#    - SUPERCLAW_GATEWAY_CROSS_COMPANY_AUTONOMY=on（与 Cloud Run 生产一致）
#    - -p 8085:8080 -v /opt/superclaw-canvas/data:/data（chown 1001）

# 4) 两级健康门（front door 起 ≠ Node 控制面起，必须都过才算部署完成）：
curl http://127.0.0.1:8085/health              # {"ok":true,"service":"superclaw"}
curl http://127.0.0.1:8085/paperclip-api/health # {"status":"ok",…}（最长等 ~4 分钟）

# 5) 外部冒烟（本机在 Clash 后：加 --noproxy "*"，否则代理层 502 会误判）：
curl --noproxy "*" -H "Host: canvas.clawhunt.store" http://16.58.241.212/health
```

## TLS / 新子域上线（**必读**，踩过坑）

nginx 的 `ssl_certificate` 是 **http 层全局**（`conf.d/clawhunt.conf` 顶部），所有 vhost 共用
`/etc/nginx/certs/clawhunt.crt`。**这张证书是显式 SAN 列表、不是通配符** —— 新子域不加进
SAN，Cloudflare（Full strict）就会回 **526**，与 DNS 记录是否正确无关。

证书由主机上的 **acme.sh** 经 **Cloudflare DNS API（dns_cf）** 签发，cron 自动续期。
新增子域 = 把全部域名重签一次（**必须带上所有既有域名**，acme.sh 是全量替换语义）：

```bash
export HOME=/root                      # ← 不设会读不到 CF API 凭证，签发必失败
/root/.acme.sh/acme.sh --issue --force --home /root/.acme.sh \
  -d clawhunt.store -d www.clawhunt.store -d payswitch.clawhunt.store \
  -d embed.clawhunt.store -d staging.clawhunt.store \
  -d canvas.clawhunt.store -d superclaw.clawhunt.store \
  --dns dns_cf --server letsencrypt
export HOME=/root
/root/.acme.sh/acme.sh --install-cert -d clawhunt.store --ecc --home /root/.acme.sh \
  --fullchain-file /etc/nginx/certs/clawhunt.crt --key-file /etc/nginx/certs/clawhunt.key \
  --reloadcmd "nginx -t && systemctl reload nginx"
openssl x509 -in /etc/nginx/certs/clawhunt.crt -noout -ext subjectAltName   # 自检
```

**坑（2026-08-26 实际踩到）**：SSM 以 root 跑但 `HOME` 未设 → acme.sh 找不到 CF 凭证，
签发失败；紧随其后的 `--install-cert` 仍会执行，把 crt **写成 0 字节**。当时 nginx 尚未
reload 该文件、线上 TLS 未受影响，下一条命令即恢复；但顺序必须是「签发成功后才 install」，
且 install 后务必 `openssl x509 ... -ext subjectAltName` 自检。

**验证子域时不要信本机 curl**：本机在 Clash 后，连源站 IP 也会被劫到 Cloudflare 边缘
（会看到一张 `*.clawhunt.store` 通配符证书的幻觉）。要看源站真实证书，从主机内部探
`openssl s_client -connect 127.0.0.1:443 -servername <子域>`。另：Cloudflare 对裸 curl
（无浏览器 UA）一律 **403**，带真实 UA 才能测通。

## 图像 adapter（imagegen_local，热插不改镜像）

`packages/superclaw-adapter-imagegen` 构建产物（dist + package.json）放持久卷
`/data/adapters/superclaw-adapter-imagegen`，写
`/data/node-runtime/adapter-plugins.json`（顶层 JSON 数组）：

```json
[{ "packageName": "superclaw-adapter-imagegen",
   "localPath": "/data/adapters/superclaw-adapter-imagegen",
   "type": "imagegen_local", "installedAt": "<ISO>" }]
```

`docker restart superclaw-canvas` 后日志应见
`Loaded external adapters from plugin store {"adapters":["imagegen_local"]}`，
`/api/agents` 契约即含 imagegen_local（模型下拉 gemini-2.5-flash-image，effort 隐藏，
个人 chat composer 按设计排除）。**真跑生图需要 GEMINI_API_KEY 以 company secret
绑定到 agent env**（fail-closed：不绑不派发）。脚本源 `s3://…/install-adapter.sh`。

## 安全态势（如实，与 Cloud Run 先例一致）

- 应用为 `local_trusted` 模式：**无内建鉴权**，能达 :8085/域名者即 instance_admin，
  可雇 agent、派发运行（消耗 relay key）。Cloud Run 时代业主明确选择公开运行；
  AWS 上等价敞口 = Cloudflare 记录指过来后即公开。若要收口：CF Access / IP 白名单 /
  `SUPERCLAW_CONTROL_TOKEN`（只关 Python 路由的 fail-open，非完整门）。
- 密钥只在 SSM ↔ 容器 env 流转；日志/镜像/脚本均不含值。

## 上线状态（2026-08-26 验证）

`https://canvas.clawhunt.store` **已上线**（Cloudflare A→16.58.241.212 Proxied，业主已加）：
SPA 200、`/health` 200、`/paperclip-api/health` 200、浏览器侧 `/api/agents` 16 个 runtime
含 `imagegen_local`；右键加图像节点 → 配置面板 Runtime 下拉可选 imagegen_local → 模型输入框
出现（填 RunningHub 工作流 ID）、思考强度按契约隐藏。全 7 域回归：clawhunt 200 / www 301 /
embed 200 / payswitch 200 / staging 302 / canvas 200 / superclaw 200。

顺带修复：`superclaw.clawhunt.store` 此前一直 526（原证书 SAN 从未包含它，与本次部署无关），
已在同次重签中加入 SAN 并恢复 200。

### 端到端真实执行验证（2026-08-26，生产 + 真 Agent）

在线上完整跑通一条工作流，**M2 执行引擎对活 gateway 的最后一块验证补齐**：

1. 画布双击空白建公司 → 控制面真实创建（世界从「暂无公司」变 1 张卡）
2. 右键加「表单输入」节点，填任务字段 → 右键加「编码 Agent」节点
3. 配置面板：Runtime 下拉选 `claude_local` → 点「绑定并创建真实 Agent」
   → **真实雇佣成功（idle）且人设写入 AGENTS.md**（hire + persona sync 两条路径都验证）
4. 连线 form.data → agent.context（typed 边 dataType=text 持久化正确）
5. 点「运行工作流」→ **2/2 节点成功**：表单 0:00、编码 Agent **0:28 真实 worker 运行**
6. 输出面板显示 Agent 真实回复，内容明确引用上游节点标题「验证任务」并照其要求作答
   → **上游输出注入下游前置输入这条链在生产环境成立**
7. 打开该节点聊天窗 → 恢复出本次运行的真实对话历史
   → **「运行与聊天共用一条持久线程」成立**
8. 清理：DELETE 该公司（200 ok），世界回到 0 —— 不留测试垃圾

已知上游行为（非本次改动引入）：工作流运行结束后，vendored server 的 issue 处置流程会
继续追问 disposition（聊天线程里可见），不影响节点状态与输出捕获。

### Session 画布重构上线（2026-08-27，tag `sessioncanvas`）

业主拍板「删掉所有原本的底层内容，从头重构，全部取代」后，画布由融合画布（fleet 公司世界 +
creative 节点世界）整体换成 **session 画布**：每个节点就是一个 agent 会话，聊天窗开在瓦片
里，上游输出即下游前置输入。部署走上面同一条流程，只有 tag 不同：

```bash
git archive --format=tar.gz -o /tmp/src.tar.gz HEAD
aws s3 cp /tmp/src.tar.gz s3://clawhunt-data-563688183799/deploy/superclaw-canvas/src-sessioncanvas.tar.gz --profile clawhunt --region us-east-2
# app-1 = i-08b823f76bd4a44ae（**不是** governance-runner；用错 id 会报 InvalidInstanceId）
# docker build -t clawhunt-superclaw-canvas:sessioncanvas .（nohup + build.log 轮询，约 25 分钟）
```

同批清除的死代码：`apps/web/src/studio/`、三个宿主对话框、`apps/fleet-canvas` 整包、38 个过时
测试。**`apps/creative-canvas` 保留** —— myshell orchestrator 仍 import 它的 embed 并在 CI 构建，
删它会打断另一条产品线。根 `Dockerfile` 相应去掉两条 sibling embed 的 `COPY`。

### Session 画布端到端真实验证（2026-08-27，生产 + 真 Agent）

在 `https://canvas.clawhunt.store` 上把新引擎完整跑通一遍：

1. `POST /paperclip-api/companies` 建临时公司 → 201
2. 画布上表单节点 + LLM 会话节点，连线 `form.data → llm.context`（typed 边持久化正确）
3. 节点「配置」→ Runtime 下拉列出 16 个契约 runtime（含 `imagegen_local`）→ 选 `claude_local`
   → **思考强度下拉按契约自动出现**（claude_local 的 `supports_effort_selection=true`），
   模型栏显示「默认模型」占位，未选 runtime 时显示「选择 Runtime…」
4. 「绑定并创建真实 Agent」→ **真实雇佣成功（idle）+ 人设写入 AGENTS.md**，`bindAttempt` 为 null
5. 「运行图」→ **2/2 节点成功**；运行中**所有端口 disabled**（运行锁覆盖连线，本次新增）
6. Agent 真实输出：「验证通过：workflow 画布是一块可视化编排区，把任务节点用连线串成自动
   执行的流程。」—— **它遵守了上游表单里的约束**（"必须以「验证通过：」四个字开头"），
   证明表单输出确实作为前置条件注入下游并被执行
7. 刷新页面 → 瓦片**恢复出真实历史对话**（本次修复的 `restoreHistory` 接线），
   `node.preview` 已写入
8. `DELETE` 该公司 → 200 `{"ok":true}`，**547ms 返回**（无 PGlite 卡死），世界归零、
   控制面仍 200 —— 不留测试垃圾

中途踩到的两件事都已修并记录：运行首次失败是 gateway 503（见下方事故），
以及浏览器拿到 Cloudflare 边缘缓存的旧 `index.html` —— **验证新版必须带 cache-bust 查询参数**，
或直接在源站容器里 `curl` 出 `/assets/index-*.js` grep 特征字符串确认版本。

### 2026-08-27 事故：陈旧 gateway marker 让整条 chat/run 通道 503

**症状**：`/paperclip-api/*` 全正常，但 `/gateway-api/*` 一律 503 `node_unavailable`；画布能建节点、能绑 agent，一运行就「出错：gateway responded 503」。

**根因**：`/data/run/gateway-marker.json` 在**持久卷**上，会活过写它的那个容器。新容器里那个 pid 属于别的进程（PID 命名空间从 1 重新开始），网关判定「有进程活着但认不出」→ 拒绝启动并保留 marker → 永远起不来。前门看到 marker 就去代理，连不上就 503。marker 日期是 8/26，之后每次重启都自锁。

**定位手法**（下次照做）：
```bash
docker exec superclaw-canvas sh -lc 'ps aux | grep -E "gateway|node"'   # 网关进程是 <defunct> 僵尸
docker exec superclaw-canvas sh -lc 'cat /data/run/gateway.log'          # "a prior process is alive but unidentifiable"
docker exec superclaw-canvas sh -lc 'cat /data/run/gateway-marker.json'  # pid/startSignature 是上一个容器的
```

**应急**：删 marker + 重启容器（marker 先备份成 `gateway-marker.stale-<date>.json` 留证）。
**根治**：已改 `apps/gateway/src/index.ts` —— identity 未知时不再直接拒绝，而是**先尝试绑定端口**（端口才是真裁判：真是我们的网关就还占着端口）；只有真 `EADDRINUSE` 才保留 marker 并延后。

**验证 `/gateway-api` 是否活着**（比 `/health` 更能区分两级）：
```bash
curl -s http://127.0.0.1:8085/gateway-api/health   # 503 node_unavailable = 网关没起来
```

## 已知未竟
- 旧 Cloud Run 服务仍在（superclaw-canvas @ us-central1）；确认 AWS 稳定后可停。
- Cloud SQL 里的旧画布数据未迁移（AWS 侧全新世界）；需要时 pg_dump → RDS。
- PGlite 单连接仍是控制面的单点：一条卡住的事务能锁死整个 `/companies`（已在生产踩过一次，
  靠改名 `db-pglite` 目录 + 重启恢复）。要真稳，得换 RDS Postgres。
