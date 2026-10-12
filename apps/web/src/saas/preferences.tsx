import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Code2, Languages, MessageSquare } from 'lucide-react';
import { LOCALE_STORAGE_KEY, localeHtmlLang, readInitialLocale, type UiLocale } from '../locale';
import { LocaleProvider } from '../canvas/i18n';
import { CanvasUiModeProvider, isUiMode, readUiMode, UI_MODE_STORAGE_KEY, writeUiMode, type CanvasUiMode } from '../canvas/uiMode';
import { applyTheme, isThemeChoice, readThemeChoice, resolveTheme, systemPrefersDark, THEME_STORAGE_KEY, writeThemeChoice, type ThemeChoice, type ThemeDefinition, type ThemeScheme } from './themes';
import { ThemePicker } from './ThemePicker';

type Preferences = {
  locale: UiLocale; setLocale: (locale: UiLocale) => void;
  /** The appearance style the reader chose (外观风格), or `auto` to follow the system. */
  themeChoice: ThemeChoice; setThemeChoice: (choice: ThemeChoice) => void;
  /** The style on screen now. */
  theme: ThemeDefinition;
  /** Its light or dark side, for code that only needs that (the account colour scheme picks its canvas by it). */
  themePreference: ThemeScheme;
  /** 普通用户模式 (simple) or 开发者模式 (developer); presentation only. */
  uiMode: CanvasUiMode; setUiMode: (mode: CanvasUiMode) => void;
  t: (zh: string, en: string) => string;
};
const Context = createContext<Preferences | null>(null);
export function SaaSPreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(readInitialLocale);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readThemeChoice());
  const [uiMode, setUiMode] = useState<CanvasUiMode>(() => readUiMode());
  const theme = resolveTheme(themeChoice, prefersDark);
  useEffect(() => {
    document.documentElement.lang = localeHtmlLang(locale);
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Keep the current page usable. */ }
  }, [locale]);
  useEffect(() => {
    applyTheme(theme);
    writeThemeChoice(themeChoice, theme);
  }, [themeChoice, theme]);
  useEffect(() => {
    // `auto` follows the system while the page is open, not only when it loads.
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setPrefersDark(query.matches);
    query.addEventListener?.('change', change);
    return () => query.removeEventListener?.('change', change);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.uiMode = uiMode;
    writeUiMode(uiMode);
  }, [uiMode]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY && (event.newValue === 'zh' || event.newValue === 'en')) setLocale(event.newValue);
      if (event.key === THEME_STORAGE_KEY && isThemeChoice(event.newValue)) setThemeChoice(event.newValue);
      if (event.key === UI_MODE_STORAGE_KEY && isUiMode(event.newValue)) setUiMode(event.newValue);
    };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync);
  }, []);
  const value = useMemo<Preferences>(() => ({ locale, setLocale, themeChoice, setThemeChoice, theme, themePreference: theme.scheme, uiMode, setUiMode,
    t: (zh, en) => locale === 'zh' ? zh : en }), [locale, themeChoice, theme, uiMode]);
  return <Context.Provider value={value}><LocaleProvider locale={locale}><CanvasUiModeProvider mode={uiMode}>{children}</CanvasUiModeProvider></LocaleProvider></Context.Provider>;
}
export function useSaaSPreferences(): Preferences {
  const value = useContext(Context);
  if (!value) throw new Error('SaaSPreferencesProvider is required');
  return value;
}
export function LanguageSwitch({ variant = 'button' }: { variant?: 'button' | 'menu' } = {}) {
  const { locale, setLocale, t } = useSaaSPreferences();
  const label = t('切换为英文', 'Switch to Chinese');
  const toggle = () => setLocale(locale === 'zh' ? 'en' : 'zh');
  if (variant === 'menu') return <button type="button" className="saas-language-row" aria-label={label} onClick={toggle}><Languages size={16} aria-hidden="true" />{locale === 'zh' ? 'English' : '中文'}</button>;
  return <button type="button" aria-label={label} onClick={toggle}>{locale === 'zh' ? 'EN' : '中'}</button>;
}
/** The language switch and the appearance-style button, for pages whose header has no account controls. */
export function PreferenceControls({ appearance = true }: { appearance?: boolean } = {}) {
  return <div className="saas-preferences"><LanguageSwitch />{appearance && <ThemePicker />}</div>;
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
