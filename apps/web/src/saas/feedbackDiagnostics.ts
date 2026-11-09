// What the feedback assistant sends with a report besides the person's words (FeedbackAssistant.tsx, backend
// feedback.go): where they were, what browser and window, which build of the site, and what this page saw going wrong
// since it opened: its last script errors and the API requests that failed, newest last. Kept in memory only, a few of
// each, and only for a report the person sends.

const KEEP = 8;
const errors: string[] = [];
const requests: string[] = [];

const clock = () => new Date().toISOString().slice(11, 19);
const keep = (list: string[], item: string) => {
  list.push(item.length > 380 ? `${item.slice(0, 379)}…` : item);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
};

/** A script error the page met (the message and where), for the next report. */
export function noteFeedbackError(message: string, where = ''): void {
  const text = `${message}`.replace(/\s+/g, ' ').trim();
  if (text) keep(errors, `[${clock()}] ${text}${where ? ` @ ${where}` : ''}`);
}

/** An API request that failed: its method, path without the query, status and the API's code. */
export function noteFeedbackRequest(method: string, path: string, status: number, code: string): void {
  keep(requests, `[${clock()}] ${method.toUpperCase()} ${path.split('?')[0]} → ${status}${code ? ` ${code}` : ''}`);
}

/** Starts listening for the page's script errors and unhandled rejections; returns the way to stop. */
export function installFeedbackDiagnostics(): () => void {
  const onError = (event: ErrorEvent) => {
    const where = event.filename ? `${event.filename.split('/').pop()}:${event.lineno}:${event.colno}` : '';
    noteFeedbackError(event.message || String(event.error ?? 'Script error'), where);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    noteFeedbackError(`Unhandled rejection: ${reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)}`);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
}

export type FeedbackContext = {
  url: string; title: string; userAgent: string; viewport: string; screen: string; language: string; timezone: string;
  webBuild: string; uiMode: string; theme: string; errors: string[]; requests: string[];
};

/** The page's address without what a link may carry for one person alone (an invitation, a reset token): the server
 *  keeps only the parameters that say where the person was, and the page leaves the rest out before it sends. */
export function feedbackPageAddress(href = window.location.href): string {
  try {
    const url = new URL(href);
    const kept = new URLSearchParams();
    for (const key of ['tenant', 'canvas', 'view', 'section', 'account', 'case', 'tab', 'node']) {
      const value = url.searchParams.get(key);
      if (value) kept.set(key, value);
    }
    return `${url.origin}${url.pathname}${kept.size ? `?${kept}` : ''}`;
  } catch { return ''; }
}

/** The build of the site this page runs: the app's version and its entry script. */
function webBuild(): string {
  const version = import.meta.env.VITE_AWWO_VERSION || '';
  const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src.split('/').pop() || '';
  return [version, entry].filter(Boolean).join(' · ');
}

export function feedbackContext(uiMode: string): FeedbackContext {
  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* a browser without time zones */ }
  return {
    url: feedbackPageAddress(), title: document.title, userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}×${window.innerHeight}@${Math.round((window.devicePixelRatio || 1) * 100) / 100}`,
    screen: `${window.screen?.width ?? 0}×${window.screen?.height ?? 0}`, language: navigator.language || '', timezone,
    webBuild: webBuild(), uiMode, theme: document.documentElement.dataset.theme || 'light',
    errors: [...errors], requests: [...requests],
  };
}

/** For tests: forget what was noted. */
export function clearFeedbackDiagnostics(): void { errors.length = 0; requests.length = 0; }
