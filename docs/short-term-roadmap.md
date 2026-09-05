# SuperClaw Short-Term Roadmap

This document defines the next short-term development plan for SuperClaw as an engineering control plane, not as a generic agent platform. The goal is to make the current system durable, verifiable, and ready for protocol expansion without rewriting the core state model twice.

## Scope

This roadmap covers the next three short-term phases:

1. Protocol skeleton
2. Runtime robustness
3. Protocol expansion, verifier hardening, and orchestration upgrades

This document does not define a public product roadmap, pricing, UI polish backlog, or broad ecosystem strategy.

## Product Intent

SuperClaw exists to run delivery tasks through a shared orchestrator and produce auditable evidence, artifacts, and verdicts. It is successful only if a run can be resumed, verified, inspected, and submitted without relying on unverifiable model claims.

The short-term target is:

- durable local and API-driven runs
- fail-closed evidence capture
- stable internal state transitions
- explicit readiness for ClawHunt protocol alignment
- no premature expansion into a generic workflow engine

## Non-Goals

The following items are explicitly out of scope until this roadmap is complete:

- major UI redesign
- broad backend expansion beyond `local`, `codex`, and `claude`
- heavy workflow engine adoption such as Temporal or Airflow
- unrestricted DAG orchestration before the current linear control plane is stable
- production claims that exceed `CHAIN_PARTIAL` or `E2E_PROVEN` evidence

## Current Baseline

The current implementation already provides:

- typed `GoalSpec`, `TaskGraph`, `RunSession`, `EvidenceBundle`, and `ChainVerdict`
- a fixed task chain: `explore -> plan -> implement -> verify -> review`
- shared execution through `local`, `codex`, and `claude` backends
- persistent runs, events, evidence, and chat sessions
- adversarial profile checks for command proof, negative probes, consistency, and secret redaction

The main gaps are:

- run recovery is incomplete
- stale runs are not reconciled as a first-class flow
- evidence persistence is not yet treated as a stable contract
- verifier logic is still narrow relative to the platform claim
- subagent lifecycle is not yet a real system concept
- ClawHunt protocol alignment is incomplete

## Design Principles

Every implementation in this roadmap must follow these rules:

- Fail closed. Missing evidence or ambiguous worker outcomes must produce `FAIL` or `CHAIN_PARTIAL`, never silent success.
- Persist before claiming. Any run state shown in API or UI must be reconstructable from stored state.
- Separate internal model from external protocol. Do not hard-wire ClawHunt request shapes into the core state types.
- Extend by adapters first. Prefer edge adapters and translation layers before core rewrites.
- Keep the runtime inspectable. Every critical transition must emit an event and be explainable from stored evidence.
- Preserve linear safety before adding topology. The existing sequential chain is the safe base until resume and verifier semantics are stable.

## Core Internal Contract

The following data concepts are short-term required and must remain explicit in code review:

### Run Identity

- `goal_id` is the stable goal identity
- `run_id` is the stable execution identity
- `task_id` is the stable node identity
- future parent-child execution must not overload `run_id`

### Run Status Contract

The persisted run status vocabulary must be explicit and finite. The minimum accepted set is:

- `created`
- `queued`
- `running`
- `verifying`
- `completed`
- `failed`
- `cancelled`

If additional states are introduced, they must document:

- transition source states
- transition target states
- whether resume is allowed
- whether evidence mutation is still legal

### Evidence Contract

The minimum evidence skeleton must stay stable across phases:

- `run_id`
- `commands`
- `probes`
- `worker_results`
- `artifacts`
- `findings`
- `backend_summary`
- `submitted_to_clawhunt`
- `submission_response`

Rules:

- `commands` are normalized execution proof, not raw full logs
- `worker_results` are per-task execution records
- `artifacts` are references, not inline large blobs
- `findings` are verifier outcomes or explicit evidence-contract metadata, not
  generic logs; event streams distinguish verifier findings as
  `verification.finding` and evidence metadata findings as `evidence.finding`
- evidence must remain serializable and comparable between retries

### Event Contract

Every stateful action must emit an event with a stable event type string. At minimum:

- `run.queued`
- `run.started`
- `run.verifying`
- `run.completed`
- `run.failed`
- `run.cancelled`
- `task.started`
- `task.completed`
- `task.failed`
- `worker.cancelled`
- `artifact.added`
- `verification.completed`

If an operation mutates state without a corresponding event, it is incomplete.

Event persistence rules:

- the state mutation and its corresponding event append must succeed together or fail together
- resume, reconciliation, and cancellation must be single-writer per `run_id`
- any resume or reconcile path must acquire a per-run lock or compare-and-set guard before mutating state
- fire-and-forget event emission is not accepted for terminal state changes

## Phase 1: Protocol Skeleton

### Goal

Define the minimum internal data shape required to support durable state, safe retries, and later ClawHunt protocol expansion without forcing a near-term migration.

### Required Work

1. Write a state transition table for `RunSession.status`.
2. Freeze the minimum evidence skeleton as an internal contract.
3. Define task attempt semantics.
4. Define cancellation semantics.
5. Define adapter boundaries between internal evidence and external ClawHunt submission payloads.

### Phase 1 Spec Requirements

#### 1. State Transition Table

The implementation must document allowed transitions for each run status. At minimum:

- `created -> queued`
- `queued -> running`
- `running -> verifying`
- `running -> failed`
- `running -> cancelled`
- `verifying -> completed`
- `verifying -> failed`

Forbidden examples:

- `completed -> running`
- `failed -> completed` without a new run or explicit retry attempt record
- `cancelled -> completed`

#### 2. Task Attempt Model

Each task execution attempt must be representable as a distinct record, even if the current storage format remains embedded. The minimum logical fields are:

- `run_id`
- `task_id`
- `attempt_index`
- `backend`
- `started_at`
- `finished_at`
- `exit_code`
- `timed_out`
- `cancelled`
- `forced_kill`
- `artifact_id`

The current system may keep a compact representation, but the semantics must be defined before runtime hardening.

#### 3. Resume Eligibility Rules

A run is eligible for resume only if all of the following are true:

- status is `queued`, `running`, or `verifying`
- persisted task graph is available
- evidence bundle can be loaded successfully
- the active task frontier can be reconstructed without guessing

Otherwise the run must fail closed into `failed` or require a new run.

Implemented resume eligibility slice:

- stale `queued`, `running`, or `verifying` runs are resumable only when the
  stored `EvidenceBundle` exists and can be decoded;
- missing or unreadable evidence is classified as `failed_closed`, persists the
  run as `failed`, and records a `run.failed` event with the evidence-load
  reason;
- the reconciler does not create a new empty evidence bundle to make an
  otherwise incomplete stale run resumable.

This slice is an eligibility guard only. It does not add new resume scheduling,
change task frontier calculation, or alter cancellation semantics.

#### 4. Adapter Boundary

Core models must not directly depend on the latest ClawHunt package manifest. Instead:

- internal state and evidence remain SuperClaw-owned
- a protocol adapter maps internal evidence to external payloads
- unsupported external fields must degrade explicitly, not silently disappear

#### 5. Concurrency Guard

The short-term runtime is single-active-writer per run.

Required semantics:

- at most one executor, reconciler, or resumer may hold mutation authority for the same `run_id`
- lock ownership must be observable in state or lease records
- lock loss during mutation must fail the operation and record a finding or event
- duplicate resume or reconcile requests for the same `run_id` must be rejected or no-op deterministically

Implemented local state slice:

- `StateStore.acquire_run_mutation_lease(run_id, owner, mode)` persists one
  `RunMutationLease` on `RunSession.active_mutation_lease` and emits
  `run.lease.acquired`;
- `StateStore.require_run_mutation_lease(run_id, lease_id, owner, mode)`
  performs the compare-and-set read guard before a caller mutates run state and
  emits `run.lease.lost` when the expected lease is missing or stale;
- `StateStore.release_run_mutation_lease(run_id, lease_id, owner)` clears only
  the matching active lease and emits `run.lease.released`;
- failed release attempts are fail-closed and persist
  `run.lease.release_rejected` before raising.

Runtime integration slice:

- `SuperClawOrchestrator` uses the StateStore acquire, require, and release
  methods instead of hand-writing persisted lease mutation;
- the in-process runtime lock remains a local live-writer guard before stale
  persisted leases are reclaimed;
- lease-loss during execution still records a critical `run_mutation_lease`
  finding and fails the run closed.

This slice is intentionally a storage-level guard. It does not by itself
implement resume scheduling, stale-run reconciliation, cancellation, or DAG
orchestrator behavior; those remain Phase 2 runtime responsibilities.

### Phase 1 Deliverables

- this state contract implemented or codified in repo docs and code comments where needed
- explicit status transition validation in runtime or state layer
- task attempt semantics documented in code-facing spec
- protocol adapter interface documented
- evidence-backed resume eligibility enforced during stale-run reconciliation
- storage-level run mutation lease acquire, require, and release behavior
  covered by tests
- execute, resume, and reconcile paths use the same StateStore lease contract
  rather than a separate hand-written persistence path

### Phase 1 Acceptance Criteria

- there is a documented and reviewable run status transition table
- invalid transitions are rejected by tests
- evidence serialization round-trip is stable for representative runs
- resume eligibility is deterministic from persisted state alone
- missing or unreadable evidence fails stale-run reconciliation closed instead
  of creating blank evidence and continuing
- external ClawHunt payload shaping is isolated behind a named adapter layer
- duplicate or stale run mutation leases fail closed with persisted audit events
- runtime lease loss produces both a persisted lease event and a failing
  machine-readable finding

### Phase 1 Verification

- unit tests for allowed and forbidden status transitions
- serialization tests for `RunSession`, `TaskGraph`, and `EvidenceBundle`
- reconciliation tests for missing and unreadable resume evidence
- contract test showing the adapter can map a stored evidence bundle into a submission payload without mutating core state
- state-store tests for lease acquire, duplicate acquire rejection, stale lease
  loss recording, and rejected release recording
- orchestrator regression tests for stale lease reclamation, duplicate writer
  rejection, resume/reconcile guard behavior, and execution-time lease loss

## Phase 2: Runtime Robustness

### Goal

Make the current linear orchestrator durable enough that real local runs can survive retries, cancellations, restarts, and stale state reconciliation without losing auditability.

### Required Work

1. Add deterministic resume behavior.
2. Add stale-run reconciliation.
3. Harden cancellation and forced-kill outcomes.
4. Make verification a first-class persisted stage.
5. Ensure evidence updates are idempotent and replay-safe.

### Phase 2 Spec Requirements

#### 1. Resume

Resume must:

- reload run, task graph, evidence, and events from storage
- identify the next executable task without re-running already completed tasks
- preserve prior worker outputs and artifacts
- emit an explicit resume event

Resume must not:

- silently overwrite existing evidence
- reclassify a failed task as passed without a new attempt record
- reuse transient in-memory state as the source of truth

Implemented resume evidence-preservation slice:

- `resume_run()` reloads the stored `EvidenceBundle` through the same
  `execute_existing_session()` path before continuing a reconciled run;
- prior worker results, worker-log artifacts, and command evidence remain in
  the persisted bundle after remaining tasks execute and the final
  `evidence-json` artifact is written;
- the resumed run emits the existing `run.reconciled` and `run.resumed` audit
  events, so the preservation can be inspected from stored run state plus
  artifacts instead of transient memory.

This slice proves evidence preservation for eligible stale local runs only. It
does not add process-level interrupt injection, worker pid or heartbeat
liveness, external process detection, background reconciliation, cancellation
semantics, resumable verification jobs, protocol export, plugin runtime
behavior, cloud sync, marketplace, payment, or production recovery tooling.

Implemented local interrupt-resume integration slice:

- a real local execution path can complete one worker task, persist its command
  evidence and artifact references, then simulate a process exit during the next
  task after that task has been marked `running`;
- a fresh `StateStore` and `SuperClawOrchestrator` instance can reconcile the
  interrupted run to `queued`, resume from persisted execution context, and
  complete the remaining tasks without rerunning the completed task;
- the recovered run emits `run.reconciled`, `run.resumed`, and terminal
  completion events, and preserves the pre-interrupt worker result as the only
  result for that completed task.

This slice covers synchronous local interrupt-resume integration only. It does
not add OS-level crash injection, background reconciliation, heartbeat workers,
external process detection, orphan process cleanup, cloud worker recovery,
protocol export, plugin runtime behavior, marketplace, payment, or production
recovery tooling.

#### 2. Stale-Run Reconciliation

A stale run is any `queued`, `running`, or `verifying` run whose active worker is no longer alive or whose execution lease cannot be proven.

The reconciler must classify stale runs into one of:

- resumable
- failed
- cancelled

The reconciler must never auto-complete a stale run.

Implemented fresh-lease guard slice:

- public `reconcile_run()` no longer clears an active persisted
  `RunMutationLease` before acquisition;
- fresh persisted leases are classified as `active_writer`, leave the run
  status unchanged, keep the lease attached, and record the existing
  `run.reconcile.ignored` audit path;
- `resume_run()` inherits the same guard because it reconciles active runs
  before execution resume;
- expired leases are still reclaimed only through the shared
  `_try_acquire_run_mutation` path after the in-process runtime lock is proven
  available.

This slice is a single-writer safety fix only. It does not add worker pid or
heartbeat liveness, external process detection, background reconciliation,
resume scheduling, cancellation semantics, verification persistence, protocol
export, plugin runtime behavior, or cloud sync.

Implemented local worker-pid liveness slice:

- acquired `RunMutationLease` records persist the local `worker_pid` and
  `worker_host` that took mutation authority;
- `_try_acquire_run_mutation()` treats a same-host lease as stale before TTL
  only when the recorded pid is provably gone from the local process table;
- reclaimed leases emit `run.lease.stale` with the recorded pid, host, and
  `stale_reason`, so stale-worker reconciliation is inspectable from stored
  events;
- the public API and CLI reconcile entrypoints both have regression coverage
  proving the same dead-pid lease path is reachable without direct database
  surgery.

This slice covers same-host local process liveness only. It does not add a
heartbeat daemon, cross-host process verification, pid-start-time validation,
background reconciliation, cloud worker tracking, cancellation semantics,
resume scheduling, protocol export, plugin runtime behavior, marketplace,
payment, or production recovery tooling.

#### 3. Verification Stage Persistence

Verification must be represented as a real stage transition, not an implicit tail step. At minimum:

- entering verification emits `run.verifying`
- adversarial findings are persisted before final verdict
- final verdict is derived from stored evidence and findings, not only live process state

Implemented verifier-finding persistence slice:

- after entering `run.verifying`, adversarial verifier findings are applied to
  the `EvidenceBundle` and saved before `verification.finding` and
  `verification.completed` events are emitted;
- the `verification.completed` event's `chain_verdict` is derived from the
  evidence bundle that already contains persisted verifier findings;
- terminal `run.completed` and `run.failed` events continue to use the same
  stored verdict after verification.

This slice closes the verifier-finding persistence ordering gap only. It does
not add process-level crash recovery, resumable verification jobs, external
worker liveness, background reconciliation, cancellation semantics, verifier
rule expansion, protocol export, plugin runtime behavior, or cloud sync.

Implemented verification restart-resume slice:

- a run persisted in `verifying` with a completed task graph can be resumed by
  a fresh `StateStore` and `SuperClawOrchestrator` instance;
- resumed verification does not rerun already completed workers, keeps prior
  worker evidence and pre-restart verifier findings, and emits the normal
  `verification.completed` plus terminal run event;
- the recovery path remains evidence-backed through the stored task graph,
  evidence bundle, and events rather than transient in-memory state.

This slice covers local restart-resume from the persisted verification stage
only. It does not add resumable verifier jobs, process-level crash injection,
verification checkpointing inside individual verifier rules, background
reconciliation, external worker liveness, cancellation semantics, verifier rule
expansion, protocol export, plugin runtime behavior, cloud sync, marketplace,
payment, or production recovery tooling.

#### 4. Evidence Idempotency

Repeated save operations for the same normalized command or finding must not create uncontrolled duplication. The implementation may use append-only semantics internally, but the externally visible evidence bundle must remain stable and reviewable.

Implemented worker-result idempotency slice:

- `EvidenceBundle.add_worker_result` and `EvidenceBundle.normalize` collapse
  duplicate worker result records by replay identity: task, role, backend,
  command, attempt index, timestamps, outcome flags, and artifact references;
- re-saving the same logical worker attempt replaces that record instead of
  appending another externally visible row;
- distinct attempts or distinct outcomes remain separate records, so failed and
  successful attempts are not merged without a new attempt identity;
- worker result output remains capped to the primary evidence text limit before
  persistence.

This slice is evidence-normalization only. It does not change scheduler retry
policy, task attempt allocation, backend execution, cancellation, verification
verdicts, protocol export, ClawHunt submission, plugin proxy behavior, or cloud
sync.

#### 5. Evidence Size Limits

The short-term system must define hard caps for evidence-heavy fields. Minimum required limits:

- normalized command output stored in primary evidence: at most 4,000 characters per command
- transcript preview stored in primary evidence: at most 4,000 characters per task attempt
- large stdout, stderr, or full transcripts must move to artifacts
- evidence serialization for one run must remain loadable without streaming support

Implemented evidence size-limit slice:

- `EvidenceBundle.add_command`, `EvidenceBundle.add_worker_result`, and
  `EvidenceBundle.normalize` keep primary command output and worker attempt
  previews capped at 4,000 characters before serialization;
- local backend worker artifacts retain complete redacted stdout/stderr in the
  worker-log and transcript artifact files, while the stored `WorkerResult` and
  command evidence remain capped;
- evidence bundles keep only artifact references for large logs/transcripts, so
  persisted evidence stays loadable without streaming support.

This slice covers local backend stdout/stderr artifact retention and primary
evidence caps only. It does not add artifact size quotas, compression,
retention policy, object storage upload, remote backend transcript parity,
protocol export, plugin runtime behavior, cloud sync, marketplace, payment, or
production log streaming.

#### 5. Cancellation Semantics

When a run is cancelled:

- active subprocesses are terminated or escalated to forced kill
- transcript evidence records `cancelled` and `forced_kill`
- final run status is `cancelled` unless later reconciliation proves an earlier terminal state had already completed

Implemented cancellation restart-recovery slice:

- a persisted `run.cancel.requested`, `run.cancel.propagated`, `worker.cancelled`,
  or terminal `run.cancelled` event remains authoritative after a process
  restart;
- a fresh `StateStore` and `SuperClawOrchestrator` instance can reconcile the
  stored active run into terminal `cancelled` without requiring the original
  in-memory worker thread;
- previously stored cancellation evidence and command proof remain available,
  and resumed execution is rejected once the restarted reconciler finalizes the
  run as cancelled.

This slice covers persisted cancellation recovery after local orchestrator
restart only. It does not add background cancellation scheduling, cross-process
signal delivery after restart, external worker supervision, pid-start-time
validation, heartbeat liveness, protocol export, plugin runtime behavior, cloud
sync, marketplace, payment, or production recovery tooling.

Implemented forced-kill evidence slice:

- POSIX local subprocess cancellation now has regression coverage for workers that
  ignore normal termination and require kill escalation;
- the resulting `WorkerResult`, worker transcript, and worker-log artifact
  record `cancelled=true`, `forced_kill=true`, and exit code `130`;
- the existing orchestrator/API cancellation paths continue to surface
  `worker.cancelled` and `worker.forced_kill` from the same worker result
  fields.

This slice covers POSIX local backend forced-kill evidence semantics only.
Windows `terminate()` behavior is explicitly outside this regression. It does
not add a background cancellation scheduler, cross-host process supervision,
pid-start-time validation, process-tree termination, cloud worker cancellation,
protocol export, plugin runtime behavior, marketplace, payment, or production
kill orchestration.

### Phase 2 Deliverables

- `resume` support for eligible runs
- stale-run reconciliation command or background path
- explicit verification-stage persistence
- verifier findings persisted before `verification.completed`
- verification restart-resume regression coverage without rerunning completed
  workers
- idempotent evidence update behavior
- worker result replay-idempotency for repeated evidence save paths
- fresh persisted run mutation leases respected by reconcile and resume paths
- same-host worker-pid liveness used to reclaim provably dead active writers
- resume evidence-preservation regression coverage for prior worker results
  and artifacts
- local interrupt-resume regression coverage that restarts the store and
  orchestrator before continuing remaining tasks
- cancellation restart-recovery regression coverage for persisted cancellation
  events and evidence
- cancellation tests covering subprocess termination outcomes
- evidence size-limit regression coverage for large local worker stdout/stderr
  retained in artifacts while primary evidence remains capped
- forced-kill regression coverage for POSIX local workers that ignore normal
  termination and require kill escalation

### Phase 2 Acceptance Criteria

- an interrupted run can be resumed without losing prior evidence
- a stale run is deterministically reclassified without manual DB surgery
- verifier findings persist even if the process exits between execution and final verdict
- cancelling a run leaves stored status and evidence consistent
- no run reaches `completed` without passing through persisted verification

### Phase 2 Verification

- integration test: interrupt and resume a local run
- integration test: stale worker process is reconciled
- integration test: cancellation records survive restart
- regression test: persisted evidence contains verifier findings before
  `verification.completed` is emitted
- regression test: a restarted `verifying` run resumes verification without
  rerunning completed workers or losing pre-restart findings
- regression test: duplicated save path does not corrupt visible evidence bundle
- regression test: duplicate worker result writes collapse while distinct
  attempts or outcomes remain visible
- regression test: reconcile and resume do not steal a fresh persisted writer
  lease
- regression test: same-host dead worker pids allow stale lease reclamation
  before the normal lease TTL
- regression test: resumed runs preserve prior worker results and artifacts in
  both stored evidence and the final `evidence-json` artifact
- integration test: an interrupted local run resumes from persisted storage
  without rerunning the completed task
- regression test: large local worker stdout/stderr remains available from
  worker-log/transcript artifacts while primary evidence fields stay capped
- regression test: forced-killed POSIX local workers persist `cancelled`,
  `forced_kill`, and exit-code evidence in both result metadata and artifacts

## Phase 3: Protocol Expansion, Verifier Hardening, and Orchestration Upgrades

### Goal

Expand beyond the protocol skeleton only after the runtime is durable, then raise proof quality and orchestration flexibility without weakening the control plane.

### Required Work

1. Map internal evidence to the latest ClawHunt delivery protocol or package manifest.
2. Harden the adversarial verifier beyond the current four checks where platform claims require it.
3. Introduce parent-child execution semantics for subagents.
4. Upgrade from a fixed chain to a constrained DAG only after subagent lifecycle rules exist.

### Phase 3 Spec Requirements

#### 1. Protocol Expansion

The protocol adapter must support:

- payload shaping for latest ClawHunt submission contract
- explicit handling of unsupported fields
- evidence-to-package export without mutating internal evidence storage

If the external protocol changes, the adapter is the first change surface, not the core state model.

Implemented child execution protocol-export slice:

- delivery protocol manifests export sanitized child execution summaries from
  the stored `EvidenceBundle.child_executions` records;
- exported child summaries include child task/run identity, parent task
  identity, backend, status, depth, cancellation mode, timeout, evidence owner,
  chain verdict, and evidence artifact id;
- local evidence file paths such as `evidence_path` are deliberately excluded
  from the manifest, so the platform receives artifact references instead of
  host-specific storage details;
- the API and CLI protocol-export entrypoints both have regression coverage
  proving persisted child execution summaries are exposed through the public
  delivery package path without leaking local evidence paths.

This slice covers protocol adapter export of already-persisted child execution
metadata only. It does not add new child execution scheduling, fan-out policy,
DAG dependency behavior, cancellation propagation, verifier rules, ClawHunt
submission transport changes, plugin runtime behavior, marketplace, payment,
or production artifact upload.

#### 2. Verifier Hardening

Verifier hardening belongs here because it relies on persisted runtime semantics from Phase 2.

The verifier backlog must be structured into:

- proof-of-execution checks
- proof-of-negative-path checks
- artifact-to-submission consistency checks
- secret redaction checks
- backend-auth/readiness misclassification checks

Each new verifier rule must define:

- input fields used
- fail-open or fail-closed behavior
- severity
- expected remediation path

Implemented verifier rule-spec entrypoint slice:

- adversarial verifier rule specs are exposed through
  `/api/verify/adversarial` as `rule_specs` alongside the persisted findings;
- `superclaw verify --json` emits the same machine-readable rule specs for
  operator-facing verification, while the existing text output remains
  unchanged for human CLI use;
- each public rule spec includes `input_fields`, `fail_mode`, `severity`, and
  `remediation`, so Phase 3 verifier hardening can be audited through public
  entrypoints instead of only internal unit tests.

This slice exposes the existing verifier contract and public-entrypoint tests
only. It does not add new verifier rules, change pass/fail semantics, alter
chain verdict calculation, introduce async verifier jobs, modify protocol
export, change subagent scheduling, or add production ClawHunt submission
transport behavior.

Implemented verifier hardening public-failure slice:

- `/api/verify/adversarial` is covered for a persisted
  `plugin_policy_boundary` fail-closed finding when model-visible evidence
  exposes a direct plugin directory bypass;
- `superclaw verify --json` is covered for the same failure path, including
  persisted evidence parity after verification;
- both public entrypoints assert machine-readable severity, fail mode, detail,
  and persisted finding state, proving hardened verifier failures are not only
  internal unit-test behavior.

This slice tests the existing hardening rules at public entrypoints only. It
does not add new verifier rules, change failure thresholds, alter chain verdict
calculation, introduce async verifier jobs, modify protocol export, change
subagent scheduling, or add production ClawHunt submission transport behavior.

#### 3. Subagent Lifecycle

Subagents must not be treated as invisible helper calls. The minimum contract is:

- parent task identity
- child task identity
- child backend
- child evidence ownership
- aggregation rules into the parent run
- explicit cancellation and timeout propagation

No true subagent spawning is accepted until these semantics are defined.

Short-term safety limit:

- maximum subagent depth is `1`
- recursive child-of-child spawning is out of scope for this roadmap
- cyclical parent-child references must be rejected at creation time

Implemented subagent lifecycle API contract slice:

- `/api/runs/{run_id}/fanout` returns `child_executions` derived from the
  persisted parent evidence bundle, not only transient fan-out summaries;
- each returned child execution includes parent/child run identity,
  parent/child task identity, backend, status, depth, linked cancellation mode,
  timeout, evidence owner, chain verdict, and child evidence artifact id;
- the API response is regression-tested against persisted parent evidence and
  the required `child_run.spawned`, `child_evidence.added`, and
  `child_fanout.completed` audit events.

This slice makes the existing depth-1 subagent lifecycle contract consumable
through the API. It does not introduce recursive subagents, arbitrary nesting,
new cancellation behavior, new fan-out aggregation policies, production worker
queues, protocol submission transport, plugin runtime behavior, marketplace,
payment, or production artifact upload.

#### 4. DAG Upgrade Constraint

The system may move beyond the fixed linear chain only when:

- task dependencies are persisted
- retry semantics for branched execution are defined
- verifier aggregation across branches is defined
- parent-child evidence aggregation is testable

DAG support is not considered shipped unless at least one persisted non-linear dependency pattern is executable, resumable, and covered by integration tests. A vague deferral note is not sufficient.

Implemented constrained topology CLI slice:

- `superclaw run --task-topology explore_fanout --backend local` is covered as
  a real, non-dry CLI execution path;
- the public CLI entrypoint persists the requested topology in run context,
  spawns bounded depth-1 explore children, aggregates child evidence into the
  parent evidence bundle, and records `child_run.spawned`,
  `child_evidence.added`, and `child_fanout.completed` events;
- the parent evidence bundle retains a machine-readable `subagent_fanouts`
  summary with aggregation policy and child verdicts, while the normalized
  `child_executions` records retain child evidence artifact ids for protocol
  export and review.

This slice proves one constrained DAG/topology pattern is operator-visible
through the CLI and evidence system. It does not add arbitrary user-authored DAG
editing, unbounded recursion, child-of-child spawning, generalized scheduler
policy, production multi-worker queues, ClawHunt submission transport changes,
plugin runtime behavior, marketplace, payment, or production artifact upload.

Implemented review-consensus API topology slice:

- `/api/runs` is covered for a real, non-dry `review_consensus` topology run
  against the local backend;
- the API-created run persists the requested topology, creates three bounded
  review child executions, aggregates them under the `consensus` fan-out policy,
  and exposes child evidence artifact ids through the parent evidence bundle;
- the public event stream is regression-tested for `child_run.spawned`,
  `child_evidence.added`, `child_fanout.completed`, and `run.completed`.

This slice proves a second constrained topology pattern through the API surface
and evidence system. It does not add arbitrary DAG authoring, user-authored
dependency editing, recursive subagents, production multi-worker queues,
protocol submission transport changes, plugin runtime behavior, marketplace,
payment, or production artifact upload.

### Phase 3 Deliverables

- protocol adapter for latest ClawHunt submission path
- expanded verifier rule set and tests
- subagent execution spec and initial implementation
- constrained DAG support with at least one shipped non-linear dependency pattern, or explicit removal from the phase scope before implementation begins

### Phase 3 Acceptance Criteria

- a stored evidence bundle can export to the target ClawHunt delivery package without core-model mutation
- verifier failures can block false-positive completion on real backend edge cases
- child execution is visible in persisted state and evidence
- DAG execution, if shipped, preserves deterministic evidence aggregation and resume behavior

### Phase 3 Verification

- contract tests against representative ClawHunt payload shapes
- adversarial tests for secret leakage, fake success, and evidence mismatch
- integration tests for parent-child execution and cancellation propagation
- DAG tests, if enabled, for dependency ordering and evidence aggregation

## Development Standards

The following standards are mandatory while implementing this roadmap.

### Code Standards

- add typed fields and explicit enums before adding behavior branches
- avoid stringly-typed hidden state transitions
- no direct API handler mutations of evidence without going through a state or orchestration layer
- no backend-specific success heuristics without a recorded finding or probe
- no protocol-specific branching inside generic core models unless the branch is documented as a compatibility shim

### Testing Standards

- every new terminal run status must have at least one transition test
- every new verifier rule must have both pass and fail tests
- every resume or reconciliation path must have at least one integration test
- every external protocol adapter must have contract fixtures

### Evidence Standards

- redact secrets before persistence where possible, and always before presentation
- keep artifacts as references, not giant embedded payloads
- normalize command output tails rather than storing uncontrolled logs in primary evidence
- findings must remain machine-readable and severity-tagged

### API Standards

- async API responses must reflect persisted truth, not optimistic in-memory assumptions
- event streams must be derivable from stored events
- terminal API status must agree with stored `RunSession.status`
- terminal API responses must not claim success before the corresponding terminal event and state mutation are durably stored

### Review Standards

No phase is accepted if it relies on:

- undocumented state transitions
- silent evidence mutation
- verifier rules that cannot be traced to stored input data
- protocol coupling that forces immediate core-model rewrites

## Definition of Done For This Roadmap

This short-term roadmap is complete only when all of the following are true:

- the internal state skeleton is explicit and tested
- resume and stale-run handling work on real local runs
- verification is a persisted stage, not just a terminal side effect
- protocol export is handled through adapters
- verifier hardening blocks known false-positive paths
- subagent and DAG work, if introduced, do not weaken evidence determinism

## Immediate Build Order

The concrete build order for the next cycle is:

1. codify the protocol skeleton and transition rules
2. implement runtime resume and stale-run reconciliation
3. persist verification as an explicit stage
4. harden evidence idempotency and cancellation semantics
5. add protocol adapter expansion and verifier hardening
6. defer subagents and DAG until the first five items are stable

## Acceptance Summary

This roadmap is acceptable only if the team treats it as a control-plane hardening plan. If implementation drifts into feature expansion before Phase 2 is stable, the likely result is a more complex system with weaker proof quality rather than a stronger delivery agent.
