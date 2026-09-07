import { fetchConversationMessages } from '../canvasAgentChat';
import type { SessionNode } from './canvasDoc';
import type { CanvasRunJournal } from './runJournal';
import { hasManualRecoveryCapacity, persistRecoveredManualConversation, pruneNativeBackedManualConversations,
  type NativeManualHistoryProof } from './runRecoveryDocument';

async function readNativeHistory(gatewayBase: string, node: SessionNode, signal?: AbortSignal): Promise<NativeManualHistoryProof | null> {
  if (!node.binding || !node.issueId || signal?.aborted) return null;
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  // This API returns an array only when the gateway explicitly reports complete:true.
  const turns = await fetchConversationMessages(gatewayBase, node.binding.companyId, node.issueId, bounded);
  return turns && !bounded.aborted ? { complete: true, turns } : null;
}

/** Normally synchronous apart from the Promise boundary; only capacity pressure needs a read. */
export async function prepareManualHistoryCapacity(
  gatewayBase: string, node: SessionNode, userText: string, stillCurrent: () => boolean,
): Promise<boolean> {
  if (hasManualRecoveryCapacity(node, userText)) return true;
  const proof = await readNativeHistory(gatewayBase, node);
  if (!stillCurrent() || !proof) return false;
  if (!pruneNativeBackedManualConversations(node, proof)) return false;
  return hasManualRecoveryCapacity(node, userText);
}

/** Called before clearing the journal; absent native proof preserves the durable fallback. */
export async function persistManualHistoryWithNativeProof(
  gatewayBase: string, node: SessionNode, journal: CanvasRunJournal, signal?: AbortSignal,
): Promise<boolean> {
  const proof = await readNativeHistory(gatewayBase, node, signal);
  if (signal?.aborted) return false;
  return persistRecoveredManualConversation(node, journal, localStorage, proof);
}
