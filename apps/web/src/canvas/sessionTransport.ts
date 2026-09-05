// One tile's MANUAL conversation, over the gateway SSE client.
//
// This is the StudioChatBubble state machine lifted out of the component: the same honest frame
// mapping (accepted / delta / phase / status / done / no_run / error), the same local-send guard
// and stale-stream guard — but writing into the module-level session store (./sessions) instead
// of component state, so the transcript survives the tile being culled by the viewport and is
// shared with the graph run engine.
//
// KEY CHANGE from the studio version: a conversation is identified by THIS NODE's own issueId,
// not by "the bound agent's most recent conversation". Two tiles bound to the same agent are two
// distinct threads on one canvas; picking "the agent's latest issue" would silently merge them
// (and each tile's next turn would land in whichever thread was touched last). The node's issueId
// is passed in and reported back through `onIssueId` when the server mints one, so the caller can
// persist it on the node.
//
// Honest by construction: "talking to an agent" wakes its FULL worker — the reply is that
// execution, not a chatbot answer. Nothing here renders a state the gateway did not report.

import {
  fetchConversationIndex,
  fetchConversationMessages,
  streamAgentConversation,
  type AgentChatFrame,
} from '../canvasAgentChat';
import type { SessionNode } from './canvasDoc';
import * as sessions from './sessions';
import { sessionStoreKey } from './nodeThreads';

export const COPY = {
  thinking: '已投递，等待 agent 启动…',
  /** Reading the stored transcript FAILED. Deliberately distinct from an empty transcript —
   *  an unreadable history must never be shown as if nothing had ever been said. */
  historyUnavailable: '（无法读取历史对话，下面只显示本次新消息）',
  unbound: '本节点尚未绑定真实 Agent，无法对话。',
  noRun: (d: string) => `已投递给 agent，但暂无可见运行（它可能稍后以评论回复）。${d ? ` [${d}]` : ''}`,
  doneEmpty: (s: string) => `（本轮无文本输出，运行状态：${s}）`,
  errorPrefix: '出错：',
  /** A user-initiated stop is NOT an error. The SSE client reports it as an error frame whose
   *  detail is the internal string 'aborted'; showing that verbatim would both mislabel a
   *  deliberate action as a failure and leak an English internal token into the transcript. */
  stopped: '已停止（本轮由你中止）。',
  phaseLabel: (p: string, m: string | null) => `阶段：${p}${m ? ` · ${m}` : ''}`,
} as const;

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '超时',
};

/** Render helper for the raw status strings this module stores. */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

// ---- per-node stream tokens (the stale-stream guard) ---------------------------------------
//
// A node can have at most ONE current stream. A superseded stream (the operator sent again, or a
// graph run took over the same tile) must have its late frames DROPPED: a late 'accepted' would
// otherwise report a stale issueId onto the node, and a late 'error'/'aborted' would append to a
// conversation that has already moved on. Shared with runTransport so a run and a manual send on
// the same tile supersede each other correctly rather than interleaving.

const activeStream = new Map<string, symbol>();

/** Claim the node's stream slot; the returned token identifies this stream. */
export function beginStream(nodeId: string): symbol {
  const token = Symbol('canvas-stream');
  activeStream.set(nodeId, token);
  return token;
}

export function isStreamCurrent(nodeId: string, token: symbol): boolean {
  return activeStream.get(nodeId) === token;
}

/** Release the slot, but only if this stream still owns it. */
export function endStream(nodeId: string, token: symbol): void {
  if (activeStream.get(nodeId) === token) activeStream.delete(nodeId);
}

// ---- local-send guard ----------------------------------------------------------------------
//
// Once a turn has been sent from this client, a history replay must NOT replace the transcript:
// the replay would wipe the just-sent exchange (and any in-flight stream would be writing into a
// removed turn). In the studio component this was a ref cleared whenever the panel retargeted;
// here the store outlives the tile, so the mark is per-node and sticky — remounting a culled tile
// must not resurrect a stale server snapshot over live local turns.

const localSend = new Set<string>();

export function markLocalSend(nodeId: string): void {
  localSend.add(nodeId);
}

/** Forget everything this module tracks for a node. Call when the node is DELETED. */
export function forgetNode(nodeId: string): void {
  localSend.delete(nodeId);
  activeStream.delete(nodeId);
}

// ---- history restore -------------------------------------------------------------------------

export interface RestoreHistoryArgs {
  gatewayBase: string;
  node: SessionNode;
  signal?: AbortSignal;
}

/**
 * Replay this node's OWN stored thread into the store.
 *
 * The conversation index is consulted as the store-readability probe: `null` means "could not
 * read", which becomes history:'unreadable' — never an empty transcript. The thread itself is
 * selected by the node's own issueId, never by "the agent's latest conversation".
 */
export async function restoreHistory({ gatewayBase, node, signal }: RestoreHistoryArgs): Promise<void> {
  const binding = node.binding;
  const storeKey = sessionStoreKey(node);
  // An unbound node cannot have a conversation, and a node that has never sent a turn has no
  // thread of its own yet. Both are honestly 'loaded' (we know there is nothing), NOT 'unreadable'.
  if (!binding || !node.issueId) {
    sessions.setHistory(storeKey, 'loaded');
    return;
  }
  sessions.setHistory(storeKey, 'loading');

  const index = await fetchConversationIndex(gatewayBase, binding.companyId, signal);
  if (signal?.aborted) return;
  if (index === null) {
    sessions.setHistory(storeKey, 'unreadable');
    return;
  }

  const stored = await fetchConversationMessages(gatewayBase, binding.companyId, node.issueId, signal);
  if (signal?.aborted) return;
  if (stored === null) {
    sessions.setHistory(storeKey, 'unreadable');
    return;
  }
  // The operator (or a run) already wrote live turns while this was loading — keep them.
  // The stored thread is the same issue, so the next turn still continues it.
  if (localSend.has(storeKey)) {
    sessions.setHistory(storeKey, 'loaded');
    return;
  }
  if (stored.length) sessions.replaceTurns(storeKey, stored.map((m) => ({ role: m.role, text: m.text })));
  sessions.setHistory(storeKey, 'loaded');
}

// ---- send ------------------------------------------------------------------------------------

export interface SendMessageArgs {
  gatewayBase: string;
  node: SessionNode;
  text: string;
  /** Called when the gateway reports an issueId this node does not have yet — persist it. */
  onIssueId?: (issueId: string) => void;
  signal?: AbortSignal;
}

/**
 * Send ONE turn on this node's own thread and stream the agent's execution into the store.
 * Never throws: transport failures arrive as an honest 'error' frame from the SSE client.
 */
export async function sendMessage({ gatewayBase, node, text, onIssueId, signal }: SendMessageArgs): Promise<void> {
  const message = text.trim();
  if (!message) return;
  const binding = node.binding;
  const storeKey = sessionStoreKey(node);
  if (!binding) {
    sessions.appendTurn(storeKey, { role: 'system', text: COPY.unbound, tone: 'error' });
    return;
  }

  markLocalSend(storeKey);
  sessions.appendTurn(storeKey, { role: 'user', text: message });
  const agentTurnId = sessions.appendTurn(storeKey, { role: 'agent', text: '' });
  sessions.setStreaming(storeKey, true);
  sessions.setStatus(storeKey, 'queued');

  // This node's thread. A server-minted id is reported back so the caller persists it — the
  // NEXT turn must continue this thread, not fork a second conversation with the same agent.
  let issueId: string | undefined = node.issueId ?? undefined;
  let gotText = false;
  const token = beginStream(storeKey);

  const reportIssue = (next: string) => {
    if (!next || next === issueId) return;
    issueId = next;
    onIssueId?.(next);
  };

  const onFrame = (f: AgentChatFrame) => {
    // Drop frames from a SUPERSEDED stream (a newer send, or a graph run took this tile over):
    // a late 'accepted' must not report a stale issueId, and a late error must not append to a
    // conversation that has already moved on.
    if (signal?.aborted || !isStreamCurrent(storeKey, token)) return;
    switch (f.event) {
      case 'accepted':
        reportIssue(f.issueId);
        if (!f.runVisible) sessions.patchTurn(storeKey, agentTurnId, COPY.thinking, 'info');
        break;
      case 'delta':
        if (!gotText) {
          gotText = true;
          sessions.patchTurn(storeKey, agentTurnId, '');
        }
        sessions.appendToTurn(storeKey, agentTurnId, f.text);
        break;
      case 'phase':
        sessions.setStatus(storeKey, COPY.phaseLabel(f.phase, f.message));
        break;
      case 'status':
        sessions.setStatus(storeKey, f.status);
        break;
      case 'done':
        if (!gotText) sessions.patchTurn(storeKey, agentTurnId, COPY.doneEmpty(statusLabel(f.status)), 'info');
        break;
      case 'no_run':
        // The message DID land on this issue even though no run surfaced — keep the thread.
        reportIssue(f.issueId);
        if (!gotText) sessions.patchTurn(storeKey, agentTurnId, COPY.noRun(f.detail), 'warn');
        break;
      case 'error': {
        // A stop the operator asked for is reported honestly as a stop, not as a failure.
        const aborted = f.detail === 'aborted';
        const text = aborted ? COPY.stopped : COPY.errorPrefix + f.detail;
        const tone = aborted ? 'info' : 'error';
        if (!gotText) sessions.patchTurn(storeKey, agentTurnId, text, tone);
        else sessions.appendTurn(storeKey, { role: 'system', text, tone });
        break;
      }
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
}
