import { canvasFetch } from './saas/canvasBridge';
// P2c hire data layer — found the proposed roster into a company the canvas just
// created. POST /companies/:id/agent-hires is a real, non-idempotent mutation, so
// it reuses the SAME tri-state outcome contract the P2b company-founding path
// converged on over four Codex rounds (created / rejected / unknown — a lost
// response is UNKNOWN, never a false "not hired"), and the same same-origin /
// loopback base guard (never POST credentials to an arbitrary host).
//
// The runtime (adapterType) + model + effort come from the governed, contract-
// driven RuntimePicker (铁律6) — this module never hardcodes a model or effort;
// it just carries the operator's chosen RuntimeValue into the hire body, where
// model/effort belong under `adapterConfig` (NOT top-level, NOT runtimeConfig).

/** Canvas mission roles → the kernel's AGENT_ROLES buckets (constants.ts). The
 *  proposal roster only carries {role: MissionRole, title}; the hire `role` field
 *  wants an AGENT_ROLES value. Best-fit; the agent's title carries the real
 *  persona, `role` is a coarse org bucket. */
const MISSION_TO_AGENT_ROLE: Record<string, string> = {
  explore: 'researcher',
  plan: 'pm',
  implement: 'engineer',
  verify: 'qa',
  review: 'general',
};

export function missionRoleToAgentRole(role: string): string {
  return MISSION_TO_AGENT_ROLE[role] ?? 'general';
}

export interface HireSpec {
  /** Persona name/title (the proposal roster title). */
  name: string;
  /** Canvas mission role (explore/plan/implement/verify/review). */
  missionRole: string;
  /** Runtime chosen in the governed picker (adapter type, e.g. claude_local). */
  adapterType: string;
  /** Model chosen in the picker ('' = the runtime's own default — omitted). */
  model: string;
  /** Effort chosen in the picker ('' = inherit runtime default — omitted). */
  effort: string;
}

export type HireOutcome =
  | { outcome: 'created'; agentId: string; status: string }
  | { outcome: 'rejected'; detail: string }
  | { outcome: 'unknown'; detail: string };

// Only these non-2xx are provably pre-insert (schema validation / auth / unknown
// adapter 422) → nothing hired → safe to retry. Every other non-2xx (incl. 404,
// which the server can raise AFTER inserting on a re-read) → unknown.
const REJECTED_BEFORE_INSERT = new Set([400, 401, 403, 422]);
const HIRE_TIMEOUT_MS = 12_000;

export function normalizeBase(base: string | undefined): string {
  const t = (base ?? '').trim().replace(/\/+$/, '');
  return t || '/paperclip-api';
}

function isLoopbackHost(h: string): boolean {
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const octs = m.slice(1).map((s) => Number(s));
  return octs[0] === 127 && octs.every((o) => o >= 0 && o <= 255);
}

export function isAllowedBase(base: string): boolean {
  if (base.startsWith('//')) return false; // protocol-relative → cross-origin
  if (base.startsWith('/')) return true;
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isLoopbackHost(u.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase());
  } catch {
    return false;
  }
}

/** Build the agent-hire request body. Pure + exported for testing. model/effort
 *  go under adapterConfig, and only when the picker actually chose one (a blank
 *  means "use the runtime's own default" — never send an empty explicit value,
 *  which the kernel fail-closes for a runtime that doesn't honor it). */
export function buildHireBody(spec: HireSpec): Record<string, unknown> {
  const adapterConfig: Record<string, unknown> = {};
  // The control plane otherwise defaults Codex hires to bypassing its sandbox. Canvas
  // execution keeps workspace writes scoped and inherits the CLI's approval policy.
  if (spec.adapterType === 'codex_local') {
    adapterConfig.dangerouslyBypassApprovalsAndSandbox = false;
    adapterConfig.dangerouslyBypassSandbox = false;
    adapterConfig.extraArgs = ['--sandbox', 'workspace-write'];
    // New native agents reject legacy prompt templates. Let the server materialize its
    // managed instructions bundle; the inspector separately syncs the chosen persona.
    // Every canvas request, including the first, supplies its actual task/contract in a
    // comment wake, which the Codex adapter renders independently of its default prompt.
  }
  if (spec.model.trim()) adapterConfig.model = spec.model.trim();
  if (spec.effort.trim()) {
    // Codex's native adapter reads modelReasoningEffort; other runtimes keep
    // their existing effort contract. A blank selection still inherits defaults.
    const effortKey = spec.adapterType === 'codex_local' ? 'modelReasoningEffort' : 'effort';
    adapterConfig[effortKey] = spec.effort.trim();
  }
  return {
    name: spec.name,
    role: missionRoleToAgentRole(spec.missionRole),
    title: spec.name,
    adapterType: spec.adapterType,
    ...(Object.keys(adapterConfig).length > 0 ? { adapterConfig } : {}),
    // Canvas agents do not schedule their own timer runs. Requested graph and chat
    // wakes remain available through the server's independent wakeOnDemand default.
    runtimeConfig: { heartbeat: { enabled: false } },
  };
}

/** Hire one agent into a company. Never throws — returns the tri-state outcome. */
export async function hireAgentIntoCompany(
  baseRaw: string | undefined,
  companyId: string,
  spec: HireSpec,
): Promise<HireOutcome> {
  if (!spec.name.trim()) return { outcome: 'rejected', detail: 'empty name (not sent)' };
  if (!spec.adapterType.trim()) return { outcome: 'rejected', detail: 'no runtime chosen (not sent)' };
  const base = normalizeBase(baseRaw);
  if (!isAllowedBase(base)) return { outcome: 'rejected', detail: 'disallowed base (not sent)' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HIRE_TIMEOUT_MS);
  let responded = false;
  try {
    const res = await canvasFetch(`${base}/companies/${encodeURIComponent(companyId)}/agent-hires`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify(buildHireBody(spec)),
      signal: ctrl.signal,
    });
    responded = true;
    if (!res.ok) {
      if (REJECTED_BEFORE_INSERT.has(res.status)) {
        let reason = '';
        try {
          const body = await res.json() as { error?: unknown; message?: unknown } | null;
          const message = typeof body?.error === 'string' ? body.error : body?.message;
          if (typeof message === 'string') reason = message.trim().slice(0, 400);
        } catch { /* The status already proves rejection even if the error body is unreadable. */ }
        return { outcome: 'rejected', detail: `server ${res.status}${reason ? `: ${reason}` : ''}` };
      }
      return { outcome: 'unknown', detail: `server ${res.status} (may have hired before failing)` };
    }
    let body: { agent?: { id?: unknown; status?: unknown } };
    try {
      body = (await res.json()) as { agent?: { id?: unknown; status?: unknown } };
    } catch {
      return { outcome: 'unknown', detail: 'hired (2xx) but response body unreadable' };
    }
    const agentId = typeof body?.agent?.id === 'string' && body.agent.id ? body.agent.id : null;
    if (!agentId) return { outcome: 'unknown', detail: 'hired (2xx) but no agent id in response' };
    // status is 'idle' (usable) or 'pending_approval' (company requires board
    // approval) — surfaced as-is, honestly; both are a real creation.
    const status = typeof body?.agent?.status === 'string' ? body.agent.status : 'idle';
    return { outcome: 'created', agentId, status };
  } catch {
    return responded
      ? { outcome: 'unknown', detail: 'response lost after request was sent' }
      : { outcome: 'unknown', detail: 'network error (request may or may not have been sent)' };
  } finally {
    clearTimeout(timer);
  }
}
