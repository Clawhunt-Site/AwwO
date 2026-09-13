# AwwO 后端可观测性与用量接口

本文记录 2026-09-13 后端实现候选的实际接口和边界。工作目录基于 `1ffef64`，完整检查、真实调用与截图见[后端验收报告](awwo-backend-observability-acceptance-20260913.md)；最终提交及发布状态单独记录，本文不是上线证明。适用范围是 Go API、PostgreSQL、Pi worker、OpenAI Agents worker 和后台启动配置。

## 1. 责任范围与数据来源

| 内容 | 本次后端交付 | 外部边界 |
| --- | --- | --- |
| HTTP、调度、模型耗时、TTFT、Token、估算费用 | 埋点、独立管理监听器、持久化用量账本、授权查询 API | 指标可采集不等于监控平台已部署 |
| 调用链 | 向自托管内部 OTLP HTTP collector 导出有限元数据 | 不部署 collector / trace 存储；OpenAI 托管 tracing 仍关闭 |
| 24h / 30d 运维汇总 | 后台周期读取账本，原子替换内存快照 | 不作为账单；不安装 Prometheus / Grafana |
| 租户与平台读取 | 角色隔离、费用字段裁剪、管理员明细读取审计 | 不增加前端页面、Web Vitals / RUM |
| 验收与运行 | 相关自动化测试及单独记录的实际调用验收 | 不包含 SLO 承诺、告警通知、1 小时容量压测或生产部署 |

PostgreSQL `model_invocations` 是持久化用量事实来源。Worker 提供实际 SDK/provider usage，Go 验证并在业务终态事务中保存。Prometheus counter 是本进程观测，重启可归零；窗口 gauge 来源于账本快照，不能把 counter 与 gauge 相加。费用始终是明确价格版本下的估算，不是供应商结算账单。

## 2. 调用生命周期和失败边界

1. Go 接受任务，冻结执行配置；在调度到模型前预留 invocation，保存租户、run、turn/member、runtime、model selector、配置可证明的 provider 元数据和价格快照。
2. 调度记录排队、准入及 worker 执行阶段。每个团队成员独立计数；顺序、并行、辩论、评审仍由 Go 编排。有效模型标签来自经校验的运行时目录，未知值归入有限占位值。
3. Worker 使用版本 1 的终态观测字段返回可选 usage、timing 和失败分类。缺失字段用 null；供应商没有报告的 Token 不做 tokenizer 推算。旧 worker 的版本 0 保留业务输出，观测标记 `unavailable / legacy_worker`。
4. Go 将 invocation 终态与相应 run / message / event 或 team turn 放在同一数据库事务内提交；`completed_at` 与 `completed_xid=pg_current_xact_id()` 同时写入。只有提交成功后才记录相应终态指标。数据库提交重试不重发已接受的模型调用。
5. 启动恢复将未完成且无法确认的调用标为 interrupted，保留已知事实。Provider 已执行但终态尚未落库时进程退出，不能保证事后找回 usage；此时记录 unknown，不自动重放收费请求。

| 状态维度 | 含义 |
| --- | --- |
| `admissionStatus` | `not_attempted / accepted / rejected_before_start / unknown`，独立于业务完成状态 |
| `usageStatus` | `reported` 完整报告；`partial` 仅部分有效字段；`unavailable` 不支持或未提供；`invalid` 非法观测；`unknown` 已准入但结果不能确定 |
| `costStatus` | `not_incurred` 确认未执行；`estimated` 可按快照估算；`unavailable` 无可用价格/语义；`unknown` 消耗不确定；`reconciled` 为未来对账预留 |
| Token 字段 | 非负整数或 null；明确报告的 0 与缺失不同，cached input / reasoning 可能是 input / output 子集 |
| Timing 字段 | API `timingMs` 对象内的 `queue / admission / setup / provider / providerTtft / workerTotal / workerFirstDelta`，非负毫秒或 null；provider TTFT 与 worker 首 delta 不是同一阶段 |

无首个文本 delta 时 TTFT 保留 null。失败调用也可能有真实 Token。准入前明确拒绝的费用状态为 `not_incurred`，金额仍为 null；已准入且没有可确认 usage 的失败不能记为免费。非法观测数据不能抹掉有效的业务输出。数据库中暂缺底层 provider model / protocol 的历史或运行时元数据保持空值，不用 selector 猜测。

本实现没有供应商请求幂等结算、持久化 worker 终态确认队列、发票对账写接口或自动追补账单能力；`reconciled` 只是保留状态。既有单 API 实例数据库租约约束仍有效。

## 3. 实际配置

三个环境使用相同变量名；密钥和端点由各环境分别注入。示例文件均默认关闭导出。修改进程配置后需要重启对应进程，不提供价格或 exporter 热更新 API。

| 变量 | 直接启动进程默认值 | 生效与校验 |
| --- | --- | --- |
| `APP_ENV` | `development` | `development / staging / production`；决定环境标识与安全校验 |
| `AWWO_METRICS_ENABLED` | `false` | Go 与两个 worker；只接受 `true / false` |
| `AWWO_METRICS_LISTEN_ADDR` | API `127.0.0.1:9101`；Pi `127.0.0.1:9102`；OpenAI Agents `127.0.0.1:9103` | 每进程独立；必须是 literal loopback IP，不能设为 `0.0.0.0` 或公开主机名 |
| `AWWO_OTEL_ENABLED` | `false` | Go 与两个 worker；启用时必须有内部 collector endpoint |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 空 | 自托管内部 HTTP(S) URL；不允许 userinfo、query、fragment；staging / production 离开 loopback 必须 HTTPS |
| `OTEL_SERVICE_NAME` | `awwo-api / awwo-pi-worker / awwo-openai-agents-worker` | 对应进程固定名称，不能把同一个 API 服务名复制给 worker |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | 当前唯一支持值 |
| `OTEL_TRACES_SAMPLER_ARG` | development / staging `1`；production `0.05` | 0..1；Compose 显式默认统一为 `0.05`，覆盖直接启动默认值 |
| `OTEL_RESOURCE_ATTRIBUTES` | 空 | Go 仅允许匹配实际环境的 `deployment.environment[.name]`、匹配编译 revision 的 `service.version`；worker 忽略任意外部属性 |
| `AWWO_MODEL_PRICING_JSON` | 空 | 仅 Go；严格版本化计价 JSON；空配置不影响实际 Token 保存，费用不可估算 |
| `AWWO_USAGE_RETENTION_DAYS` | `180` | 仅 Go；31..3650；只校验保留策略输入，当前没有自动删除任务 |
| `AWWO_REVISION` | `unknown` | worker 版本描述；Go 使用编译进构建的 revision，不能靠此变量修改 |

使用仓库本地启动器时，共用 `.local/awwo-saas/.env` 的开关由 `serviceEnvironments()` 分配到三个后台进程；启动器强制各自 service name。`AWWO_METRICS_LISTEN_ADDR` 只覆盖 API；worker 可用启动器专属 `AWWO_LOCAL_PI_METRICS_LISTEN_ADDR` / `AWWO_LOCAL_OPENAI_AGENTS_METRICS_LISTEN_ADDR` 覆盖各自监听地址。模型凭据不会交给 Web 进程。

`deploy/saas/compose.yml` 已向三个后台服务转发 metrics / OTLP 开关、endpoint、sampler 和 worker revision；API 另接计价、保留策略和 metrics 地址。服务名由 Compose 固定。管理端口不发布到宿主机或 ingress；每个容器的 loopback 只在其网络命名空间可达。实际部署时采集方需配置对应命名空间的私有访问，不能把 metrics 改成公网监听。本次未部署采集方。

Compose 不转发 `OTEL_RESOURCE_ATTRIBUTES` 或 HMAC key 文件。`AWWO_TRACE_REF_HMAC_KEY_FILE / KEY_VERSION` 及 previous 版本目前有 Go 配置校验与引用 helper，但生产 span 尚未调用该 helper；不把它们列为已接通的业务关联能力。当前导出的 span 直接省略原始业务 ID。没有受支持的 `OTEL_EXPORTER_OTLP_HEADERS` 凭据注入接口；不能假设设置任意 OTEL 环境变量就会生效。

## 4. Metrics 与 trace 安全边界

启用 metrics 后，三个后台进程在各自管理监听器提供 `GET /metrics`；Go 管理监听器还提供 `GET /healthz`，成功返回 204。Worker 管理监听器只提供 metrics。Go 业务监听器没有 `/metrics` 路由，直接请求得到 404 是预期边界；前端 ingress 的响应由其路由配置决定。端口占用或配置非法导致服务启动失败，不悄悄开放其他地址。

Go 指标包含 HTTP 请求数 / 延迟 / in-flight、SSE 握手、run 排队、runtime 准入、invocation、Token、估算费用、provider duration / TTFT、账本提交、数据库池以及图与团队状态。HTTP 标签使用 route 模板而非具体 URL；模型标签由校验后的目录约束，不使用 tenant/user/run/session ID、prompt 或错误原文作为标签。

Worker 指标包括 `awwo_worker_invocations_total`、`awwo_worker_duration_seconds`、`awwo_worker_provider_duration_seconds`、`awwo_worker_provider_ttft_seconds`、`awwo_worker_first_delta_seconds`、active / capacity 和进程内存。Worker 不重复输出账本费用；Go 账本负责计价权威值。

Go 在 metrics 启用时启动 24h / 30d 账本快照：启动后刷新一次，再每分钟刷新；两个窗口来自同一只读 Repeatable Read 事务和同一 cutoff，并原子替换内存视图。单窗口最多 2048 组，查询时间受限；任一窗口失败保留整份旧快照。scrape 不执行聚合 SQL，暴露快照时间和 age；首次尚无成功快照时不制造全零窗口。日常计数可能因进程重启与快照刷新时机不同，精确查询使用 usage API。

OTLP 仅发送固定 span 名和有限运行元数据。禁止导出 prompt、system instructions、消息正文、输出、工具参数/结果、Authorization、provider 错误正文与原始业务 ID。外部浏览器传入的 traceparent / baggage / tracestate 不作为可信父级；异步 Go run 建立独立生命周期并关联本地请求 span，内部 worker 传播限于受信的私有调用。

Go exporter 使用有界批处理队列，worker 使用有界 JSON OTLP 队列，导出请求有超时且不无限重试；失败计数不包含 collector 返回正文。队列满或 collector 不可用允许丢 span，不能阻塞模型收费链或伪装业务失败。`AWWO_OTEL_ENABLED` 与 OpenAI SDK 托管 tracing 分开；后者继续显式关闭。自托管 collector 的存储访问控制、留存和告警属于运维交付。

## 5. 四个授权只读 API

下表路径均需加 `/api/v1` 前缀，沿用会话 cookie、租户成员与平台权限中间件。租户 owner 不自动拥有平台管理员权限。

| GET 路径 | 权限 | 参数和返回 |
| --- | --- | --- |
| `/tenants/{tenantId}/usage` | tenant admin / owner | 必填 `from,to,groupBy`；可选 `pageSize,cursor`；`{items,page:{nextCursor},freshness}` |
| `/tenants/{tenantId}/runs/{id}/invocations` | tenant reader / member / admin / owner | 可选 `pageSize,cursor`；同一租户存在的 run；`{items,page:{nextCursor},freshness}` |
| `/admin/observability/summary` | platform admin | 可选成对的 `from,to`，默认最近 24h；可选精确 `tenantId`；`{summary,freshness}` |
| `/admin/observability/invocations/{id}` | platform admin | 精确 invocation ID；`{invocation}`；读取成功同事务写审计 |

非本租户成员或跨租户 run 返回 404，租户内角色不足返回 403。reader / member 的 invocation DTO **完全没有** `costStatus,estimatedCostMicrousd,currency,pricingVersion,priceSnapshot` 这些 key，不能仅赋 null。admin / owner 可见费用字段；平台单条查看也可见，审计 action 为 `observability.invocation.read`。平台 summary 指定 `tenantId` 时审计 `observability.summary.read`，不提供默认租户排行榜。

公共 invocation DTO 含运行身份与元数据、业务状态、准入状态、usage status/source/reason、Token、分阶段毫秒、失败分类和创建/准入/完成时间；不含 prompt、会话正文、产出正文或原始 provider 响应。删除已完成画布后该 run API 返回 404，但原 invocation 可继续进入租户汇总和经审计的平台精确查询。

### 时间、分组和分页

- `from/to` 必须为以 `Z` 结尾的 UTC RFC3339 时间；`from < to`，区间采用 `[from,to)`，最长 92 天。`to` 最多容忍 1 分钟时钟偏差。`groupBy` 仅允许 `day / agent / model / runtime`；model 分组值为 `runtime:selector`。
- `pageSize` 默认 50，范围 1..100。费用汇总按分组值、currency、pricingVersion 完整排序，同一模型不同价格版本不会混成一组；run 明细按 `created_at,id` 排序。
- 游标签名绑定 actor、tenant、资源及时间 / 分组筛选。继续分页必须保留原筛选；每页重新检查当前权限。HMAC key 每个 App 实例随机，重启或切换实例后返回 400 `invalid_cursor`，应从第一页重新取。有效期最长 24h。
- 首次捕获 `asOf` 和 PostgreSQL `pg_current_snapshot()`；聚合使用 `completed_xid` 的可见性，run 列表使用 `created_xid` 的可见性。即使另一事务在第一页之前写入时间戳、之后才提交，也不会进入后续页。每页使用短事务，不跨 HTTP 请求保留长事务。
- run 分页冻结的是行集合：当时可见的 running 行仍可能在后续页显示新的状态/usage。聚合分页依赖终态账本不再改写；它不是支持任意后续历史更正的数据库备份协议。刷新第一页获取最新集合。
- 单个 snapshot 超过 8192 字节返回 503 容量保护；原始 cursor 上限 16 KiB，排序 key 上限 2048 UTF-8 字节，覆盖已接受的 128 字符成员 ID 和 256 字符模型名。不要解析或修改 opaque cursor。

### 数字、NULL 和 freshness

Token、计数和 micro-USD 用十进制 JSON **字符串**传输，避免 JavaScript 超过安全整数范围；明确的零为 `"0"`，缺失为 null。Timing 毫秒为 JSON 整数或 null，summary 比率 / 平均值为 JSON 数值或 null。

聚合每组返回 `invocations` 的 completed/failed/cancelled/interrupted 计数，`usageSamples` 的 reported/partial/unavailable/invalid/unknown 计数，`tokens` 的 input/output/cachedInput/cacheWrite/reasoning，`knownEstimatedCostMicrousd` 和各 `costSamples`。Token 仅汇总 reported/partial 的已知字段；全部缺失的 SUM 返回 null，不补 0。已知成本只汇总 estimated/reconciled，调用者必须同时显示未知样本数，不能把部分已知和称为完整账单。

`freshness.source="ledger"`，`asOf` 是读取 cutoff，`retainedFrom` 是已知保留边界，`stale=false` 表示本次账本查询成功。tenant aggregate 成功还返回 `completeForRequestedRange=true`，含义是请求范围在保留边界内，不代表所有 provider 都报告了 Token。数据库不可用时返回 503，不伪造 stale=false 的缓存结果。

summary 返回 invocation 数、failed/interrupted 数、unknown usage 数、errorRate、meanProviderMs、meanProviderTtftMs，以及 `protocolVersions` 的版本分布。它没有分页；同一次短事务读取，默认 24h，不是 Prometheus 查询代理。

错误结构为 `{error:{code,message,requestId,details}}`。常见错误：400 `invalid_time_range / invalid_group_by / invalid_pagination / invalid_cursor`，422 `range_too_large / range_not_retained`，503 `usage_unavailable`。超保留边界时 `details.retainedFrom` 说明可查询起点。SQL statement timeout 为 3 秒，请求处理 context 为 4 秒；失败不泄露 SQL 或数据库错误正文。

## 6. 计价快照

`AWWO_MODEL_PRICING_JSON` 接受以下 schema。此处 `fixture-model` 和价格只演示整数算术，**不是 gpt-5.6 或其他供应商的真实价格**；真实配置需由模型服务负责人提供。

```json
{
  "version": "fixture-v1",
  "currency": "USD",
  "models": {
    "openai-agents:fixture-model": {
      "ratesMicrousdPerMillion": {
        "input": "2000000",
        "cachedInput": "500000",
        "cacheWrite": null,
        "output": "8000000",
        "reasoning": null
      },
      "semantics": {
        "cachedInput": "replace_input_rate_for_subset",
        "cacheWrite": "unsupported",
        "reasoning": "included_in_output"
      },
      "rounding": "half_up_per_component"
    }
  }
}
```

金额单位为 micro-USD（1 USD = 1,000,000 micro-USD），rate 单位是 micro-USD / 百万 Token。每个非 null rate 必须是规范非负 int64 十进制字符串，不允许浮点、JSON number、负数或前导零；未知字段、重复 JSON 属性和冲突语义导致配置拒绝。整个 JSON 不超过 256 KiB，最多 256 个模型，version 长度 1..100 字节，currency 当前只支持 USD。

价格键限定为 `pi:` 或 `openai-agents:` 加 1..200 位 ASCII selector（首位字母/数字，其余允许字母数字和 `._:/-`）。它比业务模型名的 Unicode 上限更严格；无法匹配计价键的模型仍可运行，但估算费用为 unavailable，不自动套用其他模型价格。

| 分类 | 可选语义 |
| --- | --- |
| cachedInput | `replace_input_rate_for_subset`：从 input 中扣出缓存子集后分别计价；`included_in_input_rate`：已含输入单价；`additional_surcharge_on_subset`：在完整输入费用上附加缓存子集费用 |
| cacheWrite | `included_in_input`：已含输入；`additional`：独立增加；`unsupported`：不支持计价 |
| reasoning | `included_in_output`：已含输出；`additional_surcharge_on_subset`：在输出上附加；`unsupported`：不支持计价 |

需要特殊单价的语义必须配置对应 rate；included / unsupported 的对应特殊 rate 必须为 null，避免重复收费。缺少计算所需 Token，即便总 Token 已知也不猜子集。rounding 只支持 `floor_per_component / ceil_per_component / half_up_per_component`，每个费用分量乘 Token 后除 1,000,000，再按规则取整、相加；乘法与总和均检查 int64 溢出。溢出或语义不可计算时费用为 unavailable。

例：上述夹具配置下，input=1,000,000、cachedInput=200,000、output=100,000、reasoning=20,000，费用为 1,600,000 + 100,000 + 800,000 = 2,500,000 micro-USD，即 2.50 USD；reasoning 已含 output，不额外相加。

Go 在派发前将对应模型的 version/currency/catalogKey/rates/semantics/rounding 冻结进 invocation。进程重启使用新价格只影响之后预留的调用；已有快照不可用当前配置重新解释。缺模型、缺价格或缺 usage 时保留事实和 null 费用；没有自动实时价格抓取、汇率转换或账单对账。

## 7. 迁移、保留与兼容

历史编号 011 有两种内容：运行时分支增加 `agents.runtime`；远端图协作分支增加 collaboration 表/列。原迁移记录只有整数版本，不能据 version=11 判断实际结构。

| 迁移 | 行为 |
| --- | --- |
| 012 `graph_collaboration_reconcile` | 在同一 advisory transaction lock 下识别两组真实 schema；缺完整一组时仅补该组，完整两组不重复修改。保留原 011 文件、版本记录和 applied_at；新增 migration identity + checksum 记录 |
| 013 `model_observability` | 增加 invocation metadata、版本、nullable usage/timing、价格快照和保留边界；旧 usage/cost 明确 unavailable。账本改为 tenant 外键，逻辑 run_id 在画布/run 删除后保留 |
| 014 `usage_snapshot_identity` | 增加 created_xid / completed_xid；从已接受 runs.execution_snapshot / run_turns.config 回填历史 Pi / OpenAI Agents 来源，不能读取当前可编辑 Agent 猜历史；旧终态 xid 在迁移事务中回填 |

识别矩阵覆盖空库、仅 runtime、仅 graph、两者均有；列类型、NULL、默认值、check、主键/唯一约束和外键均参与校验。部分结构、错误默认值/约束/FK 或未知签名拒绝启动，错误为 `migration identity mismatch; schema requires operator review`。012–014 已记录 identity 的 SQL checksum 漂移也拒绝启动。不能以删除版本行、改原 011 内容或盲目 `IF NOT EXISTS` 绕过校验。

此迁移方案不等于已吸收最新远端代码。候选基线及远端 graph-011 的内容有明确溯源；实际合并仍需单独审查 source/target SHA。新应用启动前应备份目标数据库并在同构隔离数据库演练；本次没有在生产数据库执行迁移。

`usage_retention_boundaries` 存每租户 `retained_from`，尚无边界记录默认 epoch。**自动保留清理关闭，`AWWO_USAGE_RETENTION_DAYS=180` 不会定时删数据。**未来清理必须原子推进边界并明确备份、对账与法律要求；当前没有该 scheduler/API。删除完整租户仍可通过 tenant 外键删除其账本，保留承诺不覆盖租户删除。

## 8. 验证记录与验收要求

集成结果见[2026-09-13 后端验收报告](awwo-backend-observability-acceptance-20260913.md)：全量 Go/PostgreSQL race 121 顶层 / 252 含子测试通过、Pi 47、OpenAI Agents 54、启动器 11、双 SDK 协议栈 1 全部通过且无测试 skip；追加冻结价格和游标回归 3 顶层 / 5 含子测试通过。四组真实 gpt-5.6 图执行加一次 Computer Use 团队执行共 12 次调用均报告真实 usage；三个管理 metrics 为 200，业务路径隔离正确。12 条实际 OTLP 父子链、13 个 async root Link、24h/30d 窗口对账及测试内容隐私检查通过。报告同时列出尚未配置真实价格、浏览器直接展示 JSON 被客户端阻断和未部署边界。

本轮存储/接口专项已在独立本地 PostgreSQL 上执行 race 测试：13 个顶层测试 / 含子测试 23 项，0 失败、0 跳过，7.443 秒。覆盖迁移十种矩阵、checksum 漂移、冻结来源回填、严格价格 schema / 舍入 / 溢出、角色与租户隔离、费用字段裁剪、NULL/超安全整数、审计、保留边界、数据库故障、画布删除后账本保留，以及延迟提交的 MVCC 分页。

追加 Unicode 游标修复已通过真实 PostgreSQL race 回归：2 个顶层 / 含 agent、model 子测试共 4 项，0 失败、0 跳过，3.777 秒。覆盖 128 字符（512 UTF-8 字节）成员标识、256 字符（1024 字节）模型名的前后页以及超过排序 key 上限的拒绝。完整 Go/worker 回归、真实 Pi / OpenAI Agents 调用、OTLP 接收和管理监听器实测由集成验收报告统一记录；本文的专项记录不代替最终集成报告。测试夹具能验证数据库和协议边界，不能代替真实供应商 usage 可用性。

复验命令（从 `backend/`，使用独立本地测试数据库；不要把真实 DSN 写入报告）：

```sh
AWWO_TEST_DATABASE_URL='<dedicated local PostgreSQL DSN>' go test -race ./internal/app \
  -run 'TestUsageAPI|TestUsageCursor|TestUsageLedger|TestUsageMVCC|TestMigration|TestPricing' -count=1 -v
```

实际调用验收应逐项留证：两种 runtime 的真实成功终态与账本匹配、失败/取消没有伪造 Token、派发次数没有因数据库重试增加、顺序/并行团队按成员保存、管理 metrics 与公开路由隔离、collector 不可用时业务仍完成，以及导出内容没有消息或密钥。定价测试只能证明所配置公式与快照，不证明示例价格是供应商现价。

本次仅交付后端；浏览器 RUM、Prometheus/Grafana/collector 部署、SLO/告警通知、1 小时压测、远端合并推送和 online 部署需要各自独立证据，不能由本文或本地测试状态推导为完成。
