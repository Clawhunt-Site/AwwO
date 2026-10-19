import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProductionCases, COMPACT_CASE_COUNT } from '../src/saas/ProductionCases';
import { PRODUCTION_CASES, PRODUCTION_KIND_LABELS } from '../src/saas/productionCatalog';
import { PRODUCTION_RUN_SUMMARY } from '../src/saas/productionRuns';
import { PRODUCTION_WORKFLOWS } from '../src/saas/productionWorkflows';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { OfficialWorkflow } from '../src/saas/examples/officialWorkflows';

const SHOWCASE = `${resolve(process.cwd(), 'showcase')}/`;
const view = (compact = false) => render(<SaaSPreferencesProvider><ProductionCases compact={compact} /></SaaSPreferencesProvider>);
const cards = () => screen.getAllByRole('listitem').filter(item => item.classList.contains('production-card'));
// Cases are looked up by id: the catalog's order is its own to change.
const KB = PRODUCTION_CASES.findIndex(item => item.id === 'knowledge-base'), PIXEL = PRODUCTION_CASES.findIndex(item => item.id === 'pixel-platformer');
// Every case, its section and its dialog read in English in both interface languages (owner 2026-10-14); the tests
// below run in the Chinese interface unless they say otherwise.
const CHINESE = /\p{Script=Han}/u;
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


it('tells every case in English as a brief, a staged team and a deliverable, with its footage on disk', () => {
  expect(new Set(PRODUCTION_CASES.map(item => item.id)).size).toBe(PRODUCTION_CASES.length);
  expect([KB, PIXEL].every(index => index >= 0)).toBe(true);
  // Every cover is a recording of what its case's run delivered; none is an AI illustration any more.
  expect(PRODUCTION_CASES.filter(item => !item.recording).map(item => item.id)).toEqual([]);
  for (const item of PRODUCTION_CASES) {
    for (const text of [item.title, item.brief, item.deliverable, ...(item.caption === undefined ? [] : [item.caption]), ...item.stages.flat()]) {
      expect(text.trim(), item.id).not.toBe(''); expect(text, item.id).not.toMatch(CHINESE);
    }
    expect(item.stages.length).toBeGreaterThanOrEqual(3);
    expect(item.stages.at(-1), item.id).toEqual(['Review']);
    expect('facts' in item, item.id).toBe(false);   // what a run did is read from its record, not written here
    for (const extension of ['mp4', 'jpg']) expect(existsSync(`${SHOWCASE}${item.footage}.${extension}`), `${item.footage}.${extension}`).toBe(true);
  }
  for (const label of Object.values(PRODUCTION_KIND_LABELS)) { expect(label.trim()).not.toBe(''); expect(label).not.toMatch(CHINESE); }
  // Every cover records what its English run delivered; none shows an interface translated from another language.
  expect(PRODUCTION_CASES.filter(item => 'footageTranslated' in item).map(item => item.id)).toEqual([]);
  expect(PRODUCTION_CASES[KB].footage).toBe('kb-app-real');
  // The AI-generated covers these recordings replaced are no longer shipped.
  for (const stem of ['pixel', 'config', 'paper', 'film-ad', 'port-twin', 'glider', 'party', 'rhythm'])
    for (const extension of ['mp4', 'jpg']) expect(existsSync(`${SHOWCASE}${stem}.${extension}`), `${stem}.${extension}`).toBe(false);
  // Nor are the knowledge base's recordings of its 2026-09-04 Chinese run, nor their translated version.
  for (const stem of ['kb-real', 'kb-real-en'])
    for (const extension of ['mp4', 'jpg']) expect(existsSync(`${SHOWCASE}${stem}.${extension}`), `${stem}.${extension}`).toBe(false);
  // The playable mock-ups made outside AwwO are gone; what plays now is what an AwwO run delivered.
  expect(existsSync(`${SHOWCASE}play`)).toBe(false);
  for (const stem of ['play-fox', 'play-bike', 'play-paper']) expect(existsSync(`${SHOWCASE}${stem}.mp4`)).toBe(false);
  // Its canvas: seven agents over five stages, three in parallel after the architecture.
  expect(PRODUCTION_CASES[KB].stages.map(stage => stage.length)).toEqual([1, 3, 1, 1, 1]);
});

it('labels the cover footage for what it is, and claims delivery only where a published run delivered, in English in the Chinese interface too', () => {
  view();
  const heading = screen.getByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' });
  expect(heading).toBeVisible();
  expect(heading.closest('section')).toHaveAttribute('lang', 'en');
  // It says every case ran only once every case has a published run.
  const ran = PRODUCTION_CASES.filter(item => PRODUCTION_RUN_SUMMARY[item.id]).length;
  expect(screen.getByText(ran === PRODUCTION_CASES.length ? /^Every case is a real AwwO canvas that actually ran/
    : new RegExp(`^Every case is a real AwwO canvas: .* ${ran} of them have actually run in AwwO`))).toBeVisible();
  // The legend explains a recorded cover, and an AI-illustrated one only while some case still has one.
  expect(screen.getByText('The canvas’s actual AwwO run and what it delivered')).toBeVisible();
  expect(screen.getByText('The cover is a screen recording of that delivery')).toBeVisible();
  expect(screen.queryByText('Cover footage made by an AI video model, for illustration only')).toBeNull();
  expect(screen.queryByText('Cover: AI illustration')).toBeNull();
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  const recording = cards()[KB], pixelCard = cards()[PIXEL];
  for (const card of cards()) { expect(within(card).getByText('Recorded delivery')).toBeVisible(); expect(within(card).queryByText('Cover: AI illustration')).toBeNull(); }
  PRODUCTION_CASES.forEach((item, index) => {
    const card = cards()[index], run = PRODUCTION_RUN_SUMMARY[item.id];
    expect(within(card).getByRole('list', { name: 'Agent team, by stage' }).children).toHaveLength(item.stages.length);
    if (run?.delivered) { expect(within(card).getByText('Delivered')).toBeVisible(); expect(card.querySelector('.production-delivered svg')).not.toBeNull(); }
    else { expect(within(card).getByText('Deliverable')).toBeVisible(); expect(within(card).queryByText('Delivered')).toBeNull(); expect(card.querySelector('.production-delivered svg')).toBeNull(); }
    if (run) expect(within(card).getByText(`Real run · ${run.completed + (run.media?.completed ?? 0)}/${run.total + (run.media?.total ?? 0)} nodes done`)).toBeVisible();
    else expect(card.querySelector('.production-run-chip')).toBeNull();
  });
  expect(PRODUCTION_RUN_SUMMARY['knowledge-base']).toMatchObject({ completed: 7, total: 7, delivered: true });
  // The label is part of what a screen reader hears for the card, not only what it shows.
  expect(within(recording).getByRole('button', { name: 'Team knowledge-base SaaS' })).toHaveAccessibleDescription('Recorded delivery “Build a team knowledge-base SaaS: sign-in and roles, document governance, search, a dashboard and an audit log, on simulated data.”');
  expect(within(pixelCard).getByRole('button', { name: 'Pixel platformer' })).toHaveAccessibleDescription('Recorded delivery “A pixel-art platformer: a fox courier delivering letters across a sky market.”');
  expect(within(recording).getByText('Access · Data · Copy')).toBeVisible();
  expect(within(pixelCard).getByText('Art · Levels · Sound')).toBeVisible();
  // Without IntersectionObserver the posters show at once; nothing autoplays or preloads.
  for (const video of document.querySelectorAll<HTMLVideoElement>('.production-card video')) {
    expect(video.preload).toBe('none'); expect(video.muted).toBe(true); expect(video.autoplay).toBe(false);
    expect(video).toHaveAttribute('aria-hidden', 'true'); expect(video).toHaveAttribute('poster');
  }
  // No links out: the playable mock-ups made outside AwwO are gone.
  expect(screen.queryAllByRole('link')).toHaveLength(0);
});

it('shows one row on the workspace home until the visitor asks for all of them', () => {
  view(true);
  const toggle = screen.getByRole('button', { name: `See all ${PRODUCTION_CASES.length} cases` });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(cards()).toHaveLength(COMPACT_CASE_COUNT);
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(toggle).toHaveTextContent('Show fewer');
  expect(cards()).toHaveLength(PRODUCTION_CASES.length);
  fireEvent.click(toggle);
  expect(cards()).toHaveLength(COMPACT_CASE_COUNT);
});


it('opens a case as brief → team → delivery, then shows how it was made from its run record', async () => {
  view();
  const trigger = screen.getByRole('button', { name: 'Team knowledge-base SaaS' });
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Team knowledge-base SaaS' });
  expect(dialog).toHaveAttribute('open');
  expect(dialog).toHaveAttribute('lang', 'en');
  expect(within(dialog).getByRole('heading', { level: 3, name: 'Agent team' })).toBeVisible();
  expect(within(dialog).getByText('7 agents · 5 stages')).toBeVisible();
  expect(within(dialog).getByText('Delivered')).toBeVisible();
  expect(within(dialog).getByText('Recorded: the page a real AwwO run delivered on 2026-10-13, running as delivered and played by a script; try it yourself below, under “How it was made”.')).toBeVisible();
  expect(dialog.querySelector('video')).toHaveAttribute('src', '/showcase/kb-app-real.mp4');
  const made = await within(dialog).findByRole('region', { name: '7 agents, 5 stages, 6 min 39 s end to end' });
  expect(made).toHaveAttribute('lang', 'en');
  expect(within(made).getByText('7/7 nodes done')).toBeVisible();
  expect(within(made).getByText('2026-10-13')).toBeVisible();
  const rail = within(made).getByRole('list', { name: 'Every agent, stage by stage' });
  for (const title of ['Product scope & architecture', 'Login & workspace permissions', 'Document data governance', 'Launch assets & interface copy', 'Business layer & rules', 'Knowledge-base web workspace', 'Review'])
    expect(within(rail).getByRole('button', { name: new RegExp(`^${title}`) })).toBeVisible();
  expect(within(rail).getAllByText('3 in parallel')).toHaveLength(1);
  // A node shows what that agent actually handed over, as it wrote it: here the review's own verdict.
  fireEvent.click(within(rail).getByRole('button', { name: /^Review/ }));
  expect(within(rail).getByRole('button', { name: /^Review/ })).toHaveAttribute('aria-pressed', 'true');
  expect(within(within(made).getByRole('article')).getByRole('heading', { name: 'Review record: static source review, not actually run' })).toBeVisible();
  expect(within(made).getByText(/^Run on 2026-10-13 on the live AwwO, in the operator’s own account and workspace: 7 of 7 agents finished in 6 min 39 s/)).toBeVisible();
  expect(within(made).getByText(/^Before publishing, the delivered page was operated in Chrome/)).toBeVisible();
  expect(made.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|[A-Za-z]:\/tmp/);   // no private identifiers or machine paths
  expect(within(made).queryByRole('button', { name: 'Copy this canvas' })).toBeNull();     // no workspace to copy into here
  within(dialog).getByRole('button', { name: 'Close' }).focus();   // focus inside the dialog, as showModal leaves it
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();

  const pixel = screen.getByRole('button', { name: 'Pixel platformer' });
  fireEvent.click(pixel);
  const game = screen.getByRole('dialog', { name: 'Pixel platformer' });
  expect(within(game).getByText('Recorded: the page a real AwwO run delivered on 2026-10-13, running as delivered and played by a script; try it yourself below, under “How it was made”.')).toBeVisible();
  expect(game.querySelector('video')).toHaveAttribute('src', '/showcase/pixel-real.mp4');
  expect(within(game).getByText('6 agents · 4 stages')).toBeVisible();
  expect(within(game).getByText('3 in parallel')).toBeVisible();
  expect(within(game).getByText(PRODUCTION_RUN_SUMMARY['pixel-platformer']?.delivered ? 'Delivered' : 'Deliverable')).toBeVisible();
  await within(game).findByRole('region', { name: /^\d+ agents, \d+ stages, .+ end to end$|^No run record has been published for this case yet$/ });
  fireEvent.click(within(game).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(pixel).toHaveFocus();
});

it('shows a flagship run as it went: its agents without the assembly, its 23 runs, and the four revisions its nodes ran on', async () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Umber' }));
  const dialog = screen.getByRole('dialog', { name: 'Umber' });
  // Twelve agents: the assembly makes the page with no model.
  expect(within(dialog).getByText('12 agents · 5 stages')).toBeVisible();
  expect(dialog.querySelector('video')).toHaveAttribute('src', '/showcase/umber-real.mp4');
  // Twenty-three runs of the same canvas over two days took 250 min 33 s of work.
  const made = await within(dialog).findByRole('region', { name: '12 agents, 5 stages, 250 min 33 s in 23 runs' });
  expect(within(made).getByText('13/13 nodes done')).toBeVisible();
  const receipt = [...made.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === 'Run receipt')!.textContent!;
  expect(receipt).toContain('up to 64 model calls per node with thinking off');
  expect(receipt).toContain('23 runs took 250 min 33 s, 1925 min 1 s from the first start to the last finish');
  expect(receipt).toContain('API bdd631342ffe · runtime f0640f571df0 (Clean-room spec, Compositing');
  expect(receipt).toContain('; then API 1eeffacb9d40 · runtime 861cf0651a10 (Kernel, Interface); then API 1eeffacb9d40 · runtime e38e865e4322 (Filters, Assembly); then API 1eeffacb9d40 · runtime 6a6d831b71ac (Test and fix, Review)');
  const rail = within(made).getByRole('list', { name: 'Every agent, stage by stage' });
  fireEvent.click(within(rail).getByRole('button', { name: /^Kernel/ }));
  expect(within(made).getByText('Worked in its own sandbox computer · 60 model calls · 44,718 output tokens')).toBeVisible();
  fireEvent.click(within(rail).getByRole('button', { name: /^Assembly/ }));
  expect(within(made).getByText('Assembled with no model')).toBeVisible();
  expect(within(made).getByText('umber.html, 182 KB: the modules pasted into its template, byte for byte, with no model.')).toBeVisible();
});

it('shows Backprop as it went: thirteen agents over 25 runs, and the four revisions its nodes ran on', async () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Backprop' }));
  const dialog = screen.getByRole('dialog', { name: 'Backprop' });
  // The reader, the spec, nine builders, the tester and the review; the assembly makes the page with no model.
  expect(within(dialog).getByText('13 agents · 6 stages')).toBeVisible();
  expect(dialog.querySelector('video')).toHaveAttribute('src', '/showcase/backprop-real.mp4');
  const made = await within(dialog).findByRole('region', { name: '13 agents, 6 stages, 449 min 12 s in 25 runs' });
  expect(within(made).getByText('14/14 nodes done')).toBeVisible();
  const receipt = [...made.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === 'Run receipt')!.textContent!;
  expect(receipt).toContain('up to 64 model calls per node with thinking off');
  expect(receipt).toContain('25 runs took 449 min 12 s, 1851 min 49 s from the first start to the last finish');
  expect(receipt).toContain('API 19675fb7b979 · runtime 5317b5ec6266 (Read the library); then API c41723c6fbbe · runtime 5317b5ec6266 (Clean-room spec, Kernel');
  expect(receipt).toContain('; then API 1eeffacb9d40 · runtime 5317b5ec6266 (Interface, Assembly); then API 98f8425aad58 · runtime 6a6d831b71ac (Test and fix, Review)');
  const rail = within(made).getByRole('list', { name: 'Every agent, stage by stage' });
  fireEvent.click(within(rail).getByRole('button', { name: /^Kernel/ }));
  expect(within(made).getByText('Worked in its own sandbox computer · 10 model calls · 7,162 output tokens')).toBeVisible();
  fireEvent.click(within(rail).getByRole('button', { name: /^Assembly/ }));
  expect(within(made).getByText('backprop.html, 139 KB: the modules pasted into its template, byte for byte, with no model.')).toBeVisible();
});

it('shows Errand as it went: fifteen agents over 4 runs, its recorder and assembly with no model', async () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Errand' }));
  const dialog = screen.getByRole('dialog', { name: 'Errand' });
  // The reader, the spec, three session agents, eight builders, the tester and the review; the recorder writes its file
  // from its template and the assembly makes the page, neither with a model.
  expect(within(dialog).getByText('15 agents · 6 stages')).toBeVisible();
  expect(dialog.querySelector('video')).toHaveAttribute('src', '/showcase/errand-real.mp4');
  const made = await within(dialog).findByRole('region', { name: '15 agents, 6 stages, 57 min 53 s in 4 runs' });
  expect(within(made).getByText('17/17 nodes done')).toBeVisible();
  const receipt = [...made.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === 'Run receipt')!.textContent!;
  expect(receipt).toContain('up to 64 model calls per node with thinking off');
  expect(receipt).toContain('4 runs took 57 min 53 s, 71 min 36 s from the first start to the last finish');
  expect(receipt).toContain('API ad66eeba38e64b384dbe66e85590c18dd584745d · runtime 6a6d831b71ace0e76521f0f1f4e5b99f87c4da61');
  const rail = within(made).getByRole('list', { name: 'Every agent, stage by stage' });
  fireEvent.click(within(rail).getByRole('button', { name: /^Session recorder/ }));
  expect(within(made).getByText('Written with no model')).toBeVisible();
  expect(within(made).getByText('rec.py, 12 KB: written from its template, byte for byte, with no model.')).toBeVisible();
  fireEvent.click(within(rail).getByRole('button', { name: /^Kernel/ }));
  expect(within(made).getByText('Worked in its own sandbox computer · 18 model calls · 12,311 output tokens')).toBeVisible();
  fireEvent.click(within(rail).getByRole('button', { name: /^Assembly/ }));
  expect(within(made).getByText('errand.html, 385 KB: the modules pasted into its template, byte for byte, with no model.')).toBeVisible();
});

it('shows Roost as it went: seventeen agents over 6 runs, its recorder and assembly with no model', async () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Roost' }));
  const dialog = screen.getByRole('dialog', { name: 'Roost' });
  // The reader, the spec, four bot turns, nine builders, the tester and the review; the recorder writes its file from
  // its template and the assembly makes the page, neither with a model.
  expect(within(dialog).getByText('17 agents · 8 stages')).toBeVisible();
  expect(dialog.querySelector('video')).toHaveAttribute('src', '/showcase/roost-real.mp4');
  const made = await within(dialog).findByRole('region', { name: '17 agents, 8 stages, 74 min 11 s in 6 runs' });
  expect(within(made).getByText('19/19 nodes done')).toBeVisible();
  const receipt = [...made.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === 'Run receipt')!.textContent!;
  expect(receipt).toContain('up to 64 model calls per node with thinking off');
  expect(receipt).toContain('6 runs took 74 min 11 s, 149 min 8 s from the first start to the last finish');
  expect(receipt).toContain('API 7c2348a3093e · runtime 6a6d831b71ac (Read the app, Turn recorder, Clean-room spec');
  expect(receipt).toContain('; then API 7c2348a3093e · runtime 2b10ed38faa9 (Interface, Assembly, Test and fix, Review)');
  const rail = within(made).getByRole('list', { name: 'Every agent, stage by stage' });
  fireEvent.click(within(rail).getByRole('button', { name: /^Turn recorder/ }));
  expect(within(made).getByText('Written with no model')).toBeVisible();
  expect(within(made).getByText('rec.py, 13 KB: written from its template, byte for byte, with no model.')).toBeVisible();
  fireEvent.click(within(rail).getByRole('button', { name: /^Kernel/ }));
  expect(within(made).getByText('Worked in its own sandbox computer · 39 model calls · 27,175 output tokens')).toBeVisible();
  fireEvent.click(within(rail).getByRole('button', { name: /^Assembly/ }));
  expect(within(made).getByText('roost.html, 705 KB: the modules pasted into its template, byte for byte, with no model.')).toBeVisible();
});

it('copies an illustrated case’s real canvas through the workspace’s copy flow, closing the case first', async () => {
  const onReuse = vi.fn<(workflow: OfficialWorkflow) => void>();
  render(<SaaSPreferencesProvider><ProductionCases onReuse={onReuse} /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Pixel platformer' }));
  const dialog = screen.getByRole('dialog', { name: 'Pixel platformer' });
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Copy this canvas' }));
  expect(onReuse).toHaveBeenCalledExactlyOnceWith(PRODUCTION_WORKFLOWS['pixel-platformer']);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('copies the knowledge base’s compiled canvas too, and describes each node from its task', async () => {
  const onReuse = vi.fn<(workflow: OfficialWorkflow) => void>();
  render(<SaaSPreferencesProvider><ProductionCases onReuse={onReuse} /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Team knowledge-base SaaS' }));
  const dialog = screen.getByRole('dialog', { name: 'Team knowledge-base SaaS' });
  const made = await within(dialog).findByRole('region', { name: '7 agents, 5 stages, 6 min 39 s end to end' });
  fireEvent.click(within(within(made).getByRole('list', { name: 'Every agent, stage by stage' })).getByRole('button', { name: /^Business layer & rules/ }));
  const node = within(made).getByRole('article');
  // Its task, the template it was made from, what it hands over, and each input it received by name, all in English.
  expect(within(node).getByText(/^From the access data and the document data, write the page’s business layer in plain JavaScript/)).toBeVisible();
  expect(within(node).getByText('Backend')).toBeVisible();
  expect(within(node).getByText('Business layer code')).toBeVisible();
  expect(within(node).getByRole('button', { name: 'Login & workspace permissions · Access data' })).toBeVisible();
  expect(within(node).getByRole('button', { name: 'Document data governance · Document data' })).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Copy this canvas' }));
  expect(onReuse).toHaveBeenCalledExactlyOnceWith(PRODUCTION_WORKFLOWS['knowledge-base']);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('offers no copy where there is no workspace to copy into', async () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: '3D port cockpit' }));
  const dialog = screen.getByRole('dialog', { name: '3D port cockpit' });
  await within(dialog).findByRole('region');
  expect(within(dialog).queryByRole('button', { name: 'Copy this canvas' })).toBeNull();
});

it('closes on the backdrop only when the press and the release both land outside the box', () => {
  view();
  fireEvent.click(screen.getByRole('button', { name: 'Papercraft puzzle' }));
  const dialog = screen.getByRole('dialog', { name: 'Papercraft puzzle' });
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


it('speaks the same English in the English interface', async () => {
  localStorage.setItem('superclaw_locale', 'en');
  view();
  expect(screen.getByRole('heading', { level: 2, name: 'One brief, handed to a team of agents.' })).toBeVisible();
  const recording = cards()[KB], pixel = cards()[PIXEL];
  expect(within(recording).getByText('Recorded delivery')).toBeVisible();
  expect(within(pixel).getByText('Recorded delivery')).toBeVisible();
  expect(within(pixel).queryByText('Cover: AI illustration')).toBeNull();
  expect(recording.querySelector('video')).toHaveAttribute('src', '/showcase/kb-app-real.mp4');
  expect(within(recording).getByRole('button', { name: 'Team knowledge-base SaaS' })).toHaveAccessibleDescription(/^Recorded delivery “Build a team/);
  expect(document.querySelector('.production-translated')).toBeNull();
  expect(within(recording).getByText('Delivered')).toBeVisible();
  expect(within(recording).getByText('Real run · 7/7 nodes done')).toBeVisible();
  fireEvent.click(within(recording).getByRole('button', { name: 'Team knowledge-base SaaS' }));
  const dialog = screen.getByRole('dialog', { name: 'Team knowledge-base SaaS' });
  expect(within(dialog).getByText('7 agents · 5 stages')).toBeVisible();
  expect(within(dialog).getByText(/^Recorded: the page a real AwwO run delivered on 2026-10-13/)).toBeVisible();
  const made = await within(dialog).findByRole('region', { name: '7 agents, 5 stages, 6 min 39 s end to end' });
  // The run view no longer notes the language the agents worked in.
  expect(made.querySelector('.production-made-language')).toBeNull();
  expect(within(made).queryByText(/^The agents worked in /)).toBeNull();
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
  io.fire(io.live('near').find(watcher => watcher.targets[0] === videos[KB])!, true);
  expect(videos[KB]).toHaveAttribute('poster', '/showcase/kb-app-real.jpg');
  expect(videos.filter((_, index) => index !== KB).some(video => video.hasAttribute('poster'))).toBe(false);
  for (const watcher of io.live('near')) io.fire(watcher, true);
  const loops = io.live('play');
  expect(loops).toHaveLength(PRODUCTION_CASES.length);
  io.fire(loops[0], true);
  expect(play).toHaveBeenCalledTimes(1);
  io.fire(loops[0], true, false);   // in, then out, in one batch: the latest wins
  expect(play).toHaveBeenCalledTimes(1);
  expect(pause).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Summer sparkling-drink ad' }));
  expect(loops.every(watcher => watcher.disconnected)).toBe(true);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Team knowledge-base SaaS' }));
    const video = screen.getByRole('dialog').querySelector('video')!;
    expect(video.autoplay).toBe(false);
    expect(video.controls).toBe(true);
  } finally { restore(); }
});
