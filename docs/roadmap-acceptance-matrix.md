# Short-Term Roadmap Acceptance Matrix

This document is the convergence checklist for `docs/short-term-roadmap.md`.
It maps each short-term acceptance item to the implementation and tests that
prove it. It is not a new roadmap and must not expand the current scope.

## Completion Boundary

The short-term roadmap is considered complete when the control-plane contract is
implemented, tested, documented, and reviewable through PRs. The completion
boundary is:

- durable local and API-driven runs
- fail-closed evidence capture
- stable internal state transitions
- ClawHunt protocol export readiness through adapters
- verifier hardening for known false-positive paths
- bounded subagent/topology support without weakening evidence determinism

The following remain outside this short-term completion boundary:

- production ClawHunt artifact upload and accepted-submission settlement
- unrestricted user-authored DAG editing
- recursive subagents or child-of-child spawning
- production multi-tenant worker queues
- marketplace, payment, billing, payout, and entitlement production services
- production plugin runtime hosting beyond the local/fake-cloud contracts

## Acceptance Matrix

| Roadmap requirement | Status | Evidence |
| --- | --- | --- |
| Internal state skeleton is explicit and tested | Complete | `RunSession`, `TaskGraph`, `EvidenceBundle`, child execution, task-attempt, and lease contracts are represented in `packages/superclaw/src/superclaw/models.py` and `packages/superclaw/src/superclaw/state.py`; covered by `tests/test_models.py` and `tests/test_state.py`. |
| Invalid status/task graph transitions fail closed | Complete | Task dependency cycle, self-dependency, and dangling-dependency validation are covered in `tests/test_models.py`; run mutation lease loss and stale-writer behavior are covered in `tests/test_state.py` and `tests/test_orchestrator.py`. |
| Resume eligibility is deterministic from persisted state | Complete | Missing or unreadable evidence fails stale reconciliation closed; covered by `tests/test_orchestrator.py::test_orchestrator_reconcile_fails_closed_when_resume_evidence_missing` and related resume eligibility regressions. |
| Real local interrupt/resume preserves evidence | Complete | Local execution can be interrupted after a persisted running task, reconciled with a fresh store/orchestrator, and resumed without rerunning completed work; covered by `tests/test_orchestrator.py::test_orchestrator_interrupt_resume_local_run_without_rerunning_completed_task`. |
| Stale worker reconciliation is observable through public entrypoints | Complete | Same-host dead worker pids are reclaimed before TTL through API and CLI reconcile paths; covered by `tests/test_api.py::test_api_reconcile_reclaims_dead_worker_pid_lease_before_ttl` and `tests/test_cli.py::test_cli_reconcile_reclaims_dead_worker_pid_lease_before_ttl`. |
| Verification is a persisted stage | Complete | `run.verifying`, persisted verifier findings, and terminal verdict ordering are covered by `tests/test_orchestrator.py::test_orchestrator_persists_verifier_findings_before_verification_completed`. |
| Verification restart/resume does not rerun completed workers | Complete | A fresh store/orchestrator resumes a stored `verifying` run without losing findings or rerunning completed workers; covered by `tests/test_orchestrator.py::test_orchestrator_resume_verifying_run_after_restart_without_rerunning_workers`. |
| Evidence writes are idempotent and bounded | Complete | Worker result replay deduplication, distinct-attempt preservation, and 4,000 character primary evidence caps are covered by `tests/test_models.py`, `tests/test_orchestrator.py`, and `tests/test_worker_backends.py`. |
| Cancellation and forced-kill evidence is durable | Complete | Restarted cancellation reconciliation and POSIX forced-kill metadata are covered by `tests/test_orchestrator.py::test_orchestrator_reconcile_preserves_cancelled_run_after_restart` and `tests/test_worker_backends.py::test_local_shell_backend_records_forced_kill_when_cancelled_process_ignores_terminate`. |
| Protocol export is adapter-owned and does not mutate core evidence | Complete | Delivery protocol payload export is covered by `tests/test_protocol_adapter.py::test_protocol_adapter_builds_delivery_protocol_payload_without_mutating_evidence_bundle`, API export tests, and CLI export tests. |
| Child execution evidence is exported without local path leakage | Complete | Sanitized child execution summaries are covered by `tests/test_protocol_adapter.py::test_delivery_protocol_manifest_exports_sanitized_child_execution_summaries`, `tests/test_api.py::test_api_protocol_export_includes_sanitized_child_execution_evidence`, and `tests/test_cli.py::test_cli_export_protocol_includes_sanitized_child_execution_evidence`. |
| Verifier rules are public and machine-readable | Complete | API and CLI rule-spec output includes input fields, fail mode, severity, and remediation; covered by `tests/test_api.py::test_api_adversarial_verification_returns_rule_specs` and `tests/test_cli.py::test_cli_verify_json_returns_rule_specs`. |
| Known false-positive paths are blocked through public entrypoints | Complete | Direct plugin-policy bypass evidence returns and persists a fail-closed `plugin_policy_boundary` finding through API and CLI; covered by `tests/test_api.py::test_api_adversarial_verification_persists_plugin_policy_failure` and `tests/test_cli.py::test_cli_verify_json_persists_plugin_policy_boundary_failure`. |
| Parent-child execution is visible and auditable | Complete | API fanout returns persisted child lifecycle records and audit events; covered by `tests/test_api.py::test_api_fanout_returns_persisted_child_lifecycle_contract`. |
| Parent cancellation propagates to active linked children | Complete | Active child runs are cancelled when the parent is cancelled, and parent evidence/events reflect the child cancellation; covered by `tests/test_orchestrator.py::test_orchestrator_parent_cancel_propagates_to_active_child_run`. |
| Constrained topology/DAG execution is deterministic and resumable | Complete | `implement_fanout`, `explore_fanout`, and `review_consensus` are covered through orchestrator, CLI, and API tests, including DAG dependency order and resume of remaining branches. |

## Current PR Stack

The converged implementation currently spans the stacked PR range `#115` through
`#133`. Each PR is intentionally atomic, CI-backed, and based on the previous
stack branch. This preserved reviewability but increased wall-clock time.

For final integration, the stack should be handled in order:

1. Ensure every PR in the stack is ready for review, not draft.
2. Merge from the bottom of the stack upward, or rebase/squash the stack into
   fewer feature-group PRs if maintainers prefer lower PR count.
3. Do not merge later topology or verifier PRs before their runtime persistence
   bases are merged.

## Residual Risks

The short-term roadmap is a local control-plane hardening milestone. It does not
prove production marketplace behavior, production payment settlement, or a real
ClawHunt accepted-submission lifecycle. Those require a separate production E2E
milestone with live platform credentials, live artifact upload, and live
acceptance evidence.

## Production E2E Readiness Progress

`superclaw clawhunt live-readiness` and
`GET /api/clawhunt/live-readiness` now provide a repeatable read-only production
gate for ClawHunt integration. The gate checks public health, unauthenticated
protected API fail-closed behavior, Pay-Switch proxy/direct health, a local
ClawHunt submission protocol sample, and optional authenticated GET-only
profile/capability/problem-list surfaces. It intentionally blocks bid, claim,
submit, accept, accept-bid, and post operations by design, so it reduces the
production E2E risk but does not replace accepted-submission or settlement
evidence.
