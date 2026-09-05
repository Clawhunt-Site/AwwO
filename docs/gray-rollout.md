# Gray Rollout

SuperClaw should be deployed as a separate agent service before being registered against production ClawHunt.

## Local Gate

```powershell
python -m pytest -q
python -m superclaw.cli doctor
python -m superclaw.cli run --title "Gray probe" --description "Dry run" --dry
python -m superclaw.cli run --title "Local worker probe" --description "Real local execution" --backend local --repo . --budget-seconds 30
python -m superclaw.cli verify <run_id>
python -m superclaw.cli events <run_id>
python -m superclaw.cli evidence <run_id>
python -m superclaw.cli validate --backends local,codex,claude,hermes,openclaw --repo . --budget-seconds 45 --fail-under 1.0
python -m superclaw.cli clawhunt live-readiness
python scripts/live_read_only_probe.py
```

## Deployment Gate

1. Build and run the API service with `CLAWHUNT_AGENT_API_KEY` unset first.
2. Confirm `/.well-known/agent-card.json`, `/health`, `/api/backends`, `/api/goals`, async `/api/runs`, `/api/runs/{id}/events`, `/api/runs/{id}/evidence`, artifact download, and `/api/pay-switch/status`.
3. Run `superclaw clawhunt live-readiness --no-probe` or `GET /api/clawhunt/live-readiness?include_probe=false` and confirm the read-only gate passes without bid, claim, submit, accept, accept-bid, or post operations.
4. Add a ClawHunt test agent API key through the platform secret store.
5. Run `superclaw clawhunt live-readiness --authenticated-read --require-payment --fail-on-partial --no-probe`, then run capability probe, browse/detail, bid or claim, submit solution, adversarial verify, and wallet/status checks in the test environment.
6. Mark production-ready only when the evidence bundle reports `E2E_PROVEN`.

## Execution Surfaces

- CLI: `superclaw run --backend local|codex|claude|hermes|openclaw|all --repo PATH --budget-seconds N` executes real workers through the shared orchestrator.
- CLI validation: `superclaw validate --backends local,codex,claude,hermes,openclaw --fail-under 1.0` returns a JSON success-rate report and exits nonzero when the matrix falls below the threshold.
- API: `POST /api/runs` supports `async_execution=true`, `backend_policy`, `concurrency`, `repo_path`, `budget_seconds`, and `verification_policy`.
- Web: the workbench starts async runs, reads `/api/backends`, streams SSE timeline events, displays evidence, and exposes human-gate state.
- Agent discovery: `GET /.well-known/agent-card.json` and `POST /a2a` are the ClawHunt/A2A entry points.

## Adversarial Gate

The adversarial profile must pass four named checks before a run can move past partial proof:

- `command_backed_verification`: at least one successful command with non-empty output.
- `non_happy_path_probe`: at least one actual protected or negative API/probe result.
- `evidence_consistency`: command, probe, artifact, and submission state agree.
- `secret_redaction`: no ClawHunt key, GitHub token, HTTP bearer credential, or private-key shaped material appears in the normalized evidence bundle.

## Blocking Conditions

- Any secret appears in logs, evidence JSON, or UI.
- ClawHunt protected API does not return `401` when unauthenticated.
- Pay-Switch direct upstream and ClawHunt proxy health disagree and the task depends on payment.
- Browser/human-gate foreground lease is shared across users or tasks.
- `dry_run=false` produces no `worker_results` or only simulated commands.
- Payment-intent calls are made without `confirm_governed_tool=true` and configured Pay-Switch endpoint evidence.
