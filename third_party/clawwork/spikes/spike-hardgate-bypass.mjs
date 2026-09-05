#!/usr/bin/env node
/**
 * Spike gate 6: pay/scan hard-gate regexes have no loopback-exemption bypass.
 *
 * The curl/wget gate exempts loopback hosts (a local probe is fine) but MUST
 * still block the classic SSRF-style tricks that smuggle a public host past a
 * naive `127.0.0.1|localhost` lookahead:
 *   - subdomain:   http://127.0.0.1.attacker.com   (loopback is a prefix)
 *   - userinfo:    http://localhost@evil.com         (loopback is the user)
 *   - port+user:   http://localhost:80@evil.com
 *
 * Imports the REAL HARD_GATE_PATTERNS from the extension (node strips the TS
 * types) so the test can never drift from the shipped regexes.
 */

import { HARD_GATE_PATTERNS } from "../extensions/superclaw-governance.ts";

function intentFor(command) {
	for (const { pattern, intent } of HARD_GATE_PATTERNS) {
		if (pattern.test(command)) return intent;
	}
	return null;
}

// [command, expectedIntent | null]  (null = must be allowed through)
const cases = [
	// must BLOCK as network_scan — public host smuggled past loopback exemption
	["curl http://127.0.0.1.attacker.com", "network_scan"],
	["curl http://localhost@evil.com", "network_scan"],
	["curl http://localhost:80@evil.com", "network_scan"],
	["wget https://127.0.0.1.evil.com/x", "network_scan"],
	["curl http://127.0.0.1evil.com", "network_scan"],
	["curl https://example.com", "network_scan"],
	["curl http://169.254.169.254/latest/meta-data", "network_scan"],
	// must ALLOW — genuine loopback targets (a local dev server probe is fine)
	["curl http://localhost", null],
	["curl http://localhost:8080/health", null],
	["curl http://127.0.0.1:3000/api", null],
	["curl http://[::1]:9000/", null],
	["wget http://localhost/file.txt", null],
	["curl http://user:pass@localhost:5000/x", null],
	// scan tools + payment keywords still caught
	["nmap -sV 10.0.0.1", "network_scan"],
	["curl https://api.stripe.com/v1/charges", "payment"],
	["echo pay-switch", "payment"],
	// unrelated commands pass
	["ls -la", null],
	["git status", null],
];

let failed = 0;
for (const [command, expected] of cases) {
	const got = intentFor(command);
	// a payment keyword may also match network_scan via curl; accept either
	// hard-gate intent when SOMETHING must block.
	const ok = expected === null ? got === null : got !== null;
	if (!ok) {
		failed += 1;
		console.error(`SPIKE FAIL: "${command}" -> got ${JSON.stringify(got)}, expected ${expected === null ? "ALLOW" : "BLOCK"}`);
	}
}

if (failed === 0) {
	console.log(`SPIKE PASS: hard-gate loopback exemption has no SSRF bypass (${cases.length} cases)`);
}
process.exit(failed ? 1 : 0);
