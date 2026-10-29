// The Agent market's API (docs/awwo-agent-market.md): browsing and an Agent's detail, the author's own Agents with their
// drafts and earnings, the platform's review, and a run's Agent fee and rating. The market belongs to no workspace; using
// one of its Agents is judged by the caller's workspace (the node's canvas). Every reply is checked here, so a surface
// reads typed values or a SaaSApiError, never a half-shaped object.
//
// Where the contract leaves the browser something to assume, it is assumed here and nowhere else:
//  - an Agent's detail answers `?version=N` with that version (a node locked to an older one shows its own price); a
//    server older than that answers the listed version, which `version` in the reply says;
//  - a success rate is a fraction (0–1); a number above 1 is read as a percentage;
//  - a refusal of a draft may name its field in `details.field` (the publish form marks that field).
// A market Agent is a text Agent for now (`kind` llm); `coding` is read where a reply says it, never sent.
// A draft's skills come back with the `ref` and `tenantId` they were frozen from (a built-in one's tenantId is empty),
// which is how they are sent again.
import { api, SaaSApiError, tenantPath } from './api';
import type { WorkspaceCapabilities } from './capabilitiesApi';

export const MARKET_CATEGORIES = ['page', 'writing', 'research', 'code', 'design', 'media', 'business', 'education', 'other'] as const;
export type MarketCategory = typeof MARKET_CATEGORIES[number];
export const MARKET_SORTS = ['score', 'calls', 'new', 'price'] as const;
export type MarketSort = typeof MARKET_SORTS[number];
export type MarketAgentKind = 'llm' | 'coding';
export type MarketAgentStatus = 'draft' | 'listed' | 'unlisted' | 'suspended';
export type MarketVersionState = 'draft' | 'pending' | 'approved' | 'rejected' | 'superseded';
/** A call's fee: held when the run is admitted, taken when it completes (and when it was stopped, or its node's own output
 *  contract refused it, after the Agent had written text), given back otherwise. */
export type MarketCallStatus = 'reserved' | 'charged' | 'released';
export type MarketRating = -1 | 0 | 1;

/** The draft limits the server enforces, checked in the form first so the author sees which field is over. */
export const MARKET_LIMITS = { name: 60, tagline: 120, description: 4000, instructionsBytes: 32000, skills: 4, skillBytes: 20 << 10,
  examples: 3, examplePrompt: 2000, exampleResult: 4000, authorName: 40 } as const;

/** What a workspace's capabilities say of the market: null where it is off, or the server is older than it. */
export interface MarketSettings { enabled: true; payouts: boolean; feeBps: number; maxPrice: number; holdDays: number }

export interface MarketModel { runtime: string; id: string; effort: string; locked: boolean }
export interface MarketStats {
  calls: number; users: number; successRate: number | null; up: number; down: number;
  avgSeconds: number | null; avgModelCredits: number | null; score: number | null; ranked: boolean;
}
export interface MarketAgentSummary {
  id: string; name: string; tagline: string; category: MarketCategory; kind: MarketAgentKind; official: boolean;
  author: { name: string } | null; price: number; version: number; model: MarketModel; listedAt: string | null; stats: MarketStats;
}
export interface MarketExample { prompt: string; result: string }
export interface MarketSkillInfo { name: string; title: string; attribution: string; license: string }
/** An Agent's latest version as its author's views summarize it; `authorName` is the name it would list under. */
export interface MarketLatestVersion { version: number; state: MarketVersionState; reviewNote: string; submittedAt: string | null; price: number; authorName: string }
export interface MarketAgentDetail extends MarketAgentSummary {
  description: string; examples: MarketExample[]; skills: MarketSkillInfo[]; instructionsPublic: boolean;
  /** Only for the author, an administrator, or a version whose author made them public. */
  instructions?: string;
  /** Only for the author. */
  status?: MarketAgentStatus; latest?: MarketLatestVersion;
}
export interface MyMarketAgent extends MarketAgentSummary { status: MarketAgentStatus; listedVersion: number | null; latest: MarketLatestVersion }
export interface MarketPage<T> { items: T[]; nextCursor: string | null }

export interface MarketSkillRef { tenantId: string; ref: string }
export interface MarketDraftSkill extends MarketSkillRef, MarketSkillInfo {}
export interface MarketDraftInput {
  name: string; tagline: string; description: string; category: MarketCategory; kind: MarketAgentKind;
  instructions: string; instructionsPublic: boolean; skills: MarketSkillRef[]; model: MarketModel; price: number;
  examples: MarketExample[]; authorName: string;
}
/** `authorName` is the draft's own (reviewed with it); `listedAuthorName` the one the market shows now, until a version
 *  with another is approved. */
export interface MarketDraft extends Omit<MarketDraftInput, 'skills'> {
  agentId: string; version: number; state: MarketVersionState; reviewNote: string; skills: MarketDraftSkill[]; listedAuthorName: string;
}

/** A monthly statement: the earnings of a calendar month (`month`, YYYY-MM in UTC) gathered for one author, its calls and
 *  what they were charged in credits, what it sends in cents, and how far it went (market_settle.go). */
export interface MarketPayout { id: string; month: string | null; calls: number; credits: number; amountCents: number; status: string; createdAt: string; sentAt: string | null }
/** The author's earnings, in credits (1 credit = 1 US cent): waiting for their period to settle (pending), settled and on
 *  no statement yet (available), on a statement the platform has not approved (inReview), approved and not yet sent
 *  (transferring), and sent (paid), as of `asOf`. */
export interface MarketEarnings {
  feeBps: number; holdDays: number; payoutsEnabled: boolean; clawHuntLinked: boolean;
  pending: number; available: number; inReview: number; transferring: number; paid: number; asOf: string | null; payouts: MarketPayout[];
}

export interface MarketReviewSkill extends MarketSkillInfo { body: string; hash: string; source: string }
/** A version waiting for review, with everything it would list (the administrator's view). */
export interface MarketReview {
  agentId: string; version: number; name: string; tagline: string; description: string; category: MarketCategory; kind: MarketAgentKind;
  instructions: string; instructionsPublic: boolean; skills: MarketReviewSkill[]; model: MarketModel; price: number;
  examples: MarketExample[]; authorName: string; author: string; submittedAt: string | null; official: boolean;
  /** The author's name the market shows now; approving the version replaces it with `authorName`. */
  listedAuthorName: string;
  /** What the decision names: the version as read here. */
  reviewHash: string;
}
/** A statement's calls of one Agent, for its review. */
export interface MarketStatementAgent { id: string; name: string; calls: number; credits: number; earnedMicrocredits: number }
/** A statement as the administrator reviews it: whose, what it carried in from the one before, who approved it, the
 *  ClawHunt transaction it became, why its last attempt failed, and its calls by Agent. */
export interface MarketAdminPayout extends MarketPayout {
  author: string; transaction: string; lastError: string; attempts: number; microcredits: number; carryInMicrocredits: number;
  approvedBy: string; approvedAt: string | null; agents: MarketStatementAgent[];
  /** Every figure an approval rests on came back as the contract says (an id, a month, whole counts and an amount of a
   *  cent or more); a statement read otherwise is shown as it came and cannot be approved here. */
  complete: boolean;
}
/** The statements, and whether transfers are on: approving one sends it, so with them off none can be approved. */
export interface MarketStatements { items: MarketAdminPayout[]; payoutsEnabled: boolean }

/** A run made with a market Agent (GET /tenants/{t}/runs/{id}). `insider`: the Agent's author (or a workspace they belong
 *  to) ran it, which costs no fee and does not count in the ranking. */
export interface MarketRunInfo { agentId: string; version: number; price: number; status: MarketCallStatus; insider: boolean; rating: MarketRating }

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown, fallback = '') => typeof x === 'string' ? x : fallback;
const whole = (x: unknown, fallback = 0) => typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : fallback;
const count = (x: unknown) => Math.max(0, whole(x));
const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : null;
const version = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 1;
const itemsOf = (x: unknown): unknown[] => Array.isArray(x) ? x : object(x) && Array.isArray(x.items) ? x.items : invalid();
const cursorOf = (x: unknown) => object(x) && typeof x.nextCursor === 'string' && x.nextCursor ? x.nextCursor : null;
function invalid(): never {
  throw new SaaSApiError(502, 'invalid_market_response', 'The Agent market returned incomplete data. Try again.');
}

export const isMarketCategory = (x: unknown): x is MarketCategory => (MARKET_CATEGORIES as readonly unknown[]).includes(x);
const STATUSES: readonly MarketAgentStatus[] = ['draft', 'listed', 'unlisted', 'suspended'];
const STATES: readonly MarketVersionState[] = ['draft', 'pending', 'approved', 'rejected', 'superseded'];
const isStatus = (x: unknown): x is MarketAgentStatus => (STATUSES as readonly unknown[]).includes(x);
const isState = (x: unknown): x is MarketVersionState => (STATES as readonly unknown[]).includes(x);

function modelOf(x: unknown): MarketModel {
  const model = object(x) ? x : {};
  return { runtime: str(model.runtime), id: str(model.id), effort: str(model.effort), locked: model.locked === true };
}
/** A success rate as a fraction; a server that sends a percentage is read as one. */
function rateOf(x: unknown): number | null {
  const value = finite(x);
  if (value === null || value < 0) return null;
  return value > 1 ? Math.min(1, value / 100) : value;
}
function statsOf(x: unknown): MarketStats {
  const stats = object(x) ? x : {};
  return { calls: count(stats.calls), users: count(stats.users), successRate: rateOf(stats.successRate), up: count(stats.up), down: count(stats.down),
    avgSeconds: finite(stats.avgSeconds), avgModelCredits: finite(stats.avgModelCredits), score: finite(stats.score), ranked: stats.ranked === true };
}
const examplesOf = (x: unknown): MarketExample[] => Array.isArray(x)
  ? x.filter(object).map(item => ({ prompt: str(item.prompt), result: str(item.result) })).filter(item => item.prompt || item.result) : [];
const skillInfoOf = (item: Record<string, unknown>): MarketSkillInfo => ({ name: str(item.name), title: str(item.title) || str(item.name),
  attribution: str(item.attribution), license: str(item.license) });
const skillsOf = (x: unknown): MarketSkillInfo[] => Array.isArray(x) ? x.filter(object).map(skillInfoOf).filter(item => item.name || item.title) : [];

export function marketSummaryOf(x: unknown): MarketAgentSummary {
  if (!object(x) || typeof x.id !== 'string' || !x.id || typeof x.name !== 'string' || !version(x.version)) invalid();
  return {
    id: x.id, name: x.name, tagline: str(x.tagline), category: isMarketCategory(x.category) ? x.category : 'other',
    kind: x.kind === 'coding' ? 'coding' : 'llm', official: x.official === true,
    author: object(x.author) && typeof x.author.name === 'string' && x.author.name ? { name: x.author.name } : null,
    price: count(x.price), version: x.version, model: modelOf(x.model), listedAt: typeof x.listedAt === 'string' ? x.listedAt : null, stats: statsOf(x.stats),
  };
}
function latestOf(x: unknown, fallback: number): MarketLatestVersion {
  const latest = object(x) ? x : {};
  return { version: version(latest.version) ? latest.version : fallback, state: isState(latest.state) ? latest.state : 'draft',
    reviewNote: str(latest.reviewNote), submittedAt: typeof latest.submittedAt === 'string' ? latest.submittedAt : null, price: count(latest.price),
    authorName: str(latest.authorName) };
}
export function marketDetailOf(x: unknown): MarketAgentDetail {
  const summary = marketSummaryOf(x);
  const raw = x as Record<string, unknown>;
  return { ...summary, description: str(raw.description), examples: examplesOf(raw.examples), skills: skillsOf(raw.skills),
    instructionsPublic: raw.instructionsPublic === true,
    ...(typeof raw.instructions === 'string' ? { instructions: raw.instructions } : {}),
    ...(isStatus(raw.status) ? { status: raw.status } : {}),
    ...(object(raw.latest) ? { latest: latestOf(raw.latest, summary.version) } : {}) };
}
function myAgentOf(x: unknown): MyMarketAgent {
  const summary = marketSummaryOf(x);
  const raw = x as Record<string, unknown>;
  return { ...summary, status: isStatus(raw.status) ? raw.status : 'draft', listedVersion: version(raw.listedVersion) ? raw.listedVersion : null,
    latest: latestOf(raw.latest, summary.version) };
}
/** An author's draft as the server answers it (GET and PUT …/draft, and the 201 of a new Agent): the Agent's id, status
 *  and signature, and its latest version under `draft`. A reply with the version's fields at its top is read too. */
function draftOf(x: unknown, agentId: string): MarketDraft {
  if (!object(x)) invalid();
  const draft = object(x.draft) ? x.draft : x;
  const id = str(x.id) || str(x.agentId) || agentId;
  if (!id) invalid();
  const skills = Array.isArray(draft.skills) ? draft.skills.filter(object).map(item => ({ ...skillInfoOf(item), tenantId: str(item.tenantId), ref: str(item.ref) })) : [];
  return { agentId: id, version: version(draft.version) ? draft.version : 1, state: isState(draft.state) ? draft.state : 'draft',
    reviewNote: str(draft.reviewNote), name: str(draft.name), tagline: str(draft.tagline), description: str(draft.description),
    category: isMarketCategory(draft.category) ? draft.category : 'other', kind: draft.kind === 'coding' ? 'coding' : 'llm',
    instructions: str(draft.instructions), instructionsPublic: draft.instructionsPublic === true, skills, model: modelOf(draft.model),
    price: count(draft.price), examples: examplesOf(draft.examples), authorName: str(draft.authorName) || str(x.authorName),
    listedAuthorName: str(x.listedAuthorName) };
}
/** A statement's month as the server writes it: YYYY-MM, a real month. */
const isStatementMonth = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(x);
function payoutOf(item: Record<string, unknown>): MarketPayout {
  return { id: str(item.id), month: isStatementMonth(item.month) ? item.month : null,
    calls: count(item.calls), credits: count(item.credits), amountCents: count(item.amountCents), status: str(item.status, 'pending'),
    createdAt: str(item.createdAt), sentAt: typeof item.sentAt === 'string' && item.sentAt ? item.sentAt : null };
}
function adminPayoutOf(item: Record<string, unknown>): MarketAdminPayout {
  const author = object(item.author) ? item.author : {};
  const agents = Array.isArray(item.agents) ? item.agents.filter(object).map(agent => ({ id: str(agent.id), name: str(agent.name), calls: count(agent.calls),
    credits: count(agent.credits), earnedMicrocredits: count(agent.earnedMicrocredits) })) : [];
  const wholeCount = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  const complete = typeof item.id === 'string' && /^a[A-Za-z0-9_-]{32}$/.test(item.id) && isStatementMonth(item.month)
    && typeof author.id === 'string' && author.id !== '' && wholeCount(item.calls) && wholeCount(item.credits)
    && wholeCount(item.microcredits) && wholeCount(item.carryInMicrocredits) && wholeCount(item.amountCents) && (item.amountCents as number) >= 1
    && (Array.isArray(item.agents) && item.agents.every(agent => object(agent) && typeof agent.id === 'string' && wholeCount(agent.calls)
      && wholeCount(agent.credits) && wholeCount(agent.earnedMicrocredits)));
  return { ...payoutOf(item), author: [str(author.name), str(author.email)].filter(Boolean).join(' · ') || str(item.author),
    transaction: str(item.clawHuntTransaction), lastError: str(item.lastError), attempts: count(item.attempts), microcredits: count(item.microcredits),
    carryInMicrocredits: count(item.carryInMicrocredits), approvedBy: str(item.approvedBy),
    approvedAt: typeof item.approvedAt === 'string' && item.approvedAt ? item.approvedAt : null, agents, complete };
}
function reviewOf(x: unknown): MarketReview {
  if (!object(x) || typeof x.agentId !== 'string' || !x.agentId || !version(x.version)) invalid();
  const skills = Array.isArray(x.skills) ? x.skills.filter(object).map(item => ({ ...skillInfoOf(item), body: str(item.body) || str(item.text),
    hash: str(item.hash), source: str(item.source) })) : [];
  // The account behind it (`author`: id, email, name), the author's name the version gives (`author.display`) and the one
  // the market shows now (`author.listedDisplay`).
  const author = object(x.author) ? x.author : {};
  return { agentId: x.agentId, version: x.version, name: str(x.name), tagline: str(x.tagline), description: str(x.description),
    category: isMarketCategory(x.category) ? x.category : 'other', kind: x.kind === 'coding' ? 'coding' : 'llm',
    instructions: str(x.instructions), instructionsPublic: x.instructionsPublic === true, skills, model: modelOf(x.model), price: count(x.price),
    examples: examplesOf(x.examples), authorName: str(x.authorName) || str(author.display),
    author: [str(author.name), str(author.email)].filter(Boolean).join(' · ') || str(x.author),
    submittedAt: typeof x.submittedAt === 'string' ? x.submittedAt : null, official: x.official === true, listedAuthorName: str(author.listedDisplay),
    reviewHash: str(x.reviewHash) };
}

/** The market as a workspace's capabilities report it (capabilities.go), or null where it is off. */
export function marketSettingsOf(capabilities: Pick<WorkspaceCapabilities, 'market'> | null | undefined): MarketSettings | null {
  const market = capabilities?.market as unknown;
  if (!object(market) || market.enabled !== true) return null;
  const fee = whole(market.feeBps, 2500);
  return { enabled: true, payouts: market.payouts === true, feeBps: fee >= 0 && fee <= 10000 ? fee : 2500,
    maxPrice: Math.max(0, whole(market.maxPrice, 500)), holdDays: Math.max(0, whole(market.holdDays, 14)) };
}
/** What an author receives of one paid call, in credits: the price less the platform's fee. */
export const authorShare = (price: number, feeBps: number) => price * Math.max(0, 10000 - feeBps) / 10000;

export function marketRunInfo(raw: unknown): MarketRunInfo | null {
  if (!object(raw) || typeof raw.agentId !== 'string' || !raw.agentId) return null;
  const status = raw.status === 'charged' || raw.status === 'released' ? raw.status : 'reserved';
  const rating = raw.rating === 1 || raw.rating === -1 ? raw.rating : 0;
  return { agentId: raw.agentId, version: version(raw.version) ? raw.version : 1, price: count(raw.price), status, insider: raw.insider === true, rating };
}

const agentPath = (id: string, suffix = '') => `/market/agents/${encodeURIComponent(id)}${suffix}`;
const post = (path: string, body: unknown = {}, signal?: AbortSignal) => api<unknown>(path, { method: 'POST', body: JSON.stringify(body), signal });

export interface MarketQuery { q?: string; category?: MarketCategory | ''; sort?: MarketSort; limit?: number; cursor?: string | null }
/** Listed Agents only, in the order asked for (the server ranks them by their runs). */
export async function browseMarketAgents(query: MarketQuery = {}, signal?: AbortSignal): Promise<MarketPage<MarketAgentSummary>> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.category) params.set('category', query.category);
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const value = await api<unknown>(`/market/agents${params.size ? `?${params}` : ''}`, { signal });
  return { items: itemsOf(value).map(marketSummaryOf), nextCursor: cursorOf(value) };
}
/** An Agent's detail: its listed version, or `version` (see the note at the top). */
export async function readMarketAgent(id: string, options: { version?: number; signal?: AbortSignal } = {}): Promise<MarketAgentDetail> {
  return marketDetailOf(await api<unknown>(agentPath(id, options.version ? `?version=${options.version}` : ''), { signal: options.signal }));
}
export async function readMyMarketAgents(signal?: AbortSignal): Promise<MyMarketAgent[]> {
  return itemsOf(await api<unknown>('/market/mine', { signal })).map(myAgentOf);
}
/** A new Agent, its version 1 a draft (the reply is the new draft, with the Agent's id). */
export async function createMarketAgent(input: MarketDraftInput, signal?: AbortSignal): Promise<MarketDraft> {
  return draftOf(await post('/market/agents', input, signal), '');
}
export async function readMarketDraft(id: string, signal?: AbortSignal): Promise<MarketDraft> {
  return draftOf(await api<unknown>(agentPath(id, '/draft'), { signal }), id);
}
/** Changes the latest draft; once the latest version is past its draft, this makes the next version's draft. */
export async function saveMarketDraft(id: string, input: MarketDraftInput, signal?: AbortSignal): Promise<void> {
  await api(agentPath(id, '/draft'), { method: 'PUT', body: JSON.stringify(input), signal });
}
export async function submitMarketAgent(id: string): Promise<void> { await post(agentPath(id, '/submit')); }
export async function withdrawMarketAgent(id: string): Promise<void> { await post(agentPath(id, '/withdraw')); }
export async function unlistMarketAgent(id: string): Promise<void> { await post(agentPath(id, '/unlist')); }
export async function relistMarketAgent(id: string): Promise<void> { await post(agentPath(id, '/list')); }

export async function readMarketEarnings(signal?: AbortSignal): Promise<MarketEarnings> {
  const value = await api<unknown>('/market/earnings', { signal });
  if (!object(value)) invalid();
  const fee = whole(value.feeBps, 2500);
  const credits = (x: unknown) => Math.max(0, finite(x) ?? 0);
  return { feeBps: fee >= 0 && fee <= 10000 ? fee : 2500, holdDays: count(value.holdDays), payoutsEnabled: value.payoutsEnabled === true,
    clawHuntLinked: value.clawHuntLinked === true, pending: credits(value.pending), available: credits(value.available), inReview: credits(value.inReview),
    transferring: credits(value.transferring),
    paid: credits(value.paid), asOf: typeof value.asOf === 'string' && value.asOf ? value.asOf : null,
    payouts: Array.isArray(value.payouts) ? value.payouts.filter(object).map(payoutOf) : [] };
}

export async function readMarketReviews(signal?: AbortSignal): Promise<MarketReview[]> {
  return itemsOf(await api<unknown>('/admin/market/reviews', { signal })).map(reviewOf);
}
/** A decision on the version as it was read: its `reviewHash` from the queue, which the server checks against the
 *  version now (a version changed since answers market_review_changed). */
export async function decideMarketReview(agentId: string, versionNumber: number, decision: 'approve' | 'reject', note: string, reviewHash: string): Promise<void> {
  await post(`/admin/market/reviews/${encodeURIComponent(agentId)}/${versionNumber}`, { decision, note, reviewHash });
}
export async function setMarketAgentStatus(id: string, status: 'suspended' | 'listed'): Promise<void> {
  await post(`/admin/market/agents/${encodeURIComponent(id)}/status`, { status });
}
/** The monthly statements, those waiting for review first. */
export async function readMarketPayouts(signal?: AbortSignal): Promise<MarketStatements> {
  const value = await api<unknown>('/admin/market/payouts', { signal });
  return { items: itemsOf(value).filter(object).map(adminPayoutOf), payoutsEnabled: object(value) && value.payoutsEnabled === true };
}
/** Approves a statement waiting for review, of the amount the administrator confirmed (the server approves nothing of
 *  another: market_statement_changed), which sends it at once; answers the statement as it stands after the attempt
 *  (sent, held, or pending with the reason the job tries again). */
export async function approveMarketStatement(id: string, amountCents: number): Promise<MarketAdminPayout> {
  const value = await post(`/admin/market/payouts/${encodeURIComponent(id)}/approve`, { amountCents });
  // The answer must be this statement, of the amount confirmed, on its way or arrived; anything else is never announced
  // as a transfer (the list, read again, shows how it stands).
  if (!object(value) || value.id !== id || value.amountCents !== amountCents || !['pending', 'held', 'sent'].includes(str(value.status))) invalid();
  return adminPayoutOf(value);
}

/** 👍 (1), 👎 (-1) or no rating (0) for a run made with a market Agent that completed or was charged; members and above.
 *  Answers the rating the server holds now. */
export async function rateMarketRun(tenantId: string, runId: string, score: MarketRating): Promise<MarketRating> {
  const value = await api<unknown>(tenantPath(tenantId, `/runs/${encodeURIComponent(runId)}/market-rating`), { method: 'PUT', body: JSON.stringify({ score }) });
  const held = object(value) ? value.score : undefined;
  return held === 1 || held === -1 || held === 0 ? held : score;
}
