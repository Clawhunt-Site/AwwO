# Windows 支持评估与路线图（Windows Support Assessment & Roadmap）

> 本文回答一个具体问题：**SuperClaw 现在对 Windows 的支持到底如何，还缺什么，未来要支持需要做什么。** 结论先行——「项目是 web 的」只让浏览器那一层天然跨平台；但本项目的内核是 **Python CLI harness**（见 `CLAUDE.md`「CLI 是唯一事实来源」），Web/Desktop/API 都是它的表层。所以 Windows 支持好不好，取决于「**Windows 机器上到底要跑什么**」，而非「前端是不是 web」。
>
> **本文性质**：截至 **2026-06-29** 的**静态代码审计**（基于 `dev/server-refactor` 与 `work/main-latest-20260625` 两条线核对），**尚未在真实 Windows 上执行验证**。所有「会崩 / 会退化」的判断都附 `file:line` 证据，可逐条复核；但「能不能真跑通」必须经 §5 的真机/CI 验证才能定论。
>
> 关联文档：[[git-workflow-constitution]]、[[desktop-beta-quickstart]]、[[server-refactor-to-node-chat-compat]]、[[frozen-backend-mei-ssl]]、[[desktop-startup-cleanup-watchdog]]。

---

## 实施状态（2026-06-29 落地，形态 B）

> 下文 §1–§6 是 2026-06-29 的**静态审计原文**（保留作为依据）。本节是其后**真机落地**的结果：**形态 B 已打通到桌面安装包**。在真实 Windows（Win11 + Python 3.12 + Node 22 + Rust 1.96 + MSVC2022 + WebView2）上验证。

| 阶段 | 状态 | 证据 |
|---|---|---|
| **P0 不崩** | ✅ 完成 | `relay_key.py` 裸 `import fcntl` → `try/except` + `msvcrt.locking` 兜底；`import superclaw.cli` / `superclaw doctor` 在 Windows 真跑通（exit 0，backends 列表正常） |
| **P1 进程/信号/IPC** | ✅ 完成 | 新模块 [proc_compat.py](packages/superclaw/src/superclaw/proc_compat.py)：`pid_is_alive`（Windows 用 `OpenProcess`/`GetExitCodeProcess`，**绝不**用会杀进程的 `os.kill(pid,0)`）+ `terminate_pid`（`taskkill /T /F`）。`liveness.py` / `cli.py` daemon 全部改用之；daemon 启动用 `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP`。clawwork RPC 从 `select`+`fcntl`-on-pipe 重写为**跨平台线程+队列读取器**（[backends.py](packages/superclaw/src/superclaw/backends.py)）。`os.fchmod`/`os.getuid` 全部 `hasattr`/`os.name` 守卫 |
| **P1 路径** | ✅ 完成 | `SAFE_SIDECAR_PATH`/`SAFE_REVIEW_PATH` 在 Windows 返回 System32 系列（不再是会清空 PATH 的 `/usr/bin:/bin`）；`run_shell` 在 Windows 优先 `bash -lc` 否则 `cmd` |
| **P1 治理（NTFS ACL）** | ✅ 完成（业主裁决：硬化而非弱姿态） | 新模块 [secure_fs.py](packages/superclaw/src/superclaw/secure_fs.py) `harden_path`：Windows 用 `icacls /inheritance:r /grant:r <user>` 收紧到当前用户，**fail-closed**（收紧失败打 WARNING，绝不静默 fail-open）。已接入 relay_key / clawhunt_auth / secrets_store / team_mcp_proxy / backends（clawwork agent_dir 失败即拒绝发 key） |
| **P2 桌面安装包** | ✅ **已产出 .msi + .exe** | `build-backend.mjs` 增 Windows 分支（PyInstaller 冻结 `superclaw-backend.exe` + 落入 `src-tauri/resources/`）；`tauri.conf.json` 配 `bundle.windows`（NSIS + WiX、WebView2 downloadBootstrapper、currentUser）；产物：`SuperClaw_0.1.0_x64_en-US.msi`（46.6 MB）+ `SuperClaw_0.1.0_x64-setup.exe`（45.5 MB）。**未签名**（Authenticode 证书需业主提供） |
| **CI** | ✅ 完成 | `ci.yml` 新增 `test-windows`（windows-latest）：lint + pytest（POSIX-only 测试经 `posix_only` 标记在 Windows 自动跳过）+ `doctor` + API `/health` 冒烟 + web build。新增 `desktop-windows.yml`（tag/手动触发）构建并发布安装包 |
| **测试** | ◑ 进行中 | 全量 5487 用例在 Windows **5329 通过**；158 个 POSIX 语义用例（mode bits / symlink / FIFO / 信号 / AF_UNIX / fcntl / dir_fd swap）标 `posix_only` 在 Windows 跳过（conftest `pytest_collection_modifyitems` 钩子）——保持「绿且诚实」 |

**本机特例（不影响 CI / 干净检出）**：本开发机的仓库根路径含撇号（`E:\Bobo's Coding cache\...`），微软资源编译器 `rc.exe` 会把撇号转义成 `\'` 导致 RC2135。已加 `build.rs` 逃生阀 `SUPERCLAW_WINDOWS_ICON`（指向干净路径的 .ico 副本，仅用于 EXE 内嵌图标；bundler 仍读 `bundle.icon`）。GitHub Actions / 普通检出路径无撇号，默认行为不变。构建步骤见 [[windows-desktop-build-runbook]]。

---

## 0. 核心判断：先分清两种部署形态

Windows「支持不支持」这个问题，必须先拆成两种完全不同的形态，再分别回答：

| 形态 | 含义 | Windows 现状 | 需要做的事 |
|---|---|---|---|
| **A. 纯 web 客户端** | 后端（API server / Node / Python harness）跑在 **Linux/Mac 服务器**，Windows 用户只用 Chrome/Edge 访问 | ✅ **完全没问题，零改动** | 无。React/Vite 前端是纯浏览器代码，不碰任何 OS API |
| **B. 在 Windows 本地运行** | `superclaw` CLI、本地 API server、或**桌面 app（内含打包的 Python sidecar）**跑在 Windows 上 | ⚠️ **目前一启动即崩 + 大量未验证** | 见 §2 缺口、§4 路线图 |

> **决策锚点**：团队要先回答「Windows 用户是只当 web 客户端，还是要在 Windows 本地跑后端 / 装桌面 app」。
> - 若**只走形态 A**（后端托管在 Linux）——现状即够用，本文 §2 之后可作为「未来若改主意」的储备，不必立即动工。
> - 若要走**形态 B**——必须按 §4 分期推进，且要意识到这不只是「让它别崩」，还涉及 §2.4 的**治理语义重定义**（见下）。

本文 §1 之后**全部针对形态 B**。

---

## 1. 分层现状评估（形态 B）

| 层 | 组件 | 状态 | 说明 |
|---|---|---|---|
| 前端 | `apps/web`（React/Vite） | ✅ **可移植** | 纯浏览器代码。`npm run build` / `vitest` 走 vite，跨平台。唯一注意：构建产物本身无 OS 依赖 |
| Node 后端 | `server/`（vendored Paperclip）+ `apps/gateway` | ✅ **基本可移植** | Node 本身跨平台。启动器 [node_runtime.py](packages/superclaw/src/superclaw/node_runtime.py) 用 `shutil.which("node")`（Windows 命中 `node.exe`）、`start_new_session=os.name != "nt"`、teardown 有 `os.name == "nt"` 分支——**做得相对干净**。但优雅关闭在 Windows 退化（无 `killpg`），见 §2.2 |
| Python 内核 / CLI | `packages/superclaw/src/superclaw/` | ⚠️ **有意做过跨平台，但没做完** | 7 个核心文件带刻意的 `os.name == "nt"` / `msvcrt` 兜底分支；但有 **1 个硬阻断 + 多处功能缺口 + 治理语义缺口**，见 §2 |
| 桌面 | `apps/desktop`（Tauri v2） | ⚠️ **理论可构建，从未构建/验证** | `tauri.conf.json` 配 `"targets": "all"`，能产 NSIS+MSI——**但只有在 Windows 主机/CI 上构建才会产出**，且依赖 WebView2、Windows 代码签名、PyInstaller 的 Windows 打包，全未做。见 §2.6 |
| 构建 / 测试 | `scripts/*.sh`、CI | ❌ **Windows 零覆盖** | 本地全量门 `scripts/run-ci-tests.sh` 是 bash，cmd/PowerShell 跑不了；CI 只有 `ubuntu-latest`（[ci.yml:34](.github/workflows/ci.yml:34)）。**从来没有任何东西在 Windows 上被构建或测试过** |

**一句话**：web 与 Node 层对 Windows 友好；**所有风险集中在 Python 内核 / CLI / 桌面打包 / 构建脚本这四块**。

---

## 2. 缺口清单（按严重度，附证据）

### 2.1 🔴 硬阻断：CLI 在 Windows 一启动即崩

- **`fcntl` 裸导入**：[relay_key.py:27](packages/superclaw/src/superclaw/relay_key.py:27) 是**全仓唯一一个无保护的 `import fcntl`**（POSIX 专有，Windows 无此模块）。而 [cli.py:68](packages/superclaw/src/superclaw/cli.py:68) 在模块顶层 `from superclaw.relay_key import ...`。
  - **链路**：`superclaw doctor` → import `cli` → import `relay_key` → `import fcntl` → `ModuleNotFoundError: No module named 'fcntl'` → **整个 CLI 起不来**。
  - **对比**：其他 5 个用到 `fcntl` 的文件（`runtime_config` / `telemetry_upload` / `skill_sync` 等）都用 `try/except ImportError` + `msvcrt` 兜底**做对了**，唯独 `relay_key` 漏了。
  - **修法**：照搬现有 `msvcrt` 兜底模式（见 [runtime_config.py:12-19](packages/superclaw/src/superclaw/runtime_config.py:12)）。这是当前**唯一让 CLI「连门都进不去」**的点，是 P0。

### 2.2 🟠 进程 / 信号 / IPC：POSIX 进程模型在 Windows 退化或失效

- **进程组信号**：`os.killpg` / `os.getpgid` / `signal.SIGKILL` 在 [desktop_runtime.py](packages/superclaw/src/superclaw/desktop_runtime.py:567)、[plugin_proxy.py:1041](packages/superclaw/src/superclaw/plugin_proxy.py:1041)、[claude_stream.py:206](packages/superclaw/src/superclaw/claude_stream.py:206)、[node_runtime.py:566](packages/superclaw/src/superclaw/node_runtime.py:566) 均有使用。多数已用 `os.name == "nt"` 分支退化为 `process.kill()`，**但「优雅级联终止整个进程树」在 Windows 丢失**——关 app / 取消 run 时可能**留孤儿子进程**。Windows 正解是 **Job Object** 或 `taskkill /T`。
- **桌面看护 watchdog 是 POSIX-only**：[desktop_runtime.py:665](packages/superclaw/src/superclaw/desktop_runtime.py:665) 注释明说「No POSIX sessions; the desktop watchdog path is POSIX」。Windows 下桌面退出清理退化，呼应 [[desktop-startup-cleanup-watchdog]] 的孤儿问题，需 Windows 专路。
- **本地 daemon broker IPC 完全不可用**：[daemon.py:784](packages/superclaw/src/superclaw/daemon.py:784) 对非 POSIX 直接 `raise LocalDaemonBrokerIPCUnsupportedError`（用 `AF_UNIX`）。这是 **fail-closed（正确）但意味着该能力在 Windows 整块缺失**；要可用需 TCP-loopback 或 Named Pipe 兜底。
- **`select` on pipes**：[backends.py:3826](packages/superclaw/src/superclaw/backends.py:3825) 的 clawwork RPC 驱动用 `select` + `fcntl` 读管道——Windows 上 `select` 只能用于 socket 不能用于管道 → **clawwork 后端在 Windows 不可用**。

### 2.3 🟠 路径与文件系统

- **硬编码 POSIX 路径**：`/tmp/`、`/usr/bin`、`/Users/`（[plugin_proxy.py:907](packages/superclaw/src/superclaw/plugin_proxy.py:907)、[plugin_submission.py:908](packages/superclaw/src/superclaw/plugin_submission.py:908)、[capability_submission.py:785](packages/superclaw/src/superclaw/capability_submission.py:785)）、Linux 字体路径 `/usr/share/fonts/...`（[evals.py:2548](packages/superclaw/src/superclaw/evals.py:2548)）。在 Windows 上这些路径前缀判断会**永远判空或永远不命中**，相关 allow-list / 字体渲染失效。
- **待真机核查的通用坑**（静态审计无法定论，列入 §3）：路径分隔符、`MAX_PATH` 260 限制、保留文件名（`CON`/`NUL`/`AUX`…）、大小写不敏感文件系统、`TMPDIR` vs `TEMP/TMP`、`HOME` vs `USERPROFILE`（`Path.home()` 本身跨平台 OK，但 `~/.superclaw` 数据根约定需在 Windows 落到 `%USERPROFILE%` 并验证，见 [[home-data-root]]）。

### 2.4 🟠 治理 / 信任语义：建立在 POSIX 权限位上，NTFS 没有

> **这是最容易被忽略、却最关键的一条**：本项目的 fail-closed 治理大量依赖 **POSIX 文件权限位**，而 NTFS 根本没有这套语义。移植到 Windows 不是「让它别崩」，而是**要重新决定信任门怎么裁**。

- **权限收紧多为 no-op**：满仓 `chmod(0o700)`（[daemon.py](packages/superclaw/src/superclaw/daemon.py:403)、[relay_key.py:135](packages/superclaw/src/superclaw/relay_key.py:135)、[backends.py:3426](packages/superclaw/src/superclaw/backends.py:3426)、[clawhunt_auth.py:91](packages/superclaw/src/superclaw/clawhunt_auth.py:91) 等）。Windows 上 Python 的 `chmod` **几乎只认 read-only 位**，`0o700` 形同虚设 → 私密目录（密钥、状态）在 Windows **没有被真正收紧**。
- **「group/world 可读」检查在 Windows 被静默跳过**：[secrets_store.py:140](packages/superclaw/src/superclaw/secrets_store.py:140) 是 `if os.name == "posix" and (st_mode & 0o077)` → Windows 上**整条密钥权限硬化检查被跳过**，密钥文件不再被强校验。这是**安全姿态缺口**（非崩溃），与项目 fail-closed 文化冲突，需显式决策。
- **未守卫的 mode 位检查可能误判**：[developer_identity.py:71](packages/superclaw/src/superclaw/developer_identity.py:71) 的 `st_mode & 0o077` 未加 `os.name` 守卫；Windows 上 `os.stat` 伪造 mode 位 → 行为不确定。
- **sticky-bit 检查无对应物**：[plugins.py:311](packages/superclaw/src/superclaw/plugins.py:311) 的 `S_ISVTX` 是 `/tmp=1777` 豁免逻辑（见 `CLAUDE.md`「CI 工程纪律」），Windows 无 sticky bit 概念。
- **决策要求**：Windows 端要么映射到 **NTFS ACL**（`icacls`/`win32security` 收紧到当前用户）做等价硬化，要么**显式接受并文档化一个更弱的姿态**。**绝不能默认「跳过即安全」**——那等于 fail-open，违背铁律。

### 2.5 🟡 命令构造：`shlex` 是 POSIX shell 引用

- `shlex.split` / `shlex.quote` 用于 [backends.py](packages/superclaw/src/superclaw/backends.py)、[process_scripts.py](packages/superclaw/src/superclaw/process_scripts.py)、[credential_guard.py](packages/superclaw/src/superclaw/credential_guard.py)、[capability_r2.py](packages/superclaw/src/superclaw/capability_r2.py)。`shlex` 产出的是 **POSIX shell 引用规则**，与 Windows `cmd.exe` 引用规则不同 → 若这些命令串最终交给 Windows shell 执行，参数引用可能出错。需逐处确认是「直接 `Popen(list)`（安全）」还是「拼成字符串过 shell（有风险）」。
- 可执行名解析：已有 `clawwork.exe`（[backends.py:3128](packages/superclaw/src/superclaw/backends.py:3128)）正确处理；但 `npm`/`npx`/`node` 在 Windows 是 `.cmd` shim，`shutil.which` 一般能命中，需真机确认 `PATHEXT` 行为。

### 2.6 🟠 桌面打包（Tauri + PyInstaller sidecar）

- **WebView2 依赖**：Tauri 在 Windows 渲染靠 Edge WebView2 运行时，终端用户机器需预装或随安装包 bootstrap，安装器要配。
- **代码签名**：Windows 走 **Authenticode 证书**（与 Apple 公证完全不同），未签名的 `.exe`/`.msi` 会触发 SmartScreen 警告。需采购证书 + 配 CI 签名步骤。
- **sidecar 二进制**：`tauri.conf.json` 当前**没有** `externalBin` 配置；Python 后端打包成 Windows sidecar 需 PyInstaller 产 `.exe`，并按 Tauri 的 target-triple 命名（`...-x86_64-pc-windows-msvc.exe`）。
- **PyInstaller Windows 坑**：[[frozen-backend-mei-ssl]] 记录的 `_MEI` / certifi / SSL 问题在 macOS 已修；Windows 打包大概率有**同类但不同形态**的 SSL/证书/DLL 缺失问题，需重新趟一遍。
- **交叉编译不可行**：**Windows 安装包基本无法从 macOS 交叉构建**——必须有 Windows 构建机或 `windows-latest` CI runner。

### 2.7 🟠 构建与测试工具链

- **bash 脚本**：`scripts/run-ci-tests.sh`（团队本地全量门）与 `scripts/build-clawwork.sh` 是 bash，**Windows 开发者无法直接运行**。需提供 PowerShell 等价物，或要求 Windows 开发者走 WSL/Git-Bash（需文档化）。
- **npm 脚本**：`apps/web` 的 `dev`/`build`/`test`（[apps/web/package.json:7](apps/web/package.json:7)）是纯 vite/vitest 调用 + `&&`，**cmd 也支持 `&&`，基本可移植**——这一块不是阻碍。
- **CI 零 Windows**：当前只有 `ubuntu-latest`。Windows 要成为「被验证的平台」，必须加 `windows-latest` job（见 §5）。

---

## 3. 还没核实 / 需真机验证的未知项（静态审计的边界）

以下**无法靠读代码定论**，必须在真实 Windows（建议 Win10/11 + Python 3.12 + Node LTS）上跑才能确认。列出来是为了让团队知道「绿了静态审计 ≠ Windows 能用」：

1. CLI 修掉 `fcntl` 后，**`superclaw doctor` 能否真正起来**、`superclaw run --backend local` 端到端能否跑通。
2. 本地 API server（`uvicorn apps.api.main:app`）在 Windows 启动 + `/health` 是否 200。
3. Node sidecar 在 Windows 真起 + web 前端连通（端口、`detect-port`、loopback）。
4. 全量 `pytest` 在 Windows 的通过率——预计**大量涉及权限位 / `/tmp` / 子进程 / 信号的测试会红**（呼应 `CLAUDE.md`「测试环境无关性」铁律：本地绿 ≠ 跨平台绿）。
5. 路径长度（`MAX_PATH`）、保留文件名、大小写不敏感对 company/skill/plugin 落盘的影响。
6. 控制台编码（Windows 默认 `cp1252` vs UTF-8）对日志 / JSONL 事件流 / emoji 的影响。
7. §2.4 的治理语义：选 NTFS ACL 还是文档化弱姿态——这是**产品 + 安全决策**，不是纯工程。

---

## 4. 路线图（若决定走形态 B，分期推进）

> 每一期都按 `CLAUDE.md` 铁律走：worktree 隔离开发、只测相关、推 PR 前本地全量门、Codex + Gemini 双对抗验收通过才提交。

### P0 —「不崩」：让 CLI / API 在 Windows 能起来
- 修 [relay_key.py:27](packages/superclaw/src/superclaw/relay_key.py:27) 裸 `import fcntl` → `try/except` + `msvcrt` 兜底（照 `runtime_config.py` 范式）。
- 加一条 `windows-latest` CI smoke：`pip install -e .` → `python -c "import superclaw.cli"` → `superclaw doctor` → `npm run build`。**先把 Windows 从「零验证」变成「至少能 import + 构建」。**
- 验收口径：Windows CI 上 CLI 能 import、doctor 能跑、web 能 build。

### P1 —「本地后端可用」：CLI / API / Node 在 Windows 真跑通
- 趟通 §2.2 进程 / 信号：Windows 上用 `CREATE_NEW_PROCESS_GROUP` + `taskkill /T` 或 Job Object 实现「级联终止」，补齐 backend / plugin_proxy / claude_stream / node_runtime 的 Windows 终止路径。
- 决断 §2.4 治理语义：实现 NTFS ACL 硬化 **或** 文档化弱姿态 + 显式告警（**绝不静默 fail-open**）。
- 清 §2.3 硬编码路径：`/tmp`→`tempfile.gettempdir()`、字体路径走 `matplotlib`/系统字体发现。
- daemon IPC（§2.2）：TCP-loopback 或 Named Pipe 兜底（若该能力在 Windows 必须可用）。
- 全量 `pytest` 在 Windows 跑绿（预计要改一批权限位 / tmp 假设的测试）。
- 验收口径：Windows 上 `superclaw run --backend local` 端到端、本地 API + web 连通、`pytest` 绿。

### P2 —「桌面可装」：Windows 安装包
- Tauri：配 `externalBin`（PyInstaller Windows sidecar）、WebView2 bootstrap、NSIS/MSI 产物、Authenticode 签名。
- 趟 PyInstaller Windows 的 SSL/DLL 坑（[[frozen-backend-mei-ssl]] 的 Windows 版）。
- 上 `windows-latest` 构建产物 + 冒烟（启动不白屏、退出不留孤儿——呼应 [[desktop-startup-cleanup-watchdog]]）。

### P3 —「平价」：与 macOS 体验对齐
- 桌面通知、自更新、单实例、原生集成的 Windows 等价物。
- 文档：`docs/desktop-beta-quickstart.md` 增补 Windows 章节。

---

## 5. 测试与 CI 要求（Windows 成为「被验证平台」的门）

- **加 `windows-latest` job**（与 `ubuntu-latest` 并列 matrix）：分期对应 §4——P0 只跑 import+doctor+build；P1 起跑全量 `pytest` + API/health 冒烟；P2 起跑桌面构建+冒烟。
- **测试要对 Windows 友好**：呼应 `CLAUDE.md`「测试环境无关性」——涉及权限位 / 子进程 / `/tmp` 的测试需 `skipif(os.name == "nt")` 或提供 Windows 等价断言，**不得让 Windows job 因「测试本身假设 POSIX」而长红**。
- **本地门**：为 Windows 开发者提供 `scripts/run-ci-tests.ps1`（PowerShell 等价），或在文档明确「Windows 开发走 WSL2」。

---

## 6. 业主决策点（需拍板，AI 不替决）

1. **走形态 A 还是 B？** 只当 web 客户端（A，零工作）还是要 Windows 本地运行 / 桌面 app（B，按 §4 推进）？这是一切的前提。
2. **§2.4 治理姿态**：Windows 端用 NTFS ACL 做等价硬化，还是接受并文档化一个更弱的权限姿态？（涉及 fail-closed 红线，必须显式裁决，不能默认跳过。）
3. **桌面投入**：是否采购 Windows 代码签名证书、是否引入 `windows-latest` CI（消耗 Actions 分钟，见 [[ci-actions-minute-budget]]）。
4. **优先级**：Windows 排在 [[server-refactor-to-node-chat-compat]] 的 Node 再平台化主线**之前还是之后**？（Node 化对 Windows 是利好，建议**之后**——等后端搬到跨平台的 Node，Python 层只剩「启动器 + 治理」需要趟 Windows，工作量更小。）

---

## 附录：证据索引

| 类别 | 位置 | 问题 |
|---|---|---|
| 硬阻断 | [relay_key.py:27](packages/superclaw/src/superclaw/relay_key.py:27) | 裸 `import fcntl`，经 [cli.py:68](packages/superclaw/src/superclaw/cli.py:68) 顶层导入 → Windows CLI 崩 |
| 进程信号 | [desktop_runtime.py:567](packages/superclaw/src/superclaw/desktop_runtime.py:567) / [plugin_proxy.py:1041](packages/superclaw/src/superclaw/plugin_proxy.py:1041) / [claude_stream.py:206](packages/superclaw/src/superclaw/claude_stream.py:206) / [node_runtime.py:566](packages/superclaw/src/superclaw/node_runtime.py:566) | `killpg`/`getpgid`/`SIGKILL`，Windows 级联终止退化 |
| 桌面看护 | [desktop_runtime.py:665](packages/superclaw/src/superclaw/desktop_runtime.py:665) | watchdog 路径 POSIX-only |
| daemon IPC | [daemon.py:784](packages/superclaw/src/superclaw/daemon.py:784) | `AF_UNIX`，非 POSIX 直接 raise（fail-closed 但功能缺失） |
| clawwork RPC | [backends.py:3825](packages/superclaw/src/superclaw/backends.py:3825) | `select`+`fcntl` on pipe，Windows 不可用 |
| 硬编码路径 | [plugin_proxy.py:907](packages/superclaw/src/superclaw/plugin_proxy.py:907) / [plugin_submission.py:908](packages/superclaw/src/superclaw/plugin_submission.py:908) / [evals.py:2548](packages/superclaw/src/superclaw/evals.py:2548) | `/tmp`、`/usr/bin`、Linux 字体路径 |
| 治理权限位 | [secrets_store.py:140](packages/superclaw/src/superclaw/secrets_store.py:140) / [developer_identity.py:71](packages/superclaw/src/superclaw/developer_identity.py:71) / [plugins.py:311](packages/superclaw/src/superclaw/plugins.py:311) | `st_mode & 0o077` / `S_ISVTX`，Windows 静默跳过或误判 |
| 命令引用 | backends / process_scripts / credential_guard / capability_r2 | `shlex`（POSIX shell 引用） |
| 桌面打包 | [tauri.conf.json:36](apps/desktop/src-tauri/tauri.conf.json:36) | `targets: "all"` 但无 Windows 构建/`externalBin`/签名/WebView2 |
| 构建脚本 | `scripts/run-ci-tests.sh` / `scripts/build-clawwork.sh` | bash，Windows 跑不了 |
| CI | [ci.yml:34](.github/workflows/ci.yml:34) | 仅 `ubuntu-latest`，Windows 零覆盖 |
| 已正确处理（正面参照） | [runtime_config.py:12](packages/superclaw/src/superclaw/runtime_config.py:12) / [node_runtime.py:144](packages/superclaw/src/superclaw/node_runtime.py:144) / [backends.py:3128](packages/superclaw/src/superclaw/backends.py:3128) | `fcntl`+`msvcrt` 兜底 / `shutil.which("node")` / `clawwork.exe` —— 修其他处的范式参照 |
