---
name: superclaw-delivery-harness
description: Operate the SuperClaw end-to-end ClawHunt delivery harness.
---

# SuperClaw Delivery Harness

Default workflow:

1. Normalize the goal into `GoalSpec`.
2. Build a dependency-aware `TaskGraph`.
3. Run workers with leases for repo, browser/display, ClawHunt submission, and Pay-Switch/human-gate resources.
4. Persist every command, API response, artifact reference, and verification finding.
5. Submit to ClawHunt only after adversarial verification.

Execution surfaces:

- Use `superclaw run --backend local|codex|claude|all` for CLI execution.
- Use `superclaw validate --backends local,codex,claude --fail-under 1.0` to calculate backend success rate.
- Use `POST /api/runs` with `async_execution=true` and the same backend policy for API/Web execution.
- Use `GET /api/runs/{run_id}/events` as the live timeline, not as a static log dump.
- Treat `WAITING_FOR_HUMAN_GATE` as a foreground lease state; resume only after the operator completes the handoff.
- `dry_run=false` must create real `worker_results` and artifacts.
- Treat Pay-Switch as governed optional tooling; call payment-intent only with explicit confirmation and endpoint configuration.

ClawHunt helper coverage:

- Browse/detail/post/bid/claim/submit/accept/wallet/capability-probe/me/skills/memories/subtasks are available under `superclaw clawhunt`.
- Return status code plus response body as evidence; do not swallow protected API `401` or proxy `502` responses.

Secret policy:

- Load credentials from environment or secret manager only.
- Never write `cph_`, payment tokens, cookies, browser profile data, or card details to evidence.
- Use public artifact refs for shareable proof and `sensitive` refs for private local artifacts.
