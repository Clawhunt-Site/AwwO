import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveBuildAppEnv } from "../scripts/app-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");

const steps = [
  {
    name: "config",
    command: "npm",
    args: ["run", "test:config", "--prefix", "apps/desktop"],
  },
  {
    name: "build",
    command: "npm",
    args: ["run", "tauri:build", "--prefix", "apps/desktop"],
  },
  {
    name: "launch_smoke",
    command: "npm",
    args: ["run", "test:launch-smoke", "--prefix", "apps/desktop"],
  },
  {
    name: "runtime_smoke",
    command: "npm",
    args: ["run", "test:runtime-smoke", "--prefix", "apps/desktop"],
  },
  {
    name: "workbench_smoke",
    command: "npm",
    args: ["run", "test:workbench-smoke", "--prefix", "apps/desktop"],
  },
  {
    name: "installed_bundle_smoke",
    command: "npm",
    args: ["run", "test:installed-bundle-smoke", "--prefix", "apps/desktop"],
  },
];

function createReportPath() {
  const configured = process.env.SUPERCLAW_DESKTOP_ACCEPTANCE_REPORT;
  if (configured && configured.trim()) {
    return path.resolve(configured);
  }
  return path.join(repoRoot, ".superclaw", "desktop", "desktop-beta-acceptance.json");
}

function ensureParentDirectory(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

async function runStep(step) {
  const startedAt = new Date().toISOString();
  const timerStartedAt = Date.now();
  const child = spawn(step.command, step.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const durationMs = Date.now() - timerStartedAt;
  return {
    name: step.name,
    command: [step.command, ...step.args].join(" "),
    started_at: startedAt,
    duration_ms: durationMs,
    code: exit.code,
    signal: exit.signal,
    ok: exit.code === 0 && exit.signal === null,
    stdout_tail: stdout.trim().split("\n").slice(-20),
    stderr_tail: stderr.trim().split("\n").slice(-20),
  };
}

const reportPath = createReportPath();
ensureParentDirectory(reportPath);

const report = {
  generated_at: new Date().toISOString(),
  repo_root: repoRoot,
  app_root: appRoot,
  success: true,
  failed_step: null,
  steps: [],
};

for (const step of steps) {
  process.stdout.write(`\n== desktop beta acceptance: ${step.name} ==\n`);
  const result = await runStep(step);
  report.steps.push(result);
  if (!result.ok) {
    report.success = false;
    report.failed_step = step.name;
    break;
  }
}

// End-to-end environment-identity check: prove the build actually baked the resolved
// APP_ENV into the bundle's build-profile.json (the lowest-priority signal the kernel
// reads). This runs on every acceptance build — the default is 'staging', and a
// production acceptance (APP_ENV=production in the environment, e.g. via
// `npm run tauri:build:production` semantics) verifies that identity instead. Closes the
// gap where the per-environment build variants were asserted to exist but never proven
// to bake the right identity (adversarial review).
if (report.success) {
  const expectedAppEnv = resolveBuildAppEnv(process.env.APP_ENV, process.env.VITE_APP_ENV);
  const profilePath = path.join(
    appRoot, "src-tauri", "target", "release", "bundle", "macos",
    "ClawHunt.app", "Contents", "Resources", "backend", "superclaw-backend", "build-profile.json",
  );
  // The bundle only exists after a real macOS build; skip the check where the build
  // step is a no-op (non-darwin) rather than failing on an absent artifact.
  if (fs.existsSync(profilePath)) {
    let actualAppEnv = null;
    let ok = false;
    try {
      actualAppEnv = JSON.parse(fs.readFileSync(profilePath, "utf8")).app_env;
      ok = actualAppEnv === expectedAppEnv;
    } catch (error) {
      actualAppEnv = `unreadable: ${error.message}`;
    }
    report.steps.push({
      name: "build_profile_identity",
      command: `verify build-profile.json app_env == ${expectedAppEnv}`,
      ok,
      expected_app_env: expectedAppEnv,
      actual_app_env: actualAppEnv,
    });
    if (!ok) {
      report.success = false;
      report.failed_step = "build_profile_identity";
    }
  }
}

fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

assert.equal(report.success, true, `Desktop beta acceptance failed at ${report.failed_step ?? "unknown step"}`);
assert.ok(report.steps.length >= steps.length, "Expected every acceptance step to run");
for (const step of report.steps) {
  assert.equal(step.ok, true, `Expected ${step.name} to pass`);
}

console.log(`desktop beta acceptance ok: ${reportPath}`);
