import { describe, expect, it, vi } from "vitest";

import {
  importWorkshopCapability,
  WorkshopImportError,
  type WorkshopImportDeps,
  type WorkshopInstaller,
} from "../services/workshop-import.js";
import { computeReceiptMac, type WorkshopReceipt } from "../services/workshop-receipt.js";

const KEY = "import-test-key";
const TRANSPORT = "sha256:" + "cd".repeat(32);

function wire(overrides: Partial<WorkshopReceipt> = {}): Record<string, unknown> {
  const receipt: WorkshopReceipt = {
    receipt_version: "1",
    receipt_id: "rcpt_one",
    kind: "plugin",
    capability_id: "acme.tool",
    version: "1.2.3",
    package_digest: "sha256:" + "ab".repeat(32),
    transport_sha256: TRANSPORT,
    staged_artifact: "/staging/plugin/acme.tool/cd.scplug",
    artifact_ref: "superclaw-object://capabilities/plugin/acme.tool",
    app_env: "staging",
    official: true,
    issued_at: 1000,
    expires_at: 1120,
    ...overrides,
  };
  return { ...receipt, mac: computeReceiptMac(receipt, KEY) };
}

// An installer whose own rollback spy is reachable for assertions.
function installer(nativeId = "acme.tool", rollback = vi.fn(async () => {})) {
  const fn: WorkshopInstaller = vi.fn(async () => ({ nativeId, rollback }));
  return Object.assign(fn, { rollback });
}

function makeDeps(overrides: Partial<WorkshopImportDeps> = {}): WorkshopImportDeps {
  return {
    expectedAppEnv: "staging",
    receiptKey: KEY,
    now: () => 1050,
    verifyAndUnpackArchive: vi.fn(async () => ({ dir: "/tmp/unpacked", cleanup: vi.fn(async () => {}) })),
    installers: { plugin: installer(), skill: installer(), company: installer() },
    recordProvenance: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("importWorkshopCapability", () => {
  it("verifies, recomputes the digest, installs, and records provenance", async () => {
    const deps = makeDeps();
    const out = await importWorkshopCapability(deps, wire());
    expect(out).toEqual({
      kind: "plugin",
      nativeId: "acme.tool",
      capabilityId: "acme.tool",
      version: "1.2.3",
      official: true,
    });
    expect(deps.verifyAndUnpackArchive).toHaveBeenCalledWith("/staging/plugin/acme.tool/cd.scplug", TRANSPORT);
    expect(deps.installers.plugin).toHaveBeenCalledTimes(1);
    expect(deps.recordProvenance).toHaveBeenCalledTimes(1);
    expect((deps.installers.plugin as ReturnType<typeof installer>).rollback).not.toHaveBeenCalled();
  });

  it("routes to the installer for each kind", async () => {
    for (const kind of ["plugin", "skill", "company"] as const) {
      const deps = makeDeps();
      const out = await importWorkshopCapability(deps, wire({ kind, official: kind !== "company" }));
      expect(out.kind).toBe(kind);
      expect(deps.installers[kind]).toHaveBeenCalledTimes(1);
    }
  });

  it("passes the verified receipt's official verdict through unchanged", async () => {
    const out = await importWorkshopCapability(makeDeps(), wire({ official: false }));
    expect(out.official).toBe(false);
  });

  it("rejects a transport digest mismatch BEFORE installing (fail-closed)", async () => {
    // The buffer-bound primitive throws on a mismatch, so the installer never runs.
    const deps = makeDeps({
      verifyAndUnpackArchive: vi.fn(async () => {
        throw new Error("staged artifact transport digest does not match the receipt");
      }),
    });
    await expect(importWorkshopCapability(deps, wire())).rejects.toThrow(/transport digest/);
    expect(deps.installers.plugin).not.toHaveBeenCalled();
    expect(deps.recordProvenance).not.toHaveBeenCalled();
  });

  it("rejects an invalid receipt before touching the filesystem", async () => {
    const deps = makeDeps();
    const bad = { ...wire(), version: "9.9.9" }; // mac no longer matches
    await expect(importWorkshopCapability(deps, bad)).rejects.toThrow(/mac verification failed/);
    expect(deps.verifyAndUnpackArchive).not.toHaveBeenCalled();
  });

  it("errors when no installer is registered for the kind", async () => {
    const deps = makeDeps({ installers: { skill: installer(), company: installer() } as never });
    await expect(importWorkshopCapability(deps, wire({ kind: "plugin" }))).rejects.toThrow(/no installer/);
  });

  it("does not record provenance and cleans up when the installer throws", async () => {
    const failing: WorkshopInstaller = vi.fn(async () => {
      throw new Error("install boom");
    });
    const cleanup = vi.fn(async () => {});
    const deps = makeDeps({
      installers: { plugin: failing, skill: installer(), company: installer() },
      verifyAndUnpackArchive: vi.fn(async () => ({ dir: "/tmp/u", cleanup })),
    });
    await expect(importWorkshopCapability(deps, wire())).rejects.toThrow(/install boom/);
    expect(deps.recordProvenance).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rolls back the install (its own handle) when provenance fails", async () => {
    const rollback = vi.fn(async () => {});
    const deps = makeDeps({
      installers: { plugin: installer("acme.tool", rollback), skill: installer(), company: installer() },
      recordProvenance: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(importWorkshopCapability(deps, wire())).rejects.toThrow(/db down/);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("surfaces BOTH errors when provenance AND rollback fail", async () => {
    const provenanceErr = new Error("db down");
    const rollbackErr = new Error("uninstall failed");
    const deps = makeDeps({
      installers: {
        plugin: installer("acme.tool", vi.fn(async () => {
          throw rollbackErr;
        })),
        skill: installer(),
        company: installer(),
      },
      recordProvenance: vi.fn(async () => {
        throw provenanceErr;
      }),
    });
    const caught = await importWorkshopCapability(deps, wire()).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([provenanceErr, rollbackErr]);
    expect((caught as AggregateError).message).toMatch(/unattributed|manual cleanup/);
  });

  it("rolls back (no residue) when the installer returns an empty native id", async () => {
    const rollback = vi.fn(async () => {});
    const deps = makeDeps({
      installers: { plugin: installer("", rollback), skill: installer(), company: installer() },
    });
    await expect(importWorkshopCapability(deps, wire())).rejects.toThrow(/empty native id/);
    expect(rollback).toHaveBeenCalledTimes(1); // undone via the installer's own handle
    expect(deps.recordProvenance).not.toHaveBeenCalled();
  });

  it("surfaces both errors when an empty-id install also fails to roll back", async () => {
    const rollbackErr = new Error("cannot undo");
    const deps = makeDeps({
      installers: {
        plugin: installer("", vi.fn(async () => {
          throw rollbackErr;
        })),
        skill: installer(),
        company: installer(),
      },
    });
    const caught = await importWorkshopCapability(deps, wire()).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[1]).toBe(rollbackErr);
  });

  it("surfaces a failed unpack cleanup via onWarning without masking success", async () => {
    const onWarning = vi.fn();
    const deps = makeDeps({
      onWarning,
      verifyAndUnpackArchive: vi.fn(async () => ({
        dir: "/tmp/leak",
        cleanup: vi.fn(async () => {
          throw new Error("rmdir failed");
        }),
      })),
    });
    const out = await importWorkshopCapability(deps, wire());
    expect(out.nativeId).toBe("acme.tool");
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0][0]).toMatch(/unpack dir/);
  });

  it("does not let a throwing onWarning change the import result", async () => {
    const deps = makeDeps({
      onWarning: vi.fn(() => {
        throw new Error("logger exploded");
      }),
      verifyAndUnpackArchive: vi.fn(async () => ({
        dir: "/tmp/leak",
        cleanup: vi.fn(async () => {
          throw new Error("rmdir failed");
        }),
      })),
    });
    const out = await importWorkshopCapability(deps, wire());
    expect(out.nativeId).toBe("acme.tool"); // success survives a broken warning sink
  });
});
