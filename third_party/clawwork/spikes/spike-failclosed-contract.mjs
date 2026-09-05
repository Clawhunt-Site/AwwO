#!/usr/bin/env node
/**
 * Spike gate 4 + fail-closed variants (plan §3b):
 *
 * A. Missing snapshot env  -> EVERY tool blocked ("fail-closed").
 * B. Tampered signature    -> EVERY tool blocked.
 * C. Contract pin: the hook/event names this integration depends on must
 *    exist in the pinned ClawWork build (tool_call hook, agent_end /
 *    tool_execution_end events, {block, reason} return). Run BEFORE any
 *    upstream rebase; a failure here means re-audit the integration.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const cli = join(repo, "packages/coding-agent/dist/cli.js");

function runOnce({ name, env }) {
	return new Promise((resolve) => {
		const work = mkdtempSync(join(tmpdir(), `clawwork-fc-${name}-`));
		const agentDir = join(work, "agent");
		mkdirSync(agentDir, { recursive: true });
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
				env: { ...process.env, CLAWWORK_CODING_AGENT_DIR: agentDir, MOCKPROV_API_KEY: "mock-key", ...env },
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
			if (events.some((e) => e.type === "agent_end")) {
				clearTimeout(timer);
				child.kill("SIGTERM");
				const s = JSON.stringify(events);
				const blocked = s.includes("fail-closed");
				const executed = s.includes("\\ntotal ") || /drwx/.test(s);
				resolve({ name, ok: blocked && !executed, why: blocked ? (executed ? "tool executed" : "") : "no fail-closed block", events });
			}
		});
		child.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: "go" }) + "\n");
	});
}

// C. Contract pin (static): the pinned build must still declare exactly the
// surface SuperClaw consumes — the governance extension's hook contract
// (tool_call -> {block, reason}) and the RPC event/command shapes parsed by
// ClawWorkBackend._spawn_rpc (prompt in; tool_execution_end / agent_end with
// messages[].content[] text blocks out).
const extensionTypes = readFileSync(
	join(repo, "packages/coding-agent/dist/core/extensions/types.d.ts"), "utf-8");
const rpcTypes = readFileSync(
	join(repo, "packages/coding-agent/dist/modes/rpc/rpc-types.d.ts"), "utf-8");
const pins = [
	["tool_call hook", /"tool_call"/.test(extensionTypes)],
	["block/reason return", /block/.test(extensionTypes) && /reason/.test(extensionTypes)],
	["tool_execution_end event", /"tool_execution_end"/.test(extensionTypes)],
	["agent_end event", /"agent_end"/.test(extensionTypes)],
	["agent_end messages payload", /messages/.test(extensionTypes)],
	["prompt RPC command", /"prompt"/.test(rpcTypes)],
];
for (const [what, ok] of pins) {
	if (!ok) {
		console.error(`SPIKE FAIL: contract pin missing: ${what} — re-audit before rebasing upstream`);
		process.exit(1);
	}
}

const tamperedWork = mkdtempSync(join(tmpdir(), "clawwork-fc-sig-"));
const payload = JSON.stringify({ version: 1, mode: "bypassPermissions", allowed_tools: [], disallowed_tools: [], pay_switch: { enabled: false }, issued_at: 0, run_id: "x" });
const badSig = createHmac("sha256", "WRONG-KEY").update(payload, "utf-8").digest("hex");
const tamperedPath = join(tamperedWork, "snap.json");
writeFileSync(tamperedPath, JSON.stringify({ payload, signature: badSig }));

const results = [];
results.push(await runOnce({ name: "missing-env", env: { SUPERCLAW_POLICY_SNAPSHOT: "", SUPERCLAW_POLICY_SNAPSHOT_KEY: "" } }));
results.push(await runOnce({ name: "bad-signature", env: { SUPERCLAW_POLICY_SNAPSHOT: tamperedPath, SUPERCLAW_POLICY_SNAPSHOT_KEY: "right-key" } }));

let failed = false;
for (const r of results) {
	if (r.ok) {
		console.log(`SPIKE PASS: ${r.name} -> all tools blocked (fail-closed)`);
	} else {
		failed = true;
		console.error(`SPIKE FAIL: ${r.name}: ${r.why}`);
		for (const e of r.events.slice(-6)) console.error(JSON.stringify(e).slice(0, 300));
	}
}
console.log("SPIKE PASS: contract pins hold (tool_call / block+reason / tool_execution_end / agent_end / prompt)");
process.exit(failed ? 1 : 0);
