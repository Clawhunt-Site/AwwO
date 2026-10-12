/**
 * AwwO's appearance styles (外观风格). The values live in design/themes.css; this is the catalogue the picker shows,
 * the choice a reader makes, and how that choice reaches the page.
 *
 * A choice is a style id, or `auto`: follow the system's light / dark setting with 潮汐 by day and 深潜 by night (the
 * main site's pair, and what AwwO always did). It is kept per browser under THEME_STORAGE_KEY; saas.html reads the
 * same key before the first paint (its inline script carries the same ids, tests/saas-themes.test.ts keeps the two in
 * step). The older key `superclaw_theme` ('light' | 'dark') is still written, and read once to carry an earlier
 * choice over.
 */
export type ThemeScheme = 'light' | 'dark';
export type ThemeId = 'tide' | 'cloud' | 'paper' | 'blossom' | 'night' | 'graphite' | 'aurora' | 'ember';
export type ThemeChoice = ThemeId | 'auto';

type Text = { zh: string; en: string };
export type ThemeDefinition = { id: ThemeId; scheme: ThemeScheme; name: Text; description: Text };

export const THEME_STORAGE_KEY = 'awwo.theme.v1';
export const LEGACY_THEME_STORAGE_KEY = 'superclaw_theme';
export const AUTO_THEMES: Record<ThemeScheme, ThemeId> = { light: 'tide', dark: 'night' };

/** Light styles first, then dark; the picker shows them in this order. */
export const AWWO_THEMES: readonly ThemeDefinition[] = [
  { id: 'tide', scheme: 'light', name: { zh: '潮汐', en: 'Tide' },
    description: { zh: '盐白纸面、深海墨色与潮池青，和主站一致', en: 'Salt paper, abyss ink and tide-pool teal, as on the main site' } },
  { id: 'cloud', scheme: 'light', name: { zh: '云白', en: 'Cloud' },
    description: { zh: '不带色偏的中性白灰，靛蓝强调，最清爽', en: 'Neutral white and grey, no tint, an indigo accent' } },
  { id: 'paper', scheme: 'light', name: { zh: '暖纸', en: 'Paper' },
    description: { zh: '米色纸面配咖啡墨色，适合长时间阅读', en: 'Cream paper and espresso ink, for long reading' } },
  { id: 'blossom', scheme: 'light', name: { zh: '樱雾', en: 'Blossom' },
    description: { zh: '淡玫瑰底色配梅子色文字，轻松明快', en: 'A faint rose ground and plum ink, light and lively' } },
  { id: 'night', scheme: 'dark', name: { zh: '深潜', en: 'Night dive' },
    description: { zh: '深海藏青配亮青色，主站的深色风格', en: 'Abyss navy and bright teal, the main site’s dark look' } },
  { id: 'graphite', scheme: 'dark', name: { zh: '石墨', en: 'Graphite' },
    description: { zh: '不偏色的中性深灰，夜间专注不刺眼', en: 'Neutral charcoal with no hue, for focused nights' } },
  { id: 'aurora', scheme: 'dark', name: { zh: '极光', en: 'Aurora' },
    description: { zh: '深紫夜空配霓虹青紫，科技感最强', en: 'A deep violet night with neon violet and cyan' } },
  { id: 'ember', scheme: 'dark', name: { zh: '琥珀夜', en: 'Ember' },
    description: { zh: '温暖棕黑配琥珀色，深色里最柔和', en: 'Warm brown-black and amber, the gentlest dark' } },
];

const BY_ID = new Map(AWWO_THEMES.map(theme => [theme.id, theme]));

export function isThemeId(value: unknown): value is ThemeId { return typeof value === 'string' && BY_ID.has(value as ThemeId); }
export function isThemeChoice(value: unknown): value is ThemeChoice { return value === 'auto' || isThemeId(value); }
export function themeById(id: ThemeId): ThemeDefinition { return BY_ID.get(id)!; }

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** The style a choice shows now: `auto` follows the system. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ThemeDefinition {
  return themeById(choice === 'auto' ? AUTO_THEMES[prefersDark ? 'dark' : 'light'] : choice);
}

/**
 * The saved choice. Before this key existed the app kept only 'light' or 'dark' (and wrote it on every visit, so it
 * may only echo the system setting of the day it was written): a value that matches the system now becomes `auto`,
 * one that differs was a real choice and keeps its look as 潮汐 or 深潜.
 */
export function readThemeChoice(prefersDark = systemPrefersDark()): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeChoice(saved)) return saved;
    const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (legacy === 'light' || legacy === 'dark') return (legacy === 'dark') === prefersDark ? 'auto' : AUTO_THEMES[legacy];
  } catch { /* Browser storage can be unavailable. */ }
  return 'auto';
}

export function writeThemeChoice(choice: ThemeChoice, shown: ThemeDefinition): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, shown.scheme);
  } catch { /* Keep the current page usable. */ }
}

/** Put a style on the page: its values (data-awwo-theme) and its light / dark side (data-theme, color-scheme). */
export function applyTheme(theme: ThemeDefinition, root: HTMLElement = document.documentElement): void {
  root.dataset.awwoTheme = theme.id;
  root.dataset.theme = theme.scheme;
  root.style.colorScheme = theme.scheme;
}
