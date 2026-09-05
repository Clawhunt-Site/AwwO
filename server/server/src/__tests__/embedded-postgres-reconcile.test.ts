import { describe, expect, it } from "vitest";
import {
  parsePostmasterPidFile,
  reconcilePidfile,
  classifyPidProcess,
  killPostmaster,
  resolveLeftoverPostmaster,
  isProcessAlive,
  readPostmasterPidFile,
  type ReconcileProbes,
  type ResolveLeftoverPostmasterDeps,
} from "../embedded-postgres-reconcile.ts";

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const DATA_DIR = "/home/user/.superclaw/node-runtime/instances/superclaw/db";
const OTHER_DIR = "/home/user/Desktop/other-project/db";

function pidfile(pid: number, dataDir: string, port: number | string): string {
  // Real postmaster.pid layout: pid, datadir, start-time, port, socket dir, ...
  return [String(pid), dataDir, "1700000000", String(port), "/tmp", "*", "     123456"].join("\n") + "\n";
}

function makeProbes(overrides: Partial<ReconcileProbes> = {}): ReconcileProbes {
  return {
    isPidAlive: () => true,
    probeDataDirectoryAtPort: async () => null,
    classifyProcess: () => "unknown",
    samePath: (a, b) => a === b,
    ...overrides,
  };
}

describe("parsePostmasterPidFile", () => {
  it("extracts pid, data directory, and port from a well-formed file", () => {
    expect(parsePostmasterPidFile(pidfile(4242, DATA_DIR, 54330))).toEqual({
      pid: 4242,
      dataDir: DATA_DIR,
      port: 54330,
    });
  });

  it("returns null when the pid line is missing or non-numeric", () => {
    expect(parsePostmasterPidFile("")).toBeNull();
    expect(parsePostmasterPidFile("not-a-pid\n" + DATA_DIR + "\n")).toBeNull();
    expect(parsePostmasterPidFile("0\n" + DATA_DIR + "\n")).toBeNull();
    expect(parsePostmasterPidFile("-5\n" + DATA_DIR + "\n")).toBeNull();
  });

  it("tolerates a missing/garbage port line (port=null) without dropping the pid", () => {
    expect(parsePostmasterPidFile(`4242\n${DATA_DIR}\n1700000000\n`)).toEqual({
      pid: 4242,
      dataDir: DATA_DIR,
      port: null,
    });
    expect(parsePostmasterPidFile(`4242\n${DATA_DIR}\n1700000000\nnope\n`)).toEqual({
      pid: 4242,
      dataDir: DATA_DIR,
      port: null,
    });
  });
});

describe("classifyPidProcess", () => {
  it("is 'ours' for a postgres executable running -D <ourDataDir> (separate token)", () => {
    expect(classifyPidProcess(`/opt/pg/bin/postgres -D ${DATA_DIR} -p 54330`, DATA_DIR)).toBe("ours");
  });

  it("is 'ours' for the -D<dir> joined form and the postmaster alias", () => {
    expect(classifyPidProcess(`/opt/pg/bin/postgres -D${DATA_DIR}`, DATA_DIR)).toBe("ours");
    expect(classifyPidProcess(`postmaster -D ${DATA_DIR}`, DATA_DIR)).toBe("ours");
  });

  it("is 'unknown' for a postgres NOT bound to our datadir (never risk deleting its lock)", () => {
    expect(classifyPidProcess(`/opt/pg/bin/postgres -D ${OTHER_DIR} -p 5432`, DATA_DIR)).toBe("unknown");
  });

  it("is 'unknown' when the command line is empty (ps unavailable / Windows)", () => {
    expect(classifyPidProcess("", DATA_DIR)).toBe("unknown");
    expect(classifyPidProcess("   ", DATA_DIR)).toBe("unknown");
  });

  it("is 'foreign' for a non-postgres process even if it merely mentions the datadir path", () => {
    // The critical anti-misfire case: substring match must NOT flag these as postgres.
    expect(classifyPidProcess(`tail -f ${DATA_DIR}/log/postgresql.log`, DATA_DIR)).toBe("foreign");
    expect(classifyPidProcess(`grep -r foo ${DATA_DIR}`, DATA_DIR)).toBe("foreign");
    expect(classifyPidProcess(`/usr/bin/node db-backup.js ${DATA_DIR}`, DATA_DIR)).toBe("foreign");
    expect(classifyPidProcess(`vim ${DATA_DIR}/postgresql.conf`, DATA_DIR)).toBe("foreign");
  });

  it("does not treat a -D that resolves elsewhere as ours", () => {
    expect(classifyPidProcess(`postgres -D ${DATA_DIR}-sibling`, DATA_DIR)).toBe("unknown");
  });

  it("degrades to 'unknown' (never 'foreign') when a space in the binary path breaks token[0]", () => {
    // ps: `/Applications/My App/bin/postgres -D <ourDataDir>` → token[0] = "/Applications/My".
    // The exe check fails, but `-D <ourDataDir>` is present, so it must NOT be deletable-foreign.
    const cmd = `/Applications/My App/bin/postgres -D ${DATA_DIR} -p 54330`;
    expect(classifyPidProcess(cmd, DATA_DIR)).toBe("unknown");
  });

  it("degrades to 'unknown' when a space in the DATADIR breaks the -D token alignment", () => {
    const spacedDir = "/home/user/My Data/db";
    const cmd = `/opt/pg/bin/postgres -D ${spacedDir} -p 54330`;
    // The -D token no longer aligns, but it is still a postgres exe → unknown, never foreign.
    expect(classifyPidProcess(cmd, spacedDir)).toBe("unknown");
  });

  it("degrades to 'unknown' when BOTH the binary path AND the datadir contain spaces", () => {
    // token[0] parsing breaks AND -D alignment breaks, but the raw command still shows
    // "/postgres" and a -D flag → must not be the deletable 'foreign', must be 'unknown'.
    const spacedDir = "/Users/me/My Data/db";
    const cmd = `/Applications/My App/bin/postgres -D ${spacedDir} -p 54330`;
    expect(classifyPidProcess(cmd, spacedDir)).toBe("unknown");
  });

  it("does NOT over-trigger on a JVM-style -Dprop (no space/slash after -D → not a postgres -D)", () => {
    // The -D hint requires a postgres-shaped boundary (`-D /path` or `-D/path`); `-Dfoo=bar`
    // is a JVM system property, so a recycled JVM process is correctly 'foreign' (datadir free).
    expect(classifyPidProcess("java -Dfoo=bar -jar app.jar", DATA_DIR)).toBe("foreign");
  });
});

describe("isProcessAlive", () => {
  it("is alive when kill(pid, 0) succeeds", () => {
    expect(isProcessAlive(4242, () => {})).toBe(true);
  });

  it("is dead ONLY for ESRCH (no such process)", () => {
    expect(
      isProcessAlive(4242, () => {
        throw errno("ESRCH");
      }),
    ).toBe(false);
  });

  it("counts EPERM (exists, not permitted to signal) as ALIVE", () => {
    expect(
      isProcessAlive(4242, () => {
        throw errno("EPERM");
      }),
    ).toBe(true);
  });

  it("counts any other error as alive (conservative)", () => {
    expect(
      isProcessAlive(4242, () => {
        throw errno("EINVAL");
      }),
    ).toBe(true);
  });
});

describe("readPostmasterPidFile", () => {
  it("returns the file contents when readable", () => {
    const contents = pidfile(4242, DATA_DIR, 54330);
    expect(readPostmasterPidFile("/x/postmaster.pid", { readFile: () => contents })).toBe(contents);
  });

  it("returns null ONLY when the file is genuinely absent (ENOENT)", () => {
    expect(
      readPostmasterPidFile("/x/postmaster.pid", {
        readFile: () => {
          throw errno("ENOENT");
        },
      }),
    ).toBeNull();
  });

  it("THROWS on a present-but-unreadable file (EACCES) rather than reporting absent", () => {
    expect(() =>
      readPostmasterPidFile("/x/postmaster.pid", {
        readFile: () => {
          throw errno("EACCES");
        },
      }),
    ).toThrow(/could not be read/);
  });
});

describe("reconcilePidfile", () => {
  it("starts fresh when there is no pidfile", async () => {
    expect((await reconcilePidfile(null, DATA_DIR, makeProbes())).action).toBe("start-fresh");
  });

  it("starts fresh when the recorded pid is not alive (stale file)", async () => {
    const info = parsePostmasterPidFile(pidfile(4242, DATA_DIR, 54330));
    const d = await reconcilePidfile(info, DATA_DIR, makeProbes({ isPidAlive: () => false }));
    expect(d.action).toBe("start-fresh");
    expect(d.reason).toMatch(/not alive/);
  });

  it("reuses a reachable server for our datadir on its RECORDED port, not the configured one", async () => {
    const info = parsePostmasterPidFile(pidfile(4242, DATA_DIR, 54330)); // fell back to 54330 last run
    let probedPort = -1;
    const d = await reconcilePidfile(
      info,
      DATA_DIR,
      makeProbes({
        probeDataDirectoryAtPort: async (port) => {
          probedPort = port;
          return DATA_DIR;
        },
      }),
    );
    expect(probedPort).toBe(54330);
    expect(d).toMatchObject({ action: "reuse", pid: 4242, port: 54330 });
  });

  it("reclaims an alive-but-unreachable postmaster confirmed to own our datadir", async () => {
    const info = parsePostmasterPidFile(pidfile(4242, DATA_DIR, 54330));
    const d = await reconcilePidfile(
      info,
      DATA_DIR,
      makeProbes({
        probeDataDirectoryAtPort: async () => null, // wedged: won't accept/answer connections
        classifyProcess: () => "ours",
      }),
    );
    expect(d).toMatchObject({ action: "reclaim", pid: 4242 });
  });

  it("starts fresh (datadir free) when the pid was recycled to a confirmed non-postgres process", async () => {
    const info = parsePostmasterPidFile(pidfile(4242, DATA_DIR, 54330));
    const d = await reconcilePidfile(
      info,
      DATA_DIR,
      makeProbes({ probeDataDirectoryAtPort: async () => null, classifyProcess: () => "foreign" }),
    );
    expect(d.action).toBe("start-fresh");
    expect(d.reason).toMatch(/recycled/);
  });

  it("ABORTS (never deletes) when a live pid cannot be confirmed as ours or foreign", async () => {
    const info = parsePostmasterPidFile(pidfile(4242, DATA_DIR, 54330));
    const d = await reconcilePidfile(
      info,
      DATA_DIR,
      makeProbes({ probeDataDirectoryAtPort: async () => null, classifyProcess: () => "unknown" }),
    );
    expect(d).toMatchObject({ action: "abort", pid: 4242 });
  });

  it("reclaims when the port is unparseable but the process is confirmed ours", async () => {
    const info = parsePostmasterPidFile(pidfile(4242, DATA_DIR, "garbage"));
    expect(info?.port).toBeNull();
    const d = await reconcilePidfile(
      info,
      DATA_DIR,
      makeProbes({
        probeDataDirectoryAtPort: async () => {
          throw new Error("must not probe when no port is known");
        },
        classifyProcess: () => "ours",
      }),
    );
    expect(d).toMatchObject({ action: "reclaim", pid: 4242 });
  });

  it("does not reuse when the reachable server reports a different datadir", async () => {
    const info = parsePostmasterPidFile(pidfile(4242, DATA_DIR, 54330));
    const d = await reconcilePidfile(
      info,
      DATA_DIR,
      makeProbes({ probeDataDirectoryAtPort: async () => OTHER_DIR, classifyProcess: () => "unknown" }),
    );
    expect(d.action).toBe("abort");
  });
});

// The corruption-safety invariants live in the orchestration: the pidfile is removed
// ONLY when the datadir is provably free, and a live lock we cannot clear aborts startup.
describe("resolveLeftoverPostmaster (caller side effects)", () => {
  function makeDeps(
    disposition: "reuse" | "start-fresh" | "reclaim" | "abort",
    overrides: Partial<ResolveLeftoverPostmasterDeps> & { killResult?: boolean } = {},
  ): { deps: ResolveLeftoverPostmasterDeps; state: { removed: boolean; killed: number | null } } {
    const state = { removed: false, killed: null as number | null };
    const probeByDisposition: Record<string, Partial<ReconcileProbes>> = {
      reuse: { probeDataDirectoryAtPort: async () => DATA_DIR },
      "start-fresh": { isPidAlive: () => false },
      reclaim: { probeDataDirectoryAtPort: async () => null, classifyProcess: () => "ours" },
      abort: { probeDataDirectoryAtPort: async () => null, classifyProcess: () => "unknown" },
    };
    const deps: ResolveLeftoverPostmasterDeps = {
      dataDir: DATA_DIR,
      readPidfileContents: () => pidfile(4242, DATA_DIR, 54330),
      probes: makeProbes(probeByDisposition[disposition]),
      killPostmaster: async (pid) => {
        state.killed = pid;
        return overrides.killResult ?? true;
      },
      removeStalePidfile: () => {
        state.removed = true;
      },
      ...overrides,
    };
    return { deps, state };
  }

  it("reuse: adopts the running server, never removes the lock", async () => {
    const { deps, state } = makeDeps("reuse");
    const plan = await resolveLeftoverPostmaster(deps);
    expect(plan).toMatchObject({ mode: "reuse", pid: 4242, port: 54330 });
    expect(state.removed).toBe(false);
    expect(state.killed).toBeNull();
  });

  it("start-fresh: removes the stale lock and starts", async () => {
    const { deps, state } = makeDeps("start-fresh");
    const plan = await resolveLeftoverPostmaster(deps);
    expect(plan).toEqual({ mode: "start" });
    expect(state.removed).toBe(true);
  });

  it("reclaim + kill success: kills, then removes the lock, then starts", async () => {
    const { deps, state } = makeDeps("reclaim", { killResult: true });
    const plan = await resolveLeftoverPostmaster(deps);
    expect(plan).toEqual({ mode: "start" });
    expect(state.killed).toBe(4242);
    expect(state.removed).toBe(true);
  });

  it("reclaim + kill FAILURE: throws and leaves the lock intact (no corruption)", async () => {
    const { deps, state } = makeDeps("reclaim", { killResult: false });
    await expect(resolveLeftoverPostmaster(deps)).rejects.toThrow(/Could not terminate/);
    expect(state.killed).toBe(4242);
    expect(state.removed).toBe(false);
  });

  it("abort: throws, never kills, never removes the lock", async () => {
    const { deps, state } = makeDeps("abort");
    await expect(resolveLeftoverPostmaster(deps)).rejects.toThrow(/refusing to start/);
    expect(state.killed).toBeNull();
    expect(state.removed).toBe(false);
  });

  it("start-fresh from a stale file we READ removes exactly that file", async () => {
    const { deps, state } = makeDeps("start-fresh");
    const plan = await resolveLeftoverPostmaster(deps);
    expect(plan).toEqual({ mode: "start" });
    expect(state.removed).toBe(true);
  });

  it("a genuinely ABSENT pidfile (null contents) starts WITHOUT deleting anything (TOCTOU-safe)", async () => {
    // ENOENT read → we must not remove "whatever is there now" (a racer may have written a
    // live lock in the gap). removeStalePidfile must not be called.
    const removeCalls: string[] = [];
    const { deps } = makeDeps("start-fresh", { readPidfileContents: () => null });
    deps.removeStalePidfile = (contents) => removeCalls.push(contents);
    const plan = await resolveLeftoverPostmaster(deps);
    expect(plan).toEqual({ mode: "start" });
    expect(removeCalls).toEqual([]);
  });

  it("passes the exact contents it read to removeStalePidfile (content-guarded removal)", async () => {
    const contents = pidfile(4242, DATA_DIR, 54330);
    const removeCalls: string[] = [];
    const { deps } = makeDeps("start-fresh", { readPidfileContents: () => contents });
    // classify as stale via a dead pid so the read file is treated as removable.
    deps.probes = makeProbes({ isPidAlive: () => false });
    deps.removeStalePidfile = (c) => removeCalls.push(c);
    await resolveLeftoverPostmaster(deps);
    expect(removeCalls).toEqual([contents]);
  });
});

describe("killPostmaster", () => {
  it("returns immediately when the pid is already gone", async () => {
    const signals: string[] = [];
    const ok = await killPostmaster(999, {
      isPidAlive: () => false,
      kill: (_pid, s) => signals.push(s),
      sleep: async () => {},
    });
    expect(ok).toBe(true);
    expect(signals).toEqual([]);
  });

  it("stops after a graceful SIGTERM exit without escalating to SIGKILL", async () => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const ok = await killPostmaster(
      4242,
      {
        isPidAlive: () => alive,
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGTERM") alive = false;
        },
        sleep: async () => {},
      },
      { termGraceMs: 1000, pollMs: 100 },
    );
    expect(ok).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const ok = await killPostmaster(
      4242,
      {
        isPidAlive: () => alive,
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") alive = false;
        },
        sleep: async () => {},
      },
      { termGraceMs: 400, killGraceMs: 400, pollMs: 100 },
    );
    expect(ok).toBe(true);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });

  it("reports failure when the process survives even SIGKILL", async () => {
    const ok = await killPostmaster(
      4242,
      { isPidAlive: () => true, kill: () => {}, sleep: async () => {} },
      { termGraceMs: 200, killGraceMs: 200, pollMs: 100 },
    );
    expect(ok).toBe(false);
  });
});
