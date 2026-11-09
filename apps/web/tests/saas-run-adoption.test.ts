import { describe, expect, it } from 'vitest';
import { agentTextHash } from '../src/canvas/agentPages';
import { createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument, type CanvasEdge, type NodeOutput } from '../src/canvas/canvasDoc';
import type { CanvasChange, CanvasOp } from '../src/canvas/multiplayer/types';
import type { GraphRunSnapshot } from '../src/saas/graphRuns';
import { ADOPT_GRACE_MS, ADOPT_WITHIN_MS, endedRunsToCheck, missingResults, nodesRunSince, resultsNewerByClock, resultsTouchedAfter,
  runLanding, runScope, touchedSinceEnd, workingHoldsLanding } from '../src/saas/runAdoption';
import { graphRunSummary } from './saas-graph-run-summary-fixture';

// 多人同屏: an open canvas lands a run whose starter's page closed before it ended (runAdoption.ts).

const tenantId = 'tenant-a';
const step = (id: string, x: number, lastOutput?: NodeOutput) => ({
  ...createSessionNode('llm', { x, y: 0 }), id, title: `Step ${id}`, runtime: 'openai', model: 'qwen',
  binding: { companyId: tenantId, agentId: `agent-${id}`, agentName: id }, ...(lastOutput ? { lastOutput } : {}),
});
/** Steps a, b and c (outputs by id), wired by `edges`. */
const canvas = (outputs: Partial<Record<'a' | 'b' | 'c', NodeOutput>> = {}, edges: CanvasEdge[] = []): CanvasDocument =>
  sanitizeDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 }, edges,
    nodes: [step('a', 0, outputs.a), step('b', 500, outputs.b), step('c', 1000, outputs.c)] });
const wire = (from: string, to: string): CanvasEdge => ({ id: `${from}-${to}`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'context', dataType: 'text' });
const NOW = Date.parse('2026-11-08T10:00:00Z');
const ENDED = NOW - 60_000;
/** A run of `scope` frozen on `document` that ended at ENDED: each node done with its output, or as `states` says. */
const run = (document: CanvasDocument, scope: string[], states: Record<string, 'done' | 'failed' | 'blocked'> = {}): GraphRunSnapshot => ({
  id: 'graph-1', operationId: 'operation-1', canvasId: 'canvas-1', documentVersion: 3, document, scope, status: 'failed',
  createdAt: new Date(ENDED - 30_000).toISOString(), updatedAt: new Date(ENDED).toISOString(),
  nodes: scope.map(nodeId => ({ nodeId, state: states[nodeId] ?? 'done', output: (states[nodeId] ?? 'done') === 'done' ? `${nodeId.toUpperCase()} by the run` : '' })),
});
const byHand = (text: string, at: number): NodeOutput => ({ text, at, source: 'manual' });
const change = (ops: CanvasOp[], at: number, version = 4): CanvasChange => ({ version, actor: { kind: 'human', name: 'Member', clientId: 'page-other-1', userId: 'user-other' },
  label: 'edit', ops, at: new Date(at).toISOString() });
const none = new Set<string>();
const output = (document: CanvasDocument, id: string) => document.nodes.find(node => node.id === id)?.lastOutput ?? null;

describe('which ended runs an open canvas looks at', () => {
  it('takes those that ended at least the grace ago and within the window, never one still going', () => {
    const at = (status: GraphRunSnapshot['status'], ago: number, id: string) => ({ ...graphRunSummary({ ...run(canvas(), ['a']), status,
      updatedAt: new Date(NOW - ago).toISOString() }), id });
    const items = [at('completed', ADOPT_GRACE_MS - 1, 'too-soon'), at('completed', ADOPT_GRACE_MS, 'due'), at('failed', 5 * 60_000, 'failed'),
      at('running', 60_000, 'running'), at('completed', ADOPT_WITHIN_MS + 1, 'too-old')];
    expect(endedRunsToCheck(items, NOW).map(item => item.id)).toEqual(['due', 'failed']);
    // None that ended before the page opened (the opening took up the latest of those), unless the opening left it to the
    // page: then however long ago it ended.
    expect(endedRunsToCheck(items, NOW, NOW - 60_000).map(item => item.id)).toEqual(['due']);
    expect(endedRunsToCheck(items, NOW, NOW - 60_000, new Set(['failed', 'too-old', 'too-soon'])).map(item => item.id)).toEqual(['due', 'failed', 'too-old']);
  });

  it('reads a run’s nodes as its recovery does: its scope, else the nodes it did not reuse', () => {
    expect(runScope({ scope: ['a'], nodes: [{ nodeId: 'a', state: 'done' }, { nodeId: 'b', state: 'cached' }] })).toEqual(['a']);
    expect(runScope({ scope: [], nodes: [{ nodeId: 'a', state: 'done' }, { nodeId: 'b', state: 'cached' }] })).toEqual(['a']);
  });

  it('names the nodes a newer run holds or remade, and none a newer run failed on or reused', () => {
    const older = { ...graphRunSummary(run(canvas(), ['a', 'b'])), id: 'older' };
    const newer = (status: GraphRunSnapshot['status'], nodes: { nodeId: string; state: 'done' | 'failed' | 'cached' | 'running' }[]) => ({
      ...graphRunSummary({ ...run(canvas(), nodes.map(node => node.nodeId)), status }), id: 'newer', createdAt: new Date(NOW - 20_000).toISOString(), nodes });
    expect([...nodesRunSince([newer('completed', [{ nodeId: 'b', state: 'done' }]), older], older)]).toEqual(['b']);
    expect([...nodesRunSince([newer('running', [{ nodeId: 'a', state: 'running' }]), older], older)]).toEqual(['a']);
    expect([...nodesRunSince([newer('failed', [{ nodeId: 'b', state: 'failed' }]), older], older)]).toEqual([]);
    expect([...nodesRunSince([older], newer('completed', [{ nodeId: 'b', state: 'done' }]))]).toEqual([]);
  });
});

describe('what changed on the canvas since a run ended', () => {
  it('names the nodes whose result anyone changed at its end or later, by the server’s time, and none moved or renamed', () => {
    const changes = [
      change([{ op: 'set', path: ['nodes', 'a', 'lastOutput'], value: byHand('A before', 0) }], ENDED - 1),
      change([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: byHand('B by hand', 0) }], ENDED + 5_000),
      change([{ op: 'set', path: ['nodes', 'c', 'threads', 'default', 'lastOutput'], value: null }], ENDED + 6_000),
      change([{ op: 'set', path: ['nodes', 'a', 'x'], value: 40 }, { op: 'set', path: ['nodes', 'a', 'title'], value: 'Renamed' }], ENDED + 7_000),
      change([{ op: 'del', path: ['nodes', 'gone'] }], ENDED + 8_000),
    ];
    expect([...resultsTouchedAfter(changes, ENDED)].sort()).toEqual(['b', 'c', 'gone']);
    // A change whose time cannot be read could be any time: it counts.
    expect([...resultsTouchedAfter([{ ...changes[0], at: 'not a time' }], ENDED)]).toEqual(['a']);
  });

  it('where the log no longer reaches back, takes a result stamped at the run’s end or later as newer', () => {
    const document = canvas({ a: { text: 'Partial', at: ENDED - 10_000, source: 'run', partial: true }, b: byHand('B by hand', ENDED + 1) });
    expect([...resultsNewerByClock(document, ENDED)]).toEqual(['b']);
  });

  it('reads the log from the run’s admission, or from later where its oldest change came before the run’s end', () => {
    const ran = run(canvas(), ['a', 'b']);
    // b's result by hand after the end, stamped by a clock running behind; the canvas shows it.
    const shown = canvas({ b: byHand('B by hand', ENDED - 60_000) });
    const handed = change([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: byHand('B by hand', 0) }], ENDED + 5_000, 400);
    const before = change([{ op: 'set', path: ['nodes', 'c', 'x'], value: 1 }], ENDED - 60_000, 399);
    // From the admission (version 3): the log holds everything.
    expect([...touchedSinceEnd(ran, { version: 400, changes: [handed] }, 3, shown)]).toEqual(['b']);
    // From version 398, whose oldest change came a minute before the end: everything since the end is in it.
    expect([...touchedSinceEnd(ran, { version: 400, changes: [before, handed] }, 398, shown)]).toEqual(['b']);
    // From version 399, whose oldest change came after the end: a change between the admission and it may be missing, so
    // a result's own time tells too, with what the changes read do say (b's, here).
    expect([...touchedSinceEnd(ran, { version: 400, changes: [handed] }, 399, shown)]).toEqual(['b']);
    const moved = change([{ op: 'set', path: ['nodes', 'c', 'x'], value: 2 }], ENDED + 6_000, 400);
    expect([...touchedSinceEnd(ran, { version: 400, changes: [moved] }, 399, shown)]).toEqual([]);
    // When the log was pruned, a result's own time alone (b's reads older).
    expect([...touchedSinceEnd(ran, { version: 400, reset: true }, 3, shown)]).toEqual([]);
    expect([...touchedSinceEnd(ran, { version: 400, reset: true }, 3, canvas({ b: byHand('B by hand', ENDED + 1) }))]).toEqual(['b']);
  });
});

describe('how an ended run lands on a canvas', () => {
  it('as its results alone, where the canvas lacks them and still holds their inputs', () => {
    const landing = runLanding(run(canvas(), ['a']), canvas(), tenantId, none, none);
    expect(landing?.whole).toBe(true);
    expect(landing?.ops.every(op => op.op === 'set' && op.path[0] === 'nodes' && op.path[1] === 'a' && ['lastOutput', 'issueId', 'threads'].includes(op.path[2]))).toBe(true);
    expect(output(landing!.document, 'a')).toMatchObject({ text: 'A by the run', source: 'run' });
    expect(landing?.nodes).toContain('a');
  });

  it('with the fingerprint of a result made from an invited Agent’s words, as every landing records one', () => {
    const persona = 'Reply with exactly this page';
    const written = sanitizeDocument({ ...canvas(), nodes: canvas().nodes.map(node => node.id === 'a'
      ? { ...node, persona, agentWritten: [{ h: agentTextHash(persona), by: 'Codex' }] } : node) });
    const landing = runLanding(run(written, ['a']), written, tenantId, none, none);
    expect(landing?.whole).toBe(true);
    expect(output(landing!.document, 'a')).toMatchObject({ text: 'A by the run', source: 'run' });
    expect(landing!.document.nodes.find(node => node.id === 'a')?.agentWritten).toContainEqual({ h: agentTextHash('A by the run'), by: 'Codex' });
  });

  it('not at all once the canvas shows them, nor once their inputs changed', () => {
    const shown = canvas({ a: { text: 'A by the run', at: 1, source: 'run' } });
    expect(runLanding(run(canvas(), ['a']), shown, tenantId, none, none)).toBeNull();
    const changed = sanitizeDocument({ ...canvas(), nodes: canvas().nodes.map(node => node.id === 'a' ? { ...node, persona: 'A different brief' } : node) });
    expect(runLanding(run(canvas(), ['a']), changed, tenantId, none, none)).toBeNull();
    expect(missingResults(run(canvas(), ['a']), shown, tenantId, none)).toBe(false);
    expect(missingResults(run(canvas(), ['a']), canvas(), tenantId, none)).toBe(true);
    // The same text shown partial, or by hand, may still lack the run's own result: the run is read whole to tell.
    expect(missingResults(run(canvas(), ['a']), canvas({ a: { text: 'A by the run', at: 1, source: 'run', partial: true } }), tenantId, none)).toBe(true);
    expect(missingResults(run(canvas(), ['a']), canvas({ a: byHand('A by the run', 1) }), tenantId, none)).toBe(true);
  });

  it('whole, where a step changed since the run ended shows the run’s own result (its page published it late)', () => {
    // a → b: the starter's page published a's result just after the run ended, then closed before b's.
    const edges = [wire('a', 'b')];
    const now = canvas({ a: { text: 'A by the run', at: ENDED - 30_000, source: 'run' } }, edges);
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'a', 'lastOutput'], value: { text: 'A by the run', at: ENDED - 30_000, source: 'run' } }], ENDED + 1_000)], ENDED);
    const landing = runLanding(run(canvas({}, edges), ['a', 'b']), now, tenantId, none, touched);
    expect(landing?.whole).toBe(true);
    expect(output(landing!.document, 'b')?.text).toBe('B by the run');
    expect(output(landing!.document, 'a')).toEqual(output(now, 'a'));
  });

  it('keeps the run’s steps after a step it keeps, which were made from a result the canvas does not show', () => {
    // a → b, and c on its own. Since the run ended, a member chatted with a (its conversation changed, its result did not).
    const edges = [wire('a', 'b')];
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'a', 'threads'], value: [] }], ENDED + 1_000)], ENDED);
    const landing = runLanding(run(canvas({}, edges), ['a', 'b', 'c']), canvas({}, edges), tenantId, none, touched);
    // a stays as it is, and so does b, made from a's result by the run; c lands.
    expect(landing?.journal.scope).toEqual(['c']);
    expect(output(landing!.document, 'a')).toBeNull();
    expect(output(landing!.document, 'b')).toBeNull();
    expect(output(landing!.document, 'c')?.text).toBe('C by the run');
    // A result by hand on a since the run ended keeps b off as well, and the run's own result for a too.
    const byHandA = canvas({ a: byHand('A by hand', ENDED + 2_000) }, edges);
    const handed = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'a', 'lastOutput'], value: byHand('A by hand', 0) }], ENDED + 2_000)], ENDED);
    const rest = runLanding(run(canvas({}, edges), ['a', 'b', 'c']), byHandA, tenantId, none, handed);
    expect(rest?.journal.scope).toEqual(['c']);
    expect(output(rest!.document, 'a')?.text).toBe('A by hand');
    expect(output(rest!.document, 'b')).toBeNull();
  });

  it('keeps the conversation a step got since the run ended, though its result did not change', () => {
    // k failed in the run, in a session of its own; since the end a member chatted with k, in a session k now shows.
    const frozen = canvas();
    const ran: GraphRunSnapshot = { ...run(frozen, ['a', 'b'], { a: 'failed' }),
      nodes: [{ nodeId: 'a', state: 'failed', output: '', sessionId: 'session-run' }, { nodeId: 'b', state: 'done', output: 'B by the run' }] };
    const chatted = sanitizeDocument({ ...frozen, nodes: frozen.nodes.map(node => node.id === 'a' ? { ...node, issueId: 'session-chat' } : node) });
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'a', 'issueId'], value: 'session-chat' }], ENDED + 1_000)], ENDED);
    const landing = runLanding(ran, chatted, tenantId, none, touched);
    expect(landing?.journal.scope).toEqual(['b']);
    expect(landing?.ops.some(op => op.path[1] === 'a')).toBe(false);
    expect(landing!.document.nodes.find(node => node.id === 'a')).toMatchObject({ issueId: 'session-chat' });
    expect(output(landing!.document, 'b')?.text).toBe('B by the run');
  });

  it('lands the rest where a step’s own inputs changed since the run (its brief edited to run it again)', () => {
    const edited = sanitizeDocument({ ...canvas(), nodes: canvas().nodes.map(node => node.id === 'b' ? { ...node, persona: 'A better brief' } : node) });
    // b failed and was edited, then run again by a newer run: a still lands.
    const again = runLanding(run(canvas(), ['a', 'b'], { b: 'failed' }), edited, tenantId, new Set(['b']), none);
    expect(again?.journal.scope).toEqual(['a']);
    expect(output(again!.document, 'a')?.text).toBe('A by the run');
    // Edited and not run again: the same.
    expect(runLanding(run(canvas(), ['a', 'b']), edited, tenantId, none, none)?.journal.scope).toEqual(['a']);
    // A step after a step of the run that shows the run's own result (its page published it) is not changed by it.
    const fed = [wire('a', 'c')];
    const publishedA = sanitizeDocument({ ...canvas({ a: { text: 'A by the run', at: ENDED - 30_000, source: 'run' } }, fed),
      nodes: canvas({ a: { text: 'A by the run', at: ENDED - 30_000, source: 'run' } }, fed).nodes.map(node => node.id === 'b' ? { ...node, persona: 'A better brief' } : node) });
    const rest = runLanding(run(canvas({}, fed), ['a', 'b', 'c']), publishedA, tenantId, none, none);
    expect(rest?.journal.scope).toEqual(['a', 'c']);
    expect(output(rest!.document, 'c')?.text).toBe('C by the run');
    // But not a step after the edited one, made from its run result.
    const wired = [wire('b', 'c')];
    const editedWired = sanitizeDocument({ ...canvas({}, wired), nodes: canvas({}, wired).nodes.map(node => node.id === 'b' ? { ...node, persona: 'A better brief' } : node) });
    expect(runLanding(run(canvas({}, wired), ['a', 'b', 'c']), editedWired, tenantId, none, none)?.journal.scope).toEqual(['a']);
  });

  it('lands the rest where a step’s own inputs changed, past a step changed since that shows the run’s own result', () => {
    // a → c, and b on its own. The starter's page published a's result just after the run ended, then closed before c's;
    // since, someone edited b's brief.
    const fed = [wire('a', 'c')];
    const published: NodeOutput = { text: 'A by the run', at: ENDED - 30_000, source: 'run' };
    const briefOf = (document: CanvasDocument) => sanitizeDocument({ ...document, nodes: document.nodes.map(node => node.id === 'b' ? { ...node, persona: 'A better brief' } : node) });
    const now = briefOf(canvas({ a: published }, fed));
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'a', 'lastOutput'], value: published }], ENDED + 1_000)], ENDED);
    const landing = runLanding(run(canvas({}, fed), ['a', 'b', 'c']), now, tenantId, none, touched);
    expect(landing?.journal.scope).toEqual(['a', 'c']);
    expect(output(landing!.document, 'c')?.text).toBe('C by the run');
    expect(output(landing!.document, 'a')).toEqual(published);
    // A step changed since that does not show the run's own result keeps the steps after it: nothing lands.
    const byHandA = briefOf(canvas({ a: byHand('A by hand', ENDED + 1_000) }, fed));
    expect(runLanding(run(canvas({}, fed), ['a', 'b', 'c']), byHandA, tenantId, none, touched)).toBeNull();
  });

  it('keeps a step changed since whose own delivery would change its conversation, and lands the rest, where a step’s inputs changed', () => {
    // a → c, b and d on their own. The starter's page published a's result just after the run ended, then a member
    // chatted with a (its session changed); since, someone edited b's brief.
    const fed = [wire('a', 'c')];
    const published: NodeOutput = { text: 'A by the run', at: ENDED - 30_000, source: 'run' };
    const four = (outputs: Partial<Record<'a' | 'b' | 'c' | 'd', NodeOutput>> = {}) => sanitizeDocument({ ...emptyDocument(), view: { x: 0, y: 0, scale: 1 },
      edges: fed, nodes: [step('a', 0, outputs.a), step('b', 500, outputs.b), step('c', 1000, outputs.c), step('d', 1500, outputs.d)] });
    const now = sanitizeDocument({ ...four({ a: published }), nodes: four({ a: published }).nodes.map(node =>
      node.id === 'a' ? { ...node, issueId: 'session-chat' } : node.id === 'b' ? { ...node, persona: 'A better brief' } : node) });
    const ran: GraphRunSnapshot = { ...run(four(), ['a', 'b', 'c', 'd']), nodes: ['a', 'b', 'c', 'd'].map(nodeId =>
      ({ nodeId, state: 'done' as const, output: `${nodeId.toUpperCase()} by the run`, sessionId: `session-${nodeId}` })) };
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'a', 'issueId'], value: 'session-chat' }], ENDED + 1_000)], ENDED);
    const landing = runLanding(ran, now, tenantId, none, touched);
    // a stays (its run delivery would take its conversation back), and c after it; b's inputs changed; d lands.
    expect(landing?.journal.scope).toEqual(['d']);
    expect(output(landing!.document, 'd')?.text).toBe('D by the run');
    expect(landing!.document.nodes.find(node => node.id === 'a')).toMatchObject({ issueId: 'session-chat' });
  });

  it('as ordinary freshness has it: a step that had no result makes stale what lies after it', () => {
    // a → c. The run made a, which showed nothing.
    const edges = [wire('a', 'c')];
    // Since the run ended, a member published c by hand: landing a would make it stale, so nothing lands.
    const handC = canvas({ c: byHand('C by hand', ENDED + 1_000) }, edges);
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'c', 'lastOutput'], value: byHand('C by hand', 0) }], ENDED + 1_000)], ENDED);
    expect(runLanding(run(canvas({}, edges), ['a']), handC, tenantId, none, touched)).toBeNull();
    // c's result from before the run ended goes stale with a's: the landing clears it.
    const olderC = canvas({ c: { text: 'C before', at: ENDED - 60_000, source: 'run' } }, edges);
    const landing = runLanding(run(canvas({}, edges), ['a']), olderC, tenantId, none, none);
    expect(output(landing!.document, 'a')?.text).toBe('A by the run');
    expect(output(landing!.document, 'c')).toBeNull();
    expect(landing?.ops.some(op => op.path[1] === 'c' && op.path[2] === 'lastOutput')).toBe(true);
  });

  it('takes the session a failed step got for no change of what lies after it', () => {
    // a → c, b on its own; the run covered a and b. a failed, in a session of its own; b is done.
    const edges = [wire('a', 'c')];
    const ran: GraphRunSnapshot = { ...run(canvas({}, edges), ['a', 'b'], { a: 'failed' }),
      nodes: [{ nodeId: 'a', state: 'failed', output: '', sessionId: 'session-a' }, { nodeId: 'b', state: 'done', output: 'B by the run', sessionId: 'session-b' }] };
    // c was published while the run went: b lands, and c stays (a delivered nothing).
    const during = canvas({ c: byHand('C by hand', ENDED - 5_000) }, edges);
    const landing = runLanding(ran, during, tenantId, none, none);
    expect(output(landing!.document, 'b')?.text).toBe('B by the run');
    expect(output(landing!.document, 'c')?.text).toBe('C by hand');
    expect(landing?.ops.some(op => op.path[1] === 'c')).toBe(false);
    // c was published since the run ended: the same.
    const since = canvas({ c: byHand('C by hand', ENDED + 5_000) }, edges);
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'c', 'lastOutput'], value: byHand('C by hand', 0) }], ENDED + 5_000)], ENDED);
    expect(output(runLanding(ran, since, tenantId, none, touched)!.document, 'b')?.text).toBe('B by the run');
  });

  it('takes a failed step’s evidence for no change of what lies after it: no reader is given it', () => {
    // a → c, b on its own; the run covered a and b. a failed with half an answer; b is done; c holds a hand-in.
    const edges = [wire('a', 'c')];
    const ran: GraphRunSnapshot = { ...run(canvas({}, edges), ['a', 'b'], { a: 'failed' }),
      nodes: [{ nodeId: 'a', state: 'failed', output: 'Half an answer', sessionId: 'session-a' }, { nodeId: 'b', state: 'done', output: 'B by the run', sessionId: 'session-b' }] };
    const during = canvas({ c: byHand('C by hand', ENDED - 5_000) }, edges);
    const landing = runLanding(ran, during, tenantId, none, none);
    expect(output(landing!.document, 'b')?.text).toBe('B by the run');
    expect(output(landing!.document, 'c')?.text).toBe('C by hand');
    expect(landing?.ops.some(op => op.path[1] === 'c')).toBe(false);
  });

  it('counts nothing missing on a finished collaboration whose proposals the canvas shows partial, as the run left them', () => {
    const collaboration = { goal: 'Ship', rounds: 1, synthesizerNodeId: 'b', maxModelCalls: 5, phase: 'synthesis' as const, round: 1, turns: [] };
    const done: GraphRunSnapshot = { ...run(canvas(), ['a', 'b']), status: 'completed', collaboration,
      nodes: [{ nodeId: 'a', state: 'done', output: 'A proposal' }, { nodeId: 'b', state: 'done', output: 'Final', partial: false }] };
    const landed = canvas({ a: { text: 'A proposal', at: ENDED - 20_000, source: 'run', partial: true }, b: { text: 'Final', at: ENDED - 10_000, source: 'run' } });
    expect(missingResults(done, landed, tenantId, none)).toBe(false);
  });

  it('a collaboration’s final result where the canvas shows the same text as a proposal still partial', () => {
    const collaboration = { goal: 'Ship', rounds: 1, synthesizerNodeId: 'b', maxModelCalls: 5, phase: 'synthesis' as const, round: 1, turns: [] };
    const done: GraphRunSnapshot = { ...run(canvas(), ['a', 'b']), status: 'completed', collaboration,
      nodes: [{ nodeId: 'a', state: 'done', output: 'A proposal' }, { nodeId: 'b', state: 'done', output: 'Final', partial: false }] };
    const proposals = canvas({ a: { text: 'A proposal', at: ENDED - 20_000, source: 'run', partial: true }, b: { text: 'Final', at: ENDED - 10_000, source: 'run', partial: true } });
    expect(missingResults(done, proposals, tenantId, none)).toBe(true);
    const landing = runLanding(done, proposals, tenantId, none, none);
    expect(output(landing!.document, 'b')).toMatchObject({ text: 'Final', source: 'run' });
    expect(output(landing!.document, 'b')?.partial).toBeFalsy();
  });

  it('keeps a result published since the run ended on a step it left without output, and what lies downstream of it', () => {
    // b failed in the run (no output); someone published one by hand since; c, downstream of b, has a result too.
    const edges = [wire('b', 'c')];
    const now = canvas({ b: byHand('B by hand', ENDED + 5_000), c: byHand('C by hand', ENDED + 6_000) }, edges);
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: byHand('B by hand', 0) }], ENDED + 5_000),
      change([{ op: 'set', path: ['nodes', 'c', 'lastOutput'], value: byHand('C by hand', 0) }], ENDED + 6_000, 5)], ENDED);
    const landing = runLanding(run(canvas({}, edges), ['a', 'b'], { b: 'failed' }), now, tenantId, none, touched);
    expect(landing?.whole).toBe(false);
    expect(landing?.journal.scope).toEqual(['a']);
    expect(output(landing!.document, 'a')?.text).toBe('A by the run');
    expect(output(landing!.document, 'b')?.text).toBe('B by hand');
    expect(output(landing!.document, 'c')?.text).toBe('C by hand');
    expect(landing?.ops.some(op => op.path[1] === 'b' || op.path[1] === 'c')).toBe(false);
  });

  it('keeps a result the log says came after the run ended, whatever its writer’s clock stamped on it', () => {
    // The publisher's clock runs behind: its result reads older than the run's end, but the server took it after.
    const now = canvas({ b: byHand('B by hand', ENDED - 30_000) });
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: byHand('B by hand', ENDED - 30_000) }], ENDED + 2_000)], ENDED);
    const landing = runLanding(run(canvas(), ['a', 'b']), now, tenantId, none, touched);
    expect(output(landing!.document, 'b')?.text).toBe('B by hand');
    expect(landing?.journal.scope).toEqual(['a']);
  });

  it('leaves the run whole where landing it would change a result published since it ended, anywhere on the canvas', () => {
    // a shows a partial its starter's page published while it ran; the run's own result replaces it, which makes c,
    // downstream of a and published by hand since, stale: c would go, so nothing lands.
    const edges = [wire('a', 'c')];
    const now = canvas({ a: { text: 'Partial', at: ENDED - 10_000, source: 'run', partial: true }, c: byHand('C by hand', ENDED + 3_000) }, edges);
    const touched = resultsTouchedAfter([change([{ op: 'set', path: ['nodes', 'c', 'lastOutput'], value: byHand('C by hand', 0) }], ENDED + 3_000)], ENDED);
    expect(runLanding(run(canvas({}, edges), ['a']), now, tenantId, none, touched)).toBeNull();
    // With nothing published since, the same landing goes, and c goes with it, as the run's own page would have had it.
    const landed = runLanding(run(canvas({}, edges), ['a']), now, tenantId, none, none);
    expect(output(landed!.document, 'a')?.text).toBe('A by the run');
    expect(output(landed!.document, 'c')).toBeNull();
  });

  it('keeps the nodes a newer run holds and lands the rest, but a collaboration only whole', () => {
    const taken = runLanding(run(canvas(), ['a', 'b']), canvas({ b: { text: 'B again', at: NOW - 20_000, source: 'run' } }), tenantId, new Set(['b']), none);
    expect(taken?.journal.scope).toEqual(['a']);
    expect(output(taken!.document, 'b')?.text).toBe('B again');
    const collaboration = { ...run(canvas(), ['a', 'b']), status: 'completed' as const, collaboration: { goal: 'Ship', rounds: 1, synthesizerNodeId: 'b',
      maxModelCalls: 5, phase: 'synthesis' as const, round: 1, turns: [] } };
    expect(runLanding(collaboration, canvas(), tenantId, new Set(['b']), none)).toBeNull();
  });

  it('only on a page holding what it was decided on: no unsent edit of its inputs, nor of a result it writes', () => {
    const decided = canvas();
    const landing = runLanding(run(canvas(), ['a']), decided, tenantId, none, none)!;
    expect(workingHoldsLanding(decided, decided, landing)).toBe(true);
    const renamed = sanitizeDocument({ ...decided, nodes: decided.nodes.map(node => node.id === 'a' ? { ...node, title: 'Renamed here' } : node) });
    expect(workingHoldsLanding(renamed, decided, landing)).toBe(false);
    expect(workingHoldsLanding(canvas({ a: byHand('A by hand here', NOW) }), decided, landing)).toBe(false);
    // An edit elsewhere is no matter.
    expect(workingHoldsLanding(sanitizeDocument({ ...decided, nodes: decided.nodes.map(node => node.id === 'c' ? { ...node, x: 9999 } : node) }), decided, landing)).toBe(true);
  });
});
