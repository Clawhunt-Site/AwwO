# SuperClaw Agent Comparison

Observed locally on 2026-05-26:

- Codex CLI: `0.1.2505172129`
- Claude Code CLI: `2.1.138`
- SuperClaw validation command: `superclaw validate --backends local,codex,claude --repo . --budget-seconds 25 --fail-under 1.0`

## Current Validation

The latest real backend matrix completed with 2/3 successful backends after fail-closed auth/TTY detection:

| Backend | Result | Verdict | Notes |
| --- | --- | --- | --- |
| `local` | pass | `CHAIN_PARTIAL` | Real local shell worker evidence and artifacts. |
| `codex` | fail | `FAIL` | Installed and help-probeable, but direct non-interactive task currently enters ChatGPT/API-key login and raw-mode failure; SuperClaw now classifies this as backend failure even when the process exits `0`. |
| `claude` | pass | `CHAIN_PARTIAL` | Real Claude Code process invocation in non-interactive no-tools smoke mode. |

This proves worker execution, evidence, artifact, and adversarial profile plumbing for available authenticated backends. It does not prove production ClawHunt submission. `E2E_PROVEN` still requires a real ClawHunt submit response with `CLAWHUNT_AGENT_API_KEY`.

## Capability Comparison

| Area | SuperClaw | Codex CLI | Claude Code |
| --- | --- | --- | --- |
| Product target | ClawHunt delivery agent and evidence service | General local coding agent | General local coding agent |
| Execution surface | CLI, API, Web, A2A, SSE | CLI / local app session | CLI, agents, plugins, MCP, remote control |
| Evidence model | First-class `EvidenceBundle`, worker logs, worker transcripts, artifacts, findings, chain verdict | Session transcript and command output | Session transcript, optional JSON/stream JSON output |
| ClawHunt integration | Native browse/detail/claim/submit/wallet helpers | Not ClawHunt-specific | Not ClawHunt-specific |
| Pay-Switch integration | Governed optional status/config/payment-intent/human-gate | External integration required | External integration required |
| Backend role | Can call `local`, `codex`, and `claude` behind one scheduler | Primary agent backend | Primary agent backend |
| Session UX | `superclaw chat`, persisted chat sessions, `superclaw watch`, API chat session endpoints | Interactive session, history, saved rollouts | Interactive session, resume/continue, named sessions |
| Permission/runtime policy | Normalized policy passed into Codex approval mode and Claude permissions/MCP/plugins where supported | Approval mode and writable roots | Tool allow/deny, permission mode, MCP config, plugin dirs |
| Success-rate reporting | `superclaw validate` JSON matrix | External harness required | External harness required |
| Production verdict | Explicit `CONTROL_PLANE_READY`, `CHAIN_PARTIAL`, `E2E_PROVEN`, `FAIL` | Manual interpretation | Manual interpretation |

## Functional Strengthening Done

- Added `superclaw validate` for backend success-rate reports and thresholded nonzero exits.
- Added `superclaw chat` and API chat sessions so delivery turns can resume around a persistent SuperClaw session id.
- Added `superclaw watch` for terminal-event-following JSON/event output.
- Added `superclaw runtime inspect|policy` and `/api/runtime` to expose local Codex/Claude capability probes without printing secrets.
- Added `superclaw runtime compare` and `/api/runtime/compare` so CLI parity checks are repeatable against local SuperClaw/Codex/Claude/Gemini/OpenCode/Cursor availability.
- Added `superclaw runtime context` and `/api/runtime/context` to summarize local goals, runs, events, evidence, transcripts, and chat state before further iteration.
- Added `superclaw runtime mcp-status` and `/api/runtime/mcp-status` for secret-safe MCP config/readiness discovery plus optional `codex mcp list` live probe.
- Added per-worker transcript artifacts with redacted stdout/stderr tails and normalized permission policy.
- Added fail-closed detection for agent CLI auth/TTY prompts so Codex login screens and raw-mode errors cannot be misreported as successful worker execution.
- Added process-level cancellation for local/Codex/Claude worker subprocesses: cancel now trips a state-backed `cancel_check`, terminates the active process, records `worker.cancelled`, and writes `cancelled`/`forced_kill` into transcript evidence.
- Made `superclaw run` exit nonzero when the stored run status is failed.
- Hardened the Claude backend to use non-interactive JSON/no-session smoke mode by default, while supporting explicit permission/MCP/plugin policy when requested.
- Added structured API-agent transcript stream events for Gemini and Anthropic agent loops so model responses, tool calls, tool results, finish, and terminal status are machine-readable in worker transcript artifacts.

## Remaining Gap

SuperClaw now proves the harness, local agent backends, session CLI, event watch, runtime policy, live MCP readiness status, transcript capture, structured API-agent stream-event capture, and process-level subprocess cancellation. The remaining gap versus mature Codex/Claude daily coding UX is a long-lived interactive model loop with native tool permission prompts, live stream-json passthrough, and true subagent task spawning rather than SuperClaw-owned role scheduling.
