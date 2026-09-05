import React, { useEffect } from 'react';
import type { Preview, ReactRenderer } from '@storybook/react-vite';
import type { DecoratorFunction } from 'storybook/internal/types';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../src/i18n';
import '../src/index.css';

// ---------------------------------------------------------------------------
// Mock window.Telegram so hooks that read it (useTelegram, useHaptic, etc.)
// don't crash outside a real Telegram WebApp environment.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && !(window as any).Telegram) {
  (window as any).Telegram = {
    WebApp: {
      initData: '',
      initDataUnsafe: {},
      expand: () => {},
      close: () => {},
      ready: () => {},
      setHeaderColor: () => {},
      setBackgroundColor: () => {},
      BackButton: {
        show: () => {},
        hide: () => {},
        onClick: (_cb: () => void) => {},
        offClick: (_cb: () => void) => {},
      },
      HapticFeedback: {
        impactOccurred: (_style: string) => {},
        notificationOccurred: (_type: string) => {},
        selectionChanged: () => {},
      },
      openInvoice: (_url: string, _cb?: (status: string) => void) => {},
      openTelegramLink: (_url: string) => {},
      openLink: (_url: string) => {},
      MainButton: {
        show: () => {},
        hide: () => {},
        setText: (_text: string) => {},
        onClick: (_cb: () => void) => {},
        offClick: (_cb: () => void) => {},
      },
      themeParams: {},
      colorScheme: 'dark' as const,
      viewportHeight: 812,
      viewportStableHeight: 812,
      isExpanded: true,
      platform: 'unknown',
    },
  };
}

// ---------------------------------------------------------------------------
// Real providers — they call APIs that will fail (no Telegram initData),
// but they catch errors silently so the app boots with null/default state.
// This is good enough for component-level stories. Page-level stories that
// need realistic data should use MSW handlers to intercept API calls.
// ---------------------------------------------------------------------------
import { EnergyProvider } from '../src/contexts/EnergyContext';
import { ToastProvider } from '../src/contexts/ToastContext';
import { InviteProvider } from '../src/contexts/InviteContext';

// ---------------------------------------------------------------------------
// Router parameter support
// ---------------------------------------------------------------------------
// Stories can opt-in to a specific route + path pattern via parameters.router:
//   parameters: { router: { path: '/library/img-123', pattern: '/library/:id' } }
// If `pattern` is omitted, the story renders directly at `path`.
// If neither is provided, defaults to '/'.
// ---------------------------------------------------------------------------
interface StoryRouterParams {
  path?: string;
  pattern?: string;
}

// ---------------------------------------------------------------------------
// iPhone viewports — matches the Telegram WebApp target device matrix
// (W x H in logical CSS pixels, the value Safari / Telegram's in-app webview
// reports for window.innerWidth / innerHeight under normal orientation).
// ---------------------------------------------------------------------------
const iphoneViewports = {
  iphoneSE: {
    name: 'iPhone SE (3rd gen)',
    styles: { width: '375px', height: '667px' },
    type: 'mobile' as const,
  },
  iphone13Mini: {
    name: 'iPhone 13 mini',
    styles: { width: '375px', height: '812px' },
    type: 'mobile' as const,
  },
  iphone14: {
    name: 'iPhone 14 / 13 / 12',
    styles: { width: '390px', height: '844px' },
    type: 'mobile' as const,
  },
  iphone14Plus: {
    name: 'iPhone 14 Plus / 13 Pro Max',
    styles: { width: '428px', height: '926px' },
    type: 'mobile' as const,
  },
  iphone15: {
    name: 'iPhone 15 / 14 Pro',
    styles: { width: '393px', height: '852px' },
    type: 'mobile' as const,
  },
  iphone15ProMax: {
    name: 'iPhone 15 Pro Max / 14 Pro Max',
    styles: { width: '430px', height: '932px' },
    type: 'mobile' as const,
  },
  iphone16: {
    name: 'iPhone 16 / 16 Pro',
    styles: { width: '402px', height: '874px' },
    type: 'mobile' as const,
  },
  iphone16ProMax: {
    name: 'iPhone 16 Pro Max',
    styles: { width: '440px', height: '956px' },
    type: 'mobile' as const,
  },
};

// ---------------------------------------------------------------------------
// Locale switcher decorator — respects the toolbar globe button
// ---------------------------------------------------------------------------
const I18nDecorator: DecoratorFunction<ReactRenderer> = (Story, context) => {
  const locale = (context.globals as Record<string, unknown>).locale as string || 'en';
  useEffect(() => {
    i18n.changeLanguage(locale);
  }, [locale]);
  return (
    <I18nextProvider i18n={i18n}>
      <Story />
    </I18nextProvider>
  );
};

// ---------------------------------------------------------------------------
// Router decorator — single source of truth for react-router-dom.
// Stories configure initial route via parameters.router; no story should
// wrap its own <MemoryRouter> or Routing errors like
// "You cannot render a <Router> inside another <Router>" will occur.
// ---------------------------------------------------------------------------
const RouterDecorator: DecoratorFunction<ReactRenderer> = (Story, context) => {
  const router = ((context.parameters as Record<string, unknown>).router ?? {}) as StoryRouterParams;
  const path = router.path ?? '/';
  const pattern = router.pattern;
  return (
    <MemoryRouter initialEntries={[path]}>
      {pattern ? (
        <Routes>
          <Route path={pattern} element={<Story />} />
        </Routes>
      ) : (
        <Story />
      )}
    </MemoryRouter>
  );
};

// ---------------------------------------------------------------------------
// Preview configuration
// ---------------------------------------------------------------------------
const preview: Preview = {
  globalTypes: {
    locale: {
      name: 'Locale',
      description: 'i18n locale',
      toolbar: {
        icon: 'globe',
        items: [
          { value: 'en', title: 'English' },
          { value: 'zh', title: '中文' },
          { value: 'ja', title: '日本語' },
          { value: 'ko', title: '한국어' },
          { value: 'ar', title: 'العربية' },
          { value: 'de', title: 'Deutsch' },
          { value: 'es', title: 'Español' },
          { value: 'fr', title: 'Français' },
          { value: 'it', title: 'Italiano' },
          { value: 'nl', title: 'Nederlands' },
          { value: 'pt', title: 'Português' },
          { value: 'ru', title: 'Русский' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    locale: 'en',
  },
  decorators: [
    // Outermost → innermost: Router > Energy > Toast > Invite > i18n > Story
    RouterDecorator,
    (Story) => (
      <EnergyProvider>
        <ToastProvider>
          <InviteProvider>
            <Story />
          </InviteProvider>
        </ToastProvider>
      </EnergyProvider>
    ),
    I18nDecorator,
  ],
  parameters: {
    backgrounds: {
      default: 'dark',
      values: [
        { name: 'dark', value: '#0e0e0f' },
        { name: 'surface', value: '#1d1c1f' },
      ],
    },
    viewport: {
      viewports: iphoneViewports,
      defaultViewport: 'iphone14',
    },
    layout: 'fullscreen',
  },
};

export default preview;
