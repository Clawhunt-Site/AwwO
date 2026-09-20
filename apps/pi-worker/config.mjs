import { loadObservabilityConfig } from './observability.mjs';
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

const PROFILE_FIELDS = new Set(['id', 'provider', 'model', 'baseURL', 'apiKeyEnv', 'contextWindow', 'maxTokens']);
const MODEL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/;

function validBaseURL(baseURL) {
  try {
    if (typeof baseURL !== 'string' || !/^https?:\/\//.test(baseURL) || /[\s\\]/.test(baseURL)) return false;
    const url = new URL(baseURL);
    return Boolean(url.hostname) && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function profileInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('Invalid model profile capacity');
  }
  return value;
}

function providerProtocol(provider) {
  return provider === 'anthropic' ? 'anthropic_messages' : 'chat_completions';
}

function loadProfiles(serialized, env, defaultProfile, missing) {
  if (serialized === undefined || serialized === '') return Object.freeze([defaultProfile]);
  // Configuration errors must not fall back to an unintended provider. Error
  // text deliberately omits JSON, URLs, key values, and environment references.
  let problem = 'expected a JSON array containing at most 32 profiles';
  try {
    if (typeof serialized !== 'string' || serialized.length > 65_536) throw new Error();
    const values = JSON.parse(serialized);
    if (!Array.isArray(values) || values.length > 32) throw new Error();
    const profiles = [defaultProfile];
    const ids = new Set([defaultProfile.id]);
    for (const [index, value] of values.entries()) {
      problem = `profile ${index + 1} has invalid fields, an unsupported provider, or a duplicate ID`;
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => !PROFILE_FIELDS.has(key))
        || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.id)
        || ids.has(value.id) || typeof value.provider !== 'string' || !Object.hasOwn(DEFAULTS, value.provider)
        || typeof value.model !== 'string' || !MODEL_SELECTOR.test(value.model)
        || (value.baseURL !== undefined && (typeof value.baseURL !== 'string' || !value.baseURL || value.baseURL.trim() !== value.baseURL))
        || (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.apiKeyEnv)))) throw new Error();
      const baseURL = value.baseURL ?? DEFAULTS[value.provider];
      problem = `profile ${index + 1} has an invalid baseURL`;
      if (!validBaseURL(baseURL)) throw new Error();
      problem = `profile ${index + 1} requires a valid apiKeyEnv reference`;
      const apiKey = value.apiKeyEnv === undefined ? '' : env[value.apiKeyEnv]?.trim() ?? '';
      if (value.provider !== 'ollama' && !value.apiKeyEnv) throw new Error();
      if (value.provider !== 'ollama' && !apiKey) missing.push('AWWO_PI_MODELS_JSON_CREDENTIALS');
      problem = `profile ${index + 1} has invalid capacity limits`;
      const contextWindow = profileInteger(value.contextWindow, defaultProfile.contextWindow, 4096, 2_000_000);
      const maxTokens = profileInteger(value.maxTokens, defaultProfile.maxTokens, 128, 32_768);
      if (maxTokens + 256 >= contextWindow) throw new Error();
      profiles.push(Object.freeze({ id: value.id, provider: value.provider, model: value.model, protocol: providerProtocol(value.provider), baseURL, apiKey, contextWindow, maxTokens }));
      ids.add(value.id);
    }
    return Object.freeze(profiles);
  } catch { throw new Error(`AWWO_PI_MODELS_JSON must contain valid unique model profiles: ${problem}`); }
}

export function loadConfig(env = process.env) {
  const environment = env.APP_ENV ?? 'development';
  if (!['development', 'staging', 'production'].includes(environment)) throw new Error('APP_ENV must be development, staging, or production');
  const provider = (env.AWWO_PI_PROVIDER ?? '').trim();
  const model = (env.AWWO_PI_MODEL ?? '').trim();
  const apiKey = (env.AWWO_PI_API_KEY ?? '').trim();
  const token = env.AWWO_PI_TOKEN ?? '';
  const baseURL = (env.AWWO_PI_BASE_URL ?? '').trim() || DEFAULTS[provider] || '';
  const userCredentials = env.AWWO_CREDENTIAL_MODE === 'user';
  const missing = [];
  if (token.length < 32) missing.push('AWWO_PI_TOKEN');
  if (!Object.hasOwn(DEFAULTS, provider)) missing.push('AWWO_PI_PROVIDER');
  if (!model || model.length > 256) missing.push('AWWO_PI_MODEL');
  if (provider !== 'ollama' && !apiKey) missing.push('AWWO_PI_API_KEY');
  if (!validBaseURL(baseURL)) missing.push('AWWO_PI_BASE_URL');
  const contextWindow = integer(env.AWWO_PI_CONTEXT_WINDOW, 32_768, 4096, 2_000_000, 'AWWO_PI_CONTEXT_WINDOW');
  const maxTokens = integer(env.AWWO_PI_MAX_TOKENS, 4096, 128, 32_768, 'AWWO_PI_MAX_TOKENS');
  if (maxTokens + 256 >= contextWindow) missing.push('AWWO_PI_MAX_TOKENS');
  const models = loadProfiles(env.AWWO_PI_MODELS_JSON, env, Object.freeze({ id: model, provider, model, protocol: providerProtocol(provider), apiKey, baseURL, contextWindow, maxTokens }), missing);
  return Object.freeze({
    observability: loadObservabilityConfig(env, 'pi', environment),
    host: env.AWWO_PI_HOST ?? '127.0.0.1',
    port: integer(env.AWWO_PI_PORT, 8097, 0, 65535, 'AWWO_PI_PORT'),
    token, provider, model, apiKey, baseURL,
    timeoutMs: integer(env.AWWO_PI_TIMEOUT_MS, 120_000, 100, 600_000, 'AWWO_PI_TIMEOUT_MS'),
    cancelGraceMs: integer(env.AWWO_PI_CANCEL_GRACE_MS, 2_000, 50, 10_000, 'AWWO_PI_CANCEL_GRACE_MS'),
    maxConcurrency: integer(env.AWWO_PI_MAX_CONCURRENCY, 4, 1, 32, 'AWWO_PI_MAX_CONCURRENCY'),
    maxOutputBytes: integer(env.AWWO_PI_MAX_OUTPUT_BYTES, 1_048_576, 1024, 8_388_608, 'AWWO_PI_MAX_OUTPUT_BYTES'),
    contextWindow, maxTokens, models,
    userCredentials,
    ready: userCredentials ? token.length >= 32 && !/[\r\n]/.test(token) : missing.length === 0,
    missing: Object.freeze([...new Set(missing)]),
  });
}

export function publicHealth(config, activeRuns = 0) {
  return {
    status: config.ready ? 'ready' : 'unconfigured',
    ready: config.ready,
    userCredentials: config.userCredentials === true,
    configured: config.ready,
    provider: config.provider || null,
    model: config.model || null,
    models: config.models.filter((profile) => profile.id && profile.provider).map((profile) => ({
      id: profile.id,
      name: profile.model,
      providerModel: profile.model,
      protocol: profile.protocol,
      provider: profile.provider,
      runtime: 'pi',
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxTokens,
      maxContextTextBytes: Math.max(0, profile.contextWindow - profile.maxTokens - 256),
      messageOverheadBytes: 32,
    })),
    activeRuns,
    version: '0.1.0',
    telemetryProtocolVersion: 1,
    metricsEnabled: config.observability.enabled,
    selfHostedTracingEnabled: config.observability.tracing,
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
  const allowed = new Set(['runId', 'tenantId', 'sessionId', 'prompt', 'messages', 'systemPrompt', 'userModel', 'model', 'runtime']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Invalid request fields');
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || !MODEL_SELECTOR.test(value.model))) throw new Error('Invalid model selector');
  if (value.runtime !== undefined && value.runtime !== 'pi') throw new Error('Invalid runtime selector');
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

export function resolveModelConfig(config, selector) {
  const profile = selector === undefined ? config.models[0] : config.models.find((model) => model.id === selector);
  if (!profile) throw new Error('Unknown configured model');
  return profile;
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
