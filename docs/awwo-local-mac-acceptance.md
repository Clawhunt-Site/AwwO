# AwwO 本地版 on the Mac: build and acceptance

How a build of AwwO for Mac that carries the local edition (docs/awwo-local-edition.md, "Mac 应用") is built,
installed and accepted on a Mac. Everything here runs on the Mac itself; what could be checked elsewhere (the runtime's
logic, the payload's checks on EDB's real files, the web app) is checked by `npm run test:local` and the web tests.
Record each step's result as you go (`.local/mac-acceptance/<date>.md` in the checkout, never committed) and report it
in the form at the end.

Rules while doing it: work in a fresh clone at the commit or tag you were given, detached; push nothing to any branch
(the repository keeps `main` alone); never delete or overwrite `~/Library/Application Support/AwwO Local/` (an earlier
build's data) or the installed app without a backup; ask before anything outward-facing (pushing a tag, publishing).

## 0. The Mac

- Apple silicon, macOS 14 or later. Note `sw_vers` and `uname -m`.
- Xcode Command Line Tools (`xcode-select -p`; else `xcode-select --install`), git.
- Node.js 24 to run the scripts (`node -v`; e.g. `brew install node@24`), Go at the version go.mod names (`go version`;
  `GOTOOLCHAIN=auto` fetches it), curl. Docker is not needed.
- Optional for the render service: Google Chrome and `brew install ffmpeg`.
- Network: nodejs.org, get.enterprisedb.com, ftp.gnu.org, the npm registry, proxy.golang.org.

## 1. Set up and test the checkout

```sh
npm run setup:local   # Node.js 24.22.1, EDB's PostgreSQL 18.4 (SHA-256 pinned), packages, API, web, the managed
                      # execution's core (git and npm only; without Docker running its workspace image is skipped)
npm run test:local    # all of it runs here, the link and POSIX-signal tests included
npm ci --prefix apps/macos --ignore-scripts && npm run typecheck --prefix apps/macos && npm test --prefix apps/macos
```

Expect: setup reports PostgreSQL "installed 18.4-1" (or "present"), the libraries' sources and the managed execution
core; every test passes (none skipped for want of links or signals). A failure: record its output and stop at the
first one you cannot explain.

## 2. The runtime from the checkout

```sh
npm run local
```

Expect `AwwO 本地版 is ready: http://awwo.localhost:5199 (it opens as http://awwo-<id>.localhost:5199 …)`. Then:

- Chrome (or Edge/Firefox) at `http://awwo.localhost:5199`: it goes on to `awwo-<id>.localhost` and shows the sign-in
  page; sign in with `.local/awwo-local/state/admin-credentials.txt`.
- Safari at the same address: on macOS 26 it opens; on macOS 14 and 15 it cannot find the server (expected: macOS
  resolves `*.localhost` from 26 on). Record which.
- `ls -l .local/awwo-local/state` shows mode `drwx------` and `local.env`, `postgres/`.
- Ctrl-C: `AwwO 本地版 has stopped.` within about a minute; afterwards `pgrep -fl 'awwo|postgres'` lists nothing of it.

## 3. The payload

```sh
npm run package:local:macos -- --out "$HOME/awwo-mac" --smoke
```

Expect its line `AwwO 本地版 payload for the Mac app in …: <n> files, <m> MB; signed here: <k>` and
`smoke: {"seconds":…,"services":[…],"page":200,"stop":0}`. Record n, m, k and the signed files' names if any. A
refusal names what it found (a library not in the payload, a link, an unlisted dylib…): record it whole.

## 4. The app

```sh
AWWO_MAC_LOCAL_PAYLOAD="$HOME/awwo-mac/payload" APP_ENV=production VITE_APP_ENV=production \
  AWWO_MAC_CLOUD_URL=https://awwo.clawhunt.store node apps/macos/build.ts
APP_ENV=production VITE_APP_ENV=production AWWO_MAC_CLOUD_URL=https://awwo.clawhunt.store \
  AWWO_MAC_APP="<the app path latest.json names>" node apps/macos/verify-bundle.ts
```

The build compiles `apps/macos/AwwOLocal.swift` and runs its self-tests (`policy` includes `Local contract: <n> checks
passed`). This Swift was written without a Mac: if it does not compile, fix it with the smallest change that keeps
its intent, record each error and its fix, and go on.

## 5. Install and use it

Back up the installed app first if there is one (`ditto "$HOME/Applications/AwwO Local.app" "$HOME/AwwO-Local-backup.app"`),
quit it, then copy the built app to `~/Applications`. Open it:

1. It asks which workspace to open. Choose 本机工作区. The window shows the runtime's steps (数据库, 执行服务, API) and
   then AwwO's sign-in page; TextEdit opens `admin-credentials.txt`. Record how long the first start took.
2. Sign in, open 我的工作区, make a canvas. If you have a model key, add it in 我的引擎 and run one Agent node.
3. 设置 → 本机: the data folder is `~/Library/Application Support/store.clawhunt.awwo.local/state`; the render
   service's hint names Homebrew and 「AwwO → 退出 AwwO」, no npm command.
4. The AwwO menu: 打开数据目录 and 打开日志 open those folders; 在浏览器中打开 opens `http://awwo-<id>.localhost:5199/…`
   in the default browser (Safari before macOS 26 cannot open it); 重新启动 restarts it (the page comes back signed
   in); 重置登录密码 restarts it and opens the new `admin-credentials.txt`, whose password signs in.
5. `~/Library/Application Support/AwwO Local/` is unchanged (`ls -la` before and after, if it exists).
6. Quit (⌘Q) while it runs: the window says it is stopping; record how long until the app is gone; afterwards
   `pgrep -fl 'awwo|postgres|node'` lists nothing of it.
7. Open it again: it opens 本机工作区 without asking, and the page is still signed in.
8. 工作区 → 线上工作区: the local workspace stops in order and the hosted site opens (its sign-in, if any, as before);
   back to 本机工作区 starts it again.
9. Ended from outside: while it runs, `kill -9` the runtime (`pgrep -f awwo-local.mjs`). The window says AwwO 本地版
   stopped and offers 「AwwO → 重新启动」; `pgrep postgres` shows the database stopped within a minute (the window stops
   what the runtime left); 重新启动 brings it back.
10. Stopped from outside: while it runs, `pkill -TERM -f awwo-local.mjs`. At once the page goes and the window says
    「AwwO 本地版正在停止」 (the runtime's `stopping` event), then 「AwwO 本地版已停止（0）」; 重新启动 brings it back,
    still signed in.

## 6. As downloaded (Gatekeeper)

The app is signed ad hoc, not notarized. Simulate a download:

```sh
ditto -c -k --keepParent "$HOME/Applications/AwwO Local.app" /tmp/AwwO.zip
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" /tmp/AwwO.zip
```

Unpack it in Finder (double-click) into a new folder, open the app: record what macOS shows and what it takes to open
it (System Settings → Privacy & Security → Open Anyway). Then choose 本机工作区 and record whether its runtime starts:
whether macOS asks again or blocks `node`, `postgres` or `awwo-api` (each inside the app), and what the window and
`~/Library/Application Support/store.clawhunt.awwo.local/logs/runtime.log` say.

## 7. Clean up

Quit the app; restore the backed-up app if you replaced one and want it back; remove `/tmp/AwwO.zip` and the folder
you unpacked it in. Keep the data folder (it is the person's), the payload and the logs until the report is read.

## Report

```
Mac: <model>, macOS <sw_vers>, <uname -m>; commit <git rev-parse HEAD>
1 setup/tests: <pass | first failure, verbatim>
2 runtime: ready in <s> s; Chrome <ok>; Safari <opens | cannot find server>; stop <s> s; leftovers <none | list>
3 payload: <n> files, <m> MB, signed here <k> (<names>); smoke <json>
4 app: build <ok | errors+fixes>; self-tests <lines>; verify-bundle <ok | output>
5 use: first start <s> s; 1–10 <ok | what differed, each>
6 quarantine: <what macOS showed; whether the local workspace started>
Swift or script changes made: <none | the diff, or the tag holding them>
```
