import { describe, expect, it, vi } from "vitest";

import {
  createSuperCompanyInstaller,
  SuperCompanyInstallError,
  type SuperCompanyInstallerDeps,
} from "../services/super-company-installer.js";
import { unprocessable } from "../errors.js";
import { computeReceiptMac, verifyReceipt, type WorkshopReceipt } from "../services/workshop-receipt.js";
import type { WorkshopInstallContext } from "../services/workshop-import.js";
import type { CompanyPortabilityImportResult } from "@paperclipai/shared";

const KEY = "company-installer-test-key";

function verifiedReceipt(over: Partial<WorkshopReceipt> = {}) {
  const receipt: WorkshopReceipt = {
    receipt_version: "1",
    receipt_id: "rcpt_c",
    kind: "company",
    capability_id: "acme-corp",
    version: "1.0.0",
    package_digest: "sha256:" + "ab".repeat(32),
    transport_sha256: "sha256:" + "cd".repeat(32),
    staged_artifact: "/s/x.scplug",
    artifact_ref: "superclaw-object://capabilities/company/acme-corp",
    app_env: "staging",
    official: true,
    issued_at: 1000,
    expires_at: 1120,
    ...over,
  };
  const wire = { ...receipt, mac: computeReceiptMac(receipt, KEY) };
  return verifyReceipt(wire, { key: KEY, now: 1050, expectedAppEnv: "staging" });
}

const ctx = (receipt = verifiedReceipt()): WorkshopInstallContext => ({ receipt, unpackedDir: "/unpack/co" });

function importResult(over: Partial<CompanyPortabilityImportResult["company"]> = {}): CompanyPortabilityImportResult {
  return {
    company: { id: "company_new_123", name: "Acme", action: "created", ...over },
    agents: [],
    projects: [],
    envInputs: [],
    warnings: [],
  };
}

function deps(over: Partial<SuperCompanyInstallerDeps> = {}): SuperCompanyInstallerDeps {
  return {
    buildInlineFiles: vi.fn(async () => ({ "COMPANY.md": "---\nname: Acme\n---\n" })),
    importBundle: vi.fn(async () => importResult()),
    removeCompany: vi.fn(async () => {}),
    ownerUserId: "local-board",
    ...over,
  };
}

describe("super-company-installer", () => {
  it("imports a bundle as a NEW company (inline, rename, local-board owner) → returns companyId", async () => {
    const d = deps();
    const out = await createSuperCompanyInstaller(d)(ctx());
    expect(out.nativeId).toBe("company_new_123");
    expect(d.importBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ type: "inline" }),
        target: { mode: "new_company" },
        collisionStrategy: "rename",
      }),
      "local-board", // explicit owner, not null
    );
  });

  it("rejects a non-company receipt (kind assertion)", async () => {
    await expect(createSuperCompanyInstaller(deps())(ctx(verifiedReceipt({ kind: "plugin" })))).rejects.toThrow(
      /non-company/,
    );
  });

  it("rejects an empty bundle", async () => {
    const d = deps({ buildInlineFiles: vi.fn(async () => ({})) });
    await expect(createSuperCompanyInstaller(d)(ctx())).rejects.toThrow(/empty/);
  });

  it("classifies a bad-bundle HttpError (4xx) as SuperCompanyInstallError (→ route 400)", async () => {
    const d = deps({
      importBundle: vi.fn(async () => {
        throw unprocessable("Manifest does not include company metadata.");
      }),
    });
    await expect(createSuperCompanyInstaller(d)(ctx())).rejects.toThrow(SuperCompanyInstallError);
  });

  it("PROPAGATES a server-side (non-HttpError) failure AS-IS (→ route 500), not wrapped to 400", async () => {
    const d = deps({
      importBundle: vi.fn(async () => {
        throw new Error("db connection lost");
      }),
    });
    const err = await createSuperCompanyInstaller(d)(ctx()).catch((e) => e);
    expect(err).not.toBeInstanceOf(SuperCompanyInstallError);
    expect((err as Error).message).toMatch(/db connection lost/);
  });

  it("a failed import does NOT global-diff-delete any company (零偏差 with native; no concurrency data loss)", async () => {
    // On a mid-materialize failure the installer must NOT enumerate + delete "new"
    // companies — a concurrently created company (native /api/companies) would be wrongly
    // reaped. It surfaces the error and leaves the (rare) orphan EXACTLY as native does.
    const removeCompany = vi.fn(async () => {});
    const d = deps({
      removeCompany,
      importBundle: vi.fn(async () => {
        throw new Error("materialize failed after create");
      }),
    });
    await expect(createSuperCompanyInstaller(d)(ctx())).rejects.toThrow(/materialize failed/);
    expect(removeCompany).not.toHaveBeenCalled(); // never a global-diff deletion
  });

  it("fail-closed + rolls back when the import did not CREATE a new company", async () => {
    const removeCompany = vi.fn(async () => {});
    const d = deps({
      importBundle: vi.fn(async () => importResult({ id: "company_existing", action: "updated" })),
      removeCompany,
    });
    await expect(createSuperCompanyInstaller(d)(ctx())).rejects.toThrow(/newly created/);
    expect(removeCompany).toHaveBeenCalledWith("company_existing");
  });

  it("installer rollback deletes the created company (cascade)", async () => {
    const removeCompany = vi.fn(async () => {});
    const out = await createSuperCompanyInstaller(deps({ removeCompany }))(ctx());
    await out.rollback();
    expect(removeCompany).toHaveBeenCalledWith("company_new_123");
  });

  it("two concurrent imports each delete ONLY their own company on rollback (no cross-deletion)", async () => {
    // The precise rollback uses the KNOWN companyId — never a global diff — so even fully
    // concurrent imports + rollbacks can never reap each other's company.
    let n = 0;
    const removed: string[] = [];
    const mk = () =>
      createSuperCompanyInstaller(
        deps({
          importBundle: vi.fn(async () => importResult({ id: `company_${n++}` })),
          removeCompany: vi.fn(async (id: string) => {
            removed.push(id);
          }),
        }),
      );
    const [a, b] = await Promise.all([mk()(ctx()), mk()(ctx())]);
    await Promise.all([a.rollback(), b.rollback()]);
    expect(new Set(removed)).toEqual(new Set([a.nativeId, b.nativeId])); // each only its own
  });
});
