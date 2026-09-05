/**
 * Config for the SuperClaw plugin-tool MCP bridge (Form A — see
 * docs/node-agent-capability-bridge-design.md §4.1).
 *
 * The bridge is a stdio MCP server spawned by the agent CLI (via --mcp-config /
 * codex [mcp_servers]). It reuses the run-bound credentials the host already
 * injects into the agent's environment (buildPaperclipEnv): API_URL, API_KEY
 * (the per-run agent JWT), and the run identity. It then exposes installed
 * plugin tools to the model and proxies tools/call to the governed host route
 * POST /api/plugins/tools/execute.
 *
 * Fail-closed: every field of the runContext (agentId, companyId, runId,
 * projectId) is REQUIRED. A bridge that cannot assemble a complete, host-issued
 * runContext must refuse to start rather than fall back to a partial/guessed one
 * — the host route would reject it anyway, and a half-context is a governance
 * smell. None of these values are model-controllable: the host writes them into
 * the agent process environment before spawning the CLI.
 */

export interface PluginBridgeConfig {
  /** Host API base, normalized to end with `/api`. */
  readonly apiUrl: string;
  /** Per-run agent JWT (host-issued, short-TTL, run-bound). */
  readonly apiKey: string;
  readonly agentId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly projectId: string;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Normalize an API base to end with exactly one `/api`. */
export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

/**
 * Read the bridge config from the agent process environment. Accepts both
 * `SUPERCLAW_*` and `PAPERCLIP_*` (buildPaperclipEnv mirrors both); SUPERCLAW
 * wins when both are present. Throws (fail-closed) on any missing field.
 */
export function readPluginBridgeConfig(env: NodeJS.ProcessEnv = process.env): PluginBridgeConfig {
  const pick = (suffix: string): string | null =>
    nonEmpty(env[`SUPERCLAW_${suffix}`]) ?? nonEmpty(env[`PAPERCLIP_${suffix}`]);

  const apiUrl = pick("API_URL");
  const apiKey = pick("API_KEY");
  const agentId = pick("AGENT_ID");
  const companyId = pick("COMPANY_ID");
  const runId = pick("RUN_ID");
  const projectId = pick("PROJECT_ID");

  const missing = [
    ["API_URL", apiUrl],
    ["API_KEY", apiKey],
    ["AGENT_ID", agentId],
    ["COMPANY_ID", companyId],
    ["RUN_ID", runId],
    ["PROJECT_ID", projectId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`plugin bridge: missing required env: ${missing.join(", ")}`);
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl as string),
    apiKey: apiKey as string,
    agentId: agentId as string,
    companyId: companyId as string,
    runId: runId as string,
    projectId: projectId as string,
  };
}
