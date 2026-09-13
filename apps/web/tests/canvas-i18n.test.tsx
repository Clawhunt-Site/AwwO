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
    expect(canvasText('en', 'workspace.agentCount', { count: 1 })).toBe('Agent nodes: 1');
    expect(canvasText('zh', 'workspace.agentCount', { count: 1 })).toBe('Agent 节点：1');
    expect(canvasText('en', 'workspace.connectedCount', { count: 1 })).toBe('Connected Agent nodes: 1');
    expect(canvasText('zh', 'workspace.connectedCount', { count: 1 })).toBe('已连接 Agent 节点：1');
    const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider locale="en">{children}</LocaleProvider>;
    const { result } = renderHook(() => useCanvasI18n(), { wrapper });
    expect(result.current.locale).toBe('en');
    expect(result.current.t('common.cancel')).toBe('Cancel');
  });

  it.each(['zh', 'en'] as const)('names required output formats explicitly in %s', locale => {
    expect(canvasText(locale, 'contract.html')).toBe('HTML (.html)');
    expect(canvasText(locale, 'contract.markdown')).toBe('Markdown (.md)');
  });
});
