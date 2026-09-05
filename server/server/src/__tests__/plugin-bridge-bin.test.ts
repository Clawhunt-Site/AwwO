import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPluginBridgeBinCacheForTests,
  resolvePluginBridgeBin,
} from "../services/plugin-bridge-bin.js";

describe("resolvePluginBridgeBin", () => {
  let tmp: string;

  beforeEach(async () => {
    __resetPluginBridgeBinCacheForTests();
    tmp = await mkdtemp(path.join(os.tmpdir(), "plugin-bridge-bin-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns an existing explicit override", async () => {
    const bin = path.join(tmp, "bridge.js");
    await writeFile(bin, "// stub", "utf8");
    expect(await resolvePluginBridgeBin({ SUPERCLAW_PLUGIN_BRIDGE_BIN: bin })).toBe(bin);
  });

  it("fails closed (null) when the override points at a missing file", async () => {
    const missing = path.join(tmp, "nope.js");
    expect(await resolvePluginBridgeBin({ SUPERCLAW_PLUGIN_BRIDGE_BIN: missing })).toBeNull();
  });

  it("ignores a blank override and falls through to package resolution", async () => {
    // package resolution succeeds in the built workspace (mcp-server dist).
    const resolved = await resolvePluginBridgeBin({ SUPERCLAW_PLUGIN_BRIDGE_BIN: "   " });
    expect(resolved).toMatch(/plugin-bridge-stdio\.js$/);
  });

  it("resolves the mcp-server subpath export by default", async () => {
    const resolved = await resolvePluginBridgeBin({});
    expect(resolved).toMatch(/@paperclipai\/mcp-server|mcp-server\/dist\/plugin-bridge-stdio\.js$/);
  });

  it("never throws and prefers the override even after the default is cached", async () => {
    await resolvePluginBridgeBin({}); // primes the cache
    const bin = path.join(tmp, "override.js");
    await writeFile(bin, "// stub", "utf8");
    expect(await resolvePluginBridgeBin({ SUPERCLAW_PLUGIN_BRIDGE_BIN: bin })).toBe(bin);
  });
});
