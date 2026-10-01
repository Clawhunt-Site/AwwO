import type { CanvasNode } from './canvasDoc';
import type { CanvasRunJournal, CanvasRunJournalNode } from './runJournal';
import { activeThreadId } from './nodeThreads';

/** A cached ancestor or a different session must never appear to be this node's new execution. */
export function currentGraphRunEntry(node: CanvasNode, journal: CanvasRunJournal | null): CanvasRunJournalNode | undefined {
  if (!journal?.serverGraph || node.kind !== 'session' || !journal.scope.includes(node.id)) return undefined;
  const entry = journal.nodes[node.id];
  if (!entry || entry.state === 'cached' || entry.threadId !== activeThreadId(node)
    || entry.companyId !== node.binding?.companyId || entry.agentId !== node.binding?.agentId) return undefined;
  return entry;
}
