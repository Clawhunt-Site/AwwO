# 路线图开发公约 · 启动提示词（权威版）

> 把下面 `===` 之间整段贴给每一个要做 SuperClaw 路线图开发的会话/Agent。
> 它是**路线图协调层**(认领台账 + 完成定义),叠加在权威工作流之上:
> **worktree / 分支 / PR / promotion 等机制一律以 `AGENTS.md` 与 `docs/git-workflow-constitution.md` 为准**,本提示词不另立。

---

===

你现在加入 SuperClaw 项目的**路线图开发**。本项目多机器、多 worktree、多 Claude Code 会话并行,已发生过同一个 PR 被两处各做一遍的偏移与重复(跨机/跨会话**未先认领**的协调缺失所致)。这份公约保证大家**开工前先认领、进行中可见、可按会话溯源、完成才进 main**。它是协调层;底层 git 工作流以 `AGENTS.md` + `docs/git-workflow-constitution.md` 为准。

## 一、开发地:各自 worker worktree,不共用 dev/roadmap
- 每条轨道在**自己独立的 worker worktree + 分支**开发:**优先用会话已预置的 worktree**(如 Codex `~/.codex/worktrees/<id>`);手动建则从最新 `origin/main` 切 `feat/<slug>` 或 `codex/<slug>`(落点路径 / `creator.md` / 命名见 `AGENTS.md` Worker Worktree Rules)。**一会话一棵树 + 一个分支,不与别的会话共用。**
- `~/superclaw-wt/roadmap`(分支 `dev/roadmap`)**仅是本地集成沙盘**——把已验证的 worker 分支并进去跑「组合态」测试用;**它不是开发地、不是 PR 源、可被定期重建**。
- **绝不**在本地 `main` 或共享主检出(`~/Documents/superClaw`)上累积 WIP:本地 `main` = `origin/main` 只读镜像,主检出常驻 `main`、保持干净。

## 二、开工三步:先读 → 先认领(带 chat ID)→ 再动手
1. **读** `docs/ROADMAP-STATUS.md`(统一台账);在 §2 表里找你要做的轨道。
2. **查重**:
   - 该轨道状态已是 `in-progress` 且有别的认领者 → **停**,别重复;换一条 `planned` 的,或在台账留言与该认领者协调。
   - 在 §2.1「重复裁决」里若你的范围被裁给了别的线程 → 只做**非重复部分**。
3. **认领(带 chat ID,这是硬规)**:把该行状态改 `in-progress`,在「认领者」列填:
   ```
   <人/机标识> · chat <你这个 Claude Code 会话的完整 session UUID>
   ```
   - **为什么带 chat ID**:任何人对这条轨道有疑问,直接 `claude --resume <uuid>` 打开你这个会话,回看完整推理、双顾问验收、每个提交——不必猜是谁做的。
   - **怎么拿到你自己的 UUID**:看你自己后台任务输出路径 `/private/tmp/claude-*/-Users-leongong-Documents-superClaw/<uuid>/tasks/` 里的 `<uuid>`;或直接问 Leon。
   - ⚠️**只填你自己确定的 chat ID,绝不替别的会话瞎猜 UUID**(本项目已有 160+ 会话,猜映射必错)。别人的认领者留空给本人补。
   - ⚠️**认领要"可见"才算锁——这是 worktree 隔离下的关键**:每会话在自己独立 worktree 里,**只提交在你自己 worker 分支的认领,别的会话(从 `origin/main` 切)看不到、不算锁**。两条路让认领生效,**缺一不可**:
     - **① live 协调(快、用于立即去重)**:开工前**向 Leon 报**你要做哪条轨道——单业主多会话,**Leon 是 live 协调点**,由他防止重复指派。这是即时锁(不必为每次认领走一遍重量级远端流程)。
     - **② durable 记录(权威、跨机)**:台账**权威副本在 `origin/main`**;认领随一笔 **docs-only 台账 PR** 落 `origin/main`(台账是**纯协调元数据**,该 PR 由 Leon 按 `AGENTS.md` 既有 gate 合入——不是 shippable 代码)。合入后所有会话/机器 `git fetch` 即见。
   - **动手前先看最新认领**(不是看你本地旧副本):`git fetch origin && git show origin/main:docs/ROADMAP-STATUS.md`,确认没人已认领该轨道;拿不准问 Leon。

## 三、移交你手上的旧 WIP
若你手上已有这条轨道的未完成 WIP(散在本地 `main`/共享主检出/别的分支),迁进你**自己的 worker 分支**(不是 `dev/roadmap`):
- 未提交改动:在你自己的 worktree 重做或拷入对应文件再提交。
- 已有 WIP 提交:`git cherry-pick <你的 WIP commit>`;冲突**逐处解决,保留团队既有内容,绝不整体覆盖**。

## 四、开发铁律(见仓库 `CLAUDE.md`,不可跳过)
1. 一项「做完」= 相关 `ruff` / `pytest` / `npm test`(对应表层)全绿 + 端到端自走查正确。
2. **「做完」≠「可提交」**:提交前**必须**用两个顾问技能 `codex-cli-advisor`(`--model gpt-5.5`)与 `gemini-cli-advisor`(已停用则用 `agy`)做**对抗式验收(目标是挑错,不是夸奖)**;**两者都明确 PASS、无阻断**才允许提交。任一方指出真阻断 → 先修 → **重跑两路**,直到双 PASS。给顾问自包含简报、要求它们亲自核对本地代码(物理断言以本地为准)。
3. **原子提交**:一个 commit 一件事(可独立 review/回滚);约定式信息 `feat/fix/docs/refactor/test(...)`,正文写「做了什么 + 为什么 + 验收结论(注明 Codex/Gemini 已 PASS)」;**禁止** AI 署名行(`Co-Authored-By` 等);**除非业主显式批准,否则禁止任何分支 `git push --force` / `--force-with-lease`**(重写历史属 destructive,见 `AGENTS.md` Approval Gates;绝不 force 覆盖共享/保护分支)。
4. **提交隔离**:每次用 `git commit -F <msg文件> -- <显式文件路径>` **只提你自己的文件**;提交前 `git status` 核验,**绝不夹带**其它会话改进共享检出的改动(主检出/共享树常有别的会话未提交的改动)。

## 五、状态实时标记
进度变化就更新台账,信息用 `docs(roadmap): <轨道> <状态>`。**顺序(对齐 §六 / AGENTS.md,别颠倒)**:
```
planned → in-progress(认领时)→ in-review(双顾问验收中)
        → done(双顾问双 PASS + 已并入 dev/roadmap 跑组合态集成验证全绿,二者都满足才标)
        → merged(从 worker 分支发 PR、业主批准合入 origin/main 后)
```
- **先集成再 done**:双 PASS 后**先**把 worker 分支并入 `dev/roadmap` 跑组合态集成验证(AGENTS.md:targeting main 前必过);**集成全绿才标 `done`**,然后停下交给 Leon 亲自验证——确保 Leon 验收的是**已集成**的状态,不是未集成的孤岛代码。
- **可见性**:台账权威态以 `origin/main` 为准;中间状态本地更新,**认领 与 done/merged 这两个全局关键节点必须随 docs-only 台账 PR 发布到 `origin/main`**(其余中间 tick 可攒着一起发)。

## 六、流向 main 的唯一通道(对齐 `AGENTS.md`)
- promotion 路径 = **worker 分支 → 本地 `dev/roadmap` 集成验证 → 从同一 worker 分支发/更新 PR 到 `origin/main`**(若仓库已启用 staging-first,则先 PR 到 `staging`,验证后再从同一 worker 分支发 main-target PR)。
- **PR 源始终是 worker / feature 分支,不是 `dev/roadmap`**;`dev/roadmap → main` 不是默认路径,需业主显式批准。
- 本地 `main` = `origin/main` 只读镜像:**只 `git fetch` + `merge --ff-only` 刷新,绝不在其上 commit、绝不接收 `dev/roadmap` 合并**。
- 远端状态变更(`git push` / 开关 PR / 合并)需业主在当前 chat **显式批准**(见 `AGENTS.md` Approval Gates)。

## 七、基线与同步
- worker 分支基线 = **最新 `origin/main`**(不是本地 `main`、不是 `dev/roadmap`、不是别的未完成 worker 分支)。开分支前先 `git fetch`;落后了用 `git merge origin/main` 吸收(尤其前端,见全局前端同步门)。

## 八、不重复造协议 / 不绕治理
- 涉及 runtime/契约,以仓库**既有事实源**为准,别各自猜字段名(已有因猜字段名返工的教训):
  - 显示契约:`packages/superclaw/src/superclaw/display_contracts.py`(`ui_contracts.py` re-export)。
  - codex 真实 v2 协议:`~/Documents/codex研究/codex-rs/app-server-protocol/src/protocol/v2/item.rs`。
- 表层零新增语义、内核独占治理(pay-switch/扫描类一律 fail-closed + 人审),别在表层放行。

## 九、发现重复怎么办
若发现某能力在多处并行做:立刻在台账 §2.1 用**客观证据**(`git show --stat` 比对提交)裁定**唯一权威线程**,其他线程只做非重复部分;裁决只是台账协调,不改别人代码。

## 十、并行会话 / 跨机注意
- 多个本机会话会共用主检出的 `.git`(分支/HEAD/未提交改动互相漂移):每会话各自 worktree、动手前 `git status`、提交 path-scoped 只提自己文件。早期把此漂移归咎 iCloud **已证为误判**,根因是**并行会话共用主检出**(见 `CLAUDE.md` 铁律「并行开发必须 worktree 隔离」)。
- chat ID 的 transcript 是**本机**的(`~/.claude/projects/-Users-leongong-Documents-superClaw/<uuid>.jsonl`):同机会话可 `--resume` 回看;**另一台机器的会话只能在那台机器查**。
- 跨机同步只走 `git push`/`pull`(GitHub),绝不靠文件级同步搬 `.git`。

---
**开始前,先回答:** ① 你读了台账;② 你认领了哪条轨道、填了你的 chat ID;③ 是否需要移交旧 WIP 进你自己的 worker 分支;④ 你这条轨道与现有 in-progress/§2.1 裁决无重叠;⑤ 你在自己独立的 worker worktree 里(不是共享主检出、不是 dev/roadmap)。确认无误后再动手。

===
