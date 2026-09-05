import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Build the internalized ClawWork harness into a SELF-CONTAINED standalone
// binary (bun --compile) so the shipped desktop app can drive the ClawWork
// backend out of the box — the end user never installs Node or runs a build.
//
// prepare-macos-bundle.mjs then copies the binary + the (self-contained)
// governance extension into ClawHunt.app/Contents/Resources/.../clawwork/, and
// the kernel (backends._frozen_clawwork_dir) auto-discovers them next to the
// frozen backend. No SUPERCLAW_CLAWWORK_EXECUTABLE / _GOVERNANCE_EXT wiring.
//
// Why not scripts/build-clawwork.sh? That produces dist/cli.js (needs an
// external Node at runtime). A shipped app cannot assume Node, so we compile a
// standalone binary instead — bun embeds its own runtime and natively loads the
// .ts governance extension, which a bare `node dist/cli.js` cannot.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, ".."); // apps/desktop
const repoRoot = path.resolve(appRoot, "..", ".."); // repo root
const harness = path.join(repoRoot, "third_party", "clawwork");
const codingAgent = path.join(harness, "packages", "coding-agent");
const binaryName = process.platform === "win32" ? "pi.exe" : "pi";
const builtBinary = path.join(codingAgent, "dist", binaryName);

if (process.platform !== "darwin") {
  // The desktop bundle (and prepare-macos-bundle.mjs) is macOS-only today; the
  // binary is host-platform, matching the .app being built. Skip elsewhere so a
  // CI lint/test run on Linux never needs bun.
  console.log("clawwork binary build skipped on non-darwin platform");
  process.exit(0);
}

if (!fs.existsSync(codingAgent)) {
  throw new Error(`bundled ClawWork harness not found at ${harness}`);
}

// bun is required for --compile (it embeds the runtime). Fail with a clear,
// actionable message rather than an opaque "command not found" deep in npm.
try {
  execFileSync("bun", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error(
    "bun is required to compile the ClawWork standalone binary (`bun build --compile`). " +
      "Install it (https://bun.sh) and ensure `bun` is on PATH.",
  );
}

// Fresh, reproducible install — ALWAYS `npm ci`, every build. node_modules/ is
// gitignored, so the only durable source of truth for what should be installed is
// `package-lock.json`. The previous `if (!existsSync(node_modules)) npm ci` guard
// installed only when node_modules was *absent*: after a re-vendor of the pinned
// ClawWork upstream (which rewrites package-lock.json), any host with a STALE
// node_modules from the prior vendoring kept it — so the install no longer matched
// the lockfile (missing @types/*, stale SDK type defs) and the workspace `tsgo`
// typecheck failed on a tree that was actually correct. `npm ci` is the canonical
// reproducible installer: it deletes node_modules and installs EXACTLY the
// lockfile, and fails closed (non-zero) if package-lock.json is missing or out of
// sync — so a stale tree can never silently leak into the compile. It costs a
// reinstall on every build, which is negligible next to the bun --compile + the
// PyInstaller backend freeze in the surrounding desktop build, and buys an
// unambiguous, always-matching dependency tree. NOTE: do NOT run two desktop
// builds concurrently against the same `third_party/clawwork` checkout — each
// `npm ci` deletes and recreates node_modules, so concurrent runs would race
// (one wiping deps mid-typecheck of the other). This is a single-invocation
// release packaging step, not a concurrency-safe one.
if (!fs.existsSync(path.join(harness, "package-lock.json"))) {
  throw new Error(
    `ClawWork harness lockfile missing at ${path.join(harness, "package-lock.json")} — ` +
      "refusing to build against an unpinned dependency tree.",
  );
}
console.log(`installing ClawWork harness deps (npm ci) at ${harness}...`);
execFileSync("npm", ["ci"], { cwd: harness, stdio: "inherit" });

// `build:binary` compiles the workspaces (tui/agent/ai via tsgo) then
// `bun build --compile` + copy-binary-assets. The COMPILE steps do NOT
// regenerate the model catalog from the network — that catalog-fetching logic
// lives in the SEPARATE `generate-models*` scripts, not in the package `build`
// (the dangerous step is the workspace-ROOT build; `npm --prefix ../ai run
// build` is plain tsgo). Verified it mutates no committed source. NOTE: this is
// not a hermetic/offline build — `npm ci` above still fetches deps from the
// registry on a cache miss, and `bun build --compile` embeds whatever `bun` is
// on PATH (version not pinned here → the binary is not bit-for-bit reproducible
// across hosts; pin bun + vendor deps if strict reproducibility is required).
console.log("compiling ClawWork standalone binary (bun --compile; this can take a minute)...");
execFileSync("npm", ["run", "build:binary"], { cwd: codingAgent, stdio: "inherit" });

if (!fs.existsSync(builtBinary) || !fs.statSync(builtBinary).isFile()) {
  throw new Error(`expected compiled ClawWork binary at ${builtBinary}`);
}
// Probe it for real: a present file can still be a broken build. A failed
// --version means the binary is not actually runnable — fail the build now
// rather than ship a clawwork the backend will report unavailable.
const version = execFileSync(builtBinary, ["--version"], { encoding: "utf-8" }).trim();
console.log(`ClawWork standalone binary ready: ${builtBinary} (${version})`);
