import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { verifyOfficialCosignature } from "../trust/cosign.js";
import { computeKeyid, verifyEnvelope, verifyEnvelopeJson } from "../trust/envelope.js";
import { TrustContractError, jcsCanonicalize, nfcNormalize, parseTrustJson } from "../trust/jcs.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

interface GoldenVectors {
  jcs: Array<{ name: string; input: unknown; expected_hex: string }>;
  nfc_then_jcs: Array<{ name: string; input: unknown; expected_hex: string }>;
  keyid: Array<{ public_key: string; keyid: string }>;
  verify: Array<{
    name: string;
    envelope: unknown;
    keys: Record<string, unknown>;
    threshold: number;
    expect: "ok" | "fail";
    verified?: string[];
  }>;
  cosign: Array<{
    name: string;
    entry: Record<string, unknown>;
    official_public_key: string;
    expect: boolean;
  }>;
}

const golden: GoldenVectors = JSON.parse(
  readFileSync(new URL("./fixtures/trust-golden-vectors.json", import.meta.url), "utf-8"),
);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("JCS canonicalization — byte-exact parity with trust_contracts.jcs_canonicalize", () => {
  for (const vec of golden.jcs) {
    it(`jcs: ${vec.name}`, () => {
      expect(hex(jcsCanonicalize(vec.input))).toBe(vec.expected_hex);
    });
  }
});

describe("NFC-then-JCS parity (verify path message = JCS(NFC(signed)))", () => {
  for (const vec of golden.nfc_then_jcs) {
    it(`nfc+jcs: ${vec.name}`, () => {
      expect(hex(jcsCanonicalize(nfcNormalize(vec.input)))).toBe(vec.expected_hex);
    });
  }
});

describe("keyid derivation — parity with trust_contracts.compute_keyid", () => {
  for (const vec of golden.keyid) {
    it(`keyid for ${vec.public_key.slice(0, 20)}…`, () => {
      expect(computeKeyid(vec.public_key)).toBe(vec.keyid);
    });
  }
});

describe("verify_envelope — parity with trust_contracts.verify_envelope", () => {
  for (const vec of golden.verify) {
    it(`verify: ${vec.name}`, () => {
      if (vec.expect === "ok") {
        const verified = verifyEnvelope(vec.envelope, vec.keys, { threshold: vec.threshold });
        expect([...verified].sort()).toEqual((vec.verified ?? []).slice().sort());
      } else {
        expect(() => verifyEnvelope(vec.envelope, vec.keys, { threshold: vec.threshold })).toThrow(
          TrustContractError,
        );
      }
    });
  }
});

describe("trust primitives — fail-closed guards", () => {
  it("rejects floats", () => {
    expect(() => jcsCanonicalize(1.5)).toThrow(TrustContractError);
  });

  it("rejects integers outside the JS safe range", () => {
    expect(() => jcsCanonicalize(2 ** 53)).toThrow(TrustContractError);
  });

  it("rejects an NFC key collision (precomposed vs decomposed)", () => {
    // Built from explicit code points (ASCII-only source) so neither the editor nor
    // the object literal can collapse the two distinct raw keys before the guard runs.
    const precomposed = String.fromCharCode(0x00e9); // precomposed "é"
    const decomposed = "e" + String.fromCharCode(0x0301); // "e" + combining acute → folds to U+00E9
    const colliding: Record<string, number> = {};
    colliding[precomposed] = 1;
    colliding[decomposed] = 2;
    expect(() => nfcNormalize(colliding)).toThrow(TrustContractError);
  });

  it("rejects a non-positive threshold", () => {
    const vec = golden.verify.find((v) => v.expect === "ok" && v.threshold === 1)!;
    expect(() => verifyEnvelope(vec.envelope, vec.keys, { threshold: 0 })).toThrow(TrustContractError);
  });

  it("rejects a public key without the ed25519: prefix", () => {
    const bare = golden.keyid[0].public_key.slice("ed25519:".length);
    expect(() => computeKeyid(bare)).toThrow(TrustContractError);
  });

  it("rejects a malformed envelope shape", () => {
    expect(() => verifyEnvelope({ signed: [], signatures: [] }, {})).toThrow(TrustContractError);
    expect(() => verifyEnvelope({ signed: {}, signatures: {} }, {})).toThrow(TrustContractError);
  });

  it("rejects a non-canonical signature base64 (embedded newline) the kernel would reject", () => {
    const vec = golden.verify.find((v) => v.name === "valid_single_threshold1")!;
    const tampered = clone(vec);
    const sig = (tampered.envelope as { signatures: Array<{ sig: string }> }).signatures[0].sig;
    // Inject a newline into the otherwise-valid base64 — Buffer.from would ignore it,
    // but the canonical roundtrip check must reject it (parity with validate=True).
    (tampered.envelope as { signatures: Array<{ sig: string }> }).signatures[0].sig =
      sig.slice(0, 12) + "\n" + sig.slice(12);
    expect(() => verifyEnvelope(tampered.envelope, tampered.keys, { threshold: 1 })).toThrow(
      TrustContractError,
    );
  });

  it("rejects an explicit null threshold (no fail-open to 1)", () => {
    const vec = golden.verify.find((v) => v.expect === "ok" && v.threshold === 1)!;
    expect(() =>
      verifyEnvelope(vec.envelope, vec.keys, { threshold: null as unknown as number }),
    ).toThrow(TrustContractError);
  });
});

describe("parseTrustJson — rejects float number literals (parity with Python json.loads → float)", () => {
  it("accepts integer-only JSON", () => {
    expect(parseTrustJson('{"n":7,"a":[-1,0,9007199254740991]}')).toEqual({
      n: 7,
      a: [-1, 0, 9007199254740991],
    });
  });

  it("rejects a float that JSON.parse would collapse to an int (7.0)", () => {
    expect(() => parseTrustJson('{"n":7.0}')).toThrow(TrustContractError);
  });

  it("rejects fractional and exponent forms", () => {
    expect(() => parseTrustJson('{"x":0.5}')).toThrow(TrustContractError);
    expect(() => parseTrustJson('{"x":1e3}')).toThrow(TrustContractError);
    expect(() => parseTrustJson('{"x":1E5}')).toThrow(TrustContractError);
    expect(() => parseTrustJson('[1.2e-3]')).toThrow(TrustContractError);
  });

  it("ignores float-looking content inside strings", () => {
    expect(parseTrustJson('{"v":"7.0","u":"1e3"}')).toEqual({ v: "7.0", u: "1e3" });
  });
});

describe("prototype-pollution parity — '__proto__' kept as a real own key", () => {
  it("nfcNormalize writes '__proto__' as an own property (no prototype setter)", () => {
    const normalized = nfcNormalize(JSON.parse('{"__proto__":{"x":1},"a":2}')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(normalized, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf({ polluted: undefined })).not.toHaveProperty("x");
  });

  it("canonicalizes '__proto__' keys byte-identically (covered by proto_key_in_signed_ok vector)", () => {
    // Direct JCS check independent of the verify vector.
    const hexOut = hex(jcsCanonicalize(nfcNormalize(JSON.parse('{"__proto__":1,"a":2}'))));
    const expected = golden.jcs.find((v) => v.name === "proto_pollution_keys");
    // proto_pollution_keys also has a "constructor" key, so just assert the prefix
    // ordering puts "__proto__" first (0x5f < 0x61/0x63) rather than reusing that hex.
    expect(Buffer.from(hexOut, "hex").toString("utf-8").startsWith('{"__proto__":1,')).toBe(true);
    expect(expected).toBeDefined();
  });
});

describe("verifyOfficialCosignature — parity with capability_cosign.verify_official_cosignature", () => {
  for (const vec of golden.cosign) {
    it(`cosign: ${vec.name} → ${vec.expect}`, () => {
      const officialKey = vec.official_public_key === "" ? null : vec.official_public_key;
      expect(verifyOfficialCosignature(vec.entry, officialKey)).toBe(vec.expect);
    });
  }

  it("never trusts a self-reported flag — only the baked key (null key → false)", () => {
    const vec = golden.cosign.find((v) => v.expect === true)!;
    const lying = { ...vec.entry, official_verified: true, verified: true, trust: "official" };
    expect(verifyOfficialCosignature(lying, null)).toBe(false);
    expect(verifyOfficialCosignature(lying, undefined)).toBe(false);
  });

  it("reads OWN properties only — inherited fields do not endorse (parity with dict.get)", () => {
    const vec = golden.cosign.find((v) => v.name === "valid_required_only")!;
    // Zero own fields, but the entire valid entry on the prototype: Python's dict.get
    // sees nothing → false; Node must not inherit the valid signature/core.
    const inherited = Object.create(vec.entry) as Record<string, unknown>;
    expect(verifyOfficialCosignature(inherited, vec.official_public_key)).toBe(false);
  });

  it("does not let an inherited capability_id relax the no-fallback boundary", () => {
    const vec = golden.cosign.find((v) => v.name === "valid_required_only")!;
    // Own copy of everything EXCEPT capability_id, which is only on the prototype.
    const base = { capability_id: vec.entry.capability_id } as Record<string, unknown>;
    const entry = Object.create(base) as Record<string, unknown>;
    for (const [k, v] of Object.entries(vec.entry)) {
      if (k !== "capability_id") entry[k] = v;
    }
    expect(Object.prototype.hasOwnProperty.call(entry, "capability_id")).toBe(false);
    expect(verifyOfficialCosignature(entry, vec.official_public_key)).toBe(false);
  });

  it("rejects a non-object entry", () => {
    expect(verifyOfficialCosignature(null as unknown as Record<string, unknown>, "x")).toBe(false);
    expect(verifyOfficialCosignature([] as unknown as Record<string, unknown>, "x")).toBe(false);
  });
});

describe("verifyEnvelopeJson — blessed raw-JSON entrypoint closes the float gap", () => {
  it("verifies a valid envelope supplied as JSON text", () => {
    const vec = golden.verify.find((v) => v.name === "valid_single_threshold1")!;
    const verified = verifyEnvelopeJson(JSON.stringify(vec.envelope), vec.keys, { threshold: 1 });
    expect(verified.size).toBe(1);
  });

  it("rejects an envelope whose signed payload uses a float literal (7.0)", () => {
    const vec = golden.verify.find((v) => v.name === "valid_single_threshold1")!;
    // Re-serialize then inject a float literal into the signed payload's JSON text.
    const text = JSON.stringify(vec.envelope).replace('"n":7', '"n":7.0');
    expect(text).toContain('"n":7.0');
    expect(() => verifyEnvelopeJson(text, vec.keys, { threshold: 1 })).toThrow(TrustContractError);
  });
});
