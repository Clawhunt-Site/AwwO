/**
 * Resolve the project a run legitimately OWNS — the single source of truth shared
 * by `/api/plugins/tools/execute` scope validation and the per-run plugin MCP
 * bridge context (heartbeat). Both must bind `projectId` the same trusted way.
 *
 * Authority comes from the issue(s) whose checkout/execution run IS this run —
 * host-written links during claim/execution, NOT the agent-shapeable
 * `contextSnapshot` (see design §7.2 / the #1 trust-chain hardening). A run may
 * own multiple issues with no uniqueness or same-project constraint, so we
 * require EXACTLY ONE distinct non-null project and verify it belongs to the
 * run's company (`issues.projectId` is a plain FK with no company composite).
 * Zero, multiple, or cross-company all fail closed — never a company-only scope.
 */

import type { Db } from "@paperclipai/db";
import { issues, projects } from "@paperclipai/db";
import type { PluginBridgeRunContext } from "@paperclipai/adapter-utils";
import { and, eq, or } from "drizzle-orm";

/**
 * Per-run context the adapters need to inject the plugin MCP bridge. The shape
 * is defined ONCE in adapter-utils (the package the adapters read it from); we
 * alias it here so a new bridge field cannot drift between host and adapter.
 * Both fields are server-derived, so the `applyPluginToolRunContext` sanitizer's
 * strip-then-write-server-value rule covers the whole object. Absent → adapters
 * must NOT wire the bridge.
 */
export type PluginToolRunContext = PluginBridgeRunContext;

export type RunUniqueOwnedProject =
  | { readonly kind: "ok"; readonly projectId: string }
  /** No owning issue carries a project. */
  | { readonly kind: "none" }
  /** Owning issues map to more than one distinct project. */
  | { readonly kind: "ambiguous" };

/**
 * Derive the SINGLE project a run owns from its owning issues, WITHOUT the
 * company-membership check (callers run that separately so each can order its
 * own checks — e.g. /tools/execute compares against the supplied projectId
 * before the company query, preserving its exact error precedence).
 */
/**
 * The single predicate for "issues this run OWNS" — its checkout/execution run
 * IS this run (host-written during claim/execution, never agent-shapeable). Both
 * the unique-project derivation AND the run-scoped plugin opt-in source must use
 * THIS so consent and the bridged project can never come from different issues
 * (see design §7.2 / the 3b-4a same-source requirement).
 */
export function runOwnsIssueWhere(companyId: string, runId: string) {
  return and(
    eq(issues.companyId, companyId),
    or(eq(issues.checkoutRunId, runId), eq(issues.executionRunId, runId)),
  );
}

export async function resolveRunUniqueOwnedProjectId(
  db: Pick<Db, "select">,
  companyId: string,
  runId: string,
): Promise<RunUniqueOwnedProject> {
  const ownerIssues = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(runOwnsIssueWhere(companyId, runId));
  const projectIds = Array.from(
    new Set(ownerIssues.map((i) => i.projectId).filter((p): p is string => typeof p === "string")),
  );
  if (projectIds.length === 0) return { kind: "none" };
  if (projectIds.length > 1) return { kind: "ambiguous" };
  return { kind: "ok", projectId: projectIds[0] };
}

/**
 * Apply the server-derived plugin tool run context to a runtimeConfig, with a
 * fail-closed sanitizer: `pluginToolRunContext` is a RESERVED, server-owned key,
 * but `runtimeConfig` is a merge of agent/user/issue-influenced config — so a
 * forged key could otherwise survive and let an adapter wire the bridge even
 * when the gate failed. Always strip any pre-existing key first; only the
 * server-computed `context` (or nothing) may be present in the result.
 */
export function applyPluginToolRunContext(
  runtimeConfig: Record<string, unknown>,
  context: PluginToolRunContext | null,
): Record<string, unknown> {
  const { pluginToolRunContext: _forged, ...rest } = runtimeConfig;
  return context ? { ...rest, pluginToolRunContext: context } : rest;
}

/**
 * Verify a project belongs to a company (`issues.projectId` is a plain FK with no
 * company composite, so an owning issue could reference a foreign-company
 * project). Fail closed on a missing or cross-company project.
 */
export async function projectBelongsToCompany(
  db: Pick<Db, "select">,
  projectId: string,
  companyId: string,
): Promise<boolean> {
  const [project] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return !!project && project.companyId === companyId;
}
