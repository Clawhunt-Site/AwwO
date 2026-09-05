# Node 侧双格式 plugin 运行时设计 — 通用(Paperclip JS) + super(二进制/脚本/MCP)

> 分支 `feat/workshop-plugin-company-fullchain`。承接 `docs/capability-workshop-paperclip-fullchain-design.md`（工坊下载全链）的 **plugin 这一类的运行时落地**。
> 经 Codex(gpt-5.5) + agy(Gemini 3.1 Pro) 设计评审收敛 + 主代理裁决（2026-06-29）。
> 业主拍板：**接受无沙箱 RCE 残留、带治理门先跑**；**先落设计文档 + 切片计划**。

## 0. 需求（业主硬要求，不可退化）
能力工坊 plugin 在 Node 侧落地后，**必须同时支持两类、且都能真跑**：
1. **通用插件** = Paperclip 原生 plugin（Node/JS worker，`fork`）；
2. **super 自己格式的插件** = `superclaw-plugin.json`，**语言无关**：`external_mcp`（MCP server）/ 裸脚本 / **二进制**。后者**必须能真实运行**（不能只支持 Node 插件糊弄）。
约束：vendored Paperclip「只增不删、不改上游源码」；工坊验权留 Python（H 架构），执行在 Node。

## 1. 顶层架构：统一只读 catalog + 执行 router + 分物理存储
**反模式（两路一致否决）**：不拆两套独立 plugin 系统；也**不把 super 插件塞进 Paperclip `plugin-registry`**（它强依赖 JS worker running/call 语义，见 `plugin-tool-registry.ts:384`，super 插件冒充会崩）。

```
统一只读 PluginRuntimeCatalog —— UI/列表/状态/provenance 徽章只从它读,绝不直读底表(防双表漂移)
执行 PluginRuntimeRouter.executeTool(pluginId, toolName, input)
  ├─ Paperclip JS  → 现有 plugin-registry + plugin-worker-manager(fork)        [复用,零改]
  └─ super 插件 → 新增 super_plugin_runtimes 表(幂等建表,like chat-pins)
       ├─ runtime.type==external_mcp → SuperExternalMcpRunner
       └─ runtime.entrypoint(非mcp)  → SuperSidecarRunner
```
- Paperclip JS 继续走自己的 registry；super 插件写**独立** `super_plugin_runtimes` 表 + 不可变 runtime store。
- UI/API **只读统一 catalog**（join 两边 + provenance 徽章）；执行统一经 router。**super runner 绝不冒充 PluginWorkerManager。**

## 2. 分流判据（manifest 嗅探，dual-manifest fail-closed）
解包后（S2c unpack 产物）静态嗅探：
1. `package.json` 有 `paperclipPlugin` 且过 `pluginManifestV1Schema`（`server/packages/shared/src/validators/plugin.ts`）→ `paperclip_js_runner`。
2. 包根有 `superclaw-plugin.json`（`MANIFEST_NAME`，`plugins.py:27`）→ super：
   - `runtime.type === "external_mcp"` → `super_external_mcp_runner`；
   - 否则有 `runtime.entrypoint` → `super_sidecar_runner`。
3. **两种 manifest 同时存在 → fail closed**（除非将来显式新增 dual-format 元数据）。

## 3. 三类 runner
### 3.1 Paperclip JS runner（复用，零改）
现有 `plugin-worker-manager.ts` 的 `fork` + Host-Worker 协议；`installPlugin({localPath})` 落地（仓库外目录免 build，见工坊全链设计）。

### 3.2 SuperExternalMcpRunner（新建）
- Node 用 `@modelcontextprotocol/sdk` **client** 自建 MCP host/proxy（client SDK 已装）：per-call（MVP）拉起 `runtime.command` 子进程 → `initialize` → `tools/list` 校验 → `tools/call` → timeout → 进程组 kill → stderr 截断 → 结果归一化 → 映射进统一 catalog。
- `agent mcpServers` 投影只作**本地可选**（Phase 2），**不是权威执行路径**（远程会删 mcpServers，见 `claude-config.ts`；backend 行为不一）。
- 治理：root-signed/curated-only；launcher allowlist；stdio-only；禁 shell；env 白名单；**远程 backend fail-closed**。

### 3.3 SuperSidecarRunner（新建，不强包 MCP）
- POSIX `spawn(entrypointAbs, args)`，`cwd=packageRoot`，stdin 写 JSON，stdout 按 super 工具契约解析，stderr 单独审计。复刻 super `command_for_script` 的「POSIX 直接执行入口」（`process_scripts.py:11`）。
- 不强行包成 MCP（避免重写 super sidecar 协议 + 再套 MCP 垫片）。

## 4. 无沙箱 RCE 治理门（两路一致，每个 super runner 必做）
1. **exec-bit 校验**：拉起前 `fs.stat` 检 `S_IXUSR`（复刻 `plugins.py:289` passive-data vs runnable）。
2. **路径牢笼**：`entrypoint`/`command` `realpath` 后**必须严格在该插件不可变 runtime store 目录内**；拒 `../` 逃逸、拒 symlink escape、拒 setuid/setgid/sticky。
3. **digest 没漂移**：执行前比对包 digest 与 provenance 记录；漂移即 fail-closed。
4. **execFile/spawn 非 exec**：绝不走 shell（防注入）；参数走 argv 数组。
5. **ENV 白名单**：`spawn` 显式 `env:` 极简白名单，**切断宿主 env 继承**（防 AWS/Anthropic key 泄给第三方二进制）。
6. **timeout + 进程组 kill + 输出上限**。
7. **僵尸进程治理**（agy）：常驻 runner 记 pid 侧表，Node 重启时检查并 SIGKILL 同名孤儿子进程。
8. **供应链 pin**（Codex）：`npx/uvx` 类 launcher 会运行时拉远端代码 → MVP 要求**版本 pin、最好字节随 artifact 入包**；否则 fail-closed。

## 5. 与 S2c 工坊导入衔接
S2c `workshop-import.ts` 的注入式 plugin installer（`super-plugin-installer.ts`）：
1. 嗅探 manifest（§2）。
2. 原子落到**不可变 runtime store**。
3. 写 `super_plugin_runtimes`（DB UUID/path/version/digest——DB 实现不泄漏给 provenance）。
4. 注册工具进统一 catalog。
5. 返回 `nativeId = manifest plugin id`。
- `workshop_provenance` 仍**只由 verified receipt** 写（S2b 合约）。缺 provenance / 缺 runtime row / digest 不匹配 → 列表可见但**不可执行 / fail-closed**。
- rollback：删 runtime store 目录 + 删 super_plugin_runtimes 行 + 注销 catalog 工具（installer 自带 rollback 句柄，对接 S2c 的回滚模型）。

## 6. 信任边界（Python 准入 vs Node 运行时，不重不漏）
- **Python（H/S1/S2a）= 准入**：cosign + 域 digest + 吊销 + skill-origin + R2 字节——「这些字节能否进入系统」。
- **Node（S2b/S2c/runtime）= 运行时门**：receipt+provenance 在、digest 没漂移、runtime policy、权限 grant、env 白名单、local/remote backend、timeout、审计——「这次能否执行」。是运行时 TOCTOU + 权限边界，**不是重复验权**。

## 7. 残留风险（业主已接受，须留痕）
- **无沙箱 RCE**：允许跑二进制 = 宿主机代码执行。§4 治理门**只降准入风险，不替代隔离**。真沙箱（macOS sandbox / 容器 / WASI）= **Phase 3**；在那之前「verified binary」≠「被隔离」。
- per-call 进程慢（无 pool）；MVP 安全优先可接受，Phase 2 池化。

## 8. 复用 / 移植 / 新建
- **复用**：S1/S2a/S2b/S2c（receipt/provenance/import）；Paperclip plugin-registry/list/status（JS 类）；plugin-tool-dispatcher 命名/UI 语义；local-service-supervisor 进程组/终止思路；`@mcp-sdk` client；local/remote mcpServers fail-closed 规则。
- **移植（super→TS）**：`superclaw-plugin.json` schema；`runtime.type` 模型；`command_for_script` 入口/shebang/exec-bit；external_mcp root/curated/launcher allowlist；env/secret 白名单；声明式权限门。
- **新建**：`super-plugin-manifest.ts`、`super-plugin-installer.ts`、`super-plugin-runtime-store.ts`、`super-sidecar-runner.ts`、`super-external-mcp-runner.ts`、`plugin-runtime-router.ts` + `PluginRuntimeCatalog` + 三类 fixture 集成测试。

## 9. 切片计划（每刀=模块+相关测试+Codex 单顾问+本地原子提交不推；MVP 三类都真跑/本地/stdio/per-call/无 pool/无真沙箱,但带 §4 治理门）
| 刀 | 内容 |
|---|---|
| **P1** | `super-plugin-manifest.ts`：`superclaw-plugin.json` 解析+校验（runtime.type/entrypoint/args/command/tools）+ 单测 |
| **P2** | `super-plugin-runtime-store.ts`：`super_plugin_runtimes` 表(幂等建表 like chat-pins) + CRUD + 单测(embedded pg) |
| **P3** | `super-sidecar-runner.ts`：spawn 裸脚本/二进制 + §4 治理门(exec-bit/路径牢笼/env白/timeout/digest) + fake/真二进制 fixture 测试 |
| **P4** | `super-external-mcp-runner.ts`：@mcp-sdk client per-call host + tools/list 校验 + 治理门 + MCP fixture 测试 |
| **P5** | `plugin-runtime-router.ts` + `PluginRuntimeCatalog`：分流判据(dual-manifest fail-closed) + 统一只读 catalog(join Paperclip JS + super + provenance 徽章) + 单测 |
| **P6** | `super-plugin-installer.ts`：接 S2c 注入式 installer(嗅探→落 store→写表→注册→nativeId+rollback) + 集成测试 |
| **P7** | 三类端到端 E2E（Paperclip JS / super sidecar / super external_mcp 各装+跑+列表+卸载）+ 安全负例(路径逃逸/exec-bit/digest 漂移/env 泄漏 fail-closed) |

## 10. 分期
- **MVP（P1-P7）**：三类都真跑，本地/stdio/per-call/无 pool/无 UI contribution/无真沙箱，**带 §4 全套治理门**。
- **Phase 2**：agent mcpServers 投影 + MCP server pool + UI/health 管理 + 高频 Fast Path。
- **Phase 3**：真沙箱（macOS sandbox / 容器 / WASI）——根治 RCE 残留。
