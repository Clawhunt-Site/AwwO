// P3d — orchestrate one per-agent conversation turn into a stream of chat frames
// (gateway BFF, ZERO server/ change). Ties together:
//   dispatcher (wake the specific agent) + run discovery (issue-scoped /live-runs)
//   + RunStreamProjector (company WS firehose → this run's frames).
//
// Order of operations matters (subscribe-before-wake): the company event source
// is opened and starts BUFFERING *before* the wake fires, so a fast/short run's
// events are not missed. The runId is then discovered from the issue-scoped
// /live-runs (the only reliable attribution key — WS queued/status carry no
// issueId); once known, the buffered-then-live events are projected by runId.
//
// Transport-agnostic + fully injectable: the event source is an async iterable,
// the dispatcher + clock are injected — so this is unit-tested with fakes, no
// real WebSocket. The real WS adapter + the SSE route wrap this (part 2c).

import type { AgentConversationDispatcher, DispatchInput, ActiveRun } from './dispatcher.js';
import { RunStreamProjector, type LiveEventFrame } from './run-stream.js';

/** Frames yielded for a conversation turn — mapped 1:1 to SSE events by the route. */
export type ConversationFrame =
  // The turn was accepted: the message landed on the issue; runVisible is evidence of a run.
  | { event: 'accepted'; issueId: string; runId: string | null; runVisible: boolean }
  | { event: 'delta'; text: string } // a chunk of the agent's textual output
  | { event: 'phase'; phase: string; message: string | null } // progress note
  | { event: 'status'; status: string } // run status transition
  | { event: 'done'; status: string } // the run ended
  // Honest terminal states that are NOT a normal run completion:
  | { event: 'error'; detail: string } // dispatch failed — nothing delivered
  // Message delivered, but no run became visible before we gave up.
  // NOT a failure of delivery, and NOT a fake "replied" — the operator can re-check.
  | { event: 'no_run'; issueId: string; detail: string };

/** An abortable async stream of decoded company LiveEvents (the WS adapter). */
export interface CompanyEventSource extends AsyncIterable<LiveEventFrame> {
  close(): void;
}

export interface ConversationStreamDeps {
  dispatcher: Pick<AgentConversationDispatcher, 'dispatch' | 'findActiveRun'> & Partial<Pick<AgentConversationDispatcher, 'readRunStdout'>>;
  /** Open a BUFFERING event stream for the company (subscribe-before-wake). */
  openEventSource: (companyId: string) => CompanyEventSource;
  /** Sleep (injected for tests). Defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /** How many times / how often to poll /live-runs for the run to appear. */
  runDiscoveryAttempts?: number;
  runDiscoveryDelayMs?: number;
}

const DEFAULT_DISCOVERY_ATTEMPTS = 8;
const DEFAULT_DISCOVERY_DELAY_MS = 500;

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drive one conversation turn and yield its frames. Never throws — every failure
 * path yields an honest terminal frame ('error' | 'no_run' | 'done'). The event
 * source is always closed on exit.
 */
export async function* streamConversationTurn(
  deps: ConversationStreamDeps,
  input: DispatchInput,
  /** Aborting (e.g. the SSE client disconnected) closes the event source, which
   *  unblocks the projection loop so the turn ends promptly. */
  signal?: AbortSignal,
): AsyncGenerator<ConversationFrame> {
  const delay = deps.delay ?? realDelay;
  const attempts = deps.runDiscoveryAttempts ?? DEFAULT_DISCOVERY_ATTEMPTS;
  const discoveryDelay = deps.runDiscoveryDelayMs ?? DEFAULT_DISCOVERY_DELAY_MS;

  // Subscribe FIRST so events between now and the wake are buffered, not lost.
  let events: CompanyEventSource;
  try {
    events = deps.openEventSource(input.companyId);
  } catch {
    // Can't even open the stream — nothing was dispatched. Honest error.
    yield { event: 'error', detail: 'failed to open the company event stream' };
    return;
  }
  // A caller abort (client disconnect) closes the source so the projection loop
  // below unblocks; the finally still closes it on every normal path too.
  const onAbort = () => events.close();
  if (signal) {
    if (signal.aborted) events.close();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let projector: RunStreamProjector | null = null;
  try {
    const dispatched = await deps.dispatcher.dispatch(input);
    if (dispatched.status === 'error') {
      yield { event: 'error', detail: dispatched.detail };
      return;
    }

    const issueId = dispatched.issueId;
    let run: ActiveRun | null = dispatched.status === 'dispatched' ? dispatched.run : null;

    // If the run wasn't visible on dispatch, poll the ISSUE-SCOPED /live-runs for
    // it (reliable attribution) — buffering continues on `events` meanwhile.
    for (let i = 0; !run && i < attempts; i += 1) {
      await delay(discoveryDelay);
      run = await deps.dispatcher.findActiveRun(issueId, input.agentId);
    }

    yield { event: 'accepted', issueId, runId: run?.runId ?? null, runVisible: run !== null };

    if (!run) {
      // No run surfaced in time. The message DID land on the
      // issue (the agent may still pick it up / may have replied via a comment);
      // we just have no live run to stream. Not a fake completion.
      yield { event: 'no_run', issueId, detail: 'message delivered; no live run appeared in time' };
      return;
    }

    // Project the company firehose down to THIS run, buffered-then-live.
    projector = new RunStreamProjector({ runId: run.runId, adapterType: run.adapterType });
    // Seed the initial status (the discovered run may already be running).
    yield { event: 'status', status: run.status };
    for await (const ev of events) {
      if (projector.needsLogRecovery && projector.terminalStatus(ev)) {
        try {
          if (!deps.dispatcher.readRunStdout) throw new Error('Run log reader unavailable');
          const stdout = await deps.dispatcher.readRunStdout(run.runId, signal);
          const recovered = new RunStreamProjector({ runId: run.runId, adapterType: run.adapterType });
          // Replay the complete log through the same decoder. Historical phases
          // are ignored; the original stream has already shown live progress.
          recovered.handle({ type: 'heartbeat.run.log', payload: { runId: run.runId, stream: 'stdout', chunk: stdout } });
          const recoveredFrames = recovered.handle(ev);
          if (recovered.hasMalformedCodexLog || !recoveredFrames.some(frame => frame.kind === 'delta')) throw new Error('Incomplete persisted output');
          for (const frame of recoveredFrames) yield mapFrame(frame);
        } catch {
          for (const frame of projector.flushPartial()) yield mapFrame(frame);
          yield { event: 'error', detail: '运行日志不完整，暂时无法确认完整交付物。请稍后查看该次运行记录。' };
        }
        return;
      }
      const projected = projector.handle(ev);
      // A damaged final JSONL line can arrive without the WS truncated marker,
      // including as the trailing line flushed by terminal handling. Earlier
      // candidates remain partial evidence, never a confirmed final delivery.
      if (projector.hasMalformedCodexLog && projected.some(frame => frame.kind === 'done' && frame.status === 'succeeded')) {
        for (const frame of projected) if (frame.kind === 'delta') yield mapFrame(frame);
        yield { event: 'error', detail: '运行日志不完整，无法确认最终交付物。请查看该次运行记录后重试。' };
        return;
      }
      for (const frame of projected) {
        yield mapFrame(frame);
      }
      if (projector.isDone) return;
    }
    // The source ended without a terminal status (WS closed / aborted). Honest —
    // don't fabricate a 'done'; report the stream ended without a terminal signal.
    for (const frame of projector.flushPartial()) yield mapFrame(frame);
    yield { event: 'no_run', issueId, detail: 'event stream ended before the run reported a terminal status' };
  } catch (err) {
    // Contract: never throw. An unexpected dependency failure (a non-fail-soft
    // fetch / socket iterator) becomes an honest error frame — never a rejection
    // and never a fabricated completion.
    for (const frame of projector?.flushPartial() ?? []) yield mapFrame(frame);
    yield { event: 'error', detail: err instanceof Error ? err.message : 'conversation stream failed' };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    events.close();
  }
}

function mapFrame(frame: ReturnType<RunStreamProjector['handle']>[number]): ConversationFrame {
  switch (frame.kind) {
    case 'delta':
      return { event: 'delta', text: frame.text };
    case 'phase':
      return { event: 'phase', phase: frame.phase, message: frame.message };
    case 'status':
      return { event: 'status', status: frame.status };
    case 'done':
      return { event: 'done', status: frame.status };
  }
}
