import { afterEach, expect, it, vi } from 'vitest';
import type { SaaSRuntimeStatus } from '../src/saas/runtimeCatalog';
import { api, MODEL_MARKS_HEADER } from '../src/saas/api';
import { groupModels } from '../src/canvas/modelPalette';
import { automaticChoices, planModelsOf } from '../src/canvas/userChosenModels';
import { withSandbox } from '../src/canvas/InspectorPanel';
import { createSessionNode, emptyDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { applyCanvasPlan, parseCanvasPlan } from '../src/canvas/canvasPlan';

afterEach(() => { vi.unstubAllGlobals(); });

// ClawHunt's privacy policy (clause 08, 2026-10-21): a request goes to DeepSeek only when a DeepSeek model is selected
// for it, and AwwO never moves a request there by itself. The API marks such a model userChosen; every choice the page
// makes by itself leaves it out, whatever the request says.
const status: SaaSRuntimeStatus = { engine: 'pi', available: true, configured: true,
  runtimes: [{ id: 'pi', name: 'Pi', available: true, configured: true, supportsEffortSelection: false, tools: [] }],
  models: [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', runtime: 'pi', provider: 'deepseek', route: 'gate', userChosen: true },
    { id: 'qwen3.8-27b-p6', name: 'Qwen 3.8', runtime: 'pi', provider: 'llmgate', route: 'free' },
  ] };

it('leaves out the models only a user may choose', () => {
  const entries = [{ id: 'a', userChosen: true }, { id: 'b' }, { id: 'c', userChosen: false }];
  expect(automaticChoices(entries).map(entry => entry.id)).toEqual(['b', 'c']);
  expect(automaticChoices([{ id: 'only', userChosen: true }])).toEqual([]);
});

it('carries the server’s mark into the model palette, and only there', () => {
  const models = groupModels(status, 'en').flatMap(group => group.models);
  expect(models.find(model => model.model === 'deepseek-flash')).toMatchObject({ userChosen: true, available: true });
  expect(models.find(model => model.model === 'qwen3.8-27b-p6')!.userChosen).toBeUndefined();
  expect(automaticChoices(models).map(model => model.model)).toEqual(['qwen3.8-27b-p6']);
});

it('never lets a canvas plan put a node on a model only a user may choose, and says who picks it', () => {
  const palette = groupModels(status, 'en').flatMap(group => group.models);
  const models = planModelsOf(palette);
  expect(models.choices.map(choice => choice.model)).toEqual(['qwen3.8-27b-p6']);
  expect(models.userChosen).toEqual([{ runtime: 'pi', model: 'deepseek-flash', available: true, name: 'DeepSeek V4.1 Flash' }]);
  const page = { ...createAgentTemplate('general', { x: 0, y: 0 }, 'zh'), id: 'page', title: '页面', runtime: 'pi', model: 'qwen3.8-27b-p6' } as SessionNode;
  const plan = (model: string) => parseCanvasPlan({ version: 1, summary: 'S', operations: [{ type: 'set_model', nodeId: 'page', model }] });
  // By id or by name, the reader asking for it included: the node keeps its model, and the reply says the reader picks it.
  for (const model of ['deepseek-flash', 'deepseek v4.1 flash']) {
    const applied = applyCanvasPlan({ ...emptyDocument(), nodes: [page] }, plan(model), 'zh', '把页面改用 DeepSeek', undefined, models);
    expect((applied.doc.nodes[0] as SessionNode).model).toBe('qwen3.8-27b-p6');
    expect(applied.adjustments).toEqual([expect.stringContaining('没有把「页面」改用「DeepSeek V4.1 Flash」：这个模型只能由你自己在节点设置里选，助手不替你选')]);
  }
  // A model the workspace does not have is still said to be missing.
  const missing = applyCanvasPlan({ ...emptyDocument(), nodes: [page] }, plan('gpt-9'), 'zh', '', undefined, models);
  expect(missing.adjustments).toEqual([expect.stringContaining('此工作区现在没有可用的这个模型')]);
});

// A node the reader set on such a model keeps it: a plan may set its reasoning effort there (a lesson's suggestion is
// applied as such a step), which sends no request anywhere it did not go already; the entry it runs on decides the levels.
it('keeps a node the reader set on a model only a user may choose there, at the effort a plan asks for where its entry offers it', () => {
  const offered: SaaSRuntimeStatus = { ...status,
    runtimes: [...status.runtimes, { id: 'openai-agents', name: 'OpenAI Agents', available: true, configured: true, supportsEffortSelection: true, tools: [] }],
    models: [...status.models, { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', runtime: 'openai-agents', provider: 'deepseek', route: 'gate', userChosen: true,
      reasoningEfforts: ['low', 'medium', 'high'] }] };
  const models = planModelsOf(groupModels(offered, 'en').flatMap(group => group.models));
  expect(models.choices.map(choice => choice.model)).toEqual(['qwen3.8-27b-p6']);
  const node = (patch: Partial<SessionNode> = {}) => ({ ...createAgentTemplate('general', { x: 0, y: 0 }, 'zh'), id: 'page', title: '页面',
    runtime: 'openai-agents', model: 'deepseek-flash', effort: 'high', ...patch } as SessionNode);
  const plan = (model: string, effort?: string) => parseCanvasPlan({ version: 1, summary: 'S', operations: [{ type: 'set_model', nodeId: 'page', model, ...(effort ? { effort } : {}) }] });
  const apply = (on: SessionNode, model: string, effort?: string) => applyCanvasPlan({ ...emptyDocument(), nodes: [on] }, plan(model, effort), 'zh', '', undefined, models);
  // By id or by name: the node stays on its model and runtime, at the level asked for.
  for (const model of ['deepseek-flash', 'deepseek v4.1 flash']) {
    const applied = apply(node(), model, 'low');
    expect(applied.doc.nodes[0]).toMatchObject({ runtime: 'openai-agents', model: 'deepseek-flash', effort: 'low' });
    expect(applied.adjustments).toEqual([]);
    expect(applied.modelSetNodeIds).toEqual(['page']);
  }
  // A level its entry does not offer leaves it at the model's own default, saying so.
  const unoffered = apply(node(), 'deepseek-flash', 'xhigh');
  expect(unoffered.doc.nodes[0]).toMatchObject({ model: 'deepseek-flash', effort: '' });
  expect(unoffered.adjustments).toEqual([expect.stringContaining('没有「xhigh」这档思考强度')]);
  // A node set on it on Pi, which offers it no levels, runs it where AwwO runs it (as a canvas run would move it).
  expect(apply(node({ runtime: 'pi', effort: '' }), 'deepseek-flash', 'low').doc.nodes[0]).toMatchObject({ runtime: 'openai-agents', model: 'deepseek-flash', effort: 'low' });
  // Never onto it: a node on another model, or on the workspace default, keeps its own, and the reply says who picks it.
  for (const from of [node({ runtime: 'pi', model: 'qwen3.8-27b-p6', effort: '' }), node({ runtime: '', model: '', effort: '' })]) {
    const refused = apply(from, 'deepseek-flash', 'low');
    expect(refused.doc.nodes[0]).toMatchObject({ runtime: from.runtime, model: from.model, effort: '' });
    expect(refused.adjustments).toEqual([expect.stringContaining('这个模型只能由你自己在节点设置里选，助手不替你选')]);
    expect(refused.modelSetNodeIds).toEqual([]);
  }
  // Kept only where the workspace still runs it: with no runtime ready for it, the node is left as it is.
  const gone = planModelsOf(groupModels({ ...offered, runtimes: offered.runtimes.map(runtime => ({ ...runtime, available: false })) }, 'en')
    .flatMap(group => group.models));
  const left = applyCanvasPlan({ ...emptyDocument(), nodes: [node()] }, plan('deepseek-flash', 'low'), 'zh', '', undefined, gone);
  expect(left.doc.nodes[0]).toMatchObject({ model: 'deepseek-flash', effort: 'high' });
  expect(left.adjustments).toEqual([expect.stringContaining('此工作区现在没有可用的这个模型')]);
});

it('tells the API’s listings that the page honours their userChosen mark', async () => {
  const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  await api('/tenants/t/runtime');
  const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(new Headers(init.headers).get(MODEL_MARKS_HEADER)).toBe('userChosen');
});

it('never moves a node into its sandbox onto a model only a user may choose, but keeps one it was given', () => {
  const node = { ...createSessionNode('llm', { x: 0, y: 0 }), runtime: 'pi', model: 'qwen3.8-27b-p6' };
  const entries = [{ runtime: 'sandbox', model: 'deepseek-flash', available: true, userChosen: true },
    { runtime: 'sandbox', model: 'claude-opus-5', available: true }];
  expect(withSandbox(node, true, entries).model).toBe('claude-opus-5');
  // Nothing else ready: the node keeps its own model rather than land on it.
  expect(withSandbox(node, true, entries.slice(0, 1)).model).toBe('qwen3.8-27b-p6');
  // The reader's own pick stays where the sandbox offers it.
  expect(withSandbox({ ...node, model: 'deepseek-flash' }, true, entries).model).toBe('deepseek-flash');
});
