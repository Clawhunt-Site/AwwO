# Skill 统一设计基准：super 三套碎片 → 上游 catalog 模型

> 本文是 `dev/server-refactor` Node 再平台化（§11）下的**设计基准**，与
> `super-node-server-migration-basis.md` 同级。只定方向与分刀、不含实现；后续每一刀都在独立
> `feat/<slug>` worker 分支上做，按 §11.3 合回主干。
>
> **写作依据**：每条结论都来自对当前主干源码的实读（路径 + 行号见正文）。本文 v2 已据 Codex
> 单顾问对抗式评审逐条修正首版的事实错误（字段名 / 目录名 / 外部路径 / adapter id / native-vs-
> plugin-skill 混淆）与设计缺陷（fake 能力 / 绕过 CLI 唯一事实源）。

## 一、问题：super 里 "skill" 现在有三套互不相通的来源

| # | 你在哪看到 | 数据源（API） | 落盘 | 运行时投射 |
|---|---|---|---|---|
| ① 工坊 Overview 的 Skills 区 | `GET /v1/skills`（Python `skill_store`，`App.tsx:5766/10169`） | `~/.superclaw/skills/<slug>/`（`default_skill_store`=`superclaw_home()/skills`，`skill_store.py:94`） | `skill_sync.py:622 sync_native_skills` → `~/.claude/skills/` |
| ② **给 agent / 角色分配 skill** | `GET /api/plugins/status` 里 `skill_origin: true` 的 plugin（`plugins.py:616 is_skill_origin_plugin`），picker 在 `AgentConfigDialog.tsx:158/315/458` | `~/.superclaw/plugins/cache/` | `orchestrator.py:446`：仅把 `skill_allowlist` 授权的 **skill-origin tool plugin** 合进 `available_plugins`；prose skill 不进 = no-op |
| ③ 上游 catalog | 未接入 | `server/packages/skills-catalog/`（`@paperclipai/skills-catalog` v0.3.1，11 个官方 skill） | 未接入 |

注意：① 的 native-skill projection（`sync_native_skills`）与 plugin-skill projection
（`/api/plugins/skills/*` → `sync_plugin_skills`，`App.tsx:10223/10236`、`skill_sync.py:923`）是
**两套不同的 sync**，不要混为一谈。

**直接后果（业主 2026-06-27 实测）**：`AgentConfigDialog` 的 Skills picker 走 ②（skill-origin
plugins，从 `/api/plugins/status` 按 `skill_origin` 切出），提交进 `skill_allowlist`——既看不到 ③
catalog 的 11 个，也看不到 ① 的 native skills。

## 二、上游目标模型（一条成熟、自带治理的链）

vendored `server/` 已有一套完整 skill 模型，应作为统一底座。**外部 API 路径**（gateway 代理 / CLI
client 实际用的，非 router-relative）：

```
全局 catalog  @paperclipai/skills-catalog  (server/packages/skills-catalog)
   │  只读、官方策展、带版本/contentHash；bundled/{docs,product,quality,software-development,
   │  paperclip-operations} + optional
   │  浏览(外部): GET /api/skills/catalog · /api/skills/catalog/ref?ref=…   (cli .../skills.ts:582/590)
   ▼
公司采纳  POST /api/companies/:id/skills/install-catalog   (cli skills.ts:167 → svc.installFromCatalog, company-skills.ts:3850)
   │  → 写 companySkills(DB) + materialize manifest 到该公司 __catalog__ 目录
   │     (materializeCatalogManifestSkillFiles, company-skills.ts:3698/3920；DB sourceLocator 指向它)
   │  → auditCatalogSkillSnapshot 用 contentHash 比对（防篡改/检测本地改动）
   │  ⚠ install 阶段只落 __catalog__ source；__runtime__ 是 agent sync/list 时才按需 materialize（见下）
   ▼
挂给 agent  POST /api/agents/:id/skills/sync  body { desiredSkills }   (cli skills.ts:517/550)
   │  持久化字段是 adapterConfig.paperclipSkillSync.desiredSkills(string[])，
   │  read/writePaperclipSkillSyncPreference(adapter-utils/server-utils.ts:1922/1998)；
   │  buildRuntimeSkillConfig(agents.ts:1425) 读它 → versionSelections → adapter 同步
   ▼
同步到 runtime  agent sync/list 时 materializeRuntimeSkillFiles(company-skills.ts:3999) 把 __catalog__ source
   │  按需 materialize 到 __runtime__；adapter.listSkills/syncSkills → ~/.claude/skills
   │  支持 skill 的 runtime adapter（以 adapters/registry.ts 为准，id 带 _local 后缀：
   │  claude_local·codex_local·cursor·gemini_local·grok_local·opencode_local·pi_local·acpx_local，
   │  外加 hermes_local，adapters/hermes/src/index.ts:23/162）；不支持者 → buildUnsupportedSkillSnapshot
   ▼
卸载  公司维度 deleteSkill(companyId, skillId)   (company-skills.ts:4412)
        被 agent 使用 → 拒删（先 detach）；删 DB row + 清该公司 __runtime__ materialized 文件
        （不动 __catalog__ 源、更不动全局 catalog）
```

### 治理（全部沿用上游既有，super 不凭空造）
- **compatibility**：`assertCatalogSkillInstallable`(company-skills.ts:3800) 只放行 `"compatible"`（11 个全过）。
- **trustLevel**：`markdown_only` / `assets` / `scripts_executables`(可执行脚本)。
  `assertImportedSkillSourceAllowed`(company-skills.ts:189) 对**外部来源**（`github` / `skills_sh` / `url`）
  的 `scripts_executables` **禁止导入**，且 github/skills_sh 必须 pin 固定 commit；官方 catalog 因策展 +
  contentHash 不吃这条。
- **recommendedForRoles**：软推荐（给 designer 建议 wireframe…），非门禁。
- **引用追踪**：`deleteSkill` 拒删正在被 agent 使用的 skill。

## 三、落地分刀（铁律优先级：能力先进 SuperClaw core+CLI，再上表层；runtime 先于 UI）

> 关键修正（Codex 阻断）：① 任何"分配 skill"的业务能力必须**先进 `packages/superclaw` core
> harness 并由 CLI 暴露**，API/Web/gateway 只调同一核心契约——**不允许 `AgentConfigDialog` /
> gateway 直接接上游写端点**（否则形成 CLI 没有的表层业务语义，违反"CLI 唯一事实源 / 表层零新增
> 语义"）。② runtime 桥必须先于 UI：在 catalog skill 真能进 agent runtime 之前，UI 不得以"可分配"
> 形式暴露它，否则就是"看似已分配、实际 no-op"的 fake 能力。

| 刀 | 做什么 | 改哪 | 前置 |
|---|---|---|---|
| **0 core/CLI 契约** | 在 `packages/superclaw` core + CLI 定义统一 skill 契约：浏览 catalog / 公司采纳 / 挂给 agent / 卸载，作为 core harness 能力 + CLI 命令；core 内部对接上游（catalog/company-skills/agent-sync），单一契约在 SuperClaw core | `packages/superclaw`、`cli.py`、`ui_contracts.py` | — |
| **1 runtime 桥（先于 UI）** | 让 catalog skill 真进 agent runtime：经 `paperclipSkillSync.desiredSkills` sync + adapter materialize 到 `__runtime__`/`~/.claude/skills`，agent 实际加载 | adapter 层 / orchestrator skill 注入；**绑 chat-compat / adapter 迁移** | 刀 0 |
| **2 读 UI** | runtime 桥就绪后，agent skill picker 数据源 `/api/plugins/status`(skill-origin plugins) → 经 core/CLI 契约（gateway 代理 `GET /api/skills/catalog` + 公司已采纳 `/api/companies/:id/skills`） | `AgentConfigDialog.tsx`、gateway | 刀 0、1 |
| **3 写 UI** | 分配动作 → 经 core/CLI 契约：`install-catalog`(公司采纳) + `agents/:id/skills/sync`(`{desiredSkills}` 挂载)；super `skill_allowlist` 语义映射到 `desiredSkills` | `AgentConfigDialog`、gateway 代理 | 刀 0、1、2 |
| **4 卸载** | skill 卸载走公司维度 `deleteSkill`(`DELETE …/skills/:id`，拒删被用 + 清 `__runtime__`)，**经 core/CLI**，替代对 skill 套 plugin-uninstall | 工坊 / agent 界面、core/CLI | 刀 0、1 |
| **5 收敛** | 废弃 ①② 两套碎片；工坊 Overview 的 Skills 区从"平铺 native skills"改成"展示 catalog（装给公司）" | `App.tsx` 工坊 | 刀 0-4 |

## 四、关键取舍与排序
- **顺序硬约束**：刀 0（CLI 契约）→ 刀 1（runtime 桥）→ 刀 2-4（UI/卸载）→ 刀 5（收敛）。**刀 2-3 不得
  先于刀 1 上线**（否则 fake 能力）；任何"分配 skill"不得绕过 core/CLI 直连上游（铁律）。
- **gateway 现状**：`apps/gateway` 目前只实现 `/health` + upstream wiring（`app.ts:34`/`config.ts:9`），
  **没有可承接 catalog/company-skill/agent-skill 的代理面**——这些端点的 loopback 代理 + 治理裁决是
  gateway 后续 P-刀（挂在 P1 permissions 前门框架上），不是"已就绪"。
- **不改 vendored 上游**（§11.1④ / §11.8）：`server/packages/skills-catalog` 与 `server/server` 是 vendored
  上游，对接靠 SuperClaw core 适配 + gateway 代理，不改其源码。
- **刀 1 最重**：runtime skill 注入绑 adapter / chat-compat 迁移，随那条主线推进。

## 五、与 plugin 卸载的区别（避免再混淆）
plugin 是"安装到本地缓存（`~/.superclaw/plugins/cache`）的已装项"，`uninstallPlugin` 从本地移除即可
（工坊已实现列表卸载 kebab）。skill 在上游模型里是"全局 catalog 源 → 公司采纳"，**卸载是公司维度的
取消采纳（`deleteSkill`，清该公司 `__runtime__`），不删 `__catalog__` 源、更不删全局 catalog**——所以
skill 不能照搬 plugin 的"全局列表直接卸载"，其卸载属于"公司 ← skill"那一层（刀 4）。
