/**
 * Pure geometry for the right-side conversation/context panel's drag-to-resize.
 *
 * Extracted from App.tsx so the (presentation-only) sizing math is unit-testable
 * without rendering the whole workbench. No DOM, no storage, no React — just numbers.
 *
 * Invariants encoded here:
 *  - The chat column always keeps at least CHAT_MIN_WIDTH (mirrors the CSS grid's
 *    `minmax(420px, 1fr)` middle track). Resizing only ever borrows the chat's slack.
 *  - The panel never renders wider than the viewport can hold, so it can't overflow
 *    and clip its own controls; in cramped windows it shrinks below its nominal
 *    minimum to stay fully on-screen.
 */

export const CONTEXT_PANEL_DEFAULT_WIDTH = 420;
export const CONTEXT_PANEL_MIN_WIDTH = 360;
export const CONTEXT_PANEL_MAX_WIDTH = 760;
// Chat column's hard floor — mirrors the grid's `minmax(420px, 1fr)` middle track.
export const CHAT_MIN_WIDTH = 420;

/** Clamp a *preferred* width into the panel's nominal [MIN, MAX] range (rounded). */
export function clampContextPanelWidth(width: number): number {
  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
}

/**
 * Widest the panel may *render* given the live layout, without pushing the chat
 * column below its floor. Deliberately NOT floored at the panel minimum — in a
 * cramped (sub-~1080px desktop) viewport it shrinks below the minimum so the panel
 * always fits inside the window and its controls never get clipped. Guarded at 0 so
 * an extreme window can't yield a negative track. Result ≤ MAX.
 */
export function contextPanelUpperBound(viewportWidth: number, sidebarFootprint: number): number {
  const available = viewportWidth - sidebarFootprint - CHAT_MIN_WIDTH;
  return Math.max(0, Math.min(CONTEXT_PANEL_MAX_WIDTH, available));
}

/**
 * The single source of truth for "what the panel looks like and what the user can do
 * to it RIGHT NOW", derived from the stored preferred width + the live layout:
 *
 *  - `upperBound`  the widest it may render/reach (viewport-fit; may be < the nominal
 *                  minimum in a cramped window, see contextPanelUpperBound).
 *  - `lowerBound`  the narrowest it may reach now (the nominal minimum, or the upper
 *                  bound itself when the window can't even hold the minimum).
 *  - `effective`   the width it actually renders at = the preferred width clamped into
 *                  [lowerBound, upperBound].
 *
 * Drag, keyboard, and ARIA must ALL operate on these (especially `effective` as the
 * gesture/announcement origin), never on the raw preferred width — otherwise the
 * handle/announced value desync from the visible panel in cramped viewports.
 */
export function contextPanelInteraction(
  preferredWidth: number,
  viewportWidth: number,
  sidebarFootprint: number,
): { upperBound: number; lowerBound: number; effective: number } {
  const upperBound = contextPanelUpperBound(viewportWidth, sidebarFootprint);
  const lowerBound = Math.min(CONTEXT_PANEL_MIN_WIDTH, upperBound);
  const effective = Math.max(lowerBound, Math.min(preferredWidth, upperBound));
  return { upperBound, lowerBound, effective };
}

/**
 * The width the panel actually renders at — the `effective` field of
 * contextPanelInteraction. Kept as a thin alias for call sites / tests that only need
 * the number.
 */
export function effectiveContextPanelWidth(
  preferredWidth: number,
  viewportWidth: number,
  sidebarFootprint: number,
): number {
  return contextPanelInteraction(preferredWidth, viewportWidth, sidebarFootprint).effective;
}
