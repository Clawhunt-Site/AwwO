// ── Network Probe ──
// Lightweight metrics collector for API request timing & errors.
// Hooks into apiRequest() — does NOT replace fetch.
// Batches metrics and sends via sendBeacon to a CF Worker.

const REPORT_URL = 'https://fantasia-probe.mike-651.workers.dev/report';
const FLUSH_INTERVAL = 30_000;
const MAX_BUFFER = 50;

interface NetworkMetric {
  url: string;                // API path only (no host)
  status: number | null;      // HTTP status, null = network failure
  duration: number;           // ms
  errorType: 'none' | 'timeout' | 'network' | 'http' | 'abort';
  errorMessage?: string;
  timestamp: number;
  userId?: string;
  platform?: string;
  languageCode?: string;
}

const buffer: NetworkMetric[] = [];

// TG context — resolved once at init
let tgCtx: { userId?: string; platform?: string; languageCode?: string } = {};

function resolveTgContext() {
  try {
    const wa = window.Telegram?.WebApp as any;
    if (!wa) return;
    const user = wa.initDataUnsafe?.user;
    tgCtx = {
      platform: wa.platform || 'unknown',
      languageCode: user?.language_code || '',
      userId: String(user?.id || ''),
    };
  } catch { /* best-effort */ }
}

// ── Public: record a completed request ──

export function recordMetric(
  endpoint: string,
  status: number | null,
  duration: number,
  errorType: NetworkMetric['errorType'],
  errorMessage?: string,
) {
  // Only track our API, skip S3 uploads etc.
  if (!endpoint.includes('/v1/')) return;

  buffer.push({
    url: endpoint,
    status,
    duration: Math.round(duration),
    errorType,
    errorMessage: errorMessage?.slice(0, 200),
    timestamp: Date.now(),
    ...tgCtx,
  });

  if (buffer.length >= MAX_BUFFER) flush();
}

// ── Flush to CF Worker ──

function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0);

  try {
    const ok = navigator.sendBeacon(REPORT_URL, JSON.stringify(batch));
    if (!ok) saveToLocal(batch);
  } catch {
    saveToLocal(batch);
  }
}

// ── localStorage fallback (best-effort) ──

const STORAGE_KEY = '_np_pending';

function saveToLocal(data: NetworkMetric[]) {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const existing: NetworkMetric[] = stored ? JSON.parse(stored) : [];
    const merged = [...existing, ...data].slice(-200);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch { /* silent */ }
}

function flushPending() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const pending = JSON.parse(stored);
    if (!Array.isArray(pending) || pending.length === 0) return;
    localStorage.removeItem(STORAGE_KEY);
    navigator.sendBeacon(REPORT_URL, JSON.stringify(pending));
  } catch { /* silent */ }
}

// ── Nav Timing (bonus — first-load breakdown) ──

function collectNavTiming() {
  if (!window.performance?.getEntriesByType) return;

  window.addEventListener('load', () => {
    setTimeout(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      if (!nav) return;

      buffer.push({
        url: '/__nav_timing__',
        status: 200,
        duration: Math.round(nav.loadEventEnd - nav.startTime),
        errorType: 'none',
        timestamp: Date.now(),
        ...tgCtx,
        errorMessage: JSON.stringify({
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: Math.round(nav.connectEnd - nav.connectStart),
          tls: Math.round((nav as any).secureConnectionEnd - nav.secureConnectionStart),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          download: Math.round(nav.responseEnd - nav.responseStart),
          domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
        }),
      });
    }, 0);
  });
}

// ── Init (call once from main.tsx) ──

export function initNetworkProbe() {
  resolveTgContext();
  collectNavTiming();
  flushPending();
  setInterval(flush, FLUSH_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
