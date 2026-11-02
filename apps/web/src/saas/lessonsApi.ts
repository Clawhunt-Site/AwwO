import { api, SaaSApiError, tenantPath } from './api';

/** A lesson a canvas run taught one of its nodes (canvas_lessons.go): written by a rule from how the node failed, given
 *  to the node's next runs (when `given`), counted as applied and as succeeded or failed by each settled run that was
 *  given it, and retired when it never helps (or by a person). `proposal` is what it suggests changing about the node,
 *  which the 经验 panel applies as a plan (a reasoning effort) or hands to the canvas assistant (a model). */
export type LessonKind = 'output_limit' | 'step_limit' | 'run_timeout' | 'workspace_context' | 'delivery' | 'context_limit' | 'provider';
export type LessonProposal = '' | 'lower_effort' | 'raise_effort' | 'larger_context' | 'other_model';
export type LessonProposalState = 'open' | 'asked' | 'dismissed' | 'applied';
export interface CanvasLesson {
  id: string; canvasId: string | null; nodeId: string | null; nodeTitle: string; kind: string; source: 'rule' | 'model' | 'person';
  rule: string; given: boolean; status: 'proposed' | 'active' | 'retired'; retiredReason: string; seen: number; applied: number;
  succeeded: number; failed: number; proposal: LessonProposal; proposalState: LessonProposalState;
  /** What the runs it was written from ran with: their runtime, model and reasoning effort. */
  scope: { runtime?: string; model?: string; effort?: string };
  /** The reasoning effort its node is set to in the canvas as saved ('' for the model's default), or null for a node no
   *  longer on the canvas (absent from an API before 2026-11-02). */
  nodeEffort?: string | null;
  /** The runs it was written from, newest first: how each ended in the platform's codes (a refused delivery's reason). */
  evidence: { graphId?: string; runId?: string; code?: string; reason?: string; attempts?: number }[];
  lastSeenAt: string; lastAppliedAt: string | null; createdAt: string; updatedAt: string;
}
/** One of a canvas's last runs, counted as the lessons are judged. */
export interface LessonRun { id: string; status: string; createdAt: string; endedAt: string; ran: number; firstPass: number; retried: number; failed: number; givenLessons: number }
export interface CanvasLessonsView { lessons: CanvasLesson[]; runs: LessonRun[] }

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string';
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
// A suggestion or a state this page does not know (from a newer API) is read as none, and as dismissed: the panel goes
// on showing the lessons, and offers nothing it does not understand.
const PROPOSALS: readonly string[] = ['', 'lower_effort', 'raise_effort', 'larger_context', 'other_model'];
const STATES: readonly string[] = ['open', 'asked', 'dismissed', 'applied'];
// An API from before 2026-11-02 returns no scope: a lesson read from it has none.
const scope = (x: unknown): boolean => x === undefined || (object(x) && ['runtime', 'model', 'effort'].every(key => x[key] === undefined || text(x[key])));
function lesson(x: unknown): x is CanvasLesson {
  return object(x) && text(x.id) && (x.nodeId === null || text(x.nodeId)) && text(x.nodeTitle ?? '') && text(x.kind) && text(x.rule)
    && typeof x.given === 'boolean' && ['proposed', 'active', 'retired'].includes(String(x.status)) && text(x.retiredReason)
    && count(x.seen) && count(x.applied) && count(x.succeeded) && count(x.failed) && text(x.proposal) && text(x.proposalState)
    && scope(x.scope) && (x.nodeEffort === undefined || x.nodeEffort === null || text(x.nodeEffort)) && Array.isArray(x.evidence);
}
function known(item: CanvasLesson): CanvasLesson {
  return { ...item, nodeTitle: item.nodeTitle ?? '', scope: item.scope ?? {},
    proposal: PROPOSALS.includes(item.proposal) ? item.proposal : '', proposalState: STATES.includes(item.proposalState) ? item.proposalState : 'dismissed' };
}
function run(x: unknown): x is LessonRun {
  return object(x) && text(x.id) && text(x.status) && text(x.createdAt) && count(x.ran) && count(x.firstPass) && count(x.retried) && count(x.failed) && count(x.givenLessons);
}
function checked<T>(value: unknown, check: (x: unknown) => x is T): T {
  if (!check(value)) throw new SaaSApiError(502, 'invalid_lessons_response', 'Lessons returned incomplete data. Try again.');
  return value;
}

export async function readCanvasLessons(tenantId: string, canvasId: string, signal?: AbortSignal): Promise<CanvasLessonsView> {
  const value = await api<unknown>(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/lessons`), { signal });
  const view = checked(value, (x): x is CanvasLessonsView => object(x) && Array.isArray(x.lessons) && x.lessons.every(lesson) && Array.isArray(x.runs) && x.runs.every(run));
  return { lessons: view.lessons.map(known), runs: view.runs };
}
export async function updateCanvasLesson(tenantId: string, id: string, patch: { status?: 'active' | 'retired'; proposalState?: LessonProposalState }, signal?: AbortSignal): Promise<CanvasLesson> {
  const value = await api<unknown>(tenantPath(tenantId, `/canvas-lessons/${encodeURIComponent(id)}`), { method: 'PATCH', body: JSON.stringify(patch), signal });
  return known(checked({ nodeTitle: '', ...(object(value) ? value : {}) }, lesson));
}
export type RunRating = 1 | -1 | 0;
const rating = (x: unknown): x is RunRating => x === 1 || x === -1 || x === 0;
/** The thumbs the signed-in person gave a run's result: 1 up, -1 down, 0 none. */
export async function readRunRating(tenantId: string, runId: string, signal?: AbortSignal): Promise<RunRating> {
  const value = await api<unknown>(tenantPath(tenantId, `/runs/${encodeURIComponent(runId)}/rating`), { signal });
  return checked(value, (x): x is { rating: RunRating } => object(x) && rating(x.rating)).rating;
}
/** A person's thumbs for a completed run's result: 1 up, -1 down, 0 takes it back. */
export async function rateRun(tenantId: string, runId: string, value: RunRating, signal?: AbortSignal): Promise<RunRating> {
  const answer = await api<unknown>(tenantPath(tenantId, `/runs/${encodeURIComponent(runId)}/rating`), { method: 'PUT', body: JSON.stringify({ rating: value }), signal });
  return checked(answer, (x): x is { rating: RunRating } => object(x) && rating(x.rating)).rating;
}
