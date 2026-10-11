import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Code2, MessageSquare } from 'lucide-react';
import { LOCALE_STORAGE_KEY, localeHtmlLang, readInitialLocale, type UiLocale } from '../locale';
import { LocaleProvider } from '../canvas/i18n';
import { CanvasUiModeProvider, isUiMode, readUiMode, UI_MODE_STORAGE_KEY, writeUiMode, type CanvasUiMode } from '../canvas/uiMode';

export const SAAS_THEME_STORAGE_KEY = 'superclaw_theme';
type ThemePreference = 'light' | 'dark';
function readTheme(): ThemePreference {
  try { const value = localStorage.getItem(SAAS_THEME_STORAGE_KEY); if (value === 'light' || value === 'dark') return value; } catch { /* Browser storage can be unavailable. */ }
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
type Preferences = {
  locale: UiLocale; setLocale: (locale: UiLocale) => void;
  themePreference: ThemePreference; setThemePreference: (theme: ThemePreference) => void;
  /** 普通用户模式 (simple) or 开发者模式 (developer); presentation only. */
  uiMode: CanvasUiMode; setUiMode: (mode: CanvasUiMode) => void;
  t: (zh: string, en: string) => string;
};
const Context = createContext<Preferences | null>(null);
export function SaaSPreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(readInitialLocale);
  const [themePreference, setThemePreference] = useState(readTheme);
  const [uiMode, setUiMode] = useState<CanvasUiMode>(() => readUiMode());
  useEffect(() => {
    document.documentElement.lang = localeHtmlLang(locale);
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Keep the current page usable. */ }
  }, [locale]);
  useEffect(() => {
    document.documentElement.dataset.theme = themePreference;
    document.documentElement.style.colorScheme = themePreference;
    try { localStorage.setItem(SAAS_THEME_STORAGE_KEY, themePreference); } catch { /* Keep the current page usable. */ }
  }, [themePreference]);
  useEffect(() => {
    document.documentElement.dataset.uiMode = uiMode;
    writeUiMode(uiMode);
  }, [uiMode]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY && (event.newValue === 'zh' || event.newValue === 'en')) setLocale(event.newValue);
      if (event.key === SAAS_THEME_STORAGE_KEY && (event.newValue === 'light' || event.newValue === 'dark')) setThemePreference(event.newValue);
      if (event.key === UI_MODE_STORAGE_KEY && isUiMode(event.newValue)) setUiMode(event.newValue);
    };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync);
  }, []);
  const value = useMemo<Preferences>(() => ({ locale, setLocale, themePreference, setThemePreference, uiMode, setUiMode,
    t: (zh, en) => locale === 'zh' ? zh : en }), [locale, themePreference, uiMode]);
  return <Context.Provider value={value}><LocaleProvider locale={locale}><CanvasUiModeProvider mode={uiMode}>{children}</CanvasUiModeProvider></LocaleProvider></Context.Provider>;
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

/**
 * The two ways to use AwwO. `menu` is the row in the More menu; `pill` is the compact switch in a canvas header.
 * Switching never reloads or edits anything: the same canvas simply shows more or fewer controls.
 */
export function UiModeSwitch({ variant = 'menu', onSwitched }: { variant?: 'menu' | 'pill'; onSwitched?: () => void }) {
  const { uiMode, setUiMode, t } = useSaaSPreferences();
  const developer = uiMode === 'developer';
  const choose = (mode: CanvasUiMode) => { if (mode !== uiMode) setUiMode(mode); onSwitched?.(); };
  if (variant === 'pill') {
    return <button type="button" className={`saas-mode-pill is-${uiMode}`} aria-pressed={developer}
      title={developer ? t('切换到普通用户模式：只保留对话、组件聊天与选模型', 'Switch to simple mode: just the chats and model choice')
        : t('切换到开发者模式：显示连线、配置、模型栏与运行记录等全部控制', 'Switch to developer mode: wiring, configuration, model rail, run records and every other control')}
      onClick={() => choose(developer ? 'simple' : 'developer')}>
      {developer ? <Code2 size={14} aria-hidden="true" /> : <MessageSquare size={14} aria-hidden="true" />}
      <span>{developer ? t('开发者模式', 'Developer') : t('普通模式', 'Simple')}</span>
    </button>;
  }
  return <div className="saas-mode-switch" role="group" aria-label={t('使用模式', 'Mode')}>
    <span className="saas-mode-switch-label">{t('使用模式', 'Mode')}</span>
    <div className="saas-mode-switch-options">
      <button type="button" aria-pressed={!developer} onClick={() => choose('simple')}><MessageSquare size={14} aria-hidden="true" />{t('普通用户', 'Simple')}</button>
      <button type="button" aria-pressed={developer} onClick={() => choose('developer')}><Code2 size={14} aria-hidden="true" />{t('开发者', 'Developer')}</button>
    </div>
  </div>;
}
