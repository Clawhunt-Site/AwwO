import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import catalog from '../../../backend/internal/app/appearance_catalog.json';
import { AUTO_THEMES, AWWO_THEMES, LEGACY_THEME_STORAGE_KEY, readThemeChoice, resolveTheme, THEME_STORAGE_KEY } from '../src/saas/themes';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { ThemePicker } from '../src/saas/ThemePicker';
import { AppearanceScope } from '../src/saas/SaaSAppearance';
import { SaaSApp } from '../src/saas/SaaSApp';
import { appearanceFixture } from './saas-appearance-fixture';

const css = readFileSync(resolve(process.cwd(), 'src/saas/design/themes.css'), 'utf8');
const html = readFileSync(resolve(process.cwd(), 'saas.html'), 'utf8');
const prepaintScript = html.match(/<script>([\s\S]*?)<\/script>/)![1];
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

/** The custom properties a style's own block declares (html:root[data-awwo-theme='<id>'], ...). */
function block(id: string) {
  const match = css.match(new RegExp(`html:root\\[data-awwo-theme='${id}'\\][^{]*\\{([^}]*)\\}`));
  if (!match) return null;
  const values = Object.fromEntries([...match[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  return { values, scheme: match[1].match(/color-scheme:\s*(light|dark)/)?.[1] };
}
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** color-mix(in srgb, a share%, b): what the danger chip and the like paint. */
const mix = (a: string, b: string, share: number) => '#' + rgb(a).map((v, i) => Math.round(v * share + rgb(b)[i] * (1 - share)).toString(16).padStart(2, '0')).join('');
const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
const isTriplet = (value: string) => /^\d{1,3} \d{1,3} \d{1,3}$/.test(value) && value.split(' ').every(n => Number(n) <= 255);

const PALETTE = ['--bg-base', '--bg-sidebar', '--bg-card', '--border-light', '--text-primary', '--text-secondary', '--accent', '--accent-soft', '--sc-accent',
  '--saas-link', '--saas-link-hover', '--agent-running', '--saas-bio', '--saas-bio-lilac', '--saas-success', '--saas-success-dot', '--saas-success-soft',
  '--warn', '--warn-soft', '--saas-warning-dot', '--danger-bg', '--saas-tank-1', '--saas-tank-2', '--saas-tank-3', '--saas-tank-card', '--saas-tank-raised',
  '--saas-tank-ink', '--saas-tank-muted', '--saas-tank-focus', '--saas-tank-accent', '--saas-tank-accent-soft', '--saas-orb-core', '--saas-orb-edge'];
const TRIPLETS = ['--saas-shadow-rgb', '--saas-tank-line-rgb', '--saas-tank-glass-rgb', '--saas-glow-1-rgb', '--saas-glow-2-rgb', '--saas-orb-hi-rgb', '--saas-orb-ring-rgb'];

beforeEach(() => { localStorage.clear(); for (const name of ['awwoTheme', 'theme']) delete document.documentElement.dataset[name]; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.documentElement.removeAttribute('style'); });

describe('the eight styles', () => {
  it('are four light and four dark, each with a Chinese and an English name and description', () => {
    expect(AWWO_THEMES.map(theme => theme.id)).toEqual(['tide', 'cloud', 'paper', 'blossom', 'night', 'graphite', 'aurora', 'ember']);
    expect(AWWO_THEMES.filter(theme => theme.scheme === 'light')).toHaveLength(4);
    for (const theme of AWWO_THEMES) for (const text of [theme.name, theme.description]) { expect(text.zh.trim()).not.toBe(''); expect(text.en.trim()).not.toBe(''); }
    expect(new Set(AWWO_THEMES.map(theme => theme.name.zh)).size).toBe(8);
    expect(AUTO_THEMES).toEqual({ light: 'tide', dark: 'night' });
  });

  it.each(AWWO_THEMES.map(theme => [theme.id, theme] as const))('%s declares a whole look in themes.css, on its own light or dark side', (id, theme) => {
    const own = block(id);
    expect(own, `no block for ${id}`).not.toBeNull();
    expect(own!.scheme).toBe(theme.scheme);
    for (const name of PALETTE) expect(isHex(own!.values[name] ?? ''), `${id} ${name} = ${own!.values[name]}`).toBe(true);
    for (const name of TRIPLETS) expect(isTriplet(own!.values[name] ?? ''), `${id} ${name} = ${own!.values[name]}`).toBe(true);
    expect(own!.values['--saas-brand-grad']).toMatch(/^linear-gradient\(/);
    expect(own!.values['--saas-scrim']).toMatch(/^rgb\(/);
    // A light style's text accent is its own (the dark side uses the accent itself, shared block).
    if (theme.scheme === 'light') expect(own!.values['--saas-accent']).toBeTruthy();
    expect(css).toContain(`.awwo-theme-preview[data-awwo-theme='${id}']`);
  });

  it.each(AWWO_THEMES.map(theme => [theme.id, theme] as const))('%s keeps ink, muted text, links, accents and status text readable (WCAG AA)', (id, theme) => {
    const v = block(id)!.values;
    const surfaces = [v['--bg-base'], v['--bg-card'], v['--bg-sidebar']];
    for (const surface of surfaces) {
      expect(contrast(v['--text-primary'], surface), `${id} ink on ${surface}`).toBeGreaterThanOrEqual(7);
      expect(contrast(v['--text-secondary'], surface), `${id} muted on ${surface}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v['--saas-link'], surface), `${id} link on ${surface}`).toBeGreaterThanOrEqual(4.5);
      const textAccent = theme.scheme === 'dark' ? v['--accent'] : v['--saas-accent'];
      if (isHex(textAccent)) expect(contrast(textAccent, surface), `${id} accent text on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(v['--saas-success'], v['--saas-success-soft']), `${id} success chip`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v['--warn'], v['--warn-soft']), `${id} warning chip`).toBeGreaterThanOrEqual(4.5);
    // Error text sits on the card, or on its 8% danger tint (tokens.css --saas-danger-bg).
    expect(contrast(v['--danger-bg'], mix(v['--danger-bg'], v['--bg-card'], 0.08)), `${id} danger chip`).toBeGreaterThanOrEqual(4.5);
    // The deep tank (sign-in, delivery drawer) is read in its own ink.
    expect(contrast(v['--saas-tank-ink'], v['--saas-tank-2'])).toBeGreaterThanOrEqual(7);
    expect(contrast(v['--saas-tank-ink'], v['--saas-tank-card'])).toBeGreaterThanOrEqual(7);
    expect(contrast(v['--saas-tank-muted'], v['--saas-tank-2'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v['--saas-tank-muted'], v['--saas-tank-card'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps 潮汐 and 深潜 exactly the values the tokens always had', () => {
    const tokens = readFileSync(resolve(process.cwd(), 'src/saas/design/tokens.css'), 'utf8');
    const tide = block('tide')!.values, night = block('night')!.values;
    for (const [name, value] of [['--bg-base', '#eef0ef'], ['--bg-card', '#ffffff'], ['--text-primary', '#0b2230'], ['--accent', '#2b7ad8'], ['--saas-link', '#1c6f76'], ['--saas-bio', '#2bb3bb']]) {
      expect(tide[name]).toBe(value); expect(tokens).toContain(`${name}: ${value};`);
    }
    for (const [name, value] of [['--bg-base', '#07161f'], ['--bg-card', '#0c2230'], ['--text-primary', '#e7eef0'], ['--accent', '#4c9cf5'], ['--saas-link', '#6cc6c8'], ['--saas-bio', '#5fe3e8']]) {
      expect(night[name]).toBe(value); expect(tokens).toContain(`${name}: ${value};`);
    }
  });
});

describe('the choice before the first paint (saas.html) and in the app', () => {
  function prepaint(saved: string | null, legacy: string | null, dark: boolean) {
    localStorage.clear();
    if (saved !== null) localStorage.setItem(THEME_STORAGE_KEY, saved);
    if (legacy !== null) localStorage.setItem(LEGACY_THEME_STORAGE_KEY, legacy);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: dark && query.includes('dark'), addEventListener() {}, removeEventListener() {} }));
    const root = document.documentElement;
    delete root.dataset.awwoTheme; delete root.dataset.theme;
    new Function(prepaintScript)();
    return [root.dataset.awwoTheme, root.dataset.theme];
  }

  it('carries the same styles, light or dark side and follow-system pair as the catalogue', () => {
    const map = Object.fromEntries([...prepaintScript.match(/S=\{([^}]*)\}/)![1].matchAll(/(\w+):'(light|dark)'/g)].map(([, id, scheme]) => [id, scheme]));
    expect(map).toEqual(Object.fromEntries(AWWO_THEMES.map(theme => [theme.id, theme.scheme])));
    expect(prepaintScript).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(prepaintScript).toContain(`'${LEGACY_THEME_STORAGE_KEY}'`);
    expect(prepaintScript).toContain(`k?'${AUTO_THEMES.dark}':'${AUTO_THEMES.light}'`);
  });

  it.each([
    ['a saved style', 'paper', null, false, 'paper', 'light'],
    ['a saved dark style on a light system', 'aurora', null, false, 'aurora', 'dark'],
    ['follow system, dark', 'auto', null, true, 'night', 'dark'],
    ['nothing saved, light system', null, null, false, 'tide', 'light'],
    ['an old dark choice on a light system', null, 'dark', false, 'night', 'dark'],
    ['an old light choice on a dark system', null, 'light', true, 'tide', 'light'],
    ['an old value that only echoes the system', null, 'dark', true, 'night', 'dark'],
    ['an unknown value', 'neon', null, false, 'tide', 'light'],
    ['a prototype key', '__proto__', 'light', true, 'tide', 'light'],
  ])('%s: the page script and the app agree', (_case, saved, legacy, dark, id, scheme) => {
    expect(prepaint(saved as string | null, legacy as string | null, dark as boolean)).toEqual([id, scheme]);
    expect(resolveTheme(readThemeChoice(dark as boolean), dark as boolean)).toMatchObject({ id, scheme });
  });

  it('migrates an old explicit choice once and follows the system when the old value only echoed it', () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, 'dark');
    expect(readThemeChoice(false)).toBe('night');
    expect(readThemeChoice(true)).toBe('auto');
    localStorage.setItem(THEME_STORAGE_KEY, 'ember');
    expect(readThemeChoice(false)).toBe('ember');
  });
});

describe('the 外观 picker', () => {
  beforeEach(() => localStorage.setItem('superclaw_locale', 'zh'));
  const openPicker = () => { fireEvent.click(screen.getByRole('button', { name: /外观风格/ })); return screen.getByRole('dialog', { name: '外观风格' }); };

  it('offers follow-system and the eight styles, applies a choice at once and remembers it', () => {
    const view = render(<SaaSPreferencesProvider><ThemePicker /></SaaSPreferencesProvider>);
    expect(document.documentElement.dataset.awwoTheme).toBe('tide');
    const dialog = openPicker();
    const group = within(dialog).getByRole('radiogroup', { name: '外观风格' });
    expect(within(group).getAllByRole('radio')).toHaveLength(9);
    expect(within(group).getByRole('radio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'true');
    for (const theme of AWWO_THEMES) expect(within(group).getByRole('radio', { name: theme.name.zh })).toHaveAccessibleDescription(new RegExp(theme.description.zh));
    fireEvent.click(within(group).getByRole('radio', { name: '暖纸' }));
    expect(document.documentElement.dataset.awwoTheme).toBe('paper');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('paper');
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe('light');
    expect(within(group).getByRole('radio', { name: '暖纸' })).toHaveAttribute('aria-checked', 'true');
    view.unmount();
    render(<SaaSPreferencesProvider><ThemePicker /></SaaSPreferencesProvider>);
    expect(document.documentElement.dataset.awwoTheme).toBe('paper');
    expect(screen.getByRole('button', { name: '外观风格：暖纸' })).toBeVisible();
  });

  it('moves through the styles with the arrow keys and closes on Escape back to its button', () => {
    render(<SaaSPreferencesProvider><ThemePicker /></SaaSPreferencesProvider>);
    const trigger = screen.getByRole('button', { name: /外观风格/ });
    const dialog = openPicker();
    fireEvent.click(within(dialog).getByRole('radio', { name: '樱雾' }));
    fireEvent.keyDown(within(dialog).getByRole('radio', { name: '樱雾' }), { key: 'ArrowRight' });
    expect(document.documentElement.dataset.awwoTheme).toBe('night');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(within(dialog).getByRole('radio', { name: '深潜' })).toHaveFocus();
    fireEvent.keyDown(within(dialog).getByRole('radio', { name: '深潜' }), { key: 'End' });
    expect(document.documentElement.dataset.awwoTheme).toBe('ember');
    fireEvent.keyDown(within(dialog).getByRole('radio', { name: '琥珀夜' }), { key: 'ArrowRight' });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('auto');
    expect(within(dialog).getByRole('radio', { name: '跟随系统' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('follows the system while the page is open when set to follow it', () => {
    let listener: (() => void) | undefined; let dark = false;
    vi.stubGlobal('matchMedia', (query: string) => ({ get matches() { return dark && query.includes('dark'); }, addEventListener: (_: string, fn: () => void) => { listener = fn; }, removeEventListener() {} }));
    render(<SaaSPreferencesProvider><ThemePicker /></SaaSPreferencesProvider>);
    expect(document.documentElement.dataset.awwoTheme).toBe('tide');
    dark = true; act(() => listener?.());
    expect(document.documentElement.dataset.awwoTheme).toBe('night');
    expect(screen.getByRole('button', { name: '外观风格：跟随系统（深潜）' })).toBeVisible();
  });

  it('hands the colours back to the style when the account still paints an older colour scheme over it', async () => {
    const emerald = catalog.presets.find(preset => preset.id === 'emerald')!;
    let server = { ...appearanceFixture, active_preset: 'emerald', version: 3, custom: { light: { accent: '#123456' }, dark: {} } };
    const writes: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT') { const body = JSON.parse(init.body as string); writes.push(body); server = { ...server, ...body, version: server.version + 1 }; }
      return response(server);
    }));
    render(<SaaSPreferencesProvider><AppearanceScope userId="alice"><ThemePicker /></AppearanceScope></SaaSPreferencesProvider>);
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe(emerald.overrides.light.accent));
    const dialog = openPicker();
    expect(within(dialog).getByRole('status')).toHaveTextContent('「Emerald」');
    expect(writes).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('radio', { name: '石墨' }));
    fireEvent.keyDown(within(dialog).getByRole('radio', { name: '石墨' }), { key: 'ArrowRight' });
    await screen.findByText('已改用风格自带的配色。账号里原来的配色仍保存在运行设置里。');
    expect(writes).toEqual([{ active_preset: 'default', custom: { light: { accent: '#123456' }, dark: {} }, version: 3 }]);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
    expect(document.documentElement.dataset.awwoTheme).toBe('aurora');
  });

  it('leaves an account colour scheme alone until a style is chosen', async () => {
    const fetch = vi.fn(async () => response({ ...appearanceFixture, active_preset: 'midnight', version: 1 }));
    vi.stubGlobal('fetch', fetch);
    render(<SaaSPreferencesProvider><AppearanceScope userId="alice"><ThemePicker /></AppearanceScope></SaaSPreferencesProvider>);
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg-base')).not.toBe(''));
    openPicker();
    fireEvent.keyDown(screen.getByRole('dialog', { name: '外观风格' }), { key: 'Escape' });
    expect(fetch.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
  });
});

it('puts the 外观 button on the signed-in header bar and keeps the More menu free of a second theme switch', async () => {
  localStorage.setItem('superclaw_locale', 'zh');
  localStorage.setItem('awwo.workmode.v1:user-a', 'completed');
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'admin' }, tenants: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.endsWith('/appearance') ? appearanceFixture : identity)));
  render(<SaaSApp />);
  const header = (await screen.findByRole('link', { name: '进入平台管理' })).closest('main')!.querySelector('header')!;
  const trigger = within(header).getByRole('button', { name: /外观风格/ });
  expect(trigger).toHaveTextContent('外观');
  fireEvent.click(within(header).getByRole('button', { name: '更多选项' }));
  const menu = screen.getByRole('dialog', { name: '更多选项' });
  expect(within(menu).queryByRole('button', { name: /深色|浅色|外观/ })).toBeNull();
  expect(within(menu).getByRole('button', { name: '切换为英文' })).toHaveTextContent('English');
});
