# AwwO 本地版 for Windows

The installer of AwwO 本地版 (docs/awwo-local-edition.md): a window around the local runtime. It installs, for the
signed-in account only, the runtime and everything it runs — its own Node.js, PostgreSQL 18.4 with the Visual C++
runtime it needs, the API, the web app and the services — and keeps the account's data apart from the installation, in
`%LOCALAPPDATA%\store.clawhunt.awwo.local\state`, so an update or an uninstall leaves it: the uninstaller's
「删除应用程序数据」 removes it only once a second prompt, saying what goes (the account, canvases, runs, files, saved keys
and the database), is answered Yes; a silent uninstall never does. It does not install over a newer version.

What the window does:

- It starts `scripts/awwo-local.mjs` from the installed files (`--events --stop-on-stdin-close --shell windows
  --parent-pid`, its paths without Tauri's `\\?\` prefix, and without the person's `NODE_*` settings), shows its
  progress on a page of its own, and opens AwwO at the address the runtime reports when it is ready
  (`http://awwo-<instance>.localhost:5199`); the first start also opens `admin-credentials.txt`, the account and its
  first password. `--shell windows` has the app name this window's menu where it would name an npm command, and has
  the runtime refuse to start where an account other than this one (or SYSTEM, Administrators, TrustedInstaller and
  the account's own sandboxed apps) may change the installation, the payload, the code or the build, each read where
  it really is (a junction's target).
- Only that address and its own page stay in the window: the status page only at the window's own navigations (its
  address carries a token of this process's, so no page can show text of its own there), and never in a popup. Another
  web address, or a mail address, opens in its program (through the Windows shell's handler for it, not a command
  line); a window AwwO opens (a preview, a page in a new tab) opens in a window of this app, signed in as well. When
  the runtime stops by itself, the window shows the error it ended on.
- Closing it stops the runtime in order (its standard input closes) and waits for it; a runtime that has not stopped
  in four minutes is ended, and the PostgreSQL it leaves running is stopped. The runtime also stops when the window's
  process ends some other way.
- The AwwO menu restarts the runtime, opens AwwO in the browser, opens the data folder, opens the logs (a folder of
  their own, `%LOCALAPPDATA%\store.clawhunt.awwo.local\logs`, with the runtime's own `runtime.log` and no secret; each
  service's log is in the data folder's `logs`), and resets the sign-in password: it restarts the runtime with
  `--reset-password` and opens the new `admin-credentials.txt`.
- The pages it shows get no native commands (no Tauri capability); the status page is told what happens by script the
  shell runs in it and by its address's fragment.
- Before it runs anything of the payload (the runtime, pg_ctl), it reads the access lists of the installation, the
  payload, the code and the build folders, each where it really is (a junction's target), and refuses to start when
  anyone but this account, SYSTEM, Administrators (and a domain's Domain Admins and Enterprise Admins),
  TrustedInstaller, CREATOR OWNER, OWNER RIGHTS and this account's own sandboxed apps may change what is in them, when
  one's owner is not among them, or when one has no access list (anyone may change it). It also refuses a link (a
  junction or a symbolic link) at any depth of the payload: the installer makes none and the packager refuses one, and
  a tool that moved a folder to another drive leaves one, to a folder no one checked. whoami and Windows PowerShell
  have 60 seconds each to answer, and one check runs at a time. A pass holds for the rest of the window's run; a
  refusal is checked again at the next start (AwwO → Restart). The first start and the menu's Restart check off the
  main thread and before they take the runtime's lock, so the window shows its page meanwhile. Once an exit is asked
  (Quit, closing the window, `--quit`), nothing starts the runtime again.
- PostgreSQL's programs get their paths in the system's ANSI code page, a character it has not as "?": pg_ctl, which
  the window runs to stop a database an ended run left, gets a path that is not ASCII in its short (8.3) form, as the
  runtime gives PostgreSQL's programs theirs.
- `--quit` asks the running window to stop the runtime in order and exit (the single-instance plugin hands it over);
  with no window running it stops a PostgreSQL an ended run left, when no runtime holds the data folder, and exits.
  The installer's hooks (`installer-hooks.nsh`) use it before an update or an uninstall, wait until nothing runs from
  the payload (its folder can be renamed; six minutes, then a retry prompt), and remove the old payload whole, so an
  update leaves none of its files behind. They refuse an installation folder outside the person's profile and
  %LOCALAPPDATA% (one elsewhere takes its drive's permissions, under which other accounts may change its programs),
  one whose path holds % or ! (PostgreSQL starts its server through cmd.exe, which reads them even inside quotes), and
  one longer than 80 characters, below which the payload's deepest paths (170) would pass Windows' 260; each time they
  remove the empty folder Tauri made for it.

Build it on Windows after `npm run setup:local` (with Docker running, so the managed execution's core is built) and
`npm ci --prefix apps/desktop` (the Tauri CLI), with Rust stable and the Visual Studio C++ build tools:

```powershell
npm run package:local -- --smoke
```

`scripts/awwo-local-package.mjs` assembles `apps/windows-local/payload` (what the hosted images run, laid out as in a
checkout: `app/` the code, `build/` the programs; no data, and no secret: the workers' dotfiles stay out and the
assembled payload is checked for `.env`, `.npmrc`, key and certificate files; the workers' packages without the type
declarations and source maps Node.js never loads, the builds of packages for other systems and machines, and the
coding agent's clipboard, which no worker uses, and without an ES-module build `dist-es` where its paths would be too
long for Windows and the package's exports send Node.js to its CommonJS build, which is then loaded to prove it;
PostgreSQL with its server's own parts alone: its programs, their libraries and data files, and of lib the modules the
server itself loads (PL/pgSQL, Snowball's stemmers, the encoding conversions, the replication modules, the event
log's messages); no extension (contrib's and EDB's: AwwO creates none, and some carry another project's code under
terms of its own, as uuid-ossp's OSSP uuid, fuzzystrmatch's Perl-licensed dmetaphone and pgcrypto's parts do), not
contrib's programs oid2name and vacuumlo, no translations (the runtime runs the programs in English), no Perl, Python
or Tcl language, nothing extensions are built with, no StackBuilder with the wxWidgets and curl only it loads, no ICU
test plugin, and every module its catalog files name (`$libdir/…`) in lib, or the packaging stops; beside
PostgreSQL's programs the Visual C++ runtime of Visual Studio's redistributable folder that is as new as the linker
that built them; every x64 program, library and addon checked for an import a fresh Windows would not have), holding
setup's locks while it copies, starts that payload's own runtime on a scratch data folder and stops it (`--smoke`,
without the `NODE_*`, `npm_*` and `AWWO_*` settings of the packager's environment), then builds the NSIS installer
under `target/release/bundle/nsis` (or `CARGO_TARGET_DIR`) and prints its SHA-256. Where no Visual Studio here has a
redistributable as new as PostgreSQL needs (14.44: Visual Studio 2022 17.14), only a build to test is made
(`--test-build`), which carries System32's runtime and is not to be published: its installer is named
`…_x64-setup-TEST.exe`, apart from the one to publish, and its LIBRARIES.md says it is a build to test.

The licences it carries; a missing one stops the packaging, and no text is made up for anything:

- `licenses/`: AwwO's LICENSE and THIRD_PARTY_NOTICES.md with every licence file they name, as the hosted release
  carries them, the Go modules' checked against the API carried here.
- `licenses/npm/`: NPM.md, each of the workers' npm packages with its licence, which must be a permissive one, and its
  licence files; for a package that ships none, its README where that carries its licence, or its repository's licence
  files from `third_party/npm-packages`.
- `licenses/apps/windows-local/`: this window's Rust code: the standard library's from the toolchain's documentation,
  each linked crate's from its package or, where it ships none, `third_party/rust-crates`, the licence of the WebView2
  SDK webview2-com-sys bundles (the program links its static loader), and a SOURCE.txt for every MPL crate.
- `build/pgsql/`: PostgreSQL's licence and EDB's notices of its libraries; the notices of the code of others in
  PostgreSQL's own source (its regex, pg_dump, Snowball's stemmers, the Unicode tables, Ryu, md5, sha1 and sha2, the
  BSD and ISC files of src/port…) as Debian's postgresql-18 package lists them (its debian/copyright, at a commit) and
  as the headers of 18.4's own files have them (NOTICES.txt, made from the source release whose SHA-256 postgresql.org
  publishes); and LIBRARIES.md: each library's own licence
  files, from its release of the version there, in `licenses/` (`third_party/postgres-windows`; EDB's notices lack
  ICU's licence and zstd's copyright line), and the GNU source releases libintl and libiconv, under the LGPL, were
  built from, in `sources/` (setup:local downloads them on Windows). It names what has a library built in: zlib in
  postgres.exe, pg_dump and four more programs and in pgcrypto; MinGW-w64's runtime, with the notices of its parts
  (gdtoa's among them), in libintl, libiconv and libwinpthread, built by MinGW-w64's GCC. The list holds each DLL's
  SHA-256: a DLL in bin it does not name or of other bytes, a module in lib that does not say PostgreSQL made it, or
  a PostgreSQL whose `postgres -V` is another version, stops the packaging.

`node scripts/awwo-npm-licences.mjs`, `awwo-crate-licences.mjs` and `awwo-postgres-licences.mjs` fetch those three
`third_party` folders: an npm package's or a crate's from the commit it was published from (where npm's registry names
none, its version's tag, else its default branch's commit of the day, recorded as such), a PostgreSQL library's from
its version's tag. They take a file only when it is of the licence the package names, record each file's address and
SHA-256 in PROVENANCE.json, and check their folder with `--check`; the packager checks the three folders against
their PROVENANCE.json before it carries anything of them.

Each Node.js service of the runtime, and the Node.js programs it starts, loads `scripts/awwo-local-module-guard.cjs`
first: a module whose real path is outside AwwO's own folders (the code, the build and the data folder) is taken as
not found, however it was reached (a package's absent optional dependency looked for in `C:\node_modules`, which any
account can make, a junction there, a package.json whose main points elsewhere, an imports map). Programs that inherit a service's environment
get it through NODE_OPTIONS; the workers start their runs, the managed execution's core and its MCP shim with no Node
options of their own, and give them the guard alone when the runtime names it (AWWO_LOCAL_MODULE_GUARD, which the
hosted site does not set). The core's own Node.js programs do not have it yet (直接执行 is not in the installer).
Tauri is given the payload at the build (tauri.conf.json names no resource, so `cargo test` runs without one) as a
folder (a glob's files would land in one folder) beside its config (it drops a path's drive letter), and makensis
reads each file by its full path, failing past 260 characters: from a checkout too deep for that, build in a folder of
its own, `npm run package:local -- --out D:\awwo-local`, which holds a copy of the shell, the payload and the build.
The installer is unsigned unless the release operator signs it, so Windows may warn that its publisher is unknown.
WebView2 is installed if needed.

Not in the installer: the Python OpenAI Agents worker (the JavaScript one runs instead), the Academy's staged videos
(they play from the hosted site's public copy), ffmpeg (the renderer stays off without it), and the workspace image of
the managed execution (直接执行 stays off until it is built; building it from the installed app is still to do).
