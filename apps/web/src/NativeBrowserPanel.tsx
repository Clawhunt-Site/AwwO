import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';
import type { AppCopyKey } from './App';
import { getUiZoom } from './zoom';
import {
  DESKTOP_BROWSER_EVENT,
  navigateDesktopBrowser,
  openDesktopBrowser,
  setDesktopBrowserBounds,
  type DesktopBrowserEvent,
  type DesktopBrowserRect,
  type DesktopInvoke,
} from './desktop';

/**
 * Reference viewer — native browser sub-view (desktop only, presentation layer).
 *
 * Unlike {@link WebPreviewPanel} (a sanitized, inert reader), this is a REAL,
 * interactive browser: an OS-native child webview the Rust shell overlays on the
 * `.native-browser-host` rectangle below the toolbar. Scripts, cookies, and the
 * network are all live — the deliberate, owner-approved replacement for the
 * reader so pages render faithfully and can be scrolled/clicked/logged into.
 *
 * This component owns no rendering of the page itself; it only (1) measures the
 * host rectangle and keeps the native webview pinned to it, (2) renders a DOM
 * toolbar ABOVE the host (a native webview always paints over the DOM, so chrome
 * must not overlap it), and (3) reflects navigation/load state pushed back from
 * Rust as a `superclaw:ref-browser` CustomEvent.
 *
 * Pointer note: while the panel divider is dragged the host resizes continuously;
 * we hide the native webview during that burst and restore it once the size
 * settles, because a visible native surface would swallow the divider's
 * move/up pointer stream (it sits above the DOM and cannot be pointer-captured).
 *
 * Known v1 limitations (deliberate, documented as backlog — none is a regression
 * over the reader, which also fetched fresh every time):
 *  - ONE shared native webview. Within a tab you browse freely with full state;
 *    switching to another tab and back reloads the tab's original url (in-page
 *    history/scroll/form state are not preserved across switches). True per-tab
 *    persistence needs per-tab webviews.
 *  - `target="_blank"` / `window.open` open in-place; popup-window OAuth that
 *    needs `window.opener`/`postMessage` won't complete (redirect-flow login
 *    works). Allowing real popups would reopen the IPC-isolation hole, so this is
 *    a deliberate security trade-off.
 *  - Downloads are not surfaced. A DOM overlay (app modal) covering the panel is
 *    occluded by the native surface.
 */

export type NativeBrowserTranslate = (key: AppCopyKey) => string;

// Frames of stillness before the webview is re-shown after a move/resize burst
// (~100ms at 60fps) — short enough to feel immediate, long enough to outlast a
// drag's per-frame updates.
const SETTLE_FRAMES = 6;
// After the rect has been stable this many frames (~0.3s) the reconciliation loop
// suspends itself, so an idle panel costs zero rAF/CPU. It re-wakes on resize /
// scroll / pointermove — the only things that move or resize the host.
const SLEEP_AFTER_STILL_FRAMES = 18;
// Measure-only safety-net poll (catches event-less layout shifts the wake events
// miss). One getBoundingClientRect per tick; no IPC unless the rect actually moved.
const CATCHUP_POLL_MS = 500;

/**
 * Best-effort normalization of an address-bar entry into a clean http(s) URL.
 * A bare host gains an `https://`; an explicit non-http(s) `scheme://` (e.g.
 * `ftp://`) is refused outright rather than silently re-prefixed. This is UX
 * convenience only — the Rust shell re-validates with the same http(s)-only
 * guard as external links, so it is the real gate.
 */
export function normalizeBrowserAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  // An explicit `scheme://` that isn't http(s) → refuse (don't re-prefix it).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function NativeBrowserPanel({
  url,
  invoke,
  onOpenExternal,
  t,
}: {
  url: string;
  invoke: DesktopInvoke;
  onOpenExternal: (url: string) => void;
  t: NativeBrowserTranslate;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [address, setAddress] = useState(url);
  const [currentUrl, setCurrentUrl] = useState(url);
  const [loading, setLoading] = useState(true);

  const measure = useCallback((): DesktopBrowserRect | null => {
    const el = hostRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // The native child webview is positioned in the window's UNZOOMED logical
    // points, but the app applies a native WKWebView page zoom to the main webview
    // (see zoom.ts), so getBoundingClientRect reports coordinates in the ZOOMED
    // CSS space (1 CSS px = `zoom` points). Scale by the live zoom factor or the
    // overlay lands at 1/zoom of the host's true position/size (e.g. zoom 1.25 →
    // the browser renders shrunk and shifted toward the top-left, off its panel).
    const zoom = getUiZoom();
    return {
      x: rect.left * zoom,
      y: rect.top * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
  }, []);

  // Open (first mount) / re-point (url prop change). The Rust command reuses the
  // existing child webview and just navigates (and re-shows it) when one is
  // already open, so a url change — or a remount after a tab switch — re-points
  // and re-shows the same surface rather than recreating it.
  useEffect(() => {
    setAddress(url);
    setCurrentUrl(url);
    setLoading(true);
    const rect = measure();
    if (rect) void openDesktopBrowser(invoke, url, rect).catch(() => undefined);
  }, [url, invoke, measure]);

  // Hide (do NOT destroy) the native webview when the panel unmounts (tab
  // switched/closed, drawer closed). Destroying on unmount would race the next
  // panel's open on the shared singleton label; hiding leaves the surface intact
  // for the next open() to reuse. Ordering vs the next open() is guaranteed by
  // the serialized op chain in desktop.ts, so the surface ends correctly
  // shown/hidden without a self-healing heartbeat. (It is destroyed at process
  // exit. Cross-tab page state is NOT preserved — see the file header.)
  useEffect(() => {
    return () => {
      void setDesktopBrowserBounds(invoke, { x: 0, y: 0, width: 0, height: 0 }, true).catch(
        () => undefined,
      );
    };
  }, [invoke]);

  // Keep the native webview pinned to the live host rectangle. A ResizeObserver
  // only catches SIZE changes, but the panel also MOVES without resizing (sidebar
  // shift, ancestor scroll), which would strand the overlay. So we reconcile
  // against the absolute rect — but only while something is moving: the loop wakes
  // on resize/scroll/pointermove/visibility (plus a cheap measure-only poll for
  // event-less shifts), runs until the rect is stable for SLEEP_AFTER_STILL
  // frames, then suspends (an idle panel costs zero rAF/IPC). A SIZE change (a
  // resize drag) hides the webview once — a native surface paints above the DOM
  // and would swallow the divider's pointer stream (it can't be pointer-captured)
  // — and re-shows on settle; a pure TRANSLATION follows live and stays visible
  // (hiding on every scroll tick would blink it).
  useEffect(() => {
    let frame = 0;
    let prev: DesktopBrowserRect | null = measure(); // baseline = current shown rect
    let visible = true;
    let stillFrames = 0;

    const sameRect = (rect: DesktopBrowserRect) =>
      prev &&
      rect.x === prev.x &&
      rect.y === prev.y &&
      rect.width === prev.width &&
      rect.height === prev.height;
    const sizeChanged = (rect: DesktopBrowserRect) =>
      !prev || rect.width !== prev.width || rect.height !== prev.height;

    const tick = () => {
      const rect = measure();
      if (rect) {
        if (!sameRect(rect)) {
          const resized = sizeChanged(rect);
          prev = rect;
          stillFrames = 0;
          if (resized) {
            // SIZE change = a resize drag (divider / window edge). Hide ONCE so the
            // native surface can't swallow the drag's pointer stream; the final rect
            // is applied on settle below — no per-frame IPC while hidden.
            if (visible) {
              visible = false;
              void setDesktopBrowserBounds(invoke, rect, true).catch(() => undefined);
            }
          } else {
            // Pure TRANSLATION (scroll / sidebar shift): follow live and stay
            // visible. Hiding here would blink the webview on every scroll tick.
            void setDesktopBrowserBounds(invoke, rect, false).catch(() => undefined);
          }
        } else {
          stillFrames += 1;
          if (!visible && stillFrames >= SETTLE_FRAMES) {
            // Settled after a resize: re-show ONCE at the final rect.
            visible = true;
            void setDesktopBrowserBounds(invoke, rect, false).catch(() => undefined);
          }
          if (visible && stillFrames >= SLEEP_AFTER_STILL_FRAMES) {
            // Nothing moving and the surface is shown/positioned — go idle.
            frame = 0;
            return;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };

    const wake = () => {
      if (!frame) {
        stillFrames = 0;
        frame = requestAnimationFrame(tick);
      }
    };

    // Instant wake for the common interactive movers (smooth following).
    window.addEventListener('resize', wake);
    window.addEventListener('scroll', wake, true); // capture: ancestor scrolls too
    window.addEventListener('pointermove', wake); // divider / sidebar drags
    // App/window visibility restore (macOS Dock reopen, system sleep/wake, display
    // change while backgrounded) can move the host with the loop suspended.
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', wake);
    // Safety net for event-LESS layout shifts (keyboard sidebar toggle, an async
    // toast pushing the panel down): a cheap measure-only poll that re-pins within
    // ~0.5s. Costs one getBoundingClientRect per tick — no IPC unless it moved.
    const poll = window.setInterval(() => {
      const rect = measure();
      if (rect && !sameRect(rect)) wake();
    }, CATCHUP_POLL_MS);
    wake(); // settle the initial position once after mount

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearInterval(poll);
      window.removeEventListener('resize', wake);
      window.removeEventListener('scroll', wake, true);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [invoke, measure]);

  // Reflect navigation + load state pushed from Rust. A page-internal link click
  // (no React involvement) still updates the address bar this way.
  useEffect(() => {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<DesktopBrowserEvent>).detail;
      if (!detail) return;
      if (detail.type === 'navigated' && typeof detail.url === 'string') {
        setCurrentUrl(detail.url);
        setAddress(detail.url);
      } else if (detail.type === 'load') {
        setLoading(detail.phase === 'started');
      }
    };
    window.addEventListener(DESKTOP_BROWSER_EVENT, onEvent as EventListener);
    return () => window.removeEventListener(DESKTOP_BROWSER_EVENT, onEvent as EventListener);
  }, []);

  const submitAddress = useCallback(() => {
    const normalized = normalizeBrowserAddress(address);
    if (!normalized) return;
    setLoading(true);
    const rect = measure();
    if (rect) void openDesktopBrowser(invoke, normalized, rect).catch(() => undefined);
  }, [address, invoke, measure]);

  const drive = useCallback(
    (action: 'back' | 'forward' | 'reload') => {
      void navigateDesktopBrowser(invoke, action).catch(() => undefined);
    },
    [invoke],
  );

  return (
    <div className="native-browser">
      <div className="native-browser-toolbar">
        <button
          type="button"
          className="icon-button compact"
          aria-label={t('Browser back')}
          onClick={() => drive('back')}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-button compact"
          aria-label={t('Browser forward')}
          onClick={() => drive('forward')}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className={`icon-button compact${loading ? ' is-loading' : ''}`}
          aria-label={t('Browser reload')}
          onClick={() => drive('reload')}
        >
          <RotateCw size={16} />
        </button>
        <input
          className="native-browser-address"
          type="text"
          inputMode="url"
          spellCheck={false}
          aria-label={t('Browser address')}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitAddress();
            }
          }}
        />
        <button
          type="button"
          className="icon-button compact"
          aria-label={t('Preview open in browser')}
          title={t('Preview open in browser')}
          onClick={() => onOpenExternal(currentUrl)}
        >
          <ExternalLink size={16} />
        </button>
      </div>
      {/* The native webview is overlaid on this region by the Rust shell. It is
          intentionally empty; the loading hint shows through only until the
          first paint covers it. */}
      <div className="native-browser-host" ref={hostRef} role="presentation">
        {loading ? <span className="native-browser-loading">{t('Preview loading')}</span> : null}
      </div>
    </div>
  );
}
