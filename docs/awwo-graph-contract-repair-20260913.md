# AwwO 图交付契约修复验收 · 2026-09-13

结论：此前真实验收发现的图交付失败已修复并在本地实际复验通过；两条过期前端测试也已修正。本记录不代表监控建设完成、远端合并或生产部署成功。

## 候选与问题

- 工作目录：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-graph-contract-fix-20260913`，detached worktree。
- 基线：本地 `main` 的 `016b67d6b64910d585b423b446a7c0225ea73c16`。前端测试修复独立提交 `4e716fc`；本文件随图契约修复提交。
- 原失败证据：兄弟目录 `awwo-actual-acceptance-20260913/acceptance-evidence/` 中的 `frontend-real-graph-finding.md`、`frontend-real-graph-api.json`、`16-output-contract-failure.png`。
- 原因：规划生成“只返回简短文本”的 persona，而模板保留多个输出字段。persona 位于系统提示，JSON 格式仅位于任务提示，且无条件提示单文本例外。模型成功返回文字，但 Go 校验报 `Output must be a JSON object keyed by output field IDs`，下游未被放行。
- 两条前端失败来自旧 mock：Pi 标签大小写、缺少已受理 run/issue 身份及原生 settlement 确认。修复保留原断言，并新增等待确认及无重复执行断言；没有修改前端业务代码。

## 修复边界

冻结输出 policy 与 persona 分开存储；成员保留独立身份，图输出格式成为明确的服务端规则。单个 text/markdown 字段允许纯文本，多字段严格 JSON；required、number、boolean、file 校验保持。review 保留外层审批信封，交付序列化在 output 字符串内。追加格式说明纳入上下文及 Worker 长度预算，预算超限在付费模型准入前失败。已有内部 planner 会话更新规范，历史已受理快照不被重写。普通聊天不新增图格式要求。

## 实际执行的验证

| 项目 | 结果 | 范围 |
| --- | --- | --- |
| `node scripts/awwo-saas-test-backend.mjs` | PASS | Go 1.27.1 / PostgreSQL；`go test -race -count=1 -v ./...` 89 个顶层测试、含子测试共 187 个，0 失败/跳过；58 个 PostgreSQL 顶层测试；118.841 秒；`go vet ./...` 通过 |
| 新图派发集成用例 | PASS，6 场景 | Pi、OpenAI Agents、混合 sequential/parallel/debate/review；真实 Go/DB + 受控 Worker HTTP 回应；冻结配置、预算零调用、旧 planner 会话复用 |
| 前端扩展回归 | PASS，99 文件 / 1114 测试 | `npx vitest run --config vitest.saas.config.mjs tests/saas- tests/canvas- --maxWorkers 2`；0 失败/跳过；包含修复后 6/6 run-entry 用例 |
| SaaS typecheck/build | PASS | `npm run typecheck:saas`、`npm run build:saas`；保留已有大于 500 kB chunk 提示 |
| 双 Worker 协议栈 | PASS，1/1 | `node --test scripts/awwo-saas-stack.test.mjs`；真实 Go/PostgreSQL/SDK + 本地确定性模型；SSE、幂等、取消、历史、重启恢复；5.455 秒 |
| 独立源码复核 | 无阻断 | persona 隔离、冻结快照、格式/预算/review、租户与普通聊天边界；见本地 `backend-fix-review.md` |

下列为实际外部 `gpt-5.6` 调用，使用同项目已配置服务，开发环境与全新本地数据库。直接复用原失败画布的 persona、输入和多字段契约，未删除可选输出来掩盖旧场景。

| 场景 | 终态 | 图耗时 | 关键证据 |
| --- | --- | --- | --- |
| 原两节点 / Pi | 2/2 成功 | 13.938 秒 | 多字段 JSON；下游 prompt 包含上游 result 完整内容 |
| 原两节点 / OpenAI Agents | 2/2 成功 | 11.444 秒 | 相同原始格式冲突场景通过 |
| 混合顺序 / 李白 Pi → 王伟 OpenAI Agents → 下游 | 2/2 成功 | 32.514 秒 | 两个成员指令标记、独立 runtime、准确顺序与交接、下游有效结果 |
| 混合审核 / 李白 Pi → 王伟 OpenAI Agents → 下游 | 2/2 成功 | 21.071 秒 | 外层 approved=true，output 内嵌合法图 JSON；两个成员标记及下游交接 |

以上耗时是单次实际样本，不能视为负载测试、延迟 SLO 或性能监控验收。

## Computer Use 点击验证

在正式 Chrome 会话中新建本地测试画布，登录隔离账号后输入原来的同一需求：

> 创建两个顺序连接的 Agent 节点，用于验收：第一个给出多租户登录接口的一条校验要求，第二个检查第一个的结果并给出一句复核意见。只需要两个节点和一条连线，每个交付结果都是文本。

实际点击生成画布，得到两个节点、一条连线、每节点一个文本输出；点击“运行图”后显示 **运行完成：2/2 节点成功**。刷新后聊天结果和交付物仍保留，打开下游输入看到来自上游已发布输出，API 比对实际任务包含原文，且该画布只有一次 graph run。当前完成提示与连线颜色属于运行视图，不以刷新后的临时颜色替代持久化记录。

另打开原多字段混合顺序图，在“团队协作过程”中看到调用 #1 李白 / Pi、调用 #2 王伟 / OpenAI Agents；两个专属指令标记分别出现在实际成员输出中。API 对四组运行再次读取验证终态、成员记录和下游交接未变。

## 本地证据位置

全部位于本工作目录，密钥和口令不写入报告：

- `.local/repair-evidence/repair-report.html`：可独立打开的截图报告。
- `.local/repair-evidence/real-graph-regression.json`：四组真实模型结果及成员记录。
- `.local/repair-evidence/browser-graph-api.json`：实际点击画布、唯一 graph run、完整输入交接。
- `.local/repair-evidence/final-api-verification.json`：再次读取和退出清理结果。临时验证脚本最初误把 logout 期望写为 200；接口正确返回 204，修正后只重做只读核验和清理，未重复付费调用。
- `.local/awwo-saas/graph-policy-backend-full.log`、`.local/frontend-repair/`：完整自动化结果及协议栈证据。
- `.local/backend-fix-review.md`：独立复核及文件摘要。

## 仍未完成的独立事项

监控此前交付的是设计，运行能力尚未建设。原 24 项为 12 未实现、8 基础部分通过、3 阻塞、1 未执行，不应统称 24 个测试失败。按设计公网 `/metrics` 保持不开放、OpenAI hosted tracing 保持关闭；缺少的是内部 9101–9103 指标端点、用量/耗时采集、Prometheus/Grafana/告警及自建 OTel/RUM。推进顺序为迁移身份协调 → 私有指标与用量 → trace/RUM → 独立 staging、通知和 24 小时/7 天观察。没有把这些能力标为已实现或通过。

本次未 merge、push、部署。2026-09-13 fetch 后远端 main/online 为 `463992b87a89ed9515f64ecee3a412115ac939a5`，本地基线与远端仍前进 4、落后 3。后续集成需要保留双方 graph/HTML/runtime 工作，并协调两种迁移 011；本次局部验收不覆盖尚未发生的集成与线上环境。
