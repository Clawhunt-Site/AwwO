# updatePRD v2 —— node 分支 WIP 收尾（Server-Coexist 剩余步骤）

> 版本：v2 | 日期：2026-06-28 | 负责人：LK
> 上游来源：Leon 的 `docs/server-coexist-WIP-status.md`（node 分支，handoff 备忘）
> 关系：本文是 **v1 的「阶段二方向 B」展开**。v1 已把 Docker 基线 + 双服务端 chat 端到端跑通（阶段 0/1 完成）；
> 本文专门把 Leon 这条 `feat/server-coexist` 分支「没做完的剩余步骤」讲透，作为「先补 WIP 再联调」路线的规格。

---

## 〇、为什么有这份文档

v1 里「补 WIP」只在阶段 3 用一句话带过（`功能补全：runAgentTurn 抽核、全局 skill/plugin`），既没列全 5 步、也没说明
每步的**性质、优先级、业主已拍板的决策**。本文补齐这块，让"走 B 路线"时有清单可依、有取舍可查。

**重要纠正**：Leon WIP 实际是 **11 步里完成第 6 步、剩 5 步**（v1 口误写成"8/9 步"）。且其中**第 10 步（浏览器端到端验证）
已在 v1 阶段一被我们完成**，所以真正待办只剩 **4 步：7、8、9、11**。

---

## 一、Server-Coexist 11 步全景（当前状态）

> 这条分支在干什么：把 SuperClaw 的 **chat 表层**落到 vendored 的 **Paperclip Node server**（`server/`）上，走它**原生 agent 调用链路**
> （heartbeat → `adapter.execute` + session resume）；Python 后端继续服务其余面。两服务**共存不合并**，Vite proxy 按路径分流。

| # | 步骤 | 状态 | 备注 |
|---|------|------|------|
| 1 | Node server 底座 + chat/plugin/skill/工坊 cherry-pick | ✅ Leon 完成 | — |
| 2 | 双服务共存 + Vite proxy 分流（Node 3810 / Python 8810 / web 5180） | ✅ Leon 完成 | 提交 `8abe57d5` |
| 3 | chat 走 Paperclip **原生** heartbeat → `adapter.execute` 单车道 | ✅ Leon 完成 | — |
| 4 | 动态 runtime：途中换模型 + 每轮 model/effort + 上下文交接 | ✅ Leon 完成 | 移植 `chat_runtime.py` |
| 5 | workspace 契约暴露（GET inventory，侧栏列/选） | ✅ Leon 完成 | — |
| 6 | **workspace 绑定**：`/chat/stream` 读 `workspace_id`，create==move 等价、fail-closed | ✅ Leon 完成（停在此） | 提交 `9cfddcfc` |
| 7 | workspace **CRUD 治理**（新建/改名/删）→ 路由回 Python 内核 | ⬜ 未做 | **业主已拍板延后** |
| 8 | **runAgentTurn 抽核**：从 9000+ 行 vendored `heartbeat.ts` 抽出独立轮次函数 | ⬜ 未做 | 🔧 清理型重构，**非功能缺口** |
| 9 | **全局 skill/plugin union**（`~/.superclaw`，跨公司注入） | ⬜ 未做 | 🆕 真新功能 |
| 10 | **浏览器端到端验证**（真聊天/真切模型/真绑 workspace） | ✅ **v1 阶段一完成** | 见 `specs/chat-端到端验证报告.md` |
| 11 | **完整 `ci.yml` 全量本地门**（pytest / npm test / build / ruff） | ⬜ 未做 | 🚦 交付门 |

**真正待办：第 7、8、9、11 步**（第 10 已完成）。

---

## 二、剩余步骤逐条规格

### [ ] 步骤 7 — workspace CRUD 治理（⚠️ 业主已延后）

**是什么**：侧栏「项目」的**创建 / 改名 / 删除**。现在只能**列和选**（GET inventory 可用），这三个写操作对 Node 会 404。

**为什么延后**：Leon 曾在 Node 里写过一版薄壳，被 **Codex + Gemini 双顾问 BLOCK**——它把 trust / managed-folder / archive
治理写成了更弱的并行实现，违反「CLI 唯一事实源 + fail-closed」。**业主拍板：回退该薄壳，日后让 CRUD 治理路由回 Python 内核单一源。**

**落地方向（真要做时）**：不在 Node 重写治理逻辑，而是 Node 侧把这三个写操作**转发/委托给 Python 内核**（CLI/API 已有的 workspace 治理），
保持"内核唯一事实源、表层零新增语义"。

**优先级**：低（业主已延后；不影响 chat 跑通，按钮 404 与现状同态）。

---

### [ ] 步骤 8 — runAgentTurn 抽核（🔧 重构，非缺口）

**是什么**：把 `adapter.execute` 的"组参 / session resume / skill·plugin 注入 / cwd 解析"，从 9000+ 行的 vendored
`heartbeat.ts` 里**抽成一个独立的 `runAgentTurn` 函数**，去掉 chat 不需要的 task / timer / staleness 脚手架，做到确定性的
「一轮输入 = 一轮执行 = 一轮回复」。

**关键判断**：Leon 文档明确写——**当前 chat 已能走原生 `heartbeat.wakeup` 跑通，所以这是清理型重构、不是功能缺口**。
而且它**动的是 vendored 上游文件**，与项目铁律「不改 vendored 上游代码」冲突，风险/收益要先评估。

**优先级**：低（不做 chat 也照常工作；高风险低即时收益）。**建议：除非后续维护明显受阻，否则不主动做。**

---

### [ ] 步骤 9 — 全局 skill/plugin union（🆕 真新功能）

**是什么**：在现有的 company-scope（公司维度）之上，加一个**全局维度**（`company | global`）。
global source = SuperClaw 现有的 `~/.superclaw/skills | plugins`；运行期做 **union 解析**（全局 ∪ 当前 company），
使 skill / plugin 能**跨公司注入**。

**价值**：这是 4 步里**唯一实打实的新业务能力**。对"让用户在 ClawHunt 里用得顺手"有正向价值（公共技能/插件不必每个公司重配）。

**约束**：能力先进内核、再上表层；全局注入也要遵守 fail-closed 治理（扫描类需人审、支付永不默认）。设计见 design doc §4/§9。

**优先级**：中（真功能，但非 ClawHunt 联调硬前置）。

---

### [ ] 步骤 11 — 完整 `ci.yml` 全量本地门（🚦 交付门）

**是什么**：按「远端 CI 已暂停」铁律，合并/交付前在本地把整套 `ci.yml` 跑通：
全量 `ruff` + 全量 `pytest`（走 `scripts/run-ci-tests.sh` 两阶段）+ `superclaw doctor` 冒烟 + API `/health` 冒烟 +
全量 `npm test` + `npm run build`。

**现状**：Leon 这条分支只跑了 chat 针对性测试（`chat-compat-*` / `chat-runtime-*`）+ `tsc`，**没**跑全量门。

**优先级**：高（任何"合并 node 分支 / 交付"动作的硬前置；不跑全量会漏跨模块回归）。

---

## 三、优先级总览与建议

| 步 | 性质 | 优先级 | 建议 |
|---|------|--------|------|
| 7 CRUD 治理 | 功能缺口（已延后） | 低 | 路由回 Python 内核再做；现在不做 |
| 8 runAgentTurn 抽核 | 纯重构 | 低 | 高风险低收益，**默认不做** |
| 9 全局 skill/plugin | 新功能 | 中 | 真功能，可做；非联调硬前置 |
| 11 全量 CI 门 | 交付门 | 高 | 合并/交付前**必跑** |

**核心结论**：补 WIP 这 4 步里，**没有一个是 ClawHunt 联调的硬前置**——chat 内核已跑通。
- 若目标是**尽快让用户在 ClawHunt 用上** → 直接走 v1 的方向 A（联调），WIP 收尾可后置。
- 若目标是**把 node 分支本身做完整、能干净合并** → 按「11（全量门）必做 → 9（新功能）可做 → 7/8 视情况」排。

---

## 四、待业主决策

- [ ] **是否启动本文这条线（B：补 WIP）**，还是先走 A（ClawHunt 联调）、WIP 后置？
- [ ] 若走 B，**做到哪一步**：只补 11（交付门）？还是 11 + 9（新功能）？7/8 是否就此明确"暂不做"？
- [ ] 步骤 8（改 vendored 上游）是否**直接标记为"放弃/无限期延后"**，以符合「不改上游」铁律？

---

## 五、关键信息速查（承接 v1）

| 项 | 值 |
|---|---|
| WIP 来源文档 | `docs/server-coexist-WIP-status.md`（node 分支） |
| 设计文档 | `docs/persistent-chat-paperclip-native-design.md`（§4/§8/§9） |
| node 分支工作树 | `c:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/SuperClaw-node` |
| 双服务端 compose | `docker-compose.node.yml`（双容器 + socat 边车） |
| 已完成验证报告 | `specs/chat-端到端验证报告.md`（= 第 10 步） |
| 关键不变量 | CLI 唯一事实源；表层零新增内核语义；fail-closed 治理；workspace 单一归属安全 resolver |
