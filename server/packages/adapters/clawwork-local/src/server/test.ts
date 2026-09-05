import fs from "node:fs/promises";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  parseObject,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveGovernanceExtPath } from "./governance.js";
import { RELAY_BASE_URL_ENV, RELAY_API_KEY_ENV } from "./runtime-config.js";
import {
  resolveClawworkExecutable,
  resolveAbsoluteCommand,
  verifyGovernanceBarrierSupported,
} from "./resolve-executable.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const { executable: command, vendored: commandIsVendored } = resolveClawworkExecutable(config);
  const envConfig = parseObject(config.env);
  const cwd = asString(config.cwd, "") || process.cwd();
  const runId = `clawwork-envtest-${ctx.companyId}`;

  // 1. cwd valid
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
    checks.push({ code: "clawwork_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "clawwork_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // 2. governance extension present (mandatory — the pay/scan hard gate)
  const ext = resolveGovernanceExtPath();
  if (ext) {
    checks.push({ code: "clawwork_governance_present", level: "info", message: `Governance extension found: ${ext}` });
  } else {
    checks.push({
      code: "clawwork_governance_missing",
      level: "error",
      message: "superclaw-governance extension not found; ClawWork runs are refused without the pay/scan hard gate.",
      hint: "Build the vendored harness (scripts/build-clawwork.sh) or set SUPERCLAW_CLAWWORK_GOVERNANCE_EXT.",
    });
  }

  // 3. relay base + key injected
  const resolveEnv = (name: string): string =>
    (typeof envConfig[name] === "string" ? (envConfig[name] as string) : process.env[name] ?? "").trim();
  const hasBase = Boolean(resolveEnv(RELAY_BASE_URL_ENV));
  const hasKey = Boolean(resolveEnv(RELAY_API_KEY_ENV));
  if (hasBase && hasKey) {
    checks.push({ code: "clawwork_relay_env", level: "info", message: "Relay base URL and key are injected." });
  } else {
    checks.push({
      code: "clawwork_relay_env_missing",
      level: "warn",
      message: `Relay env incomplete (base: ${hasBase ? "set" : "missing"}, key: ${hasKey ? "set" : "missing"}).`,
      hint: `SuperClaw injects ${RELAY_BASE_URL_ENV} / ${RELAY_API_KEY_ENV}; a run with neither fails closed.`,
    });
  }

  // 4. command runnable (--version)
  const cwdInvalid = checks.some((c) => c.code === "clawwork_cwd_invalid");
  if (!cwdInvalid) {
    const merged = ensurePathInEnv({ ...process.env, ...(envConfig as Record<string, string>) });
    const runtimeEnv = Object.fromEntries(
      Object.entries(merged).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    try {
      const probe = await runChildProcess(runId, command, ["--version"], {
        cwd,
        env: runtimeEnv,
        timeoutSec: 10,
        graceSec: 3,
        onLog: async () => {},
      });
      if ((probe.exitCode ?? 1) === 0) {
        checks.push({
          code: "clawwork_command_runnable",
          level: "info",
          message: `ClawWork command is runnable: ${command} (${(probe.stdout || "").trim().split(/\r?\n/)[0] ?? ""})`,
        });
      } else {
        checks.push({
          code: "clawwork_command_not_runnable",
          level: "error",
          message: `ClawWork command exited ${probe.exitCode} for --version.`,
          detail: command,
          hint: "Build the vendored harness with scripts/build-clawwork.sh, or set SUPERCLAW_CLAWWORK_EXECUTABLE.",
        });
      }
    } catch (err) {
      checks.push({
        code: "clawwork_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "ClawWork command is not executable",
        detail: command,
      });
    }

    // Governance barrier attestation (A1b): behaviorally probe EVERY resolved binary
    // (including the vendored build — a stale dist could predate the barrier) and
    // report whether it actually enforces the barrier. Path/source is never trusted
    // as proof.
    const commandResolvable = checks.every(
      (c) => c.code !== "clawwork_command_unresolvable" && c.code !== "clawwork_command_not_runnable",
    );
    if (commandResolvable) {
      const merged = ensurePathInEnv({ ...process.env, ...(envConfig as Record<string, string>) });
      const probeEnv = Object.fromEntries(
        Object.entries(merged).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
      // Probe the SAME absolute file a real run would spawn (resolved against the
      // run env), not the bare name.
      const absolute = resolveAbsoluteCommand(command, probeEnv) ?? command;
      const supported = await verifyGovernanceBarrierSupported(runId, absolute, probeEnv, cwd);
      checks.push(
        supported
          ? {
              code: "clawwork_barrier_supported",
              level: "info",
              message: `ClawWork enforces the SuperClaw governance barrier${commandIsVendored ? " (vendored build)" : ""}.`,
            }
          : {
              code: "clawwork_barrier_unsupported",
              level: "error",
              message: "The resolved ClawWork binary does not enforce the SuperClaw governance barrier; governed runs would be refused (fail-closed).",
              detail: command,
              hint: "Rebuild the vendored harness (scripts/build-clawwork.sh) or use a patched ClawWork binary.",
            },
      );
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
