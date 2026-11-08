// The icon view (图标视图, a view preference: the board draws every component as a live icon instead of its card, wired as
// the cards are). This module is its geometry, pure: where a component's icon sits, the band its ports and wires use, the
// box the 多人同屏 marks ring, and how much of its rows it shows at a zoom. NodeIcon.tsx draws it; CanvasSurface hands
// these boxes to every part of the board that reads a node's box (wires, ports, marks, marquee, minimap, display links).
import type { CanvasNode } from './canvasDoc';
import { canvasStorageKey } from './canvasStorage';
import { COMPACT_SESSION_SIZE } from './nodePresentation';
import { portsFor, type WireGeometry } from './ports';

/** Whether a person draws a canvas in its icon view: a view preference like converging (convergedGroups.ts), kept per
 *  person, browser and canvas beside the canvas cache, never in the document, so it works for a reader and while the
 *  canvas runs. */
export const ICON_VIEW_KEY = 'awwo.canvas.icon-view.v1';
type ReadStorage = Pick<Storage, 'getItem'> | null;
type WriteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
const browserStorage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/** Whether this person last drew this canvas as icons, fail-soft: anything malformed means cards. */
export function loadIconView(storage: ReadStorage = browserStorage()): boolean {
  try {
    const raw = JSON.parse(storage?.getItem(canvasStorageKey(ICON_VIEW_KEY)) || 'null') as unknown;
    return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).v === 1
      && (raw as Record<string, unknown>).on === true);
  } catch { return false; }
}

/** Cards mean no entry. Writes only on a change. */
export function saveIconView(on: boolean, storage: WriteStorage = browserStorage()): void {
  try {
    const key = canvasStorageKey(ICON_VIEW_KEY);
    const current = storage?.getItem(key) ?? null;
    const next = JSON.stringify({ v: 1, on: true });
    if (on) { if (current !== next) storage?.setItem(key, next); }
    else if (current !== null) storage?.removeItem(key);
  } catch { /* A view preference that cannot be stored lasts for this page only. */ }
}

/** An icon's world size: inside a compact card's box (260 x 128) and a form's (300 x 200), so icons laid out where the
 *  cards were keep their gaps. */
export const NODE_ICON_WORLD = 112;
const RADIUS = NODE_ICON_WORLD / 2;
/** A port band is never thinner than a fifth of the icon (as a converged member's band) and keeps two ports this far
 *  apart (a port's handle is 11-14 units, 1.25 times that hovered), up to the icon's own height. */
const BAND_MIN = NODE_ICON_WORLD / 5;
const PORT_GAP = 18;
/** What an icon shows under it by its size on screen: under NAME px nothing (its name would only overlap the next
 *  one's), then its name, and from LINE px its state line too. A canvas fitted on screen (a quarter of its size or so)
 *  draws icons of about 30 px: named. */
export const NODE_ICON_NAME_MIN_PX = 20;
export const NODE_ICON_LINE_MIN_PX = 44;
export type NodeIconTier = 'S' | 'M' | 'L';

export interface Box { x: number; y: number; w: number; h: number }

/** The icon's box: a square centred on the node's closed card (a session's compact card, any other kind at its saved
 *  size), never on an enlarged or opened frame, so a card enlarged earlier does not move its icon. */
export function nodeIconBox(node: Pick<CanvasNode, 'kind' | 'x' | 'y' | 'w' | 'h'>): Box {
  const w = node.kind === 'session' ? COMPACT_SESSION_SIZE.w : node.w;
  const h = node.kind === 'session' ? COMPACT_SESSION_SIZE.h : node.h;
  return { x: node.x + w / 2 - RADIUS, y: node.y + h / 2 - RADIUS, w: NODE_ICON_WORLD, h: NODE_ICON_WORLD };
}

/** The band the icon's ports and wires use: centred on the icon, tall enough to keep the busier side's ports PORT_GAP
 *  apart (a fifth of the icon at least, the icon at most); round, so portAnchorWorld puts each port on the plate's rim;
 *  and with the plate's top, so a feedback wire's lane runs above the plate as it runs above a card. */
export function nodeIconWireBox<T extends CanvasNode>(node: T, icon: Box = nodeIconBox(node)): T & WireGeometry {
  const ports = portsFor(node);
  const busier = Math.max(ports.filter(port => port.side === 'input').length, ports.filter(port => port.side === 'output').length);
  const h = Math.min(NODE_ICON_WORLD, Math.max(BAND_MIN, PORT_GAP * (busier + 1)));
  const band: Box & WireGeometry = { x: icon.x, y: icon.y + (NODE_ICON_WORLD - h) / 2, w: NODE_ICON_WORLD, h, round: true, laneTop: icon.y };
  return { ...node, ...band } as T & WireGeometry;
}

/** How wide an icon's rows may be in world units: its node's closed card. Icons sit where the cards sat, so rows no
 *  wider than the card they replace cannot meet a neighbour's (the cards did not), and a name too long for it is cut
 *  with an ellipsis exactly as its card's title is. */
export function nodeIconLabelWidth(node: Pick<CanvasNode, 'kind' | 'w'>): number {
  return node.kind === 'session' ? COMPACT_SESSION_SIZE.w : node.w;
}

export interface NodeIconGeometry<T extends CanvasNode = CanvasNode> {
  /** The plate: where the icon is drawn. */
  icon: Box;
  /** How wide its rows may be (nodeIconLabelWidth), in world units. */
  labelWidth: number;
  /** The node as the wires and its own ports see it: its band. */
  wire: T & WireGeometry;
  /** The node as the 多人同屏 marks, the marquee, the minimap and display links see it: its plate, round. */
  plate: T & { round: true };
}

const GEOMETRY = new WeakMap<CanvasNode, NodeIconGeometry>();

/** A node's icon geometry, one set of objects per node object: the board's nodes keep their objects while they do not
 *  change, so the icons, the wires and the marks keep theirs and re-render only for what moved. */
export function nodeIconGeometry<T extends CanvasNode>(node: T): NodeIconGeometry<T> {
  const known = GEOMETRY.get(node) as NodeIconGeometry<T> | undefined;
  if (known) return known;
  const icon = nodeIconBox(node);
  const geometry: NodeIconGeometry<T> = { icon, labelWidth: nodeIconLabelWidth(node), wire: nodeIconWireBox(node, icon),
    plate: { ...node, ...icon, round: true } };
  GEOMETRY.set(node, geometry);
  return geometry;
}

/** The nodes with the given ones in their icon geometry (`pick` chooses which box), the very array when there are none
 *  (the board layer and the wires keep their identity while nothing is an icon). */
export function withIconGeometry<T extends CanvasNode>(nodes: ReadonlyArray<T>, iconIds: ReadonlySet<string>,
  pick: 'wire' | 'plate'): ReadonlyArray<T> {
  if (!iconIds.size) return nodes;
  return nodes.map(node => iconIds.has(node.id) ? nodeIconGeometry(node)[pick] : node);
}

/** The icon's rows at this zoom: none (S), its name (M), its name and state line (L). */
export function nodeIconTier(zoom: number): NodeIconTier {
  const px = NODE_ICON_WORLD * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  return px < NODE_ICON_NAME_MIN_PX ? 'S' : px < NODE_ICON_LINE_MIN_PX ? 'M' : 'L';
}
