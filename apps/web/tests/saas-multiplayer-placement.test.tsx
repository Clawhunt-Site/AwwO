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
    // Until it is measured (the first paint is after), the place it always had: below a 56px header 8px in. What sets
    // the top edge: top, or an inset shorthand or logical inset that holds it.
    expect(panelRule().match(TOP_EDGE)).toEqual([PANEL_TOP_RULE]);
    expect(panelRule().match(BOTTOM_EDGE)).toEqual(['bottom: var(--mp-panel-bottom);']);
    const onPhone = phoneRule();
    expect(onPhone).toContain('--mp-panel-bottom: 8px; right: 8px; left: 8px; width: auto;');
    expect(onPhone.match(TOP_EDGE)).toBeNull();
    expect(onPhone.match(BOTTOM_EDGE)).toBeNull();
    // Nothing else places the panel or the Share dialog (its own class beside the panel's), or sizes either, in any of
    // the web app's stylesheets: every rule whose selector ends on either element, in a list or a compound, at any width,
    // sets no top edge, bottom edge or height but the panel's own.
    const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? sheets(join(dir, entry.name)) : entry.name.endsWith('.css') ? [readFileSync(join(dir, entry.name), 'utf8')] : []);
    const placing = (edge: RegExp) => sheets(resolve(process.cwd(), 'src')).flatMap(sheet => [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .flatMap(([, selectors, body]) => selectors.split(',')
        .some(selector => /\.awwo-multiplayer-(?:panel|share)(?![-\w])[^\s>+~]*$/.test(selector.trim())) ? body.match(edge) ?? [] : []));
    expect(placing(TOP_EDGE)).toEqual([PANEL_TOP_RULE]);
    expect(placing(BOTTOM_EDGE)).toEqual(['bottom: var(--mp-panel-bottom);']);
  });

  it('keeps the panel and the Share dialog 200px tall on a short window, over the header only as far as that takes', () => {
    // Where the panel's top edge comes, and how tall it is, in a window `height` px tall below a header whose bottom
    // edge belowHeader.ts measured at `header`: from its rule, and on a phone the phone's over it.
    const desk = declarations(panelRule());
    const phone = { ...desk, ...declarations(phoneRule()) };
    const place = (rule: Record<string, string>, height: number, header?: number) => {
      const values = header === undefined ? rule : { ...rule, [PANEL_TOP]: `${header}px` };
      const top = lengthOf(rule.top, values, height);
      return { top, height: height - lengthOf(rule.bottom, values, height) - top };
    };
    // Room below the header, with a banner above it or without: right below it, down to 12px from the window's bottom.
    expect(place(desk, 900, 64)).toEqual({ top: 64, height: 824 });
    expect(place(desk, 900, 172)).toEqual({ top: 172, height: 716 });
    // Room for just 200px below a header that a banner and a second row moved down.
    expect(place(desk, 384, 172)).toEqual({ top: 172, height: 200 });
    // Less: it keeps its 200px, over the header's bottom as far as that takes.
    expect(place(desk, 360, 172)).toEqual({ top: 148, height: 200 });
    // A window shorter than that and the panel's edges: all of it, 8px from its top and 12px from its bottom.
    expect(place(desk, 180, 116)).toEqual({ top: 8, height: 160 });
    // Where nothing measured a header: below the hosted one, 56px tall 8px in.
    expect(place(desk, 900)).toEqual({ top: 64, height: 824 });
    expect(place(desk, 240)).toEqual({ top: 28, height: 200 });
    // A phone's is 8px from the window's bottom, and keeps its 200px the same way.
    expect(place(phone, 812, 116)).toEqual({ top: 116, height: 688 });
    expect(place(phone, 300, 116)).toEqual({ top: 92, height: 200 });
  });
});

const css = () => readFileSync(resolve(process.cwd(), 'src/canvas/multiplayer/multiplayer.css'), 'utf8');
const rule = (text: string, selector: string) => text.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
/** The panel's own rule, and the phone's over it. */
const panelRule = () => rule(css(), '.awwo-multiplayer-panel');
const phoneRule = () => rule(css().match(/@media \(max-width: 600px\) \{([\s\S]*?)\n\}/)?.[1] ?? '', '.awwo-multiplayer-panel');
const TOP_EDGE = /(?<![-\w])(?:top|inset(?:-block(?:-start)?)?):[^;]*;/g;
const BOTTOM_EDGE = /(?<![-\w])(?:bottom|inset(?:-block(?:-end)?)?|(?:min-|max-)?(?:height|block-size)):[^;]*;/g;
/** Right below the header, but never so low that the window leaves the panel less than its floor, nor above 8px. */
const PANEL_TOP_RULE = `top: max(8px, min(var(${PANEL_TOP}, 64px), calc(100% - var(--mp-panel-bottom) - var(--mp-panel-floor))));`;
/** A rule's declarations by property. */
const declarations = (body: string): Record<string, string> => Object.fromEntries(body.split(';')
  .map(part => part.trim()).filter(Boolean).map(part => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]));

/** What a length in the panel's rule comes to, in px, in a window `height` px tall (a fixed box's % is of the window's
 *  height): px and %, var() with its fallback (its value from `values`), calc() of + and -, min() and max(). Anything
 *  else throws, so a rule this cannot read fails the test rather than passing it. */
function lengthOf(expression: string, values: Record<string, string>, height: number): number {
  const text = expression.trim();
  let at = 0;
  const skip = () => { while (text[at] === ' ') at++; };
  const take = (char: string) => { skip(); if (text[at] !== char) throw new Error(`expected “${char}” at ${at} in ${text}`); at++; };
  const sum = (): number => {
    let value = term();
    for (;;) {
      skip();
      const sign = text[at];
      if (sign !== '+' && sign !== '-') return value;
      at++;
      value += (sign === '+' ? 1 : -1) * term();
    }
  };
  const term = (): number => {
    skip();
    const call = /^(calc|min|max|var)\(/.exec(text.slice(at));
    if (call) {
      at += call[0].length;
      skip();
      if (call[1] === 'var') {
        const name = /^--[\w-]+/.exec(text.slice(at))?.[0];
        if (!name) throw new Error(`no custom property at ${at} in ${text}`);
        at += name.length;
        skip();
        let fallback: number | undefined;
        if (text[at] === ',') { at++; fallback = sum(); }
        take(')');
        if (values[name] !== undefined) return lengthOf(values[name], values, height);
        if (fallback === undefined) throw new Error(`${name} is not set`);
        return fallback;
      }
      const args = [sum()];
      for (skip(); text[at] === ','; skip()) { at++; args.push(sum()); }
      take(')');
      if (call[1] === 'calc') {
        if (args.length !== 1) throw new Error(`calc() of ${args.length} in ${text}`);
        return args[0];
      }
      return call[1] === 'min' ? Math.min(...args) : Math.max(...args);
    }
    const length = /^(\d+(?:\.\d+)?)(px|%)/.exec(text.slice(at));
    if (!length) throw new Error(`cannot read “${text.slice(at)}”`);
    at += length[0].length;
    return length[2] === 'px' ? Number(length[1]) : Number(length[1]) * height / 100;
  };
  const value = sum();
  skip();
  if (at !== text.length) throw new Error(`left over: “${text.slice(at)}”`);
  return value;
}
