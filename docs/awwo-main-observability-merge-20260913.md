# AwwO 后端候选合并验收 · 2026-09-13

## 对象与授权

- 操作者在当前会话明确批准：将候选 `4b2de674f7ee1b35eae695b943edb26e008a22bf` 合入 `main@463992b87a89ed9515f64ecee3a412115ac939a5`，处理重叠文件并回归。
- 重新 fetch 后，`origin/main` 与 `origin/online` 均仍为 `463992b`；本地旧 `main` 为 `016b67d`。从批准的目标建立 detached 隔离 worktree，保留两个父提交的完整历史。
- 工作目录：`/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-main-observability-merge-20260913`。
- 本次完成的是批准的本地合并与组合回归。推送、online 引用更新、生产迁移和部署须按实际动作分别记录，不以分支名称或本地测试代替部署证据。

## 冲突处理与兼容性

四个实际冲突文件为 `database.go`、`graph_contracts.go`、`graph_runs.go` 和 `creator.md`。

1. 数据库保留新版 schema-aware 迁移：新库从 runtime 011 开始，实际历史 graph-collaboration 011 由 012 补齐。保留两份历史 SQL，012–014 保留 checksum 验证，不重写旧 version 11 的应用时间。
2. HTML 进入冻结输出策略：单 HTML 字段允许完整文档，多个字段仍要求按字段 ID 序列化为 JSON；`html/head/body` 文档校验、真实文件交付及外链展示约束保留。
3. 选中节点协作的 review 子 run 使用服务端点评策略；proposal 和 synthesis 仍使用初始冻结的交付策略。每一阶段保留独立身份、历史、运行时、调用账本和配额约束。
4. 保留远端的会话占用检查、协作轮次、部分交付标记与消息展示元数据。新增后端回归证明 Pi/OpenAI Agents 混合的五个阶段可完成，运行期间修改 Agent 指令不影响已冻结的角色，点评不会覆盖 HTML 最终产物。
5. 两方 `creator.md` 来源记录均保留，并补记本次隔离工作目录。
6. 补齐选中节点协作的图/节点状态指标：只有提交成功后才计数，失败回滚和重复取消不计数；已经完成的 turn 重放不能重置后续节点状态或覆盖交付物。

前端只做双方现有改动的合并兼容：34 个远端独有文件与 `463992b` 逐字一致；3 个自动合并的重叠文件保留 HTML/协作展示及 Pi/OpenAI Agents 运行时支持。本次没有新增前端产品功能。

## 回归证据

所有执行均为本地 development；PostgreSQL 使用现有本地实例上的独立随机 schema。SDK 集成的上游为本地协议夹具，无生产写入或外部真实模型调用。

| 检查 | 结果 | 证据目录 |
| --- | --- | --- |
| 首轮完整 Go / PostgreSQL race | 137 顶层、280 含子项，全通过，0 测试跳过，163.748 秒 | `.local/merge-go-evidence/go-test.jsonl` |
| 迁移 focused race | 5 顶层、15 含子项，全通过；含远端真实 011 文件升级 | `.local/merge-db-evidence/` |
| Pi | 47/47，无跳过，11.538 秒 | `.local/merge-workers-evidence/pi-tests.log` |
| OpenAI Agents | 54/54，无跳过，8.933 秒 | `.local/merge-workers-evidence/openai-agents-tests.log` |
| Launcher | 11/11，无跳过，0.712 秒 | `.local/merge-workers-evidence/launcher-tests.log` |
| Go + PostgreSQL + 两 SDK 协议集成 | 1/1，无跳过，5.392 秒 | `.local/merge-workers-evidence/stack-test.log` |
| 协作指标事务与重放 race | 4 顶层、9 含子项，全通过，8.741 秒 | `.local/merge-workers-evidence/collaboration-metrics-summary.json` |
| 舍入测试独立性 | `TestPricingRoundingOverflowAndSpecialRates` 连续 100 次 race 通过，2.552 秒 | `.local/merge-go-evidence/pricing-fixture-repeat.json` |
| SaaS Web | 36 文件、375 用例全通过 | `.local/merge-evidence/frontend-saas-test.log` |
| Canvas / runtime picker | 79 文件、982 用例全通过 | `.local/merge-evidence/frontend-verification.json` |
| 静态与构建 | Go vet、两 worker check、TypeScript、SaaS build、静态 UI、Compose config 通过 | 对应证据目录 |

前端两组选择有重叠，不能相加成独立用例数量。第一次扩展前端测试因 cwd 错误产生一个路径错误；在标准 `apps/web` 目录完整重跑后通过，未以改代码掩盖路径问题。构建保留 883.21 kB 主包的体积警告，本次不开展前端性能重构。

指标补齐后的第二轮全量出现一次 `TestPricingRoundingOverflowAndSpecialRates` 失败：测试循环遍历无序 Go map，将最后一种 rounding 留给后续断言，若最后为 floor 就与预期 half-up 不符。修复仅为每种舍入测试复制独立 snapshot，不改业务计价算法，不放宽断言。原失败日志保留为 `go-test-before-pricing-fixture-fix.jsonl`，修复后单用例重复 100 次通过并再次完整重跑。

最终完整 Go / PostgreSQL race 在全部修复后通过：**141 顶层、290 含子项，0 失败、0 测试跳过，169.804 秒**。原始日志为 `.local/merge-go-evidence/go-test-final.jsonl`。最终源文件哈希与验收工作树一致；合并提交及本地 main 落点记录在 `.local/merge-evidence/merge-verification.json`。

Codex 独立审查提出的协作指标缺口已经修复。Gemini 初次需要执行命令的审查被其 headless 权限拒绝，未扩大权限；改用纯文本 diff 审查。其后提出的两个上下文生命周期 P1 和一个 HTML fence P2，在提供完整辅助函数、调用位置和已有测试后全部撤销，最终没有剩余 P1/P2。该顾问只进行了所提供代码的静态审查，不替代实际测试；原始失败、审查、复核记录均保留在 `.local/merge-evidence/gemini-*.log`。

## 与先前实际验收的关系

[后端实际验收报告](awwo-backend-observability-acceptance-20260913.md) 记录源候选上 12 次真实模型调用、Computer Use 点击、五张截图、OTLP 父子关联及进程重启恢复。那些原始证据保留在前一隔离目录；本次没有把旧截图或真实模型运行重新标记为合并后新测。

本次组合回归不证明生产已迁移、真实供应商价格已配置、Prometheus/Grafana/告警通知已部署，也不等于长时容量测试。这些运维边界与原后端验收一致。
