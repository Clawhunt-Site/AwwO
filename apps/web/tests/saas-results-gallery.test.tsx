import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { ResultsGallery, RESULTS_GALLERY_COUNT } from '../src/saas/ResultsGallery';
import { CanvasRunReceipt } from '../src/saas/CanvasRunReceipt';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { publishGraphRuns, type GraphRunSnapshot } from '../src/saas/graphRuns';
import { createSessionNode, type CanvasNode, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import type { CanvasRecord, Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const now = Date.now();
const page = (text: string) => `<!doctype html><html><head><title>${text}</title><script>alert(1)</script></head><body><h1>${text}</h1></body></html>`;
function step(id: string, title: string, type: 'markdown' | 'html', output?: string, extra: Partial<NodeOutput> = {}): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id, title,
    contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: title, type, required: true, value: '' }] },
    lastOutput: output === undefined ? null : { text: JSON.stringify({ result: output }), at: now - 60_000, source: 'run', ...extra } };
}
const canvas = (id: string, name: string, nodes: CanvasNode[]): CanvasRecord => ({ id, tenantId: tenant.id, name, version: 1, createdAt: '', updatedAt: '',
  document: { version: 2, updatedAt: now, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `e${index}`, fromNode: nodes[index].id, fromPort: 'out:result', toNode: node.id, toPort: 'in:brief', dataType: 'text' })), waypoints: [], view: null } });
const gallery = (canvases: CanvasRecord[] | null) => render(<SaaSPreferencesProvider><ResultsGallery tenant={tenant} canvases={canvases} /></SaaSPreferencesProvider>);
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the home’s 最近的成果', () => {
  it('shows each delivering canvas by its result, newest first, opening straight into its results', () => {
    gallery([
      canvas('c-old', '旧画布', [step('a', '需求整理', 'markdown', '需求', { at: now - 86_400_000 })]),
      canvas('c-game', '狐狸邮差', [step('d', '玩法与数值', 'markdown', '规格'), step('b', '可玩试玩关', 'html', page('Fox game'))]),
      canvas('c-none', '空画布', [step('e', '还没跑', 'markdown')]),
    ]);
    const cards = screen.getAllByRole('link');
    expect(cards.map(card => within(card).getByText(/可玩试玩关|需求整理/).textContent)).toEqual(['可玩试玩关', '需求整理']);
    expect(cards[0]).toHaveAttribute('href', '/?tenant=tenant-a&canvas=c-game&view=results');
    expect(within(cards[0]).getByText('狐狸邮差')).toBeVisible();
    expect(within(cards[0]).getByText('运行交付')).toBeVisible();
    expect(screen.queryByText('空画布')).toBeNull();
  });

  it('prints a web result statically: no scripts, an opaque origin, no focus, and says so', () => {
    const { container } = gallery([canvas('c-game', '狐狸邮差', [step('b', '可玩试玩关', 'html', page('Fox game'))])]);
    const frame = container.querySelector('iframe')!;
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('tabindex', '-1');
    expect(frame).toHaveAttribute('aria-hidden', 'true');
    expect(frame.getAttribute('srcdoc')).toContain("script-src 'none'");
    expect(frame.getAttribute('srcdoc')).not.toContain('alert(1)');
    expect(screen.getByText('网页 · 静态预览')).toBeVisible();
  });

  it('labels partial, hand-published, copied-case and unfinished results honestly', () => {
    gallery([
      canvas('c-case', '复制的案例', [step('k', '可玩试玩关', 'markdown', '实录', { source: 'case', model: 'qwen3.8-27b-p6', at: Date.UTC(2026, 9, 3) })]),
      canvas('c-partial', '失败过的画布', [step('a', '分析报告', 'markdown', '一半', { partial: true })]),
      canvas('c-manual', '手动的画布', [step('b', '海报文案', 'markdown', '文案', { source: 'manual' })]),
      canvas('c-half', '没跑完的画布', [step('c', '玩法与数值', 'markdown', '规格'), step('d', '可玩试玩关', 'html')]),
    ]);
    expect(within(screen.getByRole('link', { name: /失败过的画布/ })).getByText('部分结果')).toBeVisible();
    expect(within(screen.getByRole('link', { name: /手动的画布/ })).getByText('手动发布')).toBeVisible();
    expect(within(screen.getByRole('link', { name: /没跑完的画布/ })).getByText('还有 1 步没有交付')).toBeVisible();
    const copied = within(screen.getByRole('link', { name: /复制的案例/ }));
    expect(copied.getByText('案例实录')).toBeVisible();
    // Dated by the case's run, not by when the copy received it.
    expect(copied.getByText('qwen3.8-27b-p6 · 2026-10-03')).toBeVisible();
    expect(screen.getByRole('link', { name: /复制的案例/ }).querySelector('time')).toBeNull();
  });

  it(`shows at most ${RESULTS_GALLERY_COUNT}, invites a first run when nothing was delivered, and stays out of an empty workspace`, () => {
    const many = Array.from({ length: 9 }, (_, index) => canvas(`c${index}`, `画布 ${index}`, [step(`n${index}`, `交付 ${index}`, 'markdown', '内容', { at: now - index * 1000 })]));
    const { rerender } = gallery(many);
    expect(screen.getAllByRole('link')).toHaveLength(RESULTS_GALLERY_COUNT);
    rerender(<SaaSPreferencesProvider><ResultsGallery tenant={tenant} canvases={[canvas('c', '新画布', [step('a', '第一步', 'markdown')])]} /></SaaSPreferencesProvider>);
    expect(screen.getByText('还没有交付。运行一张画布后，它交付的东西会出现在这里。')).toBeVisible();
    // A viewer cannot run, so the invitation is not theirs.
    rerender(<SaaSPreferencesProvider><ResultsGallery tenant={{ ...tenant, role: 'reader' }} canvases={[canvas('c', '新画布', [step('a', '第一步', 'markdown')])]} /></SaaSPreferencesProvider>);
    expect(screen.getByText('还没有交付。成员运行画布后，成果会出现在这里。')).toBeVisible();
    rerender(<SaaSPreferencesProvider><ResultsGallery tenant={tenant} canvases={[]} /></SaaSPreferencesProvider>);
    expect(screen.queryByRole('heading', { name: '最近的成果' })).toBeNull();
    rerender(<SaaSPreferencesProvider><ResultsGallery tenant={tenant} canvases={null} /></SaaSPreferencesProvider>);
    expect(screen.queryByRole('heading', { name: '最近的成果' })).toBeNull();
  });

  it('says nothing until the loaded list has been read, then shows what it found', () => {
    const { rerender, container } = gallery(null);
    expect(container).toBeEmptyDOMElement();
    rerender(<SaaSPreferencesProvider><ResultsGallery tenant={tenant} canvases={[canvas('c-ok', '好画布', [step('a', '报告', 'markdown', '内容')])]} /></SaaSPreferencesProvider>);
    expect(screen.getByRole('link', { name: /好画布/ })).toBeVisible();
    expect(screen.queryByText(/还没有交付/)).toBeNull();
  });

  it('ignores a stored document it cannot read instead of failing the home', () => {
    gallery([{ ...canvas('c-bad', '坏数据', []), document: 'not a document' }, canvas('c-ok', '好画布', [step('a', '报告', 'markdown', '内容')])]);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('survives a delivery time no date can hold, and shows no time for it', () => {
    gallery([canvas('c-far', '时间坏了', [step('a', '报告', 'markdown', '内容', { at: 9e15 })])]);
    const card = screen.getByRole('link', { name: /时间坏了/ });
    expect(card.querySelector('time')).toBeNull();
  });

  it('keeps the print out of reach and prints only a page small enough to build at once', () => {
    const big = `<!doctype html><html><head><title>big</title></head><body><p>${'x'.repeat(600 * 1024)}</p></body></html>`;
    const { container } = gallery([canvas('c-small', '小页面', [step('a', '页面', 'html', page('small'))]), canvas('c-big', '大页面', [step('b', '页面', 'html', big)])]);
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(container.querySelector('iframe')).toHaveAttribute('inert');
    expect(within(screen.getByRole('link', { name: /大页面/ })).getByText('网页')).toBeInTheDocument();
  });

  it('reads results from the most recently updated canvases only', () => {
    const touched = (index: number) => ({ ...canvas(`c${index}`, `画布 ${index}`, [step(`n${index}`, `交付 ${index}`, 'markdown', '内容', { at: now - 1000 })]),
      updatedAt: new Date(now - index * 60_000).toISOString() });
    gallery(Array.from({ length: 25 }, (_, index) => touched(index)));
    // Six shown, all from the eighteen most recently updated canvases.
    expect(screen.getAllByRole('link').every(link => Number(link.getAttribute('href')!.match(/canvas=c(\d+)/)![1]) < 18)).toBe(true);
  });
});

describe('the 成果 view’s run receipt', () => {
  const finalNode = step('build', '可玩试玩关', 'html', page('Fox'));
  const run = (id: string, state: GraphRunSnapshot['nodes'][number]['state'], extra: Partial<GraphRunSnapshot> = {}): GraphRunSnapshot => ({
    id, operationId: `op-${id}`, canvasId: 'canvas-a', documentVersion: 1, scope: ['design', 'build'], status: 'completed', createdAt: '2026-10-05T06:00:00Z', updatedAt: '2026-10-05T06:03:12Z',
    nodes: [{ nodeId: 'design', state: 'cached' }, { nodeId: 'build', state }],
    document: { version: 2, updatedAt: 1, waypoints: [], view: null, edges: [], nodes: [{ ...finalNode, model: 'qwen3.8-27b-p6' }, { ...step('design', '玩法与数值', 'markdown'), model: 'qwen3.8-27b-p6' }] }, ...extra });
  const receipt = (final: CanvasNode | null = finalNode, canvasId = 'canvas-a') => render(<SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId={canvasId} final={final} /></SaaSPreferencesProvider>);

  it('reads the run panel’s poll and names the latest run that completed the result’s step, without claiming more', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    publishGraphRuns('tenant-a', 'canvas-a', [run('newer-failed', 'failed', { status: 'failed' }), run('done-run-123456', 'done')]);
    receipt();
    const region = screen.getByRole('region', { name: '运行回执' });
    expect(within(region).getByText('最近一次完成这一步的运行')).toBeVisible();
    // The whole canvas ran: its two steps are both in scope.
    expect(within(region).getByText('整张画布')).toBeVisible();
    expect(within(region).getByText('完成')).toBeVisible();
    expect(within(region).getByText('3 分 12 秒')).toBeVisible();
    expect(within(region).getByText('1 步完成 · 1 步沿用上次结果')).toBeVisible();
    expect(within(region).getByText('qwen3.8-27b-p6（1 步）')).toBeVisible();
    expect(within(region).getByText('done-run-1')).toBeVisible();
    expect(within(region).getByText('运行完成不等于人工验收通过。完整过程见「运行记录」。')).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the runs itself, once, when nothing has read them yet, and follows later polls', async () => {
    const fetcher = vi.fn(async () => Response.json({ items: [run('first', 'done')] }));
    vi.stubGlobal('fetch', fetcher);
    receipt(finalNode, 'canvas-fresh');
    await screen.findByText('first'.slice(0, 10));
    expect(fetcher).toHaveBeenCalledOnce();
    act(() => publishGraphRuns('tenant-a', 'canvas-fresh', [run('second-run', 'done'), run('first', 'done')]));
    expect(await screen.findByText('second-run')).toBeVisible();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('says plainly when no run produced the result', async () => {
    vi.stubGlobal('fetch', vi.fn());
    publishGraphRuns('tenant-a', 'canvas-b', [run('other', 'cached')]);
    const { rerender } = receipt(finalNode, 'canvas-b');
    expect(screen.getByText('最近 1 次运行里没有完成这一步的记录。')).toBeVisible();
    rerender(<SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId="canvas-b" final={{ ...finalNode, lastOutput: { ...finalNode.lastOutput!, source: 'manual' } }} /></SaaSPreferencesProvider>);
    expect(screen.getByText('这份交付是手动发布的，没有对应的运行记录。')).toBeVisible();
    // With nothing delivered it reports only what the records say: the latest run, not a claim about completion.
    rerender(<SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId="canvas-b" final={null} /></SaaSPreferencesProvider>);
    expect(screen.getByText(/^最近一次运行：完成 · /)).toBeVisible();
    expect(screen.queryByText(/没有完成的运行/)).toBeNull();
  });

  it('names the run in which a partial result’s step stopped, and a run that covered only some steps', () => {
    vi.stubGlobal('fetch', vi.fn());
    const stopped = run('stopped-run', 'failed', { status: 'failed', scope: ['build'] });
    publishGraphRuns('tenant-a', 'canvas-partial', [stopped]);
    receipt({ ...finalNode, lastOutput: { ...finalNode.lastOutput!, partial: true } }, 'canvas-partial');
    const region = screen.getByRole('region', { name: '运行回执' });
    expect(within(region).getByText('最近一次没有完成这一步的运行')).toBeVisible();
    expect(within(region).getByText('1 步')).toBeVisible();
    expect(within(region).getByText('显示的是这一步中断前留下的部分内容。完整过程见「运行记录」。')).toBeVisible();
    expect(within(region).queryByText('运行完成不等于人工验收通过。完整过程见「运行记录」。')).toBeNull();
  });

  it('claims no run of this workspace for a copied case’s recording', () => {
    vi.stubGlobal('fetch', vi.fn());
    publishGraphRuns('tenant-a', 'canvas-case', [run('done-here', 'done')]);
    receipt({ ...finalNode, lastOutput: { ...finalNode.lastOutput!, source: 'case', model: 'qwen3.8-27b-p6', at: Date.UTC(2026, 9, 3) } }, 'canvas-case');
    const region = screen.getByRole('region', { name: '运行回执' });
    expect(within(region).getByText('这份交付是复制来的案例实录（qwen3.8-27b-p6 · 2026-10-03），没有在这个工作区运行；运行整张图会换成你自己的结果。')).toBeVisible();
    expect(within(region).queryByText('最近一次完成这一步的运行')).toBeNull();
  });

  it('says when there are no runs at all', () => {
    vi.stubGlobal('fetch', vi.fn());
    publishGraphRuns('tenant-a', 'canvas-none', []);
    const { rerender } = receipt(null, 'canvas-none');
    expect(screen.getByText('还没有运行记录。')).toBeVisible();
    rerender(<SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId="canvas-none" final={finalNode} /></SaaSPreferencesProvider>);
    expect(screen.getByText('没有找到这一步的运行记录。')).toBeVisible();
    expect(screen.queryByText(/最近 0 次/)).toBeNull();
  });

  it('says when the records cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: 'nope' })));
    receipt(finalNode, 'canvas-broken');
    await waitFor(() => expect(screen.getByText('暂时读不到运行记录。')).toBeVisible());
  });

  it('refuses a run record with a malformed step instead of failing the page', async () => {
    const broken = { ...run('broken', 'done'), nodes: [null, { nodeId: 'build', state: 'done' }] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [broken] })));
    receipt(finalNode, 'canvas-malformed');
    await waitFor(() => expect(screen.getByText('暂时读不到运行记录。')).toBeVisible());
  });
});
