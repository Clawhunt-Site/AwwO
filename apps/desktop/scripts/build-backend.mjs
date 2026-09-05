import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBuildAppEnv } from "./app-env.mjs";

// Freeze the ClawHunt Python backend (FastAPI service + orchestrator + Typer
// CLI) into a self-contained PyInstaller onefile executable.
//
// macOS: prepare-macos-bundle.mjs then embeds and signs the result inside
//   ClawHunt.app/Contents/Resources/backend.
// Windows: this script ALSO stages the frozen .exe (+ build-profile.json) into
//   src-tauri/resources/backend/superclaw-backend/ so Tauri's bundle.resources
//   picks it up at build time (there is no post-build .app to inject into); the
//   Rust shell resolves it next to the installed exe (lib.rs
//   bundled_backend_executable).
// The shipped app needs no developer workspace or .venv at runtime.

// FAIL FAST at the very start of the build chain (before the expensive PyInstaller /
// cargo / vite work) if APP_ENV and VITE_APP_ENV disagree or are invalid — a desktop
// bundle must ship one environment identity (adversarial review).
const appEnv = resolveBuildAppEnv(process.env.APP_ENV, process.env.VITE_APP_ENV);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, ".."); // apps/desktop
const repoRoot = path.resolve(appRoot, "..", ".."); // repo root
const backendDir = path.join(appRoot, "backend");
const spec = path.join(backendDir, "superclaw-backend.spec");
const distDir = path.join(backendDir, "dist");
const workDir = path.join(backendDir, "build");

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

// Linux desktop packaging is not a target; skip so a Linux CI lint/test run never
// needs PyInstaller. macOS and Windows both produce a real frozen backend.
if (!isMac && !isWindows) {
  console.log(`backend freeze skipped on ${process.platform} (only macOS + Windows package a desktop backend)`);
  process.exit(0);
}

const venvPython = isWindows
  ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
  : path.join(repoRoot, ".venv", "bin", "python");
const frozenName = isWindows ? "superclaw-backend.exe" : "superclaw-backend";

if (!fs.existsSync(spec)) {
  throw new Error(`PyInstaller spec not found at ${spec}`);
}
const python = fs.existsSync(venvPython) ? venvPython : isWindows ? "python" : "python3";

console.log("freezing ClawHunt backend with PyInstaller (this can take a minute)...");
fs.rmSync(path.join(distDir, frozenName), { recursive: true, force: true });
execFileSync(
  python,
  ["-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", distDir, "--workpath", workDir, spec],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      // os.pathsep, not a hardcoded ":" — Windows splits PYTHONPATH on ";".
      PYTHONPATH: [path.join(repoRoot, "packages", "superclaw", "src"), repoRoot].join(path.delimiter),
    },
  },
);

const frozenExe = path.join(distDir, frozenName);
if (!fs.existsSync(frozenExe) || !fs.statSync(frozenExe).isFile()) {
  throw new Error(`expected frozen backend executable at ${frozenExe}`);
}
console.log(`frozen backend ready: ${frozenExe}`);

if (isWindows) {
  // Stage into the Tauri resource tree (collected at `tauri build` time) and bake
  // the build profile next to the backend so the installed app knows its
  // environment without the user editing config (mirrors prepare-macos-bundle).
  const stageDir = path.join(appRoot, "src-tauri", "resources", "backend", "superclaw-backend");
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.copyFileSync(frozenExe, path.join(stageDir, frozenName));
  fs.writeFileSync(
    path.join(stageDir, "build-profile.json"),
    `${JSON.stringify({ app_env: appEnv }, null, 2)}\n`,
  );
  console.log(`staged Windows backend resource: ${stageDir} (app_env=${appEnv})`);
}

if (isMac) {
  // macOS embeds the REAL backend AFTER `tauri build`, via prepare-macos-bundle.mjs
  // (a single onefile, to avoid the syspolicyd sealed-resource FD pressure a full
  // resources/ tree would cause). But tauri.conf's `bundle.resources` glob
  // (`resources/backend/**/*`) is platform-agnostic and tauri-build validates it at
  // COMPILE time — an empty/missing dir panics build.rs ("path not found or didn't
  // match any files"). Stage a tiny placeholder (in the same subdir shape Windows
  // uses) so the glob matches; the real backend/node-runtime/clawwork are embedded
  // and re-signed post-build by prepare-macos-bundle. Windows stages the real backend
  // into this tree above; macOS only needs the glob satisfied.
  const stageDir = path.join(appRoot, "src-tauri", "resources", "backend", "superclaw-backend");
  fs.rmSync(path.join(appRoot, "src-tauri", "resources", "backend"), { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(
    path.join(stageDir, "PLACEHOLDER.txt"),
    "Placeholder so tauri-build's bundle.resources glob matches at compile time on macOS.\n" +
      "The real frozen backend is embedded post-build by prepare-macos-bundle.mjs.\n",
  );
  console.log(`staged macOS resources placeholder: ${stageDir}`);
}
