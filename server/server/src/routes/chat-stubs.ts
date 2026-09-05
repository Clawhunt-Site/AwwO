import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { companyService } from "../services/companies.js";

/**
 * Small legacy endpoints the chat frontend pings on startup. They have no native
 * equivalent and carry no chat-critical state — they exist so the surface never
 * errors on a missing route. All gated to local_trusted (single-operator chat).
 *
 * - team/messages: sidebar team-unread badge (chat has no team inbox → 0).
 * - team/companies: the @company picker source (projects the company list).
 * - onboarding: the first-run tour gate (migrated installs are past it).
 * - control-token/rotate: returns a fresh token; on local_trusted the API is
 *   loopback single-operator and the actor is granted implicitly, so the token
 *   is cosmetic (defense-in-depth the deployment doesn't enforce) — mirrors how
 *   the native server treats local_trusted.
 */
export function chatCompatStubsRoutes(db: Db, opts: { deploymentMode: DeploymentMode }) {
  const router = Router();
  const gate = (
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    if (opts.deploymentMode !== "local_trusted") {
      res.status(403).json({
        error: "Chat is only available on local single-operator instances",
        code: "DEPLOYMENT_MODE_UNSUPPORTED",
      });
      return;
    }
    next();
  };

  router.get("/team/messages", gate, (_req, res) => {
    res.json({ total_unread: 0 });
  });

  router.get("/team/companies", gate, async (_req, res) => {
    const companies = await companyService(db).list();
    res.json({
      companies: companies.map((company) => ({
        company_profile_id: company.id,
        name: company.name,
        status: company.status,
      })),
    });
  });

  router.get("/onboarding", gate, (_req, res) => {
    res.json({ completed: true, version: 1 });
  });

  router.post("/onboarding/complete", gate, (_req, res) => {
    res.json({ ok: true });
  });

  router.post("/runtime/control-token/rotate", gate, (_req, res) => {
    res.json({ control_token: randomUUID() });
  });

  return router;
}
