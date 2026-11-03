import { api, SaaSApiError, tenantPath } from './api';

/** A canvas that evolves by itself (canvas_evolution.go): two switches a member turns on, off until then. Auto apply
 *  has each node that failed in a run take its lesson's suggested reasoning effort; auto rerun runs the run's unfinished
 *  nodes once more. The server says what is due once the latest run is learnt from; the canvas page claims each change
 *  (the server names its efforts), makes it, and settles it (claimCanvasEvolution, settleCanvasEvolution). */
export interface EvolutionSwitch { on: boolean; since: string | null }
/** A change due for one node: a lesson's suggested effort (`lessonId`), or the revert of a change that did not help
 *  (`revertsId`), from the node's own effort to `effort`, on `model` (the node's own, or its lesson's runs'). */
export interface EvolutionStep {
  lessonId?: string; revertsId?: string; nodeId: string; nodeTitle: string; kind: string; proposal?: string; seen?: number;
  from: string; effort: string; model: string;
}
/** The rerun due: canvas run `graphId`'s unfinished nodes, to run under `operationId`. */
export interface EvolutionRerun { graphId: string; operationId: string; scope: string[] }
/** The canvas's latest canvas run: whether it was learnt from (it has ended then), whether it is itself an auto rerun,
 *  and the auto rerun of it. */
export interface EvolutionRun { id: string; status: string; learnt: boolean; endedAt: string; autoRerun: boolean; rerunId: string | null }
/** One thing the canvas's evolution did: an effort change, its revert (by the canvas, or a person: `auto` false), a
 *  change the page could not make (`reason`; empty for one claimed and never settled), or a rerun (`rerunGraphId`). A
 *  change is `claimed` until settled (`done`), or `expired` when never settled; one that `standing` still holds the
 *  node at the effort it set, for a person to take back. */
export interface EvolutionEntry {
  id: string; kind: 'effort' | 'revert' | 'skip' | 'rerun'; auto: boolean; nodeId: string; nodeTitle: string; lessonId: string | null;
  graphId: string; revertsId: string | null; rerunGraphId: string | null; from: string; to: string; reason: string; createdAt: string;
  doneAt: string | null; state: 'claimed' | 'done' | 'expired'; reverted: boolean; standing: boolean;
}
export interface EvolutionLimits { rerunsLastDay: number; rerunsPerDay: number; revertAfterRuns: number; changeEveryHours: number; changesPerWeek: number }
export interface CanvasEvolutionView {
  autoApply: EvolutionSwitch; autoRerun: EvolutionSwitch; latestRun: EvolutionRun | null;
  pending: { apply: EvolutionStep[]; revert: EvolutionStep[]; rerun: EvolutionRerun | null };
  limits: EvolutionLimits; log: EvolutionEntry[];
}
/** A change to claim: a lesson's suggested effort or a revert, of node `nodeId` at the end of canvas run `graphId`; a
 *  person's revert is `auto: false`. */
export interface EvolutionClaim { graphId: string; nodeId: string; lessonId?: string; revertsId?: string; auto?: boolean }

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string';
const optionalText = (x: unknown) => x === undefined || text(x);
const nullableText = (x: unknown) => x === null || text(x);
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const evolutionSwitch = (x: unknown): x is EvolutionSwitch => object(x) && typeof x.on === 'boolean' && nullableText(x.since);
function step(x: unknown): x is EvolutionStep {
  return object(x) && optionalText(x.lessonId) && optionalText(x.revertsId) && (text(x.lessonId) !== text(x.revertsId)) && text(x.nodeId) && x.nodeId !== ''
    && text(x.nodeTitle) && text(x.kind) && optionalText(x.proposal) && (x.seen === undefined || count(x.seen)) && text(x.from) && text(x.effort) && text(x.model);
}
const rerun = (x: unknown): x is EvolutionRerun => object(x) && text(x.graphId) && text(x.operationId) && Array.isArray(x.scope) && x.scope.length > 0 && x.scope.every(text);
const run = (x: unknown): x is EvolutionRun => object(x) && text(x.id) && text(x.status) && typeof x.learnt === 'boolean' && text(x.endedAt)
  && typeof x.autoRerun === 'boolean' && nullableText(x.rerunId);
const KINDS: readonly string[] = ['effort', 'revert', 'skip', 'rerun'];
const STATES: readonly string[] = ['claimed', 'done', 'expired'];
function entry(x: unknown): x is EvolutionEntry {
  return object(x) && text(x.id) && text(x.kind) && typeof x.auto === 'boolean' && text(x.nodeId) && text(x.nodeTitle) && nullableText(x.lessonId)
    && text(x.graphId) && nullableText(x.revertsId) && nullableText(x.rerunGraphId) && text(x.from) && text(x.to) && text(x.reason)
    && text(x.createdAt) && nullableText(x.doneAt) && text(x.state) && typeof x.reverted === 'boolean' && typeof x.standing === 'boolean';
}
// An entry of a kind or a state from a newer API is left out of the log rather than shown as one this page knows.
const known = (item: EvolutionEntry) => KINDS.includes(item.kind) && STATES.includes(item.state);
const limits = (x: unknown): x is EvolutionLimits => object(x) && ['rerunsLastDay', 'rerunsPerDay', 'revertAfterRuns', 'changeEveryHours', 'changesPerWeek'].every(key => count(x[key]));
function view(x: unknown): x is CanvasEvolutionView {
  if (!object(x) || !evolutionSwitch(x.autoApply) || !evolutionSwitch(x.autoRerun) || !(x.latestRun === null || run(x.latestRun)) || !limits(x.limits)) return false;
  const pending = x.pending;
  return object(pending) && Array.isArray(pending.apply) && pending.apply.every(step) && Array.isArray(pending.revert) && pending.revert.every(step)
    && (pending.rerun === null || rerun(pending.rerun)) && Array.isArray(x.log) && x.log.every(entry);
}
const invalid = () => new SaaSApiError(502, 'invalid_evolution_response', 'The canvas evolution returned incomplete data. Try again.');
function checked(value: unknown): CanvasEvolutionView {
  if (!view(value)) throw invalid();
  return { ...value, log: value.log.filter(known) };
}
const path = (tenantId: string, canvasId: string, rest = '') => tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/evolution${rest}`);

export async function readCanvasEvolution(tenantId: string, canvasId: string, signal?: AbortSignal): Promise<CanvasEvolutionView> {
  return checked(await api<unknown>(path(tenantId, canvasId), { signal }));
}
/** Turns a canvas's switches on or off; answers its evolution. */
export async function updateCanvasEvolution(tenantId: string, canvasId: string, change: { autoApply?: boolean; autoRerun?: boolean }, signal?: AbortSignal): Promise<CanvasEvolutionView> {
  return checked(await api<unknown>(path(tenantId, canvasId), { method: 'PUT', body: JSON.stringify(change), signal }));
}
/** Claims a change before the page makes it: the change as claimed (its efforts the server's), with the evolution. */
export async function claimCanvasEvolution(tenantId: string, canvasId: string, claim: EvolutionClaim, signal?: AbortSignal): Promise<{ change: EvolutionEntry; evolution: CanvasEvolutionView }> {
  const value = await api<unknown>(path(tenantId, canvasId, '/changes'), { method: 'POST', body: JSON.stringify(claim), signal });
  if (!object(value) || !entry(value.change) || value.change.state !== 'claimed' || !known(value.change)) throw invalid();
  return { change: value.change, evolution: checked(value.evolution) };
}
/** Settles a change claimed: done once the canvas as saved holds it, or skipped with why; answers the evolution. */
export async function settleCanvasEvolution(tenantId: string, canvasId: string, changeId: string, settle: { done: true } | { skipped: string }, signal?: AbortSignal): Promise<CanvasEvolutionView> {
  return checked(await api<unknown>(path(tenantId, canvasId, `/changes/${encodeURIComponent(changeId)}`), { method: 'POST', body: JSON.stringify(settle), signal }));
}
