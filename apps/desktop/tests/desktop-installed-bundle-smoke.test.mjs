import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const releaseDir = path.join(appRoot, "src-tauri", "target", "release");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(targetPath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(targetPath)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${targetPath}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill(process.platform === "win32" ? undefined : "SIGKILL");
      reject(new Error(`Timed out waiting for installed bundle smoke process ${child.pid} to exit`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function macBundleExecutable(bundleDir) {
  const macOsDir = path.join(bundleDir, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir)) {
    return null;
  }
  const entries = fs
    .readdirSync(macOsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(macOsDir, entry.name));
  return entries.length === 1 ? entries[0] : null;
}

function builtBundleCandidates() {
  if (process.platform === "win32") {
    return [
      path.join(releaseDir, "superclaw_desktop.exe"),
      path.join(releaseDir, "ClawHunt.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      path.join(releaseDir, "bundle", "macos", "ClawHunt.app"),
      path.join(releaseDir, "superclaw_desktop"),
    ];
  }
  return [
    path.join(releaseDir, "superclaw_desktop"),
    path.join(releaseDir, "ClawHunt"),
  ];
}

function firstExistingCandidate(candidates, description) {
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(found, `Expected ${description}; checked ${candidates.join(", ")}`);
  return found;
}

function copyBundleToInstallRoot(sourceBundle, applicationsDir) {
  const sourceStats = fs.statSync(sourceBundle);
  const installedBundleDir = path.join(applicationsDir, process.platform === "darwin" ? "ClawHunt.app" : "ClawHunt");
  if (sourceStats.isDirectory()) {
    fs.cpSync(sourceBundle, installedBundleDir, { recursive: true });
    return installedBundleDir;
  }
  if (process.platform === "darwin") {
    const macOsDir = path.join(installedBundleDir, "Contents", "MacOS");
    fs.mkdirSync(macOsDir, { recursive: true });
    const target = path.join(macOsDir, path.basename(sourceBundle));
    fs.copyFileSync(sourceBundle, target);
    fs.chmodSync(target, 0o755);
    return installedBundleDir;
  }
  fs.mkdirSync(installedBundleDir, { recursive: true });
  fs.copyFileSync(sourceBundle, path.join(installedBundleDir, path.basename(sourceBundle)));
  return installedBundleDir;
}

function installedExecutableForBundle(bundleDir) {
  if (process.platform === "darwin") {
    const executable = macBundleExecutable(bundleDir);
    assert.ok(executable, `Expected a single executable under copied macOS bundle ${bundleDir}`);
    return executable;
  }
  const entries = fs
    .readdirSync(bundleDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(bundleDir, entry.name));
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executable = entries.find((entry) => path.basename(entry).toLowerCase().includes("superclaw") && entry.endsWith(suffix));
  assert.ok(executable, `Expected copied desktop executable in ${bundleDir}`);
  return executable;
}

function assertMacBundleResourceSealIsLaunchable(bundleDir) {
  if (process.platform !== "darwin") {
    return;
  }
  const codeResources = path.join(bundleDir, "Contents", "_CodeSignature", "CodeResources");
  assert.ok(fs.existsSync(codeResources), `Expected macOS CodeResources at ${codeResources}`);
  const out = execFileSync(
    "python3",
    [
      "-c",
      [
        "import plistlib, sys",
        "with open(sys.argv[1], 'rb') as f:",
        "    data = plistlib.load(f)",
        "print(len(data.get('files2') or data.get('files') or {}))",
      ].join("\n"),
      codeResources,
    ],
    { encoding: "utf8" },
  ).trim();
  const sealedResourceCount = Number.parseInt(out, 10);
  assert.ok(Number.isFinite(sealedResourceCount), `Expected numeric sealed resource count, got ${out}`);
  assert.ok(
    sealedResourceCount < 256,
    `Expected macOS bundle to seal fewer than 256 resources, got ${sealedResourceCount}`,
  );
}

function assertBundledClawworkPresent(bundleDir) {
  // The self-contained ClawWork (binary + governance extension) must ship next
  // to the frozen backend so the kernel auto-discovers it
  // (backends._frozen_clawwork_dir resolves <sys.executable dir>/clawwork/).
  // Gated on the embedded backend dir existing: only the full .app path embeds a
  // backend, so the single-release-binary smoke fallback correctly skips this.
  const embeddedBackendDir = path.join(
    bundleDir, "Contents", "Resources", "backend", "superclaw-backend",
  );
  if (!fs.existsSync(embeddedBackendDir)) {
    return;
  }
  const bundledBin = path.join(embeddedBackendDir, "clawwork", "clawwork");
  const bundledExt = path.join(
    embeddedBackendDir, "clawwork", "extensions", "superclaw-governance.ts",
  );
  assert.ok(fs.existsSync(bundledBin), `Expected bundled ClawWork binary at ${bundledBin}`);
  assert.ok(
    (fs.statSync(bundledBin).mode & 0o111) !== 0,
    `Expected bundled ClawWork binary to be executable: ${bundledBin}`,
  );
  // The governance extension is MANDATORY — without it the backend fails closed
  // (a half-shipped bundle would leave ClawWork unavailable, never ungoverned).
  assert.ok(fs.existsSync(bundledExt), `Expected bundled ClawWork governance extension at ${bundledExt}`);
}

function smokeExecutableForBundle(installedExecutable) {
  if (process.platform === "darwin") {
    // macOS kills direct headless execution of the signed .app/Contents/MacOS
    // entry in this harness. The release binary is the same Rust application
    // entry before bundling/signing, so use it for environment-driven smoke
    // while still validating the copied bundle structure above.
    const releaseExecutable = path.join(releaseDir, "superclaw_desktop");
    if (fs.existsSync(releaseExecutable) && fs.statSync(releaseExecutable).isFile()) {
      return releaseExecutable;
    }
  }
  return installedExecutable;
}

function defaultSmokeCliExecutable() {
  const windowsCandidate = path.join(repoRoot, ".venv", "Scripts", "superclaw.exe");
  const posixCandidate = path.join(repoRoot, ".venv", "bin", "superclaw");
  if (process.platform === "win32" && fs.existsSync(windowsCandidate)) {
    return windowsCandidate;
  }
  if (fs.existsSync(posixCandidate)) {
    return posixCandidate;
  }
  return "superclaw";
}

const sourceBundle = firstExistingCandidate(builtBundleCandidates(), "a built desktop bundle or executable");

const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "superclaw-desktop-installed-bundle-"));
try {
  const applicationsDir = path.join(installRoot, "Applications");
  fs.mkdirSync(applicationsDir, { recursive: true });
  const installedBundleDir = copyBundleToInstallRoot(sourceBundle, applicationsDir);

  assert.ok(fs.existsSync(installedBundleDir), `Expected copied desktop bundle at ${installedBundleDir}`);
  const installedBinary = installedExecutableForBundle(installedBundleDir);
  assertMacBundleResourceSealIsLaunchable(installedBundleDir);
  assertBundledClawworkPresent(installedBundleDir);
  assert.ok(
    path.normalize(installedBinary).startsWith(path.normalize(installedBundleDir)),
    `Expected installed binary ${installedBinary} to live under copied bundle ${installedBundleDir}`,
  );
  const smokeBinary = smokeExecutableForBundle(installedBinary);
  assert.ok(fs.existsSync(smokeBinary), `Expected smoke executable at ${smokeBinary}`);

  const smokeDir = path.join(installRoot, "smoke");
  fs.mkdirSync(smokeDir, { recursive: true });
  const smokeFile = path.join(smokeDir, "installed-workbench-smoke.json");
  const statePath = path.join(smokeDir, "installed-workbench-state.db");
  const child = spawn(smokeBinary, [], {
    cwd: installRoot,
    stdio: "ignore",
    env: {
      ...process.env,
      SUPERCLAW_DESKTOP_WORKDIR: repoRoot,
      SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_FILE: smokeFile,
      SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_STATE_PATH: statePath,
      SUPERCLAW_DESKTOP_WORKBENCH_CHAT_BACKEND: "codex",
      SUPERCLAW_DESKTOP_WORKBENCH_RUN_BACKEND: "local",
      SUPERCLAW_DESKTOP_CLI_EXECUTABLE: defaultSmokeCliExecutable(),
    },
  });

  await waitForFile(smokeFile, 120000);
  const payload = JSON.parse(fs.readFileSync(smokeFile, "utf8"));
  assert.equal(payload.shell.productName, "ClawHunt");
  assert.equal(payload.success, true);
  assert.equal(payload.error, null);
  assert.equal(payload.directChat.status, "completed");
  assert.equal(payload.run.status, "completed");
  assert.equal(payload.evidence.chain_verdict, "CHAIN_PARTIAL");
  assert.equal(payload.stop.ok, true);
  assert.equal(payload.stop.stopped, true);
  assert.equal(payload.probeAfterStop.ok, false);
  assert.equal(payload.start.handle.state_path, statePath);
  assert.equal(payload.start.handle.owned, true);

  const result = await waitForExit(child, 120000);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);

  console.log("desktop installed bundle smoke ok");
} finally {
  fs.rmSync(installRoot, { recursive: true, force: true });
}
