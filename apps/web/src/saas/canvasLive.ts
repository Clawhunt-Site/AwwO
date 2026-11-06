// 多人同屏: one canvas's live connection (docs/awwo-canvas-live-collaboration.md). It holds the canvas's stream
// (GET …/live/events): the changes after the version the page has confirmed, who is on the canvas, the claims and the
// live messages. It sends this page's state (selection, focus, pointer) at a measured pace, and gives the panel's calls
// (claims, messages, agent tokens). Every API release ends the stream (bye: restart); the page connects again a moment
// later, from the version it holds, and misses no change.

import { readSseFrames } from '../sse';
import { API_BASE, api, sessionFetch } from './api';
import type { AgentTokenItem, CanvasChange, LiveClaim, LiveMessage, LiveParticipant, LiveState } from '../canvas/multiplayer/types';

export type LiveStatus = 'connecting' | 'live' | 'offline';
/** Why the stream ended for good: the page's access ended, or the canvas is gone. */
export type LiveEnded = 'access' | 'deleted' | 'revoked' | null;

export interface LiveSnapshot {
  status: LiveStatus;
  ended: LiveEnded;
  you: LiveParticipant | null;
  /** Everyone on the canvas, this page included: people, agents and AwwO's running node Agents. */
  participants: readonly LiveParticipant[];
  claims: readonly LiveClaim[];
  /** The latest live messages, the oldest first. */
  messages: readonly LiveMessage[];
}

export interface CanvasLiveHandlers {
  /** The version this page has confirmed now: where a (re)connected stream starts. */
  confirmedVersion(): number;
  /** Changes the stream brought, in order (several that came together arrive at once). */
  changes(changes: readonly CanvasChange[]): void;
  /** The stream's changes no longer reach back to the page's version: read them again (GET …/changes). */
  reset(version: number): void;
}

export interface CanvasLive {
  readonly clientId: string;
  start(): void;
  stop(): void;
  snapshot(): LiveSnapshot;
  subscribe(listener: () => void): () => void;
  setPresence(state: Partial<LiveState>): void;
  claim(nodeIds: readonly string[], options?: { ttlSeconds?: number; note?: string }): Promise<{ claims: LiveClaim[]; refused: { nodeId: string; holder: LiveClaim | null }[] }>;
  release(nodeIds?: readonly string[]): Promise<void>;
  say(text: string, nodeId?: string): Promise<LiveMessage>;
  olderMessages(before: string): Promise<LiveMessage[]>;
  listTokens(): Promise<AgentTokenItem[]>;
  createToken(name: string, days: number, scope: 'edit' | 'read'): Promise<{ token: string; item: AgentTokenItem }>;
  revokeToken(id: string): Promise<void>;
}

/** How many live messages a page keeps. */
const KEPT_MESSAGES = 200;
/** Presence goes at most this often (the server takes ten a second); a pointer's alone is held this long, so at most
 *  four a second leave a page. Nothing goes while no one else is on the canvas, nor a pointer while the tab is hidden. */
const PRESENCE_PACE_MS = 120;
const CURSOR_PACE_MS = 250;
/** A dropped stream connects again after a random wait in [min, max): an API release drops every page at once. */
const RECONNECT_MIN_MS = 800;
const RECONNECT_MAX_MS = 30_000;

/** A page's own id on the canvas: one per tab. */
export function newLiveClientId(): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `p${id.slice(0, 31)}`;
}

function sameJSON(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function createCanvasLive(tenantId: string, canvasId: string, handlers: CanvasLiveHandlers, clientId = newLiveClientId()): CanvasLive {
  const base = `/tenants/${encodeURIComponent(tenantId)}/canvases/${encodeURIComponent(canvasId)}`;
  let snapshot: LiveSnapshot = { status: 'connecting', ended: null, you: null, participants: [], claims: [], messages: [] };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<LiveSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  };
  let running = false;
  let abort: AbortController | null = null;
  let wakeUp: (() => void) | null = null;
  // The changes of one burst go to the page together.
  let batch: CanvasChange[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  const flushChanges = () => {
    batchTimer = null;
    const changes = batch;
    batch = [];
    if (changes.length) handlers.changes(changes);
  };
  // This page's state: what it last sent in full (sent again after every reconnect), and the parts waiting to go.
  const state: LiveState = { selection: [], focus: null, cursor: null, status: null };
  let unsent: Partial<LiveState> = {};
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether anyone else is on the canvas to see this page's state: alone, a page sends none (it all goes once someone
  // comes), so a canvas open in many tabs behind one address costs the edge nothing.
  const othersHere = () => snapshot.participants.some(p => p.id !== clientId);
  const sendPresence = () => {
    presenceTimer = null;
    if (!running || !Object.keys(unsent).length || !othersHere()) return;
    const body = { clientId, state: unsent };
    unsent = {};
    void api(`${base}/live/presence`, { method: 'POST', body: JSON.stringify(body) }).catch(() => undefined);
  };
  const sendAllSoon = () => {
    unsent = { ...state };
    if (presenceTimer === null) presenceTimer = setTimeout(sendPresence, PRESENCE_PACE_MS);
  };
  const upsert = (participant: LiveParticipant) => {
    const list = snapshot.participants.filter(p => p.id !== participant.id);
    const at = snapshot.participants.findIndex(p => p.id === participant.id);
    if (at >= 0) list.splice(at, 0, participant); else list.push(participant);
    publish({ participants: list, you: participant.id === clientId ? participant : snapshot.you });
  };
  const dispatch = (event: string, data: any) => {
    switch (event) {
      case 'hello': {
        greeted = true;
        const participants: LiveParticipant[] = Array.isArray(data?.participants) ? data.participants : [];
        const messages: LiveMessage[] = Array.isArray(data?.messages) ? [...data.messages].reverse() : [];
        publish({ status: 'live', you: data?.you ?? null, participants, claims: Array.isArray(data?.claims) ? data.claims : [], messages });
        // The server forgets every page's state at a restart: this page's goes again in full.
        sendAllSoon();
        break;
      }
      case 'changes':
        if (data && Number.isSafeInteger(data.version) && Array.isArray(data.ops)) {
          batch.push(data as CanvasChange);
          if (batchTimer === null) batchTimer = setTimeout(flushChanges, 16);
        }
        break;
      case 'reset':
        if (batchTimer !== null) { clearTimeout(batchTimer); flushChanges(); }
        if (Number.isSafeInteger(data?.version)) handlers.reset(data.version);
        break;
      case 'presence':
        if (data?.participant?.id) {
          const alone = !othersHere();
          upsert(data.participant as LiveParticipant);
          // The first one to come is told where this page is.
          if (alone && othersHere()) sendAllSoon();
        } else if (typeof data?.left === 'string') publish({ participants: snapshot.participants.filter(p => p.id !== data.left) });
        break;
      case 'claims':
        if (Array.isArray(data?.claims)) publish({ claims: data.claims });
        break;
      case 'message':
        if (data?.message?.id && !snapshot.messages.some(m => m.id === data.message.id)) {
          publish({ messages: [...snapshot.messages, data.message as LiveMessage].slice(-KEPT_MESSAGES) });
        }
        break;
      case 'bye': {
        const reason = data?.reason;
        if (reason === 'revoked' || reason === 'access' || reason === 'deleted') {
          running = false;
          publish({ status: 'offline', ended: reason });
        }
        break;
      }
    }
  };
  const pause = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(() => { wakeUp = null; resolve(); }, ms);
    wakeUp = () => { clearTimeout(timer); wakeUp = null; resolve(); };
  });
  // A stream counts as open once its hello came: one that ends right after its 200 (a database problem on the way to
  // its hello) waits longer each time, as a refused one does.
  let greeted = false;
  const loop = async () => {
    let failures = 0;
    while (running) {
      const controller = new AbortController();
      abort = controller;
      greeted = false;
      try {
        const after = handlers.confirmedVersion();
        const url = `${API_BASE}${base}/live/events?after=${encodeURIComponent(String(after))}&client=${encodeURIComponent(clientId)}`;
        const response = await sessionFetch(url, { credentials: 'include', headers: { Accept: 'text/event-stream' }, signal: controller.signal });
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          running = false;
          publish({ status: 'offline', ended: response.status === 404 ? 'deleted' : 'access' });
          break;
        }
        if (!response.ok || !response.body) throw new Error(`live stream ${response.status}`);
        await readSseFrames(response.body, dispatch);
      } catch { /* connects again below */ }
      if (batchTimer !== null) { clearTimeout(batchTimer); flushChanges(); }
      if (!running) break;
      publish({ status: 'connecting' });
      failures = greeted ? 1 : failures + 1;
      const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures, 6));
      await pause(RECONNECT_MIN_MS + Math.random() * (ceiling - RECONNECT_MIN_MS));
    }
    if (!snapshot.ended) publish({ status: 'offline' });
  };
  const path = (tail: string) => `${base}${tail}`;
  // A tab put away takes its pointer off everyone's canvas.
  const hidden = () => { if (typeof document !== 'undefined' && document.hidden) live.setPresence({ cursor: null }); };
  const live: CanvasLive = {
    clientId,
    start() {
      if (running) return;
      running = true;
      publish({ status: 'connecting', ended: null });
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hidden);
      void loop();
    },
    stop() {
      running = false;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hidden);
      abort?.abort();
      wakeUp?.();
      if (presenceTimer !== null) { clearTimeout(presenceTimer); presenceTimer = null; }
      if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; batch = []; }
      publish({ status: 'offline' });
    },
    snapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setPresence(next) {
      let changed = false;
      for (const key of Object.keys(next) as (keyof LiveState)[]) {
        const value = next[key];
        if (key === 'cursor' && value && typeof document !== 'undefined' && document.hidden) continue;
        if (value === undefined || sameJSON(state[key], value)) continue;
        (state as unknown as Record<string, unknown>)[key] = value;
        (unsent as unknown as Record<string, unknown>)[key] = value;
        changed = true;
      }
      if (!changed || !running || presenceTimer !== null) return;
      const onlyCursor = Object.keys(unsent).every(key => key === 'cursor');
      presenceTimer = setTimeout(sendPresence, onlyCursor ? CURSOR_PACE_MS : PRESENCE_PACE_MS);
    },
    async claim(nodeIds, options = {}) {
      const out = await api<{ claims: LiveClaim[]; refused: { nodeId: string; holder: LiveClaim | null }[] }>(path('/live/claims'), {
        method: 'POST', body: JSON.stringify({ clientId, nodeIds: [...nodeIds], ...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}), ...(options.note ? { note: options.note } : {}) }),
      });
      publish({ claims: out.claims ?? snapshot.claims });
      return out;
    },
    async release(nodeIds) {
      const out = await api<{ claims: LiveClaim[] }>(path('/live/claims'), { method: 'DELETE', body: JSON.stringify({ clientId, ...(nodeIds ? { nodeIds: [...nodeIds] } : {}) }) });
      publish({ claims: out.claims ?? snapshot.claims });
    },
    async say(text, nodeId) {
      const out = await api<{ message: LiveMessage }>(path('/live/messages'), { method: 'POST', body: JSON.stringify({ clientId, text, ...(nodeId ? { nodeId } : {}) }) });
      if (!snapshot.messages.some(m => m.id === out.message.id)) publish({ messages: [...snapshot.messages, out.message].slice(-KEPT_MESSAGES) });
      return out.message;
    },
    async olderMessages(before) {
      const out = await api<{ items: LiveMessage[] }>(path(`/live/messages?before=${encodeURIComponent(before)}`));
      return [...(out.items ?? [])].reverse();
    },
    async listTokens() { return (await api<{ items: AgentTokenItem[] }>(path('/agent-tokens'))).items ?? []; },
    async createToken(name, days, scope) {
      return api<{ token: string; item: AgentTokenItem }>(path('/agent-tokens'), { method: 'POST', body: JSON.stringify({ name, days, scope }) });
    },
    async revokeToken(id) { await api(path(`/agent-tokens/${encodeURIComponent(id)}`), { method: 'DELETE' }); },
  };
  return live;
}
