# Paperclip 去品牌：剩余工作清单（延后项）

> 状态快照：2026-06-29，分支 `feat/strip-paperclip-display`（基于 `dev/server-refactor`）。
> 本文件记录**尚未处理**的 Paperclip 去品牌项，按业主指示统一延后，留待后续决策/实施。

## 背景：已完成（9 个本地提交，未推）

vendored Paperclip Node server（`server/`，server-refactor 后是真实出货后端）里**用户可见**的 Paperclip 品牌已分批去除：

| commit | 范围 |
|--------|------|
| `03153f15` | web 页面（server/ui + apps/web 向导，可见 278→0） |
| `ad43dc70` | 后端 system-notice 文案 + legacy 兼容识别 |
| `7c828ebf` | Auth/Onboarding 漂浮 ASCII 回形针 → 中性菱形 |
| `1910146f` | storybook 可见品牌词/fixture |
| `c9d7eb47` | adapter 层提示词/标签/文档（~250 处） |
| `4234fa71` | "Paperclip API/Cloud" 显示术语 + 插件描述 |
| `78407c05` | env/header 机器契约改名带双读兼容（`SUPERCLAW_*` / `X-SuperClaw-Run-Id`，`mirrorApiEnvAliases` 5 层安全网） |
| `7c9a21a1` | company-export README 署名 |
| `cb05ad9a` | paperclipai CLI 散文（20 文件 68 处，保留 bin 名/符号/契约） |

**去品牌纪律（沿用）**：散文 → SuperClaw；机器值/符号/env/包名/`.paperclip` 路径/`x-paperclip` 头/代码注释一律保留；`\bPaperclip\b` 词边界天然跳过 camelCase 符号；连字符头（`X-Paperclip-*`）会被词边界误伤，必须显式排除。

---

## 类别 A：~~仍然 APP 可见~~ → ✅ **已完成（commit `40cf18b2`，24 处 / 16 文件）**

> 这些是 server 端 route/service 的字符串、渲染的 SVG、或默认数据值，前面的 web/通知提交没够到。**已统一去品牌为 SuperClaw**（execution-workspace 等执行主体语境用 SuperClaw 避 "workspace…workspace" 套娃）。`successful-run-handoff.ts:15` legacy 锚点按下文保留未动；一处测试断言（company-skills-service "Reserved SuperClaw skill key"）同步。Codex PASS。下列各项为历史记录（均已处理，除显式标注的 legacy 保留）。

### A1. 组织架构图 SVG 文字标签（最显眼）
- `server/server/src/routes/org-chart-svg.ts:563` — `<text ...>Paperclip</text>`，作为水印/标签渲染进公司看板的组织架构图 SVG。
- **动作**：改成 `SuperClaw`（或移除）。注意这是 SVG 文本节点，纯显示，低风险。

### A2. 默认操作者 / 作者名（数据值，渲染进活动流/列表）
- `server/server/src/services/workspace-runtime.ts:3157,3205` — `actor: { name: "Paperclip" }`，活动/事件账本的操作者名，渲染进 APP 活动流。
- `server/server/src/services/company-skills.ts:3958` — `authorName: ... ?? "Paperclip"`，技能默认作者，渲染进技能列表。
- **动作**：默认值改 `SuperClaw`。⚠️ 注意这是**数据值**不是散文——要确认没有下游按 `"Paperclip"` 字面比较/分组（grep `=== "Paperclip"` / `name: "Paperclip"` 的消费端），否则改默认值可能影响过滤/归类。

### A3. 工作区 / 项目 错误与警告（API 422 / 抛错 / warnings，APP 渲染）
- `server/server/src/routes/execution-workspaces.ts:171,335,386` — "...before Paperclip can run/manage workspace commands/local runtime services"
- `server/server/src/routes/projects.ts:422` — "...before Paperclip can run workspace commands"
- `server/server/src/services/execution-workspaces.ts:95,100` — "...so Paperclip cannot inspect git status before close."
- `server/server/src/services/company-skills.ts:219,1700,1702` — 技能导入/定位错误（"Reserved Paperclip skill key..."、"...Paperclip cannot find its local source..."）
- `server/server/src/middleware/private-hostname-guard.ts:47` — "Hostname '...' is not allowed for this Paperclip instance."
- **动作**：散文 → SuperClaw。低风险（纯错误/警告文案）。

### A4. 工单线程 / 导入 状态消息（issue thread 内可见）
- `server/server/src/services/heartbeat.ts:7564` — "Cancelled because issue dependencies are still blocked; Paperclip will wake the assignee when blockers resolve"
- `server/server/src/services/company-portability.ts:1260` — "...Paperclip will import the routine trigger without those limits."
- **动作**：散文 → SuperClaw。⚠️ 先确认这些不是 `ad43dc70` 那类**需要 legacy 兼容识别**的通知 body（若有 recognizer/matcher 按旧 body 去重，须同步 matcher，参考 ad43dc70 的处理）。

### A5. 服务端文案/描述（设置/诊断/插件列表等处可能渲染）
- `server/server/src/routes/llms.ts:37,72` — `# Paperclip Agent Configuration Index` / `# Paperclip Agent Icon Names`（served llms.txt）
- `server/server/src/services/environments.ts:24` — "Default execution environment for Paperclip runs on this machine."
- `server/server/src/services/environment-probe.ts:34` — "Local environment is available on this Paperclip host."
- `server/server/src/routes/plugins.ts:313` — "Bundled Paperclip plugin from ..."（插件描述）
- `server/server/src/services/adapter-plugin-store.ts:75` — "Managed directory for Paperclip external adapter plugins..."
- `server/server/src/routes/board-chat.ts:90` — agent 提示散文 "company through Paperclip. Help them create companies..."（agent 可能回显给用户）
- `server/server/src/services/hire-hook.ts:10` — agent 提示 "...assign you a task in Paperclip..."（agent 可能回显）
- **动作**：散文 → SuperClaw（board-chat/hire-hook 属 agent 提示，按 c9d7eb47 的 prompt 去品牌纪律处理）。

---

## 类别 B：**机器契约 / 需业主决策**（不是改字符串能解决）

### B1. telemetry / 反馈遥测远端
- `server/server/src/services/feedback-share-client.ts:5` — `DEFAULT_FEEDBACK_EXPORT_BACKEND_URL = "https://telemetry.paperclip.ing"`
- `server/packages/shared/src/telemetry/client.ts:10` — `"https://telemetry.paperclip.ing/ingest"`
- **本质**：真实数据流向第三方域名 `paperclip.ing`，改字符串无用。**需决策**：① 指向你自己的遥测后端、② 关闭/默认不上报、③ 保留现状。

### B2. 云同步签名头 `X-Paperclip-Upstream-*`
- `server/cli/src/commands/client/cloud.ts:515-518` — `X-Paperclip-Upstream-Source-Instance-Id / Proof-Timestamp / Proof-Nonce / Proof-Signature`
- 接收端（`server/server/src/services/cloud-upstreams.ts` 等）按这些头名验签。
- **本质**：wire 协议头，**不是 APP 可见**。改名要**收发两端 + 你的远端实例一起发版**，否则跨实例验签断。cloud_sync 实验功能默认关。**需决策**：是否值得为非可见的 wire 头承担双端同步成本。

### B3. `paperclipai` CLI bin 命令名 + 关联引用
- `server/cli/package.json` bin `paperclipai`、`.name("paperclipai")`、`paperclipai run/onboard` 引用、README line 160 `pnpm paperclipai company import`。
- 业主已裁"**保留 CLI 代码、只去品牌散文**"（见 `cb05ad9a`）；bin 名作为机器契约保留。
- **若未来要改名**：是改命令契约（连 bootstrap 文案/文档/package.json bin/用户肌肉记忆），要么带双名兼容、要么全链同步。README line 160 的导入命令届时一并解决（SuperClaw 目前无 1:1 `company import <url>` 命令）。

---

## 类别 C：**非用户可见**（低优先级，可选）

- **代码注释**（按纪律保留）：`org-chart-svg.ts:2`、`chat-compat.ts:667/770/772/776/778`、`plugin-loader.ts:66/67/419/435/436/583/1337`、`plugin-registry.ts:54/513`、`plugin-host-services.ts:478`、`plugin-job-coordinator.ts:19`、`plugin-event-bus.ts:2`、`chat-runtime-selection.ts:5`、`chat-pins.ts:9`、`agents.ts:238`、`adapters.ts:11`、`workshop-contracts.ts:15`、`verify-package.ts:10`、`builtin-adapter-types.ts:2`、`global-runtime-skills.ts:10/299`、`superclaw-environment.ts:2`、`plugin-secrets-handler.ts:3` 等。
- **服务端日志**（非 APP）：`index.ts:1097` `logger.error(..., "Paperclip server failed to start")`、`plugin-loader.ts:1216/1308` 抛错（开发者/插件作者向）。
- **运维/admin 错误提示**：`secrets/aws-secrets-manager-provider.ts:30/32/1064/1065/1131`、`adapters/http/test.ts:89`、`services/secrets.ts:135/139`。
- **生成的 .env 注释**：`server/server/src/worktree-config.ts:81,82`（`# Paperclip environment variables` 等，与已改的 cli/config/env.ts 同类，用户在 .env 文件里可见，低优先）。

> 注：`services/recovery/successful-run-handoff.ts:15` 的 "Paperclip needs a disposition..." 很可能是 `ad43dc70` **故意保留的 legacy body**（供 recognizer/matcher 识别旧通知）。改动前必须确认它不是 legacy-compat 锚点，否则会破坏旧通知的去重/识别。

---

## 建议处理顺序（后续）

1. ~~**类别 A**（APP 可见）~~ → ✅ 已完成（`40cf18b2`）。
2. **类别 B1/B2**（telemetry / 云头）—— 各自单独决策，可能涉及远端发版。
3. **类别 B3**（CLI bin 名）—— 仅当确定要改命令契约时，按全链同步/双名兼容处理。
4. **类别 C** —— 可选，低优先，注释按纪律一般保留。

---

## 附录：去品牌端到端验证发现的 dev/server-refactor 预存红测试（与去品牌无关）

2026-06-29 对去品牌全树做了 `pnpm -r typecheck`（EXIT=0 全绿）+ 全量 vitest。**唯一由去品牌引入的回归**（server-startup-feedback-export 的 `SUPERCLAW_API_URL` 测试隔离）已修（`e836ca06`）。其余失败**全部预存于 dev/server-refactor 主干、与去品牌零关**（铁证：失败测试/源码与 base `diff=0` 字节一致；错误是环境/DB/集成性质），记此备查：

- **`issue-watchdogs-routes.test.ts`（8 失败）**：vendored 上游刷新（`90a2efe4`）引入的 DB FK teardown bug——测试 cleanup `delete from "agents"` 撞 `agent_runtime_state_agent_id_agents_id_fk` 外键（子表未先删）。隔离单跑确定性失败。
- **`openapi-routes.test.ts`（1 失败）**："covers the mounted server routes exactly" 报 `unknownRouteFiles: [chat.ts, chat-runtime.ts, chat-skills.ts, chat-stubs.ts]`——server-refactor 新增的 4 个 chat 路由文件未纳入 openapi 覆盖检查。
- **`workspace-runtime.test.ts`（2 失败）**：本机环境 flaky——`provision-worktree.sh` 经 Bun node-wrapper 跑（"does not support a repl"）+ `git push origin main master` 的 `master` refspec 在本机 `init.defaultBranch=main` 下不存在。
- **`plugin-database.test.ts`（1 失败）**：`@paperclipai/plugin-sdk` 未构建的预存 flaky。

> 这些是主干自身需修的（上游刷新 + chat-on-Node 集成遗留 + 测试环境假设），不属于去品牌范围。合并去品牌不会加重它们，也不会修复它们。
