import { describe, expect, it } from 'vitest';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import type { CanvasRunJournal } from '../src/canvas/runJournal';
import { journalSummary } from '../src/canvas/runJournal';
import {
  applyRecoveredDocument,
  mergeRecoveredManualConversation,
  mergePersistedManualConversations,
  persistRecoveredManualConversation,
  recoveryJournalForDocument,
  prepareRunDocument,
  runInputFingerprint,
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
