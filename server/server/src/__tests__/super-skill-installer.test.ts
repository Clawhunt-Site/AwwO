import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSuperSkillInstaller,
  SuperSkillInstallError,
  uninstallSuperSkill,
  type SuperSkillInstallerDeps,
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
import { verifyReceipt, computeReceiptMac, type WorkshopReceipt } from "../services/workshop-receipt.js";
import type { WorkshopInstallContext } from "../services/workshop-import.js";

const KEY = "skill-installer-test-key";

function verifiedReceipt(over: Partial<WorkshopReceipt> = {}) {
  const receipt: WorkshopReceipt = {
    receipt_version: "1",
    receipt_id: "rcpt_s",
    kind: "skill",
    capability_id: "demo-skill",
    version: "1.0.0",
    package_digest: "sha256:" + "ab".repeat(32),
    transport_sha256: "sha256:" + "cd".repeat(32),
    staged_artifact: "/s/x.scplug",
    artifact_ref: "superclaw-object://capabilities/skill/demo-skill",
    app_env: "staging",
    official: true,
    issued_at: 1000,
    expires_at: 1120,
    ...over,
  };
  const wire = { ...receipt, mac: computeReceiptMac(receipt, KEY) };
  return verifyReceipt(wire, { key: KEY, now: 1050, expectedAppEnv: "staging" });
}

function ctx(unpackedDir: string, receipt = verifiedReceipt()): WorkshopInstallContext {
  return { receipt, unpackedDir };
}

describe("super-skill-installer (real fs)", () => {
  let work: string;
  let storeDir: string;
  let unpacked: string;
  let savedStoreEnv: string | undefined;

  beforeEach(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "super-skill-test-"));
    storeDir = path.join(work, "skills");
    savedStoreEnv = process.env.SUPERCLAW_SKILL_STORE_DIR;
    process.env.SUPERCLAW_SKILL_STORE_DIR = storeDir; // real super-skill-fs lands here
    unpacked = path.join(work, "unpacked");
    await mkdir(unpacked, { recursive: true });
    await writeFile(path.join(unpacked, "SKILL.md"), "---\nname: Demo\n---\nbody\n");
  });
  afterEach(async () => {
    process.env.SUPERCLAW_SKILL_STORE_DIR = savedStoreEnv;
    await rm(work, { recursive: true, force: true });
  });

  function deps(over: Partial<SuperSkillInstallerDeps> = {}): SuperSkillInstallerDeps {
    return {
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
      now: () => new Date("2026-06-29T00:00:00.000Z"),
      ...over,
    };
  }

  it("lands a skill (atomic) and the kernel enumerator admits it with a matching digest", async () => {
    const out = await createSuperSkillInstaller(deps())(ctx(unpacked));
    expect(out.nativeId).toBe("demo-skill");
    const landed = path.join(storeDir, "demo-skill");
    const prov = JSON.parse(await readFile(path.join(landed, ".provenance.json"), "utf8"));
    expect(prov.store_digest).toBe(await computeStoredSkillDigest(landed)); // kernel admission invariant
    expect(prov.executable).toBe(false);
    // The kernel's own fail-closed enumerator sees it (→ usable in a run).
    const entries = await listGlobalRuntimeSkillEntries();
    expect(entries.map((e) => e.runtimeName)).toContain("demo-skill");
  });

  it("never leaves a packaged .provenance.json in the committed skill (scrub + atomic stage)", async () => {
    await writeFile(path.join(unpacked, ".provenance.json"), '{"store_digest":"sha256:forged","executable":false}');
    await createSuperSkillInstaller(deps())(ctx(unpacked));
    const prov = JSON.parse(await readFile(path.join(storeDir, "demo-skill", ".provenance.json"), "utf8"));
    expect(prov.store_digest).not.toBe("sha256:forged"); // our digest, not the packaged forgery
    expect(prov.store_digest).toBe(await computeStoredSkillDigest(path.join(storeDir, "demo-skill")));
  });

  it("REFUSES a skill carrying a real executable-bit asset, committing nothing", async () => {
    const script = path.join(unpacked, "run.sh");
    await writeFile(script, "#!/bin/sh\necho hi\n");
    await chmod(script, 0o755); // a real exec bit
    await expect(createSuperSkillInstaller(deps())(ctx(unpacked))).rejects.toThrow(/executable asset/);
    await expect(stat(path.join(storeDir, "demo-skill"))).rejects.toThrow(); // nothing committed
    expect(await listGlobalRuntimeSkillEntries()).toHaveLength(0);
  });

  it("RED LINE (reverse): refuses a plugin package (carries superclaw-plugin.json) as a skill", async () => {
    await writeFile(path.join(unpacked, "superclaw-plugin.json"), "{}");
    await expect(createSuperSkillInstaller(deps())(ctx(unpacked))).rejects.toThrow(/plugin package as a skill/);
    await expect(stat(path.join(storeDir, "demo-skill"))).rejects.toThrow();
  });

  it("rejects a non-skill receipt and an unsafe slug", async () => {
    await expect(createSuperSkillInstaller(deps())(ctx(unpacked, verifiedReceipt({ kind: "plugin" })))).rejects.toThrow(
      /non-skill/,
    );
    for (const bad of ["../evil", "a/b", ".hidden", ".."]) {
      await expect(
        createSuperSkillInstaller(deps())(ctx(unpacked, verifiedReceipt({ capability_id: bad }))),
      ).rejects.toThrow(SuperSkillInstallError);
    }
  });

  it("rejects a package with no SKILL.md", async () => {
    const noMd = path.join(work, "nomd");
    await mkdir(noMd, { recursive: true });
    await writeFile(path.join(noMd, "readme.txt"), "x");
    await expect(createSuperSkillInstaller(deps())(ctx(noMd))).rejects.toThrow(/no SKILL\.md/);
  });

  it("fail-closed on a concurrent same-slug import (atomic rename claim)", async () => {
    const installer = createSuperSkillInstaller(deps());
    const results = await Promise.allSettled([installer(ctx(unpacked)), installer(ctx(unpacked))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/already installed/);
    expect(await listGlobalRuntimeSkillEntries()).toHaveLength(1);
  });

  it("surfaces BOTH errors via AggregateError when staging cleanup also fails", async () => {
    const installer = createSuperSkillInstaller(
      deps({
        hasExecutableAsset: async () => true, // primary failure
        removeDir: async () => {
          throw new Error("rm boom"); // cleanup failure
        },
      }),
    );
    await expect(installer(ctx(unpacked))).rejects.toThrow(AggregateError);
  });

  it("installer rollback removes the committed skill dir", async () => {
    const out = await createSuperSkillInstaller(deps())(ctx(unpacked));
    expect((await stat(path.join(storeDir, "demo-skill"))).isDirectory()).toBe(true);
    await out.rollback();
    await expect(stat(path.join(storeDir, "demo-skill"))).rejects.toThrow();
  });

  it("uninstall atomic-quarantines (instant un-admit) then clears provenance + deletes quarantine", async () => {
    await createSuperSkillInstaller(deps())(ctx(unpacked));
    const order: string[] = [];
    const clearProvenance = vi.fn(async () => {
      order.push("prov");
    });
    const removeDir = vi.fn(async (dir: string) => {
      order.push("rm");
      await rm(dir, { recursive: true, force: true });
    });
    const ok = await uninstallSuperSkill(
      {
        quarantineSkillDir: async (slug) => {
          order.push("quarantine");
          return quarantineSkillDir(slug);
        },
        removeDir,
        clearProvenance,
      },
      "demo-skill",
    );
    expect(ok).toBe(true);
    expect(order).toEqual(["quarantine", "prov", "rm"]); // un-admit FIRST, then provenance, then rm
    expect(await listGlobalRuntimeSkillEntries()).toHaveLength(0);
  });

  it("uninstall returns false for a not-installed slug but still sweeps provenance (idempotent)", async () => {
    const clearProvenance = vi.fn(async () => {});
    const ok = await uninstallSuperSkill(
      { quarantineSkillDir, removeDir: removeSkillDir, clearProvenance },
      "never-installed",
    );
    expect(ok).toBe(false);
    expect(clearProvenance).toHaveBeenCalledWith("never-installed");
  });
});
