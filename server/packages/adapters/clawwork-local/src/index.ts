import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "clawwork_local";
export const label = "ClawWork (relay)";

// ClawWork is vendored into SuperClaw (a hard fork of `earendil-works/pi`) and
// built on demand; it is not an npm package, so there is no sandbox auto-install
// command. A run on a host without the harness fails closed in test.ts /
// execute.ts rather than silently npm-installing an unrelated package.
export const SANDBOX_INSTALL_COMMAND = "";

// ClawWork resolves models through the SuperClaw relay (clawrelay provider). The
// selectable values are the relay package tiers (core/plus/max) — the SAME
// contract constants the Python kernel routes on (relay_packages.py
// SUPERCLAW_RELAY_GROUP_SLUGS). They are surfaced here so the agent-config model
// selector shows the documented tiers; the adapter translates a tier to its
// relay group slug at run time (server/models.ts).
export const models: Array<{ id: string; label: string }> = [
  { id: "core", label: "ClawWork: core" },
  { id: "plus", label: "ClawWork: plus" },
  { id: "max", label: "ClawWork: max" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [];

export const agentConfigurationDoc = `# clawwork_local agent configuration

Adapter: clawwork_local

Use when:
- You want SuperClaw to run ClawWork (SuperClaw's relay coding harness) locally as the agent runtime.
- You want the agent driven through the SuperClaw model relay (clawrelay provider) instead of a directly-installed model CLI.
- You want ClawWork session resume across heartbeats and SuperClaw soft governance (pay/scan hard gate via the governance extension).

Don't use when:
- The ClawWork harness is not built on the host (build it with scripts/build-clawwork.sh, or set SUPERCLAW_CLAWWORK_EXECUTABLE).
- You need a directly-installed model CLI (use claude_local / codex_local / pi_local).

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible).
- model (string, optional): a SuperClaw relay package tier (core, plus, max). Omitted defaults to the base relay tier.
- thinking (string, optional): thinking level (off, minimal, low, medium, high, xhigh).
- permissionMode (string, optional): soft posture driving the --tools bound and the signed policy snapshot (plan, acceptEdits, auto, ask, bypassPermissions, dontAsk). Defaults to a PERMISSIVE posture (bypassPermissions: full tools, only payment/outbound-scan hard-gated) so an autonomous agent can do real work; set "plan" or an explicit allowedTools list to restrict.
- command (string, optional): defaults to "clawwork".
- env (object, optional): KEY=VALUE environment variables.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds.
- graceSec (number, optional): SIGTERM grace period in seconds.

Notes:
- Relay base/key are injected by SuperClaw via SUPERCLAW_RELAY_BASE_URL / SUPERCLAW_RELAY_API_KEY; a run with neither fails closed.
- The relay key is NEVER written to disk: the managed provider config binds apiKey to the $SUPERCLAW_RELAY_API_KEY environment variable, and the config lives in an ephemeral dir (never the workspace).
- Governance is SOFT (SuperClaw posture): the superclaw-governance extension hard-gates payment / outbound-scan intents and projects the permission posture; it does not cage the runtime. The adapter verifies the extension actually loaded (a per-spawn ready-file/nonce handshake) and fails the run CLAWWORK_UNGOVERNED if it did not.
- The relay key is kept off disk, but the raw run stdout/stderr are stored verbatim in the result for the transcript — a tool that echoes a secret would be recorded there (the credential-hygiene guarantee is "the key is never persisted by the adapter", not "the transcript is scrubbed").
- Sessions are stored under SUPERCLAW_HOME (~/.superclaw/clawwork/...) and resumed with --session.
`;
