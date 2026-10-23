import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TEMPLATES, createAgentTemplate } from '../src/canvas/agentTemplates';
import { createFormNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { buildPlanningContext, loadLastPlanDuration, loadPlanningConversation, PLANNING_STORAGE_KEY, readPlannerStatus, requestCanvasPlan,
  saveLastPlanDuration, savePlanningConversation, type PlanningMessage, type PlanProgress } from '../src/canvas/canvasPlanning';
import { planNewNodeModel } from '../src/canvas/canvasPlan';
import { DEFAULT_NEW_NODE_MODEL, newNodeModelOf } from '../src/canvas/planNewNodeModel';
import { configureCanvasStorage } from '../src/canvas/canvasStorage';
import { appendTurn, resetAllSessions } from '../src/canvas/sessions';

vi.mock('../src/chatAutomations', () => ({ gatewayApiBase: () => '/fixture-gateway' }));

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); resetAllSessions(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetAllSessions(); });

const validPlan = { version: 1, summary: '新增一个任务组件。', operations: [{ type: 'add_node', ref: 'task', templateId: 'general' }] };
const requestSignal = () => new AbortController().signal;
const message = (index: number): PlanningMessage => ({ id: `m-${index}`, role: 'user', content: `planning-message-${index}` });

function contextSection(context: string, heading: string): unknown {
  const start = context.indexOf(`${heading}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(context.slice(start + heading.length + 1).split('\n\n')[0]);
}

function privateRuntimeDocument(): CanvasDocument {
  const node: SessionNode = {
    ...createAgentTemplate('frontend', { x: 70, y: 90 }), id: 'frontend-node', persona: 'USER_PERSONA_ALLOWED',
    binding: { companyId: 'PRIVATE_COMPANY', agentId: 'PRIVATE_AGENT', agentName: 'PRIVATE_AGENT_NAME' },
    runtime: 'PRIVATE_RUNTIME', model: 'PRIVATE_MODEL', effort: 'PRIVATE_EFFORT', issueId: 'PRIVATE_ISSUE',
    preview: 'PRIVATE_PREVIEW', activeThreadId: 'default',
    lastOutput: { text: 'PRIVATE_CURRENT_ARTIFACT', source: 'run', at: 1 },
    threads: [{ id: 'default', title: 'PRIVATE_THREAD_TITLE', issueId: 'PRIVATE_THREAD_ISSUE', draft: 'PRIVATE_THREAD_DRAFT',
      preview: 'PRIVATE_THREAD_PREVIEW', createdAt: 1, lastOutput: { text: 'PRIVATE_HISTORY_ARTIFACT', source: 'run', at: 1 } }],
  };
  node.contract!.inputs[0].value = 'USER_INPUT_CONTEXT_ALLOWED';
  node.contract!.outputs[0].value = 'PRIVATE_OUTPUT_DRAFT';
  const form = createFormNode({ x: 0, y: 0 });
  form.fields = [{ id: 'form-input', label: '人工输入', value: 'FORM_INPUT_ALLOWED' }];
  form.lastOutput = { text: 'PRIVATE_FORM_ARTIFACT', source: 'run', at: 1 };
  appendTurn(node.id, { role: 'agent', text: 'PRIVATE_LIVE_TRANSCRIPT' });
  return { ...emptyDocument(), nodes: [node, form] };
}

describe('canvas planner context', () => {
  it('exposes the editable review policy and data/feedback distinction without any runtime state', () => {
    const doc = privateRuntimeDocument();
    doc.execution = { mode: 'review', maxRounds: 3, reviewerNodeId: 'frontend-node', verdictFieldId: 'approved' };
    doc.edges = [
      { id: 'data', fromNode: 'source', fromPort: 'out:page', toNode: 'frontend-node', toPort: 'in:brief', dataType: 'text' },
      { id: 'feedback', fromNode: 'frontend-node', fromPort: 'out:review', toNode: 'source', toPort: 'in:feedback', dataType: 'text', kind: 'feedback' },
    ];
    (doc.nodes[0] as SessionNode).contract!.outputs[0].type = 'html';
    const context = buildPlanningContext(doc, []);
    const graph = contextSection(context, '当前画布：') as { execution: unknown; edges: unknown[] };
    expect(graph.execution).toEqual(doc.execution);
    expect(graph.edges).toMatchObject([{ id: 'data', kind: 'data' }, { id: 'feedback', kind: 'feedback' }]);
    expect(context).toContain('set_execution');
    expect(context).toContain('set_edge_kind');
    expect(context).toContain('"html"');
    expect(context).not.toContain('PRIVATE_');
    const legacy = contextSection(buildPlanningContext(emptyDocument(), []), '当前画布：') as { execution: unknown };
    expect(legacy.execution).toEqual({ mode: 'workflow' });
  });

  it('includes real template schemas and editable graph inputs while excluding runtime identities, transcripts and output values', () => {
    const doc = privateRuntimeDocument();
    const context = buildPlanningContext(doc, []);
    const templates = contextSection(context, '组件模板：') as Array<{ id: string; inputs: unknown[]; outputs: unknown[] }>;
    expect(templates.map(template => template.id)).toEqual(AGENT_TEMPLATES.map(template => template.id));
    const frontend = AGENT_TEMPLATES.find(template => template.id === 'frontend')!;
    expect(templates.find(template => template.id === 'frontend')).toMatchObject({
      inputs: frontend.inputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
      outputs: frontend.outputs.map(({ id, label, type, required }) => ({ id, label, type, required })),
    });
    const graph = contextSection(context, '当前画布：') as { nodes: Array<Record<string, unknown>> };
    expect(graph.nodes[0]).toMatchObject({ id: 'frontend-node', templateId: 'frontend', persona: 'USER_PERSONA_ALLOWED' });
    expect(context).toContain('USER_INPUT_CONTEXT_ALLOWED');
    expect(context).toContain('FORM_INPUT_ALLOWED');
    expect(context).not.toContain('PRIVATE_');
    expect(graph.nodes[0]).not.toHaveProperty('binding');
    expect(graph.nodes[0]).not.toHaveProperty('threads');
    expect(graph.nodes[0]).not.toHaveProperty('lastOutput');
    expect((graph.nodes[0].outputs as Array<Record<string, unknown>>).every(field => !Object.hasOwn(field, 'value'))).toBe(true);
    // Building context must not sanitize the actual project or discard its local evidence.
    expect((doc.nodes[0] as SessionNode).lastOutput?.text).toBe('PRIVATE_CURRENT_ARTIFACT');
  });

  // From 2026-10-16 to 10-19 20 of production's 22 timeouts were a model call that had not written a word when its time
  // came: the way on is another model, not a smaller task (owner 2026-10-21), where the planner can set one (review
  // 2026-10-21: with no model list it has no set_model, and the work split or narrowed stays its way on).
  it('tells a planner that can set models to give a node that ran out of time another model, and one that cannot to split it', () => {
    const models = { models: [{ id: 'm', name: 'M' }] };
    const zh = buildPlanningContext(emptyDocument(), [], 'zh', [], models);
    const en = buildPlanningContext(emptyDocument(), [], 'en', [], models);
    expect(zh).toContain('修复失败：太长拆分或缩小交付，超时换模型，');
    expect(zh).not.toContain('太长或超时就拆分工作或缩小交付');
    expect(en).toContain('an answer too long → split the work or narrow the delivery; out of time → another model;');
    expect(en).not.toContain('too long or out of time');
    expect(buildPlanningContext(emptyDocument(), [], 'zh')).toContain('修复失败：太长或超时就拆分工作或缩小交付，');
    expect(buildPlanningContext(emptyDocument(), [], 'zh')).not.toContain('超时换模型');
    expect(buildPlanningContext(emptyDocument(), [], 'en')).toContain('an answer too long or out of time → split the work or narrow the delivery;');
    expect(buildPlanningContext(emptyDocument(), [], 'en')).not.toContain('another model;');
  });

  // A hosted planner sizes each node's task by its model's output limit (planning_limits.go); the nodes a plan adds without
  // set_model take the model the reader chose for the canvas assistant (withAssistantModel), which it is told by id, a
  // model only a user may choose too, which the set_model list leaves out but the nodes still take.
  it('names the model the nodes a plan adds take, apart from the models set_model offers', () => {
    const models = [{ id: 'bedrock.claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'qwen', name: 'Qwen' }];
    const en = buildPlanningContext(emptyDocument(), [], 'en', [], { models, newNodeModel: 'bedrock.claude-opus-5-5' });
    expect(en).toContain('\n\nNew Agent nodes you add without set_model run on: "bedrock.claude-opus-5-5"\n\n');
    expect(contextSection(en, 'Models a node can run (for set_model; "default" is the workspace default):')).toEqual(models);
    expect(buildPlanningContext(emptyDocument(), [], 'zh', [], { models, newNodeModel: 'qwen' }))
      .toContain('\n\n新增且未用 set_model 指定模型的 Agent 节点使用："qwen"\n\n');
    expect(buildPlanningContext(emptyDocument(), [], 'en', [], { models, newNodeModel: 'deepseek-flash' }))
      .toContain('\n\nNew Agent nodes you add without set_model run on: "deepseek-flash"\n\n');
    // Nodes that run the workspace default say so, by the id the planner's limits give it.
    expect(buildPlanningContext(emptyDocument(), [], 'en', [], { models, newNodeModel: DEFAULT_NEW_NODE_MODEL }))
      .toContain('\n\nNew Agent nodes you add without set_model run on: "default"\n\n');
    for (const extras of [{ models }, { models, newNodeModel: '' }, {}]) {
      expect(buildPlanningContext(emptyDocument(), [], 'en', [], extras)).not.toContain('New Agent nodes you add');
    }
  });

  it('uses only the last ten planning messages and excludes their local identifiers and extra metadata', () => {
    const messages = Array.from({ length: 13 }, (_, index) => ({ ...message(index), localOnly: 'PRIVATE_METADATA' }));
    const context = buildPlanningContext(emptyDocument(), messages);
    const history = contextSection(context, '对话上下文（仅作意图参考，以当前画布为准）：') as Array<Record<string, unknown>>;
    expect(history).toEqual(messages.slice(-10).map(({ role, content }) => ({ role, content })));
    expect(history.every(item => !Object.hasOwn(item, 'id'))).toBe(true);
    expect(context).not.toContain('PRIVATE_METADATA');
  });
});

describe('canvas planner client requests', () => {
  it('accepts an AI proposal for bounded review and HTML edits through the normal request gate', async () => {
    const proposal = { version: 1, summary: '添加互审与 HTML 交付约束', operations: [
      { type: 'update_field', nodeId: 'frontend-node', side: 'output', fieldId: 'delivery', changes: { type: 'html' } },
      { type: 'set_edge_kind', edgeId: 'existing-feedback', kind: 'feedback' },
      { type: 'set_execution', mode: 'review', maxRounds: 3, reviewerNodeId: 'reviewer', verdictFieldId: 'approved' },
    ] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ plan: proposal }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestCanvasPlan('让两个 Agent 相互验证，交付 HTML', privateRuntimeDocument(), [], requestSignal())).toEqual(proposal);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends the prompt and bounded context to the configured gateway and parses a valid plan', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ plan: `\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\`` }) });
    vi.stubGlobal('fetch', fetchMock);
    const signal = requestSignal();
    expect(await requestCanvasPlan('请组织这个项目', privateRuntimeDocument(), [], signal)).toEqual(validPlan);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/fixture-gateway/canvas/plan');
    // The client reads either a progress stream or a single JSON body, so it accepts both.
    expect(options).toMatchObject({ method: 'POST', credentials: 'include', signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' } });
    const body = JSON.parse(options.body);
    expect(body.prompt).toBe('请组织这个项目');
    expect(body.context).toContain('USER_INPUT_CONTEXT_ALLOWED');
    expect(body.context).not.toContain('PRIVATE_');
  });

  it('surfaces the real service error and uses a fallback when the HTTP body is unreadable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: '未配置可用的规划模型' }) })
      .mockResolvedValueOnce({ ok: false, json: async () => { throw new SyntaxError('not JSON'); } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('未配置可用的规划模型');
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('画布规划服务暂时不可用');
  });

  it('rejects successful HTTP responses that contain no plan or an invalid plan', async () => {
    // A body with no plan at all is a broken planner rather than a bad plan, so it fails on the
    // first attempt without spending another run.
    const absent = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: 'ok' }) });
    vi.stubGlobal('fetch', absent);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('未返回有效方案');
    expect(absent).toHaveBeenCalledOnce();
    // A plan that does not conform is the model's structure going wrong, which is retried once and
    // then reported. Both attempts have to be answered or the assertion would only prove the mock ran dry.
    const nonconforming = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ plan: { ...validPlan, version: 9 } }) });
    vi.stubGlobal('fetch', nonconforming);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('仅支持协议 version: 1');
    expect(nonconforming).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation and network errors without retrying or returning a fabricated plan', async () => {
    const abort = new DOMException('request cancelled', 'AbortError');
    const network = new TypeError('network unavailable');
    const fetchMock = vi.fn().mockRejectedValueOnce(abort).mockRejectedValueOnce(network);
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toBe(abort);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toBe(network);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads planner availability only from explicit boolean readiness and string metadata', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: true, provider: 'Configured provider' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ available: 'true', provider: 99, error: '缺少配置' }) });
    vi.stubGlobal('fetch', fetchMock);
    const signal = requestSignal();
    expect(await readPlannerStatus(signal)).toEqual({ available: true, provider: 'Configured provider', error: undefined });
    expect(fetchMock.mock.calls[0]).toEqual(['/fixture-gateway/canvas/planner', { credentials: 'include', signal }]);
    expect(await readPlannerStatus()).toEqual({ available: false, provider: '', error: '缺少配置' });
  });

  it.each(['http', 'network', 'malformed'] as const)('reports %s status failures as unavailable', async failure => {
    const fetchMock = failure === 'network' ? vi.fn().mockRejectedValue(new TypeError('offline'))
      : vi.fn().mockResolvedValue({ ok: failure !== 'http', json: async () => failure === 'malformed' ? null : {} });
    vi.stubGlobal('fetch', fetchMock);
    expect(await readPlannerStatus()).toEqual({ available: false, provider: '', error: '画布规划服务未连接。启动本地规划服务后可重试。' });
  });
});

describe('planning conversation recovery', () => {
  it('recovers safely from malformed JSON or a null conversation without throwing or writing during the read', () => {
    for (const raw of ['{broken', 'null']) {
      localStorage.setItem(PLANNING_STORAGE_KEY, raw);
      expect(loadPlanningConversation()).toEqual({ draft: '', messages: [] });
      expect(localStorage.getItem(PLANNING_STORAGE_KEY)).toBe(raw);
    }
  });

  it('keeps valid conversation entries and filters damaged roles, content and non-string statuses', () => {
    const valid = [message(1), { ...message(2), role: 'assistant', status: 'applied' }];
    localStorage.setItem(PLANNING_STORAGE_KEY, JSON.stringify({ draft: 123, messages: [
      valid[0], { id: 'bad-role', role: 'system', content: 'bad' }, { id: 'bad-content', role: 'user', content: 42 },
      { ...message(3), status: 'unknown' }, { ...message(4), status: false }, { ...message(5), content: 'x'.repeat(20_001) }, valid[1],
    ] }));
    expect(loadPlanningConversation()).toEqual({ draft: '', messages: valid });
  });

  it('bounds restored drafts and conversation history while retaining the latest messages', () => {
    const messages = Array.from({ length: 70 }, (_, index) => message(index));
    savePlanningConversation({ draft: 'a'.repeat(8_100), messages });
    const loaded = loadPlanningConversation();
    expect(loaded.draft).toHaveLength(8_000);
    expect(loaded.messages).toEqual(messages.slice(-60));
  });

  it('keeps storage failures from preventing in-memory use of the planner', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    expect(() => savePlanningConversation({ draft: '保留这条草稿', messages: [message(1)] })).not.toThrow();
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
    expect(loadPlanningConversation()).toEqual({ draft: '', messages: [] });
  });
});

// The nodes a plan adds take the model its planner sized them for: the one the request its run was made from named, which
// the host's plan frame says (canvasBridge.ts), a resume's too, whatever the reader chose since.
describe('the model a plan sized the nodes it adds for', () => {
  const sseResponse = (frames: unknown[]) => ({
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: new ReadableStream<Uint8Array>({ start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    } }),
  });
  const models = [{ id: 'qwen', name: 'Qwen' }];

  it('is read back from the line a context writes, in either language, and from nothing else', () => {
    for (const locale of ['en', 'zh'] as const) {
      expect(newNodeModelOf(buildPlanningContext(emptyDocument(), [], locale, [], { models, newNodeModel: 'deepseek-flash' }))).toBe('deepseek-flash');
      expect(newNodeModelOf(buildPlanningContext(emptyDocument(), [], locale, [], { models, newNodeModel: DEFAULT_NEW_NODE_MODEL }))).toBe('default');
      expect(newNodeModelOf(buildPlanningContext(emptyDocument(), [], locale, [], { models }))).toBeUndefined();
    }
    expect(newNodeModelOf('New Agent nodes you add without set_model run on: not json')).toBeUndefined();
    expect(newNodeModelOf(undefined)).toBeUndefined();
  });

  it('is the one the host’s plan frame names, a resume’s too, and none where no frame names one', async () => {
    const frames = vi.fn().mockResolvedValueOnce(sseResponse([{ type: 'plan', plan: validPlan, newNodeModel: 'qwen' }]))
      .mockResolvedValueOnce(sseResponse([{ type: 'plan', plan: validPlan, newNodeModel: 'bedrock.claude-opus-5-5' }]))
      .mockResolvedValueOnce(sseResponse([{ type: 'plan', plan: validPlan, newNodeModel: DEFAULT_NEW_NODE_MODEL }]))
      .mockResolvedValueOnce(sseResponse([{ type: 'plan', plan: validPlan }]));
    vi.stubGlobal('fetch', frames);
    const resume = { models, newNodeModel: 'qwen', recoveryOperationId: 'operation-1' };
    expect(planNewNodeModel(await requestCanvasPlan('生成', emptyDocument(), [], requestSignal(), 'zh', undefined, { models, newNodeModel: 'qwen' }))).toBe('qwen');
    // A resume's request named the model chosen then, whatever this request names now.
    expect(planNewNodeModel(await requestCanvasPlan('生成', emptyDocument(), [], requestSignal(), 'zh', undefined, resume))).toBe('bedrock.claude-opus-5-5');
    expect(planNewNodeModel(await requestCanvasPlan('生成', emptyDocument(), [], requestSignal(), 'zh', undefined, resume))).toBe('default');
    // A request stored before requests named one says nothing: the reader's choice now stands (planComponentModel).
    expect(planNewNodeModel(await requestCanvasPlan('生成', emptyDocument(), [], requestSignal(), 'zh', undefined, resume))).toBeUndefined();
    // A host without plan frames says nothing either, whatever its own request named.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ plan: validPlan }) }));
    expect(planNewNodeModel(await requestCanvasPlan('生成', emptyDocument(), [], requestSignal(), 'zh', undefined, { models, newNodeModel: 'qwen' }))).toBeUndefined();
  });
});

describe('a malformed plan or a run a provider fault cut short gets exactly one more attempt', () => {
  const sseResponse = (frames: unknown[]) => ({
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: new ReadableStream<Uint8Array>({ start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    } }),
  });
  const planFrames = [{ type: 'progress', stage: 'streaming', characters: 12, nodes: 1 }, { type: 'plan', plan: validPlan }];
  /** A run the model service broke off after it had written part of its plan. */
  const brokeOff = (code: string, error: string, extra: Record<string, unknown> = {}) =>
    [{ type: 'progress', stage: 'running' }, { type: 'progress', stage: 'streaming', characters: 40 }, { type: 'error', code, error, ...extra }];
  /** A stream whose frames each arrive at a moment of the faked clock (Date only), each after the page has read the one
   * before: a stream pulls its next chunk as soon as one is read, so each waits for a real task first. */
  const timedResponse = (frames: Array<[number, unknown]>) => ({
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: new ReadableStream<Uint8Array>({ async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 0));
      const next = frames.shift();
      if (!next) { controller.close(); return; }
      vi.setSystemTime(next[0]);
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(next[1])}\n\n`));
    } }),
  });

  it('retries a plan the host rejected as malformed and reports the retry to the caller', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([{ type: 'error', code: 'invalid_canvas_plan', error: '规划结果无效' }]))
      .mockResolvedValueOnce(sseResponse(planFrames));
    vi.stubGlobal('fetch', fetchMock);
    const reported: { stage: string; characters: number; nodes: number }[] = [];
    expect(await requestCanvasPlan('生成', emptyDocument(), [], requestSignal(), 'zh', p => reported.push({ ...p }))).toEqual(validPlan);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry has to be visible: an attempt that silently starts over looks like a stall.
    const retry = reported.find(entry => entry.stage === 'retrying');
    expect(retry).toBeDefined();
    // Counts restart with the attempt; carrying the abandoned one's totals would report work that
    // no longer exists.
    expect(retry).toMatchObject({ characters: 0, nodes: 0 });
    // The second attempt then reports its own progress and ends in validation, so the caller sees a
    // continuous account of what is happening rather than a gap.
    const afterRetry = reported.slice(reported.indexOf(retry!) + 1);
    expect(afterRetry.some(entry => entry.stage === 'streaming' && entry.characters > 0)).toBe(true);
    expect(afterRetry.at(-1)?.stage).toBe('validating');
  });

  it('gives up after the second attempt rather than looping on a persistently broken model', async () => {
    // Built per call: a stream body is consumed once, so reusing one response would make the second
    // attempt look like a lost connection instead of a second malformed plan.
    const fetchMock = vi.fn().mockImplementation(async () => sseResponse([{ type: 'error', code: 'invalid_canvas_plan', error: '规划结果无效' }]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('规划结果无效');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a run out of room, a deadline, a rate limit, a quota rejection or a cancelled run', async () => {
    for (const frame of [
      // A model that wrote its whole output budget would only do so again (runs.go plannerSpentOutput).
      { type: 'error', code: 'output_limit', error: '规划太长' },
      { type: 'error', code: 'run_timeout', error: '规划超时' },
      { type: 'error', code: 'provider_rate_limited', error: '请求过多' },
      { type: 'error', code: 'quota_exceeded', error: '额度不足' },
      { type: 'error', code: 'reasoning_only_output', error: '只返回了思考过程' },
      { type: 'error', error: '规划连接中断' },
    ]) {
      const fetchMock = vi.fn().mockImplementation(async () => sseResponse([frame]));
      vi.stubGlobal('fetch', fetchMock);
      await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it('retries once a run a provider fault cut short, and says why it runs again', async () => {
    for (const code of ['runtime_failed', 'provider_unavailable', 'runtime_stream_ended']) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(sseResponse(brokeOff(code, '模型执行失败')))
        .mockResolvedValueOnce(sseResponse(planFrames));
      vi.stubGlobal('fetch', fetchMock);
      const reported: PlanProgress[] = [];
      expect(await requestCanvasPlan('生成', emptyDocument(), [], requestSignal(), 'zh', p => reported.push({ ...p }))).toEqual(validPlan);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The report that starts the retry says it follows a model service that failed partway, not a malformed plan;
      // the second run's own reports then follow, and say nothing of it.
      const retry = reported.findIndex(entry => entry.stage === 'retrying');
      expect(reported[retry]).toMatchObject({ retry: 'provider', attempt: 2, characters: 0 });
      expect(reported.slice(retry + 1).every(entry => entry.retry === undefined && entry.attempt === 2)).toBe(true);
      expect(reported.at(-1)?.stage).toBe('validating');
    }
  });

  it('gives up after a second provider fault and reports the first', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(brokeOff('runtime_failed', '第一次失败')))
      .mockResolvedValueOnce(sseResponse(brokeOff('runtime_failed', '第二次失败')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('第一次失败');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks only once more in all, and says the failure that names its cause', async () => {
    // A malformed plan first says what the model produced; a provider fault first says nothing of it, so the second
    // attempt's own cause is said: a malformed plan, or a plan out of room, which sending again would only repeat.
    for (const [first, second, said] of [['invalid_canvas_plan', 'runtime_failed', 'first'], ['runtime_failed', 'invalid_canvas_plan', 'second'],
      ['runtime_failed', 'output_limit', 'second'], ['runtime_failed', 'provider_unavailable', 'first']]) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(sseResponse(brokeOff(first, `first ${first}`)))
        .mockResolvedValueOnce(sseResponse(brokeOff(second, `second ${second}`)))
        .mockResolvedValueOnce(sseResponse(planFrames));
      vi.stubGlobal('fetch', fetchMock);
      await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow(said === 'first' ? `first ${first}` : `second ${second}`);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('does not ask again for a run that had not begun answering when its model service failed', async () => {
    // A refusal of the request itself (a throttle, a credential, a check of the request) comes at once, with nothing
    // written, after the worker has already asked the model's other route.
    for (const frames of [[{ type: 'error', code: 'runtime_failed', error: '模型执行失败' }],
      [{ type: 'progress', stage: 'queued' }, { type: 'progress', stage: 'running' }, { type: 'error', code: 'runtime_failed', error: '模型执行失败' }]]) {
      const fetchMock = vi.fn().mockImplementation(async () => sseResponse(frames));
      vi.stubGlobal('fetch', fetchMock);
      await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('模型执行失败');
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it('asks again for a run silent for ten seconds, and not for one past three minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.parse('2026-10-23T12:00:00Z');
      for (const [failedAt, asked] of [[t0 + 9_000, 1], [t0 + 10_000, 2], [t0 + 179_000, 2], [t0 + 180_000, 1]] as const) {
        const fetchMock = vi.fn()
          .mockResolvedValueOnce(timedResponse([[t0, { type: 'progress', stage: 'running' }], [failedAt, { type: 'error', code: 'runtime_failed', error: '模型执行失败' }]]))
          .mockResolvedValueOnce(sseResponse(planFrames));
        vi.stubGlobal('fetch', fetchMock);
        const result = requestCanvasPlan('生成', emptyDocument(), [], requestSignal());
        if (asked === 2) await expect(result).resolves.toEqual(validPlan);
        else await expect(result).rejects.toThrow('模型执行失败');
        expect(fetchMock).toHaveBeenCalledTimes(asked);
      }
    } finally { vi.useRealTimers(); }
  });

  it('asks again for a worker stream that ended however soon, and not past three minutes', async () => {
    // A stream that ended without an answer is never a refusal of the request: only the upper bound applies.
    let fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse([{ type: 'progress', stage: 'running' }, { type: 'error', code: 'runtime_stream_ended', error: '运行中断' }]))
      .mockResolvedValueOnce(sseResponse(planFrames));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).resolves.toEqual(validPlan);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.parse('2026-10-23T12:00:00Z');
      fetchMock = vi.fn()
        .mockResolvedValueOnce(timedResponse([[t0, { type: 'progress', stage: 'running' }], [t0 + 180_000, { type: 'error', code: 'runtime_stream_ended', error: '运行中断' }]]))
        .mockResolvedValueOnce(sseResponse(planFrames));
      vi.stubGlobal('fetch', fetchMock);
      await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('运行中断');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('does not ask again for a run the host attached to rather than started', async () => {
    for (const code of ['runtime_failed', 'invalid_canvas_plan']) {
      const fetchMock = vi.fn().mockImplementation(async () => sseResponse(brokeOff(code, '规划失败', { recovered: true })));
      vi.stubGlobal('fetch', fetchMock);
      await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('规划失败');
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it('does not retry a provider fault after the caller cancelled, nor that of a recovered run', async () => {
    const controller = new AbortController();
    let fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      return sseResponse(brokeOff('runtime_failed', '模型执行失败'));
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], controller.signal)).rejects.toThrow('模型执行失败');
    expect(fetchMock).toHaveBeenCalledOnce();
    // A recovery replays its run's own request, as a malformed plan's is not asked again either.
    fetchMock = vi.fn().mockImplementation(async () => sseResponse(brokeOff('runtime_failed', '模型执行失败')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal(), 'zh', undefined, { recoveryOperationId: 'op-1' }))
      .rejects.toThrow('模型执行失败');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry after the caller cancelled, even for a malformed plan', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort();
      return sseResponse([{ type: 'error', code: 'invalid_canvas_plan', error: '规划结果无效' }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], controller.signal)).rejects.toThrow('规划结果无效');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

});

describe('planning duration expectation', () => {
  afterEach(() => configureCanvasStorage('', '', ''));

  it('keeps the last measured duration per account and workspace, shared by its canvases', () => {
    configureCanvasStorage('user-a', 'tenant-a', 'canvas-1');
    expect(loadLastPlanDuration()).toBeUndefined();
    saveLastPlanDuration(47.6);
    expect(loadLastPlanDuration()).toBe(48);
    // A new canvas in the same workspace is exactly where the first long wait happens.
    configureCanvasStorage('user-a', 'tenant-a', 'canvas-2');
    expect(loadLastPlanDuration()).toBe(48);
    // Another account or workspace never sees it.
    configureCanvasStorage('user-b', 'tenant-a', 'canvas-2');
    expect(loadLastPlanDuration()).toBeUndefined();
    configureCanvasStorage('user-a', 'tenant-b', 'canvas-1');
    expect(loadLastPlanDuration()).toBeUndefined();
  });

  it('ignores values that are not a plausible measurement', () => {
    configureCanvasStorage('user-a', 'tenant-a', 'canvas-1');
    for (const seconds of [0, -3, Number.NaN, 7_200]) saveLastPlanDuration(seconds);
    expect(loadLastPlanDuration()).toBeUndefined();
    localStorage.setItem('awwo.saas:user-a:tenant-a:awwo.canvas.planning.duration.v1', 'soon');
    expect(loadLastPlanDuration()).toBeUndefined();
  });
});
