import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { importWorkshopCapability } from "../services/workshop-import.js";
import { createSuperPluginInstaller, uninstallSuperPlugin } from "../services/super-plugin-installer.js";
import { createSuperSkillInstaller, uninstallSuperSkill } from "../services/super-skill-installer.js";
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
import {
  materializeInstall,
  readSuperManifestJson,
  removeInstallDir,
  unpackVerifiedScplug,
} from "../services/super-workshop-fs.js";
import {
  getSuperPluginRuntime,
  superPluginRuntimes,
} from "../services/super-plugin-runtime-store.js";
import {
  deleteWorkshopProvenance,
  getWorkshopProvenance,
  recordVerifiedWorkshopProvenance,
  workshopProvenance,
} from "../services/workshop-provenance.js";
import { computeReceiptMac, type WorkshopReceipt } from "../services/workshop-receipt.js";

/**
 * P7 — plugin-kind import chain end-to-end with the REAL fs primitives: a genuine
 * `.scplug` (built here) → `unpackVerifiedScplug` (digest-bound buffer extract) →
 * `createSuperPluginInstaller` (materializes into a real install dir + records the
 * runtime row) → provenance from the verified receipt → on-disk bytes present →
 * `uninstallSuperPlugin` removes the row + dir + provenance. Skill/company chains are
 * still fail-closed (S4/S5), so only the plugin kind is end-to-end here.
 */

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
// 64-hex: the key is now read from a 0600 file whose content must match KEY_RE (64 lowercase hex).
const HMAC = "e2e1d00d".repeat(8);

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };

/** Minimal STORED-method ZIP (UTF-8 names) — same approach as the fs unit test. */
function buildZip(entries: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.content, "utf8");
    const crc = crc32(data);
    const F = 0x0800;
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(F), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(F), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32((0o100644 << 16) >>> 0), u32(offset), name]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, cd, eocd]);
}

function manifest(id: string): string {
  return JSON.stringify({
    schema_version: "1.0.0",
    id,
    name: "E2E Tool",
    version: "1.0.0",
    summary: "End-to-end import fixture.",
    source: { type: "developer_upload", clawhunt_problem_id: null, developer_id: "leon" },
    runtime: { type: "mcp_sidecar", entrypoint: "bin/run", args: ["mcp"], transport: "stdio", mcp_protocol_versions: ["2025-06-18"], platforms: ["darwin-arm64", "linux-x64"] },
    tools: [{ name: "do_x", description: "Do x.", input_schema: { type: "object" }, output_schema: { type: "object" } }],
    permissions: { filesystem: [], network: [], environment: [] },
    acceptance: { level: "L1", tests: ["tests/smoke.sh"], evidence_fixtures: ["evidence-fixtures/smoke.json"], latency_budget_ms: 1000 },
    commerce: { pricing_model: "free", metering: "none" },
    provenance: { build_type: "developer_upload", source_digest: null, package_digest: "sha256:" + "00".repeat(32), signature: "ed25519:fixture" },
  });
}

describeEmbedded("workshop import chain (plugin kind) — real fs E2E", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let work: string;
  let installRoot: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workshop-import-e2e-");
    db = createDb(tempDb.connectionString);
    work = await mkdtemp(path.join(os.tmpdir(), "workshop-import-e2e-"));
    installRoot = path.join(work, "installed");
    process.env.SUPERCLAW_SUPER_PLUGIN_ROOT = installRoot;
    process.env.SUPERCLAW_SKILL_STORE_DIR = path.join(work, "skills");
    // The key is read from a 0600 file (never process.env); write it and hand Node the PATH.
    const keyFile = path.join(work, "workshop_hmac.key");
    await writeFile(keyFile, HMAC);
    await chmod(keyFile, 0o600);
    process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE = keyFile;
  }, 30_000);

  afterEach(async () => {
    await db.delete(superPluginRuntimes);
    await db.delete(workshopProvenance);
  });

  afterAll(async () => {
    delete process.env.SUPERCLAW_SUPER_PLUGIN_ROOT;
    delete process.env.SUPERCLAW_SKILL_STORE_DIR;
    delete process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE;
    await rm(work, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function stageArchive(id: string): Promise<{ staged: string; transport: string }> {
    const bytes = buildZip([
      { name: "superclaw-plugin.json", content: manifest(id) },
      { name: "bin/run", content: "#!/bin/sh\necho mcp\n" },
    ]);
    const staged = path.join(work, `${id}.scplug`);
    await writeFile(staged, bytes);
    const transport = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    return { staged, transport };
  }

  function wireReceipt(id: string, staged: string, transport: string): Record<string, unknown> {
    const receipt: WorkshopReceipt = {
      receipt_version: "1",
      receipt_id: "rcpt_e2e",
      kind: "plugin",
      capability_id: id,
      version: "1.0.0",
      package_digest: "sha256:" + "ab".repeat(32),
      transport_sha256: transport,
      staged_artifact: staged,
      artifact_ref: "superclaw-object://capabilities/plugin/" + id,
      app_env: "staging",
      official: true,
      issued_at: 1000,
      expires_at: 1120,
    };
    return { ...receipt, mac: computeReceiptMac(receipt, HMAC) };
  }

  function deps() {
    return {
      expectedAppEnv: "staging",
      receiptKey: HMAC,
      now: () => 1050,
      verifyAndUnpackArchive: (staged: string, sha: string) => unpackVerifiedScplug(staged, sha),
      installers: {
        plugin: createSuperPluginInstaller({
          db,
          readSuperManifestJson,
          resolveInstallDir: (key: string) => path.join(installRoot, key),
          materializeInstall,
          removeInstallDir,
          installPaperclipJsPlugin: async () => {
            throw new Error("JS not wired");
          },
        }),
        skill: createSuperSkillInstaller({
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
        }),
        company: (async () => {
          throw new Error("company not wired");
        }) as never,
      },
      recordProvenance: (
        receipt: Parameters<typeof recordVerifiedWorkshopProvenance>[1],
        nativeId: string,
        verificationDigest?: string,
      ) => recordVerifiedWorkshopProvenance(db, receipt, nativeId, verificationDigest),
    };
  }

  it("imports a real .scplug: row + provenance + on-disk bytes, then uninstalls clean", async () => {
    const id = "dev.e2e.import";
    const { staged, transport } = await stageArchive(id);

    const outcome = await importWorkshopCapability(deps(), wireReceipt(id, staged, transport));
    expect(outcome).toMatchObject({ kind: "plugin", nativeId: id, official: true });

    // Runtime row recorded + flipped to installed.
    const row = await getSuperPluginRuntime(db, id);
    expect(row?.status).toBe("installed");
    expect(row?.runtimeType).toBe("mcp_sidecar");
    // Provenance bound from the verified receipt (official badge source).
    expect((await getWorkshopProvenance(db, "plugin", id))?.official).toBe(true);
    // The verified bytes actually landed on disk in the install dir.
    const installDir = path.join(installRoot, id);
    expect(JSON.parse(await readFile(path.join(installDir, "superclaw-plugin.json"), "utf8")).id).toBe(id);

    // Uninstall removes the row, the provenance, and the install dir.
    await uninstallSuperPlugin({ db, removeInstallDir }, { pluginKey: id, installDir: row!.installDir });
    expect(await getSuperPluginRuntime(db, id)).toBeNull();
    expect(await getWorkshopProvenance(db, "plugin", id)).toBeNull();
    await expect(stat(installDir)).rejects.toThrow();
  }, 30_000);

  it("fail-closed: a tampered staged archive (digest mismatch) never installs", async () => {
    const id = "dev.e2e.tamper";
    const { staged, transport } = await stageArchive(id);
    const wire = wireReceipt(id, staged, transport);
    // Swap the staged bytes AFTER the receipt was signed — the buffer-bound verify
    // recomputes the digest and must reject.
    await writeFile(staged, buildZip([{ name: "superclaw-plugin.json", content: manifest(id) }, { name: "evil", content: "x" }]));
    await expect(importWorkshopCapability(deps(), wire)).rejects.toThrow(/transport digest/);
    // Zero landing: no runtime row, no provenance, no install dir.
    expect(await getSuperPluginRuntime(db, id)).toBeNull();
    expect(await getWorkshopProvenance(db, "plugin", id)).toBeNull();
    await expect(stat(path.join(installRoot, id))).rejects.toThrow();
  }, 30_000);

  it("imports a real skill .scplug end-to-end: store dir + provenance + kernel visibility, then uninstalls", async () => {
    const slug = "e2e-skill";
    const bytes = buildZip([{ name: "SKILL.md", content: "---\nname: E2E Skill\n---\nuse me\n" }]);
    const staged = path.join(work, `${slug}.scplug`);
    await writeFile(staged, bytes);
    const transport = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    const receipt: WorkshopReceipt = {
      receipt_version: "1",
      receipt_id: "rcpt_skill_e2e",
      kind: "skill",
      capability_id: slug,
      version: "1.0.0",
      package_digest: "sha256:" + "ab".repeat(32),
      transport_sha256: transport,
      staged_artifact: staged,
      artifact_ref: "superclaw-object://capabilities/skill/" + slug,
      app_env: "staging",
      official: true,
      issued_at: 1000,
      expires_at: 1120,
    };
    const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC) };

    const outcome = await importWorkshopCapability(deps(), wire);
    expect(outcome).toMatchObject({ kind: "skill", nativeId: slug, official: true });

    // Lands in the global store with a kernel-admissible .provenance.json.
    const skillDir = resolveSkillStoreDir(slug);
    const prov = JSON.parse(await readFile(path.join(skillDir, ".provenance.json"), "utf8"));
    expect(prov.store_digest).toBe(await computeStoredSkillDigest(skillDir));
    // The kernel's own fail-closed enumerator admits it (→ usable in a run).
    expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toContain(slug);
    // Provenance side-table bound from the verified receipt + the TAMPER-PROOF store
    // digest (verificationDigest plumbed from the installer), not the writable file.
    const dbProv = await getWorkshopProvenance(db, "skill", slug);
    expect(dbProv?.official).toBe(true);
    expect(dbProv?.storeDigest).toBe(await computeStoredSkillDigest(skillDir));

    // Uninstall atomic-quarantines then clears the side-table; the kernel no longer admits it.
    await uninstallSuperSkill(
      { quarantineSkillDir, removeDir: removeSkillDir, clearProvenance: (s) => deleteWorkshopProvenance(db, "skill", s) },
      slug,
    );
    await expect(stat(skillDir)).rejects.toThrow();
    expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).not.toContain(slug);
    expect(await getWorkshopProvenance(db, "skill", slug)).toBeNull();
  }, 30_000);

  it("skill commit succeeds but provenance write fails → installer rollback quarantines (zero residue)", async () => {
    const slug = "e2e-skill-rollback";
    const bytes = buildZip([{ name: "SKILL.md", content: "---\nname: RB\n---\nx\n" }]);
    const staged = path.join(work, `${slug}.scplug`);
    await writeFile(staged, bytes);
    const transport = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    const receipt: WorkshopReceipt = {
      receipt_version: "1",
      receipt_id: "rcpt_rb",
      kind: "skill",
      capability_id: slug,
      version: "1.0.0",
      package_digest: "sha256:" + "ab".repeat(32),
      transport_sha256: transport,
      staged_artifact: staged,
      artifact_ref: "superclaw-object://capabilities/skill/" + slug,
      app_env: "staging",
      official: true,
      issued_at: 1000,
      expires_at: 1120,
    };
    const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC) };

    // Force the provenance write to fail AFTER the skill has committed to the store.
    const failingDeps = { ...deps(), recordProvenance: async () => { throw new Error("db down"); } };
    await expect(importWorkshopCapability(failingDeps, wire)).rejects.toThrow(/db down/);

    // The installer's rollback atomic-quarantined the committed store dir → nothing left
    // in the store, and the kernel no longer admits it.
    await expect(stat(resolveSkillStoreDir(slug))).rejects.toThrow();
    expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).not.toContain(slug);
  }, 30_000);
});
