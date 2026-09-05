import { useEffect, useCallback } from 'react';


interface TelegramWebApp {
  initData: string;
  initDataUnsafe: Record<string, unknown>;
  expand: () => void;
  close: () => void;
  ready: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  BackButton: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  HapticFeedback: {
    impactOccurred: (style: string) => void;
    notificationOccurred: (type: string) => void;
    selectionChanged: () => void;
  };
  openInvoice: (url: string, cb?: (status: string) => void) => void;
  openTelegramLink: (url: string) => void;
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
  MainButton: {
    show: () => void;
    hide: () => void;
  };
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

function getTg(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function useTelegramBackButton(onBack: (() => void) | null) {
  useEffect(() => {
    const tg = getTg();
    if (!tg) return;

    if (onBack) {
      tg.BackButton.show();
      tg.BackButton.onClick(onBack);
      return () => {
        tg.BackButton.offClick(onBack);
        tg.BackButton.hide();
      };
    } else {
      tg.BackButton.hide();
    }
  }, [onBack]);
}

export function useHaptic() {
  return useCallback((type: 'light' | 'medium' | 'heavy' | 'selection' = 'light') => {
    const tg = getTg();
    if (!tg) return;
    if (type === 'selection') {
      tg.HapticFeedback.selectionChanged();
    } else {
      tg.HapticFeedback.impactOccurred(type);
    }
  }, []);
}

export function openExternalLink(url: string) {
  const tg = getTg();
  if (tg?.openLink) {
    tg.openLink(url);
  } else {
    window.open(url, '_blank');
  }
}

export { getTg };
