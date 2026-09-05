import { describe, expect, it, vi } from 'vitest';
import { AgentConversationDispatcher } from './dispatcher.js';

const BASE = 'http://127.0.0.1:3100';

// A fake fetch router: map "METHOD path" → { status, body }. Records calls.
function fakeFetch(routes: Record<string, { status: number; body: unknown }>, calls: Array<{ method: string; path: string; body: unknown }> = []) {
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${u.pathname}`;
    calls.push({ method, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    const hit = routes[key];
    if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'no route' }) } as unknown as Response;
    return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, json: async () => hit.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const run = (agentId: string, status = 'running', id = 'run-1', adapterType = 'claude_local') => ({ id, agentId, status, adapterType });
const issue = (status = 'in_progress') => ({ id: 'iss-9', companyId: 'co-1', assigneeAgentId: 'ag-1', status });

describe('AgentConversationDispatcher.dispatch', () => {
  it('first turn: creates a 1:1 issue assigned to the agent (todo+message) and reports dispatched when the run is visible', async () => {
    const { impl, calls } = fakeFetch({
      'POST /api/companies/co-1/issues': { status: 201, body: { id: 'iss-1' } },
      'GET /api/issues/iss-1/live-runs': { status: 200, body: [run('ag-1')] },
    });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    const r = await d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: '帮我看下登录' });
    expect(r).toEqual({ status: 'dispatched', issueId: 'iss-1', agentId: 'ag-1', run: { runId: 'run-1', status: 'running', agentId: 'ag-1', adapterType: 'claude_local' } });
    // create body: assigned to the agent, status todo, message as description
    const create = calls.find((c) => c.path === '/api/companies/co-1/issues')!;
    expect(create.body).toMatchObject({ assigneeAgentId: 'ag-1', status: 'todo', description: '帮我看下登录' });
  });

  it('first turn: run not visible yet → queued (honest, message delivered)', async () => {
    const { impl } = fakeFetch({
      'POST /api/companies/co-1/issues': { status: 201, body: { id: 'iss-2' } },
      'GET /api/issues/iss-2/live-runs': { status: 200, body: [] },
    });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    const r = await d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: 'hi' });
    expect(r.status).toBe('queued');
    if (r.status === 'queued') expect(r.issueId).toBe('iss-2');
  });

  it('continuing turn (issueId given): posts a comment to re-wake, no new issue created', async () => {
    const { impl, calls } = fakeFetch({
      'GET /api/issues/iss-9': { status: 200, body: issue() },
      'POST /api/issues/iss-9/comments': { status: 201, body: { id: 'cmt-1' } },
      'GET /api/issues/iss-9/live-runs': { status: 200, body: [run('ag-1', 'queued')] },
    });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    const r = await d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: '继续', issueId: 'iss-9' });
    expect(r.status).toBe('dispatched');
    expect(calls.some((c) => c.path === '/api/companies/co-1/issues')).toBe(false); // no create
    const comment = calls.find((c) => c.path === '/api/issues/iss-9/comments')!;
    expect(comment.body).toMatchObject({ body: '继续' });
  });

  it.each(['done', 'blocked'])('continuing %s work requests the upstream resume gate on the existing issue', async (status) => {
    const { impl, calls } = fakeFetch({
      'GET /api/issues/iss-9': { status: 200, body: issue(status) },
      'POST /api/issues/iss-9/comments': { status: 201, body: { id: 'cmt-1' } },
      'GET /api/issues/iss-9/live-runs': { status: 200, body: [run('ag-1')] },
    });
    const result = await new AgentConversationDispatcher(BASE, { fetchImpl: impl }).dispatch({
      companyId: 'co-1', agentId: 'ag-1', message: '  请复核\n', issueId: 'iss-9',
    });
    expect(result.status).toBe('dispatched');
    expect(calls.filter(call => call.method !== 'GET')).toEqual([
      { method: 'POST', path: '/api/issues/iss-9/comments', body: { body: '  请复核\n', resume: true } },
    ]);
    expect(calls[0]?.path).toBe('/api/issues/iss-9');
  });

  it.each(['todo', 'in_progress', 'in_review'])('continuing %s work does not request a status transition', async (status) => {
    const { impl, calls } = fakeFetch({
      'GET /api/issues/iss-9': { status: 200, body: issue(status) },
      'POST /api/issues/iss-9/comments': { status: 201, body: { id: 'cmt-1' } },
      'GET /api/issues/iss-9/live-runs': { status: 200, body: [] },
    });
    await new AgentConversationDispatcher(BASE, { fetchImpl: impl }).dispatch({
      companyId: 'co-1', agentId: 'ag-1', message: '继续', issueId: 'iss-9',
    });
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ body: '继续' });
  });

  it.each([
    'Issue follow-up blocked by unresolved blockers',
    'Issue follow-up blocked by active subtree pause hold',
  ])('surfaces the upstream resume refusal without polling, retries or bypass: %s', async (reason) => {
    const { impl, calls } = fakeFetch({
      'GET /api/issues/iss-9': { status: 200, body: issue('blocked') },
      'POST /api/issues/iss-9/comments': { status: 409, body: { error: reason } },
    });
    const result = await new AgentConversationDispatcher(BASE, { fetchImpl: impl }).dispatch({
      companyId: 'co-1', agentId: 'ag-1', message: '继续', issueId: 'iss-9',
    });
    expect(result).toEqual({ status: 'error', detail: `comment failed (upstream 409): ${reason}` });
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /api/issues/iss-9', 'POST /api/issues/iss-9/comments',
    ]);
  });

  it.each([
    { ...issue(), companyId: 'other-company' },
    { ...issue(), assigneeAgentId: 'other-agent' },
    { ...issue(), assigneeAgentId: null },
    { ...issue(), id: 'other-issue' },
    null,
  ])('does not write to an unavailable or mismatched conversation issue: %j', async (body) => {
    const { impl, calls } = fakeFetch({
      'GET /api/issues/iss-9': { status: 200, body },
      'POST /api/issues/iss-9/comments': { status: 201, body: { id: 'cmt-1' } },
    });
    const result = await new AgentConversationDispatcher(BASE, { fetchImpl: impl }).dispatch({
      companyId: 'co-1', agentId: 'ag-1', message: '继续', issueId: 'iss-9',
    });
    expect(result.status).toBe('error');
    expect(calls.map(call => call.method)).toEqual(['GET']);
  });

  it('does not post a reopening comment to a cancelled conversation', async () => {
    const { impl, calls } = fakeFetch({
      'GET /api/issues/iss-9': { status: 200, body: issue('cancelled') },
      'POST /api/issues/iss-9/comments': { status: 201, body: { id: 'cmt-1' } },
    });
    const result = await new AgentConversationDispatcher(BASE, { fetchImpl: impl }).dispatch({
      companyId: 'co-1', agentId: 'ag-1', message: '继续', issueId: 'iss-9',
    });
    expect(result.status).toBe('error');
    expect(calls.map(call => call.method)).toEqual(['GET']);
  });

  it('does not post a comment when the existing issue cannot be read', async () => {
    const { impl, calls } = fakeFetch({
      'GET /api/issues/iss-9': { status: 503, body: {} },
      'POST /api/issues/iss-9/comments': { status: 201, body: { id: 'cmt-1' } },
    });
    const result = await new AgentConversationDispatcher(BASE, { fetchImpl: impl }).dispatch({
      companyId: 'co-1', agentId: 'ag-1', message: '继续', issueId: 'iss-9',
    });
    expect(result.status).toBe('error');
    expect(calls.map(call => call.method)).toEqual(['GET']);
  });

  it('create-issue upstream failure → error (nothing faked as sent)', async () => {
    const { impl } = fakeFetch({ 'POST /api/companies/co-1/issues': { status: 500, body: { error: 'boom' } } });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    const r = await d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: 'x' });
    expect(r.status).toBe('error');
  });

  it('comment upstream failure → error', async () => {
    const { impl } = fakeFetch({
      'GET /api/issues/iss-9': { status: 200, body: issue() },
      'POST /api/issues/iss-9/comments': { status: 409, body: {} },
    });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    const r = await d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: 'x', issueId: 'iss-9' });
    expect(r.status).toBe('error');
  });

  it('create returns no id → error (not a fake success)', async () => {
    const { impl } = fakeFetch({ 'POST /api/companies/co-1/issues': { status: 201, body: { ok: true } } });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    const r = await d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: 'x' });
    expect(r.status).toBe('error');
  });

  it('fetch throw (network refuse / abort timeout) → resolves error, never rejects (fail-soft)', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    await expect(d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: 'x' })).resolves.toMatchObject({ status: 'error' });
    await expect(d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: 'x', issueId: 'iss-9' })).resolves.toMatchObject({ status: 'error' });
  });

  it('sends the original message verbatim (no whitespace/newline stripping)', async () => {
    const { impl, calls } = fakeFetch({
      'POST /api/companies/co-1/issues': { status: 201, body: { id: 'iss-1' } },
      'GET /api/issues/iss-1/live-runs': { status: 200, body: [] },
    });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    await d.dispatch({ companyId: 'co-1', agentId: 'ag-1', message: '  \n```code```\n  ' });
    const create = calls.find((c) => c.path === '/api/companies/co-1/issues')!;
    expect((create.body as { description: string }).description).toBe('  \n```code```\n  ');
  });

  it('blank inputs → error without any upstream call', async () => {
    const spy = vi.fn();
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: spy as unknown as typeof fetch });
    expect((await d.dispatch({ companyId: ' ', agentId: 'a', message: 'm' })).status).toBe('error');
    expect((await d.dispatch({ companyId: 'c', agentId: ' ', message: 'm' })).status).toBe('error');
    expect((await d.dispatch({ companyId: 'c', agentId: 'a', message: '  ' })).status).toBe('error');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AgentConversationDispatcher.findActiveRun', () => {
  it('picks the queued/running run for THIS agent, ignoring others and finished runs', async () => {
    const { impl } = fakeFetch({
      'GET /api/issues/iss-1/live-runs': {
        status: 200,
        body: [run('ag-other'), { id: 'run-done', agentId: 'ag-1', status: 'done' }, run('ag-1', 'queued', 'run-mine')],
      },
    });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    expect(await d.findActiveRun('iss-1', 'ag-1')).toEqual({ runId: 'run-mine', status: 'queued', agentId: 'ag-1', adapterType: 'claude_local' });
  });

  it('unreadable roster → null (unknown, not "no run")', async () => {
    const { impl } = fakeFetch({ 'GET /api/issues/iss-1/live-runs': { status: 500, body: {} } });
    const d = new AgentConversationDispatcher(BASE, { fetchImpl: impl });
    expect(await d.findActiveRun('iss-1', 'ag-1')).toBeNull();
  });
});

describe('AgentConversationDispatcher.readRunStdout', () => {
  const record = (stream: string, chunk: string) => JSON.stringify({ stream, chunk }) + '\n';
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

  it('reads only the requested run and re-reads a split UTF-8 record from its boundary', async () => {
    const first = record('stdout', 'first\n') + record('stderr', 'must not become output');
    const second = record('stdout', '中文 final\n');
    const expectedOffset = Buffer.byteLength(first);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const parsed = new URL(String(url)); calls.push(parsed.pathname + parsed.search);
      const offset = Number(parsed.searchParams.get('offset'));
      if (offset === 0) return response({ runId: 'run-1', content: first + '{"stream":"stdout","chunk":"�', nextOffset: expectedOffset + 30 });
      if (offset === expectedOffset) return response({ runId: 'run-1', content: second });
      throw new Error('invalid offset');
    }) as typeof fetch;
    expect(await new AgentConversationDispatcher(BASE, { fetchImpl }).readRunStdout('run-1')).toBe('first\n中文 final\n');
    expect(calls).toEqual([`/api/heartbeat-runs/run-1/log?offset=0&limitBytes=1048576`, `/api/heartbeat-runs/run-1/log?offset=${expectedOffset}&limitBytes=1048576`]);
  });

  it('continues a full page even when an upstream version omits nextOffset', async () => {
    const pageBytes = 1024 * 1024;
    const firstText = 'x'.repeat(pageBytes - Buffer.byteLength(record('stdout', '')));
    const first = record('stdout', firstText);
    const fetchImpl = (async (url: string | URL) => response({ runId: 'run-1', content: new URL(String(url)).searchParams.get('offset') === '0' ? first : record('stdout', 'tail') })) as typeof fetch;
    const actual = await new AgentConversationDispatcher(BASE, { fetchImpl }).readRunStdout('run-1');
    expect(actual.length).toBe(firstText.length + 4);
    expect(actual.endsWith('tail')).toBe(true);
  });

  it('refuses a different run, invalid records and non-advancing or excessive offsets', async () => {
    for (const body of [
      { runId: 'another-run', content: record('stdout', 'wrong') },
      { runId: 'run-1', content: '{invalid' },
      { runId: 'run-1', content: record('stdout', 'x'), nextOffset: 0 },
      { runId: 'run-1', content: record('stdout', 'x'), nextOffset: 8 * 1024 * 1024 + 1 },
      { runId: 'run-1', content: record('stdout', 'x'.repeat(1024 * 1024)) },
    ]) {
      const fetchImpl = (async () => response(body)) as typeof fetch;
      await expect(new AgentConversationDispatcher(BASE, { fetchImpl }).readRunStdout('run-1')).rejects.toThrow();
    }
  });

  it('propagates cancellation into the bounded upstream read', async () => {
    const controller = new AbortController(); let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const fetchImpl = ((_url, init) => new Promise((_resolve, reject) => {
      began(); init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as typeof fetch;
    const pending = new AgentConversationDispatcher(BASE, { fetchImpl }).readRunStdout('run-1', controller.signal);
    const rejected = expect(pending).rejects.toThrow('aborted');
    await started; controller.abort(); await rejected;
  });
});
