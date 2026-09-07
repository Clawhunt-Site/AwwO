# AwwO SaaS 本地验收记录

日期：2026-09-07（Asia/Shanghai）。范围：现有画布 + Go/PostgreSQL 多租户 API + Pi 内部执行服务的本地基础版本。

## 基线与工作区

- Forgejo：`https://git.clawhunt.store/ClawHunt-Store/AwwO.git`。
- 原始仓库：`/Users/leongong/Desktop/LeonProject/awwo`。
- 实施 worktree：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-saas-20260907`。
- 分支：`feat/awwo-go-pi-saas`，基线 `6e1dc158a79e2f18c7bdf82610a353883b883f31`，已发布版本仍为 `0.3.0`。
- 本报告验证的是该 worktree 的 SaaS 实现；验证后按 Pi、Go API、Web、运行工具及文档划分本地原子提交，最终 SHA 以该分支 Git 记录为准。这不是新的发布版本。没有执行 Git 合并、推送或公网部署。

## 已通过

| 验证入口 | 观察到的结果 |
| --- | --- |
| `npm run setup:saas` | 两份 lockfile 的 clean install、Go 模块下载/API 编译、SaaS Web 生产构建均成功。两份 npm 安装审计当时均为 0 vulnerabilities；不等同完整安全审计。 |
| `npm run dev:saas` | Go、Pi、Vite 实际启动，复用本项目专属 PostgreSQL；Pi 未配置时仍可使用账户与画布，并明确报告 unconfigured。 |
| `npm run test:saas:scripts` | 3 项通过，0 skip：dotenv 按文本解析、端口校验、允许 Pi 明确未配置但拒绝其他不可用状态。 |
| `npm run check && npm test`（`apps/pi-worker`） | 18 项通过，0 skip：真实 SDK 与 OpenAI/Anthropic/Ollama 本地协议 fixture、history、认证、无模型配置、禁用工具/扩展、取消/超时/断连/进程目录清理、同会话连续多轮无重叠。 |
| `npm run test:saas:backend` | 13 组 Go 测试通过，另含 5 个准入子 case，其中 5 组使用真实 PostgreSQL；race、vet 通过，0 skip。覆盖越权、角色、CAS、幂等并发、SSE、取消、暂停、恢复、规划、错误/授权撤销、上下文预算及安全准入等待。 |
| `npm run test:saas:stack` | 1 组完整真实进程测试通过，0 skip：HTTP → Go binary → Pi HTTP → 真实 Pi SDK/子进程 → 本地 OpenAI 协议 fixture → PostgreSQL 持久 SSE；包括连续对话历史、幂等、取消后立即同会话执行、合法/非法规划及 API 重启读回。 |
| `npm run test:saas:smoke` | 对正在运行的 Go/Pg 服务实测注册/登录、跨租户 404、普通用户管理端 403、reader 写入 403、陈旧画布 409、错误 Origin 403、暂停/恢复、logout 后 cookie 失效。未执行模型推理。 |
| `npm run typecheck:saas --prefix apps/web` | TypeScript 检查通过。 |
| `npm run test:saas --prefix apps/web` | 4 文件 23 项通过，包含持久草稿新增回归；与相关原画布测试一并运行时为 20 文件 249 项通过（不是相加的 272 项）。 |
| `npm run build:saas` | 独立 SaaS 构建通过；存在约 664 KB JS 主包的体积提示，尚未做按路由拆包。 |
| Compose `config --quiet` | 使用 `.env.example` 的配置解析通过，未因此认定镜像已构建或容器已运行。 |
| 独立 GPT-5.5 只读审查与复审 | 首轮定位草稿 reload 丢失问题；修复后复审草稿恢复、Pi 终态释放、Go 准入等待三条边界，明确结论为“未发现新的 P1/P2 阻断项”，先前 P1 已关闭。审查未自行复跑测试，测试结果来自上表的实际命令。 |
| 独立 Gemini 3.1 Pro High 源码审查 | 通过 agy 提供 23 份核心源码与架构文本，以不执行工具的方式独立审查租户隔离、权限、并发、草稿及 Pi 生命周期，明确结论为“直接通过”，未指出阻断项。这是静态审查，不替代运行验收或安全审计。 |

本轮修复并复验：Pi 终态早于子进程清理导致连续对话偶发失败；取消后立即重跑撞上清理窗口；CAS/网络失败后的未同步草稿在 reload 时丢失。Pi 自然终态先清理再发布，Go 仅等待明确未受理的 SESSION_BUSY，草稿按用户/租户/画布/编辑页面分别持久保留且精确确认保存 revision。

完整相关前端回归命令（cwd `apps/web`）：

```sh
npx vitest run --config vitest.saas.config.mjs tests/saas- tests/canvas-agent-chat.test.ts tests/canvas-hire.test.ts tests/canvas-runtime-reader.test.ts tests/canvas-core.test.ts tests/canvas-sessions.test.ts tests/canvas-run.test.ts tests/canvas-run-recovery.test.ts tests/canvas-stop-recovery-regressions.test.ts tests/canvas-recovery-document.test.ts tests/canvas-thread-persistence.test.tsx tests/awwo-workspace.test.tsx tests/canvas-planning-client.test.ts tests/canvas-plan.test.ts tests/canvas-planning-integration.test.tsx tests/canvas-assistant.test.tsx tests/canvas-run-ownership.test.ts
```

## 浏览器实测

实际入口 `http://127.0.0.1:5189/`。使用本次创建的本地验收账户和工作区，无生产用户数据。

1. 注册“本地验收用户 / 本地验收团队”，创建“Go + Pi 验收画布”。
2. 使用现有产品研发模板建立 5 节点、5 连线画布；显示“已同步”，刷新后结构仍在，后端节点工作台可打开。
3. 通过工作区成员面板添加实际注册用户为 reader，重新登录该用户后，只能查看节点、依赖和历史、导出 JSON，没有编辑/运行入口；切换其自建工作区后恢复 owner 的新建/成员管理权限。底层成员增删与 reader 写入拒绝另由实际 API smoke 验证。
4. 普通用户直接访问 `/admin` 显示无平台管理权限。管理员没有租户时仍有管理入口和退出入口。
5. 平台管理的租户、用户、运行、审计页面均加载；运行列表为空时显示真实空状态。暂停并恢复本次自建团队，状态与审计记录一致。
6. 用户画布及管理员页面检查到的浏览器 error/warn 日志为空。

## 尚未通过或未执行的范围

- **真实模型账号调用：未执行。** 开发环境没有指定 provider/model/API key；实际 Pi SDK 的测试使用本地协议 fixture。`ready` 只说明服务端配置齐备，不证明账号、余额、模型可用或任务交付质量。
- **历史默认前端全量入口：环境阻塞。** `npm test --prefix apps/web` 在加载历史 `vitest.config.mjs` 时失败：`Cannot find module '@mdxeditor/editor/style.css'`，来自未安装的 `server/ui` 继承工作区。独立 SaaS 安装不安装该历史运行时。复用画布的相关测试使用独立 SaaS 配置执行，不把历史默认全量测试计为通过。
- **容器运行：环境阻塞。** Docker Compose CLI 可用，Docker daemon 的版本探测超时；未启动或重启系统 Docker 服务。镜像构建、容器健康、HTTPS 入口及公网部署未验证。
- **历史 Python/桌面/其他继承应用：本次未执行。** 未用系统 Python 冒充项目运行时，也没有把旧模块的静态存在作为 SaaS 验收证据。

## 双顾问验收记录

仓库 `CLAUDE.md:140–159` 的双顾问提交门已满足：GPT-5.5 最终复审无 P1/P2 阻断项，Gemini 独立源码审查明确通过。原始记录保存在本地被 Git 忽略的 `.local/awwo-saas/codex-review-final.txt`、`.local/awwo-saas/gemini-source-review.log` 和 `.agy-advisor/logs/20260907T000720Z-awwo-saas-source-review.*`。

Gemini 首轮直连和代理重试均超时，随后无交互源码读取因 command 工具权限被拒绝。最终将所需源码直接作为文本输入，未修改顾问或系统权限，成功取得独立结论。只记录最终有效结果为通过。

顾问用语不扩展产品保证：operationId 提供的是持久化运行去重，不保证外部服务副作用的全局 exactly-once；Pi 子进程及 SDK 资源限制不等同于操作系统安全沙箱。租户隔离的已验证范围和剩余部署边界仍以本报告及架构文档为准。

## 能力边界

当前支持单个 Go API 实例；PostgreSQL 锁避免两个实例同时接管任务。已有运行可在浏览器离开后完成，未派发的下游节点仍由浏览器图调度器管理。工程文件执行、通用 shell 工具、对象存储、支付、邮箱验证/找回、OIDC、多副本调度以及生产恢复演练均属于后续实施范围，见 [架构设计](awwo-saas-architecture.md)。

运行时版本：Node `26.3.0`、npm `11.16.0`、项目 Go 工具链 `1.27.1`、PostgreSQL `18.4`、Pi SDK `0.85.1`。本机全局 Go `1.22.1` 通过 go.mod 的自动工具链使用项目版本；没有替换系统 Go。
