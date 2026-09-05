import { realpathSync } from "node:fs";
import type { Extension } from "./extensions/types.ts";

/**
 * SuperClaw forge-proof governance barrier (vendored-fork addition).
 *
 * When `SUPERCLAW_REQUIRE_GOVERNANCE` is set (to the canonical governance
 * extension's path), the process MUST have loaded THAT exact extension AND that
 * extension MUST have registered a `tool_call` handler. Otherwise the run is
 * ungoverned and we refuse to build the runtime — the caller exits non-zero before
 * any model request or tool execution.
 *
 * Why this is forge-proof where a ready-file / env-nonce handshake is NOT: the
 * proof here is an IN-PROCESS handler registration on a SPECIFIC loaded extension
 * (matched by resolved path), not a file or env value. The agent runs as a tool
 * SUBPROCESS — it can read env and write files (so it can forge a ready-file), but
 * it cannot register a handler inside ClawWork's JS process, and a planted
 * extension (e.g. under the workspace's `.clawwork/extensions/` or the agent dir)
 * has a different path so it cannot masquerade as the canonical governance
 * extension. So an agent cannot satisfy this barrier from inside a run.
 *
 * No-op unless `SUPERCLAW_REQUIRE_GOVERNANCE` is set, so ordinary (non-SuperClaw)
 * ClawWork usage is unaffected.
 */

export const REQUIRE_GOVERNANCE_ENV = "SUPERCLAW_REQUIRE_GOVERNANCE";

export class GovernanceBarrierError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GovernanceBarrierError";
	}
}

function realpathOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

export function assertGovernanceBarrier(extensions: ReadonlyArray<Extension>): void {
	const expected = (process.env[REQUIRE_GOVERNANCE_ENV] ?? "").trim();
	if (!expected) return;
	const expectedReal = realpathOrSelf(expected);
	const satisfied = extensions.some((ext) => {
		const extReal = realpathOrSelf(ext.resolvedPath || ext.path);
		if (extReal !== expectedReal) return false;
		const handlers = ext.handlers.get("tool_call");
		return Array.isArray(handlers) && handlers.length > 0;
	});
	if (!satisfied) {
		throw new GovernanceBarrierError(
			`CLAWWORK_UNGOVERNED: the mandatory SuperClaw governance extension (${expected}) did not load and register a tool_call handler; ` +
				`refusing to run ungoverned (${REQUIRE_GOVERNANCE_ENV} is set — rebuild the harness or check the -e extension load).`,
		);
	}
}
