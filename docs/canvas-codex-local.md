# AwwO canvas: local Codex execution

The canvas planner and node execution use separate paths. Planning returns validated graph operations. A bound node creates or continues a real conversation issue through the gateway; the control plane executes its `codex_local` adapter and streams the result back into that node's active Session.

## Local runtime

- Start the existing control plane with an isolated development instance and its native embedded PostgreSQL database. Keep the instance, database, instruction bundles and logs outside production resources.
- Set the gateway's existing `SUPERCLAW_GATEWAY_UPSTREAM_URL` to the actual control-plane URL. An old desktop service marker can otherwise select a stopped process.
- Keep the gateway and control plane on loopback. Disable scheduled heartbeat execution for a manual canvas verification.
- Initialize the instance's Agent JWT with the existing `ensureAgentJwtSecret` helper. Its generated value belongs in the instance's private `.env`, never in browser code or a committed file.
- Verify `codex login status` before binding. Models and reasoning options come from the runtime inventory; leaving them unset uses the runtime configuration.

The experimental PGlite driver is unsuitable for this verified execution path: the existing heartbeat finalization code can await an outer database query while holding a transaction. PGlite serializes both on one connection, so the transaction and health queries wait indefinitely. Native PostgreSQL is already supported by the control plane. This canvas change does not modify the vendored database or heartbeat implementation.

## Binding and isolation

Open a node, choose **配置 → Runtime → codex_local**, select a local company, and click **绑定并创建真实 Agent**. Use one Agent per independently customized node. The binding writes the node's persona to the Agent's managed `AGENTS.md`.

Canvas hires explicitly set both Codex bypass aliases to `false`, add `--sandbox workspace-write`, and disable scheduled heartbeats. Requested conversation and graph wakes remain enabled. Each Agent should use its own working directory; each canvas Session receives its own server issue ID and Codex task session.

On Windows, creating a file symlink for the default managed Codex home can fail with `EPERM`. The existing adapter supports an explicit `adapterConfig.env.CODEX_HOME` pointing to the already logged-in user's Codex directory. This uses the existing authentication without copying a refresh token or changing Windows privileges. The native `codex.exe` can be selected with `adapterConfig.command`. These are host-specific runtime settings, not hardcoded frontend defaults.

For a local verification, use the adapter's existing skill selection to avoid installing extra runtime skills, and disable unrelated MCP/apps/plugins through CLI configuration overrides. Preserve the user's instructions and approval policy. Do not use a permission-bypass flag. A shared login directory does not merge the Agents' working directories, issue IDs or task sessions.

## Evidence required for a successful run

1. The browser shows the real Agent bindings and starts the graph through the gateway.
2. The control plane reports actual `codex_local` run records and distinct task sessions.
3. A node finishes only after a successful terminal event and valid values for its declared output fields. A failed or invalid upstream result blocks dependent nodes.
4. Downstream inputs contain the connected upstream fields, rather than a fabricated placeholder.
5. File references are checked against real local files. A generated prototype is described as a prototype; it does not prove a deployed application or implemented login/backend.
6. A follow-up conversation reuses the same Session, while a new Session obtains a separate conversation identity.

The per-run verification results and local preview are recorded in `superpowers/2026-09-04-awwo-handoff.md`.

## Codex result streaming

The gateway projects native Codex JSONL into conversation events. It keeps tool progress separate from the final Agent message and publishes the final answer only when the corresponding heartbeat run reaches a terminal state. Structured output validation remains the canvas's responsibility.

The control plane truncates oversized live log chunks. On a truncated stream, the gateway reads the persisted stdout for that same run ID before confirming delivery. Recovery is bounded to 8 MiB and 16 pages; failed reads, mismatched run IDs and malformed assistant records produce an error rather than an empty successful result. The control plane's redactor can damage the JSON escaping of command-execution records; those recognized tool records do not become contract content. Unknown damaged records still fail validation.

A remaining discovery limitation is that a run which finishes before the gateway first discovers it can be reported as `no_run`; this change does not add historical-run fallback. The recorded canvas acceptance uses observed live run IDs and checks each actual terminal status.

## Continuing an existing Session

The dispatcher verifies the existing issue's company and assigned Agent before posting a follow-up. For a finished or blocked issue it uses the control plane's official `resume: true` comment intent. Unresolved dependencies or pause holds are returned immediately to the conversation; the gateway does not clear blockers or force a wake. A cancelled issue requires the official restore flow. Message delivery alone is not reported as proof that an Agent has started.

Local file references in delivery fields expose the complete path and a copy action. They do not navigate to a nonexistent HTTP path or claim that the local file has been uploaded. Clipboard failure leaves the path available for manual copying.
