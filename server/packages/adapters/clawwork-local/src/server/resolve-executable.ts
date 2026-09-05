import { realpathSync, statSync, accessSync, constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

/**
 * Resolve which ClawWork binary to spawn AND prove it enforces the governance
 * barrier (A1b).
 *
 * The forge-proof core barrier (governance-barrier.ts) only protects a run if the
 * binary we spawn actually CONTAINS it. A stray/old `clawwork` on PATH would
 * silently ignore `SUPERCLAW_REQUIRE_GOVERNANCE` and run ungoverned, collapsing A1
 * back to the forgeable ready-file fallback. So:
 *
 *  - We PREFER the vendored patched binary as the resolution source.
 *  - EVERY resolved binary (including the vendored one — a stale dist could predate
 *    the barrier) is behaviorally self-checked: a cheap probe confirms it refuses an
 *    ungoverned run, and a binary that does not is failed closed. Path/source is a
 *    preference, never proof.
 *  - The probe and the real run MUST bind to the SAME absolute path
 *    (`resolveAbsoluteCommand` against the real run env), so a bare command name
 *    cannot resolve to a patched binary at probe time and an old one at run time.
 */

export const CLAWWORK_EXECUTABLE_ENV = "SUPERCLAW_CLAWWORK_EXECUTABLE";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function isRunnableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Locate the vendored patched ClawWork build output, walking up from this module
 * to the repo's `third_party/clawwork/packages/coding-agent/dist/cli.js`. Returns
 * null when not built (the harness must be built first). */
export function resolveVendoredClawwork(): string | null {
  let dir = __moduleDir;
  for (let i = 0; i < 12; i += 1) {
    const home = path.join(dir, "third_party", "clawwork");
    // Probe order matches the kernel _bundled_clawwork_home(): built dist OR the
    // workspace bin symlink. Aligning closes the "CLI green, web red" mismatch.
    for (const candidate of [
      path.join(home, "packages", "coding-agent", "dist", "cli.js"),
      path.join(home, "node_modules", ".bin", "clawwork"),
    ]) {
      if (isRunnableFile(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface ResolvedExecutable {
  executable: string;
  /** True only for the vendored build — used as a resolution PREFERENCE and for
   * display. It is NOT proof the barrier is present (a stale dist could predate
   * it), so the caller behaviorally self-checks every binary regardless. */
  vendored: boolean;
}

/**
 * Resolve the ClawWork executable. Order: explicit operator override
 * (SUPERCLAW_CLAWWORK_EXECUTABLE) > vendored patched build > explicit config
 * command > "clawwork" on PATH. Only the vendored build is trusted without a
 * self-check.
 */
export function resolveClawworkExecutable(config: Record<string, unknown>): ResolvedExecutable {
  const override = (process.env[CLAWWORK_EXECUTABLE_ENV] ?? "").trim();
  if (override) return { executable: override, vendored: false };

  const vendored = resolveVendoredClawwork();
  if (vendored) return { executable: vendored, vendored: true };

  const configured = typeof config.command === "string" ? config.command.trim() : "";
  if (configured && configured !== "clawwork") return { executable: configured, vendored: false };

  return { executable: "clawwork", vendored: false };
}

/**
 * Resolve a (possibly bare) command to an ABSOLUTE runnable path, using the SAME
 * env (PATH) the real run will use. Pinning the absolute path closes the gap where
 * a bare name resolves to a patched binary at probe time but an old one at run time
 * (the probe and the real spawn must be the exact same file). Returns null when not
 * found / not runnable.
 */
export function resolveAbsoluteCommand(command: string, env: Record<string, string>): string | null {
  if (path.isAbsolute(command)) {
    return isRunnableFile(command) ? command : null;
  }
  // A relative path with a separator is resolved against cwd by the OS; treat it
  // as-is if runnable (rare), else fall through to PATH search by basename.
  if (command.includes("/") || command.includes("\\")) {
    const resolved = path.resolve(command);
    if (isRunnableFile(resolved)) return resolved;
  }
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isRunnableFile(candidate)) return candidate;
    }
  }
  return null;
}

// The exact prefix the core barrier (governance-barrier.ts GovernanceBarrierError)
// emits; the self-check greps for it to prove the binary enforces the barrier.
export const BARRIER_MARKER = "CLAWWORK_UNGOVERNED: the mandatory SuperClaw governance extension";

// Cache the attestation per resolved-executable realpath so the probe runs at most
// once per binary per process.
const barrierSupportCache = new Map<string, boolean>();

/**
 * Behavioral self-check: spawn the binary with SUPERCLAW_REQUIRE_GOVERNANCE set to
 * a path NO loaded extension can match (and no governance extension wired), with no
 * relay provider. A PATCHED binary's barrier fires in _buildRuntime — BEFORE any
 * model call — and prints the barrier marker (non-zero exit). An old binary ignores
 * the env var and never prints the marker. No relay/model call happens either way
 * (the patched one barriers first; the old one has no provider and fails fast).
 */
export async function verifyGovernanceBarrierSupported(
  runId: string,
  executable: string,
  baseEnv: Record<string, string>,
  cwd: string,
): Promise<boolean> {
  const key = realpathOrSelf(executable);
  const cached = barrierSupportCache.get(key);
  if (cached !== undefined) return cached;

  // A strongly-random, guaranteed-nonexistent path so no loaded extension can ever
  // coincidentally match it — a patched binary's barrier therefore ALWAYS fires.
  const bogusGovernancePath = path.join(
    __moduleDir,
    `__superclaw_barrier_selfcheck_no_such_ext_${randomBytes(12).toString("hex")}__.ts`,
  );
  const env: Record<string, string> = {
    ...baseEnv,
    SUPERCLAW_REQUIRE_GOVERNANCE: bogusGovernancePath,
  };
  // The probe must NEVER touch the relay/provider or carry governance secrets: a
  // patched binary barriers before any model call, and an unpatched one must fail
  // fast with no provider. Strip relay creds, the signed policy snapshot, the
  // governance handshake, and the managed agent dir so the probe is self-contained.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("SUPERCLAW_RELAY") ||
      key.startsWith("SUPERCLAW_POLICY_SNAPSHOT") ||
      key === "SUPERCLAW_GOVERNANCE_READY_FILE" ||
      key === "SUPERCLAW_GOVERNANCE_NONCE" ||
      key === "CLAWWORK_CODING_AGENT_DIR" ||
      key === "CLAWWORK_CODING_AGENT_SESSION_DIR"
    ) {
      delete env[key];
    }
  }

  let supported = false;
  try {
    const probe = await runChildProcess(
      `${runId}-barrier-selfcheck`,
      executable,
      ["--mode", "json", "-p", "--no-session", "--tools", "read", "governance barrier self-check"],
      { cwd, env, timeoutSec: 20, graceSec: 3, onLog: async () => {} },
    );
    supported = (probe.stdout + probe.stderr).includes(BARRIER_MARKER);
  } catch {
    supported = false;
  }
  barrierSupportCache.set(key, supported);
  return supported;
}

/** Test-only: reset the attestation cache. */
export function resetBarrierSupportCacheForTests(): void {
  barrierSupportCache.clear();
}
