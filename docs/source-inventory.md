# SuperClaw Source Inventory

This document records what was intentionally imported into SuperClaw and what was left as an external source of truth.

## Productized Core Imports

| Source | Imported capability | Target surface |
|---|---|---|
| `Arxchibobo/clawproduct-hunt` | ClawHunt v1 API shape, protected API behavior, capability probe and evidence expectations | `superclaw.clawhunt`, API submit/probe contracts |
| `Arxchibobo/openclaw-loops` | Loop config style, verifier expressions, state/report/supervision pattern | `superclaw.verifier`, `superclaw.state`, `superclaw.orchestrator` |
| `Arxchibobo/openclaw-arxchibo` | Swarm roles and workspace-level orchestration vocabulary | `WorkerRole`, `TaskGraph`, worker timeline UI |
| `Arxchibobo/bobo-cli` | Chat/REPL-first workbench, role-based subagents, verification agent, memory/skills pattern | `apps/web`, `skills/`, CLI command layout |
| `Arxchibobo/payswitch` | Agent-card/A2A service shape, human gate, foreground lease, evidence/ledger proof boundary | API agent-card, human-gate UI, evidence verdict model |
| `Arxchibobo/OpenClaw-AWD-Arena` | Adversarial competition scoring, signed webhook idea, player evidence export boundary | `superclaw.adversarial`, future AWD adapter |
| `Arxchibobo/agents` | Multi-harness capability matrix, adapter degradation rules, plugin inventory shape, artifact emission/validation paths, Codex skill body cap handling | `superclaw.harness`, CLI/API harness emit/validate surfaces, `docs/harness-adaptation.md` |
| `Arxchibobo/claude-code/src` | Task type registry, terminal task status guard, tool concurrency partition, agent definition fields, context boundary model | `superclaw.harness.runtime_profile`, orchestrator harness evidence |
| `Arxchibobo/claude-code-sourcemap` | Research-only architecture signals: SDK hook/control schemas, permission modes, worker transcript fields, agent tool topology, cancel/kill-agent split, MCP output truncation boundary | `superclaw.runtime.CLAUDE_SOURCEMAP_ALIGNMENT`, `docs/claude-code-sourcemap-notes.md` |
| `Arxchibobo/adversarial-verification` | Break-it verification posture and PASS/PARTIAL/FAIL reporting | `skills/adversarial-verification`, `superclaw.adversarial` |

## Not Copied

- `.git` directories, branch metadata, unmerged worktrees, and remote credential URLs.
- `.env`, API keys, token files, Cloud Run/SSH credentials, browser profiles, ledgers, SQLite runtime DBs, screenshots, recordings, and generated artifacts.
- Large historical apps and dashboards that are not needed for the first gray rollout.
- Production ClawHunt code; SuperClaw integrates through public/agent API surfaces instead of vendoring the marketplace.
- Reconstructed Claude Code source from sourcemaps; SuperClaw uses only public/research architecture signals and does not copy implementation code.

## Current Live Readiness Notes

- `https://clawhunt.store/health` is the primary site health probe.
- `https://clawhunt.store/api/v1/problems` should return `401` without a Bearer `cph_` key.
- Pay-Switch must be treated as optional until ClawHunt `/api/pay-switch/health` and direct upstream health both agree.
- A SuperClaw delivery can only claim `E2E_PROVEN` after command output, non-happy-path verification, artifact/evidence, and ClawHunt submission response are all present.
