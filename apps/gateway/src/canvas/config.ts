export interface CanvasPlannerConfig { provider: 'codex' | 'disabled'; cliPath: string; model?: string; timeoutMs: number }
export function loadCanvasPlannerConfig(env: NodeJS.ProcessEnv = process.env): CanvasPlannerConfig {
  const appEnv = env.APP_ENV?.trim().toLowerCase() || 'development';
  if (!['development', 'staging', 'production'].includes(appEnv)) throw new Error('APP_ENV must be development, staging or production');
  const provider = env.SUPERCLAW_CANVAS_PLANNER_PROVIDER?.trim() || (appEnv === 'development' ? 'codex' : 'disabled');
  if (provider !== 'codex' && provider !== 'disabled') throw new Error('SUPERCLAW_CANVAS_PLANNER_PROVIDER must be codex or disabled');
  const timeoutMs = Number(env.SUPERCLAW_CANVAS_PLANNER_TIMEOUT_MS?.trim() || 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('SUPERCLAW_CANVAS_PLANNER_TIMEOUT_MS must be between 1000 and 300000');
  const cliPath = env.SUPERCLAW_CANVAS_PLANNER_CLI_PATH?.trim() || 'codex';
  const model = env.SUPERCLAW_CANVAS_PLANNER_MODEL?.trim();
  if (cliPath.length > 4096 || /[\r\n\0]/.test(cliPath)) throw new Error('Invalid SUPERCLAW_CANVAS_PLANNER_CLI_PATH');
  if (model && (model.length > 200 || /[\r\n\0]/.test(model))) throw new Error('Invalid SUPERCLAW_CANVAS_PLANNER_MODEL');
  return { provider, cliPath, timeoutMs, ...(model ? { model } : {}) };
}
