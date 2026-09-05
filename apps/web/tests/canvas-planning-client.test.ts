import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TEMPLATES, createAgentTemplate } from '../src/canvas/agentTemplates';
import { createFormNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { buildPlanningContext, loadPlanningConversation, PLANNING_STORAGE_KEY, readPlannerStatus, requestCanvasPlan,
  savePlanningConversation, type PlanningMessage } from '../src/canvas/canvasPlanning';
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
  it('sends the prompt and bounded context to the configured gateway and parses a valid plan', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ plan: `\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\`` }) });
    vi.stubGlobal('fetch', fetchMock);
    const signal = requestSignal();
    expect(await requestCanvasPlan('请组织这个项目', privateRuntimeDocument(), [], signal)).toEqual(validPlan);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/fixture-gateway/canvas/plan');
    expect(options).toMatchObject({ method: 'POST', credentials: 'include', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' } });
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: 'ok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ plan: { ...validPlan, version: 9 } }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('未返回有效方案');
    await expect(requestCanvasPlan('生成', emptyDocument(), [], requestSignal())).rejects.toThrow('仅支持协议 version: 1');
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
