import type { CanvasRunJournal } from './runJournal';
import type { SessionNode } from './canvasDoc';
import { activeThreadId } from './nodeThreads';

/** Build the complete next round before dispatch. Caller must durably save this first. */
export function beginReviewRound(journal: CanvasRunJournal, round: number): CanvasRunJournal {
  const review = journal.review;
  if (!review || round !== review.round + 1 || round > review.maxRounds
    || Object.values(journal.nodes).some(node => node.state === 'running')) throw new Error('review_round_not_ready');
  const turns = review.round ? [...review.turns, ...Object.values(journal.nodes).map(node => ({ ...node, round: review.round }))] : review.turns;
  return { ...journal, review: { ...review, round, turns }, nodes: Object.fromEntries(Object.entries(journal.nodes).map(([id, node]) =>
    [id, { ...node, operationId: null, runId: null, state: 'waiting', detail: undefined, output: undefined }])) };
}

/** A round gets a new idempotency key, while the node keeps its original Session. */
export function prepareReviewTurn(journal: CanvasRunJournal, node: SessionNode, operationId: string): CanvasRunJournal {
  const current = journal.nodes[node.id];
  if (!journal.review || !current || !operationId || current.operationId
    || current.threadId !== activeThreadId(node) || current.companyId !== node.binding?.companyId
    || current.agentId !== node.binding?.agentId) throw new Error('review_turn_identity_changed');
  return { ...journal, nodes: { ...journal.nodes, [node.id]: {
    ...current, issueId: node.issueId, operationId, runId: null, state: 'running', output: undefined, detail: undefined,
  } } };
}
