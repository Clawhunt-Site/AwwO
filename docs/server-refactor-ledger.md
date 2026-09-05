# `dev/server-refactor` 集成主干台账

本文件按宪法 §11.6 维护：`dev/server-refactor` 是 Node 后端再平台化的长命集成主干，
PR 稀疏、数月跨度。每个 merge 回主干的子功能在此登记，保证末次（§11.7 由 Leon 统一推
PR / 合 main）能按 bucket 分段成可 review 的 PR，而不是一条不可拆的集成史。

字段：merge SHA / worker SHA / 分支 / owner / scope / 触碰路径 / 验证证据 / 未来 PR
bucket / 依赖关系。仅登记 `feat/<slug>` 子功能合回；主干自身的 vendor 导入 / 治理文档
直接提交（§11.1）不在此列。

---

## 子功能合回记录

### 1. 能力工坊统一卡片 UI 重构

- **merge SHA**：`1381b81f`
- **worker SHA**：`8633dd42`（分支 `feat/workshop-card-unify`）
- **owner**：Leon (LeonSGP43)
- **scope**：前端（apps/web）— 能力工坊四个 tab（Overview / Plugins / Skills /
  Companies）统一成 Codex 风格两列精简卡片；X 风格认证角标（fail-closed，仅 kernel
  trust 点亮，skill 绝不从 skill-store label 误亮官方）；独立详情子页（read-only 跟随
  能力，配置 / 卸载移入 `···` 菜单）；「在 chat 中使用」纯表层导航（@skill token /
  聚焦 composer，不新增内核语义）。
- **触碰路径**：
  - `apps/web/src/App.tsx`
  - `apps/web/src/styles.css`
  - `apps/web/tests/app-shell.test.tsx`
  - `apps/web/tests/static-ui.test.mjs`
- **验证证据**：merge 零冲突；merge 结果 web 41 文件 / 546 测试 + build 全绿；
  Codex(gpt-5.5) 单顾问验收 merge 结果通过（§11.3.④）。worker 阶段另经 Codex+agy
  双顾问对抗式验收——首轮抓出 Overview→详情路由提权、角标 label 误亮、并发 spinner
  丢失、remote skills 未统一等阻断，逐一修复后重审两路均通过。
- **未来 PR bucket**：`frontend / capability-workshop`（独立前端 PR，可在 vendor 导入
  PR 之前或之后单独落地）。
- **依赖关系**：无。纯 `apps/web`，不 import `server/` vendor，不依赖任何其它子功能。

### 2. 能力工坊列表卡片卸载 kebab

- **merge SHA**：`b9d907b3`
- **worker SHA**：`ce7e0b7d`（分支 `feat/workshop-card-unify`）
- **owner**：Leon (LeonSGP43)
- **scope**：前端（apps/web）— 业主决策：所有已安装 plugin 卡片（含只读 Overview）
  右侧加 `···` kebab，点开「卸载」（列表层快捷卸载，配置仍留详情页）。Overview「只读」
  精确化为禁止 INSTALL 新能力 / 实例化 company，但允许卸载已装 plugin。skill 卡片无
  kebab（内核无 native skill 卸载能力，铁律 表层零新增语义）。
- **触碰路径**：
  - `apps/web/src/App.tsx`
  - `apps/web/src/styles.css`
  - `apps/web/tests/app-shell.test.tsx`
- **验证证据**：merge 零冲突；merge 结果 web 41 文件 / 546 测试 + build 全绿；Codex
  (gpt-5.5) 单顾问验收 merge 结果通过。本增量经 Codex **三轮**对抗式验收——首轮抓 stale-
  menu 进详情误卸载、二轮抓 setPluginStoreTab 切 tab 未清菜单，逐一修复（同步清空 +
  `!workshopDetail` 守卫 + useEffect 兜底导航清空 + 两条回归测试）后三轮通过。
- **未来 PR bucket**：`frontend / capability-workshop`（与子功能 1 同一 bucket，可合并
  成同一前端 PR）。
- **依赖关系**：依赖子功能 1（统一卡片）——kebab 建在统一卡片渲染之上。

### 3. Node gateway 接电骨架（P0）+ permission 框架（P1 首刀）

- **merge SHA**：`727155c3`
- **worker SHA**：`487190c1`（P0 gateway）/ `d4583955`（P1 permissions）/ `52670174`·`20bc8669`（设计文档），分支 `feat/super-node-bff-p0`
- **owner**：Leon (LeonSGP43)
- **scope**：Node 后端再平台化 —— 新建独立 Node 包 `apps/gateway`（super Node 前门，
  在 vendored `server/` 之外，**零改上游**）。**P0**：绑外部前门 + 把 vendored 当
  loopback-only 黑盒依赖**代理** + `/health` 聚合（镜像 Python `{ok,service:"superclaw"}`
  + upstream 状态）；config 全 fail-closed（loopback host / URL override host / health
  path-only / IPv6 bracket / 非 http scheme 拒）；gateway 自管 upstream spawn 监管故意
  收窄到 P0.5。**P1 首刀**：忠实 port `permissions.py` 两档 preset（ask/allow 都→
  bypassPermissions、ask 绝不 prompt、拒第三档）+ readonly posture 门默认覆盖
  company/marketplace 写工具词汇（跨语言防漂移测试对拍 Python 源）。
- **触碰路径**：
  - `apps/gateway/**`（新包：config / upstream / app / index / governance/{permissions,
    command-vocabulary} + 测试 + tsconfig / vitest / package(-lock).json / README）
  - `docs/super-node-server-migration-basis.md`（新：设计基准 v2 + P1 验收契约）
  - `.github/workflows/ci.yml`（加 gateway typecheck/test/build 四步）
- **验证证据**：merge 零冲突（纯增量，与主干并发的 apps/web workshop 改动无重叠）；merge
  结果在主干 gateway 43 测试 + typecheck 全绿。逐刀 Codex(gpt-5.5) 单顾问对抗式验收
  （§11.3.④，本线降单顾问）——**P0 6 轮**（拦下 loopback 绕过 / launch 死配置 / 端口漂移
  / localhost 身份分叉 / TOCTOU / IPv6 等，含一次范围决策把自动 launch 收窄 P0.5）；
  **permissions 4 轮**（拦下 _MUTATING_TOOLS 漏 company/marketplace、PresetRealization
  缺校验、serialize 不等价、可变 Set 泄漏、防漂移测试假绿）。均最终通过。
- **未来 PR bucket**：`backend / node-gateway`（Node 再平台化骨架；独立于前端 workshop
  bucket，可单独成 PR；依赖 vendored `server/` 已在主干）。
- **依赖关系**：无子功能依赖；运行期把 vendored `server/` 当 loopback 依赖代理（不 import
  其源码）。后续 P1 刀（company_scope / escalation / 默认拒绝 mutation proxy）将在此之上增量合回。
- **增量合回**：
  - `70a209eb`（worker `d08c8ae2`）**company-scope 权威核心（P1b-1）**：忠实 port
    `company_scope.py` 纯核心（CompanyScope / permits 顺序 fail-closed / check /
    requireResolvedCompany）；`allowedCompanyIds` 私有持有、仅暴露副本（运行期不可放大
    scope）；grant/run id 按 Python `str.strip()` 空白码点降级（非 JS trim，`U+0085`/
    `U+FEFF` 行为对齐 Python）。主干 58 测试 + typecheck 绿。**业主指示先合入**，Codex
    复审两处修复并行进行（fix-forward）；resolver/derive/per-command 留 P1b-2/P2。
  - `73663876`（worker `1e403b3d`）**company-scope 实例冻结（P1b-1 fix-forward）**：
    Codex 复审确认 Set 泄漏 + strip 已闭合，另指 `isAdmin` 等 public authority 字段仅靠
    TS `readonly`、运行期可 `(scope as any).isAdmin=true` 放大 → 构造末尾加
    `Object.freeze(this)`（frozen-dataclass 等价），冻结全部 public authority 字段。主干
    59 测试绿。
  - `7f3650c2`（worker `f2a9ebac`）**company-scope prototype 冻结（P1b-1 fix-forward）**：
    Codex 再指 instance 冻结不护 prototype——`Object.getPrototypeOf(s).permits=()=>true`
    仍可放大 → 加 `Object.freeze(CompanyScope.prototype)` + `Object.freeze(CompanyScope)`，
    封死 prototype 上的 authority 成员（permits/getter）。JS-specific 纯加固、零行为改变。
    主干 60 测试绿。
  - `679b4068`（worker `1d5a82b1`）**company-scope final + check 真实性（P1b-1 fix-forward）**：
    Codex 再指 `check` 虚分发可被 subclass override `permits` 绕过 → constructor 加
    `new.target` final 守卫（禁 subclass 实例化）+ `check` 加 `instanceof CompanyScope`
    守卫（假对象/forged scope fail-closed）。封死 subclass/假对象/`Object.create` 全部
    authority 放大面。JS-specific 加固、零行为改变（Python frozen dataclass 同样可
    subclass override，`_check` 同样按契约信任其 scope 参数）。主干 63 测试绿。
  - `5a600b4c`（worker `5a600b4c`，经 workshop-paperclip-api 吸收带入主干）**company-scope
    private-brand 真实性（P1b-1 fix-forward, 终）**：Codex 终指 `instanceof` 不足——
    `Object.create(CompanyScope.prototype)` 过 instanceof，挂 `isAdmin=true` 则 permits admin
    短路绕过 → 采纳 Codex 建议改 **private-brand 检查** `static isAuthentic(v){…&& #allowed
    in v}`，`check` 用它替 instanceof；forged 对象无私有 brand → fail-closed。主干 64 测试绿。
    **至此 P1b-1 在 value-type 层「authority 构造后不可放大」全部闭合**（私有 Set 副本 / 实例
    +proto+constructor freeze / final / brand 真实性）；唯一构造点保证（只有 gateway 从认证
    principal 构造 scope 传入 check）属 P1b-2/P2 wiring。⚠️ 本轮 trunk 多会话并发，最终主干
    company-scope.ts 与 feat HEAD 逐字一致、64 测试绿。
  - `a20f2478`（worker `d81446ab`）+ `9e541335`（worker `46f4b081`）**company-scope P1b-1
    收尾闭环（fix-forward, Codex 第8轮 PASS）**：上条「全部闭合」过早——Codex 续指两面:
    ① `permits` 公开方法对 forged-this（`Object.create(proto)+isAdmin=true`）仍返 true
    （admin 短路在读 `#allowed` 前）→ permits 首行 `const allowed=this.#allowed` brand-touch，
    forged-this 即抛；② truthy 非布尔 `isAdmin`（`"false"` 等）经 `?? false` 保留 → `=== true`
    严格化；③ `allowedCompanyIds: Iterable<string>` 接受裸 string `new Set("x")` 拆字符 →
    类型收窄 `readonly string[]|ReadonlySet<string>` + 运行期跳过 string/过滤非 string·空项。
    **Codex 第8轮穷举裁决：value-type 层无任何剩余可关 authority 放大面，判通过。** 主干
    70 测试绿。**company-scope P1b-1 经 8 轮（私有 Set 副本/三层 freeze/final/双 brand 真实性/
    严格 admin/strip 码点/裸 string 过滤）value-type 层彻底闭环**；resolver/derive/same-origin/
    per-command 留 P1b-2/P2（含「唯一构造点保证」wiring）。
  - `65acb2c8`（feat `feat/chat-compat-layer`，13 commit）**chat 兼容层合回（§11.6）**：
    把 SuperClaw 整条 WebUI chat 链路落到 vendored Node 后端，复用原生
    issue/comment/heartbeat/adapter，**不新增表**。映射 B2（Company=个人/团队 ·
    Project=workspace · Issue(origin_kind=chat)=session · issue_comments=turns ·
    agent_task_sessions taskKey=issue.id 续接）。端点：`GET /api/chat/sessions[/:id]`、
    `POST /chat/stream`（存 user comment→assignChatAgent→heartbeat.wakeup→live-events
    桥→DisplayProtocol SSE；先订阅再 wakeup+buffer+轮询兜底+断开清理；run_id=null 保
    legacy）、`/chat/sessions/:id/{archive,move}`、`/api/backends`·`/agents[/:b/models|/probe]`
    （listServerAdapters 投影，effort=false）、`/api/workspaces`·`/api/runs`、`/v1/skills`
    （skill/plugin 注入由 heartbeat executeRun 自动完成，本端点仅 composer 建议）、team/
    onboarding/control-token stub。**DisplayProtocol 桥**：claude_local stream-json→tool/
    reasoning/usage 信封 + stream_event live token deltas；plain-text runtime verbatim 透传；
    只投影 stdout。全程 local_trusted gate，无 shadow 原生路由。**先吸收主干前沿 ed829627
    进 feat（零冲突，纯增量，主干 ed829627 为 apps/gateway 新文件无重叠）→ 主干 63 chat
    测试 + typecheck 绿 → --no-ff 合回（merge-base 确认 feat 已含主干前沿，合回内容=已测
    内容）**。逐刀 Codex(gpt-5.5) 单顾问（§11.3.④）：stream 3 轮 / management 2 轮 /
    read-route 2 轮 / write-primitives 2 轮 / inventory 2 轮 / skill 4 轮 / DisplayProtocol
    4 轮（含 stream_event live-token 补漏）等，均最终通过。**未来 PR bucket**：
    `backend / chat-compat`（依赖 vendored `server/`；独立于 gateway/workshop bucket）。
    残留增强 backlog：per-turn @skill 显式 scoping、preview/pin、非 claude runtime 的
    per-adapter DisplayProtocol 解析、client-close-during-setup 回归测试。

### 4. Company 页面原生挂载 board UI（company-surface-board）

- **merge SHA**：`f91bbc80`
- **worker SHA**：`7e847d38`（板挂载）/ `a6342400`（徽章 fan-out 去 churn-flood + 测试）/
  `901bffce`（vite proxy/warmup），分支 `feat/company-webui-paperclip-parity`；
  fix-forward `7dd1ba8a`
- **owner**：Leon (LeonSGP43)
- **scope**：前端（apps/web）+ vendored `server/ui` overlay —— company 页面从 iframe 嵌入
  改为把 vendored 的 board UI（`server/ui`）**原生编译进** apps/web 构建（`CompanyBoard.tsx`：
  MemoryRouter 隔离 URL + initPluginBridge + 镜像 main.tsx provider 栈，丢弃 service-worker
  注册）。board 经 vite `define __PAPERCLIP_API_BASE__` 把所有 /api·WS·SSE 调用打到同源
  `/paperclip-api` 代理（Node 控制面）；Tailwind v4 样式经 @tailwindcss/vite 编进
  （`index.css` 加 `@source "."`，否则 0 工具类）。侧栏未读徽章 + composer @-company 经
  `paperclipBridge` 读 Node company API。徽章 fan-out 去 churn-flood：interval effect
  ref-stabilize（deps [apiReady] + render-time ref）+ in-flight dedupe，把初始渲染 readJson
  identity churn 触发的 ~200 请求 fan-out 收敛为 ready 时一次 + 每 30s 一次。vite proxyConfig
  提取共享给 `vite preview`（生产包预览也走 /paperclip-api）+ board 模块图 warmup。
- **触碰路径**：
  - apps/web：`App.tsx` / `CompanyBoard.tsx`(新) / `paperclipBridge.ts`(新) / `styles.css` /
    `vite.config.mjs` / `vitest.config.mjs` / `package(-lock).json` /
    `tests/{app-shell,company-board,paperclip-bridge}`
  - apps/desktop：`src-tauri/tauri.conf.json`
  - **⚠️ vendored `server/ui`（13 文件 overlay）**：`api/client.ts`(导出 apiBase) /
    `api/{auth,health,file-resources}.ts` / `adapters/*` /
    `pages/{BoardChat,Auth,InviteLanding,AgentDetail}.tsx` / `context/LiveUpdatesProvider.tsx` /
    `components/transcript/useLiveRunTranscripts.ts` / `plugins/bridge.ts` / `index.css`(@source)
    —— 把硬编码 `/api` 路由经 apiBase 重定向到 `/paperclip-api`。
- **验证证据**：merge-tree 零冲突，App.tsx/styles.css/app-shell.test.tsx 三处与 workshop
  漂移 auto-merge 成功。worker 分支全套 web 563 测试绿。merge 结果 app-shell.test.tsx 150
  测试绿（含徽章 fan-out 回归测试）。⚠️ board-import 测试（company-board + 6 个 transitive
  拉 CompanyBoard 的 suite）在主干 worktree 因未装 board 依赖（apps/web 的
  react-router-dom/@tanstack、server pnpm workspace 的 @paperclipai/*）无法 collection——
  非代码缺陷（worker worktree 装齐后 563 全绿），属主干引入 board 后必需的 setup（见依赖）。
  Codex(gpt-5.5) 单顾问（§11.3.④）：徽章 fan-out 精修两轮——首轮抓徽章口径回归（换 Python
  roll-up ≠ Node sidebar inbox），二轮抓 StrictMode 双 fan-out，恢复双源 + ref-stabilize +
  in-flight dedupe 后通过。
- **fix-forward `7dd1ba8a`**：徽章回归测试原 render `<StrictMode><App/>`，与 workshop 漂移
  新增的 App-render 测试叠加后，StrictMode 双挂载把 App 弥散的 unmount-racing
  `/api/runtime/status` refetch 泄漏进同文件桌面用例的脆弱 last-call 断言 → 改 render 普通
  `<App/>`（仍测 churn 回归；StrictMode-double 由 dedupe 确定性论证保障）。
- **未来 PR bucket**：`frontend / company-surface-board`（独立前端 PR）+ **vendor-overlay 子门**。
- **依赖关系 / ⚠️ PR 期债务**：
  - **vendor tree-equality（§11.7③）**：改了 13 个 vendored `server/ui` 文件，破坏 server/ui 与
    pin 的 tree-equality。PR 期须作 vendor-overlay 处理（独立记录 SuperClaw 定制层 + board
    依赖安装：apps/web npm + server pnpm workspace），不得混入 vendor-only PR。
  - **§11.8 去命名**：本功能 grandfathered 大量 `paperclip` 命名（§11.8 入宪前提交）；新提交
    注释已改中性 "Node control plane"，整体去名为单独 follow-up。
  - **性能取舍**：board 静态打进主包（8.95MB），整页刷新解析慢——业主选择"写进项目里"；
    lazy-load/prefetch 拆分为未决优化。

### 5. skill 统一设计基准（super 三套碎片 → 上游 catalog）

- **merge SHA**：`636ec080`
- **worker SHA**：`6c1c8c1e`（分支 `feat/skill-unification-design`）
- **owner**：Leon (LeonSGP43)
- **scope**：设计文档（docs/）— 把 super 当前**三套互不相通**的 skill 来源（① `GET /v1/skills`
  native skill · ② 给 agent 分配走 skill-origin plugins 经 `skill_allowlist` · ③ 未接入的上游
  `@paperclipai/skills-catalog`）统一到上游 catalog 模型的设计基准。定方向 + 5 刀分解（0 core/CLI
  契约 → 1 runtime 桥 → 2-4 读/写/卸载 UI → 5 收敛），严守**CLI 唯一事实源**（任何"分配 skill"
  先进 `packages/superclaw` core+CLI，禁 AgentConfigDialog/gateway 直连上游写端点）+ **runtime
  先于 UI**（catalog skill 真进 agent runtime 前 UI 不得以"可分配"暴露，否则 fake 能力）。仅设计、
  不含实现。
- **触碰路径**：
  - `docs/skill-model-unification.md`（新）
- **验证证据**：`merge --no-ff` 零冲突（纯新文件，无构建/测试影响）。Codex(gpt-5.5) 单顾问**三轮**
  对抗式复审通过（§11.3.④）——首版抓 8 处事实/设计错误（desiredSkills 契约名 / 违反 CLI 唯一事实源 /
  `__catalog__`-vs-`__runtime__` 落盘 / native-vs-plugin skill 混淆 / 外部路径 / adapter id / gateway
  现状 / governance url）→ v2 修 6 处 → v3 修完 installFromCatalog 落盘两阶段语义（install→`__catalog__`
  source、agent sync/list 时才 materialize 到 `__runtime__`）+ `server-utils` 行号（1922/1998）。
  **合回前据当前 trunk `bade80b7` 复核全部代码锚点**：cli skills.ts(167/517/550/582/590)、
  server-utils(1922/1998)、company-skills 各函数(installFromCatalog 3850 / materialize 3698+3999 /
  deleteSkill 4412 / assert 3800)、super-side(App.tsx · AgentConfigDialog 158 · plugins.py 616 ·
  orchestrator 446 · skill_store 94 · skill_sync 622/923) 均吻合；唯 `assertImportedSkillSourceAllowed`
  随 trunk 前移 183→189 已同步（纯行号锚点更新，语义/设计零变化）。
- **未来 PR bucket**：`docs / design-basis`（与 `super-node-server-migration-basis.md` 同 bucket，
  可随后续 skill 统一实现刀的 PR 或独立落地）。
- **依赖关系**：无代码依赖（纯 `docs/`，不 import 任何代码）。是后续"skill 统一"实现刀（从刀 0
  core/CLI 契约起）的设计基准；实现刀将以本文为方向落地，绑 chat-compat / adapter 迁移主线。

### 6. Team/Company 看板启动数据预热（board-embed-prewarm）

- **merge SHA**：`52a34414`（fast-forward 落地）
- **worker SHA**：`05c0f53b`（分支 `feat/team-board-prewarm`）
- **owner**：Leon (LeonSGP43)
- **scope**：前端（apps/web）— 嵌入式 Paperclip 看板（CompanyBoard，建在 #4 原生挂载之上）此前
  仅在首次进 Team 表层时才发起冷数据级联（companies → 自动选公司 → Dashboard 6 个 company-scoped
  query + live WS），点 Team 要等一段 spinner。业主选 **Approach A「数据预热」**（非常挂载
  keep-alive）：启动 `apiReady` 后把 board 数据预热进**持久 module-level `companyBoardQueryClient`**
  （与 board 共享、跨挂载存活），board UI 仍按需挂载、命中缓存 → 无 spinner；离开即卸载 → **零快捷键
  泄漏**（keep-alive 会让 board 的全局 `document` keydown 监听——CommandPalette 的 Cmd+K、
  useKeyboardShortcuts 的 c/[/]/Cmd+B——在停留 chat 时也活着触发隐藏 board 的不可见动作；CSS 屏不掉
  document 级监听、又不改 vendored 源码，故否决 keep-alive）。`prewarmCompanyBoard()` 复用 board
  **已导出**的 `resolveBootstrapCompanySelection` 选公司（零逻辑重复）；单飞 + per-client 幂等
  （WeakMap）；语义 settled（已热 / 无可热）→true 不重试 vs 瞬时失败（控制面未起）→false 重试；
  `dashboard.summary`（board 骨架 `isLoading` 卡的 query）用 `fetchQuery`（失败=可重试 miss，非
  假"已热"），其余 5 个次要 section 用 best-effort `prefetchQuery`。表层零新增内核语义。
- **触碰路径**：
  - `apps/web/src/companyBoardPrewarm.ts`（新）
  - `apps/web/src/CompanyBoard.tsx`
  - `apps/web/src/App.tsx`
  - `apps/web/tests/company-board-prewarm.test.ts`（新）
  - `apps/web/package.json`
- **验证证据**：`merge --ff-only` 零冲突落地（吸收 trunk 的 board i18n 3 提交时 App.tsx /
  CompanyBoard.tsx 三方自动合并干净——i18n 的 `locale` prop / `syncBoardLocale` 与本支共享
  `companyBoardQueryClient` 共存零重叠；唯 `apps/web/package.json` 测试清单冲突，解为并集保留两个新
  测试）。worker 阶段 web 9（prewarm + board）+ app-shell/startup/team 241、合并后 163 + build 绿。
  Codex(gpt-5.5) 对抗式**两轮**（§11.3.④）——首轮抓 2 阻断（summary 用 prefetchQuery 吞错 → 假
  "预热完成" 被 WeakMap 永久记住、点 Team 仍冷加载；空 companies 被 staleTime 当 fresh 缓存 → 2.5s
  重试名不副实），修后复审 PASS。**真栈端到端实测**：起 Node 控制面（embedded-pg + 独立
  PAPERCLIP_HOME）+ web dev，建一家公司 → 启动日志 `companies=1 → selected → cascade warmed
  summary ok=true (322ms) → settled`（点 Team 之前已热）→ 点 Team `[CompanyBoard mount]
  companies cache=HIT, dashboard warmed=1` → 截图 board 直接渲染该公司 Dashboard 无 spinner。临时
  埋点验证后已剥离（工作树回到 05c0f53b 干净态后再吸收合并）。
- **未来 PR bucket**：`frontend / board-embed`（与 #4 company-surface-board、board en/zh i18n 同
  bucket，可合成同一前端 PR）。
- **依赖关系**：依赖 #4（board 原生挂载 CompanyBoard）。已吸收 trunk 的 board en/zh i18n
  （`c7245fcd`，3 提交）——与其 `locale` prop / `syncBoardLocale` 共存零冲突。无内核依赖（纯
  `apps/web` 表层，不改 `packages/superclaw`）。

### 7. 公司目录作 Team home + 顶栏层级返回 + 新建弹窗换壳

- **merge SHA**：`eec2dda4`
- **worker SHA**：`671771b6`（feat 三连：`671771b6` feat 目录Team home+顶栏层级 / `f4b5a966` refactor 弹窗换壳+去品牌 / `7cb6d055` docs 台账；分支 `feat/company-directory-board`）
- **owner**：Leon (LeonSGP43)
- **scope**：前端（apps/web）+ **vendored `server/ui` overlay** —— 把 Team 表层做成"公司目录优先"：
  ① 公司目录改 super 风格卡片网格 + 空态，提升为**全屏顶层路由**（`/companies` 移入 global
  roots，`CompanyDirectoryHome` 全宽渲染，无 per-company 侧栏/面包屑壳），数据 100% 走 Node 控制面
  （`companiesApi` / `useCompany` / `company.logoUrl`，logo 复用 board 原生 `CompanyPatternIcon`），
  点卡片 `setSelectedCompanyId` + `navigate('/${issuePrefix}/dashboard')` 进对应公司；保留 board
  原有改名(inline)/删除(确认)于悬停 `···` 菜单（卡片 `onKeyDown` 加 `e.target===e.currentTarget`
  守卫，防内部控件 Enter/Space 误触）。② **返回层级放在 super 顶栏**（主菜单 → 公司列表 → 当前
  公司），经新增的 `companyBoardNav.ts` 桥 + board 内 `BoardNavReporter` 上报/驱动，**不在 board
  面包屑里改**（早前的 home crumb 已撤销还原）。③ 新建公司弹窗 `OnboardingWizard` **只换外壳**：
  全屏 takeover → super 风格暗遮罩 + 居中有界面板，内部分栏/多步/提交逻辑不动；`FrontDoor`
  去品牌 "Welcome to Paperclip"→"Welcome to SuperClaw"。
- **触碰路径**：
  - apps/web（表层，可自由改）：`CompanyBoard.tsx`（落地 `/companies` + `BoardNavReporter`）/
    `companyBoardNav.ts`(新，导航桥) / `App.tsx`（顶栏层级 UI；默认 `workspaceSurface` 维持
    `'chat'`，见下"取舍") / `styles.css`(顶栏 trail)
  - **⚠️ vendored `server/ui`（7 文件 overlay —— 破坏与上游 pin 的 tree-equality）**：
    `pages/Companies.tsx`（目录页重写）/ `App.tsx`（`CompanyDirectoryHome` + `/companies` 全屏路由）/
    `lib/company-routes.ts`（`companies`+`onboarding` 移入 GLOBAL_ROUTE_ROOTS）/
    `lib/company-routes.test.ts`（全局路由分类回归用例）/ `components/Sidebar.tsx`（"公司列表"入口）/
    `components/OnboardingWizard.tsx`（弹窗外壳）/ `components/FrontDoor.tsx`（去品牌）。
    PR 期须作 **vendor-overlay 子门**处理（独立记录 SuperClaw 定制层），不得混入 vendor-only PR；
    下次 re-vendor 须三方合并这 7 处文件。
- **验证证据**：`server/ui` typecheck `tsc -b` exit 0；`apps/web` `npm run build` ✓ built（7401 modules）；
  `company-routes.test.ts` 7 passed（含全局路由分类回归）。真栈 e2e（Node 控制面 :3101 local_trusted +
  3 家公司 + apps/web dev :5181，playwright 实测截图）：打开点 Team → 全屏目录；点卡片 → 公司 Dashboard +
  顶栏 "← 返回主菜单  公司列表 › 交付中心"；点"公司列表" → 回目录，层级消失；New company → 居中弹窗
  （step0 "Welcome to SuperClaw" + 选项卡，step1 左表单/右 ASCII 分栏完好）。Codex(gpt-5.5) 对抗式验收
  **三轮**：首轮抓 3 阻断（默认 Team 破坏打包桌面 / 卡片键盘回归 / vendor-overlay 未登记），二轮抓
  `extractCompanyPrefixFromPath` 对 `/onboarding` 漏判——逐一修复（默认回 `'chat'` + `e.target` 守卫 +
  `onboarding` 入 global roots + 本台账登记 + 回归测试）后，第三轮判**通过**。**Gemini 侧豁免（留痕）**：
  原 `gemini` CLI 已被 Google 永久弃用（`IneligibleTierError`，要求迁 Antigravity）；改用 `agy`
  （Antigravity / Gemini 3.1 Pro）后在本变更大 diff 上反复超时（隔离探测小 prompt 返回 OK，属输入吞吐
  限制、非不可用）。业主明确指示本次**豁免 agy**，以 Codex 三轮通过为门。
- **未来 PR bucket**：`frontend / company-surface-board`（与 #4 同 bucket）+ **vendor-overlay 子门**。
- **依赖关系 / 已知取舍**：
  - 依赖 #4（board 原生挂载）、#6（board 预热）。无内核依赖（不改 `packages/superclaw`）。
  - **默认落地页取舍**：业主曾要"打开 App 直接落公司列表"，但 board 走 `/paperclip-api`，该前门仅
    `vite dev/preview` 存在，**打包桌面无 Node 前门**（Tauri CORS，见 `paperclipBridge.ts` 注释，
    属 server-refactor follow-up，由 coexist 前门线 `feat/coexist-prod-front-door` 负责）。故本次
    **默认 `workspaceSurface` 维持 `'chat'`**（点 Team 才进目录），"打开即落列表"推迟到桌面 Node 前门
    落地后再开（一行翻转）。
  - **残留**：新建公司"建到底"完整 e2e（建 company→agent→task 依赖后端 runtime）未跑；弹窗小视口
    裁剪未专项验；导航桥 `homeNav` 为模块单例（单 board 实例可用，多实例需 owner token）。

### 8. Embed 看板 chrome 精简 + 实例设置去冗余控件（chrome-trim）

- **merge SHA**：`3c300b08`
- **worker SHA**：`31a95927`（feat CSS：账户/公司菜单 + 设置 nav 隐藏）/ `6ef85595`（feat 删 Sign out/键盘/censor 三 section）/ `fd19f0f3`（docs：仅显示层掩码设计，未实现）；分支 `feat/embed-chrome-trim`
- **owner**：Leon (LeonSGP43)
- **scope**：前端（apps/web 表层）+ **vendored `server/ui` overlay** —— 把 embed 看板里冗余/越权的 chrome 收掉：
  ① **作用域 CSS**（`.company-board-root`，super-only，与既有 ThemeToggle 抑制同模式，standalone board 不受影响）隐藏 board 自带左下账户菜单 + 左上公司切换器（按 board 专属触发 aria-label，en+zh；`:has()` 连带去掉账户菜单带边框 footer 外壳防留空条），并隐藏公司设置 nav 的 **成员/邀请/个人资料/实验功能** 四项（看板 NavLink 经 `applyCompanyPrefix` 给路径加公司前缀 → 真实 href=`/<PREFIX>/company/settings/...`，故按**路由后缀** `[href$=...]` 匹配以**前缀无关**）。② 从实例设置「通用」页删除 **Sign out + 键盘快捷键 + 在日志中屏蔽用户名** 三个 section 及失效 import（`LogOut`/`authApi`/`Button`/`ToggleSwitch` + signOut mutation + censor/keyboard 派生变量）；保留 Deployment-and-auth / Backup retention / AI feedback sharing。
- **触碰路径**：
  - apps/web（表层，可自由改）：`src/styles.css`（追加作用域抑制规则）。
  - **⚠️ vendored `server/ui` overlay（破坏与上游 pin 的 tree-equality）**：`src/pages/InstanceGeneralSettings.tsx`（删三 section + import）。PR 期须作 **vendor-overlay 子门**处理，不得混入 vendor-only PR；下次 re-vendor 须三方合并此文件。
  - 文档（新）：`docs/username-display-masking-design.md`（被推迟的"仅显示层掩码"设计 + 失败尝试根因）。
- **验证证据**：CSS 抑制以**真实浏览器引擎**对带前缀 href + en/zh aria-label 实测——目标控件计算 `display:none`、其余设置项与 super 自身外壳（`.company-board-root` 外）保留、作用域隔离成立；`InstanceGeneralSettings` 经 vite 编译 OK 且删后无悬挂引用（`queryClient` 仍用于 invalidate，非残留）。Codex(gpt-5.5) 对抗式验收**两轮**：首轮抓 2 阻断 ——（1）CSS 用精确 `[href=]` 未命中带前缀 href（"成员仍显示"）；（2）`censorUsernameInLogs` 默认翻 true 是真实**写库回归**（`addComment` 写路径按该 flag 改写评论/chat 正文、有损，chat-compat 明确警告破坏 chat）——逐一处理（改 `href$=` 后缀匹配 + **整组撤销 censor 默认翻转**）后第二轮判**通过**。Gemini 侧按 §11 本分支**不强制**（Codex 单顾问门）。
- **未来 PR bucket**：`frontend / company-surface-board`（与 #4/#7 同 bucket）+ **vendor-overlay 子门**（`InstanceGeneralSettings.tsx`）。
- **依赖关系 / 已知取舍**：
  - 依赖 #4（board 原生挂载）。无内核依赖（不改 `packages/superclaw`）。
  - **censor 默认开启被否决**：业主要"默认屏蔽用户名"，但现成 `censorUsernameInLogs` 语义=「读显示掩码 **且** 写入改写」，二者同 flag 耦合 → 默认开会在 `addComment` 写时永久掉码评论/chat 正文（有损、破坏 chat）。已**撤销默认翻转**，设置保持上游默认 off，并删除该 toggle（防误开危险开关）。**代价**：看板仍显示用户名/路径。安全替代（拆分 `maskUsernameOnDisplay` 仅显示掩码，不碰写路径）已写入 `docs/username-display-masking-design.md`，**待业主拍板范围后实现**。
  - mobile `CompanySettingsNav`（`<select>` tab 栏）不在 `a[href$=]` 覆盖内；桌面 Tauri `minWidth=1180` > board `isMobile` 阈值 768，按桌面嵌入面不触发，非阻断（Codex 留痕）。


### 9. clawwork relay key 按 tier 绑分组（付费 plus/max 接 opus，#452）

- **merge SHA**：`2f1199e0`
- **worker SHA**：`dae1bfbf`（内核 relay_key tier 链路：exchange 接 tier + device 分档 + 缓存档位闸 + ceiling + clamp + is_tier_locked）/ `35b70422`（backends 默认跟随 ceiling + 越级 clamp；CLI ensure-key --tier；API packages locked；clawhunt_auth 切号清 ceiling）/ `1f07974d`（Web 四表层越级灰显）/ `26acf46c`+`9d9500dc`+`fdf28365`+`cc997557`（Codex 复审修复：login-fresh ceiling、动态/裸模型 core 绑定、并发窗口 tier-aware resolve）；分支 `feat/relay-tier-binding`
- **owner**：Leon (LeonSGP43)
- **scope**：内核 + 全表层。clawwork 是唯一靠 relay 拿模型的 backend；本改动让付费 plus/max 用户的 relay key 真正绑到 `superclaw-{tier}` 分组（命中 opus 而非 GLM5.2）：① exchange 携带规范化 tier、device id 加 tier 后缀（每档在中转站命名空间 `superclaw-clawwork:{device_id}` 落独立 key，切档换池、切号不串档），`_owned_stored_key` / `resolve_relay_api_key` 加档位闸；② 读 `/api/auth/me` 的 tier 缓存为解锁上限（`cached_or_refresh_tier_ceiling`：已登录但未缓存时刷新一次，之后纯缓存），默认档跟随上限、越级硬 clamp（业主拍板）；③ 动态套餐/裸模型显式绑 core（绝不复用付费 key），post-ensure `resolve_relay_api_key(tier=)` 关闭"ensure 后 pin 前被并发换 key"窗口。CLI（relay status 显示绑定档/上限、ensure-key --tier）、API（`/api/relay/packages` 附 `tier_ceiling` + 每套餐 `locked`）、Web 四套餐选择器（composer / RuntimePicker / AgentConfigDialog / TeamCompanies 越级档禁选 + 角标）零偏差对齐。裁决单一源在内核（`is_tier_locked` / `check_tier_within_ceiling`），表层零计算。
- **触碰路径**：
  - 内核（`packages/superclaw/src/superclaw/`）：`relay_key.py`（tier 绑定 + ceiling + clamp + is_tier_locked + tier-aware resolve）、`backends.py`（ClawWorkBackend.run 默认跟随 + clamp + ensure_tier + post-ensure tier-aware pin）、`cli.py`（relay ensure-key --tier + 越级拦截）、`clawhunt_auth.py`（save 切号清 `superclaw_tier_ceiling`）。
  - API：`apps/api/main.py`（`/api/relay/packages` 附 tier_ceiling + 每套餐 locked）。
  - Web（表层，可自由改）：`src/App.tsx`（composer 套餐下拉）、`src/RuntimePicker.tsx`、`src/TeamCompanies.tsx`、`src/team/AgentConfigDialog.tsx`、`tests/runtime-picker.test.tsx`。
  - 测试：`tests/test_relay_key.py`（+~56 tier/ceiling/clamp/隔离/并发窗口测试）、`tests/test_api_relay_packages_tier.py`（新建，API locked/ceiling 契约）。
  - **无 vendored overlay**（不碰 `server/`）。
- **验证证据**：ruff clean；pytest 7 文件相关簇 **542 passed / 1 skipped**（含 `test_worker_backends` 标准/动态/裸模型翻译契约 + 全部新测试），**合并后主干树重验亦 542 passed**；vitest **547 passed**、tsc 加 0 类型错误（App.tsx 既有 45 个 pre-existing，本改动加 0）。Codex(gpt-5.5) 对抗式验收 **6 轮**逐层抓出并修复 **8 处真问题**：device-id 截断丢 tier 后缀（撞名）/ 无主 legacy key 行为声明 / login 后 ceiling 未刷新被当 core / 动态套餐 refuse 破坏既有契约（改 log）/ refresh 短超时 / 动态档显式 core 绑定 / 裸模型亦 core 绑定 / post-ensure tierless resolve 并发换 key 窗口（tier-aware resolve + fail-closed）。第 6 轮判**通过、无阻断**（含两个并行只读子评审均无阻断）。Gemini 按 §11 本分支不强制（Codex 单顾问门）。
- **未来 PR bucket**：`clawwork / relay-tier-binding`（内核 + CLI + API + Web 一体，无 vendor overlay）。
- **依赖关系 / 已知取舍**：
  - 无内核外依赖。唯一跨表层共享改动 `save_clawhunt_auth` 切号清 ceiling **只碰新字段** `superclaw_tier_ceiling`，不影响任何现有登录字段 / 非 clawwork 流程。
  - **动态套餐逐档 key 绑定列 backlog**：动态档（未来 "pro" 等）当前显式绑 fail-safe core（model 请求动态 slug 但 key 绑 core，存在 mismatch），需放宽 `_normalize_tier` 接受 catalog 校验的动态 tier 才能逐档绑定；#452 范围只覆盖标准 core/plus/max（既有 `test_worker_backends` 动态翻译契约保留：动态档照常翻译并起跑）。
  - **`ui_contracts.py` `default_model='core'` 展示契约与"默认跟随 ceiling"漂移**（Codex 非阻断观察）：不影响 key 绑定隔离 / 治理，留后续对齐。
  - **真账号 relay 冒烟待补**：单测证明 payload 带 tier / device 分档 / clamp / 隔离 / 并发 fail-closed，但证明不了 LLMgate 那端真返回 opus；需真持 plus/max 卡账号端到端验证「命中 opus 而非 GLM」。


### 10. 浏览器引用查看器忠实样式渲染（faithful preview）

- **merge SHA**：`a33927ec`（FF 快进，无独立 merge commit）
- **worker SHA**：`25398ee8`（feat：内核 `build_faithful_page`+`page_html`、CLI 对齐、前端渲染+回退、全套测试）/ `a33927ec`（docs：`reference-viewer-panel.md` §11 姿态变更记录）；分支 `feat/web-preview-faithful`
- **owner**：Leon (LeonSGP43)
- **scope**：内核 + Web 表层 + CLI/API 对齐。业主诉求「Web 端引用查看器要和桌面 APP 效果一样」。Web 端原本只展示内核 §10 的 `sanitized_html`（nh3 零属性纯文本）→ CSS/图/链接全剥光、呈纯文本。本改动让 Web 端达到浏览器天花板——**忠实静态渲染（CSS/图在、脚本关）**：内核 `web_preview.build_faithful_page(raw, final_url)` 把真实 HTML 的 `<head>` 首位注入「禁脚本页级 CSP（`script-src 'none'` 等，省略 default-src/base-uri 以放行被动子资源 + 让注入的 base 生效）+ `<base href>`」，使页面自有子资源由**浏览器直连**加载（不过服务端 → 零新增服务端 SSRF）。`PreviewResult` 加 `page_html`（默认 `""`），`to_dict()`/`asdict` 自动随 `GET /api/preview/{ticket}` 下发（**API 路由零改**）；CLI `web preview` 增 `page_html_chars=` 并经 `--json` 全量暴露（CLI/API/Web 同一事实源）。前端 `WebPreviewPanel` 主渲染 `page_html`（仍 `sandbox=""` 不透明源、无 allow-scripts），`page_html` 缺失（版本偏斜）回退 `buildPreviewSrcdoc(sanitized_html)` 惰性阅读器、绝不空白。
- **触碰路径**：
  - 内核（`packages/superclaw/src/superclaw/`）：`web_preview.py`（`build_faithful_page` + `_PREVIEW_PAGE_CSP` + `PreviewResult.page_html` + `fetch_url_preview` 填充）、`cli.py`（`web preview` 增 `page_html_chars` + docstring）。
  - Web（表层，可自由改）：`src/WebPreviewPanel.tsx`（渲染 page_html + 回退）、`src/App.tsx`（'Preview reader note' 文案 en+zh）。
  - 测试：`tests/test_web_preview.py`（build_faithful_page 注入/转义/无 head 兜底 + fetch 返回 page_html）、`tests/test_api_preview.py`（roundtrip 带 page_html）、`tests/test_web_preview_cli.py`（page_html_chars + json）、`apps/web/tests/web-preview-panel.test.tsx`（渲染 page_html + 回退 + 恢复 buildPreviewSrcdoc 测试）。
  - 文档：`docs/reference-viewer-panel.md`（§11 忠实视图 + 姿态变更；§10.0 零请求声明加 §11 指针）。
  - **无 vendored overlay**（不碰 `server/`）。
- **验证证据**：ruff clean；pytest preview 簇 **104 passed**（合并前 rebase 后 + 合并后集成树各重验一次均 104）；vitest `web-preview-panel` **17 passed**；`vite build` clean；真实 baidu HTML 喂 `build_faithful_page` 证明 `page_html` **保留** `<link rel=stylesheet>`/`<img>` + 注入 base，旧 `sanitize_preview_html` 全剥光（复现用户所见纯文本）。批判性验收 **Codex(gpt-5.5) + Gemini 3.1 Pro(Antigravity) 双 PASS(no blocking)**（超 §11 单顾问门；原免费层 gemini-cli 被 Google 停用故走 agy，已验真模型无静默回退）。
- **未来 PR bucket**：`frontend / reference-viewer`（内核 `web_preview` + CLI + Web 一体，无 vendor overlay）。
- **依赖关系 / 已知取舍**：
  - 无内核外依赖；与 §10 preview-proxy 同模块叠加（`page_html` 为新增并行字段，`sanitized_html` 路径不变、降为回退）。
  - **安全姿态变更（诚实记录，见 `reference-viewer-panel.md` §11）**：忠实视图**有意逆转** §10 P2「零浏览器网络请求」——服务端 SSRF 未复现（子资源浏览器直连不过服务端）、内网探测外泄被「脚本关闭」阻断（页面无 JS 观测 load/error）；**残留** = 被动子资源 GET 副作用 + 第三方追踪/暴露用户 IP，对页面不可观测，且**是桌面 `NativeBrowserPanel`（连脚本都跑）的严格子集**、仍被 click-to-load 默认门挡在用户同意后。
  - **全代理子资源方案列 backlog**：若要连客户端 GET 副作用也关掉，需走「子资源全经服务端代理重写」重型方案（成本高、重开服务端抓取面，需另评审）。
  - **真浏览器 Playwright 验收待补**（Codex 非阻断）：JSDOM 证字符串/属性，但脚本不执行/父源不可达/meta refresh 仅 frame 内/被动请求行为需真浏览器证；本次因 Playwright 浏览器被并行会话占用未跑。
  - 已知边界：iframe 内点链接 frame 内导航（XFO 目标可能空白）；`<head>` 正则非 parser 级（注释内 head/畸形属性可致 base 失效→样式降级，sandbox 托底不致 XSS）；脚本关 ⇒ JS 动态内容不渲染（浏览器天花板）；https app + http 子资源被混合内容拦。


### 11. 能力工坊全链（plugin / skill / company：下载→导入→列表→执行→卸载 + 双 plugin 运行时）

- **merge SHA**：`cd7ebbf3`（`--no-ff` 集成 merge）
- **worker SHA**（分支 `feat/workshop-plugin-company-fullchain`，19 个原子 worker 提交）：
  - 设计：`118e0ea1`（全链落地基准）/ `24553a84`（Node 双格式 plugin 运行时设计）
  - skill 桥 + 信任：`c4088a8f`(S1 receipt+staging) / `59bc5628`(S2a Node 验签) / `20aacf12`(S2b provenance 侧表) / `aec7b3f8`(S2c 导入编排内核)
  - plugin 双运行时：`911f7898`(P1 manifest) / `ec08f3c1`(P2 runtime 表+store) / `42934c41`(P3 exec 治理 preflight) / `2b44d2aa`(P4 MCP runner+stdio transport) / `f956df64`(P5 router+统一 catalog) / `88ddb7e7`(P6a installer) / `7a81ebc6`(P6b-1 硬化 .scplug 提取器) / `e6490b24`(P6b-2 HTTP 路由接线) / `7c39d270`+`4ce826a8`(P7 真子进程 E2E + 进程组拆除)
  - skill / company / 总 E2E：`5369c004`(S4 skill 全链) / `db5bea9c`(S5 company 全链) / `08fc878d`(S6 三类共存 E2E) / `a0e0bfc6`(状态文档)
- **owner**：Leon (LeonSGP43)
- **scope**：vendored `server/`（Node/Paperclip）overlay。把能力工坊三类（plugin / skill / company）的「下载 → 导入 → 只读列表 → (plugin)执行 → 卸载」端到端落到 Node 后端，并新增 **双 plugin 运行时**（通用 Paperclip JS plugin = fork worker；super 二进制/脚本/MCP plugin = subprocess MCP via stdio，物理隔离 `super_plugin_runtimes` 表 + 独立 store）。架构 = **H 架构 / add-only（只增不删、不改上游源码、必要才碰）**：验权留 Python（cosign + R2 + receipt HMAC 签发），**落地/导入/运行时归 Node**，company 直接复用 Paperclip 原生 `importBundle`（无并行实现）。
- **触碰路径**：
  - vendored overlay（`server/server/src/`）新增 services：`workshop-receipt.ts`（HMAC 验签，与 Python 字节级一致）、`workshop-provenance.ts`（侧表 + 服务端控制的 `store_digest` 列，防 official 伪造）、`workshop-import.ts`（receipt-gated 编排 + installers 注册）、`super-workshop-fs.ts`（硬化 `.scplug` 提取：buffer-bound 完整性 + 独立 central-directory 校验）、`super-plugin-manifest.ts`/`super-plugin.schema.ts`（manifest 解析校验）、`super-plugin-runtime-store.ts`（runtime 物理隔离）、`super-plugin-exec.ts`（执行治理 preflight）、`super-mcp-runner.ts`+`super-stdio-transport.ts`（自建 MCP stdio runner，EXACT 收窄 env + killpg 进程组拆除）、`plugin-runtime-router.ts`（双运行时分流 + 统一只读 catalog）、`super-plugin-installer.ts`/`super-skill-installer.ts`+`super-skill-fs.ts`/`super-company-installer.ts`+`super-company-fs.ts`（三类 installer：stage-then-atomic-commit）。
  - 路由 `server/server/src/routes/super-workshop.ts`（新增，add-only：`POST /api/internal/workshop-import` loopback+HMAC、`GET/DELETE /api/super-plugins|super-skills|super-companies`、`POST /api/super-plugins/:key/tools/:tool`）+ `routes/plugins.ts`（卸载时 `clearPluginProvenanceOnUninstall` 清 provenance，与同区他人新增 `GET /api/plugins/global` 路由零冲突共存）+ `app.ts`（注入 storageService）。
  - 依赖：`server/server/package.json` + `server/pnpm-lock.yaml` 新增 `yauzl@^3.2.0`、`@modelcontextprotocol/sdk@^1.29.0`、`embedded-postgres`（测试）。
  - 测试（`server/server/src/__tests__/`）：super-* / workshop-* 全套 + 真子进程 MCP E2E + S6 三类共存 E2E。
  - docs：`docs/capability-workshop-paperclip-fullchain-design.md`、`docs/capability-workshop-dual-plugin-runtime-design.md`、`docs/workshop-fullchain-status.md`。
  - **上传侧此前已存在，不在本 overlay**（Python `capability_submission.py` 三类 + Node `POST /api/companies/:id/export` + `capability_r2` publish-r2 + cosign）。
- **验证证据**：合并后主干树（`cd7ebbf3`，`pnpm install --frozen-lockfile` 同步新依赖后）**tsc 0 错误**；super/workshop 串行 **19 文件 272 passed**；worker tip `5ebb68eb` 上更跑过 super/workshop+重叠区 **21 文件 301 passed**（并行偶现 1 例 `socket hang up` = embedded-postgres 真子进程并行饿死的 flaky，单跑+串行均绿，非回归）。每个 worker 切片经 Codex(gpt-5.5) 对抗式验收通过后才原子提交（S4 8 轮 / S5 4 轮 / P7 6 轮 / P6b-1 4 轮等）。按 §11 本分支走 Codex 单顾问门。
- **未来 PR bucket**：`capability-workshop / node-fullchain`（vendored `server/` overlay，含双 plugin 运行时 + 三类 installer + 路由 + 依赖）。
- **依赖关系 / 已知取舍**：
  - 唯一与他人重叠文件 `routes/plugins.ts`，两边改动在不同区域，自动三方合并干净（已逐处 grep 核验两边改动并存）。
  - **关键不变量**：完整性边界 = `transport_sha256`（整段 archive 读进不可变 buffer，同一 buffer 上 hash+独立 CD 遍历+解压，闭 same-UID TOCTOU；yauzl@3.x 不验 CRC 故 transport_sha256 是边界）；skill official 绑**服务端 DB `store_digest`**（GET 实时重算比对，而非可写、被排除出 digest 的 `.provenance.json`）；company 失败语义**与原生零偏差**（不做 before/after 全局 company-id diff 补偿——并发下会误删他人刚建公司；rollback 只删已知精确 id）；进程组拆除 detached spawn + SIGTERM→grace→无条件 SIGKILL group + 轮询 `kill(-pgid,0)` 至 ESRCH，killGroup 只用负 pid（防 pid 复用误杀）。
  - **no-sandbox RCE 残留**（设计已接受）：super plugin 在无沙箱环境执行，靠治理门（受信 root 签名 + cosign 验权 + 人审）兜底，非技术隔离。
  - **上传一步重构列 backlog**（Python CLI 域，可选）：company 当前两步（`/api/companies/:id/export` → submit），设计的「给 companyId+kind 一步导出上传」是便利重构，export 端点已在，非缺失能力。
  - **真账号端到端冒烟待补**：测试覆盖 receipt 验签 / 提取完整性 / 三类 installer / 真子进程 MCP / 共存，但未跨真 R2 + 真 cosign 拉真能力字节落地一次；留 PR-to-main 满血门补。


### 12. 能力工坊 company-upload portability bridge（修上传/导入格式不连贯，与 S5 round-trip）

- **merge SHA**：`02a61982`（`--no-ff` 集成 merge）
- **worker SHA**（分支 `feat/workshop-plugin-company-fullchain`，6 个 worker 提交，Codex 裁决的 4 片切分 + 双顾问终验修复）：
  - `3725226b`(slice 1 portability bundle 本地审查门) / `601019f9`(slice 2 loopback export→freeze→submit + CLI `submit-company`) / `c3b6b2cc`(slice 3 distribution/publish flow + 真 R2 round-trip) / `2936d014`(slice 4 文档 + 更正早先误判) / `5dbdffe3`(终验修复:短路完整化 + digest POSIX 序 + multiple-COMPANY.md 放宽 + 400/5xx 分类) / `20baa508`(preview 422 当业务拒绝)
- **owner**：Leon (LeonSGP43)
- **scope**：内核(Python `packages/superclaw`)。修复 company 链路**上传/审查侧只认 legacy `superclaw-company.json`** 而**下载/导入侧(§见前序工坊 S5)只认 `COMPANY.md` portability bundle** 的格式不连贯（不能 round-trip）。按业主「上传也按 Paperclip 取项目逻辑」+ Codex 设计裁决，新建基于 Paperclip 导出的 portability 上传路径与导入侧对齐。**架构收窄**：Python 不重写 portability parser，可导入性交由 Node `previewImport`（注入式 preview_fn，真实现是**强制 loopback** 的 HTTP）；Python 只管 CLI/发布身份/digest/R2/receipt。**add-only**，legacy 路径保留。
- **触碰路径**：
  - 内核新增：`packages/superclaw/src/superclaw/company_portability_review.py`（fail-closed 本地审查门:有序短路 identity→symlink→structure→limits→secret→preview→digest;长度前缀+POSIX 序稳定 digest;`check_bundle_safety_and_limits` 复制前预检）、`company_portability_loopback.py`（强制 loopback 的 export/freeze/preview_fn,trust_env=False+follow_redirects=False,400/422 业务拒绝 vs 5xx infra）。
  - 内核改动：`capability_submission.py`（`submit_company_portability_upload` 复用既有 store/审查/记录机制 + 走通既有 kind-generic distribution→publish→R2;修 `_store_capability_blob` 对 RAW 路径先验 symlink——原 resolve 后检查恒失效,修复对所有 kind 生效）、`cli.py`（`capability submit-company --from-company|--bundle`,硬消歧,legacy 仍走 `capability submit company <path>`）。
  - 测试:`tests/test_company_portability_{review,loopback,submission}.py`(123 对抗式单测)。
  - 文档:`docs/workshop-fullchain-status.md` §六。
  - **无 vendored overlay**（不碰 `server/`）。
- **验证证据**：ruff 干净;**123 对抗式单测全绿**（含短路反例/digest 碰撞/loopback 强制/path-safety/400+422 分类/多 COMPANY.md 取浅）;相关 Python 簇 190 passed 无回归;合并后主干树重验 123 绿。**真账号 R2 字节 round-trip 冒烟 PASS**（submissions-prod 唯一 `__workshop_smoke__/<uuid>` key,put→get→字节一致→delete 自清理,零 registry 污染）。**双顾问终验双 PASS**：Codex(gpt-5.5,全新 session)+ agy(Gemini 3.1 Pro) 均 **no blocking findings**（逐片 Codex 多轮:slice1 三轮/slice2 两轮;终验 Codex 1 blocking+agy 6 findings 全部修复或经 Node 源码核验为非问题后双 PASS）。
- **未来 PR bucket**：`capability-workshop / company-portability-upload`（内核 Python,无 vendor overlay）。
- **依赖关系 / 已知取舍**：
  - 与他人零文件重叠（纯 Python 内核;合并时主干 e4dfd904 的 5 提交与本 bridge 无交集）。
  - **关键不变量**：完整性边界 = portability digest(长度前缀+POSIX 序,杜绝跨树碰撞);loopback **强制本机**(`ipaddress.is_loopback`,非 loopback URL 发请求前即拒——company 字节绝不离机);审查门全 fail-closed 且有序短路(invalid 提交绝不到达 Node preview / 算 digest);发布身份显式(slug allowlist+semver,绝不从 live companyId 推断);复用 Paperclip 原生 `previewImport`,绝不并行实现。
  - **backlog**：① cosign 未安装 → 完整官方发布签名段未端到端跑(真 R2 字节通道已冒烟);② `--from-company` 真 Node 活体集成冒烟需活的 Node(单测已 mock,生产靠 local_trusted loopback=board 授权);③ registry `instantiable=False`(company)是 D3/G1/G2 有意 verify-before-instantiate 设计,非 bug,不改。


### 13. 公司删除 500 级联修复 + 嵌入板样式隔离引擎兼容重构（company-delete-embed-css）

- **merge SHA**：`d5e695d1`（`--no-ff` 集成 merge）
- **worker SHA**：`fb0850e2`（分支 `fix/company-delete-cascade-embed-css`，5 个原子提交
  `88f68c2e`(server 级联) / `2be466ce`(costs FK 归属校验) / `f9f898c3`(board 删除反馈) /
  `901491b6`(web 样式隔离) / `fb0850e2`(docs)；合回前吸收主干 `326eef7f`，唯一冲突
  `apps/web/package.json` test 清单取并集）
- **owner**：Leon (LeonSGP43)
- **scope**：
  1. **Node 内核（vendored server/server）**：`companyService.remove()` 手动级联序修复——
     `finance_events`→`cost_events` 先于 `heartbeat_runs`（NO ACTION FK），`projects` 先于
     `goals`。旧序对任何有 costed run 的公司（用户真机复现「你好」，Node 日志
     `cost_events_heartbeat_run_id_..._fk` 违规）或 Goal Mode 公司删除必 500。顾问加码：
     id 集合全改 drizzle 子查询（消 65535 绑定参数上限，agy 阻断）；其它公司引用本公司
     rows 的 legacy 跨租户 cost/finance 行 set-null 解链（绝不删他租户账目，Codex 阻断
     删除层）；`costService.createEvent` 补 issue/project/goal/run 归属校验（对齐
     financeService、复用其导出的 `assertBelongsToCompany`，Codex 阻断写入层）。
  2. **板 UI（vendored overlay server/ui）**：公司目录删除确认面板补失败反馈（内联
     `role="alert"` + 面板保持可重试 + 跨卡片 `mutation.reset()` + flex-wrap/break-words）。
     修复前 500 被静默吞掉 =「点了没反应」。
  3. **前端（apps/web）**：嵌入板样式隔离从「未分层 `revert-layer` 桥」改为
     「scope-at-source 守卫」——revert-layer 在未分层规则中的回滚 WebKit/WKWebView 下失效
     （桌面板内按钮 padding 实测 `0px 12px`→`0px`，删除确认框/新建公司向导文字超框），
     Chromium 正常故 dev 不显。宿主 6 处裸元素规则逐条加零特异性
     `:where(:not(.company-board-root */[data-slot]/[data-board-portal]/[data-paperclip-floating-ui]…))`
     守卫，4 个 revert-layer 桥块整体删除；`--accent` 去冲突块不变。
- **触碰路径**：`server/server/src/services/{companies,costs,finance}.ts`、
  `server/server/src/__tests__/{companies-service,costs-service}.test.ts`、
  `server/ui/src/pages/Companies.tsx` + `Companies.test.tsx`（新）、
  `apps/web/src/styles.css`、`apps/web/tests/board-style-isolation.test.ts`（新，挂入
  npm test 清单）、`apps/web/package.json`、`docs/ledger-entry-draft-...md`（本条落定后删除）。
- **验证证据**：嵌入式 PG 新旧对拍（旧序回归用例必红/新序全绿：costed-run / goal-project /
  跨租户解链形状）；Playwright **WebKit+Chromium 双引擎** E2E（构建后 dist 走完整 UI 删除流，
  padding 两引擎一致、向导 portal 干净）；合并树 web **42 文件 476 tests + static-ui** 全绿
  （含主干新增 canonical-composer 与本分支 isolation 测试并集）、server 相关 31 tests、
  ui 3 tests 绿；双侧 `tsc` 零错；`npm run build` 成功。**Codex(gpt-5.5)+agy(Gemini 3.1 Pro)
  两轮对抗式验收**：首轮双不通过（Codex 抓跨租户 FK 写入口、agy 抓 inArray 参数上限），
  修复后二轮双 PASS。
- **未来 PR bucket**：`kernel / company-directory`（scope 1）+ `frontend / board-embed`（2、3）。
- **依赖关系 / 已知取舍**：建立在子功能 4/7（company-surface-board、公司目录 Team home）之上。
  另一并行会话 `fix/company-board-button-overflow` 有未提交同域 WIP（onError 提示 + 部分
  cascade 测试，未覆盖 cost_events 真根因、未动 CSS），其记忆条目的「按钮只 revert font」
  窄修方向已被本条 scope-at-source 取代；该 WIP 如后续提交按本条为准协调。
  运行中的桌面 App / dev 栈需重建后用户才能从 UI 删除「你好」。
