#!/usr/bin/env node
/**
 * Spike gate 5: headless permission-posture projection.
 *
 * RPC mode can never ASK, so the governance extension must project every
 * would-ask posture onto a hard block (fail-closed), and must NOT block the
 * never-ask postures (otherwise the backend would be uselessly strict):
 *
 *   A. mode=acceptEdits  -> bash blocked (commands would ask).
 *   B. mode=default      -> bash blocked (everything would ask).
 *   C. mode=bypassPermissions -> bash EXECUTES (positive control: the chain
 *      passes through, proving A/B block via posture, not by accident).
 *   D. mode=acceptEdits + allowed_tools=["bash"] -> bash EXECUTES (an explicit
 *      allowlist is the pre-approved set; posture must not override it).
 *
 * Mirrors ClawWorkBackend._clawwork_tool_allowlist; the extension layer must
 * never be LOOSER than the CLI --tools hard gate.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const cli = join(repo, "packages/coding-agent/dist/cli.js");

function signedSnapshot(work, { mode, allowed = [], disallowed = [] }) {
	const key = "spike-posture-key";
	const payload = JSON.stringify({
		version: 1,
		mode,
		allowed_tools: allowed,
		disallowed_tools: disallowed,
		pay_switch: { enabled: false },
		issued_at: Date.now() / 1000,
		run_id: "spike-posture",
	});
	const signature = createHmac("sha256", key).update(payload, "utf-8").digest("hex");
	const snapshotPath = join(work, "policy-snapshot.json");
	writeFileSync(snapshotPath, JSON.stringify({ payload, signature }));
	return { snapshotPath, key };
}

function runOnce({ name, mode, allowed, disallowed, expectExecuted, expectBlockMarker }) {
	return new Promise((resolve) => {
		const work = mkdtempSync(join(tmpdir(), `clawwork-posture-${name}-`));
		const agentDir = join(work, "agent");
		mkdirSync(agentDir, { recursive: true });
		const { snapshotPath, key } = signedSnapshot(work, { mode, allowed, disallowed });
		const child = spawn(
			process.execPath,
			[
				cli,
				"--mode", "rpc", "--no-session",
				"--provider", "mockprov", "--model", "mock-tool-caller",
				"-e", join(here, "mock-toolcall-provider.ts"),
				"-e", join(repo, "extensions/superclaw-governance.ts"),
			],
			{
				cwd: work,
				env: {
					...process.env,
					CLAWWORK_CODING_AGENT_DIR: agentDir,
					SUPERCLAW_POLICY_SNAPSHOT: snapshotPath,
					SUPERCLAW_POLICY_SNAPSHOT_KEY: key,
					MOCKPROV_API_KEY: "mock-key",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const events = [];
		let buffer = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ name, ok: false, why: "timeout", events });
		}, 60_000);
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf-8");
			let idx;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx).replace(/\r$/, "");
				buffer = buffer.slice(idx + 1);
				if (!line.trim()) continue;
				try { events.push(JSON.parse(line)); } catch { /* ignore */ }
			}
			if (!events.some((e) => e.type === "agent_end")) return;
			clearTimeout(timer);
			child.kill("SIGTERM");
			const s = JSON.stringify(events);
			// `ls -la` output betrays real execution ("total " line / drwx perms).
			const executed = s.includes("\\ntotal ") || /drwx/.test(s);
			if (expectExecuted) {
				resolve({
					name,
					ok: executed && !s.includes("SuperClaw governance:"),
					why: executed ? "unexpected governance block" : "bash did not actually execute",
					events,
				});
			} else {
				const blocked = s.includes(expectBlockMarker);
				resolve({
					name,
					ok: blocked && !executed,
					why: blocked ? (executed ? "tool executed despite block" : "") : `block marker missing: ${expectBlockMarker}`,
					events,
				});
			}
		});
		child.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: "go" }) + "\n");
	});
}

const results = [];
results.push(await runOnce({
	name: "acceptEdits-blocks-bash", mode: "acceptEdits",
	expectExecuted: false,
	expectBlockMarker: "permission mode 'acceptEdits' would require approval for 'bash'",
}));
results.push(await runOnce({
	name: "default-blocks-bash", mode: "default",
	expectExecuted: false,
	expectBlockMarker: "permission mode 'default' would require approval for 'bash'",
}));
results.push(await runOnce({
	name: "bypass-allows-bash", mode: "bypassPermissions",
	expectExecuted: true,
}));
results.push(await runOnce({
	name: "explicit-allowlist-preapproves-bash", mode: "acceptEdits", allowed: ["bash"],
	expectExecuted: true,
}));
// Defense in depth: even if a producer skipped kernel canonicalization, a
// Claude-convention "Bash" denylist entry must still match the lower-case
// tool name — a case mismatch must never fail open.
results.push(await runOnce({
	name: "uppercase-denylist-still-blocks", mode: "bypassPermissions", disallowed: ["Bash"],
	expectExecuted: false,
	expectBlockMarker: "tool 'bash' is disallowed by policy",
}));

let failed = false;
for (const r of results) {
	if (r.ok) {
		console.log(`SPIKE PASS: ${r.name}`);
	} else {
		failed = true;
		console.error(`SPIKE FAIL: ${r.name}: ${r.why}`);
		for (const e of r.events.slice(-6)) console.error(JSON.stringify(e).slice(0, 300));
	}
}
process.exit(failed ? 1 : 0);
