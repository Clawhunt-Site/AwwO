import { stat } from "node:fs/promises";

import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";

import { assertBoardOrgAccess, assertInstanceAdmin } from "./authz.js";
import {
  importWorkshopCapability,
  WorkshopImportError,
  type WorkshopImportDeps,
} from "../services/workshop-import.js";
import {
  clearPluginProvenanceOnUninstall,
  createSuperPluginInstaller,
  SuperPluginInstallError,
  uninstallSuperPlugin,
} from "../services/super-plugin-installer.js";
import {
  createSuperSkillInstaller,
  SuperSkillInstallError,
  uninstallSuperSkill,
} from "../services/super-skill-installer.js";
import {
  commitSkill,
  computeStoredSkillDigest,
  createSkillStageDir,
  hasExecutableAsset,
  hasPluginManifest,
  hasSkillMarkdown,
  materializeSkill,
  quarantineSkillDir,
  removeSkillDir,
  resolveSkillStoreDir,
  scrubPackagedProvenance,
  writeSkillProvenance,
} from "../services/super-skill-fs.js";
import { listGlobalRuntimeSkillEntries } from "../services/global-runtime-skills.js";
import { createSuperCompanyInstaller, SuperCompanyInstallError } from "../services/super-company-installer.js";
import { buildCompanyInlineFiles, SuperCompanyFsError } from "../services/super-company-fs.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { companyService } from "../services/companies.js";
import type { StorageService } from "../storage/types.js";
import {
  materializeInstall,
  readSuperManifestJson,
  removeInstallDir,
  resolveSuperPluginInstallDir,
  ScplugExtractionError,
  unpackVerifiedScplug,
} from "../services/super-workshop-fs.js";
import { isReceiptKeyConfigured, WorkshopReceiptError } from "../services/workshop-receipt.js";
import {
  deleteWorkshopProvenance,
  getWorkshopProvenance,
  recordVerifiedWorkshopProvenance,
} from "../services/workshop-provenance.js";
import {
  getSuperPluginRuntime,
  type SuperPluginRuntimeRecord,
} from "../services/super-plugin-runtime-store.js";
import { callSuperPluginTool, openSuperMcpSession } from "../services/super-mcp-runner.js";
import { assertValidToolParameters, ToolParameterValidationError } from "../services/plugin-tool-schema.js";
import {
  executeTool,
  listUnifiedPlugins,
  PluginRuntimeRouterError,
  type PaperclipPluginSummary,
} from "../services/plugin-runtime-router.js";
import { pluginRegistryService } from "../services/plugin-registry.js";

/**
 * Super-workshop runtime routes (P6b-2) — the ADD-ONLY HTTP surface that wires the
 * dual plugin runtime together. It does NOT modify the vendored `routes/plugins.ts`
 * (Paperclip's own plugin lifecycle); it adds a parallel super-owned surface:
 *
 *   POST   /api/internal/workshop-import            loopback-only; the receipt-gated
 *                                                   importer the Python gate calls
 *   GET    /api/super-plugins                       unified read catalog (JS + super)
 *   POST   /api/super-plugins/:key/tools/:tool      execute a SUPER plugin tool (P4)
 *   DELETE /api/super-plugins/:key                  uninstall a super plugin
 *
 * Trust wiring: verification stays in Python; this server re-verifies the receipt
 * HMAC + recomputes the transport digest over an immutable byte snapshot (P6b-1) and
 * records provenance from the VERIFIED receipt, so the official badge binds to cosign.
 */

/** Per-tool-call timeout for the super MCP runner. */
const SUPER_TOOL_TIMEOUT_MS = 60_000;

/** The local board principal a loopback workshop-imported company is owned by (auth.ts). */
const WORKSHOP_COMPANY_OWNER_USER_ID = "local-board";

/**
 * Whether the TCP peer is loopback. This is DEFENCE IN DEPTH only — the receipt HMAC
 * (a secret only the Python gate holds) is the actual trust boundary for the import
 * endpoint. An empty/unknown peer address is treated as NON-loopback (fail-closed),
 * never as loopback.
 */
export function isLoopbackRequest(req: Request): boolean {
  const addr = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1";
}

/** The SuperClaw deployment env the workshop receipt must be bound to (fail-closed if unset). */
function resolveExpectedAppEnv(): string | null {
  const env = process.env.SUPERCLAW_APP_ENV?.trim();
  return env ? env : null;
}

/** Whether the receipt HMAC key is configured (without revealing the env name to clients).
 * Reads the boot cache (the key is scrubbed from process.env at startup), falling back to a
 * not-yet-scrubbed env for tests. */
function receiptHmacConfigured(): boolean {
  return isReceiptKeyConfigured();
}

/** Build the importer deps with the REAL fs primitives + installers wired in. */
function buildImportDeps(
  db: Db,
  expectedAppEnv: string,
  onWarning: (m: string, e: unknown) => void,
  storageService?: StorageService,
): WorkshopImportDeps {
  const portability = companyPortabilityService(db, storageService);
  const companies = companyService(db);
  const companyInstaller = createSuperCompanyInstaller({
    buildInlineFiles: buildCompanyInlineFiles,
    importBundle: (input, actorUserId) => portability.importBundle(input, actorUserId),
    removeCompany: async (companyId) => {
      await companies.remove(companyId);
    },
    // The loopback workshop import attributes the new company to the local board user
    // (auth.ts's implicit board principal) — explicit, not the native null→"board".
    ownerUserId: WORKSHOP_COMPANY_OWNER_USER_ID,
  });
  const superInstaller = createSuperPluginInstaller({
    db,
    readSuperManifestJson,
    resolveInstallDir: resolveSuperPluginInstallDir,
    materializeInstall,
    removeInstallDir,
    // A workshop "plugin" with no super manifest is a Paperclip-native JS plugin; that
    // install path (unpacked dir → Paperclip loader) is a follow-on, fail-closed here.
    installPaperclipJsPlugin: async () => {
      throw new WorkshopImportError("Paperclip JS-format workshop import is not wired yet");
    },
  });
  const skillInstaller = createSuperSkillInstaller({
    resolveSkillDir: resolveSkillStoreDir,
    createStageDir: createSkillStageDir,
    materializeSkill,
    scrubPackagedProvenance,
    hasSkillMarkdown,
    hasPluginManifest,
    hasExecutableAsset,
    computeStoredSkillDigest,
    writeSkillProvenance,
    commitSkill,
    quarantineSkillDir,
    removeDir: removeSkillDir,
    now: () => new Date(),
  });
  return {
    expectedAppEnv,
    verifyAndUnpackArchive: (stagedArtifact, expectedTransportSha) =>
      unpackVerifiedScplug(stagedArtifact, expectedTransportSha),
    installers: { plugin: superInstaller, skill: skillInstaller, company: companyInstaller },
    // Pass the installer's verificationDigest (a skill's store digest) into provenance so
    // the official badge binds to a server-controlled, store-recomputable digest.
    recordProvenance: (receipt, nativeId, verificationDigest) =>
      recordVerifiedWorkshopProvenance(db, receipt, nativeId, verificationDigest),
    onWarning,
  };
}

/** Adapter: project Paperclip-native plugin rows into the unified catalog summary. */
function paperclipSummaries(rows: Array<{ pluginKey: string; status: string; manifestJson: unknown }>): PaperclipPluginSummary[] {
  return rows.map((row) => {
    const manifest = (row.manifestJson ?? {}) as { name?: unknown; version?: unknown; tools?: unknown };
    const tools = Array.isArray(manifest.tools)
      ? manifest.tools
          .map((t) => (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string" ? { name: (t as { name: string }).name } : null))
          .filter((t): t is { name: string } => t !== null)
      : [];
    return {
      pluginKey: row.pluginKey,
      name: typeof manifest.name === "string" ? manifest.name : row.pluginKey,
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      tools,
      status: row.status,
    };
  });
}

export function superWorkshopRoutes(
  db: Db,
  opts: { logger?: { warn: (o: unknown, m: string) => void }; storageService?: StorageService } = {},
) {
  const router = Router();
  const registry = pluginRegistryService(db);
  const companies = companyService(db);
  const warn = (message: string, err: unknown) => opts.logger?.warn({ err }, message);

  /**
   * POST /api/internal/workshop-import — loopback-only. The Python gate (after cosign
   * verification + staging) calls this with the HMAC-signed receipt. The receipt HMAC
   * + the recomputed transport digest are the trust boundary; loopback is defence in
   * depth (the endpoint never faces the public surface).
   */
  router.post("/internal/workshop-import", async (req, res) => {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    // Fail closed (and DO NOT reveal env names to the client) when the trust config
    // is missing — the server cannot verify a receipt without these.
    if (!resolveExpectedAppEnv() || !receiptHmacConfigured()) {
      res.status(503).json({ error: "workshop import is not configured" });
      return;
    }
    try {
      const outcome = await importWorkshopCapability(
        buildImportDeps(db, resolveExpectedAppEnv()!, warn, opts.storageService),
        req.body,
      );
      res.json(outcome);
    } catch (err) {
      // The detailed error is logged server-side but NEVER returned (it can leak
      // receipt/staging/install internals); the client gets a generic reason.
      // Client-correctable rejections are EXACTLY the known rejection error CLASSES
      // (receipt verification, archive integrity, per-kind install governance, import
      // orchestration) — classified by type, NOT by a fragile message substring. Any
      // OTHER error (a DB/fs/runtime failure) is a server error (500), never a
      // misleading 400.
      const clientError =
        err instanceof WorkshopImportError ||
        err instanceof WorkshopReceiptError ||
        err instanceof ScplugExtractionError ||
        err instanceof SuperSkillInstallError ||
        err instanceof SuperPluginInstallError ||
        err instanceof SuperCompanyInstallError ||
        err instanceof SuperCompanyFsError;
      warn("workshop import failed", err);
      res.status(clientError ? 400 : 500).json({ error: clientError ? "workshop import rejected" : "workshop import failed" });
    }
  });

  /** GET /api/super-plugins — unified read catalog (Paperclip JS + super), official badge from provenance. */
  router.get("/super-plugins", async (req, res) => {
    // Board-operator access (matches the native /api/plugins gate); agent keys cannot
    // enumerate the global plugin catalog here.
    assertBoardOrgAccess(req);
    const rows = await registry.listInstalled();
    const entries = await listUnifiedPlugins(db, {
      listPaperclipPlugins: async () => paperclipSummaries(rows),
      // Live drift probe: surface a super plugin whose install dir vanished as
      // "missing"/"install_failed" via effectiveStatus instead of a lying "installed".
      // Contracted never to reject — any stat error becomes a probe outcome so the
      // catalog can't be 500'd by one unreadable dir.
      probeInstallDir: async (installDir) => {
        try {
          const st = await stat(installDir);
          return st.isDirectory() ? "present" : "inaccessible";
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "inaccessible";
        }
      },
    });
    res.json(entries);
  });

  /**
   * POST /api/super-plugins/:pluginKey/tools/:toolName — execute a SUPER plugin tool.
   *
   * Governance: INSTANCE-ADMIN only. A super plugin is a stateless subprocess MCP
   * server (P4) — unlike a Paperclip JS worker it has no company-DB access, so the
   * native runContext data-scoping does not apply; what matters is that only a trusted
   * operator can TRIGGER execution of governed-at-install code (which runs unsandboxed,
   * per the accepted RCE residual). The admin floor matches the uninstall gate; a
   * fuller agent-invocation path (registering super tools into the native dispatcher
   * with a runContext) is a follow-on.
   */
  router.post("/super-plugins/:pluginKey/tools/:toolName", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginKey, toolName } = req.params;
    try {
      const result = await executeTool(db, pluginKey, toolName, req.body ?? {}, {
        callSuperTool: (record: SuperPluginRuntimeRecord, tool, input) => {
          // Server-side schema enforcement (blocker 4): the admin exec surface
          // must validate against the declared inputSchema too, or it becomes a
          // bypass of the dispatcher path's validation. Super tool schemas live
          // on the runtime record, not the in-memory tool registry.
          const decl = record.tools.find((t) => t.name === tool);
          assertValidToolParameters(decl?.inputSchema, input, `${pluginKey}:${tool}`);
          return callSuperPluginTool(tool, input, {
            openSession: () => openSuperMcpSession(record),
            timeoutMs: SUPER_TOOL_TIMEOUT_MS,
          });
        },
        // Paperclip JS plugins must execute via the native /plugins/tools/execute
        // (which carries the agent runContext); this super surface never runs them.
        dispatchPaperclipTool: async () => {
          throw new PluginRuntimeRouterError("Paperclip plugins execute via /api/plugins/tools/execute, not here");
        },
        isPaperclipPlugin: async (key) => (await registry.getByKey(key)) !== null,
      });
      res.json(result);
    } catch (err) {
      // Generic responses only — the router/runner messages reveal whether a key
      // exists, is super, lacks provenance, or its install/launcher internals; a
      // probing operator/agent must not learn those. Detail is logged, not returned.
      warn("super plugin tool execution failed", err);
      const isClientError =
        err instanceof PluginRuntimeRouterError || err instanceof ToolParameterValidationError;
      const status = isClientError ? 400 : 500;
      res.status(status).json({ error: status === 400 ? "tool cannot be executed" : "tool execution failed" });
    }
  });

  /** DELETE /api/super-plugins/:pluginKey — uninstall a super plugin (clears provenance). */
  router.delete("/super-plugins/:pluginKey", async (req, res) => {
    assertInstanceAdmin(req);
    const { pluginKey } = req.params;
    const record = await getSuperPluginRuntime(db, pluginKey);
    if (!record) {
      // Not a super plugin — still clear any stale provenance so a future same-id JS
      // plugin cannot inherit an official badge (idempotent, fail-safe).
      await clearPluginProvenanceOnUninstall(db, pluginKey);
      res.status(404).json({ error: `no super plugin installed for key: ${pluginKey}` });
      return;
    }
    await uninstallSuperPlugin({ db, removeInstallDir }, { pluginKey, installDir: record.installDir });
    res.json({ uninstalled: pluginKey });
  });

  /**
   * GET /api/super-skills — the global skill store as a catalog, with the OFFICIAL
   * badge joined from `workshop_provenance` (by slug). `listGlobalRuntimeSkillEntries`
   * is the kernel's own fail-closed enumeration (tampered/revoked skills are dropped),
   * so this only adds the badge — never relaxes the kernel's admission.
   */
  router.get("/super-skills", async (req, res) => {
    assertBoardOrgAccess(req);
    const entries = await listGlobalRuntimeSkillEntries();
    const withBadge = await Promise.all(
      entries.map(async (entry) => {
        // OFFICIAL is gated on a TAMPER-PROOF digest match: the provenance row stores
        // the store digest recorded at install (server-controlled), and we recompute it
        // LIVE over the current store bytes. They match ONLY if the bytes are exactly
        // what was officially installed — a store-writer who replaces the bytes (even
        // with a forged, writable `.provenance.json`) changes the recompute and loses
        // the badge. (The kernel already dropped the entry unless its declared digest is
        // self-consistent; this binds it to the official install.)
        const prov = await getWorkshopProvenance(db, "skill", entry.runtimeName);
        let official = false;
        if (prov?.official === true && typeof prov.storeDigest === "string") {
          const recomputed = await computeStoredSkillDigest(entry.source);
          official = recomputed === prov.storeDigest;
        }
        return { slug: entry.runtimeName, source: entry.source, official };
      }),
    );
    res.json(withBadge);
  });

  /**
   * DELETE /api/super-skills/:slug — uninstall a skill. Atomic quarantine (un-admit)
   * then clear provenance (see uninstallSuperSkill). 404 if nothing was installed.
   */
  router.delete("/super-skills/:slug", async (req, res) => {
    assertInstanceAdmin(req);
    const { slug } = req.params;
    try {
      const uninstalled = await uninstallSuperSkill(
        {
          quarantineSkillDir,
          removeDir: removeSkillDir,
          clearProvenance: (s) => deleteWorkshopProvenance(db, "skill", s),
        },
        slug,
      );
      if (!uninstalled) {
        res.status(404).json({ error: `no skill installed for slug: ${slug}` });
        return;
      }
      res.json({ uninstalled: slug });
    } catch (err) {
      // An unsafe slug throws from resolveSkillStoreDir → generic 400.
      warn("super skill uninstall failed", err);
      res.status(400).json({ error: "skill cannot be uninstalled" });
    }
  });

  /**
   * GET /api/super-companies — workshop-imported companies, with the OFFICIAL badge from
   * provenance (keyed by companyId). No digest gate is needed: each import yields a FRESH
   * companyId (new_company never reuses an id), so a provenance row can never drift onto
   * different bytes. Companies WITHOUT a workshop provenance row are simply non-official
   * (locally created). Uninstall is the native company-delete UI (not exposed here) — a
   * deleted company drops out of the list, so any orphaned provenance row joins nothing.
   */
  router.get("/super-companies", async (req, res) => {
    assertBoardOrgAccess(req);
    const all = await companies.list();
    const withBadge = await Promise.all(
      all.map(async (company: { id: string; name: string }) => {
        const prov = await getWorkshopProvenance(db, "company", company.id);
        return { companyId: company.id, name: company.name, official: prov?.official === true };
      }),
    );
    res.json(withBadge);
  });

  return router;
}
