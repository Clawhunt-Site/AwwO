import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LocaleProvider,
  canvasText,
  localeHtmlLang,
  readInitialLocale,
  useCanvasI18n,
} from '../src/i18n';

beforeEach(() => localStorage.clear());

describe('AwwO locale foundation', () => {
  it('uses the persisted preference before the host language', () => {
    localStorage.setItem('superclaw_locale', 'en');
    expect(readInitialLocale(localStorage, 'zh-CN')).toBe('en');
    localStorage.setItem('superclaw_locale', 'unsupported');
    expect(readInitialLocale(localStorage, 'zh-TW')).toBe('zh');
    expect(readInitialLocale(localStorage, 'fr-FR')).toBe('en');
  });

  it('maps UI locales to valid document language tags', () => {
    expect(localeHtmlLang('zh')).toBe('zh-CN');
    expect(localeHtmlLang('en')).toBe('en');
  });

  it('provides typed translated canvas text with interpolation', () => {
    expect(canvasText('en', 'workspace.connectionCount', { count: 3 })).toBe('3 connections');
    expect(canvasText('zh', 'workspace.connectionCount', { count: 3 })).toBe('3 条连接');
    const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider locale="en">{children}</LocaleProvider>;
    const { result } = renderHook(() => useCanvasI18n(), { wrapper });
    expect(result.current.locale).toBe('en');
    expect(result.current.t('common.cancel')).toBe('Cancel');
  });
});
