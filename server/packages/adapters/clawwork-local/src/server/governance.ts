import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

/**
 * SuperClaw soft governance for the ClawWork adapter.
 *
 * Posture (owner decision: soft prompt governance, do not cage the runtime, hard
 * gates ONLY for payment / outbound-scan): the adapter writes the SAME signed
 * policy snapshot the in-process `superclaw-governance.ts` extension verifies, so
 * the extension's pay/scan hard gate + posture projection runs in-process. The
 * `--tools` argv bound is a cheap soft fence (the agent cannot rewrite argv mid
 * run). This is NOT network containment.
 *
 * Wire contract — must stay in lockstep with the extension
 * (third_party/clawwork/extensions/superclaw-governance.ts):
 *
 *   envelope = { payload: "<json string>", signature: "<hex hmac-sha256>" }
 *   payload  = { version: 1, mode, allowed_tools, disallowed_tools,
 *                pay_switch: { enabled: bool }, issued_at: number, run_id }
 *
 * The writer and the verifier are BOTH TypeScript and we control both, so the
 * snapshot only needs internal consistency (sign the exact string we emit as
 * `payload`); it does not have to be byte-identical with the Python kernel's
 * snapshot. Tool names are lower-cased / trimmed / deduped before signing, which
 * the extension also does, so a `Bash` vs `bash` convention mismatch cannot fail
 * open.
 */

export const SNAPSHOT_VERSION = 1;

// ClawWork's whole tool universe is read/bash/edit/write/grep/find/ls; the
// read-only postures keep only the non-mutating subset (mirrors the Python
// ClawWorkBackend._CLAWWORK_READONLY_TOOLS / _CLAWWORK_EDITS_OK_TOOLS).
const CLAWWORK_READONLY_TOOLS = ["read", "grep", "find", "ls"];
const CLAWWORK_EDITS_OK_TOOLS = ["read", "grep", "find", "ls", "write", "edit"];

const POLICY_SNAPSHOT_ENV = "SUPERCLAW_POLICY_SNAPSHOT";
const POLICY_SNAPSHOT_KEY_ENV = "SUPERCLAW_POLICY_SNAPSHOT_KEY";
const GOVERNANCE_EXT_ENV = "SUPERCLAW_CLAWWORK_GOVERNANCE_EXT";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Canonical SuperClaw permission modes. Normalized case-insensitively so a
// stray "Plan" / "BYPASSPERMISSIONS" cannot slip past the exact-match logic in
// both this allowlist AND the governance extension (which compares
// `policy.mode === "plan"` verbatim) — the snapshot and the --tools bound must
// agree on the same canonical string.
const CANONICAL_MODES: Record<string, string> = {
  plan: "plan",
  default: "default",
  acceptedits: "acceptEdits",
  auto: "auto",
  bypasspermissions: "bypassPermissions",
  dontask: "dontAsk",
  ask: "ask",
};

export function normalizePermissionMode(mode: string | null | undefined): string {
  const lower = (mode ?? "").trim().toLowerCase();
  if (!lower) return "";
  return CANONICAL_MODES[lower] ?? lower;
}

export function canonicalizeToolNames(names: string[] | null | undefined): string[] {
  const seen: string[] = [];
  for (const name of names ?? []) {
    const canonical = String(name).trim().toLowerCase();
    if (canonical && !seen.includes(canonical)) seen.push(canonical);
  }
  return seen;
}

export interface PolicyPayload {
  version: number;
  mode: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  pay_switch: { enabled: boolean };
  issued_at: number;
  run_id: string;
}

export function buildPolicyPayload(input: {
  mode: string;
  allowedTools: string[] | null | undefined;
  disallowedTools: string[] | null | undefined;
  paySwitchEnabled: boolean;
  runId: string;
  issuedAt: number;
}): PolicyPayload {
  return {
    version: SNAPSHOT_VERSION,
    mode: input.mode,
    allowed_tools: canonicalizeToolNames(input.allowedTools),
    disallowed_tools: canonicalizeToolNames(input.disallowedTools),
    pay_switch: { enabled: Boolean(input.paySwitchEnabled) },
    issued_at: input.issuedAt,
    run_id: input.runId,
  };
}

export function signPayloadString(payloadString: string, key: string): string {
  return createHmac("sha256", key).update(payloadString, "utf-8").digest("hex");
}

export interface PolicySnapshotHandle {
  path: string;
  /** Per-run HMAC secret; never persisted, lives only in the child env. */
  key: string;
  env(): Record<string, string>;
}

/**
 * Write a signed snapshot file under `directory` (0600 — it carries the run's
 * governance authority and the signature alongside) and return its handle. The
 * HMAC key is a fresh per-run secret unless one is supplied (tests).
 */
export function writePolicySnapshot(input: {
  directory: string;
  mode: string;
  allowedTools: string[] | null | undefined;
  disallowedTools: string[] | null | undefined;
  paySwitchEnabled: boolean;
  runId: string;
  issuedAt: number;
  key?: string;
}): PolicySnapshotHandle {
  fs.mkdirSync(input.directory, { recursive: true });
  const secret = input.key ?? randomBytes(32).toString("hex");
  const payload = buildPolicyPayload({
    mode: input.mode,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    paySwitchEnabled: input.paySwitchEnabled,
    runId: input.runId,
    issuedAt: input.issuedAt,
  });
  const payloadString = JSON.stringify(payload);
  const signature = signPayloadString(payloadString, secret);
  const envelope = JSON.stringify({ payload: payloadString, signature });
  // Sanitize the run id for the filename only; the authoritative run id stays in
  // the signed payload.
  const safeRunId = String(input.runId).replace(/[^A-Za-z0-9._-]/g, "-") || "run";
  const snapshotPath = path.join(input.directory, `clawwork-policy-${safeRunId}.json`);
  fs.writeFileSync(snapshotPath, envelope, { mode: 0o600 });
  // writeFileSync's mode is masked by umask on creation; force it.
  try {
    fs.chmodSync(snapshotPath, 0o600);
  } catch {
    /* best-effort; the dir is already adapter-owned */
  }
  return {
    path: snapshotPath,
    key: secret,
    env(): Record<string, string> {
      return {
        [POLICY_SNAPSHOT_ENV]: this.path,
        [POLICY_SNAPSHOT_KEY_ENV]: this.key,
      };
    },
  };
}

/**
 * Translate a SuperClaw soft posture into ClawWork's `--tools` allowlist, or
 * `null` when no CLI-layer restriction applies. Mirrors the Python
 * ClawWorkBackend._clawwork_tool_allowlist precedence EXACTLY (plan wins over an
 * explicit allowlist; a missing/default posture is the read-only bound, never
 * unrestricted). The list drives ClawWork's own `--tools` flag so a blocked tool
 * is never even enabled — a cheap soft fence the agent cannot rewrite (argv is
 * fixed at spawn).
 */
export function clawworkToolAllowlist(
  mode: string | null | undefined,
  allowedTools: string[] | null | undefined,
): string[] | null {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "plan") return [...CLAWWORK_READONLY_TOOLS];
  const explicit = canonicalizeToolNames(allowedTools);
  if (explicit.length > 0) return explicit;
  if (normalized === "acceptEdits" || normalized === "auto" || normalized === "ask") {
    return [...CLAWWORK_EDITS_OK_TOOLS];
  }
  if (normalized === "bypassPermissions" || normalized === "dontAsk") return null;
  // default and any unknown mode -> read-only bound at the CLI layer. NOTE: the
  // adapter's effective DEFAULT posture is bypassPermissions (set in execute.ts),
  // so an UNCONFIGURED agent never lands here — only an explicit "default"/unknown
  // does, which is a deliberate restriction.
  return [...CLAWWORK_READONLY_TOOLS];
}

/**
 * Resolve the canonical `superclaw-governance.ts` path the spawn loads via `-e`.
 * Env override wins; otherwise walk up from this module to the repo root and look
 * for the vendored copy. Returns `null` when neither resolves — the caller MUST
 * fail closed (the pay/scan hard gate is the one hard control SuperClaw keeps
 * under the soft posture, so a run without the governance extension is refused).
 */
export function resolveGovernanceExtPath(): string | null {
  const override = process.env[GOVERNANCE_EXT_ENV];
  if (override && override.trim() && fileExists(override.trim())) {
    return override.trim();
  }
  // Walk up looking for third_party/clawwork/extensions/superclaw-governance.ts.
  let dir = __moduleDir;
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(
      dir,
      "third_party",
      "clawwork",
      "extensions",
      "superclaw-governance.ts",
    );
    if (fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
