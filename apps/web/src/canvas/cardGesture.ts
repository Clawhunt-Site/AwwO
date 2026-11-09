// The canvas's one gesture at a time (a card's drag or resize, an icon's drag, a wire drawn from a port), with the pointer
// that pressed for it (SessionTile.tsx, NodeIconTile.tsx, TilePorts.tsx). It is the one record of who holds the canvas:
// the canvas surface ends what the others see of a gesture when this lets it go (onCardGesture), however it ends.
//
// - Another pointer's press while one is held is a press (it selects, a tap opens, a port's click arms a wire), never a
//   drag, a resize or a wire drag (two-finger work on cards is phase 2's; the board's own pinch is CanvasViewport's,
//   which never sees a card's press). Its listeners are a passive press's, ended when its pointer presses again.
// - A press of the same pointer, a new first one of its kind (every earlier touch has ended then), a mouse's (never
//   pressed by accident, as a palm is while a pen draws) or a pen's over a finger's replaces the held gesture: the old
//   one ends (its lift never came) before the new one starts.

/** What a press says of its pointer. */
export interface CardPress { pointerId?: number; pointerType?: string; isPrimary?: boolean }

interface Held { pointerId: number | undefined; pointerType: string | undefined; end: () => void }
let held: Held | null = null;
const watchers = new Set<(released: boolean) => void>();
const passive = new Map<number | undefined, () => void>();

/** Whether a press of this pointer replaces a gesture held by `current` (rather than being another pointer's). */
export function pressReplaces(press: CardPress, current: { pointerId: number | undefined; pointerType: string | undefined }): boolean {
  return press.pointerId === current.pointerId
    || (press.isPrimary !== false && (press.pointerType === current.pointerType || press.pointerType === 'mouse'
      || (press.pointerType === 'pen' && current.pointerType === 'touch')));
}

/** Whether this press may start a gesture now; a gesture it replaces is ended first, and so is its own pointer's last
 *  passive press (whose lift never came). */
export function cardPressAllowed(press: CardPress): boolean {
  passive.get(press.pointerId)?.();
  const current = held;
  if (!current) return true;
  if (!pressReplaces(press, current)) return false;
  current.end();
  return true;
}

/** The pointer holding the canvas's gesture now, or null. */
export function cardGestureHeld(): { pointerId: number | undefined; pointerType: string | undefined } | null {
  return held ? { pointerId: held.pointerId, pointerType: held.pointerType } : null;
}

/** Ends the held gesture, if any (a press the canvas takes as replacing it, wherever it lands). */
export function endCardGesture(): void {
  held?.end();
}

/** Holds the canvas's gesture for this press until its `end` runs; returns what lets it go (called from that `end`). */
export function holdCardGesture(press: CardPress, end: () => void): () => void {
  const mine: Held = { pointerId: press.pointerId, pointerType: press.pointerType, end };
  held = mine;
  for (const watch of [...watchers]) watch(false);
  return () => {
    if (held !== mine) return;
    held = null;
    for (const watch of [...watchers]) watch(true);
  };
}

/** Records a passive press's listeners (another pointer's press while a gesture is held) until its `end` runs; returns
 *  what lets it go. Its pointer's next press ends it first (cardPressAllowed, endPassivePress). */
export function holdPassivePress(press: CardPress, end: () => void): () => void {
  passive.get(press.pointerId)?.();
  passive.set(press.pointerId, end);
  return () => { if (passive.get(press.pointerId) === end) passive.delete(press.pointerId); };
}

/** Ends this pointer's passive press, if one is left (its lift never came). */
export function endPassivePress(pointerId: number | undefined): void {
  passive.get(pointerId)?.();
}

/** Calls `watch` whenever a gesture is held (false) or let go (true); returns what stops it. */
export function onCardGesture(watch: (released: boolean) => void): () => void {
  watchers.add(watch);
  return () => { watchers.delete(watch); };
}
