import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { AcademyLauncher, AcademyProvider, preloadAcademy } from '../src/saas/Academy';
import { ACADEMY_SECTIONS, ACADEMY_VIDEOS, academyDuration } from '../src/saas/academyCatalog';
import { academySearch, readAcademyLink } from '../src/saas/academyLink';
import { caseURL, canOpenCase, openCase } from '../src/saas/caseLink';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { ProductionCases } from '../src/saas/ProductionCases';
import { agentCount, PRODUCTION_CASES } from '../src/saas/productionCatalog';
import { PRODUCTION_RUN_SUMMARY } from '../src/saas/productionRuns';
import chordCanvas from '../src/saas/production-canvases/the-long-chord';
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
/** A real calendar day written YYYY-MM-DD, as the catalog's dates are (any year). */
const isDay = (day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  return /^\d{4}-\d\d-\d\d$/.test(day) && new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) === day;
};
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
    expect(isDay(video.recordedOn), video.id).toBe(true);
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

it('logs each update of a published video, newest first, the latest no earlier than its recording, in both languages', () => {
  const updated = ACADEMY_VIDEOS.filter(video => video.changes?.length);
  expect(updated.length).toBeGreaterThan(0);
  for (const video of updated) {
    const days = video.changes!.map(change => change.on);
    expect(days, video.id).toEqual([...days].sort().reverse());
    // The latest update is the recording the video holds now, or one after it (a span recorded again); an earlier
    // update may predate a later recording of the whole video.
    expect(days[0] >= video.recordedOn, video.id).toBe(true);
    for (const change of video.changes!) {
      expect(isDay(change.on), `${video.id} ${change.on}`).toBe(true);
      expect(change.text.en.trim(), video.id).not.toBe('');
      expect(change.text.en, video.id).not.toMatch(CHINESE);
      expect(change.text.zh, video.id).toMatch(CHINESE);
      for (const text of [change.text.en, change.text.zh]) expect(text, video.id).not.toMatch(PROVIDERS);
    }
  }
});

it('notes what changed since a video was recorded, each at a moment of the video, in both languages', () => {
  for (const video of ACADEMY_VIDEOS) {
    const notes = video.notes ?? [];
    const at = notes.map(note => note.at);
    expect(at, video.id).toEqual([...new Set(at)].sort((a, b) => a - b));
    for (const note of notes) {
      expect(Number.isInteger(note.at) && note.at >= 0 && note.at < video.seconds, `${video.id} at ${note.at}`).toBe(true);
      expect(isDay(note.since), `${video.id} ${note.since}`).toBe(true);
      expect(note.since >= video.recordedOn, video.id).toBe(true);
      expect(note.text.en.trim(), video.id).not.toBe('');
      expect(note.text.en, video.id).not.toMatch(CHINESE);
      expect(note.text.zh, video.id).toMatch(CHINESE);
      for (const text of [note.text.en, note.text.zh]) expect(text, video.id).not.toMatch(PROVIDERS);
    }
  }
});

it('keeps what THE LONG CHORD’s tutorial says a copy costs true to the case and to AwwO’s prices', () => {
  // Its recording of Episode I (2026-10-24, the file efc0ebb3…) says: "Running the copy makes all two hundred and
  // eighty-two pictures, clips and sounds again: at the case's settings, about sixty-four thousand credits of media, more
  // than six months of the Max plan, and more generations than any plan makes in a day." A change to the case's media or
  // to AwwO's prices that breaks this is a note for the video (academyCatalog.ts) or a new recording; change this test
  // with it, to what the note or the new recording says.
  const video = ACADEMY_VIDEOS.find(entry => entry.id === 'the-long-chord');
  if (!video?.sha256.startsWith('efc0ebb313f19c39')) throw new Error('THE LONG CHORD’s tutorial is not the recording these figures are from: check what the new one says');
  const media = PRODUCTION_RUN_SUMMARY['the-long-chord'].media!.total;
  const { credits, mediaNodes, monthly, mostPerDay } = chordCopyPrice();
  expect(media).toBe(282);
  expect(mediaNodes).toBe(media);
  expect(Math.abs(credits - 64_000)).toBeLessThan(1_000);
  expect(Math.floor(credits / monthly.max)).toBe(6);
  expect(media).toBeGreaterThan(mostPerDay);
});

/** What a copy of THE LONG CHORD's case spends on its media: each media node of the case canvas at its own settings,
 *  priced as mediaCreditsFor (backend/internal/app/plans.go) prices a generation, from that file's price table and
 *  plans, so a price or a plan that changes there fails the video's spoken figures here. The settings' multipliers (a video's
 *  length and resolution, a picture's count, size and quality) mirror mediaCreditsFor's: a change to those rules there
 *  needs the same change here. */
function chordCopyPrice() {
  const plans = readFileSync(resolve(WEB, '../../backend/internal/app/plans.go'), 'utf8');
  const table = /var mediaBaseCredits = map\[string\]int\{([\s\S]*?)\n\}/.exec(plans)![1];
  const constant = (name: string) => Number(new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(plans)![1]);
  const base = new Map([...table.matchAll(/"([a-z0-9.-]+)":\s*(\w+)/g)].map(([, model, value]) => [model, /^\d+$/.test(value) ? Number(value) : constant(value)]));
  const plan = (id: string) => /\{Credits: (\d+),[^}]*MediaPerDay: (\d+)/.exec(new RegExp(`"${id}": (\\{[^}]*\\})`).exec(plans)![1])!.slice(1).map(Number);
  const text = (value: unknown) => String(value ?? '').toLowerCase();
  const large = (value: unknown) => text(value).includes('4k') || text(value).split(/[x*: ]/).some(part => /^\d+$/.test(part) && Number(part) > 2048);
  let credits = 0, mediaNodes = 0;
  for (const node of chordCanvas.nodes) {
    if (node.kind !== 'session' || !['image', 'video', 'audio'].includes(node.agentKind)) continue;
    const price = base.get(node.model);
    expect(price, node.model).toBeGreaterThan(0);
    const params = node.mediaParams ?? {};
    let n = price!;
    if (node.agentKind === 'video') {
      n *= Math.max(1, (Number(params.duration) || 5) / 5);
      if (large(params.resolution) || large(params.size)) n *= 2;
      else if (text(params.resolution).includes('1080') || /1080|1792/.test(text(params.size))) n *= 1.5;
    } else if (node.agentKind === 'image') {
      n *= Math.max(1, Number(params.imageNum) || 1);
      if (['resolution', 'size', 'width', 'height'].some(key => large(params[key]))) n *= 2;
      if (['high', '2', '4'].includes(text(params.quality))) n *= 2;
    }
    credits += Math.ceil(n);
    mediaNodes += 1;
  }
  const [pro, max] = [plan('pro'), plan('max')];
  return { credits, mediaNodes, monthly: { pro: pro[0], max: max[0] }, mostPerDay: Math.max(pro[1], max[1]) };
}

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
  expect(within(dialog).getByText(`${academyDuration(umber.seconds)} · English narration, English and Chinese subtitles · Recorded ${noteDay(umber.recordedOn, 'en')}`)).toBeVisible();
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

/** The day a note shows, as the dialog writes it. */
const noteDay = (day: string, locale: 'en' | 'zh') => new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' })
  .format(new Date(`${day}T00:00:00Z`));

it('shows what changed since a video was recorded, and plays it from the moment each note names', async () => {
  library();
  const dialog = await openLibrary();
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  // The first video with two notes or more, whichever it is as spans are recorded again.
  const noted = ACADEMY_VIDEOS.find(video => (video.notes?.length ?? 0) >= 2);
  if (!noted) throw new Error('no video has two notes any more: test the notes on a catalog of the test’s own');
  const [first, last] = [noted.notes![0], noted.notes![noted.notes!.length - 1]];
  fireEvent.click(within(dialog).getByRole('button', { name: noted.title.en }));
  const notes = within(dialog).getByRole('region', { name: 'Changed since recording' });
  expect(within(notes).getAllByRole('listitem').map(item => within(item).getByRole('button').textContent))
    .toEqual(noted.notes!.map(note => academyDuration(note.at)));
  for (const note of noted.notes!) {
    const item = within(notes).getByText(note.text.en).closest('li')!;
    expect(within(item).getByText(`Since ${noteDay(note.since, 'en')}`)).toHaveAttribute('datetime', note.since);
  }
  const video = dialog.querySelector('video')!;
  // jsdom has no scrollIntoView: the video comes back into view above the notes.
  const scroll = vi.fn();
  Object.defineProperty(video, 'scrollIntoView', { value: scroll, configurable: true });
  // The focus stays on the note, to read on from there.
  const later = within(notes).getByRole('button', { name: `Play from ${academyDuration(last.at)}` });
  later.focus();
  fireEvent.click(later);
  expect(video.currentTime).toBe(last.at);
  expect(play).toHaveBeenCalledTimes(1);
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  expect(later).toHaveFocus();
  // An older browser's play() returns no promise, and a refused play leaves the video paused there: neither throws.
  play.mockReturnValueOnce(undefined as unknown as Promise<void>).mockRejectedValueOnce(new DOMException('refused', 'NotAllowedError'));
  const earlier = within(notes).getByRole('button', { name: `Play from ${academyDuration(first.at)}` });
  fireEvent.click(earlier);
  expect(video.currentTime).toBe(first.at);
  fireEvent.click(later);
  await act(async () => {});
  expect([video.currentTime, play.mock.calls.length, scroll.mock.calls.length]).toEqual([last.at, 3, 3]);
  // A video that did not load plays from no note: their times say so and keep the focus, under its "Try again".
  fireEvent.error(video);
  expect(earlier).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(earlier);
  expect([video.currentTime, play.mock.calls.length]).toEqual([last.at, 3]);
  expect(later).toHaveFocus();
  expect(within(dialog).getByRole('alert')).toHaveTextContent('This video could not be loaded.');
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
  expect(within(dialog).getByText(`${academyDuration(pixel.seconds)} · 英文讲解，中英字幕 · 录于 ${noteDay(pixel.recordedOn, 'zh')}`)).toBeVisible();
  expect(within(dialog).getByText(/^按四个部分写需求/)).toBeVisible();
  // No case library here, and no canvas page whose home page has one: nothing would open the case.
  expect(within(dialog).queryByRole('link', { name: '打开这个案例' })).toBeNull();
  expect(within(dialog).queryByRole('button', { name: '打开这个案例' })).toBeNull();
});

it('marks an updated video on its card and lists its updates beside it, in English and Chinese', async () => {
  // A video updated after it was first published, whichever it is.
  const updated = ACADEMY_VIDEOS.find(video => video.changes?.length);
  if (!updated) throw new Error('no video has an update: test the updates on a catalog of the test’s own');
  const latest = updated.changes![0];
  const short = (day: string, locale: 'en' | 'zh') => new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${day}T00:00:00Z`));
  // The mark's words as docs/academy.md gives them: "Updated 24 Oct", 「10月24日更新」.
  expect([short('2026-10-24', 'en'), short('2026-10-24', 'zh')]).toEqual(['24 Oct', '10月24日']);
  library();
  const dialog = await openLibrary();
  const card = within(dialog).getByRole('button', { name: updated.title.en });
  expect(card).toHaveAccessibleDescription(`Updated ${short(latest.on, 'en')} ${updated.summary.en}`);
  expect(within(card.closest('li')!).getByText(`Updated ${short(latest.on, 'en')}`)).toBeVisible();
  // Only updated videos carry the mark.
  expect(within(dialog).getAllByText(/^Updated /)).toHaveLength(ACADEMY_VIDEOS.filter(video => video.changes?.length).length);
  fireEvent.click(card);
  const updates = within(dialog).getByRole('region', { name: 'Updates' });
  expect(within(updates).getAllByRole('listitem')).toHaveLength(updated.changes!.length);
  expect(within(updates).getByText(latest.text.en)).toBeVisible();
  expect(within(updates).getByText(noteDay(latest.on, 'en'))).toHaveAttribute('datetime', latest.on);
  cleanup();
  library('zh');
  fireEvent.click(screen.getByRole('button', { name: '教程' }));
  const zh = await loaded('从真实画布学会 AwwO');
  const zhCard = within(zh).getByRole('button', { name: updated.title.zh });
  expect(zhCard).toHaveAccessibleDescription(`${short(latest.on, 'zh')}更新 ${updated.summary.zh}`);
  expect(within(zhCard.closest('li')!).getByText(`${short(latest.on, 'zh')}更新`)).toBeVisible();
  fireEvent.click(zhCard);
  const zhUpdates = within(zh).getByRole('region', { name: '更新记录' });
  expect(within(zhUpdates).getByText(latest.text.zh)).toBeVisible();
  expect(within(zhUpdates).getByText(noteDay(latest.on, 'zh'))).toHaveAttribute('datetime', latest.on);
});

it('shows a video’s notes in Chinese in the Chinese interface', async () => {
  // An English-narrated video with a note, whichever it is as spans are recorded again.
  const noted = ACADEMY_VIDEOS.find(video => video.voice === 'en' && video.notes?.length);
  if (!noted) throw new Error('no English-narrated video has a note any more: test the notes on a catalog of the test’s own');
  const note = noted.notes![0];
  window.history.replaceState({}, '', `/?academy=${noted.id}`);
  library('zh');
  const dialog = await screen.findByRole('dialog', { name: noted.title.zh });
  const notes = within(dialog).getByRole('region', { name: '录制之后的变化' });
  expect(within(notes).getByRole('button', { name: `从 ${academyDuration(note.at)} 播放` })).toHaveTextContent(academyDuration(note.at));
  const item = within(notes).getByText(note.text.zh).closest('li')!;
  expect(within(item).getByText(`${noteDay(note.since, 'zh')}起`)).toHaveAttribute('datetime', note.since);
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
