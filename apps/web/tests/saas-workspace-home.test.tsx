import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CanvasRecord, Identity, Tenant } from '../src/saas/api';
import { PLAN_HANDOFF_PREFIX, takePlanHandoff } from '../src/saas/planHandoff';
import { readHomeDraft, saveHomeDraft } from '../src/saas/homePrompt';
import { STARTER_CASES } from '../src/saas/starterCases';

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
const draftScope = { user: 'user-a', tenant: 'tenant-a' };
const ready = { available: true, configured: true, plannerAvailable: true, models: [{ id: 'fixture-model' }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const record = (id: string, name: string, updatedAt = '2026-09-07T00:00:00Z'): CanvasRecord =>
  ({ id, tenantId: tenant.id, name, version: 1, document: { nodes: [] }, createdAt: '2026-09-01T00:00:00Z', updatedAt });
const example = (id: string) => STARTER_CASES.find(item => item.id === id)!;
const handoffs = () => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter(key => key?.startsWith(PLAN_HANDOFF_PREFIX));

function server({ canvases = [], create, runtime = ready }: { canvases?: CanvasRecord[]; create?: (body: any) => Response | Promise<Response>; runtime?: unknown } = {}) {
  const posts: any[] = [];
  const fetcher = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('/runtime')) return json(runtime);
    if (url.pathname.endsWith('/canvases') && init.method === 'POST') {
      const body = JSON.parse(init.body as string);
      posts.push(body);
      return create ? create(body) : json({ ...record('new-canvas', body.name), document: body.document }, 201);
    }
    if (url.pathname.endsWith('/canvases')) return json({ items: canvases, nextCursor: null });
    return json({ error: { message: `Unexpected ${url.pathname}` } }, 404);
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, posts };
}
const view = ({ role = 'owner', onOpen = vi.fn() }: { role?: string; onOpen?: (id: string) => void } = {}) =>
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={{ ...tenant, role }} onOpen={onOpen} /></SaaSPreferencesProvider>);
const box = () => screen.getByRole('textbox', { name: '画布需求' });
const openExamples = () => fireEvent.click(screen.getByRole('button', { name: '需要灵感？看看案例' }));

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); });

it('keeps the request on the page when the browser refuses to store it for the new canvas', async () => {
  const { posts } = server();
  const onOpen = vi.fn();
  view({ onOpen });
  fireEvent.change(box(), { target: { value: '搭建采购审批工具' } });
  const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  fireEvent.keyDown(box(), { key: 'Enter' });
  const alert = await screen.findByRole('alert');
  // The canvas exists, but leaving would open it with an empty prompt box and lose the request.
  expect(alert).toHaveTextContent('已新建画布「搭建采购审批工具」，但这个浏览器不允许暂存需求');
  expect(posts).toHaveLength(1);
  expect(onOpen).not.toHaveBeenCalled();
  expect(box()).toHaveValue('搭建采购审批工具');
  expect(box()).not.toHaveAttribute('readonly');
  refuse.mockRestore();
  fireEvent.click(within(alert).getByRole('button', { name: '打开画布' }));
  expect(onOpen).toHaveBeenCalledWith('new-canvas');
});

it('creates one canvas named after the request, hands the request to it and opens it on Enter', async () => {
  const { posts } = server();
  const onOpen = vi.fn();
  view({ onOpen });
  expect(screen.getByRole('heading', { level: 1, name: '想一起搭建什么？' })).toBeVisible();
  expect(screen.getByText('Workspace A')).toBeVisible();
  // The page never grabs focus: a returning operator lands on the whole page, not the keyboard.
  expect(box()).not.toHaveFocus();
  expect(box()).toHaveAttribute('maxlength', '8000');
  expect(box()).toHaveAttribute('enterkeyhint', 'send');
  expect(box()).toHaveAccessibleDescription('Enter 发送 · Shift+Enter 换行');
  fireEvent.change(box(), { target: { value: '  请帮我搭建销售周报流程：先统一口径\n再汇总  ' } });
  expect(readHomeDraft(draftScope)).toBe('  请帮我搭建销售周报流程：先统一口径\n再汇总  ');
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('new-canvas'));
  expect(posts).toHaveLength(1);
  expect(posts[0].name).toBe('搭建销售周报流程');
  expect(posts[0].document).toMatchObject({ version: 2, nodes: [], edges: [] });
  expect(takePlanHandoff({ ...draftScope, canvas: 'new-canvas' })).toEqual({ prompt: '请帮我搭建销售周报流程：先统一口径\n再汇总', start: true, interrupted: false });
  expect(readHomeDraft(draftScope)).toBe('');
});

it('never sends on Shift+Enter or a composing Enter, and sends once however fast Enter repeats', async () => {
  let release!: (response: Response) => void;
  const { posts } = server({ create: () => new Promise<Response>(resolve => { release = resolve; }) });
  const onOpen = vi.fn();
  view({ onOpen });
  fireEvent.change(box(), { target: { value: '做一个任务看板' } });
  fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
  fireEvent.compositionStart(box());
  fireEvent.keyDown(box(), { key: 'Enter' });
  fireEvent.compositionEnd(box());
  fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
  expect(posts).toHaveLength(0);
  fireEvent.keyDown(box(), { key: 'Enter' });
  fireEvent.keyDown(box(), { key: 'Enter' });
  fireEvent.submit(box().closest('form')!);
  expect(posts).toHaveLength(1);
  expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '空白画布' })).toBeDisabled();
  await act(async () => release(json(record('new-canvas', '做一个任务看板'), 201)));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(posts).toHaveLength(1);
});

it('keeps the request and hands nothing over when the canvas cannot be created', async () => {
  const { posts } = server({ create: () => json({ error: { message: 'network save failed' } }, 503) });
  const onOpen = vi.fn();
  view({ onOpen });
  fireEvent.change(box(), { target: { value: 'keep this request' } });
  fireEvent.click(screen.getByRole('button', { name: '生成画布' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('network save failed');
  expect(box()).toHaveValue('keep this request');
  expect(box()).not.toHaveAttribute('readonly');
  expect(box()).toHaveAccessibleDescription(/network save failed/);
  expect(posts).toHaveLength(1);
  expect(handoffs()).toEqual([]);
  expect(readHomeDraft(draftScope)).toBe('keep this request');
  expect(onOpen).not.toHaveBeenCalled();
  // Typing again clears the stale failure.
  fireEvent.change(box(), { target: { value: 'keep this request, edited' } });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('creates an untitled blank canvas without planning, keeping the typed request for later', async () => {
  const { posts } = server();
  const onOpen = vi.fn();
  view({ onOpen });
  fireEvent.change(box(), { target: { value: '稍后再写的需求' } });
  fireEvent.click(screen.getByRole('button', { name: '空白画布' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('new-canvas'));
  expect(posts).toEqual([{ name: '未命名', document: expect.objectContaining({ version: 2, nodes: [], edges: [] }) }]);
  expect(handoffs()).toEqual([]);
  expect(readHomeDraft(draftScope)).toBe('稍后再写的需求');
});

it('filters examples by category and fills the box without creating or planning anything', async () => {
  const { posts } = server();
  view();
  const toggle = screen.getByRole('button', { name: '需要灵感？看看案例' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: '从案例开始' })).toBeNull();
  openExamples();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const gallery = within(screen.getByRole('region', { name: '从案例开始' }));
  expect(gallery.getAllByRole('listitem')).toHaveLength(11);
  expect(gallery.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(gallery.getByRole('button', { name: '数据分析' }));
  expect(gallery.getByRole('button', { name: '数据分析' })).toHaveAttribute('aria-pressed', 'true');
  expect(gallery.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'false');
  expect(gallery.getAllByRole('listitem')).toHaveLength(2);
  const churn = example('subscription-churn');
  const card = gallery.getByRole('button', { name: churn.title.zh });
  expect(card).toHaveAccessibleDescription(churn.summary.zh);
  fireEvent.click(card);
  expect(box()).toHaveValue(churn.prompt.zh);
  expect(box()).toHaveFocus();
  expect((box() as HTMLTextAreaElement).selectionStart).toBe(churn.prompt.zh.length);
  expect(screen.getByText(`已填入案例「${churn.title.zh}」，可以直接生成，也可以先修改。`).closest('[role="status"]')).not.toBeNull();
  expect(readHomeDraft(draftScope)).toBe(churn.prompt.zh);
  fireEvent.click(gallery.getByRole('button', { name: '全部' }));
  expect(gallery.getAllByRole('listitem')).toHaveLength(11);
  expect(posts).toHaveLength(0);
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: '从案例开始' })).toBeNull();
});

it('names the canvas after an example sent unedited, and after the request once it is edited', async () => {
  const { posts } = server();
  const onOpen = vi.fn();
  view({ onOpen });
  const saas = example('team-collaboration-saas');
  openExamples();
  fireEvent.click(screen.getByRole('button', { name: saas.title.zh }));
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  expect(posts[0].name).toBe('团队协作 SaaS');
  expect(takePlanHandoff({ ...draftScope, canvas: 'new-canvas' })?.prompt).toBe(saas.prompt.zh);

  cleanup(); sessionStorage.clear();
  view({ onOpen });
  openExamples();
  fireEvent.click(screen.getByRole('button', { name: saas.title.zh }));
  fireEvent.change(box(), { target: { value: saas.prompt.zh.replace('中小团队', '设计团队') } });
  fireEvent.keyDown(box(), { key: 'Enter' });
  await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
  expect(posts[1].name).toBe('做一个面向设计团队的任务协作 SaaS');
});

it('sets the operator’s own text aside when an example replaces it, and restores it on request', () => {
  server();
  view();
  fireEvent.change(box(), { target: { value: '我自己的需求' } });
  openExamples();
  fireEvent.click(screen.getByRole('button', { name: example('monthly-content-calendar').title.zh }));
  // A second example replaces the first; the text worth restoring is still the operator's.
  fireEvent.click(screen.getByRole('button', { name: example('launch-content-kit').title.zh }));
  expect(box()).toHaveValue(example('launch-content-kit').prompt.zh);
  fireEvent.click(screen.getByRole('button', { name: '恢复原输入' }));
  expect(box()).toHaveValue('我自己的需求');
  expect(box()).toHaveFocus();
  expect(screen.getByText('已恢复原来的输入。')).toBeVisible();
  expect(screen.queryByRole('button', { name: '恢复原输入' })).toBeNull();
  expect(readHomeDraft(draftScope)).toBe('我自己的需求');
  // An example chosen over an empty box offers nothing to restore.
  fireEvent.change(box(), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: example('policy-briefing').title.zh }));
  expect(screen.queryByRole('button', { name: '恢复原输入' })).toBeNull();
});

it('gives readers the canvas list without a prompt box or examples, and reads no runtime', async () => {
  const { fetcher } = server({ canvases: [record('canvas-1', 'Reader canvas')] });
  view({ role: 'reader' });
  expect(await screen.findByRole('heading', { name: 'Reader canvas' })).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: 'Workspace A' })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: '画布需求' })).toBeNull();
  expect(screen.queryByRole('button', { name: '空白画布' })).toBeNull();
  expect(screen.queryByRole('button', { name: '需要灵感？看看案例' })).toBeNull();
  expect(screen.queryByRole('region', { name: '从案例开始' })).toBeNull();
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['/api/v1/tenants/tenant-a/canvases?limit=50']);
});

it('reads in English', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  server({ canvases: [record('canvas-1', 'Launch plan')] });
  view();
  expect(screen.getByRole('heading', { level: 1, name: 'What would you like to build together?' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Canvas request' })).toHaveAttribute('placeholder', 'Describe your goal, required capabilities, and deliverables…');
  expect(screen.getByRole('button', { name: 'Generate canvas' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Blank canvas' })).toBeEnabled();
  expect(await screen.findByRole('heading', { name: 'Continue working' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Need inspiration? Explore examples' }));
  const gallery = within(screen.getByRole('region', { name: 'Start from an example' }));
  fireEvent.click(gallery.getByRole('button', { name: 'Research reports' }));
  fireEvent.click(gallery.getByRole('button', { name: example('competitor-research').title.en }));
  expect(screen.getByRole('textbox', { name: 'Canvas request' })).toHaveValue(example('competitor-research').prompt.en);
  expect(screen.getByText('Filled in the “Competitor research report” example. Generate it as is, or edit it first.')).toBeVisible();
});

it('says before sending when the canvas will not be able to plan yet', async () => {
  server({ runtime: { available: false, configured: true, plannerAvailable: false, reason: 'No configured runtime is available', models: [] } });
  view();
  const note = await screen.findByText('规划暂不可用：当前没有可用的执行引擎。仍会新建画布，需求会保留在画布输入框中。');
  expect(note).toBeVisible();
  expect(box()).toHaveAccessibleDescription(/规划暂不可用/);
  expect(screen.getByRole('button', { name: '空白画布' })).toBeEnabled();
});

it('shows no planning warning when the engine and planner are ready', async () => {
  const { fetcher } = server();
  view();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/runtime'))).toBe(true));
  await screen.findByRole('heading', { name: '继续工作' });
  expect(screen.queryByText(/规划暂不可用/)).toBeNull();
});

it('keeps an unsent request in this tab, and a page restored from the back/forward cache is usable again', async () => {
  saveHomeDraft(draftScope, '上次没发的需求');
  let release!: (response: Response) => void;
  server({ create: () => new Promise<Response>(resolve => { release = resolve; }) });
  const onOpen = vi.fn();
  view({ onOpen });
  expect(box()).toHaveValue('上次没发的需求');
  fireEvent.keyDown(box(), { key: 'Enter' });
  await act(async () => release(json(record('new-canvas', '上次没发的需求'), 201)));
  expect(onOpen).toHaveBeenCalledWith('new-canvas');
  // The browser left for the canvas and came back with this page frozen mid-send.
  expect(screen.getByRole('button', { name: '正在创建…' })).toBeDisabled();
  const restored = new Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  act(() => { window.dispatchEvent(restored); });
  expect(box()).toHaveValue('');
  expect(box()).not.toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '空白画布' })).toBeEnabled();
});


it('quick starters only fill a draft and let the user restore their own words before sending', async () => {
  const { posts } = server(); const onOpen = vi.fn(); view({ onOpen });
  fireEvent.change(box(), { target: { value: '我的原始任务' } });
  const starter = example('weekly-sales-report');
  fireEvent.click(screen.getByRole('button', { name: `填写示例：${starter.title.zh}` }));
  expect(box()).toHaveValue(starter.prompt.zh);
  expect(box()).toHaveFocus();
  expect(posts).toHaveLength(0); expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '恢复原输入' }));
  expect(box()).toHaveValue('我的原始任务');
  expect(readHomeDraft(draftScope)).toBe('我的原始任务');
  expect(posts).toHaveLength(0);
});
