import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import yauzl from "yauzl";

import { SUPER_PLUGIN_MANIFEST_NAME } from "./super-plugin-manifest.js";

/**
 * Real filesystem primitives for the workshop import wiring (P6b): a HARDENED
 * `.scplug` (plain ZIP) extractor plus the install-dir materialize / remove /
 * resolve / manifest-read the S2c importer + P6a installer inject.
 *
 * INTEGRITY BINDING (closing the same-UID TOCTOU): the authoritative boundary is
 * the receipt's `transport_sha256` over the archive BYTES. {@link unpackVerifiedScplug}
 * reads the archive into ONE immutable in-memory buffer, hashes THAT buffer, and
 * extracts from the SAME buffer (`yauzl.fromBuffer`) — so the extracted bytes ARE the
 * digest-covered bytes. A same-UID process rewriting the path OR the inode after the
 * snapshot cannot change what was hashed/extracted (pinning an fd would freeze the
 * inode but not its content; S1 is explicit that a chmod/path is not the boundary).
 *
 * EXTRACTION PARITY (closing the spoofed-entry-count discrepancy): yauzl trusts the
 * EOCD entry count, but Python's verifier walks the central directory independently.
 * A crafted archive with a low declared count would make Node extract a different
 * tree than the one Python reviewed/signed. So before extraction we independently
 * walk the central directory and reject any archive whose real record count does not
 * match the declared count (mirroring plugins.py's CD guard).
 *
 * The per-member guards mirror Python `_safe_extract_plugin_archive`: entry-count
 * cap, path-traversal / absolute / root-alias rejection, symlink + `__pycache__`
 * rejection, Unicode-NFC enforcement, duplicate / case-collision rejection,
 * file-vs-directory ancestor conflict, and a STREAMING uncompressed-byte budget (the
 * declared per-entry size is never trusted — extraction aborts mid-copy if the real
 * decompressed bytes exceed the cap).
 */

export class ScplugExtractionError extends Error {}

export interface ScplugLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
  readonly maxCompressedBytes: number;
  /** Central-directory byte cap (bounds the CD-walk read; mirrors plugins.py). */
  readonly maxCentralDirectoryBytes: number;
}

export const DEFAULT_SCPLUG_LIMITS: ScplugLimits = {
  maxEntries: 100_000,
  maxUncompressedBytes: 512 * 1024 * 1024, // 512 MiB
  maxCompressedBytes: 256 * 1024 * 1024, // 256 MiB on-disk (pre-open guard)
  maxCentralDirectoryBytes: 16 * 1024 * 1024, // 16 MiB
};

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

// LOCAL filesystem errnos: a failure of the extraction TARGET (disk/permission/handle
// limits/path), NOT a malformed archive. These propagate AS-IS → the route returns 500.
// (Anything else — incl. zlib `Z_*` decompress errors — is a malformed-archive error.)
const FS_TARGET_ERRNOS = new Set([
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EMFILE",
  "ENFILE",
  "ENAMETOOLONG",
  "ENOENT",
  "EIO",
  "EROFS",
  "ENOTDIR",
  "EEXIST",
  "ELOOP",
  "EDQUOT",
]);

const EOCD_SIG = 0x06054b50;
const CD_RECORD_SIG = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

/**
 * Read the archive into a single in-memory buffer, aborting early past `maxBytes` so
 * a huge file cannot drive an unbounded allocation. This buffer is the IMMUTABLE
 * snapshot every later step (hash, CD walk, extract) operates on — the same bytes.
 */
async function readArchiveBuffer(archivePath: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of createReadStream(archivePath)) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      throw new ScplugExtractionError(`archive is too large on disk (> ${maxBytes} bytes)`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function hashBuffer(buffer: Buffer): string {
  return "sha256:" + createHash("sha256").update(buffer).digest("hex");
}

/** `sha256:<hex>` over the archive file (streamed, never loaded whole into memory). */
export async function computeArchiveSha256(archivePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) {
    hash.update(chunk as Buffer);
  }
  return "sha256:" + hash.digest("hex");
}

interface CentralDirectoryInfo {
  readonly cdOffset: number;
  readonly cdSize: number;
  readonly declaredEntries: number;
}

/** Locate + parse the End-Of-Central-Directory record. ZIP64 archives are refused. */
function readEocd(buffer: Buffer): CentralDirectoryInfo {
  const fileSize = buffer.length;
  if (fileSize < EOCD_MIN_SIZE) throw new ScplugExtractionError("archive is too small to be a valid ZIP");
  let eocdOffset = -1;
  for (let i = fileSize - EOCD_MIN_SIZE; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new ScplugExtractionError("archive is missing a valid end-of-central-directory record");
  const declaredEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (declaredEntries === ZIP64_SENTINEL_16 || cdSize === ZIP64_SENTINEL_32 || cdOffset === ZIP64_SENTINEL_32) {
    throw new ScplugExtractionError("ZIP64 archives are not supported for .scplug");
  }
  // The central directory must end EXACTLY where the EOCD begins — no gap (hidden CD
  // records smuggled after a spoofed-low cdSize) and no overlap. This makes the
  // archive structure unambiguous so a low declared count/cdSize cannot conceal
  // records that another reader would parse.
  if (cdOffset + cdSize !== eocdOffset) {
    throw new ScplugExtractionError("archive central-directory bounds are inconsistent with the EOCD");
  }
  return { cdOffset, cdSize, declaredEntries };
}

/**
 * Independently walk the central directory and return the REAL record count. Rejects
 * a declared/real mismatch (spoofed entry count → extraction discrepancy) and any
 * overrun/garbage, so Node extracts exactly the tree Python's verifier walked.
 */
function walkCentralDirectory(buffer: Buffer, info: CentralDirectoryInfo, limits: ScplugLimits): number {
  if (info.cdSize > limits.maxCentralDirectoryBytes) {
    throw new ScplugExtractionError(
      `archive central directory is too large (${info.cdSize} > ${limits.maxCentralDirectoryBytes} bytes)`,
    );
  }
  const cd = buffer.subarray(info.cdOffset, info.cdOffset + info.cdSize);
  let pos = 0;
  let count = 0;
  while (pos < info.cdSize) {
    if (pos + 46 > info.cdSize || cd.readUInt32LE(pos) !== CD_RECORD_SIG) {
      throw new ScplugExtractionError("archive central directory is malformed");
    }
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    pos += 46 + nameLen + extraLen + commentLen;
    count++;
    if (count > limits.maxEntries) {
      throw new ScplugExtractionError(`archive has too many entries (> ${limits.maxEntries})`);
    }
  }
  if (pos !== info.cdSize) throw new ScplugExtractionError("archive central directory has trailing garbage");
  if (count !== info.declaredEntries) {
    throw new ScplugExtractionError(
      `archive declared ${info.declaredEntries} entries but the central directory holds ${count} (spoofed count)`,
    );
  }
  return count;
}

function fromBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // BufferSlicer (no fd) — `zipfile.close()` has no underlying fd to close.
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new ScplugExtractionError("could not open archive"));
        return;
      }
      resolve(zipfile);
    });
  });
}

function readAllEntries(zipfile: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zipfile.on("entry", (entry: yauzl.Entry) => {
      entries.push(entry);
      zipfile.readEntry();
    });
    zipfile.on("end", () => resolve(entries));
    zipfile.on("error", reject);
    zipfile.readEntry();
  });
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new ScplugExtractionError(`could not read entry: ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

/** Mirror plugins.py `_archive_collision_key`: NFC-normalize THEN case-fold each part. */
function collisionKey(parts: string[]): string {
  // JS toLowerCase() is a close (not exact) approximation of Python str.casefold();
  // the authoritative integrity boundary is the receipt digest match, so a residual
  // full-Unicode-casefold gap here is defence-in-depth, not the primary guard.
  return parts.map((part) => part.normalize("NFC").toLowerCase()).join("/");
}

interface ValidatedEntry {
  readonly entry: yauzl.Entry;
  readonly parts: string[];
  readonly isDir: boolean;
  readonly perms: number;
}

/** PASS 1 (no I/O): validate every member path/mode and reject collisions. */
function validateEntries(entries: yauzl.Entry[], limits: ScplugLimits): ValidatedEntry[] {
  if (entries.length > limits.maxEntries) {
    throw new ScplugExtractionError(`archive has too many entries (${entries.length} > ${limits.maxEntries})`);
  }

  const validated: ValidatedEntry[] = [];
  const seen = new Map<string, string>();
  const fileKeys = new Map<string, string>();
  const dirKeys = new Map<string, string>();

  for (const entry of entries) {
    const name = entry.fileName;
    if (name.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(name)) {
      throw new ScplugExtractionError(`unsafe archive member path (absolute): ${name}`);
    }
    const isDir = name.endsWith("/");
    const rawParts = name.split("/");
    const parts: string[] = [];
    for (const part of rawParts) {
      if (part === "" || part === ".") continue; // dir trailing slash / "." collapse
      if (part === "..") throw new ScplugExtractionError(`unsafe archive member path (traversal): ${name}`);
      if (part === "__pycache__") {
        throw new ScplugExtractionError(`archive may not contain a __pycache__ member: ${name}`);
      }
      if (part.normalize("NFC") !== part) {
        throw new ScplugExtractionError(`archive member name is not Unicode-NFC-normalized: ${name}`);
      }
      parts.push(part);
    }
    if (parts.length === 0) {
      throw new ScplugExtractionError(`archive may not contain a root-alias member: ${JSON.stringify(name)}`);
    }

    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    if ((mode & S_IFMT) === S_IFLNK) {
      throw new ScplugExtractionError(`archive may not contain a symlink: ${name}`);
    }

    const key = collisionKey(parts);
    const normalized = parts.join("/");
    if (seen.has(key)) {
      const prior = seen.get(key);
      throw new ScplugExtractionError(
        prior === normalized
          ? `archive contains a duplicate member: ${JSON.stringify(normalized)}`
          : `archive contains a case/Unicode-colliding member: ${JSON.stringify(prior)} vs ${JSON.stringify(normalized)}`,
      );
    }
    seen.set(key, normalized);

    // Ancestor/descendant file-vs-dir conflict: every ancestor of any member is a
    // directory; a member that is itself a file at that path collides on disk.
    const ancestorCount = parts.length - (isDir ? 0 : 1);
    if (isDir) dirKeys.set(key, normalized);
    else fileKeys.set(key, normalized);
    for (let depth = 0; depth < ancestorCount; depth++) {
      const ancestorParts = parts.slice(0, depth + 1);
      const ancestorKey = collisionKey(ancestorParts);
      if (!dirKeys.has(ancestorKey)) dirKeys.set(ancestorKey, ancestorParts.join("/"));
    }

    validated.push({ entry, parts, isDir, perms: mode & 0o777 });
  }

  for (const [key, fileName] of fileKeys) {
    if (dirKeys.has(key)) {
      throw new ScplugExtractionError(
        `archive uses a path as both a file and a directory: ${JSON.stringify(fileName)} vs ${JSON.stringify(dirKeys.get(key))}`,
      );
    }
  }
  return validated;
}

/** PASS 2: extract under `root` with a streaming cumulative byte budget. */
async function extractValidated(
  zipfile: yauzl.ZipFile,
  validated: ValidatedEntry[],
  root: string,
  limits: ScplugLimits,
): Promise<void> {
  let remaining = limits.maxUncompressedBytes;
  for (const { entry, parts, isDir, perms } of validated) {
    const target = path.join(root, ...parts);
    // Lexical jail (we already rejected "." / ".." / absolute): the joined target
    // must stay within root.
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new ScplugExtractionError(`unsafe archive member path: ${entry.fileName}`);
    }
    if (isDir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const source = await openEntryStream(zipfile, entry);
    const budget = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        remaining -= chunk.length;
        if (remaining < 0) {
          cb(new ScplugExtractionError(`archive exceeds the maximum uncompressed size (${limits.maxUncompressedBytes} bytes)`));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(source, budget, createWriteStream(target));
    if (perms) await chmod(target, perms);
  }
}

export interface UnpackedArchive {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Snapshot the archive into ONE immutable buffer; optionally verify the transport
 * digest over THAT buffer (so the extracted bytes ARE the digest-covered bytes — a
 * same-UID rewrite of the file after the snapshot cannot change them); independently
 * walk the central directory (closing the spoofed-entry-count discrepancy) BEFORE
 * creating any temp dir; then extract from the same buffer via `yauzl.fromBuffer`.
 */
async function unpackFromBuffer(
  buffer: Buffer,
  limits: ScplugLimits,
  expectedSha256: string | null,
): Promise<UnpackedArchive> {
  if (expectedSha256 !== null && hashBuffer(buffer) !== expectedSha256) {
    throw new ScplugExtractionError("staged artifact transport digest does not match the receipt");
  }
  // Independent central-directory walk on the SAME buffer, BEFORE any temp dir is
  // created (a malformed archive therefore leaks nothing).
  const cdInfo = readEocd(buffer);
  const realCount = walkCentralDirectory(buffer, cdInfo, limits);
  if (realCount > limits.maxEntries) {
    throw new ScplugExtractionError(`archive has too many entries (${realCount} > ${limits.maxEntries})`);
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "superclaw-scplug-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const zipfile = await fromBuffer(buffer);
    if (zipfile.entryCount !== realCount) {
      throw new ScplugExtractionError("archive entry count is inconsistent with its central directory");
    }
    const entries = await readAllEntries(zipfile);
    const validated = validateEntries(entries, limits);
    await extractValidated(zipfile, validated, path.resolve(dir), limits);
    return { dir, cleanup };
  } catch (err) {
    await cleanup().catch(() => {});
    // Already classified (e.g. the streaming size budget) → keep.
    if (err instanceof ScplugExtractionError) throw err;
    // A LOCAL filesystem failure (the extraction TARGET: mkdir/write/chmod hitting
    // ENOSPC/EACCES/ENAMETOOLONG/…) is a SERVER error — propagate AS-IS so the route
    // returns 500, NOT a misleading 400. Only an ALLOWLISTED fs errno qualifies; a zlib
    // `Z_DATA_ERROR` (corrupt deflate) also carries a `.code` but is a MALFORMED ARCHIVE.
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && FS_TARGET_ERRNOS.has(code)) throw err;
    // Otherwise it is a yauzl structural / zlib decompress failure on the (already
    // digest-verified) archive bytes → the publisher's archive is MALFORMED, a
    // client-correctable package error → a classified 400.
    throw new ScplugExtractionError(`archive could not be extracted: ${(err as Error).message}`);
  }
}

/**
 * Verify (`sha256:<hex>` over the archive bytes) + extract from ONE immutable buffer,
 * so the extracted bytes ARE the digest-covered bytes (no same-UID TOCTOU). This is
 * the primitive the importer uses (integrity-authoritative).
 */
export async function unpackVerifiedScplug(
  archivePath: string,
  expectedSha256: string,
  limits: ScplugLimits = DEFAULT_SCPLUG_LIMITS,
): Promise<UnpackedArchive> {
  const buffer = await readArchiveBuffer(archivePath, limits.maxCompressedBytes);
  return unpackFromBuffer(buffer, limits, expectedSha256);
}

/**
 * Extract WITHOUT integrity verification — for trusted/local callers and tests. The
 * importer must use {@link unpackVerifiedScplug} so the digest covers exactly the
 * extracted bytes.
 */
export async function unpackScplug(
  archivePath: string,
  limits: ScplugLimits = DEFAULT_SCPLUG_LIMITS,
): Promise<UnpackedArchive> {
  const buffer = await readArchiveBuffer(archivePath, limits.maxCompressedBytes);
  return unpackFromBuffer(buffer, limits, null);
}

/** Root under which super plugins are materialized (env-overridable, no host hardcode). */
export function superPluginInstallRoot(): string {
  return process.env.SUPERCLAW_SUPER_PLUGIN_ROOT ?? path.join(os.homedir(), ".superclaw", "super-plugins");
}

/** Resolve the persistent install dir for a plugin key (the schema bars path separators). */
export function resolveSuperPluginInstallDir(pluginKey: string): string {
  if (pluginKey.includes("/") || pluginKey.includes("\\") || pluginKey.includes("..")) {
    throw new ScplugExtractionError(`refusing an unsafe plugin key as a directory name: ${JSON.stringify(pluginKey)}`);
  }
  return path.join(superPluginInstallRoot(), pluginKey);
}

/**
 * Materialize the verified unpacked dir into the (fresh) install dir: copy into a
 * sibling `.tmp` then atomically rename into place, so a reader never sees a
 * half-copied install dir. The installer only calls this for a NOT-yet-installed id.
 */
export async function materializeInstall(unpackedDir: string, installDir: string): Promise<void> {
  await mkdir(path.dirname(installDir), { recursive: true });
  const staging = `${installDir}.tmp-${randomUUID()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(unpackedDir, staging, { recursive: true });
    await rename(staging, installDir);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Remove an install dir, idempotently (no-op if absent). */
export async function removeInstallDir(installDir: string): Promise<void> {
  await rm(installDir, { recursive: true, force: true });
}

/**
 * Read + strict-UTF-8-decode + JSON-parse the `superclaw-plugin.json` from an unpacked
 * dir. Returns `null` ONLY when the file is absent (→ the artifact is a Paperclip JS
 * plugin, not a super plugin); a present-but-unreadable / invalid-UTF-8 / unparseable
 * manifest THROWS (a corrupt super plugin must never be silently treated as JS).
 */
export async function readSuperManifestJson(unpackedDir: string): Promise<unknown | null> {
  const manifestPath = path.join(unpackedDir, SUPER_PLUGIN_MANIFEST_NAME);
  let bytes: Buffer;
  try {
    bytes = await readFile(manifestPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // Strict UTF-8 (fatal) + JSON parse: a corrupt manifest is a CLIENT-CORRECTABLE
  // package error → a classified ScplugExtractionError (so the route returns 400, not
  // a 500), never a bare TypeError/SyntaxError.
  let text: string;
  try {
    // `ignoreBOM: true` PRESERVES a leading BOM (the option name is inverted) so a
    // BOM-prefixed manifest makes JSON.parse reject — matching the kernel's strict JSON
    // boundaries (global-runtime-skills `readFileUtf8Strict`); stripping it would admit
    // a manifest the kernel refuses.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ScplugExtractionError(`${SUPER_PLUGIN_MANIFEST_NAME} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ScplugExtractionError(`${SUPER_PLUGIN_MANIFEST_NAME} is not valid JSON`);
  }
}
