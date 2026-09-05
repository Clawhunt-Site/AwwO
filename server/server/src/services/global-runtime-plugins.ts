import { homedir } from "node:os";
import path from "node:path";
import { promises as fs, statSync } from "node:fs";
import { loadPluginPackageDir } from "../trust/load-package.js";
import { verifyPluginPackage } from "../trust/verify-package.js";
import { PackageVerificationError, type SignerClass } from "../trust/package-signature.js";

/**
 * Global (cross-company) plugin source — a fail-closed bridge that makes the plugins
 * in SuperClaw's native plugin store (`~/.superclaw/plugins`, the SAME governance root
 * the Python kernel uses) VISIBLE and GOVERNABLE in the Node runtime, mirroring the
 * global skill union (`global-runtime-skills.ts`).
 *
 * Scope (owner decision): this is the VERIFIED-VISIBILITY layer only. It enumerates the
 * store, verifies each package's integrity + signature with the already-ported trust
 * primitives (`loadPluginPackageDir` + `verifyPluginPackage`), and PROJECTS the verified
 * ones as read-only inventory entries. It does NOT install, activate, or execute them —
 * a SuperClaw plugin's execution model (signed `superclaw-plugin.json` + sidecar) differs
 * from Paperclip's (Node-worker `dist/manifest.js`); wiring execution is left to the
 * plugin gateway. So this never touches the vendored plugin runtime.
 *
 * Fail-closed, like the kernel and the skill union:
 *  - a package that lacks a manifest, fails the digest, is not signature-admissible, or
 *    is revoked is DROPPED (never surfaced as if verified);
 *  - `rejectSkillOrigin` is set so a skill-origin package in the plugin store is dropped
 *    (skills are equipped via the Skills surface, never the plugin inventory — the
 *    capability-workshop red line);
 *  - if the store can't be enumerated safely (e.g. a corrupt revocation file), the union
 *    surfaces NO globals rather than unverified ones.
 */

/** Mirrors the kernel `superclaw-plugin.json` manifest name (and trust/load-package). */
const MANIFEST_NAME = "superclaw-plugin.json";
const GLOBAL_PLUGIN_KEY_PREFIX = "superclaw-global:";

/** Refuses the whole global store (the union then surfaces no globals). */
export class GlobalPluginStoreError extends Error {}

function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** `SUPERCLAW_HOME` else `~/.superclaw` — mirrors environment.superclaw_home(). */
function superclawHome(): string {
  const configured = (process.env.SUPERCLAW_HOME ?? "").trim();
  return configured ? expandUser(configured) : path.join(homedir(), ".superclaw");
}

/**
 * `SUPERCLAW_PLUGIN_STATE_ROOT` else `<home>/plugins` — mirrors plugins.py
 * `plugin_state_root()` (resolved at call time so an override set after import is honored).
 * NOT trimmed: the kernel reads `os.environ.get(...)` VERBATIM (only `SUPERCLAW_HOME` is
 * `.strip()`ed), so an empty value falls back (Python `if override:`) but a path with
 * surrounding whitespace resolves the SAME root on both sides — preserving the single
 * governance root. Trimming here would diverge Node from the kernel under the same env.
 */
export function globalPluginStoreDir(): string {
  const override = process.env.SUPERCLAW_PLUGIN_STATE_ROOT ?? "";
  return override ? expandUser(override) : path.join(superclawHome(), "plugins");
}

/** `<store>/revocations.json` — mirrors plugins.py `default_revocation_file()`. */
function globalPluginRevocationFile(): string {
  return path.join(globalPluginStoreDir(), "revocations.json");
}

/**
 * `SUPERCLAW_PLUGIN_CACHE_PATH` else `<plugin_state_root>/cache` — mirrors plugins.py
 * `plugin_cache_root()`. This is where installed packages actually live, as
 * `<cache>/<plugin_id>/<version>/superclaw-plugin.json` (NOT directly under the state
 * root); the revocation file, by contrast, sits at the state root.
 */
export function globalPluginCacheRoot(): string {
  // VERBATIM and NOT `~`-expanded — plugins.py `plugin_cache_root()` does
  // `return Path(configured)` (no `.expanduser()`), UNLIKE `plugin_state_root()` which
  // expands. So a `SUPERCLAW_PLUGIN_CACHE_PATH=~/cache` stays the literal `~/cache` on
  // both sides; expanding it here (as state-root does) would diverge Node from the kernel.
  const override = process.env.SUPERCLAW_PLUGIN_CACHE_PATH ?? "";
  return override ? override : path.join(globalPluginStoreDir(), "cache");
}

/**
 * Read a file as STRICT UTF-8 (invalid bytes THROW), mirroring the kernel's
 * `read_text(encoding="utf-8")` — unlike `fs.readFile(p, "utf-8")`, which substitutes
 * U+FFFD for bad bytes and would let a corrupt revocation file parse as if clean.
 */
async function readFileUtf8Strict(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  // ignoreBOM: true PRESERVES a leading BOM as U+FEFF so a BOM-prefixed file makes the
  // subsequent JSON.parse throw (fail-closed), matching the kernel.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * Load the global plugin revocation data, fail-CLOSED on corruption:
 *  - missing file → null (nothing revoked, the normal first-run state);
 *  - unreadable / non-JSON / not an object / `revoked` present-but-not-an-array → THROW.
 * The parsed object is handed to `verifyPluginPackage`'s `checkRevocation`, which does
 * the per-entry structural validation (and also throws on a malformed entry). A corrupt
 * governance source is never treated as "nothing revoked".
 */
export async function loadGlobalPluginRevocations(
  revocationFile = globalPluginRevocationFile(),
): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFileUtf8Strict(revocationFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new GlobalPluginStoreError(`plugin revocation file is unreadable: ${revocationFile}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new GlobalPluginStoreError(`plugin revocation file is not valid JSON: ${revocationFile}`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new GlobalPluginStoreError(`plugin revocation file is malformed (expected an object): ${revocationFile}`);
  }
  // Mirror the skill union: `revoked` MAY be absent (→ nothing revoked), but a present
  // non-array value is malformed and must fail closed here rather than be coerced.
  if (Object.prototype.hasOwnProperty.call(payload, "revoked") && !Array.isArray((payload as Record<string, unknown>).revoked)) {
    throw new GlobalPluginStoreError(`plugin revocation file 'revoked' must be a list: ${revocationFile}`);
  }
  return payload;
}

/** A verified global plugin projected as a read-only inventory entry (no DB lifecycle). */
export interface GlobalPluginEntry {
  /** Stable, namespaced key — never collides with a DB plugin row id. */
  key: string;
  /** The manifest plugin id (e.g. `acme.formatter`). */
  pluginId: string;
  version: string;
  /** Human label (manifest `name` when present, else the plugin id). */
  name: string;
  /** The recomputed `sha256:` package digest the signature binds to. */
  digest: string;
  /** Trust class that admitted the signature: root / local_dev / none. */
  signerClass: SignerClass;
  /** Absolute on-disk package directory. */
  source: string;
  /** Marks the entry as a global-store projection, distinct from DB-installed plugins. */
  origin: "superclaw-global";
  /** Set by the union: whether this plugin id is ALSO installed in the DB registry. */
  alreadyInstalled?: boolean;
}

/**
 * Names of child entries that ARE directories (real or via a symlink-to-directory), sorted.
 * A `Dirent` for a symlink-to-dir reports isDirectory() === false in Node, but the kernel's
 * `is_dir()` follows the link, so we stat-follow each symlink and include it ONLY when the
 * target is a directory — keeping local-dev plugins linked in via `ln -s` visible (parity)
 * while EXCLUDING a symlink-to-file or a broken/unreadable symlink. Excluding non-dir
 * symlinks here is what stops a stray `<cache>/<id>` symlink-to-file from later throwing
 * ENOTDIR on readdir and taking down the whole inventory. ENOENT on the top readdir → []
 * (the level doesn't exist yet); any other readdir error propagates — the CALLER decides
 * whether that is store-level fail-closed (cache root) or a per-id drop (an id dir).
 */
async function readSubdirNames(dir: string): Promise<string[]> {
  let children: import("node:fs").Dirent[];
  try {
    children = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const names: string[] = [];
  for (const child of children) {
    if (child.isDirectory()) {
      names.push(child.name);
      continue;
    }
    if (child.isSymbolicLink()) {
      // stat (not lstat) follows the link. A broken link / symlink-to-file / unreadable
      // target is NOT a traversable directory → skip it (never escalate into a whole-store
      // failure). Inner symlinks within a package are still rejected by the trust loader.
      try {
        if (statSync(path.join(dir, child.name)).isDirectory()) names.push(child.name);
      } catch {
        // broken or unreadable symlink → not a directory → skip
      }
    }
  }
  return names.sort();
}

/**
 * Enumerate the global plugin CACHE as verified inventory entries, fail-closed. The cache
 * layout mirrors the kernel's `list_cached_plugins`: packages live at
 * `<cache>/<plugin_id>/<version>/superclaw-plugin.json` — two levels under the cache root
 * (`SUPERCLAW_PLUGIN_CACHE_PATH` or `<state_root>/cache`), NOT directly under the state
 * root (the revocation file is the only thing at the state root). Every cached version is
 * listed (no first-version-wins collapse), matching the kernel's two-level manifest glob.
 *
 * Throws (`GlobalPluginStoreError` / an unexpected fs error at the cache/id level) if the
 * store or its revocation file can't be read safely; per (id, version) it silently DROPS
 * any package that lacks a manifest, fails the digest, is not signature-admissible, is
 * revoked, or is a skill-origin package — one bad package never aborts the inventory.
 */
export async function listGlobalRuntimePluginEntries(): Promise<GlobalPluginEntry[]> {
  const cacheRoot = globalPluginCacheRoot();
  const idDirs = await readSubdirNames(cacheRoot); // ENOENT → [] (no cache yet)
  if (idDirs.length === 0) return [];
  // Throws on a corrupt revocation source → caller (union) fails closed.
  const revocationData = await loadGlobalPluginRevocations();
  const entries: GlobalPluginEntry[] = [];
  const seen = new Set<string>(); // dedup an exact <id>@<version> (pathological dup dirs)
  for (const idDir of idDirs) {
    // A fault reading ONE id dir (e.g. EACCES, or it vanished between scans) is a per-id
    // drop, NEVER a whole-inventory failure — only the cache-root read above is store-level
    // fail-closed. (readSubdirNames already excludes a symlink-to-file, so no ENOTDIR here.)
    let versionDirs: string[];
    try {
      versionDirs = await readSubdirNames(path.join(cacheRoot, idDir));
    } catch (err) {
      console.warn(
        `[global-plugins] skipping id dir ${idDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const versionDir of versionDirs) {
      const dir = path.join(cacheRoot, idDir, versionDir);
      // Only an <id>/<version> dir that actually carries a manifest is a package (mirrors
      // the kernel's `*/*/MANIFEST` glob, which never matches a dir without one). Tell
      // "no manifest" (ENOENT → skip, not a package) apart from a real fs fault (EACCES
      // etc. → drop + warn) rather than swallowing every error as "no manifest".
      let hasManifest: boolean;
      try {
        hasManifest = statSync(path.join(dir, MANIFEST_NAME)).isFile();
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        console.warn(
          `[global-plugins] dropping ${idDir}/${versionDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!hasManifest) continue;
      try {
        const pkg = loadPluginPackageDir(dir);
        const result = verifyPluginPackage(pkg, {
          revocationData,
          // Local store: a non-skill package still REQUIRES a verifiable signature; only a
          // skill-origin local package would be sign-free, and those are rejected below.
          provenance: "local",
          // Skills are equipped through the Skills surface, never the plugin inventory.
          rejectSkillOrigin: true,
          manifestName: MANIFEST_NAME,
        });
        const idVersion = `${result.pluginId}@${result.version}`;
        if (seen.has(idVersion)) continue; // first (sorted) wins on an exact duplicate
        seen.add(idVersion);
        const manifestName = pkg.manifest.name;
        entries.push({
          key: `${GLOBAL_PLUGIN_KEY_PREFIX}${idVersion}`,
          pluginId: result.pluginId,
          version: result.version,
          name: typeof manifestName === "string" && manifestName.length > 0 ? manifestName : result.pluginId,
          digest: result.digest,
          signerClass: result.verdict.signerClass,
          source: dir,
          origin: "superclaw-global",
        });
      } catch (err) {
        // Per (id, version) fail-closed: a single bad package NEVER aborts the inventory
        // (store-level integrity — unreadable cache dir / corrupt revocation file — is
        // enforced above). A verification failure (missing/invalid manifest, digest
        // mismatch, unsigned, revoked, skill-origin) is an EXPECTED drop; any other error
        // is dropped too (never surface unverified) but warned so it stays visible.
        if (!(err instanceof PackageVerificationError)) {
          console.warn(
            `[global-plugins] dropping ${idDir}/${versionDir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
    }
  }
  return entries;
}

/**
 * The verified global plugins, each annotated with whether its id is ALSO installed in
 * the DB registry, for the inventory surface. Fail-closed: if the store can't be
 * enumerated safely, returns NO globals (and warns) rather than unverified entries — the
 * DB-installed plugins (the caller's own list) are unaffected.
 */
export async function unionGlobalRuntimePluginEntries(
  installedPluginIds: ReadonlySet<string>,
): Promise<GlobalPluginEntry[]> {
  let globals: GlobalPluginEntry[];
  try {
    globals = await listGlobalRuntimePluginEntries();
  } catch (err) {
    console.warn(
      `[global-plugins] refusing to surface global plugins (store not safely enumerable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  return globals.map((entry) => ({ ...entry, alreadyInstalled: installedPluginIds.has(entry.pluginId) }));
}
