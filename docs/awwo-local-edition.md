# AwwO 本地版（local edition）

AwwO 本地版在一台电脑上运行与线上版**同一套代码**：Go API、托管版网页（`apps/web` 的 SaaS 构建）和执行服务。它为一个人使用：账号、画布、运行记录和交付文件都保存在这台电脑上，模型调用使用使用者自己在「我的引擎」里保存的 Key，没有套餐、额度或付费。

它不是旧的本地开发入口（`npm run dev`，Paperclip 控制面与网关）的延续；那条线没有线上版此后增加的能力（首页案例、画布助手、媒体与剪辑节点、直接执行、设置中心、技能库等）。本地版直接运行线上版的服务，所以线上有的，本地版基本都有；例外见下文「本地版没有的」。

## Windows 安装包

普通使用者装 **AwwO Local**（`apps/windows-local`，NSIS，只装给当前账号）即可，不需要代码库、Node.js 或数据库：安装包带着本地版的全部程序（它自己的 Node.js 24、PostgreSQL 18.4 和它需要的 Visual C++ 运行库、API、网页和执行服务）。打开「AwwO 本地版」窗口，它在后台启动本地版（下文的运行时），显示启动进度，就绪后直接打开 AwwO；第一次启动完成时，它还打开 `admin-credentials.txt`，里面是本机账号和初始密码。关闭窗口时它先有序停止本地版再退出。数据放在 `%LOCALAPPDATA%\store.clawhunt.awwo.local\state`，与安装目录分开：升级、卸载都不动它（卸载时勾选「删除应用程序数据」，并在随后说明会删除哪些数据的提示中确认，才会删除；静默卸载从不删除）。安装包不会装到更新的版本上面（不能降级）。窗口的「AwwO」菜单可以重新启动、在浏览器中打开、打开数据目录、打开日志（`%LOCALAPPDATA%\store.clawhunt.awwo.local\logs` 中的 `runtime.log` 是运行时自己的日志，那个目录里没有任何密钥；各个服务的日志在数据目录的 `logs` 中），以及重置登录密码（以 `--reset-password` 重新启动，并打开新的 `admin-credentials.txt`）。本地版自己停下时，窗口显示它停下前报告的错误。窗口以 `--shell windows` 启动运行时，应用里原本提示运行 npm 命令的地方（登录页的密码重置、「设置 → 本机」）因此改为指向这个菜单。

升级或卸载时，安装程序先请正在运行的窗口退出（`--quit`），窗口照常有序停止本地版；没有窗口在运行时，`--quit` 会停下之前被强制结束的运行留下的数据库。安装程序等到安装目录下的程序都已结束（最多六分钟，等不到时提示重试），再整个移走旧的程序文件，所以升级不会留下旧版本的文件。数据目录不受影响。安装位置的路径不能超过 80 个字符（payload 里最深的路径有 170 个字符，加起来不能超过 Windows 的 260 个），并且必须在使用者自己的用户目录或 `%LOCALAPPDATA%` 之内（默认的 `%LOCALAPPDATA%\AwwO Local` 就是）：别处的文件夹沿用磁盘根目录的权限，这台电脑上的其他账号可能改动其中的程序，而这些程序握着本账号的密钥；被拒绝时安装程序删掉它刚建的空文件夹。窗口每次启动本地版、在运行 payload 里的任何程序（运行时、pg_ctl）之前，还会按真实路径（junction 指向的位置）读取安装目录、payload、代码与构建目录的权限：除本账号、SYSTEM、Administrators（以及域的 Domain Admins 与 Enterprise Admins）、TrustedInstaller、CREATOR OWNER 与 OWNER RIGHTS（以及本账号自己的沙盒应用）之外还有谁能改动其中的文件，目录的所有者不是其中之一，或目录没有访问列表（人人都能改），就拒绝启动并说明。payload 里任何一层出现链接（junction 或符号链接）也拒绝启动：安装程序不建链接，打包也拒绝带链接的 payload；把文件夹挪到别的磁盘的工具会留下 junction，它指向的位置没人检查过。读权限的 whoami 与 PowerShell 各限 60 秒，超时同样拒绝；检查通过后，本次运行不再重复，没通过时下次启动（菜单「重新启动」）会重新检查。安装位置的路径也不能含 `%` 或 `!`：PostgreSQL 经 cmd.exe 启动服务器，cmd.exe 即使在引号里也会把它们读作变量。

窗口停止本地版超过四分钟仍未停完时，会强制结束它，并停下它留下的数据库。

安装包没有签名，Windows 可能提示发布者未知（「更多信息 → 仍要运行」）。安装包里没有：Python 执行器（由 JS 执行器代替）、Academy 的视频（从线上公开副本播放）、ffmpeg（没有它渲染服务不开）、直接执行的工作区镜像（在安装版里构建它属于后续工作，直接执行暂时不开）。

打包（在 Windows 上，先 `npm run setup:local`，Docker 运行时构建直接执行的核心；再 `npm ci --prefix apps/desktop` 装 Tauri CLI；需要 Rust 与 Visual Studio C++ 构建工具）：

```sh
npm run package:local -- --smoke
```

`scripts/awwo-local-package.mjs` 先组装 payload：线上镜像运行的那些文件，按代码库的结构放（`app/` 是代码、`build/` 是程序）。执行器的依赖按它们镜像的方式 `npm ci --omit=dev --ignore-scripts` 安装，再去掉 Node.js 不会加载的类型声明和 source map、为其他系统或处理器构建的依赖（`package.json` 的 `os`/`cpu` 不含 Windows x64 的），以及没有任何执行器用到的编程代理剪贴板 `@mariozechner/clipboard`（原生插件；代理只在它存在时加载，线上的 Linux 执行器没有显示器也从不加载它）；某个依赖的 ES 模块构建 `dist-es` 路径过长（安装到用户目录下会超过 Windows 的 260 个字符）、而它的 `exports` 让 Node.js 只加载 CommonJS 构建时，去掉这个 `dist-es`，并用 payload 的 Node.js 以 import 和 require 加载该依赖的每个导出来确认；其他过长的路径会让打包失败。payload 不含任何数据和密钥：执行器目录里的点文件（`.env` 等）不进入 payload，组装后再检查一遍，发现 `.env`、`.npmrc`、私钥或证书文件就停止打包；payload 自己的脚本引用、而 payload 里没有的文件也会让打包停止。

PostgreSQL 只带服务器自己用的部分：程序、它们的库和数据文件；`lib` 里只留服务器自己加载的模块（PL/pgSQL、Snowball 词干、编码转换、复制模块与事件日志的消息）。不带任何扩展（contrib 与 EDB 的模块及其 control / SQL 文件：AwwO 的迁移不创建扩展，其中几个还带着别人按各自条款授权的代码，如 uuid-ossp 的 OSSP uuid、fuzzystrmatch 按 Perl 条款授权的 dmetaphone、pgcrypto 的一些部分），也不带 contrib 的两个程序 oid2name 与 vacuumlo、各程序的翻译（`share/locale`：运行时让它们用英文报告）、Perl / Python / Tcl 过程语言、编译扩展用的 `.lib`、`.a` 与 pgxs、EDB 的 StackBuilder 和只有它用的 wxWidgets 与 curl、ICU 的测试插件；`share` 里的目录文件（initdb 载入的，以及留下的 PL/pgSQL 扩展文件）提到的每个 `$libdir` 模块都要在 `lib` 里，否则打包停止。它的程序需要的 Visual C++ 运行库放在它旁边：取本机 Visual Studio 可再分发目录（`VC\Redist\MSVC\<版本>\x64\Microsoft.VC14x.CRT`，Visual Studio 的许可允许应用随带这里的文件）中不低于编译 PostgreSQL 的工具版本（读它们 PE 头里的链接器版本；PostgreSQL 18.4 要 14.44，即 Visual Studio 2022 17.14）的那份。都不够新时打包停止：只能加 `--test-build` 打一个测试用的包，它带系统里（别的软件装进 System32）的那份，不得发布：它的安装程序名为 `…_x64-setup-TEST.exe`，与发布用的分开，`LIBRARIES.md` 也写明它是测试包；更新 Visual Studio 的 C++ 构建工具后再打发布用的包。payload 里每个 x64 程序、库和 Node.js 插件导入的 DLL 都要在它会被找到的位置（加载它的程序旁边、它自己旁边，或 System32 中 Windows 自带的部分），否则打包停止。

许可证随 payload 一起放，缺了哪一份打包就停止，不会漏掉，也不会替谁编写文本：

- `licenses/`：AwwO 的 LICENSE 与 THIRD_PARTY_NOTICES.md，以及其中提到的每个许可证文件（与线上发布包相同，`scripts/awwo-saas-release.ts` 的 `noticePaths`；Go 模块的许可证会与 payload 里 API 实际链接的模块核对）。
- `licenses/npm/`：执行器的 npm 包。`NPM.md` 列出每个包（每个版本一次）的许可证（须是宽松许可证，否则打包停止）和许可证文件；包里没有许可证文件时，用它 README 里附带的许可证全文，或 `third_party/npm-packages` 里从它的仓库取来的许可证文件。
- `licenses/apps/windows-local/`：窗口程序的 Rust 代码。Rust 标准库的版权说明与许可证取自构建它的工具链自带的文档；每个链入的依赖包的许可证在 `crates/<名称>-<版本>/`，取自包本身，包里没有时取自 `third_party/rust-crates`；webview2-com-sys 链入了微软的 WebView2 加载器，因此附带它所带 SDK 版本的 WebView2 SDK 许可证；MPL-2.0 的包都附 `SOURCE.txt` 注明源码位置。
- `build/pgsql/`：PostgreSQL 的 `server_license.txt` 与 EDB 的 `commandlinetools_3rd_party_licenses.txt`（setup 一并解压）；PostgreSQL 自己源码里别人的代码（正则引擎、pg_dump、Snowball 词干、Unicode 表、Ryu、md5 / sha1 / sha2、`src/port` 里 BSD 与 ISC 授权的文件等）的完整版权说明：Debian postgresql-18 软件包的 `debian/copyright`（固定到一个提交），以及 `NOTICES.txt`——从 PostgreSQL 18.4 源码发布包（按 postgresql.org 公布的 SHA-256 核对）里每个带别人版权或授权文字的文件头摘出；以及 `LIBRARIES.md`：PostgreSQL 带的每个库（ICU、libxml2、libxslt、zlib、lz4、zstd、OpenSSL、winpthreads 等）自己的许可证文件在 `licenses/`，取自各库对应版本的发布（`third_party/postgres-windows`；EDB 的说明里没有 ICU 的许可证，zstd 的缺版权行）；LGPL 的 libintl（gettext 0.19.8）与 libiconv（1.18）构建所用的 GNU 源码发布包在 `sources/`，setup 在 Windows 上下载并核对 SHA-256。名单记着每个 DLL 的 SHA-256：bin 目录里出现名单之外的 DLL、名单上的 DLL 字节不同（另一个构建，许可证与源码未必对得上）、lib 目录里有不是 PostgreSQL 自己的模块（版本信息不写 PostgreSQL Global Development Group），或 `postgres.exe -V` 报的不是名单的版本，打包都会停止，要先更新 `scripts/awwo-postgres-licences.mjs` 的名单。postgres.exe、pg_dump 等程序和 lib 里的 pgcrypto 内置了 zlib；libintl、libiconv 与 libwinpthread 由 MinGW-w64 的 GCC 构建，链入了 MinGW-w64 的运行库（其中有 gdtoa 等需要附带说明的部分），它的许可说明（运行库 5 与 10 两个版本）也在 `licenses/`，`LIBRARIES.md` 一并写明。`third_party/` 下的文件与 `PROVENANCE.json` 记录的不一致时，打包也会停止。
- Node.js 的 LICENSE 在它的目录里。

`third_party/` 下这三个目录分别由 `node scripts/awwo-npm-licences.mjs`、`awwo-crate-licences.mjs`、`awwo-postgres-licences.mjs` 取来：npm 包与 Rust 包取自发布它的那次提交（npm 的注册表没记提交时，取版本标签，再没有就取默认分支当天的提交并如实记下），PostgreSQL 的库取自对应版本的标签。只接受与包声明的许可证一致的文件，在 `PROVENANCE.json` 记下来源地址与 SHA-256；各自的 `--check` 检查是否齐全、与记录是否一致。

`--smoke` 用这份 payload 自己的运行时在临时数据目录上启动一次再停止（不带打包环境里的 `NODE_*`、`npm_*`、`AWWO_*` 设置），然后用 Tauri 构建 NSIS 安装包，并给出它的 SHA-256。组装期间持有 setup 的代码锁和构建锁（共享），setup 不会在这期间替换文件。

makensis 按完整路径读取每个文件，超过 260 个字符就失败，所以代码库所在的路径太深时（例如 `.claude/worktrees/…` 下的工作树），打包会提示改用 `--out`：`npm run package:local -- --out D:\awwo-local` 在这个目录里复制窗口的源文件，把 payload 组装在其中的 `payload`，并在那里构建安装包（也适合换到更快的磁盘）。这个目录须是空的，或是之前打包时建立的。`--no-installer` 只组装 payload；`--keep-payload` 用之前组装好的 payload 只构建安装包，但只接受由当前打包脚本、在同一提交且代码库没有改动时组装的 payload（各项检查都在组装时做）。

## 从代码库运行

```sh
npm run setup:local
npm run local
```

打开 `http://awwo.localhost:5199`，用 `.local/awwo-local/state/admin-credentials.txt` 中的账号登录（`owner@awwo.local`）。首次启动会建立数据库并为这个账号创建「我的工作区」。按 Ctrl-C 停止；运行时停完后会显示 `AwwO 本地版 has stopped.`（在 Windows 上，`npm run local` 在按下 Ctrl-C 时就回到提示符，本地版仍在后台停止，以这一行为准；直接运行 `node scripts/awwo-local.mjs` 则会等它停完）。

`*.localhost` 在当前所有浏览器中都指向本机，并被视为安全上下文。本地版用这样的名字而不是 `127.0.0.1`：浏览器把 `127.0.0.1` / `localhost` 的 Cookie 发给同一主机的每个端口，其他本机网页服务（或另一套 `dev:saas`）会收到本机会话，或把它覆盖。Cookie 也不按端口区分，所以每个数据目录在首次启动时得到自己的名字 `awwo-<实例标识>.localhost`（保存在它的 `local.env` 中，即 `AWWO_LOCAL_HOSTNAME`）：同一台电脑上的两个实例（同一份代码或两份代码）不会共用会话。打开 `http://awwo.localhost:5199` 或 `http://127.0.0.1:5199` 会跳转到这个名字；它的 API 只接受来自这个名字的请求。

`setup:local` 可以重复运行：已是最新的部分会跳过。它会：

- 在缺少时下载 Node.js 24.22.1（nodejs.org，按该版本 `SHASUMS256.txt` 中的 SHA-256 校验），只供本地版的服务使用，不改动系统中已有的 Node.js；
- 在 Windows 上缺少 PostgreSQL 时下载 EDB 的 PostgreSQL 18.4 二进制包（只解压 `bin`、`lib`、`share`）。EDB 不公布该压缩包的校验值；脚本固定的是 2026-10-21 从 `get.enterprisedb.com` 经 HTTPS 下载的那一份的 SHA-256。其他系统请把 `initdb`、`pg_ctl`、`postgres`、`psql`、`createdb` 放在 PATH 上，或设置 `AWWO_LOCAL_PG_BIN`；
- 为 Web、Pi、OpenAI Agents（JS）和渲染服务安装依赖：执行服务与线上镜像一样不装开发依赖、不运行安装脚本（`--omit=dev --ignore-scripts`），网页带上构建工具；用 `uv`（或 Python 3.12 的 venv）建立 Python 执行器的环境；
- 构建 Go API 和网页，构建直接执行的核心（只需 git 与 npm）；
- Docker 正在运行时，构建工作区镜像（`awwo-workspace:local-<源码哈希>`）；
- 带 `--staged-videos` 时，下载 Academy 的 27 个教程视频和《THE LONG CHORD》的成片（约 1.5 GB，每个文件按其完整 SHA-256 校验；已有文件也会重新校验）。

更新代码后先停止本地版，再运行 `setup:local`：Windows 不允许覆盖正在运行的程序。`setup:local` 会替换代码中的部分（依赖、网页构建、直接执行的核心）和构建目录中的部分，所以有两把锁：代码的 `.local/awwo-local/code.lock` 和构建目录的 `build.lock`。每个运行时在运行期间持有这两把锁（共享，无论它用哪份代码、哪个构建目录），`setup:local` 工作时独占它们，所以这份代码或这个构建有任何运行时（无论数据目录在哪）时 setup 会拒绝执行，setup 进行中运行时也不会启动，两个 setup 也不会同时进行；拿不到锁的运行时不会启动。`setup:local` 只替换带着它的代码库和该代码库自己的构建目录（`.local/awwo-local/build`），所以只有这两处有锁：打包好的应用的代码与构建目录没有锁，运行时也不在应用包里写任何文件；它若用的是某个代码库的构建目录，仍持有那个构建目录的锁。这些锁和下文数据目录的锁都是操作系统的锁，随持有它的进程结束而释放，进程如何结束都一样，所以不会留下需要手动删除的锁。

构建目录和代码属于这份代码库：本地版只把数据目录设为私有。能修改代码库的其他账号也能改动这里运行的程序，或占住构建锁让本地版无法启动；在多人共用的电脑上，请像保护其他要运行的代码一样保护代码库（Windows 上 `E:\` 这类非系统盘的根目录默认允许所有已登录账号修改）。

## 与线上版的对应

| 线上服务 | 本地版 | 条件 |
| --- | --- | --- |
| PostgreSQL | 本机 PostgreSQL 18，只监听 127.0.0.1，不开 Unix socket | — |
| Go API | 同一 API，`APP_ENV=development`（本机 http），个人 Key 模式 | — |
| 网页（nginx） | `scripts/awwo-local-web.mjs`：静态文件 + `/api/v1/` 反向代理，安全头与线上 nginx 相同；只回应 `awwo.localhost:<端口>` | — |
| Pi 执行器 | 同一执行器 | — |
| OpenAI Agents（Python） | 同一执行器，线上同样把它放在 API 的 openai-agents 路径上 | 未装好 Python 环境或它启动失败时由 JS 执行器代替 |
| 直接执行（OpenMaus 托管核心） | 同一服务；工作区容器无网络 | Docker 运行、工作区镜像与核心已构建 |
| 渲染服务（渲染为视频、剪辑节点） | 同一服务，驱动本机 Chrome 或 Edge | Chrome/Edge、ffmpeg、ffprobe 可用 |
| 从网址读取、技能库（skills.sh） | 已开启 | 需要网络；可经本机代理（下文 `AWWO_WEB_READER_PROXY`） |

某项可选服务不能运行时，本地版不启动它，也不把它告诉 API；应用中的对应功能显示为未就绪，与线上缺少该服务时一样。画布上传和渲染的文件存放在数据目录的 `media/` 中，没有渲染服务和媒体 Key 时上传同样可用。

## 本地版的界面

运行时以 `AWWO_EDITION=local` 启动 API（`backend/internal/app/edition.go`），网页据此（`/auth/options` 与 `/auth/me` 中的 `edition`）换成本地版的样子，其余与线上相同：

- **「设置 → 本机」代替「用量与计费」**：数据目录与备份方法、`providers.env` 的位置与媒体服务是否开启、直接执行 / 渲染 / 从网址读取 / 技能库是否在运行（以及开不起来时缺什么）、版本。内容来自 `GET /api/v1/local`（只在本地版、只对平台管理员回答，不含任何 Key 或令牌）。应用中指向「用量与计费」或「邀请好友」的链接都打开这一页。
- **没有套餐与升级**：升级卡片、Opus 5.5 邀请、今日额度表和画布「下一步」里的升级都不出现。本机账号拥有的工作区本来就没有模型层面的限制（运营方工作区）。
- **不再注册**：`AWWO_REGISTRATION=closed`，API 拒绝 `/auth/register`（`registration_closed`），登录页不显示「创建账号和工作区」，并说明初始密码在 `admin-credentials.txt`。这个开关只关闭本机注册，所以 API 不接受它与 ClawHunt 登录同时设置（那时账号来自 ClawHunt 的首次登录）。成员页不再提供邀请：没有人能接受。
- **忘记密码**：本地版不发邮件，登录页不显示「忘记密码？」。停止本地版后运行 `npm run local -- --reset-password`：运行时生成新密码，写入 `local.env` 和 `admin-credentials.txt`，API 在启动时把它设到本机账号上（`AWWO_BOOTSTRAP_ADMIN_RESET=<重置标识>`，只在本地版有效），并结束该账号的所有登录会话。`local.env` 中的 `AWWO_LOCAL_PASSWORD_RESET=<重置标识>` 记着这次重置，直到 API 带着它启动成功：这次启动在 API 之前失败的话，下一次普通启动会接着完成。API 对每个标识只执行一次（记在审计记录里），所以没能清掉的标记不会在之后覆盖你改过的密码。
- **新手教程只提供一次，不强制**：可以关掉，之后从菜单再打开。
- **平台管理的入口不显示**（`/admin` 地址本身仍可打开）。
- **数据管理**：「导出我的数据」照旧；「从 AwwO 在线版导入」读取线上「设置 → 数据管理 → 导出我的数据」下载的 JSON 文件，为其中每个正常状态的工作区在本机新建一个同名工作区，再经 API 逐一创建画布（画布保存忙时稍候重试；被拒绝的画布列出原因，其余照常导入；会话结束或 API 不再回应时导入停止并说明）。每张画布先与线上工作区脱离：节点绑定的 Agent、会话与对话线程、`agentRef`、工作区技能、指向线上文件或媒体的结果都被清除（线上的这些对象本机没有，API 会拒绝它们），节点在本机第一次运行时重新建立；输入字段和打开的对话里未发送的草稿（媒体节点的提示词就在这里）去掉线上附件后保留，纯文字的结果也保留，没有重跑的节点仍把它交给下游。超过 200 字节的名字按字符截短；超过 400 MB 的文件浏览器读不了，会直接说明。被中断的导出文件（`"complete":false`）和更新版本写出的文件会被拒绝；同一个文件再导入时会提示将多出一份。节点的对话记录，以及线上生成的图片、视频、3D、配音和上传文件不在导出文件里；节点挂的个人技能需要重新添加，线上的模型本机没有时需要重新选择；设置与配色不导入。「申请删除账号」换成说明：本机数据只在这台电脑上，停止本地版后删除数据目录即可；要留备份就复制整个数据目录（导出的 JSON 不含文件、运行记录和已保存的 Key）。

### 经本机代理读取网页

在 `providers.env` 中设置 `AWWO_WEB_READER_PROXY=http://127.0.0.1:<端口>`（例如 Clash 的混合端口）并重启后，「从网址读取」和技能库的所有连接都经这个代理建立；不设置时直接连接，任何时候都不读取 `HTTP_PROXY` 等环境变量。只接受 `http://127.0.0.1:<端口>`，且只在 `APP_ENV=development`（本地版即是）下生效。

直接连接时，API 在建立每个连接时检查对方地址，只连公网地址。经代理时检查同样严格：API 先在本机解析网址的主机名，所有结果都必须是公网地址，再请代理建立到**这个地址**的隧道（`CONNECT <IP>:<端口>`），而不是把名字交给代理再解析一次；TLS 仍按网站的名字验证证书。解析到内网、本机或保留地址的名字被拒绝；本机 DNS 返回 fake-IP 地址（198.18.0.0/15，代理的 DNS 给出的替身地址）或解析不了的名字也被拒绝，因为无法确认网站在哪里——代理的 DNS 处于 fake-IP 模式时，需要改用返回真实地址的模式（例如 Clash 的 redir-host）才能经代理读取网页。代理需要支持 CONNECT（含 80 端口，http 网址也走隧道）。网址本身的规则不变（只按名字、不接受本地名字、只用 80 和 443 端口）。

## 内容

首页 23 个生产案例（含 PALLWARD、THE LONG CHORD 与四个旗舰案例的运行记录、封面与媒体）、Academy 目录、画布模板、内置技能、角色市场和模型目录都随代码，构建时进入网页。

Academy 的视频和《THE LONG CHORD》的成片太大，不在代码中。用 `--staged-videos` 下载后从本机播放；未下载时，本地版从线上公开副本播放这些视频（`local.env` 中 `AWWO_LOCAL_STAGED_FALLBACK=none` 可关闭，改为 404）。

线上的账号、画布和运行记录不会自动复制到本地版；画布可以用线上的数据导出文件导入（见上文「数据管理」）。

「原理图解」节点生成的网页从线上的公开地址加载 figure kit（Anatomy 的绘图模块），本地版不改：这样下载或分享出去的页面在任何地方都能打开；这台电脑离线时，这类页面的图形不显示。

## 数据与配置

本地数据目录默认是 `.local/awwo-local/state`。在 Windows 上，运行时在写入任何密钥之前把这个目录设为只有当前账号和 SYSTEM 可以访问（关闭继承，只留这两个 SID 的完全控制，目录内文件随之继承），并按 SID 读回确认：目录的所有者须是当前账号、SYSTEM 或 Administrators，其中的密钥文件也只允许这两个 SID。做不到时拒绝启动。其他系统上目录权限为 700。在任何系统上，属于其他账号的目录会被拒绝；没有 `local.env` 的目录，尚未只属于本账号的只能是空的（Finder 的 `.DS_Store`、`.localized` 与 Explorer 的 `desktop.ini`、`Thumbs.db` 这类系统文件除外），已经只属于本账号的还可以有首次启动在写 `local.env` 之前留下的东西（`logs`、`media`、`openmaus`、`render-tmp`、`runtime.lock`、写到一半的 `local.env` 副本），有数据库（`postgres/PG_VERSION`）时还可以有运行时自己的全部文件：那是丢了 `local.env` 的数据目录，运行时随后说明这一点并请你恢复它。其他目录（指错了的 `--state`，或 Mac 应用早期本机模式的目录：它也只属于本账号，里面有 `models.env` 和旧的 `admin-credentials.txt`）一律被拒绝，而不会被改权限或写入。Windows 上的检查通过 Windows PowerShell 读取权限；PowerShell 被 WDAC 或 AppLocker 限制为受约束语言模式（Constrained Language Mode）的电脑上无法检查，本地版因此不会启动。

| 路径 | 用途 |
| --- | --- |
| `local.env` | 运行时生成的设置与密钥：数据库密码、每个服务的令牌、本机登录的初始密码、本实例的标识与名字，以及加密已保存 API Key 的主密钥 `AWWO_CREDENTIAL_ENCRYPTION_KEY`。主密钥只生成一次、永不替换；**备份数据库时一并备份此文件**。文件无法读取时运行时会停止，而不会重写它；数据库已存在而文件丢了主密钥或数据库密码时同样拒绝启动，不会重新生成。 |
| `runtime.lock` | 正在使用这个目录的运行时持有的锁（操作系统的锁：Windows 上以独占方式打开，macOS 上是 flock，Linux 上改用以它命名的抽象 Unix 套接字，需要 Node.js 22 以上）。一个数据目录同时只能有一个运行时；锁随运行时的进程结束而释放，所以不会有需要接管的残留锁。Linux 的锁按名字区分：同一个数据目录经两个挂载点、在容器内外或经网络共享打开时，彼此看不到对方的锁，所以一个数据目录只在一台电脑、一个容器（命名空间）中运行。 |
| `providers.env` | 可选的媒体服务密钥（图片、视频、3D、配音）、媒体下载用的本机代理（`AWWO_MEDIA_DEV_PROXY`）和读取网页用的本机代理（`AWWO_WEB_READER_PROXY`）；只接受这些名称。旧版本生成的文件没有最后一行，需要时手动加上。 |
| `admin-credentials.txt` | 本机账号与初始密码。在设置中修改密码后，此文件不会更新；`npm run local -- --reset-password` 会换上新密码并更新它。 |
| `postgres/` | 数据库。 |
| `media/` | 上传、媒体节点和渲染生成的文件。 |
| `logs/` | 每个服务的日志。 |

数据库与线上一样是 UTF-8：AwwO 用的 `awwo` 库以 UTF-8（`--locale=C`）从 template0 建立，每次启动都核对，不是 UTF-8 时运行时拒绝启动。PostgreSQL 集群自己的库（template1、postgres）则是 SQL_ASCII：initdb 会把它 `share` 目录的路径写进它执行的 SQL（导入 `sql_features.txt` 的 COPY），UTF-8 的库不收不是 ASCII 的路径，而中文账号的 `%LOCALAPPDATA%`（默认的安装目录和数据目录都在其中）就不是。PostgreSQL 的程序按系统的 ANSI 代码页（「非 Unicode 程序的语言」）接收路径，代码页里没有的字符（例如中文 Windows 上的韩文账号名、emoji）到它们那里会变成「?」，所以在 Windows 上，运行时（和窗口停下残留数据库时）把不是 ASCII 的路径换成它的短名（8.3）再交给它们；中文 Windows 的短名仍保留中文，这些字符代码页里都有。路径里有代码页没有的字符、所在的卷又不保留短名（系统盘默认保留）时，PostgreSQL 无法启动，运行时的错误会说明这一点。PostgreSQL 经系统的 shell 启动服务器与 initdb 的引导（Windows 上是 cmd.exe，其他系统上是 /bin/sh），所以交给它的路径在 Windows 上不能含 `%` 或 `!`，在其他系统上不能含 `$`、`` ` ``、`"` 或 `\`：有这些字符时运行时在启动数据库之前就拒绝，并说明是哪个目录。

模型的 API Key 在应用的「我的引擎」中添加，加密保存在数据库中；每次运行由 API 交给执行器，只用于该次调用。本地版不附带任何平台 Key。

媒体服务只提供给本机账号（平台管理员）拥有的工作区（API 的 `mediaEntitled`：管理员拥有的工作区即运营方自己的工作区）。本地版不打开「所有工作区可用媒体」的开关，所以即使有人在这台电脑上另注册账号，也用不了 `providers.env` 中的媒体 Key。

## 本地版没有的

- **沙箱执行（sandbox）**：API 在个人 Key 模式下拒绝沙箱运行时（沙箱只接平台模型），本地版因此不启动沙箱执行器。四个旗舰案例的记录可以完整查看，但在本地重新运行沙箱节点需要先为沙箱接通个人 Key。沙箱执行器在容器里多轮调用模型，把个人 Key 交给它会让 Key 进入代理运行的代码所在的环境；安全的接法是让它的模型调用经过 API 的模型代理（直接执行已经这样做），需要改 Python 执行器的项目执行模式和 API 的准入，约一天以上，单独排期。需要「在一台电脑上做事」的任务可以用直接执行。
- 只属于托管服务的部分：ClawHunt 统一登录与邀请码门禁、付费套餐与结算、促销额度与签到、Cloudflare 隧道与访问门禁、Jev/TypeSafe 规划、即梦命令行、工作区出网代理（直接执行的工作区没有网络）。这些设置为空时线上代码会自行隐藏对应界面，套餐与升级由本地版的界面隐藏（见「本地版的界面」）。

## 运行时协议（桌面窗口）

`scripts/awwo-local.mjs` 也是桌面窗口要启动的程序：

- `--events`：标准输出每行一个 JSON：`{"event":"status","step":…}`、`{"event":"ready","url":…,"stateDir":…,"services":{…}}`（`url` 是这个数据目录自己的地址）、`{"event":"error","message":…}`，以及停完时的 `{"event":"stopped","code":…}`；日志写到标准错误。
- `--parent-pid <pid>`：该进程结束时停止；`--stop-on-stdin-close`：标准输入关闭时停止。
- `--state <dir>`、`--resources <dir>`、`--build <dir>`：数据目录、代码目录与构建目录。Windows 路径的 `\\?\` 前缀（规范化了自己路径的启动程序会这样传，例如 Tauri）会被去掉：PostgreSQL 的程序按启动它们的路径互相查找，从这样写的路径启动不了。
- `--shell windows`：由 AwwO Local 的窗口启动（API 得到 `AWWO_LOCAL_SHELL=windows`，`/auth/options` 与 `/api/v1/local` 中的 `shell`），应用据此提示窗口的菜单，而不是 npm 命令。
- `node scripts/awwo-local.mjs <resources> <state> <parent pid>`：`apps/macos/AwwOLocal.swift` 已实现的本机工作区协议（等同于 `--events`）。该外壳目前只接受 `127.0.0.1` / `localhost` 的 `ready` 地址，重新启用 Mac 本机模式时需改为接受 `*.localhost`。

每个服务由 `scripts/awwo-local-reaper.mjs` 启动，运行时握着它的标准输入：要停止某个服务时，运行时在其中写入 `stop` 再关闭。管道没有 `stop` 就关闭了，说明运行时已经不在（被强制结束或崩溃）：服务及其启动的进程立即结束，端口随之释放，这样同一数据目录上接着启动的运行时不会遇到还在工作的旧服务。服务自己退出时，它启动、仍在运行的进程也随之结束（其他系统上是它的进程组；Windows 上是它启动的进程，Node.js 本身会结束自己的子进程，其他程序不会）。必需的服务（Pi、OpenAI Agents、API）在任何时候停止都会结束整个运行时，启动期间也一样。

每个 Node.js 服务，以及它启动的 Node.js 程序，最先加载 `scripts/awwo-local-module-guard.cjs`（继承服务环境的程序经 `NODE_OPTIONS`；执行器另起的运行进程、托管执行的核心和我们给它的 MCP 进程 `awwo_workspace` 不带父进程的 Node 选项，由执行器按 `AWWO_LOCAL_MODULE_GUARD` 显式带上这一项，线上没有这个设置，一切照旧；核心自己另起的 Node.js 程序还没有，直接执行目前不在安装版里）。Node.js 找包时会一路查到磁盘根目录，依赖缺了某个可选包（编程代理的剪贴板、ws 的 bufferutil）也会这样找，而电脑上任何账号都能建 `C:\node_modules`；没有这道检查，别的账号放在那里的代码会在握着本账号密钥的服务里运行。规则只有一条：真实路径不在本地版自己的目录（代码、构建和数据目录，都只属于本账号）里的模块，一律当作找不到。本地版运行的东西都不从别处加载代码，所以没有例外：不管模块是怎么找到的（本地版目录之上的包、那里指向别处的 junction、`main` 指到包外的 `package.json`、包的 imports 映射、自引用），只看它的文件实际在哪里。数据目录里工作区自己的 `node_modules` 照常可用。目录以 JSON 数组传给它（路径里可以有 `;`），读不懂时服务不启动。服务的环境里本来就不带使用者自己的 `NODE_OPTIONS`。

停止（Ctrl-C、标准输入关闭、父进程结束或信号）按以下顺序进行，在 Windows 上和其他系统上相同：

- 先停 API：它的标准输入随之关闭（`AWWO_STOP_ON_STDIN_CLOSE`），API 像收到 SIGTERM 时一样有序关闭，最多等 30 秒，让正在提交的媒体生成记下任务编号、重启后继续，而不是被重复计费（线上同样给 API 45 秒）。Windows 没有可发给控制台程序的温和信号，所以用标准输入。
- 再停执行器：Windows 上直接结束；其他系统先发 SIGTERM，20 秒后强制结束整个进程组。API 与执行器把运行状态保存在数据库中，下次启动后继续未完成的运行。
- 然后移除本实例的工作区容器：直接执行的工作区容器带有本实例的标签（`awwo.workspace-instance`），运行时在每次启动和停止时移除带此标签的容器，不触碰其他实例的容器。列不出或移除不了时，运行时报告错误，并以非零状态退出（运行期间退出了 Docker Desktop 时也是这样：它的容器已随之停止）。
- 最后由 `pg_ctl` 快速关闭 PostgreSQL；没有关掉时运行时报告错误，并以非零状态退出。运行时被强制结束后，数据库会留下来：下次启动时，若仍有程序连着它（例如运行时在停止途中被强制结束时还在有序关闭的 API，或另一个连着数据库的工具），先等它们断开（最多一分钟），再停止它并按新设置启动。
- 停止开始一秒以后再按一次 Ctrl-C（或再发一个信号），运行时不再等待：所有服务立即结束，PostgreSQL 立即关闭（正在进行的数据库启动或关闭会先完成）。这样停止时，正在提交的媒体生成可能丢失（已由服务商计费）。一秒之内的第二个信号算作同一次：`npm run` 会把终端的 Ctrl-C 再转给运行时，而运行时已从终端收到过它。终端的 Ctrl-C 与挂断也会传到各个服务的包装进程，它们不理会，交给运行时按顺序停止。
- 运行时自己被强制结束（任务管理器、`kill -9`）时，所有服务随之立即结束，API 来不及有序关闭。

## 端口

网页 5199（固定：浏览器按地址保存未发送的草稿；被占用时报错，可在 `local.env` 中改 `AWWO_LOCAL_WEB_PORT`），同时监听 IPv4 与 IPv6 本机地址：浏览器先在 IPv6 上尝试 `*.localhost`，所以该端口在 `[::1]` 上被其他程序占用时同样报错（没有 IPv6 本机地址的电脑只监听 IPv4）。其余服务从 18087（API）、15483（数据库）、18097、18099、18109、18111 开始，被占用时依次顺延。这些端口避开了 `dev:saas` 的端口和 Windows 的动态端口范围。

## 验证

```sh
npm run test:local
```

运行 `scripts/awwo-local.test.mjs`（运行时、包装进程、模块检查、锁与 setup）、`scripts/awwo-local-web.test.mjs`（网页服务与代理）、`scripts/awwo-local-package.test.mjs`（Windows 安装包的 payload）和 `scripts/awwo-local-licences.test.mjs`（安装包带的许可证）。其中一项测试用构建好的 API 程序检查本地版生成的设置在各种可选服务与媒体 Key 组合下都能被 API 接受。

## 后续

1. 为沙箱接通个人 Key（经 API 的模型代理，见「本地版没有的」）。
2. Windows 安装版里构建直接执行的工作区镜像（Docker 运行时），并带上 ffmpeg 或说明安装方法。
3. Mac：重新打开 `AwwOLocal.swift` 中的本机工作区：接受 `*.localhost` 的 `ready` 地址；只向运行时本身发信号（它的强制清理会向各个包装进程发 SIGTERM，那在包装进程是「立即结束」）；把停止期限从 20 秒放宽到有序停止所需的时间（API 最多 55 秒、执行器 30 秒、数据库最多 120 秒）；升级与备份。
4. Linux 与 macOS：托管核心（OpenMaus）由直接执行的服务以独立进程组启动，那个服务崩溃或被强制结束时，核心不会随包装进程结束（工作区容器仍按标签移除）。
5. 工作区出网代理在 Docker 的 Linux 环境中运行，使直接执行的工作区可以联网。
