import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { companySkillService } from "../services/company-skills.js";
import { findLocalChatCompanyId } from "../services/chat-compat.js";
import { unionGlobalRuntimeSkillEntries } from "../services/global-runtime-skills.js";
import { ensureSeedChatSkills } from "../services/seed-chat-skills.js";
import { isVendoredEngineSkillKey } from "@paperclipai/shared/skill-key-namespaces";

/**
 * Legacy `GET /v1/skills` — the composer's @skill suggestion source. Projects
 * the host chat company's available runtime skills (the very skills the native
 * heartbeat run injects into the adapter, so a suggested skill is one that will
 * actually be available to the runtime). Mounted at the app root (not under
 * /api) to match the legacy path; gated to local_trusted.
 *
 * Note: FULL skill/plugin injection needs no compat code — a chat turn runs
 * through `heartbeat.wakeup → executeRun`, which unconditionally attaches the
 * company's `paperclipRuntimeSkills` + plugin runtime-services, so the model can
 * use any of them. (Per-turn EXPLICIT `@skill:<slug>` scoping is a separate
 * backlog item: the composer emits a plain `@skill:` token, while the native
 * run-scoped path extracts `skill://` markdown mentions — full injection is
 * unaffected, only the "narrow this turn to one skill version" refinement.)
 */
export function chatSkillsRoutes(db: Db, opts: { deploymentMode: DeploymentMode }) {
  const router = Router();

  // Seed the built-in skill-creator into the global store at startup (idempotent,
  // non-destructive, best-effort) so it's available to the @skill picker + every
  // run. Gated to local_trusted: seeding writes ~/.superclaw/skills, so it is a
  // chat-surface side effect that must respect the SAME deployment gate the
  // handler enforces — a non-local instance (where /v1/skills 403s) must never
  // mutate the global store at startup. Fire-and-forget: a seed failure must
  // never break route setup.
  if (opts.deploymentMode === "local_trusted") {
    void ensureSeedChatSkills().catch(() => {});
  }

  router.get("/v1/skills", async (_req, res) => {
    if (opts.deploymentMode !== "local_trusted") {
      res.status(403).json({
        error: "Chat is only available on local single-operator instances",
        code: "DEPLOYMENT_MODE_UNSUPPORTED",
      });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    // Company runtime skills use the same inventory/reconciliation path as the
    // heartbeat run (so it is NOT a pure read), but a SUGGESTION is narrower than
    // what gets injected: `materializeMissing: false` plus the `missing` filter
    // below mean only skills with an existing runtime source are suggested.
    // The global skills (~/.superclaw/skills) are available regardless of whether
    // the local chat company exists yet — a fresh instance with no chat company
    // must still surface the built-in skill-creator — so union even with no
    // company entries rather than short-circuiting to an empty list.
    const companyEntries = companyId
      ? await companySkillService(db).listRuntimeSkillEntries(companyId, {
          materializeMissing: false,
        })
      : [];
    // Suggest exactly what a run actually injects: the company's runtime skills
    // UNIONED with the global skill store (~/.superclaw/skills), mirroring the
    // heartbeat run's `unionGlobalRuntimeSkillEntries`. Without this, a globally
    // available skill (and the skill-creator) is silently injected at runtime but
    // never appears in the `@skill` picker — so the surface couldn't reference it.
    // Company wins on a runtimeName collision (same fail-closed union as the run).
    const entries = await unionGlobalRuntimeSkillEntries(companyEntries);
    res.json({
      skills: entries
        .filter((entry) => entry.sourceStatus !== "missing")
        // De-brand + relevance: suggest SuperClaw capabilities (the global store +
        // the user's company skills), never the vendored engine's bundled internals.
        .filter((entry) => !isVendoredEngineSkillKey(entry.key))
        .map((entry) => ({
          slug: entry.key,
          name: entry.runtimeName ?? entry.key,
          description: "",
        })),
    });
  });

  return router;
}
