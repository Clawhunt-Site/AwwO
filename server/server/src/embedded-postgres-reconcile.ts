import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

/**
 * Reconciliation for a leftover embedded-PostgreSQL `postmaster.pid`.
 *
 * WHY THIS EXISTS: the embedded server is spawned as a direct child of the Node
 * process (`spawn(postgres, ["-D", dataDir, ...])`), and its clean shutdown runs
 * only through the Node SIGINT/SIGTERM handler. When Node is hard-killed
 * (force-quit, SIGKILL, or a too-fast desktop close/reopen), the postmaster can
 * survive as an orphan that keeps holding the data-directory lock — so the next
 * startup finds a stale/foreign `postmaster.pid` and either mis-reuses a wrong
 * process or fails to start on the locked datadir. The previous logic trusted a
 * bare `kill(pid, 0)` liveness check and assumed the configured port, which broke
 * on recycled PIDs and after a prior port fallback.
 *
 * CORRUPTION SAFETY IS THE PRIME DIRECTIVE. Deleting `postmaster.pid` while a real
 * postmaster still runs on the datadir lets a second postmaster start on the same
 * files → irreversible corruption. So the decision here is fail-CLOSED: the lock is
 * only ever removed once the datadir is positively confirmed free (no pidfile, a
 * dead pid, a recycled non-postgres pid, or a postmaster we successfully killed).
 * Every ambiguous case aborts startup and leaves the lock untouched.
 *
 * The pure {@link reconcilePidfile} decision and the {@link resolveLeftoverPostmaster}
 * orchestration are both driven by injected probes so their branch logic — including
 * the "never delete a live lock" invariant — is unit-testable without a live
 * PostgreSQL or real signals.
 */

/**
 * A parsed PostgreSQL `postmaster.pid`. The file layout (the postmaster writes it
 * once it owns the datadir) is:
 *   line 1: postmaster PID
 *   line 2: data directory
 *   line 3: start time (epoch seconds)
 *   line 4: port number
 *   line 5: UNIX socket directory
 *   line 6: first listen address
 *   line 7: shared-memory key
 */
export type PostmasterPidInfo = {
  pid: number;
  /** Data directory recorded by the postmaster (line 2); "" when unreadable. */
  dataDir: string;
  /** Port recorded by the postmaster (line 4); null when unreadable. */
  port: number | null;
};

export function parsePostmasterPidFile(contents: string): PostmasterPidInfo | null {
  const lines = contents.split("\n");
  const pid = Number(lines[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const dataDir = lines[1]?.trim() ?? "";
  const portRaw = lines[3]?.trim() ?? "";
  const parsedPort = /^\d+$/.test(portRaw) ? Number(portRaw) : NaN;
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null;
  return { pid, dataDir, port };
}

/**
 * What the OS process behind a leftover PID is, relative to our datadir:
 *   - "ours":    a postgres/postmaster executable running `-D <ourDataDir>` — it
 *                genuinely holds our datadir and must be reused or reclaimed.
 *   - "foreign": a live process that is definitively NOT postgres (the real
 *                postmaster died and the PID was recycled) — our datadir is free.
 *   - "unknown": we could not read the command line, or it is a postgres we cannot
 *                tie to our datadir — treated as possibly-ours, so NEVER deleted.
 */
export type ProcessIdentity = "ours" | "foreign" | "unknown";

export type PidfileDisposition =
  /** Datadir confirmed free — caller removes any stale pidfile and starts fresh. */
  | { action: "start-fresh"; reason: string }
  /** A healthy embedded server for our datadir is already listening; reuse on `port`. */
  | { action: "reuse"; pid: number; port: number; reason: string }
  /** Our datadir's postmaster is orphaned/wedged; caller kills `pid`, then starts fresh. */
  | { action: "reclaim"; pid: number; reason: string }
  /** A live process may hold our datadir and cannot be safely reclaimed — refuse to start. */
  | { action: "abort"; pid: number; reason: string };

export type ReconcileProbes = {
  /** True when a process with this PID currently exists (e.g. `kill(pid, 0)`). */
  isPidAlive(pid: number): boolean;
  /** data_directory reported by a PostgreSQL reachable at `port`, or null if unreachable. */
  probeDataDirectoryAtPort(port: number): Promise<string | null>;
  /** Classify the live OS process `pid` relative to `dataDir`. */
  classifyProcess(pid: number, dataDir: string): ProcessIdentity;
  /** True when both paths resolve to the same location (symlink-aware in production). */
  samePath(a: string, b: string): boolean;
};

/**
 * Decide what to do about a leftover `postmaster.pid`. Pure: all IO is injected via
 * {@link ReconcileProbes}. Fail-closed — `start-fresh` (which authorises deleting the
 * lock) is returned ONLY when the datadir is positively free; a live process that
 * might be our postmaster yields `abort`, never a delete.
 */
export async function reconcilePidfile(
  info: PostmasterPidInfo | null,
  dataDir: string,
  probes: ReconcileProbes,
): Promise<PidfileDisposition> {
  if (!info) {
    return { action: "start-fresh", reason: "no postmaster.pid" };
  }

  if (!probes.isPidAlive(info.pid)) {
    return { action: "start-fresh", reason: "postmaster.pid pid is not alive (stale file)" };
  }

  // The PID is alive. Is a healthy embedded server for our datadir actually listening?
  // Probe ITS recorded port (not the configured one, which may differ after a prior
  // fallback), and confirm the reported data directory is ours before reusing.
  if (info.port !== null) {
    const actualDataDir = await probes.probeDataDirectoryAtPort(info.port);
    if (actualDataDir && probes.samePath(actualDataDir, dataDir)) {
      return {
        action: "reuse",
        pid: info.pid,
        port: info.port,
        reason: "reachable embedded PostgreSQL for our data directory",
      };
    }
  }

  // Alive PID, but no reachable server for our datadir on the recorded port. Classify
  // the OS process to decide safely between reclaim (kill our wedged postmaster),
  // start-fresh (recycled to an unrelated process — datadir is free), and abort
  // (cannot tell — must not risk deleting a live lock).
  const identity = probes.classifyProcess(info.pid, dataDir);
  if (identity === "ours") {
    return {
      action: "reclaim",
      pid: info.pid,
      reason: "orphaned/wedged postmaster still holding our data directory",
    };
  }
  if (identity === "foreign") {
    return {
      action: "start-fresh",
      reason: "postmaster.pid pid was recycled to an unrelated process; data directory is free",
    };
  }
  return {
    action: "abort",
    pid: info.pid,
    reason:
      "a live process holds the pid recorded in postmaster.pid but could not be confirmed as ours or foreign; " +
      "refusing to start to avoid a second postmaster on the same data directory",
  };
}

/**
 * Classify a process command line relative to `dataDir`. Pure so it is unit-testable.
 *
 * Identity is NOT a substring test: the executable basename must be `postgres`/
 * `postmaster` AND the argv must carry `-D <dataDir>` (or `-D<dataDir>`) as a bounded
 * token whose path resolves to ours. This rejects unrelated processes that merely
 * mention the datadir path (a backup, `tail`, `grep`, an editor). A postgres we cannot
 * tie to our exact datadir degrades to "unknown" (never deleted), not "foreign".
 *
 * Note: `-D` and its value are separate argv entries from embedded-postgres, and the
 * value is the verbatim path we passed, so plain resolve-equality is correct here (no
 * symlink canonicalisation needed — that only matters for the port-probe comparison,
 * where PostgreSQL reports its own realpath'd data_directory).
 */
export function classifyPidProcess(command: string, dataDir: string): ProcessIdentity {
  const trimmed = command.trim();
  if (!trimmed) {
    return "unknown";
  }
  const tokens = trimmed.split(/\s+/);
  const exe = tokens[0] ? basename(tokens[0]) : "";
  const isPostgresExe = exe === "postgres" || exe === "postmaster";
  const target = resolve(dataDir);

  let carriesOurDataDir = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-D" && i + 1 < tokens.length && resolve(tokens[i + 1]!) === target) {
      carriesOurDataDir = true;
      break;
    }
    if (token.length > 2 && token.startsWith("-D") && resolve(token.slice(2)) === target) {
      carriesOurDataDir = true;
      break;
    }
  }

  // Fail-closed classification. Strongest signal first: a cleanly-parsed postgres executable
  // pinned to our datadir is definitively "ours".
  if (isPostgresExe && carriesOurDataDir) {
    return "ours";
  }

  // "foreign" — the ONLY verdict that authorises deleting the lock — requires ZERO postgres
  // signature in the (lossy, whitespace-split) command. Besides the token-based checks above,
  // scan the RAW command for a postgres/postmaster executable name or a `-D` flag: when BOTH
  // the binary path and the datadir contain spaces, tokenisation corrupts token[0] AND the
  // `-D` alignment, yet the raw string still carries "/postgres" / "-D". Any such hint keeps
  // it out of "foreign" and degrades to "unknown" → abort, never a delete.
  if (isPostgresExe || carriesOurDataDir || commandLooksPostgresish(trimmed)) {
    return "unknown";
  }
  return "foreign";
}

const POSTGRES_EXE_HINT = /(?:^|\/)(?:postgres|postmaster)(?:\s|$)/;
const POSTGRES_D_FLAG_HINT = /(?:^|\s)-D(?:[\s=/]|$)/;

/** True when a lossy command line carries any postgres shape (executable name or -D flag). */
function commandLooksPostgresish(command: string): boolean {
  return POSTGRES_EXE_HINT.test(command) || POSTGRES_D_FLAG_HINT.test(command);
}

/**
 * Liveness check that distinguishes "no such process" from "exists but I can't signal it".
 * `process.kill(pid, 0)` throws ESRCH when the PID is truly gone, but EPERM when the process
 * EXISTS under another owner — which must count as alive, not stale, or we would treat a live
 * lock as removable. Any non-ESRCH error therefore returns true (conservative/fail-closed).
 */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = process.kill.bind(process),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * Read a `postmaster.pid`, distinguishing "genuinely absent" from "exists but unreadable".
 * A missing file (ENOENT) returns null → the caller may treat the datadir as free. ANY other
 * read error (permission, transient IO) means a lock file may exist and hold a live datadir,
 * so it THROWS — never letting an unreadable-but-present lock be silently deleted. Reading
 * directly (no existsSync pre-check) also removes the TOCTOU window.
 */
export function readPostmasterPidFile(
  pidfilePath: string,
  deps: { readFile(path: string): string },
): string | null {
  try {
    return deps.readFile(pidfilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `postmaster.pid at ${pidfilePath} exists but could not be read ` +
        `(${(error as NodeJS.ErrnoException)?.code ?? "unknown error"}); refusing to start to avoid ` +
        "deleting a lock that may protect a live data directory.",
    );
  }
}

/**
 * Best-effort read of a process's command line, used by {@link classifyPidProcess}.
 * POSIX-only via `ps`; returns "" on any other platform or failure so the caller
 * conservatively classifies as "unknown" and declines to delete the lock.
 */
export function readProcessCommandLine(pid: number): string {
  if (process.platform === "win32") {
    return "";
  }
  try {
    // -ww disables column truncation so long datadir paths in the argv survive.
    return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export type KillProbes = {
  isPidAlive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
};

export type KillOptions = {
  /** How long to wait for a graceful SIGTERM exit before escalating. */
  termGraceMs?: number;
  /** How long to wait for the SIGKILL to take effect. */
  killGraceMs?: number;
  /** Liveness poll interval. */
  pollMs?: number;
};

/**
 * Tear down an orphaned postmaster by PID: SIGTERM, wait, then escalate to SIGKILL.
 * Deterministic and IO-injected so it is unit-testable in-process (no real signals,
 * no wall-clock waits). Returns true once the PID is gone; false if it survives even
 * SIGKILL (the caller MUST treat false as "datadir still locked" and abort startup).
 */
export async function killPostmaster(
  pid: number,
  probes: KillProbes,
  opts: KillOptions = {},
): Promise<boolean> {
  const pollMs = opts.pollMs ?? 200;
  const termAttempts = Math.max(1, Math.ceil((opts.termGraceMs ?? 10_000) / pollMs));
  const killAttempts = Math.max(1, Math.ceil((opts.killGraceMs ?? 2_000) / pollMs));

  const trySignal = (signal: NodeJS.Signals): void => {
    try {
      probes.kill(pid, signal);
    } catch {
      // Already gone, or we lack permission — liveness polling below is the source of truth.
    }
  };

  if (!probes.isPidAlive(pid)) {
    return true;
  }

  trySignal("SIGTERM");
  for (let i = 0; i < termAttempts; i += 1) {
    if (!probes.isPidAlive(pid)) {
      return true;
    }
    await probes.sleep(pollMs);
  }

  trySignal("SIGKILL");
  for (let i = 0; i < killAttempts; i += 1) {
    if (!probes.isPidAlive(pid)) {
      return true;
    }
    await probes.sleep(pollMs);
  }

  return !probes.isPidAlive(pid);
}

/** What the caller should do after reconciliation. */
export type StartupPlan =
  | { mode: "reuse"; pid: number; port: number }
  | { mode: "start" };

export type ResolveLeftoverPostmasterDeps = {
  dataDir: string;
  /** Full `postmaster.pid` contents, or null ONLY when the file is genuinely absent (ENOENT). */
  readPidfileContents(): string | null;
  probes: ReconcileProbes;
  /** Kill an orphaned postmaster; returns false if it could not be terminated. */
  killPostmaster(pid: number): Promise<boolean>;
  /**
   * Remove the specific stale pidfile we read and classified. MUST be content-guarded: only
   * unlink if the file on disk still equals `expectedContents`, so a pidfile a racing
   * postmaster rewrote (a live lock) is never deleted.
   */
  removeStalePidfile(expectedContents: string): void;
  log?: { warn?(msg: string): void; info?(msg: string): void; error?(msg: string): void };
};

/**
 * Orchestrate the leftover-postmaster decision and its side effects, fail-closed.
 * Injected deps keep it fully unit-testable. Guarantees:
 *   - A pidfile is removed ONLY when we actually READ one (a stale/foreign/garbage file) and
 *     the datadir is confirmed free (`start-fresh`, or a `reclaim` whose kill succeeded), and
 *     the removal is content-guarded. A genuinely ABSENT pidfile (ENOENT → null contents) is
 *     never "removed" — that closes the read-absent-then-delete-a-racer's-new-lock TOCTOU.
 *   - `reclaim` whose kill FAILS, and every `abort`, THROW without removing the pidfile
 *     or starting — never risking a second postmaster on a live datadir.
 */
export async function resolveLeftoverPostmaster(
  deps: ResolveLeftoverPostmasterDeps,
): Promise<StartupPlan> {
  const contents = deps.readPidfileContents();
  const info = contents !== null ? parsePostmasterPidFile(contents) : null;
  const disposition = await reconcilePidfile(info, deps.dataDir, deps.probes);

  switch (disposition.action) {
    case "reuse":
      deps.log?.warn?.(
        `Embedded PostgreSQL already running for our data directory; reusing it (pid=${disposition.pid}, port=${disposition.port})`,
      );
      return { mode: "reuse", pid: disposition.pid, port: disposition.port };

    case "start-fresh":
      // Only remove a pidfile we actually read (stale/foreign/garbage). If it was absent
      // (contents === null), removing "whatever is there now" could delete a live lock a
      // concurrent starter just wrote — so leave it; a real collision fails start() loudly.
      if (contents !== null) {
        deps.removeStalePidfile(contents);
      }
      return { mode: "start" };

    case "reclaim": {
      deps.log?.warn?.(
        `Reclaiming orphaned embedded PostgreSQL still holding ${deps.dataDir} (pid=${disposition.pid}): ${disposition.reason}`,
      );
      const reclaimed = await deps.killPostmaster(disposition.pid);
      if (!reclaimed) {
        throw new Error(
          `Could not terminate orphaned embedded PostgreSQL (pid=${disposition.pid}) holding ${deps.dataDir}; ` +
            "refusing to start a second postmaster on the same data directory to avoid corruption. " +
            "Terminate that process manually and restart.",
        );
      }
      deps.log?.info?.(`Reclaimed embedded PostgreSQL data directory (terminated pid=${disposition.pid})`);
      // contents is non-null here (we parsed a pid from it).
      deps.removeStalePidfile(contents!);
      return { mode: "start" };
    }

    case "abort":
      throw new Error(
        `A live process (pid=${disposition.pid}) may hold the embedded PostgreSQL data directory ${deps.dataDir} ` +
          `and could not be verified or reclaimed; refusing to start to avoid data corruption. ${disposition.reason}`,
      );
  }
}
