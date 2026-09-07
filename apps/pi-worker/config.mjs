const DEFAULTS = Object.freeze({
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://127.0.0.1:11434/v1',
});

export const INPUT_LIMITS = Object.freeze({
  promptChars: 128_000,
  systemPromptChars: 32_768,
  historyMessageChars: 32_768,
  historyMessages: 100,
  totalTextChars: 262_144,
  bodyBytes: 1_048_576,
});

function integer(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside its allowed range`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const provider = (env.AWWO_PI_PROVIDER ?? '').trim();
  const model = (env.AWWO_PI_MODEL ?? '').trim();
  const apiKey = (env.AWWO_PI_API_KEY ?? '').trim();
  const token = env.AWWO_PI_TOKEN ?? '';
  const baseURL = (env.AWWO_PI_BASE_URL ?? '').trim() || DEFAULTS[provider] || '';
  const missing = [];
  if (token.length < 32) missing.push('AWWO_PI_TOKEN');
  if (!Object.hasOwn(DEFAULTS, provider)) missing.push('AWWO_PI_PROVIDER');
  if (!model || model.length > 256) missing.push('AWWO_PI_MODEL');
  if (provider !== 'ollama' && !apiKey) missing.push('AWWO_PI_API_KEY');
  let validURL = false;
  try {
    const url = new URL(baseURL);
    validURL = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { /* reported below without exposing the URL */ }
  if (!validURL) missing.push('AWWO_PI_BASE_URL');
  return Object.freeze({
    host: env.AWWO_PI_HOST ?? '127.0.0.1',
    port: integer(env.AWWO_PI_PORT, 8097, 0, 65535, 'AWWO_PI_PORT'),
    token, provider, model, apiKey, baseURL,
    timeoutMs: integer(env.AWWO_PI_TIMEOUT_MS, 120_000, 100, 600_000, 'AWWO_PI_TIMEOUT_MS'),
    cancelGraceMs: integer(env.AWWO_PI_CANCEL_GRACE_MS, 2_000, 50, 10_000, 'AWWO_PI_CANCEL_GRACE_MS'),
    maxConcurrency: integer(env.AWWO_PI_MAX_CONCURRENCY, 4, 1, 32, 'AWWO_PI_MAX_CONCURRENCY'),
    maxOutputBytes: integer(env.AWWO_PI_MAX_OUTPUT_BYTES, 1_048_576, 1024, 8_388_608, 'AWWO_PI_MAX_OUTPUT_BYTES'),
    contextWindow: integer(env.AWWO_PI_CONTEXT_WINDOW, 32_768, 4096, 2_000_000, 'AWWO_PI_CONTEXT_WINDOW'),
    maxTokens: integer(env.AWWO_PI_MAX_TOKENS, 4096, 128, 32_768, 'AWWO_PI_MAX_TOKENS'),
    ready: missing.length === 0,
    missing: Object.freeze([...new Set(missing)]),
  });
}

export function publicHealth(config, activeRuns = 0) {
  return {
    status: config.ready ? 'ready' : 'unconfigured',
    ready: config.ready,
    configured: config.ready,
    provider: config.provider || null,
    model: config.model || null,
    activeRuns,
    version: '0.1.0',
    piVersion: '0.85.1',
    // Configuration readiness only; no network/model inference occurs here.
    modelConnectivityVerified: false,
    limits: {
      ...INPUT_LIMITS,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxTokens,
      maxContextTextBytes: Math.max(0, config.contextWindow - config.maxTokens - 256),
      messageOverheadBytes: 32,
    },
  };
}

export function validateRequest(value) {
  const allowed = new Set(['runId', 'tenantId', 'sessionId', 'prompt', 'messages', 'systemPrompt']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Invalid request fields');
  }
  for (const field of ['runId', 'tenantId', 'sessionId']) {
    if (typeof value[field] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value[field])) {
      throw new Error(`Invalid ${field}`);
    }
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > INPUT_LIMITS.promptChars) throw new Error('Invalid prompt');
  if (value.systemPrompt !== undefined && (typeof value.systemPrompt !== 'string' || value.systemPrompt.length > INPUT_LIMITS.systemPromptChars)) {
    throw new Error('Invalid systemPrompt');
  }
  if (!Array.isArray(value.messages) || value.messages.length > INPUT_LIMITS.historyMessages) throw new Error('Invalid messages');
  let total = value.prompt.length + (value.systemPrompt?.length ?? 0);
  for (const message of value.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).some((key) => !['role', 'content'].includes(key))
      || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string' || message.content.length > INPUT_LIMITS.historyMessageChars) throw new Error('Invalid history message');
    total += message.content.length;
  }
  if (total > INPUT_LIMITS.totalTextChars) throw new Error('Conversation is too large');
  return value;
}

// Text admission uses a conservative byte budget, not a provider-tokenizer claim.
// Reserve output capacity and framing, and never silently truncate instructions,
// planner context, or conversation history to make a request fit.
export function fitsContextBudget(request, config) {
  const textBytes = Buffer.byteLength(request.prompt)
    + Buffer.byteLength(request.systemPrompt ?? '')
    + request.messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0);
  return textBytes + 32 * (request.messages.length + 1) <= config.contextWindow - config.maxTokens - 256;
}
