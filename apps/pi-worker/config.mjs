import { loadObservabilityConfig } from './observability.mjs';
import { applyBedrockPromptCache, assertOperatorOnlyBedrock, bedrockApiKey, bedrockCatalogProfiles, bedrockProfile, bedrockPromptCacheModels, bedrockRegion, parsePlatformProviders, platformHealth, platformProvidersInUse } from '../bedrock-catalog.ts';
import { validBedrockRegion, validThinkingBudget } from '../bedrock-bridge.ts';
const DEFAULTS = Object.freeze({
  llmgate: 'https://api.clawhunt.site/v1',
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
  // Six pictures of 3.75 MiB are 31.5 MB as base64; the rest is room for the largest text.
  bodyBytes: 34 * 1024 * 1024,
  // A run's pictures (vision): at most six, each at most 3.75 MiB, for the final user turn only.
  images: 6,
  imageBytes: 3_932_160,
});

// The picture types Bedrock Converse and the providers take.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function integer(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside its allowed range`);
  }
  return parsed;
}

const PROFILE_FIELDS = new Set(['id', 'provider', 'model', 'baseURL', 'apiKeyEnv', 'contextWindow', 'maxTokens', 'input']);
const BEDROCK_PROFILE_FIELDS = new Set(['id', 'provider', 'model', 'apiKeyEnv', 'contextWindow', 'maxTokens', 'region', 'name', 'input']);

// What a profile's model takes: text, unless it names ["text","image"] (a model that sees pictures). Anything else is
// a configuration error, so a misspelt list never sends pictures to a text model.
function profileInput(value) {
  if (value === undefined) return Object.freeze(['text']);
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || new Set(value).size !== value.length
    || value.some((kind) => kind !== 'text' && kind !== 'image') || !value.includes('text')) throw new Error('Invalid model input');
  return Object.freeze([...value]);
}
const MAX_CATALOG_MODELS = 256; // Includes the required default profile.
const MAX_CATALOG_BYTES = 512 * 1024;
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

function validProfileName(name) {
  if (typeof name !== 'string' || !name.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(name)) return false;
  const characters = [...name].length;
  return characters >= 1 && characters <= 80;
}

// A Bedrock profile reaches the provider only through the Converse bridge, which Pi calls as
// an OpenAI-compatible endpoint. It signs with the worker's AWS credentials unless it names a key.
function bedrockModelsJsonProfile(value, env, ids, defaultProfile, missing) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !BEDROCK_PROFILE_FIELDS.has(key))
    || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.id) || ids.has(value.id)
    || typeof value.model !== 'string' || !MODEL_SELECTOR.test(value.model)
    || (value.region !== undefined && !validBedrockRegion(value.region))
    || (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.apiKeyEnv)))
    || (value.name !== undefined && !validProfileName(value.name))) throw new Error();
  let apiKey = '';
  if (value.apiKeyEnv !== undefined) {
    apiKey = bedrockApiKey(env, value.apiKeyEnv);
    if (!apiKey) missing.push('AWWO_PI_MODELS_JSON_CREDENTIALS');
  }
  const contextWindow = profileInteger(value.contextWindow, defaultProfile.contextWindow, 4096, 2_000_000);
  const maxTokens = profileInteger(value.maxTokens, defaultProfile.maxTokens, 128, 32_768);
  if (maxTokens + 256 >= contextWindow) throw new Error();
  return workerBedrockProfile(bedrockProfile({ id: value.id, name: value.name ?? value.model, vendor: '', target: value.model, contextWindow, maxTokens, input: profileInput(value.input) },
    value.region ?? bedrockRegion(env), apiKey));
}

function workerBedrockProfile(profile, thinking = null) {
  // An operator thinking budget reaches only the Claude models it names, and only where the output limit leaves
  // room beyond it.
  const budget = thinking !== null && thinking.models.has(profile.id) && profile.vendor === 'anthropic'
    && profile.maxTokens > thinking.budget + 1024 ? thinking.budget : 0;
  return Object.freeze({ ...profile, protocol: 'chat_completions', ...(budget ? { thinkingBudget: budget } : {}) });
}

// AWWO_PI_BEDROCK_THINKING_BUDGET (empty or 0: none) with AWWO_PI_BEDROCK_THINKING_MODELS: extended-thinking
// tokens for the named Claude catalog models this worker serves through Bedrock — meant for the API's canvas
// planner model (AWWO_PLANNER_MODEL). Every Pi request is tool-free, so a model users can also pick would think,
// and spend, for them too: name only the planner's. Operator-set, never a per-request choice; the bridge applies
// it only to requests without tools (withClaudeThinking).
function thinkingSetting(env) {
  const value = env.AWWO_PI_BEDROCK_THINKING_BUDGET;
  if (value === undefined || value === '' || value === '0') return null;
  const budget = Number(value);
  if (!/^[0-9]+$/.test(String(value)) || !validThinkingBudget(budget)) throw new Error('AWWO_PI_BEDROCK_THINKING_BUDGET must be 0 or a whole number from 1024 to 16000');
  const models = new Set((env.AWWO_PI_BEDROCK_THINKING_MODELS ?? '').split(',').map(id => id.trim()).filter(Boolean));
  if (!models.size) throw new Error('AWWO_PI_BEDROCK_THINKING_BUDGET needs AWWO_PI_BEDROCK_THINKING_MODELS, the Claude catalog ids that may think');
  return Object.freeze({ budget, models });
}

function loadProfiles(serialized, env, defaultProfile, missing) {
  if (serialized === undefined || serialized === '') return Object.freeze([defaultProfile]);
  // Configuration errors must not fall back to an unintended provider. Error
  // text deliberately omits JSON, URLs, key values, and environment references.
  let problem = 'expected a JSON array containing at most 255 additional profiles within 512 KiB';
  try {
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_CATALOG_BYTES) throw new Error();
    const values = JSON.parse(serialized);
    if (!Array.isArray(values) || values.length >= MAX_CATALOG_MODELS) throw new Error();
    const profiles = [defaultProfile];
    const ids = new Set([defaultProfile.id]);
    for (const [index, value] of values.entries()) {
      if (value?.provider === 'bedrock') {
        problem = `profile ${index + 1} is not a valid Bedrock profile`;
        profiles.push(bedrockModelsJsonProfile(value, env, ids, defaultProfile, missing));
        ids.add(value.id);
        continue;
      }
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
      problem = `profile ${index + 1} has an invalid input list`;
      const input = profileInput(value.input);
      profiles.push(Object.freeze({ id: value.id, provider: value.provider, model: value.model, protocol: providerProtocol(value.provider), baseURL, apiKey, contextWindow, maxTokens, input }));
      ids.add(value.id);
    }
    return Object.freeze(profiles);
  } catch { throw new Error(`AWWO_PI_MODELS_JSON must contain valid unique model profiles: ${problem}`); }
}

export function loadConfig(env = process.env) {
  if (!['', 'false', 'true', undefined].includes(env.AWWO_LLMGATE_ONLY)) throw new Error('AWWO_LLMGATE_ONLY must be true or false');
  const llmgateOnly = env.AWWO_LLMGATE_ONLY === 'true';
  const environment = env.APP_ENV ?? 'development';
  if (!['development', 'staging', 'production'].includes(environment)) throw new Error('APP_ENV must be development, staging, or production');
  const provider = (env.AWWO_PI_PROVIDER ?? (llmgateOnly ? 'llmgate' : '')).trim();
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
  let defaultInput;
  try { defaultInput = profileInput(env.AWWO_PI_INPUT === undefined || env.AWWO_PI_INPUT.trim() === '' ? undefined : env.AWWO_PI_INPUT.split(',').map((kind) => kind.trim())); }
  catch { throw new Error('AWWO_PI_INPUT must be text or text,image'); }
  const configured = loadProfiles(env.AWWO_PI_MODELS_JSON, env, Object.freeze({ id: model, provider, model, protocol: providerProtocol(provider), apiKey, baseURL, contextWindow, maxTokens, input: defaultInput }), missing);
  let catalog;
  const thinking = thinkingSetting(env);
  try {
    catalog = applyBedrockPromptCache(bedrockCatalogProfiles('pi', env).map(profile => workerBedrockProfile(profile, thinking)), bedrockPromptCacheModels(env));
  }
  catch (error) { throw new Error(`Bedrock catalog configuration is invalid: ${error.message}`); }
  for (const id of thinking?.models ?? []) {
    if (!catalog.some(profile => profile.id === id && profile.thinkingBudget)) {
      throw new Error(`AWWO_PI_BEDROCK_THINKING_MODELS names ${id}, which is not a Claude model this worker serves through Bedrock with room for the budget`);
    }
  }
  if (catalog.some(profile => configured.some(item => item.id === profile.id)) || configured.length + catalog.length > MAX_CATALOG_MODELS) {
    throw new Error('Bedrock catalog models must have unique IDs and fit the 256-model catalog');
  }
  const models = Object.freeze([...configured, ...catalog]);
  const platformProviders = parsePlatformProviders(env.AWWO_PLATFORM_PROVIDERS);
  // Provider labels may name the protocol adapter; only the URL chooses the destination.
  // Bedrock is a second operator destination only where the platform policy names it.
  if (llmgateOnly && models.some(profile => profile.provider !== 'bedrock' && profile.baseURL !== DEFAULTS.llmgate)) {
    throw new Error('AWWO_LLMGATE_ONLY requires the LLM Gate endpoint for every model profile');
  }
  if (llmgateOnly && models.some(profile => profile.provider === 'bedrock') && !platformProviders.includes('bedrock')) {
    throw new Error('AWWO_LLMGATE_ONLY allows Bedrock profiles only when AWWO_PLATFORM_PROVIDERS includes bedrock');
  }
  assertOperatorOnlyBedrock(userCredentials, models);
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
    llmgateOnly,
    // What health claims: the destinations these profiles reach, within the policy checked above.
    platformProviders: platformProvidersInUse(platformProviders, models),
    ready: userCredentials ? token.length >= 32 && !/[\r\n]/.test(token) : missing.length === 0,
    missing: Object.freeze([...new Set(missing)]),
  });
}

export function publicHealth(config, activeRuns = 0) {
  return {
    status: config.ready ? 'ready' : 'unconfigured',
    ready: config.ready,
    userCredentials: config.userCredentials === true,
    ...platformHealth(config.llmgateOnly === true, config.platformProviders ?? ['llmgate']),
    configured: config.ready,
    provider: config.provider || null,
    model: config.model || null,
    models: config.models.filter((profile) => profile.id && profile.provider).map((profile) => ({
      id: profile.id,
      name: profile.name ?? profile.model,
      providerModel: profile.model,
      protocol: profile.protocol,
      provider: profile.provider,
      runtime: 'pi',
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxTokens,
      maxContextTextBytes: Math.max(0, profile.contextWindow - profile.maxTokens - 256),
      messageOverheadBytes: 32,
      // What the model takes; the API shows pictures only to a model listing 'image' (vision).
      input: [...(profile.input ?? ['text'])],
    })),
    // This worker takes a run's pictures ("images") and shows them to the models whose input lists 'image'.
    imageInput: true,
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
  const allowed = new Set(['runId', 'tenantId', 'sessionId', 'prompt', 'messages', 'systemPrompt', 'userModel', 'model', 'runtime', 'images']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Invalid request fields');
  }
  if (value.images !== undefined) {
    if (!Array.isArray(value.images) || value.images.length < 1 || value.images.length > INPUT_LIMITS.images) throw new Error('Invalid images');
    for (const image of value.images) {
      if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some((key) => !['name', 'mimeType', 'data'].includes(key))
        || typeof image.name !== 'string' || !image.name || image.name.length > 200 || !IMAGE_TYPES.has(image.mimeType)
        || typeof image.data !== 'string' || image.data.length % 4 !== 0 || !BASE64.test(image.data)) throw new Error('Invalid images');
      const bytes = Buffer.byteLength(image.data, 'base64');
      if (bytes < 1 || bytes > INPUT_LIMITS.imageBytes) throw new Error('Invalid images');
    }
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
