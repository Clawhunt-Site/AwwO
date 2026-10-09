import { describe, expect, it } from 'vitest';
import { createSessionNode, emptyDocument, type CanvasDocument, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import type { CanvasRunJournal } from '../src/canvas/runJournal';
import { journalSummary } from '../src/canvas/runJournal';
import {
  applyRecoveredDocument,
  mergeRecoveredManualConversation,
  mergePersistedManualConversations,
  persistRecoveredManualConversation,
  recoverableOutput,
  recoveryJournalForDocument,
  prepareRunDocument,
  runInputFingerprint,
  hasManualRecoveryCapacity,
  pruneNativeBackedManualConversations,
  type RecoveredConversationTurn,
  type FingerprintedRunJournal,
} from '../src/canvas/runRecoveryDocument';

function session(id: string, title: string): SessionNode {
  return {
    ...createSessionNode('coding', { x: 0, y: 0 }), id, title,
    runtime: 'codex_local', model: 'gpt-5.5', effort: 'high', persona: `Persona ${id}`,
    binding: { companyId: 'company-1', agentId: `agent-${id}`, agentName: title },
    issueId: `old-issue-${id}`, preview: `preview-${id}`,
    contract: {
      version: 1,
      inputs: [{ id: 'brief', label: 'Brief', type: 'markdown', required: true, value: `input-${id}`, help: 'Use facts.' }],
      outputs: [{ id: 'result', label: 'Result', type: 'markdown', required: true, value: '', help: 'Show evidence.' }],
    },
    lastOutput: { text: `old-${id}`, at: 10, source: 'run' },
  };
}

function graph(): CanvasDocument {
  const a = session('a', 'A');
  const b = session('b', 'B');
  const c = session('c', 'C');
  return {
    ...emptyDocument(),
    nodes: [a, b, c],
    edges: [
      { id: 'edge-a-b', fromNode: 'a', fromPort: 'out:result', toNode: 'b', toPort: 'in:brief', dataType: 'markdown' },
      { id: 'edge-b-c', fromNode: 'b', fromPort: 'out:result', toNode: 'c', toPort: 'in:brief', dataType: 'markdown' },
    ],
  };
}

function journal(doc: CanvasDocument, manual = false): FingerprintedRunJournal {
  const value: CanvasRunJournal = {
    version: 1, id: 'run-journal-1', startedAt: 100, scope: ['a', 'b'],
    ...(manual ? { manual: true } : {}),
    nodes: {
      a: { nodeId: 'a', threadId: 'default', companyId: 'company-1', agentId: 'agent-a', issueId: 'new-issue-a', runId: 'run-a', state: 'done', output: 'new-a' },
      b: { nodeId: 'b', threadId: 'default', companyId: 'company-1', agentId: 'agent-b', issueId: 'new-issue-b', runId: 'run-b', state: 'done', output: 'new-b' },
    },
  };
  return { ...value, inputFingerprint: runInputFingerprint(doc, value.scope) };
}

describe('canvas run document recovery', () => {
  it('synchronously clears the execution scope and stale descendants before dispatch', () => {
    const original = graph();
    const prepared = prepareRunDocument(original, ['a', 'b'], false);
    expect(prepared.nodes.map(node => node.lastOutput ?? null)).toEqual([null, null, null]);
    expect(original.nodes.map(node => node.lastOutput?.text)).toEqual(['old-a', 'old-b', 'old-c']);
  });

  it('does not clear an explicitly published output for a manual conversation', () => {
    const original = graph();
    expect(prepareRunDocument(original, ['a'], true)).toBe(original);
  });

  it('invalidates stale descendants, then overlays every coherent result from the same recovered batch', () => {
    const original = graph();
    const recovered = applyRecoveredDocument(original, journal(original));
    expect(recovered.nodes.map(node => node.lastOutput?.text ?? null)).toEqual(['new-a', 'new-b', null]);
    expect(recovered.nodes[0]).toMatchObject({ issueId: 'new-issue-a', lastOutput: { source: 'run' } });
    expect(recovered.nodes[1]).toMatchObject({ issueId: 'new-issue-b', lastOutput: { source: 'run' } });
    expect(recovered.nodes[0].lastOutput).not.toHaveProperty('partial');
    expect(recovered.nodes[1].lastOutput).not.toHaveProperty('partial');
  });

  it('never auto-publishes a recovered manual reply', () => {
    const original = graph();
    const recovered = applyRecoveredDocument(original, journal(original, true));
    expect(recovered.nodes.map(node => node.lastOutput?.text)).toEqual(['old-a', 'old-b', 'old-c']);
    expect(recovered.nodes[0]).toMatchObject({ issueId: 'new-issue-a' });
  });

  it('never merges an old Agent issue or output after the same node and thread are rebound', () => {
    const original = graph();
    const saved = journal(original);
    const rebound = structuredClone(original);
    const node = rebound.nodes[0] as SessionNode;
    node.binding = { companyId: 'company-1', agentId: 'replacement-agent', agentName: 'Replacement' };
    node.issueId = 'replacement-issue';
    node.lastOutput = { text: 'replacement-output', at: 50, source: 'manual' };

    const recovered = applyRecoveredDocument(rebound, saved);

    expect(recovered.nodes[0]).toMatchObject({
      binding: { agentId: 'replacement-agent' },
      issueId: 'replacement-issue',
    });
    expect(recovered.nodes[0].lastOutput).toBeNull();
    expect(recovered.nodes[0]).not.toMatchObject({ issueId: 'new-issue-a' });
  });

  it('clears stale outputs but refuses recovered publication after execution inputs changed', () => {
    const original = graph();
    const saved = journal(original);
    const changed = structuredClone(original);
    (changed.nodes[0] as SessionNode).persona = 'Changed while detached';
    const recovered = applyRecoveredDocument(changed, saved);
    expect(recovered.nodes.map(node => node.lastOutput ?? null)).toEqual([null, null, null]);
    const reconciled = recoveryJournalForDocument(changed, saved);
    expect(journalSummary(reconciled)).toMatchObject({ ok: false, done: 0, failed: 2 });
    expect(reconciled.nodes.a.detail).toBe('recovery_input_changed');
    expect(reconciled.nodes.a.output).toBe('new-a');
  });

  it('reconstructs a detached manual user/reply pair once by operation and run identity', () => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.operationId = '11111111-1111-4111-8111-111111111111';
    const history = [{ role: 'user' as const, text: 'Earlier turn' }];

    const merged = mergeRecoveredManualConversation(history, saved, 'a');
    const repeated = mergeRecoveredManualConversation(merged, saved, 'a');

    expect(merged).toEqual([
      history[0],
      expect.objectContaining({ role: 'user', text: 'Please continue', recoveryOperationId: saved.nodes.a.operationId, recoveryRunId: 'run-a' }),
      expect.objectContaining({ role: 'agent', text: 'new-a', recoveryOperationId: saved.nodes.a.operationId, recoveryRunId: 'run-a' }),
    ]);
    expect(repeated).toEqual(merged);
  });

  it('does not duplicate a manual pair already present at the end of restored server history', () => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    const history = [
      { role: 'user' as const, text: 'Please continue' },
      { role: 'agent' as const, text: 'new-a' },
    ];
    expect(mergeRecoveredManualConversation(history, saved, 'a')).toEqual(history);
  });

  it.each(['native', 'recovery'] as const)('preserves identical text from different %s operation and run identities', source => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.operationId = 'operation-a';
    const identity = source === 'native' ? { nativeOperationId: 'operation-b', nativeRunId: 'run-b' }
      : { recoveryOperationId: 'operation-b', recoveryRunId: 'run-b' };
    const history = [
      { role: 'user' as const, text: 'Please continue', ...identity },
      { role: 'agent' as const, text: 'new-a', ...identity },
    ];
    const merged = mergeRecoveredManualConversation(history, saved, 'a');
    expect(merged).toHaveLength(4);
    expect(merged.slice(0, 2)).toEqual(history);
    expect(merged.slice(2)).toEqual([
      expect.objectContaining({ role: 'user', recoveryOperationId: 'operation-a', recoveryRunId: 'run-a' }),
      expect.objectContaining({ role: 'agent', recoveryOperationId: 'operation-a', recoveryRunId: 'run-a' }),
    ]);
    expect(mergeRecoveredManualConversation(merged, saved, 'a')).toEqual(merged);
  });

  it.each(['native', 'recovery'] as const)('deduplicates a complete round with matching %s identity', source => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.operationId = 'operation-a';
    const user = source === 'native' ? { nativeOperationId: 'operation-a' } : { recoveryOperationId: 'operation-a' };
    const agent = source === 'native' ? { nativeRunId: 'run-a' } : { recoveryRunId: 'run-a' };
    const history = [{ role: 'user' as const, text: 'Please continue', ...user },
      { role: 'agent' as const, text: 'new-a', ...agent }];
    expect(mergeRecoveredManualConversation(history, saved, 'a')).toEqual(history);
  });

  it.each(['native', 'recovery'] as const)('restores missing stdout when only the %s user comment is present', source => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.operationId = 'operation-a';
    const identity = source === 'native' ? { nativeOperationId: 'operation-a' } : { recoveryOperationId: 'operation-a' };
    const history = [{ role: 'user' as const, text: 'Please continue', ...identity },
      { role: 'user' as const, text: 'Later request', nativeOperationId: 'operation-b' }];
    const merged = mergeRecoveredManualConversation(history, saved, 'a');
    expect(merged).toEqual([history[0], expect.objectContaining({ role: 'agent', text: 'new-a',
      recoveryOperationId: 'operation-a', recoveryRunId: 'run-a' }), history[1]]);
    expect(merged.filter(turn => turn.role === 'user' && turn.text === 'Please continue')).toHaveLength(1);
    expect(mergeRecoveredManualConversation(merged, saved, 'a')).toEqual(merged);
  });

  it('does not let a matching run hide a conflicting operation on native turns', () => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.operationId = 'operation-a';
    const history = [
      { role: 'user' as const, text: 'Please continue', nativeOperationId: 'operation-b', nativeRunId: 'run-a' },
      { role: 'agent' as const, text: 'new-a', nativeOperationId: 'operation-b', nativeRunId: 'run-a' },
    ];
    expect(mergeRecoveredManualConversation(history, saved, 'a')).toHaveLength(4);
  });

  it('keeps a failed local-only request when an identical untagged user turn has a native reply from another run', () => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a = { ...saved.nodes.a, operationId: 'operation-a', runId: null, state: 'failed', output: '' };
    const history = [{ role: 'user' as const, text: 'Please continue' },
      { role: 'agent' as const, text: 'Different execution', nativeRunId: 'run-b' }];
    const merged = mergeRecoveredManualConversation(history, saved, 'a');
    expect(merged).toHaveLength(3);
    expect(merged.at(-1)).toMatchObject({ role: 'user', text: 'Please continue', recoveryOperationId: 'operation-a' });
    expect(mergeRecoveredManualConversation(merged, saved, 'a')).toEqual(merged);
  });

  it('retains recovered stdout when the same native run stored a different reply body', () => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.operationId = 'operation-a';
    const history = [{ role: 'user' as const, text: 'Please continue', nativeOperationId: 'operation-a' },
      { role: 'agent' as const, text: 'Native status note', nativeRunId: 'run-a' }];
    const merged = mergeRecoveredManualConversation(history, saved, 'a');
    expect(merged).toHaveLength(3);
    expect(merged.map(turn => turn.text)).toEqual(['Please continue', 'new-a', 'Native status note']);
    expect(mergeRecoveredManualConversation(merged, saved, 'a')).toEqual(merged);
  });

  it('preserves two persisted operations with identical raw request/reply pairs after reload', () => {
    const doc = graph();
    const node = doc.nodes[0] as SessionNode;
    const saved = journal(doc, true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.operationId = 'operation-a';
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(persistRecoveredManualConversation(node, saved, storage)).toBe(true);
    const second = { ...saved, startedAt: 200, nodes: { ...saved.nodes,
      a: { ...saved.nodes.a, operationId: 'operation-b', runId: 'run-b' } } };
    expect(persistRecoveredManualConversation(node, second, storage)).toBe(true);
    const history = [{ role: 'user' as const, text: 'Please continue', nativeOperationId: 'operation-b' },
      { role: 'agent' as const, text: 'new-a', nativeRunId: 'run-b' }];
    const merged = mergePersistedManualConversations(node, history, storage)!;
    expect(merged).toHaveLength(4);
    expect(merged.filter(turn => turn.recoveryOperationId === 'operation-a')).toHaveLength(2);
    expect(merged.filter(turn => turn.nativeOperationId === 'operation-b' || turn.nativeRunId === 'run-b')).toHaveLength(2);
    expect(mergePersistedManualConversations(node, merged, storage)).toEqual(merged);
  });

  it('persists recovered manual stdout and merges it again after a fresh session reload', () => {
    const doc = graph();
    const node = doc.nodes[0] as SessionNode;
    const saved = journal(doc, true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.operationId = '11111111-1111-4111-8111-111111111111';
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(persistRecoveredManualConversation(node, saved, storage)).toBe(true);
    expect(persistRecoveredManualConversation(node, saved, storage)).toBe(true);
    expect(mergePersistedManualConversations(node, [{ role: 'user', text: 'Earlier' }], storage)).toEqual([
      { role: 'user', text: 'Earlier' },
      expect.objectContaining({ role: 'user', text: 'Please continue', recoveryOperationId: saved.nodes.a.operationId }),
      expect.objectContaining({ role: 'agent', text: 'new-a', recoveryRunId: 'run-a' }),
    ]);
    expect(JSON.parse([...values.values()][0]!).records).toHaveLength(1);
  });

  it('keeps cancelled partial output with its server user turn before a later completed reply', () => {
    const doc = graph();
    const node = doc.nodes[0] as SessionNode;
    const cancelled = journal(doc, true);
    cancelled.manualMessage = 'Write a long explanation';
    cancelled.nodes.a.state = 'cancelled';
    cancelled.nodes.a.output = '{"result":"Partial';
    const completed = journal(doc, true);
    completed.startedAt = 200;
    completed.manualMessage = 'Reply with RESUME_OK';
    completed.nodes.a.runId = 'later-run';
    completed.nodes.a.output = '{"result":"RESUME_OK"}';
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(persistRecoveredManualConversation(node, cancelled, storage)).toBe(true);
    expect(persistRecoveredManualConversation(node, completed, storage)).toBe(true);
    const server = [
      { role: 'user' as const, text: cancelled.manualMessage },
      { role: 'user' as const, text: completed.manualMessage },
      { role: 'agent' as const, text: completed.nodes.a.output! },
    ];

    const merged = mergePersistedManualConversations(node, server, storage)!;

    expect(merged).toEqual([
      server[0],
      expect.objectContaining({ role: 'agent', text: cancelled.nodes.a.output, tone: 'warn', recoveryRunId: 'run-a' }),
      server[1], server[2],
    ]);
    expect(mergePersistedManualConversations(node, merged, storage)).toEqual(merged);
    expect(server).toHaveLength(3);
  });

  it('anchors repeated cancelled prompts to separate server turns without shifting later matches', () => {
    const doc = graph();
    const node = doc.nodes[0] as SessionNode;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    for (let index = 0; index < 2; index += 1) {
      const cancelled = journal(doc, true);
      cancelled.startedAt += index;
      cancelled.manualMessage = 'Same prompt';
      Object.assign(cancelled.nodes.a, { state: 'cancelled', runId: `cancelled-${index}`, output: 'Same partial output' });
      expect(persistRecoveredManualConversation(node, cancelled, storage)).toBe(true);
    }
    const merged = mergePersistedManualConversations(node, [
      { role: 'user', text: 'Same prompt' },
      { role: 'user', text: 'Same prompt' },
      { role: 'user', text: 'Latest request' },
      { role: 'agent', text: 'Latest result' },
    ], storage)!;
    expect(merged.map(turn => turn.text)).toEqual([
      'Same prompt', 'Same partial output', 'Same prompt', 'Same partial output', 'Latest request', 'Latest result',
    ]);
    expect(mergePersistedManualConversations(node, [], storage)?.map(turn => turn.text)).toEqual([
      'Same prompt', 'Same partial output', 'Same prompt', 'Same partial output',
    ]);
    expect(mergePersistedManualConversations(node, merged, storage)).toEqual(merged);
  });

  it('keeps the complete server reply when cancellation cached only its streamed prefix', () => {
    const saved = journal(graph(), true);
    saved.manualMessage = 'Please continue';
    saved.nodes.a.state = 'cancelled';
    saved.nodes.a.output = 'Partial';
    const history = [
      { role: 'user' as const, text: 'Please continue' },
      { role: 'agent' as const, text: 'Partial output completed on the server' },
      { role: 'user' as const, text: 'Next request' },
      { role: 'agent' as const, text: 'Latest result' },
    ];
    expect(mergeRecoveredManualConversation(history, saved, 'a')).toEqual(history);
  });

  it('does not expose locally recovered turns after the node is rebound to another Agent', () => {
    const doc = graph();
    const node = doc.nodes[0] as SessionNode;
    const saved = journal(doc, true);
    saved.manualMessage = 'private prompt';
    saved.nodes.a.operationId = '11111111-1111-4111-8111-111111111111';
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    expect(persistRecoveredManualConversation(node, saved, storage)).toBe(true);
    const rebound = structuredClone(node);
    rebound.binding = { companyId: 'company-1', agentId: 'replacement-agent', agentName: 'Replacement' };
    expect(mergePersistedManualConversations(rebound, [], storage)).toEqual([]);
  });

  it('places an older failed local-only request before a newer native reply and remains idempotent', () => {
    const doc = graph();
    const node = doc.nodes[0] as SessionNode;
    const saved = journal(doc, true);
    saved.startedAt = 1000;
    saved.manualMessage = 'blocked by manual hold';
    saved.nodes.a = { ...saved.nodes.a, operationId: 'blocked-operation', runId: null, state: 'failed', output: '' };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(persistRecoveredManualConversation(node, saved, storage)).toBe(true);
    const completed = { ...saved, startedAt: 2000, manualMessage: 'resume', nodes: {
      ...saved.nodes, a: { ...saved.nodes.a, operationId: 'resume-operation', runId: 'resume-run', state: 'done' as const, output: 'latest agent' },
    } };
    expect(persistRecoveredManualConversation(node, completed, storage)).toBe(true);
    const merged = mergePersistedManualConversations(node, [
      { role: 'user', text: 'resume', createdAt: 2100 },
      { role: 'agent', text: 'latest agent', createdAt: 3000 },
    ], storage)!;
    expect(merged.map(turn => turn.text)).toEqual(['blocked by manual hold', 'resume', 'latest agent']);
    expect(mergePersistedManualConversations(node, merged, storage)).toEqual(merged);
  });

  it('preserves native order when timestamps are missing or equal', () => {
    const doc = graph();
    const node = doc.nodes[0] as SessionNode;
    const saved = journal(doc, true);
    saved.startedAt = 2000;
    saved.manualMessage = 'local-only';
    saved.nodes.a = { ...saved.nodes.a, state: 'failed', output: '' };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(persistRecoveredManualConversation(node, saved, storage)).toBe(true);
    const native = [{ role: 'user' as const, text: 'unknown' }, { role: 'agent' as const, text: 'same-time', createdAt: 2000 }];
    expect(mergePersistedManualConversations(node, native, storage)?.map(turn => turn.text))
      .toEqual(['unknown', 'same-time', 'local-only']);
  });
});

describe('native-backed manual history retention', () => {
  function fixture() {
    const doc = graph();
    const node = doc.nodes[0] as SessionNode;
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); } };
    const round = (index: number, output = `reply-${index}`): CanvasRunJournal => {
      const saved = journal(doc, true);
      return { ...saved, startedAt: index + 1, manualMessage: `request-${index}`, scope: ['a'], nodes: {
        a: { ...saved.nodes.a, operationId: `operation-${index}`, runId: `native-run-${index}`, output },
      } };
    };
    const proofFor = (saved: CanvasRunJournal): RecoveredConversationTurn[] => [
      { role: 'user', text: saved.manualMessage!, nativeOperationId: saved.nodes.a.operationId! },
      { role: 'agent', text: saved.nodes.a.output!, nativeRunId: saved.nodes.a.runId! },
    ];
    return { node, values, storage, round, proofFor };
  }

  it('continues beyond 50 completed rounds by retaining only fallbacks not proven in complete native history', () => {
    const f = fixture();
    const native: RecoveredConversationTurn[] = [];
    for (let index = 0; index < 50; index += 1) {
      const saved = f.round(index);
      expect(persistRecoveredManualConversation(f.node, saved, f.storage)).toBe(true);
      native.push(...f.proofFor(saved));
    }
    expect(hasManualRecoveryCapacity(f.node, 'next request', f.storage)).toBe(false);
    const next = f.round(50);
    native.push(...f.proofFor(next));
    expect(persistRecoveredManualConversation(f.node, next, f.storage, { complete: true, turns: native })).toBe(true);
    expect(JSON.parse([...f.values.values()][0]).records).toHaveLength(0);
    expect(hasManualRecoveryCapacity(f.node, 'next request', f.storage)).toBe(true);
    for (let index = 51; index < 75; index += 1) {
      const saved = f.round(index);
      native.push(...f.proofFor(saved));
      expect(persistRecoveredManualConversation(f.node, saved, f.storage, { complete: true, turns: native })).toBe(true);
    }
    expect(JSON.parse([...f.values.values()][0]).records).toHaveLength(0);
  });

  it('never removes fallback from incomplete native history or a partial role pair', () => {
    const f = fixture();
    const saved = f.round(0);
    expect(persistRecoveredManualConversation(f.node, saved, f.storage)).toBe(true);
    const original = [...f.values.values()][0];
    expect(pruneNativeBackedManualConversations(f.node, { complete: false, turns: f.proofFor(saved) }, f.storage)).toBe(false);
    expect([...f.values.values()][0]).toBe(original);
    expect(pruneNativeBackedManualConversations(f.node, { complete: true, turns: [f.proofFor(saved)[0]] }, f.storage)).toBe(true);
    expect([...f.values.values()][0]).toBe(original);
  });

  it('accepts a result over the local fallback limit only when the full round is proven natively', () => {
    const f = fixture();
    const saved = f.round(0, 'x'.repeat(1_000_001));
    expect(persistRecoveredManualConversation(f.node, saved, f.storage)).toBe(false);
    expect(f.values.size).toBe(0);
    expect(persistRecoveredManualConversation(f.node, saved, f.storage, { complete: true, turns: f.proofFor(saved) })).toBe(true);
    expect(f.values.size).toBe(0);
  });

  it.each(['different-id', 'recovery-only', 'context-only', 'conflicting-id', 'different-text'] as const)('keeps local evidence when native proof is %s', kind => {
    const f = fixture();
    const saved = f.round(0);
    expect(persistRecoveredManualConversation(f.node, saved, f.storage)).toBe(true);
    const original = [...f.values.values()][0];
    let turns = f.proofFor(saved);
    if (kind === 'different-id') turns = turns.map(turn => ({ ...turn, nativeOperationId: 'other-operation', nativeRunId: 'other-run' }));
    if (kind === 'recovery-only') turns = [{ role: 'user', text: saved.manualMessage!, recoveryOperationId: saved.nodes.a.operationId! },
      { role: 'agent', text: saved.nodes.a.output!, recoveryRunId: saved.nodes.a.runId! }];
    if (kind === 'context-only') turns = turns.map(turn => turn.role === 'user' ? { ...turn, nativeSource: 'issue_description' } : turn);
    if (kind === 'conflicting-id') turns = turns.map(turn => ({ ...turn, nativeOperationId: 'other-operation' }));
    if (kind === 'different-text') turns = turns.map(turn => turn.role === 'agent' ? { ...turn, text: 'similar reply' } : turn);
    expect(pruneNativeBackedManualConversations(f.node, { complete: true, turns }, f.storage)).toBe(true);
    expect([...f.values.values()][0]).toBe(original);
  });

  it('preserves unrelated local fallbacks when the current complete native round needs no local copy', () => {
    const f = fixture();
    for (let index = 0; index < 50; index += 1) expect(persistRecoveredManualConversation(f.node, f.round(index), f.storage)).toBe(true);
    const original = [...f.values.values()][0];
    const current = f.round(50, 'x'.repeat(1_000_001));
    expect(persistRecoveredManualConversation(f.node, current, f.storage, { complete: true, turns: f.proofFor(current) })).toBe(true);
    expect([...f.values.values()][0]).toBe(original);
  });
});

describe('run input fingerprint', () => {
  it('ignores server identities, presentation state, previews and prior output', () => {
    const original = graph();
    const changed = structuredClone(original);
    const node = changed.nodes[0] as SessionNode;
    Object.assign(node, { x: 900, y: -20, w: 999, h: 111, issueId: 'server-minted-new', preview: 'new preview', lastOutput: null });
    node.threads = [{ id: 'default', title: 'Session 1', issueId: 'thread-server-id', preview: 'thread preview', draft: 'unsent draft', createdAt: 999 }];
    changed.updatedAt = 999;
    changed.view = { x: 10, y: 20, scale: 0.5 };
    changed.waypoints = [{ slot: 1, view: { x: 1, y: 2, scale: 1 } }];
    expect(runInputFingerprint(changed, ['a', 'b'])).toBe(runInputFingerprint(original, ['a', 'b']));
  });

  it('changes for relevant execution configuration and incoming topology, but not unrelated nodes', () => {
    const original = graph();
    const expected = runInputFingerprint(original, ['b']);
    const unrelated = structuredClone(original);
    (unrelated.nodes[2] as SessionNode).persona = 'Unrelated downstream edit';
    expect(runInputFingerprint(unrelated, ['b'])).toBe(expected);

    const config = structuredClone(original);
    (config.nodes[0] as SessionNode).contract!.inputs[0].value = 'Changed upstream input';
    expect(runInputFingerprint(config, ['b'])).not.toBe(expected);

    const topology = structuredClone(original);
    topology.edges = topology.edges.filter(edge => edge.id !== 'edge-a-b');
    expect(runInputFingerprint(topology, ['b'])).not.toBe(expected);
  });

  it('ignores a persisted wire that the execution engine rejects', () => {
    const original = graph();
    const stale = structuredClone(original);
    stale.edges.push({
      id: 'stale-wire', fromNode: 'a', fromPort: 'out:removed',
      toNode: 'b', toPort: 'in:brief', dataType: 'markdown',
    });
    expect(runInputFingerprint(stale, ['b'])).toBe(runInputFingerprint(original, ['b']));
  });

  it('captures the derived incoming order when layout changes prompt order', () => {
    const original = graph();
    const a = original.nodes[0] as SessionNode;
    const b = original.nodes[1] as SessionNode;
    const c = original.nodes[2] as SessionNode;
    a.y = 0;
    c.y = 200;
    b.contract = undefined;
    original.edges = [
      { id: 'edge-a-b', fromNode: 'a', fromPort: 'out:result', toNode: 'b', toPort: 'context', dataType: 'text' },
      { id: 'edge-c-b', fromNode: 'c', fromPort: 'out:result', toNode: 'b', toPort: 'context', dataType: 'text' },
    ];

    const reordered = structuredClone(original);
    (reordered.nodes[0] as SessionNode).y = 200;
    (reordered.nodes[2] as SessionNode).y = 0;
    expect(runInputFingerprint(reordered, ['b'])).not.toBe(runInputFingerprint(original, ['b']));
  });
});

describe('recovering a run the canvas already shows', () => {
  // The browser that ran a step stamps its delivery with its own clock; a journal rebuilt from the server starts at
  // the server's. Applying the same run again must leave the canvas as it is, so opening it saves nothing.
  const shownAt = (doc: CanvasDocument, at: number): CanvasDocument => ({
    ...doc, nodes: doc.nodes.map(node => node.lastOutput ? { ...node, lastOutput: { ...node.lastOutput, at } } as CanvasNode : node),
  });

  it('keeps each delivery it already shows, its time included', () => {
    const applied = shownAt(applyRecoveredDocument(graph(), journal(graph())), 97);
    const again = applyRecoveredDocument(applied, journal(applied));
    // The whole canvas is unchanged: nothing to save.
    expect(again).toEqual(applied);
    expect(again.nodes.map(node => node.lastOutput?.at ?? null)).toEqual([97, 97, null]);
  });

  it('brings a kept delivery back after a changed step upstream invalidated it', () => {
    // a was published by hand over the run's result, so the run's result replaces it; b shows the run's own result.
    const ran = shownAt(applyRecoveredDocument(graph(), journal(graph())), 97);
    const handPublished = { ...ran, nodes: ran.nodes.map(node => node.id === 'a' ? { ...node, lastOutput: { ...node.lastOutput!, source: 'manual' as const } } as CanvasNode : node) };
    const recovered = applyRecoveredDocument(handPublished, journal(handPublished));
    expect(recovered.nodes[0].lastOutput).toEqual({ text: 'new-a', at: 100, source: 'run' });
    expect(recovered.nodes[1].lastOutput).toBe(handPublished.nodes[1].lastOutput);
    expect(recovered.nodes[2].lastOutput ?? null).toBeNull();
  });

  it('keeps what was published downstream since, while a changed step still invalidates it', () => {
    // a → b → c; the run covered a and b, and c was published by hand afterwards.
    const ran = shownAt(applyRecoveredDocument(graph(), journal(graph())), 97);
    const published = { ...ran, nodes: ran.nodes.map(node => node.id === 'c' ? { ...node, lastOutput: { text: 'by hand', at: 120, source: 'manual' as const } } as CanvasNode : node) };
    expect(applyRecoveredDocument(published, journal(published))).toEqual(published);
    const changed = journal(published);
    const rerun = applyRecoveredDocument(published, { ...changed, nodes: { ...changed.nodes, b: { ...changed.nodes.b, output: 'newer-b' } } });
    expect(rerun.nodes.map(node => node.lastOutput?.text ?? null)).toEqual(['new-a', 'newer-b', null]);
  });

  it('still stamps a result the canvas does not show yet with the run’s start, and keeps the one it does', () => {
    const applied = shownAt(applyRecoveredDocument(graph(), journal(graph())), 97);
    const newer = journal(applied);
    const recovered = applyRecoveredDocument(applied, { ...newer, nodes: { ...newer.nodes, b: { ...newer.nodes.b, output: 'newer-b' } } });
    expect(recovered.nodes.map(node => [node.lastOutput?.text ?? null, node.lastOutput?.at ?? null])).toEqual([['new-a', 97], ['newer-b', 100], [null, null]]);
  });

  it('replaces a shown delivery whose standing changed: partial, or published by hand', () => {
    const applied = applyRecoveredDocument(graph(), journal(graph()));
    const nodes = applied.nodes.map((node, index) => index === 0 ? { ...node, lastOutput: { ...node.lastOutput!, at: 97, partial: true } }
      : index === 1 ? { ...node, lastOutput: { ...node.lastOutput!, at: 97, source: 'manual' as const } } : node) as CanvasNode[];
    const shown = { ...applied, nodes };
    const recovered = applyRecoveredDocument(shown, journal(shown));
    expect(recovered.nodes.slice(0, 2).map(node => node.lastOutput)).toEqual([
      { text: 'new-a', at: 100, source: 'run' }, { text: 'new-b', at: 100, source: 'run' }]);
  });
});

describe('what a recovery publishes', () => {
  const step = (state: string, output?: string) => ({ nodeId: 'a', threadId: 'default', companyId: 'company-1', agentId: 'agent-a',
    issueId: null, runId: null, state, ...(output === undefined ? {} : { output }) }) as CanvasRunJournal['nodes'][string];

  it('publishes a finished step’s text, partial or not', () => {
    for (const state of ['done', 'failed', 'cancelled']) expect(recoverableOutput({}, step(state, 'text'))).toBe('text');
  });

  it('publishes a collaboration step’s latest proposal whatever its state', () => {
    const collaboration = { goal: 'Agree on one plan' } as unknown as CanvasRunJournal['collaboration'];
    expect(recoverableOutput({ collaboration }, step('waiting', 'proposal'))).toBe('proposal');
    expect(recoverableOutput({ collaboration }, step('waiting', ''))).toBeNull();
  });

  it('publishes nothing for a step that is waiting, blocked, reused or left no text (the server sends those as "")', () => {
    for (const [state, output] of [['blocked', ''], ['blocked', 'Upstream did not complete'], ['waiting', ''], ['running', 'so far'],
      ['cached', 'old result'], ['done', ''], ['failed', undefined]] as const) expect(recoverableOutput({}, step(state, output))).toBeNull();
  });
});


describe('structured follow-up delivery recovery', () => {
  const revised = '{"result":"## Revised book club\\nBudget: 240 yuan"}';
  it('publishes a confirmed revision and invalidates downstream results once', () => {
    const original = graph();
    const saved = journal(original, true);
    saved.scope = ['a']; saved.inputFingerprint = runInputFingerprint(original, ['a']);
    saved.nodes = { a: { ...saved.nodes.a, output: revised } };
    const recovered = applyRecoveredDocument(original, saved);
    expect(recovered.nodes.map(node => node.lastOutput?.text ?? null)).toEqual([revised, null, null]);
    expect(applyRecoveredDocument(recovered, saved)).toEqual(recovered);
  });

  it.each(['failed', 'cancelled', 'running', 'invalid', 'changed'] as const)('keeps the prior publication for a %s revision', state => {
    const original = graph();
    const saved = journal(original, true);
    saved.scope = ['a']; saved.inputFingerprint = runInputFingerprint(original, ['a']);
    saved.nodes = { a: { ...saved.nodes.a, output: state === 'invalid' ? '{"result":3}' : revised,
      state: state === 'invalid' || state === 'changed' ? 'done' : state } };
    if (state === 'changed') (original.nodes[0] as SessionNode).persona = 'Changed after admission';
    expect(applyRecoveredDocument(original, saved).nodes.map(node => node.lastOutput)).toEqual(original.nodes.map(node => node.lastOutput));
  });
});


it('protects a follow-up from its superseded graph and allows a newly admitted graph to replace it', () => {
  const original = graph();
  original.nodes[1].lastOutput = { text: 'Revision', source: 'run', at: 1, supersedesThroughGraphVersion: 12, supersedesGraphCanvasId: 'canvas' };
  const old = journal(original);
  old.serverGraph = { tenantId: 'company-1', canvasId: 'canvas', id: 'old-graph', documentVersion: 12 };
  const recovered = applyRecoveredDocument(original, old);
  expect(recovered.nodes[0].lastOutput?.text).toBe('new-a');
  expect(recovered.nodes[1].lastOutput?.text).toBe('Revision');
  const next = { ...old, serverGraph: { ...old.serverGraph, id: 'new-graph', documentVersion: 13 } };
  expect(applyRecoveredDocument(original, next).nodes[1].lastOutput?.text).toBe('new-b');
});

it('does not resurrect stale downstream results from a graph superseded by an upstream revision', () => {
  const original = graph();
  original.nodes[0].lastOutput = { text: 'Revised upstream', source: 'run', at: 1, supersedesThroughGraphVersion: 12, supersedesGraphCanvasId: 'canvas' };
  original.nodes[1].lastOutput = null;
  original.nodes[2].lastOutput = null;
  const old = journal(original);
  old.serverGraph = { tenantId: 'company-1', canvasId: 'canvas', id: 'old-graph', documentVersion: 12 };
  expect(applyRecoveredDocument(original, old).nodes.map(node => node.lastOutput?.text ?? null)).toEqual(['Revised upstream', null, null]);
});

it('preserves a revision from any graph admitted on its prior cloud version while allowing a graph that saw the revision', () => {
  const original = graph();
  original.nodes[1].lastOutput = { text: 'Concurrent-safe revision', source: 'run', at: 1, supersedesThroughGraphVersion: 12, supersedesGraphCanvasId: 'canvas' };
  const stale = journal(original);
  stale.serverGraph = { tenantId: 'company-1', canvasId: 'canvas', id: 'different-graph-admitted-during-chat', documentVersion: 12 };
  expect(applyRecoveredDocument(original, stale).nodes[1].lastOutput?.text).toBe('Concurrent-safe revision');
  const later = { ...stale, serverGraph: { ...stale.serverGraph, id: 'graph-after-revision', documentVersion: 13 } };
  expect(applyRecoveredDocument(original, later).nodes[1].lastOutput?.text).toBe('new-b');
});


it('does not suppress graphs from another canvas when copying a document with a revision', () => {
  const original = graph();
  original.nodes[1].lastOutput = { text: 'Copied revision', source: 'run', at: 1,
    supersedesThroughGraphVersion: 12, supersedesGraphCanvasId: 'original-canvas' };
  const copied = journal(original);
  copied.serverGraph = { tenantId: 'company-1', canvasId: 'new-canvas', id: 'new-canvas-graph', documentVersion: 1 };
  expect(applyRecoveredDocument(original, copied).nodes[1].lastOutput?.text).toBe('new-b');
});
