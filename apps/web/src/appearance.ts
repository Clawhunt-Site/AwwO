// Appearance / color-scheme surface logic.
//
// The kernel (`superclaw.appearance`) is the single source of truth for the preset
// catalog and the persisted choice; this module is the *presentation* half — it
// reads the kernel payload and projects it onto CSS custom properties on the document
// root. The base canvas (light/dark) stays owned by the existing `data-theme`
// mechanism; a color scheme only *overrides* a curated whitelist of tokens on top of
// it. Translucent companion variables (`--accent-soft` …) are derived here from each
// token's `soft_alpha` — color math is a rendering detail kept out of the kernel.

export type AppearanceCanvas = 'light' | 'dark';

export interface AppearanceToken {
  id: string;
  label: string;
  css_var: string;
  group: string;
  soft_var?: string;
  soft_alpha?: number;
}

export interface AppearancePreset {
  id: string;
  label: string;
  description: string;
  swatch: string;
  overrides: Record<AppearanceCanvas, Record<string, string>>;
}

export type AppearanceCustom = Record<AppearanceCanvas, Record<string, string>>;

export interface AppearancePayload {
  schema_version: string;
  canvases: AppearanceCanvas[];
  default_preset: string;
  custom_preset_id: string;
  tokens: AppearanceToken[];
  presets: AppearancePreset[];
  config_path?: string;
  active_preset: string;
  custom: AppearanceCustom;
  warnings?: string[];
}

export interface AppearanceExportBundle {
  kind: string;
  schema_version: string;
  active_preset: string;
  custom: AppearanceCustom;
}

// FOUC guard: the last-applied payload is cached so a color scheme can be re-applied
// synchronously on the next load, before the async `/api/appearance` fetch resolves.
export const APPEARANCE_STORAGE_KEY = 'superclaw_appearance';

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}

function normalizeHex(value: string): string {
  let body = value.trim().slice(1).toLowerCase();
  if (body.length === 3) {
    body = body
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  return `#${body}`;
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeHex(hex);
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  // Trim trailing zeros so '0.20' -> '0.2' to match the stylesheet's literals.
  const a = Number(alpha.toFixed(3)).toString();
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** The token-id -> hex overrides in effect for a canvas, given the active scheme. */
export function resolveOverrides(
  payload: AppearancePayload,
  canvas: AppearanceCanvas,
): Record<string, string> {
  if (payload.active_preset === payload.custom_preset_id) {
    return { ...(payload.custom?.[canvas] ?? {}) };
  }
  const preset = payload.presets.find((p) => p.id === payload.active_preset);
  return { ...(preset?.overrides?.[canvas] ?? {}) };
}

/** Expand the active overrides into concrete `cssVar -> value` assignments. */
export function resolveSchemeVars(
  payload: AppearancePayload,
  canvas: AppearanceCanvas,
): Record<string, string> {
  const overrides = resolveOverrides(payload, canvas);
  const tokensById = new Map(payload.tokens.map((t) => [t.id, t]));
  const out: Record<string, string> = {};
  for (const [tokenId, hex] of Object.entries(overrides)) {
    const token = tokensById.get(tokenId);
    if (!token || !isValidHex(hex)) continue;
    out[token.css_var] = normalizeHex(hex);
    if (token.soft_var && typeof token.soft_alpha === 'number') {
      out[token.soft_var] = hexToRgba(hex, token.soft_alpha);
    }
  }
  return out;
}

/** Every CSS var a scheme could touch — cleared before each apply so switching back
 *  to a preset that overrides fewer tokens reveals the stylesheet defaults again. */
function clearableVars(payload: AppearancePayload): string[] {
  const vars: string[] = [];
  for (const token of payload.tokens) {
    vars.push(token.css_var);
    if (token.soft_var) vars.push(token.soft_var);
  }
  return vars;
}

/** Apply the active color scheme to the document root for the given canvas.
 *  Idempotent: clears all scheme-owned vars first, then sets the active ones, so the
 *  result depends only on the current payload+canvas, never on prior calls.
 *
 *  Also wipes every var that `applyCachedScheme` set (tracked in `_cachedVarsApplied`)
 *  so a non-whitelisted cache entry (e.g. a future token) cannot outlive the authoritative
 *  payload load. */
export function applyAppearance(
  payload: AppearancePayload | null,
  canvas: AppearanceCanvas,
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!payload) return;
  // Wipe any var the FOUC cache wrote that the current kernel contract doesn't own.
  for (const cssVar of _cachedVarsApplied) {
    root.style.removeProperty(cssVar);
  }
  _cachedVarsApplied.clear();
  // Clear kernel scheme-owned vars so switching back to a lighter preset reveals defaults.
  for (const cssVar of clearableVars(payload)) {
    root.style.removeProperty(cssVar);
  }
  const vars = resolveSchemeVars(payload, canvas);
  for (const [cssVar, value] of Object.entries(vars)) {
    root.style.setProperty(cssVar, value);
  }
  syncBoardAccentMirror(root, vars[ACCENT_CSS_VAR]);
}

// The embedded board (shadcn) shadows the bare `--accent` name with its OWN neutral gray,
// so it can't read super's brand accent through `var(--accent)`. We publish the brand accent
// under a non-colliding alias `--sc-accent` that the board's token bridge consumes (styles.css).
// `--accent` is the ONLY name shared with the board, so this single mirror is sufficient.
const ACCENT_CSS_VAR = '--accent';
const BOARD_ACCENT_MIRROR = '--sc-accent';

function syncBoardAccentMirror(root: HTMLElement, accentValue: string | undefined): void {
  if (accentValue) {
    // A preset/custom override is active — mirror its concrete value.
    root.style.setProperty(BOARD_ACCENT_MIRROR, accentValue);
  } else {
    // No accent override — drop the inline alias so it falls back to the stock `--sc-accent`
    // declared in the base stylesheet (kept in lockstep with the stock `--accent`).
    root.style.removeProperty(BOARD_ACCENT_MIRROR);
  }
}

// --- FOUC cache ------------------------------------------------------------------
// The cache holds ONLY a pre-rendered, self-contained snapshot of the resolved CSS
// vars per canvas — never the kernel contract. So it can never act as a second source
// of truth for the preset/token catalog: the authoritative payload always comes from
// `/api/appearance`. Every cached entry is re-validated before it is injected, so a
// tampered/stale cache cannot smuggle an arbitrary value into `style.setProperty`.
//
// IMPORTANT: `applyCachedScheme` may write vars that are NOT in the kernel token
// whitelist (e.g. future tokens cached by an older/newer kernel version). The
// authoritative `applyAppearance` must wipe *all* vars the cache applied, not just
// the vars it owns, so no cache entry escapes into the post-load page session.
// `_cachedVarsApplied` tracks every var written by `applyCachedScheme`; it is cleared
// by `applyAppearance` on its first authoritative pass.

type CachedScheme = { light: Record<string, string>; dark: Record<string, string> };

// Vars written by the last `applyCachedScheme` call; wiped by `applyAppearance`.
const _cachedVarsApplied = new Set<string>();

const CSS_VAR_RE = /^--[a-z0-9-]+$/;
const RGBA_RE = /^rgba?\([\d.,\s]+\)$/;

function isSafeVarValue(value: string): boolean {
  return isValidHex(value) || RGBA_RE.test(value);
}

function sanitizeCanvasVars(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (CSS_VAR_RE.test(key) && typeof value === 'string' && isSafeVarValue(value)) {
      out[key] = value;
    }
  }
  return out;
}

export function cacheScheme(payload: AppearancePayload): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const snapshot: CachedScheme = {
      light: resolveSchemeVars(payload, 'light'),
      dark: resolveSchemeVars(payload, 'dark'),
    };
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // best-effort cache; a quota/serialization failure must never break theming
  }
}

// --- serial mutation queue -------------------------------------------------------
// Appearance mutations must be SERIALIZED, not just have their responses ordered.
// Firing them concurrently lets the server observe writes in a different order than
// the user issued them: two quick edits to the SAME token (red then blue) could land
// on disk as red-then... no — as blue-then-red if the requests race, leaving the disk
// holding the OLDER intent while the UI shows the newer. A client-side latest-wins
// gate can't fix that (it only orders what the UI adopts, not what the kernel writes).
// The robust fix is to run each mutation only after the previous one has fully settled,
// so server write order == user intent order, and responses are adopted in that order.
export interface SerialQueue {
  run: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      // Chain off the tail; run `task` whether the prior settled OK or errored, so one
      // failed mutation never wedges the queue. The tail swallows results/errors.
      const result = tail.then(task, task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export function readCachedScheme(): CachedScheme | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedScheme>;
    return { light: sanitizeCanvasVars(parsed?.light), dark: sanitizeCanvasVars(parsed?.dark) };
  } catch {
    return null;
  }
}

/** Apply the cached (validated) scheme for a canvas before the authoritative payload
 *  loads, to avoid a flash of the stock colors. Every var set here is recorded in
 *  `_cachedVarsApplied` so `applyAppearance` can wipe them all — even vars the current
 *  kernel doesn't own — when the authoritative payload arrives. */
export function applyCachedScheme(canvas: AppearanceCanvas): void {
  if (typeof document === 'undefined') return;
  const cached = readCachedScheme();
  if (!cached) return;
  const root = document.documentElement;
  for (const [cssVar, value] of Object.entries(cached[canvas])) {
    root.style.setProperty(cssVar, value);
    _cachedVarsApplied.add(cssVar);
  }
  // Mirror the cached brand accent so the embedded board themes correctly pre-load too;
  // tracked in `_cachedVarsApplied` so the authoritative `applyAppearance` wipes it.
  const cachedAccent = cached[canvas][ACCENT_CSS_VAR];
  if (cachedAccent) {
    root.style.setProperty(BOARD_ACCENT_MIRROR, cachedAccent);
    _cachedVarsApplied.add(BOARD_ACCENT_MIRROR);
  }
}
