// What a page runs in, for the people bar (docs/awwo-canvas-live-collaboration.md, Presence): shown to the others on the
// canvas, never trusted. AwwO Cloud for Windows is WebView2, which gives every page window.chrome.webview; the Mac app's
// web view is WebKit with no Safari of its own in its user agent (its local workspace also registers a script handler,
// its online one none). Phones and tablets by their user agent; iPadOS says it is a Mac, with touch.
import type { LiveDevice } from './types';

interface DeviceEnvironment {
  navigator?: { userAgent?: string; maxTouchPoints?: number };
  chrome?: { webview?: unknown };
  webkit?: { messageHandlers?: unknown };
}

export function detectDevice(env: DeviceEnvironment | undefined = typeof window !== 'undefined' ? window as unknown as DeviceEnvironment : undefined): LiveDevice {
  if (!env) return 'browser';
  const agent = env.navigator?.userAgent ?? '';
  const touch = (env.navigator?.maxTouchPoints ?? 0) > 1;
  if (/\b(iPhone|iPod)\b/.test(agent) || (/\bAndroid\b/.test(agent) && /\bMobile\b/.test(agent))) return 'phone';
  if (/\biPad\b/.test(agent) || /\bAndroid\b/.test(agent) || (/\bMacintosh\b/.test(agent) && touch)) return 'tablet';
  if (env.chrome?.webview) return 'windows';
  const embeddedWebKit = /AppleWebKit\//.test(agent) && !/\b(Safari|Chrome|Chromium|CriOS|Firefox|FxiOS|Edg|OPR)\//.test(agent);
  if (/\bMacintosh\b/.test(agent) && (env.webkit?.messageHandlers || embeddedWebKit)) return 'mac';
  return 'browser';
}
