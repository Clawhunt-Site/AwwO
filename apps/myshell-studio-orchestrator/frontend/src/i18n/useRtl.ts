import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const RTL_LANGS = new Set(['ar']);

export function useRtl() {
  const { i18n } = useTranslation();

  useEffect(() => {
    const dir = RTL_LANGS.has(i18n.language) ? 'rtl' : 'ltr';
    document.documentElement.dir = dir;
  }, [i18n.language]);
}
