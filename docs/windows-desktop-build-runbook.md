# Windows 桌面安装包构建手册（Windows Desktop Build Runbook）

> 怎么在 Windows 上从源码构建 SuperClaw 桌面安装包（`.msi` + NSIS `.exe`，内含 PyInstaller 冻结的 Python sidecar）。
> 关联：[[windows-support-assessment]]、[[desktop-beta-quickstart]]。

## 0. 前置工具链

| 工具 | 版本 | 说明 |
|---|---|---|
| Python | 3.12 | 建项目 venv（`.venv\Scripts\python.exe`），装 `pip install -e ".[dev,desktop-build]"`（`desktop-build` 带 PyInstaller） |
| Node | 22 LTS | `npm`；前端 + Tauri CLI |
| Rust | stable (MSVC) | `rustup default stable-x86_64-pc-windows-msvc`；Tauri 用 MSVC 工具链 |
| MSVC Build Tools | 2022 | 需 `VC.Tools.x86.x64` 组件 + Windows 10/11 SDK（`link.exe` / `rc.exe`） |
| WebView2 Runtime | 任意近期版 | 终端用户机器同样需要；安装包配了 `downloadBootstrapper` 自动拉取 |

## 1. 一行命令（干净检出路径）

```powershell
# 仓库根（路径不含空格/撇号等 RC 敏感字符时）
npm --prefix apps/desktop ci
npm --prefix apps/web ci
npm --prefix apps/desktop run tauri:build:win
```

`tauri:build:win` = `build-backend.mjs`（PyInstaller 冻结 + 落入 `src-tauri/resources/backend/`）→ `tauri build`。
产物：

```
apps/desktop/src-tauri/target/release/bundle/msi/SuperClaw_<ver>_x64_en-US.msi
apps/desktop/src-tauri/target/release/bundle/nsis/SuperClaw_<ver>_x64-setup.exe
```

CI 走这条路径：见 `.github/workflows/desktop-windows.yml`（tag `v*` 或手动 `workflow_dispatch` 触发，自动上传产物并附到 Release）。

## 2. 仓库路径含撇号/空格时（本机特例）

微软资源编译器 `rc.exe` 会把内嵌图标的**绝对源路径**里的撇号转义成 `\'`，触发
`RC2135 file not found`（例如检出在 `E:\Bob's code\...`）。这是 `rc.exe` 的局限，不是项目 bug——
GitHub runner 与普通检出路径无此问题。

逃生阀：`build.rs` 读 `SUPERCLAW_WINDOWS_ICON` 环境变量；设它指向一个**干净路径**的 `.ico` 副本，
则仅 EXE 内嵌图标用它，安装包 bundler 仍读 `bundle.icon`（相对路径，照常）：

```bat
:: 1) 拷一份图标到无特殊字符的路径
mkdir C:\scicons
copy "apps\desktop\src-tauri\icons\icon.ico" C:\scicons\icon.ico
copy "apps\desktop\src-tauri\icons\icon.png" C:\scicons\icon.png

:: 2) 进 MSVC 环境 + 指定干净图标 + 用仓库自带的相对图标配置构建
call "<VS>\VC\Auxiliary\Build\vcvars64.bat"
set "SUPERCLAW_WINDOWS_ICON=C:\scicons\icon.ico"
cd apps\desktop
node scripts\build-backend.mjs
node_modules\.bin\tauri.cmd build --config src-tauri\tauri.conf.json
```

**不要**用目录联结（junction）/`subst` 绕路径：`tauri-winres` 会把图标路径 canonicalize
回真实（含撇号）路径，联结无效。同理，把整树拷到全新目录可能触发实时安全扫描器锁文件
（`LINK : fatal error LNK1105 ... 错误代码 1224 = USER_MAPPED_FILE`）——在仓库原地构建（扫描器已放行）+
上面的图标逃生阀是最稳的本机组合。

## 3. 代码签名（未做）

产物当前**未签名**，Windows SmartScreen 会对未签名 `.exe`/`.msi` 弹警告。要消除需 Authenticode 证书
（与 Apple 公证不同），由业主采购后在 `desktop-windows.yml` 增签名步骤（signtool）。

## 4. 校验

```powershell
# 冻结的后端能独立跑（安装包内就是它）
apps\desktop\src-tauri\resources\backend\superclaw-backend\superclaw-backend.exe --help
# 安装后：开始菜单启动 SuperClaw；首启自动拉起 sidecar + WebView2
```
