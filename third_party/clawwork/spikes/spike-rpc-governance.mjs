#!/usr/bin/env node
/**
 * Spike gate 1+2+3 (docs/clawwork-two-track-dev-plan.md §3b), hermetic:
 *
 * 1. `--mode rpc` headless loads extensions and a `tool_call` `{block, reason}`
 *    decision lands end-to-end (the bash tool must NOT execute).
 * 2. The governance extension never mutates `event.input` (asserted by the
 *    mock provider emitting a fixed command and the transcript echoing it
 *    unchanged inside the block reason path).
 * 3. Headless has no usable `ctx.ui.confirm` — governance BLOCKS instead and
 *    (when SUPERCLAW_API_BASE is set) files an approval; here we assert the
 *    block path works without any UI.
 *
 * Exit 0 = all assertions hold. Any failure exits 1 with a reason.
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

const work = mkdtempSync(join(tmpdir(), "clawwork-spike-"));
const agentDir = join(work, "agent");
mkdirSync(agentDir, { recursive: true });

// Signed policy snapshot: plan (read-only) mode → bash must be blocked.
const key = "spike-secret-key";
const payload = JSON.stringify({
	version: 1,
	mode: "plan",
	allowed_tools: [],
	disallowed_tools: [],
	pay_switch: { enabled: false },
	issued_at: Date.now() / 1000,
	run_id: "spike-run",
});
const signature = createHmac("sha256", key).update(payload, "utf-8").digest("hex");
const snapshotPath = join(work, "policy-snapshot.json");
writeFileSync(snapshotPath, JSON.stringify({ payload, signature }));

const child = spawn(
	process.execPath,
	[
		cli,
		"--mode", "rpc",
		"--no-session",
		"--provider", "mockprov",
		"--model", "mock-tool-caller",
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
			SUPERCLAW_GOVERNANCE_READY_FILE: join(work, "governance-ready.json"),
			SUPERCLAW_GOVERNANCE_NONCE: "spike-nonce-123",
			MOCKPROV_API_KEY: "mock-key",
		},
		stdio: ["pipe", "pipe", "pipe"],
	},
);

const events = [];
let stderr = "";
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf-8");
	let idx;
	while ((idx = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, idx).replace(/\r$/, "");
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			/* non-JSON line — ignore */
		}
	}
});
child.stderr.on("data", (c) => {
	stderr += c.toString("utf-8");
});

function fail(reason) {
	console.error(`SPIKE FAIL: ${reason}`);
	console.error("--- events ---");
	for (const e of events) console.error(JSON.stringify(e));
	console.error("--- stderr ---\n" + stderr.slice(-2000));
	child.kill("SIGKILL");
	process.exit(1);
}

const timeout = setTimeout(() => fail("timed out waiting for agent_end"), 60_000);

child.stdout.on("data", () => {
	const end = events.find((e) => e.type === "agent_end");
	if (!end) return;
	clearTimeout(timeout);

	const serialized = JSON.stringify(events);
	// Gate 1: the governance block reason must appear in a tool result, and the
	// bash tool must not have produced real output (no 'total ' from ls -la).
	if (!serialized.includes("read-only mode (plan) forbids 'bash'")) {
		fail("governance block reason not found in event stream");
	}
	const toolEnds = events.filter((e) => e.type === "tool_execution_end");
	if (toolEnds.length === 0) fail("no tool_execution_end event observed");
	const blocked = toolEnds.some((e) => JSON.stringify(e).includes("read-only mode (plan) forbids"));
	if (!blocked) fail("tool_execution_end does not carry the governance block");
	if (serialized.includes("\\ntotal ") || /drwx/.test(serialized)) {
		fail("bash appears to have actually executed despite the block");
	}
	// Gate 2: the original command must be unmutated wherever it is echoed.
	if (!serialized.includes("ls -la")) {
		fail("original tool input not present — input may have been mutated/dropped");
	}
	// Gate 3b: the ready file must carry handler_registered AND echo the
	// per-spawn nonce (the backend validates content, not existence, so a
	// stale file from a prior attempt can never satisfy the handshake).
	let readyPayload;
	try {
		readyPayload = JSON.parse(readFileSync(join(work, "governance-ready.json"), "utf-8"));
	} catch {
		fail("governance ready file missing or unreadable after load");
	}
	if (readyPayload.handler_registered !== true || readyPayload.nonce !== "spike-nonce-123") {
		fail(`ready file content wrong: ${JSON.stringify(readyPayload)}`);
	}
	console.log("SPIKE PASS: rpc extension block end-to-end (fail-closed governance held)");
	child.stdin.write(JSON.stringify({ type: "prompt", message: "ignored" }) + "\n");
	child.kill("SIGTERM");
	process.exit(0);
});

child.on("exit", (code) => {
	if (code !== 0 && code !== null) {
		const end = events.find((e) => e.type === "agent_end");
		if (!end) fail(`clawwork exited ${code} before agent_end`);
	}
});

// Kick off: one prompt; the mock model answers with a bash tool call.
child.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: "list the files" }) + "\n");
