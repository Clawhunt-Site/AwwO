import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { applyRecoveredDocument } from '../src/canvas/runRecoveryDocument';
import { CANVAS_RUN_JOURNAL_KEY, journalSummary, loadRunJournal, saveRunJournal } from '../src/canvas/runJournal';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { GraphRunPanel } from '../src/saas/GraphRunPanel';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { graphRecoveryJournal, mergeGraphSnapshot, submitCloudGraph, validGraphCollaboration,
  type GraphCollaborationSnapshot, type GraphRunSnapshot } from '../src/saas/graphRuns';

const base = '/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs';
const policy = { goal: 'Compare and improve the synthetic proposal', rounds: 1, synthesizerNodeId: 'a' };
const node = (id: string): SessionNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id,
  title: `Agent ${id}`, activeThreadId: `thread-${id}`, issueId: `session-${id}`,
  binding: { companyId: 'tenant-a', agentId: `agent-${id}`, agentName: id },
});
const document = (): CanvasDocument => ({ ...emptyDocument(), nodes: [node('a'), node('b')] });
const collaboration = (): GraphCollaborationSnapshot => ({ ...policy, maxModelCalls: 5, phase: 'review', round: 1, turns: [
  { ordinal: 1, nodeId: 'a', phase: 'proposal', round: 1, status: 'completed', runId: 'run-a1', sessionId: 'session-a', output: 'Candidate A' },
  { ordinal: 2, nodeId: 'b', phase: 'proposal', round: 1, status: 'completed', runId: 'run-b1', sessionId: 'session-b', output: 'Candidate B' },
  { ordinal: 3, nodeId: 'a', phase: 'review', round: 1, status: 'running', runId: 'run-a2', sessionId: 'session-a', output: 'Check evidence for the estimate' },
  { ordinal: 4, nodeId: 'b', phase: 'review', round: 1, status: 'waiting', sessionId: 'session-b' },
  { ordinal: 5, nodeId: 'a', phase: 'synthesis', round: 1, status: 'waiting', sessionId: 'session-a' },
] });
const snapshot = (patch: Partial<GraphRunSnapshot> = {}): GraphRunSnapshot => ({ id: 'graph-a', operationId: 'operation-a',
  canvasId: 'canvas-a', documentVersion: 1, document: document(), scope: ['a', 'b'], status: 'running', createdAt: '2026-09-12T00:00:00Z',
  collaboration: collaboration(), nodes: [
    { nodeId: 'a', state: 'running', runId: 'run-a2', sessionId: 'session-a', output: 'Candidate A', partial: true, phase: 'review', round: 1 },
    { nodeId: 'b', state: 'waiting', runId: 'run-b1', sessionId: 'session-b', output: 'Candidate B', partial: true },
  ], ...patch,
});
const completed = (): GraphRunSnapshot => {
  const group = collaboration(); group.phase = 'synthesis';
  group.turns = group.turns.map(turn => ({ ...turn, status: 'completed', runId: turn.runId || (turn.nodeId === 'b' ? 'run-b2' : 'run-a3'),
    output: turn.output || (turn.phase === 'synthesis' ? 'Final synthesis' : 'Review B') }));
  return snapshot({ status: 'completed', collaboration: group, nodes: [
    { nodeId: 'a', state: 'done', runId: 'run-a3', sessionId: 'session-a', output: 'Final synthesis', partial: false, phase: 'synthesis', round: 1 },
    { nodeId: 'b', state: 'done', runId: 'run-b2', sessionId: 'session-b', output: 'Candidate B', partial: true, phase: 'review', round: 1 },
  ] });
};
const storage = () => {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
};
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'en'); });
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); localStorage.clear(); });

describe('selected-node collaboration admission and identity', () => {
  it('treats the real ordinary-DAG collaboration:null response as a legacy graph across recovery and storage', () => {
    const data = completed(); data.collaboration = null;
    const journal = graphRecoveryJournal(data, 'tenant-a', document());
    expect(journal.collaboration).toBeUndefined();
    const saved = storage(); saved.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify({ ...journal, collaboration: null }));
    expect(loadRunJournal(saved)).toEqual(journal);
    expect(journalSummary(journal).ok).toBe(true);
  });

  it('captures policy and exact scope before saving, with one versioned POST', async () => {
    configureSaaSCanvas({ tenant: { id: 'tenant-a', name: 'Test', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 20 }, canvasId: 'canvas-a' });
    let finish!: (version: number) => void;
    configureSaaSCanvasSave(() => new Promise(resolve => { finish = resolve; }));
    const fetcher = vi.fn(async (_url: string, _init: RequestInit = {}) => json(snapshot())); vi.stubGlobal('fetch', fetcher);
    const input = { ...policy }; const scope = ['a', 'b'];
    const request = submitCloudGraph('operation-a', scope, input);
    input.goal = 'Changed while saving'; scope.reverse();
    expect(fetcher).not.toHaveBeenCalled(); finish(12); await request;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({ operationId: 'operation-a', documentVersion: 12, scope: ['a', 'b'], collaboration: policy });
  });

  it('persists actual phase, every turn, original Sessions and partial candidates through reload', () => {
    const journal = graphRecoveryJournal(snapshot(), 'tenant-a', document()); const saved = storage();
    expect(saveRunJournal(journal, saved)).toBe(true);
    expect(loadRunJournal(saved)).toEqual(journal);
    expect(journal.nodes.a).toMatchObject({ issueId: 'session-a', phase: 'review', partial: true });
    expect(journal.collaboration?.turns).toHaveLength(5);
    expect(journalSummary(journal).ok).toBe(false);
  });

  it.each(['graph', 'policy', 'session', 'turn', 'scope', 'missing-policy'])('rejects a changed %s identity without replacing existing evidence', kind => {
    const journal = graphRecoveryJournal(snapshot(), 'tenant-a', document()); const next = completed();
    if (kind === 'graph') next.id = 'foreign-graph';
    if (kind === 'policy') next.collaboration!.goal = 'Foreign goal';
    if (kind === 'session') next.nodes[0]!.sessionId = 'foreign-session';
    if (kind === 'turn') next.collaboration!.turns[0]!.runId = 'foreign-run';
    if (kind === 'scope') next.scope = ['a', 'foreign-node'];
    if (kind === 'missing-policy') delete next.collaboration;
    expect(() => mergeGraphSnapshot(journal, next)).toThrow();
    expect(journal.collaboration!.turns[0]!.runId).toBe('run-a1');
  });

  it('rejects a turn that changes node Session between proposal and review', () => {
    const value = collaboration(); value.turns[2]!.sessionId = 'other-session';
    expect(validGraphCollaboration(value, ['a', 'b'])).toBe(false);
  });

  it('refuses stale responses that drop already observed turns or change the frozen node persona', () => {
    const journal = graphRecoveryJournal(snapshot(), 'tenant-a', document());
    const stale = snapshot(); stale.collaboration!.turns = [];
    expect(() => mergeGraphSnapshot(journal, stale)).toThrow('regressed');
    const changed = snapshot(); (changed.document!.nodes[0] as SessionNode).persona = 'A different Agent';
    expect(() => mergeGraphSnapshot(journal, changed)).toThrow('document changed');
  });

  it('allows undelivered planned turns to be cancelled without inventing run IDs', () => {
    const value = collaboration(); value.turns[3]!.status = 'cancelled'; value.turns[4]!.status = 'cancelled';
    expect(validGraphCollaboration(value, ['a', 'b'])).toBe(true);
  });

  it('refuses torn collaboration metadata instead of loading it as an ordinary DAG', () => {
    const journal = graphRecoveryJournal(snapshot(), 'tenant-a', document()); const saved = storage();
    journal.collaboration!.turns[0]!.ordinal = 99; saved.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(journal));
    expect(loadRunJournal(saved)).toBeNull();
  });
});

describe('collaboration output publication', () => {
  it('shows candidates as partial while review is running, without publishing review text', () => {
    const journal = graphRecoveryJournal(snapshot(), 'tenant-a', document());
    const restored = applyRecoveredDocument(document(), { ...journal, inputFingerprint: journal.inputFingerprint! });
    expect(restored.nodes[0]!.lastOutput).toMatchObject({ text: 'Candidate A', partial: true });
    expect(restored.nodes[1]!.lastOutput).toMatchObject({ text: 'Candidate B', partial: true });
    expect(JSON.stringify(restored)).not.toContain('Check evidence for the estimate');
  });

  it('publishes only the completed synthesis and leaves the other proposal partial', () => {
    const pending = graphRecoveryJournal(snapshot(), 'tenant-a', document());
    const journal = mergeGraphSnapshot(pending, completed());
    const restored = applyRecoveredDocument(document(), { ...journal, inputFingerprint: journal.inputFingerprint! });
    expect(restored.nodes[0]!.lastOutput?.text).toBe('Final synthesis');
    expect(restored.nodes[0]!.lastOutput?.partial).not.toBe(true);
    expect(restored.nodes[1]!.lastOutput).toMatchObject({ text: 'Candidate B', partial: true });
    expect(journalSummary(journal).ok).toBe(true);
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)('keeps the latest proposals partial after %s', status => {
    const data = completed(); data.status = status;
    const journal = graphRecoveryJournal(data, 'tenant-a', document());
    const restored = applyRecoveredDocument(document(), { ...journal, inputFingerprint: journal.inputFingerprint! });
    expect(restored.nodes.every(item => item.lastOutput?.partial === true)).toBe(true);
    expect(journalSummary(journal).ok).toBe(false);
  });
});

describe('durable collaboration details', () => {
  it('keeps ordinary-DAG history readable when the server includes collaboration:null', async () => {
    const data = completed(); data.collaboration = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === base ? { items: [data] }
      : url.endsWith('/turns') ? { items: [] } : { id: 'run-a3', tenantId: 'tenant-a', status: 'completed' })));
    render(<SaaSPreferencesProvider><GraphRunPanel tenantId="tenant-a" canvasId="canvas-a" readOnly /></SaaSPreferencesProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Background runs & collaboration/ }));
    expect(await screen.findByText('Final synthesis')).toBeVisible();
    expect(screen.queryByText('Invalid graph run response')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Selected-node collaboration' })).toBeNull();
  });

  it('renders actual turns and planned steps distinctly, including original Session and review evidence', async () => {
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => { expect(url).toBe(base); return json({ items: [snapshot()] }); });
    vi.stubGlobal('fetch', fetcher);
    render(<SaaSPreferencesProvider><GraphRunPanel tenantId="tenant-a" canvasId="canvas-a" readOnly /></SaaSPreferencesProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Background runs & collaboration/ }));
    const region = within(await screen.findByRole('region', { name: 'Selected-node collaboration' }));
    expect(region.getByText('3/5 calls admitted · Synthesizer: Agent a')).toBeInTheDocument();
    expect(region.getByText('run-a2')).toBeInTheDocument();
    expect(region.getByText('Check evidence for the estimate')).toBeVisible();
    expect(region.getByText('Review evidence; not a published deliverable')).toBeVisible();
    expect(region.getAllByText('No model call has been dispatched for this step.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Stop entire task' })).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => !init.method)).toBe(true);
  });

  it('labels completed synthesis without claiming another review of the final result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [completed()] })));
    render(<SaaSPreferencesProvider><GraphRunPanel tenantId="tenant-a" canvasId="canvas-a" /></SaaSPreferencesProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Background runs & collaboration/ }));
    expect(await screen.findByText('Synthesis after peer review is complete. The synthesis has not had an additional independent review.')).toBeVisible();
    expect(screen.getByText('Node result')).toBeVisible();
  });
});
