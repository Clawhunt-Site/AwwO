import { Router } from "express";

import {
  buildCapabilityUploadContract,
  buildCatalogContractPayload,
  buildGithubCatalogPayload,
} from "../services/workshop-contracts.js";
import { fetchMarketplaceCatalog, fetchWorkshopCatalog } from "../services/workshop-catalog.js";
import { assertAuthenticated } from "./authz.js";

/**
 * Capability Workshop — static contract routes (slice 1).
 *
 * Re-serves three of SuperClaw's existing `/api/...` workshop endpoints from the
 * Paperclip Node server with byte-for-shape identical payloads, so the web surface
 * (apps/web `loadPluginControl`) does not drift:
 *   GET /api/contracts/catalog            → build_catalog_contract_payload()
 *   GET /api/contracts/capability-upload  → build_capability_upload_contract()
 *   GET /api/plugins/github-catalog       → GITHUB_PLUGIN_CATALOG
 *
 * Auth parity: the FastAPI originals require `Depends(require_control_token)`
 * (apps/api/main.py:2676) — a purely token-based, actor-type-agnostic control-plane
 * check that 401s on a missing/wrong token. The faithful Paperclip-native gate is
 * therefore `assertAuthenticated`: any authenticated actor passes (mirroring "valid
 * control token → allowed"), and anonymous callers (`actor.type === "none"`) get 401
 * — matching the kernel AND the web surface, which only suppresses 401 in
 * `loadPluginControl`. This is basic control-plane authentication and deliberately
 * adds NO actor-type semantics the kernel lacks (no board-only / company gate); the
 * per-company equip/grant governance was dropped by the owner
 * (docs/workshop-on-paperclip-api-mapping.md §3.6).
 *
 * MUST be mounted BEFORE pluginRoutes so `/plugins/github-catalog` wins over the
 * `/plugins/:pluginId` route (otherwise Express resolves pluginId="github-catalog").
 */
export function workshopContractRoutes() {
  const router = Router();

  router.get("/contracts/catalog", (req, res) => {
    assertAuthenticated(req);
    res.json(buildCatalogContractPayload());
  });

  router.get("/contracts/capability-upload", (req, res) => {
    assertAuthenticated(req);
    res.json(buildCapabilityUploadContract());
  });

  router.get("/plugins/github-catalog", (req, res) => {
    assertAuthenticated(req);
    res.json(buildGithubCatalogPayload());
  });

  // Live catalog proxies — fetch the ClawHunt-hosted feed and re-shape it. They never
  // throw on a feed failure (return {source:"unavailable", …}); only auth/config can.
  router.get("/plugins/marketplace-catalog", async (req, res) => {
    assertAuthenticated(req);
    res.json(await fetchMarketplaceCatalog());
  });

  router.get("/plugins/workshop-catalog", async (req, res) => {
    assertAuthenticated(req);
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    res.json(await fetchWorkshopCatalog(kind));
  });

  return router;
}
