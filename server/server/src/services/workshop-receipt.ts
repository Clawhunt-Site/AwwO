/**
 * Workshop trust receipt verification (Node side, capability workshop S2).
 *
 * The receipt is issued by SuperClaw's Python verification gate
 * (`superclaw.capability_receipt`) and handed to the Paperclip-native importer
 * over a loopback channel. This module verifies it, so the importer can trust
 * the staged bytes WITHOUT re-running SuperClaw's custom domain-hash check.
 *
 * Parity is the whole point: the HMAC is computed over the SAME canonical bytes
 * Python produces — `json.dumps(core, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=True)` then HMAC-SHA256. `canonicalCore` reproduces that byte for
 * byte (sorted keys, compact, non-ASCII escaped as `\uXXXX`); it is locked by
 * golden vectors exported from the Python signer (see workshop-receipt.test.ts).
 *
 * Every verification failure is a `WorkshopReceiptError` (fail-closed): strict
 * field types (no coercion — `bool("false")`-style upgrades are impossible),
 * a strict mac shape BEFORE the timing-safe compare (so a non-ASCII mac cannot
 * throw a raw TypeError), TTL window, and a MANDATORY app-env binding.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";

export class WorkshopReceiptError extends Error {}

const RECEIPT_VERSION = "1";
const MAX_RECEIPT_TTL_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 300;
const VALID_KINDS = new Set(["plugin", "skill", "company"]);
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
/**
 * The supervisor (Python) passes the FILE PATH of the 0600 receipt key here — never the key
 * VALUE. Reading the key from a file instead of an env var means the secret never lives in this
 * process's `process.env`, so no child process (agent / plugin / runtime / git / ssh / tar /
 * npm — local or remote) can ever inherit it. The path itself is not sensitive.
 */
export const WORKSHOP_RECEIPT_KEY_FILE_ENV = "SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE";

const CORE_KEYS = [
  "receipt_version",
  "receipt_id",
  "kind",
  "capability_id",
  "version",
  "package_digest",
  "transport_sha256",
  "staged_artifact",
  "artifact_ref",
  "app_env",
  "official",
  "issued_at",
  "expires_at",
] as const;
const ALLOWED_KEYS = new Set<string>([...CORE_KEYS, "mac"]);

export interface WorkshopReceipt {
  receipt_version: string;
  receipt_id: string;
  kind: string;
  capability_id: string;
  version: string;
  package_digest: string;
  transport_sha256: string;
  staged_artifact: string;
  artifact_ref: string;
  app_env: string;
  official: boolean;
  issued_at: number;
  expires_at: number;
}

declare const verifiedReceiptBrand: unique symbol;

/**
 * A receipt that has passed `verifyReceipt` (HMAC + TTL + app-env + strict types).
 * The brand is a module-private unique symbol, so a value of this type can ONLY
 * be produced by `verifyReceipt` — downstream APIs (e.g. provenance writes) that
 * require it cannot be fed a hand-fabricated receipt, which is what binds the
 * `official` verdict to the cosign gate rather than a caller-supplied flag.
 */
export type VerifiedWorkshopReceipt = WorkshopReceipt & { readonly [verifiedReceiptBrand]: true };

/** Reproduce Python json.dumps(ensure_ascii=True) string escaping for one string. */
function jsonEscapeAscii(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    // Python json.dumps(ensure_ascii=True) escapes control chars AND everything
    // above 0x7e — including 0x7f (DEL), which `>= 0x80` would miss.
    else if (c < 0x20 || c > 0x7e) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += value[i];
  }
  return out + '"';
}

/** Canonical bytes the HMAC is taken over — byte-identical to the Python signer. */
function canonicalCore(receipt: WorkshopReceipt): string {
  const core: Record<string, string | number | boolean> = {
    receipt_version: RECEIPT_VERSION,
    receipt_id: receipt.receipt_id,
    kind: receipt.kind,
    capability_id: receipt.capability_id,
    version: receipt.version,
    package_digest: receipt.package_digest,
    transport_sha256: receipt.transport_sha256,
    staged_artifact: receipt.staged_artifact,
    artifact_ref: receipt.artifact_ref,
    app_env: receipt.app_env,
    official: receipt.official,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
  };
  const parts = Object.keys(core)
    .sort()
    .map((key) => {
      const value = core[key];
      let serialized: string;
      if (typeof value === "string") serialized = jsonEscapeAscii(value);
      else if (typeof value === "boolean") serialized = value ? "true" : "false";
      else serialized = String(value);
      return `${jsonEscapeAscii(key)}:${serialized}`;
    });
  return `{${parts.join(",")}}`;
}

// The key VALUE never lives in process.env (only the file PATH does). At boot,
// `loadAndScrubReceiptKeyFilePath()` reads the key into `pinnedReceiptKey` and DELETES the path
// env var, so children Node later spawns are not even handed the path (defence in depth — the
// path is otherwise derivable, and 0600 only protects across UIDs; a same-UID process that knows
// the path could still read the file, which is the accepted system-wide posture for every local
// secret, e.g. relay_key — true isolation of same-UID untrusted code needs OS sandboxing).
//
// `cachedReceiptKey` is the non-boot path-keyed cache (used before the boot scrub runs and by
// tests): the key is read+validated ONCE per path then held; a different non-empty path re-reads,
// a cleared path drops it. Fail-closed applies on the read, not on every verify.
let pinnedReceiptKey: Buffer | null = null;
let cachedReceiptKey: Buffer | null = null;
let cachedReceiptKeyPath: string | null = null;

/**
 * Read the 64-hex receipt key from a 0600 file fail-closed, returning the UTF-8 key bytes.
 * Mirrors the Python provisioner's safety (`superclaw.workshop_receipt_key`): O_NOFOLLOW (no
 * symlink swap), a regular file, owner-only perms (no group/other access bits, no owner-exec),
 * and a strict 64-hex body. Throws `WorkshopReceiptError` on any violation.
 */
function readReceiptKeyFile(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    throw new WorkshopReceiptError(`workshop receipt key file is unreadable: ${(err as Error).message}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new WorkshopReceiptError("workshop receipt key file is not a regular file");
    // Reject any group/other access bit and the owner-exec bit (a key must be 0600-ish).
    if (st.mode & 0o177) throw new WorkshopReceiptError("workshop receipt key file has unsafe permissions");
    // Parity with the Python provisioner (workshop_receipt_key.py): the key must be owned by THIS
    // user and have exactly one link (a hardlink alias is another readable path to the secret).
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) {
      throw new WorkshopReceiptError("workshop receipt key file is not owned by this user");
    }
    if (st.nlink !== 1) throw new WorkshopReceiptError("workshop receipt key file is hard-linked");
    const body = readFileSync(fd, "utf-8").trim();
    if (!KEY_RE.test(body)) throw new WorkshopReceiptError("workshop receipt key file content is malformed");
    return Buffer.from(body, "utf-8");
  } finally {
    closeSync(fd);
  }
}

/** Resolve the key from the boot pin or the file path env, caching the bytes per path. Returns
 * null if not configured; throws `WorkshopReceiptError` if a path is set but the file is
 * unsafe/malformed. */
function loadReceiptKeyFromFile(): Buffer | null {
  if (pinnedReceiptKey) return pinnedReceiptKey; // boot already read + scrubbed the path
  const keyPath = process.env[WORKSHOP_RECEIPT_KEY_FILE_ENV]?.trim();
  if (!keyPath) {
    cachedReceiptKey = null;
    cachedReceiptKeyPath = null;
    return null;
  }
  if (cachedReceiptKey && cachedReceiptKeyPath === keyPath) return cachedReceiptKey;
  cachedReceiptKey = readReceiptKeyFile(keyPath);
  cachedReceiptKeyPath = keyPath;
  return cachedReceiptKey;
}

/**
 * Read the key into a private boot pin and SCRUB the file-path env var from process.env. Call
 * ONCE at boot, before anything is spawned, so no descendant process is even handed the path
 * (defence in depth; see the cache comment above). After this, verification reads the pin.
 * Best-effort: a missing/unsafe file leaves the pin null (workshop import then fail-closed 503),
 * but the path is scrubbed regardless.
 */
export function loadAndScrubReceiptKeyFilePath(): void {
  try {
    pinnedReceiptKey = loadReceiptKeyFromFile();
  } catch {
    pinnedReceiptKey = null; // unsafe/malformed file → workshop disabled, but still scrub below
  }
  delete process.env[WORKSHOP_RECEIPT_KEY_FILE_ENV];
}

/** Whether a usable receipt key file is configured (path set AND the file reads safely). */
export function isReceiptKeyConfigured(): boolean {
  try {
    return loadReceiptKeyFromFile() !== null;
  } catch {
    return false;
  }
}

function resolveKey(key: Buffer | string | undefined): Buffer {
  if (key !== undefined) {
    const buf = typeof key === "string" ? Buffer.from(key, "utf-8") : key;
    if (buf.length === 0) throw new WorkshopReceiptError("workshop receipt HMAC key must not be empty");
    return buf;
  }
  const fileKey = loadReceiptKeyFromFile();
  if (!fileKey) {
    throw new WorkshopReceiptError(`${WORKSHOP_RECEIPT_KEY_FILE_ENV} is required to verify workshop receipts`);
  }
  return fileKey;
}

export function computeReceiptMac(receipt: WorkshopReceipt, key?: Buffer | string): string {
  const mac = createHmac("sha256", resolveKey(key)).update(canonicalCore(receipt), "utf-8").digest("hex");
  return `sha256:${mac}`;
}

function requireString(wire: Record<string, unknown>, field: string): string {
  const value = wire[field];
  if (typeof value !== "string") throw new WorkshopReceiptError(`receipt ${field} has the wrong type`);
  return value;
}

function requireInt(wire: Record<string, unknown>, field: string): number {
  const value = wire[field];
  // typeof bool !== "number", so booleans are already excluded here.
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new WorkshopReceiptError(`receipt ${field} must be an integer`);
  }
  return value;
}

function requireBool(wire: Record<string, unknown>, field: string): boolean {
  const value = wire[field];
  if (typeof value !== "boolean") throw new WorkshopReceiptError(`receipt ${field} has the wrong type`);
  return value;
}

function requireSha256(value: string, field: string): string {
  if (!SHA256_RE.test(value)) throw new WorkshopReceiptError(`${field} must be a sha256:<64-hex> digest`);
  return value;
}

export interface VerifyReceiptOptions {
  expectedAppEnv: string;
  key?: Buffer | string;
  now?: number;
}

/**
 * Verify a wire receipt and return the validated receipt, else throw
 * `WorkshopReceiptError`. `expectedAppEnv` is mandatory.
 */
export function verifyReceipt(wire: unknown, options: VerifyReceiptOptions): VerifiedWorkshopReceipt {
  if (typeof wire !== "object" || wire === null || Array.isArray(wire)) {
    throw new WorkshopReceiptError("receipt must be an object");
  }
  if (!options.expectedAppEnv) {
    throw new WorkshopReceiptError("expectedAppEnv is required to verify a receipt");
  }
  const record = wire as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length > 0) {
    throw new WorkshopReceiptError(`receipt has unexpected fields: ${extra.sort().join(", ")}`);
  }
  if (requireString(record, "receipt_version") !== RECEIPT_VERSION) {
    throw new WorkshopReceiptError("unsupported receipt_version");
  }
  const presentedMac = requireString(record, "mac");
  // Strict shape BEFORE timingSafeEqual, which throws on non-ASCII / unequal length.
  if (!SHA256_RE.test(presentedMac)) throw new WorkshopReceiptError("receipt mac is malformed");

  const receipt: WorkshopReceipt = {
    receipt_version: RECEIPT_VERSION,
    receipt_id: requireString(record, "receipt_id"),
    kind: requireString(record, "kind"),
    capability_id: requireString(record, "capability_id"),
    version: requireString(record, "version"),
    package_digest: requireSha256(requireString(record, "package_digest"), "package_digest"),
    transport_sha256: requireSha256(requireString(record, "transport_sha256"), "transport_sha256"),
    staged_artifact: requireString(record, "staged_artifact"),
    artifact_ref: requireString(record, "artifact_ref"),
    app_env: requireString(record, "app_env"),
    official: requireBool(record, "official"),
    issued_at: requireInt(record, "issued_at"),
    expires_at: requireInt(record, "expires_at"),
  };

  const expectedMac = computeReceiptMac(receipt, options.key);
  const expectedBuf = Buffer.from(expectedMac, "utf-8");
  const presentedBuf = Buffer.from(presentedMac, "utf-8");
  if (expectedBuf.length !== presentedBuf.length || !timingSafeEqual(expectedBuf, presentedBuf)) {
    throw new WorkshopReceiptError("receipt mac verification failed");
  }

  if (!VALID_KINDS.has(receipt.kind)) throw new WorkshopReceiptError("receipt has an unsupported kind");
  if (receipt.expires_at <= receipt.issued_at) {
    throw new WorkshopReceiptError("receipt expires_at must be after issued_at");
  }
  if (receipt.expires_at - receipt.issued_at > MAX_RECEIPT_TTL_SECONDS) {
    throw new WorkshopReceiptError("receipt ttl exceeds the maximum");
  }
  const current = options.now ?? Math.floor(Date.now() / 1000);
  if (receipt.issued_at > current + CLOCK_SKEW_SECONDS) {
    throw new WorkshopReceiptError("receipt is not yet valid (issued in the future)");
  }
  if (current >= receipt.expires_at) throw new WorkshopReceiptError("receipt has expired");
  if (receipt.app_env !== options.expectedAppEnv) {
    throw new WorkshopReceiptError(
      `receipt app_env ${JSON.stringify(receipt.app_env)} does not match ${JSON.stringify(options.expectedAppEnv)}`,
    );
  }
  // The brand is applied ONLY here, after every check passed.
  return receipt as VerifiedWorkshopReceipt;
}
