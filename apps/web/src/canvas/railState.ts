// Side-rail disclosure state (the model shelf on the left, the Bot list on the right).
//
// Each rail has its own default and remembers an explicit choice per browser. This preference
// lives in localStorage and never in the canvas document.
// Storage can be absent, full or blocked (private windows, cleared site data): every access is
// guarded and a failure simply falls back to the default.

import { useEffect, useState } from 'react';

export const RAIL_MODEL_KEY = 'superclaw.canvas.railModel';
export const RAIL_BOT_KEY = 'superclaw.canvas.railBot';

/** Widths above this are a desktop stage; at or below it the rails are mobile drawers instead. */
export const DESKTOP_MIN_WIDTH = 900;

export function isDesktopStage(width = typeof window !== 'undefined' ? window.innerWidth : 0): boolean {
  return width > DESKTOP_MIN_WIDTH;
}

/** Tracks isDesktopStage() across window resizes, so a rail state chosen on a desktop stage never
 * reaches the mobile drawer that replaces the rail below it. */
export function useDesktopStage(): boolean {
  const [desktop, setDesktop] = useState(() => isDesktopStage());
  useEffect(() => {
    const update = () => setDesktop(isDesktopStage());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return desktop;
}

/** The stored collapsed state, or `fallback` when nothing valid is stored (or storage is unusable). */
export function readRailCollapsed(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === '1' ? true : stored === '0' ? false : fallback;
  } catch {
    return fallback;
  }
}

export function writeRailCollapsed(key: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    // The in-memory state is still applied; only the cross-reload memory is lost.
  }
}
