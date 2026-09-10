export interface CanvasPlannerConfig {
  provider: 'codex' | 'openai' | 'disabled';
  cliPath: string;
  model?: string;
  timeoutMs: number;
  /** OpenAI-compatible HTTP base URL (…/v1). Used when provider=openai. */
  baseUrl?: string;
  /** API key for OpenAI-compatible HTTP. Never logged. */
  apiKey?: string;
}

const DEFAULT_OPENAI_BASE_URL = 'https://api.clawhunt.site/v1';
const DEFAULT_OPENAI_MODEL = 'claude-sonnet-4-6';

export function loadCanvasPlannerConfig(env: NodeJS.ProcessEnv = process.env): CanvasPlannerConfig {
  const appEnv = env.APP_ENV?.trim().toLowerCase() || 'development';
  if (!['development', 'staging', 'production'].includes(appEnv)) throw new Error('APP_ENV must be development, staging or production');
  const provider = env.SUPERCLAW_CANVAS_PLANNER_PROVIDER?.trim() || (appEnv === 'development' ? 'codex' : 'disabled');
  if (provider !== 'codex' && provider !== 'openai' && provider !== 'disabled') {
    throw new Error('SUPERCLAW_CANVAS_PLANNER_PROVIDER must be codex, openai or disabled');
  }
  const timeoutMs = Number(env.SUPERCLAW_CANVAS_PLANNER_TIMEOUT_MS?.trim() || 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('SUPERCLAW_CANVAS_PLANNER_TIMEOUT_MS must be between 1000 and 300000');
  const cliPath = env.SUPERCLAW_CANVAS_PLANNER_CLI_PATH?.trim() || 'codex';
  const model = env.SUPERCLAW_CANVAS_PLANNER_MODEL?.trim()
    || (provider === 'openai' ? (env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL) : undefined);
  if (cliPath.length > 4096 || /[\r\n\0]/.test(cliPath)) throw new Error('Invalid SUPERCLAW_CANVAS_PLANNER_CLI_PATH');
  if (model && (model.length > 200 || /[\r\n\0]/.test(model))) throw new Error('Invalid SUPERCLAW_CANVAS_PLANNER_MODEL');

  if (provider !== 'openai') {
    return { provider, cliPath, timeoutMs, ...(model ? { model } : {}) };
  }

  const baseUrlRaw = (env.SUPERCLAW_CANVAS_PLANNER_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrlRaw) || baseUrlRaw.length > 2048 || /[\r\n\0]/.test(baseUrlRaw)) {
    throw new Error('Invalid OPENAI_BASE_URL / SUPERCLAW_CANVAS_PLANNER_BASE_URL');
  }
  const apiKey = env.OPENAI_API_KEY?.trim() || env.SUPERCLAW_CANVAS_PLANNER_API_KEY?.trim() || '';
  if (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new Error('Invalid OPENAI_API_KEY');
  return { provider, cliPath, timeoutMs, model: model || DEFAULT_OPENAI_MODEL, baseUrl: baseUrlRaw, ...(apiKey ? { apiKey } : {}) };
}
