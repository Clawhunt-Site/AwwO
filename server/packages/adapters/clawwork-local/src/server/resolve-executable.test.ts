import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveClawworkExecutable,
  resolveAbsoluteCommand,
  CLAWWORK_EXECUTABLE_ENV,
} from "./resolve-executable.js";

const prev = process.env[CLAWWORK_EXECUTABLE_ENV];
const cleanupDirs: string[] = [];
afterEach(() => {
  if (prev === undefined) delete process.env[CLAWWORK_EXECUTABLE_ENV];
  else process.env[CLAWWORK_EXECUTABLE_ENV] = prev;
  for (const d of cleanupDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeExecutable(name: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-exe-"));
  cleanupDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

// NOTE: the vendored dist/cli.js is not built in the test tree, so
// resolveVendoredClawwork() returns null and the resolution falls through past it.
// These tests pin the override / config / default ordering around that.
describe("resolveClawworkExecutable", () => {
  it("an explicit SUPERCLAW_CLAWWORK_EXECUTABLE override wins and is NOT trusted as vendored", () => {
    process.env[CLAWWORK_EXECUTABLE_ENV] = "/opt/custom/clawwork";
    expect(resolveClawworkExecutable({})).toEqual({ executable: "/opt/custom/clawwork", vendored: false });
  });

  it("falls back to an explicit config.command when no override and no vendored build", () => {
    delete process.env[CLAWWORK_EXECUTABLE_ENV];
    expect(resolveClawworkExecutable({ command: "my-clawwork" })).toEqual({
      executable: "my-clawwork",
      vendored: false,
    });
  });

  it('defaults to "clawwork" on PATH (never trusted as vendored) when nothing else resolves', () => {
    delete process.env[CLAWWORK_EXECUTABLE_ENV];
    expect(resolveClawworkExecutable({})).toEqual({ executable: "clawwork", vendored: false });
    // an explicit command equal to the default is treated the same.
    expect(resolveClawworkExecutable({ command: "clawwork" })).toEqual({ executable: "clawwork", vendored: false });
  });
});

describe("resolveAbsoluteCommand", () => {
  it("returns an absolute runnable path as-is", () => {
    const { file } = makeExecutable("clawwork");
    expect(resolveAbsoluteCommand(file, {})).toBe(file);
  });

  it("returns null for an absolute path that is not runnable", () => {
    expect(resolveAbsoluteCommand("/no/such/clawwork-binary-xyz", {})).toBeNull();
  });

  it("resolves a bare name via the SAME env PATH the run would use", () => {
    const { dir, file } = makeExecutable("clawwork");
    expect(resolveAbsoluteCommand("clawwork", { PATH: dir })).toBe(file);
  });

  it("returns null when a bare name is not found on the given PATH", () => {
    const { dir } = makeExecutable("something-else");
    expect(resolveAbsoluteCommand("clawwork", { PATH: dir })).toBeNull();
  });
});
