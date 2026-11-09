// 多人同屏: one canvas's live connection (docs/awwo-canvas-live-collaboration.md). It holds the canvas's stream
// (GET …/live/events): the changes after the version the page has confirmed, who is on the canvas, the claims and the
// live messages. It sends this page's state (selection, focus, pointer, the edit it is making, the field it types in,
// what its screen shows) at most eight times a second, and gives the panel's calls (claims, messages, agent tokens).
// Every API release ends the stream (bye: restart); the page connects again a moment later, from the version it
// holds, and misses no change. A stream that goes quiet is opened again (its pings come every 15 s).

import { readSseFrames } from '../sse';
import { API_BASE, api, SaaSApiError, sessionFetch } from './api';
import { detectDevice } from '../canvas/multiplayer/device';
import type { AgentTokenItem, CanvasChange, LiveClaim, LiveDevice, LiveMessage, LiveParticipant, LiveState } from '../canvas/multiplayer/types';

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
  /** When this page last heard of each participant (ms since the epoch, this page's clock): an edit in progress is shown
   *  for a while after it came, and a person is followed on the page of theirs heard from last. */
  heard: ReadonlyMap<string, number>;
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
/** Presence goes at most every PRESENCE_EVERY_MS (eight a second; the server takes ten), at once when that long has
 *  passed since the last. Nothing goes while no one else is on the canvas or the stream is not live (its hello sends
 *  everything again), nor a pointer while the tab is hidden. An edit in progress goes again every PREVIEW_RENEW_MS
 *  while it lasts (the others let it go 2 s after its last). A post with no answer in PRESENCE_DEADLINE_MS is given up;
 *  a failed one goes again after RETRY_MS, twice as long after each failure in a row, up to RETRY_MAX_MS. */
const PRESENCE_EVERY_MS = 125;
const PREVIEW_RENEW_MS = 1_000;
const PRESENCE_DEADLINE_MS = 5_000;
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 16_000;
/** A dropped stream connects again after a random wait in [min, max): an API release drops every page at once. */
const RECONNECT_MIN_MS = 800;
const RECONNECT_MAX_MS = 30_000;
/** A stream that brought nothing (its pings come every 15 s) for this long is opened again; how often that is looked at. */
const QUIET_MS = 35_000;
const WATCH_EVERY_MS = 5_000;
/** The parts of a state every API with the live stream takes; a later one names more in its hello (presenceParts). */
const FIRST_PARTS: readonly (keyof LiveState)[] = ['selection', 'focus', 'cursor', 'status'];

/** A page's own id on the canvas: one per tab. */
export function newLiveClientId(): string {
  const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `p${id.slice(0, 31)}`;
}

function sameJSON(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function createCanvasLive(tenantId: string, canvasId: string, handlers: CanvasLiveHandlers, clientId = newLiveClientId(),
  device: LiveDevice = detectDevice()): CanvasLive {
  const base = `/tenants/${encodeURIComponent(tenantId)}/canvases/${encodeURIComponent(canvasId)}`;
  let snapshot: LiveSnapshot = { status: 'connecting', ended: null, you: null, participants: [], claims: [], messages: [], heard: new Map() };
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
  const state: LiveState = { selection: [], focus: null, cursor: null, status: null, preview: null, editing: null, viewport: null };
  let unsent: Partial<LiveState> = {};
  // The last place of an edit in progress that ended while that place still waited to go (see setPresence).
  let endedPreview: LiveState['preview'] = null;
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  // The parts the API takes: an older one refuses a post with a part it does not know, so the newer parts stay here
  // until a hello names them.
  let parts = new Set<keyof LiveState>(FIRST_PARTS);
  // Whether anyone else is on the canvas to see this page's state: alone, a page sends none (it all goes once someone
  // comes), so a canvas open in many tabs behind one address costs the edge nothing.
  const othersHere = () => snapshot.participants.some(p => p.id !== clientId);
  const schedule = () => {
    if (presenceTimer !== null || !running) return;
    presenceTimer = setTimeout(sendPresence, Math.max(0, sentAt + PRESENCE_EVERY_MS - Date.now()));
  };
  // One post at a time: what changes while one is out waits for it (merged into the next), so posts reach the server in
  // the order their state changed, and a slow network never bunches them into a burst the server refuses. One with no
  // answer in PRESENCE_DEADLINE_MS is given up (a connection that died quietly never holds this page's presence), and
  // the answer to one given up changes nothing.
  let inFlight: AbortController | null = null;
  let failures = 0;
  // Which hello the page's state was last sent in full after: a post from before it changes nothing when it fails.
  let epoch = 0;
  const sendPresence = () => {
    presenceTimer = null;
    if (!running || inFlight || snapshot.status !== 'live' || !othersHere()) return;
    const body: Partial<LiveState> = {};
    for (const key of Object.keys(unsent) as (keyof LiveState)[]) {
      if (parts.has(key)) (body as Record<string, unknown>)[key] = unsent[key];
    }
    if (!Object.keys(body).length) return;
    for (const key of Object.keys(body)) delete (unsent as Record<string, unknown>)[key];
    // An edit in progress that ended before its last place went out: its last place goes now, its end next.
    const ending = endedPreview !== null && body.preview === null ? endedPreview : null;
    if (ending) { body.preview = ending; unsent.preview = null; }
    endedPreview = null;
    sentAt = Date.now();
    const sentEpoch = epoch;
    const controller = new AbortController();
    inFlight = controller;
    const deadline = setTimeout(() => controller.abort(), PRESENCE_DEADLINE_MS);
    const sent = api(`${base}/live/presence`, { method: 'POST', body: JSON.stringify({ clientId, state: body }), signal: controller.signal });
    void sent.then(() => {
      clearTimeout(deadline);
      if (inFlight !== controller) return;
      inFlight = null;
      failures = 0;
      schedule();
    }, error => {
      clearTimeout(deadline);
      if (inFlight !== controller) return;
      inFlight = null;
      if (!running) return;
      // Sent before the stream's latest hello, which sends everything again: nothing of it is owed.
      if (sentEpoch !== epoch) { schedule(); return; }
      // Refused as malformed: sending it again would be refused again.
      if (error instanceof SaaSApiError && error.status >= 400 && error.status < 500 && error.status !== 429) { schedule(); return; }
      // Too fast for the server, no answer, or given up: the parts go again (as they are now) unless newer ones replaced
      // them, no sooner than the server asked, and later after each failure in a row. An edit's last place that did not
      // get there (sent as its drop place, or as its place when the edit ended while it was out) goes again before its
      // end, unless a new edit began meanwhile. With the stream down they wait for its hello.
      for (const key of Object.keys(body) as (keyof LiveState)[]) {
        if (!(key in unsent)) (unsent as Record<string, unknown>)[key] = state[key];
      }
      const lastPlace = ending ?? body.preview ?? null;
      if (lastPlace && state.preview === null && unsent.preview === null && endedPreview === null) endedPreview = lastPlace;
      failures += 1;
      sentAt = Math.max(sentAt, Date.now() + Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS) - PRESENCE_EVERY_MS);
      if (presenceTimer !== null) { clearTimeout(presenceTimer); presenceTimer = null; }
      schedule();
    });
  };
  const sendAllSoon = () => {
    unsent = { ...state };
    // A drop place the others never saw (the stream was down, or no one was here) is not needed: they see where it is.
    endedPreview = null;
    schedule();
  };
  // An edit in progress goes again while it lasts: the others let one go a while after its last update.
  const renewPreview = () => {
    if (state.preview && renewTimer === null) {
      renewTimer = setInterval(() => {
        if (!state.preview) return;
        unsent.preview = state.preview;
        schedule();
      }, PREVIEW_RENEW_MS);
    } else if (!state.preview && renewTimer !== null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  };
  const heardFrom = (ids: readonly string[], heard: ReadonlyMap<string, number> = snapshot.heard) => {
    const next = new Map(heard);
    const now = Date.now();
    for (const id of ids) next.set(id, now);
    return next;
  };
  const upsert = (participant: LiveParticipant) => {
    const list = snapshot.participants.filter(p => p.id !== participant.id);
    const at = snapshot.participants.findIndex(p => p.id === participant.id);
    if (at >= 0) list.splice(at, 0, participant); else list.push(participant);
    publish({ participants: list, you: participant.id === clientId ? participant : snapshot.you, heard: heardFrom([participant.id]) });
  };
  const dispatch = (event: string, data: any) => {
    switch (event) {
      case 'hello': {
        greeted = true;
        const participants: LiveParticipant[] = Array.isArray(data?.participants) ? data.participants : [];
        const messages: LiveMessage[] = Array.isArray(data?.messages) ? [...data.messages].reverse() : [];
        const named: (keyof LiveState)[] = Array.isArray(data?.presenceParts)
          ? data.presenceParts.filter((part: unknown): part is keyof LiveState => typeof part === 'string') : [];
        parts = new Set<keyof LiveState>([...FIRST_PARTS, ...named]);
        // A new stream: what this page sends starts afresh, with no wait left from failures before it.
        epoch += 1;
        failures = 0;
        sentAt = Number.NEGATIVE_INFINITY;
        if (presenceTimer !== null) { clearTimeout(presenceTimer); presenceTimer = null; }
        publish({ status: 'live', you: data?.you ?? null, participants, claims: Array.isArray(data?.claims) ? data.claims : [], messages,
          heard: heardFrom(participants.map(p => p.id), new Map()) });
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
        } else if (typeof data?.left === 'string') {
          const heard = new Map(snapshot.heard);
          heard.delete(data.left);
          publish({ participants: snapshot.participants.filter(p => p.id !== data.left), heard });
        }
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
  // When the open stream (or the attempt to open it) last brought anything, its pings included: one quiet for QUIET_MS
  // is opened again. `now` makes the next attempt skip its back-off (the browser is back online).
  let heardAt = Date.now();
  let now = false;
  const loop = async () => {
    let failures = 0;
    while (running) {
      const controller = new AbortController();
      abort = controller;
      greeted = false;
      heardAt = Date.now();
      try {
        const after = handlers.confirmedVersion();
        const url = `${API_BASE}${base}/live/events?after=${encodeURIComponent(String(after))}&client=${encodeURIComponent(clientId)}&device=${encodeURIComponent(device)}`;
        const response = await sessionFetch(url, { credentials: 'include', headers: { Accept: 'text/event-stream' }, signal: controller.signal });
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          running = false;
          publish({ status: 'offline', ended: response.status === 404 ? 'deleted' : 'access' });
          break;
        }
        if (!response.ok || !response.body) throw new Error(`live stream ${response.status}`);
        await readSseFrames(response.body, dispatch, () => { heardAt = Date.now(); });
      } catch { /* connects again below */ }
      if (batchTimer !== null) { clearTimeout(batchTimer); flushChanges(); }
      if (!running) break;
      publish({ status: 'connecting' });
      failures = greeted ? 1 : failures + 1;
      if (now) { now = false; continue; }
      const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures, 6));
      await pause(RECONNECT_MIN_MS + Math.random() * (ceiling - RECONNECT_MIN_MS));
    }
    if (!snapshot.ended) publish({ status: 'offline' });
  };
  const path = (tail: string) => `${base}${tail}`;
  // A tab put away takes its pointer off everyone's canvas.
  const hidden = () => { if (typeof document !== 'undefined' && document.hidden) live.setPresence({ cursor: null }); };
  // The watchdog: a stream that went quiet (a sleeping laptop, a network that changed under it), or an attempt to open
  // one that never answered, is opened again; one the browser says is back online is not left waiting out its back-off.
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  const watch = () => {
    if (running && wakeUp === null && Date.now() - heardAt > QUIET_MS) abort?.abort();
  };
  const online = () => {
    if (!running) return;
    if (wakeUp) { wakeUp(); return; }
    if (snapshot.status === 'live' && Date.now() - heardAt <= QUIET_MS / 2) return;
    now = true;
    abort?.abort();
  };
  const live: CanvasLive = {
    clientId,
    start() {
      if (running) return;
      running = true;
      publish({ status: 'connecting', ended: null });
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hidden);
      if (typeof window !== 'undefined') window.addEventListener('online', online);
      watchTimer = setInterval(watch, WATCH_EVERY_MS);
      void loop();
    },
    stop() {
      running = false;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hidden);
      if (typeof window !== 'undefined') window.removeEventListener('online', online);
      if (watchTimer !== null) { clearInterval(watchTimer); watchTimer = null; }
      abort?.abort();
      wakeUp?.();
      if (presenceTimer !== null) { clearTimeout(presenceTimer); presenceTimer = null; }
      if (renewTimer !== null) { clearInterval(renewTimer); renewTimer = null; }
      inFlight?.abort();
      inFlight = null;
      failures = 0;
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
        // An edit in progress ending while its last place has not gone out yet: that place goes first, so the others
        // see it where it was let go.
        if (key === 'preview' && value === null && unsent.preview) endedPreview = unsent.preview;
        // A new edit in progress takes over from an ended one's last place still waiting to go.
        if (key === 'preview' && value !== null) endedPreview = null;
        (state as unknown as Record<string, unknown>)[key] = value;
        (unsent as unknown as Record<string, unknown>)[key] = value;
        changed = true;
      }
      if (!changed) return;
      renewPreview();
      schedule();
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
