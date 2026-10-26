// Enter clicks a focused button on its first keypress, while the key is still down, and a key held down repeats. A press
// that hands the keyboard's focus on as it closes what holds its button (a file's ✕, a notice's ✕) would let those repeats
// go on to the control the focus went to: remove the next file, type newlines into a field, send a draft. Before the
// hand-off the focus fell to the page's body, where they did nothing.

let releaseHeld: (() => void) | null = null;

/** Keys that change what another key means, pressed or let go while Enter is still held (Shift+Enter, then Shift up). */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock', 'Symbol', 'SymbolLock',
  'CapsLock', 'NumLock', 'ScrollLock']);

/**
 * Called by such a press: when its click came from a key (`detail` 0, as Enter's and Space's clicks are, where a pointer's
 * click counts its presses), the repeats of an Enter held down are refused (no default action, no listener after this
 * one) until Enter comes up, another key is pressed (that press goes through, a fresh Enter too), or the window loses the
 * focus. A modifier pressed or let go meanwhile leaves the guard on (otherwise a Shift+Enter whose Shift is let go first
 * would send).
 */
export function refuseHeldEnter(event: { detail: number }) {
  if (event.detail !== 0) return;
  releaseHeld?.();
  const keydown = (key: KeyboardEvent) => {
    if (key.key === 'Enter' && key.repeat) {
      key.preventDefault();
      key.stopImmediatePropagation();
    } else if (!MODIFIERS.has(key.key)) release();
  };
  const keyup = (key: KeyboardEvent) => { if (key.key === 'Enter') release(); };
  const release = () => {
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('keyup', keyup, true);
    window.removeEventListener('blur', release);
    if (releaseHeld === release) releaseHeld = null;
  };
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('keyup', keyup, true);
  window.addEventListener('blur', release);
  releaseHeld = release;
}
