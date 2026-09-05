# updatePRD v3 — PLAN（SuperClaw ↔ ClawHunt 联调 · 第一期）

> 配套 PRD：`specs/updatePRDv3.md`（决策点全定：路线 Y / 分两期 / 先用 llmgate key / 先接 web）
> 版本：v3-PLAN | 日期：2026-06-28 | 负责人：LK
> 本 PLAN 覆盖 **第一期：本地/dev 两个租户聊出真答案**（补 G1/G2/G3/G7）。第二期（G5 持久化 + G6 安全 P0 + 线上发放）另起 PLAN。
> **开发主战场是 ClawHunt 仓**：`c:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/clawproduct-hunt`（PLAN/PRD 文档放在 SuperClaw 仓 `specs/`，与 PRD 成对）。

---

## 〇、开发前必读（铁律 + 联调关键事实）

### 铁律（每个任务都适用，提示词里已内嵌，这里集中声明）
1. **中文交流 + 代码注释中文**。
2. **隔离 worktree 开发**：任何写代码的会话在自己独立 `git worktree` 里开，绝不在共享主检出直接改。
3. **开发完成 → Codex + Gemini 批判性验收（两者都过）→ 才原子化提交**：一个 commit 一件事；提交信息约定式风格、不带 AI 署名。
4. **fail-closed 治理不可破**：embed 层强制 `mode=plan`、禁 bash/write/edit、`pay_switch=False`、hunt-JWT 不透传进子进程——任何改动不得削弱这些。
5. **CLI 唯一事实源 / 表层零新增语义**：embed 是 SuperClaw 的"表层"，不得在 ClawHunt 侧另写一份并行业务逻辑。

### 联调关键事实（调研已确认，避免重复踩坑）
- **G1 大半已就绪**：`/superclaw` 路由（前端 `main.html:11448` + 后端 `main.py:1347/894`）、`#page-superclaw` 节点（`main.html:23145`）、nav、SSE 范式 `trySuperClawStream()`（`main.html:25495`）、JWT 注入 `getAuthHeaders()`（`main.html:10758`）**都已存在可复用**。真正缺：把 page-superclaw 接到 **embed 端点** `/superclaw/api/chat/stream`（现有 chat 打的是主站 `/api/agent-chat/chat/stream`，不是 embed）。
- **embed 是独立服务**：`backend/superclaw_embed_app.py`，挂 `prefix="/superclaw"` → 端点 `POST /superclaw/api/chat/stream`，本地默认 uvicorn 端口 8080。**它不在主站 main:app 进程内**（避免计费后台任务双跑）。
- **principal 鉴权**：embed 入口 `_principal` 强校验 hunt-JWT 的 `sub == user.id`（防跨租户计费）。本地联调要么造有效 JWT、要么走 session cookie——这是 Task 1.2 的核心子问题。
- **G2 缺口在 LLMgate 仓，不在 ClawHunt**：ClawHunt 侧 `utils/llmgate_bridge.py:151` 已传 `tier`、`:218` 有 tier 时直接 rotate；`utils/superclaw_tier.py:12` 已有 tier→slug 映射。瓶颈是 **LLMgate 服务端** `backend/app/api/v1/bridge.py` 不解析 tier→group_id（见 `docs/llmgate-superclaw-package-bridge-report.md`）。本地联调第一步可用 v1 的 llmgate key **先绕过** G2。
- **本地启动前置**：先 `scripts/sync_superclaw.sh --build` 物化 SuperClaw（clone SHA `db474fb8` → venv → 编 ClawWork）；`superclaw_embed_app.py` 启动时 fail-fast 检查 `SUPERCLAW_EMBED_HOME/apps/api/main.py` 存在。

### 本轮实测新增事实（2026-06-28，Task 1.1/1.2 打通后回填，给后续任务避坑）
- **【字段对齐 · 影响 Task 2.1/2.3】embed 强制 backend 需请求体同步带 `backend_policy`**：embed `router.py` 只强制 `direct_chat_backend="clawwork"`，**不设** `backend_policy`。SuperClaw 内核 `main.py` 有 fail-closed 守卫 `model = runtime.model if runtime.backend == direct_backend else None`——请求不带 `backend_policy` 时 `runtime.backend` 回退 `"claude"` ≠ `clawwork` → **model override 被丢弃**，回落到 tier 派生的 `superclaw-core`。**前端 `scSendMessage` 的 body 必须同带 `backend_policy:"clawwork"` + `model`**，否则选模型无效且会撞 G2 的套餐 403。
- **【G2 实测 · 影响 Checkpoint C】`superclaw-core` 被 relay 403**：v1 固定 llmgate key 对套餐模型 `superclaw-core` 返回 `403 / package_not_permitted`，对裸模型 `claude-opus-4-8` 有权。印证 G2 缺口在 LLMgate 侧；本地用裸模型 `EMBED_MODEL=claude-opus-4-8`（经请求级 model 覆盖）兜过。Task 2.3 验「非法 model 被拒」时注意区分：套餐无权(403) vs group 未暴露(haiku 被拒) 是两类正向 fail-closed 证据。
- **【Windows · 影响所有本地起服务的任务】兼容垫片链**：本地跑 embed + spawn 子进程需一套垫片（全经 env/PYTHONPATH 注入，**不改 vendored 源**）：PYTHONUTF8 治 GBK、venv 在 `Scripts/` 非 `bin/`、`USERPROFILE` 回填 `Path.home()`、`fcntl` 垫片、`cli.js` 的 `.cmd` 包装（治 WinError 193）、`os.O_NONBLOCK` 哨兵 + `PeekNamedPipe`/`PIPE_NOWAIT` select 补丁（`sitecustomize.py`）。详见 `doc/superclaw-embed-local-dev.md` §6/§9。
- **【G8 新缺口 · 影响生产 materialize】Windows 从零全量 build ClawWork 不通**：`sync_superclaw.sh --build` 全量编译在 Windows 失败（`packages/agent` + `proxy.ts/types.ts` 找不到 `@earendil-works/pi-ai/base`——`pi-ai/dist/base*` 未先产出，工作区编译顺序问题 + 一批 implicit-any）。**运行时用的 `coding-agent/dist/cli.js` 已存在并跑通**，本地联调不阻塞；仅在「从零物化」与生产 `--build` 路径需先解决 build 顺序。留给第二期/生产部署处理。

---

## 阶段一 · 第一期任务清单

### Checkpoint A — 本地嵌入层起来 + 真答案打通（G3 + 环境就绪）

---

#### Task 1.1 — 物化 SuperClaw 并启动 embed 服务（本地起得来、/health 200）

**状态**：`[x]`
**预计**：1.5h
**目标**：在本地把 SuperClaw 物化好、embed 服务能启动、`GET /health` 返回 200、子进程能按租户 spawn。
**涉及**：`clawproduct-hunt/scripts/sync_superclaw.sh`、`backend/superclaw_embed_app.py`、`backend/superclaw_embed/config.py`、`superclaw.lock`、本地 `.env`

**AI 提示词**：
```
你是一位资深 Python 后端与 DevOps 工程师，精通 FastAPI / uvicorn / 子进程隔离与本地环境搭建。ultrathink。

目标：在本地把 ClawHunt 的 SuperClaw 嵌入层服务跑起来（不接前端、不接真模型，先确认服务骨架可启动）。

仓库：c:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/clawproduct-hunt

步骤：
1. 阅读 backend/superclaw_embed_app.py（入口）与 backend/superclaw_embed/config.py（EmbedConfig.from_env 的所有 env 字段），列出本地启动「必需」与「可选」的 env 清单。
2. 阅读 scripts/sync_superclaw.sh，搞清它如何 clone SHA db474fb8 → 建 venv → 编译 ClawWork。在本地执行 `scripts/sync_superclaw.sh --build`（Windows Git Bash 环境，注意路径与 shell 兼容；如脚本是 Unix-only，记录需在 WSL/容器内跑还是可在 Git Bash 跑，给出可行方案）。
3. 写一个本地 .env.embed.local（不入库，加进 .gitignore 若未忽略）填好：SUPERCLAW_EMBED_HOME 指向物化出的 third_party/superclaw、SUPERCLAW_EMBED_DATA_ROOT 指向本地 data 目录、SUPERCLAW_EMBED_SPAWN_ARGV 指向 venv 的 python -m uvicorn apps.api.main:app、SUPERCLAW_RELAY_BASE_URL 先占位。
4. 启动：`cd backend && uvicorn superclaw_embed_app:app --host 127.0.0.1 --port 8080`，确认 `GET http://127.0.0.1:8080/health` 返回 200。
5. 若启动 fail-fast（找不到 apps/api/main.py 等），定位原因并修正 env / 路径，不要改 embed 源码绕过校验。

约束：
- 不削弱任何 fail-closed 校验；只配 env，不动 superclaw_embed 业务源码。
- 所有新增脚本/配置的注释用中文。
- Windows 路径用正斜杠；shell 用 Git Bash 语法（/dev/null 不是 NUL）。

交付：一份「本地启动手册」（写到 clawproduct-hunt/doc/superclaw-embed-local-dev.md，中文），含完整 env 清单 + 启动命令 + /health 验证截图/输出。
```

**验收标准**：本地 `uvicorn superclaw_embed_app:app` 启动无 fail-fast；`curl http://127.0.0.1:8080/health` 返回 `{"ok":...}` 200。

---

#### Task 1.2 — 本地造有效 hunt-JWT + 配 v1 llmgate key，curl 打通真答案

**状态**：`[x]`
**预计**：2h
**目标**：绕过线上发放，用 v1 验证过的 llmgate key + 本地有效 principal，直接 `curl POST /superclaw/api/chat/stream` 拿到**真答案**（SSE）。
**涉及**：`backend/superclaw_embed_app.py`（`_principal`）、`backend/superclaw_embed/gateway.py`、`backend/superclaw_embed/tenant.py`（relay_key_provider）、`backend/utils/llmgate_bridge.py`、本地 `.env.embed.local`

**AI 提示词**：
```
你是一位资深 Python 安全与鉴权工程师，精通 JWT、FastAPI 依赖注入、HTTP 流式代理。ultrathink。

背景：ClawHunt 嵌入层入口 superclaw_embed_app.py 的 _principal 会强校验 hunt-JWT 的 sub==user.id（防跨租户计费）；resolve 时默认走 LLMgate bridge 换 per-user relay key。本地联调第一步要绕过线上发放，用一个固定的 llmgate 测试 key（v1 已验证可用：<PROVIDER_API_KEY>，relay base https://gate.clawhunt.site/v1），并造一个本地有效 principal。

任务：
1. 读 superclaw_embed_app.py 的 _principal（53-69 行附近），搞清它接受 Bearer JWT 还是 session cookie、用什么 secret 验签、sub 怎么比对。给出「本地如何造一个能通过校验的 token」的最小方案（优先复用主站签发逻辑，而不是绕过校验）。
2. 读 gateway.py（build_gateway / EmbedRuntime.create，88-92 行 resolver 注入点）与 tenant.py（TenantProfileResolver / default_relay_key_provider，203-212 行）。设计本地「用固定 relay key 绕过 bridge」的最小改动：优先用 env 覆盖或注入自定义 relay_key_provider（通过 build_gateway 的 resolver 参数），不要改死业务默认逻辑、不要把测试 key 写进代码或入库。
3. 配好 .env.embed.local：SUPERCLAW_RELAY_BASE_URL=https://gate.clawhunt.site/v1；relay key 经环境注入（不硬编码）。
4. 写一个本地联调脚本 scripts/embed_chat_smoke.sh（中文注释）：造 token → curl POST http://127.0.0.1:8080/superclaw/api/chat/stream（body 含 message/agent_id/model），逐帧打印 SSE，断言拿到非空 delta（真答案）。注意 Windows Git Bash 的中文 curl body 要用 --data-binary @utf8file，别内联中文。
5. 跑通：至少一次拿到模型真实回答；记录用的 model id（确认 relay 默认 group 暴露的是 opus/sonnet，haiku 会被拒——这是正确的）。

约束：
- 测试 key 只走 env / 本地不入库文件，绝不写进源码或提交。
- 不削弱 _principal 的 sub==user.id 校验；本地方案是「造一个合法 token」而非「关掉校验」。
- 中文注释。

交付：embed_chat_smoke.sh + 一段联调记录（贴进 doc/superclaw-embed-local-dev.md）：请求/响应、用的 model、真答案片段。
```

**验收标准**：本地 `curl /superclaw/api/chat/stream` 拿到 SSE 真答案（非空 delta）；token 通过 `_principal` 校验；relay key 不入库。

---

> ### ✅ 验收检查点 A（Task 1.1–1.2 完成后停下）
> 汇报：本地 embed 服务起得来、能用 v1 llmgate key 打出真答案。等业主确认「后端链路通了」再进 Checkpoint B（前端接入）。
>
> **实测结论（2026-06-28，已达标）**：embed(:8099) 直连真 gate(`gate.clawhunt.site`) `curl POST /superclaw/api/chat/stream` 拿到非空中文真答案（`status: completed`，backend `clawwork`，~13.4s）；JWT 过 `_principal`（test user id=2）；relay key 只在 gitignored `.env.embed.local` 不入库。交付：`scripts/embed_chat_smoke.sh` + `doc/superclaw-embed-local-dev.md` §9。**等业主确认后端链路通了，再进 Checkpoint B。**（提交前须经 Codex+Gemini 批判性验收 + 隔离 worktree + 原子化提交。）

---

### Checkpoint B — web 前端接入（G1）

---

#### Task 2.1 — page-superclaw 接入 embed chat（UI + fetch adapter → /superclaw/api/chat/stream）

**状态**：`[ ]`
**预计**：2h
**目标**：在已存在的 `#page-superclaw` 节点内做一套 chat UI，发消息打到 **embed 端点** `/superclaw/api/chat/stream`，复用现有 SSE 渲染 + JWT 注入范式。
**涉及**：`clawproduct-hunt/frontend/main.html`（`#page-superclaw` ~23145；复用 `trySuperClawStream` ~25495、`getAuthHeaders` ~10758、typewriter ~25528）

**AI 提示词**：
```
coding with gemini（main.html 有 3.2 万行，需长上下文）。你是一位资深前端工程师，精通原生 JS SPA、Fetch ReadableStream、SSE 流式渲染。ultrathink。

仓库：c:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/clawproduct-hunt
文件：frontend/main.html（纯原生 HTML/JS SPA，无框架、无构建）

现状（已确认，直接复用别重写）：
- 路由 /superclaw 已注册（CLEAN_ROUTE_BY_PAGE 第 11448 行）、#page-superclaw 节点已存在（第 23145 行）、nav 已有。
- 现成 SSE 流式范式 trySuperClawStream()（第 25495-25645 行）：fetch → res.body.getReader() → TextDecoder → 按 \n\n 切 SSE 帧 → handleFrame（type: delta/error/done）→ typewriter 平滑渲染（第 25528 行）。
- 现成 JWT 注入 getAuthHeaders()（第 10758 行）：拼 Authorization: Bearer <AppState.authToken>。
- 注意：现有 chat 打的是主站 /api/agent-chat/chat/stream，本任务要打的是 embed 端点 /superclaw/api/chat/stream（不同服务）。

任务：
1. 在 #page-superclaw 节点内新增一套独立 chat UI：消息列表区 + 输入框 + 发送按钮（视觉沿用站点 Tailwind built css 既有 class，风格与现有 agent chat 一致）。给 DOM 元素用 superclaw- 前缀的 id，避免与现有 agent chat 冲突。
2. 写一个独立 fetch adapter scSendMessage(text)：
   - 复用 getAuthHeaders() 注入 hunt-JWT（匿名用户提示先登录）。
   - POST /superclaw/api/chat/stream，body：{ message, agent_id:'superclaw', model, history: 最近N条 }（字段对齐 embed 子进程 apps.api.main 的 /api/chat/stream 入参；先读后端契约再定字段，别瞎猜）。
   - 复用现有 SSE 读取逻辑（getReader + TextDecoder + 按 \n\n 切帧）渲染 delta；error 帧显示错误；done 收尾。可直接抽取 trySuperClawStream 的 reader/parseEvent/handleFrame 逻辑成一个可复用函数，两处共享。
3. showPage('superclaw') 的 switch 分支（第 11609 行附近）加初始化钩子：进入页面时聚焦输入框、清空/恢复会话。
4. 不破坏现有 /api/agent-chat 那套；两套 chat 各自独立。

约束：
- 中文注释（JS 注释用中文）。
- 不引入任何框架/构建步骤；纯原生 JS。
- 字段语义必须和 embed 后端契约一致（零偏差）；拿不准的字段先去 backend 读 apps.api.main 的 chat 入参或 router.py 的 build_forward。

交付：改动后的 main.html（page-superclaw 内 chat UI + scSendMessage adapter + 初始化钩子）。
```

**验收标准**：进入 `/superclaw` 页面有可用 chat UI；点发送会向 `/superclaw/api/chat/stream` 发带 Bearer 的 POST；SSE delta 能流式渲染（后端通时）。

---

#### Task 2.2 — 本地前后端路由联通（让前端 /superclaw/* 到达 embed 8080）

**状态**：`[ ]`
**预计**：1h
**目标**：本地 dev 时，前端（主站 `backend/main.py` serve 的 main.html）发出的 `/superclaw/*` 请求能到达独立的 embed 服务（8080）。
**涉及**：`clawproduct-hunt/backend/main.py`（本地反代/转发）或本地反代配置；`doc/superclaw-embed-local-dev.md`

**AI 提示词**：
```
你是一位资深后端与本地开发环境工程师，精通 FastAPI、反向代理、SSE 透传。ultrathink。

背景：ClawHunt 主站 backend/main.py（uvicorn 一个进程）serve 前端 main.html 与主站 API；SuperClaw embed 是独立服务（superclaw_embed_app.py，端口 8080）。前端用相对路径 fetch /superclaw/api/chat/stream，本地需要让这个请求到达 8080。生产是 nginx/LB 把 /superclaw/* 转给独立 Cloud Run 服务，本地没有这层。

任务：
1. 给出本地联通的最小方案，从下面选最干净的一个并实现：
   (a) 在主站 backend/main.py 加一个「仅本地 dev 生效」的 /superclaw/* 反代，把请求（含 SSE 流式）转发到 http://127.0.0.1:8080/superclaw/*，且原样透传 Authorization header 与流式响应；用 env 开关（如 SUPERCLAW_EMBED_LOCAL_PROXY=1）守卫，绝不在生产开启。
   (b) 或本地起一个轻量反代（caddy/nginx/python）把 /superclaw/* → 8080、其余 → 主站。
   优先 (a)（零额外依赖、对前端透明）；若 (a) 会污染生产代码，则选 (b) 并写好启动脚本。
2. 确保 SSE 流式不被缓冲（转发时 stream=True、不缓存、正确透传 Content-Type: text/event-stream）。
3. 把方案写进 doc/superclaw-embed-local-dev.md（中文）：怎么同时起主站 + embed + 联通。

约束：
- 本地反代必须 env 守卫，生产默认关闭，fail-closed。
- 不透传任何会破坏 embed _principal 校验的东西；Authorization 原样转发即可。
- 中文注释。

交付：本地联通实现（main.py 的守卫反代 或 反代配置 + 启动脚本）+ doc 更新。
```

**验收标准**：本地同时起主站 + embed 后，浏览器访问主站 `/superclaw` 页面发消息，请求确实到达 8080 embed 并流式返回。

---

#### Task 2.3 — 端到端浏览器联调验证（web 出真答案）

**状态**：`[ ]`
**预计**：1h
**目标**：浏览器里在 `/superclaw` 页面登录态下发消息 → embed → 真答案流式渲染，截图留证。
**涉及**：前述全部；产出 `specs/v3-第一期-web联调报告.md`（SuperClaw 仓）

**AI 提示词**：
```
你是一位资深 QA 与联调工程师，精通端到端验证与证据留痕。

任务：在本地把主站 + embed 都起好（Task 1.1/1.2/2.2 的环境），用真实登录态在浏览器 /superclaw 页面做端到端验证：
1. 登录拿到 hunt-JWT（AppState.authToken 有值）。
2. 在 superclaw chat UI 发一条消息，确认：请求打到 /superclaw/api/chat/stream、带 Bearer、SSE delta 逐步渲染、最终是模型真答案。
3. 验证至少 2 个 model 选择都能出答案；验证一个不被 relay 默认 group 暴露的 model（如 haiku-4-6）被正确拒绝（fail-closed 正向证据）。
4. 验证匿名（未登录）时 UI 提示登录、不发裸请求。
5. 截图 + 网络面板证据，写报告 specs/v3-第一期-web联调报告.md（中文）：拓扑、请求/响应、真答案片段、已知问题（如非真流式体验 G4）。

约束：中文报告。如实记录问题，不掩盖。
```

**验收标准**：浏览器 web 端 `/superclaw` 聊天出真答案；model 切换有效；非法 model 被拒；匿名拦截；报告落档。

---

> ### ✅ 验收检查点 B（Task 2.1–2.3 完成后停下）
> 汇报：**用户能在 ClawHunt web 里聊出真答案了**（第一期最核心验收口径 1 达成）。等业主确认后进 Checkpoint C（计费绑定）。
> ⚠️ 提交前：本批前端/后端改动须经 Codex + Gemini 批判性验收（两者都过）再原子化提交。

---

### Checkpoint C — 计费走对套餐（G2）

---

#### Task 3.1 — 核验 ClawHunt 侧 tier 透传（确认 ClawHunt 一行不用改）

**状态**：`[ ]`
**预计**：1h
**目标**：用测试/脚本证明 ClawHunt 侧已正确把 `tier` 传进 bridge、并按 `(user_id, tier)` 隔离缓存、有 tier 时直接 rotate——锁定缺口确实只在 LLMgate。
**涉及**：`backend/utils/llmgate_bridge.py`（`_exchange` 142-155、`ensure_user_relay_key` 218）、`backend/utils/superclaw_tier.py`（12-16）、`backend/superclaw_embed/tenant.py`（`env_overlay` 113）、新测试

**AI 提示词**：
```
你是一位资深 Python 测试工程师，精通 pytest、httpx mock、契约测试。ultrathink。

仓库：c:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/clawproduct-hunt

背景：调研结论是 G2（relay key 套餐绑定）的缺口在 LLMgate 服务端，不在 ClawHunt。本任务用测试把「ClawHunt 侧已就绪」这一结论钉死，作为后续改 LLMgate 的依据与回归护栏。

任务：写 pytest（mock 掉对 LLMgate 的 HTTP），断言：
1. ensure_user_relay_key(access_token, user_id, tier="plus") 发给 LLMgate /bridge/exchange 的 payload 里带 tier="plus"（llmgate_bridge.py:151）。
2. tier 非空时 rotate_directly=True，走 _rotate 而非 _ensure_or_rotate（llmgate_bridge.py:218），即不复用可能绑旧 group 的 key。
3. 缓存键按 (user_id, tier) 隔离：同 user 不同 tier 不串 key。
4. tenant.env_overlay 注入 SUPERCLAW_CLAWWORK_MODEL=superclaw-{tier}（tenant.py:113），core/plus/max 三档分别正确。
5. utils/superclaw_tier.SUPERCLAW_RELAY_GROUP_SLUGS 映射正确（core→superclaw-core 等）。

约束：
- 不改业务代码，只补测试（除非发现 ClawHunt 侧真有 bug，才修并说明）。
- 中文注释。
- 放进 backend/ 既有测试目录，遵循现有测试风格。

交付：测试文件 + 一句话结论（ClawHunt 侧是否确实就绪）。
```

**验收标准**：测试全绿，证明 ClawHunt 侧 tier 透传/rotate/缓存/注入均正确；明确「缺口在 LLMgate」。

---

#### Task 3.2 — LLMgate 服务端：解析 tier → 绑定 superclaw-{tier} group（⚠️ 跨仓）

**状态**：`[ ]`
**预计**：2h
**目标**：在 **LLMgate 仓**（非 ClawHunt）让 bridge 创建/rotate key 时按 tier 绑定正确 group，使计费/模型池真正落到 `superclaw-{tier}`。
**涉及**：**LLMgate 仓** `backend/app/api/v1/bridge.py`（`/exchange`、`/keys/ensure`、`/keys/rotate`）；参考 ClawHunt `docs/llmgate-superclaw-package-bridge-report.md`、`docs/clawwork-relay-local-test.md`

**AI 提示词**：
```
你是一位资深后端工程师，精通 API 网关、计费分组、relay key 签发。ultrathink。

⚠️ 注意：本任务改的是 LLMgate 仓库，不是 ClawHunt。先确认 LLMgate 仓在本机的位置与分支（见 ClawHunt docs/clawwork-relay-local-test.md：checkout feat/relay-key-quota-enforcement）。若本机没有 LLMgate 仓，先停下来向业主确认仓库位置，不要在 ClawHunt 里乱改。

背景：ClawHunt 侧已把 tier 传进 /api/v1/bridge/exchange（payload.tier），但 LLMgate 创建 key 时 group_id=None，导致 key 没绑定 superclaw-{tier} 模型池，计费/模型走默认。tier→group_slug 映射：core→superclaw-core, plus→superclaw-plus, max→superclaw-max。

任务（在 LLMgate 仓）：
1. 读 backend/app/api/v1/bridge.py 的 /exchange、/keys/ensure、/keys/rotate handler，搞清 key 当前如何创建、group_id 从哪来。
2. 在 /exchange（或 key 创建处）解析 payload.tier → 查 group_slug=superclaw-{tier} → 取该 group_id → 创建/rotate key 时写入 key.group_id（替代 None）。tier 缺省/非法时 fail-closed（拒绝或落最低档，按 LLMgate 既有约定，别静默落到全量池）。
3. 确认对应的 superclaw-core/plus/max group 在 LLMgate 已存在（暴露的模型池正确：至少 opus/sonnet，按套餐差异）；不存在则补建或记录为前置。
4. （可选，若报告要求）新增 GET /api/v1/bridge/packages catalog 端点，返回 [{id,name,group_slug}]，供 ClawHunt utils/llmgate_relay.list_relay_package_catalog 消费。
5. 写 LLMgate 侧测试覆盖 tier→group 绑定。

约束：
- 只在 LLMgate 仓改；ClawHunt 一行不动。
- tier 解析 fail-closed，绝不让非法 tier 落到全量/免费池。
- 中文注释。

交付：LLMgate bridge handler 改动 + 测试；并在 ClawHunt docs/llmgate-superclaw-package-bridge-report.md 末尾追加「已修复」记录。
```

**验收标准**：选 plus/max 后签发的 key 实际绑定 `superclaw-plus/max` group；非法 tier fail-closed；LLMgate 侧测试绿。
**备注**：本地联调第一步可先用 v1 固定 key 跳过本任务（PRD 决策点 3 第一步）；本任务是「计费正确性」闭环，可与前端并行，但属第一期验收口径 3。

---

> ### ✅ 验收检查点 C（Task 3.1–3.2 完成后停下）
> 汇报：计费链路是否真正按套餐绑定。若 LLMgate 仓暂不可改，记录为阻塞、本地继续用固定 key 推进，等业主协调 LLMgate 侧。

---

### Checkpoint D — 多租户隔离 + 链路稳定（G7）

---

#### Task 4.1 — 两个真实租户端到端互不串集成测试

**状态**：`[ ]`
**预计**：2h
**目标**：补现有单测（全用假 provider）缺的「两个真实租户端到端互不串数据/串计费」集成测试。
**涉及**：`backend/superclaw_embed/tests/`（参考 `test_isolation.py`/`test_e2e.py`/`test_process.py`），新增 `test_real_isolation_e2e.py`

**AI 提示词**：
```
你是一位资深测试工程师，精通多租户隔离测试、并发、HTTP 流式 mock。ultrathink。

仓库：c:/Users/LiuKe/Desktop/AI-coding/AutoPilotWork/clawproduct-hunt
现有测试：backend/superclaw_embed/tests/（test_tenant/isolation/process/sandbox/e2e/...），已覆盖 profile/路径/token/key/port/进程隔离，但都用假 relay_key_provider、串行 asyncio.run，缺以下端到端互不串场景。

任务：新增 backend/superclaw_embed/tests/test_real_isolation_e2e.py，覆盖（用桩后端模拟子进程，无需真模型）：
1. 用户 A 的 relay key 不会被用到用户 B 的请求：A、B 各 resolve → 各自 spawn → 验证 B 进程 env 里的 SUPERCLAW_RELAY_API_KEY 是 B 的、绝不是 A 的。
2. 两租户并发 chat（asyncio.gather），各自走各自端口/进程/key，互不串（现有测试是串行，这里要并发）。
3. relay key 401 后 recycle + 重取 key 再发请求的完整链路（区别于现有只测 control token 串号）。
4. tier 切换（plus→max）后进程指纹变 → 重起 → 新 group key 注入正确。
5. HOME/SUPERCLAW_HOME 下凭据缓存文件（如 clawhunt-auth.json）跨租户不互读。

约束：
- 不削弱被测的隔离/fail-closed 语义；测试是验证不是放宽。
- 归入串行测试家族（真子进程/签名类按 SuperClaw 测试纪律串行跑）。
- 中文注释。

交付：test_real_isolation_e2e.py，本地 pytest 全绿。
```

**验收标准**：新增集成测试全绿，覆盖跨租户 key/数据/缓存/并发/recycle/tier 切换不串。

---

#### Task 4.2 — 链路稳定性 + fail-closed 端到端验证

**状态**：`[ ]`
**预计**：1.5h
**目标**：验证 spawn → ready → chat → 回收 全程稳定，异常路径 fail-closed（容量满 503、上游 401/500 如实透传、就绪超时不挂死）。
**涉及**：`backend/superclaw_embed/`（process/readiness/proxy/gateway）、测试 + 一份稳定性报告

**AI 提示词**：
```
你是一位资深 SRE 与可靠性测试工程师，精通进程池、超时、错误透传、fail-closed。ultrathink。

任务：针对 ClawHunt embed 层链路稳定性补测试 + 端到端验证：
1. 容量满且全忙 → CapacityError → HTTP 503（不静默排队、不串租户）。
2. 上游子进程返回 401/500 → 经 proxy 如实透传状态码（不被吞成 200）。
3. wait_ready 超时 → 明确报错、释放租约、不挂死、不留僵尸进程。
4. idle TTL 回收 + LRU 逐出后再次请求能正确重起。
5. 子进程崩溃 → 下次请求自动重起（已有 test_process 覆盖部分，补端到端经 gateway 的验证）。
检查现有 test_process/test_e2e 已覆盖的别重复，只补缺口。

约束：
- 不削弱 fail-closed；验证而非放宽。
- 串行家族；中文注释。

交付：补充测试 + specs/v3-第一期-链路稳定性报告.md（中文，SuperClaw 仓）：各异常路径行为 + 证据。
```

**验收标准**：异常路径全部 fail-closed 且有测试覆盖；无僵尸进程；稳定性报告落档。

---

> ### ✅ 验收检查点 D（Task 4.1–4.2 完成后停下）= 第一期总验收
> 对照 PRD 第一期验收口径逐条核对：
> 1. web 出真答案 ✅（Checkpoint B）
> 2. 多租户隔离正确 ✅（Task 4.1）
> 3. 计费走对套餐 ✅（Checkpoint C，或记录 LLMgate 阻塞 + 固定 key 兜底）
> 4. 链路稳定 fail-closed ✅（Task 4.2）
> 5. 用 v1 llmgate key 打通 ✅（Task 1.2）
> 通过后：第一期收口，规划第二期 PLAN（G5 持久化 + G6 安全 P0 + 线上发放 + iOS）。

---

## 验收检查点总览

| 检查点 | 任务 | 验收内容 |
|--------|------|----------|
| A | 1.1–1.2 | 本地 embed 起得来 + v1 key 打出真答案（curl） |
| B | 2.1–2.3 | **web 端聊出真答案**（第一期核心口径 1） |
| C | 3.1–3.2 | 计费按套餐绑定（缺口在 LLMgate，跨仓） |
| D | 4.1–4.2 | 多租户隔离 + 链路稳定 fail-closed = **第一期总验收** |

## 提交纪律（每个 Checkpoint 收尾）
- 本地相关测试绿 + `ruff check` 干净 → Codex(`gpt-5.5`) + Gemini 批判性验收（两者都「无阻断」）→ 原子化 commit（一事一提交、约定式、无 AI 署名）。
- 跨 ClawHunt / LLMgate 两仓的改动各自独立提交，不混提。
- 隔离 worktree 开发；提交前 `git fetch` 吸收最新 main。

---

## 状态标记说明
`[ ]` 未开始 | `[x]` 已完成 | `[!]` 需修改
执行命令：「继续」/「下一个」推进下一任务或检查点；「查看进度」看完成情况。
