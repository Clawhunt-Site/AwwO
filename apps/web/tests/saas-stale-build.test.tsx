import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLayoutEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Tenant } from '../src/saas/api';
import { localeHtmlLang } from '../src/locale';

// A tab opened before a website release runs its own build; when a part of it does not load and the site serves another
// build by now, the page saves its canvas, then offers the reload, and never reloads by itself.
type Modules = {
  stale: typeof import('../src/saas/staleBuild');
  bridge: typeof import('../src/saas/canvasBridge');
  edits: typeof import('../src/canvas/unsavedEdits');
  notice: typeof import('../src/saas/StaleBuildNotice');
  prefs: typeof import('../src/saas/preferences');
};
let m: Modules;
let served: string;
let fetchPage: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let stops: Array<() => void>;
const OWN = '/assets/saas-Own11111.js';
const NEWER = '/assets/saas-Newer222.js';
const page = (entry: string | null) => `<!doctype html><html><head>${entry ? `<script type="module" crossorigin src="${entry}"></script>` : ''}</head><body><div id="root"></div></body></html>`;
const tenant = (role: Tenant['role']): Tenant => ({ id: 'team', name: 'Team', role, status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 20, createdAt: '2026-09-01T08:00:00Z' });
const LEAD = 'AwwO was updated after this page was opened, so part of the page could not load.';
type Deferred = { promise: Promise<number>; resolve: (version: number) => void; reject: (error: Error) => void };
const deferred = (): Deferred => {
  let resolve!: Deferred['resolve'], reject!: Deferred['reject'];
  const promise = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem('superclaw_locale', 'en');
  document.head.innerHTML = `<script type="module" crossorigin src="${OWN}"></script>`;
  served = NEWER;
  fetchPage = vi.fn(async () => new Response(page(served), { status: 200, headers: { 'Content-Type': 'text/html' } }));
  vi.stubGlobal('fetch', fetchPage);
  m = {
    stale: await import('../src/saas/staleBuild'),
    bridge: await import('../src/saas/canvasBridge'),
    edits: await import('../src/canvas/unsavedEdits'),
    notice: await import('../src/saas/StaleBuildNotice'),
    prefs: await import('../src/saas/preferences'),
  };
  reload = vi.fn();
  vi.spyOn(m.stale.page, 'reload').mockImplementation(reload);
  stops = [];
});
afterEach(() => {
  for (const stop of stops) stop();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = '';
});

const show = () => render(<m.prefs.SaaSPreferencesProvider><m.notice.StaleBuildNotice /></m.prefs.SaaSPreferencesProvider>);
const watch = () => { stops.push(m.stale.installStaleBuildWatch()); };
/** What Vite's preload helper sends when a lazily imported chunk, or a stylesheet it needs, does not load. */
const loadFails = () => {
  const event = Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: new TypeError('Failed to fetch dynamically imported module') });
  act(() => { window.dispatchEvent(event); });
  return event;
};
const openCanvas = (role: Tenant['role'], save: () => Promise<number>) => {
  m.bridge.configureSaaSCanvas({ tenant: tenant(role), canvasId: 'canvas-1' });
  m.bridge.configureSaaSCanvasSave(save);
};
const button = (name: string) => screen.queryByRole('button', { name });

it('saves the open canvas before it offers the reload, and reloads only when asked', async () => {
  const first = deferred(), second = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  openCanvas('owner', save);
  watch();
  show();
  const event = loadFails();
  // The import still fails for its own caller, which says so as before.
  expect(event.defaultPrevented).toBe(false);
  expect(await screen.findByRole('alert')).toHaveTextContent(`${LEAD} Saving your canvas first…`);
  expect(fetchPage).toHaveBeenCalledWith('/saas.html', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  expect(save).toHaveBeenCalledTimes(1);
  expect(button('Reload')).not.toBeInTheDocument();
  await act(async () => { first.resolve(4); });
  expect(screen.getByRole('alert')).toHaveTextContent(`${LEAD} Your canvas is saved: reload to use the new version.`);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(reload).not.toHaveBeenCalled();
  // Edits made since are saved too before the page goes.
  fireEvent.click(button('Reload')!);
  expect(save).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
  await act(async () => { second.resolve(5); });
  expect(reload).toHaveBeenCalledTimes(1);
});

it('does not reload once “Not now” was asked while the reload waited for its save', async () => {
  const slow = deferred();
  const save = vi.fn().mockResolvedValueOnce(3).mockReturnValueOnce(slow.promise);
  openCanvas('owner', save);
  watch();
  show();
  loadFails();
  await waitFor(() => expect(button('Reload')).toBeVisible());
  fireEvent.click(button('Reload')!);
  expect(screen.getByRole('alert')).toHaveTextContent('Saving your canvas first…');
  fireEvent.click(button('Not now')!);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => { slow.resolve(4); });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(save).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
});

it('offers no reload while the canvas cannot be saved, and sends the person to the canvas’s own message', async () => {
  const save = vi.fn().mockRejectedValue(new Error('画布未同步，请先解决保存错误再运行。'));
  openCanvas('member', save);
  watch();
  show();
  loadFails();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`${LEAD} Your canvas has changes that could not be saved: see the message above the canvas, and export a local copy before reloading.`));
  expect(button('Reload')).not.toBeInTheDocument();
  // The canvas stays failed until the page reloads, so saving again cannot help.
  expect(button('Try saving again')).not.toBeInTheDocument();
  expect(button('Not now')).toBeVisible();
  expect(reload).not.toHaveBeenCalled();
});

it('offers to save again after a save that takes too long, and then the reload', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const save = vi.fn().mockReturnValueOnce(new Promise<number>(() => {})).mockResolvedValueOnce(6);
  openCanvas('owner', save);
  watch();
  show();
  loadFails();
  await act(async () => { await vi.advanceTimersByTimeAsync(m.stale.SAVE_DEADLINE_MS); });
  expect(screen.getByRole('alert')).toHaveTextContent(`${LEAD} Your canvas is not saved yet: saving has taken more than 20 seconds. Reload once it is saved, so no change is lost.`);
  expect(button('Reload')).not.toBeInTheDocument();
  fireEvent.click(button('Try saving again')!);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(button('Reload')).toBeVisible();
  expect(save).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
});

it('holds the reload while an open editor has changes the canvas does not have yet', async () => {
  let editing = true;
  const stop = m.edits.registerUnsavedEdits(() => editing);
  stops.push(stop);
  const save = vi.fn(async () => 7);
  openCanvas('owner', save);
  watch();
  show();
  loadFails();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`${LEAD} An editor you have open holds changes the canvas does not have yet: save or close it, then reload, so no change is lost.`));
  expect(save).toHaveBeenCalledTimes(1);
  expect(button('Reload')).not.toBeInTheDocument();
  editing = false;
  fireEvent.click(button('Done, check again')!);
  await waitFor(() => expect(button('Reload')).toBeVisible());
  expect(screen.getByRole('alert')).toHaveTextContent('Your canvas is saved: reload to use the new version.');
  expect(reload).not.toHaveBeenCalled();
  // A reload asked for while the editor is open again waits too.
  editing = true;
  fireEvent.click(button('Reload')!);
  await waitFor(() => expect(button('Done, check again')).toBeVisible());
  expect(reload).not.toHaveBeenCalled();
});

it('gives a save that takes too long up, without a reload', async () => {
  openCanvas('owner', () => new Promise<number>(() => {}));
  expect(await m.stale.saveOpenCanvas(10)).toEqual({ kind: 'failed', timedOut: true });
  expect(await m.stale.reloadAfterSaving(() => true, 10)).toEqual({ kind: 'failed', timedOut: true });
  expect(reload).not.toHaveBeenCalled();
});

it('has nothing to save without an open canvas, on a read-only one, or on one still loading', async () => {
  expect(await m.stale.saveOpenCanvas()).toEqual({ kind: 'nothing' });
  const save = vi.fn(async () => 1);
  openCanvas('reader', save);
  expect(await m.stale.saveOpenCanvas()).toEqual({ kind: 'nothing' });
  m.bridge.configureSaaSCanvasSave(null);
  m.bridge.configureSaaSCanvas({ tenant: tenant('owner'), canvasId: 'canvas-1' });
  expect(await m.stale.saveOpenCanvas()).toEqual({ kind: 'nothing' });
  expect(save).not.toHaveBeenCalled();
});

it('offers the reload at once on a page without a canvas', async () => {
  watch();
  show();
  loadFails();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`${LEAD} Reload to use the new version.`));
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(button('Reload')!);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('says nothing while the site still serves this build: the load failed for another reason', async () => {
  served = OWN;
  watch();
  show();
  loadFails();
  await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('asks the site once for a burst of failed loads, and about a failure in the pause once it is over', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  served = OWN;
  const answers = await Promise.all([1, 2, 3, 4, 5].map(() => m.stale.noteLoadFailure()));
  expect(answers).toEqual([false, false, false, false, false]);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  // A lazily loaded part keeps its failed import, so a failure during the pause is asked about once it is over.
  expect(await m.stale.noteLoadFailure()).toBe(false);
  expect(await m.stale.noteLoadFailure()).toBe(false);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  served = NEWER;
  await vi.advanceTimersByTimeAsync(m.stale.RECHECK_MS - 1);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(m.stale.staleBuildFailures()).toBe(1);
  // Once known, it is not asked again.
  expect(await m.stale.noteLoadFailure()).toBe(true);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(m.stale.staleBuildFailures()).toBe(2);
});

it('takes a page it cannot read, or one without a module script, for no newer build', async () => {
  fetchPage.mockResolvedValueOnce(new Response('busy', { status: 503 }));
  expect(await m.stale.checkForNewerBuild()).toBe(false);
  fetchPage.mockResolvedValueOnce(new Response(page(null), { status: 200 }));
  expect(await m.stale.checkForNewerBuild()).toBe(false);
  fetchPage.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
  expect(await m.stale.noteLoadFailure()).toBe(false);
  // A page that does not say which build it runs (no module script) cannot tell either.
  document.head.innerHTML = '';
  expect(await m.stale.checkForNewerBuild()).toBe(false);
});

it('reads the entry script, not another module script before it', () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  expect(m.stale.entryScript(parse(page('/assets/saas-X1234567.js?v=1')))).toBe('/assets/saas-X1234567.js');
  // A browser extension's module script ahead of the entry does not count.
  expect(m.stale.entryScript(parse('<head><script type="module" src="chrome-extension://abc/inject.js"></script><script type="module" src="/assets/saas-X1234567.js"></script></head>')))
    .toBe('/assets/saas-X1234567.js');
  // In development the entry is the source module.
  expect(m.stale.entryScript(parse('<body><script type="module" src="/src/saas/main.tsx"></script></body>'))).toBe('/src/saas/main.tsx');
  expect(m.stale.entryScript(parse('<head><script src="/legacy.js"></script></head>'))).toBeNull();
});

it('stays away after “Not now” until another part fails to load, then saves again first', async () => {
  const again = deferred();
  const save = vi.fn().mockResolvedValueOnce(3).mockReturnValueOnce(again.promise);
  openCanvas('owner', save);
  watch();
  show();
  loadFails();
  await waitFor(() => expect(button('Reload')).toBeVisible());
  fireEvent.click(button('Not now')!);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(1);
  loadFails();
  expect(await screen.findByRole('alert')).toHaveTextContent(`${LEAD} Saving your canvas first…`);
  expect(button('Reload')).not.toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(2);
  await act(async () => { again.resolve(4); });
  expect(button('Reload')).toBeVisible();
  // The site was asked once: a newer build, once known, stays known.
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});

it('speaks the interface language', async () => {
  localStorage.setItem('superclaw_locale', 'zh');
  watch();
  show();
  loadFails();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('AwwO 在这个页面打开后更新过，页面的一部分没能加载。 重新加载即可使用新版本。'));
  expect(button('重新加载')).toBeVisible();
  expect(button('暂不')).toBeVisible();
});

// While a modal dialog is open the rest of the page is inert, so the notice moves into the dialog opened last, as a
// popover above the dialog's content, and comes back to the page when that dialog closes.
/** A dialog as showModal() leaves it in a browser: open, and :modal while open (jsdom's stub only sets the attribute). */
const modalDialog = (before?: Element) => {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = '<p>A case</p>';
  document.body.insertBefore(dialog, before ?? null);
  const matches = dialog.matches.bind(dialog);
  vi.spyOn(dialog, 'matches').mockImplementation(selector => selector === ':modal' ? dialog.hasAttribute('open') : matches(selector));
  dialog.setAttribute('open', '');
  stops.push(() => dialog.remove());
  return dialog;
};
/** Popovers as a browser shows them: `shown` lists each node shown, in order. jsdom hides a [popover] that is not open
 * but cannot open one, so a shown one gets the display it would have. */
const popovers = (fails = false) => {
  const shown: Element[] = [];
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value(this: HTMLElement) {
    if (fails) throw new DOMException('Not supported', 'NotSupportedError');
    shown.push(this);
    this.style.display = 'flex';
  } });
  stops.push(() => { delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover; });
  return shown;
};

it('moves into an open modal dialog, as a popover above it, so its buttons can be used', async () => {
  const shown = popovers();
  const dialog = modalDialog();
  watch();
  show();
  loadFails();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`${LEAD} Reload to use the new version.`));
  const notice = screen.getByRole('alert');
  expect(dialog.contains(notice)).toBe(true);
  expect(notice).toHaveAttribute('popover', 'manual');
  expect(shown).toEqual([notice]);
  fireEvent.click(button('Reload')!);
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it('comes back to the page when the dialog closes, still offering what it offered', async () => {
  const shown = popovers();
  const dialog = modalDialog();
  watch();
  show();
  loadFails();
  await waitFor(() => expect(button('Reload')).toBeVisible());
  act(() => { dialog.removeAttribute('open'); });
  await waitFor(() => expect(dialog.contains(screen.getByRole('alert'))).toBe(false));
  const notice = screen.getByRole('alert');
  expect(notice).not.toHaveAttribute('popover');
  expect(notice).toHaveTextContent(`${LEAD} Reload to use the new version.`);
  expect(button('Reload')).toBeVisible();
  expect(shown).toHaveLength(1);
  // A dialog opened afterwards takes it in again, shown anew.
  const next = modalDialog();
  await waitFor(() => expect(next.contains(screen.getByRole('alert'))).toBe(true));
  expect(shown).toHaveLength(2);
  expect(shown[1]).toBe(screen.getByRole('alert'));
});

it('goes into the dialog opened last, whatever their order on the page, and back when it closes', async () => {
  popovers();
  const first = modalDialog();
  watch();
  show();
  loadFails();
  await waitFor(() => expect(first.contains(screen.getByRole('alert'))).toBe(true));
  const second = modalDialog(first);
  await waitFor(() => expect(second.contains(screen.getByRole('alert'))).toBe(true));
  act(() => { second.removeAttribute('open'); });
  await waitFor(() => expect(first.contains(screen.getByRole('alert'))).toBe(true));
  act(() => { first.remove(); });
  await waitFor(() => expect(screen.getByRole('alert').closest('dialog')).toBeNull());
});

it('is "Not now" inside the dialog too, and stays a plain box there where popovers do not work', async () => {
  popovers(true);
  const dialog = modalDialog();
  watch();
  show();
  loadFails();
  await waitFor(() => expect(dialog.contains(screen.getByRole('alert'))).toBe(true));
  expect(button('Not now')).toBeVisible();
  const notice = screen.getByRole('alert');
  // showPopover() threw, so the browser's popover rules would keep it hidden: it is an ordinary box instead.
  expect(notice).not.toHaveAttribute('popover');
  fireEvent.click(button('Not now')!);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});

it('stays the page’s own box while only a non-modal dialog is open', async () => {
  const shown = popovers();
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  document.body.appendChild(dialog);
  stops.push(() => dialog.remove());
  watch();
  show();
  loadFails();
  await waitFor(() => expect(button('Reload')).toBeVisible());
  expect(dialog.contains(screen.getByRole('alert'))).toBe(false);
  expect(screen.getByRole('alert')).not.toHaveAttribute('popover');
  expect(shown).toEqual([]);
});

it('goes into the dialog that holds the focus when several were open before it came up', async () => {
  popovers();
  const lower = modalDialog();
  // Opened later, over the first, though earlier on the page: only the dialog on top can hold the focus.
  const upper = modalDialog(lower);
  const field = document.createElement('button');
  field.textContent = 'In the upper dialog';
  upper.appendChild(field);
  field.focus();
  watch();
  show();
  loadFails();
  await waitFor(() => expect(upper.contains(screen.getByRole('alert'))).toBe(true));
});

it('is shown again above its dialog when that dialog reopens in one step', async () => {
  const shown = popovers();
  const dialog = modalDialog();
  watch();
  show();
  loadFails();
  await waitFor(() => expect(dialog.contains(screen.getByRole('alert'))).toBe(true));
  expect(shown).toHaveLength(1);
  // As the forced tutorial does when the browser closes it anyway: closed and opened again before the page notices.
  act(() => { dialog.removeAttribute('open'); dialog.setAttribute('open', ''); });
  await waitFor(() => expect(shown).toHaveLength(2));
  expect(shown[1]).toBe(screen.getByRole('alert'));
  expect(dialog.contains(screen.getByRole('alert'))).toBe(true);
});

it('comes back to the page when the component that owns its dialog goes', async () => {
  popovers();
  function OwnDialog() {
    const ref = useRef<HTMLDialogElement>(null);
    useLayoutEffect(() => {
      const dialog = ref.current!;
      const matches = dialog.matches.bind(dialog);
      vi.spyOn(dialog, 'matches').mockImplementation(selector => selector === ':modal' ? dialog.hasAttribute('open') : matches(selector));
      dialog.showModal();
      return () => dialog.close();
    }, []);
    return <dialog ref={ref} lang="en"><p>A case</p></dialog>;
  }
  watch();
  const tree = (open: boolean) => <m.prefs.SaaSPreferencesProvider><m.notice.StaleBuildNotice />{open && <OwnDialog />}</m.prefs.SaaSPreferencesProvider>;
  const { rerender } = render(tree(true));
  loadFails();
  await waitFor(() => expect(screen.getByRole('alert').closest('dialog')).not.toBeNull());
  rerender(tree(false));
  await waitFor(() => expect(screen.getByRole('alert').closest('dialog')).toBeNull());
  expect(screen.getByRole('alert')).toBeVisible();
  expect(button('Reload')).toBeVisible();
});

it('keeps the interface language inside a dialog in another one', async () => {
  localStorage.setItem('superclaw_locale', 'zh');
  popovers();
  const dialog = modalDialog();
  dialog.lang = 'en';
  watch();
  show();
  loadFails();
  await waitFor(() => expect(dialog.contains(screen.getByRole('alert'))).toBe(true));
  expect(screen.getByRole('alert')).toHaveAttribute('lang', localeHtmlLang('zh'));
  expect(screen.getByRole('alert')).toHaveTextContent('AwwO 在这个页面打开后更新过');
});
