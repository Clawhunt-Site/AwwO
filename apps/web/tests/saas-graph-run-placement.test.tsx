// Where run history opens (saas/GraphRunPanel.tsx, graph-runs.css): right below the canvas header it opens from, as the
// 同屏 panel does (canvas/multiplayer/belowHeader.ts), wherever a banner above the header (执行尚未就绪) has moved it, and
// again when the banner goes; it no longer covers the header's right end, where its own button is. A phone keeps its own
// sheet. jsdom lays nothing out: the header's box is given, and the ResizeObserver is one the test fires. Every id here is
// made up.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_TOP } from '../src/canvas/multiplayer/belowHeader';
import { GraphRunPanel } from '../src/saas/GraphRunPanel';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

/** A ResizeObserver the test fires: what the browser does once a box it watches changes size. */
class FakeResizeObserver {
  static made: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) { FakeResizeObserver.made.push(this); }
  observe(target: Element) { this.observed.add(target); }
  unobserve(target: Element) { this.observed.delete(target); }
  disconnect() { this.observed.clear(); }
  resized(target: Element) {
    if (this.observed.has(target)) this.callback([{ target } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}
const watching = () => FakeResizeObserver.made.filter(observer => observer.observed.size > 0);
const watchingHeader = (header: Element) => FakeResizeObserver.made.find(observer => observer.observed.has(header))!;

/** The canvas page around the header (SaaSApp.tsx, AgentWorkspace.tsx): a banner above the workspace, if any, then the
 *  workspace, its main column, and the header whose actions hold run history's button (developer mode). */
function Page({ banner, children }: { banner: boolean; children: ReactNode }) {
  return <div className="saas-canvas-shell">
    {banner && <div className="saas-runtime-note" role="status">执行尚未就绪：当前没有可用的执行引擎。</div>}
    <div className="awwo-workspace"><main className="awwo-main"><header className="awwo-header">
      <div className="awwo-page-title">画布</div>
      <div className="awwo-header-actions"><div className="saas-canvas-doc-actions">{children}</div></div>
    </header></main></div>
  </div>;
}

/** The header's box, its bottom edge where the test puts it. */
let headerBottom = 0;
function boxTheHeader() {
  const header = document.querySelector<HTMLElement>('.awwo-header')!;
  vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: headerBottom - 56, top: headerBottom - 56, left: 0, right: 1440,
    bottom: headerBottom, width: 1440, height: 56, toJSON: () => ({}) }) as DOMRect);
  return header;
}
const page = (banner: boolean) => <SaaSPreferencesProvider><Page banner={banner}><GraphRunPanel tenantId="tenant-one" canvasId="canvas-one" /></Page></SaaSPreferencesProvider>;

beforeEach(() => {
  FakeResizeObserver.made = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  // No run yet: the panel reads an empty list.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('run history opens right below the canvas header', () => {
  it('opens below a header a banner moved down, follows it when the banner goes, and is measured again when reopened', () => {
    const { rerender } = render(page(true));
    const header = boxTheHeader();
    // 8px of the workspace's own, the banner's 51, the header's 56.
    headerBottom = 115;
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }));
    const panel = screen.getByRole('dialog', { name: '运行记录' });
    expect(panel.style.getPropertyValue(PANEL_TOP)).toBe('115px');
    // The engine is ready again: the banner goes, the workspace grows, and the header moves up.
    rerender(page(false));
    headerBottom = 64;
    watchingHeader(header).resized(header.closest('.awwo-workspace')!);
    expect(panel.style.getPropertyValue(PANEL_TOP)).toBe('64px');
    // Closed, it watches nothing more.
    fireEvent.click(screen.getByRole('button', { name: '关闭运行记录' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(watching()).toEqual([]);
    // Opened again under a taller header, it is measured again.
    headerBottom = 104;
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }));
    expect(screen.getByRole('dialog', { name: '运行记录' }).style.getPropertyValue(PANEL_TOP)).toBe('104px');
  });

  it('holds under StrictMode’s doubled effects: one observer while open, none once closed, measured again when reopened', () => {
    const strict = (banner: boolean) => <StrictMode>{page(banner)}</StrictMode>;
    const { rerender } = render(strict(true));
    const header = boxTheHeader();
    headerBottom = 115;
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }));
    const panel = screen.getByRole('dialog', { name: '运行记录' });
    expect(panel.style.getPropertyValue(PANEL_TOP)).toBe('115px');
    // StrictMode runs the effect, its cleanup and the effect again: only the last observer is left watching.
    expect(watching()).toHaveLength(1);
    rerender(strict(false));
    headerBottom = 64;
    watchingHeader(header).resized(header.closest('.awwo-workspace')!);
    expect(panel.style.getPropertyValue(PANEL_TOP)).toBe('64px');
    fireEvent.click(screen.getByRole('button', { name: '关闭运行记录' }));
    expect(watching()).toEqual([]);
    headerBottom = 104;
    fireEvent.click(screen.getByRole('button', { name: '运行记录' }));
    expect(screen.getByRole('dialog', { name: '运行记录' }).style.getPropertyValue(PANEL_TOP)).toBe('104px');
    expect(watching()).toHaveLength(1);
  });

  it('does the same in English', () => {
    localStorage.setItem('superclaw_locale', 'en');
    const { rerender } = render(page(true));
    const header = boxTheHeader();
    headerBottom = 172;
    fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
    const panel = screen.getByRole('dialog', { name: 'Run history' });
    expect(panel.style.getPropertyValue(PANEL_TOP)).toBe('172px');
    rerender(page(false));
    headerBottom = 64;
    watchingHeader(header).resized(header.closest('.awwo-main')!);
    expect(panel.style.getPropertyValue(PANEL_TOP)).toBe('64px');
    fireEvent.click(screen.getByRole('button', { name: 'Close run history' }));
    expect(watching()).toEqual([]);
  });

  it('takes its top and its height from the header in its CSS, and keeps the phone’s own sheet', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/saas/graph-runs.css'), 'utf8');
    const panelRule = css.match(/(?:^|\n)\.saas-graph-panel \{([^}]*)\}/)?.[1] ?? '';
    expect(panelRule).toContain(`top: var(${PANEL_TOP}, 60px);`);
    // The room below it stays what it was (20px), whatever the header's bottom.
    expect(panelRule).toContain(`max-height: calc(100dvh - var(${PANEL_TOP}, 60px) - 20px);`);
    const phone = css.match(/@media \(max-width: 600px\) \{ \.saas-graph-panel \{([^}]*)\} \}/)?.[1] ?? '';
    expect(phone).toContain('top: 8px;');
    expect(phone).toContain('max-height: calc(100dvh - 16px);');
  });
});
