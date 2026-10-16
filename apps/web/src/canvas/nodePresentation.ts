import type { CanvasEdge, CanvasNode } from './canvasDoc';
import { mediaKindOf } from './mediaCatalog';

export const COMPACT_SESSION_SIZE = { w: 260, h: 128 } as const;
// Slim focused geometry: a focused node plus its delivery drawer has to fit a laptop stage with
// both side rails open. The drawer width is mirrored by .awwo-node-delivery-drawer in awwo-node.css.
export const FOCUSED_SESSION_MIN_SIZE = { w: 520, h: 380 } as const;
export const DELIVERY_DRAWER_WIDTH = 320;

/** What an opened node mostly shows, which decides how much of the stage it takes and how wide its delivery drawer is:
 *  a page (a web page, game or figure it delivers as HTML), a picture, clip or 3D model it generates, another delivery
 *  (a document, data or code), or only its conversation so far. */
export type OpenContent = 'page' | 'media' | 'delivery' | 'chat';

export function openContentOf(node: CanvasNode): OpenContent {
  if (node.kind !== 'session') return 'chat';
  if (mediaKindOf(node.agentKind)) return 'media';
  if (node.templateId === 'figure' || node.contract?.outputs.some(field => field.type === 'html')) return 'page';
  return node.lastOutput ? 'delivery' : 'chat';
}

/** Whether an opened node shows its delivery drawer: as the reader left it, or else once it has delivered in full,
 *  what it made being most of what opening it is for (owner request 2026-10-15) — never for a picture, clip or 3D
 *  model, which its own view shows, nor for a partial delivery a failure left, beside which the failure note must stay
 *  in view, nor where the drawer would cover the conversation instead of sitting beside it (`beside`). */
export function deliverablesShown(node: CanvasNode, beside = true): boolean {
  if (node.kind !== 'session') return false;
  return node.deliverablesOpen ?? (beside && Boolean(node.lastOutput && !node.lastOutput.partial) && !mediaKindOf(node.agentKind));
}
/** The narrowest an opened node (its frame, the tile's outer width) holds its delivery drawer beside its conversation.
 *  The container query in awwo-node.css lays the drawer over the conversation while the workbench is under 740 px, and
 *  the workbench is the tile less its padding (14 px a side) and border (1 px a side, canvas.css): a frame of 740-769 px
 *  opened its drawer by itself over the conversation. */
export const DRAWER_BESIDE_MIN_WIDTH = 740 + 2 * (14 + 1);

/** The widest an opened node of each kind grows: a page wants the room of a browser window, a conversation the width
 *  of a readable column beside its drawer. */
const OPEN_MAX_WIDTH: Record<OpenContent, number> = { page: 1680, media: 1200, delivery: 1440, chat: 1100 };
const OPEN_MAX_HEIGHT = 1100;

/**
 * The size a node opens at on a stage of `available` world pixels (the stage less its focus padding, and less the
 * Configure panel's room while that floats beside it): as much of the stage as its content can use, so it opens at
 * 100 % zoom with its conversation, inputs and delivery readable instead of in a fixed box (owner request 2026-10-15).
 * None below the narrow-stage width, where the opened node fills the stage its own way. `content` stands in for what
 * the node shows now (an open node keeps the room its delivery had while a run clears it).
 */
export function openFrameFor(node: CanvasNode | undefined, available: { w: number; h: number }, content?: OpenContent): { w: number; h: number } | undefined {
  if (!node || node.kind !== 'session' || available.w < FOCUSED_SESSION_MIN_SIZE.w || available.h < 200) return undefined;
  return {
    w: Math.max(FOCUSED_SESSION_MIN_SIZE.w, Math.min(available.w, OPEN_MAX_WIDTH[content ?? openContentOf(node)])),
    h: Math.max(FOCUSED_SESSION_MIN_SIZE.h, Math.min(available.h, OPEN_MAX_HEIGHT)),
  };
}

/**
 * Geometry for the current canvas view only. Persisted workspace sizes and session contents
 * remain untouched, so closing a conversation does not resize or discard the user's work.
 * Use these same nodes for cards, port anchors, wires, minimap, selection and viewport fitting.
 * `cardFrames` are the sizes people enlarged cards to (cardFrames.ts), a view preference too.
 * `openFrame` is the size the focused node opens at (openFrameFor); a node saved larger keeps its size, unless the
 * frame is `exact` (the reader resized the open node by hand, to any size).
 */
export function presentationNodes(nodes: ReadonlyArray<CanvasNode>, focusedId: string | null, narrowFocusWidth?: number,
  cardFrames?: Readonly<Record<string, { w: number; h: number }>>, openFrame?: { w: number; h: number }, exact = false): CanvasNode[] {
  return nodes.map(node => {
    if (node.kind !== 'session') return node;
    const card = cardFrames?.[node.id];
    const opened = !narrowFocusWidth && openFrame;
    const w = node.id === focusedId
      ? narrowFocusWidth
        ? Math.min(Math.max(280, narrowFocusWidth), Math.max(node.w, FOCUSED_SESSION_MIN_SIZE.w))
        // Opened at its frame, the drawer takes a share of that width; without one it widens the node by its own width.
        : opened && exact ? opened.w
        : Math.max(node.w, opened ? opened.w : FOCUSED_SESSION_MIN_SIZE.w + (deliverablesShown(node) ? DELIVERY_DRAWER_WIDTH : 0))
      : card?.w ?? COMPACT_SESSION_SIZE.w;
    const h = node.id !== focusedId ? card?.h ?? COMPACT_SESSION_SIZE.h
      : opened && exact ? opened.h : Math.max(node.h, opened ? opened.h : 0, FOCUSED_SESSION_MIN_SIZE.h);
    return node.w === w && node.h === h ? node : { ...node, w, h };
  });
}

/**
 * Each node's step in the graph: its longest path from a node with no inputs. Cycles and their
 * unresolved descendants share one step after every other, so malformed graphs still terminate.
 * Wires to missing nodes and duplicate wires are ignored.
 */
export function nodeDepths(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>): Map<string, number> {
  const ids = new Set(nodes.map(node => node.id));
  const outgoing = new Map(nodes.map(node => [node.id, new Set<string>()]));
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  const rank = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    if (!ids.has(edge.fromNode) || !ids.has(edge.toNode)) continue;
    const targets = outgoing.get(edge.fromNode)!;
    if (targets.has(edge.toNode)) continue;
    targets.add(edge.toNode);
    indegree.set(edge.toNode, indegree.get(edge.toNode)! + 1);
  }
  const ready = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  const visited = new Set<string>();
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index];
    visited.add(id);
    for (const target of outgoing.get(id)!) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      const pending = indegree.get(target)! - 1;
      indegree.set(target, pending);
      if (pending === 0) ready.push(target);
    }
  }
  const fallbackRank = ready.reduce((max, id) => Math.max(max, rank.get(id)!), -1) + 1;
  return new Map(nodes.map(node => [node.id, visited.has(node.id) ? rank.get(node.id)! : fallbackRank]));
}

/**
 * Explicit, reversible graph layout. Longest-path layers (nodeDepths) keep every DAG dependency
 * moving right; stable source order keeps peers predictable. Only positions change. Sessions are
 * laid out at their compact presentation size; forms use their actual dimensions, which can
 * enlarge column and row spacing.
 */
export function arrangeNodePositions(nodes: ReadonlyArray<CanvasNode>, edges: ReadonlyArray<CanvasEdge>): CanvasNode[] {
  const depths = nodeDepths(nodes, edges);
  const layers = new Map<number, CanvasNode[]>();
  for (const node of nodes) {
    const layer = depths.get(node.id)!;
    const peers = layers.get(layer) || [];
    peers.push(node);
    layers.set(layer, peers);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let x = 80;
  for (const [, peers] of [...layers.entries()].sort(([left], [right]) => left - right)) {
    let y = 80;
    let columnWidth: number = COMPACT_SESSION_SIZE.w;
    for (const node of peers) {
      positions.set(node.id, { x, y });
      const width = node.kind === 'form' ? node.w : COMPACT_SESSION_SIZE.w;
      const height = node.kind === 'form' ? node.h : COMPACT_SESSION_SIZE.h;
      columnWidth = Math.max(columnWidth, width);
      y += Math.max(COMPACT_SESSION_SIZE.h, height) + 68;
    }
    x += columnWidth + 100;
  }
  return nodes.map(node => {
    const position = positions.get(node.id)!;
    return node.x === position.x && node.y === position.y ? node : { ...node, ...position };
  });
}
