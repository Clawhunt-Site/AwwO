import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleConversationRun, settleExecutionResult, settleRecoveredJournal } from '../src/canvas/runSettlement';
import type { CanvasRunJournal } from '../src/canvas/runJournal';

const identity = { companyId: 'company-1', agentId: 'agent-1', issueId: 'issue-1', runId: 'run-1' };
const journal = (): CanvasRunJournal => ({ version: 1, id: 'journal', startedAt: 1, scope: ['one'], nodes: {
  one: { ...identity, nodeId: 'one', threadId: 'session-1', state: 'done', output: 'verified output' },
  upstream: { ...identity, runId: 'previous-run', nodeId: 'upstream', threadId: 'other', state: 'cached' },
} });
afterEach(() => vi.unstubAllGlobals());
describe('completed canvas turns wait for the next operator message', () => {
  it('makes one explicit identity-scoped POST, with a deadline, without sending another message', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ confirmed: true, status: 'succeeded', holdId: 'hold-1' })));
    vi.stubGlobal('fetch', fetcher);
    expect(await settleConversationRun('/gateway/', identity)).toEqual({ confirmed: true, status: 'succeeded', holdId: 'hold-1' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/gateway/conversations/company-1/agents/agent-1/issues/issue-1/settle', expect.objectContaining({
      method: 'POST', credentials: 'include', body: '{"runId":"run-1"}', signal: expect.any(AbortSignal),
    }));
  });
  it.each([{ confirmed: true, status: 'running', holdId: 'hold' }, { confirmed: true, status: 'succeeded' }, { confirmed: false }])('does not trust an incomplete settlement response %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    expect(await settleConversationRun('/gateway', identity)).toEqual({ confirmed: false });
  });
  it('holds publication and keeps evidence when settlement is unavailable', async () => {
    const settle = vi.fn(async () => ({ confirmed: false as const }));
    const result = await settleExecutionResult('/gateway', identity, { ok: true, output: 'verified output' }, settle);
    expect(result).toEqual({ ok: false, unconfirmed: true, output: 'verified output', detail: 'recovery_settlement_unconfirmed' });
    const recovered = await settleRecoveredJournal('/gateway', journal(), undefined, settle);
    expect(recovered.nodes.one).toMatchObject({ state: 'running', output: 'verified output' });
    expect(recovered.nodes.upstream.state).toBe('cached');
    expect(settle).toHaveBeenCalledTimes(2);
  });
  it('keeps authoritative cancellation and never upgrades failed output into success', async () => {
    expect(await settleExecutionResult('/gateway', identity, { ok: true, output: 'partial' }, async () => ({ confirmed: true, status: 'cancelled', holdId: 'hold' })))
      .toMatchObject({ ok: false, cancelled: true, output: 'partial' });
    expect(await settleExecutionResult('/gateway', identity, { ok: false, output: '', detail: 'empty_delivery' }, async () => ({ confirmed: true, status: 'succeeded', holdId: 'hold' })))
      .toMatchObject({ ok: false, detail: 'empty_delivery' });
  });
  it('keeps recovered native success without identity locked while leaving form results alone', async () => {
    const saved = journal();
    saved.nodes.one.runId = null;
    const settle = vi.fn(async () => ({ confirmed: true as const, status: 'succeeded' as const, holdId: 'hold' }));
    expect((await settleRecoveredJournal('/gateway', saved, undefined, settle)).nodes.one)
      .toMatchObject({ state: 'running', detail: 'recovery_identity_missing', output: 'verified output' });
    saved.nodes.one.threadId = 'form';
    expect((await settleRecoveredJournal('/gateway', saved, undefined, settle)).nodes.one.state).toBe('done');
    expect(settle).not.toHaveBeenCalled();
  });
  it('does not invent success without a native run identity or make a mutation for an unconfirmed stream', async () => {
    const settle = vi.fn(async () => ({ confirmed: true as const, status: 'succeeded' as const, holdId: 'hold' }));
    expect(await settleExecutionResult('/gateway', undefined, { ok: true, output: 'candidate' }, settle)).toMatchObject({ ok: false, unconfirmed: true });
    const pending = { ok: false, unconfirmed: true, output: 'partial' };
    expect(await settleExecutionResult('/gateway', identity, pending, settle)).toBe(pending);
    expect(settle).not.toHaveBeenCalled();
  });
});
