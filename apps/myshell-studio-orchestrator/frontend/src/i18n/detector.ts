const SUPPORTED = ['en', 'zh', 'ja', 'ko', 'ar', 'de', 'es', 'fr', 'it', 'nl', 'pt', 'ru'] as const;

export type SupportedLang = (typeof SUPPORTED)[number];

export function detectLanguage(): SupportedLang {
  // 1. User preference saved from Settings
  const saved = localStorage.getItem('dreamy_lang');
  if (saved && (SUPPORTED as readonly string[]).includes(saved)) return saved as SupportedLang;

  // 2. Telegram initDataUnsafe.user.language_code (server language handled async in EnergyContext)
  const tgLang = (window as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { language_code?: string } } } } })
    .Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
  if (tgLang) {
    const base = tgLang.split('-')[0].toLowerCase();
    if ((SUPPORTED as readonly string[]).includes(base)) return base as SupportedLang;
    if (base === 'zh') return 'zh';
  }

  // 3. Browser language
  const navLang = (navigator.language || 'en').split('-')[0].toLowerCase();
  if ((SUPPORTED as readonly string[]).includes(navLang)) return navLang as SupportedLang;

  return 'en';
}
