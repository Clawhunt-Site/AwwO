import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProductionCases, COMPACT_CASE_COUNT } from '../src/saas/ProductionCases';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { SaaSApp } from '../src/saas/SaaSApp';
import { WorkspaceHome } from '../src/saas/WorkspaceHome';
import type { Identity, Tenant } from '../src/saas/api';

const SHOWCASE = `${resolve(process.cwd(), 'showcase')}/`;
const view = (compact = false) => render(<SaaSPreferencesProvider><ProductionCases compact={compact} /></SaaSPreferencesProvider>);
const cards = () => screen.getAllByRole('listitem').filter(item => item.classList.contains('production-card'));
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

/** A controllable IntersectionObserver: `near` ones load posters (rootMargin), `play` ones run the loops (threshold). */
type Watcher = { callback: IntersectionObserverCallback; options: IntersectionObserverInit; targets: Element[]; disconnected: boolean };
function observeIntersections() {
  const watchers: Watcher[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    watcher: Watcher;
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) { this.watcher = { callback, options, targets: [], disconnected: false }; watchers.push(this.watcher); }
    observe(target: Element) { this.watcher.targets.push(target); }
    disconnect() { this.watcher.disconnected = true; }
    unobserve() {} takeRecords() { return []; }
  });
  const live = (kind: 'near' | 'play') => watchers.filter(watcher => !watcher.disconnected && (kind === 'near' ? watcher.options.rootMargin : watcher.options.threshold));
  const fire = (watcher: Watcher, ...states: boolean[]) => act(() => watcher.callback(states.map(isIntersecting => ({ isIntersecting, target: watcher.targets[0] }) as IntersectionObserverEntry), {} as IntersectionObserver));
  return { watchers, live, fire };
}

it('tells every case as a brief, a staged team and a deliverable, with its footage on disk', () => {
  expect(new Set(PRODUCTION_CASES.map(item => item.id)).size).toBe(PRODUCTION_CASES.length);
  expect(PRODUCTION_CASES.filter(item => item.real).map(item => item.id)).toEqual(['knowledge-base']);
  expect(PRODUCTION_CASES[0].real).toBe(true);
  for (const item of PRODUCTION_CASES) {
    for (const text of [item.title, item.brief, item.deliverable, ...item.stages.flat(), ...(item.facts ?? [])]) {
      expect(text.zh.trim()).not.toBe(''); expect(text.en.trim()).not.toBe('');
    }
    expect(item.stages.length).toBeGreaterThanOrEqual(3);
    expect(item.stages.at(-1)!.map(role => role.zh)).toEqual(['验收']);
    if (item.nodes) expect(item.nodes.map(stage => stage.length)).toEqual(item.stages.map(stage => stage.length));
    if (!item.real) expect(item.facts).toBeUndefined();   // nothing ran, so there is nothing to report
    for (const stem of [item.footage, item.footageEn, item.build?.footage].filter(Boolean))
      for (const extension of ['mp4', 'jpg']) expect(existsSync(`${SHOWCASE}${stem}.${extension}`), `${stem}.${extension}`).toBe(true);
    if (item.build) {
      const page = readFileSync(`${SHOWCASE}play/${item.build.page}.html`, 'utf8');
      expect(page).toContain("tag: '示意 · AI 生成'");
      expect(page).toContain("tag: 'Illustration · AI-generated'");
      expect(page).not.toMatch(/\bDemo\b/);   // no "Demo" tag on these: 示意 · AI 生成, like every illustration here
      expect(page).not.toMatch(/film/i);      // the film-only mode, which could hide that tag, is gone
      expect(page).not.toMatch(/https?:\/\/|fetch\(|localStorage|document\.cookie/);   // self-contained, same-origin safe
    }
  }
  // The real run: seven agents over five stages, three in parallel after the architecture.
  const real = PRODUCTION_CASES[0];
  expect(real.nodes!.flat()).toHaveLength(7);
  expect(real.nodes![1].map(node => node.zh)).toEqual(['用户登录与工作区权限', '文档数据治理', '知识库上线物料']);
});

it('labels the one real run apart from the AI-generated illustrations, and claims delivery only for it', () => {
  view();
  expect(screen.getByRole('heading', { level: 2, name: '一句话需求，交给一支 Agent 团队。' })).toBeVisible();
  expect(screen.getByText(/只有标「真实实跑」的那一个真的跑过，其余都是示意。$/)).toBeVisible();
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  const [real, ...illustrations] = cards();
  expect(within(real).getByText('真实实跑')).toBeVisible();
  expect(within(real).queryByText('示意 · AI 生成')).toBeNull();
  expect(within(real).getByText('已交付')).toBeVisible();
  expect(real.querySelector('.production-delivered svg')).not.toBeNull();
  expect(within(real).getByRole('list', { name: 'Agent 团队，按阶段' }).children).toHaveLength(5);
  for (const card of illustrations) {
    expect(within(card).getByText('示意 · AI 生成')).toBeVisible();
    expect(within(card).queryByText('真实实跑')).toBeNull();
    expect(within(card).getByText('交付目标')).toBeVisible();
    expect(within(card).queryByText('已交付')).toBeNull();
    expect(card.querySelector('.production-delivered svg')).toBeNull();
    expect(within(card).getByRole('list', { name: '设想的 Agent 团队，按阶段' })).toBeVisible();
  }
  // The label is part of what a screen reader hears for the card, not only what it shows.
  expect(within(real).getByRole('button', { name: '团队知识库 SaaS' })).toHaveAccessibleDescription('真实实跑 「搭建团队知识库 SaaS：登录、权限、数据治理、后端接口、检索看板、上线物料、验收。」');
  expect(within(illustrations[0]).getByRole('button', { name: '像素平台跳跃' })).toHaveAccessibleDescription('示意 · AI 生成 「做一款像素风平台跳跃：狐狸邮差在空中集市里送信。」');
  expect(within(real).getByText('权限 · 数据 · 物料')).toBeVisible();
  // Without IntersectionObserver the posters show at once; nothing autoplays or preloads.
  for (const video of document.querySelectorAll<HTMLVideoElement>('.production-card video')) {
    expect(video.preload).toBe('none'); expect(video.muted).toBe(true); expect(video.autoplay).toBe(false);
    expect(video).toHaveAttribute('aria-hidden', 'true'); expect(video).toHaveAttribute('poster');
  }
  const plays = screen.getAllByRole('link', { name: /^试玩示意版：/ });
  expect(plays.map(link => link.getAttribute('aria-label'))).toEqual(['试玩示意版：像素平台跳跃', '试玩示意版：3D 配置器', '试玩示意版：纸艺解谜']);
  expect(plays.map(link => link.getAttribute('href'))).toEqual(['/showcase/play/fox-courier.html', '/showcase/play/ebike-config.html', '/showcase/play/paper-path.html']);
  for (const link of plays) { expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener'); }
});

it('shows one row on the workspace home until the visitor asks for all of them', () => {
  view(true);
  const toggle = screen.getByRole('button', { name: `查看全部 ${PRODUCTION_CASES.length} 个制作案例` });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(cards()).toHaveLength(COMPACT_CASE_COUNT);
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(toggle).toHaveTextContent('收起');
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  fireEvent.click(toggle);
  expect(cards()).toHaveLength(COMPACT_CASE_COUNT);
});

it('opens a case as brief → team → delivery and gives focus back to its card', () => {
  view();
  const trigger = screen.getByRole('button', { name: '团队知识库 SaaS' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '团队知识库 SaaS' });
  expect(dialog).toHaveAttribute('open');
  expect(within(dialog).getByRole('heading', { level: 3, name: 'Agent 团队' })).toBeVisible();
  expect(within(dialog).getByText('7 个 Agent · 5 个阶段')).toBeVisible();
  expect(within(dialog).getByText('3 路并行')).toBeVisible();
  for (const node of ['产品边界与架构需求', '文档数据治理', '后端接口与业务规则', '知识库 Web 工作台', '交付验收']) expect(within(dialog).getByText(node)).toBeVisible();
  expect(within(dialog).getByText('已交付')).toBeVisible();
  expect(within(dialog).getByText('42/42 测试通过')).toBeVisible();
  expect(within(dialog).getByText('独立验收退回 2 处缺陷 → 复验通过')).toBeVisible();
  expect(within(dialog).getByText('界面实录：2026-09-04 一次 AwwO 真实运行交付的知识库工作台（演示模式，使用模拟数据）。')).toBeVisible();
  expect(dialog.querySelector('video')).toHaveAttribute('src', '/showcase/kb-real.mp4');
  within(dialog).getByRole('button', { name: '关闭' }).focus();   // focus inside the dialog, as showModal leaves it
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();

  const pixel = screen.getByRole('button', { name: '像素平台跳跃' });
  fireEvent.click(pixel);
  const game = screen.getByRole('dialog', { name: '像素平台跳跃' });
  expect(within(game).getByText(/^示意 · AI 生成：画面由 AI 生成/)).toBeVisible();
  expect(within(game).getByRole('heading', { level: 3, name: '设想的 Agent 团队' })).toBeVisible();
  expect(within(game).getAllByText('2 路并行')).toHaveLength(2);
  expect(within(game).getByText('交付目标')).toBeVisible();
  expect(within(game).queryByText('已交付')).toBeNull();
  expect(within(game).getByText('示意 · AI 生成，不是 AwwO 运行的产出')).toBeVisible();
  expect(within(game).getByRole('link', { name: '在新标签页试玩' })).toHaveAttribute('href', '/showcase/play/fox-courier.html');
  fireEvent.click(within(game).getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(pixel).toHaveFocus();
});

it('closes on the backdrop only when the press and the release both land outside the box', () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: '纸艺解谜' }));
  const dialog = screen.getByRole('dialog', { name: '纸艺解谜' });
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 700, top: 50, bottom: 650, width: 600, height: 600, x: 100, y: 50, toJSON() {} } as DOMRect);
  // a text selection that started inside the box and was released over the backdrop
  fireEvent.mouseDown(dialog, { clientX: 300, clientY: 300 }); fireEvent.click(dialog, { clientX: 20, clientY: 20 });
  expect(screen.getByRole('dialog')).toBeVisible();
  // the dialog's own scrollbar, inside the box
  fireEvent.mouseDown(dialog, { clientX: 695, clientY: 300 }); fireEvent.click(dialog, { clientX: 695, clientY: 300 });
  expect(screen.getByRole('dialog')).toBeVisible();
  // the backdrop
  fireEvent.mouseDown(dialog, { clientX: 20, clientY: 20 }); fireEvent.click(dialog, { clientX: 20, clientY: 20 });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('speaks English, with the translated recording marked on the card', () => {
  localStorage.setItem('superclaw_locale', 'en');
  view();
  expect(screen.getByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' })).toBeVisible();
  const [real, pixel] = cards();
  expect(within(real).getByText('Real run')).toBeVisible();
  expect(within(pixel).getByText('Illustration · AI-generated')).toBeVisible();
  expect(real.querySelector('video')).toHaveAttribute('src', '/showcase/kb-real-en.mp4');
  // The translated recording says so on the card itself, not only once the case is opened.
  expect(within(real).getByText('UI translated from Chinese')).toBeVisible();
  expect(within(real).getByRole('button', { name: 'Team knowledge-base SaaS' })).toHaveAccessibleDescription(/^Real run UI translated from Chinese “Build a team/);
  expect(within(pixel).queryByText('UI translated from Chinese')).toBeNull();
  expect(within(real).getByText('Delivered')).toBeVisible();
  expect(within(pixel).getByText('Deliverable')).toBeVisible();
  expect(within(pixel).getByRole('link', { name: 'Play the mock-up: Pixel platformer' })).toHaveAttribute('href', '/showcase/play/fox-courier.html?lang=en');
  fireEvent.click(within(real).getByRole('button', { name: 'Team knowledge-base SaaS' }));
  const dialog = screen.getByRole('dialog', { name: 'Team knowledge-base SaaS' });
  expect(within(dialog).getByText('7 agents · 5 stages')).toBeVisible();
  expect(within(dialog).getByText(/demo mode with simulated data\. UI translated from Chinese\.$/)).toBeVisible();
});

it('loads posters as cards near the viewport, plays loops only on screen, and holds them while a case is open', async () => {
  const io = observeIntersections();
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  view();
  const videos = [...document.querySelectorAll<HTMLVideoElement>('.production-card video')];
  expect(videos.every(video => !video.hasAttribute('poster') && !video.hasAttribute('src'))).toBe(true);
  expect(io.live('near')).toHaveLength(PRODUCTION_CASES.length);
  expect(io.live('play')).toHaveLength(0);
  io.fire(io.live('near')[0], true);
  expect(videos[0]).toHaveAttribute('poster', '/showcase/kb-real.jpg');
  expect(videos[1]).not.toHaveAttribute('poster');
  for (const watcher of io.live('near')) io.fire(watcher, true);
  const loops = io.live('play');
  expect(loops).toHaveLength(PRODUCTION_CASES.length);
  io.fire(loops[0], true);
  expect(play).toHaveBeenCalledTimes(1);
  io.fire(loops[0], true, false);   // in, then out, in one batch: the latest wins
  expect(play).toHaveBeenCalledTimes(1);
  expect(pause).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '夏日气泡水广告' }));
  expect(loops.every(watcher => watcher.disconnected)).toBe(true);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(io.live('play')).toHaveLength(PRODUCTION_CASES.length));   // back on once the case closes
  // Inside a dialog, which scrolls on its own, the mock-up's preview loads at once.
  fireEvent.click(screen.getByRole('button', { name: '像素平台跳跃' }));
  expect(screen.getByRole('dialog').querySelector('.production-build video')).toHaveAttribute('poster', '/showcase/play-fox.jpg');
});

it.each([
  ['prefers reduced motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
    return () => {};
  }],
  ['saves data', () => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } });
    return () => { delete (navigator as Navigator & { connection?: unknown }).connection; };
  }],
])('keeps posters and offers controls when the visitor %s', (_, setUp) => {
  const io = observeIntersections();
  const restore = setUp();
  try {
    view();
    for (const watcher of io.live('near')) io.fire(watcher, true);
    expect(document.querySelector('.production-card video')).toHaveAttribute('poster');
    expect(io.live('play')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '团队知识库 SaaS' }));
    const video = screen.getByRole('dialog').querySelector('video')!;
    expect(video.autoplay).toBe(false);
    expect(video.controls).toBe(true);
  } finally { restore(); }
});

it('puts the cases on the signed-out homepage, between the welcome and the examples to try', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/options')
    ? new Response(JSON.stringify({ clawhuntSSO: true, localAuth: false }))
    : new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), { status: 401 })));
  render(<SaaSApp />);
  const cases = await screen.findByRole('heading', { level: 2, name: '一句话需求，交给一支 Agent 团队。' });
  const tryOne = screen.getByRole('heading', { level: 2, name: '从一个作品开始' });
  expect(cases.compareDocumentPosition(tryOne) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 }).compareDocumentPosition(cases) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  expect(screen.queryByRole('button', { name: /查看全部 \d+ 个制作案例/ })).toBeNull();
});

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity: Identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
it.each(['owner', 'reader'] as const)('shows one row of cases on the %s workspace home, before the examples to try', async role => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify(new URL(input, 'http://localhost').pathname.endsWith('/runtime')
    ? { available: true, configured: true, plannerAvailable: true, models: [] } : { items: [], nextCursor: null }))));
  render(<SaaSPreferencesProvider><WorkspaceHome identity={identity} tenant={{ ...tenant, role }} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  const cases = await screen.findByRole('heading', { level: 2, name: '一句话需求，交给一支 Agent 团队。' });
  expect(cases.compareDocumentPosition(screen.getByRole('heading', { level: 2, name: '从一个作品开始' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(cards()).toHaveLength(COMPACT_CASE_COUNT);
  expect(screen.getByRole('button', { name: `查看全部 ${PRODUCTION_CASES.length} 个制作案例` })).toHaveAttribute('aria-expanded', 'false');
});
