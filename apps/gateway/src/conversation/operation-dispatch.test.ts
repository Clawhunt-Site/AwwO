import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentConversationDispatcher, type DispatchInput } from './dispatcher.js';
import { ConversationOperationStore, conversationRequestDigest } from './operation-store.js';

const BASE = 'http://127.0.0.1:3100';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const input: DispatchInput = { companyId: 'company-1', agentId: 'agent-1', message: 'build it', operationId: OPERATION_ID };

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function store(): Promise<ConversationOperationStore> {
  return new ConversationOperationStore(await mkdtemp(join(tmpdir(), 'awwo-operation-dispatch-')));
}

function fakeUpstream(initialIssue: Record<string, unknown> | null = null) {
  let issue = initialIssue;
  let creates = 0;
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const label = { id: 'label-operation', companyId: 'company-1', name: `awwo:op:${OPERATION_ID}`, color: '#0f766e' };
  const fetchImpl = (async (raw: string | URL, init?: RequestInit) => {
    const url = new URL(String(raw));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    if (method === 'GET' && url.pathname === '/api/companies/company-1/labels') return response([label]);
    if (method === 'GET' && url.pathname === '/api/companies/company-1/issues') return response(issue ? [issue] : []);
    if (method === 'POST' && url.pathname === '/api/companies/company-1/issues') {
      creates += 1;
      issue = { id: 'issue-1', companyId: 'company-1', assigneeAgentId: 'agent-1', status: 'todo', labelIds: body?.labelIds };
      return response(issue, 201);
    }
    if (method === 'GET' && url.pathname === '/api/issues/issue-1') return response(issue);
    if (method === 'GET' && url.pathname === '/api/issues/issue-1/live-runs') return response([]);
    if (method === 'GET' && url.pathname === '/api/issues/issue-1/runs') return response([]);
    return response({ error: 'unexpected request' }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls, creates: () => creates, issue: () => issue };
}

async function seedStarted(operationStore: ConversationOperationStore): Promise<void> {
  await operationStore.claim({
    operationId: OPERATION_ID,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: null,
    requestDigest: conversationRequestDigest(input),
  });
  await operationStore.recordLabel(OPERATION_ID, 'label-operation');
  await operationStore.beginMutation(OPERATION_ID);
}

describe('durable conversation operation dispatch', () => {
  it('lets only one concurrent gateway instance create the first issue', async () => {
    const operationStore = await store();
    const upstream = fakeUpstream();
    const opts = { operationStore, fetchImpl: upstream.fetchImpl, operationDiscoveryAttempts: 20, operationDiscoveryDelayMs: 1 };
    const first = new AgentConversationDispatcher(BASE, opts);
    const second = new AgentConversationDispatcher(BASE, opts);

    const results = await Promise.all([first.dispatch(input), second.dispatch(input)]);

    expect(results.every(result => result.status === 'queued')).toBe(true);
    expect(upstream.creates()).toBe(1);
    const create = upstream.calls.find(call => call.method === 'POST' && call.path === '/api/companies/company-1/issues');
    expect(create?.body?.labelIds).toContain('label-operation');
    expect(await operationStore.read(OPERATION_ID)).toMatchObject({ phase: 'issue_known', issueId: 'issue-1', deliveryConfirmed: true });
  });

  it('recovers an issue created before a gateway restart without replaying creation', async () => {
    const operationStore = await store();
    await seedStarted(operationStore);
    const upstream = fakeUpstream({ id: 'issue-1', companyId: 'company-1', assigneeAgentId: 'agent-1', status: 'todo' });
    const restarted = new AgentConversationDispatcher(BASE, {
      operationStore, fetchImpl: upstream.fetchImpl, operationDiscoveryAttempts: 1, operationDiscoveryDelayMs: 0,
    });

    expect(await restarted.dispatch(input)).toMatchObject({ status: 'queued', issueId: 'issue-1' });
    expect(upstream.creates()).toBe(0);
    expect((await operationStore.read(OPERATION_ID)).deliveryConfirmed).toBe(true);
  });

  it('keeps a started but unattributable mutation uncertain and never replays it', async () => {
    const operationStore = await store();
    await seedStarted(operationStore);
    const upstream = fakeUpstream();
    const restarted = new AgentConversationDispatcher(BASE, {
      operationStore, fetchImpl: upstream.fetchImpl, operationDiscoveryAttempts: 1, operationDiscoveryDelayMs: 0,
    });

    expect(await restarted.dispatch(input)).toMatchObject({ status: 'error', code: 'operation_uncertain' });
    expect(upstream.creates()).toBe(0);
    expect((await operationStore.read(OPERATION_ID)).phase).toBe('uncertain');
  });

  it('does not cross the no-replay boundary while first-turn label preflight is unavailable', async () => {
    const operationStore = await store();
    const fetchImpl = (async (raw: string | URL, init?: RequestInit) => {
      const url = new URL(String(raw));
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url.pathname === '/api/companies/company-1/labels') return response([], 200);
      if (method === 'POST' && url.pathname === '/api/companies/company-1/labels') return response({}, 503);
      return response({ error: 'unexpected mutation' }, 500);
    }) as typeof fetch;
    const dispatcher = new AgentConversationDispatcher(BASE, { operationStore, fetchImpl });

    expect(await dispatcher.dispatch(input)).toMatchObject({ status: 'error', detail: 'operation label unavailable before mutation' });
    expect(await operationStore.read(OPERATION_ID)).toMatchObject({ mutationStarted: false, deliveryConfirmed: false });
  });

  it('binds a continuation only to the run woken by its exact comment', async () => {
    const operationStore = await store();
    const continuation = { ...input, issueId: 'issue-1' };
    const calls: string[] = [];
    const fetchImpl = (async (raw: string | URL, init?: RequestInit) => {
      const url = new URL(String(raw));
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url.pathname}`);
      if (method === 'GET' && url.pathname === '/api/issues/issue-1') {
        return response({ id: 'issue-1', companyId: 'company-1', assigneeAgentId: 'agent-1', status: 'in_progress' });
      }
      if (method === 'GET' && url.pathname === '/api/issues/issue-1/tree-holds') return response([]);
      if (method === 'POST' && url.pathname === '/api/issues/issue-1/comments') return response({ id: 'comment-new' }, 201);
      if (method === 'GET' && url.pathname === '/api/issues/issue-1/live-runs') {
        return response([
          { id: 'run-old', agentId: 'agent-1', status: 'running', adapterType: 'codex_local', contextCommentId: 'comment-old' },
          { id: 'run-new', agentId: 'agent-1', status: 'queued', adapterType: 'codex_local', contextCommentId: 'comment-new' },
        ]);
      }
      return response({ error: 'unexpected request' }, 404);
    }) as typeof fetch;
    const dispatcher = new AgentConversationDispatcher(BASE, { operationStore, fetchImpl });

    const result = await dispatcher.dispatch(continuation);

    expect(result).toMatchObject({
      status: 'dispatched', run: { runId: 'run-new' },
      runAttribution: { kind: 'comment', commentId: 'comment-new' },
    });
    expect(await operationStore.read(OPERATION_ID)).toMatchObject({ issueId: 'issue-1', commentId: 'comment-new', runId: 'run-new' });
    expect(calls.filter(value => value === 'POST /api/issues/issue-1/comments')).toHaveLength(1);
  });
});
