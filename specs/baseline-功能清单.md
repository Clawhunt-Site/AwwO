# SuperClaw 网页版 —— Docker 基线功能清单

> 对应任务：`specs/updatePRDv1-PLAN.md` Task 0.4
> 分支：`main`（纯 Python 旧架构，chat 不含 Paperclip Node）
> 验证环境：Docker Desktop 29.4.1 / 镜像 `superclaw-superclaw-api`（236MB）/ 容器监听 8080
> 日期：2026-06-28 | 验证方式：curl 探活 + OpenAPI schema 走查（无图形浏览器，按 HTTP 状态判定）

---

## 一、总体结论

| 维度 | 结果 |
|---|---|
| 容器启动 | ✅ Running，无 Windows 崩溃点（`os.getuid()`/`fcntl`）在 Linux 容器内触发 |
| 健康检查 | ✅ `GET /health` → `{"ok":true,"service":"superclaw"}` |
| 前端加载 | ✅ `GET /` 200，标题 `SuperClaw Workbench`，含 `#root` + JS bundle（`/assets/index-*.js` 200, `text/javascript`） |
| API 面 | ✅ 268 条路由，核心 GET 面几乎全部 200 |
| 真聊天答案 | ⚠️ 不可用 —— 无 relay key（`RELAY_LOGIN_REQUIRED`），符合 PRD 预期 |
| ClawHunt 绑定 | ⚠️ 未登录（`auth.clawhunt: unset`），相关功能受限 |

**一句话**：Docker 基线**跑通**——容器活、前端开、API 链路通；唯独"出真答案"和"ClawHunt 身份态"因缺凭据未验证（这是预期内的外部依赖，非基线缺陷）。

---

## 二、功能模块清单

| 功能模块 | 端点（示例） | 状态 | 备注 |
|---|---|---|---|
| 健康检查 | `GET /health` | ✅ 可用 | `{"ok":true,"service":"superclaw"}` |
| 前端工作台 | `GET /` | ✅ 可用 | React/Vite 工作台，标题 SuperClaw Workbench |
| 运行时状态 | `GET /api/runtime/status` | ✅ 可用 | `backend=claude, mode=auto`；`repo=/app, state=/data/superclaw.db` |
| 后端/Agent 清单 | `GET /api/backends`、`/api/agents` | ✅ 可用 | `local`（内置 Python 3.12）可用；其余按凭据决定 |
| 工作区 Workspace | `GET /api/workspaces` | ✅ 可用 | 默认 1 个 managed workspace `Chat`，trusted |
| 聊天 Chat | `POST /api/chat`（9 子路由） | ⚠️ 链路在/答案缺 | GET 探测返回 405（POST 端点，正常）；真答案需 relay key |
| 团队工作台 Team | `/api/team/*`（55 路由：agents/issues 等） | ✅ 可用 | `agents=[]`、`issues=[]`（空数据，结构正常） |
| 治理审批 Governance | `GET /api/governance/approvals` | ✅ 可用 | `pending_count=0`，人审门面在 |
| 运行 Runs | `GET /api/runs`（15 路由） | ✅ 可用 | `runs=[]` 空列表 |
| 目标 Goals | `GET /api/goals`（10 路由） | ✅ 可用 | `goals=[]` 空列表 |
| 能力工坊 Capabilities | `GET /api/capabilities`（4 路由） | ✅ 可用 | 注册表 **245 项**（engineering 73 / media 27 / platform 23 …） |
| 技能 Skills | `GET /v1/skills` | ✅ 可用 | `skills=[]`、`conflicts=[]`（无已装技能） |
| 设置 Settings | `/api/instance-settings`、`/api/config` | ✅ 可用 | general/experimental 配置面正常返回 |
| 密钥 Secrets | `GET /api/secrets` | ✅ 可用 | `secrets=[]` |
| 成本 Cost | `GET /api/cost/events` | ✅ 可用 | `events=[]` |
| 引导 Onboarding | `GET /api/onboarding` | ✅ 可用 | `completed=false` |
| Pay-Switch 治理 | `GET /api/pay-switch/config` | ✅ 可用 | `mode=governed_optional`，未配置支付（fail-closed 默认） |
| Relay 套餐 | `GET /api/relay/packages` | ✅ 可用 | core/plus/… 套餐清单可读 |
| Relay 余额/key | `GET /api/relay/balance` | ❌ 不可用 | `RELAY_LOGIN_REQUIRED`：未检测到 relay key |
| ClawHunt 鉴权 | `GET /api/auth/status`（11 路由） | ⚠️ 未登录 | `auth.clawhunt=unset` |
| 插件 Plugins | `/api/plugins/*`（23 子路由） | ✅ 可用 | 裸 `GET /api/plugins` 404（无该聚合路径），子路由在 |
| 媒体/融合/评测等 | `/api/media`、`/api/fusion`、`/api/evals` 等 | 〇 未逐一验证 | 路由已注册；依赖外部服务（fusion 三件套未起）的功能需后续验证 |

> 图例：✅ 可用 ｜ ⚠️ 链路在但功能受外部凭据限制 ｜ ❌ 不可用 ｜ 〇 已注册未逐一走查

---

## 三、关键发现

1. **核心引擎在 Linux 容器里完全正常**：PRD 担心的 Windows 内核崩溃点（`os.getuid()`/`fcntl`）在容器内不触发，uvicorn 启动干净（`Application startup complete`）。
2. **chat 是否"能发消息"**：`/api/chat` 端点存在（POST，9 条子路由），链路在线；但**无 relay key 时跑不出真答案**（`RELAY_LOGIN_REQUIRED`）——与 PRD「main 旧架构 + 无 key」的预期一致。
3. **哪些功能依赖外部服务**：
   - **真答案** → 依赖 relay key（中转站凭据）。
   - **ClawHunt 绑定态**（账户/计费/在线就绪）→ 依赖 `superclaw clawhunt account-login`。
   - **Fusion 媒体三件套**（osiris/open-design/openpencil，端口 3000/3001/3002）→ 本次只起了 `--profile superclaw` 主服务，未起 fusion；`/api/fusion/*` 相关功能未验证。
4. **空数据 ≠ 报错**：runs/goals/team agents/issues/skills 均为空列表，属全新实例的正常初始态，结构与契约正常。

---

## 四、未验证项（受限于无图形浏览器 / 无凭据）

- 前端各页面的**点击式交互**（Console 报错、按钮行为、SSE 流式渲染卡片）——需真实浏览器走查。
- chat 端到端**真聊天 / 真切模型 / 真绑 workspace** —— 需 relay key（属阶段 1 Task 1.4/1.5）。
- Fusion 媒体生成链路 —— 需起 fusion 三件套（`--profile all`）。

---

## 五、复现命令

```bash
cd c:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/SuperClaw
docker compose --profile superclaw build
docker compose --profile superclaw up -d
curl http://localhost:8080/health          # {"ok":true,"service":"superclaw"}
# 浏览器打开 http://localhost:8080 → SuperClaw Workbench
docker compose --profile superclaw down     # 收尾
```
