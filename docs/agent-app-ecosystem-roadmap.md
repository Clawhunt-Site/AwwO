# Agent 应用容器生态 — 长期愿景路线图

> ## ⚠️ 状态：长期愿景 · 已冻结 · 短期不排期 · 暂不开发
>
> **本文件是方向性愿景记录，不是开发任务单。** 在下方「解冻条件」全部满足之前：
> - **不**新建相关分支 / worktree，**不**写实现代码，**不**改内核或表层契约。
> - **不**把本文档任何条目当作"待办"领取；CI / backlog / issue 里不应出现它的派生任务。
> - 若有人（含 AI 代理）据此动手，视为越界——请先回到本文件确认状态仍为「已冻结」。
>
> 记录它的唯一目的：把核心目的钉在纸面上，让未来决策有据可依、不跑偏。
> 编写日期：2026-06-12 ｜ 状态复核：未排期

---

## 一、核心目的（愿景陈述）

让 SuperClaw 从「Agent 交付平台」演进为**开放的 Agent 应用容器 / 运行时生态**：

> Agent 公司未来产生的业务必然是多元化的。仅有 `company` 组织体系不足以承载——它还需要能把公司的业务**具象化地运行起来**。
>
> 设想一套**标准化的框架协议**，类似微信小程序：第三方（或 Agent 公司自己）开发的应用**天然适配 SuperClaw**，开发完成后可以**直接在 SuperClaw 中运行**。SuperClaw 由此从"帮你干活的代理"，升级为"承载万千业务应用的开放容器"。

一句话：**把 Agent 公司的业务，从"工具调用"升级为"可安装、可配置、可视化运行的标准化应用"，并向第三方开放。**

---

## 二、为什么短期不做（冻结理由）

经市场调研 + Codex(gpt-5.5) + Gemini 三方批判性分析，结论一致：**方向正确，但现在动手必死。** 冻结基于五条硬约束：

1. **信任链尚未收口。** 现有 plugin 信任链仍有 P0/P1 漏洞（包 digest 未纳入权限位、撤销新鲜度缺失等，见 `docs/plugin-trust-chain-hardening.md`）。地基不稳之上盖应用生态 = 开门揖盗。
2. **治理边界会被冲垮。** 现有能力投影是 fail-closed 的（installed ∩ signed ∩ entitled ∩ policy-allowed）。第三方应用一旦拥有自己的 UI / 状态 / 网络，会天然试图绕过内核裁决——与 Pay-Switch 等治理铁律正面冲突。
3. **抽象会重叠成债。** `skill` / `plugin` / `company` 已是三层。贸然再加 `miniapp` 容器，概念债会压垮代码库与心智模型。
4. **冷启动必败。** GPT Store 是现成反面教材（创作者月入卡死 $100–500）。没有分发势能时自建私有生态，只会留下几个官方空壳 + 维护负担。
5. **生态承诺超出当前承载力。** 一旦叫"生态"，就欠下 SDK / 调试器 / 审核 / 版本兼容 / 结算争议处理的长期债务，与当前单人 + AI 代理的开发规模不匹配。

> 关键洞察：协议本身不难，**真实沙箱、信任链、凭证治理、双表层一致性**才是难点；而协议这部分，行业已经替我们做完了（见下）。

---

## 三、长期分阶段路线（解冻后才执行）

核心战略转向：**不自创小程序协议，而是采纳行业已成形的标准（MCP Apps），做"治理最严的那个宿主"。** 这样开发者不是"为 SuperClaw 写应用"，而是为整个生态写应用，SuperClaw 白拿存量、由生态分摊冷启动成本。每个 Phase 独立有价值、可随时叫停。

### Phase 0 — 前置债：信任链收口（解冻的必要前提）
- 修 `plugin-trust-chain-hardening.md` 的全部 P0/P1：digest 纳入权限位、revocation / entitlement freshness、ticket-in-package、运行前重校验。
- **验收口径**：install → configure → governed action → evidence → revocation blocks 全链路可证伪。
- 不碰任何 UI / 应用概念。这一步即便不做生态，本身也该做。

### Phase 1 — 声明式插件面板（Plugin Panel v0）
- 在现有 plugin manifest 上新增 `ui.panel` 声明节点，**只允许声明式 UI 基元**：参数表单、只读状态栏、日志、结果、触发按钮、配置 schema。
- **绝不允许第三方任意 JS / WebView。**
- 面板上每个动作**无条件路由**现有 governed MCP 管线（entitlement → policy → sandbox → evidence），不给任何旁路后门。
- 先做第一方 reference 面板（Pay-Switch 或 repo-scanner），Web / Desktop 行为一致才算 MVP 成功。
- 定位澄清：这是「插件的受控产品面板」，**不是** miniapp 容器；是 plugin 的 UI 投影，不是新包类型。

### Phase 2 — 成为 MCP Apps 宿主（真正回应"开放生态"愿景）
- 采纳 **MCP Apps** 标准（2026-01 已成为 MCP 首个官方扩展，Anthropic + OpenAI + MCP-UI 联合制定）：`ui://` 资源声明界面 → 沙箱 iframe 渲染 → 宿主↔应用走 JSON-RPC over postMessage、无后门通道、渲染前可审查。
- 战略价值：**为 Claude / ChatGPT / VS Code 写的 app 天然能跑在 SuperClaw**；冷启动由整个 MCP 阵营分摊。
- SuperClaw 的差异化 = 把每个 app 包进 **fail-closed 治理层**（Claude / ChatGPT 宿主都没有这层）——这正是 SuperClaw 的护城河。
- 双表层（Web / Tauri）各实现一遍沙箱宿主，沙箱必须能限制第三方代码的文件 / 网络 / 密钥访问。

### Phase 3 — 分发与商业化（仅当存在真实分发）
- Marketplace、审核上架、版本兼容承诺、计费 / 结算 / 争议处理。
- **触发条件**：Phase 2 之上已有 3–5 个稳定运行的第一方 app + 真实用户分发，否则不启动。

---

## 四、不可逾越的护栏（任何阶段都适用）

1. **CLI 内核仍是唯一事实来源。** 应用 / 面板不得在表层维护并行业务状态或自行发明业务语义。
2. **治理由内核统一裁决。** 任何 app 动作必须经 governed 管线；支付 / 扫描 / 凭证永远 fail-closed，应用不得自持或转发敏感 token。
3. **表层只加"表现层"。** 应用容器可以改变"如何呈现与交互"，不得新增内核没有的业务能力。
4. **不自创协议。** 优先采纳 MCP Apps；除非该标准被证明根本无法承载治理需求，否则不另起炉灶。

---

## 五、解冻条件（满足后方可重新评估排期）

本愿景**仅在以下条件全部成立时**才允许重新评估是否进入 Phase 1：

- [ ] Phase 0 信任链 P0/P1 已全部收口并通过对抗验收。
- [ ] 已有明确的、超出单人维护规模的承载力（团队 / 协作者 / 资源）。
- [ ] 存在被验证的真实需求：至少有具体业务场景因"缺应用容器"而无法交付。
- [ ] MCP Apps 标准在 SuperClaw 治理铁律下被确认可承载（做过技术预研 spike）。

> 在以上未满足前，本文件保持「已冻结」。任何"顺手先做一点"都不被允许。

---

## 六、留痕

- 三方裁决（市场调研 + Codex gpt-5.5 + Gemini）已存项目记忆：`miniapp-ecosystem-verdict.md`。
- 顾问 transcript：`.codex-cli-advisor/`、`.gemini-cli-advisor/`（已被 `.gitignore` 忽略）。
- 关键外部事实锚点：
  - MCP Apps 官方扩展（2026-01）：https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
  - OpenAI Apps SDK：https://developers.openai.com/apps-sdk/
  - 反面教材 GPT Store 冷启动 / 变现天花板。
- 相关内部规划：`docs/plugin-trust-chain-hardening.md`、`docs/capability-workshop-roadmap.md`、`docs/cross-runtime-delegation.md`。
