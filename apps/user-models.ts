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
]);

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
    !Object.hasOwn(endpoints, m.provider) ||
    m.baseURL !== endpoints[m.provider] ||
    typeof m.apiKey !== "string" ||
    !/^[\x21-\x7e]{8,4096}$/.test(m.apiKey) ||
    m.contextWindow !== 32768 ||
    m.maxTokens !== 4096 ||
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
