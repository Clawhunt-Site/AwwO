import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCompanyInlineFiles, SuperCompanyFsError } from "../services/super-company-fs.js";

describe("super-company-fs buildCompanyInlineFiles (real fs)", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "super-company-fs-test-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("walks the bundle keyed by posix-relative path; TEXT→string, BINARY→base64", async () => {
    await mkdir(path.join(work, "assets"), { recursive: true });
    await writeFile(path.join(work, "COMPANY.md"), "---\nname: Acme\n---\n"); // text
    await writeFile(path.join(work, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0xff, 0x00])); // binary
    const files = await buildCompanyInlineFiles(work);
    expect(Object.keys(files).sort()).toEqual(["COMPANY.md", "assets/logo.png"]);
    // Text file is a plain string (the native readPortableTextFile accepts ONLY string).
    expect(files["COMPANY.md"]).toBe("---\nname: Acme\n---\n");
    // Binary file is a base64 entry.
    const logo = files["assets/logo.png"] as { encoding: string; data: string };
    expect(logo.encoding).toBe("base64");
    expect(Buffer.from(logo.data, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0xff, 0x00]));
  });

  it("refuses a symlink in the bundle", async () => {
    await writeFile(path.join(work, "COMPANY.md"), "x");
    await symlink("/etc/hosts", path.join(work, "link"));
    await expect(buildCompanyInlineFiles(work)).rejects.toThrow(SuperCompanyFsError);
  });
});
