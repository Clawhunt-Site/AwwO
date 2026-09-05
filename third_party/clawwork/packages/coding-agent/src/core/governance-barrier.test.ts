import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Extension } from "./extensions/types.ts";
import { assertGovernanceBarrier, GovernanceBarrierError, REQUIRE_GOVERNANCE_ENV } from "./governance-barrier.ts";

function mockExtension(extPath: string, withToolCall: boolean): Extension {
	const handlers = new Map<string, Array<() => void>>();
	if (withToolCall) handlers.set("tool_call", [() => {}]);
	return {
		path: extPath,
		resolvedPath: extPath,
		sourceInfo: { kind: "file", path: extPath } as unknown as Extension["sourceInfo"],
		handlers: handlers as unknown as Extension["handlers"],
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

const createdDirs: string[] = [];
function tmpExtensionFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-barrier-"));
	createdDirs.push(dir);
	const file = path.join(dir, "superclaw-governance.ts");
	fs.writeFileSync(file, "// governance");
	return file;
}

const prevEnv = process.env[REQUIRE_GOVERNANCE_ENV];
afterEach(() => {
	if (prevEnv === undefined) delete process.env[REQUIRE_GOVERNANCE_ENV];
	else process.env[REQUIRE_GOVERNANCE_ENV] = prevEnv;
	for (const d of createdDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("assertGovernanceBarrier", () => {
	it("is a no-op when SUPERCLAW_REQUIRE_GOVERNANCE is unset (ordinary ClawWork usage)", () => {
		delete process.env[REQUIRE_GOVERNANCE_ENV];
		expect(() => assertGovernanceBarrier([])).not.toThrow();
	});

	it("passes when the canonical extension loaded AND registered a tool_call handler", () => {
		const gov = tmpExtensionFile();
		process.env[REQUIRE_GOVERNANCE_ENV] = gov;
		expect(() => assertGovernanceBarrier([mockExtension(gov, true)])).not.toThrow();
	});

	it("throws when the canonical extension loaded but registered NO tool_call handler", () => {
		const gov = tmpExtensionFile();
		process.env[REQUIRE_GOVERNANCE_ENV] = gov;
		expect(() => assertGovernanceBarrier([mockExtension(gov, false)])).toThrow(GovernanceBarrierError);
	});

	it("throws when only a planted extension at a DIFFERENT path registered tool_call (no masquerade)", () => {
		const gov = tmpExtensionFile();
		const planted = tmpExtensionFile();
		process.env[REQUIRE_GOVERNANCE_ENV] = gov;
		expect(() => assertGovernanceBarrier([mockExtension(planted, true)])).toThrow(GovernanceBarrierError);
	});

	it("throws when no extensions loaded at all", () => {
		const gov = tmpExtensionFile();
		process.env[REQUIRE_GOVERNANCE_ENV] = gov;
		expect(() => assertGovernanceBarrier([])).toThrow(GovernanceBarrierError);
	});
});
