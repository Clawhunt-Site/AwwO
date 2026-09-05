import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";

/**
 * Real fs primitive for the workshop COMPANY landing (S5): walk the verified unpacked
 * bundle into the inline-files map Paperclip's native `importBundle` consumes
 * (`source: { type: "inline", files }`).
 *
 * Each file is carried in the encoding the native reader expects: TEXT files (the
 * portability manifest + markdown/yaml/json the reader reads via `readPortableTextFile`,
 * which accepts ONLY `string`) as a string; genuinely BINARY files (assets/logos) as a
 * base64 entry. The split is by strict UTF-8 decodability (a valid-UTF-8 file is text;
 * anything else is binary) — base64-for-all would make the manifest "not readable as
 * text" and break the import. Symlinks / non-regular nodes are refused (a stored bundle
 * must not smuggle bytes via a link).
 *
 * There is deliberately NO plugin/skill-shape heuristic here: a company bundle
 * legitimately contains nested `SKILL.md` files (company skills), and a non-company
 * package simply lacks a company manifest — `importBundle` rejects it ("Manifest does
 * not include company metadata"), which IS the reverse red-line.
 */

export class SuperCompanyFsError extends Error {}

export async function buildCompanyInlineFiles(unpackedDir: string): Promise<Record<string, CompanyPortabilityFileEntry>> {
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  const root = path.resolve(unpackedDir);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        throw new SuperCompanyFsError(`company bundle may not contain a symlink: ${path.relative(root, abs)}`);
      }
      if (info.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!info.isFile()) {
        throw new SuperCompanyFsError(`company bundle contains a non-regular file: ${path.relative(root, abs)}`);
      }
      const relPosix = path.relative(root, abs).split(path.sep).join("/");
      const bytes = await readFile(abs);
      files[relPosix] = encodePortableFile(bytes);
    }
  }

  await walk(root);
  return files;
}

/** Text (strict-UTF-8-decodable) → string; otherwise → base64. Matches the native reader. */
function encodePortableFile(bytes: Buffer): CompanyPortabilityFileEntry {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { encoding: "base64", data: bytes.toString("base64"), contentType: null };
  }
}
