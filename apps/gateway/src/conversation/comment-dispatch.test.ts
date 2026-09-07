import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentConversationDispatcher, type DispatchInput } from './dispatcher.js';
import { ConversationOperationStore } from './operation-store.js';

const BASE = 'http://127.0.0.1:3100';
const OP = '33333333-3333-4333-8333-333333333333';
const input: DispatchInput = { companyId: 'co', agentId: 'agent', message: 'Build the requested spec.', operationId: OP };
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

function upstream(options: { loseCreate?: boolean; loseComment?: boolean; hideComments?: boolean; commentGate?: () => Promise<void>; rejectComment?: boolean } = {}) {
  const state = {
    issue: null as Record<string, unknown> | null,
    comments: [] as Array<Record<string, unknown>>,
    runs: [] as Array<Record<string, unknown>>,
    calls: [] as Array<{ method: string; path: string; body: any }>,
    holds: [] as Array<Record<string, unknown>>,
  };
  const fetchImpl = (async (raw: string | URL, init?: RequestInit) => {
    const url = new URL(String(raw));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const path = url.pathname;
    state.calls.push({ method, path, body });
    if (path === '/api/companies/co/labels') return response([{ id: 'label', name: `awwo:op:${OP}` }]);
    if (path === '/api/companies/co/issues' && method === 'POST') {
      state.issue = { ...body, id: 'issue', companyId: 'co' };
      if (options.loseCreate) throw new Error('create committed; connection lost');
      return response(state.issue, 201);
    }
    if (path === '/api/companies/co/issues') return response(state.issue ? [state.issue] : []);
    if (path === '/api/issues/issue') return response(state.issue);
    if (path === '/api/issues/issue/comments' && method === 'POST') {
      if (options.commentGate) await options.commentGate();
      if (options.rejectComment) return response({ error: 'permission denied' }, 403);
      if (body.resume && state.holds.length) return response({ error: 'Issue follow-up blocked by active subtree pause hold' }, 409);
      const comment = { ...body, id: `comment-${state.comments.length + 1}`, companyId: 'co', issueId: 'issue' };
      state.comments.push(comment);
      state.issue!.status = 'in_progress';
      state.runs.push({ id: `run-${state.runs.length + 1}`, companyId: 'co', agentId: 'agent', status: 'running', adapterType: 'codex_local',
        createdAt: new Date().toISOString(), contextCommentId: comment.id, contextSnapshot: { issueId: 'issue', commentId: comment.id, wakeReason: 'issue_commented' } });
      if (options.loseComment) throw new Error('comment committed; connection lost');
      return response(comment, 201);
    }
    if (path === '/api/issues/issue/comments') return response(options.hideComments ? [] : state.comments);
    if (path === '/api/issues/issue/live-runs') return response(state.runs.filter(run => run.status === 'running'));
    if (path === '/api/companies/co/heartbeat-runs') return response(state.runs);
    if (path === '/api/issues/issue/tree-holds' && method === 'POST') {
      // Match the real native persistence contract: creation metadata is accepted but omitted.
      const { metadata: _metadata, ...persisted } = body;
      const hold = { ...persisted, id: 'hold', companyId: 'co', rootIssueId: 'issue', status: 'active' }; state.holds.push(hold);
      const cancelledRunIds = state.runs.filter(run => run.status === 'running').map(run => { run.status = 'cancelled'; return run.id; });
      return response({ hold, cancelledRunIds }, 201);
    }
    if (path === '/api/issues/issue/tree-holds') return response(state.holds);
    if (path === '/api/issues/issue/tree-control/state') return response({ activePauseHold: state.holds.length
      ? { holdId: state.holds[0]!.id, rootIssueId: 'issue', issueId: 'issue', mode: 'pause' } : null });
    if (path === '/api/issues/issue/tree-holds/hold/release') { state.holds = []; return response({ released: true }); }
    if (/^\/api\/heartbeat-runs\/run-\d+$/.test(path)) return response(state.runs.find(run => run.id === path.split('/').at(-1)));
    if (/\/log$/.test(path)) return response({ runId: path.split('/').at(-2), content: JSON.stringify({ stream: 'stdout', chunk: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SPEC-VERIFIED' } }) + '\n' }) + '\n' });
    return response({ error: 'unexpected request' }, 404);
  }) as typeof fetch;
  return { state, fetchImpl, mutations: (path: string) => state.calls.filter(call => call.method === 'POST' && call.path === path) };
}

async function setup(options: Parameters<typeof upstream>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'awwo-comment-dispatch-'));
  const store = new ConversationOperationStore(directory);
  const fake = upstream(options);
  const restart = () => new AgentConversationDispatcher(BASE, { operationStore: new ConversationOperationStore(directory), fetchImpl: fake.fetchImpl,
    operationDiscoveryAttempts: 2, operationDiscoveryDelayMs: 1, cancelPollAttempts: 2, cancelPollDelayMs: 0 });
  return { store, fake, restart };
}

describe('comment-driven first turn and crash recovery', () => {
  it('does not treat backlog creation as delivery while the first comment is still pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { store, fake, restart } = await setup({ commentGate: () => gate });
    const dispatch = restart().dispatch(input);
    await vi.waitFor(() => expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(1));
    expect(fake.state.issue?.status).toBe('backlog');
    expect(fake.state.runs).toHaveLength(0);
    expect(await store.read(OP)).toMatchObject({ containerId: 'issue', commentStarted: true, deliveryConfirmed: false });
    expect(await restart().readConversationOperation({ companyId: 'co', agentId: 'agent', operationId: OP })).toMatchObject({ state: 'uncertain', runId: null, terminal: false });
    release();
    expect(await dispatch).toMatchObject({ status: 'dispatched', runAttribution: { kind: 'comment', commentId: 'comment-1' } });
    expect(fake.state.runs).toHaveLength(1);
  });

  it('recovers a lost creation response by label, then sends exactly one comment', async () => {
    const { fake, restart } = await setup({ loseCreate: true });
    expect(await restart().dispatch(input)).toMatchObject({ status: 'dispatched', run: { runId: 'run-1' } });
    expect(await restart().dispatch(input)).toMatchObject({ status: 'dispatched', run: { runId: 'run-1' } });
    expect(fake.mutations('/api/companies/co/issues')).toHaveLength(1);
    expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(1);
  });

  it('reads back a committed comment after losing its response, and survives a gateway restart', async () => {
    const { fake, store, restart } = await setup({ loseComment: true });
    expect(await restart().dispatch(input)).toMatchObject({ status: 'dispatched', run: { runId: 'run-1' } });
    expect(await store.read(OP)).toMatchObject({ deliveryConfirmed: true, commentId: 'comment-1' });
    fake.state.runs[0]!.status = 'succeeded';
    const before = fake.state.calls.length;
    expect(await restart().readConversationOperation({ companyId: 'co', agentId: 'agent', operationId: OP }))
      .toMatchObject({ state: 'terminal', status: 'succeeded', runId: 'run-1', output: 'SPEC-VERIFIED' });
    expect(fake.state.calls.slice(before).every(call => call.method === 'GET')).toBe(true);
    await restart().dispatch(input);
    expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(1);
  });

  it('keeps an undiscoverable committed comment uncertain until read-only evidence becomes available', async () => {
    const options = { loseComment: true, hideComments: true };
    const { fake, restart } = await setup(options);
    expect(await restart().dispatch(input)).toMatchObject({ status: 'error', code: 'operation_uncertain' });
    expect(await restart().dispatch(input)).toMatchObject({ status: 'error', code: 'operation_uncertain' });
    expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(1);
    options.hideComments = false;
    fake.state.runs[0]!.status = 'succeeded';
    expect(await restart().readConversationOperation({ companyId: 'co', agentId: 'agent', operationId: OP }))
      .toMatchObject({ state: 'terminal', runId: 'run-1', output: 'SPEC-VERIFIED' });
    expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(1);
  });

  it('recovers container-only progress without sending from GET, then safely resumes the unsent message', async () => {
    const { fake, store, restart } = await setup();
    await restart().prepareConversationOperation(input);
    await store.recordLabel(OP, 'label');
    await store.beginMutation(OP);
    fake.state.issue = { id: 'issue', companyId: 'co', assigneeAgentId: 'agent', status: 'backlog' };
    expect(await restart().readConversationOperation({ companyId: 'co', agentId: 'agent', operationId: OP }))
      .toMatchObject({ state: 'not_started', issueId: 'issue', runId: null });
    expect(fake.state.calls.every(call => call.method === 'GET')).toBe(true);
    expect(await restart().dispatch(input)).toMatchObject({ status: 'dispatched' });
    expect(fake.mutations('/api/companies/co/issues')).toHaveLength(0);
    expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(1);
  });

  it('never replays an uncertain creation or an unsent but reserved comment after a crash', async () => {
    const { fake, store, restart } = await setup();
    await restart().prepareConversationOperation(input);
    await store.recordLabel(OP, 'label');
    await store.beginMutation(OP);
    expect(await restart().dispatch(input)).toMatchObject({ status: 'error', code: 'operation_uncertain' });
    expect(fake.mutations('/api/companies/co/issues')).toHaveLength(0);
    fake.state.issue = { id: 'issue', companyId: 'co', assigneeAgentId: 'agent', status: 'backlog' };
    await store.recordContainer(OP, 'issue');
    await store.beginComment(OP);
    expect(await restart().dispatch(input)).toMatchObject({ status: 'error', code: 'operation_uncertain' });
    expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(0);
  });

  it('refuses ambiguous or differently scoped comment evidence instead of guessing a run', async () => {
    const options = { loseComment: true, hideComments: true };
    const { fake, restart } = await setup(options);
    await restart().dispatch(input);
    options.hideComments = false;
    const comment = fake.state.comments[0]!;
    fake.state.comments = [{ ...comment, companyId: 'other' }];
    expect(await restart().readConversationOperation({ companyId: 'co', agentId: 'agent', operationId: OP })).toMatchObject({ state: 'uncertain' });
    fake.state.comments = [comment, { ...comment, id: 'duplicate-comment' }];
    await expect(restart().readConversationOperation({ companyId: 'co', agentId: 'agent', operationId: OP })).rejects.toThrow('multiple comments');
    expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(1);
  });

  it('keeps a rejected comment rejected even though its container exists', async () => {
    const { fake, store, restart } = await setup({ rejectComment: true });
    expect(await restart().dispatch(input)).toMatchObject({ status: 'error', detail: 'comment failed (upstream 403): permission denied' });
    expect(await store.read(OP)).toMatchObject({ phase: 'rejected', containerId: 'issue', deliveryConfirmed: false });
    expect(await restart().readConversationOperation({ companyId: 'co', agentId: 'agent', operationId: OP })).toMatchObject({ state: 'rejected' });
    await restart().dispatch(input);
    expect(fake.mutations('/api/issues/issue/comments')).toHaveLength(1);
  });

  it('stops and resumes a comment-backed conversation after a gateway restart with one new wake', async () => {
    const { fake, restart } = await setup();
    const first = restart();
    await first.dispatch(input);
    expect(await first.cancelConversationRun({ companyId: 'co', agentId: 'agent', issueId: 'issue', runId: 'run-1' })).toMatchObject({ confirmed: true, cancelled: true });
    expect(fake.state.holds).toHaveLength(1);
    const next = { ...input, issueId: 'issue', message: 'Resume verification.', operationId: '44444444-4444-4444-8444-444444444444' };
    expect(await restart().dispatch(next)).toMatchObject({ status: 'dispatched', run: { runId: 'run-2' } });
    expect(fake.state.holds).toHaveLength(0);
    expect(fake.state.comments).toHaveLength(2);
    expect(fake.state.runs).toHaveLength(2);
  });
});
