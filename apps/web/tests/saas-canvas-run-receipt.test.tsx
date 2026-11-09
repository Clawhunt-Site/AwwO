import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasRunReceipt } from '../src/saas/CanvasRunReceipt';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { publishGraphRuns, type GraphRunSnapshot } from '../src/saas/graphRuns';
import { graphRunSummary } from './saas-graph-run-summary-fixture';
import { createSessionNode, type CanvasNode, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { parseMediaCatalogue } from '../src/canvas/mediaCatalog';

// The 成果 view's run receipt (CanvasRunReceipt.tsx): the run it names for the result's step, what it says of that run
// (from the run panel's poll, and from the run's own read once that comes), and what it reads to say it.
const now = Date.now();
const page = (text: string) => `<!doctype html><html><head><title>${text}</title><script>alert(1)</script></head><body><h1>${text}</h1></body></html>`;
function step(id: string, title: string, type: 'markdown' | 'html', output?: string, extra: Partial<NodeOutput> = {}): SessionNode {
  return { ...createSessionNode('llm', { x: 0, y: 0 }), id, title,
    contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: title, type, required: true, value: '' }] },
    lastOutput: output === undefined ? null : { text: JSON.stringify({ result: output }), at: now - 60_000, source: 'run', ...extra } };
}
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the 成果 view’s run receipt', () => {
  const finalNode = step('build', '可玩试玩关', 'html', page('Fox'));
  const run = (id: string, state: GraphRunSnapshot['nodes'][number]['state'], extra: Partial<GraphRunSnapshot> = {}): GraphRunSnapshot => ({
    id, operationId: `op-${id}`, canvasId: 'canvas-a', documentVersion: 1, scope: ['design', 'build'], status: 'completed', createdAt: '2026-10-05T06:00:00Z', updatedAt: '2026-10-05T06:03:12Z',
    nodes: [{ nodeId: 'design', state: 'cached' }, { nodeId: 'build', state }],
    document: { version: 2, updatedAt: 1, waypoints: [], view: null, edges: [], nodes: [{ ...finalNode, model: 'qwen3.8-27b-p6' }, { ...step('design', '玩法与数值', 'markdown'), model: 'qwen3.8-27b-p6' }] }, ...extra });
  const receipt = (final: CanvasNode | null = finalNode, canvasId = 'canvas-a') => render(<SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId={canvasId} final={final} /></SaaSPreferencesProvider>);
  // The panel's poll publishes the list's summaries; each run's own route answers whole, with the canvas it froze.
  const publish = (canvasId: string, runs: GraphRunSnapshot[]) => publishGraphRuns('tenant-a', canvasId, runs.map(graphRunSummary));
  const serve = (...runs: GraphRunSnapshot[]) => vi.fn(async (url: string) => {
    const found = runs.find(item => url.endsWith(`/graph-runs/${item.id}`));
    return found ? Response.json(found) : Response.json({ error: { code: 'not_found', message: 'Resource not found' } }, { status: 404 });
  });

  it('reads the run panel’s poll and names the latest run that completed the result’s step, without claiming more', async () => {
    const done = run('done-run-123456', 'done');
    const fetcher = serve(done); vi.stubGlobal('fetch', fetcher);
    publish('canvas-a', [run('newer-failed', 'failed', { status: 'failed' }), done]);
    receipt();
    const region = screen.getByRole('region', { name: '运行回执' });
    expect(await within(region).findByText('最近一次完成这一步的运行')).toBeVisible();
    // The whole canvas ran: its two steps are both in scope.
    expect(within(region).getByText('整张画布')).toBeVisible();
    expect(within(region).getByText('完成')).toBeVisible();
    expect(within(region).getByText('3 分 12 秒')).toBeVisible();
    expect(within(region).getByText('1 步完成 · 1 步沿用上次结果')).toBeVisible();
    expect(within(region).getByText('qwen3.8-27b-p6（1 步）')).toBeVisible();
    expect(within(region).getByText('done-run-1')).toBeVisible();
    expect(within(region).getByText('运行完成不等于人工验收通过。完整过程见「运行记录」。')).toBeVisible();
    // The list is the panel's read; the receipt reads only the run it names, for the canvas that run froze.
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/done-run-123456']);
  });

  it('names a media step’s model only generically and the others by the canvas’s labels, never by a media model’s id', async () => {
    const media = (id: string, kind: 'image' | 'video', model: string): SessionNode =>
      ({ ...createSessionNode(kind, { x: 0, y: 0 }), id, title: id, runtime: 'openai-agents', model });
    const made = run('media-run', 'done', {
      scope: ['build', 'clip', 'still-1', 'still-2'],
      nodes: [{ nodeId: 'build', state: 'done' }, { nodeId: 'clip', state: 'done' }, { nodeId: 'still-1', state: 'done' }, { nodeId: 'still-2', state: 'failed' }],
      document: { version: 2, updatedAt: 1, waypoints: [], view: null, edges: [], nodes: [{ ...finalNode, runtime: 'pi', model: 'bedrock.claude-opus-5-5' },
        media('clip', 'video', 'xt.xtasy-v3'), media('still-1', 'image', 'xt.seedream-5-pro'), media('still-2', 'image', 'xt.seedream-5-pro')] },
    });
    vi.stubGlobal('fetch', serve(made));
    publish('canvas-media', [made]);
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
    expect(await within(region).findByText('Claude Opus 5.5（1 步），视频（1 步），图片 · 高清（2 步）')).toBeVisible();
    expect(region.innerHTML).not.toMatch(/xt\.|xtasy|seedream|bedrock/i);
    // A host that cannot name models still never shows a media model's id; a chat model keeps its selector, as before.
    rerender(shown(false));
    region = screen.getByRole('region', { name: '运行回执' });
    expect(within(region).getByText('bedrock.claude-opus-5-5（1 步），视频（1 步），图片（2 步）')).toBeVisible();
    expect(region.innerHTML).not.toMatch(/xt\.|xtasy|seedream/i);
  });

  it('reads the runs itself, once, when nothing has read them yet, and follows later polls', async () => {
    const first = run('first', 'done'); const second = run('second-run', 'done');
    const fetcher = vi.fn(async (url: string) => url.endsWith('/graph-runs') ? Response.json({ items: [graphRunSummary(first)] })
      : Response.json(url.endsWith('/second-run') ? second : first));
    vi.stubGlobal('fetch', fetcher);
    const lists = () => fetcher.mock.calls.filter(([url]) => url.endsWith('/graph-runs')).length;
    receipt(finalNode, 'canvas-fresh');
    await screen.findByText('first'.slice(0, 10));
    expect(lists()).toBe(1);
    act(() => publish('canvas-fresh', [second, first]));
    expect(await screen.findByText('second-run')).toBeVisible();
    expect(lists()).toBe(1);
  });

  // A run's frozen canvas never changes: the receipt reads it once, however often the panel's poll comes back.
  it('reads the frozen canvas of the run it names once, not on every poll', async () => {
    const done = run('read-once', 'done');
    const fetcher = serve(done); vi.stubGlobal('fetch', fetcher);
    publish('canvas-once', [done]);
    receipt(finalNode, 'canvas-once');
    expect(await screen.findByText('整张画布')).toBeVisible();
    for (let poll = 0; poll < 3; poll++) act(() => publish('canvas-once', [done]));
    cleanup();
    // Shown again on the same page, it is read from what this page has already read.
    receipt(finalNode, 'canvas-once');
    expect(screen.getByText('整张画布')).toBeVisible();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  // The reader rates the result of the run the step made, which the run's own read names: no second read of the run.
  it('lets the reader rate the step’s result, from the one read of the run it names', async () => {
    const done = run('rated-run', 'done', { nodes: [{ nodeId: 'design', state: 'cached' }, { nodeId: 'build', state: 'done', runId: 'step-run-1' }] });
    let rating = 0;
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/graph-runs/rated-run')) return Response.json(done);
      if (url === '/api/v1/tenants/tenant-a/runs/step-run-1/rating') {
        if (init.method === 'PUT') rating = JSON.parse(String(init.body)).rating;
        return Response.json({ runId: 'step-run-1', rating });
      }
      return Response.json({ error: { code: 'not_found', message: 'Resource not found' } }, { status: 404 });
    }));
    publish('canvas-rated', [done]);
    receipt(finalNode, 'canvas-rated');
    const region = screen.getByRole('region', { name: '运行回执' });
    const thumbs = await within(region).findByRole('group', { name: '这次的结果' });
    const up = within(thumbs).getByRole('button', { name: '好' });
    await waitFor(() => expect(calls.map(call => call.url)).toContain('/api/v1/tenants/tenant-a/runs/step-run-1/rating'));
    fireEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute('aria-pressed', 'true'));
    expect(calls.filter(call => call.method === 'PUT')).toEqual([{ url: '/api/v1/tenants/tenant-a/runs/step-run-1/rating', method: 'PUT', body: { rating: 1 } }]);
    expect(calls.filter(call => call.url.includes('/graph-runs/'))).toHaveLength(1);
  });

  // A read taken while the run was going saw its steps as they were then: one waiting to be retried after a failed
  // attempt names that attempt's run, not the one that completed it.
  it('reads a going run again, without its canvas, for a step that ended after the read', async () => {
    const design = step('design', '玩法与数值', 'markdown', '数值表');
    const going = run('going-run', 'running', { status: 'running', nodes: [{ nodeId: 'design', state: 'done', runId: 'design-run' }, { nodeId: 'build', state: 'waiting', runId: 'attempt-1' }] });
    const ended = { ...going, status: 'completed' as const, nodes: [{ nodeId: 'design', state: 'done' as const, runId: 'design-run' }, { nodeId: 'build', state: 'done' as const, runId: 'build-run' }] };
    const reads: string[] = [];
    const ratings: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/graph-runs/going-run')) {
        reads.push(url);
        const { document: _held, ...light } = ended;
        return Response.json(reads.length === 1 ? going : light);
      }
      ratings.push(url);
      return Response.json({ runId: url.split('/').at(-2), rating: 0 });
    }));
    publish('canvas-going', [going]);
    receipt(design, 'canvas-going');
    expect(await screen.findByRole('group', { name: '这次的结果' })).toBeVisible();
    cleanup();
    publish('canvas-going', [ended]);
    receipt(finalNode, 'canvas-going');
    // The canvas held from the first read is shown at once; the step's run comes from the second.
    expect(screen.getByText('整张画布')).toBeVisible();
    expect(await screen.findByRole('group', { name: '这次的结果' })).toBeVisible();
    expect(reads).toEqual(['/api/v1/tenants/tenant-a/canvases/canvas-going/graph-runs/going-run',
      '/api/v1/tenants/tenant-a/canvases/canvas-going/graph-runs/going-run?document=false']);
    await waitFor(() => expect(ratings).toEqual(['/api/v1/tenants/tenant-a/runs/design-run/rating', '/api/v1/tenants/tenant-a/runs/build-run/rating']));
  });

  // A read again that fails is tried again a few seconds later: the list's poll may bring nothing new to try it.
  it('tries a failed read again of a going run, for a step that ended after the first', async () => {
    const design = step('design', '玩法与数值', 'markdown', '数值表');
    const going = run('retry-run', 'running', { status: 'running', nodes: [{ nodeId: 'design', state: 'done', runId: 'design-run' }, { nodeId: 'build', state: 'waiting', runId: 'attempt-1' }] });
    const ended = { ...going, status: 'completed' as const, nodes: [{ nodeId: 'design', state: 'done' as const, runId: 'design-run' }, { nodeId: 'build', state: 'done' as const, runId: 'build-run' }] };
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/graph-runs/retry-run')) {
        reads++;
        if (reads === 2) return Response.json({ error: { code: 'internal_error', message: 'down' } }, { status: 500 });
        const { document: _held, ...light } = ended;
        return Response.json(reads === 1 ? going : light);
      }
      return Response.json({ runId: url.split('/').at(-2), rating: 0 });
    }));
    publish('canvas-retry', [going]);
    receipt(design, 'canvas-retry');
    expect(await screen.findByRole('group', { name: '这次的结果' })).toBeVisible();
    cleanup();
    publish('canvas-retry', [ended]);
    receipt(finalNode, 'canvas-retry');
    expect(await screen.findByRole('group', { name: '这次的结果' }, { timeout: 6000 })).toBeVisible();
    expect(reads).toBe(3);
  }, 10000);

  // Unread, the receipt says only what the list says: the steps in the run's scope, and no models.
  it('says what the list says of the run when its own read fails, and claims nothing from the canvas it froze', async () => {
    vi.stubGlobal('fetch', serve());
    publish('canvas-unread', [run('unread-run', 'done')]);
    receipt(finalNode, 'canvas-unread');
    const region = screen.getByRole('region', { name: '运行回执' });
    expect(await within(region).findByText('2 步')).toBeVisible();
    expect(within(region).getByText('最近一次完成这一步的运行')).toBeVisible();
    expect(within(region).queryByText('整张画布')).toBeNull();
    expect(within(region).queryByText('模型')).toBeNull();
  });

  it('says plainly when no run produced the result', async () => {
    vi.stubGlobal('fetch', vi.fn());
    publish('canvas-b', [run('other', 'cached')]);
    const { rerender } = receipt(finalNode, 'canvas-b');
    expect(screen.getByText('最近 1 次运行里没有完成这一步的记录。')).toBeVisible();
    rerender(<SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId="canvas-b" final={{ ...finalNode, lastOutput: { ...finalNode.lastOutput!, source: 'manual' } }} /></SaaSPreferencesProvider>);
    expect(screen.getByText('这份交付是手动发布的，没有对应的运行记录。')).toBeVisible();
    // With nothing delivered it reports only what the records say: the latest run, not a claim about completion.
    rerender(<SaaSPreferencesProvider><CanvasRunReceipt tenantId="tenant-a" canvasId="canvas-b" final={null} /></SaaSPreferencesProvider>);
    expect(screen.getByText(/^最近一次运行：完成 · /)).toBeVisible();
    expect(screen.queryByText(/没有完成的运行/)).toBeNull();
  });

  it('names the run in which a partial result’s step stopped, and a run that covered only some steps', async () => {
    const stopped = run('stopped-run', 'failed', { status: 'failed', scope: ['build'] });
    vi.stubGlobal('fetch', serve(stopped));
    publish('canvas-partial', [stopped]);
    receipt({ ...finalNode, lastOutput: { ...finalNode.lastOutput!, partial: true } }, 'canvas-partial');
    const region = screen.getByRole('region', { name: '运行回执' });
    expect(await within(region).findByText('最近一次没有完成这一步的运行')).toBeVisible();
    expect(within(region).getByText('1 步')).toBeVisible();
    expect(within(region).getByText('显示的是这一步中断前留下的部分内容。完整过程见「运行记录」。')).toBeVisible();
    expect(within(region).queryByText('运行完成不等于人工验收通过。完整过程见「运行记录」。')).toBeNull();
  });

  it('claims no run of this workspace for a copied case’s recording', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    publish('canvas-case', [run('done-here', 'done')]);
    receipt({ ...finalNode, lastOutput: { ...finalNode.lastOutput!, source: 'case', model: 'qwen3.8-27b-p6', at: Date.UTC(2026, 9, 3) } }, 'canvas-case');
    const region = screen.getByRole('region', { name: '运行回执' });
    expect(within(region).getByText('这份交付是复制来的案例实录（qwen3.8-27b-p6 · 2026-10-03），没有在这个工作区运行；运行整张图会换成你自己的结果。')).toBeVisible();
    expect(within(region).queryByText('最近一次完成这一步的运行')).toBeNull();
    // Nor does it read a run it does not name.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('says when there are no runs at all', () => {
    vi.stubGlobal('fetch', vi.fn());
    publish('canvas-none', []);
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
    const broken = { ...graphRunSummary(run('broken', 'done')), nodes: [null, { nodeId: 'build', state: 'done' }] };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [broken] })));
    receipt(finalNode, 'canvas-malformed');
    await waitFor(() => expect(screen.getByText('暂时读不到运行记录。')).toBeVisible());
  });
});
