// When autosave may send a hosted canvas: once the canvas has been quiet for a moment, and not while a pointer is held
// down. A drag or a resize writes the whole document on every frame it draws; on a canvas of a few MB a frame, or a
// pause in the drag, takes longer than a fixed wait, so a save started mid-drag and every later frame queued another
// (five 6 MB saves for one drag of a 142-node canvas). A held pointer therefore holds autosave (for up to
// AUTOSAVE_HOLD_MS after the press), and a document of AUTOSAVE_PACED_SIZE characters or more waits longer and follows
// its writes' own pace: AUTOSAVE_QUIET_MS and AUTOSAVE_MS_PER_MILLION_CHARS more per million characters, or twice the gap
// between its last two writes (writes further apart than AUTOSAVE_BURST_GAP_MS start a new burst), at most
// AUTOSAVE_MAX_QUIET_MS. A smaller canvas keeps the plain wait. Whatever comes after it, an edit waits at most
// AUTOSAVE_MAX_DEFER_MS.

export const AUTOSAVE_QUIET_MS = 450;
export const AUTOSAVE_PACED_SIZE = 1_000_000;
export const AUTOSAVE_MS_PER_MILLION_CHARS = 200;
export const AUTOSAVE_MAX_QUIET_MS = 4000;
export const AUTOSAVE_BURST_GAP_MS = 2000;
export const AUTOSAVE_HOLD_MS = 10_000;
export const AUTOSAVE_MAX_DEFER_MS = 15_000;
/** How often a held pointer is looked at again. */
const HELD_RECHECK_MS = 200;

export type AutosavePace = {
  /** Autosave has a new write to send, of a document this many characters long: how long to wait before sending it. */
  wrote(size?: number): number;
  /** What was written so far went out (a save started). */
  sent(): void;
  /** How long until autosave may send what it has: 0 when it may now. */
  wait(): number;
  dispose(): void;
};

type PointerTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export function autosavePace(target: PointerTarget = window, now: () => number = () => Date.now()): AutosavePace {
  // Pointers are counted on the way down (capture: a tile's drag stops its press from bubbling), so two fingers or a pen
  // and a mouse hold it until the last one lifts. Each press counts the hold anew: a release the window never saw (a
  // native menu took it) leaves its pointer in the set, and the same pointer pressing again must still hold.
  const pressed = new Set<number | undefined>();
  let pressedAt = 0;
  let last = Number.NEGATIVE_INFINITY;
  let quiet = AUTOSAVE_QUIET_MS;
  /** When the oldest write not yet sent was made. */
  let oldest: number | null = null;
  const press = (event: Event) => { pressedAt = now(); pressed.add((event as PointerEvent).pointerId); };
  const lift = (event: Event) => { pressed.delete((event as PointerEvent).pointerId); };
  // A window that loses focus mid-press may never see the pointer lift.
  const lose = () => { pressed.clear(); };
  target.addEventListener('pointerdown', press, true);
  target.addEventListener('pointerup', lift, true);
  target.addEventListener('pointercancel', lift, true);
  target.addEventListener('blur', lose);
  return {
    wrote(size = 0) {
      const at = now();
      const gap = at - last;
      last = at;
      oldest ??= at;
      quiet = size < AUTOSAVE_PACED_SIZE ? AUTOSAVE_QUIET_MS
        : Math.min(AUTOSAVE_MAX_QUIET_MS, Math.max(AUTOSAVE_QUIET_MS + Math.round(size / 1_000_000 * AUTOSAVE_MS_PER_MILLION_CHARS),
          gap < AUTOSAVE_BURST_GAP_MS ? 2 * gap : 0));
      return quiet;
    },
    sent() { oldest = null; },
    wait() {
      const at = now();
      if (oldest !== null && at - oldest >= AUTOSAVE_MAX_DEFER_MS) return 0;
      const settling = Math.max(0, last + quiet - at);
      const heldFor = at - pressedAt;
      const held = pressed.size && heldFor < AUTOSAVE_HOLD_MS ? Math.min(HELD_RECHECK_MS, AUTOSAVE_HOLD_MS - heldFor) : 0;
      const waited = Math.max(settling, held);
      return oldest === null ? waited : Math.min(waited, AUTOSAVE_MAX_DEFER_MS - (at - oldest));
    },
    dispose() {
      target.removeEventListener('pointerdown', press, true);
      target.removeEventListener('pointerup', lift, true);
      target.removeEventListener('pointercancel', lift, true);
      target.removeEventListener('blur', lose);
    },
  };
}
