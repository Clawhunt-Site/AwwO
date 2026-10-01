import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OfficialExamples } from '../src/saas/examples/OfficialExamples';
import { OFFICIAL_WORKFLOWS } from '../src/saas/examples/officialWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import { SaaSApp } from '../src/saas/SaaSApp';
import { saveHomeDraft, readHomeDraft } from '../src/saas/homePrompt';
import { PLAN_HANDOFF_PREFIX } from '../src/saas/planHandoff';
import { rememberOfficialSelection, readOfficialSelection, officialSignInURL } from '../src/saas/examples/officialSelection';
import { clawHuntStartURL } from '../src/saas/clawhuntAuth';
import type { Identity, Tenant } from '../src/saas/api';

const first = OFFICIAL_WORKFLOWS[0];
const tenant: Tenant = { id: 'official-workspace', name: 'Examples workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-examples', name: 'Example', email: 'example@example.test', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const view = (props = {}) => render(<SaaSPreferencesProvider><OfficialExamples {...props} /></SaaSPreferencesProvider>);

it('starts with twelve flagship systems and filters capabilities without creating or running anything', () => {
  const onReuse = vi.fn(); view({ onReuse });
  expect(screen.getAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(12);
  fireEvent.click(screen.getByRole('button', { name: /^模型与实验/ }));
  expect(screen.getAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(1);
  expect(screen.getByRole('button', { name: `查看官方案例：${OFFICIAL_WORKFLOWS.find(item => item.tier === 'flagship' && item.category === 'training')!.title.zh}` })).toBeVisible();
  expect(onReuse).not.toHaveBeenCalled();
});

it('exposes the real graph and each selected node contract with keyboard accessible tabs', async () => {
  view({ initialId: first.id });
  fireEvent.click(screen.getByRole('tab', { name: '编排画布' }));
  const panel = screen.getByRole('tabpanel');
  const graph = screen.getByLabelText('工作流画布，可横向滚动并选择节点');
  const last = first.nodes.at(-1)!;
  fireEvent.click(within(graph).getByRole('button', { name: new RegExp(last.title.zh) }));
  expect(within(panel).getByRole('heading', { name: last.title.zh })).toBeVisible();
  expect(within(panel).getByText(last.task.zh)).toBeVisible();
  expect(within(panel).getByText(last.acceptance[0].zh)).toBeVisible();
  fireEvent.keyDown(screen.getByRole('tab', { name: '编排画布' }), { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: '复用指南' })).toHaveFocus();
  expect(screen.getByRole('button', { name: '下载画布 JSON' })).toBeVisible();
});

it('provides a public gallery without requesting auth, personal credentials or APIs', () => {
  history.replaceState({}, '', '/?examples=1');
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  render(<SaaSApp />);
  expect(screen.getAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(12);
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: /进入工作区/ })).toHaveAttribute('href', '/');
});

it('copies a complete draft once, preserves the user prompt, and never starts planning or a run', async () => {
  const scope = { user: identity.user.id, tenant: tenant.id };
  saveHomeDraft(scope, '我原来的任务要保留');
  let finish!: (value: Response) => void;
  const posts: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') { posts.push({ url, body: JSON.parse(init.body as string) }); return await new Promise<Response>(resolve => { finish = resolve; }); }
    return json(url.endsWith('/runtime') ? { available: false } : { items: [], nextCursor: null });
  }));
  const onOpen = vi.fn();
  history.replaceState({}, '', `/?official=${first.id}`);
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  const copy = screen.getByRole('button', { name: '复制到我的画布' });
  fireEvent.click(copy); fireEvent.click(copy);
  expect(posts).toHaveLength(1);
  expect(posts[0].url).toBe('/api/v1/tenants/official-workspace/canvases');
  expect(posts[0].body.name).toBe(first.title.zh);
  expect(posts[0].body.document.nodes).toHaveLength(first.nodes.length);
  expect(posts[0].body.document.edges).toHaveLength(first.edges.length);
  expect(posts[0].body.document.nodes.every((node: any) => node.binding === null && !node.lastOutput && node.model === '')).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
  finish(json({ id: 'copied-official', document: posts[0].body.document }, 201));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('copied-official'));
  expect(posts).toHaveLength(1);
  expect(Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).some(key => key?.startsWith(PLAN_HANDOFF_PREFIX))).toBe(false);
  expect(readHomeDraft(scope)).toBe('我原来的任务要保留');
});

it('keeps the selected workflow visible and reports a rejected create without opening anything', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => init.method === 'POST'
    ? json({ error: { code: 'forbidden' } }, 403)
    : json(url.endsWith('/runtime') ? {} : { items: [], nextCursor: null })));
  const onOpen = vi.fn(); history.replaceState({}, '', `/?official=${first.id}`);
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: '复制到我的画布' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '复制到我的画布' })).toBeEnabled());
  expect(screen.getAllByRole('alert').some(element => element.textContent?.includes('你没有执行此操作的权限'))).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
});

it('lets readers inspect templates without exposing a workspace create action', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [], nextCursor: null })));
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={{ ...tenant, role: 'reader' }} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: `查看官方案例：${first.title.zh}` }));
  expect(screen.queryByRole('button', { name: '复制到我的画布' })).toBeNull();
  expect(screen.queryByRole('link', { name: '登录并复用' })).toBeNull();
  expect(screen.getByText(/复制到工作区需要编辑权限/)).toBeVisible();
});

it('keeps a curated selection across SSO without accepting arbitrary paths or starting a run', () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [], nextCursor: null })));
  rememberOfficialSelection(first.id);
  rememberOfficialSelection('https://untrusted.example/');
  expect(readOfficialSelection()).toBe(first.id);
  const onOpen = vi.fn();
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={tenant} onOpen={onOpen} /></SaaSPreferencesProvider>);
  expect(screen.getByRole('button', { name: '复制到我的画布' })).toBeVisible();
  expect(onOpen).not.toHaveBeenCalled();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
  expect(readOfficialSelection()).toBeUndefined();
});

it('returns focus to the category controls when the selected card has been filtered away', () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: `查看官方案例：${first.title.zh}` }));
  fireEvent.click(screen.getByRole('button', { name: /^模型与实验/ }));
  fireEvent.click(screen.getByRole('button', { name: '收起作品' }));
  expect(screen.getByRole('button', { name: /^全部能力/ })).toHaveFocus();
});

it('preserves a valid invitation through case sign-in without carrying arbitrary redirect parameters', () => {
  const invite = 'fixture_invite_token_0123456789abcdef';
  history.replaceState({}, '', `/?invite=${invite}&returnURL=https://untrusted.example/`);
  view({ initialId: first.id });
  const link = screen.getByRole('link', { name: '登录并复用' });
  const href = link.getAttribute('href')!;
  expect(href).toBe(`/?official=${first.id}&invite=${invite}`);
  expect(clawHuntStartURL(href.slice(1))).toBe(`/api/v1/auth/clawhunt/start?invite=${invite}`);
  expect(officialSignInURL(first.id, '?invite=https://untrusted.example/')).toBe(`/?official=${first.id}`);
});


it('combines industry and text filters, clears empty results, and retains starter studies', () => {
  view();
  const industryCase = OFFICIAL_WORKFLOWS.find(item => item.tier === 'flagship')!;
  fireEvent.change(screen.getByRole('combobox', { name: '行业筛选' }), { target: { value: industryCase.industry!.en } });
  expect(screen.getAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(1);
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索案例' }), { target: { value: 'no-such-industry-zzzz' } });
  expect(screen.queryAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(0);
  expect(screen.getByRole('heading', { name: '没有找到匹配案例' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '重新浏览' }));
  expect(screen.getAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(12);
  fireEvent.click(screen.getByRole('button', { name: /^基础练习/ }));
  expect(screen.getAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(6);
  expect(screen.getByRole('button', { name: /查看官方案例：Signal Run/ })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /^全部案例/ }));
  expect(screen.getAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(18);
});

it('explores large workflows through the node directory and highlights actual dependency paths', () => {
  view({ initialId: first.id });
  fireEvent.click(screen.getByRole('tab', { name: '编排画布' }));
  const directory = screen.getByRole('navigation', { name: '节点目录' });
  expect(within(directory).getAllByRole('button')).toHaveLength(first.nodes.length);
  const target = first.nodes[2];
  fireEvent.click(within(directory).getByRole('button', { name: new RegExp(target.title.zh) }));
  expect(screen.getByRole('heading', { name: target.title.zh })).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: '突出依赖链' }));
  expect(screen.getByRole('checkbox', { name: '突出依赖链' })).toBeChecked();
  const graph = screen.getByLabelText('工作流画布，可横向滚动并选择节点');
  expect(within(graph).getByRole('button', { name: new RegExp(target.title.zh) })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '总览' })).toBeVisible();
});


it('ignores unknown direct ids and returns focus when reopening an already selected case', () => {
  view({ initialId: 'unknown-case' });
  expect(screen.getAllByRole('button', { name: /^查看官方案例/ })).toHaveLength(12);
  const card = screen.getByRole('button', { name: `查看官方案例：${first.title.zh}` });
  fireEvent.click(card);
  card.focus();
  fireEvent.click(card);
  expect(screen.getByLabelText(first.title.zh)).toHaveFocus();
});
