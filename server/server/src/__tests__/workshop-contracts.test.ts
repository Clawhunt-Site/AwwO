import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { errorHandler } from "../middleware/error-handler.js";
import { workshopContractRoutes } from "../routes/workshop-contracts.js";
import {
  GITHUB_PLUGIN_CATALOG,
  buildCapabilityUploadContract,
  buildCatalogContractPayload,
  buildGithubCatalogPayload,
} from "../services/workshop-contracts.js";

/**
 * Mount the workshop contract routes behind a stub actor middleware (mirroring how
 * the real `actorMiddleware` populates `req.actor`) + the shared `errorHandler`, so
 * thrown HttpErrors surface as their real status codes.
 */
function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { ...actor } as Express.Request["actor"];
    next();
  });
  app.use("/api", workshopContractRoutes());
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

const BOARD_ACTOR = {
  type: "board",
  userId: "local",
  userName: null,
  userEmail: null,
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: [],
  memberships: [],
} as unknown as Express.Request["actor"];

const ANON_ACTOR = { type: "none" } as unknown as Express.Request["actor"];

const AGENT_ACTOR = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
} as unknown as Express.Request["actor"];

const WORKSHOP_PATHS = [
  "/api/contracts/catalog",
  "/api/contracts/capability-upload",
  "/api/plugins/github-catalog",
] as const;

describe("workshop contract routes — board access serves payloads verbatim", () => {
  it("GET /api/contracts/catalog", async () => {
    const res = await requestApp(createApp(BOARD_ACTOR), (url) => request(url).get("/api/contracts/catalog"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(buildCatalogContractPayload());
  });

  it("GET /api/contracts/capability-upload", async () => {
    const res = await requestApp(createApp(BOARD_ACTOR), (url) =>
      request(url).get("/api/contracts/capability-upload"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(buildCapabilityUploadContract());
  });

  it("GET /api/plugins/github-catalog", async () => {
    const res = await requestApp(createApp(BOARD_ACTOR), (url) =>
      request(url).get("/api/plugins/github-catalog"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(buildGithubCatalogPayload());
  });
});

describe("workshop contract routes — control-plane auth gate (parity with require_control_token)", () => {
  it("rejects anonymous callers with 401 (kernel returns 401; web only suppresses 401)", async () => {
    for (const path of WORKSHOP_PATHS) {
      const res = await requestApp(createApp(ANON_ACTOR), (url) => request(url).get(path));
      expect(res.status, `anonymous ${path}`).toBe(401);
    }
  });

  it("admits any authenticated actor — agent keys included (token check is actor-agnostic)", async () => {
    for (const path of WORKSHOP_PATHS) {
      const res = await requestApp(createApp(AGENT_ACTOR), (url) => request(url).get(path));
      expect(res.status, `agent ${path}`).toBe(200);
    }
  });
});

describe("catalog contract payload (golden — ui_contracts.build_catalog_contract_payload)", () => {
  const payload = buildCatalogContractPayload();

  it("pins the contract identity + endpoints", () => {
    expect(payload.capability).toBe("capability-catalog");
    expect(payload.schema_version).toBe("0.1.0");
    expect(payload.status_url).toBe("/v1/catalog");
    expect(payload.refresh_url).toBe("/v1/catalog/refresh");
    expect(payload.trust_state_url_template).toBe("/v1/catalog/trust/{plugin_id}/{version}");
    expect(payload.legacy_views).toEqual({ plugins_url: "/v1/plugins", skills_url: "/v1/skills" });
  });

  it("orders trust_states most→least trusted and locks the trust copy", () => {
    expect(payload.trust_states).toEqual(["official", "developer", "local", "untrusted"]);
    expect((payload.copy as Record<string, unknown>).trust).toEqual({
      official: "Official",
      developer: "Developer signed",
      local: "Local",
      untrusted: "Untrusted",
    });
  });

  it("derives company instantiability from trust (never a client rule)", () => {
    expect(payload.kinds).toEqual(["plugin", "skill", "company"]);
    expect(payload.instantiable_semantics).toEqual({
      plugin: "install",
      skill: "install",
      company: "bootstrap_proposal",
      derived_from_trust: true,
      company_instantiable_trust: ["official", "local"],
      company_developer_disabled_reason: "developer_source_not_instantiable_pending_verify",
    });
    expect(payload.install_blocking).toEqual({ untrusted: true, revoked: true, namespace_hijack: true });
  });
});

describe("capability-upload contract (golden — ui_contracts.build_capability_upload_contract)", () => {
  const payload = buildCapabilityUploadContract();
  const kinds = payload.kinds as Array<Record<string, unknown>>;

  it("frames upload as local-path and excludes signing/publish/listing", () => {
    expect(payload.capability).toBe("capability-upload");
    expect(payload.artifact_source).toBe("local_path");
    expect(payload.excludes).toEqual(["signing_private_key", "publish", "marketplace_listing"]);
  });

  it("locks the kind vocabulary to the kernel CAPABILITY_KINDS set", () => {
    expect(kinds.map((k) => k.value)).toEqual(["plugin", "skill", "company"]);
  });

  it("lists the kernel-required plugin docs in the plugin contents checklist", () => {
    const plugin = kinds.find((k) => k.value === "plugin")!;
    const paths = (plugin.contents as Array<Record<string, unknown>>).map((c) => c.path);
    for (const doc of ["SUPPORT.md", "LICENSE", "PERMISSIONS.md", "SECURITY.md", "CHANGELOG.md"]) {
      expect(paths).toContain(doc);
    }
    expect(plugin.review).toBe("Full automated preflight gate battery, including a sandbox smoke run.");
  });

  it("exposes L1/L2/L3 acceptance levels", () => {
    expect((payload.acceptance_levels as Array<Record<string, unknown>>).map((l) => l.value)).toEqual([
      "L1",
      "L2",
      "L3",
    ]);
  });
});

describe("github catalog payload (golden — apps/api/main.py GITHUB_PLUGIN_CATALOG)", () => {
  it("returns an empty catalog (pay-switch-agent removed; asset lost with the org suspension)", () => {
    const { plugins } = buildGithubCatalogPayload();
    expect(plugins).toHaveLength(GITHUB_PLUGIN_CATALOG.length);
    expect(plugins).toEqual([]);
  });

  it("returns a fresh array (mutating the payload does not corrupt the source)", () => {
    const a = buildGithubCatalogPayload();
    a.plugins.push({ plugin_id: "mutated" });
    expect(buildGithubCatalogPayload().plugins).toEqual([]);
  });
});
