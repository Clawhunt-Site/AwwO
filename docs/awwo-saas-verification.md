# AwwO SaaS 本地验收记录

> 本文保留初轮实施的历史结果。用户随后要求全面验收，补跑默认 Web、Gateway 并修复六类问题；最终结果以 [2026-09-07 全面验收报告](awwo-saas-acceptance-20260907.md) 为准，不将下表旧数量当作最新数量。

日期：2026-09-07（Asia/Shanghai）。范围：现有画布 + Go/PostgreSQL 多租户 API + Pi 内部执行服务的本地基础版本。

## 基线与工作区

- Forgejo：`https://git.clawhunt.store/ClawHunt-Store/AwwO.git`。
- 原始仓库：`/Users/leongong/Desktop/LeonProject/awwo`。
- 实施 worktree：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-saas-20260907`。
- 本地实施分支：`feat/awwo-go-pi-saas`，基线 `6e1dc158a79e2f18c7bdf82610a353883b883f31`，此工作树 `VERSION` 为 `0.3.0`；最终 fetch 发现远端已到 `0.3.1`，见下方同步门禁。
- 本报告验证的是该 worktree 的 SaaS 实现；验证后按 Pi、Go API、Web、运行工具及文档划分本地原子提交，最终 SHA 以该分支 Git 记录为准。这不是新的发布版本。没有执行 Git 合并、推送或公网部署。

## 已通过

| 验证入口 | 观察到的结果 |
| --- | --- |
| `npm run setup:saas` | 两份 lockfile 的 clean install、Go 模块下载/API 编译、SaaS Web 生产构建均成功。两份 npm 安装审计当时均为 0 vulnerabilities；不等同完整安全审计。 |
| `npm run dev:saas` | Go、Pi、Vite 实际启动，复用本项目专属 PostgreSQL；Pi 未配置时仍可使用账户与画布，并明确报告 unconfigured。 |
| `npm run test:saas:scripts` | 3 项通过，0 skip：dotenv 按文本解析、端口校验、允许 Pi 明确未配置但拒绝其他不可用状态。 |
| `npm run check && npm test`（`apps/pi-worker`） | 18 项通过，0 skip：真实 SDK 与 OpenAI/Anthropic/Ollama 本地协议 fixture、history、认证、无模型配置、禁用工具/扩展、取消/超时/断连/进程目录清理、同会话连续多轮无重叠。 |
| `npm run test:saas:backend` | 最新 18 项顶层 Go 测试、5 个准入子 case 通过，包含真实 PostgreSQL；race、vet 通过，0 skip。新增资料更新、邀请权限/过期/撤销/并发单次领取、游标签名/跨管理员/重启失效、同时间戳分页、额度和已应用旧 003 的迁移 004 兼容检查。原有租户、CAS、幂等、SSE、取消、恢复和准入检查仍通过。 |
| `npm run test:saas:stack` | 1 组完整真实进程测试通过，0 skip：HTTP → Go binary → Pi HTTP → 真实 Pi SDK/子进程 → 本地 OpenAI 协议 fixture → PostgreSQL 持久 SSE；包括连续对话历史、幂等、取消后立即同会话执行、合法/非法规划及 API 重启读回。 |
| `npm run test:saas:smoke` | 对正在运行的 Go/Pg 服务实测注册/登录、资料保存与读回、邀请创建/预览/领取/重复领取/撤销、分页/额度、跨租户 404、普通用户管理端 403、reader 写入 403、陈旧画布 409、错误 Origin 403、暂停/恢复、logout 后 cookie 失效。未执行模型推理。 |
| `npm run typecheck:saas --prefix apps/web` | TypeScript 检查通过。 |
| 下方 SaaS + 原画布/账户回归命令 | 最新 57 文件、552 项通过，0 skip。包含只读画布及滞留回调边界、资料/邀请/偏好、管理额度/分页/完整导出和失败取消、真实 Runtime 设置入口，以及现有画布执行/恢复/规划/草稿。不是历史默认配置的整个仓库全量测试。 |
| `npm run build:saas` | 独立 SaaS 构建通过；JS 主包 710.58 KB（gzip 222.05 KB）、CSS 256.18 KB，存在大于 500 KB 提示，尚未做按路由拆包。 |
| `node scripts/awwo-saas-browser-fixture.mjs --self-test` | 纯检查通过；输出字段类型、规划结构、历史/人格摘要和凭据字段排除。实际启动与浏览器结果见下文。 |
| Compose `config --quiet` | 使用 `.env.example` 的配置解析通过，未因此认定镜像已构建或容器已运行。 |
| 独立 GPT-5.5 只读审查与复审 | 首轮定位草稿 reload 丢失问题；修复后复审草稿恢复、Pi 终态释放、Go 准入等待三条边界，明确结论为“未发现新的 P1/P2 阻断项”，先前 P1 已关闭。审查未自行复跑测试，测试结果来自上表的实际命令。 |
| 独立 Gemini 3.1 Pro High 源码审查 | 通过 agy 提供 23 份核心源码与架构文本，以不执行工具的方式独立审查租户隔离、权限、并发、草稿及 Pi 生命周期，明确结论为“直接通过”，未指出阻断项。这是静态审查，不替代运行验收或安全审计。 |

本轮修复并复验：Pi 终态早于子进程清理导致连续对话偶发失败；取消后立即重跑撞上清理窗口；CAS/网络失败后的未同步草稿在 reload 时丢失。Pi 自然终态先清理再发布，Go 仅等待明确未受理的 SESSION_BUSY，草稿按用户/租户/画布/编辑页面分别持久保留且精确确认保存 revision。

追加复审修复：保留已保存的画布视口，仍支持初始适应与显式适应；空成员角色显示未设置并可直接分配有效角色。新增组件测试确认创建、模板及旧数据缺失 preview 时，首条回复均会持久预览，无需修改预览逻辑。

最终前端回归曾出现 1 次草稿测试等待首个 PUT 失败；原样重跑未复现，不能认定唯一根因。测试现改为等待真实保存回调注册并调用原实现，以确定性验证请求未决期间的 revision 确认顺序；没有改生产保存逻辑或放宽断言。修后单文件连续 3 次各 7 项通过，完整 57 文件、552 项通过。

完整相关前端回归命令（cwd `apps/web`）：

```sh
npx vitest run --config vitest.saas.config.mjs tests/saas- tests/canvas- tests/awwo-workspace.test.tsx tests/account-workspace.test.tsx
```

## 浏览器实测

实际入口 `http://127.0.0.1:5189/`。使用本次创建的本地验收账户和工作区，无生产用户数据。

1. 注册“本地验收用户 / 本地验收团队”，创建“Go + Pi 验收画布”。
2. 使用现有产品研发模板建立 5 节点、5 连线画布；显示“已同步”，刷新后结构仍在，后端节点工作台可打开。
3. 通过工作区成员面板添加实际注册用户为 reader，重新登录该用户后，只能查看节点、依赖和历史、导出 JSON，没有编辑/运行入口；切换其自建工作区后恢复 owner 的新建/成员管理权限。底层成员增删与 reader 写入拒绝另由实际 API smoke 验证。
4. 普通用户直接访问 `/admin` 显示无平台管理权限。管理员没有租户时仍有管理入口和退出入口。
5. 平台管理的租户、用户、运行、审计页面均加载；运行列表为空时显示真实空状态。暂停并恢复本次自建团队，状态与审计记录一致。
6. 用户画布及管理员页面检查到的浏览器 error/warn 日志为空。

本轮追加验收（同一日期，原界面已完成对接）：

1. 在原 `CanvasAccountControl / AccountWorkspacePanel` 保存显示名，顶部立即更新，刷新后保持；创建只读邀请，复制按钮确认成功。
2. 邀请保留经过退出、注册和登录流程；新账号明确确认后加入原团队，实际角色为 reader。只读画布仍使用同一 `CanvasSurface`，可打开节点工作台、输入配置与历史，添加、运行、发送、绑定、保存、拖拽/快捷键写入被禁用。
3. 切换英文与浅色并刷新，`lang=en`、主题及显示名保持；深色画布、账户和管理页可读。工作区设置读取服务端 Pi 健康与模型清单，未配置时显示原因，不提供虚假的客户端密钥保存。
4. 原画布手动放大至 126%，显示已同步后刷新，重新打开仍为 126%；另有组件测试覆盖首次布局、显式适应画布及旧数据预览。
5. 管理员把本次验收租户配额改为并发 4、日运行 150，保存与刷新读回一致，审计出现 `tenant.updated`。审计列表翻至第二页；实际下载 JSON 含 69 条记录、69 个唯一 ID，与 `count` 一致。该数字是当次数据量，不是未来固定值。

### 浏览器到 Pi SDK 的协议执行

通过 `node scripts/awwo-saas-browser-fixture.mjs --start` 启动独立临时 schema 与动态端口。实际浏览器入口为 `http://127.0.0.1:63221`，Go/Pi/提供方端口分别为 63219/63220/63222；这些端口只属于本次运行，重启后会改变。正常开发服务与模型配置未被替换。

- 原画布“生成画布”经 Go → Pi SDK → 本地 OpenAI 协议 fixture 返回合法规划，前端校验后直接应用 2 个节点和 1 条连接，并提供撤销。
- 在原节点配置中选择 Pi 和 `awwo-protocol-fixture`，绑定 A/B 并保存人格。提供方请求中分别收到 `PROTOCOL_FIXTURE_PERSONA_A/B` 系统指令。
- 点击“运行图”，浏览器显示 `2/2 节点成功`；A 完成后才发起 B，B 的请求包含 A 的 `result` 内容。
- 在新 Session 连续发送 first-turn、second-turn；第二轮提供方收到 `system,user,assistant,user`，UI 显示已带入一对历史。刷新后各轮消息仍可读取。
- 发送 `[fixture:slow]`，在运行中刷新，UI 显示“已恢复运行结果”；该轮只有一个提供方请求，没有重复派发。
- 发送 `[fixture:hold]` 后点击停止，UI 确认已取消；在原 Session 立即继续成功，取消轮的部分输出没有冒充已完成历史。记录共 8 个唯一请求、7 个完成、1 个取消连接。
- 原账号面板创建 reader 邀请，另一个新账号确认加入后打开同一画布，实际看到 Session 1/2 和 first-turn、after-cancel 历史；新建 Session、发送、运行均禁用，底部显示“云端画布 · 只读”。
- 此次原始协议摘要保存于被 Git 忽略的 `.local/awwo-saas/browser-protocol-evidence.json`，仅有专用验收文本和摘要，不含密钥。浏览器 error/warn 为零。
- 验收后按 SIGTERM 停止本实例，进程正常退出；实查临时 schema 数为 0、临时目录已移除，摘要保留。正常开发环境重新启动并应用当前迁移，继续使用 5189/8087/8097。

以上使用真实 Go binary、PostgreSQL、Pi SDK 和浏览器界面；提供方为确定性本地协议 fixture，`externalInference=false`。不据此宣称真实模型质量、工程文件生成或公网可用。

## 尚未通过或未执行的范围

- **最新 Forgejo 前端同步：等待本次精确合并授权。** 收尾时 `git fetch origin main` 成功，远端主干变为 `fc5cbda9e4028837009369471ec2d54b94a985a5`（`feat(awwo): release reliable Codex sessions and private deployment`，82 个文件）。上表测试针对当前 SaaS 工作树，没有吸收该新增提交，不能作为最新主干整合后的测试结果。原主仓库本地 `main` 仍为 `6e1dc158a79e2f18c7bdf82610a353883b883f31` 且干净。
- **真实模型账号调用：未执行。** 开发环境没有指定 provider/model/API key；实际 Pi SDK 的测试使用本地协议 fixture。`ready` 只说明服务端配置齐备，不证明账号、余额、模型可用或任务交付质量。
- **历史默认前端全量入口：初轮阻塞，后续已解除。** 初轮缺少 `@mdxeditor/editor/style.css`。全面验收时按既有 lockfile 从本地缓存补齐 UI 依赖，默认 91 文件/1003 项及静态检查、原 Web 构建均通过；详见上方全面验收报告。
- **容器运行：环境阻塞。** Docker Compose CLI 可用，Docker daemon 的版本探测超时；未启动或重启系统 Docker 服务。镜像构建、容器健康、HTTPS 入口及公网部署未验证。
- **历史 Python/桌面/其他继承应用：本次未执行。** 未用系统 Python 冒充项目运行时，也没有把旧模块的静态存在作为 SaaS 验收证据。

远端与整个 SaaS 增量存在 14 个同改文件：`CHANGELOG.md`、`apps/web/package-lock.json`、`apps/web/package.json`、`apps/web/src/canvas/CanvasSurface.tsx`、`SessionTile.tsx`、`i18n.tsx`、`runRecoveryDocument.ts`、`runTransport.ts`、`sessionTransport.ts`、`apps/web/src/canvasAgentChat.ts`、`canvasHire.ts`、`canvasRuntimeReader.ts`、根 `creator.md` 和 `package.json`。这是静态重叠检查，未执行合并，不等同 Git 已确认的冲突清单。会话恢复、消息呈现和 Runtime 目录需重点整合并重新验证。

最新远端 `AGENTS.md` / `CLAUDE.md` / `docs/awwo-repository.md` 还记录了仅保留 `main`、`online` 的新拓扑。现有本地实施分支是在获知该变更前按旧快照创建，当前保留已验证成果，不发布此功能分支、不新建额外分支。后续按最新规则使用隔离 detached 工作区，并在精确合并授权后整合；不借同步之名覆盖主干或删除未整合工作。

## 双顾问验收记录

初版基础提交的仓库 `CLAUDE.md:140–159` 双顾问提交门记录：GPT-5.5 最终复审无 P1/P2 阻断项，Gemini 独立源码审查明确通过。原始记录保存在本地被 Git 忽略的 `.local/awwo-saas/codex-review-final.txt`、`.local/awwo-saas/gemini-source-review.log` 和 `.agy-advisor/logs/20260907T000720Z-awwo-saas-source-review.*`。

Gemini 首轮直连和代理重试均超时，随后无交互源码读取因 command 工具权限被拒绝。最终将所需源码直接作为文本输入，未修改顾问或系统权限，成功取得独立结论。只记录最终有效结果为通过。

本次原界面完整对接的新增审查：53 文件源码简报中，GPT-5.5 明确通过；Gemini 指出视口、空角色及预览三项。前两项已修复并新增回归；预览问题根据工厂、规范化与实际组件测试证据撤销。最后两路重新独立复审，均明确给出 `PASS: no blocking findings`，提交门已满足。

本轮记录：`.local/awwo-saas/final-completion-codex.txt`、`final-completion-gemini.txt`（保留失败原文）、`completion-remediation-review.md`、`completion-remediation-codex.txt`、`completion-remediation-gemini.txt` 及 `commit-review-manifest.json`。它们均为本地忽略文件。草稿测试随机失败及修后验证已在上文单独记录，没有把原失败归因为已证实的产品缺陷。

顾问用语不扩展产品保证：operationId 提供的是持久化运行去重，不保证外部服务副作用的全局 exactly-once；Pi 子进程及 SDK 资源限制不等同于操作系统安全沙箱。租户隔离的已验证范围和剩余部署边界仍以本报告及架构文档为准。

## 能力边界

当前支持单个 Go API 实例；PostgreSQL 锁避免两个实例同时接管任务。已有运行可在浏览器离开后完成，未派发的下游节点仍由浏览器图调度器管理。工程文件执行、通用 shell 工具、对象存储、支付、邮箱验证/找回、OIDC、多副本调度以及生产恢复演练均属于后续实施范围，见 [架构设计](awwo-saas-architecture.md)。

运行时版本：Node `26.3.0`、npm `11.16.0`、项目 Go 工具链 `1.27.1`、PostgreSQL `18.4`、Pi SDK `0.85.1`。本机全局 Go `1.22.1` 通过 go.mod 的自动工具链使用项目版本；没有替换系统 Go。
