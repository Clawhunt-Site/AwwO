#!/usr/bin/env node
/**
 * Spike (review hardening): a SILENTLY-FAILED governance extension load must
 * leave NO ready file, so a backend that gates on the ready-file handshake
 * fail-closes. ClawWork's loader catches a bad `-e` and continues, so this is
 * the load-time analogue of the runtime fail-closed checks.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const cli = join(repo, "packages/coding-agent/dist/cli.js");

// A governance extension that throws at load time (simulates a dep/syntax fault).
const work = mkdtempSync(join(tmpdir(), "clawwork-hs-"));
const badExt = join(work, "bad-governance.ts");
writeFileSync(badExt, "throw new Error('simulated governance load failure');\n");
const agentDir = join(work, "agent");
mkdirSync(agentDir, { recursive: true });
const readyFile = join(work, "ready");

const child = spawn(
	process.execPath,
	[
		cli, "--mode", "rpc", "--no-session",
		"--provider", "mockprov", "--model", "mock-tool-caller",
		"-e", join(here, "mock-toolcall-provider.ts"),
		"-e", badExt,
	],
	{ cwd: work, env: { ...process.env, CLAWWORK_CODING_AGENT_DIR: agentDir, SUPERCLAW_GOVERNANCE_READY_FILE: readyFile, MOCKPROV_API_KEY: "x" }, stdio: ["pipe", "pipe", "pipe"] },
);

// Do NOT send a prompt — model the backend's handshake: wait for the ready file.
setTimeout(() => {
	child.kill("SIGKILL");
	if (existsSync(readyFile)) {
		console.error("SPIKE FAIL: ready file written despite a failed governance load");
		process.exit(1);
	}
	console.log("SPIKE PASS: failed governance load left no ready file -> backend fail-closes (no prompt sent)");
	process.exit(0);
}, 6000);
