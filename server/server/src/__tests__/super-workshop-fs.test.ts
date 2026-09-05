import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  computeArchiveSha256,
  materializeInstall,
  readSuperManifestJson,
  removeInstallDir,
  resolveSuperPluginInstallDir,
  ScplugExtractionError,
  unpackScplug,
  unpackVerifiedScplug,
  type ScplugLimits,
} from "../services/super-workshop-fs.js";

/**
 * Minimal STORED-method (no compression) ZIP builder — portable, no zip-writer dep —
 * so we can craft both well-formed and adversarial `.scplug` fixtures (traversal,
 * symlink, duplicate, file-vs-dir, __pycache__, byte-bomb). Each entry carries a real
 * CRC32 for realism — note yauzl@3.x does NOT verify it (the receipt's transport_sha256
 * over the whole archive is the integrity boundary, not the per-entry zip CRC).
 */
interface ZipEntry {
  name: string;
  content?: Buffer | string; // omit for a pure directory entry
  unixMode?: number; // e.g. 0o100644 file, 0o040755 dir, 0o120777 symlink
  deflateGarbage?: boolean; // DEFLATE method (8) with non-inflatable bytes → Z_DATA_ERROR
}

/** IEEE CRC32 — fixtures carry a real CRC for realism (yauzl@3.x does not verify it). */
function crc32Unsigned(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function buildZip(entries: ZipEntry[], opts: { declaredEntries?: number; cdSizeOverride?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = e.deflateGarbage
      ? Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]) // not a valid deflate stream
      : e.content === undefined
        ? Buffer.alloc(0)
        : Buffer.from(e.content as never);
    const crc = crc32Unsigned(data);
    const method = e.deflateGarbage ? 8 : 0;
    const uncompSize = e.deflateGarbage ? 64 : data.length; // declared > 0 so yauzl inflates
    const UTF8_FLAG = 0x0800; // general-purpose bit 11 → yauzl decodes the name as UTF-8
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(UTF8_FLAG),
      u16(method),
      u16(0),
      u16(0), // mod time/date
      u32(crc),
      u32(data.length),
      u32(uncompSize),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      data,
    ]);
    const externalAttr = ((e.unixMode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644)) << 16) >>> 0;
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(UTF8_FLAG),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(uncompSize),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(externalAttr),
      u32(offset),
      nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const declared = opts.declaredEntries ?? entries.length; // spoof the EOCD count when overridden
  const cdSizeField = opts.cdSizeOverride ?? cd.length; // spoof the declared CD byte size when overridden
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(declared),
    u16(declared),
    u32(cdSizeField),
    u32(cdOffset),
    u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

const SMALL_LIMITS: ScplugLimits = {
  maxEntries: 50,
  maxUncompressedBytes: 4096,
  maxCompressedBytes: 1024 * 1024,
  maxCentralDirectoryBytes: 64 * 1024,
};

describe("super-workshop-fs", () => {
  let work: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "scplug-fs-test-"));
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  let counter = 0;
  async function writeZip(entries: ZipEntry[], opts: { declaredEntries?: number } = {}): Promise<string> {
    const file = path.join(work, `fixture-${counter++}.scplug`);
    await writeFile(file, buildZip(entries, opts));
    return file;
  }
  async function countTempExtractions(): Promise<number> {
    const names = await readdir(os.tmpdir());
    return names.filter((n) => n.startsWith("superclaw-scplug-")).length;
  }

  describe("computeArchiveSha256", () => {
    it("matches a known sha256 of the file bytes", async () => {
      const file = path.join(work, "digest.bin");
      await writeFile(file, "hello-superclaw");
      const expected = "sha256:" + createHash("sha256").update("hello-superclaw").digest("hex");
      expect(await computeArchiveSha256(file)).toBe(expected);
    });
  });

  describe("unpackScplug — happy path", () => {
    it("extracts files + nested dirs and applies perms", async () => {
      const file = await writeZip([
        { name: "superclaw-plugin.json", content: '{"id":"dev.x"}' },
        { name: "bin/", unixMode: 0o040755 },
        { name: "bin/run", content: "#!/bin/sh\n", unixMode: 0o100755 },
      ]);
      const { dir, cleanup } = await unpackScplug(file, SMALL_LIMITS);
      try {
        expect(await readFile(path.join(dir, "superclaw-plugin.json"), "utf8")).toBe('{"id":"dev.x"}');
        expect((await stat(path.join(dir, "bin", "run"))).mode & 0o777).toBe(0o755);
      } finally {
        await cleanup();
      }
      await expect(stat(dir)).rejects.toThrow(); // cleanup removed it
    });
  });

  describe("unpackScplug — adversarial members rejected", () => {
    const cases: Array<[string, ZipEntry[], RegExp]> = [
      // yauzl ALSO has a built-in relative/absolute-path guard (defence in depth), so
      // either its message or our own may surface — both fail closed.
      ["path traversal", [{ name: "../escape.txt", content: "x" }], /traversal|invalid relative path/i],
      ["absolute path", [{ name: "/etc/passwd", content: "x" }], /absolute|invalid absolute path/i],
      ["symlink member", [{ name: "link", content: "/etc/passwd", unixMode: 0o120777 }], /symlink/],
      ["__pycache__ member", [{ name: "__pycache__/x.pyc", content: "x" }], /__pycache__/],
      ["exact duplicate", [{ name: "a.txt", content: "1" }, { name: "a.txt", content: "2" }], /duplicate/],
      ["case collision", [{ name: "Readme.md", content: "1" }, { name: "README.MD", content: "2" }], /colliding/],
      [
        "file-vs-dir conflict",
        [{ name: "foo", content: "1" }, { name: "foo/bar", content: "2" }],
        /both a file and a directory/,
      ],
      ["root-alias member", [{ name: "./", unixMode: 0o040755 }], /root-alias/],
    ];
    for (const [label, entries, pattern] of cases) {
      it(`rejects ${label}`, async () => {
        const file = await writeZip(entries);
        await expect(unpackScplug(file, SMALL_LIMITS)).rejects.toThrow(pattern);
      });
    }

    it("rejects a non-NFC member name", async () => {
      // NFD spelling: ASCII "e" + U+0301 COMBINING ACUTE, built from an escape so the
      // editor cannot silently store it composed (NFC).
      const nfdName = "caf\u0065\u0301.txt";
      const file = await writeZip([{ name: nfdName, content: "x" }]);
      await expect(unpackScplug(file, SMALL_LIMITS)).rejects.toThrow(/NFC/);
    });
  });

  describe("unpackVerifiedScplug — fd-bound integrity", () => {
    it("extracts when the digest matches the archive bytes", async () => {
      const file = await writeZip([{ name: "superclaw-plugin.json", content: '{"id":"dev.v"}' }]);
      const sha = "sha256:" + createHash("sha256").update(await readFile(file)).digest("hex");
      const { dir, cleanup } = await unpackVerifiedScplug(file, sha, SMALL_LIMITS);
      try {
        expect(await readFile(path.join(dir, "superclaw-plugin.json"), "utf8")).toBe('{"id":"dev.v"}');
      } finally {
        await cleanup();
      }
    });

    it("fails closed when the digest does not match (and leaves no temp dir)", async () => {
      const file = await writeZip([{ name: "a.txt", content: "x" }]);
      const before = await countTempExtractions();
      await expect(unpackVerifiedScplug(file, "sha256:" + "00".repeat(32), SMALL_LIMITS)).rejects.toThrow(
        /transport digest/,
      );
      expect(await countTempExtractions()).toBe(before); // no extraction temp dir leaked
    });
  });

  describe("unpackScplug — central-directory integrity", () => {
    it("rejects a spoofed-low EOCD entry count (extraction-discrepancy guard)", async () => {
      // 3 real CD records but the EOCD declares 1 — yauzl would stop early; we must reject.
      const file = await writeZip(
        [
          { name: "a", content: "1" },
          { name: "b", content: "2" },
          { name: "c", content: "3" },
        ],
        { declaredEntries: 1 },
      );
      await expect(unpackScplug(file, SMALL_LIMITS)).rejects.toThrow(/spoofed count|central directory/);
    });

    it("rejects a spoofed-low cdSize that hides extra CD records before the EOCD", async () => {
      // EOCD declares cdSize = only the FIRST record's bytes (and count 1), so a naive
      // walk would read 1 record and pass — but the CD does not end at the EOCD.
      const firstRecordLen = 46 + Buffer.from("a", "utf8").length; // 46-byte header + 1-byte name
      const file = await writeZip(
        [
          { name: "a", content: "1" },
          { name: "b", content: "2" },
        ],
        { declaredEntries: 1, cdSizeOverride: firstRecordLen },
      );
      await expect(unpackScplug(file, SMALL_LIMITS)).rejects.toThrow(/bounds are inconsistent|central directory/);
    });

    it("classifies a corrupt deflate entry (zlib Z_DATA_ERROR) as ScplugExtractionError (→ 400)", async () => {
      // A DEFLATE-method entry whose compressed bytes are not a valid deflate stream:
      // zlib throws Z_DATA_ERROR (which carries a `.code`), but it is a MALFORMED archive,
      // not a local fs failure → must be a classified ScplugExtractionError.
      const file = await writeZip([{ name: "bad.bin", deflateGarbage: true }]);
      await expect(unpackScplug(file, SMALL_LIMITS)).rejects.toThrow(ScplugExtractionError);
    });

    it("propagates a LOCAL fs error during extraction AS-IS (not wrapped → route 500)", async () => {
      // An over-long path component makes the extraction target write fail (ENAMETOOLONG)
      // — a local fs failure, NOT a malformed archive. It must NOT be normalized to a
      // ScplugExtractionError (which would mislead as a 400 package rejection).
      const file = await writeZip([{ name: "a".repeat(400), content: "x" }]);
      const err = await unpackScplug(file, SMALL_LIMITS).then(
        () => null,
        (e) => e,
      );
      expect(err).not.toBeNull();
      expect(err).not.toBeInstanceOf(ScplugExtractionError);
      expect((err as NodeJS.ErrnoException).code).toBeTypeOf("string"); // a real fs errno
    });

    it("does not leak a temp dir on a malformed (non-ZIP) input (classified ScplugExtractionError)", async () => {
      const file = path.join(work, "not-a-zip.scplug");
      await writeFile(file, "this is not a zip file at all");
      const before = await countTempExtractions();
      await expect(unpackScplug(file, SMALL_LIMITS)).rejects.toThrow(ScplugExtractionError);
      expect(await countTempExtractions()).toBe(before);
    });
  });

  describe("unpackScplug — zip-bomb guards", () => {
    it("rejects too many entries", async () => {
      const file = await writeZip([
        { name: "a", content: "1" },
        { name: "b", content: "2" },
        { name: "c", content: "3" },
      ]);
      await expect(unpackScplug(file, { ...SMALL_LIMITS, maxEntries: 2 })).rejects.toThrow(/too many entries/);
    });

    it("aborts mid-stream when uncompressed bytes exceed the budget (declared size not trusted)", async () => {
      const file = await writeZip([{ name: "big.bin", content: Buffer.alloc(200, 0x41) }]);
      await expect(unpackScplug(file, { ...SMALL_LIMITS, maxUncompressedBytes: 100 })).rejects.toThrow(
        /maximum uncompressed size/,
      );
    });

    it("rejects an archive that is too large on disk before opening", async () => {
      const file = await writeZip([{ name: "a", content: "x" }]);
      await expect(unpackScplug(file, { ...SMALL_LIMITS, maxCompressedBytes: 10 })).rejects.toThrow(/too large on disk/);
    });
  });

  describe("resolveSuperPluginInstallDir", () => {
    it("roots a plugin key under the install root", () => {
      const dir = resolveSuperPluginInstallDir("dev.acme.tool");
      expect(dir.endsWith(path.join("super-plugins", "dev.acme.tool"))).toBe(true);
    });
    it("refuses an unsafe key with path separators", () => {
      expect(() => resolveSuperPluginInstallDir("../evil")).toThrow(ScplugExtractionError);
      expect(() => resolveSuperPluginInstallDir("a/b")).toThrow(ScplugExtractionError);
    });
  });

  describe("materializeInstall + removeInstallDir", () => {
    it("atomically places the unpacked dir at the install dir, then removes it", async () => {
      const src = path.join(work, "src");
      await mkdir(path.join(src, "bin"), { recursive: true });
      await writeFile(path.join(src, "superclaw-plugin.json"), "{}");
      await writeFile(path.join(src, "bin", "run"), "x");
      const installDir = path.join(work, "installed", "dev.acme.tool");
      await materializeInstall(src, installDir);
      expect(await readFile(path.join(installDir, "bin", "run"), "utf8")).toBe("x");
      await removeInstallDir(installDir);
      await expect(stat(installDir)).rejects.toThrow();
      await removeInstallDir(installDir); // idempotent
    });
  });

  describe("readSuperManifestJson", () => {
    it("returns the parsed manifest when present", async () => {
      const dir = path.join(work, "withman");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "superclaw-plugin.json"), '{"id":"dev.y"}');
      expect(await readSuperManifestJson(dir)).toEqual({ id: "dev.y" });
    });
    it("returns null when absent (→ Paperclip JS plugin)", async () => {
      const dir = path.join(work, "noman");
      await mkdir(dir, { recursive: true });
      expect(await readSuperManifestJson(dir)).toBeNull();
    });
    it("throws a classified ScplugExtractionError on corrupt JSON (never treated as JS)", async () => {
      const dir = path.join(work, "badman");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "superclaw-plugin.json"), "{ not json");
      await expect(readSuperManifestJson(dir)).rejects.toThrow(ScplugExtractionError);
    });

    it("throws a classified ScplugExtractionError on invalid UTF-8 bytes", async () => {
      const dir = path.join(work, "badutf8");
      await mkdir(dir, { recursive: true });
      // 0xFF is never valid in UTF-8 — a lenient decoder would replace it with U+FFFD.
      await writeFile(path.join(dir, "superclaw-plugin.json"), Buffer.from([0x7b, 0xff, 0x7d]));
      await expect(readSuperManifestJson(dir)).rejects.toThrow(ScplugExtractionError);
    });

    it("rejects a BOM-prefixed manifest (BOM preserved → JSON.parse fails)", async () => {
      const dir = path.join(work, "bomman");
      await mkdir(dir, { recursive: true });
      // A UTF-8 BOM (EF BB BF) + otherwise-valid JSON: must be REJECTED, not stripped.
      await writeFile(path.join(dir, "superclaw-plugin.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"id":"x"}')]));
      await expect(readSuperManifestJson(dir)).rejects.toThrow(ScplugExtractionError);
    });
  });
});
