# AwwO 节点多 Agent 与后台编排验收报告

验收日期：2026-09-08，Asia/Shanghai。结论：**本地 Pi 文本团队执行与 Go 后台图编排通过验收**。这份报告覆盖本次新增能力，公网 SaaS 上线仍有单独的部署与运行验收门。

## 交付版本与范围

- 工作目录：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-saas-20260907`。
- 分支：`codex/awwo-node-teams-20260908`。
- 基线：`f74b88dfc24c753960bfc09f05a627f7d2ed6035`。
- Pi 多模型实现提交：`9d69e95`。
- 最终应用代码提交：`caf7658dcb3e72098d0074f8eef02443bbfd61ab`。
- 后续验收提交仅包含脚本、报告与文档；不改变应用代码。原项目目录的 main 保持 `6e1dc158a79e2f18c7bdf82610a353883b883f31`，工作区干净。本次没有合并、推送或部署。

每个节点现在可设置 1–8 位成员，每位成员分别配置名称、职责、指令、模型档案和上下文策略。成员留空模型时继承节点绑定主 Agent 的持久化模型，主 Agent 也未指定时才使用服务默认模型。执行框架当前支持 Pi；密钥、服务地址由服务器模型档案管理，浏览器只选择可见模型 ID。

| 模式 | 实际执行规则 | 本次真实模型结果 |
| --- | --- | --- |
| 顺序执行 | 成员依次处理，后续成员按配置获取前序结果 | 2 次成员调用，完成 |
| 并行汇总 | 前 N−1 位成员并行，最后一位汇总 | 3 次成员调用，完成 |
| 讨论 | 按轮次互相参考，最后补一次汇总 | 2 人 × 2 轮 + 汇总，共 5 次，完成 |
| 审核返工 | 工作成员提交，最后一位审核；拒绝后按反馈返工 | 先拒绝、再返工、最后批准，共 4 次，完成 |

图任务由 Go 持久化并调度依赖节点。关闭浏览器不会停止正常后台执行；再次打开可恢复节点结果和成员记录。运行以受理时的配置快照为准，后续配置修改不会悄悄改变已受理任务。旧单 Agent 节点与原节点聊天入口继续可用。

详细设计见 [节点团队架构与契约](awwo-node-teams.md)、[SaaS 架构](awwo-saas-architecture.md)、[API](awwo-saas-api.md)、[设计规范](awwo-saas-design-standards.md)及[开发手册](awwo-saas-development.md)。

## 自动化检查

以下均是本次执行结果。Web 与 SaaS 套件存在重叠，不能相加为独立用例总数。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Go：真实 PostgreSQL、race、全包测试 | 42 个顶层测试及 42 个子用例；0 失败、0 跳过；73.431 秒 | [原始 JSON 日志](../.local/awwo-saas/node-teams-final-go-tests.jsonl)、[汇总](../.local/awwo-saas/node-teams-final-go-summary.json) |
| Go vet | 通过 | [执行记录摘录](../.local/awwo-saas/node-teams-backend-verification.txt) |
| 原 Web 套件及静态 UI 检查 | 94 文件、1,052 用例通过 | [日志](../.local/awwo-saas/node-teams-final-web-tests.log) |
| SaaS 套件 | 21 文件、177 用例通过 | [日志](../.local/awwo-saas/node-teams-final-saas-tests.log) |
| SaaS TypeScript 检查与构建 | 通过 | [类型日志](../.local/awwo-saas/node-teams-final-typecheck.log)、[构建日志](../.local/awwo-saas/node-teams-final-build.log) |
| Pi worker | 27 用例通过，包括真实 Pi SDK 子进程对接本地 OpenAI / Anthropic 协议 fixture、配置及密钥隔离 | [日志](../.local/awwo-saas/node-teams-pi-tests.log) |
| SaaS 脚本 | 8 用例通过 | [日志](../.local/awwo-saas/node-teams-script-tests.log) |
| 最终代码完整本地链路 | 1 个 Go HTTP → Pi SDK → 本地模型协议 fixture → PostgreSQL 集成测试通过 | [日志](../.local/awwo-saas/node-teams-final-stack-tests.log) |
| Compose 配置、Git 差异检查 | 配置解析通过；diff 检查通过；未执行 Docker 容器启动 | 本地检查记录 |

Go 测试包括租户与权限隔离、伪造绑定拒绝、图的分叉与汇合、幂等受理、并发取消、配置快照、配额与模型上下文限制、重启时避免重复调用、DB 失败后的收尾，以及取消后删除画布的迟到回调。UI 回归覆盖真实 CanvasSurface 中团队启用、编辑、关闭、保存及下游旧结果失效，并覆盖跨页恢复与新任务日志的竞态。

构建有约 766 kB 主 chunk 超过 500 kB 的体积提示；Web 环境有 JSDOM 的 Window.open 未实现提示。检查退出码均为 0，没有把这些提示算成运行失败。

## 真实模型与浏览器证据

使用用户授权的模型连接，经 Pi 发起真实 `gpt-5.6` 文本请求。公开模型档案 ID 为 `gpt-5.6` 和 `reviewer`，**两者本次指向同一个底层模型**；此次外部请求不能证明另一家 provider 的线上可用性。多 provider 配置隔离由上述本地协议测试验证。没有将 provider 密钥写入报告、截图或 Git。

使用实际原画布页面完成点击、编辑、保存、刷新、关页、重新打开、停止与聊天。四种模式的模型执行由 API 验收脚本受理，浏览器查看持久记录；后台续跑、成员配置保存、停止与聊天由实际 UI 操作触发。

| 场景 | 持久化 ID | 结果 |
| --- | --- | --- |
| 顺序 | awFbL0k2O2FNT6goAjyrVk_fSUvOW0odT | 完成，2 次 |
| 并行汇总 | amPaBft14NcHzHdhEXg5eFoTftQWCcv_y | 完成，3 次 |
| 讨论 | aLo5neIckSLYsxoV0erpikVqdsjFHlIYC | 完成，5 次 |
| 审核返工 | a7HQ-AhU-AFJcJrm-cVq-wOId7CDLsmUl | 完成，4 次；批准值 false → true |
| 关页后后台整图 | anUlSUZjB2_QHWjWDLxlG1WphGHdAC8n1 | 上游团队 5 次，下游单 Agent 1 次；2/2 节点完成 |
| UI 主动停止 | ak1a-Sgg8ivxJEIqiFLfoDww4Yvq9VTeo | 已取消；下游没有创建 run |
| 原聊天入口 | aJXPkNTGvCbxXyvhiJoY45N14QDSXeczk（run ID） | 两人讨论 5 次，8×8 最终输出 64 |

后台续跑的时间证据：12:53:40.498 关闭实际浏览器标签页；12:53:50.274739 下游开始运行；12:53:56.062955 整图完成；12:54:28 在页面仍关闭时通过 API 确认完成，随后重新打开恢复了 2/2 节点结果。这证明下游受理发生在关页之后。[关页观察](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/browser-close-observation.json) · [后台结果](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/browser-background-result.json)。

成员职责在 UI 改为“独立提出方案并解释计算依据”，保存并刷新后仍存在，实际新 run 的成员快照也使用该职责。审核测试明确要求首轮拒绝、第二轮检查返工后批准，证明返工控制流；不把该设置当作模型自主审核质量的评估。

停止场景受理了 3 次成员调用，其中 2 次已经完成、1 次取消；已完成记录被保留，下游从未启动。[取消证据](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/browser-cancel-result.json)。原聊天入口另产生 5 条完成的成员记录并回答 64。[聊天证据](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/browser-manual-chat-result.json)。

最终记录共 6 个整图任务（5 完成、1 主动取消），8 个节点/聊天 run（7 完成、1 取消），27 条成员调用（26 完成、1 取消），另有 1 次单 Agent 下游调用。这里统计受理与终态记录，不代表全部请求均成功或实际账单金额。

[最终验收摘要](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/acceptance-summary.json)合并了自动化、API 与浏览器观察。脚本原始 [results.json](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/results.json) 的 API_PASS_BROWSER_PENDING 是其自动检查范围的状态；浏览器结果由三个单独证据文件记录，没有改写原始状态伪装成自动浏览器验证。

版本边界：真实外部模型的正常流程先完成；随后发现的“取消后删除画布、迟到完成回调”边界修复，在最终应用 SHA 上通过专用 PostgreSQL 回归、完整 Go race 套件与本地完整协议链路验证。该删除边界未再使用外部模型复测。

## 发现并修复的问题

- 检查器保存漏传 team，导致表单修改未进入真实画布：补齐保存契约和真实组件回归。
- 恢复旧图时异步请求可能覆盖另一个标签页刚创建的运行日志：在所有权锁内重新检查当前日志与取消信号。
- 图取消可能覆盖已提交的完成结果或丢失部分输出：先核对持久终态，再取消尚未完成的子任务。
- DB 写入失败可能遗留孤立 run 或占用配额：终态写入执行有界间隔的 DB 重试，孤立任务标 interrupted，不重放模型调用。
- 图受理错误套用主 Agent 的上下文窗口：按实际成员模型预算校验。
- 输出契约提示误带旧 Value：只发送结构定义，避免旧结果干扰新交付。
- 取消后删除画布的迟到回调可能不断重试不存在的 run：将已级联删除视为清理完成。
- 成员记录面板浅色主题、后台状态文案和未知恢复耗时显示：修正主题变量与文案，未知时间显示“—”。

后端/Pi 与 UI 分别由独立协作 Agent 复审，最终没有未修复的阻断项。这是本次代码与验收的独立复审，不宣称重新进行了 Fable 验收。

## 截图

11 张原始 PNG 的大小与 SHA256 位于最终摘要中。下方按操作顺序列出；较早的过程截图保留当时文案和主题，09–11 是最后的浅色面板、批准记录与聊天效果。第二张文件名虽含 model，画面实际显示成员职责区域，模型执行以持久化记录为证。

1. [成员职责与指令配置](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/01-node-team-config.png)
2. [第二位成员的职责配置](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/02-member-model-config.png)
3. [刷新后团队模式保持](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/03-team-mode-after-reload.png)
4. [关页前：上游运行、下游等待](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/04-running-before-close.png)
5. [重新打开页面：两个节点完成](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/05-reopen-completed.png)
6. [持久化的成员轮次与模型记录](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/06-persisted-team-turns.png)
7. [主动停止后：上游与下游取消](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/07-cancelled-team-and-downstream.png)
8. [深色主题：审核与返工](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/08-review-rework-dark.png)
9. [浅色主题：拒绝后返工](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/09-review-rework-light.png)
10. [最终审核批准](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/10-review-approved.png)
11. [原聊天入口：团队讨论后回答 64](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/11-manual-team-chat.png)

完整便携图文版：[acceptance-report.html](../.local/awwo-saas/node-teams-acceptance-cd0428e6ed05/acceptance-report.html)。

## 复现与清理

自动化命令见开发手册。外部模型验收入口为 `node scripts/awwo-node-teams-acceptance.mjs --provider-stdin`，需要先启动项目专属本地 PostgreSQL。第一行 stdin 传入 provider/model/baseURL/apiKey，随后 run 执行四种模式，collect 收集 API 记录，finish 退出。输入使用保密的 stdin 通道；不要把真实凭据写进命令行参数、文档或 Git。

脚本自动创建独立随机 schema、临时账号与 loopback 服务，使用真实模型会产生调用。浏览器动作及其证据需要另外执行，脚本不会自动证明它们。此次已完成正常运行与 finish 清理；结束时的 EOF/SIGINT 防挂起小改动完成语法检查，异常中断路径未作为完整故障验收项目计数。

本次临时服务均已停止，随机 schema、临时登录文件和编译二进制已删除，provider 密钥仅通过 stdin 与子进程环境使用。由本次启动的项目专属 PostgreSQL 已停止，原数据目录保留。报告中的临时 webURL/apiURL 已失效，不能当作常驻演示地址。

## 未包含及运行限制

- 当前团队执行框架为 Pi 文本推理；tools 数组必须为空。尚未交付工程目录操作、工具权限与沙箱、多个不同执行框架混用。
- Go API/图调度是单实例执行所有权，未实现多副本高可用或分布式 worker。
- 正常关页可继续；进程重启时已受理且结果不确定的调用标 interrupted，不自动重试产生潜在重复调用。未受理且依赖已满足的节点可恢复调度。
- maxTurns 是模型调用次数上限；没有把它当作精确 token 或货币预算。历史面板最多显示最近 50 个图任务，没有全量历史分页导出。
- 原聊天入口有团队调用与最终回复；后台图面板只显示关联图任务的成员轮次。手动聊天成员记录可通过 runs/{id}/turns API 读取。
- 本次新增面板验证了桌面浅色与深色主题，没有重新完成移动端全套验收。Docker 仅解析配置，未执行容器构建/运行。
- 未做公网部署、HTTPS/外层访问门、真实生产负载与灾备恢复验收。上述事项不包含在此次本地功能通过结论中。
