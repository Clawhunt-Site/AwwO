# 并行开发 Git 工作流宪法 v11
> Codex(gpt-5.5) + Gemini 十一轮对抗式验收定稿（主体 4 轮 + 落地补丁 7 轮）。
> **v11.1（2026-06-27，Leon 拍板）增补 §十一**:`dev/server-refactor` 集成主干工作流（Node server 再平台化专用，含逐改 Codex 单顾问轻量门 + 末次合 main 满血重门）。
> 本 repo 现实:`ClawHunt-Store/SuperClaw`，GitHub **Free 私有**（无分支保护机制）。本机会同时跑多个 Claude / Codex 会话并行开发本仓 → **每个会话各自独占一棵 worktree、绝不在共享主检出里开发**（见 §四 并行会话隔离硬约束）。

## 〇、最高铁律:CI 边界 = PR 边界
任何要合 main 的 PR 必须在它声明的 base 上独立通过 required CI（构建/测试/迁移/启动）。沙盘通过只证明"终态可能跑通"，不证明每个 PR 可独立合并/回滚/bisect。PR 在自己 base 上红 = PR 边界划错了。
**两类特殊 PR（必须区分）**:
- 沙盘验证 PR:draft、**设为不可合并**，只为远端跑 CI 看集成是否绿。
- 交付型 integration PR:**可合并**，装跨功能胶水/wiring，有明确归属，自己 base 上独立过 CI。

## 一、真相与镜像
- `origin/main` = 唯一真相，只能通过 PR 合入，不直接推。
- 本地 `main` = origin/main 只读镜像，只 `git fetch && git merge --ff-only`，**绝不在上面 commit**。
- 每个功能 = 一个 feature 分支 + 一个独立 worktree，**默认从最新 origin/main 切**（stacked 子分支例外见 §三）。

## 二、测试集成 ≠ PR 交付（核心铁律,混淆两者是一切混乱的根源）
- **铁律 1**:集成沙盘是测试台、**永不作为可合并/交付 PR**（只能是 §〇 draft 不可合并沙盘验证 PR）;定期重建防工作台化。沙盘里为跑通写的胶水/wiring/schema/flag 编排是**遗漏的交付单元**，必须归属到某个功能 PR，或拆成**交付型 integration PR（可合并）**。
- **铁律 2**:让有依赖功能「既独立 PR 又独立过 CI」，只有 4 种合法处理:
  1. 合成一个 PR（真不可分割）。
  2. Stacked PR——CI 跑在父分支 base 上，子 PR base=父分支。
  3. **Feature Flag / Contract-first（推荐，agent 协同最不易崩）**:先合"地基 PR"（契约/接口/开关/默认兜底），后续功能 PR 在开关后默认关、独立可绿。**闭环硬门禁:含 flag-on 新路径的 PR 不得 merge，除非 required CI 已在【当前 PR 内】实跑覆盖 flag-on 路径;若用 companion PR 补测，该 companion 必须【合并前已存在、已绿、强绑定、先合/同队列】——绝不靠"未来承诺"。**
  4. 测试兼容旧路径:缺依赖时 skip/mock/stub。**边界:mock/stub 绑稳定契约;skip 只用于"旧路径天然不适用"，绝不跳过本 PR 引入的交付语义。**
  ❌ 绝不"独立 PR + 仅标注依赖"——CI 红、合不进、锁死链路。

## 三、Stacked PR 实操规范
- 子 PR base = 父分支（不是 origin/main）。子 PR 跟父分支 restack，不 merge main。
- **父 PR squash merge 进 main 后，子 PR 硬门禁（缺一不可）**:① `fetch` + 本地 main `merge --ff-only` 到含父 squash 的当前 origin/main → ② `git rebase --onto origin/main feat/父 feat/子` → ③ retarget PR base 到 main → ④ 重跑 required CI（**旧绿强制失效**）→ ⑤ 重确认 diff 无父分支冗余 → 才可合并。
- 父 PR 被大改/废弃 → 子 PR 底座塌陷需重建。全局开 `git config rerere.enabled true`。

## 四、worktree 更新 + 并行会话隔离硬约束
- 开新功能:`git worktree add <path> -b feat/x origin/main`（stacked 例外见 §三）。base-on-main 分支落后:`git fetch && git merge origin/main`。只在「开分支」「合并 PR 前」两时机追主线。
- 看全貌:`git worktree list` + `git branch -vv` + `gh pr list` + `git log --all --graph`，**无单一"总进度"分支**。
- **并行会话隔离硬约束（本项目最大坑，根因纠正 2026-06-23）**:本机同时跑多个 Claude / Codex 会话开发本仓 → **每个写代码的会话必须在自己的 `git worktree` 里工作，绝不在共享主检出里直接 checkout 功能分支 / 改业务文件 / 提交**。否则分支、HEAD、未提交改动会在会话之间漂移、互相覆盖（曾因此从**过期 base** 切 worktree 而**白做已合并的工作**）。〔注:跨机 / 跨会话「同一 PR 各做一遍」如 `d068933` 是**协调 / 基线缺失**问题——靠开工先认领 + `git fetch` 吸收 `origin/main` 解决,**既不归 iCloud、也不归本机共享检出**这个根因,别混为一谈。〕
  - **⚠️ 历史误判纠正**:此漂移早期被归咎于 **iCloud 跨机同步**（"主仓在 iCloud、另一台机器同步进 `.git`"，并据此把主仓"迁出 iCloud 到 `~/dev/superClaw`"）。**实测为误判**:当前主仓 `~/Documents/superClaw` **不在 iCloud 同步区**（`~/Documents` 无 iCloud xattr），`reflog`/`lsof` 证实分支切换与 commit 全是**本机多个并行会话共用同一检出**所致——与仓库放哪、是否 iCloud **无关**。故旧版「主仓必须迁出 iCloud / 现役 `~/dev/superClaw`」的**因果与路径均作废**;真正且唯一的约束是 worktree 隔离。iCloud 仅在「明文备份/快照被同步卷离机」这类**安全威胁模型**语境下才是真实考量，不是漂移成因。
  - **硬规则（今后必守，不得违反）**:① 每个会话独占一棵 worktree + 一个分支（**优先用已预置的 worktree**——Codex `~/.codex/worktrees/<id>` 或 chat 提供的;手动建则 `git worktree add <path> -b feat/<slug> origin/main`,**必须带 `-b`** 否则 detached HEAD;落点路径 / `creator.md` / 命名见 `AGENTS.md` 的 Worker Worktree Rules），**绝不**两个会话共用一棵 worktree、**绝不**在共享主检出里开发;② 主检出保持"无业务 WIP、源码树干净"——只做 `fetch` / 看全貌（只读）/ `merge --ff-only` 本地 main / `gh pr merge`（业主已批准的远端合并）/ 编译（产物落 gitignored `dist`/`target`,不脏源码），**绝不**在其上 checkout 功能分支 / 改业务源文件 / commit 功能代码，理想态一直贴 `origin/main`;③ 改任何文件前 `git status` 核验,发现共享检出里有别的会话未提交的 WIP **先停手**（备份到 `/tmp` 或让该会话先提交），绝不 `checkout`/`reset`/`stash` 掉别人没存的活;④ 提交只 `git commit -- <显式路径>` 提自己的文件;⑤ 跨机同步**只走 `git push`/`pull`（GitHub）**，每台机器各自独立 `clone`，绝不靠文件级同步搬 `.git`（会损坏 pack、错乱 refs）。
  - **若将来需迁仓 / 重建本地仓:正解 = 全新 clone，非 `mv + worktree repair`**（不限于 iCloud:`mv+repair` 对大 `.git` 本就不可靠——`index.lock` 残留、`.git/worktrees/*` 绝对路径双向绑定易断;若仓库恰在 iCloud / 其他云盘等 File Provider 同步区,dataless 占位符还会额外触发 `bad object`）→ 用**全新 `git clone`** 绕开被污染的 `.git`。**零丢失清单（缺一即丢数据）**:① `git bundle create <bk>.bundle --all` + **逐个 stash 打 tag**（`--all` 不保证含 stash）→ 存安全路径，`git bundle verify`;② 要长期留的未推分支 `push` 到 origin（WIP 先 commit 快照再推），实验/backup 分支留 bundle 冷存;③ **gitignore 的运行态单独迁**——`.superclaw/`（state.db + WAL/SHM、签名 `keys/`、`chat-attachments/`、`plugins/`，约 1G）用 `rsync -a` 迁进新仓（fresh clone 天然不含，漏迁=丢聊天/密钥）;④ `git -c http.version=HTTP/1.1 clone`（大仓 HTTP/2 会 `stream CANCEL` 中断）;⑤ venv 用满足 `>=3.11` 的解释器重建（系统 py3.10 装不上）;⑥ 旧仓 + bundle **保留只读归档**，新仓验证（`superclaw doctor` + 全套 `pytest`/`npm test` 绿）后才删旧。`.codex/worktrees/*` 是 Codex CLI 自管的 detached worktree，别当普通 worktree 迁。

## 五、红线 + merge 门禁
- 永不在本地 main commit / 永不 `git push origin main` / 永不把沙盘整体作可合并/交付 PR。
- **force 限定共享/保护分支**:永不 force push origin/main 或团队共享分支;个人 stack 分支 restack 后 `--force-with-lease` 合法。
- 永不提交在声明 base 上过不了 required CI 的**可合并** PR。
- **无保护分支退路（GitHub Free 私有仓现实）**:
  - **agent 写 main 隔离 = 纪律级（诚实，非机制）**:Free 私有仓权限只到 Repo 级（`Contents: Write`），agent 发 PR 必需此权限 → 物理上即可写 main，**无法靠权限粒度机制阻止**。故"agent 不得以任何途径（push/merge/api/auto/UI）对 main 写入"是**纪律 + 凭据最小化**;**真机制隔离唯一途径 = fork 模型**（agent 推自己 fork、对主仓零写权）或升 GitHub Team+。
  - **merge 原子性 = git 原生 CAS 机制根治（owner 本地脚本，单一 merge owner 串行）**:
    > **不变量:推上 main 的 SHA == 被 required CI〔check-runs + commit statuses 两套全覆盖〕验过的 SHA == 含最新 origin/main 的 SHA;纯 ff;non-ff 拒绝=CAS 挡残余窗口。**
    > 1. pin `H = PR head SHA`;`git fetch origin` + `git fetch origin pull/<PR>/head`（兼容 fork）。
    > 2. **拓扑前置**（=require-branches-up-to-date 手动等价）:`git merge-base --is-ancestor origin/main "$H"` 否则 PR stale → 阻断、要求先更新+重跑 CI。
    > 3. **CI 完整验证**（按 `$H`，GitHub 仅有的两套 CI 报告体系都查）:commit `combined status .state==success` **且** `check-runs` 分页全取无非 success/未完成。任一 failure/pending → 拒绝。
    > 4. `git push origin "$H":main`（纯 ff，推的就是被两套 CI 全验过的 `$H`;non-ff 物理拒绝=CAS:②→④ 间 main 被推进则机制失败 → 回 2）。
    > （用临时引用/PR head SHA，不写本地 main，§一不破。具体 shell 为可持续加固的运维附件。）
  - 合完一个 PR，其余在飞 PR 旧绿失效，下次合前重走上述。
  - **当前落地决策（2026-06-15，Leon 拍板）**:上述 owner 本地 CAS merge 脚本**暂不落地为强制工具**。现阶段 merge owner（Leon）走**人工纪律**——合 PR 前手动 `git fetch` + 确认 PR 已基于最新 `origin/main` + 查 required CI 全绿，再合（GitHub 网页按钮或命令行均可）。CAS 脚本作为**已设计、待落地的安全网**保留在本宪法；**触发落地条件**:① PR 量变大；② 出现 agent 也参与 merge；③ 发生过 stale base 事故。**一劳永逸方案 = 升 GitHub Pro 开分支保护**（服务端自动把关，网页按钮也安全），优先级由 Leon 定。注:CAS 脚本只在"命令行合 PR"时生效，网页点 Merge 用不上——故它与人工纪律是同一安全目标的两种强度，按需升级。

## 六、集成沙盘 SOP（工具兜底）
1. manifest 记录:待集成分支 / 顺序 / 期望 SHA / owner / 冲突策略。
2. 脚本从 origin/main 重建 + `git rerere` 复用冲突。
3. **增量**:已合 main 的分支从 manifest 删除，只重放剩余未合分支（不让沙盘变第二个假 main）。
4. 跑全量测试 + tree-equality;测通过 → 各功能按 §二铁律2 发 PR。

## 七、补充场景
- Hotfix:从最新 origin/main 切独立分支，快速通道直接 PR main，不进沙盘拓扑。
- Release:tag + release 分支。Rollback:`git revert`（不 reset 已 push 的）。
- Schema migration:expand-contract 向后兼容，迁移 PR 独立可回滚。
- Feature flag 生命周期:合入即默认关（且 flag-on 已被 CI 覆盖，§二） → 灰度 → 清理开关。
- 大文件/lockfile/submodule:LFS / 锁文件按生态规范。

## 八、多人团队扩展
§五 的 merge CAS 机制单人多 agent 与多人都适用。多人额外需要:远端 merge queue + CODEOWNERS + 远端临时 integration CI（升 GitHub Team+ 后可用 branch protection 把 §五 自动化）。

## 九、台账迁移（一次性，本 repo 现状）
`docs/ROADMAP-STATUS.md` 旧公约（唯一开发地 dev/roadmap / merge 进本地 main / 基线=本地 main）与本宪法冲突，**作废**:① dev/roadmap 降级 §六 沙盘;② 开发地改各功能各自 worktree 从 origin/main 切;③ **ROADMAP-STATUS.md 不能再是 dev/roadmap 独有可变台账**（与沙盘只读/重建冲突）→ 首次提取为 origin/main 上 docs-only PR（台账新家），之后认领/状态各发小 docs PR，dev/roadmap 旧副本停更。

## 十、存量迁移（一次性，dev/roadmap ahead ~64）
"done 待验证"轨道（多轨交错、466 行级冲突）按「本地 main 安全拆 PR 方法论」迁移:
1. **每条轨道先产出 path ownership manifest**;从 origin/main 切净分支，**所有 restored 路径（不只共享文件）做 restore 后 diff/hunk 归属审计**，杜绝顺手修复/格式化偷带。
2. 共享文件（多轨改的）**绝不 restore 终态**，改 `git show <commit> -- <file> | git apply --3way` 单轨 patch。
3. **tree-equality 只保物理对齐不保可跑** → 每轨额外跑全量测试 + 有冲突/共享文件的轨道走 Codex+Gemini 双顾问语义验收。
4. 多轨依赖用 stacked / feature flag（§二铁律2），单 merge owner 按 §五 CAS 串行合。
5. **试点**:先 run cockpit + cross-runtime P0 两条 done 轨道走通再批量。迁移期 dev/roadmap 只读不接新 WIP。

## 十一、`dev/server-refactor` 集成主干工作流（Node server 再平台化专用，2026-06-27 Leon 拍板）
> 本节是对 §一/§四的**作用域限定例外**，**仅适用于** vendored Paperclip → SuperClaw Node 后端的再平台化工程;其余一切照 §〇–§十。**本节不放宽任何 main 红线（§五）**。
>
> **背景**:`server/` 是逐字 vendored 的 Paperclip（当前定格上游 `f3f50e2` = 上游 master HEAD）。再平台化跨数月、体量巨大（相对 origin/main 153 万行 vendor base），逐改走"重 PR 合 main"不现实 → 用一条**长生命周期集成主干**在**本地循环**承载，末了由 Leon **一次性**合回 main。模式近似项目既有 `dev/roadmap`。
>
> **核心模式（业主 2026-06-27 明确拍板）:开发期 = 纯本地循环 + 只测相关代码 + 补相关 test case;远端推送 / 全量测试 / 合回 main 全部留到 PR 时由 Leon 统一做。**

1. **集成主干 = `dev/server-refactor`**（本地长命分支，常驻 worktree `/Users/leongong/superclaw-wt/server-refactor-to-node`）。已有远端镜像 `origin/dev/server-refactor` 作**可选异地备份**，但**开发期不要求逐改推远端**（见第 4 条）。它**绝不是 `main`**、不享受 main 的真相地位——只是一条平行长命分支。
   - **它是 merge-only 集成主干:绝不在其上直接开发 / 直接 checkout 它来改业务文件 / 直接提交功能代码。** 它只接收三类写入——① `feat/<slug>` 子功能（及回滚用的 `revert/<slug>`，见第 4 条）按第 3 条 merge 回;② 吸收 `origin/main` 的 merge（第 5 条）;③ **主干自身治理 / 工作流文档**（本宪法 / `CLAUDE.md` / `AGENTS.md` / 台账）的维护——这是唯一允许的直接提交类别（类比 §一 对本地 main 的有限操作；**业主 2026-06-27 明确确认保留此例外，非疏漏，勿当漏洞"修掉"**）。**任何功能 / 业务代码 / 重构及其配套测试，都必须在独立 worktree 的 `feat/<slug>` 子分支上做，再 merge 回主干**（见第 2、3 条）。

2. **子功能从本主干切**（不是 origin/main）:`git worktree add <path> -b feat/<slug> dev/server-refactor`，**一会话一树一分支**（§四隔离硬约束照旧）。做完 **merge 回** `dev/server-refactor`（本地）。

3. **逐改门（轻量，对齐既有"测试提速"铁律:开发期只测相关）**:
   - **只测相关**:谁改了哪块代码，就把**那块「相关 + 可能相关」**的 lint / test / build / smoke 跑绿，并**为改动补齐相关测试 case**（单元进程内瞬时、集成归串行家族，见 `CLAUDE.md` 测试金字塔）。**开发期不跑全量**;"不跑全量" ≠ "不跑测试"。
   - **合回主干流程（必须按序，缺一不可）**:
     1. **先把主干更新到最新**——合回前确保本地 `dev/server-refactor` 是最新（期间别的子功能已合入的都要先纳入）;
     2. `git merge --no-commit --no-ff <feat/<slug> 或 revert/<slug>>` 生成**未提交**的 merge 结果，**就地解决所有冲突**;
     3. 在**解决冲突后的 merge 结果**上跑「相关 + 可能相关」测试（含本次补的 test case），**全绿**;
     4. **Codex（gpt-5.5）单顾问**对抗式验收无阻断（业主明确将本线双顾问门降为 Codex 单顾问，Gemini 不强制;简报带验证证据;验的是**解冲突后合回主干的最终 merge 结果**，不只子分支原始 diff）;
     5. 上述全过才 `commit`;任一步有冲突未解 / 测试红 / Codex 阻断 → 在 `feat/<slug>` 里修;若主干已处于未提交 merge 态，先 `git merge --abort` 回到干净主干，再**回到第 1 步重走**（绝不在半合并状态里重复 merge）。
   - **绝不在「落后于主干 / 未解决冲突 / 相关测试未过 / Codex 未通过」任一状态下合回。** 本地原子提交即可，**不强制推远端**。

4. **开发期以本地循环为主，远端可选**:`dev/server-refactor` 先在**本地**积累迭代，**不必逐改交远端**。可选地偶尔 `push origin dev/server-refactor` 作异地备份;**真要推时**——它是【共享分支】 → **永不 force**，push 前先 `git fetch origin` + `git merge --ff-only origin/dev/server-refactor`，non-ff 则重新吸收再合，**绝不 `--force-with-lease` 绕过**;**回滚也守 merge-only**——在 `revert/<slug>` 子分支做 `git revert` 再按第 3 条 merge 回主干，**不直接在主干 revert**（更不 reset 已 push 的）。

5. **漂移提醒（开发期非硬门，但别全攒到 PR）**:本主干长命、PR 稀疏 → 离 `origin/main` 越久越远。**建议**在开新子功能前、或一旦触碰 `apps/web` / `apps/api` / `ui_contracts.py` 等契约 / config 时，顺手 `git fetch && git merge origin/main` 吸收一次（防 `CLAUDE.md` 记录的 stale-base 前端漂移）。业主取舍:开发期换本地循环速度、不设硬性周期门;但越早吸收越省末次合 main 的冲突。

6. **主干台账（保末次可拆分性）**:首个子功能合回时建立 `docs/server-refactor-ledger.md`，每个合回的子功能记 **commit SHA / owner / scope / touched paths / 验证证据 / 未来 PR bucket / 依赖关系**。否则数月后只剩一条不可拆的集成史，违背第 7 条分段 PR。

7. **推远端 / 全量测试 / 合回 main = 全部留到 PR 时，由 Leon 统一做（满血重门，不豁免）**:整体就绪、Leon 决定推 PR 时，第 3 条轻量化**全部失效**，恢复 §〇–§五 全套:
   - ① 先吸收最新 `origin/main`（解前端等冲突）;
   - ② **跑全量**（完整本地 `ci.yml`，pytest 用 `scripts/run-ci-tests.sh`，含 web build/test）——PR 阶段先对总树跑一次全量;**每个可合并 PR 仍须在其声明 base 上独立通过相应 required checks（§〇 PR 边界）**;
   - ③ 按第 6 条台账**分段成可 review 的 PR**——**vendor 导入先单独落地**，重构改动再分块，绝不 153 万行 mega-PR;**vendor-only PR 完整性门**:`server/` 与已固定 vendor pin（默认 `f3f50e2`）**tree equality**、记上游 URL / license、排除 cache/build artifacts、**不混 SuperClaw 定制**（升级上游须走独立 vendor-refresh 门记新 freeze commit，不得末次临时改口）;
   - ④ 每段走 **Codex + Gemini 双顾问**;
   - ⑤ 按 §五 merge 门禁与原子性合入。
   - **逐改的 Codex 单顾问只是工程期加速，绝不延伸到 main**。

8. **去 Paperclip 命名（我们自己新造的命名不得用 "paperclip"）**:本分支开发 / 优化中，**我们新写或改写的内容里，不得引入任何形式的 "paperclip" 作为品牌 / 产品 / 新标识符 / 文案命名**（大小写 / 连写 / `paperclipai` 等变体均算）—— 新建标识符、用户可见文案、产品 / 模块命名、文档叙述、commit / 分支命名一律用 `SuperClaw` 或中性术语。**提交前对自己的 diff 自检**:`git diff | grep -iE '^\+.*paperclip'`，**每一处新增命中都必须落在下列例外内，否则改名**:
   - ① vendored `server/` 的**上游树**逐字保留（第 7 条③ tree-equality / re-vendor），不得为去名而改动它，其内既有 "paperclip" 不在本规则内;
   - ② vendor 快照的**来源溯源**（re-vendor commit 记 `paperclipai/paperclip` + pin + license 归属）—— 开源许可与第 7 条③ 要求的事实归因;
   - ③ **对接 vendored 上游既有标识符所必需的引用**（包名 / 导入名 / 函数 / 字段，如 `paperclipRuntimeServices`、`config.paperclipRuntimeSkills`；**代码或技术文档中的必要引用均算**）—— 改这些等于改上游 API、破坏 tree-equality，属被迫引用而非品牌传播;
   - ④ **本条及治理文档**为定义 / 引用 / 审计该禁用词所必需的事实性提及。
   - **判据**:例外 = 事实性归因 / 被迫对接上游 / 规则自身定义;**禁止 = 我们主动给新事物起带 "paperclip" 的名、或在产品文案里传播该品牌**。

9. **红线照旧**:永不在本地 main commit、永不 `git push origin main`、子功能不得绕过本主干直接对 main 写、**绝不在 `dev/server-refactor` 上直接开发 / 直接提交功能代码（主干 merge-only，见第 1 条）**。

## 十二、vendored 上游（`server/` = Paperclip）re-vendor SOP（与 CLAUDE.md「vendored 上游维护」铁律配套）

> 本节是 CLAUDE.md 同名铁律的**操作细则**:如何在持续同步 Paperclip 官方更新的同时保住本地改动。机制 = bare-prefix vendor + 三方合并重放 + content-addressed 审计 + 测试门。经 Codex(GPT-5.5) + Gemini 3.1 Pro **五轮对抗式验收通过（阻断 10→0）**。

### 0. 定位:(A) 现在生效 / (B) 待建 backlog
- **(A) 现在即刻生效**:纪律 + 已有 git 命令硬门 + 人工 review checklist + 可当场跑的 1-liner,不依赖待建工具。
- **(B) 待建审计工具 backlog**（`scripts/vendor-verify.sh`、`scripts/vendor-audit.sh`、i18n AST 检测器）:命名追踪,落地前**不冒充已生效**,由 (A) 兜底。
- 凡可由一条 shell 命令当场执行的（算 digest、贴 diff、比 tree）属 (A);(B) 仅指批量自动化。

### 0.1 一次性 bootstrap（本节生效前置,必须先做）
1. 建分支 `vendor/paperclip` = 当前纯上游基线（Paperclip `f3f50e2`）,代码落在 **`server/` 前缀下**（与主干 `server/` 路径一致,保证 `git merge` 三方合并）。
2. 写 `server/VENDOR_STATE.json`:`upstreamUrl`、`upstreamSha=f3f50e2`、`currentBaselineCommit=90a2efe4`、`previousBaselineCommit`、`treeHash`（= **upstream root tree hash**,非 vendor commit root tree）、`pnpmVersion`（=`packageManager` 钉版）、`mechanism=bare-prefix`、`sentinel`。
3. 生成初始 `server/vendor-overrides.allow`:**对全部 68 个新增文件 + 191 处就地改逐一按 §十二.2 分类 E/C/G**;所有 C 层（含 `server/ui/src/i18n/localized.ts`、`server/ui/src/context/EmbeddedHostContext.tsx` 等 server/ui 运行时代码）逐条登记 `path | layer | baseline_sha | patch_digest | reason | owner | status=grandfathered | review_evidence=bootstrap-<date>`;E 层须附上游证据;G 层（纯元数据）免 digest。
- bootstrap 落地前,merge-base/tree/digest 门无可信输入 → 本铁律视为**未生效**。

### 1. override 账本（content-addressed,(A) 可当场执行）
- 每条 C 层 override ≥ `path | layer | status | baseline_sha | patch_digest | reason | review_evidence | owner | created_at`。
- **digest 算法钉死（唯一）**:`patch_digest = git diff --binary --no-color --no-ext-diff --no-textconv <baseline_sha> -- <path> | shasum -a 256`（不受本地 git config / attributes / textconv 影响,**人不靠肉眼算 hash**）。
- **(A) 执行手段**:re-vendor 的 review brief / PR（when applicable）对每条受影响 C 层 override:①跑上面 1-liner 得新 digest 与账本比对;②**贴出 `git diff vendor/paperclip..HEAD -- <path>` 真实补丁**供 reviewer 肉眼确认语义。digest 变（hunk 漂移）→ 必须重审 + 更新条目;stale 条目（path 不存在 / baseline 已升未刷新）→ 标记失败。
- (B) `scripts/vendor-audit.sh` 仅把 1-liner **批量**跑遍全账本 —— 自动化,非新能力。

### 2. 改动分层 H/E/C/G（同 CLAUDE.md 铁律 §1,此处为判据细则）
- **H 宿主 / 覆盖层**（`apps/web`,server/ 外）:首选,零上游改动。
- **E 上游扩展点**:add-only 可,登记须**引用上游证据**（exported registry API / 文档化扩展点 / 上游契约）;无证据**降 C**。
- **C 上游核心**:`server/server` routes/services/trust/app.ts/registry、`server/ui` 既有组件 / 页面、**及任何位于 `server/` 内的运行时 / 产品行为代码（含新增）** → liability,须 override + 语义评审;触治理 / fail-closed 须双顾问。**add-only 不等于合规。**
- **G 治理元数据**:**仅** `VENDOR_STATE.json` / `vendor-overrides.allow` / 生成的 `VENDOR_PATCHES.md`;**绝不含运行时代码**;不参与上游三方合并。

### 3. re-vendor 执行步骤（隔离 worktree,主干 merge-only）
1. 隔离 worktree 新建 `chore/revendor-paperclip-<sha>`（绝不主检出 / 共享主干）。
2. `vendor/paperclip` **fast-forward** 到新上游 @<新SHA>（纯导入一提交,编码上游增 / 删 / 改名）。
3. **纯导入硬校验 (A)**:`git rev-parse <新SHA>^{tree}` == `git rev-parse vendor/paperclip:server`（上游 root tree == vendor 分支 `server/` subtree,非 root-to-root）。
4. **基线硬校验 (A)**:`git merge-base HEAD vendor/paperclip` == `VENDOR_STATE.currentBaselineCommit`,否则停手。
5. **三方合并** `git merge vendor/paperclip`（`merge.renames=true`）;**不 rebase 主干**。
6. rename/delete **全矩阵 + 单出审计报告**:`git diff --name-status -M <旧基线> <新基线> -- server/`;逐条迁移 / 弃用 C 层 override 的 path;覆盖 upstream-rename+local-modify、local-add+upstream-add 撞名、rename/rename、modify/delete;**绝不复活上游已删文件**。
7. C 层高风险接点（app.ts/registry/trust/routes/services）**强制语义评审**,产**编号评审证据**;任一无证据 → 不准合（测试绿 ≠ 语义对）。
8. lockfile 由**钉版 pnpm（via `packageManager` / corepack）**重生以减少生成差异;**lockfile diff 仍须人工审查依赖升降级**（不声称自动防回退）;硬门拒 server/ 内 `node_modules` / `dist` / `cache` / build 产物。
9. 跑受影响测试 + override digest 比对（§十二.1 1-liner）;**按本文 §十一 走交付门** —— re-vendor 分支**先本地 merge 回 `dev/server-refactor` 集成验证**;全量 ci.yml + 双顾问**在后续 main-PR 点**触发,不在 trunk 设 PR 门。
10. 记录:新 SHA、tree-hash、冲突数、override 变更、rename/delete 报告,落 commit + `VENDOR_STATE.json`。

### 4. i18n（诚实化）
- `server/ui/src/i18n/localized.ts` 是我们新增的 inline `{en,zh}` helper（**运行时代码 → C 层新增文件**,非 G、非 key/resource 层）。host 侧 locale 切换（`apps/web/src/boardLocale.ts`,server/ 外）属 H。
- 页面内中文文案就地替换 = 不可避免的 C 层 patch → 据实登记 override（带 digest）+ (B) AST codemod 在 re-vendor 时重放。
- 门 (A):新增就地文案替换必须登记 override,否则 review / PR 人工打回;(B) AST 检测器明确违规面（JSX text、aria/title/placeholder、defaultValue;排除 test fixture）后自动化。

### 5. 现状（2026-06-29,待 bootstrap 盘点）
`server/` 相对纯上游基线（f3f50e2 @ `90a2efe4`）:**259 文件 / +18152 / −2030**;新增 **68**（42 在 `server/server`,26 在其它 server/ —— 含 `clawwork-local` adapter 包、`localized.ts`、`EmbeddedHostContext.tsx`）;删除 0;就地改 **191**（`.ts/.tsx`=186,绝大多数 i18n 就地替换）。本铁律**冻结增量、存量渐迁**,不要求立即清零。
