import { api, SaaSApiError, tenantPath } from './api';

/** A skill is method guidance a node can carry (built in, or written by this workspace). The server freezes the
 *  chosen skills' exact text into each run, so this module only lists, reads and edits them. */
export type SkillSource = 'builtin' | 'workspace';
export interface SkillSummary {
  ref: string; id?: string; name: string; title: string; titleZh?: string; description: string; descriptionZh?: string;
  category: string; applies: string[]; version: number; source: SkillSource; attribution?: string; bytes: number; contentHash: string;
}
export interface Skill extends SkillSummary { body: string }
export interface SkillLimits { maxNodeSkills: number; maxNodeSkillBytes: number; maxSkillBodyBytes: number; maxWorkspaceSkills: number }
export interface SkillCatalog { items: SkillSummary[]; limits: SkillLimits }
export interface SkillInput { name?: string; title?: string; description?: string; body?: string; category?: string; applies?: string[]; markdown?: string; version?: number }

/** builtin:<name> or workspace:<id>, as the server accepts on a node. */
export const SKILL_REF = /^(builtin:[a-z0-9]+(-[a-z0-9]+)*|workspace:a[A-Za-z0-9_-]{32})$/;
export const SKILL_CATEGORIES = ['video', 'design', 'research', 'writing', 'engineering', 'business', 'data'] as const;

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string';
function summary(x: unknown): x is SkillSummary {
  return object(x) && text(x.ref) && SKILL_REF.test(x.ref) && text(x.name) && text(x.title) && text(x.description) && text(x.category)
    && Array.isArray(x.applies) && x.applies.every(text) && Number.isSafeInteger(x.version) && (x.source === 'builtin' || x.source === 'workspace')
    && Number.isSafeInteger(x.bytes) && text(x.contentHash);
}
function checked<T>(value: unknown, check: (x: unknown) => x is T): T {
  if (!check(value)) throw new SaaSApiError(502, 'invalid_skill_response', 'The skill library returned incomplete data. Try again.');
  return value;
}

export async function readSkillCatalog(tenantId: string, signal?: AbortSignal): Promise<SkillCatalog> {
  return checked(await api<unknown>(tenantPath(tenantId, '/skills'), { signal }), (x): x is SkillCatalog => object(x) && Array.isArray(x.items)
    && x.items.every(summary) && object(x.limits) && Number.isSafeInteger(x.limits.maxNodeSkills));
}
export async function readSkill(tenantId: string, ref: string, signal?: AbortSignal): Promise<Skill> {
  return checked(await api<unknown>(tenantPath(tenantId, `/skills/${encodeURIComponent(ref)}`), { signal }), (x): x is Skill => summary(x) && text((x as { body?: unknown }).body) && x.ref === ref);
}
export async function createSkill(tenantId: string, input: SkillInput, signal?: AbortSignal): Promise<Skill> {
  return checked(await api<unknown>(tenantPath(tenantId, '/skills'), { method: 'POST', body: JSON.stringify(input), signal }), (x): x is Skill => summary(x) && x.source === 'workspace');
}
export async function updateSkill(tenantId: string, id: string, input: SkillInput & { version: number }, signal?: AbortSignal): Promise<Skill> {
  return checked(await api<unknown>(tenantPath(tenantId, `/skills/${encodeURIComponent(id)}`), { method: 'PUT', body: JSON.stringify(input), signal }), (x): x is Skill => summary(x) && x.id === id);
}
export async function archiveSkill(tenantId: string, id: string, signal?: AbortSignal): Promise<void> {
  await api(tenantPath(tenantId, `/skills/${encodeURIComponent(id)}`), { method: 'DELETE', signal });
}

/** The title and description a person reads, in their language when the skill has one. */
export function skillTitle(skill: Pick<SkillSummary, 'title' | 'titleZh'>, locale: 'zh' | 'en'): string {
  return locale === 'zh' && skill.titleZh ? skill.titleZh : skill.title;
}
export function skillDescription(skill: Pick<SkillSummary, 'description' | 'descriptionZh'>, locale: 'zh' | 'en'): string {
  return locale === 'zh' && skill.descriptionZh ? skill.descriptionZh : skill.description;
}

const catalogs = new Map<string, { read: number; pending: Promise<SkillCatalog> }>();
/** How long one catalog read serves every node editor: a skill another member or tab archives or adds since then
 *  shows the next time a node's configuration opens. */
const CATALOG_SECONDS = 30;
/** One catalog read per workspace at a time, shared by every node's editor; dropped when a skill changes here. */
export function cachedSkillCatalog(tenantId: string): Promise<SkillCatalog> {
  const now = Date.now();
  const cached = catalogs.get(tenantId);
  if (cached && now - cached.read < CATALOG_SECONDS * 1000) return cached.pending;
  const entry = { read: now, pending: readSkillCatalog(tenantId) };
  catalogs.set(tenantId, entry);
  entry.pending.catch(() => { if (catalogs.get(tenantId) === entry) catalogs.delete(tenantId); });
  return entry.pending;
}
export function forgetSkillCatalog(tenantId: string): void { catalogs.delete(tenantId); }
