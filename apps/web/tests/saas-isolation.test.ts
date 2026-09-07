import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureCanvasStorage, canvasStorage, canvasStorageKey } from '../src/canvas/canvasStorage';
import { configureSaaSCanvas, configureSaaSCanvasSave, clearSaaSCanvas, canvasFetch } from '../src/saas/canvasBridge';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocument, saveDocument } from '../src/canvas/canvasDoc';
import { saveRunJournal, loadRunJournal } from '../src/canvas/runJournal';
import { savePlanningConversation, loadPlanningConversation, requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { api, SaaSApiError } from '../src/saas/api';

const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); clearSaaSCanvas(); configureSaaSCanvasSave(null); });

describe('SaaS tenant boundary', () => {
  it('isolates canvas, journal and planning data by account, tenant and canvas', () => {
    configureCanvasStorage('alice', 'tenant-a', 'canvas-a');
    const original = { ...emptyDocument(), updatedAt: 1234 };
    saveDocument(original);
    savePlanningConversation({ draft: 'private A prompt', messages: [] });
    const oldStorage = canvasStorage();
    configureCanvasStorage('alice', 'tenant-b', 'canvas-a');
    expect(loadDocument().updatedAt).not.toBe(1234);
    expect(loadPlanningConversation().draft).toBe('');
    oldStorage.setItem('captured', 'still-a');
    expect(canvasStorage().getItem('captured')).toBeNull();
    configureCanvasStorage('alice', 'tenant-a', 'canvas-a');
    expect(loadDocument().updatedAt).toBe(1234);
    expect(loadPlanningConversation().draft).toBe('private A prompt');
    expect(canvasStorage().getItem('captured')).toBe('still-a');
    expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toBeNull();
    expect(canvasStorageKey('lock')).toContain('alice:tenant-a:canvas-a');
    configureCanvasStorage('bob', 'tenant-a', 'canvas-a');
    expect(loadPlanningConversation().draft).toBe('');
    expect(loadRunJournal()).toBeNull();
  });

  it('never turns a foreign tenant conversation into a request under the active tenant', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await canvasFetch('/gateway-api/conversations/tenant-b/agents/agent-b/messages', { method: 'POST', body: JSON.stringify({ message: 'secret' }) });
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });

  it('uses server session cookies and propagates structured errors', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'conflict', message: '版本冲突' } }), { status: 409 })); vi.stubGlobal('fetch', fetch);
    await expect(api('/tenants/a/canvases/b')).rejects.toMatchObject({ status: 409, code: 'conflict', message: '版本冲突' });
    expect(fetch.mock.calls[0][1].credentials).toBe('include');
    expect(localStorage.length).toBe(0);
  });

  it('flushes the cloud canvas before creating a session and translates real run events', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    const order: string[] = [];
    configureSaaSCanvasSave(async () => { order.push('saved'); });
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      order.push(url);
      if (url.includes('operationId=')) return new Response(JSON.stringify({ items: [] }));
      if (url.endsWith('/sessions')) {
        expect(JSON.parse(init.body as string)).toMatchObject({ canvasId: 'canvas-a', nodeId: 'node-a', agentId: 'agent-a' });
        return new Response(JSON.stringify({ id: 'session-a' }));
      }
      if (url.endsWith('/runs')) {
        expect(JSON.parse(init.body as string)).toEqual({ sessionId: 'session-a', prompt: 'hello', operationId: 'op-a' });
        return new Response(JSON.stringify({ id: 'run-a', sessionId: 'session-a', status: 'queued' }));
      }
      if (url.endsWith('/events')) return new Response('data: {"type":"running"}\n\ndata: {"type":"text_delta","delta":"actual output"}\n\ndata: {"type":"completed","text":"actual output"}\n\n');
      throw new Error(`Unexpected ${url}`);
    }); vi.stubGlobal('fetch', fetch);
    const response = await canvasFetch('/gateway-api/conversations/tenant-a/agents/agent-a/messages', { method: 'POST', headers: { 'X-Awwo-Node-Id': 'node-a' }, body: JSON.stringify({ message: 'hello', operationId: 'op-a' }) });
    const frames = await response.text();
    expect(order[0]).toBe('saved'); expect(frames).toContain('"issueId":"session-a"');
    expect(frames).toContain('"event":"delta","text":"actual output"'); expect(frames).toContain('"event":"done","status":"succeeded"');
    expect(frames.match(/actual output/g)).toHaveLength(1);
  });

  it('refuses execution when cloud persistence cannot complete', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    configureSaaSCanvasSave(async () => { throw new Error('save conflict'); });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await canvasFetch('/gateway-api/conversations/tenant-a/agents/agent-a/messages', { method: 'POST', body: JSON.stringify({ message: 'hello' }) });
    expect(response.ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });

  it('uses an audited Pi planning run and validates its output before exposing a plan', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    configureSaaSCanvasSave(async () => {});
    const plan = { version: 1, summary: '增加后端节点', operations: [{ type: 'add_node', ref: 'backend', templateId: 'backend' }] };
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/plan')) {
        const body = JSON.parse(init.body as string);
        expect(body.prompt).toBe('创建后端'); expect(body.context).toContain('只返回一个 JSON 对象');
        expect(body.operationId).toBeTruthy();
        return new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 });
      }
      return new Response(`data: ${JSON.stringify({ type: 'completed', text: JSON.stringify(plan) })}\n\n`);
    }); vi.stubGlobal('fetch', fetch);
    const result = await requestCanvasPlan('创建后端', emptyDocument(), [], new AbortController().signal);
    expect(result).toEqual(plan);
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/tenants/tenant-a/canvases/canvas-a/plan');
  });

  it('rejects invalid model planning output without changing the canvas', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => {});
    const document = { ...emptyDocument(), updatedAt: 1234 };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/plan')
      ? new Response(JSON.stringify({ id: 'planning-run' }), { status: 202 })
      : new Response('data: {"type":"completed","text":"I already changed everything"}\n\n')));
    await expect(requestCanvasPlan('create', document, [], new AbortController().signal)).rejects.toThrow('不是有效 JSON');
    expect(document).toMatchObject({ updatedAt: 1234, nodes: [], edges: [] });
  });
});
