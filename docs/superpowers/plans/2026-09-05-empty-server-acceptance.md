# AwwO empty-server acceptance plan

> For agentic workers: use superpowers:executing-plans to execute this deployment in bounded steps. User has requested deployment and real acceptance; no additional execution-choice approval is required.

**Goal:** Deploy published AwwO v0.3.0 to an isolated Linux host and verify the actual browser, native Agent and persistent state behavior.

**Architecture:** Install the release under a non-root service account with dedicated native PostgreSQL, Node control plane, Gateway, and built Web preview. Record any installation repair separately from the immutable source tag. Bind every application listener to loopback. SSH authentication is the outer access gate; no public HTTP listener is created. This first host is explicitly a single-operator acceptance environment. Authenticated account APIs are tested in a separate isolated instance because v0.3.0 Gateway does not yet propagate workspace user identity to all upstream HTTP/WS calls.

**Tech Stack:** Ubuntu 24.04 x86_64, Node 24, pnpm 9.15.4, native PostgreSQL, systemd, OpenSSH, Codex CLI.

**Spec:** Operator request in this task, `docs/awwo-development.md`, `docs/accounts-and-languages.md`, `docs/awwo-v0.3-validation.md`.

## Constraints

- Source version is v0.3.0, commit `6e1dc158a79e2f18c7bdf82610a353883b883f31`, tree `449259d15edc3a5130df538fad4f0f19bba95614`.
- The vendored `server/` tree remains unchanged.
- Existing production and stopped business machines and their data remain untouched.
- Use an identified empty host or a newly approved dedicated AWS instance. Existing AWS names are discovery evidence, not proof of an empty host.
- APP_ENV and VITE_APP_ENV are staging. Explicitly configure planner provider; stage defaults must not silently use production integrations.
- No production database credentials, external email, payment keys, or test messages to third parties.
- The operator explicitly authorized reusing the currently logged-in local Codex credential on this dedicated host. Transfer only that authentication file over SSH stdin with private permissions; do not copy Windows configuration, print tokens or include credentials in Git or release archives.
- Keep database, runtime state, credentials, build outputs, logs, inventory and receipts outside Git.
- SSH tunnel access is operator-scoped and is not multi-tenant authentication. Do not claim otherwise.

## Task 1: Target and source proof

- [x] Fetch Forgejo and verify published source and clean worktree.
- [x] Inspect current runtime entry points and distinguish obsolete deployment scripts.
- [x] Query accessible AWS instance inventory without modifying existing workloads.
- [x] Resolve the operator's target choice; record instance ID, region, image, disk, IP, and empty-host inspection.
- [x] Verify source archive SHA-256 on both local and remote machines.

## Task 2: Repeatable private installation

**Files:** `scripts/deploy/awwo-private-acceptance.sh`, `docs/awwo-server-acceptance.md`, deployment-specific tests as needed.

- [x] Validate inputs and reject root runtime execution, non-loopback service listeners, reused state directories, and production environment configuration.
- [x] Install pinned workspace dependencies with existing `npm run setup` and build the Web with matching staging environment values. Four missing optional lock entries repaired; original source and failed installation preserved.
- [x] Initialize dedicated state, Agent JWT secret and systemd units without printing secrets.
- [x] Use existing Node source entry point, Gateway built entry point and Vite preview proxy configuration. Keep startup sidecars disabled.
- [x] Confirm each service and upstream readiness, then verify no public application listener.

## Task 3: Browser and real runtime acceptance

- [x] Open an SSH tunnel and use a new browser storage context.
- [x] Verify empty-state onboarding, Chinese/English persistence and personalized templates.
- [x] Generate and edit the two-node graph through the real planner using the operator-authorized current Codex account.
- [x] Authenticate the remote Codex installation through its supported flow.
- [x] Bind independent Agent working directories and Sessions; execute two connected nodes and read their real output files.
- [x] Verify contract rejection/scoped repair, Stop/native cancellation, same-Session continuation, refresh and duplicate dispatch prevention. The old UI cancellation race was found and repaired locally.
- [x] Deploy the final incremental fixes and verify first-Session single-comment execution, waiting-for-user settlement, UI cancellation and continuation after Gateway restart. acceptance.4 passed the preserved regression recheck and two-node 2/2 run; acceptance.5 passed both-tab live history recovery with one native execution and original Session.
- [x] Restart the instance services and verify workspace persistence, port release and healthy recovery.
- [x] After actual Agent execution, verify run persistence and absence of orphan Agent processes. Final full-database active runs/pending wakeups and Codex/orphan processes are all zero; service paths and four loopback listeners verified.
- [x] Run isolated account authentication and membership checks; keep their result distinct from single-operator canvas verification. All 14 checks passed.

## Task 4: Handoff

- [x] Save source, instance, service, state, browser and runtime evidence locally, omitting secrets.
- [x] Report access command/URL, service restart/log commands, tested scope and any remaining limitation. See `docs/awwo-server-acceptance-results-2026-09-06.md`.
- [ ] Complete the commit review gate and publish the verified increment. Deployment/tooling tests and all applicable native Codex reviews passed; Gemini could not obtain CLI authorization and has no PASS. No new commit or push; v0.3.0 remains immutable.
