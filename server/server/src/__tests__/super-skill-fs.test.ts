import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commitSkill,
  createSkillStageDir,
  hasExecutableAsset,
  quarantineSkillDir,
  resolveSkillStoreDir,
} from "../services/super-skill-fs.js";
import { SuperSkillInstallError } from "../services/super-skill-installer.js";

describe("super-skill-fs (real fs edge cases)", () => {
  let work: string;
  let storeDir: string;
  let saved: string | undefined;

  beforeEach(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "super-skill-fs-test-"));
    storeDir = path.join(work, "skills");
    saved = process.env.SUPERCLAW_SKILL_STORE_DIR;
    process.env.SUPERCLAW_SKILL_STORE_DIR = storeDir;
  });
  afterEach(async () => {
    process.env.SUPERCLAW_SKILL_STORE_DIR = saved;
    await rm(work, { recursive: true, force: true });
  });

  describe("hasExecutableAsset", () => {
    it("is false for a plain tree", async () => {
      const dir = path.join(work, "plain");
      await mkdir(path.join(dir, "sub"), { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), "x");
      await writeFile(path.join(dir, "sub", "note.txt"), "y");
      expect(await hasExecutableAsset(dir)).toBe(false);
    });
    it("detects a NESTED exec-bit asset", async () => {
      const dir = path.join(work, "nested");
      await mkdir(path.join(dir, "deep", "deeper"), { recursive: true });
      const script = path.join(dir, "deep", "deeper", "run.sh");
      await writeFile(script, "#!/bin/sh\n");
      await chmod(script, 0o755);
      expect(await hasExecutableAsset(dir)).toBe(true);
    });
    it("detects a FILE symlink (refused as exec-suspect)", async () => {
      const dir = path.join(work, "filelink");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "SKILL.md"), "x");
      await symlink("/bin/sh", path.join(dir, "link"));
      expect(await hasExecutableAsset(dir)).toBe(true);
    });
    it("detects a DIR symlink", async () => {
      const dir = path.join(work, "dirlink");
      await mkdir(path.join(dir, "real"), { recursive: true });
      await symlink(path.join(dir, "real"), path.join(dir, "linkdir"));
      expect(await hasExecutableAsset(dir)).toBe(true);
    });
  });

  describe("commitSkill — fail-closed on an occupied target", () => {
    async function stagedSkill(): Promise<string> {
      const stage = await createSkillStageDir();
      await writeFile(path.join(stage, "SKILL.md"), "x");
      return stage;
    }

    it("commits onto a free target", async () => {
      const finalDir = resolveSkillStoreDir("fresh");
      await commitSkill(await stagedSkill(), finalDir);
      expect((await stat(path.join(finalDir, "SKILL.md"))).isFile()).toBe(true);
    });

    it("fails closed on a pre-existing EMPTY dir (never silently replaced)", async () => {
      const finalDir = resolveSkillStoreDir("occupied-empty");
      await mkdir(finalDir, { recursive: true });
      await expect(commitSkill(await stagedSkill(), finalDir)).rejects.toThrow(/already installed/);
    });

    it("fails closed on a pre-existing FILE", async () => {
      const finalDir = resolveSkillStoreDir("occupied-file");
      await mkdir(path.dirname(finalDir), { recursive: true });
      await writeFile(finalDir, "not a dir");
      await expect(commitSkill(await stagedSkill(), finalDir)).rejects.toThrow(/already installed/);
    });

    it("fails closed on a pre-existing SYMLINK (lstat, not followed)", async () => {
      const finalDir = resolveSkillStoreDir("occupied-link");
      await mkdir(path.dirname(finalDir), { recursive: true });
      await symlink(work, finalDir);
      await expect(commitSkill(await stagedSkill(), finalDir)).rejects.toThrow(/already installed/);
      // The symlink target (work) must be untouched — never followed/overwritten.
      expect((await stat(work)).isDirectory()).toBe(true);
    });
  });

  describe("quarantineSkillDir", () => {
    it("renames an installed skill out of the store and returns the quarantine path", async () => {
      const finalDir = resolveSkillStoreDir("q1");
      const stage = await createSkillStageDir();
      await writeFile(path.join(stage, "SKILL.md"), "x");
      await commitSkill(stage, finalDir);
      const q = await quarantineSkillDir("q1");
      expect(q).not.toBeNull();
      await expect(stat(finalDir)).rejects.toThrow(); // gone from the store
      expect((await stat(q!)).isDirectory()).toBe(true); // present in quarantine
    });
    it("returns null for a not-installed slug (ENOENT)", async () => {
      expect(await quarantineSkillDir("nope")).toBeNull();
    });
  });
});
