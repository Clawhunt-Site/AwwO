# SuperClaw Long-Term Roadmap

This document tracks the work that is intentionally not complete after the
short-term control-plane roadmap. The short-term roadmap hardened local run
state, evidence, verification, protocol export, and bounded topology behavior.
This long-term roadmap turns that control plane into a production delivery
runtime, plugin ecosystem, and platform business loop.

## Current Baseline

Short-term completion means SuperClaw can produce auditable local runs with
durable evidence and reviewable protocol exports. It does not mean SuperClaw has
production ClawHunt settlement, a public plugin marketplace, payment rails,
multi-tenant worker infrastructure, or unrestricted workflow orchestration.

The current completed baseline is documented in:

- `docs/short-term-roadmap.md`
- `docs/roadmap-acceptance-matrix.md`
- `docs/plugin-ecosystem-framework.md`
- `docs/plugin-developer-guide.md`

## Long-Term Product Goal

SuperClaw should become the delivery runtime and plugin operating layer for the
ClawHunt/SuperClaw ecosystem:

- users submit or consume work through a standard delivery protocol;
- agents complete work through supervised runtimes such as Codex, Claude Code,
  Hermes, OpenClaw, and future adapters;
- every delivery produces signed, replayable, reviewable evidence;
- accepted reusable deliveries can become plugins;
- independent developers can upload plugins directly;
- users can pay for verified plugin capabilities;
- platform operators can audit, revoke, dispute, and re-verify any delivery or
  plugin without trusting model claims.

## Phase L1: Mainline Integration And Release Discipline

### Goal

Move the current stacked short-term implementation from ready PRs into a stable
mainline release path.

### Required Work

- Merge or restack the current PR series in dependency order.
- Keep each merge atomic enough to preserve reviewability.
- Run full regression after the stack lands on `main`.
- Publish a release note that distinguishes control-plane readiness from
  production E2E readiness.
- Decide whether long stack PRs should be squashed into fewer feature-group PRs
  for future development.

### Acceptance Criteria

- All short-term PRs are merged or replaced by an equivalent clean stack.
- `main` passes the full test suite.
- `CHANGELOG.md` and `VERSION` reflect the release state.
- No draft PR remains as a required dependency for the short-term baseline.

### Non-Goals

- Do not add new runtime features while merging the existing stack.
- Do not claim production ClawHunt E2E until live platform tests pass.

## Phase L2: Production ClawHunt Delivery E2E

### Goal

Prove that SuperClaw can take a real ClawHunt task through execution,
submission, platform review, and accepted settlement using production-like
credentials and artifact transport.

### Required Work

- Define the live ClawHunt delivery API contract, including submission payload,
  artifact upload, evidence bundle reference, status polling, and final
  acceptance response.
- Add an environment-gated production E2E test lane.
- Store submission ids, artifact ids, review status, and settlement state in the
  evidence bundle.
- Add retry, timeout, and idempotency rules for submission and artifact upload.
- Add operator-visible failure modes for rejected, expired, duplicate, or
  partially uploaded submissions.

### Acceptance Criteria

- A live or staging ClawHunt problem can be solved and submitted by SuperClaw.
- The platform can read the submitted evidence package without local filesystem
  paths.
- The final accepted/rejected platform verdict is persisted in evidence.
- A failed upload or rejected submission is fail-closed and auditable.
- The E2E test is skippable without credentials but mandatory in release
  certification.

### Non-Goals

- Do not couple core evidence models directly to ClawHunt API shapes.
- Do not hide failed submissions behind `CHAIN_PARTIAL` success language.

## Phase L3: Standard Delivery Package And Replay Infrastructure

### Goal

Upgrade evidence export from a report-like artifact into a platform-consumable
delivery package that can be replayed, audited, and disputed.

### Required Work

- Define a versioned delivery package manifest.
- Include artifact digests, verifier findings, run events, task graph,
  topology metadata, plugin invocation summaries, and submission references.
- Add package signing and signature verification.
- Add replay fixtures that can re-run verifier checks without re-running the
  original agent.
- Add evidence retention and redaction policy by sensitivity level.

### Acceptance Criteria

- A delivery package can be exported, signed, imported, verified, and replayed.
- Replay can reproduce verifier findings from stored evidence.
- Package verification fails if artifacts, digests, or signatures drift.
- Redacted package views are safe for users, developers, and platform reviewers.

### Non-Goals

- Do not require replay to re-execute the original production task.
- Do not expose raw secrets, local paths, or protected plugin internals.

## Phase L4: Verifier Expansion And Dispute Review

### Goal

Turn the adversarial verifier from a local quality gate into a production
acceptance and dispute-review subsystem.

### Required Work

- Add verifier rules for artifact-to-submission consistency.
- Add proof-of-negative-path and protected-resource checks per task class.
- Add backend readiness and auth-blocker classification.
- Add plugin policy, revocation, and entitlement consistency checks.
- Add dispute review mode with reviewer notes and appeal evidence.
- Version verifier rules and record which rule version judged each delivery.

### Acceptance Criteria

- Verifier findings can block platform acceptance.
- Reviewer override requires explicit signed rationale.
- Disputes can replay the original evidence package and verifier version.
- Rule changes are backwards compatible or explicitly migration-gated.

### Non-Goals

- Do not allow silent human override of critical verifier failures.
- Do not make verifier rules depend on transient in-memory agent state.

## Phase L5: Configurable DAG And Production Worker Runtime

### Goal

Move from bounded topology presets to a configurable, persisted, resumable DAG
runtime with production worker supervision.

### Required Work

- Define a user-authored DAG schema with dependency, retry, timeout,
  cancellation, and aggregation semantics.
- Persist worker leases, heartbeats, attempt records, and branch-level evidence.
- Add production queues or schedulers for concurrent work.
- Add cross-host liveness and orphan-worker cleanup.
- Add deterministic resume for branched graphs.
- Add branch-level verifier aggregation and final verdict rules.

### Acceptance Criteria

- A non-linear user-authored DAG can execute, pause, resume, cancel, and verify.
- Branch retry and failure behavior is deterministic and auditable.
- Cross-host worker loss is reconciled without guessing.
- DAG evidence aggregation is stable across replay.

### Non-Goals

- Do not introduce unrestricted workflow power before evidence aggregation is
  deterministic.
- Do not treat child agents as invisible helper calls.

## Phase L6: Plugin Marketplace And Developer Economy

### Goal

Build the commercial loop where ClawHunt deliveries and independent developer
uploads can become reusable, paid, verified SuperClaw plugins.

### Required Work

- Define marketplace listing, review, pricing, versioning, and takedown flows.
- Add developer identity, ownership, revenue attribution, and payout records.
- Add plugin purchase, entitlement, billing, and usage-metering contracts.
- Add package signing, revocation, update compatibility, and rollback.
- Add public plugin discovery, install, update, and usage reporting APIs.
- Add separate ingestion paths for ClawHunt-derived plugins and independent
  developer-uploaded plugins.

### Acceptance Criteria

- A reusable accepted ClawHunt delivery can become a plugin package.
- An independent developer can upload a plugin and pass review gates.
- A user can install and use an entitled paid plugin.
- Revocation blocks plugin use before sidecar startup.
- Usage and payout records are auditable without exposing user secrets.

### Non-Goals

- Do not let Codex, Claude Code, Hermes, OpenClaw, or any downstream runtime
  access protected plugin source or marketplace credentials directly.
- Do not ship payment flows without dispute, refund, revocation, and audit
  paths.

## Phase L7: Runtime Adapter Expansion

### Goal

Make SuperClaw the stable control layer above multiple agent runtimes without
leaking protected plugin or platform internals into those runtimes.

### Required Work

- Define a stable worker adapter contract for Codex, Claude Code, Hermes,
  OpenClaw, local shell, and future runtimes.
- Normalize auth/readiness/error reporting across runtimes.
- Route plugin calls through SuperClaw proxy or sidecar boundaries only.
- Keep secrets and entitlements in the SuperClaw layer, not model-visible
  prompts or runtime config files.
- Add conformance tests for every supported runtime adapter.

### Acceptance Criteria

- Each runtime can run the same task contract and produce comparable evidence.
- Runtime-specific auth or quota failures are classified consistently.
- Plugin invocation evidence never exposes protected package paths or secrets.
- A runtime can be disabled without breaking the core delivery package format.

### Non-Goals

- Do not optimize for runtime-specific shortcuts that bypass SuperClaw evidence.
- Do not let plugin execution become a direct model-to-binary call without
  proxy policy enforcement.

## Phase L8: Production Security, Privacy, And Operations

### Goal

Make the platform safe to operate with real users, real tasks, real plugins, and
real money.

### Required Work

- Add production secret storage and scoped injection.
- Add tenant isolation, workspace isolation, and artifact access controls.
- Add signed audit logs and tamper-evident event storage.
- Add privacy-preserving evidence views for user, developer, reviewer, and
  platform operator roles.
- Add operational dashboards for run health, queue health, verifier failures,
  plugin revocations, and payment disputes.
- Add incident response workflows for compromised plugins, bad payouts, leaked
  secrets, and malicious submissions.

### Acceptance Criteria

- Secrets are never persisted in plaintext evidence or model-visible outputs.
- Users can inspect what a plugin did without seeing protected internals.
- Operators can revoke a plugin and prove revocation enforcement.
- Incident response can identify affected runs, users, plugins, and payments.

### Non-Goals

- Do not rely on local fake-cloud behavior as proof of production safety.
- Do not expose raw logs as a substitute for role-scoped evidence views.

## Phase L9: Cross-Platform Windows Support

### Goal

Make SuperClaw a first-class citizen on Windows for the CLI, API, and Desktop
surfaces, without weakening any of the fail-closed governance, trust, and
permission guarantees that currently assume a POSIX environment. Until this
phase lands, Windows is **explicitly unsupported** (Est. 20–30% ready today),
and the platform should fail fast rather than degrade silently.

### Current Status (Audit, 2026-06-23)

SuperClaw is developed and CI-tested only on macOS/Linux, so Windows-specific
defects are never caught. A code scan found correct Windows branches in a few
places (proof the gap is known) but several blocking failures and silent
governance bypasses elsewhere. (This subsection is unique to L9; it documents a
portability audit and has no analogue in L1–L8.)

- **Crashes**: `workspace_resolver.py` calls `os.getuid()` unconditionally in
  its fail-closed dir-trust check — `AttributeError` on Windows, which takes
  down the whole workspace trust path.
- **Daemon unsupported**: `daemon.py` only implements POSIX `AF_UNIX` broker
  IPC; `WindowsNamedPipeDaemonBrokerIPCServer` is a `NotImplementedError` stub,
  so the daemon cannot start on Windows.
- **POSIX-only `fcntl`/`select` in core paths (two distinct classes)**:
  (a) *True file locks* — `relay_key.py` imports `fcntl` and calls `flock()`
  with no Windows path (ImportError). (b) *Nonblocking child-process pipe I/O* —
  the ClawWork RPC hot path in `backends.py` uses `fcntl(F_SETFL, O_NONBLOCK)`
  plus `select.select()` on subprocess pipes, so a core runtime capability (not
  just relay-key bookkeeping) breaks on Windows. These need **different** fixes:
  (a) is solved by the `fcntl`/`msvcrt` dual file-lock fallback already proven in
  `skill_sync.py`; (b) cannot use `msvcrt` locking at all — `select()` does not
  work on pipes on Windows, so it needs a separate Windows-compatible subprocess
  I/O design (threads / overlapped I/O / asyncio).
- **Process teardown (narrowed)**: `claude_stream.py` and `desktop_runtime.py`
  *do* have Windows branches (`os.name == "nt"` → `terminate()`/`kill()`) for
  the processes they own, so they are not the blocker. The real gaps are
  PID-only shutdown paths (e.g. `cli.py` calling `os.kill(pid, SIGTERM)` with no
  Windows branch), daemon teardown, and the lack of process-tree / Windows Job
  Object semantics for killing child trees that POSIX gets from process groups.
- **Trust digest skew**: signature digests fold in Unix-only signals that do
  not exist or differ on Windows — `trust.py` `mode_signal()` and
  `skill_store.py` (`S_IXUSR` for executable-asset/digest decisions) both read
  `st_mode` permission bits. A larger and easier-to-miss divergence source is
  **newline handling**: Windows git checkouts default to CRLF, so text-derived
  digests computed on Windows will not match macOS/Linux-signed digests unless
  newlines are normalized. Either source makes plugin/capability verification
  verdicts diverge cross-platform.
- **Silent governance bypass (security-relevant)**: `secrets_store.py` guards
  the secrets-key-file permission check behind `if os.name == "posix"`, so on
  Windows the world-readable-credential check is skipped entirely; the 50+
  `os.chmod(..., 0o700/0o600)` call sites are silently ignored (Windows uses
  ACLs), so intended permission tightening does not take effect.
- **Console encoding**: Windows consoles are not UTF-8 by default (legacy code
  pages such as CP1252/GBK), so CLI/agent output containing emoji or non-ASCII
  text can raise `UnicodeEncodeError` and crash — violating "the CLI runs
  cleanly."

Two things that look like Windows blockers but are **not**, and must stay as-is:

- `company_export.py` bundle-path validation rejecting `\` is a deliberate
  **security boundary** — bundle-internal paths must be POSIX-relative — not a
  Windows-path gap. It must not be relaxed to "accept backslashes."
- Windows escape vectors are the genuine path concern instead: drive-qualified
  paths (`C:\`), UNC paths (`\\server\share`), and reserved device names
  (`CON`, `NUL`, `PRN`, including suffixed forms like `con.txt`) can defeat a
  defense that only blocks `..`.

What already works: `clawwork.exe` / `codex.exe` discovery, shebang resolution
in `process_scripts.py`, the `skill_sync.py` locking fallback, the
`claude_stream.py`/`desktop_runtime.py` owned-process Windows teardown branches,
the daemon's explicit non-POSIX fail-closed guard, and a Tauri `targets: "all"`
config that can in principle emit a Windows bundle (never tested).

### Required Work

- Establish the portability boundary: route all permission/ownership/sticky-bit
  checks through a single platform-aware helper, with a Windows implementation
  that uses ACL-based equivalents — never a silent skip of a fail-closed gate.
  For confidentiality-critical paths (e.g. the secrets key file) the rule is
  strict: implement a real ACL-based equivalent, or disable that feature on the
  platform; degrading to "no permission control" is not an acceptable policy.
- Replace unconditional `os.getuid()` / `st_mode & 0o022` / `S_ISVTX` logic in
  `workspace_resolver.py`, `trust.py`, and `skill_store.py` with the portability
  helper.
- Make trust/signature digests platform-invariant: normalize newlines (CRLF→LF)
  and strip non-portable permission bits before hashing, so the same inputs
  verify identically on Windows, macOS, and Linux (or enforce LF via
  `.gitattributes` for signed material).
- Fix the two POSIX-only I/O classes with their correct strategies: (a) for
  true file-lock sites (`relay_key.py` and similar `flock()` uses) add the
  `fcntl`/`msvcrt` dual-fallback proven in `skill_sync.py`; (b) for the
  `backends.py` ClawWork RPC nonblocking pipe path (`fcntl` `O_NONBLOCK` +
  `select` on pipes) design a separate Windows-compatible subprocess I/O layer
  (threads / overlapped I/O / asyncio) — `msvcrt` locking does not apply here.
- Make process teardown portable for the gaps above: a single helper covering
  PID-only shutdown, daemon teardown, and child-process-tree termination
  (process groups + `SIGTERM`/`SIGKILL` on POSIX, `terminate()`/`kill()` plus
  Windows Job Objects for trees); fix the unconditional `os.kill(pid, SIGTERM)`
  in `cli.py`.
- Implement Windows named-pipe daemon broker IPC, or formally scope the daemon
  as POSIX-only with a fail-closed, operator-visible error on Windows.
- Restore the secrets-key-file permission guarantee on Windows via ACL checks
  (not a `posix`-only skip), and audit the silently-ignored `chmod` sites for
  ones that are load-bearing for confidentiality.
- Harden path defenses against Windows escape vectors (drive letters, UNC,
  reserved device names) while keeping the existing `..`-traversal and
  bundle-internal POSIX-relative defenses fully intact.
- Force UTF-8 console I/O (or otherwise make output encoding-safe) so non-ASCII
  CLI/agent output never raises `UnicodeEncodeError` on legacy code pages.
- Define a `windows-latest` CI lane running the full `ci.yml` equivalent as a
  **future release gate**; mark genuinely Unix-only tests with explicit,
  justified skips rather than leaving them to fail. (Note: the remote CI is
  currently paused per the project's CI铁律, so until it is restored this is a
  release-gate requirement plus a local-equivalent run, not a pre-PR GitHub
  Actions judging surface.)
- End-to-end test CLI, API server, and the Desktop (Tauri) bundle on Windows;
  add Windows install instructions and a published platform-support matrix.

### Acceptance Criteria

- `superclaw doctor` and the core CLI run cleanly on Windows with no crashes in
  trust, workspace, secrets, relay, ClawWork RPC, or process-teardown paths, and
  no `UnicodeEncodeError` on non-UTF-8 consoles.
- Every fail-closed governance gate (workspace trust, secrets permissions,
  plugin/capability trust) either enforces an equivalent guarantee on Windows or
  fails closed with an explicit, documented error — no silent skips.
- Plugin/capability signature verification produces identical verdicts on
  Windows, macOS, and Linux for the same inputs, including across CRLF/LF
  checkouts.
- The daemon either works on Windows or refuses to start with a clear,
  operator-visible "POSIX-only" error.
- A `windows-latest` CI lane (or, while remote CI is paused, the local
  equivalent) is green before any Windows-support release claim.
- The Desktop bundle installs and runs on Windows in an end-to-end smoke test.
- Until all of the above hold, Windows entry points fail fast with a clear
  "Windows support is experimental/unsupported" message rather than partially
  executing.

### Non-Goals

- Do not weaken or bypass any fail-closed gate to make Windows "work" — a
  silently-skipped permission check is worse than an explicit unsupported error.
- Do not relax the `company_export.py` bundle-internal POSIX-relative path
  validation to "support Windows paths" — that rejection is a security boundary,
  not a portability gap.
- Do not fork core logic per platform; isolate platform differences behind a
  thin portability layer so the kernel stays the single source of truth.
- Do not claim Windows support before the Windows CI lane (or its paused-CI
  local equivalent) and the Desktop E2E smoke test are both green.

## Cross-Phase Release Gates

Every long-term phase must satisfy these gates before release:

- documented scope and non-goals;
- implementation behind stable APIs or adapters;
- positive and negative tests for every public feature boundary;
- live or staging E2E tests for production claims;
- evidence redaction and secret-leakage tests;
- changelog entry with what changed, why, impact, verification, and files;
- Gemini or equivalent independent review for architecture-level claims;
- rollback plan for production-facing behavior.

## Priority Recommendation

The next practical sequence should be:

1. Merge or restack the current short-term PR stack.
2. Build production ClawHunt delivery E2E.
3. Turn evidence export into signed delivery packages with replay.
4. Expand verifier/dispute infrastructure.
5. Only then expand configurable DAG, marketplace, payments, and multi-runtime
   plugin commercialization.

This order keeps the platform from selling or scaling capabilities before it
can prove delivery, replay evidence, and enforce plugin policy safely.

Cross-platform Windows support (Phase L9) is a recognized **future goal**, not
part of the near-term platform-core sequence above. It is deliberately
sequenced after the delivery/evidence/policy core is stable, because the work is
a portability-and-governance hardening pass (fail-closed gates currently assume
POSIX) rather than a new capability. Until L9 lands, Windows entry points should
fail fast as unsupported.
