import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
      reject(new Error(`Timed out waiting for desktop smoke process ${child.pid} to exit`));
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

function builtExecutableCandidates() {
  if (process.platform === "win32") {
    return [
      path.join(releaseDir, "superclaw_desktop.exe"),
      path.join(releaseDir, "ClawHunt.exe"),
    ];
  }
  if (process.platform === "darwin") {
    const appExecutable = macBundleExecutable(path.join(releaseDir, "bundle", "macos", "ClawHunt.app"));
    return [
      path.join(releaseDir, "superclaw_desktop"),
      ...(appExecutable ? [appExecutable] : []),
    ];
  }
  return [
    path.join(releaseDir, "superclaw_desktop"),
    path.join(releaseDir, "ClawHunt"),
  ];
}

function firstExistingFile(candidates, description) {
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  assert.ok(found, `Expected ${description}; checked ${candidates.join(", ")}`);
  return found;
}

const bundleBinary = firstExistingFile(builtExecutableCandidates(), "a built desktop executable");

const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "superclaw-desktop-smoke-"));
const smokeFile = path.join(smokeDir, "launch.json");
const child = spawn(bundleBinary, [], {
  cwd: repoRoot,
  stdio: "ignore",
  env: {
    ...process.env,
    SUPERCLAW_DESKTOP_WORKDIR: repoRoot,
    SUPERCLAW_DESKTOP_SMOKE_FILE: smokeFile,
  },
});

await waitForFile(smokeFile, 15000);
const payload = JSON.parse(fs.readFileSync(smokeFile, "utf8"));
assert.equal(payload.productName, "ClawHunt");
assert.equal(payload.version, "0.1.0");
assert.equal(path.resolve(payload.workspaceRoot ?? ""), repoRoot);
assert.ok(path.normalize(payload.webDistPath ?? "").endsWith(path.join("apps", "web", "dist")));
assert.ok(payload.cliExecutable.includes("superclaw"));
assert.ok(payload.pid > 0);
assert.ok(payload.launchedAtEpochMs > 0);

const result = await waitForExit(child, 15000);
assert.equal(result.signal, null);
assert.equal(result.code, 0);

console.log("desktop launch smoke ok");
