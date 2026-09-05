# 能力工坊路线图（Capability Workshop Roadmap）

> 本文是 SuperClaw 面向未来的五大方向规划：能力工坊（插件市场更名）、三来源热更新名单、App 自更新、提权/问询交互弹窗、右侧任务 to-do。
>
> **评审留痕**：本路线图的设计草案已经过 Codex（gpt-5.5）与 Gemini 两路独立对抗式评审（简报见 `/tmp/superclaw-roadmap-brief.md`，transcript 落 `.codex-cli-advisor/`、`.gemini-cli-advisor/`）。两位顾问对原始草案**均判定"不通过"**，且**独立给出了高度一致的病根诊断**。本文是吸收全部阻断性意见后的**修正版设计**，可作为后续逐 PR 实施的基线。每个实施 PR 仍须按项目铁律重新走 Codex+Gemini 验收门。
>
> 关联文档：[[agent-team-kernel-execution-plan]]、[[plugin-trust-chain-hardening]]、[[plugin-ecosystem-framework]]、[[permission-mode-framework]]、[[unified-task-entry]]、[[workspace-trust-container]]、[[plugin-submission-approval-signing]]、[[macos-dmg-release-standard]]。

---

## 0. 北极星原则（裁决后的架构铁律落地）

两路顾问的共识结论凝练为一条总纲，作为本路线图所有方向的约束：

> **先统一"内核契约"，再统一"表层体验"；任何"统一抽象"只能统一到"签名信封 / 传输 / 展示"这一层，绝不能统一到"安装 / 运行 / 授权 / 实例化 / 决策"这一层。**

由此派生五条护栏（每个方向逐条核对）：

1. **信任层与域模型分离**：抽出共享的"签名信封 + 验证原语"（`SignedArtifactEnvelope` + `PackageTrustVerifier`），其上挂**强类型、平行**的域实体（`PluginPackage` / `SkillView` / `CompanyTemplate`），各走各的落地逻辑。**禁止**用 `if kind == 'company': skip_runtime_check()` 这类特例污染插件的严格校验。
2. **信任状态由"验证结果"推导，不信"包内自述"**：`manifest.source.type` 只是包的自我声明，不是信任事实。官方/开发者/本地徽章必须由"签名者 + key registry + revocation + digest + catalog policy + entitlement 全通过"推导。
3. **内核独占关键决策**：更新（是否更新、验签、迁移）、授权（提权/审批裁决）、包隔离（命名空间、同名冲突）三类决策权必须留在 Python core / CLI；API/Web/Desktop 只能调用同一份核心逻辑并投影结果。SSE 只是**通知**，不是**权威**；权威永远是 durable store + CLI/REST snapshot。
4. **fail-closed 是默认而非例外**：网络断、签名失效、TTL 过期、序列回滚、超时、断连——一律降级为拒绝/人审，不静默放行。
5. **身份是 `kind:id:version:digest`，不是 display name**：同 id 不同签名者 = **硬冲突**，致命异常拦截。display name 仅用于展示。

**最大单点风险（双方一致）**：「统一能力 / 统一 UX」滑成后端统一语义 → Web 看着统一、core 实际分裂 → "CLI 唯一事实源"名存实亡、fail-closed 沦为 UI 口号，后面每个方向都会互相放大偏差。**本路线图的全部分期都服务于规避这一风险。**

---

## 0.5　你的五个想法如何落地（正向实施路径）

> **重要定调**：顾问的评审是"如何建得安全"，不是"要不要建"。下面五个想法，**最终用户看到的结果就是你要的样子，一个不砍**。每个都给出"你会得到什么 + 可立即开工的第一步（低风险、用户可感）+ 完整落地链"。

| 你的想法 | 最终用户会看到（=你要的） | 可立即开工的第一步 | 完整链 |
|---|---|---|---|
| **① 能力工坊** | "插件市场"改名"能力工坊"，三个 tab：插件 / 公司 / 技能 | **PR-A1（纯表现层，今天可做）**：改 i18n 字符串 + 加"公司"tab 骨架（先占位）→ 立刻看到愿景成形 | A1 改名+三tab → A2 抽 `PackageTrustVerifier`（纯重构有测试护航）→ A3 `company.json` schema+validate CLI → A4 company proposal/commit　**【2026-06 状态：A1–A4 大部已落】** 改名+三 kind+信任徽章、`PackageTrustVerifier`、company Schema+validate、proposal/commit 均已实现（见 §1 状态表 + §2.5）；剩 company 热更新名单 + Web 实例化向导闭环 |
| **② 三来源 + 热更新** | 每个条目带 官方/开发者/本地 徽章；名单热更新 | **PR-B1（表现层）**：先用**已有**验证信息把官方/本地徽章渲染出来 → 徽章先有，热更新后补 | B1 徽章 → B2 catalog resolver CLI + 命名空间硬隔离 → B3 TUF 元数据拉取（热更新真正打通） |
| **③ App 自更新** | Settings"检查更新"，有更新提示，点击下载安装重启 | **PR-C1（内核地基）**：版本单一事实源 + `superclaw version --json` + 签名 release manifest 格式 | C1 版本契约 → C2 Settings"有更新"卡片 → C3 Tauri 接线下载替换重启 + CI 签名公证 |
| **④ 提权弹窗** | 运行时弹出 文本+N按钮 弹窗，点击即应答 | **PR-D1（内核 P0）**：EscalationEnvelope store + `escalation list/respond` CLI + 收紧 interactive=False | D1 内核升迁原语 → D2 REST+SSE 事件 → D3 Web 通用弹窗+pending 徽章 |
| **⑤ 右侧 todo** | 右侧实时显示任务拆解清单，运行中动态更新 | **PR-E1+E2（小改动！）**：补全 `task.*` 事件 + Web 加入监听列表做增量 live update | E1 事件驱动 → E2 live 渲染 → E3 plan 大纲预览（延后） |

**三个"立刻能看见进展"的高 ROI 起点（我建议从这里开工）**：
1. **① 改名 + 三 tab 骨架** —— 纯表现层，零内核风险，**今天就能做完**，立刻看到"能力工坊"成形。
2. **⑤ 右侧 live todo** —— `TaskGraph` 数据模型与渲染**已经存在**，只差把"快照驱动"改成"事件驱动"，**80% 已具备**，改动很小。
3. **④ 提权弹窗** —— 相对独立、用户可感强、不依赖信任链改造，可较早交付完整体验。

> 这三个起点都不会动到深层信任地基，可以和后台的内核重构（②的 `PackageTrustVerifier`、③的版本契约）并行推进——**你既能马上看到 UI 成果，地基也在同步铺**。

---

## 1. 现状基线（已用代码核实，file:line 可信）

| 方向 | 现状 | 关键事实 |
|---|---|---|
| **插件协议** | ✅ 成熟 | `schemas/superclaw-plugin.schema.json`（JSON Schema 2020-12）；`plugins.py:verify_plugin_package()` 验 digest→manifest 契约→Ed25519 签名→revocation→缓存；三信任类 official/local_dev/fail-closed；`plugin_cloud.py` registry；`/v1/plugins`、`/v1/skills`、`/api/plugins/marketplace-catalog`、`/v1/entitlements/sync` 等端点齐全 |
| **Skill 协议** | ✅ 存在（插件投影） | SKILL.md=frontmatter(name/description)+body；`plugins.py:is_skill_origin_plugin` 是分类单一事实源；`skill_sync.py` **仅 PROXY 层**（discovery-only，执行回 MCP proxy+治理门）；`gate_passing_plugins()` fail-closed 枚举；`/v1/skills` 是 registry 的过滤视图 |
| **Company / Team Kernel** | ✅ 大部已落（2026-06 复核更新，原"无清单/无签名/无 export-import/无模板/无目录"已**过时**） | **第三类签名资产已成型**：`company_template.py` 定义 `CompanyTemplate(SignedArtifactEnvelope)`（:39）+ kind-scoped `_COMPANY_VERIFIER`（:70，**自有** root-key/local-dev/revocation env，绝不复用插件的，护栏 1）+ `validate_company_template_contract()`（:126，JSON Schema + 角色唯一/equipment 引用已声明角色/`reports_to` 无环等关系不变量）+ `verify_company_template()`（:166，load→契约→digest→签名→revocation 全 fail-closed）。**清单/Schema 已存在**：`superclaw-company.json` 清单（:30）+ `schemas/superclaw-company.schema.json`（已落盘）。**目录已联合**：`capability_registry.py` 三 kind 统一收编（`CapabilityKind = plugin\|skill\|company`），`_entry_trust()`（:399）按验证结果推导 `TrustState`。**提交门已接线**：`capability_submission.py:_review_company`（:540）developer 预检门，`capability_devtools.py:_company_metadata`（:305）打 `.sccompany`/目录元数据。**export-import 已存在**：`company_export.py:build_company_export`（:195，COMPANY.md/AGENTS.md/manifest.json 往返）+ CLI `superclaw company export`（cli.py:5431）。**实例化走 proposal-only**：`superclaw team bootstrap --from-template … --mode proposal\|commit`（cli.py:4790，proposal 模式零副作用，commit 对高危走人审审批，护栏：绝不直接落权限/预算/设备）。**仍缺**：company 的热更新名单（TUF delegated targets 尚未接到 company）；从工坊"目录条目→一键实例化向导"的 Web 表层闭环；company 本地发现目录（`.superclaw/companies/`）尚未接入热扫描。 |
| **市场 UI** | ✅ 三 tab + 信任徽章已落 | `App.tsx` 已更名 **Capability Workshop / 能力工坊**（i18n :2083/:2213/:2233/:2363）；`kind: 'plugin' \| 'skill' \| 'company'` 三类已进类型（:1332/:1624/:1870）+ company template 文案（:2541）；信任徽章已由验证结果驱动：`trust?: 'official' \| 'developer' \| 'local' \| 'untrusted'`（:1350），契约枚举 + 文案在 `ui_contracts.py`（:698 `trust_states`、:737-740 `copy.trust`）。**仍缺**：company tab 的"目录→实例化向导"完整交互闭环（详见上一行 company "仍缺"）。 |
| **App 自更新** | ⚠️ 几乎没有 | Tauri v2 已装但 **updater 段未配置**；version 硬编码 0.1.0；`DEFAULT_UPDATE_MODE="manual"`；无 `/api/version`；版本散落 3 文件；CI 仅跑测试无 build/sign/notarize |
| **提权/问询** | ⚠️ 部分，3 套割裂 | `permissions.py` 两态 preset（ask→acceptEdits / allow→bypassPermissions），**`interactive=False` 处处如此**（连 Codex app-server approval 回调都被 policy 自动应答）；TeamKernel `Approval`、治理 `governance-approvals` 收件箱、`human-gate` 三套互不相通；**SSE 无 approval 事件** |
| **右侧 todo** | ⚠️ 部分 | `TaskGraph/TaskNode`(models.py) **已存在**；右侧 "Plan" 面板（`PanelHost.tsx`）仅执行中反应式渲染；`worker.planned` 有，`task.completed/failed` 已 emit 但**不在 Web 监听列表**，状态靠快照重载 |

**核心判断**：地基比预期好——插件协议成熟、skill 是插件投影、TaskGraph 已存在、审批原语已存在。路线图主要是「抽公共信任原语 + 补域模型缺口 + 统一传输/展示但隔离授权」，而非从零造。

> **2026-06 复核补注**：方向一（能力工坊三类资产）已从"规划"走到"大部已落"——共享信任层（`trust.py`）、第三类域模型（`CompanyTemplate`）、company 清单+Schema、三 kind 联合目录（`capability_registry.py` + `/v1/catalog`）、export/bootstrap、Web 三 tab + 信任徽章均已实现。剩余主要是 company 的热更新名单接线与 Web 实例化向导的完整交互闭环。下方 §2.5 记录已落地的统一架构决定；§方向二/方向一的"裁决后方案"已基本对照实现。

---

## 2. 五大方向：修正后的设计

> 每节结构：**目标 → 顾问阻断点 → 裁决后的方案 → 关键契约/数据结构/CLI**。

### 2.5　已落地并确认的统一架构决定（2026-06 复核）

> 这一节把"该统一什么、不该统一什么"的最终决定固化下来——它**已经在代码里成形**，不再是草案。后续任何新资产类型都按此模板接入。

- **统一 SOURCE / TRUST 层（且仅此层）**：抽出 `SignedArtifactEnvelope`（`trust.py:57`，公共信封：id/version/kind/digest/signature 等）+ `PackageTrustVerifier`（`trust.py:112`，解析 manifest → 验 sha256 digest → 验 Ed25519 签名 → 查 revocation），其 verdict 推导 `TrustState ∈ {official, developer, local, untrusted}`（`trust_state.py:29-33`，验证失败/吊销/过期/命名空间劫持一律短路为 `UNTRUSTED`，护栏 4）。**这是唯一被三类资产共享的东西。**
- **plugin / skill / company 保持平行强类型域**：各有**独立**域模型（`PluginPackage` / `SkillView` / `CompanyTemplate`(`company_template.py:39`)）、**独立** Schema（`schemas/superclaw-plugin.schema.json` / `superclaw-company.schema.json`）、**独立** Registry（`capability_registry.py` 按 kind 收编）、**独立**落地：
  - plugin → entitlement / MCP 安装；
  - skill → 投影（`skill_sync.py` PROXY 层，执行回 MCP proxy + 治理门）；
  - company → **proposal-only**（`team bootstrap --from-template --mode proposal|commit`，cli.py:4790，proposal 零副作用、commit 对高危走人审，绝不直接落权限/预算/设备）。
  - 每个域的 verifier 是 **kind-scoped** 的：company 的 `_COMPANY_VERIFIER`（`company_template.py:70`）有自己的 `SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY` / `SUPERCLAW_COMPANY_LOCAL_DEV_TRUST` / revocation env，**绝不复用插件的**（护栏 1）。
- **联合目录 = `CatalogUnion`，键为 kind × TrustState**：三类资产的可发现条目聚合给统一目录面 `/v1/catalog`（`ui_contracts.py:687-744`，`kinds: [plugin, skill, company]` × `trust_states: [official, developer, local, untrusted]`），**只声明"存在 + 可安装"，绝不授权运行**；运行授权仍走各域的 entitlement/policy/proposal。冲突（同 id 不同签名者 / 命名空间劫持 / revoked）在目录层即 `blocks_install`（:713-734）。
- **❌ 必须规避的反模式（已在设计上拒绝）**：**不要**把这三类全部塞进 `plugins.py` 的同一条流水线。一旦那样做，就会在插件的严格校验里加 `if kind == 'company': skip_xxx()` 这类特例——**域污染会削弱插件本应最严的安全校验、引入回归漏洞**。共享只到"签名信封 + 验证原语"为止；安装 / 运行 / 授权 / 实例化 / 决策**各域各管**。

---

### 2.6　已核实的缺口：本地自装 skill 进不了"可装备宇宙"（审计发现）

> 这是一处**已用代码核实**的真实断点，记录在此以免被"company 已大部落地"的乐观掩盖。它同时暴露一个潜在安全不对称。

- **现象**：`superclaw skill import`（CLI handler `cli.py:2356` `_run_native_skill_import` → `skill_store.import_skill`）/ `POST /v1/skills/import`（`apps/api/main.py:6619`）把一个本地 `SKILL.md` 落进**原生 skill store**（`skill_store.py:25` `DEFAULT_SKILL_STORE = ~/.superclaw/skills`）。
- **断点**：团队 agent 的"可装备技能宇宙"由 `team_kernel.available_skill_ids`（`team_kernel.py:110`）枚举——它走的是 `gate_passing_plugins`（`team_kernel.py:130`）over **插件缓存**（`load_cached_package`，:139），且要求 `is_skill_origin_plugin`（:142）。它**从不读原生 skill store**。因此一个 `skill import` 进来的本地 skill **无法被装备到团队 agent** —— **缺一条干净的"本地 SKILL.md → 受治理、可装备 skill"闭环**。今天只有"被包成 gate-passing 的 skill_origin 插件"的 skill 才进得了装备宇宙。
- **潜在安全不对称（今天无害，明天危险）**：原生 skill import 默认 label `local-dev`（`skill_store.py:86`），且**仅当 label ≠ `local-dev` 时才验签**（`skill_store.py:104-105` 调 `_verify_skill_signature`）——即默认导入路径**跳过签名 + revocation 校验**。这今天无害**只因为**这些原生 skill 根本进不了 agent 装备宇宙（上一条断点）；一旦未来补上"本地 skill → 可装备"闭环，**必须同时把签名/revocation 门接上**，否则就是一条绕过治理的提权通道。
- **修法方向（留作 backlog，不在本次 docs 改动范围）**：要么 (A) 让 `available_skill_ids` 也纳入"经治理门验证过的原生 skill"（前提是先给原生 skill 加 fail-closed 的签名/revocation 门），要么 (B) 把"本地 SKILL.md"统一收敛为前述方向一的 `import-skill → 受治理 plugin（PROXY 投影）`单一通道（§方向一"未来独立技能包"已定调：导入后只能生成受治理 plugin，不得开第二条执行通道）。**绝不**在不补治理门的前提下直接把原生 store 接进装备宇宙。

---

### 方向一　能力工坊：三类资产，共享信任、平行域模型

**目标**　把"插件市场"更名为**能力工坊**（英文 Capability Workshop），首页三 tab：**插件 / 公司 / 技能**。三类资产可由官方或开发者提供，未来都有标准化结构。

**顾问阻断点（双方一致，不通过）**
- 把 plugin/skill/company 强行塞进一个 `Capability Package` 并复用 `plugins.py` 整条流水线是**域污染**：plugin 是带 MCP sidecar、暴露 tools 的**可执行外挂**；company 是权限容器/预算/治理规则的**静态治理模板**；二者的安装/运行/授权/实例化语义完全不同。强行兼容必然在校验里加特例，**削弱插件的严格安全校验、引入回归漏洞**。

**裁决后的方案**
- **UI 层**统一为"能力工坊"，三 tab 共用一套目录壳 + source 徽章 + 搜索/筛选/分组（复用现有 `plugin-marketplace-shell`）。
- **后端**严格三层：
  - **信任/分发层（共享原语）**：抽 `SignedArtifactEnvelope`（manifest 信封：id/name/version/schema_version/kind/provenance/source/commerce/acceptance/logo 等公共字段）+ `PackageTrustVerifier`（解析 manifest → 验 sha256 digest → 验 Ed25519 签名 → 查 revocation）。**这是唯一被三类资产共享的东西**。从现有 `plugins.py` 把验签/验 digest/revocation 逻辑无损提取到此模块。
  - **域模型层（强类型、平行）**：`PluginPackage`（现状）、`SkillView`（现状，插件的 `skill_origin` 投影，**不打破**）、新增 `CompanyTemplate`。各自独立 Schema + 独立 Registry，**各走各的落地**：plugin → entitlement/MCP 安装；skill → 投影；company → **只产 proposal diff**（绝不直接落权限/预算/设备）。
  - **目录联合层（只读发现）**：一个 `CatalogUnion` 契约，把三类资产的可发现条目聚合给 UI，但**只声明"存在 + 可安装"，绝不授权运行**。
- **Company 标准化结构**：新增 `superclaw-company.json` 清单 + `schemas/superclaw-company.schema.json`，字段镜像插件信封的 provenance/source/commerce/acceptance，外加 `roles[]`（蓝图角色 charter）、`equipment_requirements`（每角色所需 skill/plugin allowlist）、`policies`（high_risk_policies 模板）、`budgets`。**实例化**走 `team bootstrap --from-template <id> --mode proposal` → 人审 dropped equipment / high-risk → `commit` 落地（接上 P1c 与未提交的 `update_agent_profile`）。Company 模板适配器是 `CompanyTemplate` 域逻辑，**不是** plugin kind。
- **未来独立"技能包"**：即便有朝一日 skill 想独立分发，导入后仍只能生成**受治理的 plugin**（PROXY 投影），**不得开第二条执行通道**。

**关键契约/CLI**
- `ui_contracts.py` 新增 `CATALOG_UNION` 规格（三 kind 的展示字段 + source 徽章枚举 + 冲突规则）。
- CLI：`superclaw catalog list --kind plugin|skill|company`；`superclaw company template validate <path>`（P0 先做校验，P1 才做 export/import/instantiate）。
- 数据结构：`SignedArtifactEnvelope`、`PackageTrustVerifier`、`PluginPackage`、`SkillView`、`CompanyTemplate`、`CatalogUnion`。

---

### 方向二　官方 / 开发者 / 本地 三来源 + 热更新名单

**目标**　工坊里同时展示官方（官方标签）、开发者（开发者标签）、本地三类资产；官方/开发者名单**热更新**（不需重装 app）。

**顾问阻断点（双方一致，不通过）**
- **徽章不能直接信 `manifest.source`**（包内自述非信任事实）。
- **开发者公钥吊销的 fail-closed 漏洞**：静态索引 + 本地缓存，开发者作恶被吊销后，TTL 过期前系统仍信任并执行其高危插件——违反 fail-closed。
- **命名空间劫持**：本地发现的包若与官方同名且本地优先，攻击者放个同名恶意包即可提权。
- **半套"签名静态索引"不够**。

**裁决后的方案**
- **信任状态由验证推导**：定义 `TrustState ∈ {official, developer, local, untrusted}`，由 `PackageTrustVerifier` 的结果计算——`official` = 根公钥验签 + first_party；`developer` = 已注册开发者公钥验签（在 delegated targets 内）+ 未吊销；`local` = `local_dev_trust` 或本地构建；任何验签失败/吊销 → `untrusted`，fail-closed 拒载。
- **热更新框架 = TUF 风格元数据**（裁决：采纳 Codex 的 TUF + Gemini 的命名空间硬隔离，二者兼容）：
  - 角色：**offline root**（冷存，签 key-set 元数据）+ **online targets**（签具体包 digest 的可发现性）+ **snapshot**（单调序列，反回滚）+ **timestamp**（短时效，过期即 fail-closed，**这就是 Gemini 要的吊销新鲜度/CRL 等价物**）+ **delegated developer targets**（每开发者一段委托，支持密钥轮换与按 digest 撤销）。
  - 客户端：`.superclaw/registry/` 缓存元数据 + watermark；每次加载开发者插件或执行高危操作前校验 timestamp 新鲜度；超 TTL 或拿不到最新元数据 + 触碰高危 API → fail-closed（拒载或强制人审）。
  - catalog 索引**只声明 `kind:id:version:digest` 可发现，不授权运行**；运行授权仍走 entitlement/policy。
- **命名空间硬隔离**：官方保留前缀（如 `superclaw.*` / `first_party` 命名段）在代码层写死——非根公钥签名的包用该前缀直接致命异常。同 id 不同签名者 = **hard conflict**，拦截并提示。
- **三来源不自造协议**：复用并泛化现有 `/v1/plugins`、`/v1/skills`，新增 `/v1/companies` + 顶层 `/v1/catalog`（TUF targets 投影）。**所有端点包装同一个 CLI-backed catalog resolver**（CLI 是事实源）。开发者公钥分发 = TUF delegated targets，轮换/撤销随元数据热更新，**无需 app 更新**。
- **本地（第三类）发现**：扫 `.superclaw/plugins/cache` + 新增 `.superclaw/companies/` + skill 投影，标 `TrustState=local`、本地徽章。**优先级规则**：官方 > 开发者 > 本地，但**同 id 永远 hard conflict 拦截**（不静默覆盖）。

**关键契约/CLI**
- `superclaw catalog resolve`（统一 resolver，CLI 事实源）；`superclaw catalog refresh`（拉 TUF 元数据）；`superclaw trust state <id@version>`。
- 数据结构：`CatalogItem`、`TrustState`、`InstallState`、`EntitlementState`；TUF 元数据落 `.superclaw/registry/`。
- 分期：**P0** CLI-backed catalog resolver + 上述状态机 + 命名空间硬规则；**P1** 接 `/v1/catalog`，其余端点包装同一 resolver；**P2** ETag/delta/CDN 优化。

---

### 方向三　App 自更新（check → download → install → relaunch）

**目标**　检查更新 → 有更新则提示 → 点击后下载、验签、安装、退出替换、重启。

**顾问阻断点（双方一致，不通过）**
- **Tauri v2 内置 updater 不能当决策者**：更新检查/下载/验签的权威若落到 Rust 表现层，CLI 用户与桌面用户就成了两套更新治理逻辑——违反铁律 1/2。
- **一个 `VERSION` 不够**：必须区分 desktop shell / bundled core / CLI core / API contract / state schema / plugin contract / projection schema 等多个兼容维度。
- **状态迁移黑盒**：换 `.app` 重启后若新后端需迁移 `state.db`，Tauri 无感知，可能在旧 schema 上崩。
- 草案只解决了下载/安装，没解决版本权威、兼容矩阵、迁移、active run 阻断、rollback 真可用性。

**裁决后的方案 —— Core-governed Update Orchestrator + Tauri as installer**
- **决策与验签留在 Python core**：core/CLI 提供 `superclaw version --json`（多维版本号）、`superclaw update check`（验签 release manifest）、`superclaw update preflight`（阻断条件检查）、`superclaw update state`（迁移/回滚状态）。API 包装 core；Desktop 只**展示** + 调用 Tauri 做**纯 OS 级**下载/替换/重启。
- **签名 release manifest**（`superclaw-releases.json`）：每 channel 的 latest / download_url / sha256 / signature / `min_supported_*`（最低兼容的 core/contract/schema 版本）+ **sequence**（反回滚）。进 `ui_contracts.py`。
- **preflight 硬阻断**（fail-closed）：有 active run / pending approval / 正在装插件 / 持有 projection lock → 拒绝更新或要求先收尾。
- **迁移与回滚**：更新前 core 层创建 `state.db` 快照；新版本 boot 阶段检测 schema 升级先跑 migration，失败可回滚到快照并提示降级；release manifest 带 `min_reader_version` 防新写旧读。
- **桌面整包替换 vs 热替 backend**（裁决回答顾问）：桌面 backend 冻结进 `.app`，**整包替换 `.app`** 符合 macOS 规范、最稳，作为默认；但**触发器必须是 core**（core 验签下载完成后暴露 apply，Tauri 才执行替换+重启）。CLI(pip) 用户单独走 `pip install -U`，版本/channel 语义共用同一份内核契约。

**分期**
- **P0**：version/update/migration 契约 + 签名 release manifest + sequence 反回滚 + preflight 阻断 + state backup / min reader version（**全部内核侧**，不碰 UI）。
- **P1**：Settings "检查更新"卡片接 `update check`；接 Tauri updater 做下载/替换/重启。
- **P2**：后台自动更新、delta、rollback UI、CI/CD（build+sign+notarize+publish + 更新 manifest，见 [[macos-dmg-release-standard]]）。

---

### 方向四　提权 / 问询交互弹窗（统一升迁通道）

**目标**　底层 Agent Runtime 运行时需要提权或向用户发问时，前端弹出可交互弹窗（上方文本 + 下方 N 个按钮，类似 Codex/Claude Code），用户点击即应答（本质类似发一条结构化 Chat 消息）。

**顾问阻断点（双方一致，不通过）**
- **权限域混淆 = 致命提权漏洞**：把 `governance-gate`（支付/扫描拦截）与 `clarifying_question`（业务问询）、`issue_completion`（QA 审批）统一成一个泛型 `EscalationRequest` 的**授权语义**，一旦 UI/路由有洞，攻击者可把高危治理请求伪造成低权限问询绕过 fail-closed。
- **`resume_token` 简单标识符 = 重放攻击风险**。

**裁决后的方案 —— 两层模型：传输/呈现统一，授权硬隔离**
- **公共信封层** `EscalationEnvelope`：放公共生命周期 + 展示字段（`request_id`, `run_id|session_id`, `kind`, `prompt_text`, `options[]{id,label,style}`, `default_option`, `timeout`, `created_at`, `status`）。SSE 新事件 `escalation.requested` / `escalation.resolved` 播到 run/chat 事件流——**SSE 只是通知，不是权威**。
- **底层强类型决策记录**（各自独立 handler，**绝不复用同一套授权逻辑**）：`PermissionEscalation` / `GovernanceGate` / `RuntimeToolApproval` / `PlanApproval` / `ClarifyingQuestion` / `IssueCompletionReview`。`/api/escalations/{id}/respond` 端点内部**按内核物化记录的 `kind` 做强类型路由**：业务问询只唤醒业务逻辑；治理审批必须调专门治理模块校验签名/权限；即使用户点"允许"，pay 意图无已批准权限 + 人审仍由内核保持阻断。
- **防重放/防伪造**：`resume_token` 必须是**内核生成的加密票据**（JWT 或等价），服务端绑定 `principal + policy_snapshot + requested_action + allowed_options + expiry + nonce + run_state`，**单次消费**；resume 前做**二次 policy check**；选项合法性校验。
- **统一 3 套现有系统**：`governance-approvals`、TeamKernel `Approval`、`human-gate` 收敛为 `EscalationEnvelope` 的**传输/呈现**统一（一套 SSE + 一个弹窗 + 一个 respond 端点 + 一套 `superclaw escalation list/show/respond` CLI），但**底层决策记录与授权 handler 各自独立**。
- **底层 runtime 原生 approval 归一化**：Codex/Claude app-server 的原生 approval 回调，在 **SuperClaw Orchestrator 拦截层**转换成对应 Escalation 记录入库 + 挂起 runtime，直到前端回送合法票据再恢复——不破坏各自 sandbox 语义。

**关键的 P0（Codex 单独强调，我采纳）**
- **先收紧 `interactive=False` 的自动应答**：把"非交互默认"从"按 policy 自动应答"改为**对需要人审的动作 fail-closed**（不再静默替用户决定）。补 `superclaw escalation list/show/respond`。**这是整个方向四的地基，必须先于 REST/SSE/弹窗。**

**分期**
- **P0**：收紧自动应答为 fail-closed + durable `EscalationEnvelope` store + typed decision records + CLI。
- **P1**：REST `/api/escalations` + SSE 事件 + Web 通用弹窗 + pending 徽章。
- **P2**：迁移 Codex/Claude 原生 approval 回调进统一通道。

---

### 方向五　右侧 to-do：执行前拆解 + 运行中动态更新

**目标**　复杂任务/对话开始前先拆解成 to-do list；运行中动态更新，像 Codex/Claude Code 那样显示任务流程。

**顾问阻断点**
- **Gemini（不通过）**：对动态 Agent 做**执行前静态预拆解不现实**——LLM 会基于上一步结果动态调整，强制静态 TaskGraph 必然偏离，给用户**虚假的确定性**；允许用户编辑/跳步会破坏 Agent 的 context 连续性与状态机。
- **Codex（不通过）**：`preview-plan` 若只是 Web/API 便利端点会**生成第二套规划语义**；runtime-native todo **不能前端映射**（否则 CLI/Desktop 立刻漂移）；当前 `TaskGraph` 更像描述性状态，不足以支持编辑/跳步/重排。

**裁决后的方案**
- **MVP = 内核拥有的实时执行轨迹**（双方都认可、最安全）：core 持久化 `PlanGraph`（意图大纲/milestones）+ `ExecutionGraph`（真实执行轨迹）+ `TaskEvent(seq)`（带单调序列）+ `TaskSnapshot`。orchestrator 在任务状态变化时 emit `task.started/updated/completed/failed`；Web **只渲染 snapshot**，SSE **只做增量**；序列断裂就 reload snapshot。**不做虚假的执行前确定清单。**
- **plan-only / 大纲（裁决分歧）**：若要"执行前看一眼计划"，必须是**内核拥有的 plan-only phase**（Codex），且呈现为**非约束性"意图大纲 / milestones"**而非确定 checklist（Gemini 的虚假确定性担忧）——**延后到 P1/P2，不进 MVP**。
- **runtime-native todo 归一化**：Claude Code 的 TodoWrite、Codex 的 plan 等原生 todo 流，必须在 **core adapter 层**（如 `claude_adapter.py` / `codex_adapter.py`）归一化成统一 `TaskEvent` 吐出——满足 CLI 唯一事实源，承接 [[unified-task-entry]]（一切皆 task/agent-runtime）。**禁止前端映射。**
- **用户编辑/跳步/重排**：**MVP 坚决不含**（双方一致）。这是深水区，需要 scheduler contract 级的内核支持，留 P2+。

**关键契约/CLI**
- `ui_contracts.py` 新增 task contract（PlanGraph/ExecutionGraph/TaskEvent/TaskSnapshot 展示规格）。
- CLI：`superclaw run plan <run_id> --json`（CLI 可见的 plan-only phase）；`superclaw run tasks <run_id> --json`（snapshot）。
- 分期：**P0** task contract + CLI-visible plan-only phase + 持久化 snapshot + sequenced events + REST snapshot；**P1** 右侧栏 live update + 方向四的 PlanApproval；**P2** 受限用户动作（依赖 scheduler contract）。

---

## 3. 跨方向依赖顺序与分期（两路顾问一致的构建序列）

> **关键提醒**：构建顺序 ≠ 用户列举的 1→5 顺序。Web 表层（能力工坊、弹窗、live todo、热更新 UI）一律**最后**做；先把内核契约/信任/授权/状态地基铺稳，否则每个方向都会互相放大偏差。

```
P0 共享契约地基 ──────────────────────────────────────────────┐
  · ui_contracts.py 统一契约 + CLI/core authority + durable state
  · SignedArtifactEnvelope + PackageTrustVerifier（抽公共验签原语）
  · 提权方向四 P0：收紧 interactive=False → fail-closed + escalation CLI
        │
        ▼
P1 信任元数据与身份 ───────────────────────────────────────────┐
  · TUF 风格元数据（root/targets/snapshot/timestamp/delegated dev）
  · digest identity（kind:id:version:digest）+ 命名空间硬隔离
  · TrustState/InstallState/EntitlementState 由验证推导
        │
        ▼
P2 目录解析与 Company 模板 ────────────────────────────────────┐
  · CLI-backed catalog resolver + /v1/catalog
  · superclaw-company.json 清单 + company template validate/proposal/commit
        │
        ▼
P3 升迁内核（Escalation core 全量）────────────────────────────┐
  · EscalationEnvelope + typed decision records + 加密票据
  · ★ 方向三的更新确认、方向五的 PlanApproval 都依赖它，故须先于二者落 UI
        │
        ▼
P4 TaskGraph 快照/事件 + plan-only phase（方向五内核侧）
        │
        ▼
P5 更新 preflight/version/migration 契约 + 签名 release manifest（方向三内核侧）
        │
        ▼
P6 Web 表层（最后）：能力工坊三 tab + 官方/开发者徽章 + 提权弹窗
   + 右侧 live todo + 热更新 UI + Tauri updater 接线 + CI/CD 签名公证
```

**优先级与价值权衡建议**（供你拍板）：
- 若想**最快见到用户可感价值**：方向四 P0+P1（提权弹窗）与方向五 P0+P1（live todo）相对独立、ROI 高，可在 P0 地基后较早交付。
- 若想**先稳住生态安全底座**：方向一/二（信任原语 + TUF + 命名空间）是其余一切的根，但用户可感知度低。
- 方向三（自更新）依赖最重（版本契约 + 迁移 + CI/CD），建议**最后**做，且 P0 只做内核契约不碰 UI。

---

## 4. 评审结论与留痕

- **草案判定**：Codex（gpt-5.5）与 Gemini **均判定原始草案"不通过"**，病根一致——"统一体验提前于统一内核契约""过度泛化抹平安全边界"。
- **本文状态**：已吸收**全部阻断性意见**重写为修正版设计。两处分歧（方向二 TUF vs CRL、方向五是否预拆解）已由主代理裁决并记录理由（见各方向"裁决后的方案"）。
- **后续门禁**：本文是规划基线，**每个实施 PR 仍须按项目 CLAUDE.md 铁律重新走 Codex + Gemini 验收门**，通过后方可原子化提交。
- **transcript**：`.codex-cli-advisor/transcripts/roadmap.jsonl`、`.gemini-cli-advisor/transcripts/roadmap.jsonl`（已 gitignore）。

---

## 5. 与现有规划的衔接

- 方向一 Company 模板：直接接 [[agent-team-kernel-execution-plan]] 的 P1c bootstrap（template→proposal→人审→seed）+ `update_agent_profile`。**【2026-06：已落地】** `team bootstrap --from-template --mode proposal|commit`（cli.py:4790）、`CompanyTemplate` 域模型（company_template.py）、company 清单+Schema、export（company_export.py）均已实现，见 §1 状态表与 §2.5。
- 方向二 信任：落实 [[plugin-trust-chain-hardening]] 中已成文但未接线的双层密钥/anti-rollback/ticket-in-package，升级为 TUF 风格。
- 方向三 自更新：扩展 [[desktop-manual-update]] 与 [[macos-dmg-release-standard]]，从手动走向 core-governed 自动。
- 方向四 提权：落实 [[permission-mode-framework]] 与 [[permission-broker-plan]] 的"无 Broker、纯传递"方向，但补上**交互式人审通道**这一此前缺失的环节。
- 方向五 todo：承接 [[unified-task-entry]]（一切皆 task/agent-runtime）与 [[codex-like-agentos-app]]。
