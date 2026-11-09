// 多人同屏 on the board (docs/awwo-canvas-live-collaboration.md, The canvas page): a ring in each other participant's
// colour around the nodes they have selected or are on, with their name (and 「正在编辑」 on a node one of them is typing
// in); a claim's badge on its node; each other person's pointer with their name, and the wire they are drawing; a short
// glow on a node someone else just changed.
//
// It is drawn inside the canvas world, in world coordinates, and takes no pointer events, so it never steals a click
// or a drag from the cards under it. It is cheap: it reads no layout (every place comes from the nodes' boxes and the
// participants' states); a node's marks are drawn again only when what they show changes, so the pointers' moves (five
// a second a person) redraw the pointers alone; and its names, badges and pointers keep their size on screen at any
// zoom through one custom property (--mp-inv, 1/zoom) instead of a measurement. The panel says the same in words, so
// the layer is hidden from assistive technology.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Bot } from 'lucide-react';
import type { CanvasNode } from '../canvasDoc';
import type { LiveClaim, LiveParticipant } from './types';
import type { LaneBox, LaneEditor, LaneWire } from './liveLane';
import { laneOffset, type LaneCarry } from './LaneLayer';
import { glideArrived, glideToward, reducedMotion, type Glide } from './laneMotion';
import { participantColorStyle } from './MultiplayerBar';
import { mt, useMultiplayerText } from './multiplayerText';
import './multiplayer.css';

/** A node's box as the board draws it; `round` for a component drawn as its icon (图标视图): its marks ring the plate. */
export interface BoardNodeBox { id: string; x: number; y: number; w: number; h: number; round?: boolean }
/** The box of a node the board hands a host (host.ts boardLayer): where it is drawn, and round for an icon's plate. */
export const boardBoxOf = (node: Pick<CanvasNode, 'id' | 'x' | 'y' | 'w' | 'h'> & { round?: boolean }): BoardNodeBox =>
  ({ id: node.id, x: node.x, y: node.y, w: node.w, h: node.h, ...(node.round ? { round: true } : {}) });
/** A node another participant just changed: it glows in their colour until `until` (ms since the epoch). */
export interface BoardFlash { nodeId: string; color: string; until: number }

export interface MultiplayerBoardLayerProps {
  participants: readonly LiveParticipant[];
  /** This page's own participant id: its own selection and pointer are the board's, not this layer's. */
  selfId: string;
  claims: readonly LiveClaim[];
  /** The nodes the board draws now, in world coordinates. */
  nodes: readonly BoardNodeBox[];
  flashes: readonly BoardFlash[];
  /** The clock (ms since the epoch): flashes and claims past it are not drawn. The caller's clock may stand still
   *  between its ticks: a claim still goes at its end, by a timer of the layer's own. */
  now: number;
  /** The board's zoom, so names, badges and pointers keep their size on screen. Absent, the layer reads it from the
   *  canvas world it is drawn in (the transform CanvasViewport gives the world), and takes 1 outside one. */
  scale?: number;
  /** The wires others are drawing now (liveLane.ts). */
  wires?: readonly LaneWire[];
  /** Who else types in a field, by node (liveLane.ts): the node wears their ring and 「正在编辑」. */
  editors?: ReadonlyMap<string, readonly LaneEditor[]>;
  /** Where others' edits in progress put nodes (liveLane.ts): a card's marks go with it, and a resize is drawn as the
   *  outline of the size it is taking. */
  moves?: ReadonlyMap<string, LaneBox>;
  /** How the canvas carries its cards (LaneLayer.tsx): the marks go by the same offsets, where the cards go, and a
   *  resize is outlined only on a card drawn at its own size. Absent, marks go to the moves' places. */
  carry?: LaneCarry;
}

/** A participant with more marked nodes than this is named on the first only (their focus, else their first selected). */
const TAGGED_NODES = 3;
/** setTimeout's longest wait; a claim lasts ten minutes at most. */
const MAX_TIMER_MS = 2_147_483_647;
/** The zoom in CanvasViewport's world transform (viewport.ts worldTransform): translate(…) scale(s). */
const WORLD_SCALE = /scale\(\s*([^\s)]+)\s*\)/;

/** One participant's ring on one node, as it is drawn: what a pointer's move changes is not in it. */
interface Ring { id: string; kind: LiveParticipant['kind']; name: string; color: string; tagged: boolean; editing?: boolean }
const NO_RINGS: readonly Ring[] = [];
const NO_WIRES: readonly LaneWire[] = [];
const NO_EDITORS: ReadonlyMap<string, readonly LaneEditor[]> = new Map();
const NO_MOVES: ReadonlyMap<string, LaneBox> = new Map();

const finite = (value: number) => Number.isFinite(value) ? value : 0;

/** The rings each node wears: everyone else who has it selected or is on it, in the participants' order; one typing in
 *  a field of a node rings it too, tagged 「正在编辑」. */
function ringsByNode(participants: readonly LiveParticipant[], selfId: string, boxes: ReadonlyMap<string, BoardNodeBox>,
  editors: ReadonlyMap<string, readonly LaneEditor[]> = NO_EDITORS): Map<string, Ring[]> {
  const rings = new Map<string, Ring[]>();
  const typing = new Map<string, string>();
  for (const [node, list] of editors) for (const editor of list) typing.set(editor.participantId, node);
  for (const participant of participants) {
    if (participant.id === selfId) continue;
    const focus = participant.state?.focus ?? null;
    const editing = typing.get(participant.id);
    const marked: string[] = [];
    for (const id of [...(editing ? [editing] : []), ...(focus ? [focus] : []), ...(participant.state?.selection ?? [])]) {
      if (typeof id === 'string' && boxes.has(id) && !marked.includes(id)) marked.push(id);
    }
    marked.forEach((id, index) => {
      const list = rings.get(id) ?? [];
      list.push({ id: participant.id, kind: participant.kind, name: typeof participant.name === 'string' ? participant.name : '', color: participant.color,
        tagged: marked.length <= TAGGED_NODES || index === 0 || id === editing, ...(id === editing ? { editing: true } : {}) });
      rings.set(id, list);
    });
  }
  return rings;
}

const sameRing = (a: Ring, b: Ring) => a.id === b.id && a.kind === b.kind && a.name === b.name && a.color === b.color && a.tagged === b.tagged
  && Boolean(a.editing) === Boolean(b.editing);
const sameRings = (a: readonly Ring[], b: readonly Ring[]) => a === b || (a.length === b.length && a.every((ring, index) => sameRing(ring, b[index])));
const sameBox = (a: BoardNodeBox, b: BoardNodeBox) => a === b || (a.id === b.id && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
  && Boolean(a.round) === Boolean(b.round));

/** A node's first claim that still holds now. */
function claimsByNode(claims: readonly LiveClaim[], boxes: ReadonlyMap<string, BoardNodeBox>, now: number): Map<string, LiveClaim> {
  const held = new Map<string, LiveClaim>();
  for (const claim of claims) {
    const expires = Date.parse(claim.expiresAt);
    if (!boxes.has(claim.nodeId) || held.has(claim.nodeId) || (!Number.isNaN(expires) && expires <= now)) continue;
    held.set(claim.nodeId, claim);
  }
  return held;
}

/** A node's latest glow that has not run out. */
function flashesByNode(flashes: readonly BoardFlash[], boxes: ReadonlyMap<string, BoardNodeBox>, now: number): Map<string, BoardFlash> {
  const lit = new Map<string, BoardFlash>();
  for (const flash of flashes) {
    if (!boxes.has(flash.nodeId) || !(flash.until > now)) continue;
    const earlier = lit.get(flash.nodeId);
    if (!earlier || flash.until > earlier.until) lit.set(flash.nodeId, flash);
  }
  return lit;
}

interface NodeMarkProps { box: BoardNodeBox; rings: readonly Ring[]; claim: LiveClaim | undefined; claimColor: string | undefined; flash: BoardFlash | undefined }

const NodeMark = memo(function NodeMark({ box, rings, claim, claimColor, flash }: NodeMarkProps) {
  const { locale } = useMultiplayerText();
  const tagged = rings.filter(ring => ring.tagged);
  // --mp-rings lifts the names and the claim's badge clear of the outermost ring. Round (an icon): the rings follow its
  // plate, and the names and the badge are centred over it, the badge above the names (data-tagged says they are there).
  return <div className="awwo-multiplayer-mark" data-node={box.id} data-round={box.round ? '' : undefined}
    data-tagged={tagged.length > 0 ? '' : undefined}
    style={{ transform: `translate(${finite(box.x)}px, ${finite(box.y)}px)`, width: Math.max(0, finite(box.w)), height: Math.max(0, finite(box.h)),
      '--mp-rings': rings.length } as CSSProperties}>
    {/* Keyed by its end, so a newer change on the same node glows again from the start. */}
    {flash && <span key={flash.until} className="awwo-multiplayer-flash" style={participantColorStyle(flash.color)} />}
    {rings.map((ring, index) => <span key={ring.id} className="awwo-multiplayer-ring" data-participant={ring.id}
      style={{ ...participantColorStyle(ring.color), '--mp-ring': index } as CSSProperties} />)}
    {tagged.length > 0 && <div className="awwo-multiplayer-tags">
      {/* AwwO's own Agent is named after the node it runs: over that node it is the AwwO Agent. */}
      {tagged.map(ring => <span key={ring.id} className="awwo-multiplayer-tag" data-participant={ring.id} data-kind={ring.kind}
        data-editing={ring.editing || undefined} style={participantColorStyle(ring.color)}>{ring.kind === 'awwo' ? mt(locale, 'kind.awwo')
          : ring.editing ? mt(locale, 'editing.board', { name: ring.name.trim() || mt(locale, 'someone') }) : ring.name.trim() || mt(locale, 'someone')}</span>)}
    </div>}
    {claim && <span className="awwo-multiplayer-claim" data-participant={claim.participantId} data-holder={claim.holderKind}
      style={participantColorStyle(claimColor)}>
      {claim.holderKind === 'agent' && <Bot size={11} strokeWidth={2.4} aria-hidden="true" />}
      <span>{mt(locale, 'board.claim', { name: claim.name.trim() || mt(locale, 'someone') })}</span>
    </span>}
  </div>;
}, (a, b) => sameBox(a.box, b.box) && sameRings(a.rings, b.rings) && a.claim === b.claim && a.claimColor === b.claimColor && a.flash === b.flash);

/** A pointer this close to where it goes (in board units), and this slow, is there. */
const POINTER_ARRIVED = 0.5;

/** Moves an element to each place heard on the language's glide spring (laneMotion.ts), as the lane carries the cards and
 *  wire ends a person holds, so the hand and what it holds move as one. Drawn first where it is first heard; reduced
 *  motion puts it at each place at once. */
function useGlidedPlace(ref: RefObject<HTMLElement | null>, x: number, y: number): void {
  const glide = useRef<{ x: Glide; y: Glide; to: { x: number; y: number }; frame: number | null; last: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const put = (px: number, py: number) => { element.style.transform = `translate(${px}px, ${py}px)`; };
    const current = glide.current;
    if (!current || reducedMotion() || typeof requestAnimationFrame !== 'function') {
      if (current?.frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(current.frame);
      glide.current = { x: { at: x, speed: 0 }, y: { at: y, speed: 0 }, to: { x, y }, frame: null, last: 0 };
      put(x, y);
      return;
    }
    current.to = { x, y };
    if (current.frame !== null) return;
    const step = (time: number) => {
      const state = glide.current;
      if (!state) return;
      // Reduced motion asked for while it glides: it is where it goes, at once.
      if (reducedMotion()) {
        state.x = { at: state.to.x, speed: 0 }; state.y = { at: state.to.y, speed: 0 }; state.frame = null; state.last = 0;
        put(state.to.x, state.to.y);
        return;
      }
      const dt = state.last ? Math.max(0, time - state.last) / 1000 : 1 / 60;
      state.last = time;
      state.x = glideToward(state.x, state.to.x, dt);
      state.y = glideToward(state.y, state.to.y, dt);
      const there = glideArrived(state.x, state.to.x, POINTER_ARRIVED) && glideArrived(state.y, state.to.y, POINTER_ARRIVED);
      if (there) { state.x = { at: state.to.x, speed: 0 }; state.y = { at: state.to.y, speed: 0 }; state.last = 0; }
      put(state.x.at, state.y.at);
      state.frame = there ? null : requestAnimationFrame(step);
    };
    current.frame = requestAnimationFrame(step);
  }, [ref, x, y]);
  useEffect(() => () => {
    const state = glide.current;
    if (state?.frame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.frame);
    glide.current = null;
  }, []);
}

const Cursor = memo(function Cursor({ participant, x, y }: { participant: LiveParticipant; x: number; y: number }) {
  const { locale } = useMultiplayerText();
  const ref = useRef<HTMLDivElement>(null);
  // The place glides after each one heard (useGlidedPlace: React writes only the first); the drawing keeps its size on
  // screen.
  const [first] = useState(() => `translate(${x}px, ${y}px)`);
  useGlidedPlace(ref, x, y);
  return <div ref={ref} className="awwo-multiplayer-cursor" data-participant={participant.id} style={{ transform: first }}>
    <div className="awwo-multiplayer-cursor-body" style={participantColorStyle(participant.color)}>
      <svg className="awwo-multiplayer-pointer" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M2 1.5 L15.5 8.4 L9.4 9.8 L6.6 15.6 Z" />
      </svg>
      <span className="awwo-multiplayer-cursor-name">{participant.name.trim() || mt(locale, 'someone')}</span>
    </div>
  </div>;
});

/** The clock the layer draws by: the caller's, moved on to a claim's end when that comes before the caller's next tick. */
function useClaimClock(now: number, claims: readonly LiveClaim[], boxes: ReadonlyMap<string, BoardNodeBox>): number {
  // When the caller's clock last moved, in this page's own time: how far it has come since is measured from there.
  const anchor = useRef({ given: now, at: 0 });
  useEffect(() => { anchor.current = { given: now, at: Date.now() }; }, [now]);
  const [reached, setReached] = useState(Number.NEGATIVE_INFINITY);
  const clock = Math.max(now, reached);
  useEffect(() => {
    let next = Number.POSITIVE_INFINITY;
    for (const claim of claims) {
      const ends = Date.parse(claim.expiresAt);
      if (boxes.has(claim.nodeId) && ends > clock && ends < next) next = ends;
    }
    if (next === Number.POSITIVE_INFINITY) return undefined;
    const current = anchor.current.given + (Date.now() - anchor.current.at);
    const timer = window.setTimeout(() => setReached(next), Math.min(MAX_TIMER_MS, Math.max(0, next - current)));
    return () => window.clearTimeout(timer);
  }, [claims, boxes, clock]);
  return clock;
}

/** A wire someone is drawing, from its port to their pointer: a dashed curve in their colour, as wires leave and enter
 *  ports sideways. */
const DrawnWire = memo(function DrawnWire({ wire }: { wire: LaneWire }) {
  const { from, to } = wire;
  const reach = Math.max(40, Math.abs(to.x - from.x) / 2);
  const d = `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
  return <path className="awwo-multiplayer-wire" data-participant={wire.participantId} d={d} style={participantColorStyle(wire.color)} />;
});

/** The other participants on the board: rings, names, claims, pointers, wires being drawn and glows, in world
 *  coordinates. */
export const MultiplayerBoardLayer = memo(function MultiplayerBoardLayer({ participants, selfId, claims, nodes, flashes, now, scale, wires = NO_WIRES,
  editors = NO_EDITORS, moves = NO_MOVES, carry }: MultiplayerBoardLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  // A card someone else moves takes its marks along, by the offset its card is carried by (an icon's plate too), and
  // none where this page leaves the card alone.
  const boxes = useMemo(() => {
    const map = new Map<string, BoardNodeBox>();
    for (const box of nodes) {
      if (map.has(box.id)) continue;
      const move = moves.get(box.id);
      if (!move) { map.set(box.id, box); continue; }
      if (!carry) { map.set(box.id, box.round ? box : { ...box, x: move.x ?? box.x, y: move.y ?? box.y }); continue; }
      const offset = carry.excluded(box.id) ? null : laneOffset(move, carry.drawn.get(box.id));
      map.set(box.id, offset ? { ...box, x: box.x + offset.dx, y: box.y + offset.dy } : box);
    }
    return map;
  }, [nodes, moves, carry]);
  // A resize is outlined where the card shows the size it is taking: drawn at its own size, as a card, not left alone.
  const resizes = useMemo(() => [...moves].filter(([id, move]) => move.resize && move.w !== undefined && move.h !== undefined
    && boxes.has(id) && !boxes.get(id)!.round && (!carry || (!carry.excluded(id) && carry.ownSize(id)))), [moves, boxes, carry]);
  const clock = useClaimClock(now, claims, boxes);
  const rings = useMemo(() => ringsByNode(participants, selfId, boxes, editors), [participants, selfId, boxes, editors]);
  const colors = useMemo(() => new Map(participants.map(participant => [participant.id, participant.color])), [participants]);
  const held = useMemo(() => claimsByNode(claims, boxes, clock), [claims, boxes, clock]);
  const lit = useMemo(() => flashesByNode(flashes, boxes, clock), [flashes, boxes, clock]);
  // Pointers are people's: an Agent has none, and this page's own is the real one.
  const cursors = useMemo(() => participants.flatMap(participant => {
    const cursor = participant.state?.cursor;
    return participant.id !== selfId && participant.kind === 'human' && cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
      ? [{ participant, x: cursor.x, y: cursor.y }] : [];
  }), [participants, selfId]);
  // No zoom given: the world's own transform tells it, read as it changes (a string, not a measurement), and only a
  // changed zoom touches the layer's style; a pan leaves it alone.
  useEffect(() => {
    const layer = layerRef.current;
    const world = layer?.parentElement?.closest<HTMLElement>('.canvas-world');
    if (scale !== undefined || !layer || !world) return undefined;
    let shown = '';
    const read = () => {
      const zoom = Number(WORLD_SCALE.exec(world.style.transform)?.[1] ?? 1);
      const inverse = String(Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1);
      if (inverse !== shown) { shown = inverse; layer.style.setProperty('--mp-inv', inverse); }
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(world, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [scale]);
  const marked = new Set([...rings.keys(), ...held.keys(), ...lit.keys()]);
  const zoom = scale !== undefined && Number.isFinite(scale) && scale > 0 ? scale : 1;
  // pointer-events is inherited: written here too, the layer never takes a press even before its stylesheet loads.
  const style = (scale === undefined ? { pointerEvents: 'none' } : { '--mp-inv': 1 / zoom, pointerEvents: 'none' }) as CSSProperties;
  return <div className="awwo-multiplayer-board" ref={layerRef} aria-hidden="true" style={style}>
    {[...marked].map(id => {
      const claim = held.get(id);
      return <NodeMark key={id} box={boxes.get(id)!} rings={rings.get(id) ?? NO_RINGS} claim={claim}
        claimColor={claim ? colors.get(claim.participantId) : undefined} flash={lit.get(id)} />;
    })}
    {(wires.length > 0 || resizes.length > 0) && <svg className="awwo-multiplayer-wires" aria-hidden="true" focusable="false">
      {wires.map(wire => <DrawnWire key={wire.participantId} wire={wire} />)}
      {resizes.map(([id, move]) => <rect key={id} className="awwo-multiplayer-resize" data-node={id} x={move.x} y={move.y} width={move.w} height={move.h}
        rx={8} style={participantColorStyle(move.color)} />)}
    </svg>}
    {cursors.map(({ participant, x, y }) => <Cursor key={participant.id} participant={participant} x={x} y={y} />)}
  </div>;
});
