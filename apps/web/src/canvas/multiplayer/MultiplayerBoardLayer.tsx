// 多人同屏 on the board (docs/awwo-canvas-live-collaboration.md, The canvas page): a ring in each other participant's
// colour around the nodes they have selected or are on, with their name; a claim's badge on its node; each other
// person's pointer with their name; a short glow on a node someone else just changed.
//
// It is drawn inside the canvas world, in world coordinates, and takes no pointer events, so it never steals a click
// or a drag from the cards under it. It is cheap: it reads no layout (every place comes from the nodes' boxes and the
// participants' states); a node's marks are drawn again only when what they show changes, so the pointers' moves (five
// a second a person) redraw the pointers alone; and its names, badges and pointers keep their size on screen at any
// zoom through one custom property (--mp-inv, 1/zoom) instead of a measurement. The panel says the same in words, so
// the layer is hidden from assistive technology.
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Bot } from 'lucide-react';
import type { LiveClaim, LiveParticipant } from './types';
import { participantColorStyle } from './MultiplayerBar';
import { mt, useMultiplayerText } from './multiplayerText';
import './multiplayer.css';

export interface BoardNodeBox { id: string; x: number; y: number; w: number; h: number }
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
}

/** A participant with more marked nodes than this is named on the first only (their focus, else their first selected). */
const TAGGED_NODES = 3;
/** setTimeout's longest wait; a claim lasts ten minutes at most. */
const MAX_TIMER_MS = 2_147_483_647;
/** The zoom in CanvasViewport's world transform (viewport.ts worldTransform): translate(…) scale(s). */
const WORLD_SCALE = /scale\(\s*([^\s)]+)\s*\)/;

/** One participant's ring on one node, as it is drawn: what a pointer's move changes is not in it. */
interface Ring { id: string; kind: LiveParticipant['kind']; name: string; color: string; tagged: boolean }
const NO_RINGS: readonly Ring[] = [];

const finite = (value: number) => Number.isFinite(value) ? value : 0;

/** The rings each node wears: everyone else who has it selected or is on it, in the participants' order. */
function ringsByNode(participants: readonly LiveParticipant[], selfId: string, boxes: ReadonlyMap<string, BoardNodeBox>): Map<string, Ring[]> {
  const rings = new Map<string, Ring[]>();
  for (const participant of participants) {
    if (participant.id === selfId) continue;
    const focus = participant.state?.focus ?? null;
    const marked: string[] = [];
    for (const id of [...(focus ? [focus] : []), ...(participant.state?.selection ?? [])]) {
      if (typeof id === 'string' && boxes.has(id) && !marked.includes(id)) marked.push(id);
    }
    marked.forEach((id, index) => {
      const list = rings.get(id) ?? [];
      list.push({ id: participant.id, kind: participant.kind, name: typeof participant.name === 'string' ? participant.name : '', color: participant.color,
        tagged: marked.length <= TAGGED_NODES || index === 0 });
      rings.set(id, list);
    });
  }
  return rings;
}

const sameRing = (a: Ring, b: Ring) => a.id === b.id && a.kind === b.kind && a.name === b.name && a.color === b.color && a.tagged === b.tagged;
const sameRings = (a: readonly Ring[], b: readonly Ring[]) => a === b || (a.length === b.length && a.every((ring, index) => sameRing(ring, b[index])));
const sameBox = (a: BoardNodeBox, b: BoardNodeBox) => a === b || (a.id === b.id && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

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
  // --mp-rings lifts the names and the claim's badge clear of the outermost ring.
  return <div className="awwo-multiplayer-mark" data-node={box.id}
    style={{ transform: `translate(${finite(box.x)}px, ${finite(box.y)}px)`, width: Math.max(0, finite(box.w)), height: Math.max(0, finite(box.h)),
      '--mp-rings': rings.length } as CSSProperties}>
    {/* Keyed by its end, so a newer change on the same node glows again from the start. */}
    {flash && <span key={flash.until} className="awwo-multiplayer-flash" style={participantColorStyle(flash.color)} />}
    {rings.map((ring, index) => <span key={ring.id} className="awwo-multiplayer-ring" data-participant={ring.id}
      style={{ ...participantColorStyle(ring.color), '--mp-ring': index } as CSSProperties} />)}
    {tagged.length > 0 && <div className="awwo-multiplayer-tags">
      {/* AwwO's own Agent is named after the node it runs: over that node it is the AwwO Agent. */}
      {tagged.map(ring => <span key={ring.id} className="awwo-multiplayer-tag" data-participant={ring.id} data-kind={ring.kind}
        style={participantColorStyle(ring.color)}>{ring.kind === 'awwo' ? mt(locale, 'kind.awwo') : ring.name.trim() || mt(locale, 'someone')}</span>)}
    </div>}
    {claim && <span className="awwo-multiplayer-claim" data-participant={claim.participantId} data-holder={claim.holderKind}
      style={participantColorStyle(claimColor)}>
      {claim.holderKind === 'agent' && <Bot size={11} strokeWidth={2.4} aria-hidden="true" />}
      <span>{mt(locale, 'board.claim', { name: claim.name.trim() || mt(locale, 'someone') })}</span>
    </span>}
  </div>;
}, (a, b) => sameBox(a.box, b.box) && sameRings(a.rings, b.rings) && a.claim === b.claim && a.claimColor === b.claimColor && a.flash === b.flash);

const Cursor = memo(function Cursor({ participant, x, y }: { participant: LiveParticipant; x: number; y: number }) {
  const { locale } = useMultiplayerText();
  // The place moves (smoothly, between the 5 updates a second a person sends); the drawing keeps its size on screen.
  return <div className="awwo-multiplayer-cursor" data-participant={participant.id} style={{ transform: `translate(${x}px, ${y}px)` }}>
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

/** The other participants on the board: rings, names, claims, pointers and glows, in world coordinates. */
export const MultiplayerBoardLayer = memo(function MultiplayerBoardLayer({ participants, selfId, claims, nodes, flashes, now, scale }: MultiplayerBoardLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const boxes = useMemo(() => {
    const map = new Map<string, BoardNodeBox>();
    for (const box of nodes) if (!map.has(box.id)) map.set(box.id, box);
    return map;
  }, [nodes]);
  const clock = useClaimClock(now, claims, boxes);
  const rings = useMemo(() => ringsByNode(participants, selfId, boxes), [participants, selfId, boxes]);
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
    {cursors.map(({ participant, x, y }) => <Cursor key={participant.id} participant={participant} x={x} y={y} />)}
  </div>;
});
