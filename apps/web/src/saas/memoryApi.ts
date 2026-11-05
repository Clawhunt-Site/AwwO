import { api, SaaSApiError, tenantPath } from './api';

/** A memory note: a short preference, fact, decision, lesson or style rule saved for one canvas or the whole
 *  workspace. The server quotes the relevant active notes to a node's model as untrusted background data. AwwO keeps
 *  notes of its own from a canvas's runs (origin run) and its learning cycles (origin evolution): until a person writes,
 *  changes or pins one (locked), AwwO may merge, move or archive it; an archived note says why (archivedReason). */
export type MemoryKind = 'preference' | 'fact' | 'decision' | 'lesson' | 'style';
export type MemoryStatus = 'active' | 'proposed' | 'archived';
export interface MemoryNote {
  id: string; canvasId: string | null; scope: 'canvas' | 'workspace'; title: string; body: string; kind: MemoryKind; status: MemoryStatus;
  origin: 'user' | 'run' | 'assistant' | 'evolution'; pinned: boolean;
  /** The run it came from; `distilled` for one AwwO's own model kept from a canvas run (graphId). */
  source: { runId?: string; nodeId?: string; graphId?: string; distilled?: boolean }; contentHash: string; version: number;
  useCount: number; lastUsedAt: string | null; createdAt: string; updatedAt: string;
  /** How many runs bore it out, and whether it is people's: absent from an API before self-learning. */
  evidence?: number; locked?: boolean; archivedReason?: MemoryArchivedReason | ''; successorId?: string | null; lastSeenAt?: string | null;
  /** A note AwwO wrote on probation to take another's place: that one leaves use once this one comes into it. */
  replacesId?: string | null;
}
/** Why AwwO archived a note: merged into another, replaced by a newer one, moved to the whole workspace, unused for a
 *  month, out of date, restating a person's note that was deleted or changed, or a change that made it taken back. */
export type MemoryArchivedReason = 'merged' | 'superseded' | 'promoted' | 'unused' | 'outdated' | 'restated' | 'tidied' | 'undone';
export interface MemoryDraft { canvasId?: string; title: string; body?: string; kind?: MemoryKind; pinned?: boolean; status?: 'active' | 'proposed'; source?: { runId?: string; nodeId?: string } }
export interface MemoryPatch { version: number; title?: string; body?: string; kind?: MemoryKind; pinned?: boolean; status?: MemoryStatus }

export const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'fact', 'decision', 'lesson', 'style'];
export const MEMORY_BODY_BYTES = 2048;
export const MEMORY_TITLE_CHARS = 200;

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string';
function note(x: unknown): x is MemoryNote {
  return object(x) && text(x.id) && (x.canvasId === null || text(x.canvasId)) && (x.scope === 'canvas' || x.scope === 'workspace') && text(x.title) && text(x.body)
    && MEMORY_KINDS.includes(x.kind as MemoryKind) && ['active', 'proposed', 'archived'].includes(String(x.status)) && typeof x.pinned === 'boolean'
    && Number.isSafeInteger(x.version) && Number.isSafeInteger(x.useCount) && object(x.source);
}
function checked<T>(value: unknown, check: (x: unknown) => x is T): T {
  if (!check(value)) throw new SaaSApiError(502, 'invalid_memory_response', 'Memory returned incomplete data. Try again.');
  return value;
}

export async function readMemory(tenantId: string, options: { canvasId?: string; status?: string; q?: string } = {}, signal?: AbortSignal): Promise<MemoryNote[]> {
  const query = new URLSearchParams();
  if (options.canvasId) query.set('canvasId', options.canvasId);
  if (options.status) query.set('status', options.status);
  if (options.q) query.set('q', options.q);
  const value = await api<unknown>(tenantPath(tenantId, `/memory${query.size ? `?${query}` : ''}`), { signal });
  return checked(value, (x): x is { items: MemoryNote[] } => object(x) && Array.isArray(x.items) && x.items.every(note)).items;
}
export async function createMemory(tenantId: string, draft: MemoryDraft, signal?: AbortSignal): Promise<MemoryNote> {
  return checked(await api<unknown>(tenantPath(tenantId, '/memory'), { method: 'POST', body: JSON.stringify(draft), signal }), note);
}
export async function updateMemory(tenantId: string, id: string, patch: MemoryPatch, signal?: AbortSignal): Promise<MemoryNote> {
  return checked(await api<unknown>(tenantPath(tenantId, `/memory/${encodeURIComponent(id)}`), { method: 'PATCH', body: JSON.stringify(patch), signal }), (x): x is MemoryNote => note(x) && x.id === id);
}
/** What a deletion did to the notes of AwwO's that said the same: how many it archived (setAside), and how many of the
 * whole workspace it no longer gives the deleted note's canvas (heldBack). */
export interface MemoryDeleted { setAside: number; heldBack: number }
/** Deletes a note, and answers what it did to the notes of AwwO's that said the same (MemoryDeleted). */
export async function deleteMemory(tenantId: string, id: string, signal?: AbortSignal): Promise<MemoryDeleted> {
  const result = await api<{ setAside?: unknown; heldBack?: unknown } | null>(tenantPath(tenantId, `/memory/${encodeURIComponent(id)}`), { method: 'DELETE', signal });
  const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
  return { setAside: count(result?.setAside), heldBack: count(result?.heldBack) };
}
