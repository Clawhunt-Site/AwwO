import { useCallback } from "react";

import { useTranslation } from ".";

export type LocalizedText = {
  en: string;
  zh: string;
};

export function isChineseLocale(language: string | undefined): boolean {
  return language?.toLowerCase().startsWith("zh") ?? false;
}

export function localizedText(copy: LocalizedText, language: string | undefined): string {
  return isChineseLocale(language) ? copy.zh : copy.en;
}

export function useLocalizedText(): (copy: LocalizedText) => string {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  return useCallback((copy: LocalizedText) => localizedText(copy, language), [language]);
}

export function localizedRelativeTime(date: Date | string, language: string | undefined): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);
  const zh = isChineseLocale(language);

  if (seconds < 60) return zh ? "刚刚" : "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return zh ? `${minutes}分钟前` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours}小时前` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return zh ? `${days}天前` : `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return zh ? `${weeks}周前` : `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return zh ? `${months}个月前` : `${months}mo ago`;
}

export function useLocalizedRelativeTime(): (date: Date | string) => string {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  return useCallback((date: Date | string) => localizedRelativeTime(date, language), [language]);
}

export function localizedDurationWords(ms: number | null, language: string | undefined): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const zh = isChineseLocale(language);
  if (totalSeconds < 60) {
    return zh
      ? `${totalSeconds}秒`
      : `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return zh
      ? `${totalMinutes}分钟`
      : `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return zh ? `${hours}小时` : `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return zh
    ? `${hours}小时 ${minutes}分钟`
    : `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function useLocalizedDurationWords(): (ms: number | null) => string | null {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  return useCallback((ms: number | null) => localizedDurationWords(ms, language), [language]);
}
