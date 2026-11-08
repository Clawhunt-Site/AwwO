// A page an Agent invited to the canvas hands in over MCP (agentPages.ts) is held as a market Agent's page is (the
// owner's choice, 2026-11-08): still, its scripts not run, until its reader runs it, and then with pictures and media by
// URL only from the CDNs. The server keeps such a result as {source: "manual", by: {kind: "agent", name}}; the page keeps
// who handed it in, says so, and holds its page in every view that runs one: the deliverables panel, an enlarged card,
// the results studio (an archive's pages too), a preview display and the 成果 view. A person's own publication and a
// run's result run as before; a run's record shows a reused result as text.
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { strToU8, zipSync } from 'fflate';
import { agentDisplayName, handedInBy } from '../src/canvas/agentPages';
import { ArtifactPreview } from '../src/canvas/ArtifactPreview';
import { CanvasResults } from '../src/canvas/CanvasResults';
import { CardPreview } from '../src/canvas/CardPreview';
import { createFormNode, createSessionNode, sanitizeDocument, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { DisplayTile } from '../src/canvas/DisplayTile';
import { ARTIFACT_INTERACTIVE_CSP, ARTIFACT_PREVIEW_CSP } from '../src/canvas/htmlDeliverable';
import { LocaleProvider } from '../src/canvas/i18n';
import { applyOps } from '../src/canvas/multiplayer/changes';
import { NodeDeliverables } from '../src/canvas/NodeDeliverables';
import { pageRepairTarget } from '../src/canvas/pageRepair';
import { SessionTile } from '../src/canvas/SessionTile';
import { DeliverableStudio } from '../src/canvas/studio/DeliverableStudio';
import { LivePage } from '../src/canvas/studio/LivePage';
import { LIVE_PAGE_CSP, MARKET_PAGE_CSP } from '../src/canvas/studio/liveDocument';
import { nodeEntries, studioGroups } from '../src/canvas/studio/studioModel';
import type { CanvasRecord } from '../src/saas/api';
import { CanvasRunReceipt } from '../src/saas/CanvasRunReceipt';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { readableConfirmed, unsentOps } from '../src/saas/canvasSync';
import { GraphNodeOutput } from '../src/saas/GraphNodeOutput';
import { publishGraphRuns, type GraphNodeResult, type GraphRunSnapshot } from '../src/saas/graphRuns';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { ResultsGallery } from '../src/saas/ResultsGallery';
import { graphRunSummary } from './saas-graph-run-summary-fixture';

afterEach(() => { cleanup(); clearSaaSCanvas(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const PAGE = '<!doctype html><html><head><title>Lantern Path</title></head><body><h1>Lantern Path</h1><script>window.ran=1</script></body></html>';
const STILL = '这个页面是受邀进入画布的 Agent「Claude Code」交来的，先显示静态预览，不运行它的脚本。';
const STILL_UNNAMED = '这个页面是受邀进入画布的 Agent 交来的，先显示静态预览，不运行它的脚本。';
const NOTE = '这个页面是受邀进入画布的 Agent「Claude Code」交来的，预览不加载其他网站的图片和音视频。';
const tenant = { id: 'tenant-a', name: 'Workspace', status: 'active' as const, role: 'owner' as const, maxConcurrentRuns: 2, maxRunsPerDay: 10 };

/** A result as the server keeps one an Agent handed in (canvas_change_write.go). */
const handIn = (text: string, name = 'Claude Code', at = 2_000): NodeOutput => ({ text, at, source: 'manual', by: { kind: 'agent', name } });
/** A session an Agent added over MCP: no contract, `output` its result. */
const session = (output: NodeOutput | null, over: Partial<SessionNode> = {}): SessionNode => ({
  ...createSessionNode('llm', { x: 0, y: 0 }), id: 'build', title: 'Build the game', lastOutput: output, ...over,
});
const pageContract = { version: 1 as const, inputs: [], outputs: [{ id: 'page', label: 'Page', type: 'html' as const, required: true, value: '' }] };
const siteContract = { version: 1 as const, inputs: [], outputs: [{ id: 'site', label: 'Site', type: 'file' as const, required: true, value: '' }] };
/** Stored files by artifact id, served as the API serves one: a page as `<id>.html`, bytes as `<id>.zip`. */
const serveStored = (files: Record<string, string | Uint8Array>) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
  const id = decodeURIComponent(String(input instanceof Request ? input.url : input).split('/').pop() ?? '');
  const body = files[id];
  if (body === undefined) return new Response('', { status: 404 });
  const archive = typeof body !== 'string';
  return new Response(body, { headers: { 'Content-Disposition': `attachment; filename=${id}.${archive ? 'zip' : 'html'}`, 'Content-Type': archive ? 'application/zip' : 'text/html' } });
}));
const policyOf = (frame: Element | null) => new DOMParser().parseFromString(frame?.getAttribute('srcdoc') ?? '', 'text/html')
  .querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
/** A canvas as the server sends it, with one node holding `lastOutput` as given. */
const serverDocument = (lastOutput: unknown) => ({ version: 2, updatedAt: 1, edges: [], waypoints: [], view: null, nodes: [{ ...session(null), lastOutput }] });

describe('who handed a result in', () => {
  const read = (lastOutput: unknown) => sanitizeDocument(serverDocument(lastOutput)).nodes[0].lastOutput;

  it('is kept as the server stamps it, on a result handed in only', () => {
    expect(read({ text: PAGE, at: 5, source: 'manual', by: { kind: 'agent', name: '  Claude Code ' } }))
      .toEqual({ text: PAGE, at: 5, source: 'manual', by: { kind: 'agent', name: 'Claude Code' } });
    // A name that is not text is no name; one longer than a token's is cut where a token's ends.
    expect(read({ text: PAGE, at: 5, source: 'manual', by: { kind: 'agent', name: 7 } })?.by).toEqual({ kind: 'agent', name: '' });
    expect(read({ text: PAGE, at: 5, source: 'manual', by: { kind: 'agent' } })?.by).toEqual({ kind: 'agent', name: '' });
    expect(read({ text: PAGE, at: 5, source: 'manual', by: { kind: 'agent', name: '码'.repeat(80) } })?.by?.name).toBe('码'.repeat(60));
    // Only a result handed in has an author, and only an Agent is one.
    for (const output of [
      { text: PAGE, at: 5, source: 'run', by: { kind: 'agent', name: 'Claude Code' } },
      { text: PAGE, at: 5, source: 'case', by: { kind: 'agent', name: 'Claude Code' } },
      { text: PAGE, at: 5, source: 'manual', by: { kind: 'person', name: 'Ann' } },
      { text: PAGE, at: 5, source: 'manual', by: 'Claude Code' },
      { text: PAGE, at: 5, source: 'manual', by: [{ kind: 'agent', name: 'Claude Code' }] },
    ]) expect(read(output)).not.toHaveProperty('by');
  });

  it('is read alike from a result as a page or the server holds it', () => {
    expect(handedInBy(handIn(PAGE))).toBe('Claude Code');
    expect(handedInBy({ text: PAGE, at: 1, source: 'manual', by: { kind: 'agent', name: 3 } })).toBe('');
    for (const output of [null, undefined, 'manual', { text: PAGE, at: 1, source: 'manual' },
      { text: PAGE, at: 1, source: 'run', by: { kind: 'agent', name: 'Claude Code' } }]) expect(handedInBy(output)).toBeUndefined();
  });

  it('is named without what would reorder the sentence around the name', () => {
    const override = String.fromCodePoint(0x202e), isolate = String.fromCodePoint(0x2066), pop = String.fromCodePoint(0x2069);
    const bell = String.fromCodePoint(7), mark = String.fromCodePoint(0x200f), arabicMark = String.fromCodePoint(0x61c);
    expect(agentDisplayName(`${override}edoC edualC`)).toBe('edoC edualC');
    expect(agentDisplayName(` ${isolate}Codex${pop}${bell}${mark}${arabicMark} `)).toBe('Codex');
    expect(agentDisplayName('Claude Code · 写代码')).toBe('Claude Code · 写代码');
    expect(agentDisplayName(override)).toBe('');
  });

  it('stays through a person’s edit of the node, which sends only what they changed', () => {
    const server = serverDocument({ text: PAGE, at: 5, source: 'manual', by: { kind: 'agent', name: 'Claude Code' } });
    const confirmed = readableConfirmed(server);
    const working = { ...confirmed, nodes: confirmed.nodes.map(node => ({ ...node, x: 480 })) };
    const ops = unsentOps(confirmed, working);
    expect(ops).toEqual([expect.objectContaining({ op: 'set', path: ['nodes', 'build', 'x'], value: 480 })]);
    expect(handedInBy(working.nodes[0].lastOutput)).toBe('Claude Code');
    expect(readableConfirmed(applyOps(server, ops).doc).nodes[0].lastOutput).toEqual({ text: PAGE, at: 5, source: 'manual', by: { kind: 'agent', name: 'Claude Code' } });
  });

  it('is never sent back for a repair, held or run', () => {
    expect(pageRepairTarget([session(handIn(PAGE))], PAGE)).toBeNull();
    expect(pageRepairTarget([session(handIn(JSON.stringify({ page: PAGE })), { contract: pageContract })], PAGE)).toBeNull();
    expect(pageRepairTarget([session({ text: PAGE, at: 2_000, source: 'run' })], PAGE)?.node.id).toBe('build');
  });
});

describe('a held page', () => {
  it('shows still until its reader runs it, then says pictures by URL stay off and gives the page its room back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LivePage html="<p>交付的页面</p><script>window.x=1</script>" title="交付页面" handedInBy="Claude Code" />);
    const still = await screen.findByTitle(/交付页面/);
    expect(still.getAttribute('sandbox')).toBe('');
    expect(policyOf(still)).toBe(ARTIFACT_PREVIEW_CSP);
    expect(still.getAttribute('srcdoc')).not.toContain('window.x=1');
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(MARKET_PAGE_CSP));
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
    expect(await screen.findByText(NOTE)).toBeVisible();
    await act(async () => { vi.advanceTimersByTime(8_000); });
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('names an Agent with no name as an invited one, and a name only by what it shows', async () => {
    const { rerender } = render(<LivePage html="<p>交付的页面</p>" title="交付页面" handedInBy="" />);
    expect(await screen.findByText(new RegExp(STILL_UNNAMED))).toBeVisible();
    rerender(<LivePage html="<p>交付的页面</p>" title="交付页面" handedInBy={`${String.fromCodePoint(0x202e)}Claude Code`} />);
    expect(await screen.findByText(new RegExp(STILL))).toBeVisible();
  });

  it('is built again when a page that ran comes to be handed in, never shown under its old policy', async () => {
    const { rerender } = render(<LivePage html="<p>same</p>" title="交付页面" />);
    await waitFor(() => expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(LIVE_PAGE_CSP));
    rerender(<LivePage html="<p>same</p>" title="交付页面" handedInBy="Claude Code" />);
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    expect(policyOf(screen.queryByTitle(/交付页面/)) ?? MARKET_PAGE_CSP).toBe(MARKET_PAGE_CSP);
    await waitFor(() => expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(MARKET_PAGE_CSP));
  });

  it('asks again for each new hand-in', async () => {
    const { rerender } = render(<LivePage html="<p>first</p>" title="交付页面" handedInBy="Claude Code" />);
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(MARKET_PAGE_CSP));
    rerender(<LivePage html="<p>second</p>" title="交付页面" handedInBy="Claude Code" />);
    expect(await screen.findByRole('button', { name: '运行页面' })).toBeVisible();
    expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(ARTIFACT_PREVIEW_CSP);
  });
});

describe('the deliverables panel', () => {
  it('shows an Agent’s page still, says who handed it in, and runs it on its reader’s word', async () => {
    const { container } = render(<NodeDeliverables node={session(handIn(JSON.stringify({ page: PAGE })), { contract: pageContract })} readOnly />);
    const frame = () => container.querySelector('iframe')!;
    expect(frame().getAttribute('sandbox')).toBe('');
    expect(policyOf(frame())).toBe(ARTIFACT_PREVIEW_CSP);
    expect(frame().getAttribute('srcdoc')).not.toContain('window.ran=1');
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    expect(screen.getByText('由「Claude Code」交来')).toBeVisible();
    expect(screen.getByText('不是 AwwO 运行的结果')).toBeVisible();
    expect(screen.queryByText('手动发布')).toBeNull();
    expect(screen.queryByText('手动采用')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(frame().getAttribute('sandbox')).toBe('allow-scripts allow-pointer-lock'));
    expect(policyOf(frame())).toBe(ARTIFACT_INTERACTIVE_CSP);
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
  });

  it('holds the page no deliverable declared, the whole result an Agent handed in', async () => {
    render(<NodeDeliverables node={session(handIn(PAGE))} readOnly />);
    expect(screen.getByTitle('Build the game · HTML 预览')).toHaveAttribute('sandbox', '');
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(screen.getByTitle('Build the game · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock'));
  });

  it('runs a person’s own publication and a run’s result at once, as before', () => {
    for (const output of [{ text: PAGE, at: 2_000, source: 'manual' as const }, { text: PAGE, at: 2_000, source: 'run' as const }]) {
      render(<NodeDeliverables node={session(output)} readOnly />);
      expect(screen.getByTitle('Build the game · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock');
      expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
      if (output.source === 'manual') {
        expect(screen.getByText('手动发布')).toBeVisible();
        expect(screen.getByText('手动采用')).toBeVisible();
      }
      cleanup();
    }
  });

  it('asks again for a new hand-in, and names an Agent with no name as an invited one', async () => {
    const { rerender } = render(<NodeDeliverables node={session(handIn(PAGE))} readOnly />);
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(screen.getByTitle('Build the game · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock'));
    rerender(<NodeDeliverables node={session(handIn(PAGE.replace('Lantern', 'Ember'), '', 3_000))} readOnly />);
    expect(screen.getByTitle('Build the game · HTML 预览')).toHaveAttribute('sandbox', '');
    expect(screen.getByRole('button', { name: '运行页面' })).toBeVisible();
    expect(screen.getByText(new RegExp(STILL_UNNAMED))).toBeVisible();
    expect(screen.getByText('由受邀的 Agent 交来')).toBeVisible();
  });

  it('says so in English', () => {
    render(<LocaleProvider locale="en"><NodeDeliverables node={session(handIn(PAGE))} readOnly /></LocaleProvider>);
    expect(screen.getByText(/^“Claude Code”, an Agent invited to this canvas, handed this page in, so it shows as a still preview, its scripts not run\./)).toBeVisible();
    expect(screen.getByText('Handed in by “Claude Code”')).toBeVisible();
    expect(screen.getByText('Not from an AwwO run')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run page' })).toBeVisible();
  });

  it('holds a stored page the hand-in names', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PAGE, { headers: { 'Content-Disposition': 'attachment; filename=site.html', 'Content-Type': 'text/html' } })));
    const contract = { version: 1 as const, inputs: [], outputs: [{ id: 'site', label: 'Site', type: 'file' as const, required: true, value: '' }] };
    render(<NodeDeliverables node={session(handIn(JSON.stringify({ site: 'awwo-file:aSite123456' })), { contract })} readOnly />);
    const frame = await screen.findByTitle('Site · HTML 预览');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(screen.getByTitle('Site · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock'));
  });
});

describe('a held page in every other view', () => {
  it('is held on every file of the node, and on none of a run’s or a person’s', () => {
    expect(nodeEntries(session(handIn(PAGE)), 'manual')).toEqual([expect.objectContaining({ kind: 'page', handedInBy: 'Claude Code' })]);
    expect(nodeEntries(session(handIn(PAGE, '')), 'manual')).toEqual([expect.objectContaining({ kind: 'page', handedInBy: '' })]);
    expect(nodeEntries(session(handIn('## Notes')), 'manual')).toEqual([expect.objectContaining({ kind: 'markdown', handedInBy: 'Claude Code' })]);
    expect(nodeEntries(session({ text: PAGE, at: 1, source: 'run' }), 'run')[0]).not.toHaveProperty('handedInBy');
    expect(nodeEntries(session({ text: PAGE, at: 1, source: 'manual' }), 'manual')[0]).not.toHaveProperty('handedInBy');
  });

  it('only shows still on an enlarged card', async () => {
    const card = render(<CardPreview node={session(handIn(PAGE))} running={false} />);
    await waitFor(() => expect(policyOf(card.container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    expect(card.container.querySelector('iframe')).toHaveAttribute('sandbox', '');
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
    cleanup();
    const own = render(<CardPreview node={session({ text: PAGE, at: 1, source: 'run' })} running={false} />);
    await waitFor(() => expect(policyOf(own.container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
  });

  it('shows still in the results studio, then runs under the policy that loads no pictures by URL', async () => {
    const { container } = render(<DeliverableStudio nodes={[session(handIn(PAGE))]} edges={[]} nodeId="build" title="Results" variant="embedded" />);
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
    cleanup();
    const own = render(<DeliverableStudio nodes={[session({ text: PAGE, at: 1, source: 'run' })]} edges={[]} nodeId="build" title="Results" variant="embedded" />);
    await waitFor(() => expect(policyOf(own.container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
  });

  it('holds a page inside an archive the hand-in names, in the studio', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const archive = zipSync({ 'index.html': strToU8(PAGE) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(archive, { headers: { 'Content-Disposition': 'attachment; filename=site.zip', 'Content-Type': 'application/zip' } })));
    const contract = { version: 1 as const, inputs: [], outputs: [{ id: 'site', label: 'Site', type: 'file' as const, required: true, value: '' }] };
    const { container } = render(<DeliverableStudio nodes={[session(handIn(JSON.stringify({ site: 'awwo-file:aSite123456' })), { contract })]} edges={[]} nodeId="build"
      title="Results" variant="embedded" />);
    fireEvent.click(await screen.findByRole('button', { name: '运行 index.html' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
  });

  it('shows still in a preview display, until its reader runs it', async () => {
    const groups = studioGroups({ nodes: [session(handIn(PAGE))], edges: [] });
    const { container } = render(<DisplayTile display={{ id: 'dp-1', kind: 'display', x: 900, y: 0, w: 640, h: 480, title: '', source: { type: 'node', nodeId: 'build' } }}
      groups={groups} choices={[{ id: 'build', title: 'Build the game' }]} canvasEntries={groups.flatMap(group => group.entries)} running={new Set()} scale={1} />);
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
  });

  it('shows still as the canvas’s result in the 成果 view', async () => {
    render(<CanvasResults nodes={[session(handIn(PAGE))]} edges={[]} runs={{}} running={false} readOnly onOpenNode={vi.fn()} onBack={vi.fn()} />);
    const result = screen.getByRole('article', { name: 'Build the game' });
    expect(within(result).getByTitle('Build the game · HTML 预览')).toHaveAttribute('sandbox', '');
    fireEvent.click(within(result).getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(within(result).getByTitle('Build the game · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock'));
  });

  it('says an Agent’s name as it is, whatever characters it has', () => {
    render(<ArtifactPreview type="html" source={PAGE} title="Page" renderMarkdown={text => text} handedInBy={'$& $\''} />);
    expect(screen.getByText(/^这个页面是受邀进入画布的 Agent「\$& \$'」交来的，/)).toBeVisible();
  });

  it('is text, never a running page, in a run’s record that reused it', () => {
    const value = JSON.stringify({ page: PAGE });
    const document = { ...serverDocument(null), nodes: [{ ...session(null), contract: pageContract, lastOutput: { ...handIn(value) } }] };
    const graph = { id: 'g1', status: 'completed', document } as unknown as GraphRunSnapshot;
    localStorage.setItem('superclaw_locale', 'zh');
    const { container } = render(<SaaSPreferencesProvider><GraphNodeOutput graph={graph}
      node={{ nodeId: 'build', state: 'cached', output: value, partial: false } as unknown as GraphNodeResult} /></SaaSPreferencesProvider>);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe(value);
  });
});

describe('a new delivery under the same file', () => {
  const agentPage = PAGE.replace('<h1>Lantern Path</h1>', '<h1>Agent page</h1>');
  const runPage = PAGE.replace('<h1>Lantern Path</h1>', '<h1>Run page</h1>');
  const stored = (output: NodeOutput) => session(output, { contract: siteContract });
  const names = (id: string) => JSON.stringify({ site: `awwo-file:${id}` });
  const ran = (text: string): NodeOutput => ({ text, at: 3_000, source: 'run' });

  it('is read again in the results studio, and held as that delivery is', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    serveStored({ aStudioAgent1: agentPage, aStudioRun001: runPage });
    const studio = (output: NodeOutput) => <DeliverableStudio nodes={[stored(output)]} edges={[]} nodeId="build" title="Results" variant="embedded" />;
    const { container, rerender } = render(studio(handIn(names('aStudioAgent1'))));
    const frame = () => container.querySelector('iframe');
    await waitFor(() => expect(frame()?.getAttribute('srcdoc')).toContain('Agent page'));
    expect(policyOf(frame())).toBe(ARTIFACT_PREVIEW_CSP);
    rerender(studio(ran(names('aStudioRun001'))));
    await waitFor(() => expect(frame()?.getAttribute('srcdoc')).toContain('Run page'));
    expect(policyOf(frame())).toBe(LIVE_PAGE_CSP);
    expect(frame()!.getAttribute('srcdoc')).not.toContain('Agent page');
  });

  it('holds an archive’s pages once a hand-in names the archive a run delivered', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    serveStored({ aArchive0001: zipSync({ 'index.html': strToU8(PAGE) }) });
    const studio = (output: NodeOutput) => <DeliverableStudio nodes={[stored(output)]} edges={[]} nodeId="build" title="Results" variant="embedded" />;
    const { container, rerender } = render(studio({ text: names('aArchive0001'), at: 1_000, source: 'run' }));
    fireEvent.click(await screen.findByRole('button', { name: '运行 index.html' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
    rerender(studio(handIn(names('aArchive0001'))));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
  });

  it('opens in a new tab only the page the studio shows, as it is shown', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = vi.fn(() => 'blob:page'); static revokeObjectURL = vi.fn(); });
    const studio = (output: NodeOutput) => <DeliverableStudio nodes={[session(output)]} edges={[]} nodeId="build" title="Results" variant="embedded" />;
    const { container, rerender } = render(studio({ text: PAGE, at: 1_000, source: 'run' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
    fireEvent.click(screen.getByRole('button', { name: '在新标签页打开' }));
    expect(opened).toHaveBeenCalledTimes(1);
    // The same page, now handed in by an Agent: held, so the build made before is not the page the studio shows.
    rerender(studio(handIn(PAGE)));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    fireEvent.click(screen.getByRole('button', { name: '在新标签页打开' }));
    expect(opened).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
    fireEvent.click(screen.getByRole('button', { name: '在新标签页打开' }));
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it('is read again on an enlarged card and in a preview display', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    serveStored({ aCardAgent01: agentPage, aCardRun0001: runPage, aShowAgent01: agentPage, aShowRun0001: runPage });
    const card = render(<CardPreview node={stored(handIn(names('aCardAgent01')))} running={false} />);
    await waitFor(() => expect(card.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Agent page'));
    expect(policyOf(card.container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP);
    card.rerender(<CardPreview node={stored(ran(names('aCardRun0001')))} running={false} />);
    await waitFor(() => expect(card.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Run page'));
    expect(policyOf(card.container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP);
    cleanup();
    const display = (output: NodeOutput) => {
      const groups = studioGroups({ nodes: [stored(output)], edges: [] });
      return <DisplayTile display={{ id: 'dp-1', kind: 'display', x: 900, y: 0, w: 640, h: 480, title: '', source: { type: 'node', nodeId: 'build' } }}
        groups={groups} choices={[{ id: 'build', title: 'Build the game' }]} canvasEntries={groups.flatMap(group => group.entries)} running={new Set()} scale={1} />;
    };
    const shown = render(display(handIn(names('aShowAgent01'))));
    await waitFor(() => expect(shown.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Agent page'));
    expect(policyOf(shown.container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP);
    shown.rerender(display(ran(names('aShowRun0001'))));
    await waitFor(() => expect(shown.container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Run page'));
    expect(policyOf(shown.container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP);
  });
});

describe('who a hand-in is said to be from', () => {
  // The Agent's page feeds a run's page, the canvas's result: the Agent's step keeps its own label.
  const nodes = () => [session(handIn(PAGE)), session({ text: PAGE.replace('Lantern Path', 'Finished'), at: 3_000, source: 'run' }, { id: 'notes', title: 'Notes' })];
  const edges = [{ id: 'w1', fromNode: 'build', fromPort: 'result', toNode: 'notes', toPort: 'context', dataType: 'text' as const }];

  it('is the Agent in the 成果 view, never a person’s publication', () => {
    render(<CanvasResults nodes={[session(handIn(PAGE))]} edges={[]} runs={{}} running={false} readOnly onOpenNode={vi.fn()} onBack={vi.fn()} />);
    const result = screen.getByRole('article', { name: 'Build the game' });
    expect(within(result).getByText(/由「Claude Code」交来/)).toBeVisible();
    expect(within(result).queryByText(/手动发布/)).toBeNull();
    cleanup();
    render(<CanvasResults nodes={nodes()} edges={edges} runs={{}} running={false} readOnly onOpenNode={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getAllByText('Agent 交来').length).toBeGreaterThan(0);
    expect(screen.queryByText('手动发布')).toBeNull();
  });

  it('is the Agent on the studio’s badge and in a preview display', () => {
    render(<DeliverableStudio nodes={nodes()} edges={edges} title="Results" variant="embedded" />);
    expect(screen.getByText('Agent 交来')).toBeVisible();
    expect(screen.queryByText('手动发布')).toBeNull();
    cleanup();
    const groups = studioGroups({ nodes: [session(handIn(PAGE)), session({ text: PAGE, at: 1, source: 'manual' }, { id: 'own', title: 'Own page' })], edges: [] });
    const { container } = render(<DisplayTile display={{ id: 'dp-1', kind: 'display', x: 900, y: 0, w: 640, h: 480, title: '', source: { type: 'canvas' } }}
      groups={groups} choices={[{ id: 'build', title: 'Build the game' }, { id: 'own', title: 'Own page' }]} canvasEntries={groups.flatMap(group => group.entries)} running={new Set()} scale={1} />);
    const cardOf = (title: string) => container.querySelector(`.awwo-display-card[aria-label="${title}"]`);
    expect(cardOf('Build the game')?.textContent).toContain('Agent 交来');
    expect(cardOf('Own page')?.textContent).toContain('手动采用');
  });
});

describe('a reader’s choice to run', () => {
  it('is for one hand-in: the same page handed in again asks again, in the studio and a preview display', async () => {
    const studio = (output: NodeOutput) => <DeliverableStudio nodes={[session(output)]} edges={[]} nodeId="build" title="Results" variant="embedded" />;
    const { container, rerender } = render(studio(handIn(PAGE, 'Claude Code', 2_000)));
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
    rerender(studio(handIn(PAGE, 'Codex', 5_000)));
    expect(await screen.findByRole('button', { name: '运行页面' })).toBeVisible();
    expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP);
    cleanup();
    const display = (output: NodeOutput) => {
      const groups = studioGroups({ nodes: [session(output)], edges: [] });
      return <DisplayTile display={{ id: 'dp-1', kind: 'display', x: 900, y: 0, w: 640, h: 480, title: '', source: { type: 'node', nodeId: 'build' } }}
        groups={groups} choices={[{ id: 'build', title: 'Build the game' }]} canvasEntries={groups.flatMap(group => group.entries)} running={new Set()} scale={1} />;
    };
    const shown = render(display(handIn(PAGE, 'Claude Code', 2_000)));
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(shown.container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
    shown.rerender(display(handIn(PAGE, 'Codex', 5_000)));
    expect(await screen.findByRole('button', { name: '运行页面' })).toBeVisible();
  });

  it('leaves Open in a new tab no build once the page shows still again (the code view and back)', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = vi.fn(() => 'blob:page'); static revokeObjectURL = vi.fn(); });
    const { container } = render(<DeliverableStudio nodes={[session(handIn(PAGE))]} edges={[]} nodeId="build" title="Results" variant="embedded" />);
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
    fireEvent.click(screen.getByRole('button', { name: '在新标签页打开' }));
    expect(opened).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '代码' }));
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(await screen.findByRole('button', { name: '运行页面' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '在新标签页打开' }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('runs an archive’s page from the archive a new delivery names, not the one opened before', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    serveStored({ aZipRevA0001: zipSync({ 'index.html': strToU8(PAGE.replace('Lantern Path', 'Archive A')) }),
      aZipRevB0001: zipSync({ 'index.html': strToU8(PAGE.replace('Lantern Path', 'Archive B')) }) });
    const studio = (archive: string, at: number) => <DeliverableStudio nodes={[session({ text: JSON.stringify({ site: `awwo-file:${archive}` }), at, source: 'run' }, { contract: siteContract })]}
      edges={[]} nodeId="build" title="Results" variant="embedded" />;
    const { container, rerender } = render(studio('aZipRevA0001', 1_000));
    fireEvent.click(await screen.findByRole('button', { name: '运行 index.html' }));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Archive A'));
    rerender(studio('aZipRevB0001', 2_000));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Archive B'));
    // Its download is the new archive's file too, never the one read from the archive before.
    const saved: Blob[] = [];
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = vi.fn((blob: Blob) => { saved.push(blob); return 'blob:file'; }); static revokeObjectURL = vi.fn(); });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: '下载这个文件' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(saved[0]); });
    expect(text).toContain('Archive B');
  });

  it('is its own in an enlarged preview, and runs a page naming the canvas’s files under the stricter policy', async () => {
    const { container } = render(<ArtifactPreview type="html" source={PAGE} title="Page" renderMarkdown={text => text} handedInBy="Claude Code" />);
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTitle('Page · HTML 预览')).toHaveAttribute('sandbox', '');
    fireEvent.click(within(dialog).getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(within(dialog).getByTitle('Page · HTML 预览')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock'));
    cleanup();
    const page = '<!doctype html><html><head></head><body><img alt="hero" src="cv-1/image-1.png"><script>window.ran=1</script></body></html>';
    const resolve = vi.fn(async () => ({ name: 'image-1.png', bytes: new Uint8Array([1, 2, 3]) }));
    const live = render(<ArtifactPreview type="html" source={page} title="Page" renderMarkdown={text => text} resolveAsset={resolve} handedInBy="Claude Code" />);
    expect(live.container.querySelector('iframe')).toHaveAttribute('sandbox', '');
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(live.container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
    expect(container).toBeTruthy();
  });

  it('names the Agent on a market page it handed in, and an Agent whose name shows nothing as an invited one', async () => {
    const { rerender } = render(<LivePage html="<p>交付的页面</p>" title="交付页面" market handedInBy="Claude Code" />);
    expect(await screen.findByText(new RegExp(STILL))).toBeVisible();
    const invisible = [0x200b, 0x2060, 0xfeff, 0xe0041].map(code => String.fromCodePoint(code)).join('');
    expect(agentDisplayName(invisible)).toBe('');
    rerender(<LivePage html="<p>交付的页面</p>" title="交付页面" handedInBy={invisible} />);
    expect(await screen.findByText(new RegExp(STILL_UNNAMED))).toBeVisible();
  });
});

describe('the studio while a new delivery is read', () => {
  it('stands a file of an archive in for it by its own archive, never another node’s page', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    serveStored({ aZipStand001: zipSync({ 'index.html': strToU8(PAGE.replace('Lantern Path', 'Archive A')) }),
      aZipStand002: zipSync({ 'index.html': strToU8(PAGE.replace('Lantern Path', 'Archive B')) }) });
    // The cover is the canvas's result, so it is the studio's first file.
    const cover = session({ text: PAGE.replace('Lantern Path', 'Cover page'), at: 1_000, source: 'run' }, { id: 'cover', title: 'Cover' });
    const studio = (archive: string, at: number) => <DeliverableStudio nodes={[cover, session({ text: JSON.stringify({ site: `awwo-file:${archive}` }), at, source: 'run' }, { contract: siteContract })]}
      edges={[]} title="Results" variant="embedded" />;
    const { container, rerender } = render(studio('aZipStand001', 1_000));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Cover page'));
    fireEvent.click(screen.getByTitle('Site'));
    fireEvent.click(await screen.findByRole('button', { name: '运行 index.html' }));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Archive A'));
    // With the archive folded in the tree, nothing else reads the new archive's files.
    fireEvent.click(screen.getByRole('button', { name: '收起 aZipStand001.zip' }));
    rerender(studio('aZipStand002', 2_000));
    expect(container.querySelector('.awwo-studio-file strong')?.textContent).not.toBe('Cover.html');
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Archive B'));
  });

  it('lets an earlier delivery’s file go once nothing lists it', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const id = decodeURIComponent(String(input instanceof Request ? input.url : input).split('/').pop() ?? '');
      return new Response(png, { headers: { 'Content-Disposition': `attachment; filename=${id}.png`, 'Content-Type': 'image/png' } });
    }));
    let made = 0;
    const revoked: string[] = [];
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = vi.fn(() => `blob:picture-${++made}`); static revokeObjectURL = vi.fn((url: string) => { revoked.push(url); }); });
    const studio = (reference: string, at: number) => <DeliverableStudio nodes={[session({ text: JSON.stringify({ site: `awwo-file:${reference}` }), at, source: 'run' }, { contract: siteContract })]}
      edges={[]} nodeId="build" title="Results" variant="embedded" />;
    const { container, rerender } = render(studio('aPicture0001', 1_000));
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:picture-1'));
    rerender(studio('aPicture0002', 2_000));
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:picture-2'));
    await waitFor(() => expect(revoked).toContain('blob:picture-1'));
    expect(revoked).not.toContain('blob:picture-2');
  });

  it('says again why pictures stay off each time its reader runs a page, the same page delivered again included', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = render(<LivePage html="<p>交付的页面</p>" title="交付页面" handedInBy="Claude Code" delivery={1} />);
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    expect(await screen.findByText(NOTE)).toBeVisible();
    await act(async () => { vi.advanceTimersByTime(8_000); });
    expect(screen.queryByText(NOTE)).toBeNull();
    rerender(<LivePage html="<p>交付的页面</p>" title="交付页面" handedInBy="Claude Code" delivery={2} />);
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    expect(await screen.findByText(NOTE)).toBeVisible();
  });
});

describe('a hand-in’s other labels', () => {
  it('claims no run in the 成果 view’s receipt, though a run once completed the step', async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetcher);
    const run = { id: 'done-run-agent1', operationId: 'op-agent', canvasId: 'canvas-agent', documentVersion: 1, scope: ['build'], status: 'completed',
      createdAt: '2026-11-08T06:00:00Z', updatedAt: '2026-11-08T06:01:00Z', nodes: [{ nodeId: 'build', state: 'done' }] } as unknown as GraphRunSnapshot;
    publishGraphRuns('tenant-a', 'canvas-agent', [graphRunSummary(run)]);
    localStorage.setItem('superclaw_locale', 'zh');
    render(<SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId="canvas-agent" final={session(handIn(PAGE))} /></SaaSPreferencesProvider>);
    const region = screen.getByRole('region', { name: '运行回执' });
    expect(within(region).getByText(/^这份交付是受邀进入画布的 Agent「Claude Code」交来的，不是 AwwO 运行的结果/)).toBeVisible();
    expect(within(region).queryByText('最近一次完成这一步的运行')).toBeNull();
    expect(within(region).queryByText(/手动发布/)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is the Agent on a form’s card and in the home page’s recent results', () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'brief', title: 'Brief', lastOutput: handIn('Three levels') };
    render(<SessionTile node={form} scale={1} focused />);
    expect(screen.getByTestId('canvas-tile-output-brief').textContent).toContain('Agent 交来 · ');
    cleanup();
    localStorage.setItem('superclaw_locale', 'zh');
    const record = { id: 'c-agent', tenantId: tenant.id, name: 'Agent canvas', version: 1, createdAt: '', updatedAt: '',
      document: { version: 2, updatedAt: Date.now(), nodes: [session(handIn(PAGE, 'Claude Code', Date.now() - 60_000))], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } } };
    render(<SaaSPreferencesProvider><ResultsGallery tenant={tenant} canvases={[record] as unknown as CanvasRecord[]} /></SaaSPreferencesProvider>);
    expect(screen.getByText('Agent 交来')).toBeVisible();
    expect(screen.queryByText('手动发布')).toBeNull();
  });

  it('has the studio read a new archive once, though the tree and the selection both open it', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    serveStored({ aZipOnce0001: zipSync({ 'index.html': strToU8(PAGE.replace('Lantern Path', 'Archive A')) }),
      aZipOnce0002: zipSync({ 'index.html': strToU8(PAGE.replace('Lantern Path', 'Archive B')) }) });
    const fetcher = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const studio = (archive: string, at: number) => <DeliverableStudio nodes={[session({ text: JSON.stringify({ site: `awwo-file:${archive}` }), at, source: 'run' }, { contract: siteContract })]}
      edges={[]} nodeId="build" title="Results" variant="embedded" />;
    const { container, rerender } = render(studio('aZipOnce0001', 1_000));
    fireEvent.click(await screen.findByRole('button', { name: '运行 index.html' }));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Archive A'));
    rerender(studio('aZipOnce0002', 2_000));
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Archive B'));
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/aZipOnce0002'))).toHaveLength(1);
  });
});

describe('the studio under StrictMode', () => {
  it('reads a stored file again after the trial unmount stopped its first read', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    serveStored({ aStrictMode1: PAGE.replace('Lantern Path', 'Strict page') });
    const { container } = render(<StrictMode><DeliverableStudio nodes={[session({ text: JSON.stringify({ site: 'awwo-file:aStrictMode1' }), at: 1_000, source: 'run' },
      { contract: siteContract })]} edges={[]} nodeId="build" title="Results" variant="embedded" /></StrictMode>);
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Strict page'));
  });
});
