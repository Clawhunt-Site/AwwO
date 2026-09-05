# Web 设置页重设计规划（Settings Redesign Plan)

> 状态：规划已定稿，待实施。2026-06-11 经 Codex（gpt-5.5）与 Gemini 双路批判性咨询后综合裁决。
> 咨询留痕：`.codex-cli-advisor/transcripts/settings-redesign.jsonl`、`.gemini-cli-advisor/transcripts/settings-redesign.jsonl`，简报 `/tmp/settings-redesign-brief.md`。

## 一、问题诊断（代码事实）

用户抱怨：设置页简陋、与其他页面视觉脱节、无复用设计、信息杂乱"不知道它在说什么"。代码梳理证实：

1. **零组件抽象**。设置页约 550 行 JSX 内联在 11353 行的 `apps/web/src/App.tsx`（约 8779–9330 行），11 个功能卡片全部手写 JSX + 专属 class（`.control-card`、`.stacked-field`、`.theme-segmented-control`…），无 `<Card>`/`<Field>`/`<Toggle>` 等复用组件；三个模态（Agent Setup / Plugin Config / Blocking Modal）各自独立实现。
2. **信息架构混乱**。侧边栏 6 个导航项映射 4 个 section，其中 ClawHunt / Runtime / Desktop 三项点进去是同一个 runtime section；存在一个未实现任何功能的假搜索框；Task Browser（操作流）和 Manual Update Path（静态文档）被塞进设置页。
3. **视觉脱节**。项目有完整 CSS token 体系（45+ 变量、light/dark），插件市场页有渐变/icon tile/分隔线的质感，但设置页只是平铺卡片堆砌；且完全无响应式（无 @media）。
4. **状态纠缠**。设置页约 30 个 useState、8 个 useEffect 与全局 App state（workspaceSurface、message、API 缓存）耦合。
5. **正面先例**：插件配置模态已实现契约驱动 UI（内核 `plugin_config.CONFIG_UI_SECTIONS` 下发 basic/advanced 两级 schema，前端按契约渲染）——全项目唯一一处，是本次重构的范式参照。

**两位顾问共同强调的最大坑：用户的真实抱怨是"信息不可理解"，视觉只是症状。IA 重组与文案改写必须和组件抽象同级处理，不能只做视觉美化。**

## 二、设计原则（裁决结论）

1. **行式（Row-based）取代卡片堆砌**。设置页向 macOS / Linear 式 settings rows 看齐：密集、清楚、可扫读，与 Chat 工作台的极简风格统一。卡片只留给复杂模块（如 Agent Doctor 网格）。两位顾问一致反对"抽一个泛用 `<Card>` 把 11 个卡片重新包一遍"——那只是把坏结构组件化。
2. **不引入组件库**（无 MUI/Tailwind）。全部组件基于现有 CSS token（`--bg-card`/`--text-secondary`/`--border-light` 等）；组件 API 只接受语义状态，不接受颜色 class。
3. **契约边界规则**（两位顾问一致，且符合"CLI 唯一事实源"铁律）：
   - **契约驱动**（`ui_contracts.py` / API 下发，前端按 schema 渲染）：凡是会改变 CLI/内核行为、需与 CLI 保持一致、或有校验/默认值/secret 语义的 —— agent inventory、runtime config 条目（type/required/secret/basic-advanced）、plugin config（沿用 section/step 先例）、auth/diagnostics 状态。
   - **前端手写**：只影响 Web shell 展示的 —— 主题、语言、桌面通知、导航 IA、文案、Dialog 布局、响应式。CLI 不需要知道 Web 用深色还是浅色。
   - **明确反对**整页 schema 化（导航/布局/文案全部下发）——那会把前端 IA 塞进 Python 内核，污染唯一事实源，最终变成难调的弱版表单引擎。
4. **保存语义统一**：本地偏好 auto-save 即时生效；契约驱动的 runtime/env 配置涉及校验与生效流程，必须显式 `Save & Apply`，UI 上与本地偏好明确区分。
5. **文案改写成人话**：不要 "Runtime Settings env config items"，要 "Agent environment" / "Execution paths" / "ClawHunt account"；内部字段名降级为 secondary/meta 行显示。中英双语 copy 表同步改。

## 三、组件清单（最小够用集合）

新目录 `apps/web/src/settings/`，配套独立 `settings.css`（消费全局 token，不再往 5327 行的 styles.css 末尾堆 class）。

| 层 | 组件 | 用途 |
|---|---|---|
| 布局 | `SettingsSurface` | 设置页骨架：侧栏导航 + 内容区 |
| | `SettingsSection` | 语义分组：标题、说明、可选状态摘要 |
| | `SettingsPanel` | 一组相关 rows 的容器（取代大卡片） |
| | `SettingRow` | 标准行：label / description / status / control / action |
| 控件 | `TextField` `SecretField` `PathField` `SelectField` `SegmentedControl` `ToggleField` | Field 控件族，覆盖全部配置输入形态 |
| 状态 | `StatusPill` | 统一 connected/error/warning/idle，带绿点，与 Chat 状态 pill 同源 |
| | `Callout` / `EmptyState` | 说明、错误、无数据状态 |
| 行为 | `InlineAction` | 行内按钮：copy / retry / open |
| | `DialogShell` | 统一模态外壳：标题区、footer、focus/escape/backdrop 行为 |
| 契约 | `SchemaFieldRenderer` | 只做**字段级** schema 渲染：runtime config 条目 → `SettingRow` + Field 控件自动映射 |

## 四、新信息架构（4 组导航）

| 组 | 内容 | 数据/保存语义 |
|---|---|---|
| **Preferences 偏好** | Appearance、Language、Desktop Alerts | 本地（localStorage / Tauri），auto-save |
| **Account 账户** | ClawHunt Login（账户、API key、连接状态） | API，状态展示 + 显式操作 |
| **Runtime 运行时** | Agent Runtime Configuration、Runtime Environment（契约驱动 env 项）、Desktop Shell 状态摘要 | 契约驱动，`Save & Apply` |
| **Diagnostics 诊断** | Agent Doctor、Crash & Log Export、深度健康详情；底部一行 About & Updates（版本 + 更新指引链接） | 只读 / 低频运维 |

清理决策（顾问一致）：
- **删除假搜索框**。设置项 30 个以内，良好分类胜过残废搜索；假搜索加重"不知道它在说什么"的不信任感。后续设置项增多再做真过滤（按 title/description/action label，含 no-matches 态）。
- **Manual Update Path 降级**为 Diagnostics 底部的一行帮助入口/外链。它是文档，不是设置。
- **Task Browser 移出设置页**。任务浏览是操作流（operation/workbench），归 Operations/Run Cockpit surface；过渡期在设置页留一个 `Open task browser` link row。

## 五、落地序列（6 个原子 PR，绞杀者模式）

> 每个 PR 独立可 review、可回滚；每个 PR 合并前走 Codex+Gemini 批判性验收门（项目铁律）；发 PR 前先同步 origin/main 前端（全局规则）。

1. **PR-1 `refactor(settings): prune settings IA`** — 纯减法：删假搜索框；Manual Update 卡片原地压缩为紧凑形态（版本 pill + 一行说明 + Copy update command 动作，保留后端下发的 workspaceUpdateCommand 可执行指引）。不改样式、不抽组件。**实施裁决**：Task Browser 的迁移从本 PR 移到 PR-4——迁移需要先有目的地 surface（delivery/Run Cockpit 区域），在纯减法 PR 里贸然搬迁风险大于收益；Manual Update 的最终位置（Diagnostics 底部行）同样在 PR-4 IA 重组时落位，本 PR 只做原地降级。
2. **PR-2 `refactor(settings): isolate settings surface`** — 新建 `apps/web/src/settings/SettingsSurface.tsx` + `settings.css`，把设置页 JSX 整体移出 App.tsx，状态与 API handler 先经 props 传入（后续收敛为 `useSettingsManager()` hook）。行为零变化，目标是先把单体切开。设置页专属模态随迁。
3. **PR-3 `refactor(settings): add settings primitives`** — 落地 `SettingRow`/`SettingsSection`/`Field` 族/`StatusPill`，先 row 化改造低风险块（Appearance/Language/Desktop Alerts），同时补响应式（@media 窄宽适配）。
4. **PR-4 `feat(settings): reorganize navigation and copy`** — 切换到 4 组新 IA，全部文案改写（中英 copy 表），内部字段名降级为 meta；Task Browser 移出设置页（迁往 delivery/Run Cockpit 侧，设置页留 link row）；Manual Update 紧凑行落位 Diagnostics 底部。用户可见变化最大的一个 PR，单独 review，并补"Settings 不再包含 Task Browser 操作流"的断言。
5. **PR-5 `feat(settings): contract-driven runtime config`** — `ui_contracts.py` 补字段级 schema（type/required/secret/basic-advanced），前端 `SchemaFieldRenderer` 消费；引入 `Save & Apply` 语义。内核契约与前端消费分 commit 分层。
6. **PR-6 `refactor(settings): unify dialogs and purge legacy css`** — `DialogShell` 收敛 Agent Setup / Plugin Config / Blocking Modal 三模态（高风险：不得破坏 plugin config 的 secret 不回显、advanced 折叠、保存状态语义）；从 styles.css 删除 `.control-card` 等遗留 class；补齐设置流测试（render/nav/fields/dialog focus）。
   **实施状态（2026-06-12，全部完成）**：拆分执行。**6a 已落地**（6c51d0b）——`.theme-segmented-control`/`.language-switch` 死类清扫。**6b 已落地**（3e41751）——`ui/DialogShell.tsx` 统一三模态外壳（default/wide/full 变体对位旧 footprint；dismissal 语义显式化零变更：blocking 门只能按钮关、plugin modal 保留 Escape/点背景；旧外壳类全退役；`.context-hint` 归位 styles.css；6 个新行为测试钉死 dismissal 契约，app-shell 既有 67 测试零断言改动通过）。**遗留 backlog**：`.control-card` 退役（前提：Account 卡 row 化）、DialogShell focus-trap（a11y 增强，旧实现亦无）。

## 六、风险与坑（顾问指出 + 项目已知）

1. **把设计重做误当视觉美化** —— IA 与文案是主菜，PR-1/PR-4 不可省。
2. **Modal 耦合**：三个模态目前挂在 App.tsx 最外层，强行抽走会陷入回调地狱 → PR-2 把设置页专属模态一并迁入，对外只抛"重新加载内核状态"事件。
3. **Plugin Config 契约语义**：DialogShell 统一外壳时不得破坏 secret 不回显、basic/advanced 折叠、配置保存状态（PR-6 单独做，不与 IA 重组混合）。
4. **styles.css 污染**：新样式一律进 `settings.css`（仍用全局 token），PR-6 做旧 class 清扫。
5. **useEffect 驱动刷新**：拆分后用 `useSettingsManager()` 收敛拉取逻辑，不靠生命周期串 API。
6. **验证假完成**：改源码后用户若跑的是安装版 `/Applications/SuperClaw.app`（冻结 backend），会"看起来没变"——验证要跑 `npm run dev/build/test --prefix apps/web`，桌面侧涉及时还需重打包热替换（见项目记忆 installed-app-frozen-backend）。
7. **前端协作冲突**：每个 PR 发起前 `git fetch origin && merge origin/main`，重点吸收 apps/web 上他人提交，禁 force-push。

## 七、顾问分歧与裁决记录

- **导航分组数**：Gemini 主张 3 组（把 Account 并入 Environment & Auth），Codex 主张 5 组（About & Updates 独立成组）。裁决：4 组——ClawHunt 账户是独立心智模型值得单列；About 只有一行内容，不值得独立成组，降级为 Diagnostics 底部行。
- **PR 顺序**：Gemini 主张先 IA 清理再抽组件，Codex 主张先隔离 surface 再做原语。裁决：合并两者——先做纯减法的 IA 修剪（PR-1，最小风险、缩小待迁移面积），再隔离（PR-2），后续与 Codex 序列一致。
- **搜索框**：Gemini 主张直接删，Codex 主张删或做真搜索。裁决：先删，设置项规模增长后再按 Codex 给的真过滤规格实现。
