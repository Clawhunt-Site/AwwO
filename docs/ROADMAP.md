# SuperClaw 路线图总索引（ROADMAP Index）

> 本文是所有路线图/规划文档的**汇总入口**：只放概览（范围 / 状态 / 优先级 / 配对 / 依赖 + 链接），**不内联内容**，详情点进各文档。
> 设计原则：保持各子系统路线图分布（各自内聚、独立评审），用这一层薄索引提供"总路线图"视图。
>
> **状态图例**：✅ 已完成 ｜ 🚧 部分已建 ｜ 🔧 有代码级实现方案（待开工）｜ 📝 仅设计/规划 ｜ ❄️ 冻结（待前置条件）

---

## 0. 总体节奏层（跨子系统的整体顺序）

这三份是跨域的"总盘"，先看它们定位全局节奏，再看下面各子系统：

| 文档 | 范围 | 状态 | 优先级 |
|---|---|---|---|
| [short-term-roadmap.md](short-term-roadmap.md) | 控制面硬化三阶段：协议骨架 → 运行时健壮性 → verifier/受限 DAG；fail-closed 证据持久化与状态契约 | 🔧 | P0 |
| [roadmap-acceptance-matrix.md](roadmap-acceptance-matrix.md) | 短期 12 项验收 ↔ 实现/测试证据映射（配 short-term）；PR #115–#133 全 Complete；生产 E2E 显式排除 | ✅ | P0 |
| [long-term-roadmap.md](long-term-roadmap.md) | L1–L9 长期愿景：主线整合 → 生产 E2E → replay → verifier → DAG → marketplace → 多 runtime → 生产运营 →（L9 未来目标）跨平台 Windows 支持（移除 POSIX 假设/fail-closed 门可移植化） | 📝 | P0 |

---

## 1. 能力生态（插件 / 技能 / 公司）

| 文档 | 范围 | 状态 | 优先级 | 配对 / 依赖 |
|---|---|---|---|---|
| [capability-workshop-roadmap.md](capability-workshop-roadmap.md) | 能力工坊五方向战略（插件市场更名 + 三来源热更新 + App 自更新 + 提权弹窗 + 任务可视化）；五阶段 P0→P6，信任层与域模型分离、TUF 信任元数据、命名空间硬隔离 | 🔧 | P0 | ↔ impl-roadmap｜依赖 plugin-trust-chain-hardening / unified-task-entry |
| [capability-workshop-impl-roadmap.md](capability-workshop-impl-roadmap.md) | 上者的**代码级实现**（§1–§13）：三资产统一信任原语、catalog resolver、付费/加密/上传/热更新/后台、skill 判别、测试发布、**二进制供应链**、容器隔离、**Bug 优化清单** | 🔧 | P0 | ↔ capability-workshop-roadmap |
| [agent-app-ecosystem-roadmap.md](agent-app-ecosystem-roadmap.md) | Agent 应用容器生态**长期愿景**（插件→声明式面板→MCP host→市场）；采用 MCP Apps 标准、最严治理层差异化 | ❄️ | P1 | 冻结：待 trust chain Phase 0 + 团队产能 + MCP Apps 验证 |
| [clawhunt-marketplace-participation-roadmap.md](clawhunt-marketplace-participation-roadmap.md) | **终端用户参与 ClawHunt 接单市场**：浏览不需身份/接单才需身份；P1 匿名可见市场✅(PR #372) → P2 账户登录🚧 → **P3 在 SuperClaw 内配置 ClawHunt Agent(创建/准入/签发 key)** → P4 在 SuperClaw 内完成竞标/认领/交付(内核能力已具备缺表层)；区别于 long-term L2/L6 的平台/经济视角 | 📝 | P1 | 配对 long-term L2(交付 E2E)/L6(市场经济)｜依赖账户登录 + agent admission |

---

## 2. Agent Runtime / 显示 / 委派 / Prompt

| 文档 | 范围 | 状态 | 优先级 | 配对 / 依赖 |
|---|---|---|---|---|
| [agent-runtime-display-protocol.md](agent-runtime-display-protocol.md) | Runtime↔UI 显示契约：DisplayEvent 信封 + 事件目录 + **字段级**能力矩阵（非粗粒度 FULL/PARTIAL）；三铁律（充分显示/缺字段标 null 降级/绝不伪造） | 📝 | P0 | ↔ display-protocol-impl-roadmap |
| [agent-runtime-display-protocol-impl-roadmap.md](agent-runtime-display-protocol-impl-roadmap.md) | 上者**实施方案 v14**（12 轮双顾问冻结）：7 原子 PR，契约+能力 → codex/claude 投影 → 持久化+snapshot 端点 → 前端 chat/cockpit+SSE 恢复 | 🔧 | P0 | ↔ display-protocol |
| [prompt-envelope-roadmap.md](prompt-envelope-roadmap.md) | 统一 PromptEnvelope IR（6 冻结层）+ 逐 runtime 投影；消除注入面与 0% 缓存命中；charter 进原生 system 通道；projection_loss 审计 | 🚧 | P1 | 依赖 unified-task-entry / runtime-selector-chain |
| [cross-runtime-delegation.md](cross-runtime-delegation.md) | 受治理跨 runtime 委派（向内 chat + 向外 MCP 双向）共用一条 spawn 治理通道；向内 P1 review/hardening 已集成到 `codex/roadmap-cross-runtime-p1-integrate`，含 durable broker wait、child result review gate、API/CLI review surface、parent-state RMW；向外 MCP/P2 仍待做 | 🚧 | P1 | 依赖 streaming-tool-events-fix |
| [runtime-adapter-contract.md](runtime-adapter-contract.md) | **Runtime 治理架构 + 适配器标准协议**：三轨分治（A 类原生投影/B 类 _exec_tool 门/plugin 沙箱）+ 容器 vs intent 门 + control_plane_coverage 诚实声明 + Adapter 契约（代码 Protocol 非总文档）；尺=最佳性能+不破原生 | 📝 | P0 | 索引 permission-mode-framework / display-protocol / prompt-envelope / fusion；详见 capability-workshop-impl-roadmap §8.2/§12/§14 |

---

## 3. Team Kernel / 公司 / 工作区

| 文档 | 范围 | 状态 | 优先级 | 配对 / 依赖 |
|---|---|---|---|---|
| [agent-team-kernel-daemon-pivot.md](agent-team-kernel-daemon-pivot.md) | Daemon 化转向裁决（路线 B）：常驻 daemon + 心跳调度取代 sync-kernel；Paperclip 为强制参考；Phase 2-4 已落入 dev/roadmap，含 bootstrap proposal、durable routines、board inbox、Workbench 操作、chat cost ledger 与硬预算 409 表面 | ✅ | P0 | ↔ paperclip-adoption-plan |
| [workspace-trust-container.md](workspace-trust-container.md) | ADR：Workspace 即信任容器（会话分组+权限边界+项目默认三合一）；repo 锚定、trust-on-create、fail-closed | ✅ | P0 | 依赖 Team Kernel schema |
| [clawwork-two-track-dev-plan.md](clawwork-two-track-dev-plan.md) | ClawWork + Skill/Plugin 双轨重构：skill 原生零 MCP / plugin 治理 MCP；5 PR，PR-1/3/4 已落；PR-2 native store/projection + CLI/API + Web Skills tab 已落；PR-5 本地 broker/control surface 已落，剩余生产 socket/named-pipe daemon 与 hosted distribution 硬化 | 🚧 | P0 | 依赖 plugin-runtime-projection |
| [company-chat-management-design.md](company-chat-management-design.md) | 让 SuperClaw 主 chat（agent runtime）完整管理 company（建/改/招 agent/派工单/archive），白名单 fail-closed + 风险分级人在场 ask；8 安全契约（B1 白名单风险门 / B2 有效权限闭包 / B3 独立 operator-auth 根 + 每次 mutation 人在场签名 / B4 统一 approval ledger + maintenance-gate cutover / B5 company epoch fencing / B6 中心 command registry parity / B7 单源 command models / B8 ExecutionContext scope）；6 fail-closed 相位（工具投影最后）；设计 6 轮 Codex+Gemini 双 PASS | 🚧 | P0 | PR-A.1 已落（生命周期状态+守卫，双PASS）；依赖 cross-runtime-delegation / agent-team-kernel-execution-plan |

---

## 4. 后台任务

| 文档 | 范围 | 状态 | 优先级 | 配对 / 依赖 |
|---|---|---|---|---|
| [background-task-roadmap.md](background-task-roadmap.md) | 后台任务做不做/怎么做：重定义为"受管的会话内后台原语"；并发控制留内核、三级生命周期、按 backend 能力分通知模式；RunSupervisor 延后 | 📝 | P0 | 依赖 cross-runtime-delegation / unified-task-entry / ghost-state-eradication |

---

## 5. TUI / 桌面

| 文档 | 范围 | 状态 | 优先级 | 配对 / 依赖 |
|---|---|---|---|---|
| [tui-desktop-roadmap.md](tui-desktop-roadmap.md) | CLI→Textual TUI→Tauri 桌面六阶段；一份 runtime 多客户端、UI 不拥有交付真相、context 隔离；local-first | 🔧 | — | 依赖 SuperClaw runtime/StateStore/API 契约 |

---

## 6. 架构治理 / 不变量（跨子系统）· 框架参考·未开发

| 文档 | 范围 | 状态 | 优先级 | 配对 / 依赖 |
|---|---|---|---|---|
| [architecture-invariants-roadmap.md](architecture-invariants-roadmap.md) | **【框架参考·未开发·不可生产】** 并行开发架构漂移治理思路：**Test-as-Policy**（`tests/arch/` 函数名即规范 + 设计阶段=`skip` 占位 + 测试树即索引）；结构漂移→CI 架构测试、语义漂移→双顾问派生 checklist。两轮 Codex+Gemini 对抗 + 主代理裁决，但**尚未实现、不构成实际约束** | 📝 | 参考·未承诺 | 依赖 `ui_contracts.py`；牙齿落在 pre-commit/CI（均未建） |

---

## 7. 可观测性 / 诊断 / 埋点（跨子系统·运营侧）

| 文档 | 范围 | 状态 | 优先级 | 配对 / 依赖 |
|---|---|---|---|---|
| [observability-diagnostics-roadmap.md](observability-diagnostics-roadmap.md) | **运营侧可观测与诊断埋点**：本地采集/落盘 + CLI 按需导出，**不占 UI、绝不实时上传用户数据**；分级数据（Tier A 审计/B 诊断 span/C 原始载荷永不离机）、内核诊断事实源（DisplayEvent 从其投影）、框架 choke-point 自动埋点、跨异步/多进程 trace 传播、复现降级为"条件重建+决策回放+根因定位"；P0a→P3，三方对抗式评审（两轮 Codex+agy）定稿 | 🔧 | P0 | ↔ long-term L3(replay)｜依赖 display-protocol / architecture-invariants(Test-as-Policy)｜脱敏范本 relay 审计 |

---

## 配对关系（汇总时一并看）

- **能力工坊**：`capability-workshop-roadmap`（战略）↔ `capability-workshop-impl-roadmap`（代码级）
- **显示协议**：`agent-runtime-display-protocol`（契约）↔ `agent-runtime-display-protocol-impl-roadmap`（实施 v14）
- **总体节奏**：`short-term-roadmap` ↔ `roadmap-acceptance-matrix`（验收）；`long-term-roadmap`（上层愿景）

## 命名说明

- 带 `*-roadmap.md` 的可直接 glob 汇总。
- 本索引另纳入 4 份**未带 `roadmap` 关键字**但属规划范畴的文档：`agent-runtime-display-protocol.md`、`cross-runtime-delegation.md`、`workspace-trust-container.md`(ADR)、`clawwork-two-track-dev-plan.md`、`agent-team-kernel-daemon-pivot.md`。若想统一可发现，可考虑给它们加 `roadmap`/`plan`/`adr` 前后缀。
- docs/ 下还有大量**参考/设计文档**（plugin-trust-chain-hardening、plugin-developer-guide、permission-mode-framework、unified-task-entry 等）非本索引范畴，是上述路线图的依赖/背景资料。

---

*维护提示：新增路线图文档时，在对应主题分区补一行；状态变化时更新图例标记。本索引只指路，不复制内容。*
