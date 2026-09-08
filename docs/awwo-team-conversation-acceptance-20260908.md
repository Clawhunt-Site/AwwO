# AwwO 多 Agent 连续对话与过程验收

验收日期：2026-09-08，Asia/Shanghai。范围为节点团队的顺序执行、独立人格、会话历史、输入审计与前端对接。本报告不代表整个 SaaS 已完成生产验收。

## 候选与运行环境

- Worker：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-node-setup-20260908`
- 分支：`codex/awwo-node-setup-20260908`；本轮基准 SHA：`73839462cadb0dd5152e96c4b8fafda66f560375`。
- 本轮代码提交：`b70e33b7ddc2b824ca6f667113a6afacd8514899`（连续对话与成员过程）、`2be5be954e82fd39725dec047317a1b1e16e2eff`（精确取消与状态）。运行二进制对应此代码树；源码和二进制 SHA-256 保存在 `candidate-source-manifest.json` / `runtime.json`。文档另作独立提交。
- 本地入口：http://127.0.0.1:5189/；Go API 8087、Pi 8097、PostgreSQL 55483。
- 实测使用服务器现有 `gpt-5.6` 档案，Go → Pi 子进程 → 配置的真实模型服务。未输出、提交或把供应商密钥放入浏览器。
- 独立验收画布：[多 Agent 连续对话与过程验收 · 0908](http://127.0.0.1:5189/?tenant=ayIAxdOi4IuvaV1kVwpEAqAjrCzHEK0nc&canvas=aG9S5ITA9ax9pRg99zYIQzHcKJn2B8C2w)。沿用用户两位成员的显示名称、职责、模型与“你是李白 / 你是王伟”专属指令。
- 原画布 `aEP_McARajS3dX9hDxeKh-uR0kCgqEA50` 保持 version 110，原会话、配置及交付未覆盖。重启前确认 active runs/graphs 均为 0，并保存权限 0600 的私有数据库备份。

## 已修复的行为

1. 每条回复关联服务端 `runId`，展示该次成员调用的顺序、轮次、状态、模型、时间和独立输出。失败运行只有用户消息时也可查看过程；相同文本不会关联到其他运行。
2. 成员“专属指令”定义其人格，优先于显示名称与父节点人格；“职责”仍约束工作职责。前序成员输出作为标注来源的数据传递。
3. `shared` 在当前 Session 内继承此前已完成的用户问答与团队最终结果，并加入本轮已完成成员输出；`task` 普通执行不继承这些上下文。汇总、审核、返工仍接收必要操作数。
4. 聊天框发送本次原文，不再自动附加旧的任务表单和 JSON 交付约束；“执行节点任务”使用表单、校验和原交付契约。聊天不会覆盖已发布交付物或下游产出。
5. 服务端持久化实际 `prompt / systemPrompt / messages / context`，界面可展开检查。历史窗口或模型容量造成上下文省略时显示实际数量；旧记录缺失的输入审计明确显示未保存。
6. 运行终态独立于成员记录更新；读取失败时显示暂停和旧记录提示，提供重试。取消精确发送当前成员的 turn ID，使用独立有界清理，不仅依赖客户端断流。

精确语义与 API 见 [节点团队架构](awwo-node-teams.md) 和 [SaaS API](awwo-saas-api.md)。

## 真实模型与浏览器证据

五次运行、十次成员调用均为 `completed`，使用内置浏览器实际点击发送、切换 Session、执行任务和刷新。API 审计另外核对运行顺序、指令、上下文、隔离和交付物。

| 场景 | 运行 ID | 验收结果 |
| --- | --- | --- |
| 首次自报身份并记住口令 | `azkFKhCqe9vvp_3meaWbcY-po5BzbpxZR` | 李白先答“我是李白”，王伟后答“我是王伟”；历史 0，王伟收到李白本轮输出 |
| 不重复提供口令的连续追问 | `a4N8RDFlfBUXQAuYklsPbR6ftLpND3SiP` | 两人均答出“青松472”；实际历史消息 2/2，前序来源分别 0 和 1 |
| 新 Session 询问旧口令 | `aX73zvoWrSInOGckSqM1rUpMnYK2UNEvO` | 两人都说明没有口令记录；实际历史为 0，输入和输出没有旧口令 |
| 执行原节点任务 | `anvUn43biF9KoN9cABSAiCE1xCwTJnmOU` | 表单与 JSON 输出契约进入实际 prompt，后台节点完成，交付结果及后续事项正常发布 |
| 交付完成后只聊天 | `aKd50VSas8sotHFxOlTt-OkmC0yGSn9hB` | 两人自然语言介绍各自身份，实际历史为 4；发布交付前后逐字段深比较一致 |

另做两次真实取消操作：首次发现成员已经停止但错误字段仍为 `runtime_stream_ended`，已修复并重编译。最终复测运行 `aB88U8Wpn9FHpn4faRxdEGf8RBo0UbMo9` 为 `cancelled`，仅李白一位成员启动且保留部分输出，成员 error 为空，王伟未启动，Pi activeRuns 和数据库活动成员/并发名额均为 0。此前取消问答没有作为完成历史传入。两次取消各触发一次成员调用；与五次完成运行分开统计。只读复核命令为 `node .local/awwo-saas/team-conversation-acceptance/verify-cancellation.mjs`。

刷新后重开节点，前两条消息仍对应各自成员记录，最新记录默认展开。后台整图运行面板也能查看同一份成员过程。旧用户运行的 `systemPrompt / messages / context` 保持 `null`，没有从新配置反推或伪造旧实际请求。

本地证据目录：`../.local/awwo-saas/team-conversation-acceptance/`。其中 `verify.mjs` 是只读复核脚本，`verification.json`、`all-real-runs.json`、`final-canvas.json`、`graph-runs.json` 保留实际结果。复核命令：

```sh
node .local/awwo-saas/team-conversation-acceptance/verify.mjs
```

## 自动测试

| 检查 | 结果与边界 |
| --- | --- |
| `vitest --config vitest.saas.config.mjs tests/saas- tests/canvas-` | 76 文件 / 753 项通过；包括原文发送、任务必填校验、只读权限、历史恢复、同文 runId 隔离、失败记录、详情轮询及四种团队模式相关前端回归 |
| PostgreSQL `go test -race -count=1 -v ./internal/app -run 'Team\|Graph'` | 25 顶层 / 27 子场景通过，39.120 秒；真实数据库、捕获 Pi 请求，包括租户/Session/状态隔离、受理快照、模型预算、四模式、审核、取消和配额 |
| `go vet ./...` | 通过 |
| `npm run test:saas:pi` | 27 项通过；真实 Pi SDK + 本机协议桩，不等同外部推理 |
| `npm run test:saas:stack` | 1 项通过；HTTP → Go → Pi SDK → 本地模型协议桩 → PostgreSQL/SSE/取消/历史 |
| `npm run typecheck:saas --prefix apps/web` | 通过 |
| `npm run build:saas` | 通过；仍有大于 500 kB 的 bundle 提示，不影响本次构建 |
| `git diff --check` | 通过 |

中途修正了新验收测试调用签名、中文预检提示断言，以及实测复核脚本对 API 字段和 JSON 转义的假设；最终对应检查通过。未用模型“自报验收成功”作为系统通过依据。

## 截图

- [首次两人独立回复](../.local/awwo-saas/team-conversation-acceptance/01-first-turn.png)
- [连续追问](../.local/awwo-saas/team-conversation-acceptance/02-history-followup.png)
- [刷新恢复](../.local/awwo-saas/team-conversation-acceptance/03-refreshed-history.png)
- [实际输入审计](../.local/awwo-saas/team-conversation-acceptance/04-input-audit.png)
- [新 Session 隔离](../.local/awwo-saas/team-conversation-acceptance/05-new-session-isolated.png)
- [任务交付](../.local/awwo-saas/team-conversation-acceptance/06-task-delivery.png)
- [后台成员过程](../.local/awwo-saas/team-conversation-acceptance/07-background-team-records.png)
- [聊天保留已发布交付物](../.local/awwo-saas/team-conversation-acceptance/08-chat-preserves-delivery.png)
- [最终主动停止：保留部分输出且无伪错误](../.local/awwo-saas/team-conversation-acceptance/10-cancel-final.png)

另外保留 `09-cancel-initial.png` 作为修复前问题证据，不计作通过截图。

## 复审与范围限制

独立 Swarm 复审完成。Codex GPT-5.5 首轮指出两项阻断：成员接口读取失败时运行终态未更新，以及 Pi 取消请求错用父 run ID。两项均修复、补测，Codex 与 Gemini 的复审均明确 PASS。真实浏览器随后发现主动取消的伪错误；修复后再次通过两位顾问的增量复核及真实停止测试。最终没有未处理阻断项。

审查记录在证据目录：`codex-review.md`（首次 FAIL）、`codex-followup.md` / `gemini-followup.log`（两项修复 PASS）、`codex-cancel-status.md` / `gemini-cancel-status.log`（最后状态修复 PASS）。Gemini 最初 headless 工具权限拒绝、一次大输入超时均未算通过；后改为提供代码的无工具审查成功。顾问没有独立运行测试，运行证据由上述日志和实测记录提供。Codex 的非阻断说明：若 Pi 单方面发 cancelled、父团队上下文仍未取消，父团队可以按执行失败收束；不把它冒充为用户停止成功。

- 共享历史保留已完成用户问答和团队最终结果，不为每个成员建立无限独立记忆；最多候选 50 对并按实际容量保留完整片段。
- 普通上下文允许省略完整历史/上游片段并记录；必要审核/汇总内容放不下则明确失败，不截断指令或冒充完整输入。
- 本次真实模型重点覆盖顺序模式；并行、讨论、审核回归在本轮使用协议测试，先前真实四模式验收是独立历史证据。
- 模型回答语义仍有随机性，输入审计和真实调用顺序才是系统执行证据。
- 此次没有发布外网、合并或推送；单机 Go 调度、文本推理以及现有工具能力边界保持原状。
