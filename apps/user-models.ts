type UserModel = {
  id: string;
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  protocol: string;
  contextWindow: number;
  maxTokens: number;
  reasoningEfforts: string[];
  defaultReasoningEffort: string;
  /**
   * Present only when the API froze a delivery contract for this run and the
   * connection's provider honours a json_schema response format. It is the
   * capability the openai-agents worker's contract authorization reads, so it
   * must be literally true and it exists on no other runtime.
   */
  structuredOutput?: true;
  /** An AwwO 云端 model's measured bytes of prose per token, as the hosted worker measures its calls (1 to 4). */
  proseBytesPerToken?: number;
};
const endpoints: Record<string, string> = {
  llmgate: "https://api.clawhunt.site/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  xai: "https://api.x.ai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};
const fields = new Set([
  "id",
  "provider",
  "model",
  "baseURL",
  "apiKey",
  "protocol",
  "contextWindow",
  "maxTokens",
  "reasoningEfforts",
  "defaultReasoningEffort",
  "structuredOutput",
  "proseBytesPerToken",
]);

/**
 * Where AwwO 云端 connections send their calls: the hosted AwwO's relay (its relay.go), the local edition's
 * AWWO_LOCAL_CLOUD_ORIGIN as the API is told (edition.go), https://awwo.clawhunt.store unless set; null for an origin
 * the API would refuse (HTTPS, or HTTP on this computer, with no path).
 */
export function cloudRelayBase(env: Record<string, string | undefined> = process.env): string | null {
  const origin = (env.AWWO_LOCAL_CLOUD_ORIGIN || "https://awwo.clawhunt.store").replace(/\/+$/, "");
  try {
    const url = new URL(origin);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.username || url.password || /[?#]/.test(origin) || url.pathname !== "/" || !origin.startsWith(url.protocol + "//") ||
      !(url.protocol === "https:" || (url.protocol === "http:" && local))) return null;
  } catch {
    return null;
  }
  return origin + "/api/v1/relay/v1";
}

/** Whether a bound model's calls go to the hosted AwwO's relay, which answers streamed calls only. */
export const callsCloudRelay = (baseURL: string, env?: Record<string, string | undefined>): boolean =>
  baseURL.replace(/\/+$/, "") === cloudRelayBase(env);

/** An AwwO 云端 model's limits hold: the hosted site's window, output and prose rate, Chat Completions on either runtime. */
function cloudLimits(m: UserModel): boolean {
  return Number.isInteger(m.contextWindow) && m.contextWindow >= 4096 && m.contextWindow <= 2_000_000 &&
    Number.isInteger(m.maxTokens) && m.maxTokens >= 1 && m.maxTokens + 256 < m.contextWindow &&
    (m.proseBytesPerToken === undefined || (typeof m.proseBytesPerToken === "number" && m.proseBytesPerToken >= 1 && m.proseBytesPerToken <= 4)) &&
    m.protocol === "chat_completions" && m.structuredOutput === undefined;
}

/** Internal authenticated admission only. Never mutate a shared worker config. */
export function bindUserModel<
  T extends {
    userCredentials?: boolean;
    llmgateOnly?: boolean;
    models: readonly unknown[];
    ready: boolean;
  },
>(config: T, request: Record<string, unknown>, runtime: string): T {
  if (!config.userCredentials) {
    if (request.userModel !== undefined)
      throw new Error("Personal credentials are disabled");
    return config;
  }
  const m = request.userModel as UserModel | undefined;
  const cloud = !!m && typeof m === "object" && m.provider === "awwo";
  const allowed: Record<string, string> = { ...endpoints, ...(cloudRelayBase() ? { awwo: cloudRelayBase()! } : {}) };
  if (
    !m ||
    typeof m !== "object" ||
    Array.isArray(m) ||
    (config.llmgateOnly === true && m.provider !== "llmgate") ||
    Object.keys(m).some((k) => !fields.has(k)) ||
    typeof m.id !== "string" ||
    !/^byok_[A-Za-z0-9_-]{33}_[0-9a-f]{16}$/.test(m.id) ||
    m.id !== request.model ||
    typeof m.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(m.model) ||
    !Object.hasOwn(allowed, m.provider) ||
    m.baseURL !== allowed[m.provider] ||
    typeof m.apiKey !== "string" ||
    !/^[\x21-\x7e]{8,4096}$/.test(m.apiKey) ||
    (cloud ? !cloudLimits(m) : m.contextWindow !== 32768 || m.maxTokens !== 4096 || m.proseBytesPerToken !== undefined) ||
    !Array.isArray(m.reasoningEfforts) ||
    m.reasoningEfforts.length !== 0 ||
    m.defaultReasoningEffort !== "" ||
    (m.structuredOutput !== undefined &&
      (m.structuredOutput !== true || runtime !== "openai-agents")) ||
    (m.provider === "anthropic"
      ? runtime !== "pi" || m.protocol !== "anthropic_messages"
      : !["chat_completions", "responses"].includes(m.protocol) ||
        (runtime === "pi" && m.protocol !== "chat_completions"))
  )
    throw new Error("Invalid personal model configuration");
  delete request.userModel;
  // Provider attribution remains explicit; no process-global environment update.
  // structuredOutput passes through as sent (absent or true), so a bound model
  // without it keeps the exact shape it had before the field existed.
  return {
    ...config,
    models: [
      { ...m, provider: m.provider === "anthropic" ? "anthropic" : "openai" },
    ],
    ready: true,
  };
}
