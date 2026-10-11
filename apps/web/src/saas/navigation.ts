// Moving between pages (home, a canvas, an account page) is a document navigation: each page starts from a clean
// module state, which the canvas relies on. What it must not feel like is a blank jump. Three things smooth it:
//
//   * the moment a navigation starts, the current page answers: a thin progress line runs at the top and the page
//     settles back, so a click never seems ignored while the next page loads;
//   * the browser keeps the old page on screen until the new one paints, then cross-fades (cross-document view
//     transitions, declared in saas.html; browsers without them simply swap);
//   * the new page paints at once with the AwwO boot surface (saas.html), in the reader's own theme, and that same
//     surface stays until the page has its content (Notice/CanvasLoading in SaaSApp), so nothing flashes white.
const ATTRIBUTE = 'navigating';
let clearTimer: ReturnType<typeof setTimeout> | null = null;

/** Show that a navigation is under way. Cleared on its own if the browser stayed (a cancelled unload prompt). */
export function beginNavigation(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset[ATTRIBUTE] = '1';
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(endNavigation, 9000);
}

export function endNavigation(): void {
  if (typeof document === 'undefined') return;
  delete document.documentElement.dataset[ATTRIBUTE];
  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
}

/** location.assign with the feedback above. */
export function navigateTo(url: string): void {
  beginNavigation();
  window.location.assign(url);
}

/** A plain same-tab link to another page of this site also gets the feedback (no default is prevented). */
export function installNavigationFeedback(): () => void {
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    let url: URL;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
    // The API's own routes (downloads, sign-in redirects) are not pages of the app.
    if (url.pathname.startsWith('/api/')) return;
    beginNavigation();
  };
  // A page restored from the back-forward cache is not navigating any more.
  const shown = () => endNavigation();
  document.addEventListener('click', click);
  window.addEventListener('pageshow', shown);
  return () => { document.removeEventListener('click', click); window.removeEventListener('pageshow', shown); };
}
