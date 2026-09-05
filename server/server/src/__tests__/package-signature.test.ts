import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PackageVerificationError,
  checkRevocation,
  classifySigner,
  pluginRootKey,
  resolveSignatureTrust,
  verifyPackageSignature,
} from "../trust/package-signature.js";

interface Golden {
  signature: {
    digest: string;
    public_key_bare: string;
    public_key_prefixed: string;
    valid_signature: string;
    wrong_signature: string;
    other_public_key_bare: string;
  };
  revocation: {
    id_field: string;
    target: { artifact_id: string; version: string; declared_digest: string; computed_digest: string };
    cases: Array<{ name: string; revocation: unknown; revoked: boolean }>;
  };
}

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/trust-golden-vectors.json", import.meta.url), "utf-8"),
) as Golden;

const sig = golden.signature;
const ROOT_ENV = "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY";
const LOCALDEV_ENV = "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST";
const SAVED = { ...process.env };

beforeEach(() => {
  // Force production so the baked official key (not the test key) is the implicit root,
  // and tests that set the root key do so explicitly.
  process.env.APP_ENV = "production";
  delete process.env[ROOT_ENV];
  delete process.env[LOCALDEV_ENV];
});
afterEach(() => {
  process.env = { ...SAVED };
});

describe("verifyPackageSignature — Ed25519 over the digest string (parity with verify_signature)", () => {
  it("accepts a valid signature with the bare or prefixed public key", () => {
    expect(() => verifyPackageSignature(sig.digest, sig.valid_signature, sig.public_key_bare)).not.toThrow();
    expect(() => verifyPackageSignature(sig.digest, sig.valid_signature, sig.public_key_prefixed)).not.toThrow();
  });

  it("rejects a signature over a different message", () => {
    expect(() => verifyPackageSignature(sig.digest, sig.wrong_signature, sig.public_key_bare)).toThrow(
      PackageVerificationError,
    );
  });

  it("rejects the wrong public key", () => {
    expect(() => verifyPackageSignature(sig.digest, sig.valid_signature, sig.other_public_key_bare)).toThrow(
      PackageVerificationError,
    );
  });

  it("rejects a signature without the ed25519: prefix", () => {
    const bare = sig.valid_signature.slice("ed25519:".length);
    expect(() => verifyPackageSignature(sig.digest, bare, sig.public_key_bare)).toThrow(/unsupported signature format/);
  });

  it("rejects a tampered digest", () => {
    expect(() => verifyPackageSignature(sig.digest + "x", sig.valid_signature, sig.public_key_bare)).toThrow(
      PackageVerificationError,
    );
  });
});

describe("resolveSignatureTrust — admission gate (parity with resolve_signature_trust)", () => {
  it("returns official when an explicit key verifies", () => {
    expect(resolveSignatureTrust(sig.digest, sig.valid_signature, sig.public_key_bare)).toBe("official");
  });

  it("returns official when the root env key verifies (no explicit key)", () => {
    process.env[ROOT_ENV] = sig.public_key_bare;
    expect(resolveSignatureTrust(sig.digest, sig.valid_signature, null)).toBe("official");
  });

  it("raises when no key verifies and local-dev is off (fail-closed)", () => {
    process.env[ROOT_ENV] = sig.other_public_key_bare;
    expect(() => resolveSignatureTrust(sig.digest, sig.valid_signature, null)).toThrow(PackageVerificationError);
  });

  it("returns local_dev when verification fails but local-dev is enabled", () => {
    process.env[ROOT_ENV] = sig.other_public_key_bare;
    process.env[LOCALDEV_ENV] = "1";
    expect(resolveSignatureTrust(sig.digest, sig.valid_signature, null)).toBe("local_dev");
  });

  it("honours the per-call allowLocalDev opt-in", () => {
    process.env[ROOT_ENV] = sig.other_public_key_bare;
    expect(resolveSignatureTrust(sig.digest, sig.valid_signature, null, { allowLocalDev: true })).toBe("local_dev");
  });
});

describe("pluginRootKey — baked key defaults ONLY when env is absent (no clear-then-rearm bypass)", () => {
  it("falls back to the baked official key when the env var is ABSENT", () => {
    delete process.env[ROOT_ENV]; // absent
    expect(pluginRootKey().length).toBeGreaterThan(0); // baked production key
  });

  it("uses an explicitly-set EMPTY env value as-is — never re-arms the baked key", () => {
    process.env[ROOT_ENV] = ""; // operator explicitly cleared root trust
    expect(pluginRootKey()).toBe("");
    // Consequently a valid signature is neither official nor root, and fails closed.
    expect(classifySigner(sig.digest, sig.valid_signature)).toBe("none");
    expect(() => resolveSignatureTrust(sig.digest, sig.valid_signature, null)).toThrow(PackageVerificationError);
  });

  it("resists Object.prototype pollution (own-property check, not the `in` operator)", () => {
    delete process.env[ROOT_ENV]; // genuinely absent
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto[ROOT_ENV] = sig.public_key_bare; // attacker pollutes the prototype
      // Must NOT read the inherited value as a configured root key → falls back to baked.
      expect(pluginRootKey()).not.toBe(sig.public_key_bare);
      expect(classifySigner(sig.digest, sig.valid_signature)).not.toBe("root");
    } finally {
      delete proto[ROOT_ENV];
    }
  });

  it("resists prototype pollution of the local-dev env var", () => {
    process.env[ROOT_ENV] = sig.other_public_key_bare; // root won't verify
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto[LOCALDEV_ENV] = "1"; // pollute, but the real env var is unset
      // Must NOT enable local-dev from the inherited value → stays fail-closed.
      expect(() => resolveSignatureTrust(sig.digest, sig.valid_signature, null)).toThrow(PackageVerificationError);
    } finally {
      delete proto[LOCALDEV_ENV];
    }
  });

  it("resists prototype pollution of resolveSignatureTrust options (rootKey/allowLocalDev)", () => {
    process.env[ROOT_ENV] = sig.other_public_key_bare; // root won't verify
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto.rootKey = sig.public_key_bare; // attacker-controlled key via prototype
      proto.allowLocalDev = true;
      // Default options {} must not inherit these → attacker key not admitted, no local-dev.
      expect(() => resolveSignatureTrust(sig.digest, sig.valid_signature, null)).toThrow(PackageVerificationError);
    } finally {
      delete proto.rootKey;
      delete proto.allowLocalDev;
    }
  });
});

describe("classifySigner — non-raising classification (parity with classify_signer)", () => {
  it("returns root only when the ROOT env key verifies", () => {
    process.env[ROOT_ENV] = sig.public_key_bare;
    expect(classifySigner(sig.digest, sig.valid_signature)).toBe("root");
  });

  it("never lets an explicit/other key read as root", () => {
    process.env[ROOT_ENV] = sig.other_public_key_bare;
    expect(classifySigner(sig.digest, sig.valid_signature)).toBe("none");
  });

  it("returns local_dev when the root key fails and local-dev is enabled", () => {
    process.env[ROOT_ENV] = sig.other_public_key_bare;
    process.env[LOCALDEV_ENV] = "on";
    expect(classifySigner(sig.digest, sig.valid_signature)).toBe("local_dev");
  });

  it("returns none when nothing verifies and local-dev is off", () => {
    process.env[ROOT_ENV] = sig.other_public_key_bare;
    expect(classifySigner(sig.digest, sig.valid_signature)).toBe("none");
  });
});

describe("checkRevocation — parity with check_revocation (kernel-asserted cases)", () => {
  const { target, cases, id_field } = golden.revocation;
  const revTarget = {
    artifactId: target.artifact_id,
    version: target.version,
    declaredDigest: target.declared_digest,
    computedDigest: target.computed_digest,
  };

  for (const c of cases) {
    it(`${c.name} → ${c.revoked ? "revoked" : "allowed"}`, () => {
      if (c.revoked) {
        expect(() => checkRevocation(revTarget, c.revocation, id_field)).toThrow(PackageVerificationError);
      } else {
        expect(() => checkRevocation(revTarget, c.revocation, id_field)).not.toThrow();
      }
    });
  }

  it("is a no-op when there is no revocation data", () => {
    expect(() => checkRevocation(revTarget, null, id_field)).not.toThrow();
    expect(() => checkRevocation(revTarget, undefined, id_field)).not.toThrow();
    expect(() => checkRevocation(revTarget, {}, id_field)).not.toThrow(); // object, no "revoked"
  });

  it("resists Object.prototype.revoked pollution (own-read of the revoked list)", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto.revoked = [{ plugin_id: revTarget.artifactId }]; // would revoke if read inherited
      expect(() => checkRevocation(revTarget, {}, id_field)).not.toThrow(); // {} has no OWN revoked
    } finally {
      delete proto.revoked;
    }
  });

  it("FAILS CLOSED on a non-scalar version/package_digest in an entry (Python unhashable → TypeError)", () => {
    expect(() =>
      checkRevocation(revTarget, { revoked: [{ plugin_id: revTarget.artifactId, version: [] }] }, id_field),
    ).toThrow(PackageVerificationError);
    expect(() =>
      checkRevocation(revTarget, { revoked: [{ plugin_id: revTarget.artifactId, package_digest: {} }] }, id_field),
    ).toThrow(PackageVerificationError);
  });

  it("FAILS CLOSED on malformed revocation data (parity: kernel raises, never allows)", () => {
    expect(() => checkRevocation(revTarget, [], id_field)).toThrow(PackageVerificationError); // top-level array
    expect(() => checkRevocation(revTarget, { revoked: "x" }, id_field)).toThrow(PackageVerificationError);
    expect(() => checkRevocation(revTarget, { revoked: [42] }, id_field)).toThrow(PackageVerificationError);
    expect(() => checkRevocation(revTarget, { revoked: [null] }, id_field)).toThrow(PackageVerificationError);
  });

  it("reads revocation entry fields as OWN properties only (no prototype inheritance)", () => {
    const inheritedEntry = Object.create({ plugin_id: revTarget.artifactId }) as Record<string, unknown>;
    expect(() => checkRevocation(revTarget, { revoked: [inheritedEntry] }, id_field)).not.toThrow();
  });
});
