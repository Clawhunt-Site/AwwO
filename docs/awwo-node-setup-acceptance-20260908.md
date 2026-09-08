# AwwO 节点初始化修复验收

验收日期：2026-09-08，Asia/Shanghai。结论：本次“保存后仍未绑定、首次运行被阻断、旧提示常驻”的本地修复通过。配置保存、首次整图运行和新会话发送均完成真实 Go → Pi → GPT-5.6 调用；双 Agent 团队和历史保留已在页面及持久化 API 双重核对。

## 交付位置与版本

- 工作目录：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-node-setup-20260908`
- 工作分支：`codex/awwo-node-setup-20260908`
- 基准分支：`codex/awwo-node-teams-20260908`
- 基准 SHA：`d0fb9a7445b00a238d87dcc5232d8941ab905f62`
- 修复提交：`88b35ea7018f88462ca273e5b8de14ca3a17a5c6`，`fix(canvas): initialize SaaS nodes before saving and running`
- 本地入口：[AwwO](http://127.0.0.1:5189/)，Go API 8087，Pi worker 8097，专属 PostgreSQL 55483。
- 最终后端于 20:19:20 构建，20:19:22 启动；之后的团队、首次运行、新会话验收使用此二进制。前端使用同一修复提交的 Vite 服务。
- 未执行 merge、push、PR 或公网部署。主仓库及前一工作树未修改。

## 问题与修复结果

| 原问题 | 修复后的行为 |
| --- | --- |
| 模板只有前端节点，保存不创建运行身份 | “保存并准备运行”保存配置并创建当前工作区真实 Agent / Session |
| 点击运行就报多个节点未绑定 | 整图、局部运行、手动发送先初始化所需节点，再执行原校验和运行 |
| 用户必须理解并重复操作绑定流程 | 空 runtime/model 使用服务端默认 Pi/模型；不再要求另选公司并绑定 |
| 旧拒绝提示覆盖后续运行进度 | 提示可关闭；新运行和相关文档变化清理陈旧拒绝信息 |
| 改配置容易丢旧会话，或重复创建身份 | 有效配置变化保留旧会话并建立新当前会话；重复兼容保存复用身份 |
| 窄窗口中保存按钮被状态栏遮挡 | SaaS 配置统一置于画布根浮层，固定头尾、中部滚动；窄窗运行控件换行 |
| 必填任务未填写时误报未绑定 | 明确指出缺少“任务要求”，填好后才允许发送 |

## 当前使用逻辑

1. 创建或选择画布，使用模板、画布助手或手动添加节点。
2. 在“配置”里编辑名称、人设和模型；需要团队时配置成员职责、专属指令、模型和协作方式，然后“保存并准备运行”。也可保留默认配置直接运行。
3. 在节点“输入”填写任务要求；连线节点的上游交付按端口契约进入下游。
4. “运行图”由 Go 持久调度；节点内部由 Pi 执行单 Agent 或团队协作。后台记录展示实际节点状态及成员发言。
5. 结果、消息及会话身份保存到 PostgreSQL。团队或人格等有效配置改变后使用新会话，旧会话仍可选择查看。

初始化只检查服务配置并创建数据库记录，不产生推理。真正点击运行或发送才发起模型请求。手动会话回复保存在聊天历史；自动图交付与聊天记录仍是现有产品的不同输出路径。

## 自动化验证

所有命令在上述修复工作树执行。Web 与 SaaS 套件有重叠，不将两者相加作为独立用例数。

| 检查 | 最终结果 | 本地日志 |
| --- | --- | --- |
| `npm test --prefix apps/web`，含 static UI 检查 | 96 文件 / 1,066 用例通过，exit 0，43.57 秒 | `.local/awwo-saas/node-setup-web-tests-final.log` |
| `npm run test:saas --prefix apps/web` | 23 文件 / 200 用例通过，12.53 秒 | `node-setup-saas-tests.log` |
| `npm run test:saas:backend` | 真实 PostgreSQL；Go race 48 个顶层测试 + 45 子用例通过，无失败/跳过；84.228 秒；vet 通过 | `node-setup-backend-tests.log` |
| `npm run test:saas:pi` | 27 通过 | `node-setup-pi-tests.log` |
| `npm run test:saas:scripts` | 8 通过 | `node-setup-scripts-tests.log` |
| `npm run test:saas:stack` | 1 个 Go/Pi SDK/PostgreSQL/SSE/历史/取消/规划完整本地协议测试通过 | `node-setup-stack-tests.log` |
| `npm run typecheck:saas --prefix apps/web` | 通过 | `node-setup-typecheck.log` |
| `npm run build:saas` | 通过；保留既有大 chunk 提示 | `node-setup-build.log` |
| `git diff --check`、独立代理只读复核 | 通过，无阻断项 | 本任务工具记录 |

除第一行标明路径外，日志均位于工作树 `.local/awwo-saas/`。

本次新增前端回归覆盖配置保存/锁定/失败、自动运行和手动发送、根层 Inspector、必填提示、保存队列、跨工作区、旧版本、取消及迟到响应。后端覆盖初始化默认值、scope、重复调用、原子回滚、权限再检查、跨租户引用、活动任务锁、非法模型/团队和旧历史快照。

并行运行 Web/Go/Pi 时，旧邀请表单测试出现一次等待超时（1 失败 / 1,065 通过）；该文件单独运行 10/10 通过，随后独立重跑整套 Web 1,066/1,066 通过，未改动该测试或扩大超时。保留首次失败日志 `node-setup-web-tests.log`，不掩盖此测试时序波动。最初一次命令误用不存在的 `.ts` 测试配置，纠正为仓库实际 `.mjs` 后执行；这是启动命令错误，不是应用测试失败。

## 真实页面验收

使用 Codex 内置浏览器操作可见页面，未以 API 代替点击。页面点击后再通过真实 API 核对身份、消息与运行记录。先在约 642×820 CSS 像素窄窗口检查，后在实际 1098×1248 窗口检查；截图为原始浏览器截图。

| 场景 | 操作与结果 |
| --- | --- |
| 配置一次保存 | 新建空白节点，编辑名称/人设，模型留默认；保存后变为“已连接”，面板关闭 |
| 默认 Pi 真实执行 | 填入多租户隔离说明任务，整图完成 1/1；生成结构化结果，刷新后可见 |
| 团队配置及旧历史 | 启用两位成员，第二位选择 `reviewer`；保存后产生 Session 2，Session 1 原回复和交付仍在 |
| 团队实际调用 | 两位成员顺序执行，模型档案分别为 `gpt-5.6` 和 `reviewer`；两个回合均 completed，后台面板可查看各自输出 |
| 首次运行自动准备 | 新画布添加空白节点，取消配置，保留未绑定草稿；只填写任务，直接运行，自动变为“已连接”，完成 1/1 并输出“首次运行自动准备通过。” |
| 新会话手动发送 | 新建 Session 2，不另绑定；发送文本后实际返回“新会话自动准备成功。”，刷新仍可见且未发送草稿已清空 |
| 重复保存 | 再次打开配置直接保存；API 前后 Agent ID、Session ID、历史会话 ID 一致，无重复创建 |
| 窄窗遮挡 | 配置保存/关闭及顶部运行/账户控件中心命中其自身，边界位于可视区；保存实际成功 |
| 缺少输入 | 空任务显示具体必填项，composer 禁用；不显示旧“未绑定真实 Agent”错误 |
| 原数据保留 | 原 `first one` 仍在，最后修改时间维持 19:26:15；验收使用两个新画布 |

最终 API 收据确认 **4 个 completed 运行、3 个 completed 图运行、2 个 completed 团队成员回合**，对应本轮 5 次实际模型推理（团队运行包含两次）。`reviewer` 是独立配置档案，本机目前仍映射同一 GPT-5.6 上游，不据此宣称已验证跨供应商协作。

验收画布：

- [配置及团队验收](http://127.0.0.1:5189/?tenant=ayIAxdOi4IuvaV1kVwpEAqAjrCzHEK0nc&canvas=aEP_McARajS3dX9hDxeKh-uR0kCgqEA50)
- [首次运行及新会话验收](http://127.0.0.1:5189/?tenant=ayIAxdOi4IuvaV1kVwpEAqAjrCzHEK0nc&canvas=auk2o248Zts0_0SLqNCL5hxUU8gb0Vh9G)

## 截图与收据

证据目录：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-node-setup-20260908/.local/awwo-saas/node-setup-acceptance/`。

- [窄窗配置及保存按钮](../.local/awwo-saas/node-setup-acceptance/03-team-configuration.png)
- [配置变更后旧会话保留](../.local/awwo-saas/node-setup-acceptance/04-old-history-preserved.png)
- [首次运行前未绑定草稿](../.local/awwo-saas/node-setup-acceptance/05-unbound-before-first-run.png)
- [首次自动准备后运行成功](../.local/awwo-saas/node-setup-acceptance/06-first-run-success.png)
- [新会话发送成功](../.local/awwo-saas/node-setup-acceptance/07-manual-session-success.png)
- [团队结果刷新后保留](../.local/awwo-saas/node-setup-acceptance/08-team-result-after-refresh.png)
- [两名成员的真实执行记录](../.local/awwo-saas/node-setup-acceptance/09-team-member-evidence.png)

`live-receipts.json` 保存最小化 API 收据，`final-check.json` 保存重复保存身份及运行计数断言，`verify-live.mjs` 可重新进行登录和只读核对，`screenshots.json` 保存截图 SHA-256。01/02 为排查过程截图，02 存在浏览器视口截取边缘，展示以上 full-page 原图为准。证据及本地配置均被 `.gitignore` 排除；截图链接适用于当前工作树，没有发布到公网。

## 数据与验收边界

切换修复版前确认无活动图/运行，并保存权限 0600 的 `pre-node-setup-backup.sql`。新工作树复用原专属数据库目录；账号、画布和消息保留。迁移 008 增加会话有效配置快照。未改变供应商密钥；本地配置没有进入提交、报告或截图。

当前没有阻断本次修复的未通过检查。故障、跨租户、并发和迟到响应场景通过自动化覆盖；未在正在使用的真实页面中人为断网或注入故障。局部运行初始化有自动化覆盖，本轮真实模型页面使用整图与手动发送。多轮讨论、并行汇总、审核返工沿用前一团队交付；本次只重做顺序团队的真实模型验收。

画布可缩放；窄窗下大节点可能需要“查看全部节点”后重新展开或调整视野。本次证明配置浮层与顶部操作可用，不将其扩大为所有屏幕尺寸的完整视觉验收。

这份报告不声明公网 SaaS 生产上线完成，也不声明工程文件/Shell 沙箱、图像生成或分布式多 worker 已实现。Pi 当前仍按已有范围执行文本与结构化输出；发布与生产验收独立进行。
