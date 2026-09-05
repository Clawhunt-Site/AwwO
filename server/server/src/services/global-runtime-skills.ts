import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

/**
 * Global (cross-company) skill source — a fail-closed bridge from SuperClaw's
 * native skill store (`~/.superclaw/skills`, the SAME store the Python kernel
 * imports into) onto Paperclip's runtime skill-injection contract.
 *
 * Skills are a CAPABILITY GRANT into an agent run, so this mirrors the kernel's
 * fail-closed trust VERBATIM (superclaw/skill_store.py `list_skills`):
 *  - a stored skill MUST carry both `SKILL.md` AND `.provenance.json`;
 *  - the on-disk bytes are re-hashed with `computeStoredSkillDigest` (the exact
 *    `compute_stored_skill_digest` byte layout) and the tamper/revocation decision
 *    rides ONLY that recomputed digest, never the writable `.provenance.json`
 *    value (a store-writer could forge that);
 *  - a recomputed digest that disagrees with a declared one is a tamper indicator
 *    → dropped;
 *  - a revoked slug/digest (`revocations.json`) → dropped; a CORRUPT revocation
 *    file throws (never silently admits).
 *
 * The union into a run (`unionGlobalRuntimeSkillEntries`) is fail-closed too: if
 * the global store can't be enumerated safely it injects NO globals rather than
 * unverified ones — the company's own (separately governed) skills still run.
 */

/** Domain prefix — byte-identical to skill_store.py `compute_stored_skill_digest`. */
const STORE_DIGEST_DOMAIN = Buffer.from("superclaw-native-skill-store-v1\0", "utf-8");
const PROVENANCE_NAME = ".provenance.json";
const GLOBAL_SKILL_KEY_PREFIX = "superclaw-global:";

/**
 * Drop-ONE corruption: refuses just the offending skill, like the kernel's
 * per-skill `except (OSError, ValueError, TypeError)` (a symlink in a skill is
 * `SkillStoreError(ValueError)`; a malformed revocation slug is a `TypeError`).
 */
export class GlobalSkillStoreError extends Error {}

/**
 * Crash-ALL corruption: refuses the WHOLE global store (the union then injects no
 * globals). Mirrors a kernel error that escapes its per-skill except — a non-object
 * `.provenance.json` makes `provenance.get(...)` raise `AttributeError`, which is
 * NOT caught per-skill and aborts the entire enumeration.
 */
export class GlobalSkillStoreFatalError extends GlobalSkillStoreError {}

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
 * `SUPERCLAW_SKILL_STORE_DIR` else `<home>/skills` — mirrors default_skill_store().
 * NOT trimmed: the kernel uses the env value verbatim (only `SUPERCLAW_HOME` is
 * `.strip()`ed), so an all-whitespace value resolves the same store on both sides.
 */
export function globalSkillStoreDir(): string {
  const override = process.env.SUPERCLAW_SKILL_STORE_DIR ?? "";
  return override ? expandUser(override) : path.join(superclawHome(), "skills");
}

/** `SUPERCLAW_SKILL_REVOCATION_FILE` else `<store>/revocations.json` (also un-trimmed). */
function globalSkillRevocationFile(): string {
  const override = process.env.SUPERCLAW_SKILL_REVOCATION_FILE ?? "";
  return override ? expandUser(override) : path.join(globalSkillStoreDir(), "revocations.json");
}

/**
 * Read a file as STRICT UTF-8. Invalid bytes THROW (a TypeError from the fatal
 * decoder), mirroring Python's `Path.read_text(encoding="utf-8")` — unlike Node's
 * `fs.readFile(p, "utf-8")`, which silently substitutes U+FFFD for bad bytes and
 * would let a corrupt `.provenance.json` / `revocations.json` parse as if clean.
 * Propagates the underlying fs error (e.g. ENOENT) so callers can distinguish
 * "missing" from "unreadable".
 */
async function readFileUtf8Strict(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  // `ignoreBOM: true` PRESERVES a leading BOM as U+FEFF (the option name is
  // inverted: false would strip it). Python's `read_text(encoding="utf-8")` keeps
  // the BOM too, so a BOM-prefixed `.provenance.json` / `revocations.json` makes
  // the subsequent `JSON.parse` throw on both sides (drop / fail-closed). Stripping
  // it — TextDecoder's default — would let a BOM'd file parse clean and admit an
  // entry the kernel refuses (fail-open).
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * True if the text contains a bare `NaN` / `Infinity` / `-Infinity` token OUTSIDE
 * any JSON string. Python's `json.loads` accepts these as float VALUES anywhere
 * (its `parse_constant` extension); JS `JSON.parse` rejects them. So when our
 * `JSON.parse` of `.provenance.json` throws, this distinguishes "the kernel would
 * actually have parsed this (to a list/dict/float with nan/inf)" from a genuine
 * syntax error. The walker tracks string state (honoring `\` escapes) so a literal
 * `"NaN"` INSIDE a string value is NOT mistaken for the constant.
 */
function containsBareJsonConstant(text: string): boolean {
  // A constant must stand as its own TOKEN — not be a slice of a larger bareword
  // (e.g. `notNaN`, `NaNxxx`, `InfinityPlus`), which are ordinary syntax errors in
  // BOTH Python and JS (→ per-skill drop), not Python-accepted constants. So the
  // chars adjacent to the match must not be identifier characters.
  const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++; // skip the escaped character
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    for (const tok of ["NaN", "Infinity", "-Infinity"]) {
      if (text.startsWith(tok, i)) {
        const before = i > 0 ? text[i - 1] : undefined;
        const after = text[i + tok.length];
        if (!isWordChar(before) && !isWordChar(after)) return true;
      }
    }
  }
  return false;
}

type WalkedFile = { relPosix: string; absPath: string };

/**
 * Collect every regular file under `skillRoot` (recursively), excluding any file
 * named `.provenance.json` and rejecting symlinks — the exact set
 * `compute_stored_skill_digest` hashes. Returned unsorted; the caller sorts.
 */
async function collectStoredFiles(skillRoot: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      // Exclude `.provenance.json` by NAME first — the kernel does the name check
      // before any type inspection, so a provenance node of any kind is ignored.
      if (entry.name === PROVENANCE_NAME) continue;
      // lstat (not the dirent type) is authoritative for symlink detection.
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink()) {
        // Stricter than the kernel (which skips symlinked dirs) — any symlink in a
        // stored skill is refused, so a link can never smuggle bytes past the hash.
        throw new GlobalSkillStoreError(
          `stored skill may not contain symlinks: ${path.relative(skillRoot, abs)}`,
        );
      }
      if (stat.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!stat.isFile()) {
        // A non-regular node (Unix socket / FIFO / device): the kernel includes it
        // in the digest set and `read_bytes()` raises (OSError) → the whole digest
        // fails → the skill is dropped. SKIPPING it would let a tampered store (a
        // special node injected into a verified skill) keep its old digest and be
        // admitted (fail-open). Refuse it so the per-skill guard drops the skill.
        throw new GlobalSkillStoreError(
          `stored skill contains a non-regular file: ${path.relative(skillRoot, abs)}`,
        );
      }
      const relPosix = path.relative(skillRoot, abs).split(path.sep).join("/");
      out.push({ relPosix, absPath: abs });
    }
  }
  await walk(skillRoot);
  return out;
}

function u64be(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/**
 * Byte-identical port of skill_store.py `compute_stored_skill_digest`:
 * sha256( domain || for each file sorted by relative posix path:
 *   u64be(len(name)) || name(utf8) || u64be(len(payload)) || payload )
 * with `.provenance.json` and directories excluded and symlinks refused.
 */
export async function computeStoredSkillDigest(skillRoot: string): Promise<string> {
  const files = await collectStoredFiles(skillRoot);
  files.sort((a, b) => (a.relPosix < b.relPosix ? -1 : a.relPosix > b.relPosix ? 1 : 0));
  const hash = createHash("sha256");
  hash.update(STORE_DIGEST_DOMAIN);
  for (const file of files) {
    const name = Buffer.from(file.relPosix, "utf-8");
    const payload = await fs.readFile(file.absPath);
    hash.update(u64be(name.length));
    hash.update(name);
    hash.update(u64be(payload.length));
    hash.update(payload);
  }
  return `sha256:${hash.digest("hex")}`;
}

type SkillRevocation = Record<string, unknown>;

/**
 * Port of skill_store.py `load_skill_revocations`, fail-CLOSED on corruption:
 *  - missing file → [] (nothing revoked, the normal first-run state);
 *  - unreadable / non-JSON / not an object / `revoked` not an array → THROW. A
 *    corrupt governance source is never treated as "nothing revoked".
 */
export async function loadGlobalSkillRevocations(
  revocationFile = globalSkillRevocationFile(),
): Promise<SkillRevocation[]> {
  let raw: string;
  try {
    // STRICT UTF-8 — invalid bytes make the kernel's `read_text` raise and
    // fail-closed; a non-strict read could treat a corrupt governance source as
    // "nothing revoked" and let a revoked skill load.
    raw = await readFileUtf8Strict(revocationFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new GlobalSkillStoreError(`skill revocation file is unreadable: ${revocationFile}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new GlobalSkillStoreError(`skill revocation file is unreadable: ${revocationFile}`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new GlobalSkillStoreError(`skill revocation file is malformed (expected an object): ${revocationFile}`);
  }
  // Mirror Python `payload.get("revoked", [])`: the default applies ONLY when the
  // key is ABSENT. A present-but-non-list value (incl. `null`) is malformed and
  // must throw — `?? []` would wrongly coerce `{"revoked": null}` to "nothing
  // revoked" (fail-open), letting a revoked skill load against a damaged list.
  const revoked = Object.prototype.hasOwnProperty.call(payload, "revoked")
    ? (payload as Record<string, unknown>).revoked
    : [];
  if (!Array.isArray(revoked)) {
    throw new GlobalSkillStoreError(`skill revocation file 'revoked' must be a list: ${revocationFile}`);
  }
  // Keep only JSON OBJECTS, mirroring the kernel's `[item for item in revoked if
  // isinstance(item, dict)]` — a list/primitive entry is NOT a dict there, so drop
  // it here too (a JS array is `typeof "object"`, hence the explicit array guard).
  return revoked.filter(
    (item): item is SkillRevocation =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/**
 * Port of skill_store.py `_skill_revocation_matches` for the READ path: match on
 * the recomputed `storeDigest` and/or the `slug`. A slug-only entry revokes every
 * version; a `store_digest` entry revokes that exact bytes. `source_digest` entries
 * never match here (read path has no recomputed source tree — parity with the
 * kernel passing `source_digest=None`), so a forged provenance can't dodge it.
 */
export function skillRevocationMatches(
  slug: string,
  storeDigest: string,
  revoked: SkillRevocation[],
): boolean {
  for (const item of revoked) {
    const entrySlug = item.slug;
    // An OBJECT/ARRAY slug is UNHASHABLE in the kernel's `entry_slug not in
    // {None, slug}` set membership → TypeError → the skill is dropped (fail-closed).
    // THROW (the caller drops the skill) rather than silently skipping the entry,
    // which would ignore a possibly digest-matching revocation on that same entry —
    // a revocation-bypass fail-open. (A hashable non-string slug — number/boolean —
    // is NOT a match in the kernel either: `5 not in {None, slug}` is True → skip.)
    if (typeof entrySlug === "object" && entrySlug !== null) {
      throw new GlobalSkillStoreError("malformed revocation entry: 'slug' must be a string or null");
    }
    if (entrySlug !== undefined && entrySlug !== null && entrySlug !== slug) continue;
    const storeMatch = item.store_digest;
    const sourceMatch = item.source_digest;
    if (storeMatch == null && sourceMatch == null) {
      // No digest pinned: a slug-only entry revokes every version.
      if (entrySlug === undefined || entrySlug === null) continue; // neither pinned → unusable
      return true;
    }
    if (typeof storeMatch === "string" && storeMatch === storeDigest) return true;
    // source_digest intentionally never matches on the read path.
  }
  return false;
}

/**
 * Enumerate the global skill store as Paperclip runtime skill entries, fail-closed
 * (mirrors skill_store.py `list_skills`). Throws if the revocation file is corrupt;
 * silently drops any individual skill that lacks provenance, fails to parse, is
 * tampered (digest mismatch), or is revoked.
 */
export async function listGlobalRuntimeSkillEntries(): Promise<PaperclipSkillEntry[]> {
  const root = globalSkillStoreDir();
  let children: import("node:fs").Dirent[];
  try {
    children = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  // Throws on a corrupt revocation source → caller (union) fails closed.
  const revoked = await loadGlobalSkillRevocations();
  const dirs = children.filter((c) => c.isDirectory()).map((c) => c.name).sort();
  const entries: PaperclipSkillEntry[] = [];
  for (const slug of dirs) {
    const child = path.join(root, slug);
    const skillFile = path.join(child, "SKILL.md");
    const provFile = path.join(child, PROVENANCE_NAME);
    try {
      // Require BOTH SKILL.md and .provenance.json — presence of only the markdown
      // is not a trusted, kernel-imported skill.
      // Require BOTH SKILL.md and .provenance.json. A read/parse failure here is a
      // per-skill drop (mirrors the kernel's `except (OSError, ValueError, ...)`);
      // a STRUCTURAL violation (below) refuses the whole store.
      // STRICT UTF-8 (kernel reads `.provenance.json` via `read_text(utf-8)`): a
      // missing file OR invalid UTF-8 throws → per-skill drop, like the kernel's
      // ENOENT / UnicodeDecodeError(=ValueError).
      const provRaw = await readFileUtf8Strict(provFile);
      let parsedProvenance: unknown;
      try {
        parsedProvenance = JSON.parse(provRaw);
      } catch {
        // Python's `json.loads` accepts NaN / Infinity / -Infinity as float VALUES
        // anywhere (bare, in an array, as a dict value) where JS `JSON.parse` throws.
        // If such a constant appears outside a string, the kernel WOULD have parsed
        // this file — to a list/float (→ `provenance.get` AttributeError → crash-all)
        // or a dict (→ admitted). Refuse the WHOLE store (Fatal): that is ≥ the
        // kernel's strictness in every case, so we never admit more than it. A
        // genuine syntax error (no such constant) is an ordinary per-skill drop.
        if (containsBareJsonConstant(provRaw)) {
          throw new GlobalSkillStoreFatalError(`global skill ${slug} has a non-JSON-object .provenance.json`);
        }
        continue; // genuine syntax error → drop just this skill (kernel: ValueError)
      }
      // SKILL.md must be a REGULAR FILE readable as UTF-8 — mirror the kernel's
      // `parse_markdown_with_frontmatter(skill_file.read_text(encoding="utf-8"))`:
      // a directory/symlink raises OSError, invalid UTF-8 raises UnicodeDecodeError
      // (a ValueError); both are caught per-skill → drop. Our byte-only digest would
      // otherwise admit a SKILL.md the kernel refuses to read as text. (`readFile`
      // with "utf8" silently replaces bad bytes, so decode strictly instead.)
      const skillStat = await fs.lstat(skillFile).catch(() => null);
      if (!skillStat || !skillStat.isFile()) continue; // missing / dir / symlink → drop
      try {
        await readFileUtf8Strict(skillFile);
      } catch {
        continue; // invalid UTF-8 → drop (kernel: read_text UnicodeDecodeError)
      }
      // The provenance must be a JSON OBJECT. A list/primitive is structurally
      // invalid: in the kernel `provenance.get(...)` raises AttributeError, which is
      // NOT in its per-skill except list, so the WHOLE store enumeration fails
      // (crash-all → the union injects NO globals). Mirror by THROWING — reading
      // `.store_digest` off a JS array would instead yield `undefined`, skip the
      // tamper check, and admit an UNVERIFIED skill (fail-open).
      if (typeof parsedProvenance !== "object" || parsedProvenance === null || Array.isArray(parsedProvenance)) {
        throw new GlobalSkillStoreFatalError(`global skill ${slug} has a non-object .provenance.json`);
      }
      const provenance = parsedProvenance as Record<string, unknown>;
      // The kernel does `str(provenance.get("store_digest") or "")`. For a STRING it
      // is the string itself; for a non-string truthy value (e.g. `["sha256:x"]`)
      // Python's `str()` yields a repr like `"['sha256:x']"` that can NEVER equal a
      // recomputed `sha256:` digest → tamper mismatch → drop. JS `String(["sha256:x"])`
      // would instead coerce to `"sha256:x"` and FALSELY match (fail-open). So a
      // present, non-string store_digest is dropped here; only a string is compared.
      const rawDigest = provenance.store_digest;
      if (rawDigest !== undefined && rawDigest !== null && typeof rawDigest !== "string") {
        continue; // non-string store_digest → never a valid digest match → drop
      }
      const declared = typeof rawDigest === "string" ? rawDigest : "";
      const recomputed = await computeStoredSkillDigest(child);
      if (declared && recomputed !== declared) continue; // tamper → drop
      if (skillRevocationMatches(slug, recomputed, revoked)) continue; // revoked → drop
      // The kernel builds its record with `[str(item) for item in
      // provenance.get("executable_assets", [])]`. A present, NON-ITERABLE value
      // (null / number / boolean) raises TypeError there → caught per-skill → drop.
      // (A string/array/object IS iterable in Python, so it does not error → admit;
      // an absent key defaults to `[]`.) We never use the field, but must mirror the
      // drop or we'd admit a skill the kernel refuses (fail-open).
      const execAssets = provenance.executable_assets;
      if (execAssets === null || typeof execAssets === "number" || typeof execAssets === "boolean") {
        continue;
      }
      entries.push({
        key: `${GLOBAL_SKILL_KEY_PREFIX}${slug}`,
        runtimeName: slug,
        source: child,
        versionId: null,
        currentVersionId: null,
        sourceStatus: "available",
        missingDetail: null,
      });
    } catch (err) {
      // Crash-ALL store corruption (non-object provenance) escapes the per-skill
      // guard and refuses the whole store — mirrors the kernel's un-caught
      // AttributeError. Everything else (missing/unreadable provenance, parse error,
      // symlink in tree [SkillStoreError=ValueError], malformed revocation slug
      // [TypeError]) is a per-skill DROP, exactly like the kernel's per-skill except.
      if (err instanceof GlobalSkillStoreFatalError) throw err;
      continue;
    }
  }
  return entries;
}

/**
 * Union global skills (cross-company) onto a company's runtime skill entries.
 * Company entries WIN on a `runtimeName` collision (the company's own version of a
 * skill overrides the global baseline). Fail-closed: if the global store can't be
 * enumerated (e.g. a corrupt revocation file throws), NO globals are injected and a
 * warning is logged — the company run proceeds on its own skills rather than on
 * unverified global capability.
 */
export async function unionGlobalRuntimeSkillEntries(
  companyEntries: PaperclipSkillEntry[],
): Promise<PaperclipSkillEntry[]> {
  let globals: PaperclipSkillEntry[];
  try {
    globals = await listGlobalRuntimeSkillEntries();
  } catch (err) {
    console.warn(
      `[global-skills] refusing to inject global skills (store not safely enumerable): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return companyEntries;
  }
  const takenRuntimeNames = new Set(companyEntries.map((entry) => entry.runtimeName));
  const fresh = globals.filter((entry) => !takenRuntimeNames.has(entry.runtimeName));
  return [...companyEntries, ...fresh];
}
