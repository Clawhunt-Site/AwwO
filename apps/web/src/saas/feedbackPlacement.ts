// Where the feedback assistant's button sits (FeedbackAssistant.tsx): the bottom-left corner of the window, unless
// something a person works with is there. Pages say so in their markup, not here:
//   data-feedback-slot      a place kept for the button (the home's rail keeps one under the account card); the button
//                           sits in it while it is on screen whole;
//   data-feedback-avoid     something the button must not cover: "beside" moves it to that thing's right (the canvas
//                           assistant's column, the model library), "above" moves it over that thing (the board's view
//                           tools). Covering scrolling content is fine; covering a control fixed in place is not.
// With no room left (a phone whose assistant panel fills the width) the button steps away until there is.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

// While one of the app's own modal dialogs is open (an aria-modal="true" element on screen, or a <dialog> shown as a
// modal), the button and the panel step away too: the dialog has the person's attention, and its focus trap would pull
// focus out of the panel.
export type Box = { left: number; top: number; right: number; bottom: number };
export type Obstacle = { box: Box; mode: 'beside' | 'above' };
/** The button's place, by its left edge and its distance from the window's bottom, and the slot's width when it sits in
 *  one (docked); null while there is no room. */
export type Placement = { left: number; bottom: number; width?: number } | null;

export const LAUNCHER_MARGIN = 16;
const GAP = 10;
/** The floating button's width (icon and short label), for measuring where it fits while it is docked. */
const FLOATING_WIDTH = 96;

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export function placeLauncher(view: { width: number; height: number }, size: { width: number; height: number }, slot: Box | null, obstacles: Obstacle[]): Placement {
  if (slot) return { left: Math.round(slot.left), bottom: Math.round(view.height - slot.bottom), width: Math.round(slot.right - slot.left) };
  let left = LAUNCHER_MARGIN, bottom = LAUNCHER_MARGIN;
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const box = { left, right: left + size.width, top: view.height - bottom - size.height, bottom: view.height - bottom };
    const hit = obstacles.find(item => overlaps(item.box, box));
    if (!hit) return left + size.width + LAUNCHER_MARGIN <= view.width + 0.5 && bottom + size.height <= view.height ? { left: Math.round(left), bottom: Math.round(bottom) } : null;
    if (hit.mode === 'beside') left = Math.max(left, hit.box.right + LAUNCHER_MARGIN);
    else bottom = Math.max(bottom, view.height - hit.box.top + GAP);
    if (left + size.width + LAUNCHER_MARGIN > view.width || bottom + size.height + LAUNCHER_MARGIN > view.height) return null;
  }
  return null;
}

function shown(element: Element): DOMRect | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return getComputedStyle(element).visibility === 'hidden' ? null : rect;
}

/** Whether one of the app's own modal dialogs is open now (the feedback panel itself is no modal). */
export function modalOpen(): boolean {
  for (const element of document.querySelectorAll('[aria-modal="true"]')) {
    if (!element.closest('.awwo-feedback-panel') && shown(element)) return true;
  }
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    try { if (dialog.matches(':modal')) return true; } catch { /* a browser without :modal */ }
  }
  return false;
}

/** The page's slot and obstacles as they are drawn now. */
export function measurePage(): { slot: Box | null; obstacles: Obstacle[] } {
  let slot: Box | null = null;
  const kept = document.querySelector('[data-feedback-slot]');
  const rect = kept ? shown(kept) : null;
  if (kept && rect && rect.top >= 0 && rect.bottom <= window.innerHeight) {
    // In a column that scrolls, the slot counts only while that column shows it whole.
    const column = kept.closest('[data-feedback-avoid]');
    const room = column ? shown(column) : null;
    if (!room || (rect.top >= room.top - 0.5 && rect.bottom <= room.bottom + 0.5)) slot = rect;
  }
  const obstacles: Obstacle[] = [];
  for (const element of document.querySelectorAll('[data-feedback-avoid]')) {
    const box = shown(element);
    if (box) obstacles.push({ box, mode: element.getAttribute('data-feedback-avoid') === 'above' ? 'above' : 'beside' });
  }
  return { slot, obstacles };
}

/** The button's place, kept up with the page: on resize and scroll, and twice a second for what the page itself moves
 *  (a column opened or closed, a dialog shown). `place` is undefined until it is first measured; `covered` says one of
 *  the app's modal dialogs is open. */
export function useLauncherPlacement(button: RefObject<HTMLElement | null>): { place: Placement | undefined; covered: boolean } {
  const [place, setPlace] = useState<Placement | undefined>(undefined);
  const [covered, setCovered] = useState(false);
  const measure = () => {
    const element = button.current;
    // Its size as it floats: docked, it takes the slot's width, which says nothing of the room it needs elsewhere.
    const size = { width: element?.dataset.docked === undefined ? element?.offsetWidth || FLOATING_WIDTH : FLOATING_WIDTH, height: element?.offsetHeight || 40 };
    const { slot, obstacles } = measurePage();
    const next = placeLauncher({ width: window.innerWidth, height: window.innerHeight }, size, slot, obstacles);
    setPlace(current => (current === undefined || current === null || next === null) ? (current === next ? current : next)
      : current.left === next.left && current.bottom === next.bottom && current.width === next.width ? current : next);
    const modal = modalOpen();
    setCovered(current => current === modal ? current : modal);
  };
  useLayoutEffect(measure, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let frame = 0;
    const soon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    window.addEventListener('resize', soon);
    window.addEventListener('scroll', soon, { capture: true, passive: true });
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') measure(); }, 500);
    return () => {
      window.removeEventListener('resize', soon);
      window.removeEventListener('scroll', soon, { capture: true });
      window.clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { place, covered };
}
