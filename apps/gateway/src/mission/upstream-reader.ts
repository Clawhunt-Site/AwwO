import type { CompanyCapability, MissionRole } from './types.js';
import { mapAgentRole } from './roles.js';

// Reads real companies + their agents from the vendored upstream Node server and
// derives each company's mission CAPABILITY (which roles it can staff). The
// upstream is treated as an opaque loopback HTTP dependency (same principle as
// upstream.ts) — we never import its source.
//
// Contract (existing upstream routes, zero server change):
//   GET {base}/api/companies                 → [{ id, name, status }]
//   GET {base}/api/companies/{id}/agents     → [{ id, name, role, title, status }]
//
// Fail-soft: a company whose row is unreadable is dropped; a company whose agent
// roster read fails contributes NO capability (it can't be confirmed to staff
// any role, so it must not falsely match one — fail-closed matching). A fully
// unreachable upstream surfaces as an error the route maps to 502.

export interface CompanyCapabilitiesResult {
  capabilities: CompanyCapability[];
  /** Company ids whose /agents roster read FAILED — their real capability is
   *  unknown, so they are excluded from matching AND a mission over these
   *  companies must NOT claim full coverage. Surfaced so the result is honest
   *  rather than silently treating an unreadable roster as "no capability". */
  unreadableCompanies: string[];
}

export interface UpstreamCompanyReader {
  readCompanyCapabilities(): Promise<CompanyCapabilitiesResult>;
}

/** Ceiling on companies read per plan — each costs an agents fetch, so an
 *  unbounded instance would N+1 itself. Overflow is dropped (a plan matches
 *  within the first N houses); kept modest and documented. */
export const MAX_MATCH_COMPANIES = 20;

// An agent can be staffed unless it is one of the upstream's directly
// non-invokable statuses. Mirrors the vendored server's own vocabulary
// (server/packages/shared AGENT_STATUSES + agent-invokability
// DIRECT_NON_INVOKABLE_STATUSES): the full status set is
// active/paused/idle/running/error/pending_approval and the DEFAULT is `idle`,
// so treating only `active` as available would drop the common healthy agent.
// Unavailable = {paused, pending_approval, terminated}; everything else
// (active/idle/running/error) counts toward capability.
const UNAVAILABLE_AGENT_STATUSES = new Set(['paused', 'pending_approval', 'terminated', 'archived']);

// A company can be assigned new work only when it is not paused/archived
// (COMPANY_STATUSES = active/paused/archived; a paused company "cannot start new
// work" per the upstream budget service). Assigning a track to such a company
// would be fake coverage.
const NON_ASSIGNABLE_COMPANY_STATUSES = new Set(['paused', 'archived']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

interface RawCompany {
  id?: unknown;
  name?: unknown;
  status?: unknown;
}
interface RawAgent {
  role?: unknown;
  title?: unknown;
  status?: unknown;
}

/** Pure: derive a company's capability from its raw agent roster. Only staffable
 *  agents count toward strengths — a paused / pending_approval / terminated
 *  agent cannot be staffed, so counting it would fake coverage. A healthy
 *  default `idle` agent DOES count. Exported for direct testing. */
export function deriveCapability(
  company: { id: string; name: string },
  rawAgents: unknown,
): CompanyCapability {
  const strengths: MissionRole[] = [];
  let availableAgents = 0;
  if (Array.isArray(rawAgents)) {
    for (const a of rawAgents as RawAgent[]) {
      const status = str(a?.status) ?? 'idle'; // upstream default status is idle
      if (UNAVAILABLE_AGENT_STATUSES.has(status)) continue; // not staffable
      availableAgents += 1;
      const role = mapAgentRole(str(a?.role), str(a?.title));
      if (!strengths.includes(role)) strengths.push(role);
    }
  }
  return { companyId: company.id, companyName: company.name, strengths, availableAgents };
}

export class HttpUpstreamCompanyReader implements UpstreamCompanyReader {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxCompanies: number;

  constructor(
    upstreamBaseUrl: string,
    opts: { timeoutMs?: number; fetchImpl?: typeof fetch; maxCompanies?: number } = {},
  ) {
    this.base = upstreamBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxCompanies = opts.maxCompanies ?? MAX_MATCH_COMPANIES;
  }

  private async getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!res.ok) throw new Error(`upstream ${path} returned ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async readCompanyCapabilities(): Promise<CompanyCapabilitiesResult> {
    // A failed /companies read is fatal (nothing to match against) — let it throw
    // so the route returns 502 rather than pretending zero companies exist.
    const rawCompanies = await this.getJson('/api/companies');
    if (!Array.isArray(rawCompanies)) {
      throw new Error('upstream /api/companies did not return an array');
    }
    const seen = new Set<string>();
    const usable = (rawCompanies as RawCompany[])
      .map((c) => ({ id: str(c?.id), name: str(c?.name), status: str(c?.status) }))
      .filter((c): c is { id: string; name: string; status: string | null } => !!c.id && !!c.name)
      // Only companies that can start new work are matchable (paused/archived cannot).
      .filter((c) => !(c.status && NON_ASSIGNABLE_COMPANY_STATUSES.has(c.status)))
      .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .slice(0, this.maxCompanies);

    const unreadableCompanies: string[] = [];
    const results = await Promise.all(
      usable.map(async (c) => {
        try {
          const rawAgents = await this.getJson(`/api/companies/${encodeURIComponent(c.id)}/agents`);
          return deriveCapability(c, rawAgents);
        } catch {
          // Roster unreadable → real capability UNKNOWN. Exclude it from matching
          // and record it, so a plan over the readable companies cannot falsely
          // claim full coverage (fake success). Not swallowed to "no capability".
          unreadableCompanies.push(c.id);
          return null;
        }
      }),
    );
    return { capabilities: results.filter((c): c is CompanyCapability => c !== null), unreadableCompanies };
  }
}
