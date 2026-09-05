# Claude Code Sourcemap Notes

Source inspected: `Arxchibobo/claude-code-sourcemap`, a public fork of a non-official sourcemap reconstruction of `@anthropic-ai/claude-code` version `2.1.88`.

Boundary: this is research-only input. SuperClaw must not vendor restored source files or treat the repository as an official upstream. Use it only to identify runtime contracts and product-shape gaps.

## Useful Signals

- Hook inputs consistently carry `session_id`, `transcript_path`, `cwd`, `permission_mode`, plus optional `agent_id` and `agent_type`.
- Control messages cover runtime mutation and introspection: permission mode, model, MCP status, context usage, and permission requests.
- Permission modes distinguish `default`, `acceptEdits`, `bypassPermissions`, `plan`, and `dontAsk`; newer installed Claude Code also exposes `auto`.
- Coordinator mode treats workers as separate producers of task notifications, not chat participants. Worker results are summarized and then synthesized by the coordinator.
- Async workers get a restricted tool set. Recursive delegation and main-thread-only controls are intentionally blocked.
- Cancel semantics split into current-turn cancellation and explicit background-worker kill, with separate user intent.
- MCP/tool output has a separate truncation boundary before content enters model context.
- Resume is worktree-aware and preserves session mode.

## SuperClaw Mapping

- `superclaw runtime inspect` now exposes a `sourcemap_alignment` block with hook, control, tool-topology, and operational patterns.
- `superclaw runtime mcp-status` now exposes secret-safe MCP config/readiness status and an optional `codex mcp list` live probe.
- Worker transcripts already include run/session identity, command argv, stdout/stderr tails, timing, and permission policy.
- SuperClaw now records first-class `worker.cancelled` events when a cancelled run terminates the active worker subprocess.
- SuperClaw now records first-class `permission.requested`, `permission.decided`, and `context.usage` events around real worker attempts, using the stored execution permission policy and primary evidence usage metadata.
- Process-level cancellation is now stronger than a stored `cancelled` status for local/Codex/Claude subprocess backends; remaining hardening is stale-run reconciliation after crashes or host restarts.
- Primary evidence output truncation is explicit in the evidence layer through truncation metadata, a non-verification `primary_evidence_truncated` finding, and `evidence.finding` events when output exceeds the configured evidence budget.
