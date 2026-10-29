// A page that holds a market Agent's words (marketPages.ts) shows still, its scripts not run, until its reader chooses
// to run it (the owner's choice, 2026-10-29); running, it keeps pictures and media by URL off but for the CDNs
// (liveDocument.ts MARKET_PAGE_CSP), and a line says so while it starts. So it is in the studio, for the Agent's node
// and every node its output reaches; in a deliverable's preview; and on a card on the board, which only shows it still.
// A page of the caller's own runs as any page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createSessionNode, type CanvasEdge, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { ArtifactPreview } from '../src/canvas/ArtifactPreview';
import { CardPreview } from '../src/canvas/CardPreview';
import { ARTIFACT_PREVIEW_CSP } from '../src/canvas/htmlDeliverable';
import { MarketPagesContext } from '../src/canvas/marketPages';
import { DeliverableStudio } from '../src/canvas/studio/DeliverableStudio';
import { LivePage } from '../src/canvas/studio/LivePage';
import { LIVE_PAGE_CSP, MARKET_PAGE_CSP } from '../src/canvas/studio/liveDocument';
import { GraphNodeOutput } from '../src/saas/GraphNodeOutput';
import type { GraphNodeResult, GraphRunSnapshot } from '../src/saas/graphRuns';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const NOTE = '这个页面含市场 Agent 写的内容，预览不加载其他网站的图片和音视频。';
const STILL = '这个页面含市场 Agent 写的内容，先显示静态预览，不运行它的脚本。';
const at = Date.now();
const pageNode = (id: string, patch: Partial<SessionNode> = {}): SessionNode => ({
  ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id,
  contract: { version: 1, inputs: [], outputs: [{ id: 'page', label: 'Page', type: 'html', required: true, value: '' }] },
  lastOutput: { text: JSON.stringify({ page: `<!doctype html><html><head><title>${id}</title></head><body><h1>${id}</h1><script>document.title='ran'</script></body></html>` }), at, source: 'run' },
  ...patch,
});
const policyOf = (frame: Element | null) => new DOMParser().parseFromString(frame?.getAttribute('srcdoc') ?? '', 'text/html')
  .querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');

describe('a market Agent’s page', () => {
  it('shows still until its reader runs it, then says pictures by URL stay off and gives the page its room back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LivePage html="<p>交付的页面</p><script>window.x=1</script>" title="交付页面" market />);
    const still = await screen.findByTitle(/交付页面/);
    expect(still.getAttribute('sandbox')).toBe('');
    expect(policyOf(still)).toBe(ARTIFACT_PREVIEW_CSP);
    expect(still.getAttribute('srcdoc')).not.toContain('window.x=1');
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(MARKET_PAGE_CSP));
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
    expect(await screen.findByRole('status')).toHaveTextContent(NOTE);
    await act(async () => { vi.advanceTimersByTime(8_000); });
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('only shows still on a card, from the canvas’s list of market pages', async () => {
    const card = render(<MarketPagesContext.Provider value={new Set(['agent'])}><CardPreview node={pageNode('agent')} running={false} /></MarketPagesContext.Provider>);
    await waitFor(() => expect(policyOf(card.container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
    expect(card.container.querySelector('iframe')!.getAttribute('sandbox')).toBe('');
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
    expect(screen.queryByText(new RegExp(STILL))).toBeNull();
    cleanup();
    const own = render(<MarketPagesContext.Provider value={new Set(['agent'])}><CardPreview node={pageNode('own')} running={false} /></MarketPagesContext.Provider>);
    await waitFor(() => expect(policyOf(own.container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
  });

  it('shows still in the studio, as do the pages its output reaches, and the caller’s own page runs at once', async () => {
    const nodes: CanvasNode[] = [pageNode('agent', { agentRef: { source: 'market', agentId: 'agent-1', version: 2 } }), pageNode('next'), pageNode('own')];
    const edges: CanvasEdge[] = [{ id: 'wire', fromNode: 'agent', fromPort: 'page', toNode: 'next', toPort: 'brief', dataType: 'text' }];
    for (const nodeId of ['agent', 'next']) {
      const { container } = render(<DeliverableStudio nodes={nodes} edges={edges} nodeId={nodeId} title="Results" variant="embedded" />);
      await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(ARTIFACT_PREVIEW_CSP));
      fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
      await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
      cleanup();
    }
    const { container } = render(<DeliverableStudio nodes={nodes} edges={edges} nodeId="own" title="Results" variant="embedded" />);
    await waitFor(() => expect(policyOf(container.querySelector('iframe'))).toBe(LIVE_PAGE_CSP));
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
  });

  it('shows still in a deliverable’s preview until its reader runs it', async () => {
    const page = '<!doctype html><html><head></head><body><h1>Shop</h1><script>window.ran=1</script></body></html>';
    const { container } = render(<ArtifactPreview type="html" source={page} title="Page" renderMarkdown={text => text} market />);
    const frame = () => container.querySelector('iframe')!;
    expect(frame().getAttribute('sandbox')).toBe('');
    expect(frame().getAttribute('srcdoc')).not.toContain('window.ran=1');
    expect(screen.getByText(new RegExp(STILL))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(frame().getAttribute('sandbox')).toContain('allow-scripts'));
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
    cleanup();
    // The caller's own page runs as soon as it is shown.
    const own = render(<ArtifactPreview type="html" source={page} title="Page" renderMarkdown={text => text} />);
    expect(own.container.querySelector('iframe')!.getAttribute('sandbox')).toContain('allow-scripts');
  });

  it('is built again when the same page comes to hold a market Agent’s words, never shown under its old policy', async () => {
    const { rerender } = render(<LivePage html="<p>same</p>" title="交付页面" />);
    await waitFor(() => expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(LIVE_PAGE_CSP));
    rerender(<LivePage html="<p>same</p>" title="交付页面" market />);
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    // Until the stricter build is there, the page waits; it never runs under the policy it was built with before.
    expect(policyOf(screen.queryByTitle(/交付页面/)) ?? MARKET_PAGE_CSP).toBe(MARKET_PAGE_CSP);
    await waitFor(() => expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(MARKET_PAGE_CSP));
  });

  it('asks again for each new delivery, and once for a page shown with the canvas’s own files', async () => {
    const { rerender } = render(<LivePage html="<p>first</p>" title="交付页面" market />);
    fireEvent.click(await screen.findByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(MARKET_PAGE_CSP));
    rerender(<LivePage html="<p>second</p>" title="交付页面" market />);
    expect(await screen.findByRole('button', { name: '运行页面' })).toBeVisible();
    expect(policyOf(screen.queryByTitle(/交付页面/))).toBe(ARTIFACT_PREVIEW_CSP);
    cleanup();
    // A page naming a canvas file runs in the live page: the one choice runs it there too.
    const page = '<!doctype html><html><head></head><body><img alt="hero" src="cv-1/image-1.png"></body></html>';
    const resolve = vi.fn(async () => ({ name: 'image-1.png', bytes: new Uint8Array([1, 2, 3]) }));
    const preview = render(<ArtifactPreview type="html" source={page} title="Page" renderMarkdown={text => text} resolveAsset={resolve} market />);
    fireEvent.click(screen.getByRole('button', { name: '运行页面' }));
    await waitFor(() => expect(policyOf(preview.container.querySelector('iframe'))).toBe(MARKET_PAGE_CSP));
    expect(screen.queryByRole('button', { name: '运行页面' })).toBeNull();
    preview.rerender(<ArtifactPreview type="html" source={page.replace('hero', 'other')} title="Page" renderMarkdown={text => text} resolveAsset={resolve} market />);
    expect(await screen.findByRole('button', { name: '运行页面' })).toBeVisible();
  });

  it('shows still in the run history where the run’s own canvas had the market Agent upstream', async () => {
    const page = '<!doctype html><html><head></head><body><h1>Shop</h1></body></html>';
    const contract = { version: 1, inputs: [], outputs: [{ id: 'page', label: 'Page', type: 'html', required: true, value: '' }] };
    const document = { version: 2, updatedAt: at, view: null, waypoints: [], nodes: [
      { ...pageNode('agent'), agentRef: { source: 'market', agentId: 'agent-1', version: 2 }, contract }, { ...pageNode('next'), contract }, { ...pageNode('own'), contract }],
      edges: [{ id: 'wire', fromNode: 'agent', fromPort: 'out:page', toNode: 'next', toPort: 'in:brief', dataType: 'text' }] };
    const result = (nodeId: string) => ({ nodeId, state: 'done', output: JSON.stringify({ page }), partial: false });
    const graph = { id: 'g1', status: 'completed', document } as unknown as GraphRunSnapshot;
    localStorage.setItem('superclaw_locale', 'zh');
    for (const [nodeId, still] of [['next', true], ['own', false]] as const) {
      const { container } = render(<SaaSPreferencesProvider><GraphNodeOutput graph={graph} node={result(nodeId) as unknown as GraphNodeResult} /></SaaSPreferencesProvider>);
      const frame = await waitFor(() => { const found = container.querySelector('iframe'); expect(found).not.toBeNull(); return found!; });
      expect(frame.getAttribute('sandbox')).toBe(still ? '' : 'allow-scripts allow-pointer-lock');
      expect(Boolean(screen.queryByRole('button', { name: '运行页面' }))).toBe(still);
      cleanup();
    }
  });
});
