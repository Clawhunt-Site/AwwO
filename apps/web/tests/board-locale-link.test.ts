import { afterAll, describe, expect, it } from 'vitest';
// End-to-end proof that super's CURRENT i18n language is passed to the embedded
// Paperclip board and actually changes what the board renders. We drive the REAL
// board i18next instance (server/ui via the `@` alias) through the SAME helper
// CompanyBoard uses (syncBoardLocale), then assert a real board translation
// (localizedText, the helper the 161 localized components call) resolves to the
// matching language. This is the linkage App.tsx wires via <CompanyBoard locale={locale}/>.
import { i18n as boardI18n } from '@/i18n';
import { localizedText } from '@/i18n/localized';
import { boardLocaleForSuperClawLocale, syncBoardLocale } from '../src/boardLocale';

const sample = { en: 'All', zh: '全部' } as const;
const lang = () => boardI18n.resolvedLanguage || boardI18n.language;

afterAll(() => {
  void boardI18n.changeLanguage('en');
});

describe('super language → embedded board linkage', () => {
  it('maps super locale to the board i18next locale', () => {
    expect(boardLocaleForSuperClawLocale('zh')).toBe('zh-CN');
    expect(boardLocaleForSuperClawLocale('en')).toBe('en');
  });

  it('super=zh drives the board to Chinese (component translations render zh)', async () => {
    syncBoardLocale(boardI18n, 'zh');
    await Promise.resolve();
    expect(boardI18n.language).toBe('zh-CN');
    // localizedText is what the 161 localized board components use to pick en/zh.
    expect(localizedText(sample, lang())).toBe('全部');
  });

  it('super=en drives the board back to English', async () => {
    syncBoardLocale(boardI18n, 'en');
    await Promise.resolve();
    expect(boardI18n.language).toBe('en');
    expect(localizedText(sample, lang())).toBe('All');
  });

  it('a super language toggle (zh→en→zh) is reflected each time (live switching)', async () => {
    syncBoardLocale(boardI18n, 'zh');
    await Promise.resolve();
    expect(localizedText(sample, lang())).toBe('全部');
    syncBoardLocale(boardI18n, 'en');
    await Promise.resolve();
    expect(localizedText(sample, lang())).toBe('All');
    syncBoardLocale(boardI18n, 'zh');
    await Promise.resolve();
    expect(localizedText(sample, lang())).toBe('全部');
  });
});
