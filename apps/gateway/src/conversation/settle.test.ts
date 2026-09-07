import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentConversationDispatcher } from './dispatcher.js';
import { ConversationOperationStore, conversationRequestDigest } from './operation-store.js';

const BASE = 'http://127.0.0.1:3100';
const RUN = '55555555-5555-4555-8555-555555555555';
const NEXT = '66666666-6666-4666-8666-666666666666';
const identity = { companyId: 'co', agentId: 'agent', issueId: 'issue', runId: RUN };
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

async function setup(options: { loseHoldResponse?: boolean; hideHolds?: boolean; unreadableHolds?: boolean; unreadableState?: boolean; malformedState?: boolean; failRelease?: boolean; pretendRelease?: boolean; beforeHold?: () => Promise<void>; beforeComment?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'awwo-settlement-'));
  const state = {
    issue: { id: 'issue', companyId: 'co', assigneeAgentId: 'agent', status: 'in_progress' },
    source: { id: RUN, companyId: 'co', agentId: 'agent', status: 'succeeded', createdAt: '2026-09-06T10:00:00.000Z',
      contextSnapshot: { issueId: 'issue', commentId: 'comment-source', wakeReason: 'issue_commented' } } as Record<string, any>,
    runs: [] as Array<Record<string, any>>,
    comments: [{ id: 'comment-source', companyId: 'co', issueId: 'issue', createdAt: '2026-09-06T09:59:59.000Z' }] as Array<Record<string, any>>,
    holds: [] as Array<Record<string, any>>,
    children: [] as Array<{ id: string }>,
    inheritedHold: null as Record<string, any> | null,
    calls: [] as Array<{ method: string; path: string; body: any }>,
  };
  const allRuns = () => [state.source, ...state.runs];
  const activeRuns = () => allRuns().filter(run => run.status === 'running' || run.status === 'queued');
  const preview = () => ({ companyId: 'co', rootIssueId: 'issue', issues: [{ id: 'issue' }, ...state.children],
    activeRuns: activeRuns().map(run => ({ id: run.id, issueId: run.contextSnapshot.issueId, agentId: run.agentId })) });
  const fetchImpl = (async (raw: string | URL, init?: RequestInit) => {
    const path = new URL(String(raw)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push({ method, path, body });
    if (path === '/api/issues/issue') return response(state.issue);
    if (path === '/api/companies/co/heartbeat-runs') return response(allRuns());
    if (path.startsWith('/api/heartbeat-runs/')) return response(allRuns().find(run => run.id === path.split('/').at(-1)));
    if (path === '/api/issues/issue/live-runs') return response(activeRuns());
    if (path === '/api/issues/issue/tree-control/preview') return response(preview());
    if (path === '/api/issues/issue/tree-holds' && method === 'POST') {
      await options.beforeHold?.();
      const current = preview();
      const hold = { id: 'settlement-hold', companyId: 'co', rootIssueId: 'issue', status: 'active', ...body,
        members: [{ issueId: 'issue', activeRunId: current.activeRuns[0]?.id ?? null }] };
      state.holds.push(hold);
      for (const run of activeRuns()) run.status = 'cancelled';
      if (options.loseHoldResponse) throw new Error('hold committed; response lost');
      return response({ hold, preview: current }, 201);
    }
    if (path === '/api/issues/issue/tree-holds') return options.unreadableHolds ? response({}, 503) : response(options.hideHolds ? [] : state.holds.filter(hold => hold.status === 'active'));
    if (path === '/api/issues/issue/tree-control/state') {
      if (options.unreadableState) return response({}, 503);
      if (options.malformedState) return response({});
      const held = state.inheritedHold ?? state.holds.find(hold => hold.status === 'active');
      return response({ activePauseHold: held ? { holdId: held.id, rootIssueId: held.rootIssueId, issueId: 'issue', mode: 'pause' } : null });
    }
    if (path.includes('/tree-holds/') && path.endsWith('/release')) {
      if (options.failRelease) return response({}, 503);
      if (!options.pretendRelease) state.holds = state.holds.map(hold => hold.id === path.split('/').at(-2) ? { ...hold, status: 'released' } : hold);
      return response({ released: true });
    }
    if (path === '/api/issues/issue/comments' && method === 'POST') {
      await options.beforeComment?.();
      // The native route checks its pause gate for explicit resume, not ordinary in_progress comments.
      if (body.resume && state.holds.some(hold => hold.status === 'active')) return response({ error: 'Issue follow-up blocked by active subtree pause hold' }, 409);
      const comment = { ...body, id: 'new-user-comment', companyId: 'co', issueId: 'issue', createdAt: '2026-09-06T10:01:00.000Z' };
      state.comments.push(comment);
      state.runs.push({ ...state.source, id: NEXT, status: 'running', createdAt: '2026-09-06T10:01:00.001Z',
        contextCommentId: comment.id, contextSnapshot: { issueId: 'issue', commentId: comment.id, wakeReason: 'issue_commented' } });
      return response(comment, 201);
    }
    if (path === '/api/issues/issue/comments') return response(state.comments);
    return response({ error: 'unexpected request' }, 404);
  }) as typeof fetch;
  const restart = () => new AgentConversationDispatcher(BASE, { fetchImpl, operationStore: new ConversationOperationStore(root),
    operationDiscoveryAttempts: 1, operationDiscoveryDelayMs: 0, cancelPollAttempts: 2, cancelPollDelayMs: 0 });
  const posts = (path: string) => state.calls.filter(call => call.method === 'POST' && call.path === path);
  const automatic = () => ({ ...state.source, id: NEXT, status: 'running', createdAt: '2026-09-06T10:00:01.000Z',
    contextSnapshot: { issueId: 'issue', wakeReason: 'issue_continuation_needed', retryOfRunId: RUN } });
  return { state, restart, posts, automatic, operationStore: new ConversationOperationStore(root) };
}

describe('native terminal settlement', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'timed_out'])('parks a %s run without changing its issue status', async status => {
    const { state, restart, posts } = await setup();
    state.source.status = status;
    const result = await restart().settleConversationRun(identity);
    expect(result).toEqual({ confirmed: true, status, holdId: 'settlement-hold', stoppedAutomaticRunIds: [] });
    expect(posts('/api/issues/issue/tree-holds')[0]?.body.releasePolicy.note).toBe(`awwo_agent_canvas:settle:${RUN}`);
    expect(state.issue.status).toBe('in_progress');
    expect(state.source.status).toBe(status);
    expect(state.calls.some(call => call.path.includes('/cancel') || call.method === 'PATCH')).toBe(false);
  });

  it('recovers a lost hold response and repeated settlement across gateway restarts', async () => {
    const { restart, posts } = await setup({ loseHoldResponse: true });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: true });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: true, holdId: 'settlement-hold' });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(1);
  });

  it('does not repeat an uncertain hold creation when its readback is temporarily unavailable', async () => {
    const options = { loseHoldResponse: true, hideHolds: true };
    const { restart, posts } = await setup(options);
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false, detail: expect.stringContaining('duplicate hold') });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(1);
    options.hideHolds = false;
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: true });
  });

  it.each(['running', 'queued', 'scheduled_retry', 'unknown'])('refuses a %s run before any hold mutation', async status => {
    const { state, restart, posts } = await setup();
    state.source.status = status;
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
  });

  it.each(['companyId', 'agentId', 'issueId'])('refuses a source run with mismatched %s', async field => {
    const { state, restart, posts } = await setup();
    if (field === 'issueId') state.source.contextSnapshot.issueId = 'other';
    else state.source[field] = 'other';
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
  });

  it('refuses an older source once a new user run exists, including an already completed new run', async () => {
    const { state, restart, posts } = await setup();
    state.runs.push({ ...state.source, id: NEXT, status: 'succeeded', createdAt: '2026-09-06T10:01:00.000Z' });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false, detail: expect.stringContaining('newer user turn') });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
  });

  it('refuses a newer user comment even before its wake becomes visible', async () => {
    const { state, restart, posts } = await setup();
    state.comments.push({ id: 'new-comment', companyId: 'co', issueId: 'issue', createdAt: '2026-09-06T10:01:00.000Z' });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false, detail: expect.stringContaining('newer user comment') });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
  });

  it.each([
    ['between-comment-and-run', '2026-09-06T09:59:59.500Z'],
    ['aaa-before-source-id', '2026-09-06T09:59:59.000Z'],
    ['zzz-after-source-id', '2026-09-06T09:59:59.000Z'],
  ])('refuses a later or ambiguously ordered user comment after restart: %s', async (id, createdAt) => {
    const { state, restart, posts } = await setup();
    state.comments.unshift({ id, companyId: 'co', issueId: 'issue', createdAt });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false, detail: expect.stringContaining('newer user comment') });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
  });

  it.each(['missing', 'duplicate', 'timestamp-missing', 'legacy-assignment'])('keeps settlement unconfirmed without an exact source comment anchor: %s', async kind => {
    const { state, restart, posts } = await setup();
    if (kind === 'missing') state.comments = [];
    if (kind === 'duplicate') state.comments.push({ ...state.comments[0] });
    if (kind === 'timestamp-missing') delete state.comments[0]!.createdAt;
    if (kind === 'legacy-assignment') state.source.contextSnapshot = { issueId: 'issue', wakeReason: 'issue_assigned' };
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false, detail: expect.stringContaining('source comment') });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
  });

  it('allows earlier user history and evidence tied to the exact source run', async () => {
    const { state, restart } = await setup();
    state.comments.push({ id: 'earlier-user-comment', companyId: 'co', issueId: 'issue', createdAt: '2026-09-06T09:59:58.000Z' },
      { id: 'agent-evidence', companyId: 'co', issueId: 'issue', createdAt: '2026-09-06T10:00:01.000Z', createdByRunId: RUN, authorAgentId: 'agent' });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: true });
  });

  it('does not ignore a later comment merely because it names the same agent', async () => {
    const { state, restart, posts } = await setup();
    state.comments.push({ id: 'unknown-agent-comment', companyId: 'co', issueId: 'issue', createdAt: '2026-09-06T09:59:59.500Z', authorAgentId: 'agent' });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
  });

  it('refuses child issues and unowned active executions', async () => {
    const { state, restart, posts } = await setup();
    state.children.push({ id: 'child' });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: false, detail: expect.stringContaining('isolated') });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
  });

  it('interrupts only a proven system continuation and records its cancelled native run', async () => {
    const { state, restart, automatic } = await setup();
    state.runs.push(automatic());
    expect(await restart().settleConversationRun(identity)).toEqual({ confirmed: true, status: 'succeeded', holdId: 'settlement-hold', stoppedAutomaticRunIds: [NEXT] });
    expect(state.runs[0]!.status).toBe('cancelled');
    expect(state.source.status).toBe('succeeded');
  });

  it('records a system continuation that starts in the native preview/hold gap', async () => {
    const options: { beforeHold?: () => Promise<void> } = {};
    const { state, restart, automatic } = await setup(options);
    options.beforeHold = async () => { state.runs.push(automatic()); };
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: true, stoppedAutomaticRunIds: [NEXT] });
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: true, stoppedAutomaticRunIds: [NEXT] });
  });

  it('keeps concurrent repeated settlements to one native hold', async () => {
    const { restart, posts } = await setup();
    const dispatcher = restart();
    const results = await Promise.all([dispatcher.settleConversationRun(identity), dispatcher.settleConversationRun(identity)]);
    expect(results.every(result => result.confirmed)).toBe(true);
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(1);
  });

  it('serializes dispatch before a stale settlement so that the new user run is preserved', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { state, restart, posts } = await setup({ beforeComment: () => gate });
    const dispatcher = restart();
    const sent = dispatcher.dispatch({ companyId: 'co', agentId: 'agent', issueId: 'issue', message: 'Next request', operationId: '77777777-7777-4777-8777-777777777777' });
    await vi.waitFor(() => expect(posts('/api/issues/issue/comments')).toHaveLength(1));
    const settled = dispatcher.settleConversationRun(identity);
    release();
    expect(await sent).toMatchObject({ status: 'dispatched' });
    expect(await settled).toMatchObject({ confirmed: false });
    expect(posts('/api/issues/issue/tree-holds')).toHaveLength(0);
    expect(state.runs[0]!.status).toBe('running');
  });

  it('releases a persisted settlement hold for the next user turn after gateway restart', async () => {
    const { restart, state, posts } = await setup();
    expect(await restart().settleConversationRun(identity)).toMatchObject({ confirmed: true });
    const result = await restart().dispatch({ companyId: 'co', agentId: 'agent', issueId: 'issue', message: 'Continue', operationId: '88888888-8888-4888-8888-888888888888' });
    expect(result).toMatchObject({ status: 'dispatched', run: { runId: NEXT } });
    expect(state.holds[0]!.status).toBe('released');
    expect(posts('/api/issues/issue/tree-holds/settlement-hold/release')).toHaveLength(1);
    expect(state.comments).toHaveLength(2);
  });

  it('does not release a manual pause hold while resuming a settled conversation', async () => {
    const { restart, state } = await setup();
    await restart().settleConversationRun(identity);
    state.holds.push({ id: 'manual-hold', companyId: 'co', rootIssueId: 'issue', status: 'active', mode: 'pause', reason: 'Operator pause', releasePolicy: { strategy: 'manual' } });
    expect(await restart().dispatch({ companyId: 'co', agentId: 'agent', issueId: 'issue', message: 'Continue', operationId: '99999999-9999-4999-8999-999999999999' })).toMatchObject({ status: 'error' });
    expect(state.holds.find(hold => hold.id === 'manual-hold')!.status).toBe('active');
    expect(state.calls.some(call => call.path.includes('manual-hold/release'))).toBe(false);
    expect(state.calls.some(call => call.path.endsWith('/comments') && call.method === 'POST')).toBe(false);
  });

  it.each(['new-operation', 'legacy-journal', 'no-operation'].flatMap(mode => [true, false].map(restart => ({ mode, restart }))))
    ('releases both persisted Stop and settle holds before a native 200 comment: $mode restart=$restart', async example => {
      const { state, restart, posts, operationStore } = await setup();
      state.source.status = 'cancelled';
      state.holds.push({ id: 'stop-hold', companyId: 'co', rootIssueId: 'issue', mode: 'pause', status: 'active',
        releasePolicy: { strategy: 'manual', note: `awwo_agent_canvas:stop:${RUN}` } });
      const dispatcher = restart();
      expect(await dispatcher.settleConversationRun(identity)).toMatchObject({ confirmed: true });
      const request = { companyId: 'co', agentId: 'agent', issueId: 'issue', message: 'Continue after stopping.',
        ...(example.mode !== 'no-operation' ? { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : {}) };
      if (example.mode === 'legacy-journal') {
        await operationStore.claim({ operationId: request.operationId!, companyId: 'co', agentId: 'agent', issueId: 'issue', requestDigest: conversationRequestDigest(request) });
      }
      const beforeSend = state.calls.length;
      expect(await (example.restart ? restart() : dispatcher).dispatch(request)).toMatchObject({ status: 'dispatched', run: { runId: NEXT } });
      expect(state.holds.every(hold => hold.status === 'released')).toBe(true);
      expect(posts('/api/issues/issue/comments')).toHaveLength(1);
      const sendCalls = state.calls.slice(beforeSend);
      const commentIndex = sendCalls.findIndex(call => call.method === 'POST' && call.path.endsWith('/comments'));
      expect(sendCalls.slice(0, commentIndex).filter(call => call.path.endsWith('/release'))).toHaveLength(2);
      expect(sendCalls[commentIndex - 1]).toMatchObject({ method: 'GET', path: '/api/issues/issue/tree-control/state' });
    });

  it.each([{ unreadableHolds: true }, { unreadableState: true }, { malformedState: true }, { failRelease: true }, { pretendRelease: true }])('refuses comment dispatch when pause release cannot be confirmed: %j', async options => {
    const { state, restart, posts } = await setup(options);
    state.holds.push({ id: 'stop-hold', companyId: 'co', rootIssueId: 'issue', mode: 'pause', status: 'active',
      releasePolicy: { strategy: 'manual', note: `awwo_agent_canvas:stop:${RUN}` } });
    expect(await restart().dispatch({ companyId: 'co', agentId: 'agent', issueId: 'issue', message: 'Continue' })).toMatchObject({ status: 'error' });
    expect(posts('/api/issues/issue/comments')).toHaveLength(0);
  });

  it('refuses an inherited operator pause without releasing owned root holds', async () => {
    const { state, restart, posts } = await setup();
    state.holds.push({ id: 'stop-hold', companyId: 'co', rootIssueId: 'issue', mode: 'pause', status: 'active',
      releasePolicy: { strategy: 'manual', note: `awwo_agent_canvas:stop:${RUN}` } });
    state.inheritedHold = { id: 'manual-ancestor', rootIssueId: 'parent' };
    expect(await restart().dispatch({ companyId: 'co', agentId: 'agent', issueId: 'issue', message: 'Continue' })).toMatchObject({ status: 'error' });
    expect(posts('/api/issues/issue/comments')).toHaveLength(0);
    expect(state.calls.some(call => call.path.endsWith('/release'))).toBe(false);
  });
});
