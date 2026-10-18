import { canFlushSaaSCanvas, currentSaaSCanvas, flushSaaSCanvas } from './canvasBridge';
import { hasUnsavedEdits } from '../canvas/unsavedEdits';

// A tab opened before a website release keeps running the build it loaded, and fetches parts of that build lazily: case
// records, previews, the 3D and PDF viewers, the tutorial. The host keeps serving earlier releases' files, so such a load
// normally still works. When one fails anyway, this asks the site which build it serves now; if it is a newer one, the
// notice (StaleBuildNotice) saves the open canvas first and then offers a reload. Nothing here reloads the page by
// itself: a reload drops whatever this page has not saved yet.

const ENTRY = /^\/assets\/saas-[^/]+\.js$/;
/** The page's entry script as its document names it: /assets/saas-<hash>.js in a build (another module script, a
 * browser extension's say, does not count), the first module script in development. */
export function entryScript(page: Document): string | null {
  const paths = [...page.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map(script => {
    try { return new URL(script.getAttribute('src') ?? '', window.location.href).pathname; } catch { return null; }
  }).filter((path): path is string => Boolean(path));
  return paths.find(path => ENTRY.test(path)) ?? paths[0] ?? null;
}

/** How long the site may take to answer which build it serves. */
export const CHECK_DEADLINE_MS = 10_000;
/** Whether the site now serves another build than the one this page runs: its page names another entry script. A page
 * that cannot be read in time says nothing either way. */
export async function checkForNewerBuild(fetchPage: typeof fetch = (input, init) => fetch(input, init)): Promise<boolean> {
  const own = entryScript(document);
  if (!own) return false;
  const response = await fetchPage('/saas.html', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(CHECK_DEADLINE_MS) });
  if (!response.ok) return false;
  const live = entryScript(new DOMParser().parseFromString(await response.text(), 'text/html'));
  return live !== null && live !== own;
}

/** A burst of failed loads (a preview's modules, say) asks once, and a page whose loads keep failing on the build the
 * site still serves asks at most this often; a failure in between is asked about when the pause is over. */
export const RECHECK_MS = 10_000;
// 0 while no newer build is known; from then on, how many loads have failed since (each one may show the notice again).
let failures = 0;
let checking: Promise<boolean> | null = null;
let lastCheck = -Infinity;
let later: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of [...listeners]) listener(); };

export function staleBuildFailures(): number { return failures; }
export function onStaleBuild(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A lazily loaded part of this page did not load. Resolves true once a newer build is known to be live. */
export function noteLoadFailure(fetchPage?: typeof fetch): Promise<boolean> {
  if (failures) { failures += 1; changed(); return Promise.resolve(true); }
  if (checking) return checking;
  const wait = lastCheck + RECHECK_MS - Date.now();
  if (wait > 0) {
    // React.lazy keeps a failed import, so that part will not fail again to be asked about: ask once the pause is over.
    later ??= setTimeout(() => { later = null; void noteLoadFailure(fetchPage); }, wait);
    return Promise.resolve(false);
  }
  lastCheck = Date.now();
  checking = checkForNewerBuild(fetchPage).catch(() => false).then(newer => {
    checking = null;
    if (newer && !failures) { failures = 1; changed(); }
    return failures > 0;
  });
  return checking;
}

/** Listens for the load failures Vite reports: `vite:preloadError`, sent when a lazily imported chunk, or a stylesheet
 * it needs, did not load. The event is left as it is, so the import still fails for its caller, which says so as
 * before. */
export function installStaleBuildWatch(target: Window = window): () => void {
  const failed = () => { void noteLoadFailure(); };
  target.addEventListener('vite:preloadError', failed);
  return () => target.removeEventListener('vite:preloadError', failed);
}

export type CanvasSaveOutcome =
  /** The server has every edit of the open canvas. */
  | { readonly kind: 'saved' }
  /** Nothing a reload could lose: no canvas, a read-only one, or one still loading or showing its local drafts. */
  | { readonly kind: 'nothing' }
  /** An editor on the page (a node inspector) holds changes the canvas does not have yet; it must save or close first. */
  | { readonly kind: 'editor' }
  | { readonly kind: 'failed'; readonly timedOut: boolean };
export const SAVE_DEADLINE_MS = 20_000;

/** Saves the open canvas now. It resolves 'saved' only once the server has confirmed every edit (flushSaaSCanvas). */
export async function saveOpenCanvas(deadlineMs = SAVE_DEADLINE_MS): Promise<CanvasSaveOutcome> {
  const scope = currentSaaSCanvas();
  let saved = false;
  if (scope && scope.tenant.role !== 'reader' && canFlushSaaSCanvas()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), deadlineMs); });
    try {
      if (await Promise.race([flushSaaSCanvas().then(() => 'saved' as const), deadline]) === 'late') return { kind: 'failed', timedOut: true };
      saved = true;
    } catch {
      return { kind: 'failed', timedOut: false };
    } finally {
      clearTimeout(timer);
    }
  }
  if (hasUnsavedEdits()) return { kind: 'editor' };
  return saved ? { kind: 'saved' } : { kind: 'nothing' };
}

/** How a reload is made: a property, so a test can watch it. */
export const page = { reload: () => window.location.reload() };

/** Saves the open canvas, then reloads when nothing would be lost and `wanted()` still says so (the person may have
 * changed their mind while the save ran); otherwise leaves the page as it is and says why. */
export async function reloadAfterSaving(wanted: () => boolean = () => true, deadlineMs = SAVE_DEADLINE_MS): Promise<CanvasSaveOutcome> {
  const outcome = await saveOpenCanvas(deadlineMs);
  if ((outcome.kind === 'saved' || outcome.kind === 'nothing') && wanted()) page.reload();
  return outcome;
}
