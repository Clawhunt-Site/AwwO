import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedChatSkillsInto, CHAT_MANAGER_SKILL_KEYS } from "../services/seed-chat-skills.ts";
import { unionGlobalRuntimeSkillEntries } from "../services/global-runtime-skills.ts";

describe("seedChatSkillsInto", () => {
  let dir: string;
  const prevStoreDir = process.env.SUPERCLAW_SKILL_STORE_DIR;
  const prevRevocations = process.env.SUPERCLAW_SKILL_REVOCATION_FILE;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "superclaw-seed-skills-"));
  });
  afterEach(async () => {
    if (prevStoreDir === undefined) delete process.env.SUPERCLAW_SKILL_STORE_DIR;
    else process.env.SUPERCLAW_SKILL_STORE_DIR = prevStoreDir;
    if (prevRevocations === undefined) delete process.env.SUPERCLAW_SKILL_REVOCATION_FILE;
    else process.env.SUPERCLAW_SKILL_REVOCATION_FILE = prevRevocations;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("seeds the skill-creator with SKILL.md + a provenance that omits store_digest", async () => {
    await seedChatSkillsInto(dir);
    const md = await fs.readFile(path.join(dir, "skill-creator", "SKILL.md"), "utf-8");
    expect(md).toContain("name: skill-creator");
    expect(md).toContain("# Skill Creator");
    const prov = JSON.parse(
      await fs.readFile(path.join(dir, "skill-creator", ".provenance.json"), "utf-8"),
    );
    expect(prov.schema_version).toBe("0.1.0");
    // store_digest is deliberately omitted so the runtime recompute (not a declared
    // digest) governs trust — see §9 tamper-compare skip on an empty declared digest.
    expect(prov.store_digest).toBeUndefined();
  });

  it("never overwrites an existing skill folder (user edits survive)", async () => {
    const skillDir = path.join(dir, "skill-creator");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "custom content", "utf-8");
    await seedChatSkillsInto(dir);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8")).toBe("custom content");
  });

  it("is idempotent — a second seed adds nothing and does not throw", async () => {
    await seedChatSkillsInto(dir);
    await seedChatSkillsInto(dir);
    expect((await fs.readdir(dir)).sort()).toEqual([
      "company-manager",
      "plugin-manager",
      "skill-creator",
      "skill-manager",
    ]);
  });

  it("bundles an executable scripts/manage.sh in each scripted manager skill", async () => {
    await seedChatSkillsInto(dir);
    for (const slug of ["company-manager", "skill-manager", "plugin-manager"]) {
      const scriptPath = path.join(dir, slug, "scripts", "manage.sh");
      const body = await fs.readFile(scriptPath, "utf-8");
      expect(body.length, `${slug} manage.sh non-empty`).toBeGreaterThan(0);
      expect(body.startsWith("#!/usr/bin/env bash"), `${slug} shebang`).toBe(true);
      const st = await fs.stat(scriptPath);
      // Executable bit set (the agent runs it via shell).
      expect((st.mode & 0o111) !== 0, `${slug} manage.sh is executable`).toBe(true);
    }
    // The non-scripted skill-creator stays a pure-prose skill (no scripts dir).
    await expect(fs.stat(path.join(dir, "skill-creator", "scripts"))).rejects.toThrow();
  });

  it("re-seeds a missing bundled script when only SKILL.md was hand-removed-then-restored", async () => {
    // A half-written skill (provenance only, no SKILL.md) must re-seed fully —
    // including scripts — on the next pass (crash-safe ordering: SKILL.md is last).
    const cm = path.join(dir, "company-manager");
    await fs.mkdir(cm, { recursive: true });
    await fs.writeFile(path.join(cm, ".provenance.json"), "{}", "utf-8");
    await seedChatSkillsInto(dir);
    // SKILL.md absent before → seeded now, AND its script came with it.
    expect((await fs.readFile(path.join(cm, "SKILL.md"), "utf-8"))).toContain("name: company-manager");
    expect((await fs.readFile(path.join(cm, "scripts", "manage.sh"), "utf-8")).length).toBeGreaterThan(0);
  });

  it("REFRESHES a MANAGED skill (SKILL.md + script) to the current version on an already-seeded install", async () => {
    // A managed manager skill is first-party infra: an old/stale SKILL.md + script must
    // be overwritten so a fix actually reaches an already-seeded install.
    const cm = path.join(dir, "company-manager");
    await fs.mkdir(path.join(cm, "scripts"), { recursive: true });
    await fs.writeFile(path.join(cm, ".provenance.json"), '{"source_digest":null}', "utf-8");
    await fs.writeFile(path.join(cm, "SKILL.md"), "---\nname: company-manager\n---\nSTALE", "utf-8");
    await fs.writeFile(path.join(cm, "scripts", "manage.sh"), "# stale script", "utf-8");

    await seedChatSkillsInto(dir);

    // SKILL.md refreshed to OUR current version (no longer the stale body)...
    const md = await fs.readFile(path.join(cm, "SKILL.md"), "utf-8");
    expect(md).toContain("# Company Manager");
    expect(md).not.toContain("STALE");
    // ...and the script refreshed to the real wrapper (executable).
    const script = await fs.readFile(path.join(cm, "scripts", "manage.sh"), "utf-8");
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).not.toContain("# stale script");
    expect((await fs.stat(path.join(cm, "scripts", "manage.sh"))).mode & 0o111).not.toBe(0);
  });

  it("refuses to refresh a MANAGED skill whose dir is a symlink (no write-through)", async () => {
    const realTarget = path.join(dir, "elsewhere");
    await fs.mkdir(realTarget, { recursive: true });
    await fs.writeFile(path.join(realTarget, "SKILL.md"), "---\nname: company-manager\n---\nVICTIM", "utf-8");
    await fs.symlink(realTarget, path.join(dir, "company-manager"));
    await seedChatSkillsInto(dir);
    // The symlink target must be UNTOUCHED (refresh refused on a symlinked dir).
    expect(await fs.readFile(path.join(realTarget, "SKILL.md"), "utf-8")).toContain("VICTIM");
  });

  it("refuses to refresh a MANAGED skill whose scripts/ SUBDIR is a symlink (no write-through to store-external dir)", async () => {
    // The skill dir is a normal dir, but scripts/ is a symlink to an external writable
    // dir — a naive refresh would write manage.sh THROUGH it, escaping the store.
    const cm = path.join(dir, "company-manager");
    const evilTarget = path.join(dir, "evil-writable");
    await fs.mkdir(cm, { recursive: true });
    await fs.mkdir(evilTarget, { recursive: true });
    await fs.writeFile(path.join(cm, ".provenance.json"), '{"source_digest":null}', "utf-8");
    await fs.writeFile(path.join(cm, "SKILL.md"), "---\nname: company-manager\n---\nstale", "utf-8");
    await fs.symlink(evilTarget, path.join(cm, "scripts"));
    await seedChatSkillsInto(dir);
    // Nothing was written through the symlinked scripts/ into the external dir.
    await expect(fs.readFile(path.join(evilTarget, "manage.sh"))).rejects.toThrow();
  });

  it("refuses a FRESH seed (no SKILL.md yet) when scripts/ is a symlink (no write-through on the fresh path)", async () => {
    // company-manager dir exists with a symlinked scripts/ but NO SKILL.md → the fresh
    // seed path (present=false) must ALSO be guarded, not just the managed-refresh path.
    const cm = path.join(dir, "company-manager");
    const evilTarget = path.join(dir, "evil-writable");
    await fs.mkdir(cm, { recursive: true });
    await fs.mkdir(evilTarget, { recursive: true });
    await fs.symlink(evilTarget, path.join(cm, "scripts"));
    await seedChatSkillsInto(dir);
    await expect(fs.readFile(path.join(evilTarget, "manage.sh"))).rejects.toThrow();
    // SKILL.md was not written through into the external dir either.
    await expect(fs.readFile(path.join(evilTarget, "SKILL.md"))).rejects.toThrow();
  });

  it("CHAT_MANAGER_SKILL_KEYS (heartbeat auto-desire allow-list) matches the seeded manager folders", async () => {
    // Drift guard: the keys the chat run auto-desires must each correspond to a real
    // seeded skill folder, in the `superclaw-global:<slug>` form the union produces.
    await seedChatSkillsInto(dir);
    for (const key of CHAT_MANAGER_SKILL_KEYS) {
      expect(key.startsWith("superclaw-global:")).toBe(true);
      const slug = key.slice("superclaw-global:".length);
      expect(await fs.readFile(path.join(dir, slug, "SKILL.md"), "utf-8")).toContain(`name: ${slug}`);
    }
  });

  it("seeds skill-manager + plugin-manager with the right SKILL.md contracts", async () => {
    await seedChatSkillsInto(dir);
    const sm = await fs.readFile(path.join(dir, "skill-manager", "SKILL.md"), "utf-8");
    expect(sm).toContain("name: skill-manager");
    expect(sm).toContain("SUPERCLAW_SKILL_STORE_DIR");
    // The #1 compliance hazard must be documented: never write a non-null digest.
    expect(sm).toContain("source_digest");
    expect(sm.toLowerCase()).toContain("dropped as tampered");
    expect(sm).toContain("/api/companies/<companyId>/skills");

    const pm = await fs.readFile(path.join(dir, "plugin-manager", "SKILL.md"), "utf-8");
    expect(pm).toContain("name: plugin-manager");
    // Authoring a local plugin is native + UNSIGNED: scaffold writes a REAL, directly
    // installable plugin (`install --local`), and signing is reserved for UPLOADING to the
    // workshop — never to author/install your own. The old "unsigned draft that must be
    // signed before it can install" framing must NOT survive.
    expect(pm.toLowerCase()).toContain("no signature");
    expect(pm).toContain("--local");
    expect(pm.toLowerCase()).toContain("workshop");
    expect(pm).not.toContain("UNSIGNED DRAFT");
    expect(pm).toContain("/api/plugins");
    // No dependency on an external Python CLI — that was removed.
    expect(pm).not.toContain("superclaw plugin init");
    // No "paperclip" branding leaks into the seeded skill.
    expect(pm.toLowerCase()).not.toContain("paperclip");
    // install/remove are gated destructive verbs.
    expect(pm).toContain("--yes");
  });

  it("seeds the company-manager skill (native company API guidance, omits store_digest)", async () => {
    await seedChatSkillsInto(dir);
    const md = await fs.readFile(path.join(dir, "company-manager", "SKILL.md"), "utf-8");
    expect(md).toContain("name: company-manager");
    expect(md).toContain("# Company Manager");
    // It must point at the native company REST API + the runtime base-url env, and
    // must NOT invent a parallel implementation.
    expect(md).toContain("/api/companies");
    // De-branded runtime base-url env (no "paperclip" wording in seeded skills).
    expect(md).toContain("SUPERCLAW_RUNTIME_API_URL");
    expect(md.toLowerCase()).not.toContain("paperclip");
    // Covers every CRUD verb against the real route surface.
    expect(md).toContain("POST $API/api/companies");
    expect(md).toContain("PATCH $API/api/companies/<id>");
    expect(md).toContain("DELETE $API/api/companies/<id>");
    expect(md).toContain("/archive");
    // The list response is a bare ARRAY — must NOT describe a {companies:[...]}
    // wrapper (the route does res.json(result) where result is the array).
    expect(md).toContain("a JSON **array** of companies");
    expect(md).not.toContain("{ companies: [...] }");
    // Fake-success guard: a 2xx does not prove the write took (unknown fields are
    // silently dropped), so the agent must verify the returned JSON.
    expect(md.toLowerCase()).toContain("verify the write");
    // Removal guidance prefers reversible archive over permanent delete.
    expect(md.toLowerCase()).toContain("prefer archive over delete");
    const prov = JSON.parse(
      await fs.readFile(path.join(dir, "company-manager", ".provenance.json"), "utf-8"),
    );
    expect(prov.schema_version).toBe("0.1.0");
    expect(prov.store_digest).toBeUndefined();
  });

  it("seeds EACH built-in independently — an existing skill never blocks a new one", async () => {
    // skill-creator already exists (user-customized); company-manager is absent.
    const creatorDir = path.join(dir, "skill-creator");
    await fs.mkdir(creatorDir, { recursive: true });
    await fs.writeFile(path.join(creatorDir, "SKILL.md"), "custom content", "utf-8");

    await seedChatSkillsInto(dir);

    // The customized one is left untouched...
    expect(await fs.readFile(path.join(creatorDir, "SKILL.md"), "utf-8")).toBe("custom content");
    // ...and the newly-added built-in is STILL seeded (no global "one present → skip all").
    const newMd = await fs.readFile(path.join(dir, "company-manager", "SKILL.md"), "utf-8");
    expect(newMd).toContain("name: company-manager");
  });

  it("the seeded skills are accepted by the §9 global skill union", async () => {
    await seedChatSkillsInto(dir);
    // Point the global store at the seeded dir, with a revocations file that does
    // not exist (→ empty revocations), and assert the union surfaces the skills.
    process.env.SUPERCLAW_SKILL_STORE_DIR = dir;
    process.env.SUPERCLAW_SKILL_REVOCATION_FILE = path.join(dir, "no-revocations.json");
    const entries = await unionGlobalRuntimeSkillEntries([]);
    const names = entries.map((e) => e.runtimeName);
    expect(names).toContain("skill-creator");
    expect(names).toContain("company-manager");
    // The scripts-carrying skills are trusted BY CONSTRUCTION: the union recomputes
    // the digest over SKILL.md + scripts/manage.sh (provenance has source_digest:null),
    // so a bundled script does not break trust.
    expect(names).toContain("skill-manager");
    expect(names).toContain("plugin-manager");
  });

  it("drops a scripts-carrying skill if its provenance declares a WRONG digest (tamper guard)", async () => {
    await seedChatSkillsInto(dir);
    process.env.SUPERCLAW_SKILL_STORE_DIR = dir;
    process.env.SUPERCLAW_SKILL_REVOCATION_FILE = path.join(dir, "no-revocations.json");
    // Inject a non-empty WRONG store_digest into one scripted skill → the union
    // recompute won't match → it must be dropped (this is exactly the §9 hazard
    // skill-manager's "always source_digest:null" rule avoids on every edit).
    const provPath = path.join(dir, "plugin-manager", ".provenance.json");
    const prov = JSON.parse(await fs.readFile(provPath, "utf-8"));
    prov.store_digest = "deadbeef".repeat(8);
    await fs.writeFile(provPath, JSON.stringify(prov, null, 2), "utf-8");
    const names = (await unionGlobalRuntimeSkillEntries([])).map((e) => e.runtimeName);
    expect(names).not.toContain("plugin-manager");
    // The untampered ones still load.
    expect(names).toContain("company-manager");
  });
});
