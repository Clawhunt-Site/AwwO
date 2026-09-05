# 路线图开发 · 统一台账与协作公约

> **这份文件是路线图的「协调台账」(认领 + 状态),不是开发地。**
> 开发在**各自独立的 worker worktree**(见 `AGENTS.md` / `ROADMAP-DEV-PROMPT.md`);`~/superclaw-wt/roadmap`(分支 `dev/roadmap`)**仅是本地集成沙盘**(跑组合态测试,非开发地、非 PR 源、可定期重建)。在这里只做**认领与状态标记**,**避免偏移与重复**(例如同一个 PR 在两台机器/两个 worktree 各做一遍)。

## 0. 为什么有这份台账
项目多台机器 + 多个 worktree + 多个会话并行开发路线图,两类问题分开看:**(协调层)** 跨机/跨会话未先认领 → **重复实现同一 PR**(例如 Display PR-2 在另一台机器另有一份 `d068933`,本仓不可达);**(本地层)** 本机多会话共用同一主检出 → 分支/HEAD/未提交改动**漂移**(早期误判为 iCloud 跨机同步,实为并行会话共用检出,见 `CLAUDE.md` 铁律)。这份台账 + 下面的公约就是为了:**开工前先认领、进行中可见、完成才合并**,杜绝重复与偏移。

## ⚠️ 工作流升级公告(2026-06-15 定稿 · 2026-06-23 旧模型已作废对齐)

并行开发 git 工作流由 **Codex + Gemini 十一轮对抗式验收**定稿为 **[docs/git-workflow-constitution.md](git-workflow-constitution.md)(宪法 v11)** + **`AGENTS.md`(权威工作流)**——含核心铁律「CI 边界 = PR 边界」、测试集成 ≠ PR 交付(沙盘永不可合并 / Feature Flag)、无保护分支 merge CAS、并行会话 worktree 隔离等。

**下面 §1 旧公约里"以 dev/roadmap 为唯一开发地 + 流向本地 main"的部分已正式作废**,改为权威模型(`AGENTS.md` Required Promotion Flow):① 开发地 = **各功能各自 worker worktree**(从最新 `origin/main` 切),`dev/roadmap` 降级为**本地集成沙盘**(只跑组合态测试、定期重建);② 不再"merge 进本地 main"——本地 `main` 是 `origin/main` 只读镜像,**PR 从 worker 分支直接发 `origin/main`**(经 dev/roadmap 集成验证后);③ 本台账迁 `origin/main` 走 docs-only PR 维护。**§1 中仍然有效的是协调机制**(认领 / 状态标记 / 完成定义 / chat ID 溯源 / 不重造协议),下面已就地标注。

---

## 1. 协作公约(所有路线图开发者必读必守)

1. **开发地 = 各自 worker worktree(已对齐 AGENTS.md)**:每条轨道在**自己独立的 worker worktree + 分支**(从最新 `origin/main` 切,优先用预置 worktree)开发。`dev/roadmap` **仅是本地集成沙盘**(并入已验证的 worker 分支跑组合态测试),**不是开发地**。**绝不**在本地 `main` 或共享主检出累积 WIP。
2. **开工前先认领(认领要"可见"才算锁)**:动手前先 `git fetch origin && git show origin/main:docs/ROADMAP-STATUS.md` 看**最新**认领,确认无人在做;再把该行「认领者/状态/分支」改 in-progress、写上你是谁(机器/会话+chat ID)。⚠️**worktree 隔离下,只提交在自己 worker 分支的认领对别的会话不可见**,缺一不可两条路让它生效:**① live 去重**——开工前**向 Leon 报**你要做哪条(单业主多会话,Leon 是 live 协调点防重复指派),即时锁;**② durable 记录**——台账权威副本在 `origin/main`,认领随一笔 **docs-only 台账 PR** 落 `origin/main`(纯协调元数据,由 Leon 按 `AGENTS.md` 既有 gate 合入),合入后全员 `git fetch` 可见。
3. **状态实时标记**:进度变化(planned→in-progress→in-review→done→merged)时更新台账。台账提交信息用 `docs(roadmap): <track> <状态变化>`。**台账权威态以 `origin/main` 为准**;中间状态本地更新,**认领 与 done/merged 这两个全局关键节点必须随 docs-only 台账 PR 发布到 `origin/main`**(其余中间 tick 可攒着一起发)。**done 必须是"双顾问双 PASS + 已并入 dev/roadmap 集成验证全绿"二者都满足**(先集成再标 done,见 §3 收口流程)。
4. **完成的定义(铁律)**:一条轨道「完成」(可标 `done`)= 代码写完 + `ruff`/`pytest`/`npm test` 全绿 + **Codex + Gemini 双顾问对抗验收双 PASS**(见仓库 `CLAUDE.md` 铁律)+ **已并入 `dev/roadmap` 跑组合态集成验证全绿**(AGENTS.md:targeting main 前必过)+ 原子提交(一个 commit 一件事,约定式信息,无 AI 署名)。
5. **流向 main 的唯一通道(已对齐 AGENTS.md Required Promotion Flow)**:**worker 分支 → 本地 `dev/roadmap` 集成验证 → 从同一 worker 分支发/更新 PR 到 `origin/main`**(启用 staging-first 则先 PR `staging`)。**PR 源始终是 worker 分支,不是 `dev/roadmap`**;`dev/roadmap → main` 非默认、需业主显式批准。本地 `main` = `origin/main` 只读镜像,**只 `merge --ff-only` 刷新,绝不在其上 commit、绝不接收 `dev/roadmap` 合并**。远端状态变更(push/合并/开关 PR)需业主显式批准。
6. **基线 = 最新 `origin/main`**:worker 分支从最新 `origin/main` 切(不是本地 `main`、不是 `dev/roadmap`、不是别的未完成 worker 分支);落后了 `git merge origin/main` 吸收(尤其前端)。
7. **并行会话警惕**:多个本机会话共用主检出的 `.git`,分支/HEAD/未提交改动会互相漂移(早期误判 iCloud,实为并行会话共用检出)——每会话各自 worktree、动手前 `git status` 核验、提交用 `git commit -- <显式路径>` 只提自己的文件,绝不夹带别人的改动。
8. **不重复造协议**:涉及 runtime/契约时以仓库既有事实源为准(`display_contracts.py`、codex 真实协议 `~/Documents/codex研究/codex-rs/app-server-protocol/src/protocol/v2/item.rs` 等),不要各自猜字段名(Display PR-2 曾因猜字段名返工)。
9. **认领必带 chat ID(便于溯源)**:§2「认领者」列必须写**完整 Claude Code 会话 ID(chat ID = session UUID)**,格式 `<人/机标识> · chat <uuid>`。每个会话最清楚自己的 chat ID——认领时一并填上。这样任何人对某条轨道有疑问,**直接打开对应 chat 回看该会话的完整推理、顾问验收与提交**即可,不必猜是谁做的。⚠️**别替别的会话瞎填 UUID**(本项目已有 160+ 会话,靠猜映射必错);只填自己确定的那行,别人的留给本人补。⚠️chat ID 是**本机** `~/.claude/projects/-Users-leongong-Documents-superClaw/<uuid>.jsonl` 的 transcript:同机可回看;**另一台机器的会话 transcript 在那台机器上,本机查不到**(跨机轨道如另一台的 Display `d068933` 只能在那台机查)。

## 2. 路线图轨道台账

> 状态值:`planned`(已规划未动) / `in-progress`(开发中) / `in-review`(双顾问验收中) / `done`(双PASS + dev/roadmap 集成验证全绿,待用户验证) / `merged`(已从 worker 分支发 PR 合入 `origin/main`)。
> 认领前先把「认领者」填上,**必须含完整 chat ID(session UUID,见公约第 9 条)**:既防重复,又便于有问题直接按 chat 回查对应会话。
>
> ⚠️ **下表是历史台账(逐行随当时进度写就)**:早期行里的"在 dev/roadmap 开发""merge 进本地 main""iCloud worktree"等措辞是**写入当时的旧模型/事实快照,刻意原样保留**(不回改历史);**当前权威流程以上面的 §0/§1/§3 与 `AGENTS.md` 为准**(worker worktree → dev/roadmap 集成验证 → 从 worker 分支发 PR 合入 `origin/main`)。

| 轨道 | 规划文档 | 当前分支 / worktree | 状态 | 认领者 | 备注 |
|---|---|---|---|---|---|
| Display Protocol(chat 链路) | docs/agent-runtime-display-protocol-impl-roadmap.md | **已收敛进 dev/roadmap**(原 feat/display-protocol-pr1) | **done(待用户验证 merge)** | display 会话 · chat 4fce311a-1fcd-478c-b6c8-1930e38d001d | PR-1/2/3/5 + codex v2 字段校正全双 PASS;5 提交已 cherry-pick 进 dev/roadmap 并在本地 main 基线上重验证(114 Python + 116 web 测试 + build 全绿);⚠️另一台机器有重复的 d068933(未推 origin)。本会话也建了 Agent Team Kernel 地基 row + 本台账初版 |
| Display Protocol(run cockpit) | 同上 §B PR-4/PR-6/PR-7 | PR #260 `feat/display-run-cockpit` + dev/roadmap 沙盘 | **done(PR #260 已开;CI passed)** | chat 4ede826a-3ddf-497b-ad61-38bbc6d6ffe9 (run cockpit 会话) + Codex 接手 | 已从 dev/roadmap 抽成基于 Display chat #241 的 clean stacked PR #260(base=`feat/display-protocol-chat`,head=`feat/display-run-cockpit`,HEAD `6a0687a`):PR-4 后端持久化/快照/SSE event.id + PR-6 cockpit 前端 + inline composed sink DL10 + PR-7 文档/顾问留痕 + eval/worktree 测试稳定性。full pytest 1827 passed;web 120+build;scoped ruff;diff-check;Gemini PASS;Claude Sonnet PASS(claude_code_sonnet_qa wrapper ask 空响应,改 `claude -p --model sonnet` 直接复核);GitHub CI `test` SUCCESS(2026-06-16T01:57:35Z),mergeStateStatus=CLEAN。follow-up 非阻断:inline E2E、SSE auto-reconnect、SQLite busy latency。**待 Leon 浏览器实测 cockpit 成卡后按 stack merge**。留痕见 docs/agent-runtime-display-protocol-runcockpit-ledger.md |
| Display Protocol(BATCH 后端诊断 DL4) | docs/agent-runtime-display-protocol-impl-roadmap.md §DL4 | PR #246 `feat/display-batch-dl4` + dev/roadmap 沙盘 | **done(PR #246 已重排到 #260;CI passed)** | display 会话 · chat 4fce311a-1fcd-478c-b6c8-1930e38d001d + Codex 接手 | 已从旧 #241 base 重新收敛为基于 Display run cockpit #260 的 clean stacked PR #246(base=`feat/display-run-cockpit`,head=`feat/display-batch-dl4`,HEAD `5b71d49`):canonical `adapter.diagnostic` 覆盖非流式 BATCH backend,orchestrator `_run_backend()` 顺序/并行统一早发,streaming fallback 只在流式降级时发,chat generic 早发,chat card 显示 BATCH note,run cockpit diagnostic lane 保持 #260 路由。最终修复顾问指出的 synthetic id 碰撞:delivery diagnostic id 绑定 `run_id/task_id/backend`,chat 绑定 `session_id/backend`,防止多个 batch backend 被前端 `seenIds` 去重吞掉;文案/docstring 统一英文。全量 `uv run --extra dev pytest` **1835 passed**;`npm test --prefix apps/web` **122 passed**;`npm --prefix apps/web run build` passed(仅既有 chunk warning);touched-file ruff + `git diff --check` passed;Gemini final PASS;Claude Sonnet QA final PASS(session `7e1041fa-ff42-4225-b994-8e458d6a33d3`)。全仓 `ruff check .` 仍因既有 unrelated/third_party lint 失败,未混入本 PR。GitHub CI `test` SUCCESS(2026-06-16T02:30:48Z),mergeStateStatus=CLEAN。 |
| Display Protocol(api-agent 真工具投影) | docs/agent-runtime-display-protocol-impl-roadmap.md（Display 续） | PR #261 `feat/gemini-anthropic-projection` + dev/roadmap 沙盘 | **done(PR #261 已重排到 #246;CI passed)** | Codex 接手 + Claude Sonnet QA session e1d4ed18-68a2-4045-8a92-b737a2009df3 | 已从旧 dev/roadmap 混合 base 重排为基于 Display BATCH #246 的 clean stacked PR #261(base=`feat/display-batch-dl4`,head=`feat/gemini-anthropic-projection`,HEAD `5e55964`):api-agent backends(gemini/anthropic-agent)执行后只投影真实 tool execution records,不从自然语言重构;api-agent `surfaces_live_tools=True` 因此跳过 batch diagnostic,chat turn 三端点在 completed 前 drain display events,Web chat cards 显示真实 tool cards。Clean commits:`217404b`/`99722f2`/`5e55964`。全量 `uv run --extra dev pytest` **1845 passed**;focused **364 passed**;`npm test --prefix apps/web` **122 passed**;`npm --prefix apps/web run build` passed(仅既有 chunk warning);touched-file ruff + `git diff --check` passed;Gemini PASS;Claude Sonnet QA PASS。全仓 `ruff check .` 仍因既有 unrelated/third_party lint 失败,未混入本 PR。GitHub CI `test` SUCCESS(2026-06-16T02:54:26Z),mergeStateStatus=CLEAN。 |
| Display Protocol(marketplace dock) | docs/agent-runtime-display-protocol-impl-roadmap.md（Display 续） | PR #262 `feat/display-market-dock` + dev/roadmap 沙盘 | **done(PR #262 已重排到 #261;CI passed)** | Codex 接手 + Claude Sonnet QA session 175101b2-7b49-40fc-af55-d62872a6ed38 | 已从本地 main ahead 的 `b04c48a` 抽成基于 api-agent projection #261 的 clean stacked PR #262(base=`feat/gemini-anthropic-projection`,head=`feat/display-market-dock`,HEAD `2e42b87`):空 chat surface 下方显示 ClawHunt marketplace dock,CLI/API 统一 `skip`/`limit`/`status` 分页契约,API 对 upstream error fail-closed(`tasks=[]`,`raw=null`),Web 侧 request id + loading ref 防重入/过期写入,选中 task 复用既有 governed detail/readiness flow。全量 `uv run --extra dev pytest` **1846 passed**;focused API **131 passed**;`npm test --prefix apps/web` **122 passed**;`npm --prefix apps/web run build` passed(仅既有 chunk warning);touched-file ruff + `git diff --check` passed;Gemini PASS(session `12af8497-46a1-4fd6-a941-2c14fd42dae6`);Claude Sonnet QA PASS。GitHub CI `test` SUCCESS(2026-06-16T03:29:29Z),mergeStateStatus=CLEAN。 |
| Capability Workshop | docs/capability-workshop-roadmap.md / -impl- | dev/roadmap + PR #252/#253/#256/#257/#258/#259 + `codex/integration-clawhunt-capability` + worker commits `a89af5b`/`22da7f6`/`cd21dfc` | **done on dev/roadmap**（用户要求的端到端闭环已集成；main-facing PR 仍需从干净交付分支抽取） | coordinator chat `019ecf41-82f9-70c2-aa05-3adf2ac6eace` + capability workers | 三类资产闭环已落地：ClawHunt admin `Capability Reviews` 审核页；ClawHunt submission/review/version/artifact/registry/audit 后端与 `/api/admin/capabilities/*`；审核通过写入 digest-pinned immutable artifact + registry；撤销/替换留审计；SuperClaw plugin/skill/company 开发者 submit/status API+CLI；Capability Workshop 三类列表消费 registry 且按 digest 固定、同版本不可覆盖。旧 clean PR stack #252-#259 继续作为前置能力 PR traceability。本闭环之外的未来生产硬化仍待：hosted KMS/HSM、multipart/cloud object store、签名 public registry 发布、支付/加密分发。 |
| Escalation framework (提权/审批升迁 方向四 P0/D1 · P1/D2-D3) | docs/escalation-framework-impl-status.md (capability-workshop §方向四) | **【v11 已组织】feat/escalation-d1-d2(origin/main base)= D1+测试修复+D2** · **D3 done(feat/escalation-d3,stacked)** · **P2+D5 done(feat/native-approval,stacked;含 C0 spike 实测)** | **D1+D2 已开 #250;D3 + P2/D5 done(各双PASS,CI/web 等价绿,待 Leon 验证/按 stacked PR 推进)** | claude@superClaw(opus) · chat 28f0623a-d66b-4890-8257-a115959a3b4d | **P0/D1**:内核地基(双签名单次票据+consumed_grants ledger)+B类工具硬门(workspace posture 下 shell/敏感写经 gate,fail-closed)+EscalationPending 挂起→WAITING_FOR_HUMAN_GATE→resume+CLI escalation list/show/respond。4 commit cherry-pick 进 dev/roadmap(b444521/89dff4a/d20a44e/56e5ca5),cli.py 与 approve_revision ADD-ADD 冲突逐处解(保留双方);旧分支 Codex(gpt-5.5)+Gemini 多轮双PASS、代码字节一致;dev/roadmap 基线 70 escalation + 94 回归测试全绿、ruff clean。与 row31 T11 containment 不同(escalation=审批升迁票据,非 low-trust 沙箱)。 **【P1 认领·in-progress,claude@superClaw(opus),2026-06-15】** 按 Leon「其他线程做非重复」指令认领方向四 D2(REST `/api/escalations` list/get/respond + SSE escalation 事件)+ D3(Web 通用提权弹窗 + pending 徽章),建在已 done 的 D1 之上;**零 trust 依赖**,不与 capability-workshop 会话(company/submit)、row31(trust/containment)重叠;薄包装内核(escalation.py/state.py 既有 API),逐项双 PASS 后标 done。 **【v11 §十 存量迁移已做 by chat 28f0623a】** 已组织为干净交付分支 `feat/escalation-d1-d2`(`~/superclaw-wt/escalation`,**base=origin/main 378035b**):cherry-pick 原始 D1(29b22c9/dbd0d0e/39d5e92,本就在 origin/main base 上)+ d21b128(D1 doc)+ 测试修复 1129b3e(=4b7db36,修 D1 stale 测试)+ D2 代码 ba6a6af(=0f502ae,自动合并 cli/state 无冲突)+ D2 doc c9d2613,全程 cherry-pick 无冲突。**CI 等价(ci.yml=pytest+npm test,不含 ruff)**:全量 1805 passed;6 failed 均**已证非 escalation 引入**(5 个 test_evals 在纯 origin/main 同样失败=需真 pip-install 环境;1 个 desktop_toolchain 测 worktree 目录名)。tree-equality:escalation.py/test_escalation_api.py/test_agent_prompt.py 与 dev/roadmap 双PASS 版 **0 差异**(无漂移);共享文件差异=dev/roadmap 含他轨+旧基线(预期)。**已推并开 draft PR #250**(base=main)。本次接手后补齐测试可移植性:full pytest 1811 passed,escalation regression 267 passed,scoped ruff clean,web 99 passed + build,Codex/Claude Sonnet QA + Gemini 双 PASS。D1/D2 以 consolidated branch 交付;D3 仍走 stacked #245。旧 feat/escalation-framework(仅 D1,iCloud worktree)由此分支取代。 **【已集成进 dev/roadmap 沙盘 by chat 28f0623a,2026-06-15】** D3(e1d70e7,styles/package.json append 冲突逐处解保留双方)+ C1 内核(edb068e)+ C2/C3 broker(1f21ec6,codex_app_server 与 dev/roadmap 的 display 投影版 3 处冲突均"保留双方"合并:display requested/resolved emit + broker 路径/退出 decline-all 共存)+ 设计文档,全 cherry-pick 进 dev/roadmap。**dev/roadmap 沙盘验证绿**:Python 413 passed(1 失败=worktree 目录名环境项,非本轨)+ web 132 passed(escalation-gate + display-protocol 共存)+ codex/native/escalation/orchestration 专项 86 passed。 |
| CW trust / T11 containment | docs/t11-low-trust-containment-design.md | dev/roadmap + **PR #251 `feat/cw-trust-core-pr`** + **PR #254 `fix/trust-signer-conflicts`** + **PR #255 `feat/containment-low-trust`** | done(**Trust core #251;same-id signer conflict #254;T11 containment #255 均已开 clean stacked PR 且 CI 通过**) | Codex 接手 · row31 来源 | **【trust 原语唯一权威线程】**(见 §2.1,已核验:5db4a25 trust + 4b14138 TrustState + 65a6048 命名空间硬隔离 + 858fe13 版本契约;capability-workshop 的 ebe2436 trust 放弃归此)。**【交付 PR #251,2026-06-16】** 已从旧 `feat/cw-trust-primitive` 混合分支抽出 main-based clean slice:`trust.py`/`TrustState`/namespace isolation/version contract + digest v2 hardening(permission-aware,length-framed,domain-separated,blocks non-root `skill.*` fallback spoof unless signed `skill_origin:true`);full pytest 1804 passed,web 99+build,scoped ruff,diff-check,Claude Sonnet QA + Gemini PASS。**【交付 PR #254,2026-06-16】** 已将 `dev/roadmap` 的 **same-id different-signer hard conflict** 抽成基于 #251 的 clean stacked PR:cache 写入同 id/version 异签拒绝覆盖,runtime projection 在选 latest 前排除同 id 跨签名冲突;full pytest 1806 passed,web 99+build,focused 28,scoped ruff,diff-check,Claude Sonnet QA + Gemini PASS;GitHub check passed;详见 §2.2.2。**【交付 PR #255,2026-06-16】** 已将 T11 containment 从 dev/roadmap 沙盘抽成基于 #254 的 clean stacked PR:`525ab46` first-class containment policy/strictest wins/child inherit/API+CLI guard,`335e937` A-class/native fail-closed + secret read symlink/hardlink hardening + low-trust delegate deny contract,`6fd1200` changelog;full pytest 1839 passed(1 opt-in canary skipped),web 99+build,focused 225,scoped ruff,diff-check,Claude Sonnet QA session `d9aaf0d2-28a5-43d0-bff1-2abc7d4b2728` PASS,Gemini PASS,GitHub check passed;详见 §2.2.3。后续 TUF/developer registry refresh、company catalog/API/Web 归 Capability Workshop 继续做；catalog resolver/trust state CLI 已由 Capability Workshop B5 收敛(见 §2.2.4)。⚠️**escalation 内核不在本轨道重做**——已由 Escalation framework 轨道完成收敛(done),本 row 旧备注"escalation 内核"剔除以防重复 |
| **Agent Team Kernel / Web 工作台 / cost**(work-products / delivery-ledger / state-schema / liveness / issue-tree + engine-ready + per-model USD cost + approval revision + hire/config governance + org/workbench UI + Paperclip Phase 4 routines/board lanes) | Paperclip parity T1 + 状态库耐久性 + Web 工作台 + `docs/agent-team-kernel-daemon-pivot.md` Phase 4 | **dev/roadmap 已含等价代码** + PR #234 `pr/agent-team`(base=`main`,HEAD `56b81d2`) + visible worker branches `codex/paperclip-team-kernel-backend-phase4` / `codex/paperclip-team-kernel-board-ui-phase4` | **done on dev/roadmap(Phase 4 可集成闭环已收敛;main-facing PR 仍需按栈抽取/重排)** | coordinator chat `019ecf41-82f9-70c2-aa05-3adf2ac6eace` + worker threads `019ed0d3-d336-70e1-b0ac-399705418c9b` / `019ed0d4-1eb3-7e51-96c1-14d98d466442` | **【交付事实,2026-06-16】** 旧 row 的 5 个共享地基提交已在 dev/roadmap 当前树中存在:work-products/delivery-ledger、SCHEMA_VERSION fail-closed+在线备份、ACTIVE_RUN_STATUSES 单一事实源、issue hold ledger + subtree pause/resume/cancel;#234 另汇总 engine-ready-on-open、per-model USD cost、agent config/hire governance、reports_to save choke point、request-revision/讨论线程、org pan/zoom 和 Web 工作台增量。实操验证:在 `dev/roadmap` 备份 `backup/dev-roadmap-before-agent-team-20260616` 后 cherry-pick `56b81d2` 触发预期冲突(`App.tsx`/`TeamWorkbench.tsx`/`styles.css`/`cli.py`/`state.py`/`team_kernel.py`/tests),按规则保留 Display/Escalation/work-products/hold CAS 等沙盘已收敛代码后 `git cherry-pick --continue` 报告 empty,说明 #234 对当前 dev/roadmap 无新增 tree delta。**本轮 Paperclip Phase 4 继续推进**:visible backend worker commit `c1e7ee6` 已集成为 `9a34e32`,新增 durable `TeamRoutineSchedule`、idempotent routine definitions、原子 due-slot claim + wakeup enqueue、daemon scheduled trigger tick、resume/backlog session context；visible UI/API worker commit `f9c1e20` 已集成为 `2e0c81d`,新增 read-only `/api/team/board-inbox`、board escalation thread access、pending/needs-changes/accepted/rejected review lanes。PR traceability:GitHub PR #234 `https://github.com/ClawHunt-Store/SuperClaw/pull/234`,base=`main`,head=`pr/agent-team`,GitHub CI `test` SUCCESS(2026-06-15),mergeStateStatus=CLEAN;Phase 4 两个 worker commit 未来从开发 worktree/交付栈抽 main-facing PR,不直接从 dev/roadmap 发 PR。Verification:Team Kernel/API scoped **160 passed**;full `uv run --extra dev pytest -q` **2574 passed,9 skipped,1 warning**;full `uv run --extra dev ruff check .` passed;Web `npm --prefix apps/web test` **141 passed**;`npm --prefix apps/web run build` passed(仅既有 chunk warning);`git diff --check` passed;Gemini full-diff review PASS;Claude Sonnet minimal gate `verdict=pass`(详细 review prompts 空响应,记录为工具限制)。非阻断后续:routine authoring API/CLI/Web、board escalation 状态化关闭/指派、SQL-side inbox filtering、多进程 daemon soak。 |
| Relay 安全加固 | — | feat/relay-base-hardening / fix/relay-account-isolation | 大部分 merged(#228) | — | 与 chat/display 无关 |
| Agent config edit | docs/agent-app-ecosystem-roadmap.md? | feat/agent-config-edit | in-progress(自报) | — | |
| Background task 治理 | docs/background-task-roadmap.md | 未开 | planned | — | 仅规划 |
| Prompt envelope 分层 | docs/prompt-envelope-roadmap.md | **feat/prompt-envelope-p1(d0bdd5b)= 唯一权威** | **⚠️ 重复已裁定:权威=d0bdd5b;我的 5f7d61b 放弃** | 权威分支作者会话(待本人补 chat ID)· 重复发现者 chat 28f0623a-d66b-4890-8257-a115959a3b4d | **【重复裁决·已客观核验,见 §2.1】** 存在两份 P1:① `feat/prompt-envelope-p1` 的 `d0bdd5b`(2026-06-15 **09:47:52**,prompt_contracts.py **282 行**+local_agent_runtime.py system_channel+test 231 行,**且含 system_channel 运行时校验 + read-only authority map**)② 我 dev/roadmap 的 `5f7d61b`(**10:00:17**,213 行,**晚 13 分钟、更小、缺运行时校验**)。**裁定权威=d0bdd5b**(更早+更全),**我 5f7d61b 放弃**(根因:我认领时只查 dev/roadmap+台账[显示 planned],漏查已存在 feature 分支;对方建分支未在台账认领)。我 5f7d61b 仍在 dev/roadmap 沙盘(沙盘将按 §六 重建,不单独 revert);**交付走 feat/prompt-envelope-p1,不走我的**。**教训:认领前必 `git branch -a` 查已存在 feature 分支,非只看 dev/roadmap+台账。** |
| Cross-runtime delegation | docs/cross-runtime-delegation.md | dev/roadmap + **PR #263 `feat/cross-runtime-p1-admission`** | 向外 planned · 向内 P0 done(#236/#238)· **P1-0 admission + P1-1a broker 准入编排已抽 clean PR #263;P1-1b delegate 工具注入 + P1-2a durable broker suspension + P1-2b/P1-3 reviewed delegate result gate done(集成 dev/roadmap,待继续抽 PR)** | feat/cross-runtime-p1 · chat 4ede826a-3ddf-497b-ad61-38bbc6d6ffe9 | 向外(MCP 暴露)已过双顾问验收待实施。**【向内 P0 全部 done 2026-06-15,三件套各双 PASS】** ① strengths 只读投影(`054744a`) ② `superclaw runtime list`(`01e5b88`) ③ 委派开关(`4347036`)。⚠️能力位 task_spawn 移 P1(backend `gemini`≠harness Gemini CLI;改 delegation_eligible fail-closed)。**【向内 P1 进行中 2026-06-15,base dev/roadmap】** **P1 架构 Codex+Gemini 双裁决定稿**(委派=受控上下文切出 / orchestrator broker / 异步 WAITING_FOR_CHILD_DELEGATION 不混人审 / native P1 禁只 gemini·anthropic 发起 / 物理不注入 depth≥1 / child review gate)。**P1-0 admission 准入层 done并已组织 PR #263**(`d10413a`→clean commit `8c39377`;7 轮 Codex 对抗挖 14 个 fail-open 全修,双 PASS;每个输入做类型+形状+truthy fail-closed 校验)。**P1-1a profile adapter + DelegationBroker 准入编排 done并已组织 PR #263**(`5408d0c`→clean commit `a42b267`;Codex 抓出真 bug=privileged mode 词表臆造 `{full,bypass}` 致 bypassPermissions 投影非特权 fail-open,已核实 runtime.py 改对 `{bypassPermissions,dontAsk}`;双 PASS)。**P1-1b delegate 工具注入切片 done**: api-agent 工具列表只在 `delegation_enabled()` 严格开启、发起 backend 合格、且 `delegation_depth == 0` 时物理注入 `delegate`;合法调用抛 `DelegationRequested` 结构化意图给后续 orchestrator broker,无效调用 fail-closed;修正 eligibility 为真实工具循环 backend `anthropic-agent`(非单次 completion `anthropic`)。**P1-2a durable broker suspension done**: orchestrator 顺序/并行 worker 路径捕获 `DelegationRequested`,经 `authorize_delegation_for_parent()` 准入,要求显式 target runtime(禁止 `runtime=None` 默退 `claude`),按 parent tool-call id 幂等创建一个 linked child run,写入 `child_delegation_waits`,parent 先进入 `WAITING_FOR_CHILD_DELEGATION` 后启动新 child,child streaming event 以 `child_run.event` 嵌套转发到 parent,child terminal 时更新 wait record;full pytest 2520 passed / 9 skipped + ruff/web/build/diff-check + Claude/Gemini final PASS。**P1-2b/P1-3 reviewed delegate result gate done**: child terminal sync 生成 parent-visible `delegate_tool_results`(tool_call_id/request_key/child evidence/output summary),默认 `pending_review`;`resume_run()` 对未审查结果 fail-closed 阻断,人工 review 方法批准后才把 approved tool-result 留给父 worker continuation,拒绝则父 run failed + evidence finding。**仍待/后续**:继续抽 P1-1b/P1-2/P1-3 clean PR;更完整 child stream replay/resume 消费、API/CLI review surface、event sink/thread-table/parent RMW hardening、P2 native·MCP。待 Leon 验证 merge。 |
| Workspace sidebar 重构 | docs/workspace-sidebar-rework-roadmap.md | **PR-A→D done**(stacked 于 origin/main:PR-A `4efd5a9`=feat/workspace-sidebar-kernel · PR-B/C/D 在 feat/workspace-sidebar-api `6b3e712`→`16b2c44`→`1307612`,**均未推**;已集成 dev/roadmap 沙盘 `5056b87`) | **全四 PR done(各 Codex+Gemini 双 PASS,待 Leon 验证+推送)** | display 会话 · chat 4fce311a-1fcd-478c-b6c8-1930e38d001d | Plan A+ 全部完成。**PR-A**(内核,4efd5a9):archived 字段+迁移、create_personal_workspace(folder MANAGED scratch 写锁死 / attach_repo trust_confirmed 强制门)、移动安全三层(native 逐 binding / codex_thread fail-closed / in-process cwd)。**PR-B**(API+内核移动安全,6b3e712,**10 轮 Codex**):POST workspaces/archive/move(边界 409 需 ack)+personal_only/include_archived+ui_contracts 排除 company;**§4.5 写回竞态全闭合**=全 chat-session 写口 BEGIN IMMEDIATE+统一守卫键于 turn 开始 workspace_id 变化(resolve 紧后单点捕获)。**PR-C**(Web 侧栏,16b2c44,**5 轮 Codex**):新建 workspace 对话框(folder/attach 双重 trust fail-closed)+平铺聊天/可折叠用户分组/归档(乐观本地移除)/移动(409→警告);**侧栏 state 完整性**=optimisticChatIdsRef+confirmedChatIdsRef gate+rememberBackendChatSession 三分支(保留 kernel 字段/confirmed 缺失绝不复活/未确认才合成)。**PR-D**(CLI 对齐,1307612,**4 轮 Codex**):create-personal/move-session 调 API 同一内核函数;**CLI↔API 零偏差**=空名校验下沉内核单一源(删 API min_length+CLI 自校验+name-or-Workspace 占位)+非交互走内核同序报错;chat-regroup 未 gate 主代理裁定非阻断(Codex+Gemini 接受)。沙盘验证:pytest 115 passed / web 141 passed。预存沙盘债 cli.py runtime_list F811(他轨碰撞非本特性)。**待 Leon 验证+推送** |
| Architecture invariants 治理 | docs/architecture-invariants-roadmap.md | docs/track-roadmaps? | planned | — | Test-as-Policy 方向 |

> 上表「自报」的状态是我(建台账时)从分支/worktree 存在推断的,**各轨道认领者请按真实进度修正**。发现某轨道在多处并行做 → 立刻在此标注并收敛到一处。

### 2.1 重复轨道裁决（2026-06-15, chat 4ede826a-3ddf-497b-ad61-38bbc6d6ffe9 [run cockpit 会话], 经 Leon 授权）

> 公约第 1 条「发现重复→收敛到一处」的执行结果。裁决依据为**客观核验**(git show --stat 比对提交内容),非自报。**重复部分指定唯一权威线程,其他线程只做非重复部分**;裁决仅为台账标注协调,不改任何会话的代码。

| 重复点 | 涉及线程 | 客观证据 | 裁决:唯一权威线程 | 其他线程 |
|---|---|---|---|---|
| **trust 原语** | Capability Workshop (feat/capability-workshop) · CW trust/T11 (feat/cw-trust-primitive, row31) | `ebe2436` 与 `5db4a25` 都新增 `trust.py`(238行)+`test_trust.py`(264行),行数完全相等=同一份做两遍 | **CW trust/T11 (row31)** —— 更全(另有 TrustState `4b14138`、命名空间硬隔离 `65a6048`、版本契约 `858fe13`) | Capability Workshop 放弃 `ebe2436` trust 部分,只做非重复的 company 协议 + 提交↔签名解耦(待 row31 trust 收敛后基于其 trust 重 cherry-pick) |
| **escalation 内核** | Escalation framework · CW trust/T11 (row31 旧备注曾列"escalation 内核") | Escalation framework 已独立完成(双签名票据+consumed_grants+B类硬门,b444521/89dff4a/d20a44e/56e5ca5)并收敛 done | **Escalation framework** | CW trust/T11 范围收窄为 containment+trust,不重做 escalation |
| **Prompt Envelope P1**(prompt_contracts.py + spec system_channel) | feat/prompt-envelope-p1 (`d0bdd5b`) · dev/roadmap (`5f7d61b`, chat 28f0623a) | `d0bdd5b` 2026-06-15 09:47:52 / 282 行 + 含 system_channel 运行时校验 + read-only authority map;`5f7d61b` 10:00:17 / 213 行 / 缺运行时校验 → d0bdd5b **更早 13 分钟且更全** | **feat/prompt-envelope-p1 (`d0bdd5b`)** | dev/roadmap `5f7d61b` 放弃(沙盘随 §六 重建,不单独 revert);交付走 feat/prompt-envelope-p1 |

> 非重复、各自独立的轨道(不在裁决范围,各线程照常做):Display Protocol(chat / run cockpit,两不重叠相位)、Relay 安全加固、Agent config edit、Background task、Cross-runtime delegation、Workspace sidebar、Architecture invariants。(Prompt envelope 已移出此列——见上表,它是重复轨道)

### 2.2 交付 PR 准备快照（2026-06-15, Codex 接手整理）

> Leon 要求：本地分支领先远端的部分先写好 PR，之后 `main` 只做 `origin/main` 镜像。本轮只把可独立评审、base 清楚、测试可复现的分支开 PR；备份/聚合/dirty/坏 base 分支不直接开 main PR，避免把沙盘或第三方大快照误送审。

| 轨道 / 分支 | PR | base | 当前处理 | 验证 / 备注 |
|---|---:|---|---|---|
| Local main ahead 保存 | #240 | main | ✅ draft PR | `codex/local-main-ahead-20260615` 保存本地 `main` 领先 37 commit，后续 `main` 可在确认后镜像 `origin/main` |
| Capability Workshop trust/company/submit 地基 | #239 | main | ⚠️ superseded by split PRs | 旧 `feat/capability-workshop` 夹带 obsolete trust/company/submit 三件事;trust 由 #251 接管,company P0 已抽为 #252,submit/signature 已抽为 #253 |
| CW trust core prerequisite | #251 | main | ✅ draft PR(remote CI passed) | `feat/cw-trust-core-pr`，已推；full pytest 1804 passed，web 99+build，scoped ruff，Claude Sonnet QA + Gemini PASS；GitHub check passed |
| Capability Workshop company template P0 | #252 | #251 | ✅ stacked draft PR(remote CI passed) | `feat/capability-company-template`，基于 #251;full pytest 1826 passed，focused 66 passed，web 99+build，scoped ruff，Claude Sonnet QA + Gemini PASS；GitHub check passed |
| Capability Workshop submit/signature decouple | #253 | #256 | ✅ stacked draft PR(retargeted;remote CI passed) | `feat/plugin-submit-signing-decouple`，已重排到 B5 catalog resolver 后;full pytest 1877 passed/1 skipped，focused 86 passed，web 99+build，scoped ruff，Claude Sonnet QA + Gemini PASS；GitHub check passed |
| Capability Workshop B6 catalog API | #257 | #253 | ✅ stacked PR(remote CI passed) | `feat/capability-catalog-api`，基于 #253;full pytest 1880 passed/1 skipped，focused 51 passed，web 99+build，scoped ruff，Claude Sonnet QA + Gemini PASS；GitHub check passed |
| Capability Workshop B7 Web catalog | #258 | #257 | ✅ stacked PR(remote CI passed) | `feat/capability-catalog-web`，基于 #257;full pytest 1880 passed/1 skipped，web 99+build，diff-check，Claude Sonnet QA + Gemini PASS；GitHub check passed |
| Capability Workshop B3 registry metadata | #259 | #258 | ✅ stacked PR(remote CI passed) | `feat/capability-registry-metadata`，基于 #258;full pytest 1888 passed/1 skipped，focused 37 passed，web 99+build，scoped ruff，diff-check，Claude Sonnet PASS + Gemini PASS；GitHub check passed |
| CW trust same-id signer conflicts | #254 | #251 | ✅ stacked draft PR(remote CI passed) | `fix/trust-signer-conflicts`，基于 #251;full pytest 1806 passed，focused 28 passed，web 99+build，scoped ruff，Claude Sonnet QA + Gemini PASS；GitHub check passed |
| T11 low-trust containment | #255 | #254 | ✅ stacked draft PR(remote CI passed) | `feat/containment-low-trust`，基于 #254;full pytest 1839 passed，focused 225 passed(1 opt-in canary skipped)，web 99+build，scoped ruff，Claude Sonnet QA + Gemini PASS；GitHub check passed |
| Trust digest hardening | #242 | main | ✅ draft PR | `fix/trust-chain-p0-digest`，31 pytest + ruff 绿 |
| Display chat contract/cards | #241 | main | ✅ draft PR | `feat/display-protocol-chat`，web 113 tests + build 绿 |
| Display run cockpit | #260 | #241 | ✅ stacked PR(remote CI passed) | `feat/display-run-cockpit`，基于 #241;full pytest 1827 passed，web 120+build，scoped ruff，diff-check，Gemini PASS，Claude Sonnet PASS(wrapper ask 空响应后直接 `claude -p` 复核);GitHub check passed |
| Display batch diagnostics DL4 | #246 | #260 | ✅ stacked PR(remote CI passed) | `feat/display-batch-dl4`，已重排到 `feat/display-run-cockpit`;full pytest 1835 passed，web 122+build，scoped ruff，diff-check，Gemini PASS，Claude Sonnet PASS;GitHub check passed;修复 parallel diagnostic synthetic id 去重碰撞 |
| Escalation P0/D1 foundation | #243 | main | ✅ draft PR | `feat/escalation-framework`，Py 100 + ruff 绿 |
| Escalation D1/D2 consolidated delivery | #250 | main | ✅ draft PR | `feat/escalation-d1-d2`，已推；full pytest 1811 passed，escalation regression 267 passed，scoped ruff/web 99+build，Claude Sonnet QA + Gemini PASS |
| Native approval broker / runtime_tool | #244 | #243 | ✅ stacked draft PR | `feat/native-approval`，Py 57 + ruff 绿 |
| Escalation Web gate D3 | #245 | #244 | ✅ stacked draft PR | `feat/escalation-d3`，web 106 + build 绿 |
| Workspace sidebar kernel | #247 | main | ✅ draft PR | `feat/workspace-sidebar-kernel`，Py 62 + ruff 绿 |
| Workspace sidebar API/Web controls | #248 | #247 | ✅ stacked draft PR | `feat/workspace-sidebar-api`，Py 107 + ruff + web 108 + build 绿 |
| Prompt Envelope P1 | #237 | main | ✅ existing PR updated | 本地 docs 状态 commit 已 push |
| Cross-runtime delegation P0 | #238 | main | ✅ existing PR updated | 本地 docs 状态 commit 已 push |
| Roadmap documents | #249 | main | ✅ draft PR | `docs/track-roadmaps`，docs-only |

**未直接开 PR 的本地 ahead 分支分类**：
- `backup/*`：备份锚点，不开 PR。
- `dev/roadmap`、`dev/batch-display`、`test/prompt-delegation-merge`：集成/测试沙盘，不直接 PR 到 main；只作为验证和拆分来源。
- `feat/escalation-d1-d2`：已作为 consolidation delivery branch 推送并开 #250；记录本地 ahead 分支已 PR 化。
- `feat/cw-trust-primitive`：旧混合来源分支,夹带 Agent Team Kernel 历史,不直接送审；trust core 已抽为 main-based #251,Capability Workshop 仍走 #239/后续重基。
- `feat/display-protocol-pr1`：当前主 worktree 仍有未提交 WIP 与 untracked 路线图文件；需先拆成 Display/T11/T12 独立切片。
- `feat/cross-runtime-p1`、`feat/gemini-anthropic-projection`、`feat/agent-config-edit`：含大量 dev/roadmap/third_party/clawwork 历史或坏 base，需按功能重新抽取 PR，不能原样推 main。

### 2.2.1 dev/roadmap 全量收敛快照（2026-06-15, Codex 接手执行）

> 目标：先把本地领先远端的可交付分支写好 PR，再把测试 worktree `dev/roadmap` 收到可验证状态。`dev/roadmap` 仍是测试/集成沙盘，不直接作为 main PR；未来从各功能交付分支或重新抽取的干净分支发 PR。

本轮新增到 `dev/roadmap` 的收敛提交：
- `2ca7c09 docs(roadmap): record PR preparation snapshot`：记录 #237-#249 的 PR 准备结果、stacked base 与不直接 PR 的分支分类。
- `f0ef4bd fix(delegation): classify delegate tool for read-only posture`：把 `delegate` 纳入 mutating tool 分类，并让 `plan`/read-only posture 在 broker 解析前拒绝跨 runtime delegate，修复全量测试暴露的 fail-open。
- `2a51c3d fix(cli): merge runtime list definitions`：合并 `runtime list` 重复 Typer 命令，保留 `--json/--table`，默认 JSON 输出 `runtimes + summary` 作为 cross-runtime 单一事实源。
- `c8f23da test(lint): clean roadmap ruff violations`：清理 dev/roadmap 集成沙盘中的测试/脚本 lint 债，恢复全仓库 ruff clean。

本轮全量验证结果：
- Python：`uv run --extra dev pytest` -> **2459 passed, 8 skipped, 1 warning**（skips 为 `third_party/clawwork` harness 未构建/未设置 `SUPERCLAW_CLAWWORK_REPO`）。
- Python lint：`uv run --extra dev ruff check .` -> **All checks passed**。
- Web test：`npm --prefix apps/web run test` -> **8 files / 141 tests passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅 Vite 既有 chunk-size warning）。

交叉验证结果：
- Claude Sonnet QA（session `d084d6b4-61a5-4351-b348-4b77e47d2b96`）：**PASS**。认为本轮收敛动作本身满足 test worktree、clean tree、台账更新、PR traceability 和测试基线要求；提示 Prompt Envelope 沙盘漂移、Agent Team Kernel 无 PR、run cockpit/gemini-anthropic 投影交付分支缺口为非阻断风险。
- Gemini review：**FAIL**。认为这不是测试失败，而是路线图依赖完整性阻断：CW trust / Capability Workshop 尚未作为稳定地基完全收敛，Agent Team Kernel 仍是交付瓶颈，Cross-runtime 和 Display 的 done 状态不能替代依赖链完成。

当前结论：
- `dev/roadmap` 已具备作为路线图测试 worktree 的全量测试基线，但**不是路线图整体双顾问 PASS**。
- 权限/委派、runtime CLI fact source、Display、Escalation、Workspace sidebar、Capability/Trust 相关测试在同一沙盘内共同通过。
- 下一阶段按 Gemini 的严格口径收敛依赖链：先 CW trust / TrustState / namespace isolation / version contract，再 Capability Workshop，再 Display/Agent Team Kernel/Cross-runtime。
- 仍未改变 §2.2 中“不直接 PR”的分支判断：dirty 主 worktree和坏 base 分支需要继续按功能重新抽取。

### 2.2.2 CW trust hard-conflict merge record（2026-06-15, Codex 接手执行）

> 目标：先按依赖顺序收敛 CW trust 的 hard-conflict 缺口，再让 Capability Workshop 的 catalog/company/API/Web 基于同一 trust 地基继续开发。

本轮新增到 `dev/roadmap` 的收敛提交：
- `957f10e fix(trust): reject same-id signer conflicts`：新增 `plugin_signer_identity()`；`cache_plugin_package()` 在同 id/version 已存在时复核旧缓存完整性并拒绝不同 signer 覆盖；`available_plugins()` / `gate_passing_plugins()` 在选择 latest 前排除同 id 跨 signer 冲突，避免本地/开发者较新版本静默 shadow 官方包；新增 install-path 与 runtime-projection 两个回归测试。

本轮全量验证结果：
- Python：`uv run --extra dev pytest` -> **2461 passed, 8 skipped, 1 warning**（8 个 skips 为 `third_party/clawwork` harness 未构建或未设置 `SUPERCLAW_CLAWWORK_REPO`）。
- Python lint：`uv run --extra dev ruff check .` -> **All checks passed**。
- Web test：`npm --prefix apps/web run test` -> **8 files / 141 tests passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅 Vite 既有 chunk-size warning）。

交叉验证结果：
- Claude Sonnet QA（session `f603a01b-6abf-44fe-b9a0-17a149e55b23`）：**PASS**。确认 cache 写入、runtime projection、available/gate-passing 两入口均满足 hard-conflict 要求；非阻断建议为 `public_key=None` 粒度、invalid 桶、强制重装体验和性能。
- Gemini review（session key `superclaw-cw-trust-hard-conflict`）：**PASS**。确认 hard conflict 在 latest 选择前执行,可防止开发者/本地新版本 shadow 官方包；非阻断建议为大缓存 digest 性能和 `none` signer bucket 粒度。

PR traceability：
- 已从开发 worktree 抽成 clean stacked PR #254:base=`feat/cw-trust-core-pr`,head=`fix/trust-signer-conflicts`,commit `482bf5c fix(trust): reject same-id signer conflicts`。
- #254 clean PR 验证：Python full **1806 passed**;focused plugin local/runtime projection **28 passed**;web **99 passed** + build passed;scoped ruff + diff-check clean;Claude Sonnet QA session `d8eef6da-fbbd-4515-96fd-1f14254ee898` **PASS**;Gemini session key `superclaw-trust-signer-conflicts` **PASS**。
- #254 保留 `957f10e` 的行为目标,但基于 #251 重新解冲突,只带 `CHANGELOG.md`、`plugins.py`、`plugin_runtime_projection.py`、`test_plugin_local_verification.py`、`test_plugin_runtime_projection.py`;不带 `dev/roadmap` 沙盘其它测试/代码。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：T11 containment PR-A/PR-B -> Capability Workshop catalog resolver/trust state CLI -> API/Web 能力工坊 company tab。

### 2.2.3 T11 containment merge record（2026-06-16, Codex 接手执行）

> 目标：在 Capability Workshop 继续吸收 company/catalog/API/Web 之前,先把低信任 review 的运行时 fence 做成可验证的内核事实,并与 dev/roadmap 已有 escalation / delegation / display 路径共存。

本轮新增到 `dev/roadmap` 的收敛提交：
- `39337f6 feat(containment): add low-trust runtime fence`：新增 `ContainmentPolicy` / `resolve_containment_policy()`；company/workspace/issue/repo risk strictest wins；child run 与 delegated issue 继承 low-trust fence；orchestrator 在单一 dispatch choke point 拒绝不支持 containment 的 backend；CLI/API 暴露 workspace containment；B-class in-process tool loop 在低信任下拒绝 shell/write 和 secret-read。
- `a0a27ce feat(containment): refuse low-trust A-class runtimes`：Codex/Claude/codex-app-server 等 A-class/native runtime 对 low-trust 明确 fail-closed；补 worker backend canary/test 覆盖；修复 Gemini 复核指出的两个阻断:① low-trust reviewer 的 `delegate` 可穿透到 governed broker（普通 `plan` mode 仍拒绝）② `read_file` 同时检查 raw path、resolved path,并在 low-trust 下拒绝 hardlink/symlink secret-read 绕过。

本轮全量验证结果：
- Python：`uv run --extra dev pytest` -> **2495 passed, 9 skipped, 1 warning**（8 个 `clawwork` harness 条件 skip + 1 个 opt-in real-binary canary skip）。
- Python lint：`uv run --extra dev ruff check .` -> **All checks passed**。
- Web test：`npm --prefix apps/web run test` -> **8 files / 141 tests passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅 Vite 既有 chunk-size warning）。

交叉验证结果：
- Claude Sonnet QA（session `ead6a9a1-6b47-4856-82f7-753434439da4`）：**PASS**。第一轮认为整体 T11 架构满足要求；第二轮确认 Gemini 两个阻断均已关闭,无新阻断。
- Gemini review（session key `superclaw-t11-containment-review`）：第一轮 **FAIL**（contained delegate 被 readonly posture 拒绝;secret symlink/hardlink 读绕过）→ 修复后第二轮 **PASS**。

PR traceability：
- 已从开发 worktree 抽成 clean stacked PR #255:base=`fix/trust-signer-conflicts`(#254),head=`feat/containment-low-trust`,commits `525ab46 feat(containment): add low-trust runtime fence` / `335e937 feat(containment): refuse low-trust A-class runtimes` / `6fd1200 docs(changelog): record low-trust containment delivery`。
- #255 clean PR 保留 T11 核心语义,但刻意不携带 dev/roadmap 沙盘中 cross-runtime delegate tool/broker 线的运行时代码；low-trust 的 `delegate` 在 clean PR 中是 deny contract,真正 cross-runtime delegate 继续归 Cross-runtime 轨道。
- #255 clean PR 验证：Python full **1839 passed,1 skipped**(opt-in real-binary canary);focused containment/worker/projection **225 passed,1 skipped**;web **99 passed** + build passed;scoped ruff + diff-check clean;Claude Sonnet QA session `d9aaf0d2-28a5-43d0-bff1-2abc7d4b2728` **PASS**;Gemini session key `superclaw-t11-containment-clean-pr` **PASS**;GitHub check passed(`test` 3m44s)。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 下一依赖切片：Capability Workshop API `/v1/catalog` / Web marketplace dock / company catalog projection；TUF/developer registry refresh 后续独立切片。

### 2.2.4 Capability Workshop B5 catalog resolver merge record（2026-06-16, Codex 接手执行）

> 目标：在 trust / TrustState / namespace isolation / version contract / T11 containment 稳定后,先给 Capability Workshop 建立一个可测试、只读、fail-closed 的 catalog/trust CLI 地基,再开放 API/Web 能力工坊。

本轮新增到 `dev/roadmap` 的收敛提交：
- `66c03a2 feat(cli): add capability catalog resolver`：新增 `catalog_resolver.py`,把 registry、local cache、skill-origin projection、company template 统一成 `CatalogResolution` JSON contract；本地 plugin/skill 发现复用 `gate_passing_plugins()` 而不是裸 `list_cached_plugins()`；同 id 不同 signer 的 catalog 冲突显式进入 `conflicts`；`superclaw catalog resolve/list/refresh` 和 `superclaw trust state <id@version>` 暴露同一个 resolver/trust-state 事实源。
- `284b40f fix(catalog): keep resolver discovery side-effect free`（clean PR #256 追加修复）：fail-closed `refresh_catalog` 不再创建 registry 目录；invalid company template 不再被吞掉,而是以 `company_template_invalid` 的 untrusted catalog item 暴露；registry `.scplug` archive 在 B5 catalog resolution 中不被解包,保持 `registry_package_unavailable` fail-closed；high-risk permission 判断改为结构化非空 permission key,避免字符串误报。
- `this docs commit docs(roadmap): record capability catalog resolver PR`：更新本路线图状态和未来 PR 抽取记录。

本轮全量验证结果：
- dev/roadmap 沙盘 Python：`uv run --extra dev pytest` -> **2501 passed, 9 skipped, 1 warning**（8 个 `clawwork` harness 条件 skip + 1 个 opt-in real-binary canary skip）。
- clean PR #256 Python：`uv run --extra dev pytest` -> **1870 passed, 1 skipped**。
- clean PR #256 focused：`uv run --extra dev pytest tests/test_cli_catalog.py tests/test_company_template.py tests/test_plugin_runtime_projection.py tests/test_plugin_local_verification.py` -> **60 passed**。
- clean PR #256 scoped lint：`uv run --extra dev ruff check packages/superclaw/src/superclaw/catalog_resolver.py packages/superclaw/src/superclaw/cli.py tests/test_cli_catalog.py` -> **All checks passed**。
- Web test：`npm --prefix apps/web run test` / `npm test --prefix apps/web` -> **141 passed in sandbox;99 passed on clean PR #256**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅 Vite 既有 chunk-size warning）。
- Diff hygiene：`git diff --check` -> **passed**。

交叉验证结果：
- Claude Sonnet QA（session `f4cb5c70-49f6-4aa6-8df1-2aa9d3f726f9`）：**PASS**。确认 B5 命令、JSON shape、fail-closed gate、冲突 surfacing、refresh kept-cached 语义满足路线图；明确本切片未越界到 B6 API/Web。
- Gemini review（session key `superclaw-b5-catalog`）：**PASS**。确认 B5 范围满足路线图；执行过程中出现非阻断内部工具告警 `run_shell_command` unavailable,但评审结论仍为 PASS。
- clean PR #256 Gemini second review（session key `superclaw-b5-catalog-resolver-fix`）：**PASS**。第一轮指出 read-only side effects / hidden invalid company templates / archive extraction 等阻断；`284b40f` 修复后复核通过。
- clean PR #256 Claude Sonnet QA：first review **PASS**；second review 命令超时/empty wrapper response,不计 approval evidence。

PR traceability：
- 已从开发 worktree 抽成 clean stacked PR #256:base=`feat/capability-company-template`(#252),head=`feat/capability-catalog-resolver`,commits `48d12dd feat(cli): add capability catalog resolver` / `833b9d0 docs(changelog): record catalog resolver delivery` / `284b40f fix(catalog): keep resolver discovery side-effect free`。
- #252 已按 advisor 一致建议从 #251 retarget/rebase 到 #255 后面,形成线性 stack `#251 -> #254 -> #255 -> #252 -> #256`;#252 retarget 后 GitHub check passed。
- #256 PR 已创建,remote CI passed(`test`,2026-06-15T23:49:11Z),mergeStateStatus=`CLEAN`；合 main 时按该 stack 顺序推进,不从 `dev/roadmap` 直接 PR。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：API `/v1/catalog` -> Web marketplace dock/company tab -> TUF/developer registry refresh -> submit/signature blob-store hardening。

### 2.2.5 Capability Workshop B6 catalog API merge record（2026-06-16, Codex 接手执行）

> 目标：在 B5 catalog resolver / trust state CLI 稳定后,给 Web/Desktop/Marketplace 提供同一 resolver 的 API 薄包装和稳定 contract,但不启动 B7 Web/TUF。

本轮新增到 `dev/roadmap` 的收敛提交：
- `2fa0287 feat(api): add capability catalog endpoints`：新增 `/v1/catalog`、`/v1/catalog/trust/{plugin_id}/{version}`、`/v1/catalog/refresh`；API 直接包装 `catalog_resolver` / `resolve_trust_state`,并给 `/v1/plugins`、`/v1/skills` 在保留旧字段(`package_digest`/`acceptance_level`/`verified` 等)的同时回填 `trust`、`trust_reasons`、`signer_class`、`install_state`、`entitlement_state`、`sources`、`instantiable` 等 catalog 字段；新增 5s per-process catalog cache,install/local-install/github-install/uninstall 与 refresh 成功后失效,失败 refresh 保留旧缓存；新增 `/api/contracts/catalog` 供后续 B7 表层读取字段、trust state 和 conflict reason。
- `this docs commit docs(roadmap): record capability catalog api slice`：更新本路线图状态、CHANGELOG 和未来 PR 抽取记录。

本轮全量验证结果：
- Python：`uv run --extra dev pytest` -> **1880 passed, 1 skipped**。
- Focused：`uv run --extra dev pytest tests/test_plugin_cloud_api.py tests/test_cli_catalog.py tests/test_company_template.py -q` -> **51 passed, 1 warning**。
- Scoped lint：`uv run --extra dev ruff check apps/api/main.py packages/superclaw/src/superclaw/ui_contracts.py tests/test_plugin_cloud_api.py` -> **All checks passed**。
- Web test：`npm --prefix apps/web run test` -> **99 passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅 Vite 既有 chunk-size warning）。
- Diff hygiene：`git diff --check` -> **passed**。

交叉验证结果：
- Claude Sonnet QA（session `da23eb17-96f5-4f26-9986-130363a3e23e`）：**PASS**。确认范围严格限于 B6 API 投影,失败 refresh 保留旧缓存,legacy `/v1/plugins`/`/v1/skills` 为加法兼容;非阻断备注为 contract 中 `namespace_hijack`/`revoked` conflict reason 属前瞻声明、trust endpoint 后续可复用缓存层。
- Gemini review（session key `superclaw-b6-catalog-api`）：**PASS**。确认 API projection、fail-closed trust backfill、cache invalidation、refresh failure retained-cache、Web/Desktop contract 都符合 B6;非阻断备注为未来高并发可加 lock。

PR traceability：
- 已从开发 worktree 抽成 clean stacked PR #257:base=`feat/plugin-submit-signing-decouple`(#253),head=`feat/capability-catalog-api`,commits `3bba01a feat(api): add capability catalog endpoints` / `4c97974 docs(changelog): record catalog api delivery`。
- #257 PR 已创建,remote CI passed(2026-06-16T00:21:39Z);合 main 时按 stack `#251 -> #254 -> #255 -> #252 -> #256 -> #253 -> #257` 推进,不从 `dev/roadmap` 直接 PR。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：Web marketplace dock/company tab(B7) -> TUF/developer registry metadata refresh。

### 2.2.6 Capability Workshop B7 Web catalog merge record（2026-06-16, Codex 接手执行）

> 目标：在 B5 resolver 与 B6 API 稳定后,让 Web marketplace 真正消费 live catalog contract,同时把 company template 作为 discover-only 能力暴露,不在本切片引入安装/实例化流程。

本轮从开发 worktree 抽出的 clean stacked PR：
- PR #258 `feat/capability-catalog-web`,base=`feat/capability-catalog-api`(#257)。
- `6aa333d feat(web): add live capability catalog marketplace`：Web marketplace 加载 `/api/contracts/catalog` 与 `/v1/catalog`;live catalog 成功时使用 resolver 数据,失败时保留 ClawHunt marketplace catalog、legacy `/v1/plugins` 和 mock fallback;新增 Companies tab,只显示 `kind=company` 的 discover-only 条目且不提供 install/configure;catalog conflict banner 显示 resolver 冲突;trust label 优先使用 contract copy;install blocking 由 contract `install_blocking`、catalog conflict、revocation、namespace isolation、instantiable 状态和 legacy entitlement/revocation 共同判定;保留既有 skill projection tab 行为。
- `89e7a86 docs(changelog): record catalog web delivery`：记录 B7 Web catalog delivery。
- `4b73942 fix(web): block conflicted catalog installs`：补 Claude/Gemini review 后的阻断修复:revoked/conflict/trust-root/entitlement/select-first 阻断文案本地化,top-level catalog conflict 按 item 阻断 install,company 空状态 heading 使用专用 copy,并加 app-shell regression。

本轮全量验证结果（基于 PR #258 HEAD `4b73942`）：
- Python：`uv run --extra dev pytest` -> **1880 passed, 1 skipped**（1 个 opt-in real-binary canary skip）。
- Web test：`npm test --prefix apps/web` -> **99 passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅 Vite 既有 chunk-size warning）。
- Diff hygiene：`git diff --check` -> **passed**。
- Frontend sync gate：`git fetch origin feat/capability-catalog-api`;`merge-base HEAD origin/feat/capability-catalog-api` == `origin/feat/capability-catalog-api`。

交叉验证结果：
- Claude Sonnet QA final（session `4517fe4c-8e7b-4861-b510-584fef7e3deb`）：**PASS**。
- Gemini final（session key `superclaw-b7-catalog-web-final2`）：**PASS**。前两轮 blocker 已闭合;保留的 Skills tab discover/sync-only 与 ClawHunt marketplace fallback 优先级均为既有测试合同。

PR traceability：
- PR #258 已创建：`https://github.com/ClawHunt-Store/SuperClaw/pull/258`;remote CI passed(2026-06-16T00:51:58Z),mergeStateStatus=CLEAN。
- 合 main 时按 stack `#251 -> #254 -> #255 -> #252 -> #256 -> #253 -> #257 -> #258` 推进,不从 `dev/roadmap` 直接 PR。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘。
- 后续依赖顺序：B3 TUF/developer registry metadata refresh -> submit/signature production backlog 或转入 Display marketplace dock polish。

### 2.2.7 Capability Workshop B3 TUF registry metadata merge record（2026-06-16, Codex 接手执行）

> 目标：在 B5/B6/B7 已经把 catalog/API/Web live surface 收敛后,把原先 fail-closed placeholder 的 registry refresh 补成真实的 TUF-style developer registry metadata,并继续保持 catalog 只声明 discoverability、不直接授权执行。

本轮 clean PR 抽取：
- PR #259 `feat/capability-registry-metadata`,base=`feat/capability-catalog-web`(#258)。
- `f2f637d feat(kernel): add registry metadata trust refresh`：新增 `registry_metadata.py`,验证 `root.json` / `timestamp.json` / `snapshot.json` / `targets.json` 四件套,覆盖 Ed25519 签名、digest/version pinning、trust-state watermark、snapshot anti-rollback、timestamp freshness、delegated developer keys/targets、reserved namespace delegation 拒绝、offline/invalid refresh 保留缓存;`catalog_resolver` 接入 registry state,对 plugin/skill/company 只在 exact kind/id/version/digest + developer signature 匹配时分类为 `developer:<keyid>`,并把 registry freshness/rollback 传入 `derive_trust_state`。
- `fbfebd9 docs(changelog): record registry metadata delivery`：在 clean branch 的 `CHANGELOG.md` 记录本组交付、验证与 touched files。

本轮全量验证结果（基于 PR #259 HEAD `fbfebd9`）：
- Python：`uv run --extra dev pytest` -> **1888 passed, 1 skipped**。
- Focused：`uv run --extra dev pytest tests/test_registry_metadata.py tests/test_cli_catalog.py tests/test_plugin_cloud_api.py -q` -> **37 passed**。
- Python lint：scoped `uv run --extra dev ruff check packages/superclaw/src/superclaw/registry_metadata.py packages/superclaw/src/superclaw/catalog_resolver.py tests/test_registry_metadata.py tests/test_cli_catalog.py` -> **All checks passed**。
- Web test：`npm test --prefix apps/web` -> **99 passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅 Vite 既有 chunk-size warning）。
- Diff hygiene：`git diff --check` -> **passed**。
- 备注：full-repo `uv run --extra dev ruff check .` 被 legacy tests / streamtest / scripts / `third_party/` 的既有无关 lint 阻塞;本切片 touched files scoped ruff clean。

交叉验证结果：
- Gemini review（session key `superclaw-b3-registry-metadata-final`）：**PASS**,无 blocker。
- Claude Sonnet：skill wrapper 已调用但 review prompt 多次空返回;随后用 Claude Code Sonnet safe-mode/no-tools/no-session-persistence print fallback 返回 **PASS**,认为摘要中无可见阻断项。wrapper doctor 与 healthcheck 正常。

PR traceability：
- PR #259 已创建：`https://github.com/ClawHunt-Store/SuperClaw/pull/259`;remote CI passed(2026-06-16T01:21:13Z),mergeStateStatus=CLEAN。
- 合 main 时按 stack `#251 -> #254 -> #255 -> #252 -> #256 -> #253 -> #257 -> #258 -> #259` 推进,不从 `dev/roadmap` 直接 PR。
- 后续依赖顺序：Capability Workshop production signing/approval/registry publication backlog -> Display marketplace dock polish / Agent Team Kernel / Cross-runtime 后续。

### 2.2.8 Capability Workshop submit/signature hard blob-store merge record（2026-06-16, Codex 接手执行）

> 目标：在 B3 registry metadata 与既有 submit/signature 解耦基础上,补齐本地 Phase 4A 的硬 blob-store 签名边界:签名只能针对提交时审过的固定 stored blob,不能被 review record 字段重定向或 digest 篡改骗签。

本轮新增到 `dev/roadmap` 的收敛提交：
- `181ff0f fix(plugin): harden developer submission blob signing`：`sign_reviewed_submission()` 现在固定从 `submission_root / submission_id / "package"` 派生 stored blob,拒绝 symlink/目录逃逸,只把 record `blob_path` 当一致性校验而不作为签名输入;签名前重算 canonical package digest,并要求同时匹配 `artifact_blob_digest` 与 reviewed `package_digest`;缺失或不匹配一律 fail-closed。新增回归测试覆盖 review 后 blob 内容变异、record `blob_path` 重定向、`artifact_blob_digest` 篡改、`package_digest` 篡改,同时保持 submit-alone 不签名与 REST submit-time signing key 400 行为。
- `this docs commit docs(roadmap): record developer submission blob hardening`：更新本路线图状态、CHANGELOG 和未来 PR 抽取记录。

本轮全量验证结果：
- Python：`uv run --extra dev pytest` -> **2516 passed, 9 skipped, 1 warning**（8 个 `clawwork` harness 条件 skip + 1 个 opt-in real-binary canary skip;warning 为既有 duplicate zip member 用例）。
- Python lint：`uv run --extra dev ruff check .` -> **All checks passed**。
- Web test：`npm --prefix apps/web run test` -> **8 files / 141 tests passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅 Vite 既有 chunk-size warning）。
- Focused submit/API regression：`uv run pytest tests/test_plugin_submission.py tests/test_plugin_cloud_api.py -q` -> **58 passed**。
- Diff hygiene：`git diff --check` -> **passed**。

交叉验证结果：
- Gemini review（session key `superclaw-submit-blob-hardening`）：**PASS**。确认 submit/review 不签名、signing 固定派生 blob 路径、重算 digest 并同时匹配 `artifact_blob_digest`/`package_digest`、record 路径重定向与 digest 篡改测试有效。非阻断观察：local Phase 4A 在 digest check 与 copy-to-signed 之间仍有微小 TOCTOU 窗口,生产 KMS/blob-store 阶段继续收紧。
- Claude Sonnet QA（session `dff4cc6e-2d69-4d1c-aee8-e79c91fbe089`）：**PASS**。逐条确认 submit/review 永不签名、record `blob_path` 只做反向验证、stored blob digest 重新计算、两个 digest 字段缺失/篡改均 fail-closed,无阻断项。

PR traceability：
- 未来从开发 worktree 发 main PR 时,本切片应抽成独立分支（建议 `fix/capability-submission-blob-signing`,base=`origin/main` 或当时已合入的 trust/T11/B5/B6/B7/B3 stack base）,至少包含 `181ff0f`、测试和本记录 commit。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：Capability Workshop production signing/approval backlog 先保留为设计项;按 Leon 当前收敛顺序转入 Display marketplace dock polish / Agent Team Kernel / Cross-runtime P1-2/P1-3。

### 2.2.8a Capability Workshop company template PR record（2026-06-16, Codex 接手执行）

> 目标：把 #239 中非重复的 company schema / validate CLI 切片从旧 trust 分支中抽出,基于 #251 `feat/cw-trust-core-pr` 形成可独立评审的 stacked PR;不重带 obsolete `ebe2436` trust 原语。

本轮交付分支 / PR：
- `feat/capability-company-template`（worktree `/Users/leongong/Documents/superClaw-capability`）:从 `feat/cw-trust-core-pr` 切出,仅 1 个原子 commit `1f954f1 feat(company): add signed company template validation`。
- Draft PR #252:base=`feat/cw-trust-core-pr`,head=`feat/capability-company-template`。

本轮交付内容：
- 新增 `packages/superclaw/src/superclaw/company_template.py`: `CompanyTemplate` 平行签名资产域模型,复用 #251 的 `PackageTrustVerifier` / `SignedArtifactEnvelope`,使用独立 `SUPERCLAW_COMPANY_*` trust env 与 company revocation file。
- 新增 `schemas/superclaw-company.schema.json`: `kind=company` 的标准清单 schema,拒绝 plugin-only `acceptance` 等额外字段。
- 新增 `superclaw company template validate <path> [--verify-signature]`: P0 validation-only CLI,仅做目录/`.sccompany` 加载、schema + roles/equipment/reports_to 关系校验、可选 digest/signature/revocation 校验;不 install/run/authorize/instantiate。
- 新增 `tests/test_company_template.py`:覆盖合法模板、重复角色、未知 equipment、reports_to cycle、`.sccompany` archive、zip-slip、symlink、digest/signature/revocation、local-dev trust、CLI 正负路径。

本轮验证结果：
- Python：`uv run --extra dev pytest` -> **1826 passed**。
- Focused：`uv run --extra dev pytest tests/test_company_template.py tests/test_trust.py tests/test_plugin_local_verification.py tests/test_namespace_isolation.py` -> **66 passed**。
- Scoped lint：`uv run --extra dev ruff check packages/superclaw/src/superclaw/company_template.py tests/test_company_template.py packages/superclaw/src/superclaw/cli.py` -> **All checks passed**。
- Web test：`npm --prefix apps/web run test -- --run` -> **99 passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅既有 Vite chunk-size warning）。
- Diff hygiene：`git diff --check feat/cw-trust-core-pr..HEAD` -> **passed**。

交叉验证结果：
- Gemini review（session key `superclaw-capability-company-template`）：**PASS**。确认 CompanyTemplate 是 parallel signed asset domain,使用 kind-scoped trust env,archive/schema/signature/revocation fail-closed,validation-only。
- Claude Sonnet QA（session `5e5c6fff-5cc6-42e2-be43-865efc93b262`）：**PASS**。逐项确认 #251 shared trust、无 #239 obsolete trust、validation-only、zip-slip/symlink/digest/signature/revocation fail-closed、CLI 控制流无阻断。

PR traceability：
- 未来合 main 时,先合 #251 或保持 #252 stacked;#252 即本切片的交付 PR,不再使用 #239 原始 bundled PR。
- #239 的 submit/signature decouple 来源已抽成 #253 `feat/plugin-submit-signing-decouple`;旧 #239 不再直接合。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。

### 2.2.8b Capability Workshop submit/signature PR record（2026-06-16, Codex 接手执行）

> 目标：把旧 #239 中非重复的 submit/signature decouple 与 `dev/roadmap` 已验证的 hard blob-store signing boundary 合并成一个 clean stacked PR,并在 B5 catalog resolver 后重新排栈,不重带 obsolete trust/company 代码。

本轮交付分支 / PR：
- `feat/plugin-submit-signing-decouple`（worktree `/Users/leongong/Documents/superClaw-capability`）:已从 `feat/cw-trust-core-pr` 重排到 B5 `feat/capability-catalog-resolver` 后,2 个原子 commit `c1cd04b feat(plugin): decouple submission review from signing` + `43b0449 fix(plugin): harden developer submission blob signing`。
- Draft PR #253:base=`feat/capability-catalog-resolver`(#256),head=`feat/plugin-submit-signing-decouple`;remote CI passed。

本轮交付内容：
- `superclaw plugin submit` 只做 developer package review,存储 immutable submitted package blob,返回 `ready_for_signing`;submit 阶段不再接受 signing private key,也不产出 verified artifact。
- 新增 `superclaw plugin sign-submission`,作为本地 isolated signing path;签名前固定从 `submission_id/package` 派生 reviewed stored blob,拒绝 symlink/目录逃逸,record `blob_path` 只作为一致性校验。
- REST artifact submit endpoint 对 submit-time `signing_private_key` 400 fail-closed,避免 API 绕过 CLI 两阶段边界。
- `sign_reviewed_submission()` 签名前重算 canonical package digest,并要求同时匹配 `artifact_blob_digest` 与 reviewed `package_digest`;stored blob、record path、两个 digest 字段任一篡改都 fail-closed。
- 更新 `tests/test_plugin_submission.py` 与 `tests/test_plugin_cloud_api.py`,覆盖 submit-alone 不签名、非 ready status 拒签、blob mutation、record path redirect、digest tamper、REST submit-time key 拒绝等回归。

本轮验证结果：
- Python：`uv run --extra dev pytest` -> **1877 passed,1 skipped**。
- Focused：`uv run --extra dev pytest tests/test_plugin_submission.py tests/test_plugin_cloud_api.py tests/test_cli_catalog.py tests/test_company_template.py` -> **86 passed**。
- Scoped lint：`uv run --extra dev ruff check packages/superclaw/src/superclaw/plugin_submission.py tests/test_plugin_submission.py tests/test_plugin_cloud_api.py apps/api/main.py packages/superclaw/src/superclaw/cli.py` -> **All checks passed**。
- Web test：`npm --prefix apps/web run test -- --run` -> **99 passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅既有 Vite chunk-size warning）。
- Diff hygiene：`git diff --check` -> **passed**。
- Pre-push version gate：`CHANGELOG.md`、`VERSION`、SemVer、`Unreleased`、release heading、本切片 changelog 记录均通过。

交叉验证结果：
- Gemini review（session key `superclaw-253-after-b5`）：**PASS**。确认 review/signing 已解耦,signer 只绑定 stored blob,API fail-closed,不与 catalog/company 切片耦合。
- Claude Sonnet QA（session `70e53d34-d790-45bc-b62e-9a068a5ec759`）：**PASS**。确认 submit key 移除、`ready_for_signing` 状态、不变 blob、symlink/path-escape guard、record redirect 拒绝、双 digest 照合均满足路线图。

PR traceability：
- 未来合 main 时,按 stack `#251 -> #254 -> #255 -> #252 -> #256 -> #253` 推进;#253 即本切片的交付 PR,不再使用 #239 原始 bundled PR。
- #253 submit/signature 现在显式跟在 B5 catalog resolver 之后;它不依赖 B6/B7/B3,但会先于 B6 解决 `apps/api/main.py` / `tests/test_plugin_cloud_api.py` 的重叠面。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：Capability Workshop production KMS/HSM signing service、manual approval queue、multipart/server immutable blob store、registry publication 保持 backlog;按 Leon 当前收敛顺序转入 Display marketplace dock polish / Agent Team Kernel / Cross-runtime P1-2/P1-3。

### 2.2.8c Display BATCH diagnostic PR repair record（2026-06-16, Codex 接手执行）

> 目标：把旧 #246 从 `feat/display-protocol-chat`(#241) 上的 DIRTY/no-checks 状态收敛为基于 run cockpit #260 的 clean stacked PR,只表达 BATCH runtime honesty 增量,不夹带 #260 已拥有的 run cockpit display contract。

本轮交付分支 / PR：
- `feat/display-batch-dl4`（worktree `/Users/leongong/superclaw-wt/display-batch`）已 rebase 到 `origin/feat/display-run-cockpit` 后重写为 3 个原子 commit:
  - `b4eb1d5 feat(display): BATCH runtime honesty — adapter.diagnostic for non-streaming backends (DL4)`
  - `a96aa86 test(display): fix worker backend lint imports`
  - `5b71d49 docs(display): record batch diagnostic roadmap slice`
- Draft PR #246:base=`feat/display-run-cockpit`(#260),head=`feat/display-batch-dl4`,HEAD `5b71d49`。旧 head `75f0d07` 已用 `--force-with-lease` 更新;旧 base #241 已改为 #260。

本轮交付内容：
- `build_adapter_diagnostic()` 生成 canonical `adapter.diagnostic`(`capability_tier=batch`,`streaming=false`,`tool_lifecycle=false`,`reason`)并通过 display contract validation。
- 非流式 delivery backend 统一由 orchestrator `_run_backend()` 在 `backend.run()` 前早发 diagnostic,覆盖顺序与 parallel frontier 两条执行路径;streaming backend 正常 tool.* 路径不误标 batch。
- streaming backend 落回 `run_command()` 时才由 worker 层发 fallback diagnostic;`_synthetic_result` 保持 display-silent,避免双发。
- generic chat SSE 在阻塞等待 batch backend 结果前先 yield diagnostic;Web chat 使用 `isChatDisplayEvent` + `DisplayAccumulator` + `TurnDisplay` 渲染 BATCH note。
- run cockpit 继续使用 #260 的 `classifyRunDisplayEvent()` 独立 diagnostic lane,本切片只保证 payload/reason 与 id 正确。
- 顾问复核后修复 synthetic id 碰撞:delivery diagnostic id 绑定 `run_id/task_id/backend/suffix`,generic chat id 绑定 `session_id/backend`;默认 helper id 为稳定 synthetic string,避免多个 BATCH backend 在同一 turn 被前端 `seenIds` 去重吞掉。
- Web fallback 文案与 projector docstring 统一英文,不再出现混杂 "tool痕迹"。

本轮验证结果：
- Full Python：`uv run --extra dev pytest` -> **1835 passed**。
- Focused Python：`uv run --extra dev pytest tests/test_display_projection.py tests/test_orchestrator.py tests/test_worker_backends.py -q` -> **291 passed**。
- Web：`npm test --prefix apps/web` -> **122 passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅既有 Vite chunk-size warning）。
- Scoped lint：`uv run --extra dev ruff check apps/api/main.py packages/superclaw/src/superclaw/backends.py packages/superclaw/src/superclaw/display_projection.py packages/superclaw/src/superclaw/orchestrator.py tests/test_display_projection.py tests/test_orchestrator.py tests/test_worker_backends.py` -> **All checks passed**。
- Diff hygiene：`git diff --check` -> **passed**。
- Pre-push version gate：`CHANGELOG.md`、`VERSION`、SemVer、`Unreleased`、release heading、本切片 changelog 记录均通过。
- Full lint residual：`uv run --extra dev ruff check .` 仍失败于既有 unrelated/third_party lint(66 errors),本轮未混入无关格式清理。

交叉验证结果：
- Gemini first review：approved with comments;指出 UI/docstring language consistency 与 parallel diagnostic `id=1` collision 风险。
- Claude Sonnet QA first review：PASS,并提示确认 `apps/api/main.py` chat path upfront emit。
- 本轮修复后 Gemini final review：**PASS**。
- 本轮修复后 Claude Sonnet QA final review：**PASS**(session `7e1041fa-ff42-4225-b994-8e458d6a33d3`)。

PR traceability：
- 未来合 main 时,按 stack `#241 -> #260 -> #246` 推进;#246 即 BATCH diagnostic DL4 交付 PR,不再使用旧 `dev/batch-display` 或旧 #246 head 形态。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续 Display 依赖顺序：`feat/gemini-anthropic-projection` / marketplace dock 必须建立在 #246 之后,因为它复用 BATCH diagnostic 的 `_run_backend()` gate 与 chat 三端点显示语义。
- GitHub CI：`test` SUCCESS(2026-06-16T02:30:48Z),mergeStateStatus=CLEAN。

### 2.2.8d Display api-agent true tool projection PR record（2026-06-16, Codex 接手执行）

> 目标：把旧 `feat/gemini-anthropic-projection` 从混合 dev/roadmap base 收敛为基于 Display BATCH #246 的 clean stacked PR,只表达 gemini/anthropic-agent api-agent 真工具执行投影与 chat cards 增量。

本轮交付分支 / PR：
- `feat/gemini-anthropic-projection`（worktree `/Users/leongong/superclaw-wt/gemini-anthropic-projection`）已备份旧 head 到 `backup/gemini-anthropic-projection-before-rebase-20260616`,再重置到 `origin/feat/display-batch-dl4` 并只 cherry-pick intended commits。
- Clean commits:
  - `217404b feat(display): project api-agent tool executions`
  - `99722f2 feat(chat): surface api-agent tool cards`
  - `5e55964 docs(changelog): record api-agent display projection`
- Draft PR #261:base=`feat/display-batch-dl4`(#246),head=`feat/gemini-anthropic-projection`,HEAD `5e55964`。

本轮交付内容：
- `display_projection` 只从 api-agent 实际 tool execution records 投影 tool cards,不从自然语言或 assistant 文本重构 tool traces。
- gemini / anthropic-agent 这类 api-agent backend 在拥有真实工具记录时标记为 `surfaces_live_tools=True`,因此通过 orchestrator `_run_backend()` 跳过 BATCH diagnostic,避免同一 turn 同时出现"无实时工具"与真实 tool card。
- Chat turn 同步与 streaming 三端点在 `message.completed` 前 drain display events,让 Web chat card 能看到真实工具调用、结果与错误状态。
- Web chat card 渲染继续走 Display accumulator/contract,不新增平行 UI 协议。

本轮验证结果：
- Full Python：`uv run --extra dev pytest` -> **1845 passed**。
- Focused Python：`uv run --extra dev pytest tests/test_display_projection.py tests/test_api.py tests/test_worker_backends.py -q` -> **364 passed**。
- Web：`npm test --prefix apps/web` -> **122 passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅既有 Vite chunk-size warning）。
- Scoped lint：`uv run --extra dev ruff check apps/api/main.py packages/superclaw/src/superclaw/backends.py packages/superclaw/src/superclaw/chat_turn.py packages/superclaw/src/superclaw/display_projection.py tests/test_api.py tests/test_display_projection.py` -> **All checks passed**。
- Diff hygiene：`git diff --check` -> **passed**。
- Full lint residual：`uv run --extra dev ruff check .` 仍失败于既有 unrelated/third_party lint(66 errors),本轮未混入无关格式清理。

交叉验证结果：
- Gemini review：**PASS**。
- Claude Sonnet QA review：**PASS**(session `e1d4ed18-68a2-4045-8a92-b737a2009df3`)；验收点覆盖 real-only projection、#246 diagnostic id 合同不回退、api-agent 不误发 batch diagnostic、stream completed 前 drain display events、sync 返回 display_events、streaming 不重复收集、测试覆盖核心路径。

PR traceability：
- 未来合 main 时,按 stack `#241 -> #260 -> #246 -> #261` 推进;#261 即 api-agent true tool projection 交付 PR,不再使用旧 dev/roadmap 混合 head。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续 Display 依赖顺序：marketplace dock / 更完整 cockpit diagnostic 可建立在 #261 之后,因为 chat cards 已能区分 BATCH honesty 与 api-agent 真工具投影。
- GitHub CI：`test` SUCCESS(2026-06-16T02:54:26Z),mergeStateStatus=CLEAN。

### 2.2.8e Display marketplace dock PR record（2026-06-16, Codex 接手执行）

> 目标：把本地 main ahead 中的 `b04c48a` ClawHunt marketplace dock 抽成基于 Display #261 的 clean stacked PR,只表达空 chat surface marketplace dock + CLI/API pagination/fail-closed contract,不夹带 local-main preservation PR #240 的其他 36 个 commit。

本轮交付分支 / PR：
- `feat/display-market-dock`（worktree `/Users/leongong/superclaw-wt/display-market-dock`）基于 `origin/feat/gemini-anthropic-projection`(#261),cherry-pick 原始 dock commit 后补齐 payload type 与注释修正,并把 changelog 记录 amend 到同一原子 commit。
- Clean commit:
  - `2e42b87 feat(web): ClawHunt marketplace dock in the empty chat surface`
- Draft PR #262:base=`feat/gemini-anthropic-projection`(#261),head=`feat/display-market-dock`,HEAD `2e42b87`。

本轮交付内容：
- 空 chat surface 的 composer 下方新增 ClawHunt marketplace dock,仅作为 presentation surface;选中 task 复用既有 ClawHunt detail/readiness flow,不绕过登录/就绪 gate,不自动发起 delivery。
- CLI `clawhunt browse` 与 `/api/clawhunt/tasks` 统一 `skip`/`limit`/`status` 分页契约;API 对 out-of-range 返回 422,不 silent clamp。
- API 对 upstream `ok=false` fail-closed:不从失败 body 解析 tasks,且 `raw=null`,避免 401/error body 被市场 dock 或 task browser 当成可用问题列表。
- Web dock 用 synchronous loading ref + request id 防止同帧重复 load 与过期响应写入;ClawHunt 账号链接后自动 reset 刷新;隐藏 scrollbar 下通过 scroll threshold 自动加载下一页。
- 不触碰 Display chat cards、BATCH diagnostic、api-agent tool projection internals;该 PR 只叠在 #261 之后消费现有 chat surface。

本轮验证结果：
- Full Python：`uv run --extra dev pytest` -> **1846 passed**。
- Focused API：`uv run --extra dev pytest tests/test_api.py -q` -> **131 passed**。
- Web：`npm test --prefix apps/web` -> **122 passed**。
- Web build：`npm --prefix apps/web run build` -> **passed**（仅既有 Vite chunk-size warning）。
- Scoped lint：`uv run --extra dev ruff check apps/api/main.py packages/superclaw/src/superclaw/cli.py tests/test_api.py` -> **All checks passed**。
- Diff hygiene：`git diff --check` -> **passed**。
- Pre-push version gate：`CHANGELOG.md`、`VERSION`、SemVer、`Unreleased`、release heading、本切片 changelog 记录均通过。
- Full lint residual：`uv run --extra dev ruff check .` 仍失败于既有 unrelated/third_party lint(66 errors),本轮未混入无关格式清理。

交叉验证结果：
- Claude Sonnet QA：**PASS**(session `175101b2-7b49-40fc-af55-d62872a6ed38`);指出 payload type 与 CSS 注释两个可直接修正项,已修入 final commit;hook deps 提醒为非阻断,本轮未做 useCallback churn。
- Gemini direct diff review：**PASS**(session `12af8497-46a1-4fd6-a941-2c14fd42dae6`,0 tool calls)。wrapper 首次尝试因不可用 tool + Gemini capacity 429 未产出结论,改用 direct diff stdin review 成功。

PR traceability：
- 未来合 main 时,按 stack `#241 -> #260 -> #246 -> #261 -> #262` 推进;#262 即 marketplace dock 交付 PR,#240 仅保留 local main ahead inventory,不作为本功能最终交付单元。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：Display 方向当前 clean PR stack 已覆盖 chat contract/cards、run cockpit、BATCH diagnostic、api-agent true tool projection、marketplace dock;下一阶段可转入 Agent Team Kernel 冲突收敛。
- GitHub CI：`test` SUCCESS(2026-06-16T03:29:29Z),mergeStateStatus=CLEAN。

### 2.2.8a Cross-runtime delegation P1-1b clean PR extraction record（2026-06-16, Codex 接手执行）

> 目标：把 dev/roadmap 沙盘里的 P1-1b delegate tool 注入切片抽成基于 P1 admission 的干净 stacked PR。

本轮交付：
- Clean branch：`feat/cross-runtime-p1-delegate-tool`。
- Commit：`3259330 feat(delegation): add P1 delegate tool intent path`。
- PR：#264 `https://github.com/ClawHunt-Store/SuperClaw/pull/264`，base=`feat/cross-runtime-p1-admission`，head=`feat/cross-runtime-p1-delegate-tool`。
- 范围：Gemini/Anthropic API-agent loop 仅在 `delegation_enabled()`、发起 backend 合格、`delegation_depth == 0` 时注入 `delegate`;合法调用解析为 `DelegationRequested` 后记录 `delegation_requested` stream event，并在 P1-2 broker 尚未接入前 fail-closed 返回非零结果；`delegate` 归类为 mutating tool，plan/read-only posture 在 broker 前拒绝。

本轮验证：
- Focused Python：`uv run --extra dev pytest tests/test_cross_runtime_delegation.py tests/test_worker_backends.py tests/test_permission_presets.py -q` -> **347 passed**。
- Full Python：`uv run --extra dev pytest -q` -> **1908 passed**。
- Web：`npm test --prefix apps/web` -> **99 passed**；`npm run build --prefix apps/web` -> **passed**（仅既有 Vite chunk-size warning）。
- Scoped ruff：`uv run --extra dev ruff check packages/superclaw/src/superclaw/backends.py packages/superclaw/src/superclaw/cross_runtime_delegation.py packages/superclaw/src/superclaw/permissions.py tests/test_cross_runtime_delegation.py tests/test_worker_backends.py tests/test_permission_presets.py` -> **All checks passed**。
- Diff hygiene / version gate：`git diff --check` passed；`CHANGELOG.md`、`VERSION`、SemVer、`Unreleased`、release heading、本切片 changelog 记录均通过。

交叉验证：
- Gemini review first pass caught real blocker: unhandled `DelegationRequested` would crash the backend loop if the tool was actually called. The final PR now covers Gemini and Anthropic full tool loops and returns a fail-closed `WorkerResult` instead of raising through the orchestrator.
- Claude Sonnet QA first pass independently flagged the same blocker plus exception string/schema/test symmetry notes; final PR adds exception args, `additionalProperties: false`, and symmetric Anthropic disabled/depth coverage.

PR traceability：
- #264 is the P1-1b clean delivery PR. P1-2a durable broker suspension and P1-2b/P1-3 reviewed result gate remain in dev/roadmap and should be extracted as later stacked clean PRs after #263/#264.
- Current `dev/roadmap` remains an integration/testing sandbox, not a direct main PR source.

### 2.2.9 Cross-runtime delegation P1-2a durable broker suspension merge record（2026-06-16, Codex 接手执行）

> 目标：把 P1-1b 已注入的 `delegate(...)` 工具接入 orchestrator-owned broker,让合法请求进入可持久化 child wait,非法请求 fail-closed,不再从 generic exception path 把 parent run 打成失败。

本轮新增到 `dev/roadmap` 的收敛提交：
- `this code commit feat(delegation): add durable child delegation suspension`：新增 `WAITING_FOR_CHILD_DELEGATION` run status 与 liveness active/waiting 语义;orchestrator 顺序/并行 worker 路径捕获 `DelegationRequested`;通过 `authorize_delegation_for_parent()` 做 source backend、开关、depth、principal、inventory、profile/equipment、budget、pay/scan 准入;P1-2 执行期要求显式 target runtime,禁止 `runtime=None` 默退到 `claude`;按 parent tool-call id 写 `child_delegation_waits` 去重并只创建一个 linked child;child execution context 写入 `delegation_depth`/trace/origin/parent tool-call id;parent 先持久化 `WAITING_FOR_CHILD_DELEGATION` 再启动新 child;child streaming event 以 `child_run.event` 嵌套转发给 parent;child terminal sync 更新 wait record。
- `this docs commit docs(roadmap): record cross-runtime P1-2a broker slice`：更新本路线图状态、CHANGELOG 和未来 PR 抽取记录。

本轮验证结果：
- Focused P1-2a/liveness/model regression：`uv run pytest tests/test_orchestrator.py::test_orchestrator_delegate_request_spawns_child_and_waits tests/test_orchestrator.py::test_orchestrator_parallel_delegate_request_spawns_one_child_and_waits tests/test_orchestrator.py::test_orchestrator_delegate_runtime_none_denies_without_child tests/test_liveness.py::test_waiting_for_child_delegation_is_waiting_not_live tests/test_models.py::test_run_status_transition_rules_capture_verifying_and_human_gate_compatibility -q` -> **5 passed**。
- Related Python regression：`uv run pytest tests/test_orchestrator.py tests/test_cross_runtime_delegation.py tests/test_liveness.py tests/test_models.py -q` -> **264 passed**。
- Full Python regression：`uv run --extra dev pytest` -> **2520 passed / 9 skipped / 1 warning**。
- Full Python lint：`uv run --extra dev ruff check .` -> **All checks passed**。
- Web regression：`npm --prefix apps/web run test` -> **141 passed**; `npm --prefix apps/web run build` -> **passed**(仅既有 Vite chunk-size warning)。
- Diff hygiene：`git diff --check` -> **passed**。
- Python lint(scope)：`uv run ruff check packages/superclaw/src/superclaw/orchestrator.py packages/superclaw/src/superclaw/models.py packages/superclaw/src/superclaw/liveness.py tests/test_orchestrator.py tests/test_liveness.py tests/test_models.py` -> **All checks passed**。
- Compile check：`uv run python -m compileall -q packages/superclaw/src/superclaw/orchestrator.py packages/superclaw/src/superclaw/models.py packages/superclaw/src/superclaw/liveness.py` -> **passed**。

交叉验证结果：
- Gemini first review found two real blockers: sequential path must raise `_DelegationSuspended` instead of returning `RunResult`, and parallel path must authorize with `bound_limits`; both fixed and covered by sequential/parallel tests.
- Claude Sonnet QA final review PASS(session `28c87121-0794-4bd2-9619-dc20c58c2e02`): confirmed fixed sequential suspension, bound parallel policy, child-start-after-parent-persist, and reuse path not restarting child.
- Gemini final review PASS: confirmed P1-2a functional milestone; nonblocking hardening backlog = parent RMW guard, `_threads` lock, and event sink DB-read optimization.

PR traceability：
- 未来从开发 worktree 发 main PR 时,本切片应抽成独立分支（建议 `feat/cross-runtime-p1-2a-broker-suspension`,base=`origin/main` 或当时已合入的 Cross-runtime P0/P1 stack base）,至少包含本 code commit、测试和本记录 commit。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：继续 Cross-runtime 更完整 child stream replay/resume 消费 + API/CLI review surface + parent RMW/thread-table hardening → P2 native/MCP / event sink hardening;Background/TUI/Architecture invariants 仍等核心状态模型稳定后开。

### 2.2.10 Cross-runtime delegation P1-2b/P1-3 reviewed delegate result gate merge record（2026-06-16, Codex 接手执行）

> 目标：让 P1-2a 的 child terminal fact 不能被父模型自动当作已批准结果继续执行；先生成 bounded parent tool-result 草案,经人工 review 批准后才进入父 run continuation context。

本轮新增到 `dev/roadmap` 的收敛提交：
- `this code commit feat(delegation): require review for child delegate results`：child terminal sync 时构造 parent-visible `delegate_tool_results` 记录,绑定 `request_key` / parent tool-call id / child run id / child evidence artifact / chain verdict / bounded output summary,默认 `pending_review`;`resume_run()` 在存在 pending delegate tool-result 时保持 `WAITING_FOR_CHILD_DELEGATION` 并记录 `run.resume.blocked`,不重进父 backend;新增 `review_child_delegation_result()` 内核入口,批准后把结果标为 `approved` 并保留在父 `execution_context` 供下一次 resume 的 worker turn 消费,拒绝则父 run fail-closed 并写 `cross_runtime_delegation_review` evidence finding。
- `this docs commit docs(roadmap): record cross-runtime reviewed result gate`：更新 `CHANGELOG.md`、本路线图状态和未来 PR 抽取记录。

本轮已跑验证：
- Focused P1-2b/P1-3 regression：`uv run --extra dev pytest tests/test_orchestrator.py::test_orchestrator_delegate_request_spawns_child_and_waits tests/test_orchestrator.py::test_orchestrator_delegate_result_requires_review_before_parent_continues tests/test_orchestrator.py::test_orchestrator_delegate_result_rejection_fails_parent_closed tests/test_orchestrator.py::test_orchestrator_resume_blocks_while_delegated_child_is_running -q` -> **4 passed**。
- Related Python regression：`uv run --extra dev pytest tests/test_orchestrator.py tests/test_cross_runtime_delegation.py tests/test_liveness.py tests/test_models.py -q` -> **267 passed**。
- Full Python regression：`uv run --extra dev pytest` -> **2523 passed / 9 skipped / 1 warning**（warning 为既有 duplicate zip member 测试）。
- Full Python lint：`uv run --extra dev ruff check .` -> **All checks passed**。
- Web regression：`npm --prefix apps/web run test && npm --prefix apps/web run build` -> **141 passed + build passed**（保留既有 Vite chunk-size warning）。
- Diff hygiene：`git diff --check` -> **passed**。
- Cross validation：Gemini final review -> **PASS**；Claude Sonnet QA final review -> **PASS**。

PR traceability：
- 未来从开发 worktree 发 main PR 时,本切片应抽成独立分支（建议 `feat/cross-runtime-reviewed-delegate-result`,base=`origin/main` 或当时已合入的 Cross-runtime P0/P1 stack base）,至少包含本 code commit、测试和本记录 commit。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：继续更完整 child stream replay/resume 消费 + API/CLI review surface + event sink/thread-table/parent RMW hardening → P2 native/MCP;Background/TUI/Architecture invariants 仍等核心状态模型稳定后开。

### 2.2.11 Cross-runtime delegation P1-0/P1-1a clean PR extraction（2026-06-16, Codex 接手执行）

> 目标：把 `dev/roadmap` 沙盘中已存在的 P1-0 admission + P1-1a profile adapter / `DelegationBroker` 准入编排抽成可对远程仓库推进的原子 stacked PR,不携带后续 P1-1b/P1-2/P1-3 代码。

本轮组织出的交付分支：
- PR #263：`https://github.com/ClawHunt-Store/SuperClaw/pull/263`
- branch：`feat/cross-runtime-p1-admission`
- base：`feat/cross-runtime-delegation-p0` / PR #238（P0 foundation）；待 #238 合入 main 后可 retarget 或按 stack 合并到 main。
- worktree：`/Users/leongong/superclaw-wt/cross-runtime-p1-admission`

本轮 clean commits：
- `8c39377 feat(delegation): cross-runtime 向内 P1-0 admission 准入层`：新增纯 admission 层 `DelegationRequest` / `DelegationDecision` / `authorize_delegation_request`,fail-closed 校验 delegation 开关、发起 backend eligibility、depth、principal/audit id、request 字段形状、pay/scan classifier、runtime availability、profile/equipment、budget。
- `a42b267 feat(delegation): cross-runtime P1-1a — profile adapter + DelegationBroker 准入编排`：新增 `project_agent_profile()` 与 parent-aware broker 编排,从 parent run context 继承 depth/principal/origin/trace,并把 native profile 投影成 authorize 契约后再做中央准入。
- `02c28a7 docs(delegation): record cross-runtime admission slice` + `c22dd8d docs(delegation): tighten admission changelog scope`：记录 P1 admission 范围,并按 Claude advisory 去掉 path containment / writable-tool hard-block 的过声明；这两项属于后续 governed spawn/execution 边界,不是本纯 admission slice。
- `0245850 test(evals): run fake CLI helpers with current interpreter` + `9d0b8d8 test(api): allow desktop toolchain contract in worktrees`：测试稳定化前置,只改测试,用于让 stacked worktree 在非 `superclaw` 目录名与当前 venv interpreter 下能跑全量。

本轮验证：
- Focused admission regression：`uv run --extra dev pytest tests/test_cross_runtime_delegation.py -q` -> **160 passed**。
- Focused prior blockers after test stabilizers：`uv run --extra dev pytest tests/test_api.py::test_api_desktop_toolchain_contract tests/test_evals.py::test_delivery_gap_awd_arena_accepts_endpoint_attack_plan_alias tests/test_evals.py::test_delivery_gap_fake_claude_lane_can_pass -q` -> **3 passed**。
- Full Python regression on PR stack base：`uv run --extra dev pytest` -> **1901 passed**。
- Web regression：`npm test --prefix apps/web` -> **99 passed**; `npm --prefix apps/web run build` -> **passed**（仅既有 Vite chunk-size warning）。

交叉验证：
- Claude Sonnet QA：**PASS** session `e9c25ffd-6ac1-40d2-8c0c-db16e0bcb32d`;指出 changelog 过声明 path containment / writable-tool hard-block,已由 `c22dd8d` 修正。
- Gemini 2.5 Pro：**PASS** session `966bad4e-b4df-4168-8d2f-3454f52c8517`;按 P1-0/P1-1a admission/broker 边界验收通过。
- Gemini 3.1 Pro preview：早先基于错误硬标准（把 path containment / writable-tool hard-block 当作本 slice 必须项）返回 **FAIL** session `aeed3bbc-6050-4644-b143-61268bdba2a9`;该 FAIL 已吸收为后续 P1-2/P1-3 执行期风险记录,不作为本 admission slice 阻断。路线图文档 §3/P1 对本 slice 的硬要求是 equipment 收窄、depth/budget 封顶、pay/scan fail-closed,写入与路径隔离要由 governed child spawn / workspace / review gate 承担。

PR traceability：
- 未来合 main 顺序：先 #238(P0 foundation) -> #263(P1-0/P1-1a admission broker) -> 后续抽 `feat/cross-runtime-p1-delegate-tool` / `feat/cross-runtime-p1-2a-broker-suspension` / `feat/cross-runtime-reviewed-delegate-result`。
- 当前 `dev/roadmap` 继续作为测试 worktree/集成沙盘,不直接 PR 到 `main`。
- 后续依赖顺序：继续 Cross-runtime P1-1b/P1-2/P1-3 clean PR extraction；执行期必须显式记录 child workspace/path containment、writable side-effect 控制与 review gate 的组合边界,避免 admission 层过声明。

### 2.3 v11 §十 交付分支映射快照（2026-06-15, chat 4fce311a [display 会话]，经 Leon 授权协调）

> 宪法 v11 §二:dev/roadmap 是**集成沙盘(测试台)非交付物**;每条 done 轨道交付到 origin/main 须走**各自独立 CI-green 分支**(依赖用 stacked)。下表 = 各 done 轨道按 §十 组织出的**交付分支**实况(我对每条 worktree git 状态的客观核验,非自报)。部分已按 Leon 指令推送/开 PR;其余未推项继续按 §五,§十.5 试点先行。

| 轨道 | 交付分支 / worktree | base | §十 组织状态 | 备注 |
|---|---|---|---|---|
| Display chat 链路 (DA) | `feat/display-protocol-chat` (`~/superclaw-wt/display-chat`) | origin/main 378035b | ✅ 已组织·独立绿(Py105/web113/build)·§十.3 双PASS | PR-1/2/3 Python 核 cherry-pick **全 clean**=零依赖 19 local-main;PR-5/v2 共享文件按 §十.2 解 |
| Display BATCH DL4 (DB) | `feat/display-batch-dl4` (`~/superclaw-wt/display-batch`) | **=Display run cockpit #260(stacked)** | ✅ **已组织·PR #246 已重排**·full pytest 1835/web 122+build/scoped ruff/Gemini+Claude Sonnet PASS·remote CI passed | Final head `5b71d49`;只表达 BATCH diagnostic 增量:后端早发+chat 渲染+run cockpit diagnostic lane 兼容;修复 synthetic id 去重碰撞,不再基于旧 #241 直接叠 |
| Display run cockpit | `feat/display-run-cockpit` (`~/superclaw-wt/display-chat`) | **=DA(#241 stacked)** | ✅ **已组织·PR #260 已开**·full pytest 1827/web 120+build/scoped ruff/Gemini+Claude Sonnet PASS·remote CI passed | Clean extraction of PR-4 run-channel persistence/snapshot/SSE `event.id` + PR-6 cockpit cards/approvals/diagnostic + DL10 inline composed sink + PR-7 docs;不直接从 `dev/roadmap` PR;后续等 #241 与 #260 Leon 浏览器实测后 merge |
| Display api-agent 真工具投影 | `feat/gemini-anthropic-projection` (`~/superclaw-wt/gemini-anthropic-projection`) | **=Display BATCH #246(stacked)** | ✅ **已组织·PR #261 已开**·full pytest 1845/web 122+build/scoped ruff/Gemini+Claude Sonnet PASS·remote CI passed | Final head `5e55964`;只表达 gemini/anthropic-agent 真 tool execution post-hoc projection + chat 三端点 cards;不从自然语言重构 tool traces |
| Display marketplace dock | `feat/display-market-dock` (`~/superclaw-wt/display-market-dock`) | **=Display api-agent #261(stacked)** | ✅ **已组织·PR #262 已开**·full pytest 1846/web 122+build/scoped ruff/Gemini+Claude Sonnet PASS·remote CI passed | Final head `2e42b87`;从本地 main ahead 的 `b04c48a` 抽成 clean slice;空 chat surface ClawHunt task dock + CLI/API pagination/fail-closed contract;不触碰 Display projection internals |
| CW trust core | `feat/cw-trust-core-pr` (`~/superclaw-wt/cw-trust`) | origin/main 378035b | ✅ **已组织·PR #251 已开**·full pytest 1804/web 99+build/scoped ruff/Claude+Gemini PASS·remote CI passed | Clean prerequisite slice: trust.py/TrustState/namespace isolation/version contract + digest v2 hardening；旧 `feat/cw-trust-primitive` 不直接 PR |
| CW trust same-id signer conflicts | `fix/trust-signer-conflicts` (`~/superclaw-wt/cw-trust`) | **=CW trust core (#251 stacked)** | ✅ **已组织·PR #254 已开**·full pytest 1806/web 99+build/focused 28/scoped ruff/Claude+Gemini PASS·remote CI passed | Clean extraction of `957f10e`;cache overwrite rejects different signer for same id/version,runtime projection excludes same-id different-signer conflicts before latest selection |
| Capability Workshop company template P0 | `feat/capability-company-template` (`~/Documents/superClaw-capability`) | **=T11 containment (#255 stacked)** | ✅ **已组织·PR #252 已开**·retarget/rebase 后 remote CI passed | Clean replacement for #239 company slice;validation-only `CompanyTemplate` + schema + CLI;为 B5 提供 `company_template.py`;旧 #239 不直接合 |
| Capability Workshop B5 catalog resolver | `feat/capability-catalog-resolver` (`~/Documents/superClaw-capability`) | **=CompanyTemplate (#252 stacked)** | ✅ **已组织·PR #256 已开**·full pytest 1870/1 skipped·web 99+build·focused 60·scoped ruff·Gemini PASS·remote CI passed | Read-only catalog/trust CLI;修复 refresh mkdir、invalid company template 隐藏、registry `.scplug` 解包边界;stack 顺序 #251→#254→#255→#252→#256 |
| Capability Workshop submit/signature decouple | `feat/plugin-submit-signing-decouple` (`~/Documents/superClaw-capability`) | **=B5 catalog resolver (#256 stacked)** | ✅ **已组织·PR #253 已 retarget**·full pytest 1877/1 skipped·web 99+build·focused 86·scoped ruff·Claude+Gemini PASS·remote CI passed | Clean replacement for #239 submit/signing slice + dev/roadmap blob-signing hardening;submit review-only,isolated `sign-submission`,API submit-time key fail-closed;stack 顺序 #251→#254→#255→#252→#256→#253 |
| Capability Workshop B6 catalog API | `feat/capability-catalog-api` (`~/Documents/superClaw-capability`) | **=submit/signature (#253 stacked)** | ✅ **已组织·PR #257 已开**·full pytest 1880/1 skipped·web 99+build·focused 51·scoped ruff·Claude+Gemini PASS·remote CI passed | API projection for B5 resolver:`/v1/catalog`,`/v1/catalog/trust/{plugin_id}/{version}`,fail-closed refresh,legacy plugin/skill trust backfill,`/api/contracts/catalog`;stack 顺序 #251→#254→#255→#252→#256→#253→#257 |
| Capability Workshop B7 Web catalog | `feat/capability-catalog-web` (`~/Documents/superClaw-capability`) | **=B6 catalog API (#257 stacked)** | ✅ **已组织·PR #258 已开**·full pytest 1880/1 skipped·web 99+build·diff-check·Claude+Gemini PASS·remote CI passed | Live Web catalog marketplace:`/api/contracts/catalog`+`/v1/catalog`,company discover-only tab,catalog conflict/revocation/trust/non-instantiable install blocking,ClawHunt marketplace fallback preserved;stack 顺序 #251→#254→#255→#252→#256→#253→#257→#258 |
| Capability Workshop B3 registry metadata | `feat/capability-registry-metadata` (`~/Documents/superClaw-capability`) | **=B7 Web catalog (#258 stacked)** | ✅ **已组织·PR #259 已开**·full pytest 1888/1 skipped·web 99+build·focused 37·scoped ruff·Claude+Gemini PASS·remote CI passed | TUF-style registry metadata refresh:root/timestamp/snapshot/targets,developer delegation,watermark anti-rollback,refresh cache-preserving fail-closed;stack 顺序 #251→#254→#255→#252→#256→#253→#257→#258→#259 |
| Escalation D1/D2 | `feat/escalation-d1-d2` (`~/superclaw-wt/escalation`) | origin/main 378035b | ✅ 已组织(by 28f0623a)·**PR #250 已开**·full pytest 1811/web 99+build/scoped ruff/Claude+Gemini PASS | D1+D2 consolidated delivery branch；D3 仍走 `feat/escalation-d3` / #245 |
| Cross-runtime 向内 P0 | `feat/cross-runtime-inward-p0` (`~/superclaw-wt/migrate-cross-runtime-p0`) | origin/main 378035b | ✅ **已组织·PR #236 开**(3 原子 commit 41de7fc/07a39e9/f5fb362;apply --3way 单取本轨 hunk 不带 docs;origin/main 基线 1735 passed + ruff clean;CI pending)·**待 Leon merge** | owner 4ede826a |
| Cross-runtime P1-0/P1-1a admission broker | `feat/cross-runtime-p1-admission` (`~/superclaw-wt/cross-runtime-p1-admission`) | **=Cross-runtime P0 foundation (#238 stacked)** | ✅ **已组织·PR #263 已开**·full pytest 1901·web 99+build·focused 160+3·Claude PASS·Gemini PASS·remote CI pending | Clean extraction of P1 admission + profile adapter / `DelegationBroker`;does not include P1-1b delegate tool injection or P1-2/P1-3 execution/review;stack after #238 |
| Prompt Envelope P1 | `feat/prompt-envelope-p1` (`d0bdd5b`) | — | 权威分支(§2.1 裁定);dev/roadmap 的 5f7d61b 放弃 | |
| CI 加固(§〇 required checks) | `ci/harden-required-checks` (`~/superclaw-wt/ci-verify`) | — | ✅ 已进 dev/roadmap(`656b87a`) | 构建/启动/lint 补强,PR #235 |
| gemini/anthropic api-agent 真工具投影(Display 续) | `feat/gemini-anthropic-projection` (`~/superclaw-wt/gemini-anthropic-projection`) | **=Display BATCH #246(stacked)** | ✅ **已组织·PR #261 已开**·full pytest 1845/web 122+build/scoped ruff/Gemini+Claude Sonnet PASS·remote CI passed | Final head `5e55964`;clean commits `217404b`/`99722f2`/`5e55964`;api-agent 真 tool execution post-hoc projection + chat cards;PR traceability 见 §2.2.8d |

## 3. 收口流程(每条轨道,已对齐 AGENTS.md)
```
认领(改台账 in-progress) → 在自己的 worker worktree 开发 → ruff/pytest/npm test 绿
  → Codex + Gemini 双顾问对抗验收(双 PASS) → 并入 dev/roadmap 跑组合态集成验证(AGENTS.md 必经:targeting main 前必过 dev/roadmap 验证) → 改台账 done
  → 用户 Leon 亲自验证 → 业主批准后从 worker 分支发 PR 合入 origin/main → 改台账 merged
```
