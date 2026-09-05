import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ExternalLink, Globe } from 'lucide-react';
import type { AppCopyKey } from './App';

/**
 * Reference viewer — URL web sub-view (presentation only).
 *
 * Renders the kernel's FAITHFUL view of a URL: the server fetched the page under
 * the same SSRF/DoS guards and returned `page_html` — the real HTML with a
 * first-in-<head> CSP (blocks scripts/plugins/frames) + an injected <base>, so it
 * is embedded into a sandboxed <iframe srcdoc> that renders with the page's own
 * styling and images (loaded DIRECTLY from the origin by the browser) while
 * running NO scripts. This is the browser-side counterpart of the desktop's
 * native reference webview — as faithful as a sandboxed page can be (a browser
 * tab cannot spawn a real top-level webview, so JS-driven dynamic content is the
 * deliberate ceiling). If `page_html` is ever absent (a version-skewed older
 * backend), it degrades to an inert text-only reader built from `sanitized_html`
 * rather than a blank frame. Extracted links are surfaced in the PARENT UI (never inside the
 * iframe) and only ever opened in the external browser. By default never
 * auto-loads — the user must click (overridable via Settings → Security). All
 * user-facing copy is localized through the injected `t` translator; the `load`
 * function is injected too (decoupled + testable).
 */

export type PreviewData = {
  ok: boolean;
  final_url: string;
  status: number;
  content_type: string;
  sanitized_html: string;
  // Faithful, embeddable document built by the kernel (real HTML + first-in-head
  // CSP + injected <base>). Rendered in the sandboxed srcdoc iframe below.
  page_html: string;
  extracted_links: { text: string; url: string }[];
  truncated: boolean;
};

export type PreviewLoad =
  | { kind: 'ok'; data: PreviewData }
  | { kind: 'error'; code: string; message: string };

// The translator the panel needs — the same `(key) => string` shape App passes
// to every other extracted surface (SettingsSurface, RuntimeRoster, …).
export type PreviewTranslate = (key: AppCopyKey) => string;

// Full-deny CSP for the INERT fallback reader (used only when the kernel returns
// no faithful `page_html` — e.g. a version-skewed older backend). Delivered as the
// FIRST element in <head> so it governs the whole document; meta CSP cannot use
// frame-ancestors/sandbox, those come from the iframe sandbox attribute below.
const PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; " +
  "font-src 'none'; media-src 'none'; object-src 'none'; connect-src 'none'; " +
  "child-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; " +
  "form-action 'none'; base-uri 'none'";

// Wrap the kernel's zero-attribute sanitized body into an inert, network-silent
// document. This is the FALLBACK only — the primary render is the kernel's faithful
// `page_html`. Keeps the panel from showing a blank iframe if `page_html` is ever
// absent (older backend), degrading to the safe text-only reader instead.
export function buildPreviewSrcdoc(sanitizedHtml: string): string {
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
    '<meta charset="utf-8"></head><body>' +
    sanitizedHtml +
    '</body></html>'
  );
}

/**
 * Map a kernel refusal `code` to the copy KEY for a specific, actionable reason
 * (the caller renders it through `t`, so it is localized). Without this the UI
 * shows one generic "could not be previewed" line for every failure, which hides
 * the real cause — most often a VPN/proxy in fake-IP mode (every host resolves to
 * a non-routable placeholder, so the SSRF-guarded reader refuses with
 * `blocked_private`/`blocked_dns`). Each message ends by pointing at the
 * always-present "Open in browser" escape hatch.
 */
export function describePreviewError(code: string): AppCopyKey {
  switch (code) {
    case 'blocked_private':
    case 'blocked_dns':
      return 'Preview error proxy';
    case 'blocked_protocol':
      return 'Preview error protocol';
    case 'blocked_redirect':
      return 'Preview error redirect';
    case 'bad_content_type':
      return 'Preview error content type';
    case 'too_large':
      return 'Preview error too large';
    case 'timeout':
      return 'Preview error timeout';
    case 'throttled':
      return 'Preview error throttled';
    case 'fetch_failed':
      return 'Preview error fetch failed';
    case 'invalid_ticket':
      return 'Preview error expired';
    default:
      // Covers the frontend-only 'request_refused' (thrown loader) and any
      // unrecognized/future kernel code: a safe, generic fallback.
      return 'Preview error generic';
  }
}

export function WebPreviewPanel({
  url,
  load,
  onOpenExternal,
  t,
  confirmBeforeLoad = true,
}: {
  url: string;
  load: (url: string) => Promise<PreviewLoad>;
  onOpenExternal: (url: string) => void;
  t: PreviewTranslate;
  // When true (default, fail-safe), the panel never fetches until the user clicks
  // "Click to preview" — no auto network request. When false (user opted out in
  // Settings → Security), a link click auto-loads the sandboxed preview.
  confirmBeforeLoad?: boolean;
}) {
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'done'; load: PreviewLoad }
  >({ status: 'idle' });

  const reqSeq = useRef(0);
  // Tracks the URL we have already kicked an auto-load for, so the mount effect is
  // idempotent: React 18 StrictMode double-invokes effects in dev (setup→setup),
  // which would otherwise fire TWO server-side preview fetches the first time an
  // auto-load (confirmBeforeLoad=false) URL opens — wasting per-host concurrency
  // slots. reqSeq drops the stale RESPONSE but cannot cancel an in-flight request,
  // so we must not start the second one at all.
  const autoLoadedFor = useRef<string | null>(null);
  const startLoad = useCallback(() => {
    const seq = (reqSeq.current += 1);
    const fresh = (next: PreviewLoad) => {
      if (seq === reqSeq.current) setState({ status: 'done', load: next });
    };
    setState({ status: 'loading' });
    load(url)
      .then((res) => fresh(res))
      .catch(() => fresh({ kind: 'error', code: 'request_refused', message: 'request refused' }));
  }, [url, load]);

  // Self-correct when the target URL (or the confirm preference) changes: bump the
  // request sequence so an in-flight load for the OLD url can never write its
  // result over the new target (stale-write guard, holds even without a key
  // remount). Then either return to idle (confirmation required) or auto-load
  // immediately (user opted out). startLoad is memoized, so a state change alone
  // never re-runs this effect — only url/confirm/load changes do.
  useEffect(() => {
    if (confirmBeforeLoad) {
      // Confirmation re-enabled (or URL changed while confirming): clear the
      // auto-load marker so a later switch back to auto DOES reload this URL.
      autoLoadedFor.current = null;
      reqSeq.current += 1;
      setState({ status: 'idle' });
    } else if (autoLoadedFor.current !== url) {
      // Auto-load exactly once per URL — guards the StrictMode double-invoke.
      autoLoadedFor.current = url;
      startLoad();
    }
  }, [url, confirmBeforeLoad, startLoad]);

  const openExternalLabel = t('Preview open in browser');
  const openExternal = (
    <button type="button" className="text-button compact web-preview-external" onClick={() => onOpenExternal(url)}>
      <ExternalLink size={14} /> {openExternalLabel}
    </button>
  );

  const header: ReactNode = (
    <div className="web-preview-head">
      <Globe size={16} aria-hidden="true" />
      <span className="web-preview-url" title={url}>{url}</span>
      {openExternal}
    </div>
  );

  if (state.status === 'idle') {
    return (
      <div className="web-preview web-preview-idle">
        {header}
        <button type="button" className="text-button" onClick={startLoad}>
          {t('Preview click to load')}
        </button>
        <p className="web-preview-note">{t('Preview reader note')}</p>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className="web-preview web-preview-loading" role="status">
        {header}
        <p>{t('Preview loading')}</p>
      </div>
    );
  }

  const loaded = state.load;
  if (loaded.kind === 'error') {
    return (
      <div className="web-preview web-preview-error" role="alert">
        {header}
        <div className="web-preview-error-body">
          <AlertTriangle size={16} aria-hidden="true" />
          <p data-code={loaded.code}>{t(describePreviewError(loaded.code))}</p>
        </div>
        <button
          type="button"
          className="text-button web-preview-error-open"
          onClick={() => onOpenExternal(url)}
        >
          <ExternalLink size={14} /> {openExternalLabel}
        </button>
      </div>
    );
  }

  const data = loaded.data;
  return (
    <div className="web-preview web-preview-loaded">
      {header}
      {data.truncated ? <span className="status-pill warn web-preview-truncated">{t('Preview truncated')}</span> : null}
      <iframe
        className="web-preview-frame"
        title={`${t('Preview of')} ${data.final_url}`}
        // sandbox="" = opaque origin, NO allow-scripts: the embedded page cannot
        // run code or reach this app's origin, yet a sandboxed frame STILL loads
        // passive subresources (styles/images/fonts) — which is exactly how the
        // kernel's page_html renders faithfully via its injected <base>.
        sandbox=""
        referrerPolicy="no-referrer"
        // Primary: the kernel's faithful page_html. Fallback (older backend with no
        // page_html): the inert text-only reader, never a blank frame.
        srcDoc={data.page_html || buildPreviewSrcdoc(data.sanitized_html)}
      />
      {data.extracted_links.length > 0 ? (
        <div className="web-preview-links">
          <div className="section-heading compact">{t('Preview links heading')}</div>
          <ul>
            {data.extracted_links.map((link, i) => (
              <li key={`${link.url}-${i}`}>
                <button type="button" className="text-button compact" onClick={() => onOpenExternal(link.url)}>
                  {link.text || link.url}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
