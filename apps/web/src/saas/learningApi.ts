import { api, SaaSApiError, tenantPath } from './api';

/** A workspace's learning settings (learning.go): self-learning, on wherever this AwwO offers it unless an admin turns
 *  it off, and Help improve AwwO, which only its owner turns on. An API from before self-learning has none: it reads
 *  as not offered, and its memory suggestions (`memorySuggestions`), while on, are kept for an admin to turn off. */
export interface LearningSetting { offered: boolean; on: boolean; since: string | null }
export interface LearningSettings { consent: LearningSetting; selfLearning: LearningSetting; elsewhere: boolean; memorySuggestions?: LearningSetting }

const notOffered: LearningSetting = { offered: false, on: false, since: null };
const setting = (x: unknown): x is LearningSetting => !!x && typeof x === 'object' && typeof (x as LearningSetting).offered === 'boolean'
  && typeof (x as LearningSetting).on === 'boolean' && ((x as LearningSetting).since === null || typeof (x as LearningSetting).since === 'string');
function checked(value: unknown): LearningSettings {
  const x = value as Partial<LearningSettings> | null;
  if (!x || !setting(x.consent) || (x.selfLearning !== undefined && !setting(x.selfLearning))) throw new SaaSApiError(502, 'invalid_learning_response', 'Learning settings returned incomplete data. Try again.');
  // An API before `elsewhere` says nothing of other workspaces.
  const settings: LearningSettings = { consent: x.consent, selfLearning: x.selfLearning ?? notOffered, elsewhere: x.elsewhere === true };
  const legacy = (x as { memorySuggestions?: unknown }).memorySuggestions;
  if (x.selfLearning === undefined && setting(legacy) && legacy.on) settings.memorySuggestions = legacy;
  return settings;
}

export async function readLearningSettings(tenantId: string, signal?: AbortSignal): Promise<LearningSettings> {
  return checked(await api<unknown>(tenantPath(tenantId, '/learning'), { signal }));
}
export async function updateLearningSettings(tenantId: string, change: { consent?: boolean; selfLearning?: boolean; memorySuggestions?: false }, signal?: AbortSignal): Promise<LearningSettings> {
  return checked(await api<unknown>(tenantPath(tenantId, '/learning'), { method: 'PUT', body: JSON.stringify(change), signal }));
}

/** One change a learning cycle made (learning_cycle.go): a node's lesson given to every node of its template
 *  (promote_lesson: its kind and template), notes moved to the whole workspace as one (promote_note), notes of one scope
 *  merged (merge_notes), or a note archived (archive_note): the note's title as it is now, how many notes it came from,
 *  the canvases they were on, and whether it was taken back, or can be. */
export type LearningChangeKind = 'promote_note' | 'merge_notes' | 'archive_note' | 'promote_lesson';
export interface LearningChange {
  id: string; kind: LearningChangeKind; canvasId: string | null; itemId: string; sources: number; title: string; lessonKind: string; templateId: string;
  canvases: string[]; undoneAt: string | null; createdAt: string; undoable: boolean;
}
/** One learning cycle of a workspace: how it ended (and, for one done without reading the notes, why: learning_off,
 *  few_notes…), whether its model read the workspace's notes, what it did, and its changes. */
export interface LearningCycle {
  id: string; state: 'running' | 'done' | 'failed'; reason: string; readNotes: boolean; counts: Record<string, number>;
  startedAt: string; finishedAt: string | null; changes: LearningChange[];
}
export interface LearningCycles { cycles: LearningCycle[]; everyHours: number }

const text = (x: unknown): x is string => typeof x === 'string';
const kinds: readonly LearningChangeKind[] = ['promote_note', 'merge_notes', 'archive_note', 'promote_lesson'];
const change = (x: unknown): x is LearningChange => {
  const c = x as LearningChange | null;
  return !!c && typeof c === 'object' && text(c.id) && kinds.includes(c.kind) && (c.canvasId === null || text(c.canvasId)) && text(c.itemId)
    && Number.isSafeInteger(c.sources) && text(c.title) && text(c.lessonKind) && text(c.templateId) && Array.isArray(c.canvases) && c.canvases.every(text)
    && (c.undoneAt === null || text(c.undoneAt)) && text(c.createdAt) && typeof c.undoable === 'boolean';
};
const cycle = (x: unknown): x is LearningCycle => {
  const c = x as LearningCycle | null;
  return !!c && typeof c === 'object' && text(c.id) && ['running', 'done', 'failed'].includes(c.state) && text(c.reason) && typeof c.readNotes === 'boolean'
    && !!c.counts && typeof c.counts === 'object' && text(c.startedAt) && (c.finishedAt === null || text(c.finishedAt)) && Array.isArray(c.changes) && c.changes.every(change);
};

export async function readLearningCycles(tenantId: string, signal?: AbortSignal): Promise<LearningCycles> {
  const value = await api<unknown>(tenantPath(tenantId, '/learning/cycles'), { signal }) as Partial<LearningCycles> | null;
  if (!value || !Array.isArray(value.cycles) || !value.cycles.every(cycle) || !Number.isSafeInteger(value.everyHours)) {
    throw new SaaSApiError(502, 'invalid_learning_response', 'Learning cycles returned incomplete data. Try again.');
  }
  return { cycles: value.cycles, everyHours: value.everyHours as number };
}
export async function undoLearningChange(tenantId: string, id: string, signal?: AbortSignal): Promise<void> {
  await api(tenantPath(tenantId, `/learning/changes/${encodeURIComponent(id)}/undo`), { method: 'POST', body: '{}', signal });
}
