// 多人同屏's live lane drawn on the board (liveLane.ts): where others' drags put the cards. The canvas surface draws its
// cards from the document; the cards another person moves are carried over to their place with a CSS translate (no
// layout property moves, MOTION.md), and the wires and the board's marks follow in their own layers, so nothing but
// those draws again on each frame of someone else's drag.
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { CanvasLiveLane, LaneBox } from './liveLane';

const NO_MOVES: ReadonlyMap<string, LaneBox> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();
const noSubscription = () => () => {};
const noMoves = () => NO_MOVES;
const noIds = () => NO_IDS;

/** What the board's other layers need to carry a node as its card is carried: where each card is drawn, the cards this
 *  page leaves alone (its own gesture's, the one it has open), and the cards drawn at their own size (where the outline
 *  of a resize means something: not a conversation's compact card, nor an icon). */
export interface LaneCarry {
  drawn: ReadonlyMap<string, { x: number; y: number }>;
  excluded: (id: string) => boolean;
  ownSize: (id: string) => boolean;
}

/** The nodes others' edits in progress move, kept current in a component; a new set only as one comes or goes. */
export function useLaneMovedIds(lane: CanvasLiveLane | null | undefined): ReadonlySet<string> {
  return useSyncExternalStore(lane ? lane.subscribe : noSubscription, lane ? lane.movedIds : noIds, noIds);
}

/** Where others' edits in progress put nodes now, kept current in a component. */
export function useLaneMoves(lane: CanvasLiveLane | null | undefined): ReadonlyMap<string, LaneBox> {
  return useSyncExternalStore(lane ? lane.subscribe : noSubscription, lane ? lane.moves : noMoves, noMoves);
}

/** How far a move carries a node from where it is drawn (`base`, its own place on the board), or null for none. */
export function laneOffset(move: LaneBox | undefined, base: { x: number; y: number } | undefined): { dx: number; dy: number } | null {
  if (!move || !base) return null;
  const dx = (move.x ?? base.x) - base.x;
  const dy = (move.y ?? base.y) - base.y;
  return dx || dy ? { dx, dy } : null;
}

/** Nodes carried by others' moves, each by its offset from its own place (`drawn`); the rest as they were. */
export function carried<T extends { id: string; x: number; y: number }>(nodes: readonly T[], moves: ReadonlyMap<string, LaneBox>,
  drawn: ReadonlyMap<string, { x: number; y: number }>, excluded: (id: string) => boolean): readonly T[] {
  if (!moves.size) return nodes;
  let changed = false;
  const out = nodes.map(node => {
    const offset = excluded(node.id) ? null : laneOffset(moves.get(node.id), drawn.get(node.id));
    if (!offset) return node;
    changed = true;
    return { ...node, x: node.x + offset.dx, y: node.y + offset.dy };
  });
  return changed ? out : nodes;
}

/**
 * Carries the cards others move to where they are, with a translate on each card (`.canvas-tile`, a card's
 * data-node-id or an icon's data-node-icon), measured from where the card is drawn (`drawn`, its node's place). A card
 * this page moves itself, or has open, is left alone (`excluded`). Drawn inside the board's world.
 */
export function LaneCards({ lane, drawn, excluded }: {
  lane: CanvasLiveLane | null | undefined; drawn: ReadonlyMap<string, { x: number; y: number }>; excluded: (id: string) => boolean;
}) {
  const moves = useLaneMoves(lane);
  const marker = useRef<HTMLSpanElement>(null);
  const carriedCards = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    const world = marker.current?.closest('.canvas-world');
    const next = new Map<string, HTMLElement>();
    if (world && moves.size) {
      for (const card of world.querySelectorAll<HTMLElement>('.canvas-tile')) {
        const id = card.dataset.nodeId ?? card.dataset.nodeIcon;
        if (!id || !moves.has(id) || excluded(id)) continue;
        const offset = laneOffset(moves.get(id), drawn.get(id));
        if (!offset) continue;
        card.style.translate = `${offset.dx}px ${offset.dy}px`;
        next.set(id, card);
      }
    }
    for (const [id, card] of carriedCards.current) if (next.get(id) !== card) card.style.translate = '';
    carriedCards.current = next;
  });
  useLayoutEffect(() => () => {
    for (const card of carriedCards.current.values()) card.style.translate = '';
    carriedCards.current = new Map();
  }, []);
  return <span ref={marker} hidden />;
}

/** The wires drawn with the cards others move: `children` draws them from nodes carried as the cards are. */
export function LaneWires<T extends { id: string; x: number; y: number }>({ lane, nodes, drawn, excluded, children }: {
  lane: CanvasLiveLane | null | undefined; nodes: readonly T[]; drawn: ReadonlyMap<string, { x: number; y: number }>;
  excluded: (id: string) => boolean; children: (nodes: readonly T[]) => ReactNode;
}) {
  const moves = useLaneMoves(lane);
  const shown = useMemo(() => carried(nodes, moves, drawn, excluded), [nodes, moves, drawn, excluded]);
  return <>{children(shown)}</>;
}
