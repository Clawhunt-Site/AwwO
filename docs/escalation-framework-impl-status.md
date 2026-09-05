# 提权升迁框架（Escalation Framework）实施状态 — Direction 4 P0/D1

> 本文记录能力工坊**方向四（提权/审批升迁通道）**的实施进度，对应权威规划
> `docs/capability-workshop-impl-roadmap.md` §2「方向四」/ §7.2 / §7.3 / §8.2 与
> `docs/capability-workshop-roadmap.md`「方向四」。
>
> **范围铁律**：本批只做 **P0/D1 内核地基 + B 类硬门 + 操作面 CLI**。P1/P2 表层与
> 原生归一化、以及路线图点名的 **D5 暂不实施** 一律标为「待开发」，本批不碰。

## ✅ 已落地（feat/escalation-framework，3 个原子 commit，均经 Codex+Gemini 双 PASS）

### Commit 1 — escalation 内核地基（inert，零行为改变）
- `escalation.py`：`EscalationEnvelope`（公共信封）+ 强类型 `EscalationKind`/`EscalationStatus`
  + `EscalationPending`/`EscalationError`/`EscalationDenied` 异常 + **双签名单次票据**
  （binding signature 锁 run/session/principal/tool/args_digest/prompt_text/option label；
  grant signature 锁审批决策含 consumed_at）+ `validate_new_envelope`（防预批准注入）
  + `grant_authorizes`（消费资格）+ `compute_args_digest`（严格 canonical：拒非 str key/
  NaN/tuple/非 Mapping root）。
- `state.py`：`escalations` 表 + `consumed_grants` spent-ledger（防完整还原复活）+
  CRUD（create/get/list/resolve/find_consumable_grant/consume_grant/expire_stale）。
- fail-closed 不变量：授权只读 store-backed 双签名 grant；payload 改一字节 / 跨 run /
  跨 session / 重放 / 重复消费 / 入库后篡改 / 完整还原复活 全拒。

### Commit 2 — B 类工具硬门 + 挂起/恢复（行为变更，已获用户确认）
- `backends.py`：`WorkerLimits.escalation_gate`（注入式）；`_exec_tool` 在 workspace
  posture 下对 `run_shell` / reserved-path 写经 gate（consume 授权→放行 / 无通道→
  fail-closed deny / `EscalationDenied`→拒）；`full`（allow/bypass）维持自由执行；
  `_reserved_write_target` 大小写无关检测 `.git`/`.github`/`.ssh`/`.env*`/`Dockerfile*`/
  `package.json` 等敏感目标。
- `state.py`：`resolve_gate_decision`（单一 `BEGIN IMMEDIATE` 内原子
  consume-approved / sticky-deny / find-or-open-pending）+ `find_denied_escalation` +
  `create_or_get_pending_escalation`。
- `orchestrator.py`：per-run gate（绑 run_id+principal，可靠挂载）+
  `except EscalationPending`→`_suspend_for_escalation`（running→pending、状态→
  `WAITING_FOR_HUMAN_GATE`、每个 open pending 各发 `escalation.requested`）+ 并行
  frontier **波次提交**（escalation 后停止补新→queued 永不启动；start 仅在 submit
  时 emit，无 ghost）；resume 经现有 `WAITING_FOR_HUMAN_GATE` 通道重入消费授权。
- **行为变更**：默认 `ask`（workspace posture）下 B 类（gemini/anthropic agent）不再
  自由跑 shell；无审批通道则 fail-closed 拒绝（需 `--permission-preset allow` 或人审批准）。

### Commit 3 — CLI 操作面（纯表层）
- `superclaw escalation list / show / respond`：薄表层，调用 Commit 1/2 的 StateStore
  方法，零新增授权；`respond` 的 principal 必须匹配绑定（Q4.3）；list 按 effective
  status 过滤；各错误路径内核 fail-closed → exit 1。

## ✅ D2 已落地（P1 — REST + SSE，dev/roadmap）

### 改动
- `escalation.py`：新增 `escalation_summary(env)` 纯投影 —— **CLI 与 REST 共用的单一投影源**
  （CLI `_escalation_summary` 改为委托它，零偏差）。**故意不输出任何 HMAC 材料**
  （`signature`/`grant_signature`/`nonce` 永不上线），`status` 用 `effective_status()`，
  含 `style` 供前端渲染。
- `state.py`：`resolve_escalation` 在成功 approve/deny 提交后、run-scoped 时，**单点发出
  durable `escalation.resolved` 事件**（CLI 与 REST 经同一内核路径，行为零偏差；事务提交后
  best-effort，从不抛）。
- `apps/api/main.py`：新增 `GET /api/escalations`（默认 `pending`，对齐 CLI；`status=all` 取全量；
  `pending_count` 供徽章）、`GET /api/escalations/{id}`（summary + `signature_valid`）、
  `POST /api/escalations/{id}/respond`（薄包装 `store.resolve_escalation`，零新增授权）。
- `tests/test_escalation_api.py`：12 用例（fail-closed 越权/未知 option/二次 respond 无副作用、
  default=pending、不泄 HMAC、服务端操作员身份、配 token 时端点受保护）。

### 关键设计 & 决策留痕（经 Leon 拍板）
1. **SSE 语义（据实）**：`/api/runs/{id}/events` 把 `WAITING_FOR_HUMAN_GATE` 当 terminal，
   run 一挂起该流即关——所以 `escalation.resolved` **不作 live 关弹窗用**，而是 **durable 生命周期
   事件**（run-cockpit 快照/时间线/审计）。弹窗关闭由 **respond 的 HTTP 返回**驱动；pending 发现
   由 **REST 队列轮询**（被 escalation.requested / 进入 WAITING 触发）。
2. **responder 身份（修 Codex 越权）**：REST respond **不接受请求体 principal**，改由服务端
   `_operator_principal()`（`SUPERCLAW_OPERATOR_PRINCIPAL`，fail-closed 默认 `local_user`）派生 ——
   网络调用方无法冒充任意 principal；内核仍强制 responder == 绑定 principal。这是与 CLI
   （本地操作员 `--principal` 自报）有意的、朝安全方向的 per-surface 差异。
3. **鉴权姿态（Leon 决定：保持一致）**：list/get/respond 全走 `require_control_token`，与**所有
   既有治理端点**（`/api/governance/approvals`、`/api/team/approvals/grant`）**同一模型**：未配
   token 即放行 = 本机本地信任（API 默认仅绑 `127.0.0.1`，等同 CLI shell 访问）；生产经
   `desktop_runtime` 配 token。`test_endpoints_require_control_token_when_configured` 证明配 token 时
   端点受保护、未认证 respond 不产生副作用。**不为 escalation 单独加严**（保持与兄弟端点一致）。
4. **多租户隔离（Leon 决定：defer）**：单 control-token = 单操作员，看到全部 = CLI parity，**无真实
   跨 session 泄露**。真正的"按 session/company/workspace 隔离"需先引入 **per-caller 身份模型**
   （现无此层）；在无身份层时硬加过滤 = security theater（项目反对）。→ **单列为后续 track**，本
   D2 不做，此处据实记录限制。

## 🚧 待开发（本批不做，按路线图分期）

| 项 | 范围 | 依据 |
|---|---|---|
| **P1 — Web 弹窗（D3）** | 通用「文本 + N 按钮」升迁弹窗 + pending 徽章（监听 escalation.requested/进入 WAITING → 拉 `/api/escalations?status=pending` 填充；点击 → respond；HTTP 返回关弹窗） | roadmap §方向四 P1 |
| **多租户 scoping（后续 track）** | 按 session/company/workspace 隔离 `/api/escalations` 可见性，防跨 session 泄露 —— **需先引入 per-caller 身份模型**（当前单 control-token=单操作员=CLI parity，无真实泄露；无身份层时强加过滤=theater）。Leon 决定 defer | roadmap §方向四 P1 / §7.3 Q4.2 |
| **P2 — 原生 approval 归一化** | 把 Codex/Claude app-server 的原生 `requestApproval` 回调在 orchestrator 拦截层转成 `EscalationEnvelope`（kind=`runtime_tool`），默认 decline，超时/断连/未知类型一律 decline 或 pause，绝不自动 accept | roadmap §方向四 P2 / §8.2 codex-app-server |
| **D5 — ⛔ 暂不实施** | 在 Codex app-server request handler **内**挂起等票据 | roadmap §7.2 明确：会让外层 timeout/cancel/retire 停摆，**必须等异步 approval broker（D1/D2 表层）到位后再做** |
| 其它 kind 接线 | `governance_gate`/`plan_approval`/`clarifying_question`/`issue_completion` 已在 `EscalationKind` 预留，待各自 handler 落地 | roadmap §方向四 typed routing |

## 📋 backlog（非阻断，验收顾问提）
- 补真实双线程 approve-vs-gate race 测试、`frontier>concurrency` 的 queued-never-start 测试。
- `consume_grant`/`find_consumable_grant`/`find_denied_escalation`/`create_or_get_pending_escalation`
  为受测的 store 原语；生产 gate 路径已统一走原子 `resolve_gate_decision`。
- `consumed_grants` 全量加载可改 `WHERE` 定点查询（数据量增长时）。

## 验收留痕
- **P0/D1**：三个 commit 均经 Codex(gpt-5.5) + Gemini 多轮对抗式验收最终双 PASS（Commit 2 历五轮，
  逐层闭合并发/竞态：并行挂起即停、ghost start、原子 consume-deny-pending、sticky deny、
  reserved 大小写、单次消费 ledger、完整还原复活）。
- **D2（REST + SSE）**：Codex(gpt-5.5) + Gemini 多轮对抗式验收。
  - 第一轮：Gemini PASS；Codex 阻断 3 项 → 已逐项修复：① REST principal 自报越权 → 服务端
    `_operator_principal()` 派生；② `escalation.resolved` 重定位为 durable 事件 + 下沉内核单点；
    ③ REST list 默认对齐 CLI 的 `pending`。
  - 第二轮：Gemini PASS（确认 3 项闭合、下沉 emit 无副作用）；Codex 确认 3 项修复有效、无 HMAC/grant
    绕过、无事件先于授权副作用，另提 2 项**架构级**残留：① 无 token 时鉴权 fail-open；② 多租户 scoping
    未落地。
  - 2 项架构残留**非 D2 引入的代码 bug**，经核实为实例级既有模型/未来 track，**由 Leon（项目 owner/
    架构裁决方）拍板**：① 保持与所有既有治理端点一致的 localhost+token 模型（已补 token-gating 测试证明
    受保护，生产配 token）；② 多租户隔离 defer 为需身份层的后续 track（今日单操作员=CLI parity，无真实
    泄露；硬加过滤=theater）。决策与依据见上文「关键设计 & 决策留痕」。
- transcript 落 `.codex-cli-advisor/` 与 `.gemini-cli-advisor/`（已 gitignore）。
