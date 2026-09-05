# 远程遥测集中上报架构设计（Remote Telemetry Upload）

> **状态**：📝 设计草案（待三方对抗式评审定稿：Codex gpt-5.5 + Antigravity Gemini 3.1 Pro）
>
> **范围**：在装机端/CLI 端把本地采集的诊断与审计数据**主动上报**到运营方自建的远程收集服务器，供运营集中排查错误、优化数据。
>
> **本文是 [`observability-diagnostics-roadmap.md`](observability-diagnostics-roadmap.md) 的"远程上报"扩展分支。** 该路线图的本地采集/落盘/导出地基是本设计的数据来源；本设计在其之上新增"上报通道 + 远程 server"。

---

## 0. ⚠️ 铁律变更声明（业主拍板，必须留痕）

本设计**有意推翻**以下两条原先由业主拍板、写入 [`CLAUDE.md`](../CLAUDE.md) 与 [`observability-diagnostics-roadmap.md`](observability-diagnostics-roadmap.md) §0/§3 的硬约束：

| 原铁律 | 出处 | 本设计的变更 |
|---|---|---|
| **绝不实时上传用户数据**（无 phone-home、无后台 push，导出只能本地 pull） | roadmap §0.3 | ❌ **推翻**：新增后台主动上报（push）通道 |
| **Tier C 原始载荷（原始 prompt / 完整命令输出 / env / 附件）永不离机** | roadmap §3 | ❌ **推翻**：Tier C 也纳入上报（业主第二轮明确选择"连 Tier C 也上报"） |

**业主已知并接受的后果（如实记录，不得淡化）**：

1. **隐私/安全风险集中化**：把多端的原始 prompt、命令输出、env 指纹堆到一个联网中心点，该 server 一旦被攻破即"一锅端"。这是安全工程上公认的高危反模式。
2. **产品信任承诺改变**：SuperClaw 面向 ClawHunt 终端用户、装机即用、持有用户自有密钥与仓库。开启原始载荷上报后，"agent 不会把你的 prompt/命令传走"这一信任承诺不再成立，**必须以显式知情同意（opt-in consent）替代**，否则构成合规（隐私法）风险。
3. **与既有治理铁律的张力**：`ui_contracts` / fail-closed / 表层零新增语义等仍然有效——上报是**内核能力**，CLI 是唯一事实源，API/Web/Desktop 只能投影开关状态，不得各写一份上报实现。

> 本节存在的目的：未来任何人（含 AI 代理）读到本文，都能立刻知道"远程上报 + Tier C 离机"是一次**明确的、有记录的铁律推翻**，而非疏忽或默认行为。撤销本能力时，回到本节恢复原铁律。

---

## 1. 设计原则（推翻铁律 ≠ 放弃工程底线）

越是高危，越要把安全工程做满。本设计在"业主要上报包括 Tier C 的详细数据"前提下，仍坚守：

1. **默认关闭 + 显式知情同意**：上报全局默认 `off`。开启需 operator 显式配置 + 装机端用户**知情同意**（首启告知 + 可撤回）。无同意 → fail-closed 不上报。
2. **本地优先，上报永不阻塞 run**：采集与落盘照旧在本地完成；上报是**事后异步**搬运。上报失败/网络不可达 → 本地缓冲 + 退避重试，**绝不阻塞或拖慢用户的 run**（延续 roadmap §7.2"诊断类事实优先于运行吞吐之后"）。
3. **分级加密、分桶、分 TTL**：A/B（脱敏）与 C（原始载荷）走**不同加密密钥、不同存储桶、不同保留期、不同访问权限**。C 桶端到端加密 + 最短 TTL + 最严访问。
4. **传输与静态都加密**：传输 mTLS；应用层信封加密（Tier C 字段级加密，server 端零知识接收原始明文前先解信封需独立密钥）。
5. **单一上报 choke point**：上报只有一个内核必经函数，所有 Tier 都从它出网。CI 静态检查锁死"除该 wrapper 外，诊断/导出路径不得出现 `httpx/requests/socket`"。
6. **可观测自身可审计**：上报动作本身留 receipt（上报了什么 kind、多少行、成功/失败、目标 host），形成"上报的审计轨"。
7. **全局 kill switch**：一个 env/配置开关能立即停止所有上报并清空本地上报缓冲。

---

## 2. 端到端架构

```
  装机端 / CLI 端                                          运营方远程 server
 ┌─────────────────────────────────────────┐
 │ 内核诊断事实源 (diagnostics_store.py)      │
 │  telemetry.db (Tier B) + state.db (Tier A)│
 │  + Tier C 短期文件 (原始载荷, 7天)         │
 └───────────────┬───────────────────────────┘
                 │ ① 同意门 + 全局开关 (fail-closed)
                 ▼
 ┌─────────────────────────────────────────┐
 │ 上报 spooler (单一 choke point)            │
 │  - 读取增量 (按 trace_id/水位线游标)       │
 │  - 脱敏投影 (A/B 白名单; C 字段级信封加密) │
 │  - 本地持久缓冲 (上报队列, 0600, 断网不丢) │
 │  - 退避重试 + 背压 + 批量                  │
 └───────────────┬───────────────────────────┘
                 │ ② mTLS + 应用层信封      上报 push (HTTPS/gRPC)
                 ▼                                        ▼
                                          ┌──────────────────────────────────┐
                                          │ 接收网关 (auth: 装机端凭证/mTLS)    │
                                          │  - schema 校验 + 拒绝未知字段       │
                                          │  - 速率限制 + 配额                  │
                                          └──────────────┬─────────────────────┘
                                                         ▼
                                          ┌──────────────────────────────────┐
                                          │ 分桶存储 (静态加密)                 │
                                          │  Tier A/B → 可查询库 (脱敏, 中长期) │
                                          │  Tier C   → 独立加密桶 (信封, 最短   │
                                          │             TTL, 最严访问, 审计)    │
                                          └──────────────┬─────────────────────┘
                                                         ▼
                                          运营分析 (DuckDB/BI) + Tier C 解封需独立授权
```

### 2.1 数据来源（复用现有地基，不重造）

| Tier | 本地来源（现状） | 上报形态 |
|---|---|---|
| **A 审计/统计** | `state.db` 事实表（cost/secret-audit/relay-audit），`operator_export.py` 已有迭代器 | 脱敏投影 JSONL 批量上报 |
| **B 诊断 span** | `telemetry.db`（`diagnostics_store.py` 单写者库，receipt 已带 trace 关联） | 脱敏投影 JSONL 批量上报 |
| **C 原始载荷** | 短期文件（原始 prompt/命令输出/env 指纹/附件/录制 I/O，7 天） | **字段级信封加密**后整块上报 |

> **前置依赖**：B 的诊断 span **目前还没接到执行路径**（`span()` 真实调用点为空）。必须先完成 roadmap **P0b**（把 span 埋进 Backend/Tool/orchestrator choke point），本地 `telemetry.db` 才有详细数据可上报。**先本地埋点，再谈上报。**

### 2.2 关联键

复用 `trace_context.py` 现有字段 `trace_id / run_id / span_id / export_id`，新增 `device_id`（装机端稳定匿名 ID）+ `upload_id`（每批上报）。运营在 server 端按 `trace_id` 把跨进程/跨 Tier 的记录串成一次完整运行的全貌。归因仍用 HMAC 哈希（掩明文又能分组统计）。

---

## 3. 上报 spooler（装机端，新增内核模块）

建议落在 `packages/superclaw/src/superclaw/telemetry_upload.py`，由 daemon 驱动（复用 `daemon.py` 的 tick），**单一出网 choke point**。

核心契约：

- **增量游标**：游标 = 账本的**单调插入序号（SQLite rowid，`list_cost_events_after_seq`）**，**不是**墙钟 `occurred_at`。回填/迟到事件拿到更高 seq 必被采，未来时间戳事件不会拖死后续行（用 `occurred_at` 当游标会被时钟漂移/回填永久毒化）。断点续传，幂等 `upload_id` 防重传。
- **脱敏投影**：
  - A/B：集中白名单投影（复用 `relay-audit.jsonl` 范式）+ 高熵字符串/常见 secret key 动态兜底；**绝不进**明文 secret/key/bearer/cookie/token、带 query 的 URL、env 值。
  - C：业主要原始载荷 → **不脱敏，但字段级信封加密**（用 server 持有的公钥加密内容密钥；server 解信封需独立私钥 + 独立授权）。即"传得过去，但落地后非授权不可读"。
- **本地缓冲**：上报队列落盘 `~/.superclaw/upload-spool/`（0600），断网堆积、有上限（超限丢弃 B 中低价值 span 并记 `upload_drop{count}`，A 与治理类绝不丢）。
- **fail-closed 边界**：① 无同意 / 全局开关 off → 根本不读取、不出网；② 网络失败 → 退避重试，不阻塞 run；③ 目标 host 不在 allowlist → 拒绝。
- **上报自审计**：每批出网记一条 receipt（kind/行数/目标 host/成功失败），本身是 Tier A。

---

## 4. 远程 server（运营方，新建独立服务）

**不放进 SuperClaw 仓库的表层**（API/Web/Desktop），而是独立部署的接收服务（建议独立 repo / 子服务），避免污染"CLI 唯一事实源"。

- **接收网关**：mTLS 或装机端凭证认证；schema 校验 + **拒绝未知字段**；速率限制 + 每 device 配额。
- **分桶存储**：A/B → 可查询库（DuckDB / Postgres，静态加密，中长期）；C → 独立加密对象桶（信封密文，**最短 TTL**，访问需独立授权 + 全程审计）。
- **查询/分析**：运营侧 BI/DuckDB 直读 A/B；Tier C 解封是**显式、留痕、短时效**的特权操作，不进日常查询面。
- **删除/被遗忘权**：按 `device_id` 能定向删除（合规要求）。

---

## 5. 上报开关与状态机（同意内容由用户协议定义，本设计只实现技术开关）

> **合规/法律口径由业主的用户协议承载，本设计不涉及措辞，只提供可被协议驱动的技术开关与状态。**

上报受一个**三态门**控制，fail-closed（任何非 `enabled` 状态都不出网）：

```
disabled (默认)  ──enable──▶  enabled  ──disable──▶  disabled (并清空本地 spool)
       ▲                          │
       └────── kill-switch ───────┘  (env SUPERCLAW_TELEMETRY_KILL=1 → 强制 disabled, 优先级最高)
```

- **状态持久化**：`~/.superclaw/telemetry-consent.json`（0600），记录 `state / enabled_at / agreement_version / device_id`。`agreement_version` 由业主的用户协议版本号驱动——协议升版后旧同意失效，回到 `disabled` 等重新 enable。
- **CLI 是唯一事实源**：`superclaw telemetry enable|disable|status`（§8.5）。API/Web/Desktop 仅**投影**该状态，不得各写一份开关。
- **kill switch**：`SUPERCLAW_TELEMETRY_KILL=1` 立即强制 `disabled` 并停止 spooler、清空 `upload-spool/`，优先级高于一切配置。
- **治理 choke point**：出网仍走既有 fail-closed 治理裁决点，不被本能力绕过。

---

## 6. 落地路线图（保守、可回滚，每步独立 commit）

| 阶段 | 内容 | 前置 |
|---|---|---|
| **R0** | 完成 roadmap **P0b**：诊断 span 接进 Backend/Tool/orchestrator，本地 `telemetry.db` 有详细数据 | 无（这是一切的前提） |
| **R1** | 同意框架 + 全局开关 + CLI `telemetry consent/enable/disable/status`（默认 off，纯本地，先不出网） | R0 |
| **R2** | 上报 spooler（A/B 脱敏投影 + 本地缓冲 + 增量游标 + fail-closed），对接一个 **mock 接收端**做端到端测试 | R1 |
| **R3** | 真实 server 接收网关 + A/B 分桶存储 + 运营查询 | R2 |
| **R4** | Tier C 字段级信封加密上报 + C 独立加密桶 + 解封授权 + 审计 | R3（最高危，单独评审） |
| **R5** | 删除/被遗忘权、配额、kill switch 演练、安全审计 | R4 |

### 验收硬清单
无同意/开关 off 时零出网（静态+运行时验证）、上报失败不阻塞 run、断网缓冲不丢 A/治理类、幂等不重传、A/B 脱敏黑名单回归、Tier C 离机前必信封加密回归、单一 choke point（CI 锁 `httpx/socket`）、撤回同意即停+清 spool、server 拒未知字段、按 device 定向删除。

---

## 7. 待业主/评审拍板的技术开放问题

1. **server 形态**：自建（独立 repo + 部署）还是托管？认证用 mTLS 还是复用 LLMgate/ClawHunt 既有身份体系？
2. **Tier C 解封策略**：谁持私钥、几人审批、解封 TTL 多长（影响 §8.3 密钥托管）。
3. **传输协议**：HTTPS+JSON（简单、易调试）还是 gRPC（流式、强 schema）？本设计默认前者。
4. **存储后端**：A/B 用 DuckDB（运营单机直读）还是 Postgres（多人并发）？

---

## 8. 详细技术设计（可实现层）

### 8.1 装机端模块：`telemetry_upload.py`（新增，单一出网 choke point）

```python
class UploadSpooler:
    """由 daemon tick 驱动的上报搬运器。装机端唯一出网点。"""
    def __init__(self, store, *, config, clock): ...

    def tick(self) -> TickResult:
        # 0. 门检查: 非 enabled / kill-switch → 直接 return（零出网, 零读取）
        # 1. for tier in (A, B, C): 按游标读增量 → 投影/加密 → 入本地队列
        # 2. drain: 取队列批次 → 出网 → 收 ack → 推进游标 → 删本地批次
        # 3. 背压: 队列超上限 → 丢弃低优先 B span, 记 upload_drop{count}（A/治理类绝不丢）
```

| 关注点 | 设计 |
|---|---|
| **驱动** | 复用 `daemon.py` tick；spooler 不自起线程，随 daemon 生命周期 |
| **游标** | 每 Tier 一个持久水位线，存 `~/.superclaw/upload-state.db`（单写者，复用 diagnostics_store 的单写者范式）。游标**只在收到 server ack 后推进** |
| **幂等键** | `upload_id = hmac(device_id ‖ tier ‖ cursor_from ‖ cursor_to)`；server 去重 → at-least-once 投递 + 幂等 = effectively-once |
| **本地缓冲** | `~/.superclaw/upload-spool/<tier>/<upload_id>.batch`（0600）。断网堆积，有总量上限 |
| **出网** | 唯一 `_post(envelope)`，用**已批准的 http wrapper**（CI 锁死：除此处外诊断/上报路径不得 import `httpx/requests/socket`） |
| **失败** | 网络错/5xx → 指数退避重试，**绝不阻塞 daemon 其它工作、绝不阻塞 run**；4xx schema 错 → 隔离该批 + 告警，不重试 |

### 8.2 上报 wire schema（每批一个 envelope）

```jsonc
{
  "schema_version": 1,
  "upload_id": "hmac-hex",          // 幂等键
  "device_id": "anon-stable-hex",   // 装机端匿名稳定 ID
  "tier": "A" | "B" | "C",
  "agreement_version": "v3",        // 当时生效的用户协议版本（来自 §5 同意状态）
  "cursor": { "from": "<水位线>", "to": "<水位线>" },
  "produced_at": 0,                 // 装机端打包时刻(UTC ms)
  "encrypted": false,               // A/B=false(脱敏明文行); C=true(信封密文)
  "rows":   [ /* A/B: 脱敏后的行对象数组 */ ],
  "payload": { /* C: 见 §8.3 信封 */ },
  "row_hmac": "..."                 // 对 rows/payload 的完整性校验
}
```

- **A/B 的 `rows`**：脱敏投影后的明文对象（白名单字段）。复用 `operator_export.py` 的 `_project` / `_scrub` 与 `relay-audit` 白名单范式。**绝不进**：明文 secret/key/bearer/cookie/token、带 query 的 URL、env 值、完整 `.env`。
- **B 的 receipt 行**：直接取 `diagnostics_store` 的 `Receipt`（已带 `trace_id/run_id/span_id` 关联 + `ReceiptClass`），剥离任何 raw payload，只留结构化 kind/摘要/耗时/exit/decision-code。
- **未知字段**：server 端**拒绝**（schema fail-closed）。

### 8.3 Tier C 信封加密（混合加密，server 零知识接收）

业主要原始载荷上报 → 传得过去，但**落地后非授权不可读**：

```
1. 装机端每批生成随机内容密钥  CEK (AES-256-GCM)
2. 用 CEK 加密原始载荷         → ciphertext + nonce
3. 用 server 公钥 (X25519/RSA-OAEP) 包裹 CEK → wrapped_cek
4. envelope.payload = {
     "ciphertext", "nonce", "wrapped_cek",
     "key_id": "<server 公钥指纹>"      // 支持密钥轮换
   }
```

- server 接收网关**只存密文**，不持私钥 → 入库即"零知识"。
- **解封是独立特权操作**：持私钥方（§7-2 拍板）+ 审批 + 短 TTL 才能解出明文，全程审计。
- 公钥随 build-profile 烤入装机端（复用 `environment.py` per-env 烤入范式），私钥**绝不下发装机端**。

### 8.4 Server 接口契约（独立服务，不进 SuperClaw 表层）

| 端点 | 方法 | 行为 |
|---|---|---|
| `/v1/telemetry/ingest` | POST | 认证(mTLS/bearer) → schema 校验(拒未知字段) → 幂等去重(`upload_id`) → 分桶落盘 → 返回 ack |
| `/v1/telemetry/health` | GET | 存活探针 |
| `/v1/telemetry/keys` | GET | 返回当前 Tier C 公钥 + `key_id`（支持轮换；装机端校验指纹） |

**ack 响应**（装机端据此推进游标）：
```jsonc
{ "upload_id": "...", "status": "accepted" | "duplicate" | "rejected",
  "accepted_rows": 128, "reason": null }
```
装机端**只在 `accepted`/`duplicate` 时推进游标**；`rejected` 隔离该批不前进。

**分桶存储**：A/B → 可查询库（静态加密，运营 BI/DuckDB 直读）；C → 独立加密对象桶（信封密文，最短 TTL，访问需 §8.3 解封授权 + 审计）。按 `device_id` 可定向删除（被遗忘权）。

### 8.6 媒体/二进制：只传特征描述，绝不传原文件（业主拍板）

> **铁规则**：用户的媒体与二进制载荷（图片/音频/视频/PDF/附件等）**永不上传原文件**；只上传一张几百字节的「特征描述卡」。Tier C 上传的原始内容**仅限文本**（prompt、命令输出），凡二进制一律降级为元数据。

理由（三方都赚）：① 隐私——媒体是最敏感的私密数据，这是方案里最大的隐私暴露面，直接消除；② 带宽/存储——媒体是唯一的「大块头」（一张照片 2–5 MB、短视频几十 MB），不传后纯文本遥测一次仅几十~两百 KB，§8.5 的 5 MB 上限几乎永不触发；③ 诊断够用——排查媒体类故障几乎从不需要原始字节，知道「多大/什么格式/尺寸/是否 0 字节或损坏」即可定位 99%。

「特征描述卡」字段（每个媒体一条，约几百字节）：

```jsonc
{
  "media_kind": "image/png",          // MIME 类型
  "size_bytes": 4193280,
  "width": 1920, "height": 1080,      // 图片
  "duration_ms": null,                 // 音视频
  "codec": null, "sample_rate": null,
  "role": "input" | "artifact",        // 用户输入 还是 agent 产物
  "content_fingerprint": "hmac-hex",   // 判同/判变，但还原不出原文件
  "filename_ext": ".png"               // 仅扩展名，不带可能含 PII 的全名/路径
}
```

落地约束：媒体描述卡归入 **Tier B**（诊断，脱敏明文），不进 Tier C。上传 spooler（§8.1）在投影阶段遇到任何二进制/媒体引用，一律替换为本描述卡——这是 §8.2「绝不进上报」黑名单的延伸，由 CI 静态检查与脱敏投影双重保证。

### 8.5 CLI 命令面（CLI 唯一事实源）

```
superclaw telemetry status            # 三态 + 游标进度 + 本地队列积压 + 目标 host
superclaw telemetry enable            # 置 enabled（写同意状态, agreement_version）
superclaw telemetry disable           # 置 disabled + 清空 upload-spool
superclaw telemetry spool --once      # 手动触发一次 tick（调试用）
superclaw telemetry queue             # 列本地缓冲批次（kind/行数/重试次数）
```
API/Web/Desktop 仅投影 `status`，开关只在 CLI/内核。

---

## 9. 收集端数据库选型与部署（自装 PostgreSQL）

> **背景**：装机端继续用本地 SQLite（`state.db`/`telemetry.db`），**原样不动**。本节只讲"远程收集服务器"这一侧的数据库。业主已拍板：**自建服务器，自装 PostgreSQL**（数据完全自持，含 Tier C 原始载荷）。

### 9.1 为什么是 PostgreSQL（而非沿用 SQLite）

| 需求 | SQLite（装机端用） | PostgreSQL（收集端用） |
|---|---|---|
| 多装机端并发上传 | ❌ 单写者，会锁 | ✅ 为高并发而生 |
| 7×24 联网服务 | ❌ 是文件不是服务 | ✅ 标准 server |
| 同时存规整表(A/B) + 原始大块(C) | ⚠️ 勉强 | ✅ 表 + `bytea`/`jsonb` 都行 |
| 日志分析/出图 | ⚠️ 量大吃力 | ✅ 生态最全（接 BI/DuckDB） |

不选 MySQL（分析弱）、MongoDB（数据是规整表无需文档库）、ClickHouse（当前体量过度、运维重）。

### 9.2 部署蓝图：Docker Compose 一组容器（自装但低运维）

收集服务器上跑**三个容器**，一份 `docker-compose.yml` 拉起，避免手装数据库的折腾：

```
┌─ docker compose up 一键启动 ─────────────────────────┐
│  ① postgres:16        ← 数据库本体（数据落宿主机磁盘卷）│
│  ② 接收程序 (FastAPI)  ← /v1/telemetry/ingest 写入 PG   │
│  ③ adminer / pgAdmin   ← 网页管理后台（点鼠标看数据）   │
└──────────────────────────────────────────────────────┘
   备份：宿主机 cron 每日 pg_dump → 异地留存
```

- **③ 网页后台**让不写代码也能像 Excel 一样浏览/筛选/导出（pgAdmin 功能全，Adminer 单文件更轻）。也可用桌面工具 DBeaver。
- **数据卷**：Postgres 数据目录挂到宿主机持久卷，容器重建不丢数据。
- **网络**：Postgres **绝不直接暴露公网**——只让同机的接收程序连（compose 内网）；对公网只开接收程序的 HTTPS 端口 + 后台管理端口（且限 IP/加密）。

### 9.3 三张表（对应 Tier A/B/C）

```sql
-- Tier A：审计/统计（脱敏后明文，永久留存，做账与趋势）
CREATE TABLE tier_a (
  id           BIGSERIAL PRIMARY KEY,
  upload_id    TEXT NOT NULL,           -- 幂等键（去重）
  device_id    TEXT NOT NULL,
  trace_id     TEXT, run_id TEXT,
  meter_kind   TEXT, backend TEXT, provider TEXT, model TEXT,
  tokens_in    BIGINT, tokens_out BIGINT,
  cost_usd     NUMERIC(12,6), duration_ms BIGINT,
  status       TEXT, error_code TEXT,   -- 错误码已脱敏
  occurred_at  TIMESTAMPTZ, received_at TIMESTAMPTZ DEFAULT now(),
  agreement_version TEXT
);

-- Tier B：诊断 span（脱敏后明文，中期留存，查"哪步失败/什么决策"）
CREATE TABLE tier_b (
  id            BIGSERIAL PRIMARY KEY,
  upload_id     TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  trace_id      TEXT, run_id TEXT, span_id TEXT, parent_span_id TEXT,
  receipt_class TEXT,                   -- critical | diagnostic
  kind          TEXT,                   -- 有界枚举，非自由文本
  decision_code TEXT,                   -- approved | denied | timeout ...
  summary       TEXT,                   -- 结果摘要（脱敏）
  duration_ms   BIGINT, exit_code INT, retry_count INT,
  exception_type TEXT, stack_redacted TEXT,
  occurred_at   TIMESTAMPTZ, received_at TIMESTAMPTZ DEFAULT now()
);

-- Tier C：原始载荷（信封密文，最短 TTL，非授权不可解）
CREATE TABLE tier_c (
  id            BIGSERIAL PRIMARY KEY,
  upload_id     TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  trace_id      TEXT, run_id TEXT,
  payload_kind  TEXT,                   -- prompt | command_output | env_fingerprint | recorded_io
  key_id        TEXT,                   -- 解信封用哪把私钥（支持轮换）
  ciphertext    BYTEA, nonce BYTEA, wrapped_cek BYTEA,  -- §8.3 信封
  ttl_expires_at TIMESTAMPTZ,           -- 到期自动删
  received_at   TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX uq_tier_a_upload ON tier_a(upload_id, id);
CREATE INDEX ix_tier_a_trace ON tier_a(trace_id);
CREATE INDEX ix_tier_b_trace ON tier_b(trace_id);
CREATE INDEX ix_tier_c_ttl   ON tier_c(ttl_expires_at);
```

> 字段直接对应 §8.2 wire schema 与装机端现有数据源（`tier_a` 映射 `cost_events` 等，`tier_b` 映射 `diagnostics_store` 的 `Receipt`）。**Tier C 入库即密文**——收集服务器零知识，解封需独立私钥（见 9.4）。

### 9.4 自装的安全要点（Tier C 原始载荷落在这台机器，必须做满）

1. **Postgres 不出公网**：防火墙只放行接收程序端口；数据库仅 compose 内网可达。
2. **磁盘静态加密**：宿主机磁盘加密 + 定期 `pg_dump` 备份**也加密**后异地留存。
3. **Tier C 私钥不放这台机器**：理想是私钥离线/单独保管，这台收集机只存密文；要解封时把密文取到隔离环境解。退一步至少独立密钥文件 + 严格权限，绝不与备份同处。
4. **TTL 清理任务**：定时 `DELETE FROM tier_c WHERE ttl_expires_at < now()`，Tier C 短命；A/B 可长留。
5. **访问审计**：谁登过网页后台、谁解过 Tier C，留痕。
6. **接收程序 fail-closed**：认证失败/schema 不符/未知字段一律拒，幂等去重防重复入库。

### 9.5 你日常怎么看数据（不写代码）

- 登 **pgAdmin/Adminer 网页后台** → 选 `tier_a`/`tier_b` 表 → 像 Excel 一样筛选、排序、导出 CSV；
- 想出图：把 A/B 导出喂 DuckDB/Excel，或接一个 BI（Metabase 也能 Docker 一键起，专为"点鼠标出报表"）；
- 排查某次失败：按 `trace_id` 在 `tier_b` 里拉出那次运行的整条决策时序。

---

*维护提示：本文档是"远程上报"的设计契约。§0 的铁律变更声明是核心——任何缩小或扩大上报范围（尤其 Tier C）都要回到 §0/§3 更新，并经三方对抗式评审。*
