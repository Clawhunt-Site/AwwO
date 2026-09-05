# updatePRD v3 —— SuperClaw ↔ ClawHunt 联调

> 版本：v3 | 日期：2026-06-28 | 负责人：LK
> 关系：承接 v1（双服务端 chat 已在浏览器端到端跑通）。本文是 v1「阶段二方向 A：直接 ClawHunt 联调」的展开规格。
> 目标：**让用户能在 ClawHunt 里用上 SuperClaw 聊天——出真答案、租户隔离正确、计费走对套餐。**
> 性质：本文是 **PRD（讲清"要什么/为什么/现状/决策点"）**；具体任务清单与 AI 提示词留到后续 `updatePRDv3-PLAN.md`。
>
> **✅ 2026-06-28 业主已拍板（4 个决策点全定，详见第五节）：**
> 1. **走路线 Y** —— 沿用现有 Python+ClawWork 嵌入层（基建成熟、改动小；非真流式 + 版本落后是已知取舍）。
> 2. **分两期**：先做到「本地/dev 两个租户聊出真答案」，**终局直达「公网可放量」**（持久化 G5 + 安全 P0 G6 是放量前置，纳入第二期）。
> 3. **relay key 分两步**：先用 v1 验证过的 llmgate key 打通本地，**再**对接 ClawHunt 线上发放机制。
> 4. **前端先接 web**（改动可控、便于联调）；iOS 后续。

---

## 〇、一句话现状

- **SuperClaw 侧**：node 分支双服务端 chat 已跑通（真聊天/切模型/绑 workspace，见 `specs/chat-端到端验证报告.md`）。
- **ClawHunt 侧**：已有一套**成型的嵌入层**（`clawproduct-hunt/backend/superclaw_embed/`），按租户 spawn SuperClaw 进程，三轴隔离 + 沙箱 + relay key 机制都在，**但接的是另一套 SuperClaw 架构**，且前端还没接、有几个已知阻塞。
- **联调的真正工作**：先解决"两套架构对不齐"这个根本矛盾，再补前端接入、计费绑定、流式、安全这几块。

---

## ⚠️ 一、核心矛盾：两套 chat 架构对不齐（联调第一决策点）

| 维度 | ① 我们 v1 跑通的（node 分支） | ② ClawHunt 嵌入层现在锁的（SHA db474fb8） |
|------|------------------------------|-------------------------------------------|
| 进程形态 | **双容器**：Node Paperclip 引擎 + Python | **单 Python 进程** `apps.api.main` + 内部 spawn 的 ClawWork Node 孙进程 |
| chat 执行 | acpx adapter → `claude-agent-acp` → relay | ClawWork backend → clawrelay → relay |
| 流式 | **真 SSE 流式**（逐 token） | **ClawWork 是批处理、非真流式**（见 `SUPERCLAW_FORK_GOVERNANCE.md`） |
| chat 入口 | `POST /api/chat/stream`（Node:3810） | `POST /superclaw/api/chat/stream` → 子进程 `apps.api.main` |
| 落点分支 | `node` 分支（比 main 多很多 commit） | `main` 分支某历史提交（db474fb8，已落后） |

**这意味着**：ClawHunt 当前嵌入层**不是**在用我们刚验证好的那套流式 chat。曾有两条路可选：

- **路线 X —— 嵌入层升级到 node 双服务端**：让 ClawHunt 嵌入我们验证过的 Node 引擎（真流式、能力最新）。代价：要改嵌入层的 spawn 模型（不再 spawn 单个 `apps.api.main`，而是对接 Node 服务/容器），版本锁要从 db474fb8 bump 到 node 分支。收益：chat 是真流式、和 SuperClaw 最新能力一致。
- **路线 Y —— 沿用现有 Python+ClawWork 嵌入层**：保留现成的隔离/沙箱/进程池机制，只补"计费绑定 + 前端接入 + 流式问题 + 安全"。代价：ClawWork 批处理不是真流式，体验差；且锁的版本已落后。收益：嵌入层基建已成熟，改动面小。

> ### ✅ 决策点 1 已定：**走路线 Y（沿用 Python+ClawWork 嵌入层）**
>
> **理由**：嵌入层的三轴隔离 + 沙箱 + 进程池 + relay key 机制都已成型并有单测，改动面最小、最快能让用户在 ClawHunt 里聊出真答案。路线 X 要改 spawn 模型、bump 版本锁、对接 Node 容器，工程量大且风险高，留作后续优化（真流式体验）的备选方向，不在本轮范围。
>
> **路线 Y 的已知取舍（业主已知并接受）**：
> - **非真流式**：ClawWork 批处理，用户看到的是「整段回答一次性返回」而非逐 token。体验问题（G4）记为后续优化项，不阻塞本轮联调。
> - **版本落后**：嵌入层锁 db474fb8，落后 node 分支很多 commit。本轮不 bump（bump 会牵动 patch/编译链路）；待联调跑通后再单独评估。

---

## 二、ClawHunt 嵌入层现状（调研结论）

> 路径：`clawproduct-hunt/backend/superclaw_embed/`。详细文件/行号见调研记录；下面是联调需要知道的要点。

### 2.1 它怎么工作（数据流）
```
ClawHunt 前端（web / iOS）
   │  Bearer hunt-JWT
   ▼
clawhunt 主站 → 反代 /superclaw/* → 独立 embed 服务(superclaw_embed_app.py, 专用入口)
   │  _principal: 验 hunt-JWT + sub==user.id（防跨租户计费）
   ▼
TenantProfileResolver.resolve → ensure_user_relay_key（走 LLMgate bridge 换 per-user relay key）
   ▼
ProcessManager.get_or_spawn（每租户一个进程；端口 8800-9000；空闲 15min 回收；LRU 上限）
   ▼
wait_ready（轮询子进程 /health）→ TenantRouter.build_forward（强制注入只读 sandbox policy）
   ▼
POST 127.0.0.1:{port}/api/chat/stream（子进程 apps.api.main）→ ClawWork → relay → SSE 透传回前端
```

### 2.2 三轴隔离 + 一道闸（已实现）
- **轴 1 数据**：每 user 独立 `state.db / work / home / policy / tmp` 子目录（env 注入 `SUPERCLAW_STATE_PATH`/`HOME`/`SUPERCLAW_HOME`/`TMPDIR`）。
- **轴 2 凭据/计费**：每 user 独立 relay key（`SUPERCLAW_RELAY_API_KEY`）+ 套餐模型（`superclaw-{tier}`）。
- **轴 3 能力/权限**：`ChatSandboxPolicy` 强制 `mode=plan`、禁 `bash/write/edit`、`pay_switch=False`，每次转发**覆盖**用户请求体（fail-closed）。
- **一道闸**：子进程靠 HMAC control token（`X-SuperClaw-Token`）鉴权，**hunt-JWT 不透传进子进程**（身份在嵌入层以 env 钉死，进程级 = 租户级隔离）。
- **OS 沙箱**：可选 bubblewrap（`--ro-bind / --tmpfs --bind` 只回本租户三目录）。

### 2.3 版本锁与同步
- `superclaw.lock` 钉 `SUPERCLAW_SHA=db474fb8`；`scripts/sync_superclaw.sh` deploy 期 clone 到 `third_party/superclaw`（gitignore），fail-closed 校验 `HEAD==SHA` + 应用 `patches/`。
- 有一个 patch：clawwork 版本探测加缓存（避免每轮 chat 冷起 node 探版本）。

### 2.4 部署
- 独立 Cloud Run 服务 `clawhunt-superclaw-embed-dev`，`Dockerfile.embed`（python:3.11-slim + Node 26 + bwrap + 手动按序编译 ClawWork）。
- 单实例契约（`--max-instances=1`，ProcessManager 是进程内锁+内存字典，多副本破隔离）；`--min-instances=0` 省钱；deploy 用 `--no-traffic`，需手动切流。

---

## 三、联调缺口（不论路线 X/Y 多半都要补）

| # | 缺口 | 说明 | 阻塞级别 |
|---|------|------|----------|
| G1 | **前端接入未完成** | iOS 现在打的是主站 `/agent-chat/chat`（绕过 embed）；web 前端的 `/superclaw` 子路由 + fetch adapter + 注入 hunt-JWT 尚未做 | 🔴 高（不接前端=用户用不上） |
| G2 | **relay key 套餐绑定** | LLMgate bridge 未解析 `tier` → key 没落 `superclaw-{tier}` group → 计费/模型池走默认。ClawHunt 侧已带 `tier`，**LLMgate 侧要改** | 🔴 高（计费正确性前提） |
| G3 | **真答案需有效 relay key** | 链路已通到模型调用，本地需测试 key（我们 v1 已有可用 llmgate key，可复用验证） | 🟡 中 |
| G4 | **流式问题** | 路线 Y 下 ClawWork 批处理非真流式，体验差；路线 X 天然真流式 | 🟡 中（取决于路线） |
| G5 | **历史持久化** | 租户 state.db 在容器本地盘，部署替换丢历史；需 Filestore/NFS 持久卷 | 🟡 中（放量前要解决） |
| G6 | **网络逃逸 P0（安全）** | bwrap `--share-net` 下子进程可打 GCP 元数据服务器偷 SA token；公网放量前必须建最小权限专用 SA | 🔴 高（仅公网放量前；本地联调不阻塞） |
| G7 | **多租户隔离验证** | 嵌入层有隔离机制 + 单测，但缺端到端"两个真实租户互不串数据/串计费"的联调验证 | 🟡 中 |
| G8 | **Windows 从零全量编译 ClawWork 不通** | `scripts/sync_superclaw.sh --build` 的全量编译在 Windows 失败：`packages/agent`（`@earendil-works/pi-agent-core`）+ `proxy.ts/types.ts` 都 `import '@earendil-works/pi-ai/base'`，但 `pi-ai/dist/base*` 未先产出（工作区编译顺序问题）+ 一批 implicit-any。**运行时真正用的 `coding-agent/dist/cli.js` 已存在并能跑**，本地联调不阻塞；仅影响「从零全量物化」与生产 `--build` 路径 | 🟡 中（仅生产 materialize / 从零 build；本地已有 cli.js 时不阻塞） |

> ### 实测补充（2026-06-28，Task 1.2 本地打通后回填）
>
> **① G2 已被实测印证在 relay/LLMgate 侧**：本地用 v1 固定 llmgate key 时，租户 tier 派生的套餐模型 `superclaw-core` 被 relay 直接 **403 / `package_not_permitted`**（该测试 key 无套餐权限），但同一 key 能访问**裸模型** `claude-opus-4-8`。这正是 G2「key 没绑定 `superclaw-{tier}` group」的具体表现——缺口确在 LLMgate 侧 key 配额开通，本地用裸模型兜过（详见 PLAN「联调关键事实」与 ClawHunt `doc/superclaw-embed-local-dev.md` §9）。
>
> **② 路线 Y 的一处隐性契约（embed 强制 backend 需请求体同步对齐）**：embed `router.py` 只强制 `direct_chat_backend="clawwork"`，**不设** `backend_policy`；而 SuperClaw 内核 `main.py` 有 fail-closed 守卫——请求不带 `backend_policy` 时 `runtime.backend` 回退成 `"claude"`，与强制的 `clawwork` 不等 → 视作「跨 backend 不可移植」**丢弃 model override**，回落到 `superclaw-core`。故本地请求体必须同带 `backend_policy="clawwork"` + `model=<裸模型>`，model 才落到 `WorkerLimits.model_override`。这是表层（embed）与内核（CLI 唯一事实源）对齐的一个真实接缝点，前端接入（Checkpoint B）时也要带对这两个字段。
>
> **③ Windows 本地运行需一套兼容垫片（不改 vendored 源，全经 env/PYTHONPATH 注入）**：PYTHONUTF8 治 GBK、venv 在 `Scripts/` 非 `bin/`、`USERPROFILE` 回填 `Path.home()`、`fcntl` 垫片、`cli.js` 的 `.cmd` 包装（治 WinError 193）、`os.O_NONBLOCK` 哨兵 + `PeekNamedPipe`/`PIPE_NOWAIT` select 补丁（`sitecustomize.py`）。详见 `doc/superclaw-embed-local-dev.md`。

---

## 四、目标与范围（两期推进）

> 按决策点 2：先打通本地、终局直达公网放量。拆成 **第一期（本地/dev 联调）** 与 **第二期（公网放量准备）** 两个里程碑。

### 第一期 —— 本地/dev 两个租户聊出真答案（本轮主攻）
**验收口径**：
1. **能在 ClawHunt web 前端里聊天、出真答案**（前端先接 web，决策点 4）。
2. **多租户隔离正确**：两个用户各自独立会话/数据/计费，互不串（G7 端到端验证）。
3. **计费走对套餐**：relay key 绑定到正确的 `superclaw-{tier}` group（G2，LLMgate bridge 侧改）。
4. **链路稳定**：spawn → ready → chat → 回收 全程无致命错误；异常 fail-closed。
5. **relay key 先用 v1 的 llmgate key 打通**（决策点 3 第一步），跑通后再切 ClawHunt 线上发放。

**第一期要补的缺口**：G1（web 前端接入）、G2（套餐绑定）、G3（真答案/复用 llmgate key）、G7（隔离验证）。

### 第二期 —— 公网可放量（终局，本轮不收尾但要预留）
**验收口径**：
1. **G5 历史持久化**：租户 state.db 落 Filestore/NFS 持久卷，部署替换不丢历史。
2. **G6 网络逃逸 P0 安全**：bwrap `--share-net` 下建最小权限专用 SA，堵 GCP 元数据 token 偷取面。
3. **relay key 切线上发放**：从 llmgate 测试 key 切到 ClawHunt 线上 per-user 发放机制（决策点 3 第二步）。
4. **（可选）iOS 接入**：决策点 4 web 先行，iOS 在第二期或之后。

### 暂不在本 PRD 范围
- 路线 X（升级 node 双服务端真流式）—— 决策点 1 已选 Y，X 留作后续体验优化备选。
- SuperClaw fork 独立仓治理（governance doc 里的长期项）。
- WIP 收尾那条线（见 `updatePRDv2.md`，与联调并行、非前置）。

---

## 五、业主决策（2026-06-28 已全部拍板）

- [x] **决策点 1（最关键）**：→ **路线 Y**（沿用现有 Python+ClawWork 嵌入层）。理由见第一节。
- [x] **决策点 2**：→ **分两期**，先做到「本地/dev 两个租户聊出真答案」，**终局直达「公网可放量」**（G5 持久化 + G6 安全 P0 纳入第二期）。
- [x] **决策点 3**：→ **先用 v1 的 llmgate key 打通本地，再对接 ClawHunt 线上发放**（两步走，见第四节两期）。
- [x] **决策点 4**：→ **前端先接 web**（改动可控、便于联调）；iOS 留到第二期或之后。

> 4 点已定，下一步：据此写 `updatePRDv3-PLAN.md`（带任务清单 + AI 提示词），再进入增量开发。

---

## 六、关键信息速查（联调专用）

| 项 | 值 |
|---|---|
| ClawHunt 仓库 | `c:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/clawproduct-hunt` |
| 嵌入层 | `backend/superclaw_embed/`（config/process/gateway/proxy/router/tenant/policy/readiness） |
| embed 专用入口 | `backend/superclaw_embed_app.py`（**不复用主站 main:app**，否则计费后台任务双跑） |
| 版本锁 | `superclaw.lock` → SHA `db474fb8`（Python 单进程架构，**非 node 双容器**） |
| 同步脚本 | `scripts/sync_superclaw.sh`（clone → 校验 → patch → 建 venv → 编译 ClawWork） |
| 部署 | `Dockerfile.embed` + `cloudbuild.embed.dev.yaml`（Cloud Run，单实例，`--no-traffic`） |
| relay 地址（embed） | `https://gate.clawhunt.site/v1`（per-user key）；主站用 `api.clawhunt.site/v1`（平台 key），**两者不同** |
| LLMgate bridge 报告 | `docs/llmgate-superclaw-package-bridge-report.md`（tier→group 绑定缺口） |
| 部署/治理文档 | `doc/SUPERCLAW_EMBED_DEPLOYMENT.md`、`doc/SUPERCLAW_FORK_GOVERNANCE.md`、`doc/SUPERCLAW_CAPABILITIES.md` |
| iOS chat 现状 | `ios/ClawHunt/Services/ChatService.swift` 打 `/agent-chat/chat`（**未接 embed**） |
| embed 单测 | `backend/superclaw_embed/tests/`（31 passed / 3 skipped；boot 测试需本机 venv） |
