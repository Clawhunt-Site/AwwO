// Whether a part of an opened node's chat column, once drawn, pushes the column's message box out of it. Beside the
// opened inputs the conversation's panel keeps its content's height (awwo-node.css .has-inputs) while the inputs take
// what the column leaves, down to their floor, so an open rework note counts in full there. In a column that is not
// short (useShortColumn.ts) that cut the composer wherever the column could not hold the heading, the task card, the
// inputs at their floor, the open note and the composer (2026-10-20, production's build, the default look: its bottom
// edge 130 px below the node's body at 1366 × 768, a 456 px column, where typing then scrolled the whole column, 104 px
// at 1366 × 800, 40 px at 1536 × 864 and 4 px at 1440 × 900, where two looks of seven hold it; 1920 × 1080 holds it).
// ReworkFindingsNote asks this hook, and its findings wait, as in a short column, only where they would cut the
// composer: until the inputs close or the column has room for them. The column itself is no measure: its panel can
// reach below it with the composer whole (the note's 45% cap counts against a panel sized by the uncapped note, which
// leaves 57 px under the composer there), so it is the composer's own bottom edge, its bottom padding included, that is
// compared with the column's.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

const COMPOSER = ':scope > .awwo-node-panel--conversation > .canvas-composer';

/** The column's message box reaches below the column, by more than a twentieth of a CSS px (the canvas may be zoomed). */
function cutsComposer(column: HTMLElement): boolean {
  const composer = column.querySelector<HTMLElement>(COMPOSER);
  const box = column.getBoundingClientRect();
  if (!composer || !column.clientHeight || !box.height) return false;
  return (composer.getBoundingClientRect().bottom - box.bottom) * (column.clientHeight / box.height) > 0.05;
}

/**
 * Whether what is drawn while `wanted` cuts `column`'s message box. Drawn, it is measured after every render of its
 * component, once laid out and before the page is painted (a layout effect): the node's own size comes through such a
 * render (SessionTile's frame), so a window made smaller takes it out before the composer is painted cut (Chrome,
 * frame by frame, 2026-10-20). While it waits, a change of size in the column or in one of its parts draws it again to
 * be measured the same way, and it is taken out again before the page is painted if the composer is still cut, so it
 * shows again once there is room. So does a change of `content`, what it draws and how (its text, its language, the
 * opened node's look and font), which changes no size that is observed while it waits (an undo restoring shorter
 * findings, a font that wraps them shorter), and a font that finishes loading. A change of size that comes through no
 * render of its component (a task card expanded, which renders the card alone; a font loaded) is seen a frame later,
 * by the same observer. No column, or not wanted: false.
 */
export function useCutsComposer(column: RefObject<HTMLElement | null> | undefined, wanted: boolean, content: unknown): boolean {
  const [cuts, setCuts] = useState(false);
  const watching = Boolean(column) && wanted;
  // What it draws has changed: drawn again and measured afresh (the next effect, in the render this one asks for).
  useLayoutEffect(() => { setCuts(false); }, [content]);
  useLayoutEffect(() => {
    const element = column?.current;
    // Not wanted here any more: the next time it is, it is drawn and measured first.
    if (!watching) { if (cuts) setCuts(false); }
    else if (!cuts && element && cutsComposer(element)) setCuts(true);
  });
  useEffect(() => {
    const element = column?.current;
    if (!watching || !element) return;
    // Drawn, it waits if the composer is cut now. Waiting, a composer the column holds draws it again, to be measured
    // by the layout effect (one still cut without it would be cut with it too). Sizes are compared with the last ones
    // reported, after a frame's layout: a drawing measured and taken out again within one task leaves them as they
    // were, so a measurement never sets off another. A font that finishes loading may change how it wraps while it
    // waits, which no observed box shows: measured again the same way.
    const measure = () => setCuts(cutsComposer(element));
    const fonts: FontFaceSet | undefined = document.fonts; // none in jsdom
    fonts?.addEventListener('loadingdone', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    // The column's parts as they are now, and as they come and go (a task card drawn once a media node becomes an
    // agent, a failure note): each is watched for a change of size of its own.
    const watched = new Set<Element>();
    const watchParts = () => {
      const parts = new Set(Array.from(element.children));
      for (const part of watched) if (!parts.has(part)) { watched.delete(part); observer?.unobserve(part); }
      for (const part of parts) if (!watched.has(part)) { watched.add(part); observer?.observe(part); }
    };
    watchParts();
    const arrivals = typeof MutationObserver === 'undefined' ? null : new MutationObserver(watchParts);
    arrivals?.observe(element, { childList: true });
    return () => { observer?.disconnect(); arrivals?.disconnect(); fonts?.removeEventListener('loadingdone', measure); };
  }, [column, watching]);
  return watching && cuts;
}
