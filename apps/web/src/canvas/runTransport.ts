import { canvasFetch } from '../saas/canvasBridge';
// Gateway transport for graph runs — a thin adapter turning ONE session-node execution into ONE
// turn on that node's own gateway conversation, riding the exact SSE client the tile composers
// use (streamAgentConversation).
//
// Ported from the verified studio workflow transport, with two changes:
//
//  (a) The turn lands on THIS NODE's own issueId, not on "the bound agent's most recent
//      conversation". On this canvas two tiles may be bound to the same agent; routing a run to
//      the agent's latest issue would drop the run into whichever tile spoke last. A server-minted
//      id is reported back through `onIssueId` so the caller persists it on the node.
//  (b) Every frame is ALSO mirrored into the session store for that node, so the tile shows the
//      run happening live INSIDE itself — the run and the manual composer share one transcript.
//
// Honest mapping, no fake success: ok=true ONLY when the run's terminal status is 'succeeded'.
// FIRST terminal frame wins. Partial streamed text is kept as evidence either way.

import { streamAgentConversation, type AgentChatFrame } from '../canvasAgentChat';
import type { SessionNode } from './canvasDoc';
import type { ExecAgentResult } from './runGraph';
import { withPerKeySerialization } from './runGraph';
import {
  COPY,
  beginStream,
  endStream,
  isStreamCurrent,
  markLocalSend,
  statusLabel,
} from './sessionTransport';
import * as sessions from './sessions';
import { activeThreadId, sessionStoreKey } from './nodeThreads';

const STATUS_LABEL: Record<string, string> = {
  succeeded: '已完成',
  failed: '运行失败',
  cancelled: '已取消',
  timed_out: '超时',
};

export interface ExecAgentOptions {
  /** Persist a server-minted issueId onto the node — the next turn must continue this thread. */
  onIssueId?: (issueId: string) => void;
  /** Persist the native identity as soon as the gateway exposes it (refresh recovery). */
  onRunAccepted?: (identity: { issueId: string; runId: string | null }) => void;
  /** A failed Stop remains live/locked; surface the reason without claiming cancellation. */
  onCancelFailure?: (detail: string) => void;
  cancelRun?: typeof cancelConversationRunViaGateway;
  /** Stable identity persisted in the run journal before any upstream mutation. */
  operationId?: string;
  signal?: AbortSignal;
}

export interface NativeCancelResult {
  confirmed: boolean;
  cancelled: boolean;
  status: string;
  detail?: string;
}

/** Ask the gateway to park this conversation and confirm its native run is terminal. */
export async function cancelConversationRunViaGateway(
  gatewayBase: string,
  binding: NonNullable<SessionNode['binding']>,
  issueId: string,
  runId?: string | null,
): Promise<NativeCancelResult> {
  try {
    const base = gatewayBase.replace(/\/+$/, '');
    const response = await canvasFetch(
      `${base}/conversations/${encodeURIComponent(binding.companyId)}/agents/${encodeURIComponent(binding.agentId)}/issues/${encodeURIComponent(issueId)}/cancel`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'include',
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify(runId ? { runId } : {}),
      },
    );
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || body?.confirmed !== true) {
      return { confirmed: false, cancelled: false, status: 'running', detail: typeof body?.detail === 'string' ? body.detail : `gateway responded ${response.status}` };
    }
    return {
      confirmed: true,
      cancelled: body.cancelled === true,
      status: typeof body.status === 'string' && body.status ? body.status : (body.cancelled === true ? 'cancelled' : 'terminal'),
    };
  } catch {
    return { confirmed: false, cancelled: false, status: 'running', detail: 'native stop request failed' };
  }
}

export async function execAgentViaGateway(
  gatewayBase: string,
  node: SessionNode,
  message: string,
  opts: ExecAgentOptions = {},
): Promise<ExecAgentResult> {
  const { onIssueId, onRunAccepted, onCancelFailure, operationId, signal } = opts;
  const binding = node.binding;
  const storeKey = sessionStoreKey(node);
  if (!binding) return { ok: false, output: '', detail: '节点未绑定真实 Agent' };
  // A queued same-Agent execution can reach the executor only after the operator stopped the
  // graph. Do not append a phantom transcript turn or POST a new upstream mutation.
  if (signal?.aborted) return { ok: false, cancelled: true, output: '', detail: 'cancelled_before_dispatch' };

  // The run turn is a real local turn on this thread: mark it so a later history replay cannot
  // clobber it, and mirror it into the tile exactly as the composer would.
  markLocalSend(storeKey);
  const token = beginStream(storeKey);
  const mirroring = () => isStreamCurrent(storeKey, token);
  sessions.appendTurn(storeKey, { role: 'user', text: message });
  const agentTurnId = sessions.appendTurn(storeKey, { role: 'agent', text: '' });
  sessions.setStreaming(storeKey, true);
  sessions.setStatus(storeKey, 'queued');

  let issueId: string | undefined = node.issueId ?? undefined;
  const reportIssue = (next: string) => {
    if (!next || next === issueId) return;
    issueId = next;
    onIssueId?.(next);
  };

  let text = '';
  let gotText = false;
  let nativeCancelled = false;
  // FIRST terminal frame wins. A late frame must never rewrite an already-decided outcome
  // (e.g. a stream-teardown 'error' after 'done: succeeded' would flip a real success into a
  // failure — or worse, the reverse would fake a success after an error).
  let terminal:
    | { kind: 'done'; status: string }
    | { kind: 'no_run'; detail: string }
    | { kind: 'error'; detail: string; code?: string }
    | null = null;

  // The graph's signal means "request a real Stop", not "detach this browser fetch". Keep a
  // separate transport controller so the SSE stays attached until the gateway has confirmed the
  // native process/wake is terminal. If cancellation fails, the stream remains live and the
  // canvas stays locked until a real terminal event arrives.
  const transport = new AbortController();
  let stopRequested = signal?.aborted === true;
  let runId: string | null = null;
  let cancellation: Promise<void> | null = null;
  const beginCancellation = () => {
    if (!stopRequested || !issueId || cancellation || terminal) return;
    const cancel = opts.cancelRun ?? cancelConversationRunViaGateway;
    cancellation = cancel(gatewayBase, binding, issueId, runId).then((result) => {
      if (!result.confirmed) {
        const detail = result.detail || '原生运行取消未确认';
        onCancelFailure?.(detail);
        if (mirroring()) sessions.setStatus(storeKey, `停止失败 · ${detail}`);
        return;
      }
      if (terminal?.kind === 'done') return;
      if (!result.cancelled) {
        // Stop can observe a run that completed naturally. Its status alone does not prove
        // the SSE delivered the complete output; recover that output by run ID before success.
        terminal = { kind: 'error', detail: 'native_terminal_output_unconfirmed' };
        transport.abort();
        return;
      }
      nativeCancelled = result.cancelled;
      terminal = { kind: 'done', status: result.status };
      if (mirroring()) {
        const note = result.cancelled ? COPY.stopped : COPY.doneEmpty(statusLabel(result.status));
        if (!gotText) sessions.patchTurn(storeKey, agentTurnId, note, 'info');
        else sessions.appendTurn(storeKey, { role: 'system', text: note, tone: 'info' });
      }
      transport.abort();
    }).catch(() => {
      onCancelFailure?.('原生运行取消未确认');
    });
  };
  const requestStop = () => { stopRequested = true; beginCancellation(); };
  signal?.addEventListener('abort', requestStop, { once: true });

  const onFrame = (f: AgentChatFrame) => {
    // The first terminal closes this transport's state machine. A gateway/socket teardown may
    // still deliver buffered progress or stdout afterwards; accepting any of it would mutate a
    // result the UI has already classified and can even make invalid JSON look valid/vice versa.
    if (terminal) return;
    switch (f.event) {
      case 'accepted':
        reportIssue(f.issueId);
        runId = f.runId;
        onRunAccepted?.({ issueId: f.issueId, runId: f.runId });
        beginCancellation();
        if (mirroring() && !f.runVisible) sessions.patchTurn(storeKey, agentTurnId, COPY.thinking, 'info');
        break;
      case 'delta':
        text += f.text;
        if (mirroring()) {
          if (!gotText) {
            gotText = true;
            sessions.patchTurn(storeKey, agentTurnId, '');
          }
          sessions.appendToTurn(storeKey, agentTurnId, f.text);
        }
        break;
      case 'phase':
        if (mirroring()) sessions.setStatus(storeKey, COPY.phaseLabel(f.phase, f.message));
        break;
      case 'status':
        if (mirroring()) sessions.setStatus(storeKey, f.status);
        break;
      case 'done':
        if (!terminal) terminal = { kind: 'done', status: f.status };
        if (mirroring() && !gotText) {
          sessions.patchTurn(storeKey, agentTurnId, COPY.doneEmpty(statusLabel(f.status)), 'info');
        }
        break;
      case 'no_run':
        reportIssue(f.issueId);
        beginCancellation();
        if (!terminal) terminal = { kind: 'no_run', detail: f.detail };
        if (mirroring() && !gotText) sessions.patchTurn(storeKey, agentTurnId, COPY.noRun(f.detail), 'warn');
        break;
      case 'error': {
        if (!terminal) terminal = { kind: 'error', detail: f.detail, ...(f.code ? { code: f.code } : {}) };
        // Transport loss is not proof of native cancellation. The durable operation remains
        // recoverable, and only the confirmed cancellation path above may say it stopped.
        const aborted = f.detail === 'aborted';
        const text = aborted ? '连接中断，正在核对运行状态。' : COPY.errorPrefix + f.detail;
        const tone = aborted ? 'warn' : 'error';
        if (mirroring()) {
          if (!gotText) sessions.patchTurn(storeKey, agentTurnId, text, tone);
          else sessions.appendTurn(storeKey, { role: 'system', text, tone });
        }
        break;
      }
      default:
        break;
    }
  };

  try {
    await streamAgentConversation(gatewayBase, binding.companyId, binding.agentId, message, onFrame, {
      issueId,
      nodeId: node.id,
      operationId,
      signal: transport.signal,
    });
    if (cancellation) await cancellation;
  } finally {
    signal?.removeEventListener('abort', requestStop);
    // Only the CURRENT stream may clear the tile's streaming state — a superseded stream
    // finishing late must not stop the spinner of the stream that replaced it.
    if (isStreamCurrent(storeKey, token)) {
      sessions.setStreaming(storeKey, false);
      sessions.setStatus(storeKey, null);
      endStream(storeKey, token);
    }
  }

  const t = terminal as
    | { kind: 'done'; status: string }
    | { kind: 'no_run'; detail: string }
    | { kind: 'error'; detail: string; code?: string }
    | null;
  if (!t) return { ok: false, unconfirmed: true, output: text, detail: '流在完成前中断（未收到终态）' };
  if (t.kind === 'error') return {
    ok: false,
    ...(t.code !== 'operation_prepare_failed' && (issueId || operationId) ? { unconfirmed: true } : {}),
    output: text,
    detail: t.detail,
  };
  if (t.kind === 'no_run') return { ok: false, unconfirmed: true, output: text, detail: `已投递但无可见运行${t.detail ? `（${t.detail}）` : ''}` };
  const ok = t.status === 'succeeded';
  if (ok && !text.trim()) return { ok: false, output: '', detail: 'empty_delivery' };
  return { ok, ...(nativeCancelled || t.status === 'cancelled' ? { cancelled: true } : {}), output: text, detail: STATUS_LABEL[t.status] ?? t.status };
}

export interface GatewayExecutorArgs {
  gatewayBase: string;
  /** Persist a server-minted issueId onto the given node. */
  onIssueId?: (nodeId: string, issueId: string, threadId?: string) => void;
  onRunAccepted?: (nodeId: string, identity: { issueId: string; runId: string | null }, threadId?: string) => void;
  onCancelFailure?: (nodeId: string, detail: string, threadId?: string) => void;
  /** Read the pre-persisted operation identity for this node/thread. */
  operationIdForNode?: (nodeId: string, threadId: string) => string | undefined;
  signal?: AbortSignal;
}

/**
 * The `execAgent` runGraph expects, already serialized per bound agent. Two nodes bound to the
 * SAME agent must never execute concurrently: the gateway continues that agent's conversation
 * and attaches to its live run, so parallel turns could cross-attribute outputs. Nodes bound to
 * different agents stay fully concurrent.
 */
export function createGatewayExecutor({ gatewayBase, onIssueId, onRunAccepted, onCancelFailure, operationIdForNode, signal }: GatewayExecutorArgs) {
  // Explicit type args: inference would otherwise take the arg tuple from `keyOf` alone (which
  // ignores `message`) and then reject the two-argument executor.
  return withPerKeySerialization<[SessionNode, string], ExecAgentResult>(
    (node) => (node.binding ? `${node.binding.companyId}/${node.binding.agentId}` : `unbound:${node.id}`),
    (node, message) =>
      execAgentViaGateway(gatewayBase, node, message, {
        signal,
        operationId: operationIdForNode?.(node.id, activeThreadId(node)),
        onIssueId: onIssueId ? (issueId) => onIssueId(node.id, issueId, activeThreadId(node)) : undefined,
        onRunAccepted: onRunAccepted ? (identity) => onRunAccepted(node.id, identity, activeThreadId(node)) : undefined,
        onCancelFailure: onCancelFailure ? (detail) => onCancelFailure(node.id, detail, activeThreadId(node)) : undefined,
      }),
  );
}
