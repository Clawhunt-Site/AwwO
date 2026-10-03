// Selectable looks for an opened canvas node: the AwwO default, Codex, WorkBuddy, Claude Code, or a
// custom combination. A style is a CSS skin driven by data attributes and a few validated colour and
// size variables on the canvas root (node-view-styles.css). It never changes what a node shows: no
// markup, tool call, plan or status is added, so every honesty rule of the transcript still holds.
//
// The preference is a browser preference like light/dark, scoped to the signed-in account in SaaS
// (another account on the same browser keeps its own). It is closed-set: values outside the lists
// below, or colours that are not #rrggbb, fall back to the defaults instead of reaching CSS.
import { useCallback, useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import { userStorageKey } from './canvasStorage';

export const NODE_VIEW_STYLES = ['default', 'codex', 'workbuddy', 'claude-code', 'custom'] as const;
export type NodeViewStyleId = typeof NODE_VIEW_STYLES[number];
export const NODE_VIEW_LAYOUTS = ['bubbles', 'flat', 'terminal'] as const;
export const NODE_VIEW_FONTS = ['system', 'rounded', 'serif', 'mono'] as const;
export const NODE_VIEW_SIZES = [12, 13, 14, 15, 16] as const;
export const NODE_VIEW_DENSITIES = ['compact', 'standard', 'relaxed'] as const;
export const NODE_VIEW_RADII = ['square', 'soft', 'round'] as const;
export const NODE_VIEW_WIDTHS = ['full', 'centered'] as const;

export type NodeViewKnobs = {
  layout: typeof NODE_VIEW_LAYOUTS[number];
  font: typeof NODE_VIEW_FONTS[number];
  size: typeof NODE_VIEW_SIZES[number];
  density: typeof NODE_VIEW_DENSITIES[number];
  radius: typeof NODE_VIEW_RADII[number];
  width: typeof NODE_VIEW_WIDTHS[number];
  /** #rrggbb used for the send control, focus rings, links and the working indicator. */
  accent: string;
  /** #rrggbb for the user's messages, or '' to derive it from the accent. */
  userBubble: string;
};
export type NodeViewPreference = { version: 1; style: NodeViewStyleId; custom: NodeViewKnobs };

/** The knobs each preset is built from. The custom editor starts from these; its colours then
 *  adapt to the light or dark theme, while a preset also carries its own tuned palette (CSS). */
export const PRESET_KNOBS: Record<Exclude<NodeViewStyleId, 'custom'>, NodeViewKnobs> = {
  default: { layout: 'bubbles', font: 'system', size: 13, density: 'standard', radius: 'round', width: 'full', accent: '#0a84ff', userBubble: '' },
  codex: { layout: 'flat', font: 'system', size: 14, density: 'standard', radius: 'round', width: 'centered', accent: '#0d0d0d', userBubble: '#f2f2f2' },
  workbuddy: { layout: 'flat', font: 'rounded', size: 14, density: 'standard', radius: 'soft', width: 'full', accent: '#165dff', userBubble: '#087a5a' },
  'claude-code': { layout: 'terminal', font: 'mono', size: 13, density: 'compact', radius: 'square', width: 'full', accent: '#b4461f', userBubble: '' },
};
export const DEFAULT_NODE_VIEW: NodeViewPreference = Object.freeze({ version: 1, style: 'default', custom: Object.freeze({ ...PRESET_KNOBS.default }) }) as NodeViewPreference;

const HEX = /^#[0-9a-f]{6}$/;
const pick = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
const color = (value: unknown, fallback: string, empty = false): string => {
  if (empty && value === '') return '';
  return typeof value === 'string' && HEX.test(value.toLowerCase()) ? value.toLowerCase() : fallback;
};

/** Never throws: anything unrecognised becomes the default for that knob. */
export function normalizeKnobs(value: unknown, fallback: NodeViewKnobs = PRESET_KNOBS.default): NodeViewKnobs {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    layout: pick(v.layout, NODE_VIEW_LAYOUTS, fallback.layout),
    font: pick(v.font, NODE_VIEW_FONTS, fallback.font),
    size: pick(v.size, NODE_VIEW_SIZES, fallback.size),
    density: pick(v.density, NODE_VIEW_DENSITIES, fallback.density),
    radius: pick(v.radius, NODE_VIEW_RADII, fallback.radius),
    width: pick(v.width, NODE_VIEW_WIDTHS, fallback.width),
    accent: color(v.accent, fallback.accent),
    userBubble: color(v.userBubble, fallback.userBubble, true),
  };
}

export function parseNodeViewPreference(raw: string | null | undefined): NodeViewPreference {
  if (!raw) return DEFAULT_NODE_VIEW;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return DEFAULT_NODE_VIEW; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { version?: unknown }).version !== 1) return DEFAULT_NODE_VIEW;
  const v = value as Record<string, unknown>;
  return { version: 1, style: pick(v.style, NODE_VIEW_STYLES, 'default'), custom: normalizeKnobs(v.custom) };
}

/** A strict reader for an imported file: unlike stored state, a mistaken file is reported, not repaired. */
export function importNodeViewPreference(raw: string): NodeViewPreference | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (v.version !== 1 || !keys.every(key => ['version', 'style', 'custom'].includes(key)) || !NODE_VIEW_STYLES.includes(v.style as NodeViewStyleId)) return null;
  const custom = v.custom;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return null;
  const knobs = normalizeKnobs(custom);
  // Every provided knob must have survived unchanged; an unknown or invalid one rejects the file.
  const given = custom as Record<string, unknown>;
  const expected = Object.keys(PRESET_KNOBS.default);
  if (Object.keys(given).length !== expected.length || !expected.every(key => key in given)) return null;
  for (const key of expected) {
    const provided = given[key];
    const kept = knobs[key as keyof NodeViewKnobs];
    if ((typeof provided === 'string' ? provided.toLowerCase() : provided) !== kept) return null;
  }
  return { version: 1, style: v.style as NodeViewStyleId, custom: knobs };
}

export function exportNodeViewPreference(preference: NodeViewPreference): string {
  return `${JSON.stringify({ version: 1, style: preference.style, custom: normalizeKnobs(preference.custom) }, null, 2)}\n`;
}

function channel(hex: string, offset: number): number {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
/** WCAG relative luminance of #rrggbb. */
export function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** White or a dark text colour, whichever reads better on the given fill. One of white and black
 *  always reaches at least 4.58:1, so the result meets WCAG AA (4.5:1) on any fill; the softer
 *  near-black is used only where it reaches AA too (mid-tones such as #777777 need pure black). */
export function readableText(fill: string): string {
  if (contrastRatio(fill, '#ffffff') >= contrastRatio(fill, '#000000')) return '#ffffff';
  return contrastRatio(fill, '#141414') >= 4.5 ? '#141414' : '#000000';
}

/** The conversation surfaces a custom style can sit on in each theme: the workspace cards
 *  (ios-theme) and the node's own palette (saas, awwo-node). A colour that reads on all of a
 *  theme's surfaces reads on every real card. */
export const NODE_VIEW_SURFACES = Object.freeze({
  light: Object.freeze(['#ffffff', '#f7f8f6', '#fffefa']),
  dark: Object.freeze(['#0e1421', '#222b25', '#222925']),
});
/** WCAG AA for text; 3:1 for a control or focus ring against what surrounds it. */
export const TEXT_CONTRAST = 4.5;
export const CONTROL_CONTRAST = 3;

/** The accent adjusted for a theme: unchanged when it already reaches `ratio` against every
 *  surface, otherwise moved toward black (light theme) or white (dark theme) in small steps,
 *  keeping its hue, until it does. */
export function inkOn(accent: string, surfaces: readonly string[], ratio = TEXT_CONTRAST): string {
  const reads = (colour: string) => surfaces.every(surface => contrastRatio(colour, surface) >= ratio);
  if (reads(accent)) return accent;
  const toward = luminance(surfaces[0]) > 0.18 ? 0 : 255;
  const channels = [1, 3, 5].map(offset => parseInt(accent.slice(offset, offset + 2), 16));
  for (let step = 1; step < 20; step += 1) {
    const mixed = `#${channels.map(value => Math.round(value + (toward - value) * step / 20).toString(16).padStart(2, '0')).join('')}`;
    if (reads(mixed)) return mixed;
  }
  return toward ? '#ffffff' : '#000000';
}

/** One theme's custom colours: the accent as a fill that stands out (send button, focus ring), the
 *  text on that fill, and the accent as text (links, the working label). */
function themeColours(theme: 'light' | 'dark', accent: string): Record<string, string> {
  const fill = inkOn(accent, NODE_VIEW_SURFACES[theme], CONTROL_CONTRAST);
  return { [`--nvc-accent-${theme}`]: fill, [`--nvc-accent-text-${theme}`]: readableText(fill), [`--nvc-ink-${theme}`]: inkOn(accent, NODE_VIEW_SURFACES[theme]) };
}

type RootProps = { 'data-node-style': NodeViewStyleId; style?: CSSProperties } & Record<`data-node-${string}`, string | undefined>;

/** Attributes for the canvas root. Presets set only their identity and layout; custom adds its knobs. */
export function nodeViewRootProps(preference: NodeViewPreference): RootProps {
  if (preference.style !== 'custom') {
    if (preference.style === 'default') return { 'data-node-style': 'default' };
    const knobs = PRESET_KNOBS[preference.style];
    return { 'data-node-style': preference.style, 'data-node-layout': knobs.layout, 'data-node-width': knobs.width };
  }
  const c = normalizeKnobs(preference.custom);
  const userFill = c.userBubble || '';
  return {
    'data-node-style': 'custom', 'data-node-layout': c.layout, 'data-node-width': c.width, 'data-node-density': c.density,
    'data-node-radius': c.radius, 'data-node-font': c.font,
    // Root-level inputs only; node-view-styles.css maps them inside the opened node, so a preset
    // never inherits a stale custom value.
    style: { '--nvc-size': `${c.size}px`, ...themeColours('light', c.accent), ...themeColours('dark', c.accent),
      ...(userFill ? { '--nvc-user-bg': userFill, '--nvc-user-fg': readableText(userFill) } : {}),
    } as CSSProperties,
  };
}

const LOCAL_KEY = 'superclaw_node_view_style';
const CHANGE_EVENT = 'awwo:node-view-style';
const memory = new Map<string, string>();
/** Per account in SaaS (the canvas storage scope), one per browser in the legacy local app. */
export function nodeViewStorageKey(): string { return userStorageKey('node-view-style') ?? LOCAL_KEY; }
function readRaw(): string {
  const key = nodeViewStorageKey();
  try { const value = localStorage.getItem(key); if (value !== null) return value; } catch { /* Storage can be unavailable. */ }
  return memory.get(key) ?? '';
}
function subscribe(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === nodeViewStorageKey()) callback(); };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => { window.removeEventListener('storage', onStorage); window.removeEventListener(CHANGE_EVENT, callback); };
}

export function saveNodeViewPreference(preference: NodeViewPreference): void {
  const key = nodeViewStorageKey();
  const value = JSON.stringify({ version: 1, style: pick(preference.style, NODE_VIEW_STYLES, 'default'), custom: normalizeKnobs(preference.custom) });
  memory.set(key, value);
  try { localStorage.setItem(key, value); }
  catch {
    // Full or blocked storage: drop the older stored value so this tab reads the in-memory
    // choice instead of silently snapping back to the previous style.
    try { localStorage.removeItem(key); } catch { /* Unavailable storage already reads from memory. */ }
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The current preference and a setter; every canvas and picker in the page follows one value. */
export function useNodeViewPreference(): [NodeViewPreference, (next: NodeViewPreference) => void] {
  const raw = useSyncExternalStore(subscribe, readRaw, () => '');
  const preference = useMemo(() => parseNodeViewPreference(raw), [raw]);
  const setPreference = useCallback((next: NodeViewPreference) => saveNodeViewPreference(next), []);
  return [preference, setPreference];
}
