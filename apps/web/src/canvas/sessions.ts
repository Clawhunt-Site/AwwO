// Per-node agent conversation store — the canvas rebuild's transcript authority.
//
// THE NODE IS THE AGENT SESSION: every tile on the infinite canvas holds a live conversation
// rendered inside it. That transcript CANNOT live in React state, for three independent reasons:
//
//   1. A graph run fans out across many tiles at once — the run engine writes into the same
//      conversations the operator types into, from outside any component tree.
//   2. Tiles unmount when panned far away (viewport culling) and remount when panned back; a
//      component-owned transcript would be destroyed and "restored" as a blank tile, which is
//      exactly the dishonest state this project bans (an unreadable/absent history must never
//      be indistinguishable from "nothing was ever said").
//   3. Both the manual composer AND the run engine write to the SAME conversation, so a single
//      component can't be the owner.
//
// So this is a module-level external store keyed by nodeId, shaped for useSyncExternalStore:
// `getSnapshot` returns a STABLE reference (the identical object until something actually
// changes — a fresh object per call would spin React forever), and `subscribe` notifies only
// the subscribers of the node that changed, so one streaming tile never re-renders the rest of
// the canvas.
//
// No React, no DOM, no transport: pure state + notification, fully unit-testable.

export type TurnRole = 'user' | 'agent' | 'system';
export type TurnTone = 'info' | 'warn' | 'error';

export interface Turn {
  id: number;
  role: TurnRole;
  text: string;
  tone?: TurnTone;
}

/**
 * Honest history lifecycle. 'unreadable' is NOT 'loaded with zero turns': a conversation store
 * we could not read must never render as "nothing was ever said" (see canvasAgentChat's null
 * contract). 'unloaded' = never attempted.
 */
export type HistoryState = 'unloaded' | 'loading' | 'loaded' | 'unreadable';

export interface NodeSession {
  turns: Turn[];
  streaming: boolean;
  /** Raw run status / phase note from the gateway ('' never used; null = nothing to show). */
  status: string | null;
  history: HistoryState;
}

/** The single shared snapshot handed out for a node nothing has touched yet. Frozen and shared
 *  on purpose: every getSnapshot for an untouched node must return the SAME object. */
const EMPTY_SESSION: NodeSession = Object.freeze({
  turns: Object.freeze([]) as unknown as Turn[],
  streaming: false,
  status: null,
  history: 'unloaded',
}) as NodeSession;

interface Entry {
  session: NodeSession;
  /** Per-node turn id counter. Never reused, not even across replaceTurns/reset, so an
   *  in-flight appendToTurn can never land on a different turn than it minted. */
  seq: number;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

function ensure(nodeId: string): Entry {
  let entry = entries.get(nodeId);
  if (!entry) {
    entry = { session: EMPTY_SESSION, seq: 0, listeners: new Set() };
    entries.set(nodeId, entry);
  }
  return entry;
}

function notify(entry: Entry): void {
  // Copy first: a listener may unsubscribe (or subscribe) while being notified.
  for (const cb of [...entry.listeners]) cb();
}

/**
 * Apply a pure transform. Returning the SAME session object (or null) means "nothing actually
 * changed" — no new snapshot, no notification. This is what keeps `getSnapshot` stable and
 * stops idempotent writes (a repeated setStatus, a delta of '') from re-rendering a tile.
 */
function update(nodeId: string, mutate: (session: NodeSession) => NodeSession | null): void {
  const entry = ensure(nodeId);
  const next = mutate(entry.session);
  if (!next || next === entry.session) return;
  entry.session = next;
  notify(entry);
}

// ---- reads ---------------------------------------------------------------------------------

/** Stable snapshot for useSyncExternalStore. Identical reference until the node changes. */
export function getSnapshot(nodeId: string): NodeSession {
  return entries.get(nodeId)?.session ?? EMPTY_SESSION;
}

/** Subscribe to ONE node. Returns the unsubscribe fn. Other nodes' writes never fire this. */
export function subscribe(nodeId: string, cb: () => void): () => void {
  const entry = ensure(nodeId);
  entry.listeners.add(cb);
  return () => {
    const current = entries.get(nodeId);
    if (!current) return;
    current.listeners.delete(cb);
    // Drop a fully idle, empty entry so a canvas that pans over thousands of nodes doesn't
    // accumulate empty records. An entry holding a real transcript is KEPT — that transcript
    // outliving the component is the whole point of this store.
    if (current.listeners.size === 0 && current.session === EMPTY_SESSION) entries.delete(nodeId);
  };
}

/** The last non-empty line of the last non-empty turn — the tile's glance-LOD preview. */
export function lastLine(nodeId: string): string {
  const session = getSnapshot(nodeId);
  for (let i = session.turns.length - 1; i >= 0; i -= 1) {
    const raw = session.turns[i].text;
    if (!raw) continue;
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) return lines[lines.length - 1];
  }
  return '';
}

// ---- writes --------------------------------------------------------------------------------

/** Append a turn; returns the MINTED id so the caller can stream into it later. */
export function appendTurn(nodeId: string, turn: Omit<Turn, 'id'>): number {
  const entry = ensure(nodeId);
  entry.seq += 1;
  const id = entry.seq;
  const next: Turn = { ...turn, id };
  entry.session = { ...entry.session, turns: [...entry.session.turns, next] };
  notify(entry);
  return id;
}

/** Replace a turn's whole text (and tone). A missing id is a no-op — a late frame writing to a
 *  turn that a reset/replace already removed must not resurrect it. */
export function patchTurn(nodeId: string, turnId: number, text: string, tone?: TurnTone): void {
  update(nodeId, (session) => {
    const idx = session.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) return null;
    const turn = session.turns[idx];
    if (turn.text === text && turn.tone === tone) return null;
    const turns = session.turns.slice();
    turns[idx] = { ...turn, text, tone };
    return { ...session, turns };
  });
}

/** Stream a chunk into an existing turn. */
export function appendToTurn(nodeId: string, turnId: number, chunk: string): void {
  if (!chunk) return;
  update(nodeId, (session) => {
    const idx = session.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) return null;
    const turns = session.turns.slice();
    turns[idx] = { ...turns[idx], text: turns[idx].text + chunk };
    return { ...session, turns };
  });
}

export function setStreaming(nodeId: string, streaming: boolean): void {
  update(nodeId, (session) => (session.streaming === streaming ? null : { ...session, streaming }));
}

export function setStatus(nodeId: string, status: string | null): void {
  update(nodeId, (session) => (session.status === status ? null : { ...session, status }));
}

export function setHistory(nodeId: string, history: HistoryState): void {
  update(nodeId, (session) => (session.history === history ? null : { ...session, history }));
}

/** Replace the whole transcript (history replay). Ids are minted fresh, continuing the counter. */
export function replaceTurns(nodeId: string, turns: ReadonlyArray<Omit<Turn, 'id'>>): void {
  const entry = ensure(nodeId);
  if (turns.length === 0 && entry.session.turns.length === 0) return;
  const minted = turns.map((t) => {
    entry.seq += 1;
    return { ...t, id: entry.seq } as Turn;
  });
  entry.session = { ...entry.session, turns: minted };
  notify(entry);
}

/** Wipe a node back to the pristine snapshot (node deleted, or its binding replaced). */
export function reset(nodeId: string): void {
  const entry = entries.get(nodeId);
  if (!entry) return;
  const changed = entry.session !== EMPTY_SESSION;
  entry.session = EMPTY_SESSION;
  if (changed) notify(entry);
  if (entry.listeners.size === 0) entries.delete(nodeId);
}

/** Test/teardown helper: drop every node. Never called by product code. */
export function resetAllSessions(): void {
  entries.clear();
}
