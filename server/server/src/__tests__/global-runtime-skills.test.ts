import { mkdtemp, mkdir, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import {
  computeStoredSkillDigest,
  listGlobalRuntimeSkillEntries,
  loadGlobalSkillRevocations,
  skillRevocationMatches,
  unionGlobalRuntimeSkillEntries,
  GlobalSkillStoreError,
  GlobalSkillStoreFatalError,
} from "../services/global-runtime-skills.js";

// Cross-implementation golden vector: this exact fixture, hashed by the SuperClaw
// Python kernel's `compute_stored_skill_digest`, yields this digest. If the Node
// port ever drifts a byte (length framing, sort order, domain prefix, the
// .provenance.json exclusion), this assertion fails — the two implementations must
// agree exactly or a skill verified by one is rejected by the other.
const GOLDEN_DIGEST = "sha256:82a9e116988bde8f758837d082b512e23f0bad0d7f58bb4284e2b3126f758191";
const GOLDEN_SKILL_MD = "---\nname: golden\ndescription: golden vector skill\n---\nbody text\n";
const GOLDEN_ASSET = "asset-bytes\n";

async function writeSkill(
  root: string,
  slug: string,
  opts: { skillMd?: string; asset?: { rel: string; body: string }; provenance?: unknown } = {},
): Promise<string> {
  const dir = path.join(root, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), opts.skillMd ?? GOLDEN_SKILL_MD);
  if (opts.asset) {
    const assetPath = path.join(dir, opts.asset.rel);
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, opts.asset.body);
  }
  if (opts.provenance !== null) {
    await writeFile(path.join(dir, ".provenance.json"), JSON.stringify(opts.provenance ?? {}));
  }
  return dir;
}

/**
 * Build a skill whose `.provenance.json` store_digest matches its real on-disk
 * bytes. The body is slug-specific by default so distinct skills get DISTINCT
 * digests (a shared body would let a single store_digest revocation hit several).
 */
async function writeVerifiedSkill(
  root: string,
  slug: string,
  skillMd = `---\nname: ${slug}\ndescription: ${slug} skill\n---\nbody for ${slug}\n`,
): Promise<string> {
  const dir = await writeSkill(root, slug, { skillMd, provenance: { store_digest: "sha256:placeholder" } });
  const digest = await computeStoredSkillDigest(dir);
  await writeFile(path.join(dir, ".provenance.json"), JSON.stringify({ store_digest: digest }));
  return dir;
}

describe("global runtime skills — fail-closed trust mirror", () => {
  let store: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    store = await mkdtemp(path.join(tmpdir(), "superclaw-global-skills-"));
    process.env.SUPERCLAW_SKILL_STORE_DIR = store;
    delete process.env.SUPERCLAW_SKILL_REVOCATION_FILE;
  });
  afterEach(async () => {
    process.env = { ...savedEnv };
    await rm(store, { recursive: true, force: true });
  });

  it("computeStoredSkillDigest matches the kernel's compute_stored_skill_digest (golden vector)", async () => {
    const dir = await writeSkill(store, "golden", {
      skillMd: GOLDEN_SKILL_MD,
      asset: { rel: "nested/asset.txt", body: GOLDEN_ASSET },
      provenance: { store_digest: "sha256:should-be-ignored" },
    });
    expect(await computeStoredSkillDigest(dir)).toBe(GOLDEN_DIGEST);
  });

  it("the digest excludes .provenance.json (its bytes never affect the hash)", async () => {
    const dir = await writeSkill(store, "golden", {
      skillMd: GOLDEN_SKILL_MD,
      asset: { rel: "nested/asset.txt", body: GOLDEN_ASSET },
      provenance: { store_digest: "sha256:should-be-ignored", note: "any value here is irrelevant" },
    });
    // Same SKILL.md + asset bytes ⇒ same digest regardless of provenance content.
    expect(await computeStoredSkillDigest(dir)).toBe(GOLDEN_DIGEST);
  });

  it("admits a verified skill as a global entry (namespaced key, slug runtimeName)", async () => {
    await writeVerifiedSkill(store, "alpha-skill");
    const entries = await listGlobalRuntimeSkillEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "superclaw-global:alpha-skill",
      runtimeName: "alpha-skill",
      source: path.join(store, "alpha-skill"),
      sourceStatus: "available",
      versionId: null,
    });
  });

  it("drops a skill whose dir contains a special node (FIFO) — a byte-only digest would skip it (fail-open)", async () => {
    // mkfifo isn't on every platform/sandbox; skip cleanly if it isn't available.
    let fifoOk = true;
    const probe = path.join(store, ".fifo-probe");
    try {
      execFileSync("mkfifo", [probe], { stdio: "ignore" });
      await rm(probe, { force: true });
    } catch {
      fifoOk = false;
    }
    if (!fifoOk) return;

    await writeVerifiedSkill(store, "ok-skill");
    const dir = path.join(store, "with-fifo");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), GOLDEN_SKILL_MD);
    const digest = await computeStoredSkillDigest(dir); // baseline over SKILL.md only
    await writeFile(path.join(dir, ".provenance.json"), JSON.stringify({ store_digest: digest }));
    // Inject a FIFO (a non-regular node) into the otherwise-verified skill dir.
    const fifo = path.join(dir, "evil.fifo");
    execFileSync("mkfifo", [fifo], { stdio: "ignore" });
    expect((await lstat(fifo)).isFile()).toBe(false);
    // The kernel includes the node and `read_bytes()` raises → drop. Skipping it (the
    // old bug) would keep the SKILL.md-only digest matching the provenance → admit a
    // tampered store. We must drop the poison skill; the verified sibling survives.
    expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toEqual(["ok-skill"]);
  });

  it("drops a skill with NO .provenance.json (presence of SKILL.md is not trusted)", async () => {
    await writeSkill(store, "no-prov", { provenance: null });
    expect(await listGlobalRuntimeSkillEntries()).toHaveLength(0);
  });

  it("drops a TAMPERED skill (declared store_digest disagrees with the recomputed bytes)", async () => {
    const dir = await writeVerifiedSkill(store, "tampered");
    // Mutate the bytes AFTER pinning the provenance digest → recomputed != declared.
    await writeFile(path.join(dir, "SKILL.md"), `${GOLDEN_SKILL_MD}\nsneaky injected line\n`);
    expect(await listGlobalRuntimeSkillEntries()).toHaveLength(0);
  });

  it("drops a slug-revoked skill and a store_digest-revoked skill", async () => {
    const goodDir = await writeVerifiedSkill(store, "kept");
    await writeVerifiedSkill(store, "revoked-by-slug");
    const digestDir = await writeVerifiedSkill(store, "revoked-by-digest");
    const digest = await computeStoredSkillDigest(digestDir);
    const revFile = path.join(store, "revocations.json");
    await writeFile(
      revFile,
      JSON.stringify({ revoked: [{ slug: "revoked-by-slug" }, { store_digest: digest }] }),
    );
    const keys = (await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName);
    expect(keys).toEqual(["kept"]);
    expect(goodDir).toContain("kept");
  });

  it("loadGlobalSkillRevocations is fail-closed on a corrupt revocation file", async () => {
    const revFile = path.join(store, "revocations.json");
    await writeFile(revFile, "{ not json");
    await expect(loadGlobalSkillRevocations(revFile)).rejects.toBeInstanceOf(GlobalSkillStoreError);
    // Non-object and bad `revoked` shape also throw.
    await writeFile(revFile, JSON.stringify(["array-not-object"]));
    await expect(loadGlobalSkillRevocations(revFile)).rejects.toBeInstanceOf(GlobalSkillStoreError);
    await writeFile(revFile, JSON.stringify({ revoked: "not-a-list" }));
    await expect(loadGlobalSkillRevocations(revFile)).rejects.toBeInstanceOf(GlobalSkillStoreError);
    // A present-but-null `revoked` is malformed (NOT "nothing revoked") — must throw,
    // else a damaged list would silently let a revoked skill load (fail-open).
    await writeFile(revFile, JSON.stringify({ revoked: null }));
    await expect(loadGlobalSkillRevocations(revFile)).rejects.toBeInstanceOf(GlobalSkillStoreError);
    // An object with NO `revoked` key is the normal "nothing revoked yet" state.
    await writeFile(revFile, JSON.stringify({ schema: 1 }));
    expect(await loadGlobalSkillRevocations(revFile)).toEqual([]);
    // A genuinely absent file is "nothing revoked", not an error.
    await rm(revFile, { force: true });
    expect(await loadGlobalSkillRevocations(revFile)).toEqual([]);
  });

  it("refuses the WHOLE store when a .provenance.json is not a JSON object (crash-all, mirrors AttributeError)", async () => {
    // `[].store_digest` is undefined in JS (no throw) — it would skip the tamper
    // check and admit an UNVERIFIED skill. The kernel instead hits AttributeError
    // on `list.get(...)`, which escapes its per-skill except and aborts the WHOLE
    // enumeration. Mirror that: a non-object provenance refuses every global, never
    // a partial admit of the store's other (even valid) skills.
    await writeVerifiedSkill(store, "ok-skill");
    await writeSkill(store, "list-prov", { provenance: [] });
    await expect(listGlobalRuntimeSkillEntries()).rejects.toBeInstanceOf(GlobalSkillStoreFatalError);
    // The union fails closed: company entries only, zero globals.
    const company = [
      { key: "co:a", runtimeName: "a", source: "/co/a", versionId: null, currentVersionId: null, sourceStatus: "available" as const, missingDetail: null },
    ];
    expect(await unionGlobalRuntimeSkillEntries(company)).toEqual(company);
  });

  it("drops a SKILL.md that is not valid UTF-8 (the kernel reads it as text; byte-only is not enough)", async () => {
    const dir = path.join(store, "bad-utf8");
    await mkdir(dir, { recursive: true });
    // Valid frontmatter then a lone 0xFF byte — byte-intact (the digest will match)
    // but NOT decodable UTF-8. The kernel's `read_text(encoding="utf-8")` raises
    // UnicodeDecodeError (a ValueError) and drops it; our byte-only digest must not
    // admit it.
    await writeFile(
      path.join(dir, "SKILL.md"),
      Buffer.concat([Buffer.from("---\nname: bad\n---\nbody\n"), Buffer.from([0xff])]),
    );
    const digest = await computeStoredSkillDigest(dir);
    await writeFile(path.join(dir, ".provenance.json"), JSON.stringify({ store_digest: digest }));
    expect(await listGlobalRuntimeSkillEntries()).toEqual([]);
  });

  it("drops a skill whose SKILL.md is a directory rather than a regular file", async () => {
    const dir = path.join(store, "dir-skill");
    await mkdir(path.join(dir, "SKILL.md"), { recursive: true }); // SKILL.md is a DIR
    await writeFile(path.join(dir, ".provenance.json"), JSON.stringify({ store_digest: "sha256:whatever" }));
    expect(await listGlobalRuntimeSkillEntries()).toEqual([]);
  });

  it("drops a skill whose .provenance.json is not valid UTF-8 (strict read; valid sibling survives)", async () => {
    const dir = path.join(store, "bad-prov-utf8");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), GOLDEN_SKILL_MD);
    const digest = await computeStoredSkillDigest(dir); // provenance is excluded from the digest
    // A lone 0xFF INSIDE a JSON string value (digest is CORRECT): a non-strict read
    // replaces 0xFF with U+FFFD and JSON.parse succeeds → digest matches → it would
    // be ADMITTED (the old fail-open). The kernel's strict read_text raises
    // (UnicodeDecodeError=ValueError) and drops just this skill.
    await writeFile(
      path.join(dir, ".provenance.json"),
      Buffer.concat([Buffer.from(`{"store_digest":"${digest}","note":"`), Buffer.from([0xff]), Buffer.from('"}')]),
    );
    await writeVerifiedSkill(store, "ok-skill");
    const names = (await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName);
    expect(names).toEqual(["ok-skill"]); // drop-ONE, never the bad-UTF8 skill
  });

  it("drops a skill whose .provenance.json has a UTF-8 BOM (kernel preserves the BOM; JSON.parse then fails)", async () => {
    const dir = path.join(store, "bom-prov");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), GOLDEN_SKILL_MD);
    const digest = await computeStoredSkillDigest(dir);
    // EF BB BF (BOM) + valid JSON with the CORRECT digest. TextDecoder's DEFAULT
    // would strip the BOM and JSON.parse would succeed → admit (fail-open). With the
    // BOM PRESERVED (ignoreBOM:true), JSON.parse throws on U+FEFF just like the
    // kernel's json.loads on read_text — so the skill drops; the sibling survives.
    await writeFile(
      path.join(dir, ".provenance.json"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`{"store_digest":"${digest}"}`)]),
    );
    await writeVerifiedSkill(store, "ok-skill");
    expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toEqual(["ok-skill"]);
  });

  it("a bare NaN/Infinity .provenance.json refuses the WHOLE store (Python json.loads → float → crash-all)", async () => {
    await writeVerifiedSkill(store, "zzz-ok"); // a fully verified sibling
    for (const literal of ["NaN", "Infinity", "-Infinity"]) {
      const poison = path.join(store, "aaa-poison");
      await rm(poison, { recursive: true, force: true });
      await mkdir(poison, { recursive: true });
      await writeFile(path.join(poison, "SKILL.md"), GOLDEN_SKILL_MD);
      // Python json.loads accepts the literal (as a float) → provenance.get raises
      // AttributeError → crash-all; JS JSON.parse throws, so we must treat it as a
      // non-object provenance (Fatal), refusing the valid sibling too — not an
      // ordinary syntax error that would only drop the poison skill.
      await writeFile(path.join(poison, ".provenance.json"), literal);
      await expect(listGlobalRuntimeSkillEntries()).rejects.toBeInstanceOf(GlobalSkillStoreFatalError);
    }
    const company = [
      { key: "co:a", runtimeName: "a", source: "/co/a", versionId: null, currentVersionId: null, sourceStatus: "available" as const, missingDetail: null },
    ];
    expect(await unionGlobalRuntimeSkillEntries(company)).toEqual(company); // zero globals
  });

  it("refuses the store when NaN/Infinity appears INSIDE an array/object .provenance.json (Python parses it)", async () => {
    await writeVerifiedSkill(store, "zzz-ok"); // verified sibling
    for (const body of ["[NaN]", "[Infinity]", '{"x": NaN}']) {
      const poison = path.join(store, "aaa-poison");
      await rm(poison, { recursive: true, force: true });
      await mkdir(poison, { recursive: true });
      await writeFile(path.join(poison, "SKILL.md"), GOLDEN_SKILL_MD);
      await writeFile(path.join(poison, ".provenance.json"), body);
      // JS JSON.parse throws on the embedded constant, but Python's json.loads parses
      // it (→ list/dict with nan) → crash-all or admit. We crash-all (≥ kernel) so a
      // verified sibling is never admitted where the kernel refuses the store.
      await expect(listGlobalRuntimeSkillEntries()).rejects.toBeInstanceOf(GlobalSkillStoreFatalError);
    }
  });

  it("does NOT crash-all on a bareword merely CONTAINING NaN/Infinity (token boundary → ordinary drop-one)", async () => {
    await writeVerifiedSkill(store, "ok-skill");
    for (const body of ["{notNaN}", "NaNxxx", '{"x":InfinityPlus}', '{"x": xInfinity}']) {
      const poison = path.join(store, "aaa-poison");
      await rm(poison, { recursive: true, force: true });
      await mkdir(poison, { recursive: true });
      await writeFile(path.join(poison, "SKILL.md"), GOLDEN_SKILL_MD);
      await writeFile(path.join(poison, ".provenance.json"), body);
      // `notNaN` / `NaNxxx` / `InfinityPlus` are plain syntax errors in BOTH Python
      // and JS (not the bare constant) → drop JUST the poison skill; the verified
      // sibling must survive (no crash-all DoS from a substring match).
      expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toEqual(["ok-skill"]);
    }
  });

  it("drops a skill whose store_digest is an ARRAY (JS String() would falsely match the digest)", async () => {
    const dir = path.join(store, "array-digest");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), GOLDEN_SKILL_MD);
    const digest = await computeStoredSkillDigest(dir);
    // `String(["sha256:..."])` === the digest (single-element array join) → would
    // FALSELY pass the tamper check (fail-open). Python `str([...])` is `"[...]"` and
    // never matches → drop. So a non-string store_digest must be dropped.
    await writeFile(path.join(dir, ".provenance.json"), JSON.stringify({ store_digest: [digest] }));
    await writeVerifiedSkill(store, "ok-skill");
    expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toEqual(["ok-skill"]);
  });

  it("mirrors executable_assets iteration: non-iterable (null/number/bool) → drop; iterable/absent → admit", async () => {
    // The kernel builds its record with `[str(i) for i in get("executable_assets", [])]`.
    // A non-iterable value raises TypeError → drop, EVEN with a matching digest.
    for (const bad of [null, 5, false]) {
      const dir = path.join(store, "bad-ea");
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), GOLDEN_SKILL_MD);
      const digest = await computeStoredSkillDigest(dir);
      await writeFile(
        path.join(dir, ".provenance.json"),
        JSON.stringify({ store_digest: digest, executable_assets: bad }),
      );
      expect(await listGlobalRuntimeSkillEntries()).toEqual([]); // dropped despite a matching digest
    }
    // Iterable (string/array/object) or absent → admitted (no over-rejection).
    for (const okVal of [["a"], "abc", { k: 1 }, undefined] as const) {
      const dir = path.join(store, "ok-ea");
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), GOLDEN_SKILL_MD);
      const digest = await computeStoredSkillDigest(dir);
      const prov: Record<string, unknown> = { store_digest: digest };
      if (okVal !== undefined) prov.executable_assets = okVal;
      await writeFile(path.join(dir, ".provenance.json"), JSON.stringify(prov));
      expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toEqual(["ok-ea"]);
    }
  });

  it("admits a skill whose provenance has the text \"NaN\" INSIDE a string value (not the constant)", async () => {
    const dir = path.join(store, "nan-in-string");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), GOLDEN_SKILL_MD);
    const digest = await computeStoredSkillDigest(dir);
    // Valid JSON: "NaN" is a STRING value, not the bare constant — both Python and JS
    // parse it. The scanner must NOT crash-all on it (no over-rejection).
    await writeFile(path.join(dir, ".provenance.json"), JSON.stringify({ store_digest: digest, note: "NaN here" }));
    expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toEqual(["nan-in-string"]);
  });

  it("a genuine .provenance.json syntax error is drop-ONE, not crash-all (kernel json.loads ValueError)", async () => {
    const dir = path.join(store, "syntax-bad");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), GOLDEN_SKILL_MD);
    await writeFile(path.join(dir, ".provenance.json"), "{ not json"); // both JS & Python reject
    await writeVerifiedSkill(store, "ok-skill");
    // Unlike NaN/Infinity (which Python parses to a float), a real syntax error is a
    // ValueError in Python too → drop just this skill; the sibling survives.
    expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toEqual(["ok-skill"]);
  });

  it("a UTF-8 BOM in revocations.json is fail-closed (preserved BOM ⇒ JSON.parse throws)", async () => {
    await writeVerifiedSkill(store, "global-only");
    const revFile = path.join(store, "revocations.json");
    await writeFile(revFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"revoked":[]}')]));
    // BOM preserved → JSON.parse throws → unreadable governance source → fail-closed,
    // never silently treated as an empty revocation list.
    await expect(loadGlobalSkillRevocations(revFile)).rejects.toBeInstanceOf(GlobalSkillStoreError);
    const company = [
      { key: "co:a", runtimeName: "a", source: "/co/a", versionId: null, currentVersionId: null, sourceStatus: "available" as const, missingDetail: null },
    ];
    expect(await unionGlobalRuntimeSkillEntries(company)).toEqual(company);
  });

  it("a non-UTF-8 revocations.json is fail-closed (strict read; corrupt governance ⇒ no globals)", async () => {
    await writeVerifiedSkill(store, "global-only");
    const revFile = path.join(store, "revocations.json");
    await writeFile(
      revFile,
      Buffer.concat([Buffer.from('{"revoked":[],"note":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    );
    // Strict UTF-8 read fails → throws (never silently "nothing revoked").
    await expect(loadGlobalSkillRevocations(revFile)).rejects.toBeInstanceOf(GlobalSkillStoreError);
    // The union refuses ALL globals against a corrupt governance source; company kept.
    const company = [
      { key: "co:a", runtimeName: "a", source: "/co/a", versionId: null, currentVersionId: null, sourceStatus: "available" as const, missingDetail: null },
    ];
    expect(await unionGlobalRuntimeSkillEntries(company)).toEqual(company);
  });

  it("a malformed (unhashable) revocation slug drops the skill instead of skipping its digest revocation", async () => {
    // Codex's revocation-bypass input: an entry whose slug is unhashable (`[]`) but
    // whose store_digest matches a real skill. Silently skipping the entry (the old
    // bug) would ignore the digest revocation and ADMIT the skill; the kernel raises
    // TypeError on `slug not in {None, slug}` and drops the skill. Node must too.
    const okDir = await writeVerifiedSkill(store, "ok-skill");
    const okDigest = await computeStoredSkillDigest(okDir);
    await writeFile(
      path.join(store, "revocations.json"),
      JSON.stringify({ revoked: [{ slug: [], store_digest: okDigest }] }),
    );
    expect(await listGlobalRuntimeSkillEntries()).toEqual([]);
  });

  it("skillRevocationMatches throws on an unhashable slug but skips a hashable non-string slug", () => {
    // Object/array slug → unhashable in the kernel → TypeError → drop (throw here).
    expect(() => skillRevocationMatches("s", "sha256:x", [{ slug: [], store_digest: "sha256:x" }])).toThrow(
      GlobalSkillStoreError,
    );
    expect(() => skillRevocationMatches("s", "sha256:x", [{ slug: {}, store_digest: "sha256:x" }])).toThrow(
      GlobalSkillStoreError,
    );
    // Number/boolean slug is hashable: the kernel just skips the entry (no match),
    // even when a digest is pinned — so Node skips it too (no throw, no match).
    expect(skillRevocationMatches("s", "sha256:x", [{ slug: 5, store_digest: "sha256:x" }])).toBe(false);
  });

  it("a unioned global skill resolves as a desired skill (an explicit preference injects it)", async () => {
    await writeVerifiedSkill(store, "global-tool");
    const merged = await unionGlobalRuntimeSkillEntries([]); // no company skills
    expect(merged.map((e) => e.runtimeName)).toContain("global-tool");
    // With an explicit desiredSkills naming the global key, the resolver selects it
    // against the UNIONED available pool — proving the union actually makes a global
    // skill injectable (not merely present). With no preference, nothing is desired
    // (the normal default, identical for company and global skills).
    const desired = resolvePaperclipDesiredSkillNames(
      { paperclipSkillSync: { desiredSkills: ["superclaw-global:global-tool"] } },
      merged,
    );
    expect(desired).toContain("superclaw-global:global-tool");
    expect(resolvePaperclipDesiredSkillNames({}, merged)).toEqual([]);
  });

  it("skillRevocationMatches: slug-only revokes all; store_digest matches exact; source_digest never matches on read", () => {
    expect(skillRevocationMatches("s", "sha256:x", [{ slug: "s" }])).toBe(true);
    expect(skillRevocationMatches("s", "sha256:x", [{ slug: "other" }])).toBe(false);
    expect(skillRevocationMatches("s", "sha256:x", [{ store_digest: "sha256:x" }])).toBe(true);
    expect(skillRevocationMatches("s", "sha256:x", [{ store_digest: "sha256:y" }])).toBe(false);
    // A forged provenance source_digest can never satisfy a revocation on the read path.
    expect(skillRevocationMatches("s", "sha256:x", [{ source_digest: "sha256:x" }])).toBe(false);
  });

  it("union: company entries win on a runtimeName collision; globals are appended", async () => {
    await writeVerifiedSkill(store, "shared");
    await writeVerifiedSkill(store, "global-only");
    const company = [
      { key: "co:shared", runtimeName: "shared", source: "/co/shared", versionId: null, currentVersionId: null, sourceStatus: "available" as const, missingDetail: null },
    ];
    const merged = await unionGlobalRuntimeSkillEntries(company);
    const byName = new Map(merged.map((e) => [e.runtimeName, e]));
    // The company's "shared" is kept (its source), the global "shared" is dropped.
    expect(byName.get("shared")?.source).toBe("/co/shared");
    // The non-colliding global is appended.
    expect(byName.get("global-only")?.key).toBe("superclaw-global:global-only");
    expect(merged).toHaveLength(2);
  });

  it("union is fail-closed: a corrupt revocation file injects NO globals (company run still proceeds)", async () => {
    await writeVerifiedSkill(store, "global-only");
    await writeFile(path.join(store, "revocations.json"), "{ corrupt");
    const company = [
      { key: "co:a", runtimeName: "a", source: "/co/a", versionId: null, currentVersionId: null, sourceStatus: "available" as const, missingDetail: null },
    ];
    const merged = await unionGlobalRuntimeSkillEntries(company);
    // Globals refused (can't verify against a broken governance source), company kept.
    expect(merged).toEqual(company);
  });
});
