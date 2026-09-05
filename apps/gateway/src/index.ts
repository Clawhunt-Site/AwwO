import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { loadGatewayConfig } from "./config.js";
import { HttpUpstreamClient } from "./upstream.js";
import { createGatewayApp } from "./app.js";
import { loadCanvasPlannerConfig } from "./canvas/config.js";
import { createCanvasPlanner } from "./canvas/provider.js";
import { createCanvasPlannerRouter } from "./canvas/routes.js";
import { UpstreamChatTurnDispatcher } from "./automation/fire.js";
import { createAutomationRouter } from "./automation/routes.js";
import { JsonFileAutomationStore } from "./automation/store.js";
import { AutomationTicker } from "./automation/ticker.js";
import { createMissionRouter } from "./mission/routes.js";
import { createMissionDispatchRouter } from "./mission/dispatch-routes.js";
import { ConversationIndexStore } from "./conversation/index-store.js";
import { HttpUpstreamCompanyReader } from "./mission/upstream-reader.js";
import { AgentConversationDispatcher } from "./conversation/dispatcher.js";
import { createConversationRouter } from "./conversation/routes.js";
import { ConversationOperationStore } from "./conversation/operation-store.js";
import { createClawHuntAuthRouter } from "./auth/routes.js";
import { openCompanyEventSource } from "./conversation/ws-source.js";
import {
  precleanStaleGateway,
  removeGatewayMarker,
  processStartSignature,
  superHome,
  writeGatewayMarker,
} from "./lifecycle.js";

export interface GatewayRuntime {
  readonly server: Server;
  stop(): Promise<void>;
}

// Schedule store under the SuperClaw home (respects SUPERCLAW_HOME) — survives restarts.
function automationStorePath(): string {
  const override = process.env.SUPERCLAW_GATEWAY_AUTOMATION_FILE?.trim();
  return override || join(superHome(), "chat-automations.json");
}

function tickerIntervalMs(): number {
  const raw = Number(process.env.SUPERCLAW_GATEWAY_AUTOMATION_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 30_000;
}

// The automation API is a persistent background-execution entry, so it is never
// unauthenticated. The gateway OWNS the control token: env override, else a stable per-install
// token persisted (0600) under the super home. The proxy (vite dev / front door) reads the
// SAME file to inject it, so the browser never holds the secret.
function resolveControlToken(): string {
  const fromEnv = process.env.SUPERCLAW_GATEWAY_CONTROL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const tokenPath = join(superHome(), "gateway-control-token");
  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // not yet created
  }
  const token = randomUUID();
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

// Discover the upstream Node's base URL in Node — no Python passing it. Order: explicit env →
// the upstream's own run-dir marker (node-service.json, written by the co-launched server) →
// the conventional default. So the gateway finds the upstream the Python service started.
function discoverUpstreamBaseUrl(): string | null {
  const fromEnv = process.env.SUPERCLAW_GATEWAY_UPSTREAM_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const marker = JSON.parse(readFileSync(join(superHome(), "run", "node-service.json"), "utf8")) as {
      base_url?: unknown;
    };
    if (typeof marker.base_url === "string" && marker.base_url) return marker.base_url;
  } catch {
    // upstream marker absent — fall back to the conventional default below
  }
  return null;
}

/**
 * Boot the SuperClaw Node gateway. Self-sufficient: it discovers the upstream, owns its control
 * token, reaps its own stale orphan (identity-gated), and hosts the chat-automation ticker —
 * all in Node, with no Python launch logic. The vendored upstream tree is never modified.
 */
export async function startGateway(): Promise<GatewayRuntime> {
  // Reap a prior run's orphan on the fixed port BEFORE binding.
  //
  // `identity_unknown` means a marked pid is alive but we could not prove it is OUR prior
  // gateway. Refusing outright used to be the answer — but that turns any stale marker into a
  // PERMANENT outage, which is exactly what happened in production: the marker lives on a
  // persistent volume, so it outlives the container that wrote it, and in the next container
  // that pid number belongs to something else entirely (PID namespaces restart at 1). The check
  // can then never succeed again, the gateway never starts, and every /gateway-api call 503s
  // forever with "Node control plane unavailable" — a whole-product outage from a leftover file.
  //
  // The PORT is the honest arbiter. If the prior process really were our gateway it would still
  // be holding the port, so a successful bind PROVES it is not, and we may take the marker over.
  // Only an actual EADDRINUSE defers — and that path still keeps the marker, preserving the
  // evidence the original guard existed to protect.
  const preclean = precleanStaleGateway();

  // Point config at the discovered upstream (env wins if already set).
  const discovered = discoverUpstreamBaseUrl();
  if (discovered && !process.env.SUPERCLAW_GATEWAY_UPSTREAM_URL) {
    process.env.SUPERCLAW_GATEWAY_UPSTREAM_URL = discovered;
  }
  const config = loadGatewayConfig();
  const instanceId = randomUUID();
  const upstreamClient = new HttpUpstreamClient(
    config.upstreamBaseUrl,
    config.upstreamHealthPath,
    config.upstreamTimeoutMs,
  );

  const automationStore = new JsonFileAutomationStore(automationStorePath());
  const automationDispatcher = new UpstreamChatTurnDispatcher(config.upstreamBaseUrl);
  const automationTicker = new AutomationTicker(automationStore, automationDispatcher, {
    intervalMs: tickerIntervalMs(),
    onError: (err) => console.error("[superclaw-gateway] automation tick failed", err),
  });
  const controlToken = resolveControlToken();
  const canvasPlannerRouter = createCanvasPlannerRouter({
    provider: createCanvasPlanner(loadCanvasPlannerConfig()),
    controlToken,
  });
  const automationRouter = createAutomationRouter({ store: automationStore, controlToken });

  // Read-only mission planning + real-company matching over the same upstream.
  const missionReader = new HttpUpstreamCompanyReader(config.upstreamBaseUrl, {
    timeoutMs: config.upstreamTimeoutMs,
  });
  const missionRouter = createMissionRouter({ reader: missionReader, controlToken });

  // Real per-agent conversation (P3d): dispatch a message to a specific hired
  // agent + stream its run over the company WS. All over the same loopback upstream.
  const conversationDispatcher = new AgentConversationDispatcher(config.upstreamBaseUrl, {
    timeoutMs: config.upstreamTimeoutMs,
    operationStore: new ConversationOperationStore(join(superHome(), "conversation-operations")),
  });
  const conversationRouter = createConversationRouter({
    dispatcher: conversationDispatcher,
    openEventSource: (companyId) => openCompanyEventSource(config.upstreamBaseUrl, companyId),
    controlToken,
    // P3f: company-wide conversation index (label-marked issues + their transcripts).
    indexStore: new ConversationIndexStore({ upstreamBaseUrl: config.upstreamBaseUrl }),
  });

  // P3g-a: mission dispatch (mutation) — delegate ONE operator-approved track to a
  // matched company's agent. Reuses the same company-agnostic conversation
  // dispatcher. The human-approval gate lives in the UI; a caller may instead DECLARE
  // itself autonomous, which is refused unless crossCompanyAutonomy is explicitly on
  // (P3g) — so the default build still never fires without a human.
  const missionDispatchRouter = createMissionDispatchRouter({
    dispatcher: conversationDispatcher,
    upstreamBaseUrl: config.upstreamBaseUrl,
    controlToken,
    crossCompanyAutonomy: config.crossCompanyAutonomy,
  });
  const clawHuntAuthRouter = config.clawHuntBaseUrl
    ? createClawHuntAuthRouter({
        baseUrl: config.clawHuntBaseUrl,
        timeoutMs: config.clawHuntTimeoutMs,
      })
    : undefined;
  if (!config.clawHuntBaseUrl) {
    // Fail-closed (no route → verify returns non-401 → canvas stays anonymous), but make the cause
    // visible: a deploy that forgets the base URL ships a login that silently never resolves.
    console.warn(
      "[gateway] ClawHunt SSO identity disabled: SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL is unset (GET /api/auth/me will 404).",
    );
  }

  const app = createGatewayApp({
    upstream: upstreamClient,
    canvasPlannerRouter,
    automationRouter,
    missionRouter,
    conversationRouter,
    missionDispatchRouter,
    clawHuntAuthRouter,
    automationStatus: () => automationTicker.status(),
    instanceId,
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.listenPort, config.listenHost, () => {
      if (preclean === "identity_unknown") {
        // eslint-disable-next-line no-console
        console.warn(
          "[superclaw-gateway] took over a marker whose owner could not be identified — the port was free, so it was not a live gateway",
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `[superclaw-gateway] listening on ${config.listenHost}:${config.listenPort} -> upstream ${config.upstreamBaseUrl}${config.upstreamHealthPath}`,
      );
      resolve(s);
    });
    s.once("error", (err: NodeJS.ErrnoException) => {
      // The unidentifiable owner IS holding the port after all: defer, marker untouched.
      if (preclean === "identity_unknown" && err.code === "EADDRINUSE") {
        reject(
          new Error("gateway start deferred: a prior process still holds the port (marker kept)"),
        );
        return;
      }
      reject(err);
    });
  });

  // Record our (pid, start-time) identity so a future run can reap THIS process if it orphans.
  writeGatewayMarker({
    pid: process.pid,
    startSignature: processStartSignature(process.pid),
    instanceId,
    port: config.listenPort,
  });

  automationTicker.start();

  const stop = async (): Promise<void> => {
    automationTicker.stop();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    removeGatewayMarker();
  };

  return { server, stop };
}

// Only auto-start when run directly, never when imported by tests.
const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  startGateway()
    .then((runtime) => {
      const shutdown = (): void => {
        void runtime.stop().finally(() => process.exit(0));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[superclaw-gateway] failed to start", err);
      process.exit(1);
    });
}
