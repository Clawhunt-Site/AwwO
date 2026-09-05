import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PackageDigestFile } from "../trust/package-digest.js";
import { PackageVerificationError } from "../trust/package-signature.js";
import { isSkillOriginPlugin, verifyPluginPackage } from "../trust/verify-package.js";

interface VerifyVector {
  name: string;
  manifest: Record<string, unknown>;
  files: Array<{ relative: string; mode_signal: number; content_b64: string }>;
  options: {
    public_key: string | null;
    provenance: "local" | "remote" | null;
    reject_skill_origin: boolean;
    revocation_data: unknown;
  };
  root_env: string | null;
  expect: "ok" | "fail";
  result?: { plugin_id: string; version: string; digest: string; signer_class: string };
}

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/trust-golden-vectors.json", import.meta.url), "utf-8"),
) as { verify_package: VerifyVector[] };

const ROOT_ENV = "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY";
const SAVED = { ...process.env };

beforeEach(() => {
  process.env.APP_ENV = "production"; // baked key is the implicit root unless ROOT_ENV is set
  delete process.env[ROOT_ENV];
  delete process.env.SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST;
});
afterEach(() => {
  process.env = { ...SAVED };
});

const toFiles = (v: VerifyVector): PackageDigestFile[] =>
  v.files.map((f) => ({
    relative: f.relative,
    modeSignal: f.mode_signal,
    content: Buffer.from(f.content_b64, "base64"),
  }));

describe("verifyPluginPackage — parity with the kernel verify_plugin_package", () => {
  for (const vec of golden.verify_package) {
    it(`${vec.name} → ${vec.expect}`, () => {
      if (vec.root_env === null) delete process.env[ROOT_ENV];
      else process.env[ROOT_ENV] = vec.root_env;

      const pkg = { manifest: vec.manifest, files: toFiles(vec) };
      const options = {
        publicKey: vec.options.public_key,
        provenance: vec.options.provenance,
        rejectSkillOrigin: vec.options.reject_skill_origin,
        revocationData: vec.options.revocation_data,
      };

      if (vec.expect === "ok") {
        const out = verifyPluginPackage(pkg, options);
        expect(out.pluginId).toBe(vec.result!.plugin_id);
        expect(out.version).toBe(vec.result!.version);
        expect(out.digest).toBe(vec.result!.digest);
        expect(out.verdict.signerClass).toBe(vec.result!.signer_class);
        expect(out.verdict.integrityOk).toBe(true);
      } else {
        expect(() => verifyPluginPackage(pkg, options)).toThrow(PackageVerificationError);
      }
    });
  }

  it("covers the key gates (ok + digest/sig/external_mcp/skill-origin/revoked failures)", () => {
    const names = golden.verify_package.map((v) => v.name);
    for (const expected of [
      "valid_root_signed",
      "digest_mismatch",
      "bad_signature",
      "external_mcp_non_root_fail",
      "skill_origin_field_rejected",
      "sign_free_local_skill_ok",
      "revoked_fail",
      "runtime_non_object_fail",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("verifyPluginPackage — fail-closed on non-string identity (stricter than kernel str-coercion)", () => {
  const base = golden.verify_package.find((v) => v.name === "valid_root_signed")!;

  it("rejects a non-string id or version (String([]) !== Python str([]) parity hazard)", () => {
    for (const mut of [{ id: [] as unknown }, { version: [] as unknown }]) {
      const manifest = { ...base.manifest, ...mut };
      expect(() => verifyPluginPackage({ manifest, files: toFiles(base) }, {})).toThrow(PackageVerificationError);
    }
  });

  it("rejects a non-string provenance.package_digest / signature", () => {
    const provenance = base.manifest.provenance as Record<string, unknown>;
    const m1 = { ...base.manifest, provenance: { ...provenance, package_digest: [] } };
    const m2 = { ...base.manifest, provenance: { ...provenance, signature: {} } };
    expect(() => verifyPluginPackage({ manifest: m1, files: toFiles(base) }, {})).toThrow(PackageVerificationError);
    expect(() => verifyPluginPackage({ manifest: m2, files: toFiles(base) }, {})).toThrow(PackageVerificationError);
  });
});

describe("isSkillOriginPlugin", () => {
  it("flags the skill_origin field or a reserved skill. id prefix", () => {
    expect(isSkillOriginPlugin("dev.x", true)).toBe(true);
    expect(isSkillOriginPlugin("skill.demo", undefined)).toBe(true);
    expect(isSkillOriginPlugin("dev.x", false)).toBe(false);
    expect(isSkillOriginPlugin("dev.x", undefined)).toBe(false);
  });
});
