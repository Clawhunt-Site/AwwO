# Coexist 生产/桌面单一前门设计（Python front-door reverse proxy）

> 状态：定稿（经 Codex GPT-5.5 + AgY Gemini 3.1 Pro 各两轮对抗评审 + 本地逐文件核验，2026-06-29）。
> 目标：让 coexist 的**全部 Node 后端功能**（Node chat 引擎、嵌入式 board `/paperclip-api`、插件 UI `/_plugins`、`/api/plugins/global`、adapters 等）在**打包桌面 app** 与**浏览器开 Python 端口**两种部署下都真正工作。

## 1. 问题（已三方确认）

vite 的 proxy 分流**只在 `vite dev`+`vite preview` 上班**（`apps/web/vite.config.mjs` 注释自承"inherent coexist deployment requirement"）。生产/桌面里 Python 托管 `web/dist` 但无等价前门：
- **(A) Node 独有路由 → 真 404**：`/paperclip-api/*`、`/_plugins/*`、`/api/plugins/global`、`/api/adapters`（Python 完全没有）。
- **(B) 共享路由 → 静默走 Python 老引擎**（比 404 隐蔽）：`/api/chat /api/agents /api/backends /api/workspaces /api/runs /v1/skills`。
- **桌面更糟**：webview 从 `tauri://localhost` 加载静态包；`/api/*` 经 `buildDesktopApiUrl` 拼到 Python base 能到 Python，但 `/paperclip-api`、`/_plugins` 走相对路径落 `tauri://localhost` → 挂；且 frozen 打包**未嵌 node + server/server** → `is_runnable()` 假 → Node 根本没起。

## 2. 方案（4 组件）

### C1 路由归属 manifest（单一事实源）
新增 `packages/superclaw/src/superclaw/node_routes.json`——**环境无关**的 checked-in JSON，是 dev proxy 与生产/桌面前门的**唯一**路由归属来源（替代 vite 里硬编码的 `nodeOwnedProxy`）。
- `vite.config.mjs` import 这份 JSON 生成 proxy；Python 侧 typed parse/validate（`node_routes.py`）。两端永不漂移。
- 条目 schema：`{ prefix, rewrite?: {from,to}, ws?: bool, sse?: {method,path} }`。
- 覆盖：`/paperclip-api`(rewrite→`/api`, ws)、`/_plugins`、`/api/chat`(sse: POST `/api/chat/stream`)、`/api/workspaces /api/runs /api/backends /api/agents /v1/skills`，以及明确 Node 归属的 `/api/plugins/global`、`/api/adapters`。
- **不**整段转 `/api/plugins`（Python 有大量 plugin 治理/安装/诊断路由）；只列明确 Node 归属子路径。
- ⚠️ `/api/backends`、`/api/agents` 既是 Node 又是 Python 老引擎——转 Node 是**语义 cutover 不是无害代理**。需配契约测试，且在 PR 说明里写明这是有意切换。

### C2 Python 前门反代（HTTP + SSE + WS，fail-closed）
在 `apps/api` 加反代，对 manifest Node-owned 前缀转发到 co-launched Node（**实际**端口，经 `app.state` 注入，**非**硬编码 3100——Node 端口会 detect-port 漂移）。
- **HTTP**：**前置 ASGI middleware** 按 manifest 前缀拦截（**不能**在现有路由后补 catch-all——Python 老 `/api/chat` 等会先命中）。httpx 流式透传；**请求体也要流式**（禁 `await request.body()`，否则大文件上传 OOM）；过滤 hop-by-hop headers。
- **SSE**（`POST /api/chat/stream`）：`httpx.stream` + `StreamingResponse`；**`timeout=None`**（禁默认 read timeout，否则长连接被悄悄掐）；`aiter_raw()`；客户端断连（`asyncio.CancelledError`）时**显式关闭上游** httpx request（防 Node 端幽灵挂起）。
- **WS**（Node 实际 `/api/companies/:companyId/events/ws`，经 `/paperclip-api` rewrite）：**独立 `@app.websocket` 路由**（middleware 不处理 websocket scope）。`asyncio.gather` 双向 recv-forward / backward-send；**任一端断开必须主动 kill 另一端**（防僵尸连接拖死进程）；覆盖 path/query/subprotocol/close-code。
- **fail-closed**：Node 不可达 → Node-owned 前缀返回 **503 + 诊断 JSON**（格式对齐现有错误契约，否则前端白屏），**绝不** fallthrough 到 Python 老引擎。
- ⚠️ Node `local_trusted` 鉴权与 Python `control_token` 是两套安全模型；明确哪些 Node-owned 路由在前门仍需 Python token/session 门禁。

### C3 把 node + server/server 嵌进 .app（打包前提）
**选型：真 node 二进制 + pruned 生产 node_modules 运行时树**（Codex 主张，胜出）。
- 不选 bun `--compile`/Node SEA：`server/server` 有 Express/WS/DB migrations/动态插件 loader/动态 assets/native deps，单文件打包最易在模块解析、native binding、migrations、plugin loader 上碎（clawwork 的 bun 单二进制先例只证明**小治理扩展**可行，不证明整个 Node server 可行）。AgY 倾向 SEA+esbuild，但同样受动态 require/plugin-loader 限制——故采保真路线。
- 不选 raw dev node_modules（几万小文件 → codesign/dmg 慢且 updater 差分易错）；用 **pruned prod-only 树** + deep 签名折中。
- `tauri:build` 增 `pnpm install && pnpm -r build` 构建 server/server；`prepare-macos-bundle.mjs` 拷 node 二进制 + server/server 运行时树进 `Resources/`。
- 桌面 spawn Python 时注入 `SUPERCLAW_NODE_BIN` / `SUPERCLAW_NODE_SERVER_DIR` 指向 Resources（frozen shim 设置，镜像现有 frozen 路径注入），使 `is_runnable()` 真。
- ⚠️ `PAPERCLIP_HOME` 必须落 **writable** app-support，**不可**写进 signed Resources。

### C4 桌面 webview 寻址 —— **已定：D2 + 安全加固**（主代理裁决 2026-06-29）
两路顾问在此**分歧**（都否决 D1）。主代理按"正确性优先（三协议单一同源路径、最少分叉）"裁决选 **D2**；AgY 的 IPC 安全顾虑用 Tauri v2 loopback-only origin + 作用域 capability + 导航白名单 + CSP 收敛（PR5 落地时让两路顾问逐条钉死配置）。D2/D3 仅影响 PR5；PR1–PR4 与之无关，故 D2 现在锁定零风险、必要时 PR5 可无损改回 D3。两选项备忘：
- **D2（Codex 主张，本设计推荐）**：webview 改为从 `${pythonBase}/` 加载；全部 `/api`、`/paperclip-api`、`/_plugins`、SSE、WS 同源进 Python 前门，**前端零特例**。代价=Tauri IPC 安全模型：需加 loopback-origin capability、导航白名单、CSP；Python 静态服务补 SPA catch-all（当前只挂 `/`+`/assets`）。
- **D3（AgY 主张）**：webview 仍在 `tauri://localhost`，Rust 侧 `register_uri_scheme_protocol` 拦截 `/api`、`/paperclip-api`、`/_plugins` 转发给 Python sidecar，前端零改、IPC 不泄漏。**致命限制**：wry 自定义协议**难做 WS upgrade**、SSE 流式也 finicky → WS/SSE 仍需回退绝对 URL（部分 D1），对"完整功能"不利。
- **推荐 D2**：因 SSE+WS 都需同源才干净，D2 是唯一让三种协议都"天然工作"的；D2 的 IPC 风险可经 loopback-only + capability scoping + nav allowlist + CSP 收敛（且本地 bundle XSS 在 tauri:// 下同样可被攻破，增量风险有限）。**但属安全模型决策，待业主拍板。**

## 3. 实施顺序（PR 拆分，两路一致）
1. **PR1 契约**：`node_routes.json` + vite 读取 + Python `node_routes.py` parser/排序测试。**行为不变**（dev proxy 等价）。
2. **PR2 Python HTTP/SSE 前门 + fail-closed**：证明 Node absent 时 `/api/chat` 返回 503 而非 Python 老引擎。**点亮浏览器**。需把 supervisor/base URL 注入 FastAPI `app.state`（当前 cli.py 启 Node 后未注入）。
3. **PR3 WS bridge**：先覆盖 `/paperclip-api/.../events/ws`。
4. **PR4 桌面封箱（C3）**：真 node + server/server 树 + env 注入；集成进 `prepare-macos-bundle.mjs`。
5. **PR5 桌面寻址（C4）**：按业主拍板的 D2（或 D3）落地 + Tauri capability/nav/CSP（D2）/ Rust 协议拦截（D3）。
6. **PR6 真 `.app` 验收**：UI 从 Python origin 加载、`/_plugins`→Node、`/paperclip-api` rewrite、`/api/chat/stream` 是 Node SSE、WS 可连、**杀 Node 后 Node-owned 前缀 503 不回退**。

每个 PR 走铁律：实现 → Codex+AgY 双验收 → 原子提交。

## 4. 待业主决策
- **C4：D2（推荐）还是 D3？** D2 = webview 走 Python loopback origin（三协议天然同源，IPC 需 capability 收敛）；D3 = Rust 协议拦截（IPC 最隔离，但 WS/SSE 需部分回退绝对 URL）。
- C3 内嵌 node 会显著增大 `.app` 体积与签名时间——确认可接受。

## 4.5 实施进度（2026-06-29）

- **PR1 ✅** committed (`1ef0bd0f`)：路由 manifest 单一源 + vite 读同源 + 双侧 fail-closed 校验。
- **PR2 ✅** committed (`d624e2e5`)：Python 前门 HTTP/SSE 反代，marker 三态门控 + fail-closed + 最内层中间件；manifest 加 `match:prefix|exact`（/v1/skills exact、/api/runs 移除）。
- **PR3 ✅** committed (`68b35fd6`)：WS 桥（websockets 依赖）+ kill-both + 转发真实 close code。
- **PR4a ✅**（内核运行时半）：`node_runtime._frozen_node_runtime_dir()` + resolve_node_executable/server_dir 的 frozen 分支——frozen 下自动发现 `<sys.executable dir>/node-runtime/{node, server/}`，双在 fail-closed，绝不回退 ambient。**布局契约**：PR4b 必须把 node 二进制放 `node-runtime/node`、把构建好的 server 树放 `node-runtime/server/`（含 `dist/index.js` + prod `node_modules` + `package.json`）。
- **PR4b / PR5 / PR6 ⏳ 需构建机**（headless 不可验证，须业主 `npm run tauri:build:production` + 真机验收，建议 build-loop：我写→你构建→报错→我修）。

### PR4b 规范（嵌 node + server 进 .app）
照 ClawWork 嵌块先例（`prepare-macos-bundle.mjs` 第 121-182 行：拷二进制+树进 `backendDest/clawwork/` + chmod + codesign）：
1. **新建 `apps/desktop/scripts/build-node-server.mjs`**（在 tauri:build 链中、`tauri build` 之前调用）：
   - 构建 server/server：`pnpm install`（在 `server/`）→ `pnpm --filter ./server build`（`tsc` 产 `dist/index.js`）→ `pnpm --filter ./server prepare:ui-dist`（产 `ui-dist`）。
   - 准备 prod `node_modules`：对 `server/server` 做 `pnpm install --prod`（或 `pnpm deploy --prod`）得 pruned 树。⚠️ 保留 native `.node`（better-sqlite3/ws 等）。
   - 准备 node 二进制：下载**钉死版本**官方 Node macOS arm64（如 `node-v20.x.x-darwin-arm64`），取其 `bin/node`；落到一个 staging 目录（如 `apps/desktop/backend/dist/node-runtime/{node, server/}`）。**勿用构建机 PATH 的 node**（版本/依赖不可控）。
2. **`prepare-macos-bundle.mjs` 加嵌块**（ClawWork 块之后）：把 staging 的 `node` + `server/` 拷进 `backendDest/node-runtime/`（`backendDest` = `Resources/backend/superclaw-backend/`，与 clawwork 同锚）；chmod node 0o755；**codesign**：先扫 `node-runtime` 内全部 Mach-O（node 二进制 + 所有 `.node`）逐个签，带 `macos-backend-entitlements.plist`。
3. **`tauri:build` 链**（package.json）：`node scripts/build-backend.mjs && node scripts/build-clawwork-binary.mjs && node scripts/build-node-server.mjs && tauri build ... && node scripts/prepare-macos-bundle.mjs`。
- **验收（PR4a 已就绪）**：嵌好后，frozen app 里 `resolve_node_executable()`→`node-runtime/node`、`resolve_node_server_dir()`→`node-runtime/server`、`is_runnable()` 真 → Python service 启动时 co-launch Node → 写 marker → 前门激活。

### PR5 规范（桌面 D2 寻址 + Tauri 安全加固）
1. **webview 走 Python origin**：桌面 runtime 启动得到 Python `base_url` 后，让主 webview 从 `${base_url}/` 加载（而非 tauri://localhost 的静态包）。需 Python 静态服务补 **SPA catch-all**（当前只挂 `/`+`/assets`，深链接 404）。
2. **Tauri v2 安全加固**（落地前让 Codex+AgY 逐条钉死）：`capabilities` 作用域到该 loopback http origin；导航白名单仅允许 `127.0.0.1:<port>` + `tauri://`；CSP `connect-src` 锁 self + loopback。loopback-only（非 remote domain）。
3. 备选 D3（Rust 协议拦截）仅当 D2 安全加固不可接受时回退（WS/SSE 需部分绝对 URL）。

### PR6 验收清单（真 .app，构建机）
`npm run tauri:build:production` 后装 .app，逐项：① UI 从 Python origin 加载；② board `/paperclip-api/*` 通（非 404）；③ `/_plugins/*` 插件 UI 字节通；④ `/api/chat/stream` 是 **Node** SSE（非 Python 老引擎）；⑤ board 实时 WS 可连且收事件；⑥ **杀掉 Node 进程** → Node-owned 前缀返 503（HTTP）/ 拒握手（WS），**不回退 Python 老引擎**；⑦ `/v1/skills/build` 等仍走 Python。

## 5. 隐藏翻车点（落地必盯）
- **端口**：Python 统一决定所有端口（现有 `env["PORT"]=self.port` 已如此），经 env 传 Node；前门用 `app.state` 注入的**实际** base URL，不信硬编码 3100。
- **/_plugins 静态资源**：插件 CSS 里 `url(/font.woff)` 等根相对 URL 经 proxy 到 Node，前缀处理不当则 404 满天飞——path rewrite 是高发区。
- **大请求体**：必须流式透传，否则 Python OOM。
- **WS 生命周期**：任一端断必须 kill 另一端，否则僵尸连接累积拖死 Python。

## 6. 最终状态（2026-06-29）

| PR | 内容 | 状态 |
|---|---|---|
| PR1 `1ef0bd0f` | 路由 manifest 单一源（vite+Python 双侧 fail-closed 校验） | ✅ 提交·Codex PASS |
| PR2 `d624e2e5` | Python 前门 HTTP/SSE 反代·marker 三态门控·fail-closed·`match:exact` | ✅ 提交·Codex PASS·**真浏览器端到端验证** |
| PR3 `68b35fd6` | WebSocket 桥（kill-both·转发真实 close code） | ✅ 提交·Codex PASS·**真 Node WS 验证** |
| PR4a `19c8dd6d` | frozen 自动发现内嵌 node-runtime（双在 fail-closed） | ✅ 提交·Codex PASS |
| PR4b `23e256d3`+`4eb765e6` | 产出自包含 node-runtime 并嵌进 .app | ✅ 提交·Codex PASS·**真签名 .app 验证：内嵌 node24 co-launch + 前门代理 + fail-closed** |
| SPA `3441a758` | Python SPA catch-all（深链接） | ✅ 提交·TestClient 验证 |
| PR5 `152bee5e` | 桌面 **D1**-hardening（非 D2，保住"本地源独占 IPC"周界） | ✅ 提交·Codex 代码层 PASS·web 编译+WS 单测+CORS 预检验证 |

**桌面寻址决策反转 D2→D1（关键）**：实现到 PR5 才发现 `lib.rs` 注释揭示的刻意安全周界——**只有 `tauri://localhost` 有 Tauri IPC，远程源被 ACL 拒**（业主批准，`browser_url_is_navigable` 守卫 enforce）。D2（导航主窗口到 loopback http origin + 授 remote IPC）会**破这个周界 = 单向门**。经 Codex 评审改走 **D1-hardening**：主窗口留 `tauri://localhost`（IPC 本地独占不破），只**数据 URL**经单一运行时旋钮 `globalThis.__SUPERCLAW_PY_ORIGIN__` 跨源到前门 loopback。

## 7. 剩余工作（未完成）

### PR6：真 .app GUI 验收（唯一剩余，需在构建机/真机跑）
后端 + 前门 + 内嵌 Node + D1 寻址的**代码全部完成且验证**；唯一未做的是**打开真 .app 的图形界面、肉眼确认 board 渲染**（本环境 GUI 冷启 flaky，frozen backend 直跑已验证后端面）。验收步骤：

```bash
cd apps/desktop && npm run tauri:build:staging     # 重建签名 .app（约 10-15 分钟）
open src-tauri/target/release/bundle/macos/SuperClaw.app
```
逐项肉眼确认（都应工作，因后端已验证）：① 打开公司 → **board 渲染**（`/paperclip-api/*` 经前门→内嵌 Node）；② 发 chat → **流式输出**（SSE）；③ board **实时更新**（WS，`ws://127.0.0.1:<port>`）；④ **插件 iframe + slot**（`/_plugins/*`，slot 走 blob-module import 需 CSP `script-src blob:`——已加）；⑤ 内容**图片/媒体**（CSP loopback img/media-src——已加）；⑥ 杀内嵌 Node 进程 → board 报错而非崩（fail-closed）。

**已知前提**：frozen backend 直跑（`<app>/.../superclaw-backend -m superclaw.cli service ...`）已实测：内嵌 node24 co-launch、前门 `/paperclip-api`+`/api/backends` 代理返真实数据、CORS 预检返 ACAC、杀 Node→503。所以 PR6 主要验证**前端在真 webview 里**的渲染（CSP/CORS/URL 派生在真 Tauri WebView 下的实际行为），后端面已闭环。

### Follow-ups（非阻断，Codex/AgY 标记）
- **回归测试（建议补）**：CSP 断言 `script-src blob:`；运行时注入后 `apiBase`/`frontDoorOrigin`/`paperclipApiBase` 的实际输出快照（防未来回归）。
- **生产 hardened 签名**：`tauri:build:production`（hardened runtime）下内嵌 node 的 V8 JIT 需 `allow-jit` entitlement——当前用 `backendEntitlements`（已含 allow-jit），但**未在真 hardened+notarized 构建验证**（无 Developer ID 证书）。
- **.app 体积 ~1.3GB**（内嵌 node-runtime ~1.2GB）：vendored server 固有体量，后续可 prune（drizzle-kit/jiti 等 dev 工具仍在 deploy 树）。
- **桌面 build 仅 macOS**（所有 build 脚本 `process.platform!=="darwin"` skip）；Win/Linux 出包需各自的 prepare-bundle + 签名机制。
- **D3 备选**：若将来要彻底脱离 loopback 跨源（连 CORS/CSP 都不想要），可改 Rust `register_uri_scheme_protocol` 拦截——但 WS upgrade 仍需绝对 ws://（部分 D1），比当前纯 D1 更乱，非必要不动。
