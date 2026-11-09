// A page made from words an Agent invited to the canvas wrote is held as one it hands in is (agentPages.ts, the owner's
// choice of 2026-11-08): an assemble node copies its template and its inputs into its page as they are, a form hands on
// its fields' labels and values, an image, video, 3D or edit node's file listing names its title, and a session follows
// its persona. The server keeps the fingerprints of what an Agent wrote on each node, and of each result held for an
// Agent's words (agentWritten, canvas_agent_words.go); the page reads the same rules from the same field, and both run
// backend/internal/app/testdata/agent_words_vectors.json. The views that run a page hold such a page still until its
// reader runs it, then run it under the policy that loads no pictures or media by URL but from the CDNs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  AgentPagesContext, agentPageHolds, agentRunHolds, agentTextHash, byCodePoint, keepAgentWritten, keepCurrentAgentWritten, recordAgentPages,
  sameAgentInputs, type AgentPageHold,
} from '../src/canvas/agentPages';
import { ArtifactPreview } from '../src/canvas/ArtifactPreview';
import { CanvasResults } from '../src/canvas/CanvasResults';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CardPreview } from '../src/canvas/CardPreview';
import {
  createAssembleNode, createFormNode, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeAgentWritten, sanitizeDocument, saveDocument,
  type AgentWrittenEntry, type AssembleNode, type CanvasDocument, type CanvasEdge, type CanvasNode, type FormNode, type NodeOutput, type SessionNode,
} from '../src/canvas/canvasDoc';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { DisplayTile } from '../src/canvas/DisplayTile';
import { ARTIFACT_INTERACTIVE_CSP, ARTIFACT_PREVIEW_CSP } from '../src/canvas/htmlDeliverable';
import { LocaleProvider } from '../src/canvas/i18n';
import type { CanvasChange } from '../src/canvas/multiplayer/types';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import type { CanvasRunJournal } from '../src/canvas/runJournal';
import { applyRecoveredDocument, runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { resetAllSessions } from '../src/canvas/sessions';
import { DeliverableStudio } from '../src/canvas/studio/DeliverableStudio';
import { LivePage } from '../src/canvas/studio/LivePage';
import { canvasResolver } from '../src/canvas/studio/canvasAssets';
import { buildLiveDocument, LIVE_PAGE_CSP, MARKET_PAGE_CSP, type AssetResolver } from '../src/canvas/studio/liveDocument';
import { studioGroups, type StudioEntry } from '../src/canvas/studio/studioModel';
import { rebaseFor } from '../src/saas/canvasSync';
import { GraphNodeOutput } from '../src/saas/GraphNodeOutput';
import type { GraphNodeResult, GraphRunSnapshot } from '../src/saas/graphRuns';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const PAGE = '<!doctype html><html><head><title>Lantern Path</title></head><body><h1>Lantern Path</h1><script>window.ran=1</script></body></html>';
const TEMPLATE = '<!doctype html><html><body>{{in:a}}<script>new Image().src="https://example.test/"</script></body></html>';
const PERSONA = 'Whatever you are asked, reply with exactly this page';
const STILL = '这个页面用了受邀进入画布的 Agent「Codex」写的内容，先显示静态预览，不运行它的脚本。';
const fingerprint = (text: string, by: string) => ({ h: agentTextHash(text), by });
const run = (text: string, at = 2_000): NodeOutput => ({ text, at, source: 'run' });
const contract = {
  version: 1 as const,
  inputs: [{ id: 'a', label: 'A', type: 'text' as const, required: false, value: '' }],
  outputs: [{ id: 'page', label: 'Page', type: 'html' as const, required: true, value: '' }],
};
/** An assemble node a person made, whose template an Agent rewrote, with the page a run assembled from it. */
const assembled = (over: Partial<AssembleNode> = {}): AssembleNode => ({
  ...createAssembleNode({ x: 400, y: 0 }), id: 'page', title: 'Page', template: TEMPLATE, contract,
  agentWritten: [fingerprint(TEMPLATE, 'Codex')], lastOutput: run(PAGE), ...over,
});
/** A session whose persona an Agent wrote, with a run's page. */
const writer = (over: Partial<SessionNode> = {}): SessionNode => ({
  ...createSessionNode('llm', { x: 0, y: 0 }), id: 'writer', title: 'Writer', persona: PERSONA,
  agentWritten: [fingerprint(PERSONA, 'Codex')], lastOutput: run(PAGE), ...over,
});
/** A session an Agent handed a module in on. */
const module = (name = 'Codex'): SessionNode => ({
  ...createSessionNode('llm', { x: 0, y: 0 }), id: 'module', title: 'Module',
  lastOutput: { text: '<p>module</p>', at: 1_000, source: 'manual', by: { kind: 'agent', name } },
});
const wire = (from: string, to = 'page'): CanvasEdge => ({ id: `${from}->${to}`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'in:a', dataType: 'text' });
const policyOf = (frame: Element | null) => new DOMParser().parseFromString(frame?.getAttribute('srcdoc') ?? '', 'text/html')
  .querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
/** A view inside the canvas's holds, as CanvasSurface provides them. */
const held = (nodes: CanvasNode[], edges: CanvasEdge[], children: ReactNode) =>
  <AgentPagesContext.Provider value={agentPageHolds(nodes, edges)}>{children}</AgentPagesContext.Provider>;

describe('the cases the API runs too', () => {
  type Vectors = {
    hashes: { text: string; h: string }[];
    holds: { name: string; document: unknown; holds: Record<string, AgentPageHold> }[];
    record: { name: string; before: unknown; after: unknown; agentWritten: Record<string, { h: string; by: string }[]> }[];
  };
  const vectors = JSON.parse(readFileSync(resolve(process.cwd(), '../../backend/internal/app/testdata/agent_words_vectors.json'), 'utf8')) as Vectors;

  it('fingerprints a text as the server does', () => {
    expect(vectors.hashes.length).toBeGreaterThanOrEqual(5);
    for (const { text, h } of vectors.hashes) expect(agentTextHash(text)).toBe(h);
  });

  it.each(vectors.holds.map(c => [c.name, c] as const))('holds: %s', (_name, c) => {
    const doc = sanitizeDocument(c.document);
    expect(doc.edges).toHaveLength((c.document as { edges: unknown[] }).edges.length);
    expect(Object.fromEntries(agentPageHolds(doc.nodes, doc.edges))).toEqual(c.holds);
  });

  it.each(vectors.record.map(c => [c.name, c] as const))('fingerprints: %s', (_name, c) => {
    const after = recordAgentPages(sanitizeDocument(c.before), sanitizeDocument(c.after));
    for (const node of after.nodes) expect(node.agentWritten).toEqual(c.agentWritten[node.id]);
  });
});

describe('the holds of a large canvas', () => {
  it('are found along each wire once, whatever the order of the nodes, each carrying the first names', () => {
    // A form handing on a thousand Agents' names into the head of a chain of two thousand assemble nodes, listed against
    // the chain's order (canvas_agent_words_test.go TestAgentHoldsAreFoundInLinearTime).
    const agents = Array.from({ length: 1_000 }, (_, i) => `Agent ${String(1_000 - i).padStart(4, '0')}`);
    const form: FormNode = { ...createFormNode({ x: 0, y: 0 }), id: 'f', title: '', fields: [{ id: 'q', label: 'Name', value: '' }],
      agentWritten: agents.map(name => ({ h: agentTextHash('Name'), by: name })) };
    const id = (i: number) => `a${String(i).padStart(4, '0')}`;
    const links = Array.from({ length: 2_000 }, (_, k) => 1_999 - k).map(i => assembled({ id: id(i), title: '', template: '<p>{{in:a}}</p>',
      agentWritten: undefined, lastOutput: run(`<p>${i}</p>`) }));
    const edges = [{ fromNode: 'f', toNode: id(0) }, ...Array.from({ length: 1_999 }, (_, i) => ({ fromNode: id(i), toNode: id(i + 1) }))];
    const started = performance.now();
    const holds = agentPageHolds([form, ...links], edges);
    expect(performance.now() - started).toBeLessThan(10_000);
    const first = agents.slice(-8).reverse();
    for (const at of [0, 1_000, 1_999]) expect(holds.get(id(at))?.names).toEqual(first);
    expect(holds.size).toBe(2_000);
  });

  it('sort names as the server does, by code point', () => {
    expect(['🦀 crab', 'Ａgent', 'Agent'].sort(byCodePoint)).toEqual(['Agent', 'Ａgent', '🦀 crab']);
    expect(['ab', 'a', ''].sort(byCodePoint)).toEqual(['', 'a', 'ab']);
  });
});

describe('the fingerprints a node keeps', () => {
  it('are read as the server writes them, on every kind of node', () => {
    const entries = [{ h: agentTextHash('a'), by: '  Codex  ' }, { h: agentTextHash('a'), by: 'Codex' }, { h: 'not a fingerprint', by: 'x' },
      { h: agentTextHash('b') }, 'junk', { h: agentTextHash('c'), by: '码'.repeat(80) }];
    expect(sanitizeAgentWritten(entries)).toEqual([{ h: agentTextHash('a'), by: 'Codex' }, { h: agentTextHash('b'), by: '' },
      { h: agentTextHash('c'), by: '码'.repeat(60) }]);
    expect(sanitizeAgentWritten([])).toBeUndefined();
    expect(sanitizeAgentWritten('x')).toBeUndefined();
    // None is cut: a node keeps one of every text it holds, a form's hundreds of fields included.
    expect(sanitizeAgentWritten(Array.from({ length: 1_200 }, (_, i) => ({ h: agentTextHash(String(i)), by: 'Codex' })))).toHaveLength(1_200);
    const kept = [{ h: agentTextHash('a'), by: 'Codex' }];
    const doc = sanitizeDocument({ nodes: [
      { ...writer(), agentWritten: kept }, { ...assembled(), agentWritten: kept }, { ...createFormNode({ x: 0, y: 0 }), id: 'form', agentWritten: kept },
      { id: 'cut', kind: 'edit', title: 'Cut', timeline: '', x: 0, y: 0, w: 300, h: 200, agentWritten: kept },
    ], edges: [] });
    expect(doc.nodes.map(node => node.agentWritten)).toEqual([kept, kept, kept, kept]);
  });

  it('are never taken away by a step back, a page’s own edit or a change carried onto the page', () => {
    const live: CanvasDocument = { ...emptyDocument(), nodes: [writer()] };
    const step: CanvasDocument = { ...emptyDocument(), nodes: [{ ...writer(), persona: 'My own words', agentWritten: undefined }] };
    const restored = keepAgentWritten(live, step);
    expect(restored.nodes[0].agentWritten).toEqual(writer().agentWritten);
    expect(keepAgentWritten(live, live)).toBe(live);
  });

  it('keep, within bounds, an earlier conversation’s result its panel still shows', () => {
    const earlier = run(PAGE, 1_500);
    const node = writer({ lastOutput: null, threads: [{ id: 'default', title: 'Session 1', issueId: null, preview: '', draft: '', createdAt: 1, lastOutput: earlier }] });
    const stale = Array.from({ length: 40 }, (_, i) => fingerprint(`title ${i}`, 'Codex'));
    const from = { nodes: [{ ...node, agentWritten: [fingerprint(PAGE, 'Codex'), ...stale] }] };
    const kept = keepAgentWritten(from, { ...emptyDocument(), nodes: [{ ...node, agentWritten: undefined }] }).nodes[0].agentWritten!;
    expect(kept).toContainEqual(fingerprint(PAGE, 'Codex'));
    expect(kept.filter(entry => entry.h !== agentTextHash(PAGE) && entry.h !== agentTextHash(PERSONA))).toEqual(stale.slice(-16));
  });

  it('keep, within bounds, a persona waiting in another conversation, and fingerprint a held result as it is replaced', () => {
    const waiting = writer({ persona: 'The owner’s persona', threads: [
      { id: 'a', title: 'Session 1', issueId: null, preview: '', draft: '', createdAt: 1, persona: PERSONA },
      { id: 'default', title: 'Session 2', issueId: null, preview: '', draft: '', createdAt: 2, persona: 'The owner’s persona' }] });
    const stale = Array.from({ length: 40 }, (_, i) => fingerprint(`title ${i}`, 'Codex'));
    const kept = keepAgentWritten({ nodes: [{ ...waiting, agentWritten: [fingerprint(PERSONA, 'Codex'), ...stale] }] },
      { ...emptyDocument(), nodes: [{ ...waiting, agentWritten: undefined }] }).nodes[0].agentWritten!;
    expect(kept).toContainEqual(fingerprint(PERSONA, 'Codex'));
    // A hand-in older than the fingerprints, replaced by a run, is fingerprinted as it goes.
    const before: CanvasDocument = { ...emptyDocument(), nodes: [module()] };
    const replaced = { ...before, nodes: [{ ...module(), lastOutput: run('<p>a run</p>') }] };
    expect(recordAgentPages(before, replaced).nodes[0].agentWritten).toEqual([fingerprint('<p>module</p>', 'Codex')]);
  });

  it('keep the first names one fingerprint was kept under, as the server does', () => {
    const names = Array.from({ length: 20 }, (_, i) => fingerprint(PERSONA, `name ${i}`));
    const kept = keepAgentWritten({ nodes: [{ ...writer(), agentWritten: names }] },
      { ...emptyDocument(), nodes: [{ ...writer(), agentWritten: undefined }] }).nodes[0].agentWritten!;
    expect(kept).toEqual(names.slice(0, 8));
    // The page keeps a node's fingerprints as they are when none goes (no copy each time it reads them).
    const same = { ...emptyDocument(), nodes: [writer()] };
    expect(keepAgentWritten({ nodes: [...same.nodes] }, same)).toBe(same);
  });

  it('keep their own of a value an undo brought back while the save that cleared it was out', () => {
    const value = 'Lantern Path';
    const stale = Array.from({ length: 16 }, (_, i) => fingerprint(`title ${i}`, 'Codex'));
    const form = (text: string, agentWritten: AgentWrittenEntry[]): FormNode => ({ ...createFormNode({ x: 0, y: 0 }), id: 'form',
      fields: [{ id: 'f1', label: 'Name', value: text }], agentWritten });
    const own = [fingerprint(value, 'Codex'), ...stale];
    const before = { ...emptyDocument(), nodes: [form(value, own)] };
    // The page cleared the value and sent its fingerprints with it; the server, holding the value no more, let the oldest
    // fingerprint go as stale (canvas_agent_words.go pruneAgentWritten) and answered with what it kept.
    const sent = [{ op: 'set' as const, path: ['nodes', 'form', 'fields', 'f1', 'value'], value: '' },
      { op: 'set' as const, path: ['nodes', 'form', 'agentWritten'], value: own }];
    const change: CanvasChange = { version: 2, actor: { kind: 'human', clientId: 'page-1', name: 'Owner' }, label: '', at: '',
      ops: [sent[0], { op: 'set', path: ['nodes', 'form', 'agentWritten'], value: stale }] } as unknown as CanvasChange;
    const after = { ...before, nodes: [form('', stale)] };
    // Before the answer came, an undo brought the value back.
    const working = sanitizeDocument({ ...before, nodes: [form(value, own)] });
    const moved = rebaseFor({ before, after, changes: [change], sent, own: () => true }).working(working);
    expect(moved.nodes[0]).toMatchObject({ fields: [{ value }] });
    expect(moved.nodes[0].agentWritten).toContainEqual(fingerprint(value, 'Codex'));
    // One of a text the node no longer holds does not come back.
    const cleared = sanitizeDocument({ ...before, nodes: [form('', own)] });
    expect(keepCurrentAgentWritten(cleared, { ...after, nodes: [form('', stale)] }).nodes[0].agentWritten).toEqual(stale);
  });

  it('are worked out again only when what they are read from changes, not when a node moves', () => {
    const doc: CanvasDocument = { ...emptyDocument(), nodes: [module(), assembled({ template: '<p>{{in:a}}</p>', agentWritten: undefined })], edges: [wire('module')] };
    const moved = { ...doc, nodes: doc.nodes.map(node => ({ ...node, x: node.x + 40 })) };
    expect(sameAgentInputs(doc, moved)).toBe(true);
    expect(recordAgentPages(doc, moved)).toBe(moved);
    expect(sameAgentInputs(doc, { ...doc, edges: [] })).toBe(false);
    // The same number of wires, one led from another node: what reaches the page changed.
    expect(sameAgentInputs(doc, { ...doc, edges: [{ ...wire('module'), fromNode: 'elsewhere' }] })).toBe(false);
    expect(sameAgentInputs(doc, { ...doc, nodes: doc.nodes.map(node => node.id === 'page' ? { ...node, lastOutput: run('<p>new</p>') } : node) })).toBe(false);
  });

  it('take a run’s page fingerprinted on this page as it lands, as the server does, and never a person’s own', () => {
    const before: CanvasDocument = { ...emptyDocument(), nodes: [module(), { ...assembled({ template: '<p>{{in:a}}</p>', agentWritten: undefined }), lastOutput: null }], edges: [wire('module')] };
    const landed = { ...before, nodes: before.nodes.map(node => node.id === 'page' ? { ...node, lastOutput: run(PAGE) } : node) };
    expect(recordAgentPages(before, landed).nodes.find(node => node.id === 'page')?.agentWritten).toEqual([fingerprint(PAGE, 'Codex')]);
    const published = { ...before, nodes: before.nodes.map(node => node.id === 'page' ? { ...node, lastOutput: { text: PAGE, at: 3_000, source: 'manual' as const } } : node) };
    expect(recordAgentPages(before, published).nodes.find(node => node.id === 'page')?.agentWritten).toBeUndefined();
  });

  it('take a run’s page fingerprinted as the run’s results land on the page', () => {
    const doc: CanvasDocument = { ...emptyDocument(), nodes: [module(), { ...assembled({ template: '<p>{{in:a}}</p>', agentWritten: undefined }), lastOutput: null }], edges: [wire('module')] };
    const journal: CanvasRunJournal = { version: 1, id: 'run-journal-1', startedAt: 3_000, scope: ['page'], nodes: {
      page: { nodeId: 'page', threadId: 'form', companyId: 'tenant-a', agentId: null, issueId: null, runId: 'run-1', state: 'done', output: PAGE } } };
    const landed = applyRecoveredDocument(doc, { ...journal, inputFingerprint: runInputFingerprint(doc, journal.scope) });
    expect(landed.nodes.find(node => node.id === 'page')).toMatchObject({ lastOutput: { text: PAGE, source: 'run' }, agentWritten: [fingerprint(PAGE, 'Codex')] });
  });

  it('come onto the page from its own change’s answer, which the page never carries', () => {
    const before = { ...emptyDocument(), nodes: [module(), { ...assembled({ template: '<p>{{in:a}}</p>', agentWritten: undefined }), lastOutput: null }], edges: [wire('module')] };
    const result = run(PAGE);
    const sent = [{ op: 'set' as const, path: ['nodes', 'page', 'lastOutput'], value: result }];
    // The server fingerprints the page it took (canvas_agent_words.go recordAgentPages) in the same change.
    const recorded = [fingerprint(PAGE, 'Codex')];
    const change: CanvasChange = { version: 2, actor: { kind: 'human', clientId: 'page-1', name: 'Owner' }, label: '', at: '',
      ops: [...sent, { op: 'set', path: ['nodes', 'page', 'agentWritten'], value: recorded }] } as unknown as CanvasChange;
    const after = { ...before, nodes: before.nodes.map(node => node.id === 'page' ? { ...node, lastOutput: result, agentWritten: recorded } : node) };
    const working = sanitizeDocument({ ...before, nodes: before.nodes.map(node => node.id === 'page' ? { ...node, lastOutput: result } : node) });
    const moved = rebaseFor({ before, after, changes: [change], sent, own: () => true }).working(working);
    expect(moved.nodes.find(node => node.id === 'page')?.agentWritten).toEqual(recorded);
  });
});

describe('a page made from an Agent’s words', () => {
  it('shows still until its reader runs it, then says pictures by URL stay off', async () => {
    render(<LivePage html={PAGE} title="页面" agentWords={['Codex']} />);
    const still = await screen.findByTitle(/页面/);
    expect(still.getAttribute('sandbox')).toBe('');
    expect(policyOf(still)).toBe(ARTIFACT_PREVIEW_CSP);
    expect(still.getAttribute('srcdoc')).not.toContain('window.ran=1');
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(screen.queryByTitle(/页面/))).toBe(MARKET_PAGE_CSP));
    expect(await screen.findByText('这个页面用了受邀进入画布的 Agent「Codex」写的内容，预览不加载其他网站的图片和音视频。')).toBeVisible();
  });

  it('names every Agent whose words it holds, an unnamed one as invited, and says so in English', async () => {
    const { rerender } = render(<LivePage html={PAGE} title="页面" agentWords={['Claude Code', 'Codex']} />);
    expect(await screen.findByText(/^这个页面用了受邀进入画布的 Agent（「Claude Code」、「Codex」）写的内容，/)).toBeVisible();
    rerender(<LivePage html={PAGE} title="页面" agentWords={['', String.fromCodePoint(0x202e)]} />);
    expect(await screen.findByText(/^这个页面用了受邀进入画布的 Agent 写的内容，/)).toBeVisible();
    rerender(<LocaleProvider locale="en"><LivePage html={PAGE} title="Page" agentWords={['Codex']} /></LocaleProvider>);
    expect(await screen.findByText(/^This page is made from words “Codex”, an Agent invited to this canvas, wrote, so it shows still/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run page' })).toBeVisible();
  });

  it('says an Agent’s name as it is, whatever characters it has', () => {
    render(<ArtifactPreview type="html" source={PAGE} title="Page" renderMarkdown={text => text} agentWords={['$& $\'']} />);
    expect(screen.getByText(/^这个页面用了受邀进入画布的 Agent「\$& \$'」写的内容，/)).toBeVisible();
  });
});

describe('in every view that runs a page', () => {
  it('is held in the deliverables panel, which says so, and runs on its reader’s word', async () => {
    const node = assembled();
    render(held([node], [], <NodeDeliverables node={node} readOnly />));
    const frame = () => screen.getByTitle('Page · HTML 预览');
    expect(frame()).toHaveAttribute('sandbox', '');
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    expect(screen.getByText('用了受邀 Agent 写的内容')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(frame()).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock'));
    expect(policyOf(frame())).toBe(ARTIFACT_INTERACTIVE_CSP);
  });

  it('runs at once once a person rewrote the template, and on a canvas of people only', () => {
    for (const node of [assembled({ template: '<main>{{in:a}}</main>' }), assembled({ agentWritten: undefined })]) {
      render(held([node], [], <NodeDeliverables node={node} readOnly />));
      expect(screen.getByTitle('Page · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
      expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
      expect(screen.queryByText('用了受邀 Agent 写的内容')).toBeNull();
      cleanup();
    }
  });

  it('holds an earlier Session’s result the node’s fingerprints name', () => {
    const earlier = run(PAGE, 1_500);
    const node = writer({ lastOutput: null, threads: [{ id: 'default', title: 'Session 1', issueId: null, preview: '', draft: '', createdAt: 1, lastOutput: earlier }],
      agentWritten: [fingerprint(PERSONA, 'Codex'), fingerprint(PAGE, 'Codex')] });
    render(held([node], [], <NodeDeliverables node={node} readOnly />));
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
  });

  it('only shows still on an enlarged card', async () => {
    const node = writer();
    const card = render(held([node], [], <CardPreview node={node} running={false} />));
    await waitFor(() => expect(policyOf(card.container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
    cleanup();
    const other = writer({ agentRef: { source: 'workspace', agentId: 'agent-1' } });
    const own = render(held([other], [], <CardPreview node={other} running={false} />));
    await waitFor(() => expect(policyOf(own.container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
  });

  it('is held in the results studio, the page fed by a hand-in too, after its wire is gone', async () => {
    const nodes = [module(), assembled({ template: '<p>{{in:a}}</p>', agentWritten: undefined })];
    const { container } = render(<DeliverableStudio nodes={nodes} edges={[wire('module')]} nodeId="page" title="Results" variant="embedded" />);
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
    cleanup();
    // The wire went after the page was made: the page's own fingerprint keeps it held.
    const recorded = recordAgentPages({ ...emptyDocument(), nodes, edges: [wire('module')] }, { ...emptyDocument(), nodes, edges: [] });
    const after = render(<DeliverableStudio nodes={recorded.nodes} edges={[]} nodeId="page" title="Results" variant="embedded" />);
    await waitFor(() => expect(policyOf(after.container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
  });

  it('is held in a preview display', async () => {
    const nodes = [writer()];
    const groups = studioGroups({ nodes, edges: [] });
    const { container } = render(held(nodes, [], <DisplayTile display={{ id: 'dp-1', kind: 'display', x: 900, y: 0, w: 640, h: 480, title: '', source: { type: 'node', nodeId: 'writer' } }}
      groups={groups} choices={[{ id: 'writer', title: 'Writer' }]} canvasEntries={groups.flatMap(group => group.entries)} running={new Set()} scale={1} />));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
  });

  it('is held as the canvas’s result in the 成果 view', async () => {
    const nodes = [assembled()];
    render(held(nodes, [], <CanvasResults nodes={nodes} edges={[]} runs={{}} running={false} readOnly onOpenNode={vi.fn()} onBack={vi.fn()} />));
    const result = screen.getByRole('region', { name: '画布成果' });
    expect(within(result).getByTitle('Page · HTML 预览')).toHaveAttribute('sandbox', '');
    expect(within(result).getByText(new RegExp(STILL))).toBeVisible();
  });

  it('is held in a run’s record by the canvas the run ran', () => {
    // An assemble node's page in the canvas it ran from, and a session's page its persona asked for.
    const pageContract = { version: 1 as const, inputs: [], outputs: [{ id: 'page', label: 'Page', type: 'html' as const, required: true, value: '' }] };
    const document = sanitizeDocument({ ...emptyDocument(), nodes: [assembled({ lastOutput: null }), writer({ lastOutput: null, contract: pageContract })] });
    expect(Object.fromEntries(agentRunHolds(document.nodes, document.edges, new Set(['page', 'writer'])))).toEqual({
      page: { handedIn: false, names: ['Codex'] }, writer: { handedIn: false, names: ['Codex'] } });
    expect(agentPageHolds(document.nodes, document.edges).size).toBe(0);
    const graph = { id: 'g1', status: 'completed', document, nodes: [{ nodeId: 'writer', state: 'done' }] } as unknown as GraphRunSnapshot;
    localStorage.setItem('superclaw_locale', 'zh');
    const { container } = render(<SaaSPreferencesProvider><GraphNodeOutput graph={graph}
      node={{ nodeId: 'writer', state: 'done', output: JSON.stringify({ page: PAGE }), partial: false } as unknown as GraphNodeResult} /></SaaSPreferencesProvider>);
    expect(container.querySelector('iframe')).toHaveAttribute('sandbox', '');
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
  });
});

describe('a run’s record', () => {
  it('holds a result the run made anew by what made it, never by a hand-in its node had before', () => {
    const handedIn = writer({ persona: 'The owner’s persona', agentWritten: undefined,
      lastOutput: { text: PAGE, at: 1_000, source: 'manual', by: { kind: 'agent', name: 'Codex' } } });
    const document = sanitizeDocument({ ...emptyDocument(), nodes: [handedIn] });
    expect(agentRunHolds(document.nodes, document.edges, new Set(['writer'])).size).toBe(0);
    // Reused as it was (a cached step), the hand-in is what the run shows, and is held.
    expect(agentRunHolds(document.nodes, document.edges, new Set()).get('writer')).toEqual({ handedIn: true, names: ['Codex'] });
    const fresh = { nodeId: 'writer', state: 'done', output: '<!doctype html><html><body><p>My own page</p></body></html>', partial: false };
    const graph = { id: 'g2', status: 'completed', document, nodes: [fresh] } as unknown as GraphRunSnapshot;
    localStorage.setItem('superclaw_locale', 'zh');
    render(<SaaSPreferencesProvider><GraphNodeOutput graph={graph} node={fresh as unknown as GraphNodeResult} /></SaaSPreferencesProvider>);
    expect(screen.queryByText(/Codex/)).toBeNull();
  });
});

describe('a file a held result stored', () => {
  const helper = new TextEncoder().encode('window.helperRan = 1');
  const page = '<!doctype html><html><head><title>Mine</title></head><body><script src="helper.js"></script></body></html>';

  it('reaches only a page held itself', async () => {
    const resolve: AssetResolver = async path => path.endsWith('helper.js') ? { bytes: helper, name: 'helper.js', held: true } : null;
    expect(await buildLiveDocument(page, { resolve })).not.toContain('helperRan');
    expect(await buildLiveDocument(page, { resolve, market: true })).toContain('helperRan');
    const own: AssetResolver = async path => path.endsWith('helper.js') ? { bytes: helper, name: 'helper.js' } : null;
    expect(await buildLiveDocument(page, { resolve: own })).toContain('helperRan');
  });

  it('is said to be held by the canvas’s files where its node’s result is', async () => {
    const entry = (nodeId: string): StudioEntry => ({ id: `${nodeId}:helper`, nodeId, nodeTitle: nodeId, folder: [], name: 'helper.js',
      label: 'helper.js', kind: 'code', source: { type: 'member', parentId: nodeId, archive: 'site.zip', path: 'helper.js', bytes: helper }, state: 'run' });
    expect(await canvasResolver([entry('page')], undefined, id => id === 'page')('helper.js')).toMatchObject({ held: true });
    expect(await canvasResolver([entry('mine')], undefined, id => id === 'page')('helper.js')).toMatchObject({ held: false });
    expect(await canvasResolver([{ ...entry('mine'), handedInBy: 'Codex' }])('helper.js')).toMatchObject({ held: true });
  });

  it('never runs in a page of the canvas that is not held', async () => {
    // A person's page in the panel names a script an assemble node stored from a template an Agent rewrote.
    const scripts = assembled({ id: 'scripts', title: 'Scripts' });
    const person = assembled({ id: 'mine', title: 'Mine', agentWritten: undefined, template: '<main>{{in:a}}</main>', lastOutput: run(page) });
    const files: StudioEntry[] = [{ id: 'scripts:helper', nodeId: 'scripts', nodeTitle: 'Scripts', folder: [], name: 'helper.js', label: 'helper.js',
      kind: 'code', source: { type: 'member', parentId: 'scripts', archive: 'site.zip', path: 'helper.js', bytes: helper }, state: 'run' }];
    const srcdoc = () => document.querySelector('.awwo-artifact-live iframe')?.getAttribute('srcdoc') ?? '';
    render(held([scripts, person], [], <NodeDeliverables node={person} readOnly canvasEntries={files} />));
    await waitFor(() => expect(srcdoc()).toMatch(/<body/i));
    expect(srcdoc()).not.toContain('helperRan');
    cleanup();
    // On a canvas of people only, the same file is the page's to run.
    render(held([{ ...scripts, agentWritten: undefined }, person], [], <NodeDeliverables node={person} readOnly canvasEntries={files} />));
    await waitFor(() => expect(srcdoc()).toContain('helperRan'));
  });
});

describe('the canvas', () => {
  beforeEach(() => {
    resetAllSessions();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
  });

  it('holds the page an Agent’s template made in its 成果 view', async () => {
    saveDocument({ ...emptyDocument(), nodes: [assembled()], view: { x: 0, y: 0, scale: 1 } });
    render(<CanvasSurface results={{ initialView: 'results' }} planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    const region = screen.getByRole('region', { name: '画布成果' });
    expect(await within(region).findByText(new RegExp(STILL))).toBeVisible();
    expect(region.querySelector('iframe')).toHaveAttribute('sandbox', '');
    expect(loadDocumentWithStatus().doc.nodes[0].agentWritten).toEqual([fingerprint(TEMPLATE, 'Codex')]);
  });

  it('fingerprints the page a hand-in fed as an edit commits, as the server does, and an undo keeps it', async () => {
    const nodes = [module(), assembled({ template: '<p>{{in:a}}</p>', agentWritten: undefined, x: 600 })];
    saveDocument({ ...emptyDocument(), nodes, edges: [wire('module')], view: { x: 0, y: 0, scale: 1 } });
    render(<CanvasSurface planRequest={vi.fn<typeof requestCanvasPlan>()} />);
    const page = () => loadDocumentWithStatus().doc.nodes.find(node => node.id === 'page');
    expect(page()?.agentWritten).toBeUndefined();
    const tile = screen.getByTestId('canvas-tile-module');
    fireEvent.pointerDown(tile, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 0 });
    await waitFor(() => expect(page()?.agentWritten).toEqual([fingerprint(PAGE, 'Codex')]));
    const moved = loadDocumentWithStatus().doc.nodes.find(node => node.id === 'module')!.x;
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(loadDocumentWithStatus().doc.nodes.find(node => node.id === 'module')!.x).not.toBe(moved));
    expect(page()?.agentWritten).toEqual([fingerprint(PAGE, 'Codex')]);
  });
});
