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
  signal?: AbortSignal;
}

export async function execAgentViaGateway(
  gatewayBase: string,
  node: SessionNode,
  message: string,
  opts: ExecAgentOptions = {},
): Promise<ExecAgentResult> {
  const { onIssueId, signal } = opts;
  const binding = node.binding;
  const storeKey = sessionStoreKey(node);
  if (!binding) return { ok: false, output: '', detail: '节点未绑定真实 Agent' };

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
  // FIRST terminal frame wins. A late frame must never rewrite an already-decided outcome
  // (e.g. a stream-teardown 'error' after 'done: succeeded' would flip a real success into a
  // failure — or worse, the reverse would fake a success after an error).
  let terminal:
    | { kind: 'done'; status: string }
    | { kind: 'no_run'; detail: string }
    | { kind: 'error'; detail: string }
    | null = null;

  const onFrame = (f: AgentChatFrame) => {
    switch (f.event) {
      case 'accepted':
        reportIssue(f.issueId);
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
        if (!terminal) terminal = { kind: 'no_run', detail: f.detail };
        if (mirroring() && !gotText) sessions.patchTurn(storeKey, agentTurnId, COPY.noRun(f.detail), 'warn');
        break;
      case 'error': {
        if (!terminal) terminal = { kind: 'error', detail: f.detail };
        // A stop the operator asked for is not a failure: runGraph already marks the node
        // '已停止' from the abort signal, so the tile must not contradict it with 出错：aborted.
        const aborted = f.detail === 'aborted';
        const text = aborted ? COPY.stopped : COPY.errorPrefix + f.detail;
        const tone = aborted ? 'info' : 'error';
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
      signal,
    });
  } finally {
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
    | { kind: 'error'; detail: string }
    | null;
  if (!t) return { ok: false, output: text, detail: '流在完成前中断（未收到终态）' };
  if (t.kind === 'error') return { ok: false, output: text, detail: t.detail };
  if (t.kind === 'no_run') return { ok: false, output: text, detail: `已投递但无可见运行${t.detail ? `（${t.detail}）` : ''}` };
  const ok = t.status === 'succeeded';
  return { ok, output: text, detail: STATUS_LABEL[t.status] ?? t.status };
}

export interface GatewayExecutorArgs {
  gatewayBase: string;
  /** Persist a server-minted issueId onto the given node. */
  onIssueId?: (nodeId: string, issueId: string, threadId?: string) => void;
  signal?: AbortSignal;
}

/**
 * The `execAgent` runGraph expects, already serialized per bound agent. Two nodes bound to the
 * SAME agent must never execute concurrently: the gateway continues that agent's conversation
 * and attaches to its live run, so parallel turns could cross-attribute outputs. Nodes bound to
 * different agents stay fully concurrent.
 */
export function createGatewayExecutor({ gatewayBase, onIssueId, signal }: GatewayExecutorArgs) {
  // Explicit type args: inference would otherwise take the arg tuple from `keyOf` alone (which
  // ignores `message`) and then reject the two-argument executor.
  return withPerKeySerialization<[SessionNode, string], ExecAgentResult>(
    (node) => (node.binding ? `${node.binding.companyId}/${node.binding.agentId}` : `unbound:${node.id}`),
    (node, message) =>
      execAgentViaGateway(gatewayBase, node, message, {
        signal,
        onIssueId: onIssueId ? (issueId) => onIssueId(node.id, issueId, activeThreadId(node)) : undefined,
      }),
  );
}
