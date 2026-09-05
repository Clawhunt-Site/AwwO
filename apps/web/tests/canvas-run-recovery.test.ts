import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionNode } from '../src/canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY, clearRunJournal, loadRunJournal, saveRunJournal, reconcileRunJournal, journalSummary, type CanvasRunJournal } from '../src/canvas/runJournal';

const node = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-1' };
const journal = (): CanvasRunJournal => ({ version: 1, id: 'graph-1', startedAt: 100, scope: ['node-1', 'node-2'], nodes: {
  'node-1': { nodeId: 'node-1', threadId: 'thread-1', companyId: 'co-1', agentId: 'agent-1', issueId: 'issue-1', runId: 'run-1', state: 'running' },
  'node-2': { nodeId: 'node-2', threadId: 'thread-2', companyId: 'co-1', agentId: 'agent-2', issueId: null, runId: null, state: 'waiting' },
} });
afterEach(() => vi.unstubAllGlobals());
describe('native run recovery journal', () => {
  it('persists identity and detects failed storage before a dispatch', () => {
    let value = '';
    expect(saveRunJournal(journal(), { setItem: (_key, raw) => { value = raw; } })).toBe(true);
    expect(loadRunJournal({ getItem: () => value })).toEqual(journal());
    expect(saveRunJournal(journal(), { setItem: () => { throw new Error('quota'); } })).toBe(false);
    expect(loadRunJournal({ getItem: () => '{torn' })).toBe(null);
  });
  it('preserves the exact manual prompt needed to rebuild a detached conversation', () => {
    const manual = { ...journal(), manual: true as const, manualMessage: '  keep exact spacing\n' };
    expect(loadRunJournal({ getItem: () => JSON.stringify(manual) })).toMatchObject({
      manual: true, manualMessage: '  keep exact spacing\n',
    });
  });
  it('reads only the exact identity, restores terminal output, and does not dispatch downstream', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ runId: 'run-1', terminal: true, status: 'succeeded', output: 'verified output' })));
    vi.stubGlobal('fetch', fetcher);
    const restored = await reconcileRunJournal(journal(), [node], '/gateway');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/gateway/conversations/co-1/agents/agent-1/issues/issue-1/runs/run-1');
    expect(restored.nodes['node-1']).toMatchObject({ state: 'done', output: 'verified output' });
    expect(restored.nodes['node-2']).toMatchObject({ state: 'blocked', detail: 'recovery_not_dispatched' });
    expect(journalSummary(restored)).toMatchObject({ ok: false, done: 1, blocked: 1, total: 2 });
  });
  it.each(['offline', 'wrong-id', 'unknown-status'])('keeps the execution locked when %s', async (scenario) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (scenario === 'offline') throw new Error('offline');
      return new Response(JSON.stringify({ runId: scenario === 'wrong-id' ? 'someone-else' : 'run-1', terminal: true, status: scenario === 'unknown-status' ? 'new-state' : 'succeeded', output: 'untrusted' }));
    }));
    const restored = await reconcileRunJournal(journal(), [node], '/gateway');
    expect(restored.nodes['node-1'].state).toBe('running');
    expect(restored.nodes['node-1'].output).toBeUndefined();
  });
  it('never guesses a missing run ID or treats it as a completed run', async () => {
    const pending = journal(); pending.nodes['node-1'].runId = null;
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const restored = await reconcileRunJournal(pending, [node], '/gateway');
    expect(fetcher).not.toHaveBeenCalled();
    expect(restored.nodes['node-1']).toMatchObject({ state: 'running', detail: 'recovery_identity_missing' });
  });
  it('retains partial output on cancellation and never reports success', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ runId: 'run-1', terminal: true, status: 'cancelled', output: 'partial evidence' }))));
    const restored = await reconcileRunJournal(journal(), [node], '/gateway');
    expect(restored.nodes['node-1']).toMatchObject({ state: 'cancelled', output: 'partial evidence' });
    expect(journalSummary(restored)).toMatchObject({ ok: false, cancelled: 1 });
  });

  it('recovers a first turn by operation identity before issue/run accepted reached the browser', async () => {
    const pending = journal();
    pending.nodes['node-1'] = { ...pending.nodes['node-1']!, operationId: '11111111-1111-4111-8111-111111111111', issueId: null, runId: null };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      operationId: '11111111-1111-4111-8111-111111111111', state: 'terminal', issueId: 'issue-recovered', runId: 'run-recovered',
      terminal: true, status: 'succeeded', output: 'durable result', outputAvailable: true, detail: null,
    })));
    vi.stubGlobal('fetch', fetcher);

    const restored = await reconcileRunJournal(pending, [node], '/gateway');

    expect(fetcher.mock.calls[0]?.[0]).toBe('/gateway/conversations/co-1/agents/agent-1/operations/11111111-1111-4111-8111-111111111111');
    expect(restored.nodes['node-1']).toMatchObject({ state: 'done', issueId: 'issue-recovered', runId: 'run-recovered', output: 'durable result' });
  });

  it('unlocks a durable operation proven not to have crossed the mutation boundary', async () => {
    const pending = journal();
    pending.nodes['node-1'] = { ...pending.nodes['node-1']!, operationId: '11111111-1111-4111-8111-111111111111', issueId: null, runId: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      operationId: '11111111-1111-4111-8111-111111111111', state: 'not_started', issueId: null, runId: null,
      terminal: false, status: null, output: '', outputAvailable: false, detail: null,
    }))));

    const restored = await reconcileRunJournal(pending, [node], '/gateway');

    expect(restored.nodes['node-1']).toMatchObject({ state: 'failed', detail: 'recovery_not_dispatched' });
  });

  it('preserves already streamed partial evidence when terminal log recovery is unavailable', async () => {
    const pending = journal();
    pending.nodes['node-1'] = { ...pending.nodes['node-1']!, output: 'partial before refresh' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      runId: 'run-1', terminal: true, status: 'succeeded', output: '', outputAvailable: false,
    }))));

    const restored = await reconcileRunJournal(pending, [node], '/gateway');

    expect(restored.nodes['node-1']).toMatchObject({ state: 'failed', output: 'partial before refresh', detail: 'recovery_output_unavailable' });
  });

  it('compare-deletes only the journal the caller actually finished', () => {
    let value = JSON.stringify({ ...journal(), id: 'newer-run' });
    const storage = {
      getItem: (_key: string) => value,
      removeItem: (_key: string) => { value = ''; },
    };
    expect(clearRunJournal(storage, 'stale-run')).toBe(false);
    expect(value).toContain('newer-run');
    expect(clearRunJournal(storage, 'newer-run')).toBe(true);
    expect(value).toBe('');
    expect(CANVAS_RUN_JOURNAL_KEY).toBe('awwo.canvas.active-run.v1');
  });
});
