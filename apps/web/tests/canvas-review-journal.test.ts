import { afterEach, describe, expect, it } from 'vitest';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { beginReviewRound, prepareReviewTurn } from '../src/canvas/reviewJournal';
import { CANVAS_RUN_JOURNAL_KEY, journalSummary, loadRunJournal, patchRunJournalNode, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { applyRecoveredDocument, recoveryJournalForDocument, runInputFingerprint } from '../src/canvas/runRecoveryDocument';

afterEach(() => localStorage.clear());

function fixture() {
  const author: SessionNode = { ...createSessionNode('coding', { x: 0, y: 0 }), id: 'author',
    binding: { companyId: 'company', agentId: 'author-agent', agentName: 'Author' }, issueId: 'author-issue',
  };
  const reviewer: SessionNode = { ...createSessionNode('coding', { x: 500, y: 0 }), id: 'reviewer',
    binding: { companyId: 'company', agentId: 'reviewer-agent', agentName: 'Reviewer' }, issueId: 'reviewer-issue',
  };
  const doc: CanvasDocument = { ...emptyDocument(), nodes: [author, reviewer], execution: {
    mode: 'review', maxRounds: 3, reviewerNodeId: reviewer.id, verdictFieldId: 'approved',
  }, edges: [
    { id: 'candidate', fromNode: author.id, fromPort: 'result', toNode: reviewer.id, toPort: 'context', dataType: 'text' },
    { id: 'feedback', fromNode: reviewer.id, fromPort: 'result', toNode: author.id, toPort: 'context', dataType: 'text', kind: 'feedback' },
  ] };
  const scope = doc.nodes.map(node => node.id);
  const journal: CanvasRunJournal = { version: 1, id: 'review-journal', startedAt: 1000, scope,
    inputFingerprint: runInputFingerprint(doc, scope), review: { round: 0, maxRounds: 3, outcome: 'running', turns: [] },
    nodes: Object.fromEntries([author, reviewer].map(node => [node.id, { nodeId: node.id, threadId: 'default',
      companyId: 'company', agentId: node.binding!.agentId, issueId: node.issueId, runId: null, operationId: null, state: 'waiting',
    }])),
  };
  return { author, reviewer, doc, journal };
}

describe('durable review round identities', () => {
  it('archives completed round identities before resetting only operation/run identities for the next round', () => {
    const f = fixture(); let journal = beginReviewRound(f.journal, 1);
    journal = prepareReviewTurn(journal, f.author, 'author-operation-1');
    journal = patchRunJournalNode(journal, f.author.id, { runId: 'author-run-1', state: 'done', output: '# Candidate' });
    journal = prepareReviewTurn(journal, f.reviewer, 'reviewer-operation-1');
    journal = patchRunJournalNode(journal, f.reviewer.id, { runId: 'reviewer-run-1', state: 'done', output: 'Revise navigation' });
    const next = beginReviewRound(journal, 2);
    expect(next.review?.turns).toEqual([
      { ...journal.nodes.author, round: 1 }, { ...journal.nodes.reviewer, round: 1 },
    ]);
    expect(next.nodes.author).toMatchObject({ threadId: 'default', issueId: 'author-issue', operationId: null, runId: null, state: 'waiting' });
    expect(next.nodes.author.output).toBeUndefined();
    const prepared = prepareReviewTurn(next, f.author, 'author-operation-2');
    expect(prepared.nodes.author).toMatchObject({ operationId: 'author-operation-2', issueId: 'author-issue', runId: null, state: 'running' });
    expect(saveRunJournal(prepared)).toBe(true);
    expect(loadRunJournal()).toMatchObject({ review: { round: 2, turns: JSON.parse(JSON.stringify(next.review!.turns)) }, nodes: {
      author: { operationId: 'author-operation-2', issueId: 'author-issue', state: 'running' },
    } });
  });

  it('rejects operation reuse, rebinding, a live native turn and rounds beyond the allowed budget', () => {
    const f = fixture(); const first = beginReviewRound(f.journal, 1);
    const prepared = prepareReviewTurn(first, f.author, 'operation-1');
    expect(() => prepareReviewTurn(prepared, f.author, 'operation-2')).toThrow('identity');
    expect(() => prepareReviewTurn(first, { ...f.author, binding: { ...f.author.binding!, agentId: 'other-agent' } }, 'operation-2')).toThrow('identity');
    expect(() => beginReviewRound(prepared, 2)).toThrow('not_ready');
    expect(() => beginReviewRound({ ...first, review: { ...first.review!, round: 3 } }, 4)).toThrow('not_ready');
    expect(() => beginReviewRound(f.journal, 2)).toThrow('not_ready');
  });

  it('rejects an unreadable review history instead of loading a false completed run', () => {
    const f = fixture();
    const raw = { ...f.journal, review: { round: 2, maxRounds: 3, outcome: 'approved', turns: [{
      ...f.journal.nodes.author, round: 1, state: 'running',
    }] } };
    localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(raw));
    expect(loadRunJournal()).toBeNull();
  });
});

describe('review publication and recovery fingerprint', () => {
  it('keeps the latest same-Session prior attempt as partial after a later round stops before output', () => {
    const f = fixture();
    const journal: CanvasRunJournal = { ...f.journal, review: { ...f.journal.review!, round: 3, outcome: 'cancelled', turns: [
      { ...f.journal.nodes.author, round: 1, state: 'done', output: '# First attempt' },
      { ...f.journal.nodes.author, round: 2, state: 'done', output: '# Latest attempt' },
    ] }, nodes: { ...f.journal.nodes, author: { ...f.journal.nodes.author, state: 'cancelled' } } };
    expect(saveRunJournal(journal)).toBe(true);
    const restored = loadRunJournal()!;
    const result = applyRecoveredDocument(f.doc, { ...restored, inputFingerprint: restored.inputFingerprint! });
    expect(result.nodes[0].lastOutput).toMatchObject({ text: '# Latest attempt', partial: true });
    expect(journalSummary(restored).ok).toBe(false);
    const current = { ...restored, nodes: { ...restored.nodes, author: { ...restored.nodes.author, output: '# New partial' } } };
    expect(applyRecoveredDocument(f.doc, { ...current, inputFingerprint: current.inputFingerprint! }).nodes[0].lastOutput)
      .toMatchObject({ text: '# New partial', partial: true });
  });

  it('never restores historical evidence across identities, while running, or as approved output', () => {
    const f = fixture();
    const previous = { ...f.journal.nodes.author, round: 1, state: 'done' as const, output: '# Old attempt' };
    for (const patch of [{ agentId: 'other' }, { companyId: 'other' }, { threadId: 'other' }, { issueId: 'other' }]) {
      const journal = { ...f.journal, review: { ...f.journal.review!, round: 2, outcome: 'cancelled' as const, turns: [{ ...previous, ...patch }] } };
      expect(applyRecoveredDocument(f.doc, { ...journal, inputFingerprint: journal.inputFingerprint! }).nodes[0].lastOutput).toBeFalsy();
    }
    for (const [state, outcome] of [['running', 'interrupted'], ['waiting', 'approved']] as const) {
      const journal = { ...f.journal, review: { ...f.journal.review!, round: 2, outcome, turns: [previous] },
        nodes: { ...f.journal.nodes, author: { ...f.journal.nodes.author, state } } };
      expect(applyRecoveredDocument(f.doc, { ...journal, inputFingerprint: journal.inputFingerprint! }).nodes[0].lastOutput).toBeFalsy();
    }
  });

  it('publishes a coherent feedback cycle only after explicit approval, otherwise keeps each result partial', () => {
    const f = fixture();
    const completed = { ...f.journal, review: { ...f.journal.review!, round: 1 }, nodes: {
      author: { ...f.journal.nodes.author, state: 'done' as const, output: '# Candidate' },
      reviewer: { ...f.journal.nodes.reviewer, state: 'done' as const, output: 'Review evidence' },
    } };
    for (const outcome of ['running', 'exhausted', 'failed', 'cancelled', 'interrupted', 'approved'] as const) {
      const current = { ...completed, review: { ...completed.review, outcome } };
      const recovered = applyRecoveredDocument(f.doc, { ...current, inputFingerprint: f.journal.inputFingerprint! });
      expect(recovered.nodes.map(node => node.lastOutput?.text)).toEqual(['# Candidate', 'Review evidence']);
      expect(recovered.nodes.every(node => Boolean(node.lastOutput?.partial) === (outcome !== 'approved'))).toBe(true);
      expect(journalSummary(current).ok).toBe(outcome === 'approved');
    }
  });

  it('fingerprints the mode, review budget, verdict gate and feedback direction', () => {
    const f = fixture(); const fingerprint = runInputFingerprint(f.doc, f.journal.scope);
    for (const doc of [
      { ...f.doc, execution: undefined },
      { ...f.doc, execution: { ...f.doc.execution!, maxRounds: 2 } },
      { ...f.doc, execution: { ...f.doc.execution!, reviewerNodeId: 'author' } },
      { ...f.doc, execution: { ...f.doc.execution!, verdictFieldId: 'other-verdict' } },
      { ...f.doc, edges: f.doc.edges.map(edge => edge.kind === 'feedback' ? { ...edge, kind: 'data' as const } : edge) },
    ]) expect(runInputFingerprint(doc, f.journal.scope)).not.toBe(fingerprint);
    expect(runInputFingerprint({ ...f.doc, view: { x: 99, y: 99, scale: 0.5 } }, f.journal.scope)).toBe(fingerprint);
  });

  it('does not publish old approved output after the operator changes review policy', () => {
    const f = fixture(); const approved: CanvasRunJournal = { ...f.journal,
      review: { ...f.journal.review!, round: 1, outcome: 'approved' },
      nodes: { ...f.journal.nodes, author: { ...f.journal.nodes.author, state: 'done', output: '# Approved under old policy' } },
    };
    const changed = { ...f.doc, execution: { ...f.doc.execution!, maxRounds: 1 } };
    expect(recoveryJournalForDocument(changed, approved).nodes.author).toMatchObject({ state: 'failed', detail: 'recovery_input_changed' });
    const recovered = applyRecoveredDocument(changed, { ...approved, inputFingerprint: approved.inputFingerprint! });
    expect(recovered.nodes.every(node => !node.lastOutput)).toBe(true);
  });
});
