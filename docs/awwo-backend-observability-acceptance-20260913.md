# AwwO 后端可观测性验收报告 · 2026-09-13

## 1. 结论与验收对象

本次已完成的后端回归与实际执行检查通过：Go/PostgreSQL、两个 worker、启动器、双 SDK 协议链路均无失败测试；本地真实 `gpt-5.6` 的四组图执行和一次 Computer Use 手动团队执行共完成 **12 次模型调用**，全部保存为 `completed / reported / provider_raw`。三个独立管理 metrics 端点返回 200，公开业务路径保持隔离。

本报告针对本地后端候选，不代表已 merge、push 或部署 online。未配置真实供应商价格，12 次调用的 `costStatus=unavailable`、金额为 null 是正确结果，不能据此说费用为零。计价公式、舍入、溢出与冻结快照由自动化测试验证；真实价格与供应商账单尚未核定。实际 OTLP 关联/隐私验证及额外冻结价格测试也已通过，证据见第 7 节。

| 项目 | 记录 |
| --- | --- |
| 仓库工作目录 | `/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-backend-observability-20260913` |
| 基线 SHA | `1ffef64ca29be7e79e2a6faf518548a34010f55c` |
| 工作状态 | detached 隔离提交；包含本报告的提交为交付候选，具体 SHA 见本地 `verification-summary.json` |
| 环境 | `APP_ENV=development`，独立本地 PostgreSQL 和后台进程，未对生产执行写入测试 |
| 模型 | 实际配置的 OpenAI-compatible 服务，目录模型 / provider model 均为 `gpt-5.6`，协议 `chat_completions` |
| 代码范围 | Go API/数据库、Pi、OpenAI Agents、后台启动/配置、文档；`apps/web` 本次无代码 diff |
| 实际模型验收时间 | 2026-09-13 18:49:24–18:52:43，Asia/Shanghai |
| 实际 telemetry 复核时间 | 2026-09-13 19:01:11，Asia/Shanghai |
| 实现规范 | [后端机制与 API 契约](awwo-backend-observability.md) |

真实推理使用已配置的模型服务，不将其宣称为 OpenAI 官方直连。报告不记录模型 API key、会话 cookie、数据库凭据或内部 bearer token。测试 tenant / account 为本次本地验收专用。

## 2. 自动化测试

以下数字直接从本次日志的终态计数核对；Go 子测试与其父测试分别计入“含子测试”总数，不能将 121 与 252 相加。

| 测试层 | 结果 | 耗时 | 原始证据 |
| --- | --- | --- | --- |
| 全量 Go + 真实 PostgreSQL，race | **121 顶层 / 252 含子测试 PASS**；0 fail，0 测试 skip | 137.330 s | [go-test-final.jsonl](../.local/backend-evidence/go-test-final.jsonl) |
| Pi worker | **47/47 PASS**；0 fail/skip | 11.748 s | [pi-tests.log](../.local/backend-evidence/pi-tests.log) |
| OpenAI Agents worker | **54/54 PASS**；0 fail/skip | 8.914 s | [openai-agents-tests.log](../.local/backend-evidence/openai-agents-tests.log) |
| 本地启动器 | **11/11 PASS**；0 fail/skip | 0.716 s | [launcher-test.log](../.local/backend-evidence/launcher-test.log) |
| Go → 两种 SDK → 本地协议服务 → PostgreSQL/SSE | **1/1 PASS**；0 fail/skip | 5.998 s | [stack-test.log](../.local/backend-evidence/stack-test.log) |
| 最后补充 PostgreSQL race：冻结价格与 Unicode 游标 | **3 顶层 / 5 含子测试 PASS**；0 fail/skip | 5.492 s | [final-supplement-tests.log](../.local/backend-evidence/final-supplement-tests.log) |

Go 日志中 `awwo/backend/cmd/api` 的 package `skip` 表示该入口包没有测试文件，不是一个 PostgreSQL 测试被跳过；252 个有 Test 名称的终态全部为 pass。早期失败日志保留用于排障，以上采用最终 `go-test-final.jsonl`，没有把失败轮次混入结果。

最后补充测试是全量之后的相关验证，其中游标测试与全量重复，冻结价格集成测试为新增加；因此不把两轮数量机械累加成一个“全量总数”。

关键覆盖包括：

- 迁移 011 两种身份的十项识别矩阵、checksum 漂移拒绝、历史 runtime/model 来源回填；已有数据不会凭当前 Agent 配置猜历史。
- invocation 与业务终态原子提交、幂等结算、每个团队成员独立 ledger、连接丢失保持 unknown、永久落库失败不伪造 completed。
- 租户隔离、四个 API 的角色边界、reader/member 完全不返回费用 key、平台读取审计、NULL/大整数精度、保留边界、数据库不可用返回 503。
- 画布删除后账本仍可汇总/经审计读取；跨页延迟提交被 MVCC snapshot 排除；128 Unicode 字符成员 ID 和 256 字符模型名的游标往返。
- 严格计价 schema、重复 JSON key、冻结价格、分项舍入、缺失特殊 Token 和溢出；24h/30d 快照重建和失败时保留旧视图。
- 管理监听器默认关闭与 loopback 校验、HTTP/SSE 标签、有限模型目录、async Link / 内部传播、实际 OTLP 测试接收器、导出失败不阻塞请求、重定向不携带凭据。
- Worker 真实子进程与 SDK 协议测试、usage 在分块/SSE/IPC/清理过程中保留、missing/zero/partial/cached/reasoning 的区分、shutdown 与容量释放。

这里的 SDK 协议栈使用本地协议夹具；它证明 SDK 与数据库链路，并非外部真实推理。外部推理证据单列于下一节。存在测试名称不等于某个生产场景已验证，本报告只按日志实际执行结果列项。

## 3. 真实模型图执行

原始证据：[real-backend-regression.json](../.local/backend-evidence/real-backend-regression.json)。四组都调用实际模型服务，保留原有容易冲突的 persona/输出格式要求，用于同时回归后端交付契约和观测链路。

| 场景 | 图节点 | 实际 invocation | 实测用时 | 结果 |
| --- | --- | --- | --- | --- |
| 全 Pi 两节点图 | 2/2 done | 2 Pi | 14.460 s | completed |
| 全 OpenAI Agents 两节点图 | 2/2 done | 2 OpenAI Agents | 13.857 s | completed |
| 混合顺序团队 + 下游节点 | 2/2 done | 1 Pi + 2 OpenAI Agents | 14.469 s | completed |
| 混合评审团队 + 下游节点 | 2/2 done | 1 Pi + 2 OpenAI Agents | 19.890 s | completed |

四组 `pass`、`exactDownstreamHandoff`、`durableReload`、`realUsageVerified` 均为 true：上游结果按实际交付内容进入下游，重读仍能恢复完成状态，10 条 ledger 均具有真实 input/output Token 和 provider timing。结果不是只看 HTTP 200，也不是以模型说“通过”作为系统测试通过。

这四组累计：Pi 4 次，OpenAI Agents 6 次；input 10,602、output 1,267，已报告 reasoning 582。Reasoning 是输出 Token 的子集，不能额外加到 input+output 中。全部缓存读/写计数缺失时保持 null。Provider TTFT 是对应请求的真实可观测时间，不能用总 run 时长替代。

本次真实模型图覆盖顺序和评审；并行/辩论、失败/取消及落库故障覆盖由自动化夹具承担，不将它们记为本轮外部真实模型成功样本。

## 4. Computer Use 点击与成员专属指令

通过现有浏览器 UI 登录本地验收工作区、打开混合顺序节点，并在新 Session 中实际输入并发送任务。任务要求李白先给出多租户登录校验要求，再由王伟复核；每个成员保留自己专属指令的标记。

账本与 `/turns` 返回表明：

| 顺序 | 成员 / runtime | 专属指令结果 | Input / output | provider / TTFT |
| --- | --- | --- | --- | --- |
| 1 | 李白 / Pi | 正文以 `【李白指令已触发】` 开头，提出一条校验要求 | 344 / 90 | 3936 / 2877 ms |
| 2 | 王伟 / OpenAI Agents | 正文以 `【王伟指令已触发】` 开头，明确写出“已收到李白结果”并复核 | 446 / 142 | 5117 / 4312 ms |

李白 turn 完成时间早于王伟 turn 创建时间；王伟 `upstreamMembers` 包含李白，prompt 的 quoted prior-member data 包含李白实际输出。两人的冻结 config/system prompt 分别保留成员专属指令，最终 run 为 completed、error 为空。证据见 [management-acceptance.json 的 browserRun](../.local/backend-evidence/management-acceptance.json)，不能仅以截图里最后一个成员的输出推断前一成员未执行。

截图已经逐张核对；它们是实际 UI 状态，不是设计稿。测试内容中的登录要求是模型生成的验收素材，不是新的认证协议实现声明。

**截图 1：本地专用账号与工作区已登录。**

![本地验收账号与工作区](/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-backend-observability-20260913/.local/backend-evidence/01-account.png)

**截图 2：已完成的混合顺序图，团队记录显示 2 次成员调用，李白对应 Pi。**

![顺序团队执行与第一个成员](/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-backend-observability-20260913/.local/backend-evidence/02-sequential-members.png)

**截图 3：新 Session 手动发送后的完成状态，王伟对应 OpenAI Agents，并显示自己的指令标记和接收李白结果。**

![Computer Use 实际点击完成与第二个成员](/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-backend-observability-20260913/.local/backend-evidence/03-browser-click-completed.png)

截图保存在本机 `.local/backend-evidence/`，不默认纳入 Git。它们验证现有前端能操作后端，本次没有为验收改前端产品代码。

后续放大核对了两个成员的实际输出：

**截图 4：李白的独立 turn、Pi runtime、专属指令标记。**

![李白成员实际执行详情](/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-backend-observability-20260913/.local/backend-evidence/04-collaboration-detail.png)

**截图 5：王伟的独立 turn、OpenAI Agents runtime、专属指令标记与接收李白结果。**

![王伟成员实际执行详情](/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-backend-observability-20260913/.local/backend-evidence/05-second-member.png)

浏览器直接打开 invocations JSON API 时发生客户端 `ERR_BLOCKED_BY_CLIENT`。未更换入口绕过客户端阻断，该项**不记为浏览器 JSON 展示通过**。四个 API 的角色、响应和数据库行为已由 HTTP 测试与本地实际 API 请求验证；上述五张截图只证明业务页面点击与成员结果展示。

## 5. Ledger 总量、费用与管理监听器

加上浏览器手动执行的两次调用后，同一验收租户汇总如下。数据取自 management 检查时的完整 ledger API 响应，分页 `nextCursor=null`。

| Runtime | completed / reported | Input | Output | 已报告 reasoning | 费用状态 |
| --- | --- | --- | --- | --- | --- |
| Pi | 5 / 5 | 4,390 | 482 | 197 | 5 unavailable，金额 null |
| OpenAI Agents | 7 / 7 | 7,002 | 1,017 | 491 | 7 unavailable，金额 null |
| 总计 | **12 / 12** | **11,392** | **1,499** | **688** | **全部未配置真实价格** |

`usageSource=provider_raw`，没有以字符数反推 Token。该样本 provider 总量与 computed input+output 可核对；缓存字段仍为 null。聚合 `knownEstimatedCostMicrousd=null`，不是 `"0"`；价格版本为空，不存在“已按真实 gpt-5.6 单价验收”的结论。未来由服务负责人提供实际价格版本后，才能验证真实配置下的估算；供应商最终账单仍独立对账。

| 被测入口 | 结果 | 含义 |
| --- | --- | --- |
| Go API 独立管理 `/metrics` | 200，102,479 bytes | 指标可被私有采集 |
| Pi 独立管理 `/metrics` | 200，6,825 bytes | worker 指标可被私有采集 |
| OpenAI Agents 独立管理 `/metrics` | 200，7,671 bytes | worker 指标可被私有采集 |
| Go 业务端口 `:8287/metrics` | 404 | 不从公共业务 mux 暴露指标 |
| Web 入口 `:5389/api/v1/metrics` | 404 | 没有借业务代理公开 metrics |
| Pi / OpenAI Agents 业务端口 `:8297/metrics` / `:8298/metrics`，无 token | 401 / 401 | 私有 worker 业务认证边界保持有效 |

这里的“公开业务路径”在本地 loopback 上验证，并非对 online 公网域名做了部署验证。三个 metrics body 的本次测试内容泄漏检查均为 false；没有把 request/run/tenant ID 或测试消息用作指标标签。原始 scrape：[api-metrics.prom](../.local/backend-evidence/api-metrics.prom)、[pi-metrics.prom](../.local/backend-evidence/pi-metrics.prom)、[openai-agents-metrics.prom](../.local/backend-evidence/openai-agents-metrics.prom)。

## 6. 本地请求延迟采样

启用此次后台观测配置后，对本地 health 和 tenant usage 各采集 50 个请求；数据见 [management-acceptance.json](../.local/backend-evidence/management-acceptance.json)。

| 接口 | 样本数 | P50 | P95 | Max | 错误数 |
| --- | --- | --- | --- | --- | --- |
| health | 50 | 0.241 ms | 0.401 ms | 0.482 ms | 0 |
| tenant usage | 50 | 0.590 ms | 0.840 ms | 0.922 ms | 0 |

100 个本地请求均成功，说明当前小数据集上查询可用。此结果不是一小时压测、生产延迟 SLO、模型推理延迟或多租户容量上限；没有无埋点对照实验，不能推导“埋点开销为零”。

## 7. 最后补充：冻结价格与实际 OTLP

`TestPostgresInvocationCostUsesReservedPrice` 使用真实 PostgreSQL 和可控模型响应夹具：12 input / 3 output Token，根据测试价格计算为 **48 micro-USD**。调用已派发后修改进程价格目录，终态 API 仍返回 `pricingVersion=test-v1`、`costStatus=estimated` 和 `estimatedCostMicrousd="48"`，且出现已提交费用指标。该断言证明冻结快照参与真实业务落库/API 链路；价格与响应是测试夹具，不是 gpt-5.6 实际报价。与两个游标相关顶层测试一并执行，3 顶层 / 5 含子测试全部通过，日志见第 2 节。

实际运行栈向本地自托管 OTLP receiver 导出，检查结果见 [telemetry-acceptance.json](../.local/backend-evidence/telemetry-acceptance.json) 与 [traces-decoded.json](../.local/backend-evidence/traces-decoded.json)：

- **12 条完整父子链通过**：每次调用的 Go `awwo.runtime.admit` → worker `worker.run` → `worker.provider.call` 使用同一 trace，并具有正确 parent span；其中 Pi 5 条、OpenAI Agents 7 条。
- **13 个异步 root 带 Link**：9 个 run root 与 4 个 graph root，关联触发来源并拥有独立生命周期。
- 解析快照为 **186 批、709 spans**；后续内容隐私扫描覆盖 **217 批**。两者是不同时间范围，不能把 217 批当成 709 spans 的解析分母。
- 24h / 30d 窗口调用数与 Token 均严格对齐 ledger；两窗口仍来自同一批快照，不把 24h 与 30d 相加。真实调用总量为 input 11,392 / output 1,499。
- 未配置真实价格时不输出伪造的 0 费用样本；`unknownCostEmittedAsZero=false`。实际 OTLP 与 metrics 的本次敏感测试内容扫描未发现泄漏，`contentLeak=false`。

这证明本地 exporter、关联与指标对账链路实际工作，并不表示已经部署生产 collector 或保证永不丢 span。队列满、导出超时允许丢遥测的设计边界仍保留。OpenAI 托管 tracing 仍关闭，成功的是本次自托管 OTLP 路径。

## 8. 未通过入口与范围外事项

已执行检查中的客户端阻断：浏览器直接展示 invocations JSON 返回 `ERR_BLOCKED_BY_CLIENT`，未计为通过；业务 UI 点击、HTTP API 和后台运行结果通过。客户端 JSON 展示不作为 backend API 返回正确性的替代证据。

以下不是本次后端实现的已完成事项：

- 真实供应商价格核定、发票对账；目前 live cost 明确 unavailable。
- 自动 ledger 清理 scheduler；`AWWO_USAGE_RETENTION_DAYS` 是已校验策略输入，不会自动删数据。
- 浏览器 RUM / Web Vitals、前端监控页面、Prometheus / Grafana / collector 部署、告警规则与通知运维。
- 一小时持续负载、生产容量结论、SLO 承诺；外部供应商失败、取消等本轮真实付费故障实验。
- Git merge / push、生产迁移、online 部署；基线 SHA 与本地实际运行通过不能替代发布证明。

## 9. 复验入口与证据保存

从仓库根目录执行 worker / 启动器 / 协议栈：

```sh
npm test --prefix apps/pi-worker
npm test --prefix apps/openai-agents-worker
npm run test:saas:scripts
npm run test:saas:stack
```

从 `backend/` 执行 Go 测试，使用独立本地 PostgreSQL；缺少 `AWWO_TEST_DATABASE_URL` 时的 skip 不能当作数据库验收：

```sh
AWWO_TEST_DATABASE_URL='<dedicated local PostgreSQL DSN>' go test -race -json ./... -count=1
```

本轮日志、JSON、scrape 和截图位于 `.local/backend-evidence/`，本报告仅公开测试结果及相对证据位置；该目录不应连同私有 `.env` 一起上传。重新执行真实模型场景会产生实际服务调用，不能拿旧截图替代新候选的验证。最终提交 SHA 和发布状态见本地 [verification-summary.json](../.local/backend-evidence/verification-summary.json)；[截图 HTML 报告](../.local/backend-evidence/acceptance-report.html) 内嵌五张原始截图，可以离线查看。
