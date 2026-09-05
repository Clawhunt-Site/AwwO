import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePackageDigest } from "../trust/package-digest.ts";
import { loadPluginPackageDir, MANIFEST_NAME } from "../trust/load-package.ts";
import {
  GlobalPluginStoreError,
  globalPluginCacheRoot,
  globalPluginStoreDir,
  listGlobalRuntimePluginEntries,
  loadGlobalPluginRevocations,
  unionGlobalRuntimePluginEntries,
} from "../services/global-runtime-plugins.ts";

// Verified-visibility union over the native global plugin CACHE
// (~/.superclaw/plugins/cache/<id>/<version>, the same layout the Python kernel's
// list_cached_plugins enumerates). Each package is integrity- + signature-verified
// fail-closed via the trust primitives; the tests drive the store through a temp
// SUPERCLAW_PLUGIN_STATE_ROOT and admit generic (non-root) signatures via local-dev
// trust — the crypto/parity itself is covered by verify-package.test.ts, so here we
// exercise the cache enumeration / drop / project / union behavior.
describe("global-runtime-plugins", () => {
  let store: string;
  let cacheRoot: string;
  const SAVED = { ...process.env };

  beforeEach(async () => {
    store = await fs.mkdtemp(path.join(os.tmpdir(), "superclaw-global-plugins-"));
    process.env.SUPERCLAW_PLUGIN_STATE_ROOT = store;
    process.env.SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST = "1"; // admit dev signatures as local_dev
    delete process.env.SUPERCLAW_PLUGIN_CACHE_PATH;
    delete process.env.SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY;
    delete process.env.SUPERCLAW_HOME;
    cacheRoot = globalPluginCacheRoot(); // <store>/cache
  });
  afterEach(async () => {
    process.env = { ...SAVED };
    await fs.rm(store, { recursive: true, force: true });
  });

  /**
   * Write a cached package at `<base>/<id>/<version>/` whose declared digest matches its
   * bytes. The digest canonicalization zeros provenance.package_digest/signature, so we
   * can compute the digest from disk (with a placeholder) and write it back, non-circular.
   */
  async function writePlugin(
    id: string,
    version: string,
    manifestExtra: Record<string, unknown> = {},
    files: Record<string, string> = {},
    base: string = cacheRoot,
  ): Promise<{ dir: string; digest: string }> {
    const dir = path.join(base, id, version);
    await fs.mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content, "utf-8");
    }
    const placeholder = {
      id,
      version,
      ...manifestExtra,
      provenance: { package_digest: "", signature: "dev-signature" },
    };
    await fs.writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify(placeholder), "utf-8");
    const pkg = loadPluginPackageDir(dir);
    const digest = computePackageDigest(pkg.files, pkg.manifest, MANIFEST_NAME);
    const finalManifest = { ...placeholder, provenance: { ...placeholder.provenance, package_digest: digest } };
    await fs.writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify(finalManifest), "utf-8");
    return { dir, digest };
  }

  it("lists a verified cached plugin and projects its identity (id@version keyed)", async () => {
    const { digest } = await writePlugin(
      "acme.formatter",
      "1.2.0",
      { name: "Acme Formatter" },
      { "tool.js": "export const run = () => {};\n" },
    );
    const entries = await listGlobalRuntimePluginEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "superclaw-global:acme.formatter@1.2.0",
      pluginId: "acme.formatter",
      version: "1.2.0",
      name: "Acme Formatter",
      digest,
      signerClass: "local_dev",
      origin: "superclaw-global",
    });
  });

  it("lists EVERY cached version of the same plugin id (no first-version-wins collapse)", async () => {
    await writePlugin("acme.multi", "1.0.0");
    await writePlugin("acme.multi", "2.0.0");
    const versions = (await listGlobalRuntimePluginEntries())
      .filter((e) => e.pluginId === "acme.multi")
      .map((e) => e.version)
      .sort();
    expect(versions).toEqual(["1.0.0", "2.0.0"]);
  });

  it("drops a tampered package (recomputed digest no longer matches the declared one)", async () => {
    const { dir } = await writePlugin("acme.tampered", "1.0.0", {}, { "tool.js": "original\n" });
    await fs.writeFile(path.join(dir, "tool.js"), "tampered bytes\n", "utf-8");
    expect(await listGlobalRuntimePluginEntries()).toHaveLength(0);
  });

  it("drops a skill-origin package (skills are equipped via the Skills surface, not here)", async () => {
    await writePlugin("skill.greeter", "1.0.0", { skill_origin: true });
    expect(await listGlobalRuntimePluginEntries()).toHaveLength(0);
  });

  it("drops a revoked package and keeps the rest", async () => {
    await writePlugin("acme.good", "1.0.0");
    await writePlugin("acme.bad", "1.0.0");
    await fs.writeFile(
      path.join(store, "revocations.json"),
      JSON.stringify({ revoked: [{ plugin_id: "acme.bad" }] }),
      "utf-8",
    );
    const ids = (await listGlobalRuntimePluginEntries()).map((e) => e.pluginId);
    expect(ids).toEqual(["acme.good"]);
  });

  it("one malformed-manifest package does not abort the inventory (good ones survive)", async () => {
    await writePlugin("acme.good", "1.0.0");
    // A <id>/<version> dir with an invalid-JSON manifest: drops just this package.
    const badDir = path.join(cacheRoot, "acme.broken", "1.0.0");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, MANIFEST_NAME), "{ not valid json", "utf-8");
    const ids = (await listGlobalRuntimePluginEntries()).map((e) => e.pluginId);
    expect(ids).toEqual(["acme.good"]);
  });

  it("skips an <id>/<version> dir with no manifest, and a stray non-dir, without erroring", async () => {
    await writePlugin("acme.real", "1.0.0");
    await fs.mkdir(path.join(cacheRoot, "acme.empty", "0.0.1"), { recursive: true }); // no manifest
    await fs.writeFile(path.join(cacheRoot, "stray.txt"), "x", "utf-8"); // not a dir
    const ids = (await listGlobalRuntimePluginEntries()).map((e) => e.pluginId);
    expect(ids).toEqual(["acme.real"]);
  });

  it("follows a symlinked version directory (parity with the kernel's is_dir)", async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "superclaw-plugin-target-"));
    try {
      // Build a verifiable package at <target>/acme.linked/1.0.0, then symlink the version
      // dir into the cache so only the link (not the real dir) is under the cache root.
      const { dir: realDir } = await writePlugin("acme.linked", "1.0.0", {}, {}, target);
      await fs.mkdir(path.join(cacheRoot, "acme.linked"), { recursive: true });
      await fs.symlink(realDir, path.join(cacheRoot, "acme.linked", "1.0.0"), "dir");
      const ids = (await listGlobalRuntimePluginEntries()).map((e) => e.pluginId);
      expect(ids).toContain("acme.linked");
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("skips a cache-root symlink-to-file and a broken symlink (no ENOTDIR crash of the inventory)", async () => {
    await writePlugin("acme.real", "1.0.0");
    const someFile = path.join(store, "afile");
    await fs.writeFile(someFile, "x", "utf-8");
    await fs.symlink(someFile, path.join(cacheRoot, "file-link"), "file"); // symlink-to-file
    await fs.symlink(path.join(store, "nonexistent"), path.join(cacheRoot, "broken-link")); // dangling
    const ids = (await listGlobalRuntimePluginEntries()).map((e) => e.pluginId);
    expect(ids).toEqual(["acme.real"]); // bad links skipped, the real plugin survives
  });

  it("follows a symlinked id directory at the cache root (kernel is_dir parity)", async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "superclaw-plugin-idtarget-"));
    try {
      // Build <target>/acme.idlinked/1.0.0, then symlink the id dir into the cache.
      await writePlugin("acme.idlinked", "1.0.0", {}, {}, target);
      await fs.mkdir(cacheRoot, { recursive: true });
      await fs.symlink(path.join(target, "acme.idlinked"), path.join(cacheRoot, "acme.idlinked"), "dir");
      const ids = (await listGlobalRuntimePluginEntries()).map((e) => e.pluginId);
      expect(ids).toContain("acme.idlinked");
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("returns [] when the cache directory does not exist", async () => {
    process.env.SUPERCLAW_PLUGIN_CACHE_PATH = path.join(store, "does-not-exist");
    expect(await listGlobalRuntimePluginEntries()).toEqual([]);
  });

  it("fail-closed: a corrupt revocation file throws (and the union surfaces no globals)", async () => {
    await writePlugin("acme.good", "1.0.0");
    await fs.writeFile(path.join(store, "revocations.json"), "{ not valid json", "utf-8");
    await expect(listGlobalRuntimePluginEntries()).rejects.toBeInstanceOf(GlobalPluginStoreError);
    expect(await unionGlobalRuntimePluginEntries(new Set())).toEqual([]);
  });

  it("loadGlobalPluginRevocations returns null when absent and the object when present", async () => {
    expect(await loadGlobalPluginRevocations()).toBeNull();
    await fs.writeFile(path.join(store, "revocations.json"), JSON.stringify({ revoked: [] }), "utf-8");
    expect(await loadGlobalPluginRevocations()).toEqual({ revoked: [] });
  });

  it("honors SUPERCLAW_PLUGIN_CACHE_PATH over the default <state_root>/cache", async () => {
    const altCache = path.join(store, "alt-cache");
    process.env.SUPERCLAW_PLUGIN_CACHE_PATH = altCache;
    await writePlugin("acme.alt", "1.0.0", {}, {}, altCache);
    const ids = (await listGlobalRuntimePluginEntries()).map((e) => e.pluginId);
    expect(ids).toEqual(["acme.alt"]);
  });

  it("reads the plugin env overrides VERBATIM (no trim) — kernel single-source parity", () => {
    // The kernel reads os.environ.get(...) as-is for these plugin-specific overrides
    // (only SUPERCLAW_HOME is stripped), so surrounding whitespace must resolve the SAME
    // root on both sides. Trimming would diverge Node from the kernel under one env.
    process.env.SUPERCLAW_PLUGIN_CACHE_PATH = "/var/x/ ";
    expect(globalPluginCacheRoot()).toBe("/var/x/ ");
    delete process.env.SUPERCLAW_PLUGIN_CACHE_PATH;

    process.env.SUPERCLAW_PLUGIN_STATE_ROOT = "/var/state/ ";
    expect(globalPluginStoreDir()).toBe("/var/state/ ");
    expect(globalPluginCacheRoot()).toBe(path.join("/var/state/ ", "cache"));

    // An EMPTY value is falsy → falls back to the default (mirrors Python `if override:`).
    process.env.SUPERCLAW_PLUGIN_STATE_ROOT = "";
    expect(globalPluginStoreDir().endsWith(path.join(".superclaw", "plugins"))).toBe(true);
  });

  it("expands ~ for STATE_ROOT but NOT for CACHE_PATH (kernel expanduser asymmetry)", () => {
    // plugin_state_root() does Path(override).expanduser() → `~` expands.
    delete process.env.SUPERCLAW_PLUGIN_CACHE_PATH;
    process.env.SUPERCLAW_PLUGIN_STATE_ROOT = "~/custom-state";
    expect(globalPluginStoreDir()).toBe(path.join(os.homedir(), "custom-state"));
    // plugin_cache_root() does Path(configured) with NO expanduser → `~` stays literal.
    process.env.SUPERCLAW_PLUGIN_CACHE_PATH = "~/cache";
    expect(globalPluginCacheRoot()).toBe("~/cache");
  });

  it("union annotates each entry with whether the id is already installed in the DB", async () => {
    await writePlugin("acme.installed", "1.0.0");
    await writePlugin("acme.fresh", "1.0.0");
    const entries = await unionGlobalRuntimePluginEntries(new Set(["acme.installed"]));
    const byId = Object.fromEntries(entries.map((e) => [e.pluginId, e.alreadyInstalled]));
    expect(byId).toEqual({ "acme.installed": true, "acme.fresh": false });
  });
});
