import { detectDesktopInvoke } from './desktop';

const UI_ZOOM_STORAGE_KEY = 'superclaw.uiZoom';
const DEFAULT_UI_ZOOM = 1;

export const UI_ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

let currentUiZoom = DEFAULT_UI_ZOOM;

function clampUiZoom(level: number): number {
  const min = UI_ZOOM_LEVELS[0];
  const max = UI_ZOOM_LEVELS[UI_ZOOM_LEVELS.length - 1];
  return Math.min(max, Math.max(min, level));
}

function nearestUiZoomIndex(level: number): number {
  let nearest = 0;
  for (let index = 1; index < UI_ZOOM_LEVELS.length; index += 1) {
    if (Math.abs(UI_ZOOM_LEVELS[index] - level) < Math.abs(UI_ZOOM_LEVELS[nearest] - level)) {
      nearest = index;
    }
  }
  return nearest;
}

export function getUiZoom(): number {
  return currentUiZoom;
}

export function applyUiZoom(level: number): number {
  const clamped = clampUiZoom(Number.isFinite(level) ? level : DEFAULT_UI_ZOOM);
  currentUiZoom = clamped;
  const desktopInvoke = detectDesktopInvoke();
  if (desktopInvoke) {
    // Tauri/WKWebView：CSS zoom 不会补偿布局视口（内容会缩成一角），
    // 必须走原生 pageZoom，其行为与浏览器整页缩放一致。
    void Promise.resolve(desktopInvoke('desktop_set_webview_zoom', { request: { factor: clamped } })).catch(
      () => {},
    );
  } else {
    const rootStyle = document.documentElement.style;
    if (clamped === DEFAULT_UI_ZOOM) {
      rootStyle.removeProperty('zoom');
    } else {
      rootStyle.setProperty('zoom', String(clamped));
    }
  }
  try {
    if (clamped === DEFAULT_UI_ZOOM) {
      window.localStorage.removeItem(UI_ZOOM_STORAGE_KEY);
    } else {
      window.localStorage.setItem(UI_ZOOM_STORAGE_KEY, String(clamped));
    }
  } catch {
    // localStorage 不可用（隐私模式等）时仅保留本次会话的缩放。
  }
  return clamped;
}

export function stepUiZoom(direction: 1 | -1): number {
  const nextIndex = nearestUiZoomIndex(currentUiZoom) + direction;
  const boundedIndex = Math.min(UI_ZOOM_LEVELS.length - 1, Math.max(0, nextIndex));
  return applyUiZoom(UI_ZOOM_LEVELS[boundedIndex]);
}

export function resetUiZoom(): number {
  return applyUiZoom(DEFAULT_UI_ZOOM);
}

function readStoredUiZoom(): number | null {
  try {
    const raw = window.localStorage.getItem(UI_ZOOM_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clampUiZoom(parsed) : null;
  } catch {
    return null;
  }
}

export function handleUiZoomKeydown(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) {
    return false;
  }
  if (event.key === '=' || event.key === '+' || event.code === 'NumpadAdd') {
    stepUiZoom(1);
  } else if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') {
    stepUiZoom(-1);
  } else if (event.key === '0' || event.code === 'Numpad0') {
    resetUiZoom();
  } else {
    return false;
  }
  event.preventDefault();
  return true;
}

export function initUiZoom(): () => void {
  const stored = readStoredUiZoom();
  if (stored !== null) {
    applyUiZoom(stored);
  }
  const listener = (event: KeyboardEvent) => {
    handleUiZoomKeydown(event);
  };
  window.addEventListener('keydown', listener);
  return () => {
    window.removeEventListener('keydown', listener);
  };
}
