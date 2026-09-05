// Startup tracing (P0 diagnostics) — typed accessor for the marker mechanism
// defined inline in index.html (`window.__superclawMark`). React modules call
// `recordStartupMark(label)` at key startup phases (bundle evaluated, render
// called, runtime invoke sent, runtime connected); the inline script forwards
// them — with the current wall-clock — to the desktop shell so every phase lands
// on one timeline in desktop-shell.log.
//
// This is pure instrumentation: it must never throw and must be a no-op when the
// marker mechanism is absent (browser mode, tests, or before the inline script
// ran). It deliberately does not import anything desktop-specific so it stays
// safe to call from any module.

type StartupMarkFn = (label: string, epochMs?: number) => void;

declare global {
  interface Window {
    __superclawMark?: StartupMarkFn;
  }
}

export function recordStartupMark(label: string): void {
  try {
    if (typeof window === 'undefined') return;
    const mark = window.__superclawMark;
    if (typeof mark === 'function') mark(label);
  } catch {
    // Diagnostics must never affect startup.
  }
}
