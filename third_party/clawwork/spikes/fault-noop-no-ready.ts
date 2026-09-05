/**
 * Fault-injection extension for the REAL-binary integration spike.
 *
 * Loads cleanly (no throw) and registers NOTHING — so the governance handler
 * never runs and no ready file is ever written, yet the clawwork process stays
 * ALIVE in RPC mode. This forces SuperClaw's _spawn_rpc down the handshake
 * TIMEOUT branch ("did not signal ready"), as opposed to the child-EXIT branch
 * that a throwing fixture triggers. Both are ungoverned; this fixture is what
 * distinguishes the two paths in the real-binary tests.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	// intentionally empty: no handler, no ready file
}
