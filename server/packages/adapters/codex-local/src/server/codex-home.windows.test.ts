import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexHomeHasUsableAuth, ensureWindowsAuthLink, prepareWindowsAuthHome, seedManagedCodexHome, writeApiKeyAuthJson } from "./codex-home.js";

const roots: string[] = [];
async function root(base = os.tmpdir()) {
  const dir = await fs.mkdtemp(path.join(base, "awwo-auth-test-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0).reverse()) await fs.rm(dir, { recursive: true, force: true });
});
describe("Windows shared auth inode", () => {
  it("shares refresh writes, relinks replacements and revokes a removed source", async () => {
    const dir = await root();
    const source = path.join(dir, "auth.json");
    const target = path.join(dir, "agent", "auth.json");
    await fs.writeFile(source, '{"tokens":{"access_token":"synthetic"}}');
    await ensureWindowsAuthLink(target, source);
    expect((await fs.stat(target)).ino).toBe((await fs.stat(source)).ino);
    expect(await codexHomeHasUsableAuth(path.dirname(target))).toBe(true);
    await fs.writeFile(target, '{"token":"rotated"}');
    expect(await fs.readFile(source, "utf8")).toContain("rotated");
    await fs.unlink(source);
    await fs.writeFile(source, '{"token":"replacement"}');
    await ensureWindowsAuthLink(target, source);
    expect((await fs.stat(target)).ino).toBe((await fs.stat(source)).ino);
    await fs.unlink(source);
    await ensureWindowsAuthLink(target, source);
    expect(await codexHomeHasUsableAuth(path.dirname(target))).toBe(false);
  });
  it("API key replacement never overwrites the shared auth inode", async () => {
    const dir = await root();
    const source = path.join(dir, "auth.json");
    const home = path.join(dir, "agent");
    await fs.writeFile(source, '{"token":"subscription"}');
    await ensureWindowsAuthLink(path.join(home, "auth.json"), source);
    await writeApiKeyAuthJson(home, "synthetic-key");
    expect(await fs.readFile(source, "utf8")).toBe('{"token":"subscription"}');
    expect((await fs.stat(path.join(home, "auth.json"))).ino).not.toBe((await fs.stat(source)).ino);
  });
  it("API key seeding does not attempt subscription symlinks", async () => {
    const dir = await root();
    const source = path.join(dir, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "auth.json"), '{"token":"synthetic"}');
    const spy = vi.spyOn(fs, "symlink").mockRejectedValue(Object.assign(new Error("denied"), { code: "EPERM" }));
    await seedManagedCodexHome(path.join(dir, "target"), { CODEX_HOME: source }, async () => {}, { apiKey: "synthetic-key" });
    expect(spy).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === "win32" && path.parse(os.tmpdir()).root !== path.parse(process.cwd()).root)("keeps cross-volume logical homes isolated with junctions", async () => {
    const shared = await root();
    const logicalRoot = await root(process.cwd());
    const source = path.join(shared, "auth.json");
    await fs.writeFile(source, '{"token":"synthetic"}');
    const homes = [path.join(logicalRoot, "agent-a"), path.join(logicalRoot, "agent-b")];
    await Promise.all(homes.map(async home => {
      await prepareWindowsAuthHome(home, source);
      await ensureWindowsAuthLink(path.join(home, "auth.json"), source);
    }));
    await fs.writeFile(path.join(homes[0], "config.toml"), "model = 'test'");
    await fs.writeFile(path.join(homes[0], "session.json"), "{}");
    expect(await fs.readdir(homes[1])).toEqual(["auth.json"]);
    expect((await fs.stat(path.join(homes[1], "auth.json"))).ino).toBe((await fs.stat(source)).ino);
    expect(await fs.realpath(homes[0])).not.toBe(await fs.realpath(homes[1]));
  });
  it.runIf(process.platform === "win32" && path.parse(os.tmpdir()).root !== path.parse(process.cwd()).root)("preserves existing cross-volume home contents", async () => {
    const shared = await root();
    const logical = await root(process.cwd());
    const source = path.join(shared, "auth.json");
    await fs.writeFile(source, '{"token":"synthetic"}');
    await fs.writeFile(path.join(logical, "session.json"), "keep");
    await expect(prepareWindowsAuthHome(logical, source)).rejects.toThrow("preserved");
    expect(await fs.readFile(path.join(logical, "session.json"), "utf8")).toBe("keep");
  });
});
