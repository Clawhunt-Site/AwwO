import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { AcademyLauncher, AcademyProvider, preloadAcademy } from '../src/saas/Academy';
import { ACADEMY_SECTIONS, ACADEMY_VIDEOS, academyDuration } from '../src/saas/academyCatalog';
import { academySearch, readAcademyLink } from '../src/saas/academyLink';
import { caseURL, canOpenCase, openCase } from '../src/saas/caseLink';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { ProductionCases } from '../src/saas/ProductionCases';
import { agentCount, PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { SaaSApp } from '../src/saas/SaaSApp';

const WEB = process.cwd();
const CHINESE = /\p{Script=Han}/u;
const TITLE = 'Learn AwwO from real canvases';
// The owner's rule (2026-10-11): no media provider is named in the cases, their tutorials or the site's copy.
const PROVIDERS = /tripo|runninghub|seedream|seedance|minimax|hailuo|suno|mureka|kling|vidu/i;
const EN_NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six'];
const ZH_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const zhNumber = (n: number) => n < 10 ? (n === 2 ? '两' : ZH_DIGITS[n]) : `${n >= 20 ? ZH_DIGITS[Math.floor(n / 10)] : ''}十${n % 10 ? ZH_DIGITS[n % 10] : ''}`;
const caseOf = (id?: string) => PRODUCTION_CASES.find(item => item.id === id);
const library = (locale: 'zh' | 'en' = 'en') => { localStorage.setItem('superclaw_locale', locale); return render(<SaaSPreferencesProvider><AcademyProvider><AcademyLauncher /></AcademyProvider></SaaSPreferencesProvider>); };
/** The Academy's dialog once its part of the site has loaded (its frame shows the same title while it loads). */
const loaded = (name: string) => waitFor(() => {
  const dialog = screen.getByRole('dialog', { name });
  expect(dialog).not.toHaveAttribute('aria-busy');
  return dialog;
});
const openLibrary = async () => {
  const launcher = screen.getByRole('button', { name: 'Academy' });
  launcher.focus();
  fireEvent.click(launcher);
  return loaded(TITLE);
};
const cancel = (dialog: HTMLElement) => fireEvent(dialog, new Event('cancel', { cancelable: true }));
const cardTitles = (scope: HTMLElement) => within(scope).getAllByRole('listitem').map(item => within(item).getByRole('heading', { level: 4 }).textContent);

// The dialog's part of the site, loaded up front as a launcher's hover loads it: the tests time behaviour, not the bundler.
beforeAll(async () => { await preloadAcademy(); await import('../src/saas/ProductionShowcase'); }, 300_000);
beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState({}, '', '/'); });

it('lists every video once, by section, each staged by its checksum outside the release', () => {
  expect(new Set(ACADEMY_VIDEOS.map(video => video.id)).size).toBe(ACADEMY_VIDEOS.length);
  expect(ACADEMY_VIDEOS.map(video => video.section)).toEqual([...ACADEMY_VIDEOS.map(video => video.section)].sort((a, b) => ACADEMY_SECTIONS.indexOf(a) - ACADEMY_SECTIONS.indexOf(b)));
  for (const video of ACADEMY_VIDEOS) {
    expect(video.sha256, video.id).toMatch(/^[0-9a-f]{64}$/);
    // stage-showcase.sh's name for it; nothing under showcase/staged is in the repo.
    expect(video.src, video.id).toBe(`/showcase/staged/academy/${video.sha256.slice(0, 16)}.mp4`);
    expect(video.bytes, video.id).toBeGreaterThan(1_000_000);
    expect(video.seconds, video.id).toBeGreaterThan(60);
    expect(video.recordedOn, video.id).toMatch(/^2026-\d\d-\d\d$/);
  }
  expect(existsSync(resolve(WEB, 'showcase', 'staged'))).toBe(false);
  expect(ACADEMY_VIDEOS.filter(video => video.section === 'start')).toHaveLength(4);
});

it('walks through homepage cases in the homepage’s order, one video a case, each with a poster on disk', () => {
  const cases = ACADEMY_VIDEOS.filter(video => video.caseId);
  expect(cases.every(video => video.section !== 'start')).toBe(true);
  expect(new Set(cases.map(video => video.caseId)).size).toBe(cases.length);
  for (const video of cases) expect(caseOf(video.caseId), video.id).toBeDefined();
  const order = cases.map(video => PRODUCTION_CASES.findIndex(item => item.id === video.caseId));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  for (const video of ACADEMY_VIDEOS) {
    const poster = video.poster ?? `/showcase/${caseOf(video.caseId)!.footage}.jpg`;
    const file = resolve(WEB, ...poster.split('/').filter(Boolean));
    expect(existsSync(file), poster).toBe(true);
    expect(statSync(file).size, poster).toBeLessThan(512 * 1024);
  }
});

it('words every video in both languages, names no media provider, and counts each case’s agents as its canvas does', () => {
  for (const video of ACADEMY_VIDEOS) {
    for (const text of [video.title.en, video.summary.en]) { expect(text.trim(), video.id).not.toBe(''); expect(text, video.id).not.toMatch(CHINESE); }
    for (const text of [video.title.zh, video.summary.zh]) expect(text, video.id).toMatch(CHINESE);
    for (const text of [video.title.en, video.title.zh, video.summary.en, video.summary.zh]) expect(text, video.id).not.toMatch(PROVIDERS);
    const item = caseOf(video.caseId);
    if (!item) continue;
    const agents = agentCount(item);
    // A flagship's title and a build's summary say how many agents its canvas has.
    const [en, zh] = video.section === 'flagship' ? [video.title.en, video.title.zh] : [video.summary.en, video.summary.zh];
    if (video.section === 'flagship' && !/agents/.test(en)) continue;
    expect(en.match(/(?:by|built by) ([a-z-]+) agents/)?.[1], video.id).toBe(EN_NUMBERS[agents]);
    expect(zh.match(/(?:由|：)([零一二两三四五六七八九十]+)个 Agent/)?.[1], video.id).toBe(zhNumber(agents));
  }
});

it('keeps every other part of the address as it moves the Academy’s own', () => {
  expect(readAcademyLink('?tenant=t1')).toBeNull();
  expect(readAcademyLink('?academy')).toBe('');
  expect(readAcademyLink('?tenant=t1&academy=umber-photo')).toBe('umber-photo');
  expect(academySearch('?tenant=t1&canvas=c1', '')).toBe('?tenant=t1&canvas=c1&academy');
  expect(academySearch('?academy&tenant=t1', 'umber-photo')).toBe('?tenant=t1&academy=umber-photo');
  expect(academySearch('?tenant=t1&academy=x', null)).toBe('?tenant=t1');
  expect(academySearch('?academy', null)).toBe('');
  expect(caseURL('summer-ad', 't1')).toBe('/?tenant=t1&case=summer-ad');
  expect(caseURL('summer-ad')).toBe('/?case=summer-ad');
  expect(academyDuration(374.6)).toBe('6:15');
  expect(academyDuration(3725)).toBe('1:02:05');
});

it('opens from its button on the videos by section, filters them, plays one, and closes back to its button', async () => {
  library();
  const dialog = await openLibrary();
  expect(dialog).toHaveAttribute('open');
  expect(dialog).toHaveAttribute('lang', 'en');
  expect(window.location.search).toBe('?academy');
  expect(within(dialog).getByText(new RegExp(`^${ACADEMY_VIDEOS.length} videos, ${Math.round(ACADEMY_VIDEOS.reduce((sum, video) => sum + video.seconds, 0) / 60)} minutes in all, every one recorded on the live AwwO`))).toBeVisible();
  const sections = within(dialog).getAllByRole('region');
  expect(sections.map(section => within(section).getByRole('heading', { level: 3 }).textContent)).toEqual(['Start here', 'Inside the flagship cases', 'Build a case, step by step']);
  expect(sections.reduce((sum, section) => sum + within(section).getAllByRole('listitem').length, 0)).toBe(ACADEMY_VIDEOS.length);
  // The library loads posters only; no video until one is opened.
  expect(dialog.querySelector('video')).toBeNull();
  for (const image of dialog.querySelectorAll('img')) expect(image).toHaveAttribute('loading', 'lazy');
  // The filters.
  const flagship = within(dialog).getByRole('button', { name: /^Flagship cases/ });
  fireEvent.click(flagship);
  expect(flagship).toHaveAttribute('aria-pressed', 'true');
  expect(within(dialog).getAllByRole('region')).toHaveLength(1);
  expect(cardTitles(within(dialog).getByRole('region'))).toEqual(ACADEMY_VIDEOS.filter(video => video.section === 'flagship').map(video => video.title.en));
  // A video, chosen here, plays at once, at its place in the address; the focus goes to its title, inside the dialog.
  const umber = ACADEMY_VIDEOS.find(video => video.id === 'umber-photo')!;
  const umberCard = within(dialog).getByRole('button', { name: umber.title.en });
  umberCard.focus();
  fireEvent.click(umberCard);
  expect(within(dialog).getByRole('heading', { level: 2, name: umber.title.en })).toHaveFocus();
  const video = dialog.querySelector('video')!;
  expect(video).toHaveAttribute('src', umber.src);
  expect(video).toHaveAttribute('poster', '/showcase/umber-real.jpg');
  expect(video).toHaveAttribute('preload', 'metadata');
  expect(video.autoplay).toBe(true);
  expect(window.location.search).toBe('?academy=umber-photo');
  expect(within(dialog).getByText(`${academyDuration(umber.seconds)} · English narration, English and Chinese subtitles · Recorded 19 October 2026`)).toBeVisible();
  expect(within(dialog).getByText(`3 of ${ACADEMY_VIDEOS.filter(item => item.section === 'flagship').length}`)).toBeVisible();
  // Up next: the three after it, within the filter.
  const upNext = within(dialog).getByRole('navigation', { name: 'Up next' });
  expect(within(upNext).getAllByRole('button').map(button => button.textContent)).toEqual(['backprop-lab', 'errand-agent', 'roost-team']
    .map(id => ACADEMY_VIDEOS.find(item => item.id === id)!).map(item => `${academyDuration(item.seconds)}${item.title.en}`));
  const next = ACADEMY_VIDEOS.find(item => item.id === 'backprop-lab')!;
  fireEvent.click(within(upNext).getByRole('button', { name: new RegExp(next.title.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
  expect(dialog.querySelector('video')).toHaveAttribute('src', next.src);
  expect(window.location.search).toBe('?academy=backprop-lab');
  expect(within(dialog).getByRole('heading', { level: 2, name: next.title.en })).toHaveFocus();
  // Back in the library, the focus is on the card of the video just left.
  fireEvent.click(within(dialog).getByRole('button', { name: 'All videos' }));
  expect(within(dialog).getByRole('heading', { level: 2, name: TITLE })).toBeVisible();
  expect(within(dialog).getByRole('button', { name: next.title.en })).toHaveFocus();
  expect(window.location.search).toBe('?academy');
  cancel(dialog);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(window.location.search).toBe('');
  expect(screen.getByRole('button', { name: 'Academy' })).toHaveFocus();
});

it('opens from a link, on the video it names, which waits for its play button; an unknown one opens the library', async () => {
  window.history.replaceState({}, '', '/?tenant=t1&academy=the-long-chord');
  const film = ACADEMY_VIDEOS.find(video => video.id === 'the-long-chord')!;
  library();
  const dialog = await screen.findByRole('dialog', { name: film.title.en });
  const video = dialog.querySelector('video')!;
  expect(video).toHaveAttribute('src', film.src);
  expect(video.autoplay).toBe(false);
  expect(window.location.search).toBe('?tenant=t1&academy=the-long-chord');
  cancel(dialog);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(window.location.search).toBe('?tenant=t1');
  cleanup();
  window.history.replaceState({}, '', '/?academy=nothing-here');
  library();
  expect(await loaded(TITLE)).toBeVisible();
});

it('reads in Chinese in the Chinese interface, the case names in English', async () => {
  library('zh');
  fireEvent.click(screen.getByRole('button', { name: '教程' }));
  const dialog = await loaded('从真实画布学会 AwwO');
  expect(dialog).toHaveAttribute('lang', 'zh-CN');
  expect(within(dialog).getByRole('heading', { level: 3, name: '从这里开始' })).toBeVisible();
  const pixel = ACADEMY_VIDEOS.find(video => video.id === 'pixel-platformer')!;
  const button = within(dialog).getByRole('button', { name: pixel.title.zh });
  const card = button.closest('li')!;
  expect(within(card).getByText('Pixel platformer')).toHaveAttribute('lang', 'en');
  expect(within(card).getByText(pixel.summary.zh)).toBeVisible();
  fireEvent.click(button);
  expect(within(dialog).getByText(`${academyDuration(pixel.seconds)} · 英文讲解，中英字幕 · 录于 2026年10月14日`)).toBeVisible();
  expect(within(dialog).getByText(/^按四个部分写需求/)).toBeVisible();
  // No case library here, and no canvas page whose home page has one: nothing would open the case.
  expect(within(dialog).queryByRole('link', { name: '打开这个案例' })).toBeNull();
  expect(within(dialog).queryByRole('button', { name: '打开这个案例' })).toBeNull();
});

it('opens a case through a library that shows up after it, and from a page with a canvas open by a link to its workspace’s home page', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  window.history.replaceState({}, '', '/?academy=rhythm-runner');
  const tree = (library: boolean) => <SaaSPreferencesProvider><AcademyProvider>{library && <ProductionCases compact />}<AcademyLauncher /></AcademyProvider></SaaSPreferencesProvider>;
  const view = render(tree(false));
  const rhythm = ACADEMY_VIDEOS.find(video => video.id === 'rhythm-runner')!;
  const dialog = await screen.findByRole('dialog', { name: rhythm.title.en });
  expect(within(dialog).queryByRole('button', { name: 'Open the case' })).toBeNull();
  view.rerender(tree(true));
  expect(within(dialog).getByRole('button', { name: 'Open the case' })).toBeVisible();
  cleanup();
  // An address naming a canvas is not enough (its workspace may be suspended): the link waits for the canvas to open,
  // which a canvas page does once it has loaded, after the Academy opened from the link drew.
  window.history.replaceState({}, '', '/?tenant=t1&canvas=c1&view=results&academy=rhythm-runner');
  library();
  const onCanvas = await screen.findByRole('dialog', { name: rhythm.title.en });
  expect(within(onCanvas).queryByRole('link', { name: 'Open the case' })).toBeNull();
  act(() => configureSaaSCanvas({ tenant: { id: 't1', name: 'T', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }, canvasId: 'c1' }));
  expect(within(onCanvas).getByRole('link', { name: 'Open the case' })).toHaveAttribute('href', '/?tenant=t1&case=rhythm-runner');
  act(() => clearSaaSCanvas());
  expect(within(onCanvas).queryByRole('link', { name: 'Open the case' })).toBeNull();
});

it('opens its case in the case library on the page, which shows every case and comes back to its card', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  render(<SaaSPreferencesProvider><AcademyProvider><ProductionCases compact /><AcademyLauncher /></AcademyProvider></SaaSPreferencesProvider>);
  expect(screen.queryByRole('button', { name: 'Rhythm runner' })).toBeNull();
  const dialog = await openLibrary();
  const rhythm = ACADEMY_VIDEOS.find(video => video.id === 'rhythm-runner')!;
  fireEvent.click(within(dialog).getByRole('button', { name: rhythm.title.en }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Open the case' }));
  const opened = await screen.findByRole('dialog', { name: 'Rhythm runner' });
  expect(screen.queryByRole('dialog', { name: rhythm.title.en })).toBeNull();
  expect(window.location.search).toBe('');
  expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  cancel(opened);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: 'Rhythm runner' })).toHaveFocus();
});

it('follows a link to a case once, keeping the rest of the address and coming back to its card, and opens nothing for an unknown one', async () => {
  window.history.replaceState({}, '', '/?tenant=t1&case=summer-ad');
  render(<SaaSPreferencesProvider><ProductionCases compact /></SaaSPreferencesProvider>);
  const opened = await screen.findByRole('dialog', { name: 'Summer sparkling-drink ad' });
  expect(opened).toBeVisible();
  expect(window.location.search).toBe('?tenant=t1');
  cancel(opened);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: 'Summer sparkling-drink ad' })).toHaveFocus();
  expect(canOpenCase()).toBe(true);
  expect(openCase('nothing-here')).toBe(false);
  cleanup();
  expect(canOpenCase()).toBe(false);
  window.history.replaceState({}, '', '/?case=nothing-here');
  render(<SaaSPreferencesProvider><ProductionCases /></SaaSPreferencesProvider>);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.location.search).toBe('');
});

it('keeps the keys pressed in it from the page’s shortcuts, and offers another try when a video does not load', async () => {
  library();
  const dialog = await openLibrary();
  const onWindow = vi.fn();
  window.addEventListener('keydown', onWindow);
  fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Close' }), { key: 'a' });
  window.removeEventListener('keydown', onWindow);
  expect(onWindow).not.toHaveBeenCalled();
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  fireEvent.click(within(dialog).getByRole('button', { name: ACADEMY_VIDEOS[0].title.en }));
  // A failure while the video has the focus hands it to "Try again", and a retry gives it back to the video.
  const video = dialog.querySelector('video')!;
  video.focus();
  fireEvent.error(video);
  expect(within(dialog).getByRole('alert')).toHaveTextContent('This video could not be loaded.');
  expect(video).not.toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Try again' })).toHaveFocus();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
  expect(load).toHaveBeenCalledTimes(1);
  expect(within(dialog).queryByRole('alert')).toBeNull();
  expect(video).toHaveFocus();
});

it('puts its button in the workspace page’s top bar and in More options, and beside the landing page’s language switch', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  localStorage.setItem('awwo.workmode.v1:user-a', 'completed');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/appearance') ? {} : identity))));
  render(<SaaSApp />);
  const header = (await screen.findByRole('heading', { level: 1, name: 'Choose a workspace' })).closest('main')!.querySelector('header')!;
  const actions = within(header).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent);
  expect(actions.indexOf('Academy')).toBeGreaterThan(-1);
  expect(actions.indexOf('Academy')).toBeLessThan(actions.findIndex(label => /^Appearance/.test(label ?? '')));
  fireEvent.click(within(header).getByRole('button', { name: 'More options' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'More options' })).getByRole('button', { name: 'Academy' }));
  expect(await loaded(TITLE)).toBeVisible();
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/options')
    ? new Response(JSON.stringify({ clawhuntSSO: true, localAuth: false }))
    : new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), { status: 401 })));
  render(<SaaSApp />);
  await screen.findByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' });
  const preferences = document.querySelector('.saas-login > .saas-preferences')!;
  expect(within(preferences as HTMLElement).getAllByRole('button')[0]).toHaveAccessibleName('Academy');
});
