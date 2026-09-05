import { and, count, eq, gte, inArray, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  companyLogos,
  assets,
  agents,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueComments,
  projects,
  goals,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  financeEvents,
  issueReadStates,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  documents,
  budgetPolicies,
  budgetIncidents,
  feedbackVotes,
  inboxDismissals,
  issueInboxArchives,
  issueThreadInteractions,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { environmentService } from "./environments.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";

export interface CompanyActivityActor {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

const SYSTEM_COMPANY_ACTOR: CompanyActivityActor = {
  actorType: "system",
  actorId: "system",
  agentId: null,
  runId: null,
};

export function companyService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";
  const environmentsSvc = environmentService(db);
  const heartbeat = heartbeatService(db);

  type CompanyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function applyArchiveCascadeInTx(tx: CompanyTx, id: string) {
    const pausedAgentRows = await tx
      .update(agents)
      .set({
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agents.companyId, id),
        notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
      ))
      .returning({ id: agents.id });

    const activeRunIds = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, id),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ))
      .then((rows) => rows.map((row) => row.id));

    await tx
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        error: "Cancelled because the company was archived",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentWakeupRequests.companyId, id),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        isNull(agentWakeupRequests.runId),
      ));

    return { agentsPaused: pausedAgentRows.length, activeRunIds };
  }

  async function finalizeArchive(
    id: string,
    actor: CompanyActivityActor,
    cascade: { agentsPaused: number; activeRunIds: string[] },
  ) {
    for (const runId of cascade.activeRunIds) {
      await heartbeat.cancelRun(runId, "Cancelled because the company was archived");
    }

    await logActivity(db, {
      companyId: id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action: "company.archived",
      entityType: "company",
      entityId: id,
      details: {
        agentsPaused: cascade.agentsPaused,
        runsCancelled: cascade.activeRunIds.length,
      },
    });
  }

  const companySelection = {
    id: companies.id,
    name: companies.name,
    description: companies.description,
    status: companies.status,
    issuePrefix: companies.issuePrefix,
    issueCounter: companies.issueCounter,
    budgetMonthlyCents: companies.budgetMonthlyCents,
    spentMonthlyCents: companies.spentMonthlyCents,
    attachmentMaxBytes: companies.attachmentMaxBytes,
    requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
    feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
    feedbackDataSharingConsentAt: companies.feedbackDataSharingConsentAt,
    feedbackDataSharingConsentByUserId: companies.feedbackDataSharingConsentByUserId,
    feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
    brandColor: companies.brandColor,
    logoAssetId: companyLogos.assetId,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(company: T) {
    return {
      ...company,
      logoUrl: company.logoAssetId ? `/api/assets/${company.logoAssetId}/content` : null,
    };
  }

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  async function getMonthlySpendByCompanyIds(
    companyIds: string[],
    database: Pick<Db, "select"> = db,
  ) {
    if (companyIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await database
        .select({
          companyId: costEvents.companyId,
          spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
      .from(costEvents)
      .where(
        and(
          inArray(costEvents.companyId, companyIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.companyId);
    return new Map(rows.map((row) => [row.companyId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateCompanySpend<T extends { id: string; spentMonthlyCents: number }>(
    rows: T[],
    database: Pick<Db, "select"> = db,
  ) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(rows.map((row) => row.id), database);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByCompanyId.get(row.id) ?? 0,
    }));
  }

  function getCompanyQuery(database: Pick<Db, "select">) {
    return database
      .select(companySelection)
      .from(companies)
      .leftJoin(companyLogos, eq(companyLogos.companyId, companies.id));
  }

  function deriveIssuePrefixBase(name: string) {
    const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
    return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
  }

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function isIssuePrefixConflict(error: unknown) {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      const maybe = current as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
      const constraint = maybe.constraint ?? maybe.constraint_name;
      if (maybe.code === "23505" && constraint === "companies_issue_prefix_idx") {
        return true;
      }
      current = maybe.cause;
    }
    return false;
  }

  async function createCompanyWithUniquePrefix(data: typeof companies.$inferInsert) {
    const base = deriveIssuePrefixBase(data.name);
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      try {
        const rows = await db
          .insert(companies)
          .values({ ...data, issuePrefix: candidate })
          .returning();
        return rows[0];
      } catch (error) {
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: async (id: string) => {
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    create: async (data: typeof companies.$inferInsert) => {
      const created = await createCompanyWithUniquePrefix(data);
      await environmentsSvc.ensureLocalEnvironment(created.id);
      const row = await getCompanyQuery(db)
        .where(eq(companies.id, created.id))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Company not found after creation");
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    update: async (
      id: string,
      data: Partial<typeof companies.$inferInsert> & { logoAssetId?: string | null },
      actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR,
    ) => {
      const result = await db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const { logoAssetId, ...companyPatch } = data;
        const willReactivate = existing.status !== "active" && companyPatch.status === "active";
        const willArchive = existing.status !== "archived" && companyPatch.status === "archived";

        if (logoAssetId !== undefined && logoAssetId !== null) {
          const nextLogoAsset = await tx
            .select({ id: assets.id, companyId: assets.companyId })
            .from(assets)
            .where(eq(assets.id, logoAssetId))
            .then((rows) => rows[0] ?? null);
          if (!nextLogoAsset) throw notFound("Logo asset not found");
          if (nextLogoAsset.companyId !== existing.id) {
            throw unprocessable("Logo asset must belong to the same company");
          }
        }

        const updated = await tx
          .update(companies)
          .set({ ...companyPatch, updatedAt: new Date() })
          .where(eq(companies.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        let agentsRestored = 0;
        if (willReactivate) {
          const restoredRows = await tx
            .update(agents)
            .set({
              status: "idle",
              pauseReason: null,
              pausedAt: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(agents.companyId, id),
              eq(agents.status, "paused"),
              eq(agents.pauseReason, "company_archived"),
            ))
            .returning({ id: agents.id });
          agentsRestored = restoredRows.length;
        }

        const archiveCascade = willArchive ? await applyArchiveCascadeInTx(tx, id) : null;

        if (logoAssetId === null) {
          await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        } else if (logoAssetId !== undefined) {
          await tx
            .insert(companyLogos)
            .values({
              companyId: id,
              assetId: logoAssetId,
            })
            .onConflictDoUpdate({
              target: companyLogos.companyId,
              set: {
                assetId: logoAssetId,
                updatedAt: new Date(),
              },
            });
        }

        if (logoAssetId !== undefined && existing.logoAssetId && existing.logoAssetId !== logoAssetId) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
        }], tx);

        const shouldLogReactivation = willReactivate &&
          (existing.status === "archived" || agentsRestored > 0);

        return {
          company: enrichCompany(hydrated),
          reactivated: shouldLogReactivation ? { agentsRestored } : null,
          archiveCascade,
        };
      });
      if (!result) return null;
      if (result.reactivated) {
        await logActivity(db, {
          companyId: id,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "company.reactivated",
          entityType: "company",
          entityId: id,
          details: { agentsRestored: result.reactivated.agentsRestored },
        });
      }
      if (result.archiveCascade) {
        await finalizeArchive(id, actor, result.archiveCascade);
      }
      return result.company;
    },

    archive: async (id: string, actor: CompanyActivityActor = SYSTEM_COMPANY_ACTOR) => {
      const result = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ status: companies.status })
          .from(companies)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const wasAlreadyArchived = existing.status === "archived";

        if (!wasAlreadyArchived) {
          await tx
            .update(companies)
            .set({ status: "archived", updatedAt: new Date() })
            .where(eq(companies.id, id));
        }

        const cascade = wasAlreadyArchived ? null : await applyArchiveCascadeInTx(tx, id);

        const row = await getCompanyQuery(tx)
          .where(eq(companies.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return {
          company: enrichCompany(hydrated),
          cascade,
        };
      });
      if (!result) return null;

      if (result.cascade) {
        await finalizeArchive(id, actor, result.cascade);
      }

      return result.company;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // Delete from child tables in dependency order.
        //
        // These seven tables reference the company (and, for some, issues/agents/
        // approvals/budget_policies) ONLY via NO ACTION foreign keys, and have no
        // CASCADE path through a parent deleted below — so any rows here would block
        // the final company delete (the rest of the NO ACTION children cascade away
        // when their issue/project/agent/document/routine parent is deleted). Without
        // this, deleting a company that has e.g. a budget policy 500s on a FK
        // violation. Delete them FIRST: each references only rows deleted later (or
        // the company itself), so child-first removal is always safe. budget_incidents
        // precedes budget_policies because it references it.
        await tx.delete(budgetIncidents).where(eq(budgetIncidents.companyId, id));
        await tx.delete(budgetPolicies).where(eq(budgetPolicies.companyId, id));
        await tx.delete(feedbackVotes).where(eq(feedbackVotes.companyId, id));
        await tx.delete(issueInboxArchives).where(eq(issueInboxArchives.companyId, id));
        await tx.delete(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, id));
        await tx.delete(inboxDismissals).where(eq(inboxDismissals.companyId, id));
        await tx.delete(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, id));

        // Subqueries over this company's parent rows (still present here; deleted
        // further down). Always embedded as SQL subselects, NEVER materialized into
        // id arrays — an inArray over a fetched list breaks past ~65k rows on the
        // Postgres bind-parameter limit, turning a big company's delete into a 500.
        const companyRunIds = tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, id));
        const companyIssueIds = tx
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.companyId, id));
        const companyProjectIds = tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.companyId, id));
        const companyGoalIds = tx
          .select({ id: goals.id })
          .from(goals)
          .where(eq(goals.companyId, id));
        const companyAgentIds = tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.companyId, id));
        const companyCostEventIds = tx
          .select({ id: costEvents.id })
          .from(costEvents)
          .where(eq(costEvents.companyId, id));

        // Defensively UNLINK other companies' cost/finance events that reference THIS
        // company's rows through their nullable NO ACTION FKs. The write layer now
        // rejects cross-company references (costService/financeService ownership
        // checks), but rows created before that guard would otherwise block the
        // parent deletes below — and they are ANOTHER tenant's accounting records,
        // so they must be unlinked, never deleted, by this company's teardown.
        // (cost_events.agentId is NOT NULL but has always been ownership-checked at
        // the write layer, so a cross-company agent reference cannot exist via the API.)
        await tx.update(financeEvents).set({ costEventId: null })
          .where(and(ne(financeEvents.companyId, id), inArray(financeEvents.costEventId, companyCostEventIds)));
        await tx.update(financeEvents).set({ heartbeatRunId: null })
          .where(and(ne(financeEvents.companyId, id), inArray(financeEvents.heartbeatRunId, companyRunIds)));
        await tx.update(financeEvents).set({ issueId: null })
          .where(and(ne(financeEvents.companyId, id), inArray(financeEvents.issueId, companyIssueIds)));
        await tx.update(financeEvents).set({ projectId: null })
          .where(and(ne(financeEvents.companyId, id), inArray(financeEvents.projectId, companyProjectIds)));
        await tx.update(financeEvents).set({ goalId: null })
          .where(and(ne(financeEvents.companyId, id), inArray(financeEvents.goalId, companyGoalIds)));
        await tx.update(financeEvents).set({ agentId: null })
          .where(and(ne(financeEvents.companyId, id), inArray(financeEvents.agentId, companyAgentIds)));
        await tx.update(costEvents).set({ heartbeatRunId: null })
          .where(and(ne(costEvents.companyId, id), inArray(costEvents.heartbeatRunId, companyRunIds)));
        await tx.update(costEvents).set({ issueId: null })
          .where(and(ne(costEvents.companyId, id), inArray(costEvents.issueId, companyIssueIds)));
        await tx.update(costEvents).set({ projectId: null })
          .where(and(ne(costEvents.companyId, id), inArray(costEvents.projectId, companyProjectIds)));
        await tx.update(costEvents).set({ goalId: null })
          .where(and(ne(costEvents.companyId, id), inArray(costEvents.goalId, companyGoalIds)));

        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id));
        // Defensive second pass by runId (kept from the original code, subquery form):
        // clears any event row whose companyId diverged from its run's company.
        await tx.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.runId, companyRunIds));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, id));
        await tx.delete(activityLog).where(eq(activityLog.companyId, id));
        // finance_events and cost_events reference heartbeat_runs (and finance_events
        // references cost_events) via NO ACTION FKs, so both must be gone before the
        // runs — finance first. With them after (the old order), deleting a company
        // that had ANY costed run 500'd on cost_events_heartbeat_run_id_..._fk.
        await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, id));
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        await tx.delete(approvalComments).where(eq(approvalComments.companyId, id));
        await tx.delete(approvals).where(eq(approvals.companyId, id));
        await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
        await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
        await tx.delete(invites).where(eq(invites.companyId, id));
        await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, id));
        await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, id));
        await tx.delete(companySkills).where(eq(companySkills.companyId, id));
        await tx.delete(issueReadStates).where(eq(issueReadStates.companyId, id));
        await tx.delete(documents).where(eq(documents.companyId, id));
        await tx.delete(issues).where(eq(issues.companyId, id));
        await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        await tx.delete(assets).where(eq(assets.companyId, id));
        // projects.goal_id is a NO ACTION FK to goals, so projects go first — the
        // old goals-then-projects order 500'd for any company using Goal Mode.
        await tx.delete(projects).where(eq(projects.companyId, id));
        await tx.delete(goals).where(eq(goals.companyId, id));
        await tx.delete(agents).where(eq(agents.companyId, id));
        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }),

    stats: () =>
      Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          .groupBy(issues.companyId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.companyId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.companyId]) {
            result[row.companyId].issueCount = row.count;
          } else {
            result[row.companyId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
