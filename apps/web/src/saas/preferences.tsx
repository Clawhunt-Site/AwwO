import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LOCALE_STORAGE_KEY, localeHtmlLang, readInitialLocale, type UiLocale } from '../locale';
import { LocaleProvider } from '../canvas/i18n';
import { applyCachedScheme } from '../appearance';

export const SAAS_THEME_STORAGE_KEY = 'superclaw_theme';
type ThemePreference = 'light' | 'dark';
function readTheme(): ThemePreference {
  try { const value = localStorage.getItem(SAAS_THEME_STORAGE_KEY); if (value === 'light' || value === 'dark') return value; } catch { /* Browser storage can be unavailable. */ }
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
type Preferences = { locale: UiLocale; setLocale: (locale: UiLocale) => void; themePreference: ThemePreference; setThemePreference: (theme: ThemePreference) => void; t: (zh: string, en: string) => string };
const Context = createContext<Preferences | null>(null);
export function SaaSPreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(readInitialLocale);
  const [themePreference, setThemePreference] = useState(readTheme);
  useEffect(() => {
    document.documentElement.lang = localeHtmlLang(locale);
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Keep the current page usable. */ }
  }, [locale]);
  useEffect(() => {
    document.documentElement.dataset.theme = themePreference;
    document.documentElement.style.colorScheme = themePreference;
    applyCachedScheme(themePreference);
    try { localStorage.setItem(SAAS_THEME_STORAGE_KEY, themePreference); } catch { /* Keep the current page usable. */ }
  }, [themePreference]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY && (event.newValue === 'zh' || event.newValue === 'en')) setLocale(event.newValue);
      if (event.key === SAAS_THEME_STORAGE_KEY && (event.newValue === 'light' || event.newValue === 'dark')) setThemePreference(event.newValue);
    };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync);
  }, []);
  const value = useMemo<Preferences>(() => ({ locale, setLocale, themePreference, setThemePreference, t: (zh, en) => locale === 'zh' ? zh : en }), [locale, themePreference]);
  return <Context.Provider value={value}><LocaleProvider locale={locale}>{children}</LocaleProvider></Context.Provider>;
}
export function useSaaSPreferences(): Preferences {
  const value = useContext(Context);
  if (!value) throw new Error('SaaSPreferencesProvider is required');
  return value;
}
export function PreferenceControls() {
  const { locale, setLocale, themePreference, setThemePreference, t } = useSaaSPreferences();
  return <div className="saas-preferences">
    <button type="button" aria-label={t('切换为英文', 'Switch to Chinese')} onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}>{locale === 'zh' ? 'EN' : '中'}</button>
    <button type="button" aria-label={t(themePreference === 'dark' ? '切换浅色主题' : '切换深色主题', themePreference === 'dark' ? 'Use light theme' : 'Use dark theme')} onClick={() => setThemePreference(themePreference === 'dark' ? 'light' : 'dark')}>{t(themePreference === 'dark' ? '浅色' : '深色', themePreference === 'dark' ? 'Light' : 'Dark')}</button>
  </div>;
}
