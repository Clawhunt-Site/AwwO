# AwwO 空服务器验收记录 — 2026-09-06

当前验收版本为 `/srv/awwo/releases/v0.3.0-acceptance.5`。已复用操作者当前 Codex 登录，完成真实 AI 规划与修改、两节点 2/2 交付、Stop、原 Session 续聊、Gateway 重启后恢复、人工暂停保护及双标签页历史恢复。最终无活动运行、待处理唤醒或孤儿 Codex 进程。浏览器验收入口为 `http://127.0.0.1:15188/`，依赖本机应用 SSH 隧道持续运行。

这是单操作员私有验收环境。增量已部署并实测，尚未提交或推送；双顾问提交门的剩余项见文末。下文保留真实失败与修复记录。

## 部署范围与来源

- 新建独立 Ubuntu 24.04 x86_64 验收主机，AWS us-east-2，t3.large，80 GiB 加密 gp3；原有业务主机未被启动、停止或部署。
- 应用仅监听回环地址，通过 SSH / AWS SSM SSH 隧道访问。三个服务以独立非 root `awwo` 账户运行。
- 源码基准：v0.3.0，commit `6e1dc158a79e2f18c7bdf82610a353883b883f31`。
- 归档 SHA-256：`94216273160de1ccc7691b08ade1fc7ca6f8b51adc6e5443face6d1adf8a5dc1`，服务器已读回核对。
- 首次成功运行目录：`/srv/awwo/releases/v0.3.0-acceptance.1`，基准源码加 Web 锁文件修复；后续修订记录见下文。原始失败安装目录保留。
- 修复后锁文件 SHA-256：`c48a2100241a95aa313151080dc5fc09f6450d8fe49bae1d1f5071309859580b`，本机与服务器一致。
- 工具链：Node 24.20.0，npm 11.19.0，pnpm 9.15.4，Codex CLI 0.153.3。

## 已完成的真实检查

| 范围 | 实际结果 |
| --- | --- |
| Linux 安装与构建 | 冻结依赖安装通过；Web 构建通过，原生依赖可用 |
| 服务 | Node、Gateway、Web 三个 systemd 服务均 active；Gateway upstream reachable |
| 监听与访问 | Node 3100、Gateway 8796、Web 5188、PostgreSQL 54329 均仅监听 loopback |
| 环境 | APP_ENV / VITE_APP_ENV staging；页面标题带 STAGING；禁爬响应生效 |
| 重启 | 按顺序停服后四个端口释放，重新启动健康；验收工作区记录保留 |
| 浏览器 | 可打开空画布；中文/英文切换后刷新保留；前端与用户系统模板具有不同表单与步骤 |
| 未登录失败 | 规划显示失败、保留需求文本，没有生成虚假节点或交付物 |
| Codex 身份 | 按操作者本轮明确指令复用本机当前登录，以 SSH stdin 原子写入服务账户 auth.json；目录 0700、文件 0600，本机凭据不变；原生账户读回与真实 AI 规划成功 |
| Linux 沙箱 | 为 root 管理的准确 bwrap 路径添加 AppArmor 规则后，`:workspace` 沙箱内写入成功、同用户可写的工作目录外路径以 EROFS 拒绝；全局 userns 限制保持开启 |
| 账户 API | 独立 authenticated 控制面完成 14 项实际检查，并关闭其进程、释放端口 |

账户测试覆盖匿名拒绝、注册、登录、退出、首次管理员认领、资料、工作区创建、最后 owner 保护、邀请接受、operator 权限和管理拒绝、降级 viewer 以及退出后会话失效。它使用独立数据库和密钥，没有向真实用户发送邮件。服务器保存 `account-acceptance/result.json` 及测试日志，凭据不进入此记录。

## 真实 Agent 链路进展

最初浏览器 OAuth 登录了另一个已耗尽额度的账号。操作者随后明确要求直接复用本机当前凭据，不再手工登录。本轮只同步了当前 Codex 登录文件，未同步 Windows 配置或放宽沙箱，也未在仓库、归档、命令参数或报告中写入凭据。官方只读账户接口确认身份匹配，随后真实 Codex 成功创建两个节点和一条连线，并通过对话修改节点名称和三条输入要求，同时保留已有 Agent 绑定、Session 与连线。

已在浏览器完成手动拖动，节点位置及 SVG 连线路径随之改变。下游缺少上游产出时没有派发原生 run；暴露的范围外阻断计数及单标签页拖动后误报版本冲突，已补本地回归修复。

第一次原生运行因默认提示未包含服务器已有任务正文而偏离任务，画布输出契约正确将它标为失败并阻断下游，没有发布无效 JSON。通过原生支持的 `promptTemplate` 扩展接入 `context.paperclipTaskMarkdown`，两个现有验收 Agent 已定向迁移，新绑定也采用该配置；没有修改 vendor。原生渲染器回归检查通过。

修复后浏览器串联执行显示 2/2，两个 Agent 在各自工作目录生成文件。下游首次把上游相对路径误作同目录文件，虽然 JSON 格式有效，但报告未完成内容核验；这没有被当作业务验收通过。已人工明确下游只核验连线文本，并在同一 Session 单独重跑下游，上游沿用已发布产出。

原生读回还发现旧版首次 assignment 运行后内核会额外创建 `finish_successful_run_handoff`。后续通过 backlog 容器和唯一用户评论修复，修订后的实际派发与结算证据见下文；旧执行记录保留。

额度错误分类仅识别原生结构化错误，返回稳定的 `usage_limit_exceeded` 和固定提示，不再误导用户反复检查登录。相关 28 项检查、Gateway 类型检查和构建通过；该修复已随 acceptance.3 上线。

较早的普通和含隐藏模型目录快照未提供 Spark。acceptance.3 上线后的原生 RPC 与浏览器实时目录均返回 7 个模型，其中包含 Spark；本轮实际 Agent 推理只验证 gpt-5.5，其他模型仅确认目录列出。Linux 沙箱修复与实际正反检查详见 [沙箱记录](awwo-linux-sandbox.md)，这些不消耗模型额度，也不替代 Agent 任务验收。

下游单独重跑的原生历史确认只新增一次执行，上游 `artifacts/spec.md` 的 SHA-256 与修改时间保持不变。下游 `artifacts/verification.md` 真实存在，核对上游文本中的标记与三条要求；这份文件只证明文本契约核验，功能检查由下面的独立实测提供。

| 实际检查 | 原生证据与结果 |
| --- | --- |
| 下游范围重跑 | `98a77ec9-1209-4e3c-84ab-9b193bf7829e` succeeded；新增执行仅属于下游 |
| Stop | `ce33a4a2-b4c8-418f-a73c-fd6753af6d10` cancelled；确认开始文件存在后停止，超过原 90 秒等待期限仍无结束文件 |
| 原 Session 恢复 | `9aa5d349-bbe1-4cb1-9652-7ed2d244a795` succeeded；真实写入并读回恢复文件 |
| 运行中刷新 | `3fd8bd98-93cb-41ab-9aac-8618edc7bb22` succeeded；刷新前后只有一次原生派发，最终用户消息与 Agent 回答各一条 |
| 双标签页 | 另一标签页在运行及恢复期间禁止编辑，确认完成后解锁 |

Stop、恢复和刷新三次 run 的原生 Session ID 均为 `01a07644-2ff1-79a3-950c-b1d78b768fd7`。独立工作目录的实际产物哈希：上游规格 `6920552fdad159a3f2141067c35c2b0975edd595137b5486282553d15bc38fa5`；下游核验 `451265b48b2e53f478d7840a57adcc5f603cb96d2f324ac85233ea8b16421f7f`。

旧版 Stop 的 UI 把已缓冲完成帧优先于确认取消，导致原生已取消而 UI 显示成功；已修复并加入回归测试。另新增明确的回合结算协议：原生终态和专属 pause hold 均确认后才发布产出、解锁；未知状态继续保留恢复日志。首次 Session 改成创建 backlog 容器后派发唯一用户评论，避免 assignment 自主接续。协议边界见 [回合生命周期](awwo-conversation-turn-lifecycle.md)。

acceptance.2 候选在独立目录完成服务器 Gateway/Web 类型检查与构建，未激活。独立 Codex 审阅发现旧接口评论归属、重启后结算评论排序两项边界问题，该候选被停止切换并保留源码供对照；当时服务继续运行 acceptance.1。

上述两项修复经新一轮 Codex 独立复审通过后，acceptance.3 已于 11:00 UTC 切换，47 源文件与冻结清单匹配。三个服务与数据库均仅监听回环地址，旧版本和冷数据副本保留。升级遗漏的静态 `[STAGING]` 标题已按原安装器规则原子补齐，并核对实际服务的两个环境选择器均为 staging；没有为标题修复重启服务。

acceptance.3 实测首轮 `dc0b4c02-66bd-4819-9f2e-46de05776083` 仅创建一次 `issue_commented` 运行，新 Session `01a07663-c762-7880-bc88-5c7594214229` 与旧 Session 不同，真实文件与精确结算 hold 均存在。随后 `b17030a0-6135-4f5f-a58f-9ad32c5a3cdb` 被确认取消，UI 同样显示取消，原 60 秒等待期限之后结束文件仍不存在。

11:06 UTC 单独重启 Gateway 后，`df8910a9-e767-4ba0-b4f0-b643d4ea4f81` 在同一原生 Session 成功读写恢复文件，但旧 Stop/settle holds 仍 active，因此本次重启验收整体判为失败。原生接口允许普通用户评论返回成功并启动运行，原实现仅在评论被拒绝时发现旧 hold，覆盖不足。acceptance.4 已修复为发送前主动发现、验证并释放全部自有 hold，保留人工或继承的暂停边界。

本次运行中刷新还遇到另一个标签页仍驻留旧版 JavaScript，它参与恢复时可能先清除旧协议日志；该混合版本状态不作为新版结算通过证据。升级验收要求所有相关标签页刷新至同一新版本，后续复测将保留本次失败记录并单独记录修复后的结果。

acceptance.4 的发送前检查经原生 Codex 独立复审通过后部署，两个标签页均刷新至同一版本。真实复测结果：

| 检查 | 结果 |
| --- | --- |
| 人工暂停 | 精确创建一条验收专用人工 hold 后发送消息；没有新增原生 run 或用户评论，人工 hold 和先前 hold 均保持。只在读回证实后释放本次测试的人工 hold |
| 重启后的同 Session 恢复 | `eab4bd9e-f129-44c0-b69b-989c2174eb8d` succeeded；旧 Stop/settle holds 全部 released；新 run 只有一个精确 settlement hold；原 Session ID 保持 |
| 完整两节点链路 | 上游 `57b32bd1-bfdf-447a-af48-57ec8e1bffe8` 于 11:21:20.233 UTC 完成，下游 `47d1a230-5163-4ee1-9680-622a5f5c8229` 于 11:21:21.720 UTC 开始、11:21:44.360 UTC 完成；浏览器显示 2/2 成功 |
| 唯一派发与终态 | 完整链路恰好新增两个原生运行，每个 Agent 一次、各自一个新用户评论，没有额外 handoff；两个原 Session 均保持；完成后各有一条对应本轮的 settlement hold |
| 真实文件与 Stop | 两个独立工作目录均有本轮产物；早先 probe 内容和修改时间不变，Stop 后的结束文件超过原等待期限 1,216 秒仍不存在 |

最终上游 `artifacts/spec.md` SHA-256 为 `750b9f7e9b01762a8bc5c34e2b975571ce052ae1b74dbeb6b1d181acf1d4deeb`；下游 `artifacts/verification.md` 为 `46c84389a15bdc864f88329a7d7bc1ad5e5a773c5a8f15918728f7f5973a2421`。下游包含验收标记。只读收据校验结果 `pass / resolved-regression`，原始失败收据及其哈希仍保留，不以复测覆盖失败历史。

acceptance.4 的双标签页实测另发现显示问题：另一标签页完成恢复并清除日志后，当前页解锁但仍显示旧聊天缓存；服务器历史与最终回复正确。该问题单独交由 Web 修复与复验，不归为 Gateway 派发失败。

acceptance.5 于 11:34:49 UTC 完成切换，11:34:56 UTC 独立读回通过。冻结增量包含 53 个文件，清单 SHA-256 `1cf7742e9bae986be693d2c69ec374658751d33d7e2ee8b0b4606c8f88748e76`，归档 SHA-256 `cafd45ed576f08905d002de2206281d710da195b2013d712a2b9aa8aa8a95aec`。三个实际服务进程均指向新目录，静态页面与该目录构建结果一致；保留 .2/.3/.4 源码、原服务配置和冷数据副本。本文最后的实测记录是部署后的文档增量，不属于这份冻结清单。

两个标签页均刷新至 acceptance.5 后，在原 Session 发起 `ada8240e-c138-49c0-aa77-18d1c2b39d7c`（11:35:47.008–11:36:31.905 UTC）。原生状态为 running 时刷新主标签页，两个页面保持锁定；完成后自动解锁，两个页面的最新用户消息和 Agent 回复各一条。旧失败人工消息保留在历史第 8 条，最新 Agent 回复在第 14 条；Session 预览同步为新回复，右侧已发布的规格交付仍保留。

该轮只新增一次原生执行，issue 与原生 Session `01a07663-c762-7880-bc88-5c7594214229` 均不变；用户评论与执行精确匹配，旧上游 settlement 已释放，新 settlement 对应该 run。下游 hold 未变化，所有已核验文件的内容和修改时间不变。服务器标准消息接口与浏览器一致；本轮 UI、原生和文件收据的 14 项校验全部通过。

11:37:19 UTC 最终只读终检：全库活动运行 0、待处理唤醒 0、执行进程 0、Codex 进程 0、孤儿 Codex 进程 0；自动 heartbeat 调度关闭。Node/Gateway/Web 健康，3100、8796、5188、54329 均仅监听 loopback。回退配置与冷备权限校验通过，没有执行回退或恢复旧数据库。

本环境是由 SSH 限定的单操作员画布。独立账户 API 通过不代表 Gateway 已具备端到端用户身份传播或多租户画布隔离；不将其描述为可直接开放公网的多用户服务。

## 本轮代码验证与提交状态

- 部署工具本地检查：27/27 通过；Gateway canvas 检查：28/28 通过，类型检查与构建通过。
- Gateway 回合相关检查 11 文件、189 项通过，类型检查通过；Web 完整默认测试 93 文件、1,033 项及静态 UI 检查通过（后续聊天缓存修复单独记录）。
- 原生 Codex gpt-5.5 对安装、沙箱、回合协议修复及发送前 hold 检查的独立只读复审均 PASS。协议首次 FAIL 及两项修复后的 PASS 均保留；源码、补丁及报告快照的哈希保存在本地忽略的审阅记录。
- 最终 Web 历史恢复修复：相关 10 文件、86 项检查和类型检查通过；原生 gpt-5.5 独立审阅 PASS，源码无漂移、审阅没有调用工具。结论 SHA-256 `6f49f0e89267563db682d584bf1a4298d08cb4176d6834556c36be2960b10904`。审阅记录的非阻断边界：若原生接口对已有 issue 返回完整但空的历史，旧缓存可能保留；本次实际路径读取到完整非空历史，已验证。该边界保留为后续回归项。
- Gemini CLI 非交互审阅因需要交互授权而退出，没有形成审阅结论。项目 `CLAUDE.md` 的双顾问提交要求尚未满足，没有沿用此前版本的例外。
- 本轮变更仍在 `codex/server-acceptance` 工作分支，未提交、未推送；原 v0.3.0 标签不变。

## 交接与维护

关键验证命令与已取得的结果（最终仅补文档，没有重复运行测试）：

```powershell
# 仓库根目录：部署检查 27 项；较早 Web 默认全套 93 文件 / 1,033 项及 static-ui PASS
node --test scripts/deploy/awwo-private-acceptance.test.mjs
npm test --prefix apps/web

# apps/gateway：11 文件 / 189 项及类型检查 PASS
node node_modules/vitest/vitest.mjs run src/conversation
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit

# apps/web：最终增量相关 10 文件 / 86 项及类型检查 PASS
node node_modules/vitest/vitest.mjs run tests/canvas-surface-recovery.test.tsx tests/canvas-agent-chat.test.ts tests/canvas-recovery-document.test.ts tests/canvas-tile-history.test.tsx tests/canvas-run-lock.test.tsx tests/canvas-thread-persistence.test.tsx tests/canvas-stop-recovery-regressions.test.ts tests/canvas-run-settlement.test.ts tests/canvas-node-disclosure.test.tsx tests/canvas-workspace-integration.test.tsx
node node_modules/typescript/bin/tsc --noEmit
```

acceptance.5 的独立服务器目录也完成 Gateway/Web 类型检查及构建。Web 构建保留既有 CSS `::highlight` 与 bundle 大小提示，没有构建错误。

- 工作树：`E:\Bobo's Coding cache\bo-work\AwwO-worktrees\server-acceptance`。
- 分支：`codex/server-acceptance`；基准为 Forgejo `origin/dev` / v0.3.0，SHA `6e1dc158a79e2f18c7bdf82610a353883b883f31`；本轮无新 commit、无 PR。
- 仓库：<https://git.clawhunt.store/ClawHunt-Store/AwwO>。
- 主要改动：`scripts/deploy/awwo-private-acceptance.sh` 与检查；Web 锁文件；Gateway `canvas` 模型目录及错误分类、`conversation` 评论派发/持久幂等/结算；Web `RuntimePicker`、`canvasHire`、`CanvasSurface`、`runGraph`、`runTransport`、`runSettlement`、`runRecoveryDocument`、`sessionTransport`、`canvasAgentChat` 及对应回归；相关说明与 `CHANGELOG.md`。`server/` vendor 没有变化。
- 本地忽略的收据：`turn-recheck-final-validation.json`（保留旧 FAIL 的独立复测 PASS）、`history-refresh-final-validation.json`（最终 UI/native PASS）、`acceptance-5-active-readback.json`、`acceptance-5-final-idle.json`、`acceptance-5-rollback-assets.json`。均位于 `.local/server-acceptance/`，没有将运行状态或凭据加入 Git。
- 服务与日志命令、初装流程和恢复注意事项见 [服务器操作说明](awwo-server-acceptance.md)。不要在已有状态目录重新运行初装脚本。浏览器画布仍使用本机存储，本次不声明跨设备画布同步。

可复用本机已经配置的隧道入口（当前隧道仍运行，勿重复占用同一端口）：

```powershell
ssh -F .local/server-acceptance/ssh_config -N -o ExitOnForwardFailure=yes -L 127.0.0.1:15188:127.0.0.1:5188 awwo-acceptance
```
