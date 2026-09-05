/**
 * SuperClaw governance extension for ClawWork (D4: policy-snapshot governance).
 *
 * Policy is defined ONCE in the SuperClaw Python kernel and executed in two
 * places: Python `backends.py` (CLI backends) and this TS extension (ClawWork
 * runs). The kernel writes a SIGNED JSON snapshot before spawning ClawWork and
 * points `SUPERCLAW_POLICY_SNAPSHOT` at it; the HMAC key for THIS run arrives
 * via `SUPERCLAW_POLICY_SNAPSHOT_KEY` (per-run secret, never persisted).
 *
 * Fail-closed contract (every failure path blocks ALL tools):
 * - env var missing            -> block (a governed run must carry a snapshot)
 * - file unreadable / bad JSON -> block
 * - signature missing/invalid  -> block (a tampered snapshot must not widen)
 *
 * tool_call contract (spike 2): this handler NEVER mutates `event.input` —
 * ClawWork does not re-validate mutated inputs, so mutation is forbidden here;
 * the contract test asserts the input object is untouched.
 *
 * Headless human gate (spike 3): RPC mode has no usable `ctx.ui.confirm`, so
 * anything that would need a human is BLOCKED with a reason; when
 * `SUPERCLAW_API_BASE` (+ optional `SUPERCLAW_CONTROL_TOKEN`) is set, an
 * approval request is POSTed to the local SuperClaw API so the gate surfaces
 * in the SuperClaw UI. The block never waits on that POST (fire-and-forget).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PolicySnapshot = {
	version: number;
	mode: string;
	allowed_tools: string[];
	disallowed_tools: string[];
	pay_switch: { enabled: boolean };
	issued_at: number;
	run_id: string;
};

type LoadedPolicy =
	| { ok: true; policy: PolicySnapshot }
	| { ok: false; reason: string };

// Tools that mutate the workspace or execute commands. Read-only postures
// (mode=plan) block these; everything else stays allowed unless listed in
// disallowed_tools. Mirrors superclaw.permissions posture semantics.
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

// Payment / scan intents are hard-gated regardless of permission mode
// (SuperClaw iron rule: pay is never on the default path; scans are
// fail-closed pending human approval). Matched against bash commands.
// Best-effort FIRST-layer gate (the authoritative network-scan / payment
// fail-closed lives in the SuperClaw kernel's fusion/plugin hard gates; this
// catches the obvious shell forms before they run inside ClawWork). Widened
// from the initial draft per review — still keyword-based, so the read-only
// posture below (driven into ClawWork's own `--tools` allowlist by the
// backend) is the real bound for untrusted runs.
// Exported for the bypass spike (spike-hardgate-bypass.mjs) so the regexes
// are tested directly — never copy them into a test, or the test drifts.
export const HARD_GATE_PATTERNS: { pattern: RegExp; intent: string }[] = [
	{ pattern: /\b(nmap|masscan|zmap|nikto|sqlmap|nuclei|httpx|naabu|dirb|gobuster|ffuf|wpscan|hydra|medusa)\b/i, intent: "network_scan" },
	// curl/wget reaching a non-loopback host is a probe/exfil surface. The
	// negative lookahead exempts loopback ONLY when it is the real host: the
	// optional userinfo (`localhost@evil.com`) and a trailing boundary
	// (`127.0.0.1.evil.com`, `localhost:80@evil.com`) are required, so the
	// classic SSRF-style bypasses fall through to a block. The loopback host
	// must be followed by end-of-string, a port, or a `/?#` delimiter — a `@`
	// or `.` after it means the real host is elsewhere.
	{ pattern: /\b(curl|wget)\b[^\n]*\bhttps?:\/\/(?!(?:[^@/\s?#]+@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:$|[/?#\s]))/i, intent: "network_scan" },
	{ pattern: /\b(stripe|paypal|alipay|wechatpay|venmo|cashapp|coinbase)\b/i, intent: "payment" },
	{ pattern: /\bpay-?switch\b/i, intent: "payment" },
];

function constantTimeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length || a.length === 0) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
	} catch {
		return false;
	}
}

function loadPolicy(): LoadedPolicy {
	const snapshotPath = process.env.SUPERCLAW_POLICY_SNAPSHOT;
	const key = process.env.SUPERCLAW_POLICY_SNAPSHOT_KEY;
	if (!snapshotPath) return { ok: false, reason: "SUPERCLAW_POLICY_SNAPSHOT is not set" };
	if (!key) return { ok: false, reason: "SUPERCLAW_POLICY_SNAPSHOT_KEY is not set" };

	let raw: string;
	try {
		raw = readFileSync(snapshotPath, "utf-8");
	} catch (e) {
		return { ok: false, reason: `policy snapshot unreadable: ${String(e)}` };
	}

	let envelope: { payload?: string; signature?: string };
	try {
		envelope = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "policy snapshot is not valid JSON" };
	}
	if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
		return { ok: false, reason: "policy snapshot envelope missing payload/signature" };
	}

	const expected = createHmac("sha256", key).update(envelope.payload, "utf-8").digest("hex");
	if (!constantTimeEqualHex(expected, envelope.signature)) {
		return { ok: false, reason: "policy snapshot signature invalid" };
	}

	let policy: PolicySnapshot;
	try {
		policy = JSON.parse(envelope.payload);
	} catch {
		return { ok: false, reason: "policy snapshot payload is not valid JSON" };
	}
	if (policy.version !== 1) {
		// An unknown snapshot version must not be interpreted optimistically.
		return { ok: false, reason: `unsupported policy snapshot version: ${policy.version}` };
	}
	return { ok: true, policy };
}

function postApprovalRequest(detail: Record<string, unknown>): void {
	const base = process.env.SUPERCLAW_API_BASE;
	if (!base) return;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	const token = process.env.SUPERCLAW_CONTROL_TOKEN;
	if (token) headers["X-SuperClaw-Token"] = token;
	// Fire-and-forget: the block decision must never depend on this network hop.
	void fetch(`${base.replace(/\/$/, "")}/api/governance/approvals`, {
		method: "POST",
		headers,
		body: JSON.stringify(detail),
	}).catch(() => {});
}

export default function (pi: ExtensionAPI) {
	const loaded = loadPolicy();

	pi.on("tool_call", async (event, _ctx) => {
		// Fail-closed: without a valid signed snapshot, EVERY tool is blocked.
		if (!loaded.ok) {
			return { block: true, reason: `SuperClaw governance: ${loaded.reason} (fail-closed)` };
		}
		const policy = loaded.policy;
		// Case-insensitive comparisons throughout: the kernel canonicalizes
		// (lower-cases) tool lists before signing, and this side lower-cases
		// again so a convention mismatch ("Bash" vs "bash") can never fail
		// open. ClawWork tool names are all lower-case already.
		const toolName = String(event.toolName ?? "").trim().toLowerCase();
		const disallowed = policy.disallowed_tools.map((t) => String(t).trim().toLowerCase());
		const allowed = policy.allowed_tools.map((t) => String(t).trim().toLowerCase());

		// 1. Explicit denylist always wins.
		if (disallowed.includes(toolName)) {
			return { block: true, reason: `SuperClaw governance: tool '${toolName}' is disallowed by policy` };
		}

		// 2. Explicit allowlist (when non-empty) is exhaustive.
		if (allowed.length > 0 && !allowed.includes(toolName)) {
			return { block: true, reason: `SuperClaw governance: tool '${toolName}' is not in the policy allowlist` };
		}

		// 3. Hard gates: pay / scan intents need a human regardless of mode.
		//    Headless has no confirm prompt, so block + surface an approval item.
		if (toolName === "bash") {
			const command = String((event.input as { command?: unknown })?.command ?? "");
			for (const { pattern, intent } of HARD_GATE_PATTERNS) {
				if (pattern.test(command)) {
					postApprovalRequest({
						source: "clawwork-governance",
						run_id: policy.run_id,
						intent,
						tool: toolName,
						command,
					});
					return {
						block: true,
						reason:
							`SuperClaw governance: '${intent}' intent requires human approval ` +
							"(blocked; an approval request was sent best-effort to SuperClaw — " +
							"approve there and re-run)",
					};
				}
			}
		}

		// 4. Permission posture. RPC mode is headless — nothing can ever ASK —
		//    so any tool the posture would prompt about is blocked, fail-closed:
		//    - plan: every mutating tool, regardless of explicit allowlists.
		//    - acceptEdits/auto: edits are pre-accepted, commands would ask ->
		//      bash is blocked (unless explicitly pre-approved via allowlist).
		//    - bypassPermissions/dontAsk: nothing would ask -> no posture block.
		//    - default and any unknown mode: would ask for every mutation ->
		//      every mutating tool is blocked.
		//    Mirrors ClawWorkBackend._clawwork_tool_allowlist (the CLI --tools
		//    hard gate); this layer must never be LOOSER than that one.
		if (MUTATING_TOOLS.has(toolName)) {
			if (policy.mode === "plan") {
				return {
					block: true,
					reason: `SuperClaw governance: read-only mode (plan) forbids '${toolName}'`,
				};
			}
			const preApproved = allowed.includes(toolName);
			if (!preApproved) {
				const editsPreAccepted = policy.mode === "acceptEdits" || policy.mode === "auto";
				const nothingAsks = policy.mode === "bypassPermissions" || policy.mode === "dontAsk";
				const wouldAsk = !nothingAsks && (!editsPreAccepted || toolName === "bash");
				if (wouldAsk) {
					return {
						block: true,
						reason:
							`SuperClaw governance: permission mode '${policy.mode}' would require ` +
							`approval for '${toolName}', and headless RPC cannot ask (fail-closed; ` +
							"re-run with an allow posture or pre-approve the tool explicitly)",
					};
				}
			}
		}

		// NOTE: never mutate event.input here (spike 2: ClawWork does not
		// re-validate mutated inputs). Pass-through means allow.
		return undefined;
	});

	// Liveness handshake — written ONLY AFTER the tool_call handler is registered
	// above, so the file proves the gate is live. ClawWork's loader catches a
	// failed `-e` load and CONTINUES (the handler never registers), which would
	// silently un-govern the run; the SuperClaw backend waits for this file
	// before sending the first prompt and fail-closes (kills the run) if it
	// never appears. The backend validates the CONTENT (handler_registered +
	// the per-spawn nonce it issued via SUPERCLAW_GOVERNANCE_NONCE), so a stale
	// file from an earlier attempt of the same run can never satisfy the
	// handshake. A loaded-but-invalid policy still writes the file (the handler
	// IS registered) and is enforced by the block-all path above.
	const readyFile = process.env.SUPERCLAW_GOVERNANCE_READY_FILE;
	if (readyFile) {
		try {
			writeFileSync(
				readyFile,
				JSON.stringify({
					active: true,
					handler_registered: true,
					policy_ok: loaded.ok,
					nonce: process.env.SUPERCLAW_GOVERNANCE_NONCE ?? null,
				}),
				{ mode: 0o600 },
			);
		} catch {
			/* the backend's timeout is the backstop if this write fails */
		}
	}
}
