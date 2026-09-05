/**
 * Company scope — faithful Node port of the authority core of
 * packages/superclaw/src/superclaw/company_scope.py (contract B8).
 *
 * This slice (P1b-1) ports the pure, store-free core: the CompanyScope value,
 * its server-derived authority semantics, and the fail-closed `check` /
 * `requireResolvedCompany` guards. The entity resolvers, same-origin assertion
 * and per-command authorization (which need a store / command models) follow in
 * later slices.
 *
 * The cardinal rule (company_scope.py:127): every field here is authority the
 * SERVER derives from the authenticated principal — NEVER from a request body.
 * A command's own company id is a request TARGET, checked against this scope; it
 * is never the source of permission.
 */

/**
 * A company-management command crossed the actor's authorized scope — a hard
 * forbidden (403), distinct from a recoverable risk-gate "ask".
 */
export class CompanyScopeError extends Error {
  readonly reason: string;
  readonly targetCompany: unknown;
  constructor(reason: string, targetCompany: unknown = null) {
    super(reason);
    this.name = "CompanyScopeError";
    this.reason = reason;
    this.targetCompany = targetCompany;
  }
}

export interface CompanyScopeInit {
  /** Acting operator identity (server-injected; audit only, not a scope key). */
  readonly principalId: string;
  /** The company the principal is scoped to — its always-permitted home. */
  readonly actorCompanyId: string;
  /** Full set of companies the principal may operate on. Empty degrades to
   *  "own company only"; actorCompanyId is always folded in. Must be a list/set
   *  of company-id strings — NOT a bare string (which JS would split per-char). */
  readonly allowedCompanyIds?: readonly string[] | ReadonlySet<string>;
  /** Only an explicit cross-company admin may target outside the allowed set.
   *  Defaults to false (fail-closed). */
  readonly isAdmin?: boolean;
  /** Profile id of the autonomous agent acting, or null for a human operator. */
  readonly actorAgentProfileId?: string | null;
  /** Run-scoped single-issue respond grant (server-injected), or null. */
  readonly respondIssueId?: string | null;
  /** The run this scope acts under (server-injected), or null. */
  readonly runId?: string | null;
}

// A non-empty string — mirrors Python truthiness `isinstance(x, str) and x`
// (whitespace-only is truthy / kept, matching actor_agent_profile_id handling).
function keptIdentityValue(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

// The code points Python's str.strip() removes (chars where str.isspace() is
// True). Expressed as explicit code points — NOT a literal-whitespace regex and
// NOT JS String.prototype.trim(), which strips U+FEFF (Python does NOT) and
// keeps U+0085 (Python strips it). Matching Python exactly means a grant/run id
// degrades to null on exactly the same inputs as the Python kernel.
const PY_WHITESPACE_CODES: ReadonlySet<number> = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
  0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function pyStrip(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PY_WHITESPACE_CODES.has(value.charCodeAt(start))) start += 1;
  while (end > start && PY_WHITESPACE_CODES.has(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

// A non-blank string — mirrors Python `isinstance(x, str) and x.strip()`
// (whitespace-only degrades to null), matching respond_issue_id / run_id.
function keptGrantValue(value: unknown): value is string {
  return typeof value === "string" && pyStrip(value) !== "";
}

/**
 * The server-injected actor scope a command is checked against. Immutable: the
 * allowed set is normalized once at construction, held privately, and only ever
 * exposed as a fresh copy — a caller can never widen authority by mutating it
 * (TS `ReadonlySet` is erased at runtime; Python uses a `frozenset`).
 */
export class CompanyScope {
  readonly principalId: string;
  readonly actorCompanyId: string;
  readonly isAdmin: boolean;
  readonly actorAgentProfileId: string | null;
  readonly respondIssueId: string | null;
  readonly runId: string | null;

  readonly #allowed: Set<string>;

  constructor(init: CompanyScopeInit) {
    // Final (non-subclassable): a subclass could override `permits` to return
    // true and widen authority via `check`'s virtual dispatch. No legitimate use
    // subclasses an authority value, so reject it outright.
    if (new.target !== CompanyScope) {
      throw new TypeError("CompanyScope is final and may not be subclassed (authority object)");
    }
    this.principalId = init.principalId;
    this.actorCompanyId = init.actorCompanyId;
    // Strict boolean: ONLY a literal `true` grants admin. A truthy non-boolean
    // (e.g. the string "false", any object) must NOT widen to admin — fail
    // closed, since `permits` keys admin off truthiness.
    this.isAdmin = init.isAdmin === true;

    // Always include the actor's own company; an empty allow-set degrades to
    // "own company only" (company_scope.py:199). A bare string is iterable
    // per-character in JS (`new Set("ab")` -> {"a","b"}), so skip a string (and
    // any non-string / empty item) — a stray string must never be split into
    // single-char company grants. (Python's frozenset(str) would split it too;
    // this is the value-type guard against that footgun.)
    const allowed = new Set<string>();
    const rawAllowed: unknown = init.allowedCompanyIds;
    if (rawAllowed !== undefined && rawAllowed !== null && typeof rawAllowed !== "string") {
      for (const id of rawAllowed as Iterable<unknown>) {
        if (typeof id === "string" && id !== "") allowed.add(id);
      }
    }
    allowed.add(init.actorCompanyId);
    this.#allowed = allowed;

    // Blank / non-str authority values degrade to null so the autonomy gates
    // fail closed rather than matching a profile / spuriously granting.
    this.actorAgentProfileId = keptIdentityValue(init.actorAgentProfileId) ? init.actorAgentProfileId : null;
    this.respondIssueId = keptGrantValue(init.respondIssueId) ? init.respondIssueId : null;
    this.runId = keptGrantValue(init.runId) ? init.runId : null;

    // Equivalent to Python's `@dataclass(frozen=True)` (company_scope.py:122):
    // freeze the instance so no public authority field (isAdmin / actorCompanyId
    // / actorAgentProfileId / respond grant / run id) can be reassigned after
    // construction to widen authority. The private #allowed set is already only
    // exposed as a copy.
    Object.freeze(this);
  }

  /** A fresh copy of the allowed company set — never the internal object, so a
   *  caller cannot add/delete to widen scope. */
  get allowedCompanyIds(): ReadonlySet<string> {
    return new Set(this.#allowed);
  }

  /**
   * Is `companyId` inside this actor's scope (company_scope.py:221)?
   *
   * Order is load-bearing and fail-closed:
   *   - null / undefined / "" → true ("this company": the kernel treats a blank
   *     target as the actor's home);
   *   - a non-string id → false, rejected BEFORE the admin short-circuit so even
   *     an admin cannot slip a malformed (unverifiable) id past `check`;
   *   - admin → true for any string;
   *   - otherwise membership in the allowed set.
   */
  permits(companyId: unknown): boolean {
    // Touch the private brand FIRST: a forged `this` (Object.create(prototype),
    // possibly with isAdmin=true) has no #allowed field, so this throws here
    // rather than letting the admin short-circuit below grant access.
    const allowed = this.#allowed;
    if (companyId === null || companyId === undefined || companyId === "") return true;
    if (typeof companyId !== "string") return false;
    if (this.isAdmin) return true;
    return allowed.has(companyId);
  }

  /**
   * True only for an object genuinely constructed by CompanyScope. Uses the
   * ergonomic private-brand check (`#allowed in value`), which — unlike
   * `instanceof` — a forged `Object.create(CompanyScope.prototype)` cannot
   * satisfy (it never ran the constructor, so it carries no private brand). This
   * is the authenticity test the authority gate trusts.
   */
  static isAuthentic(value: unknown): value is CompanyScope {
    return typeof value === "object" && value !== null && #allowed in value;
  }
}

// The authority-enforcing members (permits / the allowedCompanyIds getter) live
// on the prototype, so an instance Object.freeze alone is not enough: without
// this, `Object.getPrototypeOf(scope).permits = () => true` would widen every
// scope. Freeze the prototype and constructor too. (This is JS-specific
// defense-in-depth and does not change any behavior — the Python original is a
// frozen dataclass at the instance level; method dispatch is identical.)
Object.freeze(CompanyScope.prototype);
Object.freeze(CompanyScope);

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

/**
 * Raise CompanyScopeError unless `companyId` is in `scope`. A non-string id is
 * an unverifiable (forbidden) scope, not an absent one (company_scope.py:247).
 */
export function check(companyId: unknown, scope: CompanyScope, label: string): void {
  // Trust only an object genuinely constructed by CompanyScope (private-brand
  // check, not instanceof — a forged Object.create(CompanyScope.prototype),
  // possibly with isAdmin=true to short-circuit permits, would pass instanceof
  // but carries no private brand). Combined with the final-class guard, no
  // subclass/forged object can reach permits. A non-authentic scope fails closed.
  if (!CompanyScope.isAuthentic(scope)) {
    throw new CompanyScopeError(`${label}: authority check requires an authentic CompanyScope`);
  }
  if (scope.permits(companyId)) return;
  if (companyId !== null && companyId !== undefined && typeof companyId !== "string") {
    throw new CompanyScopeError(
      `${label}: unverifiable company scope (non-string id ${repr(companyId)})`,
      companyId,
    );
  }
  throw new CompanyScopeError(
    `${label}: company ${repr(companyId)} is outside the actor's scope (allowed: ${[...scope.allowedCompanyIds].sort().join(", ")})`,
    companyId,
  );
}

/**
 * A PERSISTED entity must carry a concrete (non-empty string) company. A
 * resolved entity with a null / "" / non-str company is corrupt and
 * unverifiable — fail closed rather than treating it as "home", which would let
 * two blank entities pass a same-origin check (company_scope.py:266).
 */
export function requireResolvedCompany(company: unknown, label: string, kind: string): void {
  if (typeof company !== "string" || company === "") {
    throw new CompanyScopeError(
      `${label}: resolved ${kind} has an unverifiable company id ${repr(company)} (corrupt/blank — fail-closed)`,
      company,
    );
  }
}
