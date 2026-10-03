import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProductionCases, COMPACT_CASE_COUNT } from '../src/saas/ProductionCases';
import { PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { PRODUCTION_RUN_SUMMARY } from '../src/saas/productionRuns';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { OfficialWorkflow } from '../src/saas/examples/officialWorkflows';

const SHOWCASE = `${resolve(process.cwd(), 'showcase')}/`;
const view = (compact = false) => render(<SaaSPreferencesProvider><ProductionCases compact={compact} /></SaaSPreferencesProvider>);
const cards = () => screen.getAllByRole('listitem').filter(item => item.classList.contains('production-card'));
// The case dialog loads its run view lazily; compile it once up front so the tests time behaviour, not the bundler.
beforeAll(async () => { await import('../src/saas/ProductionShowcase'); await import('../src/saas/production-runs/knowledge-base'); }, 300_000);
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
  expect(PRODUCTION_CASES.filter(item => item.recording).map(item => item.id)).toEqual(['knowledge-base']);
  expect(PRODUCTION_CASES[0].recording).toBe(true);
  for (const item of PRODUCTION_CASES) {
    for (const text of [item.title, item.brief, item.deliverable, ...item.stages.flat(), ...(item.facts ?? [])]) {
      expect(text.zh.trim()).not.toBe(''); expect(text.en.trim()).not.toBe('');
    }
    expect(item.stages.length).toBeGreaterThanOrEqual(3);
    expect(item.stages.at(-1)!.map(role => role.zh)).toEqual(['验收']);
    if (!item.recording) expect(item.facts).toBeUndefined();   // what a run did is read from its record, not written here
    for (const stem of [item.footage, item.footageEn].filter(Boolean))
      for (const extension of ['mp4', 'jpg']) expect(existsSync(`${SHOWCASE}${stem}.${extension}`), `${stem}.${extension}`).toBe(true);
  }
  // The playable mock-ups made outside AwwO are gone; what plays now is what an AwwO run delivered.
  expect(existsSync(`${SHOWCASE}play`)).toBe(false);
  for (const stem of ['play-fox', 'play-bike', 'play-paper']) expect(existsSync(`${SHOWCASE}${stem}.mp4`)).toBe(false);
  // The real run: seven agents over five stages, three in parallel after the architecture.
  expect(PRODUCTION_CASES[0].stages.map(stage => stage.length)).toEqual([1, 3, 1, 1, 1]);
});

it('labels the cover footage for what it is, and claims delivery only where a published run delivered', () => {
  view();
  expect(screen.getByRole('heading', { level: 2, name: '一句话需求，交给一支 Agent 团队。' })).toBeVisible();
  // It says every case ran only once every case has a published run.
  const ran = PRODUCTION_CASES.filter(item => PRODUCTION_RUN_SUMMARY[item.id]).length;
  expect(screen.getByText(ran === PRODUCTION_CASES.length ? /^每个案例都是一张真实的 AwwO 画布，并且真的跑过一遍/
    : new RegExp(`^每个案例都是一张真实的 AwwO 画布：.*其中 ${ran} 个已经在 AwwO 里跑过一遍`))).toBeVisible();
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  const [recording, ...illustrations] = cards();
  expect(within(recording).getByText('交付录屏')).toBeVisible();
  expect(within(recording).queryByText('封面示意 · AI 生成')).toBeNull();
  for (const card of illustrations) { expect(within(card).getByText('封面示意 · AI 生成')).toBeVisible(); expect(within(card).queryByText('交付录屏')).toBeNull(); }
  PRODUCTION_CASES.forEach((item, index) => {
    const card = cards()[index], run = PRODUCTION_RUN_SUMMARY[item.id];
    expect(within(card).getByRole('list', { name: 'Agent 团队，按阶段' }).children).toHaveLength(item.stages.length);
    if (run?.delivered) { expect(within(card).getByText('已交付')).toBeVisible(); expect(card.querySelector('.production-delivered svg')).not.toBeNull(); }
    else { expect(within(card).getByText('交付目标')).toBeVisible(); expect(within(card).queryByText('已交付')).toBeNull(); expect(card.querySelector('.production-delivered svg')).toBeNull(); }
    if (run) expect(within(card).getByText(`真实运行 · ${run.completed}/${run.total} 节点完成`)).toBeVisible();
    else expect(card.querySelector('.production-run-chip')).toBeNull();
  });
  expect(PRODUCTION_RUN_SUMMARY['knowledge-base']).toMatchObject({ completed: 7, total: 7, delivered: true });
  // The label is part of what a screen reader hears for the card, not only what it shows.
  expect(within(recording).getByRole('button', { name: '团队知识库 SaaS' })).toHaveAccessibleDescription('交付录屏 「搭建团队知识库 SaaS：登录、权限、数据治理、后端接口、检索看板、上线物料、验收。」');
  expect(within(illustrations[0]).getByRole('button', { name: '像素平台跳跃' })).toHaveAccessibleDescription('封面示意 · AI 生成 「做一款像素风平台跳跃：狐狸邮差在空中集市里送信。」');
  expect(within(recording).getByText('权限 · 数据 · 物料')).toBeVisible();
  expect(within(illustrations[0]).getByText('美术 · 关卡 · 音效')).toBeVisible();
  // Without IntersectionObserver the posters show at once; nothing autoplays or preloads.
  for (const video of document.querySelectorAll<HTMLVideoElement>('.production-card video')) {
    expect(video.preload).toBe('none'); expect(video.muted).toBe(true); expect(video.autoplay).toBe(false);
    expect(video).toHaveAttribute('aria-hidden', 'true'); expect(video).toHaveAttribute('poster');
  }
  expect(screen.queryByRole('link', { name: /试玩示意版/ })).toBeNull();
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


it('opens a case as brief → team → delivery, then shows how it was made from its run record', async () => {
  view();
  const trigger = screen.getByRole('button', { name: '团队知识库 SaaS' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '团队知识库 SaaS' });
  expect(dialog).toHaveAttribute('open');
  expect(within(dialog).getByRole('heading', { level: 3, name: 'Agent 团队' })).toBeVisible();
  expect(within(dialog).getByText('7 个 Agent · 5 个阶段')).toBeVisible();
  expect(within(dialog).getByText('已交付')).toBeVisible();
  expect(within(dialog).getByText('42/42 测试通过')).toBeVisible();
  expect(within(dialog).getByText('独立验收退回 2 处缺陷 → 复验通过')).toBeVisible();
  expect(within(dialog).getByText('界面实录：2026-09-04 一次 AwwO 真实运行交付的知识库工作台（演示模式，使用模拟数据）。')).toBeVisible();
  expect(dialog.querySelector('video')).toHaveAttribute('src', '/showcase/kb-real.mp4');
  const made = await within(dialog).findByRole('region', { name: '7 个 Agent，5 个阶段，44 分 24 秒跑完' });
  expect(within(made).getByText('7/7 个节点完成')).toBeVisible();
  expect(within(made).getByText('2026-09-04')).toBeVisible();
  const rail = within(made).getByRole('list', { name: '按阶段查看每个 Agent' });
  for (const title of ['产品边界与架构需求', '用户登录与工作区权限', '文档数据治理', '知识库上线物料', '后端接口与业务规则', '知识库 Web 工作台', '交付验收'])
    expect(within(rail).getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible();
  expect(within(rail).getAllByText('3 路并行')).toHaveLength(1);
  // A node shows what that agent actually handed over, here the review's own verdict.
  fireEvent.click(within(rail).getByRole('button', { name: /^交付验收/ }));
  expect(within(rail).getByRole('button', { name: /^交付验收/ })).toHaveAttribute('aria-pressed', 'true');
  expect(within(within(made).getByRole('article')).getByText(/^部分通过，整体验收未通过。/)).toBeVisible();
  expect(within(made).getByText(/这个案例交付的是一个多文件应用/)).toBeVisible();
  expect(within(made).getByText(/退回了两处演示缺陷/)).toBeVisible();
  expect(made.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|[A-Za-z]:\/tmp/);   // no private identifiers or machine paths
  expect(within(made).queryByRole('button', { name: '复制这张画布' })).toBeNull();     // its 2026-09-04 canvas is not offered as a copy
  within(dialog).getByRole('button', { name: '关闭' }).focus();   // focus inside the dialog, as showModal leaves it
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();

  const pixel = screen.getByRole('button', { name: '像素平台跳跃' });
  fireEvent.click(pixel);
  const game = screen.getByRole('dialog', { name: '像素平台跳跃' });
  expect(within(game).getByText(PRODUCTION_RUN_SUMMARY['pixel-platformer'] ? /只说明方向；AwwO 实际运行交付的成品在下方「它是怎么做出来的」。$/ : /^封面示意 · AI 生成：这段画面由 AI 视频模型生成，只说明方向。$/)).toBeVisible();
  expect(within(game).getByText('6 个 Agent · 4 个阶段')).toBeVisible();
  expect(within(game).getByText('3 路并行')).toBeVisible();
  expect(within(game).getByText(PRODUCTION_RUN_SUMMARY['pixel-platformer']?.delivered ? '已交付' : '交付目标')).toBeVisible();
  await within(game).findByRole('region', { name: /它是怎么做出来的|HOW IT WAS MADE|Agent，\d+ 个阶段|这个案例还没有发布运行记录/ });
  fireEvent.click(within(game).getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(pixel).toHaveFocus();
});

it('copies an illustrated case’s real canvas through the workspace’s copy flow, closing the case first', async () => {
  const onReuse = vi.fn<(workflow: OfficialWorkflow) => void>();
  render(<SaaSPreferencesProvider><ProductionCases onReuse={onReuse} /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: '像素平台跳跃' }));
  const dialog = screen.getByRole('dialog', { name: '像素平台跳跃' });
  fireEvent.click(await within(dialog).findByRole('button', { name: '复制这张画布' }));
  expect(onReuse).toHaveBeenCalledExactlyOnceWith(PRODUCTION_WORKFLOWS['pixel-platformer']);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('offers no copy where there is no workspace to copy into', async () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: '港口三维驾驶舱' }));
  const dialog = screen.getByRole('dialog', { name: '港口三维驾驶舱' });
  await within(dialog).findByRole('region');
  expect(within(dialog).queryByRole('button', { name: '复制这张画布' })).toBeNull();
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


it('speaks English, with the translated recording marked on the card', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  view();
  expect(screen.getByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' })).toBeVisible();
  const [recording, pixel] = cards();
  expect(within(recording).getByText('Recorded delivery')).toBeVisible();
  expect(within(pixel).getByText('Cover: AI illustration')).toBeVisible();
  expect(recording.querySelector('video')).toHaveAttribute('src', '/showcase/kb-real-en.mp4');
  // The translated recording says so on the card itself, not only once the case is opened.
  expect(within(recording).getByText('UI translated from Chinese')).toBeVisible();
  expect(within(recording).getByRole('button', { name: 'Team knowledge-base SaaS' })).toHaveAccessibleDescription(/^Recorded delivery UI translated from Chinese “Build a team/);
  expect(within(pixel).queryByText('UI translated from Chinese')).toBeNull();
  expect(within(recording).getByText('Delivered')).toBeVisible();
  expect(within(recording).getByText('Real run · 7/7 nodes done')).toBeVisible();
  fireEvent.click(within(recording).getByRole('button', { name: 'Team knowledge-base SaaS' }));
  const dialog = screen.getByRole('dialog', { name: 'Team knowledge-base SaaS' });
  expect(within(dialog).getByText('7 agents · 5 stages')).toBeVisible();
  expect(within(dialog).getByText(/demo mode with simulated data\. UI translated from Chinese\.$/)).toBeVisible();
  const made = await within(dialog).findByRole('region', { name: '7 agents, 5 stages, 44 min 24 s end to end' });
  expect(within(made).getByText('The agents worked in Chinese; their outputs are shown as delivered.')).toBeVisible();
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
