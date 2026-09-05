/**
 * Bind a supplied plugin-tool `runContext` to the AUTHENTICATED caller.
 *
 * `validateToolRunContextScope` (routes/plugins.ts) only proves the runContext
 * is self-consistent in the DB (agent∈company, run∈agent, project∈company). It
 * does NOT prove the *caller* is that agent/run — so within one company an agent
 * could drive tools under another agent's identity by passing a foreign (but
 * self-consistent) runContext. This is the agent-identity half of blocker 1
 * (see docs/node-agent-capability-bridge-design.md §3.1).
 *
 * For an AGENT caller the identity comes from a signed JWT (agentId = `sub`,
 * companyId = `company_id`), so requiring the runContext to match those is a
 * real binding an attacker cannot forge. The `runId` check is defense-in-depth:
 * it is only authoritative when sourced from the JWT claim (the header form is
 * spoofable), but the agentId/companyId binding alone already closes
 * cross-agent impersonation within a company.
 *
 * Board / operator callers are NOT bound here — they are a privileged management
 * surface and keep the self-consistency check. Fully removing reliance on the
 * implicit-board fallback (and minting a single-run ticket) is deferred to the
 * dedicated bridge endpoint (§4.1 / blocker 1 ticket), which does not share this
 * REST management route.
 */

export interface RunContextActor {
  readonly type: string;
  readonly agentId?: string | null;
  readonly companyId?: string | null;
  readonly runId?: string | null;
}

export interface RunContextIdentity {
  readonly agentId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly projectId: string;
}

/**
 * @returns an error string if an agent caller's identity does not match the
 * supplied runContext, otherwise `null` (match, or a non-agent caller).
 */
export function runContextActorMismatch(
  actor: RunContextActor,
  runContext: RunContextIdentity,
): string | null {
  if (actor.type !== "agent") return null;

  if (actor.agentId !== runContext.agentId || actor.companyId !== runContext.companyId) {
    return "runContext does not match the authenticated agent";
  }
  // Only enforce runId when the actor carries one; an absent claim must not be a
  // free pass for a *present* mismatch.
  if (actor.runId && actor.runId !== runContext.runId) {
    return "runContext.runId does not match the authenticated run";
  }
  return null;
}
