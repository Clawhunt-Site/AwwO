import { chmodSync, linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  computeReceiptMac,
  isReceiptKeyConfigured,
  loadAndScrubReceiptKeyFilePath,
  verifyReceipt,
  WorkshopReceipt,
  WORKSHOP_RECEIPT_KEY_FILE_ENV,
  WorkshopReceiptError,
} from "../services/workshop-receipt.js";

const KEY = "golden-vector-key";

function baseReceipt(overrides: Partial<WorkshopReceipt> = {}): WorkshopReceipt {
  return {
    receipt_version: "1",
    receipt_id: "rcpt_deadbeef",
    kind: "plugin",
    capability_id: "acme.tool",
    version: "1.2.3",
    package_digest: "sha256:" + "ab".repeat(32),
    transport_sha256: "sha256:" + "cd".repeat(32),
    staged_artifact: "/var/staging/plugin/acme.tool/cd.scplug",
    artifact_ref: "superclaw-object://capabilities/plugin/acme.tool",
    app_env: "staging",
    official: true,
    issued_at: 1000,
    expires_at: 1120,
    ...overrides,
  };
}

function wireFor(receipt: WorkshopReceipt): Record<string, unknown> {
  return { ...receipt, mac: computeReceiptMac(receipt, KEY) };
}

describe("workshop receipt — cross-language HMAC parity (golden vectors)", () => {
  // Golden vectors exported from superclaw.capability_receipt (Python signer).
  // If these drift, the Python gate and the Node importer no longer agree.
  it("matches the Python MAC for an ASCII receipt", () => {
    expect(computeReceiptMac(baseReceipt(), KEY)).toBe(
      "sha256:fd667438a90835c5e74dc6e5af3ce3ca3060b2ed27b695a05d46fde72d3de66d",
    );
  });

  it("matches the Python MAC for a non-ASCII capability_id (ensure_ascii escaping)", () => {
    const receipt = baseReceipt({
      receipt_id: "rcpt_x",
      kind: "skill",
      capability_id: "café.skïll",
      version: "0.1.0",
      package_digest: "sha256:" + "00".repeat(32),
      transport_sha256: "sha256:" + "11".repeat(32),
      staged_artifact: "/s/x",
      artifact_ref: "ref",
      app_env: "production",
      official: false,
      issued_at: 5,
      expires_at: 65,
    });
    expect(computeReceiptMac(receipt, KEY)).toBe(
      "sha256:c2c79532256c9ae84301f2912155c8edd5b1b2b3feb843fe1734c3cb2260dbd3",
    );
  });

  it("matches the Python MAC for a 0x7f DEL char (escaped as \\u007f, not literal)", () => {
    const receipt = baseReceipt({
      receipt_id: "rcpt_del",
      version: "1.0.0",
      staged_artifact: "/s/x",
      artifact_ref: "ref\x7fx",
    });
    expect(computeReceiptMac(receipt, KEY)).toBe(
      "sha256:826e01d01e28af974c1c39a113b11caf4982be3f6c9359a76d78a29f12f5002b",
    );
  });
});

describe("workshop receipt — verifyReceipt (fail-closed)", () => {
  const verify = (wire: unknown, env = "staging", now = 1050) =>
    verifyReceipt(wire, { key: KEY, now, expectedAppEnv: env });

  it("accepts a valid receipt", () => {
    const receipt = verify(wireFor(baseReceipt()));
    expect(receipt.official).toBe(true);
    expect(receipt.receipt_id).toBe("rcpt_deadbeef");
  });

  it("rejects a tampered field (mac fails)", () => {
    expect(() => verify({ ...wireFor(baseReceipt()), version: "9.9.9" })).toThrow(/mac verification failed/);
  });

  it("rejects a string coerced into official (no bool('false') upgrade)", () => {
    expect(() => verify({ ...wireFor(baseReceipt()), official: "false" })).toThrow(/wrong type/);
  });

  it("rejects a bool where an int is expected", () => {
    expect(() => verify({ ...wireFor(baseReceipt()), issued_at: true })).toThrow(/must be an integer/);
  });

  it("rejects unexpected fields", () => {
    expect(() => verify({ ...wireFor(baseReceipt()), evil: 1 })).toThrow(/unexpected fields/);
  });

  it("rejects an expired receipt", () => {
    expect(() => verify(wireFor(baseReceipt()), "staging", 1120)).toThrow(/expired/);
  });

  it("rejects a future-dated receipt", () => {
    const receipt = baseReceipt({ issued_at: 9000, expires_at: 9100 });
    expect(() => verify(wireFor(receipt), "staging", 1000)).toThrow(/not yet valid/);
  });

  it("rejects an over-long ttl", () => {
    const receipt = baseReceipt({ issued_at: 1000, expires_at: 1000 + 3601 });
    expect(() => verify(wireFor(receipt), "staging", 1100)).toThrow(/ttl exceeds/);
  });

  it("enforces the app_env binding", () => {
    expect(() => verify(wireFor(baseReceipt()), "production")).toThrow(/app_env/);
  });

  it("requires a non-empty expectedAppEnv", () => {
    expect(() => verify(wireFor(baseReceipt()), "")).toThrow(/expectedAppEnv is required/);
  });

  it("keeps a non-ASCII mac fail-closed (no raw TypeError)", () => {
    expect(() => verify({ ...wireFor(baseReceipt()), mac: "sha256:é" })).toThrow(WorkshopReceiptError);
    expect(() => verify({ ...wireFor(baseReceipt()), mac: "sha256:é" })).toThrow(/malformed/);
  });

  it("rejects a malformed digest", () => {
    expect(() => verify({ ...wireFor(baseReceipt()), package_digest: "nope" })).toThrow(/sha256/);
  });

  it("rejects the wrong key", () => {
    expect(() => verifyReceipt(wireFor(baseReceipt()), { key: "other", now: 1050, expectedAppEnv: "staging" })).toThrow(
      /mac verification failed/,
    );
  });

  it("rejects a non-object", () => {
    expect(() => verify("nope")).toThrow(/must be an object/);
    expect(() => verify([])).toThrow(/must be an object/);
  });
});

describe("workshop receipt — key read from a 0600 file (never from process.env)", () => {
  const ENV = WORKSHOP_RECEIPT_KEY_FILE_ENV;
  const KEY_HEX = "a".repeat(64);
  let dir: string | null = null;

  afterEach(() => {
    delete process.env[ENV]; // path-keyed cache: clearing the path drops the cached key
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  function writeKeyFile(content: string, mode = 0o600): string {
    dir = mkdtempSync(path.join(os.tmpdir(), "wrk-key-"));
    const p = path.join(dir, "workshop_hmac.key");
    writeFileSync(p, content);
    chmodSync(p, mode); // exact perms (writeFileSync mode is umask-masked)
    return p;
  }

  it("reads the key from the configured 0600 file and signs with it", () => {
    process.env[ENV] = writeKeyFile(KEY_HEX);
    expect(isReceiptKeyConfigured()).toBe(true);
    const receipt = baseReceipt();
    // No key arg → resolves from the file; must equal signing with the same key explicitly.
    expect(computeReceiptMac(receipt)).toBe(computeReceiptMac(receipt, Buffer.from(KEY_HEX, "utf-8")));
  });

  it("is not configured (and refuses to sign) when no key file path is set", () => {
    delete process.env[ENV];
    expect(isReceiptKeyConfigured()).toBe(false);
    expect(() => computeReceiptMac(baseReceipt())).toThrow(WorkshopReceiptError);
    expect(() => computeReceiptMac(baseReceipt())).toThrow(new RegExp(ENV));
  });

  it("fails closed on a malformed (non-64-hex) key file", () => {
    process.env[ENV] = writeKeyFile("not-a-valid-key");
    expect(isReceiptKeyConfigured()).toBe(false);
    expect(() => computeReceiptMac(baseReceipt())).toThrow(/malformed/);
  });

  it("fails closed on a group/other-readable key file", () => {
    process.env[ENV] = writeKeyFile(KEY_HEX, 0o644);
    expect(isReceiptKeyConfigured()).toBe(false);
    expect(() => computeReceiptMac(baseReceipt())).toThrow(/unsafe permissions/);
  });

  it("fails closed on a hard-linked key file (parity with the Python provisioner)", () => {
    const keyPath = writeKeyFile(KEY_HEX);
    linkSync(keyPath, path.join(dir!, "alias.key")); // nlink -> 2: a second readable path
    process.env[ENV] = keyPath;
    expect(isReceiptKeyConfigured()).toBe(false);
    expect(() => computeReceiptMac(baseReceipt())).toThrow(/hard-linked/);
  });
});

// NB: this describe runs LAST — loadAndScrubReceiptKeyFilePath() pins the key for the rest of the
// module's lifetime, so any test after it would see the pin. Keep it at the end of the file.
describe("workshop receipt — boot pin + path scrub (defence in depth)", () => {
  const ENV = WORKSHOP_RECEIPT_KEY_FILE_ENV;

  it("pins the key and DELETES the path env so no spawned child is handed it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wrk-boot-"));
    try {
      const keyHex = "b".repeat(64);
      const p = path.join(dir, "workshop_hmac.key");
      writeFileSync(p, keyHex);
      chmodSync(p, 0o600);
      process.env[ENV] = p;
      loadAndScrubReceiptKeyFilePath();
      // Path scrubbed from process.env: children spawned after boot don't inherit it.
      expect(process.env[ENV]).toBeUndefined();
      // Verification still works, reading the boot pin (path env is gone).
      expect(isReceiptKeyConfigured()).toBe(true);
      const receipt = baseReceipt();
      expect(computeReceiptMac(receipt)).toBe(computeReceiptMac(receipt, Buffer.from(keyHex, "utf-8")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
