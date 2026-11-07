// 多人同屏 for one hosted canvas page (docs/awwo-canvas-live-collaboration.md): the live connection (canvasLive.ts), the
// page's copy of the server's document moving with every change (canvasSync.ts), saving by changes (PATCH), and what
// the canvas shows of the others (the people bar, the 同屏 panel, the board's rings, claims and pointers).
//
// The page (SaaSApp CloudCanvas) keeps its save loop: it asks this hook what its working document has not sent
// (unsent), sends it here (save), and lets the changes that waited for its save or its node setup in afterwards
// (settle). Changes from others go to the canvas surface as a rebase of its working document and undo steps.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import { api, API_BASE, SaaSApiError, type CanvasRecord } from './api';
import { configureSaaSCanvasCatchUp } from './canvasBridge';
import { rememberCanvasBaseline } from './canvasDraft';
import { createCanvasLive, newLiveClientId, type CanvasLive, type LiveSnapshot } from './canvasLive';
import { advanceConfirmed, changeBatches, heldOps, opNode, readableConfirmed, rebaseFor, unsentOps } from './canvasSync';
import { CANVAS_STORAGE_KEY, sanitizeDocument, type CanvasDocument, type CanvasNode } from '../canvas/canvasDoc';
import { canvasStorage, canvasStorageKey } from '../canvas/canvasStorage';
import type { CanvasMultiplayerHost, CanvasMultiplayerSurface } from '../canvas/multiplayer/host';
import type { CanvasChange, CanvasChangeResponse, CanvasOp, LiveParticipant } from '../canvas/multiplayer/types';
import { MultiplayerBar } from '../canvas/multiplayer/MultiplayerBar';
import { MultiplayerPanel } from '../canvas/multiplayer/MultiplayerPanel';
import { boardBoxOf, MultiplayerBoardLayer, type BoardFlash } from '../canvas/multiplayer/MultiplayerBoardLayer';
import { activityItem, actorParticipantId, type ActivityItem } from '../canvas/multiplayer/activity';
import type { AgentTokenItem } from '../canvas/multiplayer/types';
import { useSaaSPreferences } from './preferences';
import '../canvas/multiplayer/multiplayer.css';

/** A value components read as it changes, without the hook's own render (the board's glows). */
function createValueStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) { value = next; for (const listener of [...listeners]) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
type ValueStore<T> = ReturnType<typeof createValueStore<T>>;

type ScopedStorage = ReturnType<typeof canvasStorage>;

/** A node whose edit the server held back (a run fences it, or an agent holds it) waits this long before it goes again,
 *  doubling to HOLD_MAX_MS while it is still held. */
const HOLD_MS = 8_000;
const HOLD_MAX_MS = 60_000;
/** Another participant's change makes its nodes glow this long. */
const FLASH_MS = 1_600;
/** The latest changes the 同屏 panel lists. */
const ACTIVITY_KEPT = 40;
/** A save that met a dropped connection or a busy server goes again (with the same change id) this many times. */
const SAVE_RETRIES = 3;

export interface CanvasMultiplayer {
  /** For the canvas surface: undefined until the canvas is open. */
  host: CanvasMultiplayerHost | undefined;
  live: CanvasLive | null;
  clientId: string;
  /** False once the API answered a change 405 (one from before 多人同屏): the page then saves whole documents. */
  saves: MutableRefObject<boolean>;
  /** The ops a working document holds that the server's does not (nothing for a camera move), held edits included. */
  unsent(document: CanvasDocument): CanvasOp[];
  /** What a save may send now: the unsent ops less those on nodes held back until their hold ends. */
  sendable(document: CanvasDocument): CanvasOp[];
  /** Whether an edit waits for its node's hold to end (a run fences the node, or an agent holds it). */
  holding(): boolean;
  /** The document the canvas holds now, or null before the canvas is open. */
  working(): CanvasDocument | null;
  /** Sends what a working document holds unsent; the new version, or null when there was nothing to send. */
  save(document: CanvasDocument): Promise<number | null>;
  /** Lets in the changes that waited for a save or node setup. */
  settle(): void;
  /** Reads the changes others made since this page's version. */
  catchUp(): Promise<void>;
  /** Others' latest changes, the newest first, with who was on the canvas then: the panel words them in the page's
   *  language as it is when it shows them. */
  recent: readonly RecentChange[];
  /** Shows a node on the canvas. */
  focusNode(nodeId: string): void;
  /** The node this page has open and the nodes it has selected: a message in the panel is about the one in view. */
  attention: ValueStore<Attention>;
}

/** The node a page has open, and its selection. */
export interface Attention { focus: string | null; selection: readonly string[] }

/** Another participant's change as the panel lists it. */
export interface RecentChange { change: CanvasChange; participants: readonly LiveParticipant[] }

export function useCanvasMultiplayer(options: {
  tenantId: string;
  canvasId: string;
  /** The signed-in person: a change is this page's own only when it carries this page's id and their account. */
  userId: string;
  /** The canvas is open (its record read, no draft being reviewed). */
  enabled: boolean;
  current: MutableRefObject<CanvasRecord | null>;
  storage: MutableRefObject<ScopedStorage | null>;
  /** A save or node setup is out: changes wait until settle(). */
  busy: () => boolean;
  /** The page's confirmed document changed (the lessons and the canvas's evolution read it). */
  confirmed: (document: unknown) => void;
}): CanvasMultiplayer {
  const { tenantId, canvasId, enabled } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clientId = useRef(newLiveClientId()).current;
  // Whole-document saves until the page knows the server takes changes (SaaSApp sets it as the canvas opens).
  const saves = useRef(false);
  const surface = useRef<CanvasMultiplayerSurface | null>(null);
  const queue = useRef<CanvasChange[]>([]);
  const held = useRef(new Map<string, number>());
  const holds = useRef(new Map<string, number>());
  const catching = useRef<Promise<void> | null>(null);
  const baselineTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drainTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [live, setLive] = useState<CanvasLive | null>(null);
  const liveRef = useRef<CanvasLive | null>(null);
  const [recent, setRecent] = useState<readonly RecentChange[]>([]);
  const flashes = useRef<ValueStore<readonly BoardFlash[]>>(createValueStore<readonly BoardFlash[]>([])).current;
  const attention = useRef<ValueStore<Attention>>(createValueStore<Attention>({ focus: null, selection: [] })).current;
  const { locale } = useSaaSPreferences();
  const localeRef = useRef(locale);
  localeRef.current = locale;

  // A new confirmed document: the page's copy of the server's, the storage's note of it, then the surface's rebase.
  const adopt = useCallback((version: number, document: unknown, sent: readonly CanvasOp[], changes: readonly CanvasChange[]) => {
    const { current, storage } = optionsRef.current;
    const before = current.current;
    // Never back: an answer made at a version the page has passed meanwhile (a catch-up came first) moves nothing.
    if (!before || version < before.version) return;
    current.current = { ...before, version, document };
    const store = storage.current;
    if (store) {
      store.setItem('awwo.cloud.version', String(Math.max(version, Number(store.getItem('awwo.cloud.version')) || 0)));
      // The synced proof (a compressed copy) is written once the changes calm down, not at each.
      clearTimeout(baselineTimer.current);
      baselineTimer.current = setTimeout(() => {
        const record = optionsRef.current.current.current;
        if (!record || optionsRef.current.storage.current !== store) return;
        try { rememberCanvasBaseline(store, record.version, record.document); } catch { /* a proof only */ }
      }, 1500);
    }
    optionsRef.current.confirmed(document);
    // A change is this page's own only under its id and its person's account: a page id is seen by everyone on the
    // canvas, so a change another member sent under it is still someone else's.
    const own = (change: CanvasChange) => change.actor.kind === 'human' && change.actor.clientId === clientId
      && change.actor.userId === optionsRef.current.userId;
    surface.current?.rebase(rebaseFor({ before: before.document, after: document, changes, sent, own }));
    // Others' changes: a line each in the panel, and a glow on the nodes they changed.
    const others = changes.filter(change => !own(change));
    if (others.length) {
      const read = readableConfirmed(document);
      const title = (id: string) => read.nodes.find(node => node.id === id)?.title;
      const participants = liveRef.current?.snapshot().participants ?? [];
      setRecent(previous => [...others.map(change => ({ change, participants })).reverse(), ...previous].slice(0, ACTIVITY_KEPT));
      const until = Date.now() + FLASH_MS;
      const glow: BoardFlash[] = [];
      for (const change of others) {
        const color = participants.find(p => p.id === actorParticipantId(change.actor))?.color ?? '#7c8c9c';
        for (const op of change.ops) {
          const node = opNode(op, read);
          if (node && !glow.some(f => f.nodeId === node)) glow.push({ nodeId: node, color, until });
        }
      }
      if (glow.length) flashes.set([...flashes.get().filter(f => f.until > Date.now() && !glow.some(g => g.nodeId === f.nodeId)), ...glow]);
    }
  }, [clientId, flashes]);

  const catchUp = useCallback(async () => {
    if (catching.current) return catching.current;
    const run = (async () => {
      // Not while a save or node setup is out: its answer moves the page's copy, and the two would race.
      for (let waited = 0; optionsRef.current.busy() && waited < 300; waited += 1) await new Promise(resolve => setTimeout(resolve, 100));
      const record = optionsRef.current.current.current;
      if (!record) return;
      const answer = await api<{ version: number; changes?: CanvasChange[]; reset?: boolean; document?: unknown }>(
        `/tenants/${encodeURIComponent(tenantId)}/canvases/${encodeURIComponent(canvasId)}/changes?after=${record.version}`);
      const now = optionsRef.current.current.current;
      if (!now || now.version >= answer.version) return;
      if (answer.reset) { adopt(answer.version, answer.document, [], []); return; }
      const moved = advanceConfirmed({ version: now.version, document: now.document }, answer.changes ?? []);
      if (moved.unreadable) {
        // A change this page cannot apply: reading the changes again would stop at it again, so the canvas is read whole.
        const fresh = await api<CanvasRecord>(`/tenants/${encodeURIComponent(tenantId)}/canvases/${encodeURIComponent(canvasId)}`);
        const latest = optionsRef.current.current.current;
        if (latest && fresh.version > latest.version) adopt(fresh.version, fresh.document, [], []);
        return;
      }
      if (moved.applied.length) adopt(moved.next.version, moved.next.document, [], moved.applied);
    })();
    catching.current = run;
    try { await run; } finally { catching.current = null; }
  }, [adopt, tenantId, canvasId]);

  // Lets in the changes that came while the page could not take them.
  const drain = useCallback(() => {
    clearTimeout(drainTimer.current);
    if (!queue.current.length) return;
    const record = optionsRef.current.current.current;
    if (!record) return;
    if (optionsRef.current.busy() || !surface.current || !surface.current.ready()) {
      drainTimer.current = setTimeout(() => drain(), 250);
      return;
    }
    const waiting = queue.current;
    queue.current = [];
    const moved = advanceConfirmed({ version: record.version, document: record.document }, waiting);
    if (moved.applied.length) adopt(moved.next.version, moved.next.document, [], moved.applied);
    if (moved.gap) void catchUp().catch(() => undefined);
  }, [adopt, catchUp]);

  useEffect(() => {
    if (!enabled) return;
    const connection = createCanvasLive(tenantId, canvasId, {
      confirmedVersion: () => optionsRef.current.current.current?.version ?? 0,
      changes: changes => { queue.current.push(...changes); drain(); },
      reset: () => { void catchUp().catch(() => undefined); },
    }, clientId);
    liveRef.current = connection;
    setLive(connection);
    connection.start();
    configureSaaSCanvasCatchUp(catchUp);
    return () => {
      connection.stop();
      liveRef.current = null;
      setLive(null);
      configureSaaSCanvasCatchUp(null);
      clearTimeout(drainTimer.current);
      clearTimeout(baselineTimer.current);
      clearTimeout(holdTimer.current);
      queue.current = [];
    };
  }, [enabled, tenantId, canvasId, clientId, drain, catchUp]);

  const unsent = useCallback((document: CanvasDocument) => {
    const record = optionsRef.current.current.current;
    if (!record) return [];
    return unsentOps(readableConfirmed(record.document), sanitizeDocument(document));
  }, []);
  const sendable = useCallback((document: CanvasDocument) => {
    const record = optionsRef.current.current.current;
    if (!record) return [];
    return unsentOps(readableConfirmed(record.document), sanitizeDocument(document), held.current);
  }, []);
  const holding = useCallback(() => held.current.size > 0, []);
  const working = useCallback(() => surface.current?.document() ?? null, []);

  const save = useCallback(async (document: CanvasDocument): Promise<number | null> => {
    const path = `/tenants/${encodeURIComponent(tenantId)}/canvases/${encodeURIComponent(canvasId)}`;
    const ops = sendable(document);
    if (!ops.length) return null;
    let version: number | null = null;
    for (const batch of changeBatches(ops)) {
      const record = optionsRef.current.current.current;
      if (!record) throw new SaaSApiError(409, 'canvas_closed', 'The canvas is no longer open');
      const changeId = newLiveClientId().replace(/^p/, 'c');
      let answer: CanvasChangeResponse | null = null;
      for (let attempt = 0; ; attempt += 1) {
        try {
          answer = await api<CanvasChangeResponse>(path, { method: 'PATCH', body: JSON.stringify({ baseVersion: record.version, changeId, clientId, ops: batch, label: 'edit' }) });
          break;
        } catch (error) {
          if (error instanceof SaaSApiError && error.status === 405) { saves.current = false; throw error; }
          // A lost answer, a busy server or the edge's 429 (too many requests from one address): the same change goes
          // again; the server applies it once (its id).
          const crowded = error instanceof SaaSApiError && error.status === 429;
          const transient = !(error instanceof SaaSApiError) || crowded || error.status >= 502 || (error.status === 503 && error.code === 'canvas_save_busy');
          if (!transient || attempt >= SAVE_RETRIES) throw error;
          await new Promise(resolve => setTimeout(resolve, (crowded ? 1500 : 600) * 2 ** attempt + Math.random() * 400));
        }
      }
      const kept = heldOps(batch, answer.results);
      const now = Date.now();
      for (const op of kept) {
        const node = opNode(op, sanitizeDocument(document));
        if (!node) continue;
        const wait = Math.min(HOLD_MAX_MS, (holds.current.get(node) ?? HOLD_MS / 2) * 2);
        holds.current.set(node, wait);
        held.current.set(node, now + wait);
      }
      for (const [node, until] of held.current) if (until <= now && !kept.some(op => opNode(op, sanitizeDocument(document)) === node)) { held.current.delete(node); holds.current.delete(node); }
      const sent = batch.filter(op => !kept.includes(op));
      if (answer.reset) {
        adopt(answer.version, answer.document, sent, []);
      } else {
        // From the page's copy as it is now: a catch-up may have moved it while the change was out.
        const now = optionsRef.current.current.current ?? record;
        const moved = advanceConfirmed({ version: now.version, document: now.document }, answer.changes ?? []);
        if (moved.gap) {
          // The answer always holds every change after its base; one that does not is read again whole.
          const fresh = await api<CanvasRecord>(path);
          adopt(fresh.version, fresh.document, sent, []);
        } else {
          adopt(moved.next.version, moved.next.document, sent, moved.applied);
        }
      }
      version = optionsRef.current.current.current?.version ?? answer.version;
    }
    // What the server held back goes again once its hold ends: the page's autosave hears of it as of an edit.
    clearTimeout(holdTimer.current);
    if (held.current.size) {
      const due = Math.min(...held.current.values());
      holdTimer.current = setTimeout(() => {
        window.dispatchEvent(new CustomEvent('awwo:canvas-cache-write', { detail: { key: CANVAS_STORAGE_KEY, storageKey: canvasStorageKey(CANVAS_STORAGE_KEY) } }));
      }, Math.max(0, due - Date.now()) + 50);
    }
    return version;
  }, [tenantId, canvasId, clientId, sendable, adopt]);

  const settle = useCallback(() => { drain(); }, [drain]);

  const host = useMemo<CanvasMultiplayerHost | undefined>(() => live ? {
    connect: next => {
      surface.current = next;
      if (next) drain();
    },
    presence: update => {
      // The node a message is about: the one this page has open, else the one node it has selected.
      if (update.focus !== undefined || update.selection !== undefined) {
        const previous = attention.get();
        const next = { focus: update.focus !== undefined ? update.focus : previous.focus, selection: update.selection ?? previous.selection };
        attention.set(next);
      }
      live.setPresence(update);
    },
    boardLayer: (nodes, scale) => <MultiplayerBoard live={live} nodes={nodes} flashes={flashes} scale={scale} />,
    busyNodes: () => {
      const busy = new Set<string>();
      // Read when asked (an edit), not subscribed to: presence must not draw the whole canvas again.
      for (const participant of live.snapshot().participants) {
        if (participant.kind === 'awwo' && participant.state.focus) busy.add(participant.state.focus);
      }
      return busy;
    },
  } : undefined, [live, drain, flashes, attention]);

  const focusNode = useCallback((nodeId: string) => surface.current?.focus(nodeId), []);
  return useMemo(() => ({ host, live, clientId, saves, unsent, sendable, holding, working, save, settle, catchUp, recent, focusNode, attention }),
    [host, live, clientId, unsent, sendable, holding, working, save, settle, catchUp, recent, focusNode, attention]);
}

const OFFLINE: LiveSnapshot = { status: 'offline', ended: null, you: null, participants: [], claims: [], messages: [] };
const noSubscription = () => () => {};

/** The live connection's snapshot, kept current in a component. */
export function useLiveSnapshot(live: CanvasLive | null): LiveSnapshot {
  return useSyncExternalStore(live ? live.subscribe : noSubscription, live ? live.snapshot : () => OFFLINE, () => OFFLINE);
}

/** A moment that moves on while there is something with a time left (a glow, a claim's countdown); current again as
 *  soon as it starts moving. */
function useNow(active: boolean, every = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [active, every]);
  return now;
}

function MultiplayerBoard({ live, nodes, flashes, scale }: { live: CanvasLive; nodes: ReadonlyArray<CanvasNode & { round?: boolean }>; flashes: ValueStore<readonly BoardFlash[]>; scale: number }) {
  const snapshot = useLiveSnapshot(live);
  const glows = useSyncExternalStore(flashes.subscribe, flashes.get, flashes.get);
  const glowing = glows.some(f => f.until > Date.now());
  // Claims end with no event: the board's clock moves while any is drawn, so one past its end goes.
  const now = useNow(glowing || snapshot.claims.length > 0, glowing ? 200 : 1000);
  // An icon of the icon view comes round: its marks ring its plate.
  const boxes = useMemo(() => nodes.map(boardBoxOf), [nodes]);
  return <MultiplayerBoardLayer participants={snapshot.participants} selfId={live.clientId} claims={snapshot.claims} nodes={boxes} flashes={glows} now={now} scale={scale} />;
}

/** The people bar and the 同屏 panel of the canvas header. */
export function MultiplayerHeader({ multiplayer, tenantId, canvasId, canWrite, nodeTitle, onFocusNode }: {
  multiplayer: CanvasMultiplayer; tenantId: string; canvasId: string; canWrite: boolean;
  nodeTitle: (id: string) => string | undefined; onFocusNode: (id: string) => void;
}) {
  const live = multiplayer.live;
  const snapshot = useLiveSnapshot(live);
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<{ items: readonly AgentTokenItem[]; loading: boolean; error: unknown }>({ items: [], loading: false, error: null });
  const now = useNow(open && snapshot.claims.length > 0, 1000);
  const attention = useSyncExternalStore(multiplayer.attention.subscribe, multiplayer.attention.get, multiplayer.attention.get);
  const messageNodeId = attention.focus ?? (attention.selection.length === 1 ? attention.selection[0] : null);
  const loadTokens = useCallback(async () => {
    if (!live || !canWrite) return;
    setTokens(previous => ({ ...previous, loading: true, error: null }));
    try { setTokens({ items: await live.listTokens(), loading: false, error: null }); }
    // The refusal itself, so the panel words it by its code in the page's language.
    catch (error) { setTokens(previous => ({ ...previous, loading: false, error })); }
  }, [live, canWrite]);
  const { locale } = useSaaSPreferences();
  // Worded now, in the page's language now (a change kept from before a language switch reads in the new one).
  const activity = useMemo<readonly ActivityItem[]>(() => multiplayer.recent.map(({ change, participants }) =>
    activityItem(change, nodeTitle, locale, participants)), [multiplayer.recent, nodeTitle, locale]);
  if (!live) return null;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return <>
    <MultiplayerBar participants={snapshot.participants} selfId={live.clientId} status={snapshot.status} open={open}
      onOpen={() => { setOpen(value => !value); if (!open) void loadTokens(); }} />
    <MultiplayerPanel open={open} onClose={() => setOpen(false)} participants={snapshot.participants} selfId={live.clientId}
      claims={snapshot.claims} messages={snapshot.messages} activity={activity} canWrite={canWrite} canInvite={canWrite}
      nodeTitle={nodeTitle} onFocusNode={onFocusNode} status={snapshot.status} now={now} messageNodeId={messageNodeId}
      onSend={async (text, nodeId) => { await live.say(text, nodeId); }}
      onRelease={async nodeIds => { await live.release(nodeIds); }}
      invite={{
        tokens, mcpUrl: `${origin}${API_BASE}/mcp`, apiBase: `${origin}${API_BASE}`, tenantId, canvasId, onOpen: () => void loadTokens(),
        onCreate: async (name, days, scope) => { const created = await live.createToken(name, days, scope); void loadTokens(); return created; },
        onRevoke: async id => { await live.revokeToken(id); await loadTokens(); },
      }} />
  </>;
}
