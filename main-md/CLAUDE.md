<!-- ENG:BEGIN v=1.0.0 type=python managed by .claude/engineering/sync-engineering.mjs — edit BELOW the END marker, not inside -->
# superclaw — 工程化配置 (python)

本项目继承 `~/.claude/CLAUDE.md` 的全局**总工程化逻辑**（blocking-rules / work-mode / cache-management）；以下区块由 `sync-engineering` 自动管理，仅可在 `ENG:END` 标记**下方**手动编辑。

**类型规范**: .claude/engineering/templates/python.md

**命令**
- build: `(none — define here)`
- test: `(none — define here)`
- dev: `(none — define here)`

**质量门 (python)**
- 依赖锁定：`requirements.txt` 或 `pyproject.toml`/`uv.lock` 钉死版本，禁止裸 `pip install`
- 类型注解齐全，`ruff check` + `mypy` 零报错（lint/类型在 CI 阻断）
- `pytest` 覆盖核心逻辑，关键路径必测；新功能补测试
- 禁止裸 `except:`／`except Exception: pass`——捕获具体异常，绝不静默吞错（fake-success 反模式）
- 用 `logging` 结构化日志，禁止 `print` 调试残留入生产
- 无硬编码凭证/密钥/绝对路径，敏感配置走环境变量或 `.env`（不入库）
- 脚本入口由 `if __name__ == '__main__':` 守卫，副作用不在 import 期触发

**项目专属**: 项目特定约定、架构说明、注意事项请写在下方 `ENG:END` 标记之后。
<!-- ENG:END -->

# CLAUDE.md

本文件为 Claude Code（及任何在本仓库工作的 AI 代理）提供项目级指引。**这些约定优先于默认行为，必须严格遵守。**

## 项目内核：事实源正从旧 Python CLI 迁往 Node 服务器 + APP / Web 表层

SuperClaw 是面向 ClawHunt 的端到端交付代理。**历史架构**曾以 Python CLI 为唯一事实来源 —— 能力先沉淀进 Python core harness、再通过 `cli.py` 暴露，API / Web / Desktop 都是其表层。**该架构已不再成立**：能力的事实源正迁往 vendored **Node 服务器（`server/`）+ `apps/web` / `apps/desktop` 表层**；旧 Python CLI 里大量业务能力（`run` / `delivery` / `fusion` / 旧 `chat` / 旧 TUI 等）已**过时、与现在的 APP / Web 脱轨**，处于 Python→Node 退役过渡中（业主 2026-06 拍板，详见下方「旧 Python 渠道彻底清除」铁律）。

- **现役事实源**：vendored Node 服务器（`server/`）+ `apps/web`（React/Vite 工作台）+ `apps/desktop`（Tauri）+ `packages/superclaw/` 中**仍在用的内核治理 / 兜底**部分。
- **legacy（逐步退役）**：旧 Python CLI（`packages/superclaw/src/superclaw/cli.py` / `tui.py` / `fusion.py` / 旧 orchestrator 表层等）—— 只在尚未迁移完成处保留作兜底，不再是基准、不再要求 APP 与之对齐。
- **契约仍应单一源**：跨表层共享的能力 / 控件 / 默认值规格集中维护（历史在 `ui_contracts.py`，迁移中以现役表层契约为准），前端**不得**硬编码与内核不一致的列表 / 默认值。

## 铁律：旧 Python 渠道——开发时按需评估、决定移除则彻底清除

> **一句话总结：本项目的事实源正从旧 Python CLI 渠道迁往 Node 服务器 + APP / Web；旧 Python 渠道里大量东西已过时、被替代、或将随 Python→Node 过渡退役。今后在新增 / 修改 / 优化任何功能、或处理到相关文件时，只要判定某段代码属于旧 Python 渠道且（① 已废弃 / 过时 / 不再生效 / 不再使用；② 已被其他功能替换；③ 处于 Python→Node 过渡的退役路径），就必须主动评估是否应当移除；一旦决定移除，必须删得干净、彻底、不留任何遗留问题。**

这是业主 2026-06 明确拍板、用于**替代**旧「CLI 是唯一事实源 / CLI≡APP 零偏差」铁律的新治理规则：旧 CLI 这套大多已过时、与现在的 APP / Web 脱轨，业主无暇集中整理 legacy，改为**在日常开发中渐进、彻底地清除**。这是当前最大的痛点，代理要主动帮业主消化。

### 1. 触发时机（被动 + 主动结合）
- 开发新功能、修改 / 优化既有功能、或在任务中**碰到 / 读到**某个文件时，只要它疑似旧 Python 渠道（`run` / `delivery` / `fusion` / 旧 `chat` / 旧 CLI 命令 / 旧 TUI / 旧 orchestrator 表层等），就**顺手评估**它是否已死。
- 不要求专门去全仓扫雷；但**凡是这次改动触及或路过的旧 Python 代码，不得视而不见**。

### 2. 判别"是否该移除"（给依据，不臆断）
- 满足以下任一、且**无现役调用者 / 无替代缺口**，即为可移除候选：① 已废弃 / 过时 / 不再生效 / 不再被任何现役表层或入口调用；② 已被新功能（Node 服务器 / `CompanyBoard` / 新 chat 等）替换；③ 明确处于 Python→Node 退役路径。
- 判别必须**本地核验**：grep 调用者 / import 链 / 路由挂载 / 测试引用，确认"真死"再动。**拿不准 = 不删，先标记并问业主**（宁可漏删、不可误删活功能；承接全局「绝不盲目覆盖」）。

### 3. 决定移除 → 必须"干净彻底"（业主最痛的点，务必做到）
"彻底" = 不留任何一类遗留：
- **代码**：被删符号的所有引用 / import / 路由挂载 / 派发分支一并清除，**零悬空引用、零死代码**（编译 + 运行时都不留）。
- **测试**：被删功能的测试同删或改写，不留指向已删代码的孤儿测试；移除后**相关 / 全量测试仍绿**。
- **契约 / 类型 / i18n / 文案**：相关契约项、类型成员、翻译键、用户可见文案、placeholder / 引导 / 帮助一并清除，不留失真文案。
- **样式 / 资源**：对应 CSS / 静态资源若零引用一并删。
- **文档**：`README` / `docs` / 本 `CLAUDE.md` / 命令矩阵里对应描述同步更新，不留陈旧指引。
- **跨表层**：删 CLI 侧时核 API / Web / Desktop 有无并行残留；删表层时核内核有无该一并退役。

### 4. 边界与留痕
- **大块退役先盘点真实范围 + 向业主确认边界**再动手——一条 import / 替换链常常牵出整片子系统（"删几个文件"可能实为"端掉整片旧子系统"），先 grep 清死活、报清体量、得业主确认，**避免把局部清理做成误删活功能或失控大改**。
- 彻底清除按既有铁律走「改完 → 相关 / 全量测试绿 → 顾问验收 → 原子提交」；一个 commit 一件清除，正文写明"删了什么 + 为何判定为死 + 如何确认无残留"。

## 治理硬门（仍然有效，不随旧 CLI 退役而松动）

> 以下两条是**产品治理 / 表现层硬约束**，与"事实源在 CLI 还是 Node"无关，照常严格遵守。

1. **Pay-Switch 等治理逻辑由内核统一裁决。** 支付永远不在默认运行路径中；扫描 / 探测类网络意图一律 fail-closed，需人审 + 已批准权限，表层不得自行放行（业主校准：硬门只「支付 + 对外扫描」两类）。
2. **凡选 agent runtime 处，model 与思考强度都必须是「按 runtime 联动、可真实选择」的下拉，不得退化成裸文本框。** 只要某个表层让用户选择 agent 的 runtime/backend（chat composer、新建公司向导、Agent 编辑/招聘对话等），就必须：
   - **model 走 runtime 联动的响应式下拉**：选定 runtime 后，及时拉取该 runtime 的真实模型清单（实时 `GET /api/agents/{backend}/models`，relay 后端则 `GET /api/relay/packages` 的套餐），离线时回退到契约 `suggested_models`；当前值若不在清单中要保留为首项，绝不静默丢弃；切换 runtime 必须重置（model id 不跨 runtime 通用）。
   - **思考强度（reasoning effort）走同样的 runtime 联动选择器**：从契约 `supports_effort_selection` / `effort_levels` / `effort_input_mode`（`select`=约束下拉，`text`=建议+自由输入）/ `default_effort` 渲染；**仅当 `supports_effort_selection` 为真才显示**（不支持的 runtime 必须不出该控件——内核对显式 effort fail-closed，表层不得诱导用户设一个会被拒的值）；`default_effort` 仅作展示，**绝不**回填成显式请求；切换 runtime 必须重置（effort 档位不跨 runtime 通用）。
   - **契约单一源（承接「项目内核」节的"契约仍应单一源"）**：这些清单/档位一律来自内核契约（历史在 `ui_contracts.py` 的 `AGENT_CONTROL_SPECS` + `build_agent_inventory`，经 `/api/backends`==`/api/agents`；迁移中以现役表层契约为准），表层**禁止**硬编码任何 runtime 的模型名或 effort 档位。
   - **持久化对齐**：agent 定义里 `model` 与 `effort` 是平行的持久字段（`AgentProfile` / `EDITABLE_PROFILE_FIELDS` / `_HIRE_SPEC_FIELDS` / company-as-code 导入导出 / orchestrator 投影成 `WorkerLimits.model_override` 与 `effort_override`），新增一个就要同步另一个，任一层断裂都算违规。

## 常用命令

```bash
# 安装（可编辑）
python -m pip install -e .
npm install --prefix apps/web

# 自检与冒烟
superclaw doctor
superclaw run --title "smoke" --description "exercise local backend" --backend local --repo . --budget-seconds 30
superclaw verify <run_id>

# Python 测试 / lint
python -m pytest
ruff check .

# Web 客户端
npm run dev   --prefix apps/web
npm run build --prefix apps/web
npm test      --prefix apps/web
```

更完整的 CLI 命令矩阵见 `README.md`。

## 约定

- 默认 worker 模型为 **Claude Opus 4.8**（`claude-opus-4-8`）；`claude` 后端为默认，`anthropic-agent` 为推荐的无依赖云端引擎后端。
- 后端经 `SUPERCLAW_*` 环境变量配置，不要硬编码可执行路径或模型名。
- 新增能力时，更新 CLI、`ui_contracts.py` 以及对应的表层，并补充测试（`tests/`、`apps/web/tests/`）。
- 改动需保持与 `README.md` 描述一致；涉及命令面或表层契约的改动要同步文档。

## 铁律：禁止开启 GitHub 分支保护（main 漂移只用纪律治理，不用平台强制）

> **一句话总结：永远不要为本仓库（`ClawHunt-Store/SuperClaw`）的 `main` 开启 GitHub 分支保护（branch protection / required status checks / require branches up to date / required reviews 等）。漂移问题一律靠开发纪律解决，不引入平台级强制门。**

这是业主明确拍板的决定，AI 代理必须严格遵守：

1. **禁止开启、禁止建议开启分支保护。** 不得在 GitHub 仓库设置里启用任何分支保护规则；也不得在回答里把"开启分支保护"当作推荐方案反复提出。如确有顾虑，只陈述事实与风险，由业主裁决，不替其决策。
2. **背景与已知取舍（写明以免日后重复纠结）：** GitHub 的 PR mergeable 检查是 **pre-merge**（基于 PR 分支跑），而 `main` 的 CI 是 **post-merge**（push 后才跑）。因此会出现"PR CI 绿、合入后 `main` CI 红"的瞬时集成漂移——多分支并行、各自基于不同 base，后合分支未吸收先合分支对同一区域的改动所致。业主已知此取舍，**仍选择不启用** up-to-date 强制，以保留并行合并的灵活度。
3. **漂移用纪律兜底，而非平台门。** 防漂移的唯一手段是全局规则里"**发 PR 前先同步主仓库最新代码（尤其前端）**"那条（见 `~/.claude/CLAUDE.md`）——合 PR 前先 `git fetch` 并把 `origin/main` 吸收进工作分支、解决冲突再合。代理要主动执行这条，而不是依赖 GitHub 拦截。
4. **合并后必须验证 `main` CI。** 因为没有平台门兜底，合并 PR 后要主动检查合入 `main` 触发的完整 CI（`ruff` + 全套 `pytest` + 全套 `npm test` + `build`）是否通过；若红，定位是哪条分支的集成漂移并修复，**不得放任红的 `main` 留存**。
   - **⚠️ 暂停期（2026-06-21 起）：远端 CI 已 `gh workflow disable`（见"远端 CI 已暂停"铁律），此条"验证 `main` CI"无远端载体，改为"合并后在本地对合入 `main` 后的树跑一遍完整 `ci.yml` 自检"；远端 CI 恢复后自动回到验证远端 `main` CI。**

## 铁律：开发完成后必须经 Codex + Gemini 批判性验收，通过后方可原子化提交

> **一句话总结：任何一项开发"做完"之后，在写 commit 之前，必须先调用 Codex（GPT‑5.x）和 Gemini 对它做"批判性验收"（adversarial review，目标是挑错而非夸奖）；两位都给出明确"通过"后，才允许写原子化 commit。未经验收，禁止 commit。**

这是硬性流程门，新增/修改任何功能都要走，**不得跳过、不得自我放行**。

### 1. 触发时机
- 一项功能/缺口/重构在本地"自认为做完"时触发，标准是：相关测试已过、`ruff check` 干净、自己已端到端走查并确认行为正确。
- "做完"不等于"可提交"。本地自检只是**进入验收的前置条件**，不是提交许可。

### 2. 如何做批判性验收
- 用本仓库的两个顾问技能：`codex-cli-advisor`（`--model gpt-5.5`）与 `gemini-cli-advisor`，**两者都必须跑**（缺一不可，要的是两个独立视角）。
- 给它们一份**自包含的验收简报**（写到 `/tmp/*.md` 再喂入），至少包含：① 改了什么（文件/函数/契约）；② 设计意图与所属规划（指向 `docs/agent-team-kernel-execution-plan.md` 等）；③ 测试与验证证据；④ 已知取舍。
- 提示词必须是**对抗式的**：明确要求"找 bug、找回归、找与铁律（CLI 唯一事实源 / fail-closed 治理 / 表层零新增语义）的冲突、找层间断点与完整性缺口"，并要求"不骑墙、直接说不通过的理由"。**禁止**把验收变成"请确认我做得对"式的捧场。
- 两路顾问可后台并行跑（`run_in_background`），各自 60–120s；产出落 `.codex-cli-advisor/` 与 `.gemini-cli-advisor/transcripts/` 留痕。

### 3. "通过"的判定（fail‑closed）
- **通过** = Codex 与 Gemini **都**明确表示无阻断性问题（no blocking findings）。
- 任一方提出**阻断性问题**（真实 bug、回归、违反铁律、致命缺口）→ 视为**未通过**：必须先修，修完**重新跑两路验收**，直到都通过。
- 顾问的"建议性/优化性"意见（非阻断）可记录为后续 backlog，不阻塞本次提交，但要在提交说明或文档里留痕。
- 顾问意见有分歧时，由我（主代理）综合裁决并写明理由；但**只要有一方指出真实阻断问题，就不算通过**。
- 顾问只是评审者，不是仓库事实的唯一来源：涉及代码事实时以本地核验为准，但顾问指出的问题必须被正面回应（修复或给出有据的反驳）。

### 4. 通过之后：原子化 commit 规则
- **一个 commit 一件事**：每个 commit 只承载一个逻辑变更（一个缺口/一个修复/一个重构），可独立 review、可独立回滚；禁止"大杂烩"提交。
- 提交信息用约定式风格（`feat(...)/fix(...)/refactor(...)/docs(...)/test(...)`），正文说明**做了什么 + 为什么 + 验收结论**（注明 Codex/Gemini 已通过）。
- 提交信息**不要**附加 `Co-Authored-By: Claude ...` 等 AI 署名行（全局设置 `includeCoAuthoredBy: false` 已禁用）。
- 测试与被测代码尽量同一原子提交；纯文档/规划更新单独成 commit。
- **绝不** `git push --force` / `--force-with-lease` 覆盖他人提交；发起 PR 前先按全局规则同步主仓库最新代码（尤其前端），详见用户全局 `~/.claude/CLAUDE.md`。

### 5. 留痕
- 每次验收的结论（通过/阻断项/已修复项）记入相关规划文档或 commit 正文；重大方向性结论同步进项目记忆（`.../memory/`）。
- 顾问 transcript 自动落 `.codex-cli-advisor/`、`.gemini-cli-advisor/`（已被 `.gitignore` 忽略），可随时复查。

## 铁律：远端 CI 已暂停（`gh workflow disable`）—— 本地全量自检是推 PR 前的唯一门

> **一句话总结：业主已暂停本仓的 GitHub Actions CI（`ci.yml`，`disabled_manually`）。在它恢复之前，"裁判面"从"干净 GitHub CI"下移到"本地全量自检"：任何 PR 推到 super 远端之前，必须在本地把 `ci.yml` 的全部步骤跑通（绿了才推）。远端不会再自动跑 CI，PR 上也不会再有 CI 状态。**

这是业主 2026-06-21 的明确决策，AI 代理与团队成员都要遵守：

### 1. 为什么暂停（写明以免日后重复纠结）
- `SuperClaw` 的 `ci.yml` 是**纯验证流水线**（`ruff` + 全量 `pytest` + `superclaw doctor` 冒烟 + API `/health` 冒烟 + `npm test` + `npm run build`），**不部署任何东西**（无 deploy/release/publish 步骤，`npm run build` 产物即弃）。
- 它是**私有仓**，每次真跑都吃组织 `ClawHunt-Store` 那个**多仓共享的 Free 2000 分钟/月**池子；本月已被高频 CI 跑爆，spending limit 卡在 `$0` → 新 job 在启动前就被计费门拦下（"3 秒 fail"、无日志、`billable=0`）。见 [[ci-actions-minute-budget]]。
- 既然它既不部署、又持续拦 PR + 吃共享额度，业主决定**先停掉**，把验证放回本地。

### 2. 怎么停的 / 怎么恢复（可逆，零代码改动）
- 暂停：`gh workflow disable ci.yml` → 工作流状态变 `disabled_manually`（**不删 `ci.yml`、不动 git 历史**）。
- 恢复（需先解锁计费）：先由组织 admin 在 **Org → Settings → Billing & plans** 上调 Actions spending limit（或修复失败付款），再 `gh workflow enable ci.yml`。AI 做不了计费动作，只能提示。
- **AI 不得擅自 enable/disable 或改 `ci.yml` 的启停**，除非业主明确指示。

### 3. 新流程：推 PR 前在本地跑通完整 `ci.yml`（绿了才推）
在隔离 worktree（每个并行会话各自独占一个、绝不在共享主检出里开发，见 [[parallel-worktree-isolation-hazard]]）里，用主仓 `.venv` + `PYTHONPATH` 覆盖跑齐 `ci.yml` 的每一步，全绿才 `git push` + 发 PR：

```bash
SRC=<worktree>/packages/superclaw/src; VENV=/Users/leongong/Documents/superClaw/.venv/bin
ruff check packages apps                                            # lint（全树，非只改动文件）
TMPDIR=/tmp PYTHONPATH=$SRC:<worktree> $VENV/python -m pytest -q    # 全量测试（TMPDIR=/tmp 逼近 Linux CI）
PYTHONPATH=$SRC $VENV/superclaw doctor                              # CLI 启动冒烟
PYTHONPATH=$SRC:<worktree> $VENV/python -m uvicorn apps.api.main:app --host 127.0.0.1 --port 8765 &
curl -fsS http://127.0.0.1:8765/health                             # 期望 {"ok":true,"service":"superclaw"}
npm ci --prefix apps/web && npm test --prefix apps/web             # web 测试
npm run build --prefix apps/web                                    # web 生产构建
```

- **跑全量，不只跑改动文件**：CI 跑的是整套 `pytest -q`；只跑子集会漏掉跨模块回归（首个按此流程的 PR #294 即靠本地全量 2929 passed 才确认不是"子集绿"）。
- **环境差仍在**：本地是 macOS / Python 3.11，CI 是 Linux / 3.12。`TMPDIR=/tmp` 只能"逼近"不能等同 Linux 的 `/tmp=1777`（见下一条铁律的 trust/权限陷阱）。这是暂停远端裁判的已知代价——本地全绿仍非绝对保证，但已是当前唯一可得的门。
- 仍走 [[no-github-branch-protection]] 的"合并前 `git fetch` 吸收 `origin/main`"纪律，只是把"push 让干净 CI 复跑转绿"换成"本地全量跑通"。

### 4. 与既有两条 CI 铁律的关系（避免成为死规则）
- 下面"CI 工程纪律"铁律里凡是"**push 让干净 GitHub CI 复跑转绿后才合 / 以干净 GitHub CI 为最终裁决**"，在远端 CI 暂停期一律**以"本地全量 `ci.yml` 跑通"替代**；其"测试环境无关性""合并前吸收 main"等内容仍然有效。
- [[no-github-branch-protection]] 里"**合并后必须验证 main CI**"在暂停期**无远端载体**，改为"合并后在本地对合入 `main` 后的树跑一遍全量自检"。
- 一旦远端 CI 恢复（计费解锁 + `gh workflow enable`），这两条铁律的"干净 GitHub CI 裁判"自动重新生效，本铁律降级为历史背景。

## 铁律：CI 工程纪律 —— 测试环境无关性 + 合并前吸收 main + 干净环境裁决

> **一句话总结：测试绝不依赖宿主机临时目录的权限位或操作系统差异（"本地绿 ≠ CI 绿"）；任何 PR 合并前必须把最新 `origin/main` 吸收进分支、在隔离 worktree 跑受影响测试，并 push 让干净 GitHub CI 复跑转绿后才合；CI 红的 PR 一律不合。这是 [[no-github-branch-protection]] 无平台门兜底下，防"PR 绿、合入 main 红"集成漂移的唯一手段。**
>
> **⚠️ 暂停期补丁（2026-06-21，见上一条"远端 CI 已暂停"铁律）：远端 GitHub CI 已 `gh workflow disable`，本铁律里"push 让干净 GitHub CI 复跑转绿""以干净 GitHub CI 为最终裁决"在恢复前一律以"本地全量 `ci.yml` 跑通"替代；其余内容（环境无关性 / 合并前吸收 main / 隔离 worktree）不变。**

这条铁律由实测教训沉淀（PR #280/#282 合并受阻），新增/修改任何功能、合并任何 PR 都要核对，**不得跳过**。

### 1. 测试环境无关性（"本地绿 ≠ CI 红"陷阱）
- **根因**：安全 / trust 检查会读目录权限位（属主、group/other-writable、sticky bit）。临时目录在不同 OS 差异巨大：macOS 本地 `/tmp` → `/private/tmp`，而 Linux CI 的 `/tmp` 是 `1777`（world-writable + sticky）。同一段 trust 检查可能本地通过、CI 拒绝（或反之）。PR #282 即因 trust 检查在 CI 的 `/tmp` 下报 `group/other-writable` 拒绝，29 个测试集体红。
- **产品侧**：trust / 权限检查必须对"带 sticky bit 的 world-writable 目录"正确豁免（`/tmp` = 1777，只有属主能 rename / 删除子项，**不是** swap 攻击面），否则会在合法的 Linux 环境误拒。判据是 `st_mode & 0o022 and not (st_mode & stat.S_ISVTX)`，不是裸 `st_mode & 0o022`。
- **测试侧**：涉及目录权限 / trust 的测试，用**私有 `0700` 临时目录**或显式 `chmod` 构造权限，绝不裸依赖共享 `/tmp` 的默认权限；用 `tmp_path` 时要意识到它的父 `/tmp` 在 CI 上是 world-writable，必要时在 fixture 里把测试根 `chmod(0o700)` 或改用受控目录。
- **推论**：**本地全量绿不代表 CI 绿，反之亦然**——本地有真实 `~/.superclaw` / `~/SuperClaw` 状态污染 + flaky；**最终裁决以干净 GitHub CI 为准**。

### 2. 合并前必须吸收最新 main（全局规则的本地强化 + 实测）
- **实测**：PR #280 落后 main 30、PR #282 落后 26 → 前端 / trust 测试在陈旧 base 上跑，CI 红纯属漂移（#280 web `/api/runtime/status` 断言、#282 trust 拒绝）。**落后越多，漂移越大、冲突越险。**
- **操作**：合任何 PR 前 `git fetch` + 把 `origin/main` merge 进分支、解冲突、在**隔离 worktree**（每个会话独占，见 [[parallel-worktree-isolation-hazard]]）跑受影响测试，**push 让干净 CI 复跑转绿后再合**。
- **多 PR 共享文件**：先合一个，把它吸收进下一个分支再验证后才合下一个（本次 #283 ↔ #281 共享 `apps/api/main.py` / `cli.py` / `team_kernel.py` 等 5 文件即如此串行处理：合 #283 → 吸收进 #281 → #281 CI 复跑绿 → 合 #281 → 验 main CI 绿）。

### 3. flaky vs 真漂移的判定（放行前必做）
- 子进程 / 签名类测试（如 `test_plugin_submission.py`）有非确定性 flaky：每次失败的用例不同、单独重跑全过、且 merge 未触碰其被测代码 → 判为 flaky / 环境污染，**非合并漂移**，不阻塞。
- **判定三步**：① 失败用例单独重跑是否过；② 在干净 base（`git stash` 或干净 `origin/main`）对拍是否同样失败；③ 看 diff 是否触碰被测代码路径。三者一致指向"非本次引入"才可放行，并以**干净 GitHub CI 为最终裁决**。
- 切勿因本地 flaky 噪音放弃合并一个真实就绪的 PR，也切勿用本地绿掩盖真实漂移；两面都靠"干净 CI 复跑"定夺。

### 4. 合并后强制验证（承接 [[no-github-branch-protection]]）
- 因无分支保护兜底，合并 PR 后**必须主动检查合入 `main` 触发的完整 CI**（`ruff` + 全套 `pytest` + 全套 `npm test` + `build`）是否通过；红则立即定位是哪条分支的集成漂移并修复，**不得放任红的 `main` 留存**。

## 铁律：测试提速与编写规范 —— 单元测试零真子进程、集成测试串行隔离、本地门走两阶段 runner

> **一句话总结：全量 `pytest` 慢/flaky 的根因不是硬件，是「到处真 fork 子进程 + 真等墙钟死线」的测试设计——CPU 加不快「等待」，并行只会让真子进程互相饿死。治理三条：① 单元级断言（argv/flag/逻辑）一律进程内执行，禁止为拿结果真起子进程；② 真子进程/签名/sidecar 类是集成测试，超时死线必须可注入/放宽，且只能串行跑；③ 本地全量门统一走 `scripts/run-ci-tests.sh`（两阶段：插件签名家族串行 + 其余并行），别无脑 `pytest -q` 也别无脑 `-n auto`。**

这条由 2026-06-23 全程实测沉淀（worker_backends 去 fork 后 428s→13s；干净机器无脑 `-n auto` 4min 但 24 插件 flaky；两阶段 runner 4.5min 全绿 3892 passed）。写功能/写测试时都要核对：

### 1. 实测结论：慢的是「等待」不是「算力」
- 测试时间分两种：**compute**（跑逻辑/断言，CPU 能加速）与 **wait**（`sleep`、等子进程、等超时死线，CPU **完全不能**加速）。慢测试的时间几乎全在 wait。
- **真 fork 子进程**是 OS 系统调用固定开销，18 核压不下去；更糟：并行（xdist）下多个 worker 同时 fork，trivial 子进程被 CPU 饿到撑爆死线 → 假超时（exit 124 / PLUGIN_TIMEOUT）。机器越忙、并行越凶，越容易假失败。
- 证据：`test_worker_backends` 改造前 200+ 真 fork → 串行 428s、并行成批 flaky；改成**进程内回显**后 13s、load 18 也绿。同一机器同一批测试，差的全是「无谓的 fork+等」。

### 2. 新测试编写规范（测试金字塔，违者拖慢全套 + 引入 flaky）
- **单元级断言禁止真起子进程。** 校验「拼出的命令行参数/flag」「聚合/路由逻辑」「数据结构」这类，**在进程内伪造执行边界**（拦 `subprocess.Popen` 用进程内替身回显 argv，见 `tests/test_worker_backends.py` 的 `_ExecShim`/`_FakeCliPopen` 范式），断言不变、瞬时、对负载/并行免疫。
- **超时/liveness 测试禁止硬等真墙钟。** 把被测超时阈值与配套 sleep 一起缩到 1–2s，或注入可控 clock / monkeypatch 时间源；**禁止裸 `time.sleep(30)` 等真死线**。
- **真子进程/签名/sidecar 测试 = 集成测试，要少而精。** 它们是被测的**安全边界**（治理隔离/签名验证），**不能伪造掉**；但必须：(a) 死线**可注入/可放宽**——插件 sidecar/smoke 的**默认**超时经 `superclaw.plugin_timeouts.floor_default_timeout_seconds` + 环境变量 `SUPERCLAW_PLUGIN_TIMEOUT_SECONDS` 放宽（只放宽默认、显式 manifest/policy 超时保留，故「测超时」用例仍正常触发），测试环境在 `tests/conftest.py` 设为 120s 防负载假超时；(b) 归入**串行家族**（见下），绝不指望它在并行下绿。
- **改哪测哪。** 日常内循环只 `pytest tests/test_<改动模块>.py`，**不要每次跑全量**；全量只在「推 PR 前的本地门」跑一次。

### 2.5 开发期测试纪律：worktree / feature 分支里**绝不跑全量**

把测试分成**两个相位**，泾渭分明：

- **开发期（在 worktree / feature 分支写功能时）—— 只跑相关，绝不跑全量。**
  1. **绝不 `pytest -q` 全量、绝不 `scripts/run-ci-tests.sh`。** 全量慢、对负载敏感、且多 worktree/会话并发会互相饿死（见 [[parallel-worktree-isolation-hazard]]）；开发期跑全量是纯浪费 + 自找 flaky。
  2. **为自己的功能写充分的单元测试。** 新增/改动的每个函数、每条分支、每个 fail-closed 守卫、每个错误码都要有用例；单测一律按 §2 进程内、瞬时、对并行免疫。
  3. **为触碰到的相关代码补集成测试。** 跨模块契约、表层对齐(CLI/API/Web 零偏差)、真子进程/签名/sidecar 边界——这些写成集成测试（按 §2：死线可注入、归串行家族）。
  4. **只跑「相关 + 可能相关」的测试**：`pytest tests/test_<本模块>.py tests/test_<下游/被影响模块>.py …`。判断「可能相关」= 你改的函数/契约被谁调用、谁的断言读你改的字段/默认值（如改了某默认值 → 跑所有透传该默认的入口测试，参见本轮 smoke_timeout 五入口）。拿不准就把那一簇相关文件一起跑，仍远比全量快。
- **推 PR 前（唯一一次）—— 跑全量门。** 这时、且只有这时，走 §3 的 `scripts/run-ci-tests.sh` 一次，确认没有「只跑子集会漏掉的跨模块回归」。全量是**交付门**，不是开发内循环。

> 一句话：**开发期只测自己 + 相关，全量留给推 PR 那一道门。** 既快又不会把别的会话/自己逼成 flaky。

### 3. 本地全量门：统一走 `scripts/run-ci-tests.sh`（两阶段）
- 覆盖与 `pytest -q` **完全一致**（同一批测试，只拆两段跑）：
  - **Phase 1（串行）**：插件/签名/sidecar 家族（`test_plugin_*` / `test_capability_*` / `test_skill_*` + `test_relay_key` / `test_evals` / `test_local_agent_runtime` / `test_claude_stream` / `test_external_mcp_plugin`）——机器最凉时先跑，避开并行下的签名 nondeterminism + sidecar 饿死。
  - **Phase 2（并行）**：其余全部 `-n auto --dist worksteal`，吃满核。
- **为什么不无脑 `-n auto`**：实测**即便干净机器**，全量 `-n auto` 也有 ~24 个插件家族 flaky（并行本身让签名/sidecar 打架）。**为什么不无脑串行**：12min 太慢且极端满载下插件家族连串行也 flaky。两阶段是唯一**又快又绿**的形态（实测 4.5min / 空闲 ~2.5min，3892 全绿）。
- **前提仍是别在机器被榨干时跑**：load 16+ 时连串行插件阶段也会 flaky（真子进程抢不到 CPU）。跑门前关掉 CPU 大户（浏览器/视频/常驻 node），或把权威门交给远端干净 CI。
- 往串行家族新增文件：在 `scripts/run-ci-tests.sh` 的 `SERIAL_GLOBS` 里加；宁可多放（多几秒串行）也别让一个真子进程文件漏进并行阶段。
- 与上面「远端 CI 已暂停」「CI 工程纪律」两铁律一致：远端 CI 恢复后，干净 Linux runner 上插件家族天然绿且快，是兜底权威门；本地两阶段 runner 是暂停期的本地门。
- 依赖：`pytest-xdist` 已钉版本进 `pyproject.toml` 的 `dev` extra（符合「禁裸 pip install」质量门）。
- **绝不多个 worktree / 会话同时跑全量门**：本机共用 18 核 + 同一 `.venv`，并发全量会互相饿死并把超时/真子进程测试逼成 flaky（见 [[parallel-worktree-isolation-hazard]]）；按隔离 worktree 纪律串行处理。

## 铁律：并行开发必须 worktree 隔离 —— 每个会话独占一棵工作树，绝不在共享主检出里开发

> **一句话总结：本机会同时跑多个 Claude / Codex 会话并行开发本仓。它们必须各自在独立的 `git worktree` 里工作；任何会话都绝不在共享的主检出（当前 `~/Documents/superClaw`）里直接改文件 / 切分支 / 提交。主检出只当一棵干净的参考树（尽量贴着 `origin/main`）。违反此条 → 分支 / HEAD / 未提交改动在会话之间互相漂移、彼此覆盖。**

### 0. 先纠正一桩历史误判：根因不是 iCloud
- 早期把「会话进行中分支被切走、`git status` 变化、HEAD 漂移、未提交改动凭空出现」归咎于 **iCloud 跨机同步**。**这是误判**：实测当前主仓 `~/Documents/superClaw` **不在 iCloud 同步区**（`~/Documents` 无 iCloud xattr），`reflog` 里的分支切换与 commit 全是**本机操作**，`lsof` 也证实是**多个本机会话进程**把 cwd 指在同一个主检出上。
- 真正的根因是 **多个本机并行会话共用同一个工作检出**——与仓库放在哪、是否 iCloud **无关**。所以历史文档/记忆里凡是「iCloud 同步导致漂移 / 主仓必须迁出 iCloud」的因果，都按本铁律理解为「**并行会话必须 worktree 隔离**」；iCloud 仅在「明文备份会被同步卷离机」这类**安全威胁模型**语境下才是真实考量（如 `docs/observability-tier-c-rfc.md`），不是漂移的成因。

### 1. 硬规则（每个会话开工第一件事）
1. **任何写代码的会话都在自己的隔离 worktree 里开**：**若会话已被分配预置 worktree（如 Codex 的 `~/.codex/worktrees/<id>` 或 chat 提供的工作树）就直接用它**，不必另建；否则手动 `git worktree add <path> -b feat/<slug> origin/main`（**必须带 `-b` 新建分支**，否则是 detached HEAD、违反"一会话一分支"）。worktree 落点路径、`creator.md`、`codex/` vs `feat/` 命名、stacked base 等**机制以 `AGENTS.md`（Worker Worktree Rules）+ `docs/git-workflow-constitution.md` §三/§四 为准**，本铁律不另立路径以免分歧。一个会话一棵树 + 一个分支，**不与别的会话共用**。
2. **主检出（`~/Documents/superClaw`）保持"常驻 `main`、无业务 WIP、源码树干净"**（对齐 `AGENTS.md`："stays on `main` and is only the local mirror of `origin/main`"）：允许的操作仅限——`git fetch` / 看全貌（`worktree list` / `branch -vv` / `gh pr list`，只读）/ 把 `origin/main` `merge --ff-only` 进本地 main / `gh pr merge`（远端推进 refs，需业主已批准，见 `AGENTS.md` Approval Gates）/ 编译交付物（产物只落 gitignored 的 `dist` / `target`，不改源码、不脏工作树）。**禁止**：在它上面 checkout 功能分支、改业务源文件、commit 功能代码。理想态它一直贴着 `origin/main`。
3. **绝不盲目覆盖**（承接全局铁律）：动任何文件前先 `git status` + 看 mtime / 行数，确认不是别的会话正在写的 WIP；发现共享检出里有别人的未提交改动，**先停手**——备份到 `/tmp` 或让该会话先提交，绝不 `git checkout` / `git reset` / `git stash` 掉别人没存的活。
4. **提交只提自己的文件**：`git commit -- <显式路径>`，绝不夹带共享检出里别的会话的改动。
5. **跨机同步只走 `git push` / `pull`（GitHub）**：不靠任何文件级同步去搬 `.git`（会损坏 pack、错乱 refs）。每台机器各自独立 `clone`。

### 2. worktree 里跑测试 / import 的两个坑
- **PYTHONPATH 覆盖 editable**：worktree 没有自己的 `.venv`。用主仓 `.venv/bin/python` 时必须 `PYTHONPATH=<worktree>/packages/superclaw/src:<worktree>` 覆盖，否则 `import superclaw` 会解析回主检出的 editable 安装，**测的是主检出不是你的 worktree**。
- **共享 `.venv` + 18 核 + 同一 `~/.superclaw` 状态**：并发全量测试会互相饿死、把真子进程 / 超时测试逼成 flaky（见上一条「测试提速」铁律）。**开发期只跑相关测试**；全量门串行、一次只一个会话跑。

### 3. 本地护栏（纪律的"牙齿"，非平台门）
- 纪律靠自觉容易破（实测：composer WIP + 一次 chat-UI 改动都在主检出里做，被并行会话切分支冲进 stash）。为给纪律加"牙齿"，仓库提供**纯本地** Git 钩子（`.githooks/pre-commit` + `.githooks/post-checkout`），一键安装：`sh scripts/install-local-guards.sh`（每个 clone 装一次，钩子不随 clone 自动分发）。
- 作用：**仅在主检出**（primary working tree）生效——主检出在功能分支上提交直接**拦截**、切到功能分支时**警告**；**linked worktree 完全不受限**（钩子用 `git-dir == git-common-dir` 自门控，可移植、不写死路径，旧 git 也不会静默失效）。拦截覆盖 `git commit` 与 clean 自动提交的 `git merge`（装为 `pre-commit` + `pre-merge-commit` 双入口）。放行：`main`、detached HEAD（含 rebase 进行中——不挡历史维护）。本地 main 镜像分支用 `git config --add guard.allowBranch 'work/main-latest-*'` 放行；`git commit --no-verify` 可越过。已知次要残留：cherry-pick 的 clean 自动提交不触发提交钩子（罕见且属刻意，用 worktree 即可）——这是 poka-yoke 防呆，非安全门。
- 安全性：安装器**非破坏性**——遇到非本护栏的同名钩子（husky/lint 等）**拒装不覆盖**；只写本仓 `.git/hooks`，**拒绝**写入仓外的全局 `core.hooksPath`；钩子还靠仓内 marker（`.githooks/.superclaw-guard`）自证身份，**绝不**泄漏到其它仓。
- 这与 [[no-github-branch-protection]] **不冲突**：那条禁的是 **GitHub 平台级**分支保护；本护栏是**本地、可逆、零远端依赖**，只把"主检出别开发"从口头约定变成想破都难。

### 4. 与既有铁律的关系
- 这条是 [[no-github-branch-protection]]（无平台门、纪律治理漂移）与「CI 工程纪律」「测试提速」三条的**共同前提**：它们反复要求的「隔离 worktree」就是本条。
- 完整的并行 git 工作流细则见 `AGENTS.md`（Standalone Chat Worktree Protocol / Worker Worktree Rules / Merge And PR Flow）、`docs/git-workflow-constitution.md` 与记忆 [[git-parallel-worktree-workflow]]。本铁律是其在项目宪法里的「必守摘要 + iCloud 误判纠正」；worktree 落点、`creator.md`、promotion flow（worker 分支 → `dev/roadmap` 本地集成 → 从 worker 分支发 PR）等**机制细节以 `AGENTS.md` 为准**，此处不重述以免分歧。
