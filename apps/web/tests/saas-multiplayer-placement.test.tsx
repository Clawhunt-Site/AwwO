// Where the 同屏 panel and the Share dialog start (canvas/multiplayer/belowHeader.ts, multiplayer.css): right below the
// canvas header they open from, wherever a banner above the header (执行尚未就绪) has moved it, and again when the banner
// goes or the header takes a second row, so they never cover its right end, where the button that opened them is.
// jsdom lays nothing out: the header's box is given, and the ResizeObserver is one the test fires. Every id and name
// here is made up.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/canvas/i18n';
import { PANEL_TOP } from '../src/canvas/multiplayer/belowHeader';
import { MultiplayerPanel, type MultiplayerPanelProps } from '../src/canvas/multiplayer/MultiplayerPanel';
import { ShareDialog, type ShareDialogProps } from '../src/canvas/multiplayer/ShareDialog';
import type { LiveParticipant } from '../src/canvas/multiplayer/types';

const SELF: LiveParticipant = { id: 'page-self-0001', kind: 'human', port: 'web', name: 'Olive', color: '#2563eb', userId: 'user-owner', role: 'owner',
  state: { selection: [], focus: null, cursor: null, status: null }, since: '2026-11-09T10:00:00Z' };

function panelProps(open: boolean): MultiplayerPanelProps {
  return { open, onClose: vi.fn(), participants: [SELF], selfId: SELF.id, claims: [], messages: [], activity: [], canWrite: true, canInvite: false,
    nodeTitle: () => undefined, onFocusNode: vi.fn(), onSend: vi.fn(async () => undefined), onRelease: vi.fn(async () => undefined),
    invite: { tokens: { items: [], loading: false, error: null }, onCreate: vi.fn(), onRevoke: vi.fn(async () => undefined), mcpUrl: 'https://awwo.example/api/v1/mcp',
      apiBase: 'https://awwo.example/api/v1', tenantId: 'tenant-one', canvasId: 'canvas-one' } };
}
function shareProps(open: boolean): ShareDialogProps {
  return { open, onClose: vi.fn(), workspaceName: 'Studio', role: 'owner', selfUserId: 'user-owner', canvasId: 'canvas-one',
    canvasUrl: 'https://awwo.example/?tenant=tenant-one&canvas=canvas-one', members: { items: [], loading: false, error: null },
    invites: { items: [], loading: false, error: null }, here: new Map(), onCreateInvite: vi.fn(), onRevokeInvite: vi.fn(async () => undefined),
    onChangeRole: vi.fn(async () => undefined), onRemove: vi.fn(async () => undefined) };
}

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
/** The observer that watches the header (others the panel may come to hold watch other things). */
const watchingHeader = (header: Element) => FakeResizeObserver.made.find(observer => observer.observed.has(header))!;

/** The canvas page around the header (SaaSApp.tsx, AgentWorkspace.tsx): a banner above the workspace, if any, then the
 *  workspace, its main column, and the header whose actions hold the panel. */
function Page({ banner, children }: { banner: boolean; children: ReactNode }) {
  return <div className="saas-canvas-shell">
    {banner && <div className="saas-runtime-note" role="status">执行尚未就绪：当前没有可用的执行引擎。</div>}
    <div className="awwo-workspace"><main className="awwo-main"><header className="awwo-header">
      <div className="awwo-page-title">画布</div>
      <div className="awwo-header-actions">{children}</div>
    </header></main></div>
  </div>;
}

/** The header's box, its bottom edge where the test puts it; `measured` counts the times it was read. */
let headerBottom = 0;
let measured = 0;
function boxTheHeader() {
  const header = document.querySelector<HTMLElement>('.awwo-header')!;
  measured = 0;
  vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => {
    measured++;
    return { x: 0, y: headerBottom - 56, top: headerBottom - 56, left: 0, right: 1440, bottom: headerBottom, width: 1440, height: 56, toJSON: () => ({}) } as DOMRect;
  });
  return header;
}
const startsBelow = (dialog: HTMLElement) => dialog.style.getPropertyValue(PANEL_TOP);

beforeEach(() => { FakeResizeObserver.made = []; vi.stubGlobal('ResizeObserver', FakeResizeObserver); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the 同屏 panel and the Share dialog start below the canvas header', () => {
  it('opens the 同屏 panel below a header that a banner moved down, and follows the header when the banner goes', () => {
    const page = (open: boolean, banner: boolean) => <Page banner={banner}><MultiplayerPanel {...panelProps(open)} /></Page>;
    const { rerender } = render(page(false, true));
    const header = boxTheHeader();
    // 8px of the workspace's own, the banner's 52, the header's 56.
    headerBottom = 116;
    rerender(page(true, true));
    const dialog = screen.getByRole('dialog', { name: '同屏' });
    expect(startsBelow(dialog)).toBe('116px');
    // It watches the header and every box around it: a banner shown above the header, or gone, resizes them.
    const observer = watchingHeader(header);
    const workspace = header.closest('.awwo-workspace')!;
    expect([...observer.observed]).toEqual(expect.arrayContaining([header, header.parentElement!, workspace, workspace.parentElement!]));
    // The engine is ready again: the banner goes, the workspace grows, and the header moves up.
    rerender(page(true, false));
    headerBottom = 64;
    observer.resized(workspace);
    expect(startsBelow(dialog)).toBe('64px');
    // A narrower window puts the header's actions on a second row.
    headerBottom = 104;
    fireEvent(window, new Event('resize'));
    expect(startsBelow(dialog)).toBe('104px');
    // A zoomed page puts the header's edge between pixels: the panel never starts above it.
    headerBottom = 63.25;
    fireEvent(window, new Event('resize'));
    expect(startsBelow(dialog)).toBe('64px');
    // A header scrolled out of sight leaves the panel at the top of the window.
    headerBottom = -30;
    fireEvent.scroll(window);
    expect(startsBelow(dialog)).toBe('0px');
    // Closed, it watches nothing more and measures nothing more.
    rerender(page(false, false));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(watching()).toEqual([]);
    const reads = measured;
    fireEvent(window, new Event('resize'));
    fireEvent.scroll(window);
    expect(measured).toBe(reads);
  });

  it('opens the Share dialog below the header too, in English', () => {
    const page = (open: boolean, banner: boolean) => <LocaleProvider locale="en"><Page banner={banner}><ShareDialog {...shareProps(open)} /></Page></LocaleProvider>;
    const { rerender } = render(page(false, true));
    const header = boxTheHeader();
    headerBottom = 172;
    rerender(page(true, true));
    const dialog = screen.getByRole('dialog', { name: 'Share this canvas' });
    expect(startsBelow(dialog)).toBe('172px');
    rerender(page(true, false));
    headerBottom = 64;
    watchingHeader(header).resized(header.closest('.awwo-main')!);
    expect(startsBelow(dialog)).toBe('64px');
    rerender(page(false, false));
    expect(watching()).toEqual([]);
  });

  it('leaves a panel outside a canvas header at the place its CSS gives it, in either language', () => {
    render(<MultiplayerPanel {...panelProps(true)} />);
    expect(startsBelow(screen.getByRole('dialog', { name: '同屏' }))).toBe('');
    cleanup();
    render(<LocaleProvider locale="en"><ShareDialog {...shareProps(true)} /></LocaleProvider>);
    expect(startsBelow(screen.getByRole('dialog', { name: 'Share this canvas' }))).toBe('');
    expect(FakeResizeObserver.made).toEqual([]);
  });

  it('starts the panel at the header’s measured bottom, and keeps the phone’s own edges', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/canvas/multiplayer/multiplayer.css'), 'utf8');
    const rule = (text: string, selector: string) => text.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
    // Until it is measured (the first paint is after), the place it always had: below a 56px header 8px in. What sets
    // the top edge: top, or an inset shorthand or logical inset that holds it.
    const top = /(?<![-\w])(?:top|inset(?:-block(?:-start)?)?):[^;]*;/g;
    expect(rule(css, '.awwo-multiplayer-panel').match(top)).toEqual([`top: var(${PANEL_TOP}, 64px);`]);
    const phone = css.match(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const onPhone = rule(phone, '.awwo-multiplayer-panel');
    expect(onPhone).toContain('right: 8px; bottom: 8px; left: 8px; width: auto;');
    expect(onPhone.match(top)).toBeNull();
    // Nothing else places the panel or the Share dialog (its own class beside the panel's), in any of the web app's
    // stylesheets: every rule whose selector ends on either element, in a list or a compound, at any width, sets no top
    // edge but that one.
    const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? sheets(join(dir, entry.name)) : entry.name.endsWith('.css') ? [readFileSync(join(dir, entry.name), 'utf8')] : []);
    const tops = sheets(resolve(process.cwd(), 'src')).flatMap(sheet => [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .flatMap(([, selectors, body]) => selectors.split(',')
        .some(selector => /\.awwo-multiplayer-(?:panel|share)(?![-\w])[^\s>+~]*$/.test(selector.trim())) ? body.match(top) ?? [] : []));
    expect(tops).toEqual([`top: var(${PANEL_TOP}, 64px);`]);
  });
});
