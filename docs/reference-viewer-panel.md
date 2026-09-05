# Reference Viewer Panel — 对话引用查看器（设计简报 R3）

状态：**A 线（文件查看器）设计收敛 → 实现中；B 线（preview-proxy）→ R4 待重审**
（R1 双不通过 → R2 agy PASS/Codex 不通过 → R3 两路不通过但 A 线零新阻断、确认 B2/B3 消除）
归属规划：`docs/codex-like-agentos-app.md`（Context Rail 表面的能力补全）、`docs/short-term-roadmap.md`

## 评审历史

- **R1（Codex gpt-5.5 + Gemini 3.1 Pro，均"不通过"）**：网络/桌面/敏感三个安全面留成"开放问题"，必须实现前定死。阻断项并集见 §9，已吸收进 R2。
- **R2（agy PASS；Codex 读真实代码后"不通过"）**：Codex 抓出 3 个 R2 残留/新增阻断（已本地核验属实）：
  - **B1 未真闭合**：纯前端字面拦内网挡不住 DNS rebinding/CNAME/302 跳转 → 业主拍板"**现在就做内核 preview-proxy**"（服务端取页+SSRF 护栏），见 §2.1/§3.5。
  - **B2（代码事实）**：`RunSession` 无 `workspace_id` 字段，只有 `execution_context`；`workspace.repo_path` 对 worktree stale，当前物理 checkout 应读 `identity["canonical_path"]`。受信根改为 run 自己的 `execution_context["repo_path"]`，见 §3.2。
  - **B3**：敏感扫描与截断顺序未定死会 fail-open，见 §3.3。
  - agy 非阻断防坑（已纳入实现）：UTF-8 截断用 `errors='replace'`；内网名单含 `0.0.0.0/8`；`is_relative_to` 前 root 也 `resolve()`；绝对 `rel_path` 提早拒绝。
- **R3（两路均"不通过"，但确认 B2-R2/B3-R2 已消除）**：新阻断全部聚集在 preview-proxy（文件查看器 A 线零新阻断 → **A 线设计收敛，先行实现**）。preview-proxy B 线阻断并集 → R4（待重审）：
  - **P1 iframe 鉴权**（双）：`<iframe src>` 带不了 header → 两步票据：前端 fetch+控制 token 换一次性短 TTL `preview ticket`，iframe 只加载同源 `/api/preview/{ticket}`，控制 token 绝不进 URL。
  - **P2 子资源 SSRF**（Codex）：`CSP: sandbox` 不挡网络子资源；远端 HTML 的绝对 `<img src=http://127.0.0.1>`/`<iframe>`/`meta refresh`/css/font 仍由浏览器直发，绕过服务端护栏 → 另一条路重开 B1。修：子资源一律经护栏代理（服务端重写其 URL 为 `/api/preview/{ticket}/sub?u=`，同 SSRF 校验）+ 严格 CSP（`default-src 'none'`，`img-src`/`style-src` 限同代理源，`frame-src 'none'`、`form-action 'none'`、`base-uri` 锁定）+ 清理 script/iframe/object/form/meta-refresh。
  - **P3 HTTPS SNI/pin-IP**（双）：不可"换 host 为 IP"（破坏 SNI+证书）。修：自定义 httpx resolver/transport 保留原始域名做 SNI+证书校验，socket 连已校验 pin 的 IP；绝不 `verify=False`；加 SNI/证书回归测试。
  - **P4 上游 XFO/CSP 剥离**（agy）：回流时丢弃上游 `X-Frame-Options`/`Content-Security-Policy`，只留我们的 `CSP`+`nosniff`+剥 `Set-Cookie`。
  - **P5 Desktop 契约统一**（Codex，我文档自相矛盾）：定死 Desktop 经同一本地 preview-proxy 内嵌（CSP-sandbox opaque origin 隔离 Tauri IPC），外开仅作护栏拒绝/超时兜底；§5/§7 措辞与 §2.2 对齐。

## 1. 目标（用户诉求）

参照 Codex / Claude Code：在 Web/Desktop 工作台右上角展开的右侧栏里

1. **对话中出现网址** → 在 sandbox web view 中打开（站点拒绝内嵌时退回外部浏览器打开）。
2. **对话中出现文件路径** → 查看文件内容（`.md` 渲染富文本，文本/代码等宽，二进制只给元数据）。

第一批范围（业主确认）：Web + Desktop；**只做单文件查看 + 网址 webview**（不做文件树）；webview = **显式点击加载 + 失败兜底外开**（R1 修正：非"自动全量内嵌"）。

## 2. 宪法定位

### 2.1 网址 web view = **内核 preview-proxy**（铁律①，R2 修正）

> **⚠️ 本节为历史早期描述（raw-HTML 代理）。preview-proxy 的权威设计以 §10（R10 双 PASS 收敛）为准——v1 是 sanitized non-navigable reader + JSON+srcdoc，非 `/api/preview?url=` 直回 HTML。实现以 §10 为唯一依据。**

R1/R2 裁决：URL 直接塞 iframe 由用户浏览器/Tauri 环境取页，纯前端拦不住 DNS rebinding/CNAME/302 跳转的内网探测面。业主拍板**现在就做内核 preview-proxy**——取页搬到服务端、带 SSRF 护栏，前端只内嵌**同源代理 URL**：

- 能力进内核 `web_preview.py`（CLI `superclaw web preview` 先行暴露，见 §4），API `GET /api/preview?url=` 调同一份。
- 前端 iframe 指向**本应用同源**的 `/api/preview?url=<target>`；目标页由后端在 SSRF 护栏下抓取并回流（DNS rebinding 失效：解析与连接都在服务端、且 pin 已校验 IP）。
- 护栏细节见 §3.5。响应以 `Content-Security-Policy: sandbox`（opaque origin，脚本碰不到本应用源/存储）+ 客户端 `<iframe sandbox referrerPolicy=no-referrer>` 双层隔离。
- **绝不自动预加载**：面板默认"点击以预览"占位，显式点击才请求代理。
- 失败（站点拒绝/超时/护栏拒绝）→ 面板常驻"在外部浏览器打开"兜底（不靠 XFO/CSP 探测）。
- 已知局限：代理不重写相对子资源 URL，JS 重站点样式/交互可能不全——这是"预览"，要完整体验用外开。

### 2.2 Desktop（Tauri）

- Desktop 同样**经本地 preview-proxy 内嵌**：内容由本地 API 服务端取（带护栏），以 `CSP: sandbox` opaque origin 渲染，**碰不到 Tauri IPC**（IPC 绑应用源）——消除 R1 的"远程页进主窗口 IPC 面"风险。
- 直接外开通道仍在（走 Tauri opener/`desktopInvoke`），作为护栏拒绝/超时兜底。
- 文件查看器在 Desktop 正常内嵌（本地受信内容）。

### 2.3 文件查看器 = 新内核能力（铁律①，切分正确，R1 确认）

读取受信工作区文件，先做内核函数 → CLI → 契约 → API → 表层。安全边界见 §3。

## 3. 内核能力设计（文件查看器）

### 3.1 函数与契约对象

```python
def read_run_file(store, run_id, rel_path, *, max_bytes=FILE_VIEW_MAX_BYTES) -> FileViewResult
```

`FileViewResult`：`path`(回显相对路径，绝不泄露绝对根) / `mime` / `is_text` / `content`(文本，截断后；二进制/敏感为 None) / `size_bytes` / `truncated` / `encoding`。

**统一错误对象（R1-B8，契约先收敛；实现态最终码集）**：内核抛 `FileViewError(code, message)`，`code ∈ {not_found, path_not_allowed, untrusted_workspace, workspace_compromised, sensitive_denied, sensitive_scan_unbounded}`（即 `FILE_VIEW_ERROR_CODES`，由 `build_file_view_contract()` 精确投影给各表层）。二进制不是错误而是正常结果（`is_text=False, content=None`，无下载）。CLI/API/Web/Desktop 共用同一 code→展示映射，进 `ui_contracts.py`。**`max_bytes` 一律截断 + `truncated=True`，不返回 413**（去掉 R1 指出的二义）。

### 3.2 受信根 + 授权边界（R2-B2/B6 修正）

- **受信根 = run 自己的 `execution_context["repo_path"]`**（run 创建时已 `Path(repo_path).resolve()` 存入；见 orchestrator.py:1738）。**不**用 `workspace.repo_path`（R2-B2：对 worktree stale，会读到同 workspace 另一 checkout 的同名文件，与本 run 证据不一致）；run 无 `workspace_id` 字段。
- **信任校验**：用 `workspace_resolver` 把该 `repo_path` 解析到覆盖它的 workspace，**要求 `workspace.is_trusted`（`trust_status==ACTIVE`）**，否则 `untrusted_workspace` 拒绝。**不**用创建期 `trust_confirmed` 判运行期信任（R2-B6）。
- managed 真文件夹：读取前 **inode-pin 复核**（`assert_managed_dir_unchanged`），被替换/篡改 → fail-closed 拒绝。
- 文件读取**只限该 run 物理 checkout 内文件**；artifact 仍只经既有 `artifact_id`/`ArtifactRef` 端点（带 sensitivity 元数据）读取，**不**开任意 path 扫 artifact root（R1-B4）。
- 授权边界：单运营者本地控制面，API 边界 = `require_control_token` + 上述 **workspace trust 门**（与执行同一道 fail-closed 门）。run_id 本身不是授权边界。
- 纯 chat：managed Chat workspace 也是 ACTIVE → 支持其 checkout 下文件查看。

### 3.3 sensitivity（R1-B3 + R2-B3，core fail-closed，扫描顺序定死）

判敏顺序（fail-closed，**不脱敏**——脱敏篡改语义违反零偏差；命中即 `sensitive_denied`，不返文本不给下载）：

1. **文件名/路径 deny 先行**（不读字节即可判）：`secrets_scan` + `_SENSITIVE_KEY_RE` + 文件名 denylist `.env`/`.env.*`/`*.pem`/`*.key`/`id_rsa*`/`id_ed25519*`/`*.p12`/`*.pfx`/`credentials`/`.netrc`/`.npmrc`/`.pypirc`/`*.sqlite`/`*.db`/`*.gpg`/`secrets.*`。denylist 进内核单一常量，CLI/API/Web 共用。
2. **二进制探测**（NUL/utf-8 解码失败）→ 只回元数据、拒下载。
3. **内容敏感扫描**（R2-B3 定死边界）：设 `FILE_VIEW_SCAN_CAP ≥ FILE_VIEW_MAX_BYTES`。文件 ≤ scan cap → 全内容 `contains_secret` 扫描，命中则 deny；文件 **> scan cap → `sensitive_scan_unbounded` fail-closed 拒绝**（无法在受控上限内保证不含敏，绝不"读 max_bytes 后扫"让边界外秘密漏出）。展示 `content` = 已扫描缓冲截断到 `max_bytes`（`errors='replace'` 吃残缺多字节，见 agy 防坑）。

### 3.4 path-safety（R1 + 既往教训）

- 目标 = `(root/rel_path)`，**先 `realpath`/`resolve()` 完整解析 symlink，再 `is_relative_to(root)`**（既有 `_path_is_within`），绝不字符串前缀比对。拒绝绝对路径 / `..` 逃逸 / symlink 指向根外。
- 复用 [[visible-project-folders]]：world-writable 祖先豁免 sticky-bit（`st_mode & 0o022 and not S_ISVTX`），避免 Linux `/tmp`=1777 误拒（重演 PR#282 全红）。
- 跨平台注意（R1）：Windows ADS（`file.txt:hidden`）/8.3 短名——`resolve()` 后校验，必要时拒绝含 `:` 的可疑分量。
- 二进制探测（NUL / utf-8 解码失败）→ `is_text=False`，**只回元数据，拒绝下载**（R1-B7：repo workspace 二进制不开下载，避免绕过 max_bytes 与敏感扫描；下载仅限既有受授权非敏感 artifact）。
- agy 防坑：组装前 `if Path(rel_path).is_absolute(): -> path_not_allowed` 提早拒；比对用 `(root/rel_path).resolve().is_relative_to(root.resolve())`（root 也 resolve）。

### 3.5 preview-proxy SSRF 护栏（R2-B1，内核 `web_preview.py`）

服务端取页函数 `fetch_url_preview(url) -> PreviewResult`（流式回流给 API）。护栏（任一不过即 fail-closed 拒绝，返回统一 code）：

- **协议白名单**：仅 `http`/`https`；其余（`file`/`data`/`ftp`/`gopher`/…）拒。
- **host 解析 + 私网拒**：`getaddrinfo` 解析全部 A/AAAA；**任一**解析 IP 属 loopback/private/link-local/ULA(`fc00::/7`)/IPv4-mapped/unspecified(`0.0.0.0/8`,`::`)/reserved/multicast → 拒（用 `ipaddress` 判，含 agy 提的 `0.0.0.0`）。
- **TOCTOU 堵 rebinding**：解析得到合法 IP 后，**连接时 pin 该 IP**（httpx 自定义 transport / 直连 IP + 带 `Host` 头），不给"check 用公网 IP、connect 时 rebinding 到私网"留窗口。
- **重定向手动跟随**：`follow_redirects=False`，逐跳重新 resolve+护栏校验，最多 N 跳；跳到非 http/https 或私网 → 拒。
- **隔离取页**：`trust_env=False`、不带 cookie/凭证、不转发 `Authorization`、超时 + size cap。
- **回流隔离**：响应加 `Content-Security-Policy: sandbox`（opaque origin）+ `X-Content-Type-Options: nosniff`，剥离 `Set-Cookie`；前端 iframe 再套 `sandbox`。
- 定位：用户对**自己看到的具体 URL** 显式点击预览（非扫描/探测），SSRF 护栏即 fail-closed 边界；不另设人审门（与"外开"同级），待顾问确认。

## 4. CLI（基准，铁律①）

```
superclaw file show <run_id> --path <rel> [--max-bytes N] [--json]   # 文件查看器
superclaw web preview <url> [--json]                                  # preview-proxy 能力
```

行为/错误 code 与 API 同序、零偏差；敏感/越权/不受信/二进制/协议/私网各对应 §3.1 统一 code。`web preview --json` 回 `PreviewResult` 元数据（final_url/status/content_type/blocked_reason），不在 CLI 渲染页面。

## 5. API + 表层

- API：`GET /api/runs/{run_id}/files?path=&max_bytes=`，`Depends(require_control_token)`，调 `read_run_file` 同一份逻辑；错误对象 = §3.1 统一 code（措辞不泄露绝对路径）。二进制不在此端点下载。
- 契约：`ui_contracts.py` 新增 `build_file_view_contract()`（能力存在、`max_bytes` 上限、渲染类别、错误 code 表），前端不硬编码。
- Web：复用 `PanelHost` + 三栏 `.context-open` 新增 Viewer 面板；**路径/URL 识别只认 markdown 链接 AST 节点**（R1：不扫自由文本/inline code）：http(s)→web 子视图（§2.1 姿态），指向 run 工作区相对路径→file 子视图。`.md` 复用 `AssistantMarkdown`（**禁 raw HTML、禁自动远程图片**，已是其现状）。
- Desktop：§2.2——URL 仅外开；文件查看正常内嵌。

## 6. 测试矩阵（R1/R2 要求）

文件：symlink escape / 绝对路径提早拒 / `..` / sticky `/tmp` 豁免 / non-sticky world-writable 拒绝 / 敏感 deny（按名+按内容）/ 内容扫描 oversize 超 scan cap fail-closed / artifact sensitivity 不被绕过 / 非 ACTIVE workspace 拒绝 / managed dir 被替换拒绝 / **run worktree 读根正确性（读 execution_context.repo_path 非 workspace.repo_path）** / 二进制只回元数据拒下载 / UTF-8 截断不崩 / CLI↔API parity。
preview-proxy：协议白名单 / 私网+loopback+link-local+ULA+IPv4-mapped+`0.0.0.0` 拒 / **DNS rebinding（check 公网 connect 私网）pin-IP 拦截** / **重定向跳私网逐跳拦截** / 超时+size cap / CSP sandbox 响应头 / 不转发 cookie/Authorization。

## 7. 实施阶段（每阶段原子提交 + Codex/Gemini 双 PASS 才落）

**A 线 文件查看器（安全、先交付）**
1. 内核 `read_run_file`+`FileViewResult`+统一错误+sensitivity（顺序定死）+path-safety/trust（execution_context.repo_path）+ 单测。
2. CLI `superclaw file show` + 契约 `build_file_view_contract` + 测试。
3. API `GET /api/runs/{id}/files` + 测试。
4. Web file 子视图（markdown/text/二进制元数据）+ vitest。

**B 线 preview-proxy（网络敏感、独立闭环）**
5. 内核 `web_preview.fetch_url_preview` + SSRF 护栏（pin-IP/逐跳/协议/CSP）+ CLI `web preview` + 单测。
6. API `GET /api/preview` + 流式回流 + CSP sandbox 头 + 测试。
7. Web web 子视图（同源代理 iframe + 外开兜底）+ Desktop opener 核对 + 冒烟 + vitest。

全部完成后本地跑通完整 `ci.yml` → 吸收 `origin/main` → PR。

## 7b. 已知边界与 follow-up（实现级验收沉淀）

A 线阶段1 经多轮 Codex+Gemini 实现级对抗验收，逐层闭合了 TOCTOU/符号链接别名/硬链接别名/敏感目录漏检/OS 异常裸冒泡/FIFO 阻塞等真实问题。一个**与内核执行门同级的已知边界**保留为 follow-up：

- **REPO 类 workspace 的 checkout root 被替换为「另一个真实目录」（非符号链接）**：viewer 的 fd 锚点 `O_NOFOLLOW` 已挡符号链接替换；managed 真文件夹由 `dir_pin` inode 复核挡真实目录替换。但 **REPO 类 workspace 在内核里本就没有任何 durable inode pin**——执行门 `assert_execution_repo_safe` 同样只对 managed 真文件夹 pin，对 REPO 不 pin。故 viewer 对 REPO 真实目录替换的检出**与内核执行本身同级（parity），不弱化任何现有边界**。
- 曾尝试在 run 创建处把 root inode 钉进 `execution_context.repo_root_pin`，但 run **启动**路径（orchestrator 重建 `effective_context` 并重写 `repo_path`，见 orchestrator.py:3076/3140）会让 pin 与 repo_path desync、产生假阳/假信心 → **撤销**，不在脆弱的 per-run context 层做。
- **正确的 follow-up（内核级，另立设计评审）**：在 **workspace 信任容器层**（trust 时）为 REPO 记录 root `(dev,ino)`，执行门与 viewer 共用同一 durable pin，旧 workspace 迁移为 fail-closed。这会同时抬升执行门，属内核范围，不塞进本 viewer 读路径。

## 8. 不做（本批次外）

文件树/目录导航、文件编辑、代理子资源 URL 重写（JS 重站点完整体验靠外开）、MCP Apps `ui://`。

## 10. B 线 preview-proxy — R10 设计（**Codex + Gemini 双 PASS 收敛**，进实现）

状态：**设计级评审中（R7 agy 通过；R8 agy 通过/Codex 提 DoS 资源限额+票据绑定，两路在资源限额上收敛）**。架构两路确认（JSON+srcdoc 解死锁、bearer ticket 爆炸面 0、nh3/html5ever 抗 mXSS）；R6 余阻断（SSRF 默认拒非 global、真浏览器零网络验收、extracted_links 协议守卫、nh3 无法边清洗边收集、meta CSP 不支持 frame-ancestors、srcdoc 头部顺序）本 R7 全部吸收。

### 10.0 v1 = JSON 取 + srcdoc 注入的 non-navigable reader（架构定稿）

1. 父面板 **fetch（带 ticket）** `GET /api/preview/{ticket}` → 后端取页（§10.3 护栏）→ **两步净化**（§10.2）→ 返回 **JSON**：`{ok, final_url, status, content_type, sanitized_html, extracted_links:[{text,url}], truncated, blocked_reason?}`，`Cache-Control: no-store`。**端点返回 JSON，不返回可直接打开的 HTML。**
2. 父面板在**自身 UI** 渲染 `extracted_links`（每个 url 已在后端过 `^https?://` 守卫，§10.2；点击再走 §2.1 外开），**绝不 iframe 内导航**。
3. `sanitized_html` 经 **`<iframe sandbox srcdoc="WRAPPER">`** 注入。**WRAPPER 顺序固定**：`<head>` 第一项是我们的 `<meta http-equiv="Content-Security-Policy" content="…§10.4…">`，untrusted `sanitized_html` 只放其后的 `<body>`。
4. iframe `sandbox`（无 allow-same-origin/top-navigation/popups/forms→opaque origin、防嵌套/防导航由 **sandbox 属性**承担，不靠 meta CSP）。
5. `sanitized_html` 超大 → 后端截断（`truncated=true`），避免 srcdoc 体积失控。

「零浏览器网络请求」由 nh3 零属性纯文本 + srcdoc 内联全 deny CSP + sandbox opaque origin 三重保证，并由 **§10.7 真实浏览器网络拦截**证明。

> **⚠️ v2 起（§11，2026-06-29）：上面这条「零浏览器网络请求」只对 `sanitized_html`（现降为 Web 端的*回退*阅读器）成立。Web 端默认改为渲染内核新返回的 `page_html`（忠实视图），它**有意**让浏览器直连加载页面自有子资源（CSS/图/字体）以还原真实样式——故对忠实视图「零浏览器网络请求」**不再成立**。此为业主明确决策（Web 端对齐桌面 APP 效果）下的姿态变更；脚本仍关闭、残留面分析见 §11。**

### 10.1 P1 — 无状态签名 bearer 票据（R5 两路确认）

票据 = 服务端密钥 HMAC 签名 bearer capability，claims `{aud:"preview", route:"/api/preview", method:"GET", url_normalized, iat, exp(60s), kid}` + 高熵 nonce。`POST /api/preview/tickets`（**`require_control_token`** 铸造）→ ticket 串；`GET /api/preview/{ticket}` 验签+aud/route/method+未过期+url 一致。控制 token 绝不进 URL/日志；no-store。务实裁决：TTL 内可重放但纯 GET+`trust_env=False`+SSRF 护栏 ⇒ 爆炸面 0。密钥持久化（`~/.superclaw/preview-sign.key`，0600，`kid` 轮换）。

### 10.2 P2 — 两步净化（提取 → nh3 零属性）+ 链接协议守卫（R6-agy1/2）

`nh3` 只收配置返字符串、**无回调**，故拆两步：

1. **提取链接**：用 stdlib `html.parser`（或 `selectolax`）遍历，收集 `<a href>` 文本+目标；**每个 url 过 `^https?://` 绝对 scheme 守卫**（R6-agy1：否则 `javascript:`/`data:` 链接喂父 UI `<a href>` → 高权域 XSS），非 http(s) 丢弃。
2. **清洗 HTML**：`nh3.clean()` **禁默认 allowlist**，钉死：tags 仅文本语义骨架（p/div/span/h1..h6/ul/ol/li/blockquote/code/pre/em/strong/b/i/br/hr/table/thead/tbody/tr/td/th/caption/dl/dt/dd；`<a>` 保留但下step 抹 href→惰性文本）；`attributes` **零属性**（默认空，最多 td/th 的 colspan/rowspan）；`url_schemes` 空集；`strip_comments`；**绝杀** style/script/iframe/object/embed/form/meta/base/link/svg/math/audio/video/source/track/picture 及 style/class/id/on* 属性。nh3 用 html5ever 序列化重组，粉碎 mutation XSS。
3. nh3 先**剥掉原始恶意 `<meta>`**（在绝杀名单），父层再在 WRAPPER `<head>` 拼**我们的** meta CSP。

### 10.3 P3 — SSRF 护栏：默认拒非 global + pin-IP 保 SNI（R6-Codex1）

- **默认拒绝所有 `not ip.is_global`**（R6-Codex1：枚举式拒 private/reserved/link-local 会漏 `100.64.0.0/10` CGNAT 等 `is_global=False` 段）；**IPv4-mapped/IPv4-compatible IPv6 取底层地址再 `is_global` 复检**；IPv6 zone(`%`)/八进制/十六进制/畸形无法 `ipaddress` 规范化 → fail-closed。
- 协议仅 http/https；`getaddrinfo` 解析全 A/AAAA，**每个**都须 `is_global` 才放行。
- pin-IP transport：向库传**原始 hostname**（SNI+证书按 hostname 验），socket connect 到**同次解析+校验**的 pin IP（check==connect 同 IP 堵 rebinding TOCTOU），**绝不 `verify=False`**，连接池不绕过。`follow_redirects=False` 逐跳重解析复检 ≤N 跳；超时+size cap；`trust_env=False` 不带 cookie/Authorization。
- 测试：私网各段 + **`100.64/10`** + IPv4-mapped + 畸形 IP fail-closed + 逐跳 redirect 跳非 global + **真实 peer IP 断言** + `trust_env=False`。

### 10.4 P4 — srcdoc 内联全 deny meta CSP（去 frame-ancestors）+ 剥上游头

- WRAPPER `<head>` 第一项 meta CSP（**全 deny，无 unsafe-inline，无 frame-ancestors**——R6：meta CSP 不支持 frame-ancestors/sandbox/report-uri，防嵌套归 iframe sandbox 属性）：`default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; connect-src 'none'; child-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; prefetch-src 'none'; form-action 'none'; base-uri 'none'`。
- JSON 响应头：丢弃上游 `X-Frame-Options`/`CSP`/`Set-Cookie`；自带 `nosniff` + `Referrer-Policy: no-referrer` + `Cache-Control: no-store` + `Content-Type: application/json`。
- 客户端 iframe `sandbox`（无 allow-same-origin/top-navigation/popups/forms）。

### 10.5 P5 — Desktop 契约统一

Desktop 同走 fetch+JSON+srcdoc：本地 API 取页（护栏）→ JSON → 父面板 srcdoc 注入沙箱。opaque origin + 无脚本/导航/属性 ⇒ 碰不到 Tauri IPC、零直连。外开仅兜底。

### 10.6 契约与铁律边界

能力先落**内核 + CLI**（`superclaw web preview <url> --json` 暴露 PreviewResult + extracted_links），API/Web/Desktop 调同一内核契约。定义：**单次显式 reader preview**，非扫描/爬取/faithful/批量。护栏只达公网（`is_global`）+ `trust_env=False` 不带凭证 ⇒ 非 SSRF 工具 ⇒ **无需人审门**（两路确认）。

### 10.7 实施阶段（每阶段原子提交 + 双 PASS）

1. 内核 `web_preview.py`：SSRF 护栏（`not is_global` 默认拒 + IPv4-mapped 复检 + pin-IP 保 SNI + 逐跳 + 超时 + size cap）+ 两步净化（html.parser 抽链接+`^https?://`守卫 → nh3 零属性 clean）+ `PreviewResult(sanitized_html, extracted_links, final_url, …)` + 单测（rebinding check-vs-connect、SNI 保持、私网+100.64/10+IPv4-mapped+畸形 IP、redirect 跳非 global、sanitizer 输出零属性/零资源、link 协议守卫）。
2. CLI `superclaw web preview <url> --json` + 契约。
3. 内核无状态签名票据基元（sign/verify+kid+claims）+ API `POST /api/preview/tickets` + `GET /api/preview/{ticket}`（JSON+剥上游头+no-store）+ 测试。
4. Web web 子视图（fetch ticket → fetch JSON → 父 UI 链接列表 + `<iframe sandbox srcdoc>`(meta CSP 头) 注入；点击加载；外开兜底）+ Desktop 核对 + vitest + **真实浏览器网络拦截验收**（Playwright：加载恶意 corpus 的 srcdoc，断言除 fetch 外无 img/srcset/picture/source/svg use/@import/meta refresh/object/embed/media/form 派生请求；点击无 iframe 内导航）。

### 10.8 实现精度钉死（R7 Codex + agy，进实现前的不可商量项）

- **SSRF fetch 链路**（Codex1）：① 每次 DNS 解析返回的**全部** A/AAAA 逐个 `is_global` 校验；② HTTP 3xx `Location` **绝不让库自动 follow**（`follow_redirects=False`），逐跳重做 scheme+host+全 IP 校验；③ 校验通过后**连接强绑定到刚校验的那个 IP**（socket 直连该 IP + `Host` 头带原域名 + SNI/证书按原域名），库**不得**按 hostname 二次解析（堵 DNS rebinding TOCTOU）；④ `trust_env=False` 且不读任何环境代理变量（防代理把请求导内网）。
- **IPv4-mapped 精确写法**（Codex2）：`ip = ipaddress.ip_address(raw); if isinstance(ip, IPv6Address) and ip.ipv4_mapped: ip = ip.ipv4_mapped; if not ip.is_global: reject`。回归测试含 `100.64.0.0/10`、`169.254.169.254`、`::ffff:127.0.0.1`。
- **强制 UTF-8 解码**（agy）：取回字节在交 `html.parser`/`nh3` 前**统一解码为 Unicode**（防 UTF-7/混淆编码绕过）。
- **链接守卫用标准 URL parser**（Codex3）：`extracted_links` 不止 regex——用 `urllib.parse` 解析+规范化、`scheme ∈ {http,https}`、剥控制字符/前后空白/userinfo 异常；父 UI **经 React props 渲染**（绝不拼 HTML 串）、外链强制 `rel="noopener noreferrer"`。
- **srcdoc 顺序锁死**（Codex+agy）：WRAPPER 的 `<meta CSP>` 是 `<head>` 物理**第一项**，untrusted `sanitized_html` 只放其后 `<body>`；用 `iframe.srcdoc` **prop** 设置（不拼未转义 HTML 属性）。
- **Playwright 验收口径**（Codex4）：`route('**/*')` 在加载 srcdoc **之前**注册；除测试明确放行的那一个 fetch 外**任何 request 都 fail**；断言点击后无 iframe 内导航/无 top navigation/无 popup；断言 iframe `sandbox` **不含** `allow-scripts`/`allow-forms`/`allow-top-navigation`/`allow-popups`。

### 10.9 fetch 资源不变量 / 配额（R8 两路共识：DoS 防御进设计）

preview-proxy 是服务端代拉不可信 URL，资源限额是**实现前的不变量**（非优化项）：

- **响应体硬上限**：流式读取，累计 > `PREVIEW_MAX_BYTES`（如 5MB）立即 abort 丢弃（防超大响应撑爆内存）。
- **解压炸弹**：限制/禁用 `Content-Encoding`——解压后累计字节同样受 `PREVIEW_MAX_BYTES` 约束，超限即 abort（gzip/br bomb）。
- **超时**：connect + read + total 三段超时（防慢响应挂死）。
- **重定向上限**：手动逐跳 ≤ `PREVIEW_MAX_REDIRECTS`（如 5），超则拒（防 redirect loop）。
- **Content-Type 早过滤**（R8-agy）：HEAD 或首包仅放行 `text/html`/`text/plain`；`video/*`/`application/zip`/二进制等**尽早丢弃**，不喂 html.parser/nh3（省 CPU + 防滥用）。
- **parse 输入上限**：交 html.parser/nh3 的输入长度 ≤ `PREVIEW_MAX_BYTES`（已被响应上限保证）。

### 10.10 票据绑定语义钉死（R8-Codex2）

bearer 票据 claims 显式绑定：`{aud:"preview", route:"/api/preview", method:"GET", url_canonical, principal, iat, exp(60s), kid, nonce(高熵)}`。

- **principal = 当前 control-token 的 generation/fingerprint**（单运营者本地的"session 上下文"）；control-token 轮换 ⇒ 旧 kid/principal 失效。
- **明确语义**：这是**短 TTL（60s）可重放 bearer 票据**，**非一次性**（无状态签名与严格 one-time 冲突，已两路确认务实接受）。
- **泄露姿态**：票据若经前端日志/插件/错误上报/Referer 泄露，60s 内至多被重放去**代拉同一个 url_canonical 的、已被 nh3 物理阉割的安全 JSON**；纯 GET + `trust_env=False` 无凭证 + SSRF 护栏 + §10.9 资源限额 ⇒ 无 SSRF 放大、带宽受限。降低泄露面：响应 `Referrer-Policy: no-referrer` + `Cache-Control: no-store` + 票据不写访问日志。

### 10.11 admission control / 限流（R9-Codex：聚合 DoS 不变量）

§10.9 是单请求上限；聚合维度也须设上限（防一个泄露票据 60s 内**无限并发重放同一 URL** 打满本地服务）：

- **全局 preview fetch 并发上限**（in-flight 总数，超限 `429`/`503`）。
- **每 `principal` 并发上限** + **每 `principal+url_canonical` 短窗口速率上限 / in-flight 合并**（同 url 在途请求复用一次抓取）。
- **队列长度上限**，超限直接拒（不无限排队）。
- **连接池 max connections / keepalive 上限**。
- 超限 / abort / timeout 计入观测指标（可见性）。

### 10.12 实现期兜底（R9-agy，非阻断）

- 目标站**未返回 Content-Type** → fallback 视为 `text/plain` 入 5MB 漏斗交 nh3 兜底，不直接报错（兼容不规范站点）。
- 恶意/损坏 `gzip`/`br` 解压抛 DecodeError → 捕获按 fetch 失败处理（空/错误提示），不崩 worker。
- 源站诡异 charset 无法标准解码 → 强制 `errors='replace'` 洗成 UTF-8 再喂 nh3（安全解析器不因编码异常崩）。

### 10.13 实现期硬 checklist（R10-agy 终审，PR review 必查）

设计已双 PASS；以下 3 项是标准库易踩、会击穿可用性防线的实现劫持点，列为编码/review 硬门：

1. **解压炸弹刚性作用于"解压后流式阶段"**：不可"先下 ≤2MB 压缩流再一次性 decompress"（2MB→2GB 撑爆）。必须 **chunked 边解压边累计解压后字节**，触达 `PREVIEW_MAX_BYTES` 立即丢 buffer + 切 TCP + 计指标。
2. **绝对墙钟超时（防 Slowloris）**：不只 `read_timeout`（空闲间隔）。必须设 **request/total wall-clock timeout**（如 5s），到点强杀协程回收并发 slot/连接，无论是否还在传。
3. **单 target domain/IP 并发上限**（防 tarpit 全局饿死）：连接池层加一层 per-target 并发上限，对慢黑洞协同攻击免疫（§10.10 鉴权 + §10.11 指标已可定位，此为纵深）。

## 9. R1 阻断项并集（已吸收对照）

| # | 来源 | 阻断项 | 吸收处 |
|---|---|---|---|
| B1 | 双(R1)+Codex(R2) | webview 自动加载/内网/DNS rebinding/跳转探测面 | §2.1+§3.5 内核 preview-proxy（pin-IP/逐跳护栏） |
| B2-R2 | Codex(R2) | 受信根选错(workspace.repo_path stale) | §3.2 改 run execution_context.repo_path |
| B3-R2 | Codex(R2) | 敏感扫描/截断顺序 fail-open | §3.3 名→二进制→内容(scan cap) 定死 |
| B2 | 双 | Desktop Tauri 主窗口内嵌外站 = RCE 面 | §2.2 经本地代理 CSP-sandbox opaque origin 隔离 IPC |
| B3 | 双 | 敏感文件需 core fail-closed 拒绝（不脱敏） | §3.3 |
| B4 | Codex | 不得按 raw path 放开 artifact 根 | §3.2 移除，artifact 仅经 artifact_id |
| B5 | 双 | run_id 非授权边界 | §3.2 workspace trust 门 + control-token |
| B6 | Codex | 用 durable trust 非 trust_confirmed/布尔 | §3.2 `is_trusted` + inode 复核 |
| B7 | Codex | 二进制下载扩大泄露面 | §3.4 二进制只回元数据拒下载 |
| B8 | Codex | 契约未收敛（413/错误对象/截断） | §3.1 统一 code + 截断不 413 |
| A1 | 双 | 路径识别只认 markdown 链接 AST | §5 |
| A2 | 双 | `.md` 禁 raw HTML/远程图片 | §5 |
| A3 | agy | realpath 后再 is_relative_to + ADS | §3.4 |
| A4 | Codex | iframe fallback 不靠 XFO 探测 | §2.1 |

## 11. v2 — 忠实样式视图（`page_html`，2026-06-29，Codex+Gemini 双 PASS）

### 11.1 动机与裁决
业主诉求：**Web 端引用查看器要和桌面 APP 效果一样**（桌面 `NativeBrowserPanel` 是真原生子 webview，CSS 完整）。Web 端原本只展示 §10 的 `sanitized_html`（nh3 零属性纯文本）——CSS/图/链接全剥光，呈现为纯文本，被业主判为「错乱」。

**裁决（业主明确「就这么做」）**：Web 端默认改渲染**忠实视图**。一个浏览器 tab 物理上无法像桌面那样起真顶层 webview（srcdoc/iframe 是不透明源，站点自身 AJAX 被 CORS 挡），故「忠实静态渲染（CSS/图在、脚本关）」是浏览器能达到的天花板，据此选型。

### 11.2 机制（最小改动、复用 §10 全部 SSRF 守卫）
- 内核 `web_preview.py` 用**同一份已抓取、已 SSRF 校验**的 `text`，除 `sanitized_html` 外再产出 `page_html = build_faithful_page(text, final_url)`：把真实 HTML 作为 `<head>` **首位**注入 ①页面级 CSP `script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'`（**故意省略 default-src/style-src/img-src** → 放行被动子资源；**故意省略 base-uri** → 注入的 `<base>` 生效）②`<base href="{HTML转义后的 final_url}">`（相对子资源解析回真实源、由**浏览器直连**加载）。
- `PreviewResult` 新增 `page_html` 字段（默认 `""`）；`to_dict()`/`asdict` 自动随 `GET /api/preview/{ticket}` 下发（**API 路由零改**）；CLI `web preview` 增 `page_html_chars=` 并经 `--json` 全量暴露（CLI/API/Web 同一事实源）。
- 前端 `WebPreviewPanel` 主渲染 `page_html`，仍用 `<iframe sandbox="" referrerpolicy="no-referrer">`（不透明源、无 allow-scripts）；`page_html` 缺失（旧后端版本偏斜）时回退 `buildPreviewSrcdoc(sanitized_html)` 惰性阅读器，**绝不空白**。

### 11.3 与 §10「P2 子资源 SSRF」决策的关系（**姿态变更，诚实记录**）
§10 P2 当年（Codex）刻意**剥光子资源**以达「零浏览器网络请求」，关闭浏览器直发子资源（含内网 `<img src=http://127.0.0.1>`）的探测面。v2 忠实视图**有意逆转**这条早期 containment，让浏览器直连加载子资源。安全再核：

- **服务端 SSRF：未复现。** 子资源由浏览器直发、**不经服务端**；内核顶层抓取仍走 §10.3 全套守卫（pin-IP/逐跳复验/超时/字节上限）。攻击者无法借此让我们的服务端去拉内网。
- **客户端内网探测外泄：被脚本关闭阻断。** sandbox `""`（无 allow-scripts）+ CSP `script-src 'none'` ⇒ 页面**无法运行 JS** 观测 `<img>/<link>` 的 load/error，**拿不到探测结果**；不透明源也读不到跨源响应。CSS 注入式外泄需读取本文档内的 secret——忠实视图里只有第三方页面、无用户 secret，故不可行。
- **残留面（接受）**：被动子资源（img/css/font）发出的 **GET 副作用 + 第三方追踪/暴露用户 IP**——对页面自身**不可观测**，但 GET 可能触达内网设备产生 CSRF 式副作用。**此残留面是桌面 `NativeBrowserPanel`（连脚本都跑、可导航）的严格子集**，而 v2 目标正是 Web 对齐桌面 ⇒ 一致且更保守；且仍被 **click-to-load 默认门**挡在用户显式同意之后。
- **设计分叉**：v2 取**轻量 base-href + 浏览器直连**，未走 P2 设想的「子资源全经服务端代理重写」重型方案。若日后要把客户端 GET 副作用面也关掉，再走代理子资源路线（成本高、重开服务端抓取面，需另评审）。

### 11.4 已知取舍（非阻断）
- iframe 内点链接在 frame 内导航到真实站；目标若发 X-Frame-Options 可能空白（首屏经 srcdoc 不受限正常）。链接列表 + 外开仍是主路径。
- `build_faithful_page` 的 `<head\b[^>]*>` 是正则非 HTML parser：注释内 `<head>`/畸形属性/截断 HTML 可能让「CSP+base 落首位 head 子节点」不总成立；**底线由 iframe sandbox 托底**（脚本恒关），最坏只是 base 失效致样式降级，非 XSS。
- 脚本关闭 ⇒ JS 驱动的动态内容不渲染（浏览器不可逾越的天花板，非实现缺陷）。
- https app + http 子资源被混合内容拦（dev 为 http localhost 不受影响）。
