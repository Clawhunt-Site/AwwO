import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { streamAgentConversation, type AgentChatFrame } from '../src/canvasAgentChat';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { configureCanvasStorage } from '../src/canvas/canvasStorage';
import { execAgentViaGateway } from '../src/canvas/runTransport';
import { resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

const tenant = { id: 'admission-workspace', name: 'Admission', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const base = `/api/v1/tenants/${tenant.id}`;
const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'admission-node', issueId: 'session-a',
  binding: { companyId: tenant.id, agentId: 'agent-a', agentName: 'Agent' } };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const operationId = 'admission-operation-1';

beforeEach(() => {
  localStorage.clear(); document.documentElement.lang = 'en'; resetAllSessions();
  configureCanvasStorage('admission-user', tenant.id, 'admission-canvas');
  configureSaaSCanvas({ tenant, canvasId: 'admission-canvas' }); configureSaaSCanvasSave(async () => {});
});
afterEach(() => { clearSaaSCanvas(); resetAllSessions(); vi.unstubAllGlobals(); document.documentElement.lang = ''; });

function serverFailure(status: number, code: string, existing = false) {
  const fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('/runs?operationId=')) return response({ items: existing ? [{ id: 'previous-run', sessionId: node.issueId }] : [] });
    if (url === `${base}/runs` && init.method === 'POST') return response({ error: { code, message: 'Original admission diagnostic' } }, status);
    throw new Error('Unexpected fixture request');
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}

it('preserves the code and proven rejection through the real SaaS bridge and chat client', async () => {
  const fetcher = serverFailure(429, 'quota_exceeded');
  const frames: AgentChatFrame[] = [];
  await streamAgentConversation('/gateway-api', tenant.id, 'agent-a', '2 + 2', frame => frames.push(frame), { issueId: node.issueId!, operationId });
  expect(frames).toEqual([{ event: 'error', code: 'quota_exceeded', detail: expect.stringContaining('quota'), admissionRejected: true }]);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it.each([[429, 'quota_exceeded'], [409, 'session_busy'], [403, 'model_not_allowed']] as const)(
  'settles a confirmed %s/%s rejection without starting recovery or a second run', async (status, code) => {
    const fetcher = serverFailure(status, code);
    const result = await execAgentViaGateway('/gateway-api', node, '2 + 2', { operationId });
    expect(result.ok).toBe(false); expect(result.unconfirmed).not.toBe(true);
    expect(result.detail).not.toContain('page');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  },
);

it.each([[500, 'internal_error', false], [429, 'request_failed', false], [409, 'idempotency_conflict', false], [429, 'quota_exceeded', true]] as const)(
  'keeps uncertain or already existing operations recoverable (%s/%s/existing=%s)', async (status, code, existing) => {
    serverFailure(status, code, existing);
    expect(await execAgentViaGateway('/gateway-api', node, '2 + 2', { operationId })).toMatchObject({ ok: false, unconfirmed: true });
  },
);

it.each(['forbidden-events', 'lost-events', 'broken-stream', 'lost-admission'] as const)(
  'keeps %s recoverable without retrying the paid submission', async failure => {
    const fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes('/runs?operationId=')) return response({ items: [] });
      if (url === `${base}/runs` && init.method === 'POST') {
        if (failure === 'lost-admission') throw new TypeError('network disconnected');
        return response({ id: 'accepted-run', sessionId: node.issueId, status: 'queued' }, 202);
      }
      if (url.endsWith('/events')) {
        if (failure === 'lost-events') throw new TypeError('network disconnected');
        if (failure === 'broken-stream') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Stream disconnected')); } }));
        return response({ error: { code: 'forbidden', message: 'Event read denied' }, admissionRejected: true }, 403);
      }
      throw new Error('Unexpected fixture request');
    });
    vi.stubGlobal('fetch', fetcher);
    const onRunAccepted = vi.fn();
    expect(await execAgentViaGateway('/gateway-api', node, '2 + 2', { operationId, onRunAccepted })).toMatchObject({ ok: false, unconfirmed: true });
    if (failure === 'broken-stream') expect(onRunAccepted).toHaveBeenCalledWith({ issueId: node.issueId, runId: 'accepted-run' });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  },
);
