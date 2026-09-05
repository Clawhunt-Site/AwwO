# Tier C 录制 + recorded-result branch replay — RFC（P2b）

> **状态**：❄️ **设计定稿，待业主审批方实现**。三方对抗评审三轮收敛（主代理 + Codex gpt-5.5 + Antigravity Gemini 3.1 Pro），除 **at-rest 加密 A/B（业主拍板项，本 RFC 推荐 B）** 外，两位顾问均 **GO for owner approval**。**未写任何录制代码**。
>
> **承接**：observability P0a/P0b（trace context + 单写者 telemetry.db + span/governance receipt + per-kind 脱敏）、P1（条件重建 manifest）、P2a（诊断上下文包 `superclaw diagnose`，已硬写 `decision_replay=unavailable / contains_tier_c=false`，保留到本 RFC 的 completeness 真满足）。
>
> **命名纪律**：全程用 **recorded-result branch replay**。**禁** `reproduce` / `replay bugs` 等措辞 —— 它**不**复现 bug、**不**重建文件系统/网络/时钟/锁竞争/并发/provider 状态；差异比对只叫 **regression signal**，非 reproduction proof。

## 0. 目标与非目标

**目标**：给已开启 Tier C 的 run，录制**决策相关的原始 I/O**（模型/工具的输入输出 + 决策帧），用于：
- `--view-raw`：原地查看"模型到底看到了什么 / 输出了什么 / 工具收发了什么"（解决 ~80% 的诊断盲点）。
- `--replay`：**recorded-result branch replay** —— 把不可重算的外部事实注入，用当前代码重算纯策略/路由逻辑，与录制结果比对，得出 **regression signal**（"当前代码在当时的输入/结果/裁决下会不会走不同分支"）。

**非目标**：逐字复现 bug；重建明文配置/环境；录网络包/env dump/文件系统快照；覆盖所有 backend（见 §5）。

## 1. 三条硬约束（业主拍板，本 RFC 全程不可破）
1. **运营/管理侧用，不占 UI**；**API/Web/Desktop 完全不碰 Tier C**（无查看/下载/SSE/REST 面）。CLI 唯一事实源。
2. **永不离机**：Tier C **无任何导出路径**；仅 `--local` 原地消费，绝不产可外发工件。
3. **绝不实时上传**；隐私 fail-closed；**默认绝对 OFF**。

## 2. 录什么（两层 schema，每条挂 trace_id/run_id/span_id）

### 2.1 raw-I/O 层（含明文，Tier C 本质）
- `llm.request`：发往模型的完整 prompt/messages（system+user+tool 定义）+ backend/model/参数。
- `llm.response`：模型完整原始输出（text + tool_calls + finish_reason + usage）。**流式录最终聚合完整串**（中断不丢前半段）。
- `tool.call`：tool name + 完整 args。
- `tool.result`：tool 完整 result/输出；**tool 内部异常作 tool.result 录**（失败路径可回放）。

### 2.2 decision-frame 层（回放骨架）
每决策点录 **inputs（供当前代码重算）+ recorded outcome（供比对）**：选中 backend 列表/顺序、attempt_index、frontier/concurrency 调度、resolved `WorkerLimits`、permission/containment policy、model_override、prompt projection 最终串、budget preflight、cancel/timeout 状态、human gate verdict、delegation authorization、child review verdict、lease/锁获取结果、时钟/timeout 事件。

## 3. 存储与隐私控制

| 维度 | 决策 |
|---|---|
| 位置 | 独立 `~/.superclaw/tier-c/<run_id>/`（**NOT** telemetry.db，敏感级不同），append-only |
| 权限 | 目录 `0700` / 文件 `0600` |
| **at-rest 加密** | **❄️ 业主拍板项 — 本 RFC 推荐 B**（见 §7） |
| no-backup/no-index | Tier C 目录尽量设排除备份 + 排除索引（无论 A/B，对齐"永不离机"对抗备份/Spotlight 向量） |
| TTL | 7 天（对齐 evidence）；B 方案下做 **crypto-deletion** + 文件清理 |
| **opt-in** | **三层治理，默认绝对 OFF**：总闸 env OFF（默认）+ **per-run 显式开启**（常规 UX = CLI 创建 run 时写入**不可由 repo/模型修改**的 run config；`SUPERCLAW_TIER_C_RUN_TARGET=<run_id>` 仅作 operator 调试闸）+ **per-company/admin policy 可禁用**。**repo 内容 / 模型输出 / 子 agent 绝不能自行开启**（堵 prompt-injection 诱导落盘监听）。开启**事实**可进 Tier B 审计（不含原始内容）。 |
| 导出 | **无**。operator_export 不接 Tier C kind。 |

## 4. 捕获 choke point（框架层，最小侵入）
- LLM I/O：B-class owned loop 的 `_complete()`；tool I/O：`_exec_tool()`（GeminiAgent/AnthropicAgent 的 `_RealToolExecution`）。
- 复用 trace context 挂 span_id，与 Tier B span 对齐（同一 span 既有 B 结构摘要、又有 C 原始 I/O）。

## 5. backend 覆盖（诚实声明）
- **仅承诺 B-class SuperClaw-owned loop**（gemini-agent / anthropic-agent，工具循环经 `_exec_tool`）。
- native `codex` / `claude` / app-server / CLI **自管工具循环不经 `_exec_tool`**（见 `cross_runtime_delegation.py`）→ 标 **`unsupported_backend` / transcript-only，no replay**，不强行 hook 闭源子进程。
- **CLI summary 必须显著显示 backend coverage**，不藏 metadata —— 杜绝业主误以为"全后端可回放"。

## 6. recorded-result branch replay 语义（核心，二分）
`superclaw diagnose <run_id> --local --replay`：
1. **侧效应事实 = 录制 outcome 注入**（不可重算的外部非确定性）：tool.result、llm.response、lease/锁结果、时钟/timeout 事件、human gate verdict、child review verdict、网络结果。
2. **纯策略/路由逻辑 = 当前代码重算 + 与录制 expected outcome 比对**：backend/model 选择、governance gate、retry/timeout 决策、completion gate、prompt projection。
3. **regression signal = recomputed_decision != recorded_decision**（这才让差异比对有意义，否则只是 trace 回放）。

### 6.1 回放污染硬门（隐私命门）
回放**绝不**复用真实写盘路径。强制注入：`EphemeralStateStore`（纯内存禁写盘）+ `NullTelemetrySink` + `NullArtifactSink` + `NullTranscriptSink` + `NullEventSink` + log guard + network/shell/write **deny** + **不调用真实 `backend.run` 写文件路径**。否则明文经异常/日志/工件落进**可导出的 Tier B telemetry.db / state.db / artifact_dir** → 击穿"永不离机"。
**验收硬测试（非文档承诺）**：回放后**工作目录 / artifact_dir / state.db / telemetry.db / 日志目录零新增 raw**。

### 6.2 completeness matrix（fail-closed 诚实）
`replayed` / `incomplete_partial` / `unsupported_backend` / `expired`。**任何 required raw-I/O 或 decision-frame 缺失**：该节点不可回放，整 run **至多 `incomplete_partial`，绝不输出 `replayed`**。（`--view-raw` 缺失可 warning；`--replay` 必须降级。）

## 7. at-rest 加密 — ❄️ 业主拍板项（本 RFC 推荐 B）
- **A — 明文 0600 + 0700 + TTL**：简单、密钥不丢；但**备份/iCloud/Spotlight 会把明文卷离机**（违"永不离机"），同用户进程可读。agy 主张（视加密为安全剧场，仅按 root/disk attacker 建模）。
- **B — 设备本地不可导出 sealed key（OS keychain）加密 at-rest**：密钥不可用 fail-closed 不录；TTL crypto-deletion。**即使文件被备份/同步/索引卷走，无本机密钥也解不开** → 真正 honors"永不离机"。Codex 主张。
- **主代理裁决 = 推荐 B**：硬约束是"永不离机"，明文最大的洞不是黑客而是**备份/云同步无声离机**；A 只在业主**显式接受**残余风险 + 证明性排除备份+索引时才走。**最终由业主拍板。**

## 8. 分增量（不一口气做完整回放）
- **P2b.1 — 地基与可视**：§2 两层 schema + §3 隐私契约 + 加密 recorder store + 7天 TTL + `diagnose --local --view-raw`（仅终端格式化看原始 I/O）。
- **P2b.2 — 捕获**：B-class `_complete()`/`_exec_tool()` choke point 录制；native 标 unsupported。
- **P2b.3 — 回放**：§6 二分回放引擎 + §6.1 全 Null sink 硬门 + `diagnose --local --replay` + §6.2 completeness。

每增量经 Codex + agy 双 PASS 才提交；P2a 的 `contains_tier_c=false / decision_replay=unavailable` 保留到 completeness 真满足才翻转。

## 9. 威胁模型与边界
- **防**：意外外发（误导出/上传敏感 I/O）—— 靠永不离机 + 无导出路径 + 全 Null sink + （B）加密对抗备份/索引。
- **不防**：有 root + 本机密钥访问的本地攻击者（这是 operator 自己机器、opt-in 主动开的诊断录制）。
- **过度承诺红线**：绝不声称复现 bug；外部 API 不稳/并发竞态/模型幻觉**无法**被 mock 回放复现。

## 10. 评审留痕（三轮三方对抗）
- **R1**：两方 NO-GO。收敛阻断 = schema 不够回放（需 decision-frame）、`--local` 隐私不够 + 回放污染（明文经日志/异常漏进可导出 Tier B/state）、opt-in 全局太粗、命名过度承诺、捕获点不能泛称全覆盖。
- **R2**：agy GO；Codex NO-GO（4 条精炼）。采纳 = 回放**二分语义**（侧效应注入 + 纯逻辑重算比对，否则差异比对是噱头）、Ephemeral 硬门扩为**全 Null sink + 零 raw 落盘硬测试**、missing payload 对 `--replay` 降 `incomplete_partial` 绝不 `replayed`、opt-in 常规走 run config 非 env。
- **R3**：两方 **GO for owner approval**（除加密业主自决）。Codex 补非阻断验收：无论 A/B，Tier C 目录 no-backup/no-index + 测试 raw 绝不出现在 export/diagnose/evidence/transcript/logs。

## 11. 待业主决策
1. **at-rest 加密 A / B**（本 RFC 推荐 **B**）。
2. **是否批准开工 P2b.1**（recorder 地基会真正把原始 prompt/输出落盘——加密——是此前"待批"的隐私面）。
