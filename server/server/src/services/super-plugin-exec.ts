import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { SuperPluginRuntimeRecord } from "./super-plugin-runtime-store.js";

/**
 * Super-plugin exec governance preflight (P3 of the dual plugin runtime).
 *
 * Paperclip plugins run inside a JS worker; super plugins are a real subprocess
 * (a bundled mcp_sidecar binary, or a bare external_mcp launcher), and Paperclip
 * has NO sandbox — so spawning is host code execution. Python's cosign/digest
 * gate decides what may be ADMITTED; this module is the runtime gate deciding
 * how a process may be SPAWNED, and is the manifest-level half of the RCE defense
 * the owner accepted (a real sandbox is a later phase).
 *
 * It produces a sanitized {@link SpawnSpec} or throws — it never spawns. The
 * runner (P4) consumes the spec. NOTE (TOCTOU): a SpawnSpec is NOT a long-term
 * authorization — the entrypoint can be replaced between this check and the
 * spawn, so P4 MUST re-run this preflight immediately before each spawn rather
 * than cache a spec. Mirrors SuperClaw's Python gates:
 *   - mcp_sidecar entrypoint: realpath-jailed inside the install dir (no symlink
 *     escape), owner-exec bit required, setuid/setgid/sticky rejected
 *     (plugins.py:289-311, plugin_proxy.py:850 "escaped package root")
 *   - external_mcp command: a BARE launcher on an ALLOWLIST, resolved on PATH
 *     (plugin_proxy.py:975 `_EXTERNAL_MCP_ALLOWED_LAUNCHERS`, :1086 path check)
 *   - env: NEVER inherit the whole host env (no AWS/Anthropic key leakage); a
 *     minimal allowlist + the plugin's own declared/curated env only
 */

export class SuperPluginExecError extends Error {}

/** Curated external_mcp launchers (mirror plugin_proxy.py `_EXTERNAL_MCP_ALLOWED_LAUNCHERS`). */
export const EXTERNAL_MCP_ALLOWED_LAUNCHERS = new Set([
  "npx",
  "uvx",
  "node",
  "python3",
  "deno",
  "bunx",
  "bun",
]);

/** Host env vars safe to pass through. PATH is handled separately (narrowed, never the host PATH). */
const BASE_ENV_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"];

/** Env keys the runner controls — the plugin's declared env must never set/override these. */
const RESERVED_ENV_KEYS = new Set(["PATH", "PYTHONDONTWRITEBYTECODE"]);

/**
 * Fixed child PATH (mirror plugin_proxy.py:71 `SAFE_SIDECAR_PATH`). The host PATH
 * is used ONLY to LOOK UP an external launcher — the spawned child never inherits
 * it, so extra/writable toolchain dirs on the operator PATH cannot become a PATH
 * hijack surface for an un-sandboxed process.
 */
const SAFE_SIDECAR_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// POSIX mode bits (Node fs.constants does not expose the set-id/sticky bits).
const S_IXUSR = 0o100;
const S_ISUID = 0o4000;
const S_ISGID = 0o2000;
const S_ISVTX = 0o1000;

export interface SpawnSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface ExecPreflightOptions {
  /** The plugin's OWN declared/curated env (secrets/settings). Merged on top of the minimal base. */
  readonly pluginEnv?: Record<string, string>;
  /** Host env to derive the minimal base from (defaults to process.env). */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Resolve a bare launcher to an absolute path on PATH (injectable for tests). */
  readonly resolveLauncher?: (command: string, pathEnv: string | undefined) => string | null;
}

/**
 * Build the child env WITHOUT a PATH — the caller sets a narrowed PATH. Never
 * inherits the whole host env (no AWS/Anthropic key leak); only the safe base
 * allowlist plus the plugin's own declared env (which can add new keys but never
 * clobber a base key or PATH).
 */
function buildBaseEnv(opts: ExecPreflightOptions): Record<string, string> {
  const host = opts.hostEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = host[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(opts.pluginEnv ?? {})) {
    if (RESERVED_ENV_KEYS.has(key) || BASE_ENV_ALLOWLIST.includes(key)) continue;
    env[key] = value;
  }
  // Set AFTER the plugin merge so a declared env can never disable it.
  env.PYTHONDONTWRITEBYTECODE = "1"; // mirror the Python sidecar env (no stray .pyc writes)
  return env;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Build a spawn spec for a `mcp_sidecar` entrypoint bundled in `installDir`.
 * Fails closed on: symlinked entrypoint, escape outside the install dir, missing
 * owner-exec bit, set-uid/set-gid/sticky bits, or a non-regular file.
 */
export function resolveSidecarSpawnSpec(
  installDir: string,
  runtime: Pick<SuperPluginRuntimeRecord, "entrypoint" | "args">,
  options: ExecPreflightOptions = {},
): SpawnSpec {
  if (!runtime.entrypoint) {
    throw new SuperPluginExecError("mcp_sidecar runtime is missing an entrypoint");
  }
  let installReal: string;
  try {
    installReal = realpathSync(installDir);
  } catch (err) {
    throw new SuperPluginExecError(`install dir does not resolve: ${(err as Error).message}`);
  }

  const candidate = path.resolve(installReal, runtime.entrypoint);
  // lstat the entrypoint itself to reject a symlink AT the target (defense in depth
  // atop the staging-time symlink rejection).
  let link;
  try {
    link = lstatSync(candidate);
  } catch (err) {
    throw new SuperPluginExecError(`entrypoint not found: ${(err as Error).message}`);
  }
  if (link.isSymbolicLink()) {
    throw new SuperPluginExecError(`entrypoint must not be a symlink: ${runtime.entrypoint}`);
  }

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (err) {
    throw new SuperPluginExecError(`entrypoint does not resolve: ${(err as Error).message}`);
  }
  if (!isWithin(installReal, real)) {
    throw new SuperPluginExecError(`entrypoint escaped the install dir: ${runtime.entrypoint}`);
  }

  const st = statSync(real);
  if (!st.isFile()) {
    throw new SuperPluginExecError(`entrypoint is not a regular file: ${runtime.entrypoint}`);
  }
  if (st.mode & S_ISUID || st.mode & S_ISGID || st.mode & S_ISVTX) {
    throw new SuperPluginExecError(`entrypoint has set-uid/set-gid/sticky bits: ${runtime.entrypoint}`);
  }
  if (!(st.mode & S_IXUSR)) {
    throw new SuperPluginExecError(`entrypoint is not executable (no owner-exec bit): ${runtime.entrypoint}`);
  }

  return {
    argv: [real, ...runtime.args],
    cwd: installReal,
    env: { ...buildBaseEnv(options), PATH: SAFE_SIDECAR_PATH },
  };
}

function defaultResolveLauncher(command: string, pathEnv: string | undefined): string | null {
  const dirs = (pathEnv ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    // path.resolve makes the candidate ABSOLUTE so the file we stat is the file
    // that gets spawned (the child cwd is the install dir — a relative argv would
    // resolve there, not here).
    const candidate = path.resolve(dir, command);
    try {
      const st = statSync(candidate);
      if (st.isFile() && st.mode & S_IXUSR) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Build a spawn spec for an `external_mcp` (stdio) bare launcher. Fails closed on:
 * a path-bearing command, a non-allowlisted launcher, or a launcher absent from PATH.
 */
export function resolveExternalMcpSpawnSpec(
  installDir: string,
  runtime: Pick<SuperPluginRuntimeRecord, "command" | "args">,
  options: ExecPreflightOptions = {},
): SpawnSpec {
  const command = runtime.command;
  if (!command) {
    throw new SuperPluginExecError("external_mcp runtime is missing a command");
  }
  // Re-assert bare-ness even though the manifest schema already enforced it.
  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    throw new SuperPluginExecError(`external_mcp command must be a bare launcher name (no path): ${command}`);
  }
  if (!EXTERNAL_MCP_ALLOWED_LAUNCHERS.has(command)) {
    throw new SuperPluginExecError(`external_mcp launcher not allowlisted: ${command}`);
  }
  let cwd: string;
  try {
    cwd = realpathSync(installDir);
  } catch (err) {
    throw new SuperPluginExecError(`install dir does not resolve: ${(err as Error).message}`);
  }
  // Look the launcher up on the HOST PATH (to find version-managed npx/node), but
  // the spawned child gets a narrowed PATH = launcher dir + SAFE_SIDECAR_PATH only.
  const hostPath = (options.hostEnv ?? process.env).PATH;
  const resolve = options.resolveLauncher ?? defaultResolveLauncher;
  const resolved = resolve(command, hostPath);
  if (!resolved) {
    throw new SuperPluginExecError(`external_mcp launcher not found on PATH: ${command}`);
  }
  // The resolver MUST yield an absolute path: a relative argv[0] would resolve
  // against the child cwd (the install dir), not the dir we validated.
  if (!path.isAbsolute(resolved)) {
    throw new SuperPluginExecError(`external_mcp launcher must resolve to an absolute path: ${resolved}`);
  }
  // Best-effort realpath (a real launcher on disk resolves; an injected test fake
  // does not, so keep the absolute path in that case).
  let launcher = resolved;
  try {
    launcher = realpathSync(resolved);
  } catch {
    /* keep the absolute resolved path */
  }
  const launcherDir = path.dirname(launcher);
  const childPath = launcherDir && launcherDir !== "." ? `${launcherDir}${path.delimiter}${SAFE_SIDECAR_PATH}` : SAFE_SIDECAR_PATH;
  return { argv: [launcher, ...runtime.args], cwd, env: { ...buildBaseEnv(options), PATH: childPath } };
}

/** Route a stored runtime record to the right spawn-spec resolver (stdio launch targets only). */
export function resolveSpawnSpec(record: SuperPluginRuntimeRecord, options: ExecPreflightOptions = {}): SpawnSpec {
  if (record.runtimeType === "mcp_sidecar") {
    return resolveSidecarSpawnSpec(record.installDir, record, options);
  }
  if (record.runtimeType === "external_mcp" && record.transport === "stdio") {
    return resolveExternalMcpSpawnSpec(record.installDir, record, options);
  }
  throw new SuperPluginExecError(
    `no spawn target for runtime ${record.runtimeType}/${record.transport} (sse/http connects without spawning)`,
  );
}
