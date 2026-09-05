import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  pruneVendoredAgentCliBinaries,
  shouldKeepVendoredAgentClis,
} from "./prune-vendored-agent-clis.mjs";
import { dedupNativeDylibs } from "./dedup-native-dylibs.mjs";

// Build a SELF-CONTAINED, PRUNED copy of the vendored Paperclip Node control
// plane (server/server) + a bundled Node runtime, so the shipped desktop app can
// co-launch Node out of the box — the end user never installs Node or builds.
//
// prepare-macos-bundle.mjs then copies the staged node-runtime/ into
// ClawHunt.app/.../Resources/backend/superclaw-backend/node-runtime/, and the
// kernel (node_runtime._frozen_node_runtime_dir) auto-discovers `node` +
// `server/dist/index.js` next to the frozen backend — no env wiring.
//
// Recipe (verified end-to-end on this host):
//   1. pnpm -r build         — build the workspace packages' dist/.
//   2. pnpm deploy --prod    — a pruned, self-contained server tree.
//   3. apply publishConfig   — pnpm deploy SHIPS each workspace package's dist
//                              (its `files`) but leaves package.json `exports`
//                              pointing at the .ts SOURCE (the dev condition).
//                              We rewrite exports/main/types/bin to the
//                              publishConfig (dist) values so plain `node` resolves
//                              the built JS instead of missing .ts files.
//   4. embed Node            — the server statically links `node:sqlite`, a builtin
//                              only present on Node >= 22.5 (stable in 24), so we
//                              ship Node 24, NOT 20 (`engines.node >= 20` is loose).
//
// Override the embedded Node binary with SUPERCLAW_EMBED_NODE_BIN (e.g. a CI cache
// or a notarization-friendly build) instead of downloading the pinned release.

const NODE_EMBED_VERSION = process.env.SUPERCLAW_EMBED_NODE_VERSION || "24.10.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, ".."); // apps/desktop
const repoRoot = path.resolve(appRoot, "..", ".."); // repo root
const serverWorkspace = path.join(repoRoot, "server"); // pnpm workspace root
const serverPkg = "@paperclipai/server";
const stageRoot = path.join(appRoot, "backend", "dist", "node-runtime");
const stageServer = path.join(stageRoot, "server");
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const nodeBinName = isWindows ? "node.exe" : "node"; // Windows ships node.exe
const stageNode = path.join(stageRoot, nodeBinName);
const nodeCacheDir = path.join(appRoot, "backend", ".node-cache");

if (!isMac && !isWindows) {
  // Only macOS + Windows package a desktop bundle (host-arch embedded Node). Skip
  // elsewhere (e.g. a Linux CI lint/test run) so it never needs pnpm/network here.
  console.log(`node-server bundle skipped on ${process.platform}`);
  process.exit(0);
}

if (!fs.existsSync(path.join(serverWorkspace, "pnpm-workspace.yaml"))) {
  throw new Error(`vendored Node server workspace not found at ${serverWorkspace}`);
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}${cwd ? `  (cwd=${cwd})` : ""}`);
  if (process.platform === "win32") {
    // pnpm/npx are `.cmd` shims on Windows — execFileSync can't run them without a
    // shell (PATHEXT resolution), hence `spawnSync pnpm ENOENT`. shell:true routes
    // through cmd.exe; quote args containing spaces/specials (the deploy target path
    // can contain spaces / an apostrophe). cmd escapes an embedded quote as "".
    const quoted = args.map((a) =>
      /[\s&|<>^"']/.test(String(a)) ? `"${String(a).replace(/"/g, '""')}"` : String(a),
    );
    execFileSync(cmd, quoted, { cwd, stdio: "inherit", shell: true });
    return;
  }
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`download failed (${res.statusCode}) for ${url}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      })
      .on("error", (err) => {
        file.close();
        fs.rmSync(dest, { force: true });
        reject(err);
      });
  });
}

// --- resolve the embedded Node binary ---------------------------------------

async function resolveEmbeddedNode() {
  const override = (process.env.SUPERCLAW_EMBED_NODE_BIN || "").trim();
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`SUPERCLAW_EMBED_NODE_BIN does not exist: ${override}`);
    return override;
  }
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform = isWindows ? "win" : "darwin";
  const slug = `node-v${NODE_EMBED_VERSION}-${platform}-${arch}`;
  // macOS tarball -> <slug>/bin/node ; Windows zip -> <slug>/node.exe
  const binPath = isWindows
    ? path.join(nodeCacheDir, slug, "node.exe")
    : path.join(nodeCacheDir, slug, "bin", "node");
  if (fs.existsSync(binPath)) return binPath;
  fs.mkdirSync(nodeCacheDir, { recursive: true });
  const ext = isWindows ? "zip" : "tar.gz";
  const archive = path.join(nodeCacheDir, `${slug}.${ext}`);
  const url = `https://nodejs.org/dist/v${NODE_EMBED_VERSION}/${slug}.${ext}`;
  console.log(`downloading embedded Node ${NODE_EMBED_VERSION} (${platform}-${arch})...`);
  await download(url, archive);
  if (isWindows) {
    // NOT tar: GNU tar (on PATH via Git Bash) misreads `E:\...` / `D:\...` as a
    // remote `host:path` ("Cannot connect to E:"). PowerShell Expand-Archive has no
    // such quirk; paths go via env vars to dodge apostrophe/space quoting issues.
    console.log(`$ Expand-Archive ${archive} -> ${nodeCacheDir}`);
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "Expand-Archive -LiteralPath $env:SC_ARCHIVE -DestinationPath $env:SC_DEST -Force"],
      { stdio: "inherit", env: { ...process.env, SC_ARCHIVE: archive, SC_DEST: nodeCacheDir } },
    );
  } else {
    run("tar", ["-xzf", archive, "-C", nodeCacheDir]);
  }
  if (!fs.existsSync(binPath)) throw new Error(`embedded Node binary not found after extract: ${binPath}`);
  return binPath;
}

// --- apply each workspace package's publishConfig (exports -> built dist) -----

function applyPublishConfig(root) {
  // Process EVERY package.json under the deploy tree (only those carrying a
  // publishConfig are rewritten — that is exactly the workspace packages). Do NOT
  // try to exclude a "*/dist/*" path here: the stage root itself lives under
  // apps/desktop/BACKEND/DIST/node-runtime, so that filter would match — and
  // exclude — every file.
  // Cross-platform recursive walk for package.json (the macOS-only `find` shell-out
  // does not exist on Windows). node_modules IS included on purpose — pnpm deploy's
  // workspace deps carry the publishConfig we must rewrite.
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name === "package.json") out.push(full);
    }
    return out;
  };
  const changed = [];
  for (const file of walk(root)) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!json.publishConfig) continue;
    for (const key of ["main", "module", "types", "exports", "bin"]) {
      if (json.publishConfig[key] !== undefined) json[key] = json.publishConfig[key];
    }
    delete json.publishConfig;
    // pnpm's store HARD-LINKS package.json into the deploy tree, so the file here
    // can share an inode with the vendored SOURCE package.json. Truncating it in
    // place would corrupt the source tree. Unlink first to break the hard link,
    // then write a fresh inode — the deploy copy changes, the source never does.
    fs.rmSync(file);
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    changed.push(json.name || path.relative(root, file));
  }
  // Log the rewritten package names so a build is auditable (and a surprise
  // third-party rewrite is visible) rather than just a count.
  const unique = [...new Set(changed)].sort();
  console.log(`applied publishConfig (exports -> dist) to ${changed.length} packages: ${unique.join(", ")}`);
}

// --- main --------------------------------------------------------------------

const embeddedNode = await resolveEmbeddedNode();
console.log(`embedded Node: ${embeddedNode}`);

// NOTE on script-shell: we deliberately keep pnpm's DEFAULT script shell on
// Windows (cmd.exe). Routing scripts through Git Bash is tempting (it has cp /
// mkdir -p) but breaks worse: pnpm's `.bin/<tool>` POSIX shims only run cygpath
// for *CYGWIN* (not MINGW/Git-Bash), so under bash they hand an MSYS basedir
// (/e/…) to the Windows node.exe, which mis-resolves it to `E:\e\…` and every
// `tsc` fails MODULE_NOT_FOUND. The `.bin/<tool>.CMD` shims used by cmd resolve
// Windows paths correctly, so every tsc/vite package builds. The only scripts
// that needed POSIX tools (cp/mkdir/rm/chmod) were rewritten to `node -e fs.*`
// in the vendored server packages — cross-platform, depends only on node (which
// is guaranteed present; coreutils are NOT on PATH in CI's pwsh runner).

// 1. Build the workspace so every package has its dist/ (deploy ships dist).
run("pnpm", ["install", "--frozen-lockfile"], serverWorkspace);
// pnpm 10's per-package script PATH omits the workspace-ROOT node_modules/.bin, so
// the ~9 workspace packages whose build script calls a bare `tsc` (hoisted to the
// root .bin on the team's pnpm 9 / macOS) fail "tsc not recognized" on Windows.
// Prepend the root .bin so those bare-tool scripts resolve (cross-platform).
process.env.PATH = `${path.join(serverWorkspace, "node_modules", ".bin")}${path.delimiter}${process.env.PATH || ""}`;
run("pnpm", ["-r", "build"], serverWorkspace);

// 2. Deploy a pruned, self-contained server tree.
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });
if (isWindows) {
  // Deploy with the HOISTED linker on Windows so the pruned node_modules is a flat
  // tree of REAL directories (npm-style) with NO symlinks. pnpm's default isolated
  // layout symlinks every package into a `.pnpm` virtual store; those symlinks
  // (a) can't be recreated when copying into src-tauri/resources without the
  // Windows "create symbolic links" privilege (EPERM), and (b) wouldn't survive
  // the NSIS/MSI installer or resolve from Program Files anyway. Hoisted = a
  // self-contained, copyable, installable runtime. macOS keeps the proven isolated
  // layout (cp -R + .app bundles preserve relative symlinks fine).
  process.env.npm_config_node_linker = "hoisted";
}
run("pnpm", ["--filter", serverPkg, "deploy", "--prod", stageServer], serverWorkspace);

// 2b. BYO prune — drop the vendored Claude/Codex CLI platform binaries (~370MB)
// unless explicitly told to ship them. See prune-vendored-agent-clis.mjs.
if (shouldKeepVendoredAgentClis()) {
  console.log("BYO prune skipped (SUPERCLAW_BUNDLE_VENDORED_AGENT_CLIS set): shipping vendored agent CLIs");
} else {
  pruneVendoredAgentCliBinaries(stageServer);
}

// 2c. Native-dylib dedup — collapse embedded-postgres's duplicate version-alias
// dylibs (e.g. 3× identical 61MB libicudata) into relative symlinks (~174MB).
// Always runs (independent of the BYO prune toggle): md5-identical files make this
// behavior-neutral. See dedup-native-dylibs.mjs.
dedupNativeDylibs(stageServer);

// 3. Make the deployed tree resolve to built JS on plain Node.
applyPublishConfig(stageServer);

// 4. Stage the embedded Node binary.
fs.copyFileSync(embeddedNode, stageNode);
fs.chmodSync(stageNode, 0o755);

// 4b. Validate the STAGED Node binary semantically — an override / wrong download
// could be the wrong version, the wrong arch, or not even Node, and would only
// crash at runtime inside the shipped .app. The server statically imports
// `node:sqlite` (Node >= 22.5; stable in 24), so require >= 24 AND a matching arch
// AND that node:sqlite actually links here.
const nodeEval = (code, opts = []) =>
  execFileSync(stageNode, [...opts, "-e", code], { encoding: "utf8" }).trim();
const stagedVersion = nodeEval("process.stdout.write(process.versions.node)");
const stagedArch = nodeEval("process.stdout.write(process.arch)");
if (!/^\d+\.\d+\.\d+/.test(stagedVersion) || Number(stagedVersion.split(".")[0]) < 24) {
  throw new Error(`embedded Node must be >= 24 (server uses node:sqlite); got v${stagedVersion}`);
}
if (stagedArch !== process.arch) {
  throw new Error(`embedded Node arch ${stagedArch} != build host arch ${process.arch}`);
}
execFileSync(stageNode, ["--input-type=module", "-e", "import 'node:sqlite'"], { stdio: "ignore" });
console.log(`embedded Node validated: v${stagedVersion} ${stagedArch}, node:sqlite OK`);

// 5. Fail closed if the self-contained contract is not satisfied.
const entry = path.join(stageServer, "dist", "index.js");
for (const required of [stageNode, entry, path.join(stageServer, "package.json")]) {
  if (!fs.existsSync(required)) throw new Error(`staged node-runtime is incomplete: missing ${required}`);
}

// 5b. Staged import smoke: import the adapter registry, which statically imports
// EVERY builtin adapter's `/server` entry (registry.ts) — acpx-local among them,
// whose execute.ts imports `acpx/runtime`. This exercises the whole builtin-adapter
// import graph that server boot pulls in (not just one adapter), proving the
// embedded Node loads it AND that the BYO prune didn't break the chain. The agent
// launchers resolve their platform binaries lazily (e.g. bin/codex-acp.js does
// import.meta.resolve + existsSync, exiting cleanly when absent), so the JS import
// graph must still succeed after the binaries are gone. Fail closed otherwise.
//
// We import the registry MODULE, NOT `dist/index.js`: the latter starts the server
// and waits on external adapters (index.ts), which would hang the build. The
// registry import only registers adapters (no listen / no DB connect), so it
// returns promptly.
//
// (Why not a bare `import('acpx/runtime')`: `acpx` is acpx-local's OWN dependency,
// not a top-level dependency of `@paperclipai/server`, so a root-level import would
// fail to resolve even on an UN-pruned tree — a false negative. Going through the
// registry resolves `acpx` from the adapter's own context, as the running server
// does.)
const registryEntry = "./dist/adapters/registry.js";
try {
  execFileSync(stageNode, ["--input-type=module", "-e", `await import('${registryEntry}')`], {
    cwd: stageServer,
    stdio: "pipe",
    encoding: "utf8",
  });
  console.log("staged import smoke: adapter registry (all builtin adapters incl. acpx → acpx/runtime) loads on embedded Node OK (prune-safe)");
} catch (err) {
  const detail = String(err.stderr || err.message || "").trim();
  throw new Error(
    `staged import smoke FAILED: embedded Node cannot import the adapter registry (${registryEntry}) from the staged server after prune — ${detail}`,
  );
}

// 5c. Embedded-postgres smoke: the dylib dedup (step 2c) rewrote PostgreSQL's
// version-alias libs into relative symlinks. `postgres`/`initdb` dlopen every
// `@loader_path/../lib/<name>` dependency at process start, so a successful
// `--version` proves the symlinked load graph resolves. Fail closed so a dedup that
// broke PG's dynamic loading aborts the build instead of shipping a runtime crash.
const pgBins = execFileSync("find", [stageServer, "-type", "f", "-path", "*native/bin/postgres"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
})
  .split("\n")
  .filter(Boolean);
if (pgBins.length === 0) {
  // No embedded-postgres in the stage — the dedup had no PG libs to touch. Make the
  // skip auditable rather than silent.
  console.log("embedded-postgres smoke: no postgres binary in stage (skipped)");
} else {
  for (const name of ["postgres", "initdb"]) {
    const bin = path.join(path.dirname(pgBins[0]), name);
    try {
      const ver = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
      console.log(`embedded-postgres smoke: ${ver} (${name} dlopen of dedup'd libs OK)`);
    } catch (err) {
      const detail = String(err.stderr || err.message || "").trim();
      throw new Error(
        `embedded-postgres smoke FAILED: ${name} cannot load its libs after dylib dedup — ${detail}`,
      );
    }
  }
}

// 6. Stage the Node automation gateway (apps/gateway) so the packaged desktop
// co-launches it too (chat sessions as scheduled tasks). The kernel resolves it at
// node-runtime/gateway/ next to the embedded `node` (see
// gateway_runtime.resolve_gateway_dir). It is a tiny single-dependency (express)
// service, so a plain `npm ci --omit=dev` into the stage gives a self-contained tree.
const gatewayDir = path.join(repoRoot, "apps", "gateway");
const stageGateway = path.join(stageRoot, "gateway");
run("npm", ["ci"], gatewayDir); // dev deps (typescript) needed to build
run("npm", ["run", "build"], gatewayDir);
fs.rmSync(stageGateway, { recursive: true, force: true });
fs.mkdirSync(stageGateway, { recursive: true });
fs.cpSync(path.join(gatewayDir, "dist"), path.join(stageGateway, "dist"), { recursive: true });
for (const f of ["package.json", "package-lock.json"]) {
  fs.copyFileSync(path.join(gatewayDir, f), path.join(stageGateway, f));
}
run("npm", ["ci", "--omit=dev"], stageGateway); // prod deps only (express)
const gatewayEntry = path.join(stageGateway, "dist", "index.js");
for (const required of [gatewayEntry, path.join(stageGateway, "node_modules", "express")]) {
  if (!fs.existsSync(required)) throw new Error(`staged gateway is incomplete: missing ${required}`);
}
// Smoke 1: the embedded Node resolves the gateway's runtime dep from the staged tree
// (proves the prod install landed for the SHIPPED Node, not just the build host's).
execFileSync(stageNode, ["--input-type=module", "-e", "import { createRequire } from 'node:module'; createRequire(process.cwd() + '/x').resolve('express')"], {
  cwd: stageGateway,
  stdio: "ignore",
});
// Smoke 2: the embedded Node can IMPORT the compiled ESM entry and its whole import
// graph (catches a TS->JS output or a transitive dep that the shipped Node can't load
// — stronger than a syntax-only --check). Safe to import because index.ts auto-starts
// ONLY under an `isMain` guard (argv[1] === its own file URL); imported via -e that is
// false, so no server is started.
const gatewayEntryUrl = pathToFileURL(gatewayEntry).href;
execFileSync(stageNode, ["--input-type=module", "-e", `await import(${JSON.stringify(gatewayEntryUrl)})`], {
  cwd: stageGateway,
  stdio: "ignore",
});
console.log(`staged automation gateway: ${gatewayEntry} (express resolves + entry import graph loads on embedded Node OK)`);

// The bundle step (prepare-macos-bundle.mjs) seals the ENTIRE stage root into the
// .app, so refuse to leave stray files (e.g. a hand-run server log) next to the
// expected entries — the root must contain exactly `node`, `server/` and `gateway/`.
const stageEntries = fs.readdirSync(stageRoot).sort();
// Use nodeBinName (node.exe on Windows) so the self-contained contract check matches
// the actual staged binary; the stage root must contain exactly the embedded node,
// the pruned `server/` tree, and the automation `gateway/`.
const expectedEntries = [nodeBinName, "server", "gateway"].sort().join(",");
if (stageEntries.join(",") !== expectedEntries) {
  throw new Error(`staged node-runtime root must contain only [${nodeBinName}, server, gateway]; found [${stageEntries.join(", ")}]`);
}
console.log(`staged self-contained node-runtime at ${stageRoot}`);
console.log(`  node:    ${stageNode} (v${stagedVersion} ${stagedArch})`);
console.log(`  server:  ${entry}`);
console.log(`  gateway: ${gatewayEntry}`);

// Windows: stage the node-runtime/ INTO the Tauri resource tree next to the frozen
// backend (mirrors prepare-macos-bundle.mjs for macOS). build-backend.mjs already
// created resources/backend/superclaw-backend/ and ran FIRST in tauri:build:win, so
// node_runtime._frozen_node_runtime_dir finds
// <exe dir>/node-runtime/{node.exe,server,gateway}.
if (isWindows) {
  const resourceDir = path.join(appRoot, "src-tauri", "resources", "backend", "superclaw-backend", "node-runtime");
  fs.rmSync(resourceDir, { recursive: true, force: true });
  // dereference: copy real files even if a stray symlink slips through (the hoisted
  // deploy above should leave none) — never recreate a symlink (EPERM on Windows).
  fs.cpSync(stageRoot, resourceDir, { recursive: true, dereference: true });
  console.log(`staged Windows node-runtime resource: ${resourceDir}`);
}
