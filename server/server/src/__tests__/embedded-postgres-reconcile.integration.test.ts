import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  getPostgresDataDirectory,
  prepareEmbeddedPostgresNativeRuntime,
} from "@paperclipai/db";
import {
  parsePostmasterPidFile,
  reconcilePidfile,
  classifyPidProcess,
  readProcessCommandLine,
} from "../embedded-postgres-reconcile.ts";

// Real-postgres integration coverage for the corruption-critical decision: mocks cannot
// prove that the live `ps` identity check + real reachability probe classify an actual
// running postmaster as reusable (and a stopped one as free). This starts a genuine
// embedded cluster in a temp datadir and drives reconcilePidfile with REAL probes.
// Serial by construction — server/server vitest runs maxWorkers:1 — and skipped where the
// embedded PostgreSQL binaries are unavailable.

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const support = await getEmbeddedPostgresTestSupport();
const describeIfSupported = support.supported ? describe : describe.skip;

describeIfSupported("embedded-postgres reconcile (real cluster)", () => {
  // Mirror production (index.ts): the SAME dataDir string is handed to EmbeddedPostgres and
  // used for classification, so the postmaster's verbatim `-D <dataDir>` argv matches. The
  // realpath-aware samePath is what reconciles PG's realpath'd data_directory report.
  let dataDir = "";
  let port = 0;
  let instance: EmbeddedPostgresInstance | null = null;

  const realProbes = () => ({
    isPidAlive: (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    probeDataDirectoryAtPort: (probePort: number) =>
      getPostgresDataDirectory(`postgres://superclaw:superclaw@127.0.0.1:${probePort}/postgres`).catch(
        () => null,
      ),
    classifyProcess: (pid: number, dir: string) => classifyPidProcess(readProcessCommandLine(pid), dir),
    samePath: (a: string, b: string) => {
      const canon = (p: string) => {
        try {
          return fs.realpathSync(p);
        } catch {
          return path.resolve(p);
        }
      };
      return canon(a) === canon(b);
    },
  });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "superclaw-pg-reclaim-it-"));
    port = await getFreePort();
    const mod = await import("embedded-postgres");
    await prepareEmbeddedPostgresNativeRuntime();
    const EmbeddedPostgres = mod.default as new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;
    instance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "superclaw",
      password: "superclaw",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {},
      onError: () => {},
    });
    await instance.initialise();
    await instance.start();
  }, 120_000);

  afterAll(async () => {
    await instance?.stop().catch(() => {});
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("classifies the live cluster as REUSE on its real port via real ps + reachability", async () => {
    const pidfilePath = path.join(dataDir, "postmaster.pid");
    const info = parsePostmasterPidFile(fs.readFileSync(pidfilePath, "utf8"));
    expect(info).not.toBeNull();
    expect(info?.port).toBe(port);

    // Sanity: the real ps-based identity check binds this pid to our datadir.
    expect(classifyPidProcess(readProcessCommandLine(info!.pid), dataDir)).toBe("ours");

    const disposition = await reconcilePidfile(info, dataDir, realProbes());
    expect(disposition).toMatchObject({ action: "reuse", pid: info!.pid, port });
  });

  it("decides RECLAIM for a real postmaster (real ps → 'ours') that is unreachable on its port", async () => {
    const pidfilePath = path.join(dataDir, "postmaster.pid");
    const info = parsePostmasterPidFile(fs.readFileSync(pidfilePath, "utf8"));
    // Real ps identity + real liveness, but simulate a wedged server by reporting the port
    // unreachable. A genuine running postmaster on our datadir must be reclaimed, not reused
    // and never deleted-as-stale — this exercises the real classifyProcess='ours' branch.
    const disposition = await reconcilePidfile(info, dataDir, {
      ...realProbes(),
      probeDataDirectoryAtPort: async () => null,
    });
    expect(disposition).toMatchObject({ action: "reclaim", pid: info!.pid });
  });

  it("classifies a stopped cluster as START-FRESH (pid dead → datadir free)", async () => {
    const pidfilePath = path.join(dataDir, "postmaster.pid");
    const info = parsePostmasterPidFile(fs.readFileSync(pidfilePath, "utf8"));
    await instance?.stop();
    instance = null;

    const disposition = await reconcilePidfile(info, dataDir, realProbes());
    expect(disposition.action).toBe("start-fresh");
  });
});
