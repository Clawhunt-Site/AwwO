/// <reference path="./types/express.d.ts" />
// Kicks off the OTel bootstrap as early as possible (no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set). startServer() awaits
// instrumentationReady before opening DB connections or constructing the
// HTTP server, so trace coverage does not depend on incidental timing.
import { instrumentationReady, shutdownInstrumentation } from "./instrumentation.js";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  openPgliteDb,
  runPgliteDatabaseBackup,
  type PgliteHandle,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  createEmbeddedPostgresLogBuffer,
  prepareEmbeddedPostgresNativeRuntime,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
  type Db,
} from "@paperclipai/db";
import detectPort from "detect-port";
import {
  resolveLeftoverPostmaster,
  killPostmaster,
  classifyPidProcess,
  readProcessCommandLine,
  isProcessAlive,
  readPostmasterPidFile,
} from "./embedded-postgres-reconcile.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadAndScrubReceiptKeyFilePath } from "./services/workshop-receipt.js";
import { getServerInfoSnapshot } from "./server-info.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  backfillPrincipalAccessCompatibility,
  bootstrapExecutionPolicyFromEnv,
  heartbeatService,
  instanceSettingsService,
  reconcileCloudUpstreamRunsOnStartup,
  reconcileCodexLocalManagedHomesOnStartup,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
} from "./services/index.js";
import {
  parseAdapterRegistryEnv,
  reconcileAdapterAvailability,
} from "./services/adapter-registry-bootstrap.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { buildRuntimeApiCandidateUrls, choosePrimaryRuntimeApiUrl } from "./runtime-api.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { conflict } from "./errors.js";
import type {
  InstanceDatabaseBackupRunResult,
  InstanceDatabaseBackupTrigger,
} from "./routes/instance-database-backups.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  // Tracing must be active (or have failed and logged) before the first DB
  // connection or the HTTP server exists — see instrumentation.ts.
  await instrumentationReady;
  // Read the workshop-receipt key into a private pin and SCRUB its file-path env var BEFORE any
  // DB/service/agent/plugin subprocess can spawn — so no descendant is handed the path. (The key
  // VALUE is never in env; this removes the path too.) Earliest safe point.
  loadAndScrubReceiptKeyFilePath();
  // Warm the server-info git snapshot now — AFTER the scrub (so its `git` child never inherits the
  // key path) but at BOOT (so the snapshot reflects the running process's checkout, not whatever
  // HEAD happens to be at the first health request). It is memoized thereafter.
  getServerInfoSnapshot();
  let config = loadConfig();
  initTelemetry({ enabled: config.telemetryEnabled });
  if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
    process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.PAPERCLIP_SECRETS_STRICT_MODE === undefined) {
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") return true;
    if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return false;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }

  function isPostgresConnectionString(connectionString: string): boolean {
    try {
      const parsed = new URL(connectionString);
      return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
    } catch {
      return false;
    }
  }

  function assertCloudDatabaseContract(): void {
    if (config.deploymentMode !== "authenticated" || config.deploymentExposure !== "public") {
      return;
    }
    if (!config.databaseUrl) {
      throw new Error(
        "authenticated public deployments require DATABASE_URL or config.database.connectionString; refusing embedded PostgreSQL fallback",
      );
    }
    if (!isPostgresConnectionString(config.databaseUrl)) {
      throw new Error(
        "authenticated public deployments require DATABASE_URL to be a postgres/postgresql connection string",
      );
    }
  }

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      // The URL API normalizes default ports like :80/:443 to "", so treat them as stable URLs.
      if (!parsed.port) return rawUrl;
      parsed.port = String(port);
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db;
  let pluginMigrationDb;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  // PGlite arm: live handle for the in-process database — the shutdown hook closes it
  // (the pglite analog of embeddedPostgres.stop()) and the backup runner dumps it.
  let pgliteHandle: PgliteHandle | null = null;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number }
    | { mode: "pglite"; dataDir: string };
  assertCloudDatabaseContract();
  if (config.databaseUrl) {
    const migrationUrl = config.databaseMigrationUrl ?? config.databaseUrl;
    migrationSummary = await ensureMigrations(migrationUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    pluginMigrationDb = config.databaseMigrationUrl ? createDb(config.databaseMigrationUrl) : db;
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else if (process.env.SUPERCLAW_DESKTOP_PGLITE === "1" || process.env.SUPERCLAW_DESKTOP_PGLITE === "true") {
    // PGlite arm (desktop dark launch): in-process WASM Postgres — no child postmaster,
    // no TCP port, no postmaster.pid, so the orphaned-cluster failure class behind the
    // desktop's recurring 503s cannot occur. Uses its OWN datadir beside the embedded
    // cluster ("<db>-pglite") so a legacy real-PG cluster is never touched; migrations
    // run through drizzle's official pglite migrator over the same migration folder
    // (feasibility proven empirically — docs/pglite-feasibility.md at the repo root).
    const dataDir = `${resolve(config.embeddedPostgresDataDir)}-pglite`;
    const handle = await openPgliteDb(dataDir);
    migrationSummary =
      handle.appliedMigrations === 0
        ? "already applied"
        : handle.hadMigrationHistory
          ? "applied (pending migrations)"
          : "applied (empty database)";
    // Downstream services type against Db (the postgres-js drizzle instance). The
    // pglite drizzle instance exposes the same PgDatabase query surface; postgres.js
    // escape hatches never flow through THIS object — they build their own
    // connections from activeDatabaseConnectionString, which is guarded for pglite
    // (see runServerDatabaseBackup).
    db = handle.db as unknown as Db;
    pluginMigrationDb = db;
    pgliteHandle = handle;
    logger.info({ dataDir }, "Using PGlite (in-process Postgres) because SUPERCLAW_DESKTOP_PGLITE is set");
    activeDatabaseConnectionString = `pglite:${dataDir}`;
    startupDbInfo = { mode: "pglite", dataDir };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
    await prepareEmbeddedPostgresNativeRuntime();
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const logBuffer = createEmbeddedPostgresLogBuffer(120);
    const verboseEmbeddedPostgresLogs = process.env.PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      logBuffer.append(message);
      if (!verboseEmbeddedPostgresLogs) {
        return;
      }
      const lines = typeof message === "string"
        ? message.split(/\r?\n/)
        : message instanceof Error
          ? [message.message]
          : [String(message ?? "")];
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      const recentLogs = logBuffer.getRecentLogs();
      if (recentLogs.length > 0) {
        logger.error(
          {
            phase,
            recentLogs,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    // ESRCH => truly gone; EPERM (exists under another owner) and anything else => alive.
    const isPidRunning = (pid: number): boolean => isProcessAlive(pid);
    // A live-but-hung postmaster can accept a TCP connection yet never answer, so EVERY
    // data_directory probe on the startup path is bounded by a hard timeout; a timeout is
    // treated as unreachable so the decision falls through instead of hanging startup.
    const probeDataDirectory = (probePort: number): Promise<string | null> =>
      Promise.race([
        getPostgresDataDirectory(`postgres://paperclip:paperclip@127.0.0.1:${probePort}/postgres`).catch(
          () => null,
        ),
        new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), 1_500)),
      ]);

    // Reconcile any leftover postmaster.pid before deciding to reuse or start, fail-CLOSED.
    // A healthy embedded server for OUR datadir is reused on ITS recorded port; an
    // orphaned/wedged postmaster that still holds our datadir is reclaimed (killed) and only
    // THEN is the stale lock removed. Every ambiguous case (a live pid we cannot confirm as
    // ours-or-foreign, a kill that fails) aborts startup with the lock left intact — never
    // deleting a live lock, which would let a second postmaster corrupt the data directory.
    // The previous bare kill(pid, 0) reuse trusted a live pid on the configured port, which
    // broke on recycled PIDs and after a prior port fallback — leaving the server unable to
    // start when the desktop app was closed and reopened too fast.
    //
    // Compare PostgreSQL-reported data_directory paths symlink-aware: PG realpath's its
    // datadir, so a plain resolve() would mismatch a datadir reached through a symlink
    // (e.g. macOS /tmp -> /private/tmp) and mis-route the decision.
    const canonicalPath = (candidate: string): string => {
      try {
        return realpathSync(candidate);
      } catch {
        return resolve(candidate);
      }
    };
    const startupPlan = await resolveLeftoverPostmaster({
      dataDir,
      // ENOENT (genuinely absent) => null => datadir may be treated as free; a file that
      // EXISTS but can't be read (permission, transient IO) THROWS inside here, aborting
      // startup rather than letting an unreadable-but-present lock be silently deleted.
      // Reading directly (no existsSync pre-check) also closes the TOCTOU window.
      readPidfileContents: () =>
        readPostmasterPidFile(postmasterPidFile, { readFile: (path) => readFileSync(path, "utf8") }),
      probes: {
        isPidAlive: isPidRunning,
        probeDataDirectoryAtPort: probeDataDirectory,
        classifyProcess: (pid, dir) => classifyPidProcess(readProcessCommandLine(pid), dir),
        samePath: (a, b) => canonicalPath(a) === canonicalPath(b),
      },
      killPostmaster: (pid) =>
        killPostmaster(pid, {
          isPidAlive: isPidRunning,
          kill: (targetPid, signal) => process.kill(targetPid, signal),
          sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
        }),
      // Content-guarded removal of the exact stale pidfile we read: re-read and only unlink
      // if the bytes still match, so a pidfile a racing postmaster rewrote (a live lock) is
      // never deleted. Reached only once the datadir is confirmed free (start-fresh, or
      // reclaim after a successful kill).
      removeStalePidfile: (expectedContents) => {
        let current: string;
        try {
          current = readFileSync(postmasterPidFile, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
            logger.warn(
              "Could not re-read postmaster.pid to verify before removal; leaving it in place",
            );
          }
          return; // already gone, or unreadable — do not delete blindly
        }
        if (current === expectedContents) {
          logger.warn("Removing stale embedded PostgreSQL lock file (data directory confirmed free)");
          rmSync(postmasterPidFile, { force: true });
        } else {
          logger.warn(
            "postmaster.pid changed since reconciliation; leaving it in place to avoid deleting a live lock",
          );
        }
      },
      log: {
        warn: (message) => logger.warn(message),
        info: (message) => logger.info(message),
        error: (message) => logger.error(message),
      },
    });

    let reusedRunningServer = false;
    if (startupPlan.mode === "reuse") {
      // Adopt the running server on the port IT actually listens on (recorded in the
      // pidfile), which may differ from the configured port after a prior fallback.
      port = startupPlan.port;
      reusedRunningServer = true;
    }

    if (!reusedRunningServer) {
      const configuredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${configuredPort}/postgres`;
      try {
        // Bounded by the same hard timeout (a wedged server on the configured port must not
        // hang startup), and compared symlink-aware since PG reports its realpath'd datadir.
        const actualDataDir = await probeDataDirectory(configuredPort);
        if (typeof actualDataDir !== "string" || canonicalPath(actualDataDir) !== canonicalPath(dataDir)) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "paperclip");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "paperclip",
          password: "paperclip",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw formatEmbeddedPostgresError(err, {
              fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
              recentLogs: logBuffer.getRecentLogs(),
            });
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        // The stale lock (if any) was already removed by resolveLeftoverPostmaster once it
        // confirmed the data directory is free — a live lock would have aborted startup
        // above, so there is nothing unsafe left to clear here.
        try {
          await embeddedPostgres.start();
        } catch (err) {
          logEmbeddedPostgresFailure("start", err);
          throw formatEmbeddedPostgresError(err, {
            fallbackMessage: `Failed to start embedded PostgreSQL on port ${port}`,
            recentLogs: logBuffer.getRecentLogs(),
          });
        }
        embeddedPostgresStartedByThisProcess = true;
      }
    }
  
    const embeddedAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "paperclip");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: paperclip");
    }
  
    const embeddedConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
    pluginMigrationDb = db;
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    resolvedEmbeddedPostgresPort = port;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }
  
  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }

  const requestedListenPort = config.port;
  const listenPort = await detectPort(requestedListenPort);
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  const accessBackfill = await backfillPrincipalAccessCompatibility(db as any);
  if (accessBackfill.agentMembershipsInserted > 0 || accessBackfill.humanGrantsInserted > 0) {
    logger.info(accessBackfill, "Backfilled principal access compatibility records");
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config, { listenPort });
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }

  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  maybePersistWorktreeRuntimePorts({
    serverPort: listenPort,
    databasePort: resolvedEmbeddedPostgresPort,
  });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
  });
  const backupSettingsSvc = instanceSettingsService(db);
  let databaseBackupInFlight = false;
  const runServerDatabaseBackup = async (
    trigger: InstanceDatabaseBackupTrigger,
  ): Promise<InstanceDatabaseBackupRunResult | null> => {
    if (databaseBackupInFlight) {
      const message = "Database backup already in progress";
      if (trigger === "scheduled") {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return null;
      }
      throw conflict(message);
    }

    databaseBackupInFlight = true;
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const label = trigger === "scheduled" ? "Automatic" : "Manual";
    try {
      logger.info({ backupDir: config.databaseBackupDir, trigger }, `${label} database backup starting`);
      // Read retention from Instance Settings (DB) so changes take effect without restart.
      const generalSettings = await backupSettingsSvc.getGeneral();
      const retention = generalSettings.backupRetention;

      // pglite mode has no server for pg_dump / COPY streaming — its backup is the
      // datadir tarball (same tiered retention, distinct prefix + .tar.gz extension).
      const result = pgliteHandle
        ? await runPgliteDatabaseBackup({
            handle: pgliteHandle,
            backupDir: config.databaseBackupDir,
            retention,
            filenamePrefix: "paperclip-pglite",
          })
        : await runDatabaseBackup({
            connectionString: activeDatabaseConnectionString,
            backupDir: config.databaseBackupDir,
            retention,
            filenamePrefix: "paperclip",
          });
      const finishedAt = new Date();
      const response: InstanceDatabaseBackupRunResult = {
        ...result,
        trigger,
        backupDir: config.databaseBackupDir,
        retention,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedAtMs,
      };
      logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: config.databaseBackupDir,
          retention,
          trigger,
          durationMs: response.durationMs,
        },
        `${label} database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
      return response;
    } catch (err) {
      logger.error({ err, backupDir: config.databaseBackupDir, trigger }, `${label} database backup failed`);
      throw err;
    } finally {
      databaseBackupInFlight = false;
    }
  };
  const pluginWorkerManager = createPluginWorkerManager();
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    databaseBackupService: {
      runManualBackup: async () => {
        const result = await runServerDatabaseBackup("manual");
        if (!result) {
          throw conflict("Database backup already in progress");
        }
        return result;
      },
    },
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  
  if (listenPort !== requestedListenPort) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${requestedListenPort}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiUrl = choosePrimaryRuntimeApiUrl({
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  const configuredApiUrl = (process.env.SUPERCLAW_API_URL?.trim() || process.env.PAPERCLIP_API_URL?.trim()) || runtimeApiUrl;
  const runtimeApiCandidates = buildRuntimeApiCandidateUrls({
    preferredApiUrl: configuredApiUrl,
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_RUNTIME_API_URL = runtimeApiUrl;
  process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify(runtimeApiCandidates);
  process.env.PAPERCLIP_API_URL = configuredApiUrl;
  process.env.SUPERCLAW_API_URL = configuredApiUrl;
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });

  void reconcileCloudUpstreamRunsOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled cloud upstream runs from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of cloud upstream runs failed");
    });

  // Backfill auth.json into any already-isolated codex_local managed home that
  // was created by the #8272 isolation guard before the Phase 1 seeding fix.
  // Idempotent; the Phase 1 execute-time seeding covers new strandings.
  void reconcileCodexLocalManagedHomesOnStartup(db)
    .then((result) => {
      if (result.seeded > 0 || result.failed > 0) {
        logger.warn(
          { seeded: result.seeded, failed: result.failed, scanned: result.scanned },
          "reconciled codex_local managed homes (backfilled missing auth)",
        );
      }
      if (result.sourceAuthMissing > 0) {
        logger.warn(
          { sourceAuthMissing: result.sourceAuthMissing, scanned: result.scanned },
          "could not backfill codex_local managed homes because shared Codex auth is missing",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of codex_local managed homes failed");
    });

  // Force the instance onto the Kubernetes sandbox provider when configured via
  // env (PAPERCLIP_EXECUTION_MODE=kubernetes). Runs BEFORE the heartbeat resumes
  // queued runs so the policy + managed k8s environments are in place. A bad
  // PAPERCLIP_EXECUTION_MODE / PAPERCLIP_K8S_* value throws and fails startup
  // (fail-loud) rather than silently allowing local execution.
  try {
    const policyResult = await bootstrapExecutionPolicyFromEnv(db as any);
    if (policyResult) {
      logger.warn(
        {
          executionMode: policyResult.executionMode,
          companiesConfigured: policyResult.companiesConfigured,
        },
        "forced execution policy applied at startup",
      );
    }
  } catch (err) {
    logger.error({ err }, "failed to apply forced execution policy from environment");
    throw err;
  }

  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any, { pluginWorkerManager });
    const routines = routineService(db as any, { pluginWorkerManager });

    // Reap orphaned runs before timer ticks start so wakeups cannot coalesce
    // into a dead "running" row during startup recovery.
    await (async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await heartbeat.reapOrphanedRuns();
          logger.info(
            { reaped: result.reaped, runIds: result.runIds },
            "startup reap of orphaned heartbeat runs complete",
          );
          break;
        } catch (err) {
          if (attempt < 2) {
            logger.warn({ err, attempt }, "startup reap failed, retrying");
          } else {
            logger.error(
              { err },
              "startup reap of orphaned heartbeat runs failed after retry — periodic reaper will serve as degraded backstop",
            );
          }
        }
      }

      const promotion = await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
      const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
      if (
        promotion.promoted > 0 ||
        reconciled.assignmentDispatched > 0 ||
        reconciled.dispatchRequeued > 0 ||
        reconciled.continuationRequeued > 0 ||
        reconciled.successfulRunHandoffEscalated > 0 ||
        reconciled.escalated > 0
      ) {
        logger.warn(
          { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
          "startup heartbeat recovery changed assigned issue state",
        );
      }

      const issueGraphReconciled = await heartbeat.reconcileIssueGraphLiveness();
      if (issueGraphReconciled.escalationsCreated > 0) {
        logger.warn(
          { ...issueGraphReconciled },
          "startup issue-graph liveness reconciliation created escalations",
        );
      }

      const taskWatchdogsReconciled = await heartbeat.reconcileTaskWatchdogs();
      if (taskWatchdogsReconciled.triggered > 0) {
        logger.warn(
          { ...taskWatchdogsReconciled },
          "startup task-watchdog reconciliation triggered watchdog work",
        );
      }

      const scanned = await heartbeat.scanSilentActiveRuns();
      if (scanned.created > 0 || scanned.escalated > 0) {
        logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
      }

      const swept = await heartbeat.sweepStaleIssueLocks();
      if (swept.cleared > 0) {
        logger.warn({ ...swept }, "startup stale-lock sweeper cleared issue locks");
      }

      const reviewed = await heartbeat.reconcileProductivityReviews();
      if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
        logger.warn({ ...reviewed }, "startup productivity reconciliation created or updated review work");
      }
    })().catch((err) => {
      logger.error({ err }, "startup heartbeat recovery failed");
    });

    setInterval(() => {
      const sweptRuntimeStatuses = heartbeat.sweepExpiredRuntimeStatuses();
      if (sweptRuntimeStatuses > 0) {
        logger.info(
          { swept: sweptRuntimeStatuses },
          "heartbeat runtime-status sweeper cleared expired entries",
        );
      }

      void heartbeat
        .tickTimers(new Date())
        .then((result) => {
          if (result.enqueued > 0) {
            logger.info({ ...result }, "heartbeat timer tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "heartbeat timer tick failed");
        });

      void routines
        .tickScheduledTriggers(new Date())
        .then((result) => {
          if (result.triggered > 0) {
            logger.info({ ...result }, "routine scheduler tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "routine scheduler tick failed");
        });
  
      // Periodically reap orphaned runs (5-min staleness threshold) and make sure
      // persisted queued work is still being driven forward.
      void heartbeat
        .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
        .then(() => heartbeat.promoteDueScheduledRetries())
        .then(async (promotion) => {
          await heartbeat.resumeQueuedRuns();
          const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
          if (
            promotion.promoted > 0 ||
            reconciled.assignmentDispatched > 0 ||
            reconciled.dispatchRequeued > 0 ||
            reconciled.continuationRequeued > 0 ||
            reconciled.successfulRunHandoffEscalated > 0 ||
            reconciled.escalated > 0
          ) {
            logger.warn(
              { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
              "periodic heartbeat recovery changed assigned issue state",
            );
          }
        })
        .then(async () => {
          const reconciled = await heartbeat.reconcileIssueGraphLiveness();
          if (reconciled.escalationsCreated > 0) {
            logger.warn({ ...reconciled }, "periodic issue-graph liveness reconciliation created escalations");
          }
        })
        .then(async () => {
          const reconciled = await heartbeat.reconcileTaskWatchdogs();
          if (reconciled.triggered > 0) {
            logger.warn({ ...reconciled }, "periodic task-watchdog reconciliation triggered watchdog work");
          }
        })
        .then(async () => {
          const scanned = await heartbeat.scanSilentActiveRuns();
          if (scanned.created > 0 || scanned.escalated > 0) {
            logger.warn({ ...scanned }, "periodic active-run output watchdog created review work");
          }
        })
        .then(async () => {
          const swept = await heartbeat.sweepStaleIssueLocks();
          if (swept.cleared > 0) {
            logger.warn({ ...swept }, "periodic stale-lock sweeper cleared issue locks");
          }
        })
        .then(async () => {
          const reviewed = await heartbeat.reconcileProductivityReviews();
          if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
            logger.warn({ ...reviewed }, "periodic productivity reconciliation created or updated review work");
          }
        })
        .catch((err) => {
          logger.error({ err }, "periodic heartbeat recovery failed");
        });
    }, config.heartbeatSchedulerIntervalMs);
  }
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionSource: "instance-settings-db",
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    setInterval(() => {
      void runServerDatabaseBackup("scheduled").catch(() => {
        // runServerDatabaseBackup already logs the failure with context.
      });
    }, backupIntervalMs);
  }
  
  // Wait for external adapters to finish loading before accepting requests.
  // Without this, adapter type validation (assertKnownAdapterType) would
  // reject valid external adapter types during the startup loading window.
  const { waitForExternalAdapters } = await import("./adapters/registry.js");
  await waitForExternalAdapters();

  // Reconcile the agent-creation picker to the declaratively-configured adapter
  // set (PAPERCLIP_ADAPTERS). Must run after external adapters are loaded so the
  // known-adapter list is complete. Fail loud on misconfig (a declared adapter
  // with no implementation), consistent with the execution-policy bootstrap:
  // log the structured error, then rethrow to fail startup.
  try {
    reconcileAdapterAvailability(parseAdapterRegistryEnv());
  } catch (err) {
    logger.error({ err }, "failed to reconcile adapter availability from PAPERCLIP_ADAPTERS");
    throw err;
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      if (process.env.PAPERCLIP_OPEN_ON_LISTEN === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
        printStartupBanner({
          bind: config.bind,
          host: config.host,
          deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: requestedListenPort,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  
  {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      const appShutdown = (app as { locals?: { paperclipShutdown?: () => void } }).locals?.paperclipShutdown;
      appShutdown?.();

      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

      if (pgliteHandle) {
        logger.info({ signal }, "Closing PGlite database");
        try {
          await pgliteHandle.close();
        } catch (err) {
          logger.error({ err }, "Failed to close PGlite cleanly");
        }
      }

      // Flush buffered OTel spans before the process goes away; without this
      // await the exporter's final batch is dropped on exit.
      await shutdownInstrumentation();

      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: configuredApiUrl,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
}
