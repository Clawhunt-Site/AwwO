import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBuildAppEnv } from "./app-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const releaseDir = path.join(appRoot, "src-tauri", "target", "release");
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(appRoot, "src-tauri", "tauri.conf.json"), "utf8"),
);
// The bundle dir + icon are named after the Tauri productName (e.g. "ClawHunt"),
// NOT a hardcoded literal — a rebrand changes productName and must not break this step.
const productName = tauriConfig.productName || "ClawHunt";
const bundleDir = path.join(releaseDir, "bundle", "macos", `${productName}.app`);
const dmgDir = path.join(releaseDir, "bundle", "dmg");
const infoPlist = path.join(bundleDir, "Contents", "Info.plist");
const pkgInfo = path.join(bundleDir, "Contents", "PkgInfo");
const signatureDir = path.join(bundleDir, "Contents", "_CodeSignature");
const resourcesDir = path.join(bundleDir, "Contents", "Resources");
const iconFile = path.join(resourcesDir, `${productName}.icns`);
const appIcon = path.join(appRoot, "src-tauri", "icons", "icon.png");
const entitlementsFile = path.join(appRoot, "scripts", "macos-entitlements.plist");
const codesignIdentity = process.env.SUPERCLAW_DESKTOP_CODESIGN_IDENTITY || "-";
// Single canonical environment identity for the bundle; fails closed on an
// APP_ENV / VITE_APP_ENV mismatch (see app-env.mjs).
const appEnv = resolveBuildAppEnv(process.env.APP_ENV, process.env.VITE_APP_ENV);
const useHardenedRuntime =
  process.env.SUPERCLAW_DESKTOP_HARDENED_RUNTIME != null
    ? !["0", "false", "no"].includes(process.env.SUPERCLAW_DESKTOP_HARDENED_RUNTIME.toLowerCase())
    : appEnv === "production";
const shouldUseHardenedRuntime = useHardenedRuntime;
const bundleIdentifier = tauriConfig.identifier;
const executableName = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", infoPlist], {
  encoding: "utf8",
}).trim();
const mainExecutable = path.join(bundleDir, "Contents", "MacOS", executableName);

if (process.platform !== "darwin") {
  console.log("macOS bundle preparation skipped on non-darwin platform");
  process.exit(0);
}

assert.ok(fs.existsSync(bundleDir), `Expected macOS bundle at ${bundleDir}`);
assert.ok(fs.existsSync(infoPlist), `Expected Info.plist at ${infoPlist}`);
assert.ok(fs.existsSync(iconFile), `Expected bundled icon at ${iconFile}`);
assert.ok(fs.existsSync(entitlementsFile), `Expected macOS entitlements at ${entitlementsFile}`);
assert.ok(fs.existsSync(mainExecutable), `Expected macOS executable at ${mainExecutable}`);
assert.ok(bundleIdentifier, "Expected Tauri bundle identifier");

for (const key of ["LSRequiresCarbon", "CSResourcesFileMapped"]) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, infoPlist], {
      stdio: "ignore",
    });
  } catch {
    // The key may already be absent in newer Tauri output.
  }
}
fs.writeFileSync(pkgInfo, "APPL????");

// --- Embed the frozen Python backend so the app is fully self-contained ---
// The app resolves Contents/Resources/backend/superclaw-backend/superclaw-backend
// at runtime instead of any developer workspace .venv. The source is normally a
// PyInstaller onefile executable; keeping only one resource prevents macOS
// syspolicyd from exhausting its low file-descriptor limit while evaluating the
// app bundle signature.
const backendSrc = path.join(appRoot, "backend", "dist", "superclaw-backend");
assert.ok(
  fs.existsSync(backendSrc),
  `Expected frozen backend at ${backendSrc} (run scripts/build-backend.mjs first)`,
);
const backendDestRoot = path.join(resourcesDir, "backend");
const backendDest = path.join(backendDestRoot, "superclaw-backend");
fs.rmSync(backendDestRoot, { recursive: true, force: true });
fs.mkdirSync(backendDestRoot, { recursive: true });
const backendExe = path.join(backendDest, "superclaw-backend");
const backendSrcStat = fs.statSync(backendSrc);
if (backendSrcStat.isDirectory()) {
  execFileSync("ditto", [backendSrc, backendDest], { stdio: "inherit" });
} else {
  fs.mkdirSync(backendDest, { recursive: true });
  fs.copyFileSync(backendSrc, backendExe);
  fs.chmodSync(backendExe, 0o755);
}
assert.ok(fs.existsSync(backendExe), `Expected embedded backend executable at ${backendExe}`);

// Bake the build profile next to the frozen backend so the installed app knows
// which environment it is (staging / production) without the end
// user editing any config. The kernel (superclaw.environment._baked_app_env)
// reads this file as the LOWEST-priority APP_ENV signal — an explicit APP_ENV
// env var still wins. It is written before the outer bundle seal so it is
// covered by the app signature; it is plain JSON (not Mach-O), so the nested
// code-signing pass below skips it.
const buildProfile = path.join(backendDest, "build-profile.json");
fs.writeFileSync(buildProfile, `${JSON.stringify({ app_env: appEnv }, null, 2)}\n`);
console.log(`baked build profile: ${buildProfile} (app_env=${appEnv})`);

// Sign every Mach-O inside the embedded backend (dylibs/.so first, then the main
// executable) before the outer app seal. Production release builds use the
// hardened runtime and must be notarized. Local/staging acceptance bundles
// deliberately do not: recent macOS builds can kill non-notarized hardened
// bundles at launch before the app can print diagnostics, while plain local
// signing remains launchable. Do not trigger hardened runtime from
// `codesignIdentity !== "-"`; Developer ID without notarization is exactly the
// unnotarized staging shape this path must avoid.
const backendEntitlements = path.join(appRoot, "scripts", "macos-backend-entitlements.plist");
assert.ok(fs.existsSync(backendEntitlements), `Expected backend entitlements at ${backendEntitlements}`);
const backendMachOFiles = collectFiles(backendDest).filter((file) => file !== backendExe && isMachO(file));
for (const file of backendMachOFiles) {
  execFileSync("codesign", codesignArgs({ target: file }), { stdio: "ignore" });
}
execFileSync("codesign", codesignArgs({ entitlements: backendEntitlements, target: backendExe }), { stdio: "inherit" });
console.log(`embedded and signed self-contained backend: ${backendDest} (${backendMachOFiles.length + 1} Mach-O files)`);

// --- Bundle the self-contained ClawWork harness (binary + governance ext) ---
// Ship a standalone ClawWork next to the frozen backend so the ClawWork backend
// works out of the box when the user just opens the app — the kernel
// auto-discovers it via backends._frozen_clawwork_dir(), which resolves
// `<sys.executable dir>/clawwork/`. For a PyInstaller onefile, sys.executable is
// THIS embedded backend path (Resources/backend/superclaw-backend/...), so the
// clawwork dir must sit next to it (same anchor as build-profile.json above).
//
// The binary is bun-compiled (embeds its own runtime — no Node on the user's
// machine); the governance extension is self-contained .ts (only node builtins +
// a type-only import) which the binary loads via `-e`. Both are mandatory: the
// kernel fails closed (clawwork unavailable) if either is missing, never running
// ungoverned. Copied AFTER the backend Mach-O sweep above so the clawwork binary
// is signed explicitly here with the backend entitlements (not swept in as a
// generic dylib), then covered by the outer app seal below.
const clawworkSrcDist = path.join(repoRoot, "third_party", "clawwork", "packages", "coding-agent", "dist");
const clawworkBinSrc = path.join(clawworkSrcDist, "pi");
const governanceExtSrc = path.join(repoRoot, "third_party", "clawwork", "extensions", "superclaw-governance.ts");
assert.ok(
  fs.existsSync(clawworkBinSrc),
  `Expected compiled ClawWork binary at ${clawworkBinSrc} (run scripts/build-clawwork-binary.mjs first)`,
);
assert.ok(fs.existsSync(governanceExtSrc), `Expected ClawWork governance extension at ${governanceExtSrc}`);
const clawworkDest = path.join(backendDest, "clawwork");
fs.rmSync(clawworkDest, { recursive: true, force: true });
fs.mkdirSync(path.join(clawworkDest, "extensions"), { recursive: true });
const clawworkBinDest = path.join(clawworkDest, "clawwork");
fs.copyFileSync(clawworkBinSrc, clawworkBinDest);
fs.chmodSync(clawworkBinDest, 0o755);
fs.copyFileSync(governanceExtSrc, path.join(clawworkDest, "extensions", "superclaw-governance.ts"));
// Co-locate the binary's runtime assets — the bun-compiled binary resolves them
// relative to its OWN directory (config.ts getPackageDir() ==
// dirname(process.execPath) for a bun binary). We ship the SELF-CONTAINED set so
// the bundle is truly "open the app and it works", with NO dead paths in the
// agent's prompt surface:
//   • package.json — the reported version.
//   • photon_rs_bg.wasm — the image-resize worker.
//   • theme/ + assets/ — rendering.
//   • export-html/ — the session-export feature's templates (template.html/css/js
//     + vendor JS); getExportTemplateDir() reads them from <binary dir>/export-html.
//   • README.md + docs/ + examples/ — the RPC system prompt (system-prompt.ts)
//     injects these ABSOLUTE paths (getReadmePath/getDocsPath/getExamplesPath)
//     so the agent can read ClawWork's own SDK/extension/theme docs when asked.
//     Bundling them keeps those prompt-advertised paths real. They are static
//     text (cheap to seal): the bundle's sealed-resource budget has ample
//     headroom (the web frontend dist is only ~8 files; total stays well under
//     the assertMacBundleResourceSealIsLaunchable < 256 ceiling), so this does
//     NOT reintroduce the syspolicyd FD pressure the backend-onefile avoids.
//
// EXCLUDED on purpose:
//   • CHANGELOG.md: not referenced by the RPC prompt surface; a 0.4 MB file with
//     no runtime consumer on this path.
const clawworkRuntimeAssets = ["package.json", "photon_rs_bg.wasm", "theme", "assets", "export-html", "README.md", "docs", "examples"];
for (const entry of clawworkRuntimeAssets) {
  const src = path.join(clawworkSrcDist, entry);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(clawworkDest, entry), { recursive: true });
  }
}
assert.ok(isMachO(clawworkBinDest), `Expected ClawWork binary to be Mach-O: ${clawworkBinDest}`);
execFileSync("codesign", codesignArgs({ entitlements: backendEntitlements, target: clawworkBinDest }), {
  stdio: "inherit",
});
console.log(`bundled and signed self-contained ClawWork: ${clawworkDest}`);

// --- Bundle the self-contained Node control plane (node binary + server tree) ---
// build-node-server.mjs stages <appRoot>/backend/dist/node-runtime/{node, server/}
// (a pinned Node binary + a pruned, publishConfig-resolved server/server deploy).
// Ship it next to the frozen backend so the kernel auto-discovers it via
// node_runtime._frozen_node_runtime_dir() -> `<sys.executable dir>/node-runtime/`
// (same anchor as build-profile.json + clawwork/). Copied AFTER the backend +
// ClawWork Mach-O sweeps so the node binary and the server's native .node modules
// are all signed before the outer app seal. ditto preserves the pnpm symlink tree.
const nodeRuntimeSrc = path.join(appRoot, "backend", "dist", "node-runtime");
assert.ok(
  fs.existsSync(path.join(nodeRuntimeSrc, "node")) &&
    fs.existsSync(path.join(nodeRuntimeSrc, "server", "dist", "index.js")) &&
    fs.existsSync(path.join(nodeRuntimeSrc, "gateway", "dist", "index.js")),
  `Expected staged Node runtime at ${nodeRuntimeSrc} (run scripts/build-node-server.mjs first)`,
);
const nodeRuntimeDest = path.join(backendDest, "node-runtime");
fs.rmSync(nodeRuntimeDest, { recursive: true, force: true });
execFileSync("ditto", [nodeRuntimeSrc, nodeRuntimeDest], { stdio: "inherit" });
fs.chmodSync(path.join(nodeRuntimeDest, "node"), 0o755);
// Drop dangling symlinks: pnpm's deploy leaves a self-reference
// (.pnpm/node_modules/@paperclipai/server -> ../../.../server/server) whose
// up-and-out relative target only resolves at the original stage depth; once
// relocated into the .app it dangles, and `codesign --verify --strict` rejects a
// sealed broken symlink. These links are unused at runtime, so prune them.
const prunedLinks = collectBrokenSymlinks(nodeRuntimeDest);
for (const link of prunedLinks) fs.rmSync(link, { force: true });
if (prunedLinks.length) console.log(`pruned ${prunedLinks.length} dangling symlink(s) from node-runtime`);
const nodeRuntimeMachO = collectFiles(nodeRuntimeDest).filter((file) => isMachO(file));
for (const file of nodeRuntimeMachO) {
  execFileSync("codesign", codesignArgs({ entitlements: backendEntitlements, target: file }), { stdio: "ignore" });
}
console.log(`bundled and signed self-contained node-runtime: ${nodeRuntimeDest} (${nodeRuntimeMachO.length} Mach-O files)`);

// Tauri/linker may leave a runnable ad-hoc executable plus a stale bundle
// CodeResources seal. After patching Info.plist/PkgInfo, sign the main Mach-O
// first, then the top-level app seal. Signing the bundle alone can pass
// codesign strict validation but still be killed when launched from /Applications.
fs.rmSync(signatureDir, { recursive: true, force: true });
execFileSync(
  "codesign",
  codesignArgs({ entitlements: entitlementsFile, target: mainExecutable }),
  { stdio: "inherit" },
);
execFileSync(
  "codesign",
  codesignArgs({ entitlements: entitlementsFile, identifier: bundleIdentifier, target: bundleDir }),
  { stdio: "inherit" },
);
execFileSync("codesign", ["--verify", "--strict", "--verbose=2", bundleDir], {
  stdio: "inherit",
});

if (fs.existsSync(dmgDir)) {
  for (const entry of fs.readdirSync(dmgDir)) {
    if (entry.startsWith(`${productName}_`) && entry.endsWith(".dmg")) {
      rebuildDmg(path.join(dmgDir, entry));
    }
  }
}

if (!fs.existsSync(appIcon)) {
  console.warn(`macOS bundle source icon not found at ${appIcon}; using generated icns only`);
}

console.log(`prepared and signed macOS bundle: ${bundleDir}`);

function codesignArgs({ entitlements, identifier, target }) {
  const args = ["--force", "--sign", codesignIdentity];
  if (shouldUseHardenedRuntime) {
    args.push("--options", "runtime");
    if (entitlements) args.push("--entitlements", entitlements);
  }
  if (identifier) args.push("--identifier", identifier);
  args.push(target);
  return args;
}

function collectFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

function collectBrokenSymlinks(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // existsSync follows the link — false means the target is missing (dangling).
      if (!fs.existsSync(full)) acc.push(full);
    } else if (entry.isDirectory()) {
      collectBrokenSymlinks(full, acc);
    }
  }
  return acc;
}

function isMachO(file) {
  try {
    const out = execFileSync("file", ["-b", file], { encoding: "utf8" });
    return /Mach-O/.test(out);
  } catch {
    return false;
  }
}

function rebuildDmg(dmgPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "superclaw-dmg-"));
  const stagingDir = path.join(tempRoot, "volume");
  const stagedApp = path.join(stagingDir, `${productName}.app`);
  const stagedApplicationsLink = path.join(stagingDir, "Applications");
  const tempDmgPath = path.join(tempRoot, path.basename(dmgPath));

  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    execFileSync("ditto", [bundleDir, stagedApp], { stdio: "inherit" });
    fs.symlinkSync("/Applications", stagedApplicationsLink);
    execFileSync(
      "hdiutil",
      ["create", "-volname", productName, "-srcfolder", stagingDir, "-ov", "-format", "UDZO", tempDmgPath],
      { stdio: "inherit" },
    );
    fs.renameSync(tempDmgPath, dmgPath);
    execFileSync("hdiutil", ["verify", dmgPath], { stdio: "inherit" });
    console.log(`rebuilt signed macOS dmg: ${dmgPath}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
