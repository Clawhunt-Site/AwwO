// How large each card is drawn on the board, when someone resized it to see its deliverable.
//
// A view preference, like the zoom: it is kept per person and browser, beside the canvas cache, and never in the
// canvas document. So a card can be enlarged while the canvas runs (the document is locked then), by a reader who
// cannot edit, and without an undo step or a cloud save for what is only a way of looking at the work.
import { canvasStorageKey } from './canvasStorage';
import { COMPACT_SESSION_SIZE } from './nodePresentation';

export type CardFrame = { w: number; h: number };
export type CardFrames = Readonly<Record<string, CardFrame>>;

export const CARD_FRAMES_KEY = 'awwo.canvas.card-frames.v1';
export const CARD_MAX = { w: 2400, h: 1800 } as const;
/** A card is drawn with its deliverable once it is at least this large (world units). */
export const CARD_PREVIEW_MIN = { w: 340, h: 230 } as const;
/** The size 「放大预览」 opens a card at. */
export const CARD_PREVIEW_DEFAULT = { w: 640, h: 460 } as const;

export function clampCard(w: number, h: number): CardFrame {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  return {
    w: Math.round(Math.min(CARD_MAX.w, Math.max(COMPACT_SESSION_SIZE.w, finite(w, COMPACT_SESSION_SIZE.w)))),
    h: Math.round(Math.min(CARD_MAX.h, Math.max(COMPACT_SESSION_SIZE.h, finite(h, COMPACT_SESSION_SIZE.h)))),
  };
}

/** Whether a card this size shows its deliverable rather than its one-line summary. */
export function showsPreview(frame: CardFrame | undefined): boolean {
  return Boolean(frame && frame.w >= CARD_PREVIEW_MIN.w && frame.h >= CARD_PREVIEW_MIN.h);
}

export function loadCardFrames(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): Record<string, CardFrame> {
  try {
    const raw = JSON.parse(storage?.getItem(canvasStorageKey(CARD_FRAMES_KEY)) || '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const frames: Record<string, CardFrame> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (id.length > 200 || !value || typeof value !== 'object') continue;
      const { w, h } = value as Record<string, unknown>;
      if (typeof w === 'number' && typeof h === 'number') frames[id] = clampCard(w, h);
    }
    return frames;
  } catch { return {}; }
}

/** Keep only cards still on the canvas; a card back at its compact size needs no entry. Writes only on a change. */
export function saveCardFrames(frames: CardFrames, nodeIds: ReadonlySet<string>,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  const kept = Object.fromEntries(Object.entries(frames).filter(([id, frame]) => nodeIds.has(id)
    && (frame.w !== COMPACT_SESSION_SIZE.w || frame.h !== COMPACT_SESSION_SIZE.h)));
  try {
    const key = canvasStorageKey(CARD_FRAMES_KEY);
    const current = storage?.getItem(key) ?? null;
    if (Object.keys(kept).length) {
      const next = JSON.stringify(kept);
      if (current !== next) storage?.setItem(key, next);
    } else if (current !== null) storage?.removeItem(key);
  } catch { /* A view preference that cannot be stored lasts for this page only. */ }
}
