import { describe, expect, it } from 'vitest';
import {
  RunStreamProjector,
  isLiveRunStatus,
  isStreamJsonAdapter,
  isTerminalRunStatus,
  type LiveEventFrame,
} from './run-stream.js';

const CLAUDE = { runId: 'r-1', adapterType: 'claude_local' };

function log(runId: string, chunk: string, stream = 'stdout'): LiveEventFrame {
  return { type: 'heartbeat.run.log', payload: { runId, stream, chunk } };
}
// Real claude stdout wraps token deltas in a stream_event envelope.
function streamEventDelta(text: string): string {
  return JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) + '\n';
}

describe('isTerminalRunStatus', () => {
  it('uses explicit live and terminal states without guessing unknown statuses', () => {
    expect(isTerminalRunStatus('queued')).toBe(false);
    expect(isTerminalRunStatus('scheduled_retry')).toBe(false);
    expect(isTerminalRunStatus('running')).toBe(false);
    expect(isTerminalRunStatus('succeeded')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('future_state')).toBe(false);
    expect(isTerminalRunStatus('')).toBe(false);
    expect(isLiveRunStatus('queued')).toBe(true);
    expect(isLiveRunStatus('scheduled_retry')).toBe(true);
    expect(isLiveRunStatus('running')).toBe(true);
    expect(isLiveRunStatus('succeeded')).toBe(false);
  });
});

describe('isStreamJsonAdapter', () => {
  it('Claude and Codex families are structured; other adapters remain raw', () => {
    expect(isStreamJsonAdapter('claude_local')).toBe(true);
    expect(isStreamJsonAdapter('claude')).toBe(true);
    expect(isStreamJsonAdapter('gemini_cli')).toBe(false);
    expect(isStreamJsonAdapter('codex')).toBe(true);
    expect(isStreamJsonAdapter('codex_local')).toBe(true);
    expect(isStreamJsonAdapter(null)).toBe(false);
    expect(isStreamJsonAdapter(undefined)).toBe(false);
  });
});

describe('RunStreamProjector — Codex JSONL final delivery', () => {
  const codex = () => new RunStreamProjector({ runId: 'r-1', adapterType: 'codex_local' });
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  const message = (text: string, phase?: string) => line({ type: 'item.completed', item: { type: 'agent_message', text, ...(phase ? { phase } : {}) } });
  const finish = (projector: RunStreamProjector, status = 'succeeded') => projector.handle({ type: 'heartbeat.run.status', payload: { runId: 'r-1', status } });
  const deltas = (frames: ReturnType<RunStreamProjector['handle']>) => frames.filter(frame => frame.kind === 'delta');
  const final = '{"api":"/api/users","tests":"passed","notes":"ready"}';

  it('keeps commentary pending and delivers only the final assistant JSON at run completion', () => {
    const projector = codex();
    expect(deltas(projector.handle(log('r-1', line({ type: 'thread.started', thread_id: 'thread-1' }) + line({ type: 'turn.started' }) + message('I will inspect the data first.'))))).toEqual([]);
    expect(deltas(projector.handle(log('r-1', message(final) + line({ type: 'turn.completed', usage: { output_tokens: 32 } }))))).toEqual([]);
    expect(finish(projector)).toEqual([{ kind: 'delta', text: final }, { kind: 'status', status: 'succeeded' }, { kind: 'done', status: 'succeeded' }]);
    expect(projector.handle(log('r-1', message('late')))).toEqual([]);
  });

  it('joins split JSONL chunks and flushes the final line without a newline', () => {
    const projector = codex(); const raw = message(final).trimEnd();
    const split = raw.indexOf('agent_message') + 4;
    expect(projector.handle(log('r-1', raw.slice(0, split)))).toEqual([]);
    expect(projector.handle(log('r-1', raw.slice(split)))).toEqual([]);
    expect(deltas(finish(projector))).toEqual([{ kind: 'delta', text: final }]);
  });

  it('never treats tool output, reasoning, runtime noise or another run as a delivery', () => {
    const projector = codex();
    const events = line({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: '{"api":"fake"}' } })
      + line({ type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } })
      + line({ type: 'item.completed', item: { type: 'mcp_tool_call', result: { text: 'not a delivery' } } });
    expect(deltas(projector.handle(log('r-1', 'runtime setup\n{invalid\n' + events)))).toEqual([]);
    expect(projector.handle(log('other-run', message(final)))).toEqual([]);
    expect(deltas(finish(projector))).toEqual([]);
  });

  it('keeps a failed turn partial as evidence without reporting success', () => {
    const projector = codex();
    projector.handle(log('r-1', message('The schema is partly drafted.') + line({ type: 'turn.failed', error: { message: 'failed' } })));
    expect(finish(projector, 'failed')).toEqual([{ kind: 'delta', text: 'The schema is partly drafted.' }, { kind: 'status', status: 'failed' }, { kind: 'done', status: 'failed' }]);
  });

  it('does not concatenate a previous turn final into the last turn result', () => {
    const projector = codex();
    expect(deltas(projector.handle(log('r-1', line({ type: 'turn.started' }) + message('{"api":"old"}') + line({ type: 'turn.completed' }))))).toEqual([]);
    expect(deltas(projector.handle(log('r-1', line({ type: 'turn.started' }) + message('Updating the proposal.') + message(final) + line({ type: 'turn.completed' }))))).toEqual([]);
    expect(deltas(finish(projector))).toEqual([{ kind: 'delta', text: final }]);
  });

  it('cannot reuse a previous completed turn when the next turn has no assistant output', () => {
    const projector = codex();
    projector.handle(log('r-1', line({ type: 'turn.started' }) + message(final) + line({ type: 'turn.completed' }) + line({ type: 'turn.started' }) + line({ type: 'turn.failed' })));
    expect(deltas(finish(projector, 'failed'))).toEqual([]);
  });

  it('honors explicit commentary phases while supporting older phase-less messages', () => {
    const projector = codex();
    expect(deltas(projector.handle(log('r-1', message('still working', 'commentary'))))).toEqual([]);
    expect(deltas(finish(projector))).toEqual([]);
    const finalProjector = codex();
    finalProjector.handle(log('r-1', message('still working', 'commentary') + message(final, 'final_answer')));
    expect(deltas(finish(finalProjector))).toEqual([{ kind: 'delta', text: final }]);
  });

  it('ignores command event JSON damaged by upstream text redaction, preserving a valid final', () => {
    const projector = codex();
    const command = '{"type":"item.completed","item":{"id":"item_8","type":"command_execution","command":"header ***REDACTED***"Bearer token omitted","exit_code":0}}\n';
    projector.handle(log('r-1', command + command.replace('item.completed', 'item.started') + message(final)));
    expect(deltas(finish(projector))).toEqual([{ kind: 'delta', text: final }]);
    expect(projector.hasMalformedCodexLog).toBe(false);
  });

  it('still rejects damaged assistant and unknown events even if text mentions a command event', () => {
    for (const damaged of [
      '{"type":"item.completed","item":{"id":"item_8","type":"agent_message","text":"***REDACTED***"cut',
      '{"type":"item.completed","item":{"id":"item_8","type":"unknown","text":"***REDACTED***"cut',
      '{"type":"item.completed","item":{"id":"item_8","type":"agent_message","text":"prefix "type":"command_execution" cut',
    ]) {
      const projector = codex(); projector.handle(log('r-1', message(final) + damaged)); finish(projector);
      expect(projector.hasMalformedCodexLog).toBe(true);
    }
  });
});

describe('RunStreamProjector — runId attribution', () => {
  it('follows only the given runId; ignores every other run on the shared socket', () => {
    const p = new RunStreamProjector(CLAUDE);
    // another run's queued + log — must be ignored (no issueId/agentId reliance)
    expect(p.handle({ type: 'heartbeat.run.queued', payload: { runId: 'r-OTHER', agentId: 'ag-9' } })).toEqual([]);
    expect(p.handle(log('r-OTHER', streamEventDelta('nope')))).toEqual([]);
    // our run
    expect(p.handle({ type: 'heartbeat.run.queued', payload: { runId: 'r-1', agentId: 'ag-1' } })).toEqual([
      { kind: 'status', status: 'queued' },
    ]);
    expect(p.handle(log('r-1', streamEventDelta('hi')))).toEqual([{ kind: 'delta', text: 'hi' }]);
  });
});

describe('RunStreamProjector — claude stream-json extraction', () => {
  it('extracts text from stream_event/content_block_delta and concatenates', () => {
    const p = new RunStreamProjector(CLAUDE);
    expect(p.handle(log('r-1', '{"type":"message_start"}\n'))).toEqual([]); // no text
    expect(p.handle(log('r-1', streamEventDelta('Hello ')))).toEqual([{ kind: 'delta', text: 'Hello ' }]);
    expect(p.handle(log('r-1', streamEventDelta('world')))).toEqual([{ kind: 'delta', text: 'world' }]);
  });

  it('handles the UNWRAPPED content_block_delta variant too', () => {
    const p = new RunStreamProjector(CLAUDE);
    const line = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '直接' } }) + '\n';
    expect(p.handle(log('r-1', line))).toEqual([{ kind: 'delta', text: '直接' }]);
  });

  it('assistant consolidated message is a FALLBACK — skipped once live text streamed', () => {
    const p = new RunStreamProjector(CLAUDE);
    p.handle(log('r-1', streamEventDelta('streamed')));
    const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'streamed' }] } }) + '\n';
    expect(p.handle(log('r-1', assistant))).toEqual([]); // deduped, not double-emitted
  });

  it('assistant consolidated IS emitted when nothing streamed live (non-verbose)', () => {
    const p = new RunStreamProjector(CLAUDE);
    const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '完整回复' }, { type: 'tool_use', id: 't', name: 'edit' }] } }) + '\n';
    expect(p.handle(log('r-1', assistant))).toEqual([{ kind: 'delta', text: '完整回复' }]);
  });

  it('buffers a stream_event line split across two log chunks', () => {
    const p = new RunStreamProjector(CLAUDE);
    const full = streamEventDelta('spanned');
    const half = Math.floor(full.length / 2);
    expect(p.handle(log('r-1', full.slice(0, half)))).toEqual([]);
    expect(p.handle(log('r-1', full.slice(half)))).toEqual([{ kind: 'delta', text: 'spanned' }]);
  });
});

describe('RunStreamProjector — raw (non-claude) adapter', () => {
  it('forwards raw stdout verbatim, INCLUDING a JSON-looking first line (no drop)', () => {
    const p = new RunStreamProjector({ runId: 'r-1', adapterType: 'gemini_cli' });
    expect(p.handle(log('r-1', '{"answer":"hi"}\n'))).toEqual([{ kind: 'delta', text: '{"answer":"hi"}\n' }]);
    expect(p.handle(log('r-1', 'plain line\n'))).toEqual([{ kind: 'delta', text: 'plain line\n' }]);
  });

  it('preserves newlines between separately-chunked raw lines', () => {
    const p = new RunStreamProjector({ runId: 'r-1', adapterType: 'gemini_cli' });
    expect(p.handle(log('r-1', 'a\nb\n'))).toEqual([{ kind: 'delta', text: 'a\nb\n' }]);
    expect(p.handle(log('r-1', 'c\n'))).toEqual([{ kind: 'delta', text: 'c\n' }]);
  });
});

describe('RunStreamProjector — streams, progress, terminal', () => {
  it('keeps scheduled retries live and accepts later output from the same run', () => {
    const p = new RunStreamProjector(CLAUDE);
    expect(p.handle({ type: 'heartbeat.run.status', payload: { runId: 'r-1', status: 'scheduled_retry' } })).toEqual([
      { kind: 'status', status: 'scheduled_retry' },
    ]);
    expect(p.isDone).toBe(false);
    expect(p.handle(log('r-1', streamEventDelta('after retry')))).toEqual([{ kind: 'delta', text: 'after retry' }]);
  });

  it('ignores stderr/system streams (not chat text)', () => {
    const p = new RunStreamProjector(CLAUDE);
    expect(p.handle(log('r-1', 'a warning\n', 'stderr'))).toEqual([]);
    expect(p.handle(log('r-1', '[system]\n', 'system'))).toEqual([]);
  });

  it('projects progress into a phase frame', () => {
    const p = new RunStreamProjector(CLAUDE);
    expect(
      p.handle({ type: 'heartbeat.run.progress', payload: { runId: 'r-1', phase: 'implement', message: '写代码' } }),
    ).toEqual([{ kind: 'phase', phase: 'implement', message: '写代码' }]);
  });

  it('a terminal status flushes buffered tail, emits done, and stops', () => {
    const p = new RunStreamProjector(CLAUDE);
    expect(p.handle(log('r-1', streamEventDelta('tail').replace(/\n$/, '')))).toEqual([]); // no newline → buffered
    const frames = p.handle({ type: 'heartbeat.run.status', payload: { runId: 'r-1', status: 'succeeded' } });
    expect(frames).toEqual([
      { kind: 'delta', text: 'tail' },
      { kind: 'status', status: 'succeeded' },
      { kind: 'done', status: 'succeeded' },
    ]);
    expect(p.isDone).toBe(true);
    expect(p.handle(log('r-1', streamEventDelta('late')))).toEqual([]);
  });
});
