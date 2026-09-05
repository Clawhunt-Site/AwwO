import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalizeToolNames,
  clawworkToolAllowlist,
  writePolicySnapshot,
  normalizePermissionMode,
  resolveGovernanceExtPath,
} from "./governance.js";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "clawwork-gov-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("canonicalizeToolNames", () => {
  it("lowercases, trims, and dedupes order-preserving", () => {
    expect(canonicalizeToolNames(["Bash", " bash ", "Write", "WRITE"])).toEqual(["bash", "write"]);
  });
  it("drops empties and handles null", () => {
    expect(canonicalizeToolNames(["", "  ", "Read"])).toEqual(["read"]);
    expect(canonicalizeToolNames(null)).toEqual([]);
  });
});

describe("normalizePermissionMode", () => {
  it("maps case-insensitively to the canonical camelCase mode", () => {
    expect(normalizePermissionMode("Plan")).toBe("plan");
    expect(normalizePermissionMode("BYPASSPERMISSIONS")).toBe("bypassPermissions");
    expect(normalizePermissionMode("acceptedits")).toBe("acceptEdits");
    expect(normalizePermissionMode("dontask")).toBe("dontAsk");
  });
  it("returns '' for empty and passes unknown through lowercased", () => {
    expect(normalizePermissionMode("")).toBe("");
    expect(normalizePermissionMode(null)).toBe("");
    expect(normalizePermissionMode("Weird-Mode")).toBe("weird-mode");
  });
});

describe("clawworkToolAllowlist", () => {
  it("plan -> read-only, even over an explicit allowlist (plan wins), case-insensitive", () => {
    expect(clawworkToolAllowlist("plan", ["bash", "write"])).toEqual(["read", "grep", "find", "ls"]);
    expect(clawworkToolAllowlist("PLAN", ["bash"])).toEqual(["read", "grep", "find", "ls"]);
  });
  it("ask -> edits-ok (write/edit, no bash), so an explicit ask is not silently read-only", () => {
    expect(clawworkToolAllowlist("ask", [])).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
  });
  it("explicit allowlist (non-plan) is exhaustive and canonicalized", () => {
    expect(clawworkToolAllowlist("default", ["Bash", "Read"])).toEqual(["bash", "read"]);
  });
  it("acceptEdits / auto -> edits-ok set", () => {
    expect(clawworkToolAllowlist("acceptEdits", [])).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
    expect(clawworkToolAllowlist("auto", null)).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
  });
  it("bypassPermissions / dontAsk -> null (no CLI restriction)", () => {
    expect(clawworkToolAllowlist("bypassPermissions", [])).toBeNull();
    expect(clawworkToolAllowlist("dontAsk", null)).toBeNull();
  });
  it("default / unknown / missing -> read-only bound, never unrestricted", () => {
    expect(clawworkToolAllowlist("default", [])).toEqual(["read", "grep", "find", "ls"]);
    expect(clawworkToolAllowlist("totally-unknown", null)).toEqual(["read", "grep", "find", "ls"]);
    expect(clawworkToolAllowlist(undefined, undefined)).toEqual(["read", "grep", "find", "ls"]);
  });
});

describe("writePolicySnapshot", () => {
  it("writes a 0600 envelope whose signature verifies over the exact payload string", () => {
    const dir = freshDir();
    const handle = writePolicySnapshot({
      directory: dir,
      mode: "plan",
      allowedTools: ["Bash"],
      disallowedTools: ["Web"],
      paySwitchEnabled: false,
      runId: "run_abc",
      issuedAt: 1700000000,
    });
    const raw = fs.readFileSync(handle.path, "utf8");
    const envelope = JSON.parse(raw) as { payload: string; signature: string };
    // The verifier (the governance extension) signs envelope.payload verbatim.
    const expected = createHmac("sha256", handle.key).update(envelope.payload, "utf-8").digest("hex");
    expect(envelope.signature).toBe(expected);
    const payload = JSON.parse(envelope.payload);
    expect(payload.version).toBe(1);
    expect(payload.mode).toBe("plan");
    expect(payload.allowed_tools).toEqual(["bash"]);
    expect(payload.disallowed_tools).toEqual(["web"]);
    expect(payload.pay_switch).toEqual({ enabled: false });
    expect(payload.run_id).toBe("run_abc");
    // File mode is 0600 (only the owner can read the run's governance authority).
    const mode = fs.statSync(handle.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("a tampered payload no longer verifies (fail-closed at the extension)", () => {
    const dir = freshDir();
    const handle = writePolicySnapshot({
      directory: dir,
      mode: "default",
      allowedTools: [],
      disallowedTools: [],
      paySwitchEnabled: false,
      runId: "run_t",
      issuedAt: 1,
    });
    const envelope = JSON.parse(fs.readFileSync(handle.path, "utf8")) as { payload: string; signature: string };
    const tampered = envelope.payload.replace('"mode":"default"', '"mode":"bypassPermissions"');
    const recomputed = createHmac("sha256", handle.key).update(tampered, "utf-8").digest("hex");
    expect(recomputed).not.toBe(envelope.signature);
  });

  it("env() exposes the snapshot path + per-run key", () => {
    const dir = freshDir();
    const handle = writePolicySnapshot({
      directory: dir,
      mode: "default",
      allowedTools: [],
      disallowedTools: [],
      paySwitchEnabled: false,
      runId: "run_e",
      issuedAt: 1,
      key: "deadbeef",
    });
    expect(handle.env()).toEqual({
      SUPERCLAW_POLICY_SNAPSHOT: handle.path,
      SUPERCLAW_POLICY_SNAPSHOT_KEY: "deadbeef",
    });
  });
});

describe("resolveGovernanceExtPath", () => {
  // The kernel (Python node_runtime) now hands this adapter the governance ext via
  // SUPERCLAW_CLAWWORK_GOVERNANCE_EXT (so a frozen/relocated bundle, where the
  // walk-up to third_party/clawwork breaks, still resolves it). These pin the
  // consumption side of that handoff: the env override is read FIRST and a bogus
  // override is never echoed back.
  const ENV = "SUPERCLAW_CLAWWORK_GOVERNANCE_EXT";
  const prevExt = process.env[ENV];
  afterEach(() => {
    if (prevExt === undefined) delete process.env[ENV];
    else process.env[ENV] = prevExt;
  });

  it("honors an explicit override at an existing file, winning over the walk-up", () => {
    const dir = freshDir();
    const ext = path.join(dir, "superclaw-governance.ts");
    fs.writeFileSync(ext, "// gov", "utf-8");
    process.env[ENV] = ext;
    expect(resolveGovernanceExtPath()).toBe(ext);
  });

  it("never echoes back an override that points at a missing file", () => {
    const missing = path.join(os.tmpdir(), `cw-gov-missing-${process.pid}.ts`);
    process.env[ENV] = missing;
    // A non-existent override must NOT be returned (it would mask the adapter's own
    // fail-closed walk-up); the walk-up may still find the in-tree copy, but the
    // bogus path is never propagated.
    expect(resolveGovernanceExtPath()).not.toBe(missing);
  });
});
