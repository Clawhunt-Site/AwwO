// Skills on canvas nodes (canvasDoc.ts, inspectorSave.ts, NodeSkillsEditor.tsx) and rendering a delivered page as a
// video (studio/RenderVideoPanel.tsx), both against a stubbed cloud API.
import { createHash } from 'node:crypto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createSessionNode, sanitizeDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { inspectorSavedNode } from '../src/canvas/inspectorSave';
import { NodeSkillsEditor } from '../src/canvas/NodeSkillsEditor';
import { RenderVideoPanel, useRenderCapability } from '../src/canvas/studio/RenderVideoPanel';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { forgetSkillCatalog } from '../src/saas/skillsApi';

const tenant = '/api/v1/tenants/tenant-a';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const workspaceRef = `workspace:a${'b'.repeat(32)}`;
const catalog = {
  items: [
    { ref: 'builtin:code-motion', name: 'code-motion', title: 'Motion in code', titleZh: '代码动效', description: 'Animation drawn in code', descriptionZh: '用代码绘制的动画', category: 'video', applies: ['html'], version: 1, source: 'builtin', bytes: 10, contentHash: 'a' },
    { ref: 'builtin:critic', name: 'critic', title: 'Critic', titleZh: '批判审稿', description: 'Find what is wrong', descriptionZh: '找出问题', category: 'writing', applies: ['review'], version: 1, source: 'builtin', bytes: 10, contentHash: 'b' },
    { ref: 'builtin:web-research', name: 'web-research', title: 'Web research', titleZh: '网络调研', description: 'Research from sources', descriptionZh: '基于来源调研', category: 'research', applies: ['research'], version: 1, source: 'builtin', bytes: 10, contentHash: 'c' },
    { ref: 'builtin:copy-editor', name: 'copy-editor', title: 'Copy editor', titleZh: '文字编辑', description: 'Tighten copy', descriptionZh: '精简文字', category: 'writing', applies: ['writing'], version: 1, source: 'builtin', bytes: 10, contentHash: 'd' },
    { ref: workspaceRef, id: `a${'b'.repeat(32)}`, name: 'house-style', title: 'House style', description: 'Our style', category: 'writing', applies: [], version: 2, source: 'workspace', bytes: 10, contentHash: 'e' },
  ],
  limits: { maxNodeSkills: 4, maxNodeSkillBytes: 20480, maxSkillBodyBytes: 12288, maxWorkspaceSkills: 100 },
};
const scope = () => configureSaaSCanvas({ canvasId: 'canvas-a', tenant: { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 } });
function session(patch: Partial<SessionNode> = {}): SessionNode { return { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title: 'Writer', ...patch }; }
beforeEach(() => { forgetSkillCatalog('tenant-a'); });
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('skills on a node', () => {
  it('keeps distinct well-formed references, at most four, and an explicit empty list', () => {
    const doc = sanitizeDocument({ nodes: [
      { ...session(), skills: ['builtin:critic', 'builtin:critic', 'tenant:x', 'builtin:Bad', 7, workspaceRef, 'builtin:a', 'builtin:b', 'builtin:c'] },
      { ...session({ id: 'node-b' }), skills: [] },
      { ...session({ id: 'node-c' }) },
    ], edges: [] });
    const [first, second, third] = doc.nodes as SessionNode[];
    expect(first.skills).toEqual(['builtin:critic', workspaceRef, 'builtin:a', 'builtin:b']);
    expect(second.skills).toEqual([]);
    expect(Object.hasOwn(third, 'skills')).toBe(false);
  });

  it('saves the inspector draft’s skills and clears them from a media node with an explicit empty list', () => {
    const live = session({ skills: ['builtin:critic'] });
    const change = { binding: false, config: false };
    expect(inspectorSavedNode(live, { ...live, skills: ['builtin:code-motion'] }, live, change).skills).toEqual(['builtin:code-motion']);
    // An empty list, not a missing key: the server keeps a node's skills when an older client leaves the key out.
    const media = inspectorSavedNode(live, { ...live, agentKind: 'image', skills: ['builtin:code-motion'] }, live, change);
    expect(media.skills).toEqual([]);
    const plain = session();
    expect(Object.hasOwn(inspectorSavedNode(plain, { ...plain, agentKind: 'image' }, plain, change), 'skills')).toBe(false);
  });

  it('shows nothing outside a cloud canvas', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const { container } = render(<NodeSkillsEditor value={['builtin:critic']} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('attaches and removes skills from the library, up to the limit, and flags one that is gone', async () => {
    scope();
    const fetcher = vi.fn(async (url: string) => url === `${tenant}/skills` ? json(catalog) : json({}, 404)); vi.stubGlobal('fetch', fetcher);
    const changes: string[][] = [];
    function Harness({ initial }: { initial: string[] }) {
      const [refs, setRefs] = useState(initial);
      return <NodeSkillsEditor value={refs} onChange={next => { changes.push(next); setRefs(next); }} />;
    }
    render(<Harness initial={['builtin:critic', 'builtin:gone']} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('技能 builtin:gone 已不可用');
    fireEvent.click(screen.getByRole('button', { name: '移除技能 builtin:gone' }));
    expect(changes.at(-1)).toEqual(['builtin:critic']);
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '添加技能' }));
    const picker = screen.getByRole('group', { name: '为这个节点选择技能' });
    fireEvent.change(within(picker).getByRole('searchbox', { name: '搜索技能' }), { target: { value: '动效' } });
    const motion = within(picker).getByText('代码动效').closest('li')!;
    fireEvent.click(within(motion).getByRole('button', { name: '添加' }));
    expect(changes.at(-1)).toEqual(['builtin:critic', 'builtin:code-motion']);
    fireEvent.change(within(picker).getByRole('searchbox', { name: '搜索技能' }), { target: { value: '' } });
    fireEvent.click(within(within(picker).getByText('网络调研').closest('li')!).getByRole('button', { name: '添加' }));
    fireEvent.click(within(within(picker).getByText('House style').closest('li')!).getByRole('button', { name: '添加' }));
    expect(changes.at(-1)).toEqual(['builtin:critic', 'builtin:code-motion', 'builtin:web-research', workspaceRef]);
    expect(within(within(picker).getByText('文字编辑').closest('li')!).getByRole('button', { name: '添加' })).toBeDisabled();
    expect(within(picker).getByText('每个节点最多 4 个技能。')).toBeVisible();
    fireEvent.click(within(within(picker).getByText('批判审稿').closest('li')!).getByRole('button', { name: '已添加' }));
    expect(changes.at(-1)).toEqual(['builtin:code-motion', 'builtin:web-research', workspaceRef]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a node’s skills within what one call can carry', async () => {
    scope();
    const heavy = { ...catalog, items: catalog.items.map((item, index) => ({ ...item, bytes: index < 3 ? 7500 : 100 })) };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === `${tenant}/skills` ? json(heavy) : json({}, 404)));
    const changes: string[][] = [];
    function Harness() {
      const [refs, setRefs] = useState<string[]>(['builtin:code-motion', 'builtin:critic']);
      return <NodeSkillsEditor value={refs} onChange={next => { changes.push(next); setRefs(next); }} />;
    }
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: '添加技能' }));
    const picker = screen.getByRole('group', { name: '为这个节点选择技能' });
    expect(within(picker).getByRole('searchbox', { name: '搜索技能' })).toHaveFocus();
    const third = within(within(picker).getByText('网络调研').closest('li')!).getByRole('button', { name: '添加' });
    expect(third).toBeDisabled();
    expect(third).toHaveAttribute('title', '加不下了：一个节点的技能合计最多 20.0 KB。');
    fireEvent.click(within(within(picker).getByText('文字编辑').closest('li')!).getByRole('button', { name: '添加' }));
    expect(changes.at(-1)).toEqual(['builtin:code-motion', 'builtin:critic', 'builtin:copy-editor']);
    fireEvent.click(within(picker).getByRole('button', { name: '完成' }));
    expect(screen.getByRole('button', { name: '添加技能' })).toHaveFocus();
  });
});

describe('rendering a page as a video', () => {
  const capability = { enabled: true, perDay: 20, usedToday: 3, limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 6291456 } };
  const job = (patch: Record<string, unknown> = {}) => ({ id: 'render-1', canvasId: 'canvas-a', nodeId: 'node-a', status: 'queued', params: { width: 1920, height: 1080, fps: 30, seconds: 6, loop: false, gif: true, contact: false },
    htmlBytes: 40, errorCode: null, createdAt: '2026-10-15T00:00:00Z', startedAt: null, finishedAt: null, result: {}, ...patch });

  it('sends the built page, follows the job and offers the video and its files', async () => {
    scope();
    let reads = 0;
    const calls: { url: string; method: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes('/renders?nodeId=')) return json({ items: [] });
      if (String(url).endsWith('/capabilities')) return json({ render: capability, skills: { enabled: true }, memory: { enabled: true }, webReader: { enabled: false } });
      if (init.method === 'POST') return json(job(), 202);
      reads += 1;
      return json(reads < 2 ? job({ status: 'running' }) : job({ status: 'completed', result: { mode: 'contract', frames: 180, distinctFrames: 180, warnings: [], pageErrors: [],
        outputs: [{ kind: 'mp4', artifactId: 'aVideoArtifact01', name: 'motion.mp4', contentType: 'video/mp4', size: 1000 }, { kind: 'gif', artifactId: 'aGifArtifact0001', name: 'motion.gif', contentType: 'image/gif', size: 900 }] } }));
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RenderVideoPanel nodeId="node-a" pageName="hero.html" capability={capability} documentOf={() => '<!doctype html><html><body>page</body></html>'} onClose={() => {}} />);
    expect(screen.getByText(/今天已渲染 3 \/ 20 次/)).toBeVisible();
    fireEvent.click(screen.getByLabelText('同时生成 GIF'));
    fireEvent.click(screen.getByRole('button', { name: '开始渲染' }));
    await screen.findByText('正在等待渲染器…');
    const sent = calls.find(call => call.method === 'POST')!;
    expect(sent.url).toBe(`${tenant}/canvases/canvas-a/renders`);
    expect(sent.body).toMatchObject({ nodeId: 'node-a', html: '<!doctype html><html><body>page</body></html>', width: 1920, height: 1080, fps: 30, seconds: 6, gif: true, contact: false, loop: false });
    expect(sent.body.operationId).toMatch(/^render-/);
    expect(screen.getByText(/今天已渲染 4 \/ 20 次/)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    await screen.findByText('正在渲染 180 帧…');
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    await screen.findByText('已渲染 180 帧（渲染约定）。');
    expect(document.querySelector('video')?.getAttribute('src')).toBe(`${tenant}/artifacts/aVideoArtifact01/media`);
    expect(screen.getByRole('link', { name: '下载 motion.gif' })).toHaveAttribute('download', 'hero-motion.gif');
  });

  it('shows only a render made from this very page', async () => {
    scope();
    const page = '<!doctype html><html><body>this page</body></html>';
    const hash = createHash('sha256').update(page).digest('hex');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/renders?nodeId=') ? json({ items: [
      job({ id: 'other-page', status: 'completed', htmlSha256: 'f'.repeat(64), result: { frames: 99, outputs: [] } }),
      job({ id: 'this-page', status: 'failed', errorCode: 'render_page_failed', htmlSha256: hash }),
    ] }) : json({}, 500)));
    render(<RenderVideoPanel nodeId="node-a" pageName="hero.html" capability={capability} documentOf={() => page} onClose={() => {}} />);
    expect(await screen.findByText('渲染未完成：页面在渲染器里没有加载成功。')).toBeVisible();
    expect(screen.queryByText(/已渲染 99 帧/)).toBeNull();
  });

  it('looks for the page’s earlier render again once the page has been built', async () => {
    scope();
    const page = '<!doctype html><html><body>built later</body></html>';
    const hash = createHash('sha256').update(page).digest('hex');
    const lists = vi.fn(async (url: string) => String(url).includes('/renders?nodeId=') ? json({ items: [job({ status: 'completed', htmlSha256: hash, result: { mode: 'contract', frames: 48, outputs: [] } })] }) : json({}, 500));
    vi.stubGlobal('fetch', lists);
    let built: string | null = null;
    const panel = (version: number) => <RenderVideoPanel nodeId="node-a" pageName="hero.html" capability={capability} documentOf={() => built} documentVersion={version} onClose={() => {}} />;
    const { rerender } = render(panel(0));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(lists.mock.calls.some(([url]) => String(url).includes('/renders?nodeId='))).toBe(false);
    built = page;
    rerender(panel(1));
    expect(await screen.findByText('已渲染 48 帧（渲染约定）。')).toBeVisible();
  });

  it('refuses before sending when the page is not built or too large', async () => {
    scope();
    const fetcher = vi.fn(async (url: string) => String(url).includes('/renders?nodeId=') ? json({ items: [] }) : json({}, 500));
    vi.stubGlobal('fetch', fetcher);
    let page: string | null = null;
    render(<RenderVideoPanel nodeId="node-a" pageName="hero.html" capability={{ ...capability, limits: { ...capability.limits, maxHtmlBytes: 10 } }} documentOf={() => page} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '开始渲染' }));
    expect(screen.getByRole('alert')).toHaveTextContent('先打开一次页面，才能渲染。');
    page = '<html>this page is longer than ten bytes</html>';
    fireEvent.click(screen.getByRole('button', { name: '开始渲染' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('超过了渲染能接收的'));
    expect(fetcher.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(true);
  });

  it('keeps following a render through failed status reads', async () => {
    scope();
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).includes('/renders?nodeId=')) return json({ items: [] });
      if (String(url).endsWith('/capabilities')) return json({ render: { ...capability, usedToday: 4 }, skills: { enabled: true }, memory: { enabled: true }, webReader: { enabled: false } });
      if (init.method === 'POST') return json(job({ status: 'running' }), 202);
      reads += 1;
      if (reads <= 2) throw new TypeError('Failed to fetch');
      return json(job({ status: 'completed', result: { mode: 'virtual-time', frames: 72, outputs: [] } }));
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RenderVideoPanel nodeId="node-a" pageName="hero.html" capability={capability} documentOf={() => '<html><body>x</body></html>'} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '开始渲染' }));
    await screen.findByText(/正在渲染/);
    // Two failed reads back off (1.5 s, then 3 s, then 6 s) and the panel stays quiet; the third read lands.
    for (const step of [1600, 3100, 6100]) await act(async () => { await vi.advanceTimersByTimeAsync(step); });
    expect(await screen.findByText('已渲染 72 帧（虚拟时钟）。')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/今天已渲染 4 \/ 20 次/)).toBeVisible();
  });

  it('is not offered to a reader', async () => {
    configureSaaSCanvas({ canvasId: 'canvas-a', tenant: { id: 'tenant-a', name: 'A', status: 'active', role: 'reader', maxConcurrentRuns: 2, maxRunsPerDay: 10 } });
    const fetcher = vi.fn(async () => json({ render: capability, skills: { enabled: true }, memory: { enabled: true }, webReader: { enabled: false } }));
    vi.stubGlobal('fetch', fetcher);
    function Probe() { return <p>{useRenderCapability() ? 'offered' : 'not offered'}</p>; }
    render(<Probe />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByText('not offered')).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops at the daily allowance', () => {
    scope();
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [] })));
    render(<RenderVideoPanel nodeId="node-a" pageName="hero.html" capability={{ ...capability, usedToday: 20 }} documentOf={() => '<html></html>'} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: '开始渲染' })).toBeDisabled();
  });
});
