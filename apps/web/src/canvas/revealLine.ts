// Brings a line of a delivered page's source into view where the reader is (ArtifactPreview's jump to a noted line).
//
// The source pane scrolls first, to put the line a third of the way down it. The pane can be taller than the box that
// holds it: in a node's drawer it is 62vh inside the drawer's own scroll box (.awwo-deliverables), so a line the pane
// scrolled to could still sit below or above what the drawer shows. So every box that scrolls around the pane, nearest
// first, then brings the line's own box inside what it shows, again a third of the way down. A box that fades its last
// pixels while more lies below (the drawer's registered --awwo-scroll-fade) counts the fade as not shown, and what it
// shows is cut by the window and by every box around it that clips without scrolling here (the canvas stage and root):
// with the canvas zoomed in and panned, part of a drawer lies outside the stage. No box around the pane is asked to
// scroll past its ends.
//
// An opened node is drawn inside the canvas's scaled world (CanvasViewport's translate + scale), so a box's rectangle on
// screen is its layout size times the zoom, while its scrollTop, clientHeight and scrollBy are in its own layout pixels:
// each box's ratio is measured and every distance converted, at any zoom.
//
// The canvas can still be fitting the open node around the new source view for a few frames (a laptop-sized window
// moves and resizes the node then), so for a moment after the jump the line is kept in view on every frame, only when it
// has left what is shown. The settling ends at once when the person scrolls, touches, presses or types, when anything
// else scrolls one of these boxes while it keeps its size, when the line is gone (a new delivery changes the page's
// text), or after a few corrections of one box. One long source line wraps, and can be taller than what a box shows below its third: a line taller than
// half of what a box shows counts as shown while its start is in the top half.
//
// MOTION.md lists the scroll position among what never moves "unless the person scrolled". These scrolls answer the
// person's own press on a noted line, as the pane's scroll did before; they are instant, and the settling that keeps the
// answer in view ends at the person's next input.

/** How long after a jump the line is kept in view while the layout settles. */
export const REVEAL_SETTLE_MS = 800;
/** The most times one box is corrected while the layout settles: a box that needs more is not settling. */
export const REVEAL_MAX_CORRECTIONS = 4;
const OWN_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

type Shown = { k: number; top: number; height: number };
type Clip = { top: number; bottom: number };
/** A scrolling box as this code last left it, and how many times it corrected the box while the layout settled. */
type Seen = { top: number; clientHeight: number; scrollHeight: number; corrections: number };

/** What a box shows, in screen pixels (the line's rectangle is in screen pixels too), and its zoom: screen pixels per
 *  layout pixel, from its rectangle against its layout height (1 where the box has no layout height, as in jsdom). */
function shownBy(box: HTMLElement, fade: number): Shown {
  const rect = box.getBoundingClientRect();
  const k = box.offsetHeight > 0 && rect.height > 0 ? rect.height / box.offsetHeight : 1;
  return { k, top: rect.top + box.clientTop * k, height: Math.max(0, box.clientHeight - fade) * k };
}

/** The part of what a box shows that `clip` leaves in sight (none at all: no height, at the nearest edge). */
function within(shown: Shown, clip: Clip): Shown {
  const top = Math.min(Math.max(shown.top, clip.top), shown.top + shown.height);
  const bottom = Math.min(shown.top + shown.height, clip.bottom);
  return { k: shown.k, top, height: Math.max(0, bottom - top) };
}

/** Notes a box as this code leaves it; `corrected` counts a scroll made while the layout settles. */
function note(box: HTMLElement, seen: Map<HTMLElement, Seen>, corrected: boolean): void {
  const was = seen.get(box);
  seen.set(box, { top: box.scrollTop, clientHeight: box.clientHeight, scrollHeight: box.scrollHeight, corrections: (was?.corrections ?? 0) + (corrected ? 1 : 0) });
}

/** Scrolls each box from `from` outwards that scrolls and does not show the line, nearest first, and notes every
 *  scrolling box it passes, scrolled or not. A scroll made while settling is a correction; one at the press is not. */
function revealIn(from: Element | null, line: () => DOMRect | null, seen: Map<HTMLElement, Seen>, settling: boolean): boolean {
  const chain: { box: HTMLElement; style: CSSStyleDeclaration; scrolls: boolean }[] = [];
  for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const style = getComputedStyle(el);
    const scrolls = typeof el.scrollBy === 'function' && el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(style.overflowY);
    if (!scrolls) seen.delete(el); // a box that fits now is noted afresh once it scrolls again
    chain.push({ box: el, style, scrolls });
  }
  // What the window and the boxes outside each box that clip without scrolling here leave in sight, outermost first.
  // Scrolling a box moves only what is inside it, so these hold while the walk scrolls.
  const clips: Clip[] = [];
  let clip: Clip = { top: 0, bottom: window.innerHeight > 0 ? window.innerHeight : Infinity };
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    clips[i] = clip;
    if (!chain[i].scrolls && chain[i].style.overflowY !== 'visible') {
      const rect = chain[i].box.getBoundingClientRect();
      clip = { top: Math.max(clip.top, rect.top), bottom: Math.min(clip.bottom, rect.bottom) };
    }
  }
  for (let i = 0; i < chain.length; i += 1) {
    const { box, style, scrolls } = chain[i];
    if (!scrolls) continue;
    const now = line();
    if (!now) return false;
    const s = within(shownBy(box, parseFloat(style.getPropertyValue('--awwo-scroll-fade')) || 0), clips[i]);
    if (s.height <= 0) {
      note(box, seen, false); // nothing of it is in sight: the boxes around it bring it back first
      continue;
    }
    const shown =now.top >= s.top && (now.bottom <= s.top + s.height || now.top <= s.top + s.height / 2);
    const by = (now.top - s.top - s.height / 3) / s.k;
    // As far as the box can go: a scroll it has no room for is not made, and costs no correction.
    const move = by < 0 ? Math.max(by, -box.scrollTop) : Math.min(by, box.scrollHeight - box.clientHeight - box.scrollTop);
    const made = !shown && Math.abs(move) >= 1;
    if (made) box.scrollBy({ top: move });
    note(box, seen, settling && made);
  }
  return true;
}

/** Whether something other than this code scrolled a box it noted (the box kept its size, its scrollTop did not). */
function scrolledByOthers(seen: Map<HTMLElement, Seen>): boolean {
  for (const [box, was] of seen) {
    if (box.clientHeight === was.clientHeight && box.scrollHeight === was.scrollHeight && Math.abs(box.scrollTop - was.top) > 1) return true;
  }
  return false;
}

/** Scrolls `pane` and then every scrolling box around it so the box `line()` gives is in view, and keeps it there while
 *  the layout settles. `line()` gives null once the line is gone (the page's text replaced or removed), which ends the
 *  settling. Returns a function that stops the settling (an effect's clean-up). */
export function revealLine(pane: HTMLElement, line: () => DOMRect | null, settleMs = REVEAL_SETTLE_MS): () => void {
  const at = line();
  if (!at || typeof pane.scrollBy !== 'function') return () => {};
  const seen = new Map<HTMLElement, Seen>();
  const p = shownBy(pane, 0);
  pane.scrollBy({ top: (at.top - p.top) / p.k - pane.clientHeight / 3 });
  note(pane, seen, false);
  revealIn(pane.parentElement, line, seen, false);
  if (typeof requestAnimationFrame !== 'function' || settleMs <= 0) return () => {};
  let frame = 0;
  let done = false;
  const until = performance.now() + settleMs;
  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    for (const type of OWN_INPUT) window.removeEventListener(type, stop, true);
  };
  // Capture: the canvas stops a wheel inside a node's drawer from reaching the window in the bubbling phase.
  for (const type of OWN_INPUT) window.addEventListener(type, stop, true);
  const tick = () => {
    if (done) return;
    if (performance.now() > until || scrolledByOthers(seen) || !revealIn(pane, line, seen, true)) {
      stop();
      return;
    }
    if ([...seen.values()].some(w => w.corrections >= REVEAL_MAX_CORRECTIONS)) {
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return stop;
}
