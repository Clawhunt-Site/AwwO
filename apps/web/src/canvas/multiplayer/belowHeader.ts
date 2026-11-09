// Where the 同屏 panel and the Share dialog start: right below the canvas header they open from (AgentWorkspace.tsx),
// wherever the header is. A banner above it (执行尚未就绪, a save that failed) moves it down, and a header too narrow for
// one row takes a second; a panel at a fixed top covered the header's right end then, the button that opened it included.
import { useLayoutEffect, type RefObject } from 'react';

/** The canvas header a panel opens from. */
const HEADER = '.awwo-header';
/** Where the panel starts (multiplayer.css): the header's bottom edge in the window. */
export const PANEL_TOP = '--awwo-multiplayer-top';

/** Keeps a panel right below the canvas header it is in: measures the header's bottom edge as the panel opens, and again
 *  whenever the header can have moved, before the page is painted. A panel outside such a header is left at the CSS's
 *  own place. */
export function useBelowHeader(panel: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = panel.current;
    const header = element?.closest<HTMLElement>(HEADER);
    if (!element || !header) return undefined;
    let shown = '';
    const place = () => {
      // A header scrolled out of sight leaves the panel at the top of the window.
      const top = `${Math.max(0, Math.ceil(header.getBoundingClientRect().bottom))}px`;
      if (top === shown) return;
      shown = top;
      element.style.setProperty(PANEL_TOP, top);
    };
    place();
    // Whatever moves the header changes the size of a box it is in: the canvas page is one window tall, so a banner shown
    // above the header shrinks every box around it, and a header that takes a second row grows them.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    for (let box: HTMLElement | null = header; box; box = box.parentElement) observer?.observe(box);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place);
    };
  }, [panel]);
}
