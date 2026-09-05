import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  WebPreviewPanel,
  buildPreviewSrcdoc,
  describePreviewError,
  type PreviewLoad,
  type PreviewTranslate,
} from '../src/WebPreviewPanel';

afterEach(cleanup);

// Minimal English copy map standing in for App's `t`. The panel renders only via
// `t`, so this both exercises the i18n wiring (no hardcoded strings leak) and
// gives the assertions stable text to match.
const COPY: Record<string, string> = {
  'Preview open in browser': 'Open in browser',
  'Preview click to load': 'Click to preview this page',
  'Preview reader note': 'A safe, reader-only snapshot is fetched on the server — no scripts, images, or links load.',
  'Preview loading': 'Loading preview…',
  'Preview truncated': 'truncated',
  'Preview links heading': 'Links on this page',
  'Preview of': 'Preview of',
  'Preview error proxy': "This page can't be previewed in-app — its address resolves through a proxy (e.g. a VPN in fake-IP mode).",
  'Preview error content type': "This isn't a text or HTML page, so it can't be shown in the reader.",
  'Preview error too large': 'This page is too large to preview safely.',
  'Preview error timeout': 'The page took too long to fetch and the preview timed out.',
  'Preview error generic': 'This page could not be previewed. Open it in your browser instead.',
};
const t = ((key: string) => COPY[key] ?? key) as PreviewTranslate;

// A stand-in for the kernel's `page_html`: a complete faithful document with the
// first-in-<head> page CSP (scripts blocked, passive subresources allowed) and an
// injected <base>, wrapping a recognizable body. The panel renders THIS verbatim.
const FAITHFUL = (body: string): string =>
  '<!doctype html><html><head>' +
  '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'">' +
  '<base href="https://example.com/"></head><body>' +
  body +
  '</body></html>';

const okLoad = (
  over: Partial<{
    sanitized_html: string;
    page_html: string;
    extracted_links: { text: string; url: string }[];
  }> = {},
): PreviewLoad => ({
  kind: 'ok',
  data: {
    ok: true,
    final_url: 'https://example.com/',
    status: 200,
    content_type: 'text/html',
    sanitized_html: '<p>hello</p>',
    page_html: FAITHFUL('<p>hello</p>'),
    extracted_links: [{ text: 'docs', url: 'https://example.com/docs' }],
    truncated: false,
    ...over,
  },
});

describe('buildPreviewSrcdoc (inert fallback reader)', () => {
  it('puts a full-deny CSP meta first in <head>, body after', () => {
    const out = buildPreviewSrcdoc('<p>x</p>');
    const headStart = out.indexOf('<head>');
    const cspIdx = out.indexOf('Content-Security-Policy');
    const bodyIdx = out.indexOf('<body>');
    expect(cspIdx).toBeGreaterThan(headStart);
    expect(cspIdx).toBeLessThan(bodyIdx); // CSP before body
    expect(out).toContain("default-src 'none'");
    expect(out).toContain("script-src 'none'");
    expect(out).toContain('<body><p>x</p></body>');
    // meta CSP must NOT try frame-ancestors (invalid in meta)
    expect(out).not.toContain('frame-ancestors');
  });
});

describe('describePreviewError', () => {
  it('maps each refusal code to its own copy key (rendered via t, so localized)', () => {
    expect(describePreviewError('blocked_private')).toBe('Preview error proxy');
    expect(describePreviewError('blocked_dns')).toBe('Preview error proxy');
    expect(describePreviewError('blocked_protocol')).toBe('Preview error protocol');
    expect(describePreviewError('blocked_redirect')).toBe('Preview error redirect');
    expect(describePreviewError('bad_content_type')).toBe('Preview error content type');
    expect(describePreviewError('too_large')).toBe('Preview error too large');
    expect(describePreviewError('timeout')).toBe('Preview error timeout');
    expect(describePreviewError('throttled')).toBe('Preview error throttled');
    expect(describePreviewError('fetch_failed')).toBe('Preview error fetch failed');
    expect(describePreviewError('invalid_ticket')).toBe('Preview error expired');
    // frontend-only thrown-loader code and any future/unknown code -> generic
    expect(describePreviewError('request_refused')).toBe('Preview error generic');
    expect(describePreviewError('something_unknown')).toBe('Preview error generic');
  });
});

describe('WebPreviewPanel', () => {
  it('never auto-loads by default — requires an explicit click', () => {
    const load = vi.fn().mockResolvedValue(okLoad());
    render(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByText('Click to preview this page')).toBeInTheDocument();
  });

  it('also requires a click when confirmBeforeLoad is explicitly true', () => {
    const load = vi.fn().mockResolvedValue(okLoad());
    render(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} confirmBeforeLoad />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByText('Click to preview this page')).toBeInTheDocument();
  });

  it('auto-loads (no click) when confirmBeforeLoad is false', async () => {
    const load = vi.fn().mockResolvedValue(okLoad());
    render(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} confirmBeforeLoad={false} />);
    const frame = (await screen.findByTitle(/Preview of/)) as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Click to preview this page')).toBeNull();
  });

  it('auto-loads exactly once under StrictMode (no double fetch on mount)', async () => {
    // StrictMode double-invokes mount effects in dev; the autoLoadedFor guard must
    // keep that to a single server-side fetch.
    const load = vi.fn().mockResolvedValue(okLoad());
    render(
      <StrictMode>
        <WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} confirmBeforeLoad={false} />
      </StrictMode>,
    );
    await screen.findByTitle(/Preview of/);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('switching confirmBeforeLoad off auto-loads without a click; back on resets to idle', async () => {
    const load = vi.fn().mockResolvedValue(okLoad());
    const { rerender } = render(
      <WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} confirmBeforeLoad />,
    );
    expect(screen.getByText('Click to preview this page')).toBeInTheDocument();
    rerender(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} confirmBeforeLoad={false} />);
    await screen.findByTitle(/Preview of/);
    expect(load).toHaveBeenCalledTimes(1);
    rerender(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} confirmBeforeLoad />);
    expect(screen.getByText('Click to preview this page')).toBeInTheDocument();
    expect(screen.queryByTitle(/Preview of/)).toBeNull();
  });

  it('renders the kernel faithful page (page_html) in a no-scripts sandboxed iframe', async () => {
    const load = vi.fn().mockResolvedValue(okLoad());
    render(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} />);
    fireEvent.click(screen.getByText('Click to preview this page'));
    const frame = (await screen.findByTitle(/Preview of/)) as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    // sandbox present with NO allow-* tokens = opaque origin, no scripts/nav/
    // forms/popups/same-origin (a sandboxed frame still loads passive styles/images)
    expect(frame.hasAttribute('sandbox')).toBe(true);
    expect(frame.getAttribute('sandbox') || '').not.toContain('allow-');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The iframe embeds the kernel's page_html verbatim: the real body, the
    // script-blocking page CSP, and the injected <base> for subresource loading.
    const srcdoc = frame.getAttribute('srcdoc') || '';
    expect(srcdoc).toContain('<p>hello</p>');
    expect(srcdoc).toContain("script-src 'none'");
    expect(srcdoc).toContain('<base href="https://example.com/"');
  });

  it('falls back to the inert reader (never a blank frame) when page_html is absent', async () => {
    // A version-skewed older backend returns no faithful page_html; the panel must
    // degrade to the full-deny sanitized reader, not render an empty iframe.
    const load = vi.fn().mockResolvedValue(okLoad({ page_html: '' }));
    render(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} />);
    fireEvent.click(screen.getByText('Click to preview this page'));
    const frame = (await screen.findByTitle(/Preview of/)) as HTMLIFrameElement;
    const srcdoc = frame.getAttribute('srcdoc') || '';
    expect(srcdoc).toContain('<p>hello</p>'); // the sanitized body
    expect(srcdoc).toContain("default-src 'none'"); // full-deny fallback CSP
    expect(srcdoc).not.toContain('<base href'); // inert: no live subresource base
  });

  it('opens extracted links externally (in the parent UI), never inside the iframe', async () => {
    const onOpenExternal = vi.fn();
    const load = vi.fn().mockResolvedValue(okLoad());
    render(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={onOpenExternal} t={t} />);
    fireEvent.click(screen.getByText('Click to preview this page'));
    const link = await screen.findByText('docs');
    fireEvent.click(link);
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('always offers an external-open button', () => {
    const onOpenExternal = vi.fn();
    render(<WebPreviewPanel url="https://example.com/" load={vi.fn()} onOpenExternal={onOpenExternal} t={t} />);
    fireEvent.click(screen.getByText('Open in browser'));
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('shows a code-specific reason on a refusal (proxy/fake-IP case)', async () => {
    const load = vi.fn().mockResolvedValue({ kind: 'error', code: 'blocked_private', message: 'no' } as PreviewLoad);
    render(<WebPreviewPanel url="http://10.0.0.1/" load={load} onOpenExternal={vi.fn()} t={t} />);
    fireEvent.click(screen.getByText('Click to preview this page'));
    // blocked_private/blocked_dns must name the real cause (proxy/fake-IP), not a
    // generic "could not be previewed".
    const msg = await screen.findByText(/fake-IP/);
    expect(msg).toHaveAttribute('data-code', 'blocked_private');
  });

  it('offers a prominent open-in-browser button in the error state', async () => {
    const onOpenExternal = vi.fn();
    // a frontend-only refusal maps to the generic reason
    const load = vi.fn().mockResolvedValue({ kind: 'error', code: 'request_refused', message: 'no' } as PreviewLoad);
    render(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={onOpenExternal} t={t} />);
    fireEvent.click(screen.getByText('Click to preview this page'));
    await screen.findByText(/could not be previewed/);
    // Two "Open in browser" affordances now: the header one and the error-body CTA.
    const buttons = screen.getAllByText('Open in browser');
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(buttons[buttons.length - 1]);
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('falls back safely if the loader throws', async () => {
    const load = vi.fn().mockRejectedValue(new Error('network'));
    render(<WebPreviewPanel url="https://example.com/" load={load} onOpenExternal={vi.fn()} t={t} />);
    fireEvent.click(screen.getByText('Click to preview this page'));
    // a thrown loader maps to request_refused -> the generic reason
    expect(await screen.findByText(/could not be previewed/)).toBeInTheDocument();
  });

  it('localizes copy through t (no hardcoded English leaks)', async () => {
    // A zh-style fake translator: the panel must show THESE strings, proving every
    // visible label flows through t rather than a literal in the component.
    const zh = ((key: string) =>
      ({
        'Preview open in browser': '在浏览器中打开',
        'Preview click to load': '点击预览此页面',
        'Preview reader note': '只读快照',
      } as Record<string, string>)[key] ?? key) as PreviewTranslate;
    render(<WebPreviewPanel url="https://example.com/" load={vi.fn()} onOpenExternal={vi.fn()} t={zh} />);
    expect(screen.getByText('点击预览此页面')).toBeInTheDocument();
    expect(screen.getByText('在浏览器中打开')).toBeInTheDocument();
  });

  it('resets to the click-to-preview state when the target URL changes', async () => {
    const load = vi.fn().mockResolvedValue(okLoad());
    const { rerender } = render(
      <WebPreviewPanel url="https://a.example/" load={load} onOpenExternal={vi.fn()} t={t} />,
    );
    fireEvent.click(screen.getByText('Click to preview this page'));
    await screen.findByTitle(/Preview of/); // A is loaded
    // Switching to a new URL must NOT keep showing A — it returns to idle so the
    // new page must be clicked, and the stale A document is gone from the frame.
    rerender(<WebPreviewPanel url="https://b.example/" load={load} onOpenExternal={vi.fn()} t={t} />);
    expect(screen.getByText('Click to preview this page')).toBeInTheDocument();
    expect(screen.queryByTitle(/Preview of/)).toBeNull();
  });

  it('ignores a stale in-flight load after the URL changes (no stale-write)', async () => {
    // The first load never resolves until we trigger it; the second URL must win.
    let resolveA: (v: PreviewLoad) => void = () => {};
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise<PreviewLoad>((res) => (resolveA = res)))
      .mockResolvedValue(okLoad({ page_html: FAITHFUL('<p>B-PAGE</p>') }));
    const { rerender } = render(
      <WebPreviewPanel url="https://a.example/" load={load} onOpenExternal={vi.fn()} t={t} />,
    );
    fireEvent.click(screen.getByText('Click to preview this page')); // start loading A (pending)
    rerender(<WebPreviewPanel url="https://b.example/" load={load} onOpenExternal={vi.fn()} t={t} />);
    fireEvent.click(screen.getByText('Click to preview this page')); // load B
    const frame = (await screen.findByTitle(/Preview of/)) as HTMLIFrameElement;
    expect(frame.getAttribute('srcdoc') || '').toContain('B-PAGE');
    // A resolves late — it must be dropped, never overwriting B.
    resolveA(okLoad({ page_html: FAITHFUL('<p>A-STALE</p>') }));
    await waitFor(() => {
      expect((screen.getByTitle(/Preview of/).getAttribute('srcdoc') || '')).toContain('B-PAGE');
    });
    expect((screen.getByTitle(/Preview of/).getAttribute('srcdoc') || '')).not.toContain('A-STALE');
  });
});
