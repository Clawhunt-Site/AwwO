// 预览展示 (preview display) nodes: windows on the board that show, live, what the canvas made.
//
// A display is not a step of the workflow. It runs nothing, takes no wire, needs no model and is never part of a run,
// so it lives in the document's own `displays` list beside the graph, not in `nodes`: the server executes `nodes` and
// `edges` as the graph (and refuses a node kind it does not know) while it stores the rest of the document as written.
// A canvas with displays therefore runs, plans and saves exactly as one without them. Moving, resizing or retargeting
// a display is an ordinary edit (an undo step, a cloud save) that touches no node, so it stays free while components
// run.
//
// What a display shows is read from published outputs only, as the cards and the results studio read them
// (studio/studioModel.ts): one component's deliverables, or the whole canvas's, its result first. Only type imports
// here: canvasDoc.ts imports this module to keep the list.
import type { Bounds } from './viewport';

export type DisplaySource = { type: 'canvas' } | { type: 'node'; nodeId: string };

export interface DisplayNode {
  id: string;
  kind: 'display';
  /** World-space top-left and size, like a node's. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** A name it was given; '' shows what it displays. */
  title: string;
  source: DisplaySource;
}

type Box = { x: number; y: number; w: number; h: number };

export const DISPLAY_NODE_SIZE = { w: 720, h: 540 } as const;
export const DISPLAY_MIN_SIZE = { w: 320, h: 240 } as const;
export const DISPLAY_MAX_SIZE = { w: 3200, h: 2400 } as const;
/** A board holds at most this many displays; a stored list longer than that keeps its first ones. */
export const MAX_DISPLAYS = 24;
/** Smaller than this on screen, a display shows its summary instead of running what it shows. */
export const DISPLAY_LIVE_MIN_PX = { w: 180, h: 120 } as const;
/** The content zoom's steps (a way of looking, never saved). 1 is the content at its own size. */
export const DISPLAY_ZOOM_STEPS: ReadonlyArray<number> = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

const ID_MAX = 200;
const TITLE_MAX = 120;

/** The next zoom step from `zoom` in a direction (+1 in, -1 out), held at the ends. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const steps = DISPLAY_ZOOM_STEPS;
  if (direction > 0) return steps.find(step => step > zoom + 1e-6) ?? steps[steps.length - 1];
  return [...steps].reverse().find(step => step < zoom - 1e-6) ?? steps[0];
}

/** A continuous zoom (Ctrl/⌘ + wheel) kept inside the steps' range. */
export function clampZoom(zoom: number): number {
  const steps = DISPLAY_ZOOM_STEPS;
  return Math.min(steps[steps.length - 1], Math.max(steps[0], Number.isFinite(zoom) ? zoom : 1));
}

let seq = 0;
export function mintDisplayId(): string {
  seq += 1;
  return `dp-${Date.now().toString(36)}-${seq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function clampDisplaySize(w: number, h: number): { w: number; h: number } {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  return {
    w: Math.round(Math.min(DISPLAY_MAX_SIZE.w, Math.max(DISPLAY_MIN_SIZE.w, finite(w, DISPLAY_NODE_SIZE.w)))),
    h: Math.round(Math.min(DISPLAY_MAX_SIZE.h, Math.max(DISPLAY_MIN_SIZE.h, finite(h, DISPLAY_NODE_SIZE.h)))),
  };
}

export function createDisplayNode(pos: { x: number; y: number }, source: DisplaySource = { type: 'canvas' }): DisplayNode {
  return { id: mintDisplayId(), kind: 'display', x: Math.round(pos.x), y: Math.round(pos.y), w: DISPLAY_NODE_SIZE.w, h: DISPLAY_NODE_SIZE.h, title: '', source };
}

export function sanitizeDisplaySource(raw: unknown): DisplaySource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.type === 'canvas') return { type: 'canvas' };
  if (value.type === 'node' && typeof value.nodeId === 'string' && value.nodeId.trim() && value.nodeId.length <= ID_MAX) return { type: 'node', nodeId: value.nodeId };
  return null;
}

export function sameDisplaySource(a: DisplaySource, b: DisplaySource): boolean {
  return a.type === b.type && (a.type === 'canvas' || a.nodeId === (b as { nodeId: string }).nodeId);
}

/**
 * The well-formed displays of a stored list, or undefined when there are none (the document then carries no key, as
 * before displays existed). Fail-soft like the rest of the document: an entry that names nothing to show, repeats an
 * id or is not a display is dropped; a bad position or size falls back as a node's would.
 */
export function sanitizeDisplays(raw: unknown): DisplayNode[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const displays: DisplayNode[] = [];
  for (const item of raw) {
    if (displays.length >= MAX_DISPLAYS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id : '';
    const source = sanitizeDisplaySource(value.source);
    if (value.kind !== 'display' || !id || id.length > ID_MAX || seen.has(id) || !source) continue;
    seen.add(id);
    const num = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    displays.push({ id, kind: 'display', x: num(value.x, 0), y: num(value.y, 0), ...clampDisplaySize(num(value.w, DISPLAY_NODE_SIZE.w), num(value.h, DISPLAY_NODE_SIZE.h)),
      title: typeof value.title === 'string' ? value.title.slice(0, TITLE_MAX) : '', source });
  }
  return displays.length ? displays : undefined;
}

const overlaps = (a: Box, b: Box, margin: number) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

/** Where a display goes at the end of the board: right of everything, level with the board's top. */
export function placeDisplayAfter(boxes: ReadonlyArray<Box>, gap = 120): { x: number; y: number } {
  if (!boxes.length) return { x: 0, y: 0 };
  return { x: Math.round(Math.max(...boxes.map(box => box.x + box.w)) + gap), y: Math.round(Math.min(...boxes.map(box => box.y))) };
}

/**
 * Where a display showing the component at `box` goes: beside it, clear of `obstacles` (the other cards and
 * displays). Right of it first, then below, then diagonally, then above, stepping further right each round; when
 * nothing nearby is free, at the end of the board.
 */
export function placeDisplayBeside(box: Box, obstacles: ReadonlyArray<Box>, size: { w: number; h: number } = DISPLAY_NODE_SIZE, gap = 72): { x: number; y: number } {
  const others = obstacles.filter(other => !(other.x === box.x && other.y === box.y && other.w === box.w && other.h === box.h));
  for (let ring = 0; ring < 6; ring += 1) {
    const dx = ring * (size.w + gap);
    for (const spot of [
      { x: box.x + box.w + gap + dx, y: box.y },
      { x: box.x + dx, y: box.y + box.h + gap },
      { x: box.x + box.w + gap + dx, y: box.y + box.h + gap },
      { x: box.x + dx, y: box.y - size.h - gap },
    ]) {
      const candidate = { ...spot, ...size };
      if (!others.some(other => overlaps(candidate, other, 24))) return { x: Math.round(spot.x), y: Math.round(spot.y) };
    }
  }
  return placeDisplayAfter([...others, box]);
}

/** The dashed link from the component a display shows to the display: a curve between their facing sides. */
export function displayLinkPath(from: Box, to: Box): string {
  const fx = from.x + from.w / 2, fy = from.y + from.h / 2, tx = to.x + to.w / 2, ty = to.y + to.h / 2;
  const dx = tx - fx, dy = ty - fy;
  // Side by side unless one sits clearly above the other.
  if (Math.abs(dx) * (from.h + to.h) >= Math.abs(dy) * (from.w + to.w)) {
    const sx = dx >= 0 ? from.x + from.w : from.x, ex = dx >= 0 ? to.x : to.x + to.w;
    const bend = Math.sign(dx || 1) * Math.max(40, Math.abs(ex - sx) / 2);
    return `M ${sx} ${fy} C ${sx + bend} ${fy}, ${ex - bend} ${ty}, ${ex} ${ty}`;
  }
  const sy = dy >= 0 ? from.y + from.h : from.y, ey = dy >= 0 ? to.y : to.y + to.h;
  const bend = Math.sign(dy || 1) * Math.max(40, Math.abs(ey - sy) / 2);
  return `M ${fx} ${sy} C ${fx} ${sy + bend}, ${tx} ${ey - bend}, ${tx} ${ey}`;
}

export function displayBounds(display: Box): Bounds {
  return { minX: display.x, minY: display.y, maxX: display.x + display.w, maxY: display.y + display.h };
}
