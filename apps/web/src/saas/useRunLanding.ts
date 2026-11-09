import { useEffect, useRef, type MutableRefObject } from 'react';
import { api, SaaSApiError, tenantPath, type CanvasRecord } from './api';
import { sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import { readableConfirmed } from './canvasSync';
import { applyOps } from '../canvas/multiplayer/changes';
import type { CanvasRunJournal } from '../canvas/runJournal';
import { graphPath, readGraphRun, validGraphRunList, type GraphRunSnapshot, type GraphRunSummary } from './graphRuns';
import { ADOPT_ATTEMPTS, ADOPT_FIRST_MS, ADOPT_SINCE_MS, adoptionPollMs, endedRunsToCheck, logHoldsSinceEnd, missingResults, nodesRunSince,
  runLanding, runScope, touchedSinceEnd, workingHoldsLanding, type ChangeLog, type RunLanding } from './runAdoption';
import type { CanvasMultiplayer } from './useCanvasMultiplayer';

// 多人同屏: an open canvas lands the results of a run whose starter's page closed before it ended (runAdoption.ts says
// which and how). The landing is a whole-document save on the version it was decided on: the server takes it only while
// the canvas is still that version (AWWO-LAW-026), so nothing anyone did meanwhile is written over, and a second editor
// landing the same run is refused. The server records the save's change with no page's id, so every page, this one's
// included, takes it in as someone else's change (canvasSync.ts rebaseFor), which no one's undo or redo takes back. Nothing
// is written where another tab or a later opening would take the run for this person's own: no lane, journal or observer.

const canvasPath = (tenantId: string, canvasId: string) => tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}`);

/** The log is read for the newest few changes first (a run that ended a moment ago, most often), then further back, a
 *  step at a time, where those do not reach back to the run's end: the API sends at most 300 changes and 4 MiB of their
 *  ops at once, and nothing when there are more. */
const LOG_STEPS = [20, 80, 290] as const;
/** A landing's save that has not been answered by then is let go (the server may still take it: a later look sees it). */
const LANDING_TIMEOUT_MS = 30_000;
/** A look whose reads hang is let go by then, and the next comes at its pace. */
const LOOK_TIMEOUT_MS = 60_000;
let lookTimeoutMs = LOOK_TIMEOUT_MS;
/** Tests let a look go sooner; null puts the usual deadline back. */
export function setLookTimeoutForTests(ms: number | null): void { lookTimeoutMs = ms ?? LOOK_TIMEOUT_MS; }
/** A run the canvas moved under is looked at again after a look's pace, doubling each time up to this many looks; after
 *  ADOPT_RETRIES such tries it is left to the next opening. */
const RETRY_MAX_LOOKS = 8;
const ADOPT_RETRIES = 12;

/** Where the log is read from for a run: the version it was admitted at, or the newest `count` changes before `known`. */
const logStart = (run: Pick<GraphRunSummary, 'documentVersion'>, known: number, count: number) => Math.max(run.documentVersion, known - count);
/** A step that may hang (a catch-up of this page's copy) waited for at most `ms`. */
const within = (step: Promise<unknown>, ms: number) => Promise.race([step.catch(() => undefined), new Promise(resolve => setTimeout(resolve, ms))]);
const changesAfter = (tenantId: string, canvasId: string, after: number, signal: AbortSignal) =>
  api<ChangeLog>(`${canvasPath(tenantId, canvasId)}/changes?after=${after}`, { signal });

/** What an opening does with a run that ended (read whole). 多人同屏 (`live`): 'defer' for one that may hold a result the
 *  canvas lacks, which the open page lands (useRunLanding) by a save on the version it decides on, so a result someone
 *  publishes meanwhile is never cleared (a lane lands seconds after it was taken up, over whatever came in between);
 *  null for one to leave. One page alone on the canvas (a server without 多人同屏): the journal to take it up whole in a
 *  lane, as an opening always has, where nothing written since it ended would change (the same rule), else null. */
export async function endedRunOnOpening(run: GraphRunSnapshot, record: { version: number; document: CanvasDocument },
  items: readonly GraphRunSummary[], tenantId: string, canvasId: string, live: boolean, signal: AbortSignal): Promise<CanvasRunJournal | 'defer' | null> {
  const held = nodesRunSince(items, run);
  if (!missingResults(run, record.document, tenantId, held)) return null;
  if (live) return 'defer';
  const after = logStart(run, record.version, LOG_STEPS[LOG_STEPS.length - 1]);
  let log: ChangeLog | null = null;
  // An API that does not have it (one from before 多人同屏) leaves a result's own time to tell; one that fails to answer
  // leaves the run to the next opening.
  try { log = await changesAfter(tenantId, canvasId, after, signal); }
  catch (error) {
    if (signal.aborted || !(error instanceof SaaSApiError && (error.status === 404 || error.status === 405))) return null;
  }
  const landing = runLanding(run, record.document, tenantId, held, touchedSinceEnd(run, log, after, record.document));
  return landing?.whole ? landing.journal : null;
}

/** landed (with the version the server's save made); settled (looked at for good); gone (the list no longer names it:
 *  left as it is); later (asked again next time,
 *  nothing read); retry (the canvas or the page moved under the decision, or the save went unanswered: asked again after
 *  a while); conflict (the save was refused: the canvas had changed). */
type Outcome = { landed: number; nodes: readonly string[] } | 'settled' | 'gone' | 'later' | 'retry' | 'conflict';

interface LandingOptions {
  /** The canvas is open and live (多人同屏), on an editor's page. */
  enabled: boolean;
  tenantId: string;
  canvasId: string;
  /** The server's canvas as this page knows it (its confirmed record). */
  current: MutableRefObject<CanvasRecord | null>;
  multiplayer: MutableRefObject<CanvasMultiplayer>;
  /** A save of this page is out: the landing waits, and holds the next one while it is out itself. */
  saving: MutableRefObject<boolean>;
  /** Whether this page holds an edit not sent yet, or saving failed: no landing then. */
  unsaved: () => boolean;
  /** Runs the opening (or this page's surface, from a journal) left to this page: looked at however long ago they ended. */
  deferred: MutableRefObject<Set<string>>;
  /** Set to what makes the page look at once (a run just left to it). */
  poke?: MutableRefObject<() => void>;
}

/** The log since `run` ended, at the canvas's `version`: the first read (the newest few changes, read with the canvas),
 *  then the log further back from the server's own version (a page behind reads too far back to be answered), a step at a
 *  time, until it reaches back to the run's end. Keeps the widest it was answered; null when the canvas moved meanwhile. */
async function logSinceEnd(run: GraphRunSnapshot, options: LandingOptions, first: { log: ChangeLog; after: number }, version: number,
  signal: AbortSignal): Promise<{ log: ChangeLog; after: number } | null> {
  let best = first;
  for (const count of LOG_STEPS) {
    if (logHoldsSinceEnd(run, best.log, best.after)) return best;
    const after = logStart(run, version, count);
    if (after >= best.after && !best.log.reset) continue;
    const log = await changesAfter(options.tenantId, options.canvasId, after, signal);
    if (log.version !== version) return null;
    // Too much to send at once from there: what was read stays (the rest goes by a result's own time).
    if (log.reset) return best.log.reset ? { log, after } : best;
    best = { log, after };
  }
  return best;
}

/** The landing of `run` as the server's canvas, its log and its runs say now, with the canvas it is decided on; or why
 *  not. The runs are read last, just before the decision; after them nothing is awaited until the save. */
async function decideLanding(run: GraphRunSnapshot, options: LandingOptions, signal: AbortSignal):
  Promise<{ outcome: Outcome } | { landing: RunLanding; stored: CanvasRecord }> {
  const { tenantId, canvasId, current, multiplayer, saving, unsaved } = options;
  const live = multiplayer.current;
  // Not while this page sends something of its own, nor where a run, a chat or setup here holds the run's nodes.
  if (saving.current || unsaved() || !live.canLand(run.operationId, runScope(run))) return { outcome: 'later' };
  // The canvas as the server holds it, its name included (a rename moves no change's ops, so this page's copy may hold an
  // older one), and what changed since the run ended.
  const after = logStart(run, current.current?.version ?? run.documentVersion, LOG_STEPS[0]);
  const [log, stored] = await Promise.all([changesAfter(tenantId, canvasId, after, signal), api<CanvasRecord>(canvasPath(tenantId, canvasId), { signal })]);
  if (!Number.isSafeInteger(stored?.version) || log?.version !== stored.version) return { outcome: 'retry' };
  const since = await logSinceEnd(run, options, { log, after }, stored.version, signal);
  if (!since) return { outcome: 'retry' };
  if (current.current && current.current.version < stored.version) await within(live.catchUp(), 10_000);
  // The runs as they are now: a newer run over the same nodes may have started, and even ended, since the page last
  // looked, and neither moves the canvas's version.
  const listed = await api<unknown>(graphPath(tenantId, canvasId), { signal });
  // From here to the save nothing is awaited: the decision, what changed since the run ended, the canvas this page shows
  // and the save are of one version.
  if (!validGraphRunList(listed) || current.current?.version !== stored.version || saving.current || unsaved()) return { outcome: 'retry' };
  // A run the list no longer names (fifty newer runs since) is left: a newer run over its steps would not be seen.
  if (!listed.items.some(item => item.id === run.id)) return { outcome: 'gone' };
  const decided = sanitizeDocument(stored.document);
  const landing = runLanding(run, decided, tenantId, nodesRunSince(listed.items, run), touchedSinceEnd(run, since.log, since.after, decided));
  if (!landing) return { outcome: 'settled' };
  const working = live.working();
  if (!working || !workingHoldsLanding(sanitizeDocument(working), decided, landing) || !live.canLand(run.operationId, landing.nodes)) return { outcome: 'retry' };
  return { landing, stored };
}

/** Decides (its reads end with `reads`) and saves (the save, with `saves`, after LANDING_TIMEOUT_MS at most) the landing
 *  of `run`, holding this page's own saves while it is out. */
async function land(run: GraphRunSnapshot, options: LandingOptions, reads: AbortSignal, saves: AbortSignal): Promise<Outcome> {
  const decided = await decideLanding(run, options, reads);
  if ('outcome' in decided) return decided.outcome;
  const { landing, stored } = decided;
  let document: unknown;
  try { document = applyOps(stored.document as Record<string, unknown>, landing.ops).doc; } catch { return 'settled'; }
  const live = options.multiplayer.current;
  options.saving.current = true;
  let saved: CanvasRecord;
  try {
    saved = await api<CanvasRecord>(canvasPath(options.tenantId, options.canvasId), { method: 'PUT',
      body: JSON.stringify({ name: stored.name, document, version: stored.version }), signal: AbortSignal.any([saves, AbortSignal.timeout(LANDING_TIMEOUT_MS)]) });
  } catch (error) {
    if (error instanceof SaaSApiError && error.status === 409 && error.code === 'version_conflict') return 'conflict';
    // A refusal that would come again (a canvas over a bound, a newer page wanted) leaves the run; the rest is asked again.
    if (error instanceof SaaSApiError && error.status >= 400 && error.status < 500 && error.status !== 429) return 'settled';
    return 'retry';
  } finally {
    options.saving.current = false;
    live.settle();
  }
  // The change reaches this page as everyone's, from the live stream; read now too, in case the stream is down.
  await within(live.catchUp(), 10_000);
  return { landed: Number.isSafeInteger(saved?.version) ? saved.version : stored.version + 1, nodes: landing.nodes };
}

/** What a page remembers of the runs it has looked at, for as long as its canvas stays open. */
interface LookState {
  settled: Set<string>;
  /** Each run's outputs read without its frozen canvas, and a run read whole: an ended run does not change. */
  outputs: Map<string, Omit<GraphRunSnapshot, 'document'>>;
  wholeReads: Map<string, GraphRunSnapshot>;
  conflicts: Map<string, number>;
  retries: Map<string, { at: number; wait: number; count: number }>;
  /** Each run found holding nothing the canvas lacks, by the canvas's version and the newer runs over its steps then. */
  clean: Map<string, string>;
  /** Landed runs whose conversations are read again once this page holds the version the landing made. */
  rereads: { version: number; nodes: readonly string[] }[];
}

/** The run's outcome folded into what the page remembers: true when the run is looked at for good. */
function settledBy(state: LookState, id: string, outcome: Outcome): boolean {
  if (outcome === 'later') return false;
  if (outcome === 'retry') {
    // Each try reads the canvas whole and its log: a canvas that keeps moving is asked less often, then left.
    const pace = adoptionPollMs();
    const previous = state.retries.get(id);
    const wait = Math.min(RETRY_MAX_LOOKS * pace, Math.max(pace, (previous?.wait ?? 0) * 2));
    const count = (previous?.count ?? 0) + 1;
    state.retries.set(id, { at: Date.now() + wait, wait, count });
    return count >= ADOPT_RETRIES;
  }
  if (outcome === 'conflict') {
    const count = (state.conflicts.get(id) ?? 0) + 1;
    state.conflicts.set(id, count);
    return count >= ADOPT_ATTEMPTS;
  }
  return true;
}

export function useRunLanding(options: LandingOptions): void {
  const { enabled, tenantId, canvasId } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const state: LookState = { settled: new Set(), outputs: new Map(), wholeReads: new Map(), conflicts: new Map(), retries: new Map(),
      clean: new Map(), rereads: [] };
    const since = Date.now() - ADOPT_SINCE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let looking = false;
    let again = false;
    const settle = (id: string) => {
      state.settled.add(id); state.outputs.delete(id); state.wholeReads.delete(id); state.retries.delete(id); state.clean.delete(id);
      optionsRef.current.deferred.current.delete(id);
    };
    const live = () => optionsRef.current.multiplayer.current;
    // A landed run's conversations are read again once this page holds what the landing made (its issues with it).
    const reread = () => {
      const version = optionsRef.current.current.current?.version ?? 0;
      const due = state.rereads.filter(item => item.version <= version);
      if (!due.length) return;
      state.rereads = state.rereads.filter(item => item.version > version);
      live().landed(due.flatMap(item => item.nodes), false);
    };
    // The runs to look at: the list's. One left to this page (`before`, as the look began) that the list no longer names
    // (it holds the newest 50) is left as the canvas shows it: a newer run over its steps would not be seen, and its
    // results would land over that run's.
    const candidates = (listed: readonly GraphRunSummary[], before: ReadonlySet<string>): GraphRunSummary[] => {
      for (const id of before) if (!listed.some(item => item.id === id)) settle(id);
      return endedRunsToCheck(listed, Date.now(), since, optionsRef.current.deferred.current);
    };
    // A run left to this page that it does not land (another tab or page landed it, or it lands nothing): the
    // conversations of its steps this page has loaded are read again, as its turns joined them.
    const leave = (item: GraphRunSummary) => {
      if (optionsRef.current.deferred.current.has(item.id)) live().landed(runScope(item), false);
      settle(item.id);
    };
    // Whether a run may hold a result the canvas lacks, by its outputs (read once, without its frozen canvas) on the canvas
    // as this page holds it now (`shown`): a page behind may yet find one missing once it catches up, so only a run left
    // to it (the canvas it opened on) is settled for holding none; another is looked at again once the canvas or the
    // newer runs over its steps have changed.
    const mayMiss = async (item: GraphRunSummary, held: ReadonlySet<string>, shown: { version: number; document: CanvasDocument },
      signal: AbortSignal): Promise<boolean> => {
      const key = `${shown.version}|${[...held].sort().join(',')}`;
      const left = optionsRef.current.deferred.current.has(item.id);
      if (!left && state.clean.get(item.id) === key) return false;
      let outputs = state.outputs.get(item.id) ?? state.wholeReads.get(item.id);
      if (!outputs) {
        const { document: _shown, ...read } = await readGraphRun(tenantId, canvasId, item.id, signal, shown.document);
        outputs = read;
        state.outputs.set(item.id, read);
      }
      if (missingResults(outputs, shown.document, tenantId, held)) return true;
      if (!left) { state.clean.set(item.id, key); return false; }
      // Let go where nothing since the canvas this was decided on touched the run's steps, by the server's log read now:
      // on a page behind, a result that looks like the run's may be an earlier one, and the conversations read again
      // would be the wrong ones. Else the page catches up and the run is looked at again.
      const log = await changesAfter(tenantId, canvasId, shown.version, signal);
      const steps = new Set(runScope(item));
      if (!log.reset && Array.isArray(log.changes)
          && !log.changes.some(change => change.ops.some(op => op.path[0] === 'nodes' && op.path.length > 1 && steps.has(op.path[1])))) {
        leave(item);
        return false;
      }
      void live().catchUp().catch(() => undefined);
      return false;
    };
    const readWhole = async (item: GraphRunSummary, signal: AbortSignal): Promise<GraphRunSnapshot> => {
      const kept = state.wholeReads.get(item.id);
      if (kept?.document) return kept;
      const run = await readGraphRun(tenantId, canvasId, item.id, signal);
      state.wholeReads.set(item.id, run);
      return run;
    };
    const lookOnce = async (signal: AbortSignal) => {
      if (globalThis.document?.visibilityState === 'hidden') return;
      if (!live().saves.current || !live().working()) return;
      reread();
      const before = new Set(optionsRef.current.deferred.current);
      const listed = await api<unknown>(graphPath(tenantId, canvasId), { signal });
      if (!validGraphRunList(listed)) return;
      const items = candidates(listed.items, before);
      // What is kept of a run goes once it is no longer one to look at (its whole read holds a canvas, a megabyte for a
      // film): one left to the page is kept until it is let go.
      const looked = new Set(items.map(item => item.id));
      for (const kept of [state.outputs, state.clean, state.wholeReads]) {
        for (const id of kept.keys()) if (!looked.has(id) && !optionsRef.current.deferred.current.has(id)) kept.delete(id);
      }
      const record = optionsRef.current.current.current;
      if (!record) return;
      // The canvas as this page holds it, read once a version (a film's is about a megabyte).
      const shown = { version: record.version, document: readableConfirmed(record.document) };
      for (const item of items) {
        if (signal.aborted) return;
        if (state.settled.has(item.id) || (state.retries.get(item.id)?.at ?? 0) > Date.now()) continue;
        // The nodes a newer run holds or remade keep its results; one it covers whole is left at once.
        const held = nodesRunSince(listed.items, item);
        if (runScope(item).every(id => held.has(id))) { settle(item.id); continue; }
        if (!await mayMiss(item, held, shown, signal)) continue;
        // Read whole only where it could land now: not while this page sends something of its own or holds an edit not
        // sent, nor where a run, a chat or setup here holds its steps (asked again next time).
        const options = optionsRef.current;
        if (options.saving.current || options.unsaved() || !live().canLand(item.operationId, runScope(item))) continue;
        const outcome = await land(await readWhole(item, signal), options, signal, controller.signal);
        if (typeof outcome === 'object') {
          live().landed([], true);
          state.rereads.push({ version: outcome.landed, nodes: outcome.nodes });
          reread();
          settle(item.id);
        } else if (settledBy(state, item.id, outcome)) {
          if (outcome === 'settled') leave(item); else settle(item.id);
        }
      }
    };
    const look = async () => {
      if (looking) { again = true; return; }
      looking = true;
      try { await lookOnce(AbortSignal.any([controller.signal, AbortSignal.timeout(lookTimeoutMs)])); }
      catch { /* Looked at again next time; the run panel says when runs cannot be read. */ }
      finally {
        looking = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void look(), again ? 0 : adoptionPollMs());
        again = false;
      }
    };
    // A run left to this page (by the opening, or by the surface from a journal) is looked at as soon as possible.
    if (optionsRef.current.poke) optionsRef.current.poke.current = () => { clearTimeout(timer); timer = setTimeout(() => void look(), 0); };
    timer = setTimeout(() => void look(), optionsRef.current.deferred.current.size ? Math.min(ADOPT_FIRST_MS, adoptionPollMs()) : adoptionPollMs());
    return () => {
      controller.abort(); clearTimeout(timer);
      if (optionsRef.current.poke) optionsRef.current.poke.current = () => {};
    };
  }, [enabled, tenantId, canvasId]);
}
