import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { groupModels, readModelPalette, type ModelPaletteGroup, type ModelProviderGroup } from '../src/canvas/modelPalette';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { runtimeDefinitions, type SaaSRuntimeStatus, type SaaSRuntimeModel } from '../src/saas/runtimeCatalog';

const status = (models: SaaSRuntimeModel[]): SaaSRuntimeStatus => ({ configured: true, available: true, models,
  runtimes: ['pi', 'openai-agents'].map(id => ({ id: id as 'pi' | 'openai-agents', name: id, available: true, configured: true, supportsEffortSelection: false, tools: [] })) });
const model = (id: string, runtime: 'pi' | 'openai-agents' = 'openai-agents', provider = 'openai'): SaaSRuntimeModel => ({ id, name: id, runtime, provider });
const scope = (id = 'workspace', canvasId = 'canvas') => ({ tenant: { id, name: 'Workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 100 }, canvasId });
const byId = (groups: ModelPaletteGroup[], id: ModelProviderGroup) => groups.find(group => group.id === id)!;
const BRAND_ORDER = ['codex', 'claude', 'grok', 'gemini', 'deepseek', 'qwen', 'kimi', 'glm', 'minimax', 'mistral', 'llama', 'nova', 'gemma', 'nemotron', 'clawhunt'];
afterEach(() => { clearSaaSCanvas(); vi.unstubAllGlobals(); });

it('distinguishes actual workspace execution from text models using the runtime capability only', () => {
  const catalog = status([model('qwen', 'pi'), model('qwen', 'openai-agents')]);
  catalog.runtimes![1].workspace = { version: 1, available: true, maxModelCalls: 16 };
  const entries = groupModels(catalog).flatMap(group => group.models);
  expect(entries.map(entry => [entry.runtime, entry.execution, entry.available])).toEqual([
    ['pi', 'text', true], ['openai-agents', 'workspace', true],
  ]);
  catalog.runtimes![1].workspace.available = false;
  expect(groupModels(catalog).flatMap(group => group.models)[1]).toMatchObject({ available: false, execution: 'workspace-unavailable' });
});

it.each([2, 16, 32, 64])('preserves the actual advertised project budget of %i calls', maxModelCalls => {
  const catalog = status([model('qwen')]);
  catalog.runtimes![1].workspace = { version: 1, available: true, maxModelCalls };
  expect(runtimeDefinitions(catalog)[1].workspace?.maxModelCalls).toBe(maxModelCalls);
  expect(groupModels(catalog).flatMap(group => group.models)[0].execution).toBe('workspace');
});

it.each([{ version: 2, available: true, maxModelCalls: 16 }, { version: 1, available: 'true', maxModelCalls: 16 }, { version: 1, available: true, maxModelCalls: 1 }, { version: 1, available: true, maxModelCalls: 65 }, { version: 1, available: true, maxModelCalls: 99 }])('does not invent project execution from malformed workspace capability %j', workspace => {
  const catalog = status([model('codex')]);
  catalog.runtimes![1].workspace = workspace as unknown as NonNullable<SaaSRuntimeStatus['runtimes']>[number]['workspace'];
  expect(groupModels(catalog).flatMap(group => group.models)[0].execution).toBe('text');
});

it('shows every brand group but enables only actual published models, grouping Qwen by its published name, never as Codex', () => {
  const groups = groupModels(status([model('qwen3.8-27b-p6'), model('qwen3.8-27b', 'pi')]));
  expect(groups.map(group => group.id)).toEqual(BRAND_ORDER);
  expect(groups.filter(group => group.id !== 'qwen').every(group => !group.available && !group.models.length && group.reason)).toBe(true);
  const qwen = byId(groups, 'qwen');
  expect(qwen.label).toBe('通义千问 Qwen');
  expect(qwen.models.map(item => item.model)).toEqual(['qwen3.8-27b', 'qwen3.8-27b-p6']);
  expect(qwen.models.every(item => item.available && item.providerGroup === 'qwen' && !('effort' in item))).toBe(true);
  expect(byId(groups, 'clawhunt').label).toBe('ClawHunt · 平台模型');
});

it('groups actual GPT models with Codex and every other published brand with its own group', () => {
  const groups = groupModels(status([model('gpt-5-codex'), model('claude-sonnet'), model('grok-4'), model('gemini-2.5-pro'), model('gpt-5'), model('qwen3.8-27b-p6'), model('opaque-claude-alias', 'pi', 'anthropic')]), 'en');
  expect(groups.filter(group => group.models.length).map(group => [group.id, group.models.length])).toEqual([['codex', 2], ['claude', 2], ['grok', 1], ['gemini', 1], ['qwen', 1]]);
  expect(groups[0].label).toBe('Codex / OpenAI');
  expect(byId(groups, 'qwen').label).toBe('Qwen');
  expect(groups.filter(group => group.models.length).every(group => group.available && group.reason === undefined)).toBe(true);
  expect(byId(groups, 'qwen').models[0].model).toBe('qwen3.8-27b-p6');
});

it('puts every model of the curated Bedrock catalog in its vendor brand group', () => {
  const catalog = JSON.parse(readFileSync(resolve(process.cwd(), '../bedrock-models.json'), 'utf8')) as { models: { id: string; name: string; vendor: string; runtime: 'pi' | 'openai-agents' }[] };
  const brand: Record<string, ModelProviderGroup> = { anthropic: 'claude', openai: 'codex', xai: 'grok', moonshot: 'kimi', deepseek: 'deepseek', qwen: 'qwen',
    zhipu: 'glm', minimax: 'minimax', mistral: 'mistral', meta: 'llama', amazon: 'nova', google: 'gemma', nvidia: 'nemotron' };
  const groups = groupModels(status(catalog.models.map(entry => ({ id: entry.id, name: entry.name, runtime: entry.runtime, provider: 'bedrock' }))), 'en');
  for (const entry of catalog.models) {
    expect(brand[entry.vendor], entry.vendor).toBeDefined();
    expect(byId(groups, brand[entry.vendor]).models.map(item => item.model), entry.name).toContain(entry.id);
  }
  expect(byId(groups, 'clawhunt').models).toEqual([]);
  expect(groups.flatMap(group => group.models)).toHaveLength(catalog.models.length);
});

it.each([['gpt-oss-120b', 'codex'], ['gpt-ossify', 'clawhunt'], ['novatek-1', 'clawhunt'], ['llamaindex-agent', 'clawhunt'], ['Kimi K3', 'kimi'],
  ['deepseek-r1-distill', 'deepseek'], ['Gemma 3 27B', 'gemma'], ['GLM-4.7 Flash', 'glm'], ['Pixtral Large', 'mistral'], ['nemotronic', 'clawhunt']])('recognises %s as %s only from a whole brand word', (name, group) => {
  const groups = groupModels(status([{ ...model('selector'), name }]));
  expect(groups.find(item => item.models.length)?.id).toBe(group);
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
  expect(byId(groups, 'qwen').models.map(item => item.model)).toEqual(['gpt-5-alias', 'qwen-gpt-compatible']);
  expect(byId(groups, 'clawhunt').models.map(item => item.model)).toEqual(['mygpt-5']);
});

it('uses a GPT selector only when the published model name is absent', () => {
  const groups = groupModels(status([{ id: 'gpt-5.6-sol', runtime: 'openai-agents', provider: 'openai' }]));
  expect(groups[0].models[0]).toMatchObject({ label: 'gpt-5.6-sol', model: 'gpt-5.6-sol' });
});

it('separates the published display name from connection labels without changing identity', () => {
  const groups = groupModels(status([{ ...model('private-selector'), name: 'qwen3.8-27b-p6', label: 'qwen3.8-27b-p6 · LLM Gate · primary' }]));
  expect(byId(groups, 'qwen').models[0]).toMatchObject({ displayName: 'qwen3.8-27b-p6', label: 'qwen3.8-27b-p6 · LLM Gate · primary', model: 'private-selector' });
});

it.each(['codex', 'claude', 'grok', 'gemini'])('does not let a %s alias override the published model identity', alias => {
  const groups = groupModels(status([
    { ...model(`${alias}-selection`), name: 'gpt-5.6-sol', label: `${alias} display alias` },
    { ...model(`${alias}-qwen`), name: 'qwen3.8-27b-p6', label: `${alias} compatible` },
  ]));
  expect(groups[0].models.map(item => item.model)).toEqual([`${alias}-selection`]);
  expect(groups.slice(1, 4).every(group => group.models.length === 0)).toBe(true);
  expect(byId(groups, 'qwen').models.map(item => item.model)).toEqual([`${alias}-qwen`]);
});

it('uses provider hints only when no authoritative model name is published', () => {
  const groups = groupModels(status([
    { id: 'opaque-selector', provider: 'anthropic', runtime: 'openai-agents' },
    { ...model('other-alias', 'openai-agents', 'google'), name: 'qwen3.8-27b-p6' },
  ]));
  expect(groups[1].models.map(item => item.model)).toEqual(['opaque-selector']);
  expect(groups[3].models).toEqual([]);
  expect(byId(groups, 'qwen').models.map(item => item.model)).toEqual(['other-alias']);
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
  expect(byId(groups, 'clawhunt').models[0]).toMatchObject({ runtime: 'pi', available: true });
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
