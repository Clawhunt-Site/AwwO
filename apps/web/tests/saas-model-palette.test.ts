import { afterEach, expect, it, vi } from 'vitest';
import { groupModels, readModelPalette } from '../src/canvas/modelPalette';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import type { SaaSRuntimeStatus, SaaSRuntimeModel } from '../src/saas/runtimeCatalog';

const status = (models: SaaSRuntimeModel[]): SaaSRuntimeStatus => ({ configured: true, available: true, models,
  runtimes: ['pi', 'openai-agents'].map(id => ({ id: id as 'pi' | 'openai-agents', name: id, available: true, configured: true, supportsEffortSelection: false, tools: [] })) });
const model = (id: string, runtime: 'pi' | 'openai-agents' = 'openai-agents', provider = 'openai'): SaaSRuntimeModel => ({ id, name: id, runtime, provider });
const scope = (id = 'workspace', canvasId = 'canvas') => ({ tenant: { id, name: 'Workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 100 }, canvasId });
afterEach(() => { clearSaaSCanvas(); vi.unstubAllGlobals(); });

it('shows all five groups but enables only actual published models, without treating compatible Qwen as Codex', () => {
  const groups = groupModels(status([model('qwen3.8-27b-p6'), model('qwen3.8-27b', 'pi')]));
  expect(groups.map(group => group.id)).toEqual(['codex', 'claude', 'grok', 'gemini', 'clawhunt']);
  expect(groups.slice(0, 4).every(group => !group.available && !group.models.length && group.reason)).toBe(true);
  expect(groups[4].label).toBe('ClawHunt · 平台模型');
  expect(groups[4].models.map(item => item.model)).toEqual(['qwen3.8-27b', 'qwen3.8-27b-p6']);
  expect(groups[4].models.every(item => item.available && !('effort' in item))).toBe(true);
});

it('groups actual GPT models with Codex while keeping compatible Qwen in the platform group', () => {
  const groups = groupModels(status([model('gpt-5-codex'), model('claude-sonnet'), model('grok-4'), model('gemini-2.5-pro'), model('gpt-5'), model('qwen3.8-27b-p6'), model('opaque-claude-alias', 'pi', 'anthropic')]), 'en');
  expect(groups.map(group => group.models.length)).toEqual([2, 2, 1, 1, 1]);
  expect(groups[0].label).toBe('Codex / OpenAI');
  expect(groups.every(group => group.available && group.reason === undefined)).toBe(true);
  expect(groups[4].models[0].model).toBe('qwen3.8-27b-p6');
});

it.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'openai/gpt-5.6-sol'])('keeps the real GPT model name and selector when grouping %s', name => {
  const entry = { ...model('gateway-selection'), name };
  const groups = groupModels(status([entry]));
  expect(groups[0]).toMatchObject({ id: 'codex', label: 'Codex / OpenAI', available: true });
  expect(groups[0].models).toEqual([expect.objectContaining({
    key: '["openai-agents","gateway-selection"]', label: name,
    model: 'gateway-selection', runtime: 'openai-agents', providerGroup: 'codex',
  })]);
  expect(entry.name).toBe(name);
  expect(entry.id).toBe('gateway-selection');
});

it('does not classify compatible models by a GPT alias, display label, or substring', () => {
  const entries = [
    { ...model('gpt-5-alias'), name: 'qwen3.8-27b-p6', label: 'GPT compatible Qwen' },
    model('qwen-gpt-compatible'), model('mygpt-5'),
  ];
  const groups = groupModels(status(entries));
  expect(groups[0].models).toEqual([]);
  expect(groups[4].models.map(item => item.model)).toEqual(entries.map(entry => entry.id));
});

it('uses a GPT selector only when the published model name is absent', () => {
  const groups = groupModels(status([{ id: 'gpt-5.6-sol', runtime: 'openai-agents', provider: 'openai' }]));
  expect(groups[0].models[0]).toMatchObject({ label: 'gpt-5.6-sol', model: 'gpt-5.6-sol' });
});

it.each(['codex', 'claude', 'grok', 'gemini'])('does not let a %s alias override the published model identity', alias => {
  const groups = groupModels(status([
    { ...model(`${alias}-selection`), name: 'gpt-5.6-sol', label: `${alias} display alias` },
    { ...model(`${alias}-qwen`), name: 'qwen3.8-27b-p6', label: `${alias} compatible` },
  ]));
  expect(groups[0].models.map(item => item.model)).toEqual([`${alias}-selection`]);
  expect(groups.slice(1, 4).every(group => group.models.length === 0)).toBe(true);
  expect(groups[4].models.map(item => item.model)).toEqual([`${alias}-qwen`]);
});

it('uses provider hints only when no authoritative model name is published', () => {
  const groups = groupModels(status([
    { id: 'opaque-selector', provider: 'anthropic', runtime: 'openai-agents' },
    { ...model('other-alias', 'openai-agents', 'google'), name: 'qwen3.8-27b-p6' },
  ]));
  expect(groups[1].models.map(item => item.model)).toEqual(['opaque-selector']);
  expect(groups[3].models).toEqual([]);
  expect(groups[4].models.map(item => item.model)).toEqual(['other-alias']);
});

it('uses distinct runtime/model keys, removes exact duplicates, and never turns an advertised default into an explicit effort', () => {
  const entry = { ...model('same-model'), reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' };
  const items = groupModels(status([entry, { ...entry }, model('same-model', 'pi')])).flatMap(group => group.models);
  expect(items).toHaveLength(2); expect(new Set(items.map(item => item.key)).size).toBe(2);
  expect(items.every(item => item.effort === undefined)).toBe(true);
  expect(items.map(item => JSON.parse(item.key))).toEqual([['pi', 'same-model'], ['openai-agents', 'same-model']]);
  expect(() => groupModels(status([entry, { ...entry, provider: 'anthropic' }]))).toThrow('冲突');
});

it('keeps unavailable models visible but disabled and accepts only the Pi legacy missing-runtime convention', () => {
  const catalog = status([model('claude-test'), { id: 'legacy', provider: 'openai' }]);
  catalog.runtimes![1].available = false; catalog.runtimes![1].reason = 'Worker unavailable';
  const groups = groupModels(catalog);
  expect(groups[1].models[0]).toMatchObject({ available: false, reason: 'Worker unavailable' });
  expect(groups[1].available).toBe(false);
  expect(groups[4].models[0]).toMatchObject({ runtime: 'pi', available: true });
  expect(groupModels(null).every(group => !group.available && !group.models.length)).toBe(true);
  const unavailable = status([model('configured-false')]); unavailable.runtimes![1].configured = false;
  expect(groupModels(unavailable).flatMap(group => group.models)[0].available).toBe(false);
});

it('reads only the active workspace runtime endpoint and returns a fresh scoped palette', async () => {
  configureSaaSCanvas(scope('a/b'));
  const fetch = vi.fn(async () => new Response(JSON.stringify(status([model('qwen')])))); vi.stubGlobal('fetch', fetch);
  const controller = new AbortController(); const result = await readModelPalette(controller.signal);
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]).toEqual(['/api/v1/tenants/a%2Fb/runtime', expect.objectContaining({ signal: controller.signal, credentials: 'include' })]);
  expect(result).toMatchObject({ tenantId: 'a/b', canvasId: 'canvas', models: [expect.objectContaining({ model: 'qwen', available: true })] });
});

it.each(['tenant', 'canvas', 'unmount'])('rejects stale responses after a %s scope change', async change => {
  configureSaaSCanvas(scope()); let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const pending = readModelPalette();
  if (change === 'unmount') clearSaaSCanvas(); else configureSaaSCanvas(scope(change === 'tenant' ? 'other' : 'workspace', change === 'canvas' ? 'other' : 'canvas'));
  resolve(new Response(JSON.stringify(status([model('old')]))));
  await expect(pending).rejects.toThrow('已切换');
});

it('rejects aborts even if transport resolves and propagates authentication errors without stale fallback', async () => {
  configureSaaSCanvas(scope()); let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const controller = new AbortController(); const pending = readModelPalette(controller.signal); controller.abort();
  resolve(new Response(JSON.stringify(status([model('old')])))); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'Sign in' } }), { status: 401 })));
  await expect(readModelPalette()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  clearSaaSCanvas(); await expect(readModelPalette()).rejects.toThrow('请先打开');
});

it('rejects malformed success payloads instead of presenting a fabricated empty catalogue', async () => {
  configureSaaSCanvas(scope());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null')));
  await expect(readModelPalette()).rejects.toThrow('模型目录无效');
});
