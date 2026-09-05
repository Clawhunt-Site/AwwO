# 统一能力层（Unified Capability Layer, UCL）—— 设计方向

> **状态:方向文档(intent)。三方(主代理 + Codex gpt-5.5 + Antigravity Gemini 3.1 Pro)基于真实代码深度对谈后的收敛结论。先定方向与不变量,不做大重构。**

## 0. 一句话

SuperClaw 要成为「跨底层 Agent Runtime 的通用顶层 Harness」。已有的 `plugin-proxy` 是**执行回流基座之一**,不是三类能力的产品基座。真正要补的是 super 顶层的 **Capability Layer**:把 **plugin / skill / company** 统一成「**可请求能力命名空间 + 策略 + 每-runtime 投影计划**」,再投到各 runtime 的**原生通道**。**统一的是命名空间与投影规划器,不是执行容器。**

## 1. 关键纠正(Codex,主代理认同)

> **不能把 company 伪装成 plugin。** plugin 是第三方 sidecar 工具包;skill 可能是 prose 也可能是 tool 指针;company 是内核里的治理命名空间 + 状态机 + 成员/预算/生命周期/审批。三者**可以同构在「可请求能力」层,绝不该同构在「执行容器」层**。→ 同一个 Capability IR,不同的 execution kernel(`plugin_proxy` / `company_handler` / `skill_runtime` / `GovernedToolExecutor`)。

## 2. 三类能力 × 三轨 runtime 的真实可用矩阵(痛点根源)

| 能力 | A 类 codex/claude | B 类 gemini/anthropic-agent | ClawWork(relay) |
|---|---|---|---|
| plugin | MCP proxy ✓ | `_exec_tool` loop ✓ | ✗ 拒 mcp_configs/plugin_dirs(backends.py:3340) |
| tool-skill | MCP proxy ✓ | ✓ | ✗(fail-closed) |
| prose-skill | 全局 skill 目录 | (prose 注入) | ✓ per-run agent_dir/skills(skill_capability()=relay) |
| company 管理 | operator-mcp 通道 ✓ | `_maybe_add_company_tools`+`company_command_resolver` ✓(backends.py:4165/4247)| ✗ |

**ClawWork 是唯一三类全断点**(自研 harness,经 relay 自解析工具、拒 MCP)。这就是"乱"的根:三类能力靠三套机制各自往每轨投影,没有单一事实表。

## 3. "识别 super chat + 优先 super 工具" —— 打破幻想,分轨定调

**笼统承诺做不到。正确的不变量不是"让 runtime 优先 super 工具"(A 类硬做不到),而是:**

> **凡被声明为 SuperClaw capability 的能力,只能经 super 投影执行;runtime 不支持投影就 fail-closed;高危能力绝不以原生裸工具暴露。**

| 轨 | 能否硬保证"优先/治理" | 机制 |
|---|---|---|
| **B 类** gemini/anthropic-agent | **硬保证** ✓ | SuperClaw 自拥 agent loop + `_exec_tool`;工具表、命名、审批、company resolver 全在 super 内,甚至可剔除原生工具、把 super 工具置顶 |
| **A 类** codex/claude | **只能软引导** | MCP 工具在场 + PromptEnvelope 要求用 `superclaw__call_tool`(main.py:1816/1887);模型仍可绕去用原生 shell/browser。治理发生在 **proxy 执行端**(投影 filter + 执行 recheck),**不在"模型选没选 super 工具"端**。要变硬只能 bwrap/AppArmor 阉割原生工具——代价极大,默认不做。靠"不把高危暴露为裸原生工具"+ 原生 sandbox/approval 兜底 |
| **ClawWork** | **当前空** | 无 MCP 通道,拿不到 super 工具,无从识别 super chat;仅 prose |

## 4. ClawWork 破局(三方一致排序)

1. **(治本)给 ClawWork 接本地 SuperClaw Tool Provider / MCP client**:ClawWork 仍管 loop,但工具 discovery/call 回流本地 super proxy,事件经 RPC。代价=改 ClawWork 工具系统/schema 映射/流式 tool event/ticket;收益=统一策略不破。
2. **(肮脏妥协,不推荐)relay 侧桥 super 工具**:风险最大——本地 secrets / company scope / approval ticket 被迫穿 relay,**破坏"super 是本地控制面"铁律**。只可桥无状态/无密钥/无本地资源的工具。
3. **(过渡)prose 描述 + 模型输出回调 super**:依赖模型按格式说话,非硬工具调用,不能当治理基座。
4. **(当前诚实状态)声明 ClawWork 只支持 prose skill**:plugin/tool-skill/company 一律 fail-closed。

**裁决**:若 ClawWork 是战略 runtime → 走 1(本地 Tool Provider),**绝不先走 2**;在接通前停在 4(fail-closed,不宣传支持)。

## 5. 执行路径统一 —— Router 统一对,生命周期别合并

- **入口表达 UX 形态,不表达内部执行拓扑。** `chat/task/delivery` 三分叉把 UX 概念、后台编排、runtime substrate 混在一起,每加一个 runtime 就爆炸。`parse_chat_route` 已把入口收敛成"一个 runtime turn + overlay"——方向对。
- **但(AGY 第一性反对)**:Chat = 同步、低延迟、强互动短会话;Company/Delivery = **异步后台 job**。**只统一 Router,不合并执行/生命周期**:Router 判定"跟 company 对话/发 delivery"时,应**向后台队列投递异步任务**并立即回"已受理、后台 company 运行中",而不是阻塞在 chat 线程跑完(否则连接断、内存爆、状态机死锁)。Chat 的 runtime 与后台 company 的 runtime 可不同。
- company 从 delivery 剥离自洽:company 不是入口类型,是能力/组织命名空间。chat 里提到 company → 解析成 `CapabilityRequest(namespace=company, action=...)`;需多 agent 则由 planner 启 `company_runtime/multi_agent_runtime`。

## 6. 目标架构骨架

```text
Chat Entry(统一入口,表达 UX:同步 chat vs 异步 job)
  └─ parse_chat_route → CapabilityRequest{ namespace: plugin|skill|company, id/action, exec_mode: sync|async }
        └─ Capability Registry(plugin catalog / skill catalog / company command catalog 统一注册为 SuperCapability)
              └─ Policy + Projection Planner(entitlement/risk/approval/scope/runtime 支持度)
                    └─ Runtime Adapter(按轨投影)
                         A: MCP 投影 + 原生 approval/sandbox 限制(软引导)
                         B: 原生 tool schema + _exec_tool 受治理执行(硬保证)
                         ClawWork: 本地 Tool Provider/MCP client,否则 fail-closed
                    └─ Execution Kernels(分开,不合并):plugin_proxy / company_handler / skill_runtime / GovernedToolExecutor
                         └─ Display/Evidence(统一 SSE/tool 事件/投影审计)
```

### 硬保证 vs 软引导 vs fail-closed 兜底
- **硬保证**:B 类工具调用;plugin sidecar 经 proxy/沙箱;company command 经 `company_handler.execute_company_command`;A 类经 MCP proxy 调回来的能力。super 对所有 `SuperCapability` 的鉴权与执行拦截——无权限绝不执行。
- **软引导**:模型"愿不愿意"选 super 工具(A 类)——只能靠 prompt + 精准工具命名诱导。
- **fail-closed 兜底**:能力矩阵不匹配(ClawWork 调 plugin)、或底层执意用危险原生工具触发沙箱报警 → 中断。

## 7. 落地排序(三方综合)

- **MVP 第一步(Codex,最低风险)**:先落 **Capability Layer IR + projection matrix**——把现有 plugin / tool-skill / prose-skill / company command 都注册成 capability,给每个 runtime 输出明确的 `projected | prose_only | unsupported(reason)`,加 **fail-closed conformance 测试**。让"某 runtime 能不能用 company/plugin/skill"的答案来自**一张事实表**,不再散落在 prompt/proxy/backend 注释里。
- **第二步(AGY)**:在 B 类(自拥 loop)跑通 UCL——plugin proxy 抽基类,tool-skill + company action 作子类,`_exec_tool` loop 内混合挂载;chat 一句话同时用 skill+company+plugin,治理日志见清晰调用记录即第一战赢。
- **第三步**:把 UCL 投影给 A 类 MCP。
- **第四步**:给 ClawWork 接本地 Tool Provider/MCP client(接通前 fail-closed)。

## 8. 与现有工作的关系

- 本次 `skill_runtime.py`(P0-P2:`BackendSkillCapability` 两轴 + `plan_skill_run` + `project_prose_skills` + fail-closed)**已是 Capability Layer 的雏形,只是 scope 在 skill**。UCL = 把它泛化到 plugin + company,统一 IR + projection planner。**不浪费,是种子。**
- `docs/unified-task-entry.md`(入口统一)+ `docs/runtime-adapter-contract.md`(三轨治理 + capability 字段 `control_plane_coverage`/`high_risk_gate_coverage`/`tool_projection`)是 UCL 的上下游,本文是把"能力投影"这层显式化。

## 8.5 对话式创建 skill —— 业主裁决:做 A,B 列长期路线

**A(已选,做主干)= super 主导、runtime 无关的创建链路:**
- super 往底层 runtime 注入一段**简短、规范、严谨**的 system-prompt 规约:用户想创建 skill 时,**不要自行落盘**,而是按 super 格式产出一个 skill **提案**(name 短稳定标识 / description 一句可触发用途 / body 渐进式说明 / 标注 prose vs 有副作用),交回 super 登记。
- super **REGISTER 提案**经治理入库(prose→`import_skill`;有副作用→`skill build`)→ 成为受治理、跨 runtime 可复用的 super skill。
- 检测+起草由 runtime(受注入规约引导)完成;**登记/治理由 super 完成**(否则=单 runtime + 绕治理)。
- 投影路径:MCP runtime(codex/claude/B 类)→ 调 `superclaw__skill_author` 工具回 super;ClawWork(无 MCP)→ runtime 把提案吐在结构化标签里,super turn 后**收割**并登记。两路都回 super 治理入库。
- 触发:`@skill:create` 显式入口 + 注入规约让 runtime 识别 NL 创建意图(规约要短)。

**B(长期路线)= 复用 `superclaw-skill-author` meta-skill 让 agent 主导跑完整流程**(自带 prose/tool 分类、安全扫描、外部 skill 转换)。受 runtime 能力限制(ClawWork 无 CLI/MCP 跑不动 import),作为长期增强,其规范作为 A 起草规约的 checklist 来源内联。

**A 的落地子阶段**:
- **A1(内核,runtime 无关)**:`register_skill_proposal(name, description, body, ...)` —— 从结构化提案经治理入库(prose/tool),返回记录。纯内核、进程内可测。**第一件。**
- **A2**:注入规约(PromptEnvelope 加一段短的 skill-creation 规约)。
- **A3**:MCP 工具 `superclaw__skill_author`(MCP runtime 调回 super)。
- **A4**:ClawWork 提案收割路径。
- **A5**:chat 表层入口(@skill:create + 显示)。

## 9. 关键文件
- 入口/路由:`chat_turn.py`(`parse_chat_route`)
- 三轨治理契约:`docs/runtime-adapter-contract.md`、`agent_runtime/adapter.py`
- plugin proxy:`plugin_mcp_proxy.py`、`plugin_proxy.py`、`plugin_runtime_projection.py`
- company:`company_handler.execute_company_command`、`backends.py`(`_maybe_add_company_tools`/`company_command_resolver`)
- skill:`skill_runtime.py`、`skill_sync.py`
- ClawWork:`backends.py` `ClawWorkBackend`(`skill_capability()`、拒 mcp_configs 处)
