// The canvas page's side of a canvas that evolves by itself (canvas_evolution.go, evolutionApi.ts). The server says what
// is due once the canvas's latest run is learnt from. This page claims each change first (the server checks it is due
// as it stands and names its efforts), makes it as a person takes a suggestion (the surface's applyEvolution: an
// undoable plan the assistant's panel describes, one at a time behind the 经验 panel's own, and only on a node still at
// the effort it was claimed from), and settles it: done once the canvas as saved holds it (the save that makes it
// settles it too, on the server, so a page that closes first loses nothing), or skipped with why. A change the surface
// has not taken in EVOLUTION_QUEUE_WAIT, or when the page leaves the canvas, is taken back and skipped (the surface drops
// it unsaid); one it took and the canvas has not saved is the server's to settle as the canvas comes to hold it. A canvas run this page started and saw end (the surface names it) is then rerun as the server allows
// (the surface's autoRun), only once every change of that run's end is settled, so that the rerun counts as a run after
// them; a page reruns a run once at most. Opening the canvas applies what is due once the page shows it (not while it
// loads, or shows its drafts), and never reruns. One tab acts at a time (a lock per canvas): another tab leaves an opening
// to the tab at work, and waits for it with a run's end; a page that leaves lets the lock go at once.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasAutoRun, CanvasEvolution, CanvasEvolutionResult } from '../canvas/CanvasSurface';
import { SaaSApiError } from './api';
import { claimCanvasEvolution, readCanvasEvolution, settleCanvasEvolution, type CanvasEvolutionView, type EvolutionClaim, type EvolutionEntry, type EvolutionLimits, type EvolutionStep } from './evolutionApi';

type Translate = (zh: string, en: string) => string;

/** A run that ended is learnt from in the background, in a moment as a rule: the page reads its evolution again every
 *  EVOLUTION_POLL_EVERY for at most EVOLUTION_POLL_FOR until it is. */
export const EVOLUTION_POLL_EVERY = 1000;
export const EVOLUTION_POLL_FOR = 45_000;
/** How long a change claimed waits for the surface to take it (in turn, once the canvas is ready); then it is taken
 *  back and skipped. */
export const EVOLUTION_QUEUE_WAIT = 90_000;
/** How long the page waits for the canvas as saved to hold a change the surface took; then it leaves the change to the
 *  server (the save that makes it settles it there; one never made is let go after a while). */
export const EVOLUTION_SAVE_WAIT = 120_000;
/** How long one request of the evolution may take. */
export const EVOLUTION_REQUEST_WAIT = 30_000;
/** How long the page waits for the surface to say whether a rerun started; then it lets the canvas go (a run admitted
 *  goes on, and is asked for no more). */
export const EVOLUTION_RERUN_WAIT = 60_000;
/** How often a settle the network lost is sent again, the first after EVOLUTION_RETRY_AFTER, each wait doubled. */
export const EVOLUTION_RETRIES = 2;
export const EVOLUTION_RETRY_AFTER = 1000;

const effortName = (effort: string, t: Translate) => effort || t('模型默认', 'the model’s default');

/** What the assistant's panel says of a change the canvas makes by itself, in the reader's words. */
export function evolutionNote(step: EvolutionStep, limits: Pick<EvolutionLimits, 'revertAfterRuns'>, t: Translate): string {
  const node = step.nodeTitle || step.nodeId;
  if (step.revertsId) return t(`自动进化：「${node}」调成 ${effortName(step.from, t)} 之后，接下来 ${limits.revertAfterRuns} 次运行都没完成。把它的推理强度改回 ${effortName(step.effort, t)}。`,
    `Auto-evolve: “${node}” finished none of its ${limits.revertAfterRuns} runs since it was set to ${effortName(step.from, t)}. Setting its reasoning effort back to ${effortName(step.effort, t)}.`);
  if (step.proposal === 'raise_effort') return t(`自动进化：「${node}」在 low 推理强度下又没能完成交付。把它的推理强度调回 medium，模型不变。`,
    `Auto-evolve: “${node}” again failed to deliver at low reasoning effort. Setting its reasoning effort back to medium and keeping its model.`);
  return t(`自动进化：「${node}」上次停在模型的输出上限，没有交付完。把它的推理强度调成 low，模型不变。`,
    `Auto-evolve: “${node}” stopped at its model’s output limit last time without finishing. Setting its reasoning effort to low and keeping its model.`);
}

/** What the assistant's panel says when the canvas reruns its unfinished nodes by itself. */
export function rerunNote(nodes: number, limits: Pick<EvolutionLimits, 'rerunsLastDay' | 'rerunsPerDay'>, t: Translate): string {
  return t(`自动进化：把上次没完成的 ${nodes} 个节点再跑一次，带上刚学到的经验。会消耗额度；这是 24 小时内第 ${limits.rerunsLastDay + 1} 次自动重跑（最多 ${limits.rerunsPerDay} 次）。`,
    `Auto-evolve: running the ${nodes} unfinished ${nodes === 1 ? 'node' : 'nodes'} once more, with what was just learnt. This spends credits; it is automatic rerun ${limits.rerunsLastDay + 1} of at most ${limits.rerunsPerDay} in 24 hours.`);
}

/** What the assistant's panel says when a person takes a change back. */
export function revertNote(entry: EvolutionEntry, t: Translate): string {
  const node = entry.nodeTitle || entry.nodeId;
  return t(`把「${node}」的推理强度改回 ${effortName(entry.from, t)}（撤销自动进化的这次调整）。`,
    `Setting “${node}”’s reasoning effort back to ${effortName(entry.from, t)} (undoing this change auto-evolve made).`);
}

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// The ends a canvas run is learnt from (a cancelled run teaches nothing, and is never marked learnt).
const LEARNT_ENDS: readonly string[] = ['completed', 'failed', 'interrupted'];
// A failure worth sending again: the network's, or the server's own (not its word on the change).
const transient = (error: unknown) => !(error instanceof SaaSApiError) || error.status === 0 || error.status === 429 || error.status >= 500;
// A request is given up after EVOLUTION_REQUEST_WAIT, and a read when the page leaves too.
const bounded = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(EVOLUTION_REQUEST_WAIT)]) : AbortSignal.timeout(EVOLUTION_REQUEST_WAIT);
const LEFT: [string, string] = ['页面离开了画布，这项调整没有做。', 'The page left the canvas before it made this change.'];

/** Where the page's changes go to the surface, in turn with the 经验 panel's own suggestions (useLessonEvolutions). */
export interface EvolutionQueue {
  enqueue: (evolution: CanvasEvolution) => void;
  /** Takes back a change the surface has not taken yet: whether it was still waiting. */
  withdraw: (id: string) => boolean;
}

/** One change claimed and handed to the surface, waiting for it to take it ('queued'), then for the canvas as saved to
 *  hold it ('saving'). `done` says whether the server has it settled. */
interface Tracked {
  changeId: string; nodeId: string; effort: string; state: 'queued' | 'saving'; posting: boolean;
  // Taken back before the surface took it: the surface drops it unsaid.
  withdrawn?: boolean;
  // The wait for the canvas as saved is over: a last refusal that it does not hold the change skips it.
  waited?: boolean;
  timer?: ReturnType<typeof setTimeout>; done: (settled: boolean) => void;
}

/** Whether a canvas document runs node `nodeId` at its own effort `effort`, as the canvas's plan left it. */
function holds(document: unknown, item: Pick<Tracked, 'nodeId' | 'effort'>): boolean {
  const nodes = object(document) ? document.nodes : undefined;
  const node = Array.isArray(nodes) ? nodes.find(entry => object(entry) && entry.id === item.nodeId) : undefined;
  return object(node) && node.kind === 'session' && (typeof node.effort === 'string' ? node.effort : '') === item.effort;
}

/** Runs `work` while this tab holds the canvas's evolution lock: once another tab lets it go when `wait` (a run's end,
 *  which only the tab that saw it can rerun), or not at all while another tab holds it (an opening, which that tab
 *  covers). `signal` (the page leaving) lets a wait go, and the lock with it: work still under way then stops at its next
 *  step. A browser without locks runs it. */
async function alone(name: string, wait: boolean, signal: AbortSignal, work: () => Promise<void>): Promise<void> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  const held = async () => {
    let stop!: () => void;
    const gone = new Promise<void>(resolve => { stop = resolve; });
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    try { await Promise.race([work(), gone]); } finally { signal.removeEventListener('abort', stop); }
  };
  if (!locks) return held();
  if (wait) await locks.request(name, { signal }, async () => { if (!signal.aborted) await held(); });
  else await locks.request(name, { ifAvailable: true }, async lock => { if (lock) await held(); });
}

export interface CanvasEvolutionDriver {
  /** Work this page watched ended, naming the canvas runs it saw end. */
  runEnded: (graphIds: readonly string[]) => void;
  /** The surface settled a suggestion (the driver takes only its own). */
  settled: (id: string, result: CanvasEvolutionResult) => void;
  /** The cloud confirmed a canvas. */
  saved: (document: unknown) => void;
  /** The rerun the surface is asked to start, and what came of it. */
  autoRun: CanvasAutoRun | null;
  autoRunSettled: (id: string, result: { started: boolean }) => void;
  /** A person takes a change back (the 经验 panel's 改回). */
  revert: (entry: EvolutionEntry) => void;
}

type Pass = { trigger: 'opened' | 'ended'; mine: number; watched: string[] };

/** The driver of canvas `canvasId`'s evolution. `ready`: the page shows the canvas (its surface takes suggestions). */
export function useCanvasEvolution(tenantId: string, canvasId: string, queue: EvolutionQueue, t: Translate, ready = true): CanvasEvolutionDriver {
  // Each time the page shows the canvas is a generation (the effect below): a pass of an earlier one (the canvas left,
  // or React's development remount) stops at its next step, and the generation's signal lets its waits and reads go.
  const generation = useRef(0);
  const leaving = useRef(new AbortController());
  const tracked = useRef(new Map<string, Tracked>());
  const confirmed = useRef<unknown>(null);
  const sequence = useRef(0);
  const [autoRun, setAutoRun] = useState<CanvasAutoRun | null>(null);
  const started = useRef<{ id: string; done: () => void } | null>(null);
  // The reruns this page asked for: each at most once.
  const asked = useRef(new Set<string>());
  const say = useRef(t);
  say.current = t;
  const hand = useRef(queue);
  hand.current = queue;
  const finish = useCallback((id: string, settled: boolean) => {
    const item = tracked.current.get(id);
    if (!item) return;
    tracked.current.delete(id);
    clearTimeout(item.timer);
    item.done(settled);
  }, []);
  // A settle the network lost is sent again; one the canvas as saved does not hold yet waits for the next canvas the
  // cloud confirms, and at the end of the wait is left to the server, as is any other refusal: the save that makes the
  // change settles it there, and a claim no save makes is let go after a while.
  const post = useCallback(async (id: string, skipped?: string) => {
    const item = tracked.current.get(id);
    if (!item || item.posting) return;
    item.posting = true;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await settleCanvasEvolution(tenantId, canvasId, item.changeId, skipped ? { skipped } : { done: true }, bounded());
        finish(id, true);
        return;
      } catch (error) {
        if (tracked.current.get(id) !== item) return;
        if (!skipped && error instanceof SaaSApiError && error.code === 'evolution_unsaved') {
          item.posting = false;
          if (item.waited) finish(id, false);
          return;
        }
        if (!transient(error) || attempt >= EVOLUTION_RETRIES) { finish(id, false); return; }
        await sleep(EVOLUTION_RETRY_AFTER * 2 ** attempt);
        if (tracked.current.get(id) !== item) return;
      }
    }
  }, [tenantId, canvasId, finish]);
  // A change the surface has not taken is taken back and skipped with why: it is not made for that run's end.
  const letGo = useCallback((id: string, reason: string) => {
    const item = tracked.current.get(id);
    if (!item || item.state !== 'queued' || item.withdrawn) return;
    item.withdrawn = true;
    hand.current.withdraw(id);
    void post(id, reason);
  }, [post]);
  // A step is claimed, then goes to the surface as a suggestion: true once the server has it settled, or never claimed
  // it (not due, as another tab or a person may have made it so); false for a claim left unsettled.
  const take = useCallback(async (claim: EvolutionClaim, model: string, note: (change: EvolutionEntry) => string): Promise<boolean> => {
    const mine = generation.current;
    // A node whose effort anything sets after this (even back to the same value) is left as it is: on the page's
    // monotonic clock, as the surface reads it.
    const since = performance.now();
    let change: EvolutionEntry;
    // A claim is not let go when the page leaves (its answer is settled at once then), only when it takes too long.
    try { ({ change } = await claimCanvasEvolution(tenantId, canvasId, claim, bounded())); }
    catch (error) { return !transient(error); }
    // The page left while the claim was on its way: it is let go at once rather than left for the server to.
    if (generation.current !== mine) {
      void settleCanvasEvolution(tenantId, canvasId, change.id, { skipped: say.current(...LEFT) }, bounded()).catch(() => undefined);
      return false;
    }
    const id = `evolution:${++sequence.current}`;
    return new Promise<boolean>(resolve => {
      const item: Tracked = { changeId: change.id, nodeId: change.nodeId, effort: change.to, state: 'queued', posting: false, done: resolve };
      item.timer = setTimeout(() => letGo(id, say.current('画布没能及时做这项调整。', 'The canvas did not get to this change in time.')), EVOLUTION_QUEUE_WAIT);
      tracked.current.set(id, item);
      hand.current.enqueue({ id, nodeId: change.nodeId, effort: change.to, model, note: note(change), expect: change.from, change: change.id, since,
        ...(change.revertsId ? { expectMark: change.revertsId } : {}),
        wanted: () => tracked.current.get(id) === item && !item.withdrawn });
    });
  }, [tenantId, canvasId, letGo]);
  const settled = useCallback((id: string, result: CanvasEvolutionResult) => {
    const item = tracked.current.get(id);
    if (!item || item.state !== 'queued' || item.withdrawn) return;
    clearTimeout(item.timer);
    if (!result.applied && !result.satisfied) {
      // A change the canvas did not make is skipped with why (said in the assistant's panel too), so that it is not due
      // again for that run's end.
      void post(id, (result.reason ?? '').trim().slice(0, 300) || say.current('画布没有应用这项调整。', 'The canvas did not take this change.'));
      return;
    }
    item.state = 'saving';
    item.timer = setTimeout(() => { item.waited = true; if (!item.posting) void post(id); }, EVOLUTION_SAVE_WAIT);
    if (holds(confirmed.current, item)) void post(id);
  }, [post]);
  const saved = useCallback((document: unknown) => {
    confirmed.current = document;
    for (const [id, item] of tracked.current) if (item.state === 'saving' && holds(document, item)) void post(id);
  }, [post]);

  const stepOf = useCallback((step: EvolutionStep, graphId: string, view: CanvasEvolutionView) => take(
    { graphId, nodeId: step.nodeId, ...(step.lessonId ? { lessonId: step.lessonId } : { revertsId: step.revertsId }) }, step.model,
    () => evolutionNote(step, view.limits, say.current)), [take]);

  // One pass at a time: work that ends while one is under way has its own pass after it.
  const working = useRef(false);
  const queued = useRef<Pass | null>(null);
  const pass = useCallback(async ({ trigger, mine, watched }: Pass): Promise<void> => {
    if (working.current) {
      const waiting = queued.current;
      queued.current = { trigger: waiting?.trigger === 'ended' ? 'ended' : trigger, mine, watched: [...(waiting?.watched ?? []), ...watched] };
      return;
    }
    working.current = true;
    const current = () => generation.current === mine;
    const signal = leaving.current.signal;
    try {
      await alone(`awwo.canvas.evolution:${tenantId}/${canvasId}`, trigger === 'ended', signal, async () => {
        let view = await readCanvasEvolution(tenantId, canvasId, bounded(signal));
        if (!view.autoApply.on && !view.autoRerun.on) return;
        for (let waited = 0; trigger === 'ended' && current() && view.latestRun && !view.latestRun.learnt && LEARNT_ENDS.includes(view.latestRun.status)
            && waited < EVOLUTION_POLL_FOR; waited += EVOLUTION_POLL_EVERY) {
          await sleep(EVOLUTION_POLL_EVERY);
          view = await readCanvasEvolution(tenantId, canvasId, bounded(signal));
        }
        const latest = view.latestRun;
        if (!current() || !latest?.learnt) return;
        const steps = [...view.pending.revert, ...view.pending.apply];
        const settledAll = (await Promise.all(steps.map(step => stepOf(step, latest.id, view)))).every(Boolean);
        // Only a run this page saw end is rerun, and only once its changes are settled.
        if (trigger !== 'ended' || !watched.includes(latest.id) || !settledAll || !current()) return;
        const now = steps.length ? await readCanvasEvolution(tenantId, canvasId, bounded(signal)) : view;
        const rerun = now.pending.rerun;
        if (!current() || !rerun || rerun.graphId !== latest.id || asked.current.has(rerun.operationId)) return;
        asked.current.add(rerun.operationId);
        const id = `autorun:${++sequence.current}`;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, EVOLUTION_RERUN_WAIT);
          started.current = { id, done: () => { clearTimeout(timer); resolve(); } };
          setAutoRun({ id, scope: rerun.scope, operationId: rerun.operationId, note: rerunNote(rerun.scope.length, now.limits, say.current) });
        });
      });
    } catch { /* The next run's end, or the next opening, reads it again. */ }
    finally {
      working.current = false;
      const next = queued.current;
      queued.current = null;
      if (next && next.mine === generation.current) void pass(next);
    }
  }, [tenantId, canvasId, stepOf]);
  const autoRunSettled = useCallback((id: string) => {
    setAutoRun(current => current?.id === id ? null : current);
    if (started.current?.id === id) { const { done } = started.current; started.current = null; done(); }
  }, []);
  // A node's own message, or a run refused before it began, names no canvas run: nothing of it is for the canvas to take.
  const runEnded = useCallback((graphIds: readonly string[]) => {
    if (graphIds.length) void pass({ trigger: 'ended', mine: generation.current, watched: [...graphIds] });
  }, [pass]);
  const revert = useCallback((entry: EvolutionEntry) => {
    void take({ graphId: entry.graphId, nodeId: entry.nodeId, revertsId: entry.id, auto: false }, '', () => revertNote(entry, say.current));
  }, [take]);

  // Each time the page shows the canvas is a generation, whose opening applies what is due; the page leaving the canvas
  // (closing, or showing its drafts again) ends it as a leave: its waits, reads and lock let go, and the changes the
  // surface has not taken, and the rerun it was asked for, with them.
  useEffect(() => {
    if (!ready) return;
    const mine = ++generation.current;
    leaving.current = new AbortController();
    void pass({ trigger: 'opened', mine, watched: [] });
    return () => {
      generation.current += 1;
      leaving.current.abort();
      for (const [id, item] of [...tracked.current]) {
        // A change the surface has not taken is taken back and let go at once; one it took is the server's to settle as
        // the canvas as saved holds it.
        if (item.state === 'queued' && !item.withdrawn && !item.posting) {
          item.withdrawn = true;
          hand.current.withdraw(id);
          void settleCanvasEvolution(tenantId, canvasId, item.changeId, { skipped: say.current(...LEFT) }, bounded()).catch(() => undefined);
        }
        finish(id, false);
      }
      started.current?.done();
      started.current = null;
      setAutoRun(null);
    };
  }, [ready, tenantId, canvasId, pass, finish]);
  return { runEnded, settled, saved, autoRun, autoRunSettled, revert };
}
