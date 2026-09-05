import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NativeBrowserPanel, normalizeBrowserAddress } from '../src/NativeBrowserPanel';
import {
  DESKTOP_BROWSER_EVENT,
  openDesktopBrowser,
  setDesktopBrowserBounds,
} from '../src/desktop';
import { getUiZoom } from '../src/zoom';
import type { AppCopyKey } from '../src/App';

// Default the page-zoom factor to 1 so the other tests (jsdom getBoundingClientRect
// is all-zero anyway) are unaffected; the zoom-scaling test overrides it.
vi.mock('../src/zoom', () => ({ getUiZoom: vi.fn(() => 1) }));

// The panel pins the native webview via a requestAnimationFrame reconciliation
// loop. Stub rAF to never fire so the geometry path stays inert here (it depends
// on real layout, exercised in Rust); we assert the IPC command wiring instead.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const COPY: Record<string, string> = {
  'Browser back': 'Back',
  'Browser forward': 'Forward',
  'Browser reload': 'Reload',
  'Browser address': 'Address',
  'Preview open in browser': 'Open in browser',
  'Preview loading': 'Loading…',
};
const t = (key: AppCopyKey) => COPY[key] ?? key;

function renderPanel(url = 'https://japantoday.com/') {
  const invoke = vi.fn().mockResolvedValue({ ok: true });
  const onOpenExternal = vi.fn();
  const view = render(
    <NativeBrowserPanel url={url} invoke={invoke} onOpenExternal={onOpenExternal} t={t} />,
  );
  return { invoke, onOpenExternal, ...view };
}

describe('normalizeBrowserAddress', () => {
  it('prepends https:// to a bare host and rejects junk', () => {
    expect(normalizeBrowserAddress('japantoday.com')).toBe('https://japantoday.com/');
    expect(normalizeBrowserAddress('  http://example.com/x  ')).toBe('http://example.com/x');
    expect(normalizeBrowserAddress('https://a.b/c?q=1')).toBe('https://a.b/c?q=1');
    expect(normalizeBrowserAddress('')).toBeNull();
    expect(normalizeBrowserAddress('two words')).toBeNull();
    // Non-http(s) schemes are refused (no javascript:/file: navigation).
    expect(normalizeBrowserAddress('javascript:alert(1)')).toBeNull();
    expect(normalizeBrowserAddress('ftp://x.y/')).toBeNull();
  });
});

describe('NativeBrowserPanel', () => {
  it('scales the host rect by the webview page-zoom before positioning', async () => {
    // The native overlay is positioned in unzoomed window points; getBoundingClientRect
    // is in zoomed CSS px, so the rect must be multiplied by the zoom factor.
    vi.mocked(getUiZoom).mockReturnValue(1.25);
    const rect = {
      left: 100,
      top: 50,
      width: 400,
      height: 300,
      right: 500,
      bottom: 350,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    } as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    try {
      const invoke = vi.fn().mockResolvedValue({ ok: true });
      render(
        <NativeBrowserPanel url="https://japantoday.com/" invoke={invoke} onOpenExternal={() => undefined} t={t} />,
      );
      await act(async () => undefined);
      expect(invoke).toHaveBeenCalledWith('desktop_browser_open', {
        request: {
          url: 'https://japantoday.com/',
          rect: { x: 125, y: 62.5, width: 500, height: 375 },
        },
      });
    } finally {
      spy.mockRestore();
      vi.mocked(getUiZoom).mockReturnValue(1);
    }
  });

  it('opens the native browser at the initial url on mount', async () => {
    const { invoke } = renderPanel();
    await act(async () => undefined);
    expect(invoke).toHaveBeenCalledWith(
      'desktop_browser_open',
      expect.objectContaining({
        request: expect.objectContaining({ url: 'https://japantoday.com/' }),
      }),
    );
  });

  it('drives history via the navigate command', async () => {
    const { invoke } = renderPanel();
    await act(async () => undefined);
    invoke.mockClear();

    fireEvent.click(screen.getByLabelText('Back'));
    fireEvent.click(screen.getByLabelText('Forward'));
    fireEvent.click(screen.getByLabelText('Reload'));
    await act(async () => undefined); // drain the serialized op chain

    expect(invoke).toHaveBeenCalledWith('desktop_browser_navigate', { request: { action: 'back' } });
    expect(invoke).toHaveBeenCalledWith('desktop_browser_navigate', { request: { action: 'forward' } });
    expect(invoke).toHaveBeenCalledWith('desktop_browser_navigate', { request: { action: 'reload' } });
  });

  it('normalizes an address-bar entry and re-opens', async () => {
    const { invoke } = renderPanel();
    await act(async () => undefined);
    invoke.mockClear();

    const address = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'example.org/news' } });
    fireEvent.keyDown(address, { key: 'Enter' });
    await act(async () => undefined); // drain the serialized op chain

    expect(invoke).toHaveBeenCalledWith(
      'desktop_browser_open',
      expect.objectContaining({
        request: expect.objectContaining({ url: 'https://example.org/news' }),
      }),
    );
  });

  it('reflects a navigation event pushed from Rust in the address bar', async () => {
    renderPanel();
    await act(async () => undefined);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(DESKTOP_BROWSER_EVENT, {
          detail: { type: 'navigated', url: 'https://japantoday.com/category/national' },
        }),
      );
    });

    const address = screen.getByLabelText('Address') as HTMLInputElement;
    expect(address.value).toBe('https://japantoday.com/category/national');
  });

  it('opens the current page externally via the escape hatch', async () => {
    const { onOpenExternal } = renderPanel();
    await act(async () => undefined);
    fireEvent.click(screen.getByLabelText('Open in browser'));
    expect(onOpenExternal).toHaveBeenCalledWith('https://japantoday.com/');
  });

  it('serializes browser ops in call order (hide settles before the next open)', async () => {
    // The race fix: every browser command applies in dispatch order even though
    // invoke is async. A slow hide must complete before a subsequently-enqueued
    // open runs, so an unmount-hide can never land after the next mount-open.
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const invoke = vi.fn((cmd: string) => {
      order.push(cmd);
      return call++ === 0 ? firstGate.then(() => ({ ok: true })) : Promise.resolve({ ok: true });
    });

    void setDesktopBrowserBounds(invoke, { x: 0, y: 0, width: 0, height: 0 }, true);
    void openDesktopBrowser(invoke, 'https://japantoday.com/', { x: 0, y: 0, width: 10, height: 10 });
    await act(async () => undefined);
    // The open is still queued behind the unresolved hide.
    expect(order).toEqual(['desktop_browser_set_bounds']);

    releaseFirst();
    await act(async () => undefined);
    expect(order).toEqual(['desktop_browser_set_bounds', 'desktop_browser_open']);
  });

  it('hides (does not destroy) the native browser on unmount', async () => {
    // Hiding rather than closing preserves page state across tab switches and
    // avoids racing the next panel's open on the shared singleton label.
    const { invoke, unmount } = renderPanel();
    await act(async () => undefined);
    invoke.mockClear();
    unmount();
    await act(async () => undefined); // drain the serialized op chain
    expect(invoke).toHaveBeenCalledWith('desktop_browser_set_bounds', {
      request: { rect: { x: 0, y: 0, width: 0, height: 0 }, hidden: true },
    });
    expect(invoke).not.toHaveBeenCalledWith('desktop_browser_close');
  });
});
