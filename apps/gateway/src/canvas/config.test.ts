import { describe, expect, it } from 'vitest';
import { loadCanvasPlannerConfig } from './config.js';

describe('canvas planner configuration', () => {
  it('uses local Codex only by default in development', () => {
    expect(loadCanvasPlannerConfig({}).provider).toBe('codex');
    expect(loadCanvasPlannerConfig({ APP_ENV: 'development' }).provider).toBe('codex');
    for (const APP_ENV of ['staging', 'production']) expect(loadCanvasPlannerConfig({ APP_ENV }).provider).toBe('disabled');
  });
  it('keeps one explicit configuration schema across environments', () => {
    expect(loadCanvasPlannerConfig({ APP_ENV: 'staging', SUPERCLAW_CANVAS_PLANNER_PROVIDER: 'codex', SUPERCLAW_CANVAS_PLANNER_MODEL: ' selected-model ', SUPERCLAW_CANVAS_PLANNER_TIMEOUT_MS: '45000', SUPERCLAW_CANVAS_PLANNER_CLI_PATH: 'C:/tools/codex.exe' })).toEqual({ provider: 'codex', cliPath: 'C:/tools/codex.exe', model: 'selected-model', timeoutMs: 45000 });
    expect(loadCanvasPlannerConfig({}).model).toBeUndefined();
    expect(loadCanvasPlannerConfig({ SUPERCLAW_CANVAS_PLANNER_PROVIDER: 'disabled' }).provider).toBe('disabled');
  });
  it('accepts openai-compatible HTTP provider configuration', () => {
    expect(loadCanvasPlannerConfig({
      APP_ENV: 'production',
      SUPERCLAW_CANVAS_PLANNER_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-llmgate-test',
      OPENAI_BASE_URL: 'https://api.clawhunt.site/v1/',
      SUPERCLAW_CANVAS_PLANNER_MODEL: 'claude-sonnet-4-6',
    })).toEqual({
      provider: 'openai',
      cliPath: 'codex',
      model: 'claude-sonnet-4-6',
      timeoutMs: 120000,
      baseUrl: 'https://api.clawhunt.site/v1',
      apiKey: 'sk-llmgate-test',
    });
  });
  it('rejects invalid values without echoing them', () => {

    for (const env of [{ APP_ENV: 'SECRET' }, { SUPERCLAW_CANVAS_PLANNER_PROVIDER: 'SECRET' }, { SUPERCLAW_CANVAS_PLANNER_TIMEOUT_MS: 'SECRET' }]) {
      expect(() => loadCanvasPlannerConfig(env)).toThrow();
      try { loadCanvasPlannerConfig(env); } catch (error) { expect(String(error)).not.toContain('SECRET'); }
    }
  });
});
