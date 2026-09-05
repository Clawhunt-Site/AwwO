import { apiRequest, API_PREFIX } from './api';
import { getSessionSummary } from './session';

// ── Types ──

interface TrackingEvent {
  event_type: string;
  payload_json: string;
}

// Injected at build time by Vite's `define` (vite.config.ts).
declare const __APP_VERSION__: string;

// ── Config ──

const BUFFER_LIMIT = 50;
const FLUSH_INTERVAL_MS = 5_000;
const EVENTS_ENDPOINT = `${API_PREFIX}/events`;

// ── State ──

let buffer: TrackingEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let sessionId: string | null = null;

// ── Helpers ──

function getInitData(): string {
  if (import.meta.env.DEV && import.meta.env.VITE_TELEGRAM_INIT_DATA) {
    return import.meta.env.VITE_TELEGRAM_INIT_DATA;
  }
  return window.Telegram?.WebApp?.initData || '';
}

function shouldFlushTracking(): boolean {
  return Boolean(getInitData());
}

/** RFC4122 UUID v4. Falls back to a math-random variant if crypto is unavailable. */
function generateUuid(): string {
  try {
    const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* noop */ }
  // Fallback — not cryptographically strong, but fine for anonymous session tagging.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Returns the current webview's session UUID, generating one lazily on first use.
 * Stable across route changes; reset only on webview reload (module re-init) or via {@link resetSession}.
 */
export function getOrCreateSessionId(): string {
  if (!sessionId) sessionId = generateUuid();
  return sessionId;
}

/** Reserved for future use — currently unused. Clears session UUID so the next event mints a new one. */
export function resetSession(): void {
  sessionId = null;
}

function readEntrySource(): string {
  try {
    return sessionStorage.getItem('entry_source') || 'direct';
  } catch {
    return 'direct';
  }
}

function readAppVersion(): string {
  try {
    // Replaced with a string literal at build time via vite.config.ts `define`.
    return __APP_VERSION__;
  } catch {
    return 'unknown';
  }
}

/** Best-effort flush via sendBeacon (for page unload). */
function beaconFlush(events: TrackingEvent[]): void {
  if (events.length === 0) return;
  if (!shouldFlushTracking()) return;
  try {
    const url =
      (import.meta.env.VITE_API_BASE_URL || 'https://api.myshell.fun') +
      EVENTS_ENDPOINT;
    const blob = new Blob(
      [JSON.stringify({ events })],
      { type: 'application/json' },
    );
    // sendBeacon doesn't support custom headers; fall back to fetch keepalive
    // so we can attach X-Telegram-Init-Data.
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'myshell-service-name': 'organics-api',
        'X-Telegram-Init-Data': getInitData(),
      },
      body: blob,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Swallow — tracking must never break the app.
  }
}

/** Normal flush via the shared apiRequest helper. */
async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  if (!shouldFlushTracking()) return;
  try {
    await apiRequest(EVENTS_ENDPOINT, { events: batch });
  } catch {
    // Silently drop — no retry for analytics.
    if (import.meta.env.DEV) {
      console.warn('[tracking] flush failed, dropped', batch.length, 'events');
    }
  }
}

/** Force-flush any buffered events immediately (used on session end). */
export function flushNow(): void {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  beaconFlush(batch);
}

// ── Public API ──

/**
 * Queue a tracking event. Flushes automatically when the buffer fills up
 * or on a 5-second interval. On page hide / unload, remaining events are
 * sent via fetch-keepalive.
 *
 * Common fields (session_id, app_version, entry_source) are injected
 * automatically. Caller-provided keys with the same name take precedence.
 */
export function trackEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
): void {
  try {
    const enriched: Record<string, unknown> = {
      session_id: getOrCreateSessionId(),
      app_version: readAppVersion(),
      entry_source: readEntrySource(),
      ...payload,
    };

    const event: TrackingEvent = {
      event_type: eventType,
      payload_json: JSON.stringify(enriched),
    };

    if (import.meta.env.DEV) {
      console.debug('[tracking]', eventType, enriched);
    }

    buffer.push(event);

    if (buffer.length >= BUFFER_LIMIT) {
      void flushBuffer();
    }
  } catch {
    // Never throw from tracking code.
  }
}

/** Start the periodic flush timer + register unload listeners. */
export function initTracking(): void {
  if (flushTimer) return; // Already initialised.

  // Mint the session UUID eagerly so every event (including ones fired
  // synchronously during bootstrap) shares the same session_id.
  getOrCreateSessionId();

  flushTimer = setInterval(() => {
    void flushBuffer();
  }, FLUSH_INTERVAL_MS);

  // Fire session_end at most once, from whichever unload signal arrives first.
  let sessionEndFired = false;
  const onSessionClose = () => {
    if (!sessionEndFired) {
      sessionEndFired = true;
      try {
        trackEvent('miniapp_session_end', getSessionSummary());
      } catch { /* noop */ }
    }
    if (buffer.length > 0) {
      beaconFlush(buffer);
      buffer = [];
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onSessionClose();
  });
  window.addEventListener('beforeunload', onSessionClose);
  window.addEventListener('pagehide', onSessionClose);
}
