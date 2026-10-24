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
  /** 「AwwO 线上」 only (cloudRelayURL): what the model takes there, and its measured prose rate. */
  input?: string[];
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
  "input",
  "proseBytesPerToken",
]);

// An origin as every reader of AWWO_CLOUD_ORIGIN takes it (apps/cloud-origin-vectors.json; the API's relay_config.go,
// the Python worker's config.py and scripts/awwo-local-lib.mjs share the rule): https, a host of ASCII letters, digits
// and inner hyphens, and a port of 1 to 65535; or http://127.0.0.1 with a port, a test's own hosted site.
const ORIGIN_HOST = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*";
const ORIGIN_PORT = "(?:6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3})";
const CLOUD_ORIGIN = new RegExp(`^(?:https://${ORIGIN_HOST}(?::${ORIGIN_PORT})?|http://127\\.0\\.0\\.1:${ORIGIN_PORT})$`);

/** Whether a value is exactly a hosted site's origin, as AWWO_CLOUD_ORIGIN must be. */
export function validCloudOrigin(origin: string): boolean {
  return CLOUD_ORIGIN.test(origin);
}

/**
 * The 「AwwO 线上」 engine's one address (docs/awwo-cloud-relay.md): the relay of the hosted site that AwwO 本地版's
 * runtime links to (AWWO_CLOUD_ORIGIN, in every worker's environment there), '' where there is none. Its models are
 * the hosted site's Bedrock models, called with a link's token, so a model bound to it must name exactly this URL: a
 * person's input never supplies an address.
 */
export function cloudRelayURL(env: Record<string, string | undefined> = process.env): string {
  const origin = env.AWWO_CLOUD_ORIGIN ?? "";
  return validCloudOrigin(origin) ? `${origin}/api/v1/relay/v1` : "";
}

const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * A relayed model's own limits, as the hosted site's catalog bounds them (apps/bedrock-catalog.ts): its budget for a
 * call, its output per call, what it takes, and its prose rate (context-estimate.ts). Any other personal model keeps
 * the fixed 32,768 / 4,096 and says nothing of input or prose.
 */
function validLimits(m: UserModel): boolean {
  if (m.provider !== "awwo") {
    return m.contextWindow === 32768 && m.maxTokens === 4096 && m.input === undefined && m.proseBytesPerToken === undefined;
  }
  const input = m.input;
  return (
    integer(m.contextWindow, 4096, 2_000_000) &&
    integer(m.maxTokens, 128, 65_536) &&
    m.maxTokens + 256 < m.contextWindow &&
    (input === undefined ||
      (Array.isArray(input) &&
        input[0] === "text" &&
        (input.length === 1 || (input.length === 2 && input[1] === "image")))) &&
    (m.proseBytesPerToken === undefined ||
      (typeof m.proseBytesPerToken === "number" && m.proseBytesPerToken > 1 && m.proseBytesPerToken <= 4))
  );
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
  const endpoint = m && typeof m === "object" && m.provider === "awwo" ? cloudRelayURL() : endpoints[m?.provider as string];
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
    (m.provider !== "awwo" && !Object.hasOwn(endpoints, m.provider)) ||
    !endpoint ||
    m.baseURL !== endpoint ||
    typeof m.apiKey !== "string" ||
    !/^[\x21-\x7e]{8,4096}$/.test(m.apiKey) ||
    !validLimits(m) ||
    !Array.isArray(m.reasoningEfforts) ||
    m.reasoningEfforts.length !== 0 ||
    m.defaultReasoningEffort !== "" ||
    (m.structuredOutput !== undefined &&
      (m.structuredOutput !== true || runtime !== "openai-agents" || m.provider === "awwo")) ||
    (m.provider === "anthropic"
      ? runtime !== "pi" || m.protocol !== "anthropic_messages"
      : m.provider === "awwo"
        ? m.protocol !== "chat_completions"
        : !["chat_completions", "responses"].includes(m.protocol) ||
          (runtime === "pi" && m.protocol !== "chat_completions"))
  )
    throw new Error("Invalid personal model configuration");
  delete request.userModel;
  // Provider attribution remains explicit; no process-global environment update.
  // structuredOutput passes through as sent (absent or true), so a bound model
  // without it keeps the exact shape it had before the field existed. A relayed
  // model is OpenAI-compatible at its relay; its input and prose rate go with it.
  return {
    ...config,
    models: [
      { ...m, provider: m.provider === "anthropic" ? "anthropic" : "openai" },
    ],
    ready: true,
  };
}
