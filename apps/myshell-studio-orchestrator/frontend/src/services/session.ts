/**
 * Session bookkeeping for tracking v2.
 * - Classifies entry_source from Telegram start_param / URL params.
 * - Tracks session start timestamp + route changes so session_end can report
 *   accurate duration / page_views / last_route.
 * - Detects first-ever launch for is_new_user on miniapp_session_start.
 */

export type EntrySource = 'share_link' | 'tg_start' | 'direct' | 'notification';

interface ClassifiedEntry {
  entrySource: EntrySource;
  /** Raw start_param (minus `s_` prefix) when available — used as ref_code. */
  refCode: string;
}

function readStartParam(): string | null {
  try {
    const fromTg = (
      window.Telegram?.WebApp?.initDataUnsafe as { start_param?: string } | undefined
    )?.start_param;
    if (fromTg) return fromTg;
    const params = new URLSearchParams(window.location.search);
    return (
      params.get('startapp') ||
      params.get('tgWebAppStartParam') ||
      null
    );
  } catch {
    return null;
  }
}

export function classifyEntrySource(): ClassifiedEntry {
  const startParam = readStartParam();
  if (startParam && startParam.startsWith('s_')) {
    return { entrySource: 'share_link', refCode: startParam.slice(2) };
  }
  if (startParam) {
    return { entrySource: 'tg_start', refCode: startParam };
  }
  return { entrySource: 'direct', refCode: '' };
}

// ── Session lifecycle state (module-level, shared across imports) ──

const NEW_USER_STORAGE_KEY = 'dp_seen_before';
const sessionStartTs = Date.now();
let pageViews = 0;
let lastRoute = '';

/**
 * Marks the webview launch as observed and returns whether this is the user's
 * first time opening the app on this device (localStorage-based heuristic).
 */
export function recordSessionStart(): boolean {
  let isNew = false;
  try {
    isNew = localStorage.getItem(NEW_USER_STORAGE_KEY) !== '1';
    if (isNew) localStorage.setItem(NEW_USER_STORAGE_KEY, '1');
  } catch { /* storage blocked — fall back to false */ }
  return isNew;
}

/** Called by a router effect on each path change. */
export function notePageView(pathname: string): void {
  pageViews += 1;
  lastRoute = pathname;
}

export function getSessionSummary() {
  return {
    duration_ms: Date.now() - sessionStartTs,
    page_views: pageViews,
    last_route: lastRoute,
  };
}
