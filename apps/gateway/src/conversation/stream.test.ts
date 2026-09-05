import { describe, expect, it, vi } from 'vitest';
import { streamConversationTurn, type CompanyEventSource, type ConversationStreamDeps } from './stream.js';
import type { LiveEventFrame } from './run-stream.js';

function streamEventDelta(text: string): string {
  return JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) + '\n';
}
const log = (runId: string, chunk: string): LiveEventFrame => ({ type: 'heartbeat.run.log', payload: { runId, stream: 'stdout', chunk } });
const status = (runId: string, s: string): LiveEventFrame => ({ type: 'heartbeat.run.status', payload: { runId, status: s } });

/** Fake event source: yields a fixed list, records close(). */
function fakeSource(events: LiveEventFrame[]): CompanyEventSource & { closed: boolean } {
  const src = {
    closed: false,
    close() {
      this.closed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        if (this.closed) return;
        yield e;
      }
    },
  };
  return src;
}

const RUN = { runId: 'r-1', status: 'running', agentId: 'ag-1', adapterType: 'claude_local' as string | null };
const INPUT = { companyId: 'co-1', agentId: 'ag-1', message: 'hi' };

async function collect(gen: AsyncGenerator<unknown>): Promise<any[]> {
  const out: any[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe('streamConversationTurn', () => {
  it('subscribes to the event source BEFORE dispatching (subscribe-before-wake)', async () => {
    const order: string[] = [];
    const src = fakeSource([]);
    const deps: ConversationStreamDeps = {
      dispatcher: {
        dispatch: vi.fn(async () => {
          order.push('dispatch');
          return { status: 'error', detail: 'x' } as const;
        }),
        findActiveRun: vi.fn(async () => null),
      },
      openEventSource: vi.fn(() => {
        order.push('open');
        return src;
      }),
      delay: async () => {},
    };
    await collect(streamConversationTurn(deps, INPUT));
    expect(order).toEqual(['open', 'dispatch']);
    expect(src.closed).toBe(true); // always closed
  });

  it('dispatch error → a single error frame, source closed', async () => {
    const src = fakeSource([]);
    const deps: ConversationStreamDeps = {
      dispatcher: { dispatch: async () => ({ status: 'error', detail: 'create issue failed' }) as any, findActiveRun: async () => null },
      openEventSource: () => src,
      delay: async () => {},
    };
    expect(await collect(streamConversationTurn(deps, INPUT))).toEqual([{ event: 'error', detail: 'create issue failed' }]);
    expect(src.closed).toBe(true);
  });

  it('dispatched (run visible) → accepted + status + projected deltas + done', async () => {
    const src = fakeSource([log('r-1', streamEventDelta('你好')), status('r-1', 'succeeded')]);
    const deps: ConversationStreamDeps = {
      dispatcher: { dispatch: async () => ({ status: 'dispatched', issueId: 'iss-1', agentId: 'ag-1', run: RUN }) as any, findActiveRun: async () => null },
      openEventSource: () => src,
      delay: async () => {},
    };
    expect(await collect(streamConversationTurn(deps, INPUT))).toEqual([
      { event: 'accepted', issueId: 'iss-1', runId: 'r-1', runVisible: true },
      { event: 'status', status: 'running' },
      { event: 'delta', text: '你好' },
      { event: 'status', status: 'succeeded' },
      { event: 'done', status: 'succeeded' },
    ]);
    expect(src.closed).toBe(true);
  });

  it('queued → polls /live-runs until the run appears, then streams it', async () => {
    const src = fakeSource([log('r-1', streamEventDelta('ok')), status('r-1', 'succeeded')]);
    let calls = 0;
    const deps: ConversationStreamDeps = {
      dispatcher: {
        dispatch: async () => ({ status: 'queued', issueId: 'iss-1', agentId: 'ag-1', detail: 'delivered' }) as any,
        findActiveRun: async () => (++calls >= 3 ? RUN : null), // appears on the 3rd poll
      },
      openEventSource: () => src,
      delay: async () => {},
      runDiscoveryAttempts: 5,
    };
    const frames = await collect(streamConversationTurn(deps, INPUT));
    expect(calls).toBe(3);
    expect(frames[0]).toEqual({ event: 'accepted', issueId: 'iss-1', runId: 'r-1', runVisible: true });
    expect(frames.at(-1)).toEqual({ event: 'done', status: 'succeeded' });
  });

  it('queued but no run ever appears → accepted(runVisible:false) + honest no_run', async () => {
    const src = fakeSource([]);
    const deps: ConversationStreamDeps = {
      dispatcher: {
        dispatch: async () => ({ status: 'queued', issueId: 'iss-1', agentId: 'ag-1', detail: 'delivered' }) as any,
        findActiveRun: async () => null,
      },
      openEventSource: () => src,
      delay: async () => {},
      runDiscoveryAttempts: 3,
    };
    const frames = await collect(streamConversationTurn(deps, INPUT));
    expect(frames).toEqual([
      { event: 'accepted', issueId: 'iss-1', runId: null, runVisible: false },
      { event: 'no_run', issueId: 'iss-1', detail: 'message delivered; no live run appeared in time' },
    ]);
    expect(src.closed).toBe(true);
  });

  it('never throws: openEventSource throwing → an error frame (no rejection)', async () => {
    const deps: ConversationStreamDeps = {
      dispatcher: { dispatch: async () => ({ status: 'dispatched', issueId: 'iss-1', agentId: 'ag-1', run: RUN }) as any, findActiveRun: async () => null },
      openEventSource: () => {
        throw new Error('ws connect failed');
      },
      delay: async () => {},
    };
    expect(await collect(streamConversationTurn(deps, INPUT))).toEqual([
      { event: 'error', detail: 'failed to open the company event stream' },
    ]);
  });

  it('never throws: a dependency that throws mid-turn → error frame + source closed', async () => {
    const src = fakeSource([]);
    const deps: ConversationStreamDeps = {
      dispatcher: {
        dispatch: async () => {
          throw new Error('boom');
        },
        findActiveRun: async () => null,
      },
      openEventSource: () => src,
      delay: async () => {},
    };
    const frames = await collect(streamConversationTurn(deps, INPUT));
    expect(frames).toEqual([{ event: 'error', detail: 'boom' }]);
    expect(src.closed).toBe(true); // finally still closed it
  });

  it('event stream ends before a terminal status → honest no_run (never a fake done)', async () => {
    const src = fakeSource([log('r-1', streamEventDelta('partial'))]); // no terminal status
    const deps: ConversationStreamDeps = {
      dispatcher: { dispatch: async () => ({ status: 'dispatched', issueId: 'iss-1', agentId: 'ag-1', run: RUN }) as any, findActiveRun: async () => null },
      openEventSource: () => src,
      delay: async () => {},
    };
    const frames = await collect(streamConversationTurn(deps, INPUT));
    expect(frames).toContainEqual({ event: 'delta', text: 'partial' });
    expect(frames.at(-1)).toEqual({ event: 'no_run', issueId: 'iss-1', detail: 'event stream ended before the run reported a terminal status' });
    expect(frames.some((f) => f.event === 'done')).toBe(false); // no fabricated completion
  });

  const codexMessage = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n';
  const codexRun = { ...RUN, adapterType: 'codex_local' };
  const truncatedLog = (runId = 'r-1') => ({ type: 'heartbeat.run.log', payload: { runId, stream: 'stdout', chunk: 'broken end of a long JSONL item\n', truncated: true } });
  function codexDeps(source: CompanyEventSource, readRunStdout?: (runId: string, signal?: AbortSignal) => Promise<string>): ConversationStreamDeps {
    return {
      dispatcher: {
        dispatch: async () => ({ status: 'dispatched', issueId: 'iss-1', agentId: 'ag-1', run: codexRun }),
        findActiveRun: async () => null,
        ...(readRunStdout ? { readRunStdout } : {}),
      },
      openEventSource: () => source,
    };
  }

  it('recovers truncated Codex stdout from this exact run and emits one complete final', async () => {
    const final = JSON.stringify({ api: '中'.repeat(12000), tests: 'passed' });
    const reader = vi.fn(async () => codexMessage('Investigating first.') + codexMessage(final));
    const source = fakeSource([log('r-1', codexMessage('Investigating first.')), truncatedLog(), status('r-1', 'succeeded')]);
    const controller = new AbortController();
    const frames = await collect(streamConversationTurn(codexDeps(source, reader), INPUT, controller.signal));
    expect(reader).toHaveBeenCalledWith('r-1', controller.signal);
    expect(frames.filter(frame => frame.event === 'delta')).toEqual([{ event: 'delta', text: final }]);
    expect(frames.at(-1)).toEqual({ event: 'done', status: 'succeeded' });
  });

  it('never reads logs for an unrelated run truncation or a complete Codex stream', async () => {
    const reader = vi.fn(async () => 'must not read');
    const final = '{"api":"ready"}';
    const source = fakeSource([truncatedLog('other-run'), log('r-1', codexMessage(final)), status('r-1', 'succeeded')]);
    const frames = await collect(streamConversationTurn(codexDeps(source, reader), INPUT));
    expect(reader).not.toHaveBeenCalled();
    expect(frames.filter(frame => frame.event === 'delta')).toEqual([{ event: 'delta', text: final }]);
  });

  it('a missing or failed recovery is an error with partial evidence, never a succeeded done', async () => {
    for (const reader of [undefined, async () => { throw new Error('sensitive internal path'); }]) {
      const source = fakeSource([log('r-1', codexMessage('partial evidence')), truncatedLog(), status('r-1', 'succeeded')]);
      const frames = await collect(streamConversationTurn(codexDeps(source, reader), INPUT));
      expect(frames.filter(frame => frame.event === 'delta')).toEqual([{ event: 'delta', text: 'partial evidence' }]);
      expect(frames.at(-1)).toMatchObject({ event: 'error' });
      expect(JSON.stringify(frames)).not.toContain('sensitive internal path');
      expect(frames.some(frame => frame.event === 'done')).toBe(false);
    }
  });

  it('cannot pass a damaged persisted final as the earlier valid assistant message', async () => {
    const reader = async () => codexMessage('earlier candidate') + '{"type":"item.completed","item":{"type":"agent_message","text":"cut';
    const frames = await collect(streamConversationTurn(codexDeps(fakeSource([truncatedLog(), status('r-1', 'succeeded')]), reader), INPUT));
    expect(frames.at(-1)).toMatchObject({ event: 'error' });
    expect(frames.some(frame => frame.event === 'done')).toBe(false);
  });

  it('rejects a damaged normal Codex final instead of succeeding with an earlier candidate', async () => {
    for (const ending of ['', '\n']) {
      const damaged = '{"type":"item.completed","item":{"type":"agent_message","text":"cut' + ending;
      const source = fakeSource([log('r-1', codexMessage('earlier candidate') + damaged), status('r-1', 'succeeded')]);
      const frames = await collect(streamConversationTurn(codexDeps(source), INPUT));
      expect(frames.at(-1)).toMatchObject({ event: 'error' });
      expect(frames.some(frame => frame.event === 'done' || frame.status === 'succeeded')).toBe(false);
      expect(frames.filter(frame => frame.event === 'delta')).toEqual([{ event: 'delta', text: 'earlier candidate' }]);
    }
  });

  it('a recovered failed run preserves its final partial and remains failed', async () => {
    const frames = await collect(streamConversationTurn(codexDeps(fakeSource([truncatedLog(), status('r-1', 'failed')]), async () => codexMessage('partial result')), INPUT));
    expect(frames.filter(frame => frame.event === 'delta')).toEqual([{ event: 'delta', text: 'partial result' }]);
    expect(frames.at(-1)).toEqual({ event: 'done', status: 'failed' });
  });

  it('Codex source close flushes pending text as partial then no_run', async () => {
    const frames = await collect(streamConversationTurn(codexDeps(fakeSource([log('r-1', codexMessage('partial answer').trimEnd())])), INPUT));
    expect(frames.filter(frame => frame.event === 'delta')).toEqual([{ event: 'delta', text: 'partial answer' }]);
    expect(frames.at(-1)).toMatchObject({ event: 'no_run' });
    expect(frames.some(frame => frame.event === 'done')).toBe(false);
  });

  it('Codex source exception flushes pending text as partial then error', async () => {
    const source: CompanyEventSource = {
      close: vi.fn(),
      async *[Symbol.asyncIterator]() { yield log('r-1', codexMessage('partial answer')); throw new Error('socket failed'); },
    };
    const frames = await collect(streamConversationTurn(codexDeps(source), INPUT));
    expect(frames.filter(frame => frame.event === 'delta')).toEqual([{ event: 'delta', text: 'partial answer' }]);
    expect(frames.at(-1)).toMatchObject({ event: 'error' });
    expect(frames.some(frame => frame.event === 'done')).toBe(false);
  });
});
