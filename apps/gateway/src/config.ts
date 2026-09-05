/**
 * SuperClaw Node gateway configuration.
 *
 * The gateway is SuperClaw's Node front door (layer L1 in
 * docs/super-node-server-migration-basis.md). It owns the external listen
 * surface and proxies to the vendored upstream server as a loopback-only
 * internal dependency (layer L3).
 *
 * P0 scope: the gateway proxies to an *externally started* loopback upstream.
 * Having the gateway spawn and supervise the upstream lifecycle (with a proper
 * readiness + port-identity handshake) is deferred to P0.5 — a half-built
 * supervisor would itself violate fail-closed discipline.
 *
 * Every setting is environment-driven (neutral SUPERCLAW_GATEWAY_* names); no
 * host / port / secret is hardcoded. Invalid values fail closed rather than
 * silently falling back. The upstream is pinned loopback on every path (host,
 * probe URL, health path) — a directly-reachable upstream would form a parallel
 * governance channel.
 */
export interface GatewayConfig {
  /** Host the gateway binds for external clients. */
  readonly listenHost: string;
  /** Port the gateway binds for external clients. */
  readonly listenPort: number;
  /** Host of the upstream (vendored) server. Always loopback. */
  readonly upstreamHost: string;
  /** Port of the upstream (vendored) server. */
  readonly upstreamPort: number;
  /** Base URL of the upstream server. Its host is always loopback. */
  readonly upstreamBaseUrl: string;
  /** Path of the upstream health route (vendored mounts it at /api/health). */
  readonly upstreamHealthPath: string;
  /** Per-request upstream timeout in milliseconds. */
  readonly upstreamTimeoutMs: number;
  /** ClawHunt main-site base URL used only to verify browser SSO bearer tokens. */
  readonly clawHuntBaseUrl: string | null;
  /** Per-request timeout for ClawHunt identity verification. */
  readonly clawHuntTimeoutMs: number;
  /**
   * Allow cross-company delegation to be dispatched WITHOUT a human in the loop
   * (P3g). Off by default: a dispatch that declares itself `autonomous` is refused
   * unless this is explicitly enabled, so the shipped default is exactly today's
   * human-approved behaviour and turning the env var off is a complete rollback.
   * Only the literal "on" enables it — an unset, empty or misspelled value stays off,
   * so a typo can never silently grant autonomy.
   */
  readonly crossCompanyAutonomy: boolean;
}

const DEFAULT_LISTEN_HOST = "127.0.0.1";
// Mirrors the Python `superclaw service` default port (cli.py:9282) so the
// gateway is a drop-in front door during the migration.
const DEFAULT_LISTEN_PORT = 8788;
const DEFAULT_UPSTREAM_HOST = "127.0.0.1";
// Matches the vendored server's own default PORT (server/server/src/config.ts:294)
// so an externally-started upstream is reachable with zero config.
const DEFAULT_UPSTREAM_PORT = 3100;
// The vendored server mounts its health router under /api (app.ts:213 + :334).
const DEFAULT_UPSTREAM_HEALTH_PATH = "/api/health";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
const DEFAULT_CLAWHUNT_TIMEOUT_MS = 10_000;

// Hosts that are genuinely loopback.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export class GatewayConfigError extends Error {}

/** Normalize a host for loopback comparison: strip IPv6 brackets, lowercase. */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/** Format a host for embedding in a URL authority (bracket IPv6 literals). */
function formatHostForUrl(host: string): string {
  if (host.startsWith("[")) return host; // already bracketed
  return host.includes(":") ? `[${host}]` : host;
}

function assertLoopback(host: string, field: string): void {
  if (!LOOPBACK_HOSTS.has(normalizeHost(host))) {
    throw new GatewayConfigError(
      `${field} must be loopback (${[...LOOPBACK_HOSTS].join(", ")}); the upstream server is a private dependency, got ${JSON.stringify(host)}`,
    );
  }
}

/** A health path must be a server-rooted path, never a URL that could redirect
 *  the probe off the loopback upstream. */
function assertPathOnly(path: string, field: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || path.includes("\\")) {
    throw new GatewayConfigError(
      `${field} must be an absolute path starting with a single "/", not a URL, got ${JSON.stringify(path)}`,
    );
  }
  return path;
}

function readPositiveInt(
  raw: string | undefined,
  fallback: number,
  field: string,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new GatewayConfigError(
      `${field} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

function readClawHuntBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayConfigError(
      `SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL is not a valid URL: ${JSON.stringify(value)}`,
    );
  }
  const localHttp =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localHttp) {
    throw new GatewayConfigError(
      "SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL must use https (http is allowed only for local development)",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new GatewayConfigError(
      "SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL must not contain credentials, a query, or a fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const listenHost = env.SUPERCLAW_GATEWAY_HOST?.trim() || DEFAULT_LISTEN_HOST;
  const listenPort = readPositiveInt(env.SUPERCLAW_GATEWAY_PORT, DEFAULT_LISTEN_PORT, "SUPERCLAW_GATEWAY_PORT", { max: 65535 });

  const upstreamHost = env.SUPERCLAW_GATEWAY_UPSTREAM_HOST?.trim() || DEFAULT_UPSTREAM_HOST;
  assertLoopback(upstreamHost, "SUPERCLAW_GATEWAY_UPSTREAM_HOST");
  const upstreamPort = readPositiveInt(env.SUPERCLAW_GATEWAY_UPSTREAM_PORT, DEFAULT_UPSTREAM_PORT, "SUPERCLAW_GATEWAY_UPSTREAM_PORT", { max: 65535 });

  // A raw URL override must not be a loopback bypass: assert its host is
  // loopback too. When deriving from host/port, the host is already asserted
  // and IPv6 literals are bracketed for a valid authority.
  const upstreamBaseUrl =
    env.SUPERCLAW_GATEWAY_UPSTREAM_URL?.trim() ||
    `http://${formatHostForUrl(upstreamHost)}:${upstreamPort}`;
  let parsedUpstream: URL;
  try {
    parsedUpstream = new URL(upstreamBaseUrl);
  } catch {
    throw new GatewayConfigError(`SUPERCLAW_GATEWAY_UPSTREAM_URL is not a valid URL: ${JSON.stringify(upstreamBaseUrl)}`);
  }
  if (parsedUpstream.protocol !== "http:" && parsedUpstream.protocol !== "https:") {
    throw new GatewayConfigError(
      `the upstream URL must be http(s), got ${JSON.stringify(parsedUpstream.protocol)}`,
    );
  }
  assertLoopback(parsedUpstream.hostname, "the upstream URL host");

  const upstreamHealthPath = assertPathOnly(
    env.SUPERCLAW_GATEWAY_UPSTREAM_HEALTH_PATH?.trim() || DEFAULT_UPSTREAM_HEALTH_PATH,
    "SUPERCLAW_GATEWAY_UPSTREAM_HEALTH_PATH",
  );
  const upstreamTimeoutMs = readPositiveInt(env.SUPERCLAW_GATEWAY_UPSTREAM_TIMEOUT_MS, DEFAULT_UPSTREAM_TIMEOUT_MS, "SUPERCLAW_GATEWAY_UPSTREAM_TIMEOUT_MS");
  const clawHuntBaseUrl = readClawHuntBaseUrl(env.SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL);
  const clawHuntTimeoutMs = readPositiveInt(
    env.SUPERCLAW_GATEWAY_CLAWHUNT_TIMEOUT_MS,
    DEFAULT_CLAWHUNT_TIMEOUT_MS,
    "SUPERCLAW_GATEWAY_CLAWHUNT_TIMEOUT_MS",
    { max: 60_000 },
  );

  // Strict opt-in: only the exact literal "on" enables autonomy (see the field doc).
  const crossCompanyAutonomy = env.SUPERCLAW_GATEWAY_CROSS_COMPANY_AUTONOMY?.trim() === "on";

  return {
    listenHost,
    listenPort,
    upstreamHost,
    upstreamPort,
    upstreamBaseUrl,
    upstreamHealthPath,
    upstreamTimeoutMs,
    clawHuntBaseUrl,
    clawHuntTimeoutMs,
    crossCompanyAutonomy,
  };
}
