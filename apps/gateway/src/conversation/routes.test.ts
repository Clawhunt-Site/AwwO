import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createConversationRouter, type ConversationRouterDeps } from './routes.js';
import type { CompanyEventSource } from './stream.js';
import type { LiveEventFrame } from './run-stream.js';
import { createGatewayApp } from '../app.js';
import { ConversationOperationConflictError } from './operation-store.js';

const TOKEN = 'test-token';
const streamEventDelta = (text: string) =>
  JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) + '\n';
const log = (runId: string, chunk: string): LiveEventFrame => ({ type: 'heartbeat.run.log', payload: { runId, stream: 'stdout', chunk } });
const status = (runId: string, s: string): LiveEventFrame => ({ type: 'heartbeat.run.status', payload: { runId, status: s } });

function fakeSource(events: LiveEventFrame[]): CompanyEventSource {
  let closed = false;
  return {
    close() {
      closed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        if (closed) return;
        yield e;
      }
    },
  };
}

const RUN = { runId: 'r-1', status: 'running', agentId: 'ag-1', adapterType: 'claude_local' as string | null };

function deps(overrides: Partial<ConversationRouterDeps> = {}): ConversationRouterDeps {
  return {
    dispatcher: {
      dispatch: async () => ({ status: 'dispatched', issueId: 'iss-1', agentId: 'ag-1', run: RUN }) as any,
      findActiveRun: async () => null,
    },
    openEventSource: () => fakeSource([log('r-1', streamEventDelta('你好')), status('r-1', 'succeeded')]),
    controlToken: TOKEN,
    runDiscoveryAttempts: 2,
    runDiscoveryDelayMs: 1, // fast discovery in tests (no real 4s wait)
    ...overrides,
  };
}

async function serve(d: ConversationRouterDeps, peer?: string): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  if (peer) app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: peer }); next(); });
  // Keep the other production mounts present: their /api-wide parsers must not
  // consume conversation bodies before this router can authenticate them.
  app.use(createGatewayApp({
    upstream: { health: async () => ({ reachable: true, status: 200 }) },
    automationRouter: express.Router(),
    missionRouter: express.Router(),
    missionDispatchRouter: express.Router(),
    conversationRouter: createConversationRouter(d),
  }));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const url = (base: string) => `${base}/api/conversations/co-1/agents/ag-1/messages`;

describe('createConversationRouter', () => {
  it('guards settlement by the existing auth boundary and passes the exact native run identity', async () => {
    const runId = '55555555-5555-4555-8555-555555555555';
    const receipt = { confirmed: true as const, status: 'failed', holdId: 'hold-1', stoppedAutomaticRunIds: [] };
    const settleConversationRun = vi.fn(async () => receipt);
    const s = await serve(deps({ dispatcher: { ...deps().dispatcher, settleConversationRun } }));
    const endpoint = `${s.base}/api/conversations/co-1/agents/ag-1/issues/iss-1/settle`;
    try {
      expect((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId }) })).status).toBe(401);
      expect(settleConversationRun).not.toHaveBeenCalled();
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN }, body: JSON.stringify({ runId }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(receipt);
      expect(settleConversationRun).toHaveBeenCalledWith({ companyId: 'co-1', agentId: 'ag-1', issueId: 'iss-1', runId });
    } finally { await s.close(); }
  });

  it('rejects invalid settlement IDs and surfaces an unconfirmed native hold as 409', async () => {
    const settleConversationRun = vi.fn(async () => ({ confirmed: false as const, detail: 'newer user turn' }));
    const s = await serve(deps({ dispatcher: { ...deps().dispatcher, settleConversationRun } }));
    const endpoint = `${s.base}/api/conversations/co-1/agents/ag-1/issues/iss-1/settle`;
    const headers = { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN };
    try {
      expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ runId: 'arbitrary' }) })).status).toBe(400);
      expect(settleConversationRun).not.toHaveBeenCalled();
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ runId: '55555555-5555-4555-8555-555555555555' }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ confirmed: false, detail: 'newer user turn' });
    } finally { await s.close(); }
  });

  it('refuses to construct without a control token', () => {
    expect(() => createConversationRouter(deps({ controlToken: '' }))).toThrow(/controlToken/);
  });

  it('401 without the control token', async () => {
    const s = await serve(deps());
    try {
      const res = await fetch(url(s.base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }) });
      expect(res.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('claims an operation before opening SSE and returns a real 409 on request mismatch', async () => {
    const prepareConversationOperation = vi.fn(async () => { throw new ConversationOperationConflictError(); });
    const d = deps({ dispatcher: { ...deps().dispatcher, prepareConversationOperation } });
    const source = vi.spyOn(d, 'openEventSource');
    const s = await serve(d);
    try {
      const response = await fetch(url(s.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ message: 'hi', operationId: '11111111-1111-4111-8111-111111111111' }),
      });
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: 'operation_conflict' });
      expect(source).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('prepares a durable operation without opening an event source or dispatching upstream', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const prepareConversationOperation = vi.fn(async () => ({
      created: true,
      snapshot: { mutationStarted: false, deliveryConfirmed: false },
    } as any));
    const d = deps({ dispatcher: { ...deps().dispatcher, prepareConversationOperation } });
    const dispatch = vi.spyOn(d.dispatcher, 'dispatch');
    const source = vi.spyOn(d, 'openEventSource');
    const s = await serve(d);
    try {
      const response = await fetch(`${s.base}/api/conversations/co-1/agents/ag-1/operations/${operationId}/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ message: 'hi', issueId: 'iss-1' }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ operationId, prepared: true, mutationStarted: false, deliveryConfirmed: false });
      expect(prepareConversationOperation).toHaveBeenCalledWith({
        companyId: 'co-1', agentId: 'ag-1', message: 'hi', issueId: 'iss-1', operationId,
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(source).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('keeps operation recovery behind the same loopback and token gate', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const readConversationOperation = vi.fn(async () => ({
      operationId, state: 'accepted' as const, issueId: 'iss-1', runId: null,
      terminal: false, status: null, output: '', outputAvailable: false, detail: null,
    }));
    const s = await serve(deps({ dispatcher: { ...deps().dispatcher, readConversationOperation } }));
    const operationUrl = `${s.base}/api/conversations/co-1/agents/ag-1/operations/${operationId}`;
    try {
      expect((await fetch(operationUrl)).status).toBe(401);
      const response = await fetch(operationUrl, { headers: { 'x-superclaw-gateway-token': TOKEN } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ operationId, state: 'accepted', issueId: 'iss-1' });
      expect(readConversationOperation).toHaveBeenCalledWith({ companyId: 'co-1', agentId: 'ag-1', operationId });
    } finally { await s.close(); }
  });

  it('returns only a complete company-scoped transcript from the index store', async () => {
    const listMessages = vi.fn(async () => ([{ body: 'first prompt', source: 'issue_description' }]));
    const indexStore = {
      listMessages,
      listConversations: vi.fn(async () => []),
      ensureConversationLabel: vi.fn(async () => null),
    } as any;
    const s = await serve(deps({ indexStore }));
    try {
      const response = await fetch(`${s.base}/api/conversations/co-1/issues/iss-1/messages`, {
        headers: { 'x-superclaw-gateway-token': TOKEN },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        issueId: 'iss-1', messages: [{ body: 'first prompt', source: 'issue_description' }], complete: true,
      });
      expect(listMessages).toHaveBeenCalledWith('co-1', 'iss-1');
    } finally { await s.close(); }
  });

  const invalidBodies = [
    { label: 'malformed', body: '{"message":SECRET-invalid' },
    { label: 'oversized', body: JSON.stringify({ message: 'x'.repeat(128 * 1024) }) },
  ];

  it.each(invalidBodies)('authenticates before parsing $label JSON with a missing or invalid token', async ({ body }) => {
    const d = deps();
    const dispatch = vi.spyOn(d.dispatcher, 'dispatch');
    const source = vi.spyOn(d, 'openEventSource');
    const s = await serve(d);
    try {
      for (const token of [undefined, 'incorrect-token']) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token) headers['x-superclaw-gateway-token'] = token;
        const response = await fetch(url(s.base), { method: 'POST', headers, body });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'unauthorized' });
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(source).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(invalidBodies)('checks the socket peer before parsing $label JSON even with a valid token', async ({ body }) => {
    const d = deps();
    const dispatch = vi.spyOn(d.dispatcher, 'dispatch');
    const s = await serve(d, '203.0.113.20');
    try {
      const response = await fetch(url(s.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN, 'x-forwarded-for': '127.0.0.1' },
        body,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'conversation API is loopback-only' });
      expect(dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each([
    { ...invalidBodies[0]!, status: 400, error: 'invalid_json' },
    { ...invalidBodies[1]!, status: 413, error: 'request_too_large' },
  ])('returns a bounded JSON error for authorized $label requests', async ({ body, status, error }) => {
    const d = deps();
    const dispatch = vi.spyOn(d.dispatcher, 'dispatch');
    const s = await serve(d);
    try {
      const response = await fetch(url(s.base), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN }, body,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('preserves the 16000-character limit for valid UTF-8 input after moving the parser', async () => {
    const d = deps();
    const dispatch = vi.spyOn(d.dispatcher, 'dispatch');
    const s = await serve(d);
    try {
      const message = '中'.repeat(16000);
      const response = await fetch(url(s.base), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ message }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('event: done');
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ message }));
      const tooLong = await fetch(url(s.base), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ message: `${message}中` }),
      });
      expect(tooLong.status).toBe(400);
      expect(await tooLong.json()).toEqual({ error: 'message exceeds 16000 chars' });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('400 when the message is empty', async () => {
    const s = await serve(deps());
    try {
      const res = await fetch(url(s.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ message: '   ' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('proxies a scoped native stop and returns success only after dispatcher confirmation', async () => {
    const cancelConversationRun = vi.fn(async () => ({ ok: true as const, confirmed: true as const, cancelled: true, status: 'cancelled', holdId: 'hold-1' }));
    const d = deps({ dispatcher: { ...deps().dispatcher, cancelConversationRun } });
    const s = await serve(d);
    try {
      const response = await fetch(`${s.base}/api/conversations/co-1/agents/ag-1/issues/iss-1/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ runId: 'run-1' }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ confirmed: true, cancelled: true, status: 'cancelled' });
      expect(cancelConversationRun).toHaveBeenCalledWith({ companyId: 'co-1', agentId: 'ag-1', issueId: 'iss-1', runId: 'run-1' });
    } finally { await s.close(); }
  });

  it('does not claim Stop when native cancellation cannot be confirmed', async () => {
    const cancelConversationRun = vi.fn(async () => ({ ok: false as const, confirmed: false as const, detail: 'native stop timeout' }));
    const d = deps({ dispatcher: { ...deps().dispatcher, cancelConversationRun } });
    const s = await serve(d);
    try {
      const response = await fetch(`${s.base}/api/conversations/co-1/agents/ag-1/issues/iss-1/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN }, body: '{}',
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: 'native_stop_unconfirmed' });
    } finally { await s.close(); }
  });

  it('streams a real turn as SSE: accepted → status → delta → done', async () => {
    const s = await serve(deps());
    try {
      const res = await fetch(url(s.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ message: '帮我看下登录' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expect(text).toContain('event: accepted');
      expect(text).toContain('"runId":"r-1"');
      expect(text).toContain('event: delta');
      expect(text).toContain('"text":"你好"');
      expect(text).toContain('event: done');
      expect(text).toContain('"status":"succeeded"');
    } finally {
      await s.close();
    }
  });

  it('honest no_run when the agent never starts a visible run', async () => {
    const s = await serve(
      deps({
        dispatcher: {
          dispatch: async () => ({ status: 'queued', issueId: 'iss-1', agentId: 'ag-1', detail: 'delivered' }) as any,
          findActiveRun: async () => null,
        },
        openEventSource: () => fakeSource([]),
      }),
    );
    try {
      const res = await fetch(url(s.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-superclaw-gateway-token': TOKEN },
        body: JSON.stringify({ message: 'hi' }),
      });
      const text = await res.text();
      expect(text).toContain('event: no_run');
      expect(text).not.toContain('event: done'); // never fabricate a completion
    } finally {
      await s.close();
    }
  });
});
