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
]);

/** Internal authenticated admission only. Never mutate a shared worker config. */
export function bindUserModel<
  T extends {
    userCredentials?: boolean;
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
    (m.provider === "anthropic"
      ? runtime !== "pi" || m.protocol !== "anthropic_messages"
      : !["chat_completions", "responses"].includes(m.protocol) ||
        (runtime === "pi" && m.protocol !== "chat_completions"))
  )
    throw new Error("Invalid personal model configuration");
  delete request.userModel;
  // Provider attribution remains explicit; no process-global environment update.
  return {
    ...config,
    models: [
      { ...m, provider: m.provider === "anthropic" ? "anthropic" : "openai" },
    ],
    ready: true,
  };
}
