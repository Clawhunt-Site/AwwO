// Maps super's coarse UI language preference (its `Locale` = 'en'|'zh', the single
// source) to the embedded board's i18next locale id, and drives the board's i18next
// instance off it. Host-side helper (neutral naming per the de-naming convention —
// no upstream brand in new identifiers).
export type SuperClawLocale = 'en' | 'zh';
export type BoardLocale = 'en' | 'zh-CN';

export type BoardI18nLike = {
  language?: string;
  resolvedLanguage?: string;
  changeLanguage: (locale: BoardLocale) => Promise<unknown>;
};

export function boardLocaleForSuperClawLocale(locale: SuperClawLocale): BoardLocale {
  return locale === 'zh' ? 'zh-CN' : 'en';
}

export function syncBoardLocale(
  i18n: BoardI18nLike,
  locale: SuperClawLocale,
  onError: (error: unknown) => void = (error) => {
    console.error('Failed to sync embedded board locale', error);
  },
): void {
  const boardLocale = boardLocaleForSuperClawLocale(locale);
  if (i18n.language === boardLocale || i18n.resolvedLanguage === boardLocale) return;
  void i18n.changeLanguage(boardLocale).catch(onError);
}
