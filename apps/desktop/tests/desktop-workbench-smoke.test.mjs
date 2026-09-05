import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const bundleMacOsDir = path.join(
  appRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "ClawHunt.app",
  "Contents",
  "MacOS",
);
const releaseExecutable = path.join(appRoot, "src-tauri", "target", "release", "superclaw_desktop");
const smokeTimeoutMs = 120000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFileOrExit(targetPath, child, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(targetPath)) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Desktop workbench smoke exited before writing ${targetPath}: code=${child.exitCode} signal=${child.signalCode}`,
      );
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
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for desktop workbench smoke process ${child.pid} to exit`));
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

assert.ok(fs.existsSync(bundleMacOsDir), `Expected built desktop bundle at ${bundleMacOsDir}`);
const bundleEntries = fs
  .readdirSync(bundleMacOsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(bundleMacOsDir, entry.name));
assert.equal(bundleEntries.length, 1, `Expected a single bundle executable in ${bundleMacOsDir}`);
const [bundleBinary] = bundleEntries;
const smokeBinary =
  process.platform === "darwin" && fs.existsSync(releaseExecutable) ? releaseExecutable : bundleBinary;

const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "superclaw-desktop-workbench-smoke-"));
const smokeFile = path.join(smokeDir, "workbench-smoke.json");
const statePath = path.join(smokeDir, "workbench-state.db");
const child = spawn(smokeBinary, [], {
  cwd: repoRoot,
  stdio: "ignore",
  env: {
    ...process.env,
    SUPERCLAW_DESKTOP_WORKDIR: repoRoot,
    SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_FILE: smokeFile,
    SUPERCLAW_DESKTOP_WORKBENCH_SMOKE_STATE_PATH: statePath,
    SUPERCLAW_DESKTOP_WORKBENCH_CHAT_BACKEND: "codex",
    SUPERCLAW_DESKTOP_WORKBENCH_RUN_BACKEND: "local",
    SUPERCLAW_DESKTOP_CLI_EXECUTABLE: path.join(repoRoot, ".venv", "bin", "superclaw"),
  },
});

await waitForFileOrExit(smokeFile, child, smokeTimeoutMs);
const payload = JSON.parse(fs.readFileSync(smokeFile, "utf8"));
assert.equal(payload.shell.productName, "ClawHunt");
assert.equal(payload.success, true);
assert.equal(payload.error, null);
assert.equal(payload.start.ok, true);
assert.equal(payload.directChat.status, "completed");
assert.ok(typeof payload.directChat.response === "string" && payload.directChat.response.trim().length > 0);
assert.ok(typeof payload.goal.goal_id === "string" && payload.goal.goal_id.length > 0);
assert.equal(payload.run.status, "completed");
assert.ok(typeof payload.run.run_id === "string" && payload.run.run_id.length > 0);
assert.equal(payload.evidence.chain_verdict, "CHAIN_PARTIAL");
assert.equal(payload.stop.ok, true);
assert.equal(payload.stop.stopped, true);
assert.equal(payload.probeAfterStop.ok, false);
assert.equal(payload.start.handle.state_path, statePath);
assert.equal(payload.start.handle.owned, true);

const result = await waitForExit(child, smokeTimeoutMs);
assert.equal(result.signal, null);
assert.equal(result.code, 0);

console.log("desktop workbench smoke ok");
