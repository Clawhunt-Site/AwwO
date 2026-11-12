// 多人同屏's live lane on this page (docs/awwo-canvas-live-collaboration.md, Presence): what the others are doing and
// have not saved yet, read from their presence, and the person this page follows.
//
// - Moves: where the others' drags and resizes put the nodes now. A card glides to each new place on the language's
//   glide spring (laneMotion.ts), keeping its speed as new places come eight times a second, so they read as one
//   motion (reduced motion: it is where it is put). When the edit ends it goes on to the last place it was put and
//   waits there for the change itself, which it goes to at once once the document has it; one that never comes (a
//   drag let go where it began, a change refused) glides home after 2 s. It is let go only once home and at rest. The
//   end of a wire someone draws glides too. Nothing runs while nothing moves (a card held still, or waiting).
// - Editors: who types in which field of which node, so their field and the node wear their name.
// - Following: the person whose screen this page shows (their avatar in the people bar), and what their screen shows.
//
// Nothing here touches the document, a change or an undo step: it is drawn over the board and forgotten.
import type { LiveParticipant, LivePreview, LiveViewport } from './types';
import { personKey, peopleOf } from './people';
import { glideArrived, glideToward, reducedMotion, type Glide } from './laneMotion';

/** How long an edit in progress is shown after its last update: the server's livePreviewFor. */
export const PREVIEW_SHOWN_MS = 2_000;
/** How long a node stays where an ended edit put it, waiting for the change to arrive. */
const SETTLE_MS = 2_000;
/** A drawn place this close to where it goes (in board units), and this slow, has arrived. */
const ARRIVED = 0.5;
/** A document's box this close to an edit's last place has the change of that edit (a preview's places are rounded). */
const LANDED = 1;

/** A node's place as another person's edit in progress puts it, in their colour; a resize (`resize`) with its size;
 *  `by` the participant whose edit it is. */
export interface LaneBox { x?: number; y?: number; w?: number; h?: number; color?: string; resize?: true; by?: string }
export interface LaneEditor { participantId: string; name: string; color: string; field: string }
export interface LaneWire { participantId: string; name: string; color: string; from: { x: number; y: number }; to: { x: number; y: number } }
export interface LaneFollowed { key: string; name: string; color: string; viewport: LiveViewport | null }

/** What the lane reads: the live connection's snapshot (canvasLive.ts) and its changes. */
export interface LaneSource {
  snapshot(): { participants: readonly LiveParticipant[]; heard?: ReadonlyMap<string, number> };
  subscribe(listener: () => void): () => void;
}

export interface CanvasLiveLane {
  subscribe(listener: () => void): () => void;
  /** Where others' edits in progress put nodes now (drawn places, gliding), by node. */
  moves(): ReadonlyMap<string, LaneBox>;
  /** The nodes in moves(), as a set that changes only as one comes or goes (a canvas keeps their cards drawn). */
  movedIds(): ReadonlySet<string>;
  /** Who else is typing in a field, by node. */
  editors(): ReadonlyMap<string, readonly LaneEditor[]>;
  /** The wires others are drawing now. */
  wires(): readonly LaneWire[];
  /** The person this page follows (their key, people.ts), or null. */
  following(): string | null;
  follow(key: string | null): void;
  /** The followed person as they are now, with what their screen shows (their page heard from last that says so). */
  followed(): LaneFollowed | null;
  /** The document changed: a node waiting for its change may have it now. */
  documentChanged(): void;
  /** This page's own gesture took these nodes over: they are drawn no more, and the edit that carried them is not drawn
   *  again until it puts them somewhere new. */
  release(ids: readonly string[]): void;
  stop(): void;
}

/** A participant's edit in progress while it is still shown: heard within PREVIEW_SHOWN_MS. */
export function freshPreview(participant: LiveParticipant, heard: ReadonlyMap<string, number> | undefined, now: number): LivePreview | null {
  const preview = participant.state?.preview;
  if (!preview || participant.kind !== 'human') return null;
  const at = heard?.get(participant.id);
  return at !== undefined && now - at <= PREVIEW_SHOWN_MS ? preview : null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Where the others' edits in progress put nodes (not this page's own), by node: the newest heard wins a node two move. */
export function previewTargets(participants: readonly LiveParticipant[], selfId: string, heard: ReadonlyMap<string, number> | undefined,
  now: number): Map<string, LaneBox> {
  const targets = new Map<string, LaneBox>();
  const ordered = [...participants].sort((a, b) => (heard?.get(a.id) ?? 0) - (heard?.get(b.id) ?? 0));
  for (const participant of ordered) {
    if (participant.id === selfId) continue;
    const preview = freshPreview(participant, heard, now);
    if (!preview) continue;
    const color = participant.color;
    for (const node of preview.nodes ?? []) {
      if (node && typeof node.id === 'string' && finite(node.x) && finite(node.y)) targets.set(node.id, { x: node.x, y: node.y, color, by: participant.id });
    }
    const box = preview.resize;
    if (box && typeof box.id === 'string' && finite(box.x) && finite(box.y) && finite(box.w) && finite(box.h) && box.w > 0 && box.h > 0) {
      targets.set(box.id, { x: box.x, y: box.y, w: box.w, h: box.h, color, resize: true, by: participant.id });
    }
  }
  return targets;
}

/** Who else types in which field, by node; this page's own person's other pages too (another tab of theirs). */
export function editorsOf(participants: readonly LiveParticipant[], selfId: string): Map<string, LaneEditor[]> {
  const editors = new Map<string, LaneEditor[]>();
  for (const participant of participants) {
    const editing = participant.state?.editing;
    if (participant.id === selfId || participant.kind !== 'human' || !editing || typeof editing.node !== 'string' || typeof editing.field !== 'string') continue;
    const list = editors.get(editing.node) ?? [];
    list.push({ participantId: participant.id, name: typeof participant.name === 'string' ? participant.name : '', color: participant.color, field: editing.field });
    editors.set(editing.node, list);
  }
  return editors;
}

/** The wires others are drawing now. */
export function wiresOf(participants: readonly LiveParticipant[], selfId: string, heard: ReadonlyMap<string, number> | undefined, now: number): LaneWire[] {
  const wires: LaneWire[] = [];
  for (const participant of participants) {
    if (participant.id === selfId) continue;
    const wire = freshPreview(participant, heard, now)?.wire;
    if (!wire || !finite(wire.from?.x) || !finite(wire.from?.y) || !finite(wire.to?.x) || !finite(wire.to?.y)) continue;
    wires.push({ participantId: participant.id, name: typeof participant.name === 'string' ? participant.name : '', color: participant.color,
      from: { x: wire.from.x, y: wire.from.y }, to: { x: wire.to.x, y: wire.to.y } });
  }
  return wires;
}

/** One node the lane draws: where it is drawn now and how fast each part moves, where it goes (null once the edit
 *  ended), the last place the edit put it (where it goes on to until the change arrives), and when the edit ended. The
 *  change has landed once the document has the node at that last place, whichever came first, the change or the end; a
 *  save from the middle of a drag (early, or late) is not it, and a change elsewhere is taken after the 2 s wait. */
interface Drawn {
  box: Required<Pick<LaneBox, 'x' | 'y'>> & LaneBox;
  speed: Partial<Record<'x' | 'y' | 'w' | 'h', number>>;
  target: LaneBox | null;
  last: LaneBox | null;
  endedAt: number | null;
}

/** The end of a wire someone draws, gliding after their pointer as their pointer and the cards do. */
interface DrawnEnd { wire: LaneWire; x: Glide; y: Glide }

const SIZES = ['x', 'y', 'w', 'h'] as const;
const PLACE = ['x', 'y'] as const;
/** Whether the document's box has the node where an edit last put it. */
const atPlace = (doc: LaneBox, place: LaneBox | null) => !!place && SIZES.every(key => place[key] === undefined
  || (doc[key] !== undefined && Math.abs(doc[key]! - place[key]!) <= LANDED));
const sameBox = (a: LaneBox | null | undefined, b: LaneBox | null | undefined) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.resize === b.resize);
const sameWires = (a: readonly LaneWire[], b: readonly LaneWire[]) => a.length === b.length && a.every((wire, index) => {
  const other = b[index];
  return wire.participantId === other.participantId && wire.color === other.color && wire.name === other.name
    && wire.from.x === other.from.x && wire.from.y === other.from.y && wire.to.x === other.to.x && wire.to.y === other.to.y;
});

/**
 * The lane of one canvas page. `nodeBox` gives a node's box as this page's document holds it (null for a node it does
 * not hold): a glide starts there, and an ended edit's node is let go once the document agrees.
 */
export function createLiveLane(source: LaneSource, selfId: string, nodeBox: (id: string) => LaneBox | null): CanvasLiveLane {
  const listeners = new Set<() => void>();
  let drawn = new Map<string, Drawn>();
  let ends = new Map<string, DrawnEnd>();
  let moves: ReadonlyMap<string, LaneBox> = new Map();
  let movedIds: ReadonlySet<string> = new Set();
  let editors: ReadonlyMap<string, readonly LaneEditor[]> = new Map();
  let wires: readonly LaneWire[] = [];
  let following: string | null = null;
  let followed: LaneFollowed | null = null;
  let frame: number | null = null;
  let lastFrame = 0;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  // Nodes this page's own gesture took over, with the edit that carried them (its participant and place; null when its
  // page had said it ended): that edit at that place is not drawn again, however long its page was not heard before or
  // since; a new place, an edit begun after its page said that one ended, or anyone else's edit, is.
  const released = new Map<string, LaneBox | null>();
  // When each page's screen last moved (its viewport changed): a followed person is shown by the page whose screen moved
  // last, never by one that only went quiet (a stream closing sends its page again, its old screen kept).
  const screens = new Map<string, { shows: string; at: number }>();
  // The page a followed person is shown by now: it stays theirs while no other page's screen moves later.
  let shownBy: string | null = null;
  let stopped = false;
  const emit = () => { for (const listener of [...listeners]) listener(); };
  /** Where a page's edit puts nodes as the page last said it, whether it was heard lately or not. */
  const saidBy = (participants: readonly LiveParticipant[], pageId: string, now: number): Map<string, LaneBox> => {
    const by = participants.find(participant => participant.id === pageId);
    return by ? previewTargets([by], selfId, new Map([[pageId, now]]), now) : new Map();
  };
  const publish = () => {
    const nextMoves = new Map<string, LaneBox>();
    for (const [id, item] of drawn) nextMoves.set(id, { ...item.box });
    // A place another person's edit takes over at the very same box is drawn again in their colour.
    const movesChanged = nextMoves.size !== moves.size || [...nextMoves].some(([id, box]) => {
      const was = moves.get(id);
      return !sameBox(box, was) || box.color !== was?.color;
    });
    if (movesChanged) moves = nextMoves;
    if (nextMoves.size !== movedIds.size || [...nextMoves.keys()].some(id => !movedIds.has(id))) movedIds = new Set(nextMoves.keys());
    const nextWires = [...ends.values()].map(end => ({ ...end.wire, to: { x: end.x.at, y: end.y.at } }));
    const wiresChanged = !sameWires(nextWires, wires);
    if (wiresChanged) wires = nextWires;
    return movesChanged || wiresChanged;
  };
  // Where a drawn node goes now: its edit's place; once the edit ended, on to the last place it put the node, or at
  // once wherever the document has it if the document moved it since the edit ended (the change has landed); and after
  // SETTLE_MS with no change come, home.
  const goalOf = (item: Drawn, doc: LaneBox | null, now: number): LaneBox | null => {
    if (item.target) return item.target;
    if (!doc) return null;
    if (atPlace(doc, item.last) || item.endedAt === null || now - item.endedAt > SETTLE_MS) return doc;
    return item.last ?? item.box;
  };
  // One frame of the glides, saying whether anything is still on its way. A node held still under its pointer, or
  // waiting for its change, is not: the loop rests until a new place comes (read), the document changes
  // (documentChanged) or a wait is over (wakeForHolds).
  const step = (dt: number): boolean => {
    const reduced = reducedMotion();
    const now = Date.now();
    let busy = false;
    for (const [id, item] of drawn) {
      const doc = nodeBox(id);
      const goal = goalOf(item, doc, now);
      if (!goal) { drawn.delete(id); continue; }
      // A drag moves a node's place; a resize its size too.
      const keys: readonly ('x' | 'y' | 'w' | 'h')[] = item.box.resize ? SIZES : PLACE;
      const next = { ...item.box };
      for (const key of keys) {
        const to = goal[key];
        const from = next[key] ?? doc?.[key];
        if (to === undefined || from === undefined) continue;
        const moved = reduced ? { at: to, speed: 0 } : glideToward({ at: from, speed: item.speed[key] ?? 0 }, to, dt);
        const there = glideArrived(moved, to, ARRIVED);
        next[key] = there ? to : moved.at;
        item.speed[key] = there ? 0 : moved.speed;
        if (!there) busy = true;
      }
      item.box = next as Drawn['box'];
      // Let go once its edit ended and it came home (the document's box) and to rest there: never on its way.
      if (item.target === null && goal === doc && keys.every(key => goal[key] === undefined || (next[key] === goal[key] && !item.speed[key]))) {
        drawn.delete(id);
      }
    }
    for (const end of ends.values()) {
      for (const key of PLACE) {
        const to = end.wire.to[key];
        end[key] = reduced ? { at: to, speed: 0 } : glideToward(end[key], to, dt);
        if (glideArrived(end[key], to, ARRIVED)) end[key] = { at: to, speed: 0 };
        else busy = true;
      }
    }
    return busy;
  };
  // A node waiting for its change goes home once the wait is over: the loop, resting meanwhile, wakes then.
  const wakeForHolds = () => {
    if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
    if (stopped) return;
    let due = Number.POSITIVE_INFINITY;
    for (const item of drawn.values()) if (item.target === null && item.endedAt !== null) due = Math.min(due, item.endedAt + SETTLE_MS);
    if (Number.isFinite(due)) holdTimer = setTimeout(() => { holdTimer = null; schedule(); }, Math.max(0, due - Date.now()) + 20);
  };
  const tick = (time: number) => {
    frame = null;
    if (stopped) return;
    const dt = lastFrame ? Math.max(0, time - lastFrame) / 1000 : 1 / 60;
    lastFrame = time;
    const busy = step(dt);
    if (publish()) emit();
    if (busy) schedule();
    else { lastFrame = 0; wakeForHolds(); }
  };
  const schedule = () => {
    if (frame !== null || stopped) return;
    if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(tick);
    else { step(Number.POSITIVE_INFINITY); if (publish()) emit(); wakeForHolds(); }
  };
  const read = () => {
    if (stopped) return;
    const { participants, heard } = source.snapshot();
    const now = Date.now();
    const targets = previewTargets(participants, selfId, heard, now);
    for (const [id, target] of targets) {
      if (released.has(id)) {
        const taken = released.get(id);
        if (taken && taken.by === target.by && sameBox(taken, target)) continue;
        released.delete(id);
      }
      const item = drawn.get(id);
      if (item) {
        item.target = target; item.last = target; item.endedAt = null;
        if (target.color) item.box.color = target.color;
        if (target.resize) item.box.resize = true;
        else { delete item.box.resize; delete item.box.w; delete item.box.h; }
        continue;
      }
      // A glide starts where the document has the node; a resize's size too (a drag's move carries no size).
      const doc = nodeBox(id);
      const sized = target.resize === true;
      drawn.set(id, { box: { x: doc?.x ?? target.x ?? 0, y: doc?.y ?? target.y ?? 0, ...(sized && doc?.w !== undefined ? { w: doc.w } : {}),
        ...(sized && doc?.h !== undefined ? { h: doc.h } : {}), ...(target.color ? { color: target.color } : {}), ...(sized ? { resize: true as const } : {}) },
      speed: {}, target, last: target, endedAt: null });
    }
    // A take-over is forgotten once the edit it took the node from is over: its page says so, or is gone. A page only
    // not heard for a while (a tab asleep, a link stalled) still says its edit: heard again at that place, it is the
    // same edit, and the node stays this page's.
    const said = new Map<string, Map<string, LaneBox>>();
    for (const [id, taken] of [...released]) {
      if (targets.has(id)) continue;
      if (taken?.by !== undefined) {
        // (Worked out once a read for each page.)
        let boxes = said.get(taken.by);
        if (!boxes) { boxes = saidBy(participants, taken.by, now); said.set(taken.by, boxes); }
        if (sameBox(taken, boxes.get(id))) continue;
      }
      released.delete(id);
    }
    for (const [id, item] of drawn) {
      if (!targets.has(id) && item.target !== null) {
        // An edit whose page went quiet ended at its last update (it is let go 2 s after that, not 2 s after it was
        // found stale); one that said it ended, now.
        const lastHeard = item.target.by === undefined ? undefined : heard?.get(item.target.by);
        item.target = null; item.endedAt = lastHeard === undefined ? now : Math.min(now, lastHeard);
      }
    }
    // The wires being drawn: a new one starts at its pointer, a known one glides after it, a finished one goes.
    const raw = wiresOf(participants, selfId, heard, now);
    const nextEnds = new Map<string, DrawnEnd>();
    for (const wire of raw) {
      const known = ends.get(wire.participantId);
      nextEnds.set(wire.participantId, known ? { ...known, wire } : { wire, x: { at: wire.to.x, speed: 0 }, y: { at: wire.to.y, speed: 0 } });
    }
    ends = nextEnds;
    const nextEditors = editorsOf(participants, selfId);
    const editorsChanged = JSON.stringify([...nextEditors]) !== JSON.stringify([...editors]);
    if (editorsChanged) editors = nextEditors;
    const present = new Set<string>();
    for (const participant of participants) {
      present.add(participant.id);
      const viewport = participant.state?.viewport;
      if (!viewport) { screens.delete(participant.id); continue; }
      const shows = JSON.stringify(viewport);
      if (screens.get(participant.id)?.shows !== shows) screens.set(participant.id, { shows, at: now });
    }
    for (const id of [...screens.keys()]) if (!present.has(id)) screens.delete(id);
    let followChanged = false;
    if (following) {
      const person = peopleOf(participants, selfId, heard).find(candidate => candidate.key === following);
      if (!person) { following = null; followed = null; shownBy = null; followChanged = true; }
      else {
        const showing = person.pages.filter(candidate => candidate.state?.viewport);
        const page = showing.reduce<LiveParticipant | undefined>((last, candidate) =>
          !last || (screens.get(candidate.id)?.at ?? 0) > (screens.get(last.id)?.at ?? 0) ? candidate : last,
        showing.find(candidate => candidate.id === shownBy)) ?? person.lead;
        shownBy = page.id;
        const next: LaneFollowed = { key: person.key, name: typeof page.name === 'string' ? page.name : '', color: page.color, viewport: page.state?.viewport ?? null };
        if (JSON.stringify(next) !== JSON.stringify(followed)) { followed = next; followChanged = true; }
      }
    }
    const lanePublished = publish();
    if (drawn.size || ends.size) schedule();
    if (editorsChanged || followChanged || lanePublished) emit();
    // Edits in progress go once they are old: looked at again when the first of them is due to go.
    if (expiry !== null) { clearTimeout(expiry); expiry = null; }
    let due = Number.POSITIVE_INFINITY;
    for (const participant of participants) {
      if (participant.id === selfId || !freshPreview(participant, heard, now)) continue;
      due = Math.min(due, (heard?.get(participant.id) ?? now) + PREVIEW_SHOWN_MS - now);
    }
    if (Number.isFinite(due)) expiry = setTimeout(read, Math.max(0, due) + 20);
  };
  const unsubscribe = source.subscribe(read);
  read();
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    moves: () => moves,
    movedIds: () => movedIds,
    editors: () => editors,
    wires: () => wires,
    following: () => following,
    follow(key) {
      if (key === following) return;
      following = key;
      followed = null;
      shownBy = null;
      if (key) read();
      emit();
    },
    followed: () => followed,
    documentChanged() { if (drawn.size) schedule(); },
    release(ids) {
      if (stopped) return;
      let changed = false;
      for (const id of ids) {
        const item = drawn.get(id);
        if (!item) continue;
        // The edit that carried it: the one in progress, or the one that put it where it glides home from when its
        // page was only not heard for 2 s and still says it (see read). One its page said ended is no edit any more:
        // whatever that page says next, at that place too, is a new one.
        const last = item.last;
        const quiet = last?.by !== undefined && sameBox(last, saidBy(source.snapshot().participants, last.by, Date.now()).get(id));
        released.set(id, item.target ?? (quiet ? last : null));
        drawn.delete(id);
        changed = true;
      }
      if (changed && publish()) emit();
    },
    stop() {
      stopped = true;
      unsubscribe();
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      if (expiry !== null) clearTimeout(expiry);
      if (holdTimer !== null) clearTimeout(holdTimer);
      listeners.clear();
      released.clear();
      screens.clear();
      drawn = new Map();
      ends = new Map();
    },
  };
}

export { personKey };
