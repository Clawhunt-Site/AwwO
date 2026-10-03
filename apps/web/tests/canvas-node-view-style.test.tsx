import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, emptyDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { LocaleProvider } from '../src/canvas/i18n';
import { NodeViewStylePicker, panelSizeIn } from '../src/canvas/NodeViewStylePicker';
import {
  CONTROL_CONTRAST, DEFAULT_NODE_VIEW, NODE_VIEW_SURFACES, PRESET_KNOBS, TEXT_CONTRAST, contrastRatio, exportNodeViewPreference, importNodeViewPreference, inkOn,
  nodeViewRootProps, nodeViewStorageKey, parseNodeViewPreference, readableText, saveNodeViewPreference, type NodeViewPreference,
} from '../src/canvas/nodeViewStyle';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';

const custom = (knobs: Partial<NodeViewPreference['custom']> = {}): NodeViewPreference => ({ version: 1, style: 'custom', custom: { ...PRESET_KNOBS.default, ...knobs } });

beforeEach(() => { localStorage.clear(); configureCanvasStorage('', '', ''); });
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('preference rules', () => {
  it('reads anything unrecognised as the default, knob by knob', () => {
    for (const raw of [null, '', '{', '[]', '{"version":2,"style":"codex"}', 'null']) expect(parseNodeViewPreference(raw)).toEqual(DEFAULT_NODE_VIEW);
    expect(parseNodeViewPreference(JSON.stringify({ version: 1, style: 'hacker' })).style).toBe('default');
    const repaired = parseNodeViewPreference(JSON.stringify({ version: 1, style: 'custom', custom: { layout: 'grid', size: 99, accent: 'red', userBubble: '#ABCDEF', font: 'mono', density: 'relaxed', radius: 'square', width: 'centered' } }));
    expect(repaired).toEqual({ version: 1, style: 'custom', custom: { ...PRESET_KNOBS.default, font: 'mono', density: 'relaxed', radius: 'square', width: 'centered', userBubble: '#abcdef' } });
  });

  it('imports only an exact, valid style file and round-trips its own export', () => {
    const preference = custom({ layout: 'terminal', font: 'serif', size: 16, accent: '#123456', userBubble: '' });
    expect(importNodeViewPreference(exportNodeViewPreference(preference))).toEqual(preference);
    const valid = JSON.parse(exportNodeViewPreference(preference));
    for (const broken of [
      { ...valid, version: 2 }, { ...valid, style: 'matrix' }, { ...valid, extra: true }, { ...valid, custom: { ...valid.custom, accent: 'blue' } },
      { ...valid, custom: { ...valid.custom, size: 11 } }, { ...valid, custom: { ...valid.custom, css: 'body{}' } },
      { version: 1, style: 'custom' }, (() => { const { layout: _layout, ...rest } = valid.custom; return { ...valid, custom: rest }; })(),
    ]) expect(importNodeViewPreference(JSON.stringify(broken)), JSON.stringify(broken)).toBeNull();
    expect(importNodeViewPreference('not json')).toBeNull();
  });

  it('turns presets into identity attributes and custom knobs into validated variables', () => {
    expect(nodeViewRootProps(DEFAULT_NODE_VIEW)).toEqual({ 'data-node-style': 'default' });
    expect(nodeViewRootProps({ ...DEFAULT_NODE_VIEW, style: 'codex' })).toEqual({ 'data-node-style': 'codex', 'data-node-layout': 'flat', 'data-node-width': 'centered' });
    expect(nodeViewRootProps({ ...DEFAULT_NODE_VIEW, style: 'workbuddy' })).toEqual({ 'data-node-style': 'workbuddy', 'data-node-layout': 'flat', 'data-node-width': 'full' });
    expect(nodeViewRootProps({ ...DEFAULT_NODE_VIEW, style: 'claude-code' })).toEqual({ 'data-node-style': 'claude-code', 'data-node-layout': 'terminal', 'data-node-width': 'full' });
    const yellow = nodeViewRootProps(custom({ layout: 'terminal', density: 'compact', radius: 'square', width: 'centered', font: 'mono', size: 15, accent: '#f5d000', userBubble: '#101820' }));
    const lightFill = inkOn('#f5d000', NODE_VIEW_SURFACES.light, CONTROL_CONTRAST);
    expect(yellow).toEqual({
      'data-node-style': 'custom', 'data-node-layout': 'terminal', 'data-node-width': 'centered', 'data-node-density': 'compact', 'data-node-radius': 'square', 'data-node-font': 'mono',
      style: { '--nvc-size': '15px', '--nvc-user-bg': '#101820', '--nvc-user-fg': '#ffffff',
        '--nvc-accent-light': lightFill, '--nvc-accent-text-light': readableText(lightFill), '--nvc-ink-light': inkOn('#f5d000', NODE_VIEW_SURFACES.light),
        '--nvc-accent-dark': '#f5d000', '--nvc-accent-text-dark': '#141414', '--nvc-ink-dark': '#f5d000' },
    });
    // Yellow is unreadable as text, and too faint as a button, on a light card: the light theme gets
    // darker yellows that work; the dark theme keeps the yellow, which already stands out there.
    const vars = yellow.style as Record<string, string>;
    expect(vars['--nvc-ink-light']).not.toBe('#f5d000');
    for (const surface of NODE_VIEW_SURFACES.light) {
      expect(contrastRatio(vars['--nvc-ink-light'], surface)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      expect(contrastRatio(vars['--nvc-accent-light'], surface)).toBeGreaterThanOrEqual(CONTROL_CONTRAST);
    }
    // Starting from Codex in the dark theme: its black accent becomes a light fill that shows on navy.
    const codexDark = (nodeViewRootProps(custom(PRESET_KNOBS.codex)).style as Record<string, string>)['--nvc-accent-dark'];
    for (const surface of NODE_VIEW_SURFACES.dark) expect(contrastRatio(codexDark, surface)).toBeGreaterThanOrEqual(CONTROL_CONTRAST);
    // A custom value that is not a colour never reaches CSS.
    const hostile = nodeViewRootProps({ version: 1, style: 'custom', custom: { ...PRESET_KNOBS.default, accent: 'red;background:url(x)' } as NodeViewPreference['custom'] });
    expect(JSON.stringify(hostile.style)).not.toMatch(/red|url|;/);
    expect(hostile.style).toMatchObject({ '--nvc-ink-dark': inkOn(PRESET_KNOBS.default.accent, NODE_VIEW_SURFACES.dark) });
  });

  it('keeps text readable: preset fills meet WCAG AA and custom fills pick black or white', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio(PRESET_KNOBS.workbuddy.userBubble, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(PRESET_KNOBS.workbuddy.accent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(PRESET_KNOBS.codex.accent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(PRESET_KNOBS['claude-code'].accent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    for (const fill of ['#ffffff', '#ffd166', '#06d6a0', '#7cb7ff']) expect(readableText(fill)).toBe('#141414');
    for (const fill of ['#000000', '#087a5a', '#165dff', '#4b0082']) expect(readableText(fill)).toBe('#ffffff');
    expect(readableText('#777777')).toBe('#000000');
    // Every fill on a 16-level grid, mid-tones included, gets text that meets AA.
    const levels = Array.from({ length: 16 }, (_, index) => (index * 17).toString(16).padStart(2, '0'));
    let worst = Infinity;
    for (const r of levels) for (const g of levels) for (const b of levels) {
      const fill = `#${r}${g}${b}`;
      worst = Math.min(worst, contrastRatio(fill, readableText(fill)));
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('turns any accent into text and a control colour that work on every surface of both themes', () => {
    expect(inkOn('#165dff', NODE_VIEW_SURFACES.light)).toBe('#165dff');
    expect(inkOn('#94cbb1', NODE_VIEW_SURFACES.dark)).toBe('#94cbb1');
    const levels = Array.from({ length: 8 }, (_, index) => (index * 36).toString(16).padStart(2, '0'));
    for (const r of levels) for (const g of levels) for (const b of levels) {
      const accent = `#${r}${g}${b}`;
      for (const surfaces of [NODE_VIEW_SURFACES.light, NODE_VIEW_SURFACES.dark]) {
        const text = inkOn(accent, surfaces), control = inkOn(accent, surfaces, CONTROL_CONTRAST);
        for (const surface of surfaces) {
          expect(contrastRatio(text, surface), `${accent} text on ${surface}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
          expect(contrastRatio(control, surface), `${accent} control on ${surface}`).toBeGreaterThanOrEqual(CONTROL_CONTRAST);
        }
        // Text on the control colour is always readable too.
        expect(contrastRatio(control, readableText(control))).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      }
    }
  });

  it('the stylesheet gives every preset, in light and dark, text colours that meet WCAG AA', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/canvas/node-view-styles.css'), 'utf8');
    const palettes: Record<string, { light: Record<string, string>; dark: Record<string, string> }> = {};
    const blocks = [...css.matchAll(/(:root\[data-theme='dark'\] )?\.canvas-root\[data-node-style='(codex|workbuddy|claude-code)'\] \.awwo-node:is\(\.canvas-tile--open, \.canvas-tile--focus\):not\(:where\(\.canvas-tile--form\)\) \{([^}]*)\}/g)];
    for (const [, dark, style, body] of blocks) {
      const vars = Object.fromEntries([...body.matchAll(/(--nv-[a-z-]+):\s*(#[0-9a-f]{6}|transparent)\b/g)].map(match => [match[1], match[2]]));
      palettes[style] ??= { light: {}, dark: {} };
      if (dark) Object.assign(palettes[style].dark, vars); else Object.assign(palettes[style].light, vars);
    }
    expect(Object.keys(palettes).sort()).toEqual(['claude-code', 'codex', 'workbuddy']);
    // [text, surface]: card and input fall back to the background, a transparent bubble to the background.
    const pairs = [['fg', 'bg'], ['muted', 'bg'], ['link', 'bg'], ['ink', 'bg'], ['user-fg', 'user-bg'], ['accent-text', 'accent'],
      ['fg', 'card'], ['muted', 'card'], ['ink', 'card'], ['link', 'card'], ['fg', 'input'], ['muted', 'input']];
    let checked = 0;
    for (const [style, { light, dark }] of Object.entries(palettes)) {
      for (const [theme, palette] of [['light', light], ['dark', { ...light, ...dark }]] as const) {
        const value = (name: string): string => {
          const raw = palette[`--nv-${name}`] ?? (['card', 'input'].includes(name) ? palette['--nv-bg'] : undefined);
          if (raw === 'transparent') return palette['--nv-bg'];
          expect(raw, `${style} ${theme} --nv-${name}`).toMatch(/^#[0-9a-f]{6}$/);
          return raw!;
        };
        for (const [text, surface] of pairs) {
          expect(contrastRatio(value(text), value(surface)), `${style} ${theme} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(3 * 2 * pairs.length);
    // Whole-pixel sizes only inside a transformed canvas, and no backdrop filters.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/\d+\.\d+px/);
    expect(rules).not.toMatch(/backdrop-filter\s*:/);
    // Found by probing the built SaaS bundle in Chrome: the workspace theme styles the send control
    // with `:root[data-theme='dark'] .awwo-workspace …` (specificity 0,6,0), so the skin's rule
    // carries html:root to stay ahead of it in dark mode.
    expect(rules).toMatch(/html:root \.canvas-root:is\(\[data-node-style='codex'\][^{]*\.canvas-composer-send \{ border: 0; background: var\(--nv-accent\)/);
    // A terminal line has no bubble, so its text colour must suit the background, not a bubble fill.
    expect(rules).toMatch(/\[data-node-layout='terminal'\][^{]*\.canvas-transcript-turn--user \{ color: var\(--nv-muted\); background: transparent; \}/);
    // The frame and composer strip follow the style, so the node reads as one surface.
    expect(rules).toMatch(/background-color: var\(--nv-card\); color: var\(--nv-fg\);/);
    expect(rules).toMatch(/\.canvas-composer \{ background: var\(--nv-bg\); \}/);
    // Every skin rule is scoped to opened session tiles: forms are excluded without adding
    // specificity (:where), so the precedence verified against the built bundle is unchanged.
    const scoped = rules.split('\n').filter(line => line.includes('.awwo-node:is('));
    expect(scoped.length).toBeGreaterThan(80);
    for (const line of scoped) expect(line).toContain('.awwo-node:is(.canvas-tile--open, .canvas-tile--focus):not(:where(.canvas-tile--form))');
    // The side panels and drawers of an opened node follow the style as well.
    expect(rules).toMatch(/:is\(\.awwo-session-sidebar, \.awwo-input-drawer, \.awwo-node-delivery-drawer\) \{ border-color: var\(--nv-line\); background: var\(--nv-soft\); color: var\(--nv-fg\); \}/);
  });
});

describe('per-account browser storage', () => {
  it('keeps one preference per signed-in account and a browser default outside SaaS', () => {
    expect(nodeViewStorageKey()).toBe('superclaw_node_view_style');
    configureCanvasStorage('alice', 'tenant', 'canvas');
    expect(nodeViewStorageKey()).toBe('awwo.saas:alice:node-view-style');
    saveNodeViewPreference({ ...DEFAULT_NODE_VIEW, style: 'claude-code' });
    configureCanvasStorage('bob', 'tenant', 'canvas');
    expect(parseNodeViewPreference(localStorage.getItem(nodeViewStorageKey())).style).toBe('default');
    configureCanvasStorage('alice', 'other-tenant', 'other-canvas');
    expect(parseNodeViewPreference(localStorage.getItem(nodeViewStorageKey())).style).toBe('claude-code');
  });

  it('a save that storage refuses still applies in this tab instead of snapping back', () => {
    // Full storage that still holds an older choice.
    const stored = new Map([[nodeViewStorageKey(), JSON.stringify({ ...DEFAULT_NODE_VIEW, style: 'codex' })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null, removeItem: (key: string) => { stored.delete(key); },
      setItem: () => { throw new DOMException('full', 'QuotaExceededError'); }, clear: () => stored.clear(), key: () => null, length: 0,
    });
    render(<LocaleProvider locale="en"><NodeViewStylePicker /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'View style' }));
    fireEvent.click(screen.getByRole('radio', { name: /Claude Code style/ }));
    expect(screen.getByRole('radio', { name: /Claude Code style/ })).toBeChecked();
    expect(stored.has(nodeViewStorageKey())).toBe(false);
  });
});

function renderPicker() {
  return render(<LocaleProvider locale="zh"><NodeViewStylePicker /></LocaleProvider>);
}

describe('the picker', () => {
  it('opens a labelled dialog of five styles and applies a choice to every opened node', () => {
    renderPicker();
    const toggle = screen.getByRole('button', { name: '界面风格' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: '节点界面风格' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('radio').map(radio => radio.closest('label')?.querySelector('strong')?.textContent)).toEqual(['AwwO 默认', 'Codex 风格', 'WorkBuddy 风格', 'Claude Code 风格', '自定义']);
    fireEvent.click(screen.getByRole('radio', { name: /WorkBuddy 风格/ }));
    expect(parseNodeViewPreference(localStorage.getItem(nodeViewStorageKey())).style).toBe('workbuddy');
    expect(screen.getByRole('radio', { name: /WorkBuddy 风格/ })).toBeChecked();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it('moves focus to the chosen style on open, and Escape on the toggle closes only the dialog', () => {
    // The canvas listens for Escape on window to close the opened node or its settings panel.
    const canvasEscape = vi.fn();
    window.addEventListener('keydown', canvasEscape);
    try {
      saveNodeViewPreference({ ...DEFAULT_NODE_VIEW, style: 'workbuddy' });
      renderPicker();
      const toggle = screen.getByRole('button', { name: '界面风格' });
      fireEvent.click(toggle);
      expect(screen.getByRole('radio', { name: /WorkBuddy 风格/ })).toHaveFocus();
      toggle.focus();
      fireEvent.keyDown(toggle, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(toggle).toHaveFocus();
      expect(canvasEscape).not.toHaveBeenCalled();
      // A closed picker leaves Escape to the canvas.
      fireEvent.keyDown(toggle, { key: 'Escape' });
      expect(canvasEscape).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener('keydown', canvasEscape); }
  });

  it('fits the panel into a narrow or short opened node instead of overflowing it', () => {
    const tile = document.createElement('div');
    tile.className = 'canvas-tile';
    const tools = document.createElement('div');
    const button = document.createElement('button');
    tools.append(button); tile.append(tools); document.body.append(tile);
    try {
      Object.defineProperty(tile, 'offsetWidth', { configurable: true, value: 280 });
      // Drawn at 0.5x: 280 layout px are 140 screen px.
      tile.getBoundingClientRect = () => ({ left: 100, right: 240, top: 50, bottom: 200, width: 140, height: 150, x: 100, y: 50, toJSON() {} }) as DOMRect;
      tools.getBoundingClientRect = () => ({ left: 180, right: 232, top: 56, bottom: 70, width: 52, height: 14, x: 180, y: 56, toJSON() {} }) as DOMRect;
      expect(panelSizeIn(button)).toEqual({ width: 252, maxHeight: 242 });
      // A roomy node keeps the full panel.
      Object.defineProperty(tile, 'offsetWidth', { configurable: true, value: 800 });
      tile.getBoundingClientRect = () => ({ left: 0, right: 800, top: 0, bottom: 700, width: 800, height: 700, x: 0, y: 0, toJSON() {} }) as DOMRect;
      tools.getBoundingClientRect = () => ({ left: 640, right: 784, top: 12, bottom: 44, width: 144, height: 32, x: 640, y: 12, toJSON() {} }) as DOMRect;
      expect(panelSizeIn(button)).toEqual({ width: 300, maxHeight: 440 });
      expect(panelSizeIn(document.createElement('button'))).toBeUndefined();
    } finally { tile.remove(); }
  });

  it('closes on an outside press and never lets its own presses reach the tile', () => {
    const tile = vi.fn();
    render(<LocaleProvider locale="en"><div onPointerDown={tile}><NodeViewStylePicker /></div><button type="button">outside</button></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'View style' }));
    fireEvent.pointerDown(screen.getByRole('dialog', { name: 'Opened node style' }));
    expect(tile).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('edits a custom style with closed choices, colours and the accent-following bubble', () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: '界面风格' }));
    fireEvent.click(screen.getByRole('radio', { name: /自定义/ }));
    const saved = () => parseNodeViewPreference(localStorage.getItem(nodeViewStorageKey())).custom;
    fireEvent.click(screen.getByRole('radio', { name: '平铺' }));
    expect(saved().layout).toBe('flat');
    fireEvent.change(screen.getByLabelText('字体'), { target: { value: 'serif' } });
    fireEvent.change(screen.getByLabelText('字号'), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('radio', { name: '宽松' }));
    fireEvent.click(screen.getByRole('radio', { name: '方角' }));
    fireEvent.click(screen.getByRole('radio', { name: '居中' }));
    fireEvent.change(screen.getByLabelText('强调色'), { target: { value: '#ff6600' } });
    expect(saved()).toMatchObject({ layout: 'flat', font: 'serif', size: 16, density: 'relaxed', radius: 'square', width: 'centered', accent: '#ff6600', userBubble: '' });
    const follow = screen.getByRole('checkbox', { name: '跟随强调色' });
    expect(follow).toBeChecked();
    expect(screen.getByLabelText('我的消息底色')).toBeDisabled();
    fireEvent.click(follow);
    expect(saved().userBubble).toBe('#ff6600');
    fireEvent.change(screen.getByLabelText('我的消息底色'), { target: { value: '#003366' } });
    expect(saved().userBubble).toBe('#003366');
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code 风格' }));
    expect(saved()).toEqual(PRESET_KNOBS['claude-code']);
    // A terminal line has no bubble: its colour controls are not offered there.
    expect(screen.queryByLabelText('我的消息底色')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '跟随强调色' })).toBeNull();
  });

  it('reset returns to the AwwO default look and puts focus on that choice', async () => {
    saveNodeViewPreference(custom({ layout: 'terminal', accent: '#ff6600' }));
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: '界面风格' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复 AwwO 默认' }));
    expect(parseNodeViewPreference(localStorage.getItem(nodeViewStorageKey()))).toEqual(DEFAULT_NODE_VIEW);
    expect(screen.queryByRole('group', { name: '基于预设' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('radio', { name: /AwwO 默认/ })).toHaveFocus());
  });

  it('reports an invalid import and applies a valid one as a custom style', async () => {
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: '界面风格' }));
    fireEvent.click(screen.getByRole('radio', { name: /自定义/ }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const upload = async (text: string) => {
      const file = new File([text], 'style.json', { type: 'application/json' });
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      await act(async () => { fireEvent.change(input); });
    };
    await upload('{"version":1,"style":"custom","custom":{"css":"body{}"}}');
    expect(await screen.findByRole('alert')).toHaveTextContent('该文件不是有效的 AwwO 界面风格。');
    await upload(exportNodeViewPreference({ version: 1, style: 'codex', custom: { ...PRESET_KNOBS.workbuddy } }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(parseNodeViewPreference(localStorage.getItem(nodeViewStorageKey()))).toEqual({ version: 1, style: 'custom', custom: PRESET_KNOBS.workbuddy });
  });
});

describe('the canvas root', () => {
  const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
  beforeEach(() => {
    resetAllSessions(); configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(emptyDocument()));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const status = { configured: true, available: true, plannerAvailable: true, models: [], runtimes: [] };
    vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => new Response(JSON.stringify(String(input).endsWith('/runtime') ? status : { items: [] }))));
  });

  it('follows the saved style live, including a change made in another tab', async () => {
    const view = render(<CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} />);
    const root = () => view.container.querySelector('.canvas-root')!;
    expect(root()).toHaveAttribute('data-node-style', 'default');
    expect(root()).not.toHaveAttribute('data-node-layout');
    act(() => saveNodeViewPreference({ ...DEFAULT_NODE_VIEW, style: 'claude-code' }));
    expect(root()).toHaveAttribute('data-node-style', 'claude-code');
    expect(root()).toHaveAttribute('data-node-layout', 'terminal');
    act(() => {
      localStorage.setItem(nodeViewStorageKey(), JSON.stringify(custom({ accent: '#336699', size: 15 })));
      window.dispatchEvent(new StorageEvent('storage', { key: nodeViewStorageKey() }));
    });
    expect(root()).toHaveAttribute('data-node-style', 'custom');
    expect((root() as HTMLElement).style.getPropertyValue('--nvc-accent-light')).toBe('#336699');
    expect((root() as HTMLElement).style.getPropertyValue('--nvc-size')).toBe('15px');
    act(() => {
      localStorage.setItem(nodeViewStorageKey(), 'garbage');
      window.dispatchEvent(new StorageEvent('storage', { key: nodeViewStorageKey() }));
    });
    expect(root()).toHaveAttribute('data-node-style', 'default');
  });
});
