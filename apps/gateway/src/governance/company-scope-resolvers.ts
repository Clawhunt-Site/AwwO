/**
 * Company-scope entity resolvers + same-origin assertion — faithful Node port of
 * company_scope.py:283-434 (P1b-2). Each resolver looks an entity's company up
 * in the store, asserts it is concrete (requireResolvedCompany) and in scope
 * (check), then RETURNS it so the caller can also enforce same-origin across refs.
 *
 * Every resolver is fail-closed: a null store (cannot prove same-origin) and an
 * unknown id both forbid the command. The store is an abstract read interface
 * here; the real implementation lands with the super data store (P3).
 */
import { check, CompanyScopeError, requireResolvedCompany, type CompanyScope } from "./company-scope.js";

/** Minimal read interface the scope resolvers need. A method returns the entity
 *  or null; null = unknown id, mirroring Python's KeyError-on-unknown (both
 *  fail-closed). `companyProfileId` maps to the Python `company_profile_id`. */
export interface ScopeStore {
  getAgentProfile(id: string): { readonly companyProfileId?: unknown } | null;
  getIssue(id: string): { readonly companyProfileId?: unknown } | null;
  getWorkProduct(id: string): { readonly companyProfileId?: unknown } | null;
  getWorkspaceProfile(id: string): { readonly companyProfileId?: unknown } | null;
  getIssueInteraction(id: string): { readonly issueId?: unknown; readonly companyProfileId?: unknown } | null;
}

function repr(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Shared resolver body: null store → forbidden; unknown entity → forbidden;
 *  else require a concrete in-scope company and return it. */
function resolveCompany(
  store: ScopeStore | null,
  id: unknown,
  lookup: (s: ScopeStore) => { readonly companyProfileId?: unknown } | null,
  scope: CompanyScope,
  label: string,
  kind: string,
): string {
  if (store === null) {
    throw new CompanyScopeError(`${label}: cannot resolve ${kind} ${repr(id)} without state (fail-closed)`);
  }
  const entity = lookup(store);
  if (entity === null || entity === undefined) {
    throw new CompanyScopeError(`${label}: unknown ${kind} ${repr(id)} (fail-closed)`);
  }
  const company = entity.companyProfileId;
  requireResolvedCompany(company, label, kind);
  check(company, scope, label);
  // requireResolvedCompany guarantees a non-empty string here.
  return company as string;
}

export function resolveAgentCompany(profileId: unknown, scope: CompanyScope, store: ScopeStore | null, label: string): string {
  return resolveCompany(store, profileId, (s) => s.getAgentProfile(profileId as string), scope, label, "agent");
}

export function resolveIssueCompany(issueId: unknown, scope: CompanyScope, store: ScopeStore | null, label: string): string {
  return resolveCompany(store, issueId, (s) => s.getIssue(issueId as string), scope, label, "issue");
}

export function resolveWorkProductCompany(workProductId: unknown, scope: CompanyScope, store: ScopeStore | null, label: string): string {
  return resolveCompany(store, workProductId, (s) => s.getWorkProduct(workProductId as string), scope, label, "work_product");
}

export function resolveWorkspaceCompany(workspaceId: unknown, scope: CompanyScope, store: ScopeStore | null, label: string): string {
  return resolveCompany(store, workspaceId, (s) => s.getWorkspaceProfile(workspaceId as string), scope, label, "workspace");
}

/**
 * Resolve a board-inbox interaction's company via its ISSUE (the authoritative
 * company is the issue's, not the interaction's denormalised copy), so an
 * interaction whose issue is in a foreign company is forbidden.
 */
export function resolveInteractionCompany(interactionId: unknown, scope: CompanyScope, store: ScopeStore | null, label: string): string {
  if (store === null) {
    throw new CompanyScopeError(`${label}: cannot resolve interaction ${repr(interactionId)} without state (fail-closed)`);
  }
  const interaction = store.getIssueInteraction(interactionId as string);
  if (interaction === null || interaction === undefined) {
    throw new CompanyScopeError(`${label}: unknown board inbox item ${repr(interactionId)} (fail-closed)`);
  }
  return resolveIssueCompany(interaction.issueId, scope, store, label);
}

/** A blank/absent company means the actor's home company (server-scoped). */
export function normalizeHome(company: unknown, actorCompanyId: string): unknown {
  if (company === null || company === undefined || company === "") return actorCompanyId;
  return company;
}

/**
 * Contract B8 same-origin: every related ref must share the anchor's company.
 * "In scope" is not enough — under an admin / multi-company allow-set two refs
 * can each be permitted yet belong to different companies; a cross-company
 * relationship is itself a boundary crossing and is forbidden.
 */
export function assertSameOrigin(
  anchor: unknown,
  anchorLabel: string,
  others: ReadonlyArray<readonly [string, unknown]>,
): void {
  for (const [label, company] of others) {
    if (company !== anchor) {
      throw new CompanyScopeError(
        `${label}: company ${repr(company)} is not same-origin with ${anchorLabel} (${repr(anchor)}) — related refs must share a company`,
        company,
      );
    }
  }
}
