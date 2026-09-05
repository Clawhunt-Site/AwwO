# 运营侧可观测与诊断埋点路线图（Observability & Diagnostics）

> **范围**：面向**内部运营/管理人员**的可观测、审计与**诊断级埋点**系统。**不占用任何终端用户 UI**；数据**本地采集、本地落盘、按需经 CLI 导出**到运营自己的分析工具；**绝不实时上传用户数据**。
>
> **状态图例**：✅ 已完成 ｜ 🚧 部分已建 ｜ 🔧 有代码级实现方案（待开工）｜ 📝 仅设计/规划 ｜ ❄️ 冻结
>
> **当前状态**：🔧 设计已经三方对抗式评审定稿（两轮设计 + 一轮文档忠实度核验，Codex gpt-5.5 + Antigravity Gemini 3.1 Pro）；**代码尚未开工，P0a 为下一步**。

---

## 0. 三条硬约束（业主拍板，不可动摇）

1. **不占用 UI**：给内部运营/管理人员用，不是终端用户产品功能。Web/Desktop/API **不新增**任何观测面板/页面/导出端点。
2. **可导出到运营自己的工具**：详细数据能导出成外部分析工具（DuckDB/Excel/任意）可直接消费的格式，在业主自己的工具里看。
3. **绝不实时上传用户数据**：无 phone-home telemetry、无实时遥测推送。采集与落盘在本地；**导出是 operator 本地主动拉取（pull）动作**，而非后台 push。隐私 **fail-closed**。

### 必须遵守的项目铁律
- **CLI 是唯一事实源**：能力先进内核 → CLI 暴露；API/Web/Desktop 只投影，不并行实现。
- **表层零新增语义**：本系统是纯 CLI + 内核能力，**API/Web/Desktop 完全不碰导出**。
- **fail-closed 治理**：任何网络外发默认拒绝，需人审 + 已批准权限，走既有治理 choke point。
- 禁裸 `except`、禁 `print` 入生产、用 structured logging、无硬编码凭证/路径。

---

## 1. 现有地基（已盘点，复用而非重造）

单一事实源是 `~/.superclaw/state.db`（SQLite）+ 若干 JSONL：

| 子系统 | 位置 | 内容 |
|------|------|------|
| 费用计费埋点 | `models.py` CostEvent；`state.py` `record_cost_event`/`list_cost_events` | token/cost/duration 全维度，幂等，可按 run/agent/company/workspace 归因，billing_lane(relay\|byo) |
| 证据留痕 | `models.py` EvidenceBundle；`plugin_evidence.py` | 每 run 一份，probes/commands/worker_results/artifacts/findings；7 天过期 + 锁定（denied/error/timeout 拒清理） |
| 秘密访问审计 | `models.py` SecretAccessEvent；`secrets_store.py` | create/rotate/resolve/denied/archive/delete 全记录 |
| Relay 账务审计 | `relay_key.py` → `~/.superclaw/relay-audit.jsonl` | append-only，**字段白名单 + 脱敏 + 0600**（质量最高的范本） |
| 显示事件协议 | `display_contracts.py`/`display_projection.py` | 统一 DisplayEvent 投影，带 degraded/truncated 标记 + `redact_secrets()` |
| 实时事件流 | `agent_runtime/bus.py` EventBus + SQLite `events` 表 | SSE doorbell，SQLite events 表是唯一真实源 |

### 已知缺口（传统 logging / 诊断可观测性侧几乎为零）
- **无根 logging 配置**：仅 3 处 `getLogger`，无 basicConfig/dictConfig → 生产里日志很可能被吞、不可见。
- 无 `LOG_LEVEL` env 控制；无日志文件/轮转；无 FastAPI 请求日志中间件。
- **无跨异步/多进程/subagent 的 trace 上下文传播** → 调用链断裂，诊断无法还原拓扑。
- 无统一"导出运营数据"的 CLI；数据散在 state.db 多表 + 多个 JSONL，无诊断 span 层。

---

## 2. 设计决策（三方对抗式评审定稿，含被否决方案的留痕）

> 评审方法：主代理出方案 → Codex(gpt-5.5) + Antigravity(Gemini 3.1 Pro) 各自对抗式批判（目标挑错非捧场）→ 主代理综合裁决。两轮（v1 审计导出维度 + v2 诊断/复现维度），关键结论如下。

| 议题 | 被否决的初稿 | 定稿（三方收敛） |
|---|---|---|
| 数据组织 | SQLite 跨源"上帝视图" | **应用层迭代器（DAO）** 流式读异构源 → 统一模型 → 脱敏 → 写出；配 `manifest.json` 记录快照时刻/源/行数/哈希 |
| 导出格式 | jsonl/csv/parquet/duckdb/sqlite 全上 | **JSONL + CSV + SQLite 单文件**；Parquet/DuckDB 降为可选 extra（缺依赖给可操作报错，不污染核心依赖） |
| 隐私强制 | "本期不写外发代码"（靠纪律） | **类型层 + 网络层硬切断**：`--out` 只收本地 Path、拒 URL；导出进程禁网络 client；CI 静态检查锁死 `httpx/requests/urllib/socket` 仅限已批准 wrapper |
| correlation | 绑 FastAPI 中间件 | **内核层生成**（contextvar）：`trace_id/run_id/span_id/export_id`；API 中间件只透传 header。覆盖 CLI/run/export，不止 HTTP |
| 脱敏分级 | `--redact full\|operator` 双标档 | **取消 operator 档**；分级仅作元数据，导出**不靠它**：集中白名单投影 + **默认关闭** + 高熵字符串/常见 key 动态兜底；归因用 **HMAC 哈希**（掩码明文又能分组统计） |
| 复现 | `superclaw repro <run_id>` 逐字复现 | 对非确定性 agent 是**过度承诺** → 降级为**条件重建 + 决策回放 + 根因定位**；录制当时 LLM/tool 真实 I/O，以 **dry-run mock 回放**验证逻辑分支 |
| **Tier C 导出** | operator 显式 + 加密可导出 | **默认禁止离机**：只允许**原地诊断** `--local`（内存解密查看，绝不生成可外带文件）。未来放开只能片段级 + 强审计 + 短 TTL + 业主批准 |
| 存储 | span 实时写 state.db | **库级物理隔离**：A→state.db 事实表；B→独立 append-only（telemetry 库/JSONL）+ 内存 ring buffer 异步批量刷盘；C→短期文件。治理/拒绝决策**绝不采样** |
| 诊断事实归属 | 新建并行 span 通道 | 避免"第四套事实通道"双写漂移：**span/诊断事件成为内核"诊断事实源"，DisplayEvent 与导出皆从它投影；evidence 继续只存工件**，不当时序主账本 |
| 埋点规范 | `span()` 散点 + AST 测"有没有调 span()" | **形式主义灾难** → **框架 choke point 自动埋点**（Tool/Backend 基类、EventBus 入口装饰器/hook），业务代码不写 span()；架构测试只验 **choke point 有 receipts** |

**三个必须先压住的高危**：① Tier C 通用导出；② 把"复现"说成可保证；③ 把埋点测试做成"有没有写 span()"。

---

## 3. 数据分级（Tiered，按敏感度 × 诊断价值）

| Tier | 内容 | 保留 | 导出 |
|---|---|---|---|
| **A — 审计/统计** | 稳定 ID、归因哈希、model、token/cost、状态、时间、脱敏错误码 | 永久（state.db 事实表） | ✅ 脱敏后可导出 |
| **B — 诊断 span** | "发生了什么 + 决策 + 时序 + 错误"，**无原始敏感载荷**：tool 调用键名结构/值脱敏/result 摘要/耗时/exit/重试、治理决策(approved/denied+理由码)、状态转移、异常类型+脱敏堆栈 | 中期（独立 telemetry 库/JSONL，异步刷盘） | ✅ 默认脱敏可导出 |
| **C — 复现/原始载荷** | 原始 prompt、完整命令输出、env 指纹、附件、录制的 LLM/tool I/O | 短期（7 天文件，对齐 evidence） | ❌ **永不离机**；仅 `--local` 原地查看 |

**绝不进任何导出**：明文 secret/API key/bearer/cookie/OAuth token、带 query 或 userinfo 的 URL、私有 webhook、环境变量值、完整 `.env`、原始 prompt/transcript 未分类文本、未脱敏命令输出。

---

## 4. 终态架构

```
   触发(CLI / API / subagent)
        │ 内核生成 trace context: trace_id / run_id / span_id / export_id
        │ ★跨异步·多进程·subagent 显式传播(inject/extract) —— 诊断命门
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  内核诊断事实源 (single source of diagnostic truth)         │
  │  框架 choke point 自动埋 span(Tool基类/Backend基类/EventBus)│
  └───────┬─────────────────────┬───────────────────┬──────────┘
   异步 ring buffer 批量刷盘      投影                  投影
          ▼                      ▼                     ▼
  物理隔离存储(分级)        DisplayEvent(展示)    导出/诊断(脱敏后)
  ├ Tier A → state.db 事实表(统计/审计,永久)
  ├ Tier B → telemetry 库 / JSONL(诊断 span,中期,独立库)
  └ Tier C → 短期文件(原始载荷+录制 I/O,7天,★永不离机)
          │
          ▼ 经 CLI 暴露(API/Web 完全不碰导出)
  superclaw export   --kind … --since/--until --format jsonl|csv|sqlite → Tier A/B 脱敏落盘
  superclaw diagnose <run_id> [--out]                                  → Tier B 诊断上下文包(脱敏; ✅P2a 已落)
  superclaw diagnose <run_id> --local --replay                         → Tier C 原地查看+决策回放(不出文件; ❄️P2b 待业主审批)
```

---

## 5. span 覆盖清单（诊断要能看到的"每一环"）

父子 span 树，trace_id 贯穿。**最易"功能看似坏了、实为配置/竞争/截断所致"的环节用 ★ 标注**：

1. **入口**：CLI args / API payload（脱敏）、trace_id、who、when、workspace/company 上下文、permission_mode
2. **★配置解析**：配置来源/覆盖优先级（env > 文件 > 默认）—— 最易误判根因
3. **编排 orchestrator**：goal 解析 → plan → 子任务分解 → backend 选择 → model 选择（及回退原因）
4. **治理决策点**：pay-switch、fail-closed 拦截、人审 gate(approved/denied+reason)、权限检查、信任链验签
5. **★队列/调度**：claim/lease/锁竞争、liveness、reconcile
6. **backend/worker 执行**：每 worker、每 tool 调用（name/args 结构/result 摘要/耗时/exit）
7. **★取消/重试/超时决策点**：为何重试、为何超时、为何取消
8. **runtime 投影**：DisplayEvent、stdout/stderr（脱敏）、token usage
9. **★脱敏/截断动作本身**：哪些字段被脱敏/截断（否则"数据缺失"会被误读为 bug）
10. **状态机**：lifecycle(queued→running→in_review→done/failed)、completion gate
11. **★持久化写失败**：DB 写失败/锁冲突
12. **错误**：异常类型 + 脱敏堆栈 + 错误码 + 上下文（对齐"禁裸 except"，每个 except 出 span）
13. **退出**：cost、duration、最终状态、verifier 结果

---

## 6. 复现的现实边界（诚实声明，不过度承诺）

对 LLM/agent 这类**非确定性系统**，"逐字复现"不可承诺（模型漂移、服务端路由、外部工具状态、时钟、并发）。本系统承诺的是：

- **条件重建**：`manifest` 记录 git sha + 依赖指纹 + 配置/env 指纹（哈希，非明文）+ backend/model/参数 + 时间线。
- **决策回放**：录制当时 LLM input/output 与 tool result（Tier C），以 **dry-run mock 回放**重走逻辑分支，验证"代码在那批 I/O 下的行为"——不重新真打模型/网络。
- **根因定位**：凭 span 树 + 时序 + 决策记录，定位"卡在哪一步、什么决策、为什么"。

**硬边界声明（不可悄悄抬高）**：env/配置指纹是**哈希**（证明"变没变"，**不重建明文配置**）；Tier C 是 7 天短期 + 永不离机。因此：
- **Tier C 在场且未过期** → 可做来源证明 + 差异比对 + **决策回放**（mock I/O dry-run）。
- **Tier C 缺失或已过期** → **只保证 diagnostic context（诊断上下文：span 树/时序/决策码/脱敏摘要），不保证 reconstructable environment（可重建的运行环境）**。
"条件重建"一词仅指前者范围内的能力，绝不承诺重建明文配置或重放原始上下文。

---

## 7. 埋点即开发契约（instrumentation as a contract）

**让埋点"自然而然"而非负担**：

- **框架层自动埋点**：在 Tool 基类、Backend 基类、EventBus 统一入口用装饰器/hook **无侵入**捕获输入结构、输出摘要、耗时、异常。业务开发者写新 Tool/Backend **无需手写 span()**。
- **新增环节的契约**：新增 backend / 治理门 / 状态时，关键决策点与 except 点经由框架 choke point 自动产出 receipts。
- **Test-as-Policy（落地为牙齿）**：架构测试断言 **choke point 有 receipts**（如"每个 fail-closed 拦截点 record 了 denied 决策"），**不**断言"某函数调了 span()"（后者会逼出敷衍埋点、阻碍重构）。承接 `architecture-invariants-roadmap.md` 的 Test-as-Policy 思路。
- **脱敏不靠人工记白名单**：导出经集中白名单投影 + 默认关闭 + 动态高熵兜底；字段 sensitivity 仅作元数据辅助。

### 7.1 Coverage Owner Map（§5 每一环由哪个框架入口出 receipt，杜绝 hardest spans 回退人工）

§5 中**不天然落在 Tool/Backend/EventBus 三类基类**的高价值环节，必须各有一个**唯一的内核入口**作为埋点 owner（否则形式主义复活）。每个 owner 是该环节代码的**单一必经点（choke point）**，receipt 在那里自动产出：

| §5 环节 | 埋点 owner（单一必经点） | receipt 内容 |
|---|---|---|
| ①入口 | CLI dispatch / API 中间件 | trace 起点、who/when、permission_mode |
| ②★配置解析 | **配置加载器统一入口**（settings/config resolver） | 每个生效值的来源层（env>文件>默认）、被覆盖项 |
| ③编排 | orchestrator 调度点 | plan/分解/backend·model 选择及回退原因 |
| ④治理决策 | **治理裁决 choke point**（pay-switch/fail-closed/gate/权限/验签的单一裁决函数） | approved/denied + reason 码（**必持久化**，见 §7.2） |
| ⑤★队列/lease | **scheduler/lease 管理器入口** | claim/lease/reconcile/锁竞争 |
| ⑥backend/worker/tool | Backend 基类 + Tool 基类（天然 choke point） | name/args 结构/result 摘要/耗时/exit/重试 |
| ⑦★取消/重试/超时 | **重试·超时策略决策函数**（统一封装，非散落 sleep/loop） | 触发原因、次数、退避 |
| ⑧runtime 投影 | EventBus 入口（天然 choke point） | DisplayEvent/usage/降级·截断标记 |
| ⑨★脱敏/截断动作 | **redactor/truncator 统一函数** | 哪些字段被脱敏/截断（避免"缺失"被误读为 bug） |
| ⑩状态机 | **状态转移单一写入点**（state store lifecycle 封装） | 转移前后状态、completion gate |
| ⑪★持久化写失败 | **state store / telemetry sink 写入封装** | 写失败/锁冲突 + 退化动作（见 §7.2） |
| ⑫错误 | 框架级 except 边界（基类/中间件包裹） | 异常类型 + 脱敏堆栈 + 错误码 |
| ⑬退出 | orchestrator 收尾点 | cost/duration/最终状态/verifier |
| 导出管线本身 | **export pipeline 入口** | export_id、kind、行数、脱敏档、manifest 哈希 |

> 落地约束：上表"owner"列即 P0a/P0b 必须建立或确认的**单一必经点**。任何新增环节必须先指定其 owner 并登记进本表，再写实现——这是"埋点即契约"的可执行形式（架构测试断言这些 owner 处有 receipt）。

### 7.2 诊断存储失败的退化合同（receipt 不能"best effort 丢了算了"）

诊断 sink（ring buffer / telemetry 库 / append-only JSONL）写失败时的行为**按 receipt 类别分级，fail-closed 优先**：

| 类别 | 例 | sink 写失败时的契约 |
|---|---|---|
| **关键 receipt（必持久化）** | 治理拒绝/权限拒绝/pay-switch/fail-closed 决策、验签结果、状态机关键转移 | **绝不静默丢弃**：先尝试同步落地（可绕过 ring buffer 直写）；仍失败 → 将该 run 标记 `degraded` 或按治理语义 **fail-closed 中止**，并在主日志（§8 P0a 的根 logging）留一条结构化错误 |
| **诊断 receipt（可降级）** | 高噪声流式 span、tool delta、stdout/stderr 片段 | 允许有损：丢弃后记一条 `diagnostic_loss{count,reason}` 计数（本身是关键 receipt），run 继续 |

> 原则：**审计/治理类事实优先于运行吞吐；诊断类事实优先于运行吞吐之后**。绝不允许"为了不阻塞 run 而静默吞掉一条 denied 决策"。

---

## 8. 落地路线图（保守排序，每步独立 commit/可回滚）

| 阶段 | 内容 | 解决的核心风险 |
|---|---|---|
| **P0a** 🚧 | 结构化 logging 根配置（`LOG_LEVEL` env + JSON/text + 脱敏 filter，CLI/API 入口幂等注入）；内核 trace context（`trace_id/run_id/span_id/export_id`）+ **跨异步/多进程/subagent 传播** + 日志注入 —— **已落：A 日志根配置 / B1 trace 地基+注入 / B2 全传播（线程池/Thread/4 个 agent 子进程）**；剩 FastAPI 请求日志中间件（metadata only，D）。统一 span 原语/receipts 归 P0b（需存储） | 日志不可见；trace 断裂则全盘失效 |
| **P0b** 📝 | 独立物理隔离的 Tier B 存储 + 内存 ring buffer 异步刷盘 + 统一 span 原语；先覆盖 §5 中 ★ 与治理拒绝/backend·model 选择/worker·tool 执行/状态转移/异常的 receipts | SQLite 锁冲突；最常查不出原因的环节 |
| **P0c** 🚧 | `superclaw export`（Tier A 本地导出 + manifest + 0600 + `--out` 拒 URL + 白名单脱敏 + JSONL/CSV/SQLite）—— **已落 cost kind 闭环（`operator_export.py`，应用层迭代器非跨源 SQL 视图）**；runs/secrets/evidence/audit 同框架后续扩展；Tool/Backend 基类自动埋点 span 属 Tier B（需 P0b 存储）后续 | 形式主义埋点；脱敏失效；Tier C 误导出 |
| **P1** ✅ | reproduction manifest（条件重建，非复现包）—— **已落**：`condition_manifest.py` 纯 builder + `superclaw export --kind run-condition`（运行参数白名单 + 标识 HMAC + telemetry 只读投影 + deps/env 指纹 + completeness） | 过度承诺复现 |
| **P2a** ✅ | 诊断上下文包 `superclaw diagnose <run_id> [--out]` —— **已落**：`diagnostic_bundle.py` 纯 builder（span 父子组织 + 生命周期时间线 + governance 决策码 + cost + 复用 P1 条件段 + 根因提示），命中"哪一环/什么决策/为什么"。诚实边界硬写 `decision_replay=unavailable / reason=tier_c_recording_absent` —— **不是回放**（回放属 P2b/Tier C），绝不拿非结构化 transcript 凑假回放 | 过度承诺回放 |
| **P2b** ❄️ | **需业主审批的先导阶段**：Tier C 原始 I/O 录制（结构化 LLM/tool input/output/result schema + opt-in 默认关 + 7 天 TTL + 目录 0700/文件 0600 + 永不离机 + 审计）→ 才能 `superclaw diagnose <run_id> --local --replay`（dry-run mock 回放，数据不离机）。三方设计讨论裁决：Tier C 是最高敏感全新隐私面，绝不与 P2a 混 PR，须先单独定稿结构化 I/O schema 再实现 | Tier C 隐私逃逸 |
| **P3** ❄️ | **仅业主明确批准**：受控的片段级 sealed extraction（显式选择 + 强审计 + 短 TTL） | 默认冻结 |

### 验收硬清单（并集）
跨进程 trace 不断裂、路径穿越/symlink 输出、0600 权限、流式大数据导出、导出期间源数据变更（撕裂）、未知字段默认拒绝、**Tier C 永不出文件**回归、SIGKILL 后 span/evidence 一致性、**API/Web 无新增导出面**静态检查、**`httpx/socket` 仅限已批准 wrapper**静态检查、**§7.1 每个 owner 处有 receipt 的架构测试**（Test-as-Policy）、**§7.2 关键 receipt sink 写失败时 fail-closed/degraded 而非静默丢弃**的测试。

---

## 9. 与其他路线图的关系

- **`long-term-roadmap.md` L3（交付包 + Replay）**：L3 的 replay 是"交付证据可复跑 verifier"；本系统的诊断 replay 是"运行时决策回放"。二者共享"内核诊断事实源"作底层——本系统为 L3 提供运行时事实来源。
- **`agent-runtime-display-protocol.md`**：DisplayEvent 从本系统的诊断事实源**投影**而来（终态），避免双写。短期二者并存，逐步收敛。
- **`architecture-invariants-roadmap.md`**：本系统的 choke-point receipts 测试是其 Test-as-Policy 的具体应用。
- **`relay_key.py` 审计白名单**：作为全量导出脱敏的**方法论范本**（白名单范式，非字段集直接复用）。

---

*维护提示：本文档是诊断埋点的"设计契约"权威。新增任何"环节"时回到 §5/§7 核对是否已被 choke point 覆盖；状态变化时更新 §8 图例。*
