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
/** The tags a skill may say it applies to (skills.go skillApplies). */
export const SKILL_TAGS = ['html', 'motion', 'video', 'image', 'research', 'writing', 'code', 'review', 'design', 'data', 'plan'] as const;
/** A skill's name, as the server accepts it. */
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const skillCategoryName = (category: string, t: (zh: string, en: string) => string) => ({
  video: t('视频', 'Video'), design: t('设计', 'Design'), research: t('研究', 'Research'), writing: t('写作', 'Writing'),
  engineering: t('工程', 'Engineering'), business: t('商业', 'Business'), data: t('数据', 'Data'),
} as Record<string, string>)[category] ?? category;

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

/** A skill found on skills.sh, the open agent-skills directory (skill_registry.go). */
export interface RegistryHit { id: string; source: string; slug: string; name: string; installs: number; url: string; repoUrl: string }
export type RegistryNote = 'extra_files' | 'runs_commands';
export interface RegistryAudit { provider: string; status: 'pass' | 'warn' | 'fail'; riskLevel?: string; summary?: string; auditedAt?: string }
/** A license or notice file of the skill's folder, or its README when that speaks of terms; shown in part beyond 16 KiB. */
export interface RegistryLicenseFile { path: string; notice: boolean; readme?: boolean; text: string; truncated: boolean }
/** What an import of a skills.sh skill would save, and what a member should know first. `problem.blocking` is a
 *  problem in the skill's text, which is imported as it is; any other problem is in a field the member can change. */
export interface RegistryPreview {
  id: string; source: string; slug: string; url: string; repoUrl: string; hash: string;
  markdown: string; truncated: boolean; bytes: number; maxBytes: number;
  /** At most 100 of the folder's other files; `filesTotal` counts them all. */
  files: { path: string; bytes: number }[]; filesTotal: number; declaredLicense: string; notes: RegistryNote[];
  /** `open` is a permissive license; any other status is imported only on the member's confirmation. */
  license: { status: 'open' | 'unknown' | 'restricted'; spdx?: string; files: RegistryLicenseFile[] };
  repository: { checked: boolean; found: boolean; license?: string; stars: number; archived: boolean };
  audits: RegistryAudit[] | null;
  problem: { code: string; message: string; blocking: boolean } | null;
  skill: { name: string; title: string; description: string; category: string; applies: string[] };
}
export interface RegistryImport { id: string; hash: string; name: string; title: string; description: string; category: string; applies: string[]; licenseConfirmed: boolean }

const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/[a-z0-9][a-z0-9-]{0,127}$/;
const https = (x: unknown): x is string => text(x) && /^https:\/\/(skills\.sh|github\.com)\//.test(x);
function hit(x: unknown): x is RegistryHit {
  return object(x) && text(x.id) && REGISTRY_ID.test(x.id) && text(x.source) && text(x.slug) && text(x.name) && Number.isSafeInteger(x.installs) && https(x.url) && https(x.repoUrl);
}
const licenseFile = (x: unknown): x is RegistryLicenseFile => object(x) && text(x.path) && typeof x.notice === 'boolean'
  && (x.readme === undefined || typeof x.readme === 'boolean') && text(x.text) && typeof x.truncated === 'boolean';
function preview(x: unknown): x is RegistryPreview {
  if (!object(x) || !text(x.id) || !REGISTRY_ID.test(x.id) || !text(x.hash) || !text(x.markdown) || !https(x.url) || !https(x.repoUrl) || !Array.isArray(x.files) || !Number.isSafeInteger(x.filesTotal) || !Array.isArray(x.notes)) return false;
  const { license, repository, audits, problem, skill } = x;
  return object(license) && (license.status === 'open' || license.status === 'unknown' || license.status === 'restricted')
    && Array.isArray(license.files) && license.files.every(licenseFile)
    && object(repository) && typeof repository.checked === 'boolean' && (audits === null || Array.isArray(audits)) && (problem === null || (object(problem) && text(problem.code)))
    && object(skill) && text(skill.name) && text(skill.title) && text(skill.description) && text(skill.category) && Array.isArray(skill.applies);
}

/** Searches skills.sh through the server; the query goes to skills.sh, nothing else does. */
export async function searchSkillRegistry(tenantId: string, query: string, signal?: AbortSignal): Promise<RegistryHit[]> {
  const value = await api<unknown>(tenantPath(tenantId, `/skills/registry/search?q=${encodeURIComponent(query)}`), { signal });
  return checked(value, (x): x is { items: RegistryHit[] } => object(x) && Array.isArray(x.items) && x.items.every(hit)).items;
}
export async function previewRegistrySkill(tenantId: string, id: string, signal?: AbortSignal): Promise<RegistryPreview> {
  return checked(await api<unknown>(tenantPath(tenantId, `/skills/registry/preview?id=${encodeURIComponent(id)}`), { signal }), (x): x is RegistryPreview => preview(x) && x.id === id);
}
export async function importRegistrySkill(tenantId: string, input: RegistryImport, signal?: AbortSignal): Promise<Skill> {
  return checked(await api<unknown>(tenantPath(tenantId, '/skills/registry/import'), { method: 'POST', body: JSON.stringify(input), signal }), (x): x is Skill => summary(x) && x.source === 'workspace');
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
