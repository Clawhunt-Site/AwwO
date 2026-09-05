/**
 * Shared, PURE helpers for wiring the SuperClaw plugin-tool MCP bridge into a
 * local agent CLI (claude-local `--mcp-config`, codex-local `[mcp_servers]`).
 *
 * This module deliberately has NO dependency on `@paperclipai/mcp-server`: the
 * host (heartbeat) resolves + existence-checks the bridge bin and hands the
 * absolute path through the server-derived `pluginToolRunContext`. Adapters
 * read that context here and assemble the spawn spec; they never resolve the
 * package themselves (see design §4.2).
 *
 * What travels in `pluginToolRunContext` is only `{ projectId, bridgeBin }` —
 * both server-derived. Every other bridge credential (API url, the per-run
 * agent JWT, run/agent/company ids) is already in the agent process env that
 * the host injected (`buildPaperclipEnv` + RUN_ID); we read those from the
 * caller's assembled env and re-emit them as the bridge subprocess's explicit
 * env, because MCP clients spawn servers with a REPLACED (not inherited) env.
 */

/**
 * Server-derived run context the host plants on the adapter config — the SINGLE
 * definition of this contract. The server aliases its `PluginToolRunContext` to
 * this type (it depends on adapter-utils), so a new bridge field added here
 * cannot silently drift out of sync with the adapter that reads it.
 */
export interface PluginBridgeRunContext {
  readonly projectId: string;
  readonly bridgeBin: string;
}

/**
 * Infrastructure env vars passed THROUGH to the bridge subprocess in addition to
 * the run credentials. MCP clients spawn servers with a replaced (not inherited)
 * env, so the bridge would otherwise lose the proxy / custom-CA configuration it
 * needs to reach the host API in corporate-proxy or self-signed-cert
 * deployments. These are a controlled infrastructure allowlist — note a proxy
 * URL MAY embed credentials (`http://user:pass@proxy`), so they sit in the same
 * 0600 mcp-config file as the run JWT (never broadened beyond this allowlist).
 */
export const PLUGIN_BRIDGE_INHERITED_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
] as const;

/**
 * Proxy keys whose presence requires Node's `--use-env-proxy` flag: Node's
 * global `fetch` (undici) does NOT honor `HTTP(S)_PROXY` from the env unless the
 * runtime is launched with this flag. Merely placing the var in the child env is
 * a no-op without it (the bridge would direct-connect). `NO_PROXY` /
 * `NODE_EXTRA_CA_CERTS` are honored natively and do not need the flag.
 */
const PLUGIN_BRIDGE_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

/** The Node flag that makes global fetch honor the proxy env vars. */
export const NODE_USE_ENV_PROXY_FLAG = "--use-env-proxy";

/** A single MCP server spawn spec (the value under an mcp config server key). */
export interface PluginBridgeMcpServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/** The canonical mcp config server key the bridge is wired under. */
export const PLUGIN_BRIDGE_MCP_SERVER_KEY = "superclaw";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Read + validate the host-planted `pluginToolRunContext` off an adapter config.
 * Returns null (→ no bridge) unless BOTH server-derived fields are present and
 * non-empty. Fail-closed: a partial/garbage context never wires a bridge.
 */
export function readPluginBridgeRunContext(
  config: Record<string, unknown> | undefined | null,
): PluginBridgeRunContext | null {
  const raw = config?.pluginToolRunContext;
  if (typeof raw !== "object" || raw === null) return null;
  const projectId = nonEmptyString((raw as Record<string, unknown>).projectId);
  const bridgeBin = nonEmptyString((raw as Record<string, unknown>).bridgeBin);
  if (!projectId || !bridgeBin) return null;
  return { projectId, bridgeBin };
}

export interface BuildPluginBridgeSpecInput {
  readonly runContext: PluginBridgeRunContext;
  /** The agent process env the adapter has assembled (buildPaperclipEnv + RUN_ID). */
  readonly agentEnv: Readonly<Record<string, string>>;
  readonly agentId: string;
  readonly companyId: string;
  readonly runId: string;
  /** Node executable to spawn the bin with (process.execPath at the call site). */
  readonly nodeExecPath: string;
  /**
   * The host process env (process.env) to source infrastructure passthrough vars
   * (proxy / custom CA) from. Optional — omitted means no passthrough.
   */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Whether the Node that will spawn the bridge supports `--use-env-proxy`
   * (check `process.allowedNodeEnvironmentFlags.has("--use-env-proxy")` at the
   * call site — the child is the same binary). When true AND a proxy var is
   * passed through, the flag is prepended so the bridge's fetch honors it.
   */
  readonly nodeSupportsEnvProxy?: boolean;
}

function pickInheritedInfraEnv(
  hostEnv: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  if (!hostEnv) return inherited;
  for (const key of PLUGIN_BRIDGE_INHERITED_ENV_KEYS) {
    const value = nonEmptyString(hostEnv[key]);
    if (value) inherited[key] = value;
  }
  return inherited;
}

/**
 * Assemble the bridge MCP server spawn spec, or null if the run credentials the
 * bridge requires (API url + per-run JWT) are not present in the agent env.
 * Fail-closed: the bridge `readPluginBridgeConfig` would reject a partial env
 * anyway, so we refuse to wire it rather than spawn a server that can't start.
 *
 * The returned `env` is the bridge subprocess's COMPLETE env (MCP clients do not
 * inherit the parent env), carrying only the run-bound bridge credentials under
 * `SUPERCLAW_*` keys — never the broad agent env.
 */
export function buildPluginBridgeMcpServerSpec(
  input: BuildPluginBridgeSpecInput,
): PluginBridgeMcpServerSpec | null {
  const { runContext, agentEnv, agentId, companyId, runId, nodeExecPath, hostEnv, nodeSupportsEnvProxy } =
    input;
  const apiUrl = nonEmptyString(agentEnv.SUPERCLAW_API_URL) ?? nonEmptyString(agentEnv.PAPERCLIP_API_URL);
  const apiKey = nonEmptyString(agentEnv.SUPERCLAW_API_KEY) ?? nonEmptyString(agentEnv.PAPERCLIP_API_KEY);
  const resolvedAgentId = nonEmptyString(agentId);
  const resolvedCompanyId = nonEmptyString(companyId);
  const resolvedRunId = nonEmptyString(runId);
  if (!apiUrl || !apiKey || !resolvedAgentId || !resolvedCompanyId || !resolvedRunId) {
    return null;
  }
  const inheritedEnv = pickInheritedInfraEnv(hostEnv);
  const hasProxyEnv = PLUGIN_BRIDGE_PROXY_ENV_KEYS.some((key) => key in inheritedEnv);
  // Node flags must precede the script path. Add --use-env-proxy only when a
  // proxy var is actually present AND the runtime supports the flag (else the
  // proxy env would be inert; an unsupported flag would also crash the spawn).
  const nodeArgs = hasProxyEnv && nodeSupportsEnvProxy ? [NODE_USE_ENV_PROXY_FLAG] : [];
  return {
    command: nodeExecPath,
    args: [...nodeArgs, runContext.bridgeBin],
    // Infra passthrough FIRST so the run credentials below always win on any key
    // collision (the allowlist never contains a SUPERCLAW_* key, but be explicit).
    env: {
      ...inheritedEnv,
      SUPERCLAW_API_URL: apiUrl,
      SUPERCLAW_API_KEY: apiKey,
      SUPERCLAW_AGENT_ID: resolvedAgentId,
      SUPERCLAW_COMPANY_ID: resolvedCompanyId,
      SUPERCLAW_RUN_ID: resolvedRunId,
      SUPERCLAW_PROJECT_ID: runContext.projectId,
    },
  };
}
