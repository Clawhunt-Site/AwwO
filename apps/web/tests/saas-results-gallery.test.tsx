import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ResultsGallery, RESULTS_GALLERY_COUNT } from '../src/saas/ResultsGallery';
import { CanvasList } from '../src/saas/CanvasList';
import { CanvasRunReceipt } from '../src/saas/CanvasRunReceipt';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { publishGraphRuns, type GraphRunSnapshot } from '../src/saas/graphRuns';
import { createSessionNode, type CanvasNode, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { parseMediaCatalogue } from '../src/canvas/mediaCatalog';

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
  it('shows the finalized plan instead of the draft when the final author uses a review template', () => {
    const final = { ...createAgentTemplate('review', { x: 0, y: 0 }), id: 'final', title: '方案检查与最终化',
      lastOutput: { text: JSON.stringify({ report: '完整的最终活动方案' }), at: now, source: 'run' as const } };
    gallery([canvas('c-plan', '活动方案', [step('draft', '活动方案拟定', 'markdown', '初稿内容'), final])]);
    const card = screen.getByRole('link', { name: /活动方案/ });
    expect(within(card).getByText('方案检查与最终化')).toBeVisible();
    expect(within(card).getByText('完整的最终活动方案')).toBeVisible();
    expect(within(card).queryByText('初稿内容')).toBeNull();
  });

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

describe('removing and deleting in the home’s 最近的成果', () => {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const inUse = () => json({ error: { code: 'resource_in_use', message: 'Active run' } }, 409);
  const delivered = (count: number) => Array.from({ length: count }, (_, index) =>
    canvas(`c${index}`, `画布 ${index}`, [step(`n${index}`, `交付 ${index}`, 'markdown', '内容', { at: now - index * 1000 })]));
  const show = (canvases: CanvasRecord[], options: { userId?: string; role?: Tenant['role']; onDeleted?: (ids: ReadonlyArray<string>) => void } = {}) =>
    <SaaSPreferencesProvider><ResultsGallery tenant={{ ...tenant, role: options.role ?? 'owner' }} canvases={canvases} userId={options.userId ?? 'user-1'} onCanvasesDeleted={options.onDeleted} /></SaaSPreferencesProvider>;
  const names = () => screen.queryAllByRole('link').map(link => within(link).getByText(/^画布 \d+$/).textContent);
  const openMenu = (name: string) => fireEvent.click(screen.getByRole('button', { name: `成果选项：${name}` }));
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  });

  it('takes a result off the list from its menu, lets the next one in, keeps it off after a reload, and undoes', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { unmount } = render(show(delivered(7)));
    expect(names()).toEqual(['画布 0', '画布 1', '画布 2', '画布 3', '画布 4', '画布 5']);
    openMenu('画布 0');
    fireEvent.click(screen.getByRole('button', { name: '从最近的成果中移除' }));
    expect(names()).toEqual(['画布 1', '画布 2', '画布 3', '画布 4', '画布 5', '画布 6']);
    expect(screen.getByRole('status')).toHaveTextContent('已从最近的成果中移除「交付 0」。画布还在');
    expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus();
    // Only this browser's list changed: nothing was sent.
    expect(fetcher).not.toHaveBeenCalled();
    unmount();
    const again = render(show(delivered(7)));
    expect(names()).not.toContain('画布 0');
    expect(screen.getByRole('button', { name: '已移除 1 项 · 全部恢复' })).toBeVisible();
    again.unmount();
    // Another person in the same browser keeps their own list.
    render(show(delivered(7), { userId: 'user-2' }));
    expect(names()).toContain('画布 0');
    cleanup();
    render(show(delivered(7)));
    fireEvent.click(screen.getByRole('button', { name: '已移除 1 项 · 全部恢复' }));
    expect(names()[0]).toBe('画布 0');
    expect(screen.getByRole('status')).toHaveTextContent('移除的成果已全部恢复');
  });

  it('undoes a removal at once, and shows a removed result again when its canvas delivers something new', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { rerender } = render(show(delivered(2)));
    openMenu('画布 1');
    fireEvent.click(screen.getByRole('button', { name: '从最近的成果中移除' }));
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(names()).toEqual(['画布 0', '画布 1']);
    openMenu('画布 1');
    fireEvent.click(screen.getByRole('button', { name: '从最近的成果中移除' }));
    expect(names()).toEqual(['画布 0']);
    const fresh = canvas('c1', '画布 1', [step('n1', '交付 1', 'markdown', '新内容', { at: now + 5000 })]);
    rerender(show([delivered(1)[0], fresh]));
    expect(names()).toEqual(['画布 1', '画布 0']);
  });

  it('says so when every result was removed, and brings them back', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(show(delivered(1)));
    openMenu('画布 0');
    fireEvent.click(screen.getByRole('button', { name: '从最近的成果中移除' }));
    expect(screen.getByText('这里的成果都移除了，画布还在上面的「继续工作」里。')).toBeVisible();
    expect(screen.queryByRole('button', { name: '管理' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '已移除 1 项 · 全部恢复' }));
    expect(names()).toEqual(['画布 0']);
  });

  it('deletes a canvas from its menu only after confirmation, and keeps it when the server refuses', async () => {
    let refuse = true; const calls: Array<[string, string]> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      calls.push([init.method ?? 'GET', input]);
      return refuse ? inUse() : new Response(null, { status: 204 });
    }));
    const onDeleted = vi.fn();
    render(show(delivered(2), { onDeleted }));
    openMenu('画布 0');
    fireEvent.click(screen.getByRole('button', { name: '删除画布…' }));
    const dialog = within(screen.getByRole('dialog', { name: '确认删除画布' }));
    expect(dialog.getByText(/确认删除“画布 0”及其全部会话和运行历史/)).toBeVisible();
    fireEvent.click(dialog.getByRole('button', { name: '取消' }));
    expect(calls).toEqual([]);
    openMenu('画布 0');
    fireEvent.click(screen.getByRole('button', { name: '删除画布…' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('正在执行');
    expect(onDeleted).not.toHaveBeenCalled();
    expect(names()).toEqual(['画布 0', '画布 1']);
    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(names()).toEqual(['画布 1']);
    expect(onDeleted).toHaveBeenCalledWith(['c0']);
    expect(calls).toEqual([['DELETE', '/api/v1/tenants/tenant-a/canvases/c0'], ['DELETE', '/api/v1/tenants/tenant-a/canvases/c0']]);
    expect(screen.getByRole('status')).toHaveTextContent('画布已删除');
  });

  it('removes or deletes several at once in 管理, and reports the canvases the server refused', async () => {
    const deletedOnServer: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      if (init.method !== 'DELETE') return json({});
      if (input.endsWith('/c3')) return inUse();
      deletedOnServer.push(input.split('/').at(-1)!);
      return new Response(null, { status: 204 });
    }));
    const onDeleted = vi.fn();
    render(show(delivered(4), { onDeleted }));
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    // Selecting: the cards tick instead of opening.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^成果选项/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择「交付 0」（画布：画布 0）' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择「交付 1」（画布：画布 1）' }));
    expect(screen.getByText('已选 2 项')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '从最近的成果中移除' }));
    expect(screen.getByRole('status')).toHaveTextContent('已从最近的成果中移除 2 项');
    expect(screen.getAllByRole('checkbox').map(box => box.getAttribute('aria-label'))).toEqual(['选择「交付 2」（画布：画布 2）', '选择「交付 3」（画布：画布 3）']);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选画布' }));
    const dialog = within(screen.getByRole('dialog', { name: '确认删除 2 张画布' }));
    expect(dialog.getAllByRole('listitem').map(item => item.textContent)).toEqual(['画布 2', '画布 3']);
    fireEvent.click(dialog.getByRole('button', { name: '确认删除' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('已删除 1 张，下面的没有删除');
    expect(alert).toHaveTextContent('画布 3：画布仍有正在执行的运行或规划');
    expect(deletedOnServer).toEqual(['c2']);
    expect(onDeleted).toHaveBeenCalledWith(['c2']);
    fireEvent.click(dialog.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(names()).toEqual(['画布 3']);
  });

  it('lets a reader take results off their own list but never offers deletion', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(show(delivered(2), { role: 'reader' }));
    openMenu('画布 0');
    expect(screen.getByRole('button', { name: '从最近的成果中移除' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '删除画布…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '从最近的成果中移除' }));
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    expect(screen.getByRole('button', { name: '从最近的成果中移除' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '删除所选画布' })).toBeNull();
  });

  it('ignores removals it cannot read and survives a browser that refuses storage', () => {
    vi.stubGlobal('fetch', vi.fn());
    localStorage.setItem('awwo.saas.results-hidden.v1:user-1:tenant-a', '{"not":"a list"}');
    render(show(delivered(1)));
    expect(names()).toEqual(['画布 0']);
    // A browser that refuses every write (private mode, a full quota).
    const own = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const real = window.localStorage;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => real.getItem(key), removeItem: (key: string) => real.removeItem(key),
      setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } } });
    try {
      openMenu('画布 0');
      fireEvent.click(screen.getByRole('button', { name: '从最近的成果中移除' }));
      expect(names()).toEqual([]);
      expect(screen.getByRole('status')).toHaveTextContent('这个浏览器不允许保存，刷新页面后它们会重新显示');
    } finally {
      if (own) Object.defineProperty(window, 'localStorage', own); else delete (window as { localStorage?: Storage }).localStorage;
    }
    expect(real.getItem('awwo.saas.results-hidden.v1:user-1:tenant-a')).toBe('{"not":"a list"}');
  });

  it('has the canvas list read the server again when 最近的成果 deleted canvases', async () => {
    const fetcher = vi.fn(async () => json({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetcher);
    const list = (reloadSignal: number) => <SaaSPreferencesProvider><CanvasList tenant={tenant} onOpen={vi.fn()} reloadSignal={reloadSignal} /></SaaSPreferencesProvider>;
    const { rerender } = render(list(0));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    rerender(list(0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    rerender(list(1));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
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

  it('names a media step’s model only generically and the others by the canvas’s labels, never by a media model’s id', () => {
    vi.stubGlobal('fetch', vi.fn());
    const media = (id: string, kind: 'image' | 'video', model: string): SessionNode =>
      ({ ...createSessionNode(kind, { x: 0, y: 0 }), id, title: id, runtime: 'openai-agents', model });
    const made = run('media-run', 'done', {
      scope: ['build', 'clip', 'still-1', 'still-2'],
      nodes: [{ nodeId: 'build', state: 'done' }, { nodeId: 'clip', state: 'done' }, { nodeId: 'still-1', state: 'done' }, { nodeId: 'still-2', state: 'failed' }],
      document: { version: 2, updatedAt: 1, waypoints: [], view: null, edges: [], nodes: [{ ...finalNode, runtime: 'pi', model: 'bedrock.claude-opus-5-5' },
        media('clip', 'video', 'xt.xtasy-v3'), media('still-1', 'image', 'xt.seedream-5-pro'), media('still-2', 'image', 'xt.seedream-5-pro')] },
    });
    publishGraphRuns('tenant-a', 'canvas-media', [made]);
    const names = {
      models: [{ key: 'opus', runtime: 'pi' as const, model: 'bedrock.claude-opus-5-5', label: 'Claude Opus 5.5', providerGroup: 'claude' as const, available: true }],
      media: parseMediaCatalogue({ configured: true, available: true, models: [{ id: 'xt.seedream-5-pro', name: 'seedream 5 pro', label: ['图片 · 高清', 'Image · HD'],
        vendor: 'xtasy', kind: 'image', prompt: { minLength: 1, maxLength: 2000 }, params: [] }] }),
    };
    const shown = (withNames: boolean) => <SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId="canvas-media" final={finalNode}
      {...(withNames ? { names } : {})} /></SaaSPreferencesProvider>;
    const { rerender } = render(shown(true));
    let region = screen.getByRole('region', { name: '运行回执' });
    // The clip's model is not in this catalogue, so its kind names it; the two pictures share one generic name.
    expect(within(region).getByText('Claude Opus 5.5（1 步），视频（1 步），图片 · 高清（2 步）')).toBeVisible();
    expect(region.innerHTML).not.toMatch(/xt\.|xtasy|seedream|bedrock/i);
    // A host that cannot name models still never shows a media model's id; a chat model keeps its selector, as before.
    rerender(shown(false));
    region = screen.getByRole('region', { name: '运行回执' });
    expect(within(region).getByText('bedrock.claude-opus-5-5（1 步），视频（1 步），图片（2 步）')).toBeVisible();
    expect(region.innerHTML).not.toMatch(/xt\.|xtasy|seedream/i);
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
