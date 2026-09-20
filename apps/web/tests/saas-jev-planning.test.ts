import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureSaaSCanvas, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { requestJevPlan, applyJevPlan, readJevPlannerStatus } from '../src/canvas/jevPlanning';
import { createSessionNode, emptyDocument, type SessionNode } from '../src/canvas/canvasDoc';
import type { JevRequest } from '../src/saas/jev';

const tenant = { id: 'jev-tenant', name: 'Workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const status = { provider: 'typesafe', model: 'jev-1.13.0', configured: true, enabled: true, canEvaluate: true,
  questionTypes: ['noul', 'choice', 'score'], limits: { maxQuestions: 16, maxRequestBytes: 65536 } };
const runtime = { configured: true, available: true, models: [
  { runtime: 'pi', id: 'shared-model', label: 'Platform model' },
  { runtime: 'openai-agents', id: 'shared-model', label: 'Platform model' },
], runtimes: ['pi', 'openai-agents'].map(id => ({ id, available: true, configured: true, tools: [], supportsEffortSelection: false })) };
const signal = () => new AbortController().signal;
type Overrides = Record<string, string>;
function answer(request: JevRequest, selections: Overrides) {
  return { model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 }, future_metadata: true,
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const choice = selections[id] || Object.keys(question.criteria)[0];
      return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])), future_field: 1 }];
    })) };
}
function mock(options: { first?: Overrides; second?: Overrides; status?: unknown; runtime?: unknown; response?: (body: JevRequest, index: number) => Response | Promise<Response> } = {}) {
  const requests: JevRequest[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    expect(init.credentials).toBe('include');
    if (url.endsWith('/runtime')) return Response.json(options.runtime || runtime);
    if (url.endsWith('/typesafe')) return Response.json(options.status || status);
    expect(url).toBe(`/api/v1/tenants/${tenant.id}/typesafe/evaluations`);
    const body = JSON.parse(String(init.body)) as JevRequest;
    requests.push(body);
    if (options.response) return options.response(body, requests.length);
    return Response.json(answer(body, requests.length === 1
      ? { intent: 'add', role_1: 'market_0', role_2: 'template_1', role_3: 'market_0', ...options.first }
      : { compatibility: 'compatible', model_0: 'model_1', model_1: 'model_0', topology: 'sequential', order: 'order_1', ...options.second }));
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, fetch };
}
beforeEach(() => configureSaaSCanvas({ tenant, canvasId: 'canvas' }));
afterEach(() => { clearSaaSCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reads honest availability from the tenant status and real catalog without inference', async () => {
  const fake = mock();
  expect(await readJevPlannerStatus()).toEqual({ available: true, provider: 'typesafe', model: 'jev-1.13.0' });
  expect(fake.requests).toHaveLength(0);
  expect(fake.fetch).toHaveBeenCalledTimes(2);
});

it('uses two real Choice batches, preserves existing nodes and assigns exact runtime/model pairs only to new roles', async () => {
  const fake = mock();
  const old = { ...createSessionNode('llm', { x: 4, y: 7 }), id: 'existing', persona: 'PRIVATE-PERSONA', preview: 'PRIVATE-TRANSCRIPT',
    agentRef: { source: 'workspace' as const, agentId: 'saved-agent' }, binding: { companyId: tenant.id, agentId: 'saved-agent', agentName: 'Keep' }, issueId: 'saved-session' };
  const doc = { ...emptyDocument(), nodes: [old] };
  const original = structuredClone(doc);
  const result = await requestJevPlan('安排产品设计与负责人复核', doc, [], signal());
  expect(fake.requests).toHaveLength(2);
  expect(Object.keys(fake.requests[0].questions)).toHaveLength(4);
  expect(Object.keys(fake.requests[0].questions.role_1.criteria)).toHaveLength(16); // 15 roles + omit
  expect(Object.keys(fake.requests[1].questions)).toHaveLength(5); // deduplicated to two roles
  expect(result).toMatchObject({ evaluations: 2, model: 'jev-1.13.0', usage: { input_tokens: 20, output_tokens: 4 } });
  expect(result.modelAssignments).toEqual([
    { ref: 'jev_role_1', runtime: 'pi', model: 'shared-model' },
    { ref: 'jev_role_2', runtime: 'openai-agents', model: 'shared-model' },
  ]);
  const applied = applyJevPlan(doc, result);
  expect(applied.addedNodeIds).toHaveLength(2);
  expect(applied.doc.nodes[0]).toEqual(old);
  const created = applied.doc.nodes.slice(1) as SessionNode[];
  expect(created[0].title).toBe('前端开发');
  expect(created[1].persona).toContain('--- BEGIN ORIGINAL ROLE SOURCE ---');
  expect(created[1].persona).toContain('does not install its skills');
  for (const node of created) {
    expect(node.binding).toBeNull();
    expect(node.issueId).toBeNull();
    expect(node.agentRef).toBeUndefined();
    expect(node.contract!.inputs.find(field => field.id === 'brief')?.value).toBe('安排产品设计与负责人复核');
    expect(node.contract!.inputs.some(field => field.id === 'api' || field.id === 'schema')).toBe(false);
    expect(node.contract!.outputs.map(field => ({ id: field.id, type: field.type }))).toEqual([{ id: 'result', type: 'markdown' }]);
  }
  expect(applied.doc.edges).toEqual([expect.objectContaining({ fromNode: created[0].id, toNode: created[1].id, fromPort: 'out:result', toPort: 'in:context' })]);
  expect(doc).toEqual(original);
  expect(JSON.stringify(fake.requests)).not.toMatch(/PRIVATE-PERSONA|PRIVATE-TRANSCRIPT|saved-session|saved-agent/);
  expect(fake.requests.every(request => Object.keys(request).sort().join() === 'questions,state')).toBe(true);
});

it.each(['unsupported', 'clarify', 'omit'])('does not apply an unsupported or missing-role decision (%s), or spend a second call', async decision => {
  const fake = mock({ first: decision === 'omit' ? { role_1: 'omit' } : { intent: decision } });
  const doc = emptyDocument();
  const result = await requestJevPlan('修改现有画布', doc, [], signal());
  expect(result.plan.operations).toEqual([]);
  expect(result.modelAssignments).toEqual([]);
  expect(result.plan.summary).toContain('未修改');
  expect(fake.requests).toHaveLength(1);
  expect(applyJevPlan(doc, result).addedNodeIds).toEqual([]);
});

it('does not silently replace an explicitly required unavailable model', async () => {
  const fake = mock({ second: { compatibility: 'unavailable' } });
  const result = await requestJevPlan('使用指定但未配置的模型', emptyDocument(), [], signal());
  expect(fake.requests).toHaveLength(2);
  expect(result.plan.operations).toEqual([]);
  expect(result.plan.summary).toContain('未替换模型');
});

it('uses the sole real candidate without asking a one-option Choice and creates independent parallel nodes', async () => {
  const fake = mock({ runtime: { ...runtime, models: runtime.models.slice(0, 1) }, second: { topology: 'parallel' } });
  const doc = emptyDocument();
  const result = await requestJevPlan('安排独立角色', doc, [], signal());
  expect(Object.keys(fake.requests[1].questions).sort()).toEqual(['compatibility', 'order', 'topology']);
  expect(result.modelAssignments.every(model => model.runtime === 'pi' && model.model === 'shared-model')).toBe(true);
  expect(applyJevPlan(doc, result).doc.edges).toEqual([]);
});

it('supports one role and one model with only the required compatibility judgment in the second batch', async () => {
  const fake = mock({ runtime: { ...runtime, models: runtime.models.slice(0, 1) }, first: { role_1: 'template_0', role_2: 'omit', role_3: 'omit' } });
  const doc = emptyDocument();
  const result = await requestJevPlan('只安排一个执行角色', doc, [], signal());
  expect(Object.keys(fake.requests[1].questions)).toEqual(['compatibility']);
  expect(result.modelAssignments).toHaveLength(1);
  expect(applyJevPlan(doc, result).addedNodeIds).toHaveLength(1);
});

it('fails closed for stale, copied or tampered proposals and never assigns an existing node', async () => {
  mock(); const doc = emptyDocument();
  const result = await requestJevPlan('安排新角色', doc, [], signal());
  expect(() => applyJevPlan(doc, { ...result })).toThrow(/失效/);
  result.modelAssignments[0].ref = 'existing';
  expect(() => applyJevPlan(doc, result)).toThrow(/失效/);
  result.modelAssignments[0].ref = 'jev_role_1';
  const changed = { ...doc, nodes: [createSessionNode('llm', { x: 0, y: 0 })] };
  expect(() => applyJevPlan(changed, result)).toThrow(/失效/);
  configureSaaSCanvas({ tenant: { ...tenant, id: 'other' }, canvasId: 'canvas' });
  expect(() => applyJevPlan(doc, result)).toThrow(/失效/);
});

it('does not retry a failed second evaluation or fall back to the Pi planner', async () => {
  const fake = mock({ response: (body, index) => index === 1 ? Response.json(answer(body, { intent: 'add', role_1: 'template_0', role_2: 'omit', role_3: 'omit' }))
    : Response.json({ error: { code: 'typesafe_rate_limited', message: 'raw service details' } }, { status: 429 }) });
  await expect(requestJevPlan('安排工作', emptyDocument(), [], signal())).rejects.toThrow(/频率或并发/);
  expect(fake.requests).toHaveLength(2);
  expect(fake.fetch.mock.calls.every(([url]) => !url.includes('/plan'))).toBe(true);
});

it('refuses disabled service, missing execution models and reader access before inference', async () => {
  let fake = mock({ status: { ...status, enabled: false, canEvaluate: false } });
  await expect(requestJevPlan('安排工作', emptyDocument(), [], signal())).rejects.toThrow(/未启用/);
  expect(fake.requests).toHaveLength(0);
  fake = mock({ runtime: { ...runtime, models: [] } });
  await expect(requestJevPlan('安排工作', emptyDocument(), [], signal())).rejects.toThrow(/没有可用/);
  expect(fake.requests).toHaveLength(0);
  configureSaaSCanvas({ tenant: { ...tenant, role: 'reader' }, canvasId: 'canvas' });
  const before = fake.fetch.mock.calls.length;
  await expect(requestJevPlan('安排工作', emptyDocument(), [], signal())).rejects.toThrow(/不能提交/);
  expect(fake.fetch).toHaveBeenCalledTimes(before);
});

it('enforces prompt and encoded request limits without truncating the user goal or sending a paid request', async () => {
  const fake = mock();
  await expect(requestJevPlan('x'.repeat(8001), emptyDocument(), [], signal())).rejects.toThrow(/8000/);
  expect(fake.fetch).not.toHaveBeenCalled();
  await expect(requestJevPlan('安排工作', emptyDocument(), [{ id: 'prior', role: 'user', content: '汉'.repeat(30000) }], signal())).rejects.toThrow(/大小限制/);
  expect(fake.requests).toHaveLength(0);
});

it.each([{ kind: 'cancel', batch: 1 }, { kind: 'workspace', batch: 1 }, { kind: 'cancel', batch: 2 }, { kind: 'workspace', batch: 2 }])('cancels batch $batch on $kind without another call', async ({ kind, batch }) => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let paid = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/runtime')) return Response.json(runtime);
    if (url.endsWith('/typesafe')) return Response.json(status);
    paid++;
    if (paid < batch) return Response.json(answer(JSON.parse(String(init.body)), { intent: 'add', role_1: 'template_0', role_2: 'omit', role_3: 'omit' }));
    entered();
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  }));
  const pending = requestJevPlan('安排工作', emptyDocument(), [], controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started;
  if (kind === 'cancel') controller.abort(); else configureSaaSCanvas({ tenant, canvasId: 'other-canvas' });
  await rejected;
  expect(paid).toBe(batch);
});
