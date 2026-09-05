# 用户名「仅显示层」掩码 — 设计草案（未实现）

> 状态：**待实现 / 待业主拍板范围**。本文记录被推迟的需求与一次失败尝试的根因，避免日后重踩。
> 触发背景：业主要求「以后不要显示什么用户名 / 默认屏蔽用户名」。直接把现成的实例开关
> `censorUsernameInLogs` 默认开启的做法**经核验是真实回归、已撤销**（见下）。本文给出一个
> *安全* 的替代设计。

## 1. 需求

在 SuperClaw 的看板表层（embed `.company-board-root`，以及桌面/Web 默认呈现）里，**默认不向用户展示操作者的本机用户名与 home 目录路径**（如 `/Users/leongong/...`、裸用户名 `leongong`）。这是一个「呈现层隐私默认」，目标是*显示*上不出现用户名，而**不改变任何已存储的数据**。

## 2. 为什么不能直接把 `censorUsernameInLogs` 默认开启（已撤销的尝试）

vendored 看板已有实例开关 `censorUsernameInLogs`（设置页「在日志中屏蔽用户名」）。曾尝试把它的默认值从 `false` 翻成 `true`（`server/packages/shared/src/validators/instance.ts` 的 schema 默认 + `server/server/src/services/instance-settings.ts` 的读路径 fallback），**但该尝试已整组回退**。根因：

- 这个 flag 不只作用于「显示」，它**同时驱动写入时改写**。`server/server/src/services/issues.ts` 的 `addComment`（评论写路径）在 insert 前执行
  `redactedBody = redactCurrentUserText(body, { enabled: censorUsernameInLogs })`，把
  **改写后的正文落库**（`issues.ts:6199` → `:6216`）。
- `redactCurrentUserText`（`server/server/src/log-redaction.ts:107`）替换的是**当前操作者的 OS 用户名 + home 目录路径**为掩码占位符。
- 看板的 **chat：每个 turn = 一条 issue comment**（见 `server/server/src/services/chat-compat.ts` 锚定模型）。`chat-compat.ts:567-572` 明确警告：
  > “A chat instance must therefore not enable `censorUsernameInLogs`, which would also rewrite comment bodies on write.”
- 因此默认开启会在**写入时**永久（有损、不可逆）改写所有含用户名/路径的评论与 chat turn 正文；在 coding agent 场景下 chat 里大量出现 `/Users/<name>/...` 路径，必被掉码。**这会破坏 chat 数据**，不是单纯的显示策略。

> 读路径 `redactIssueComment`（`issues.ts:3356/3395`，经 `listComments`/`getComment` 调用）只在**读取展示**时掩码、不落库；chat-compat 正是绕过这条读路径直接读表以拿到原文。问题完全出在 `addComment` 的**写路径**改写。

结论：`censorUsernameInLogs` 语义 = 「读显示掩码 **且** 写入改写」，二者由同一 flag 耦合。把它当「仅显示掩码」用是错的。

## 3. 安全设计：把「显示掩码」与「写入改写」解耦

目标：默认开启**仅显示**的掩码，**绝不**触发 `addComment` 的写入改写。三条候选路径，按推荐度排序：

### 方案 A（推荐）：拆分成两个独立 flag
- 在实例 general settings 增加 `maskUsernameOnDisplay`（默认 **true**），与现有 `censorUsernameInLogs`（保持默认 **false**，只管写入改写，且默认不暴露 UI）解耦。
- **读路径**（`redactIssueComment` 及 heartbeat/approvals/activity-log/recovery 等所有「读时掩码」点）改为以 `maskUsernameOnDisplay` 为准。
- **写路径**（`addComment`、`approvals.ts:273`、feedback 直接写）**继续**只看 `censorUsernameInLogs`，默认 false → 不落库改写。
- chat-compat 读表绕过的不变量保持成立（写入永不改写 → 即使显示掩码开启，存的仍是原文）。
- 影响面：需逐一审计所有 `redactCurrentUserText`/`redactIssueComment` 调用点（共约 10 处消费者，见 `git grep censorUsernameInLogs`），把「读/显示」类切到新 flag、「写」类保持旧 flag。

### 方案 B：纯前端（embed）显示层掩码
- 在 `apps/web`（`.company-board-root`）渲染层做用户名/路径的可视化替换（类似已有的 CSS chrome 抑制思路，但文本替换需 JS，不是 CSS 能做）。
- 优点：零碰 vendored 后端、零数据风险、与现有 embed-only 覆盖层一致。
- 缺点：① 只覆盖 Web/embed，CLI/桌面原生输出不覆盖（违反「内核唯一事实源」的精神，掩码只在表层）；② 需要可靠的「当前操作者用户名/home」来源传到前端；③ 富文本/转录流式渲染里做替换易漏、易误伤（把正常文本里恰好等于用户名的子串也换掉）。**仅作兜底，不推荐作为主方案。**

### 方案 C：维持现状（已落地）
- `censorUsernameInLogs` 保持默认 false，设置页的该 toggle 已**移除**（防止误开这个会破坏 chat 的危险开关）。
- 代价：看板仍显示用户名/路径。**这是当前状态**，等本设计实现前的过渡。

## 4. 待业主拍板
1. 选 A / B / C 哪条（推荐 A）。
2. 若选 A：`maskUsernameOnDisplay` 默认 true 是否要可关（给个新 toggle）？还是硬编码 always-on 不暴露？
3. 掩码占位符文案（沿用 `log-redaction.ts` 现有 `replacement`，还是 SuperClaw 专属如 `<user>`）。
4. 覆盖面：是否要求 CLI / 桌面原生输出也一并掩码（决定改在内核读路径 vs 仅表层）。

## 5. 关联代码锚点（实现时复核）
- 写路径改写：`server/server/src/services/issues.ts:6199,6216`（addComment）、`approvals.ts:273`、`feedback.ts:~1985`。
- 读路径掩码：`issues.ts:3356-3395`（redactIssueComment）、`activity-log.ts:67`、heartbeat / recovery / workspace-operations 各 `redactCurrentUserText` 调用点。
- 掩码原语：`server/server/src/log-redaction.ts:107`（`redactCurrentUserText`）。
- 设置契约：`server/packages/shared/src/validators/instance.ts`（`instanceGeneralSettingsSchema`）+ `server/server/src/services/instance-settings.ts`（`normalizeGeneralSettings`）。
- chat 不变量警告：`server/server/src/services/chat-compat.ts:560-573`。
