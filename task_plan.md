# AwwO knowledge and delivery workbench

User approved the full implementation on 2026-10-01, including visible HTML, 3D, PDF and IDE previews on the canvas.

## Scope and acceptance

- [x] Independent tenant-scoped knowledge store: immutable sources, document revisions, typed relations, search, change proposals, review and rollback.
- [x] Knowledge map and source browsing integrated into the existing SaaS project/canvas.
- [x] Select knowledge for tasks; preserve source/version references; ingest actual deliverables and review knowledge updates.
- [x] Use existing multi-agent orchestration and real project execution; bridge external execution through explicit optional configuration where possible.
- [x] HTML, 3D, PDF and IDE preview windows appear inside the canvas, open real files and support useful interaction.
- [x] Verify relevant backend/worker/frontend tests, type checks and production build.
- [x] Start an isolated development service and visually exercise all four preview types and knowledge flows.
- [x] Review final diff, preserve evidence, document limitations and commit locally.

## Sequence and ownership

1. Root: isolation, contracts, local environment, integration and acceptance.
2. Backend agent: knowledge APIs/storage/provenance/review/retrieval, with migrations and tests.
3. Preview agent: renderers and canvas preview desk, with real 3D/PDF/source handling and tests.
4. Knowledge UI agent: graph/documents/import/review/history/task context UI and tests.
5. Root: runtime/connector integration, browser acceptance and independent review.

## Decisions

- Base is GitHub main c64b51a633490af80a4b45e4ef0d677211ddc069, live-fetched and verified.
- Worktree is detached at /Users/zhouxiansheng/awwo/AwwO-knowledge-workbench. The app-managed tool was unavailable because the chat directory is a repository parent; normal Git worktree creation was used.
- Knowledge relations are independent of execution DAG edges. A knowledge source survives deletion of the canvas from which it was imported.
- Use AwwO authentication and personal engine credentials. Do not transplant a localhost-owner trust model into the SaaS service.
- No production database operations. Tests use an isolated disposable local service; direct operational SQL requires the user's prescribed Bytebase tool, which is not available in this session.
- Remote publication and production deployment are separate from local implementation/acceptance and are not inferred from source commits.

## Progress

- Repository and runtime inventory complete; separate worktree created; latest public source verified.
- Implemented knowledge store/map/review, immutable run references, explicit compiler, external executor bridge and four-pane preview desk.
- Browser verified real local HTML interaction, OBJ rotation, two-page PDF navigation, ZIP source navigation, source import, proposal review, graph citation and task-context transfer.
- Final frontend regression: 929/929 passed across 73 files. Preview tests: 86/86. Generic and SaaS strict TypeScript passed; production build and 22 script tests passed.
- Independent review led to: bounded knowledge responses and old-version retrieval; append-only duplicate-source origins; per-page compiler citation validation; evidence moved out of system instructions; OpenMaus wire-contract corrections; bounded polling and safe close/recovery.
- Backend race verification: all 342 top-level tests passed across two batches (245 before the default total timeout, then the remaining 97); exact set coverage verified and go vet passed. Worker implementations were unchanged.
- Final diff and documentation reviewed; screenshots and test manifests preserved locally. This local commit completes the implementation and local acceptance. No paid model connection or external OpenMaus instance is configured in this isolated test environment; remote publication and live external execution are not claimed.

## 2026-10-01 follow-up: one AwwO configuration

The user requested native OpenMaus integration and completion of the remaining work.

- [x] Vendor the pinned Apache-2.0 OpenMaus core, launch isolated per-run headless processes and expose only approved Docker workspace tools.
- [x] Reuse AwwO engine connections through run-scoped, revocable model leases; preserve Chat, Responses and Anthropic protocols and usage accounting.
- [x] Integrate durable runs, approval, cancellation, history, artifacts and knowledge context in the native execution panel.
- [x] Include managed runtime in local setup and production packaging without a second end-user configuration.
- [x] Exercise the real core and sandbox with deterministic provider fixtures, run relevant regressions and visually verify the full canvas flow.
- [x] Review, document evidence and limitations, then commit locally.

### Follow-up acceptance

- Actual fixed OpenMaus core and real Docker completed a task through AwwO's API and model lease. Five browser approvals released exec, three publishes and workspace archive. Four artifact byte streams matched their SHA-256 values.
- Real task HTML interaction, OBJ rotation, PDF rendering, ZIP source navigation and knowledge-source import passed in the browser; console errors were empty. Screenshot: `.local/knowledge-evidence/native-four-previews.png`.
- Frontend: 948 tests, both TypeScript checks, build and static UI pass. Shared model gateway: 8 protocol tests pass, including personal Google connection wire compatibility; strict TypeScript passes. Setup scripts: 24 tests pass. Managed worker: 11 unit tests plus separately enabled five real core/Docker scenarios pass.
- Backend targeted race tests and go vet pass. Whole backend race exceeded its 20-minute total deadline; an existing OpenAI 2-second startup assertion still fails under current load. Neither is reported as a complete regression pass; details are in the acceptance report.
- Production worker Linux arm64 image was built and checked at `sha256:36f810bcc25868f0c90989d0ba95b8dcfa78c02b5bcb56c61fafee77e2bf16dd`; no Docker socket correctly returns unavailable. No production service was deployed.
- Stopped the deterministic model fixture and restored normal user credential mode. This isolated account has no personal model connection; My engines is the sole configuration entry. Real paid-provider planning quality remains untested.

- After restoring user credential mode and restarting, browser readback retained the completed execution, four task artifacts, and imported HTML knowledge source v1; the sole missing-model action is My engines.


## 2026-10-02 authorized production release

The user explicitly requested completion, push and production deployment. The deployment target and live SHA are re-read before cutover. The user explicitly authorized this release to use the built-in migrator after a consistent backup, isolated recovery and transactional migration validation; other production SQL remains outside that exception.

- [x] Re-query GitHub/Forgejo main and actual production API/web/worker paths.
- [x] Integrate current public main without losing canvas previews, knowledge or managed execution.
- [x] Complete merged frontend/backend/worker regressions and Linux amd64 runtime checks.
- [x] Build a complete immutable Linux release, push public main and preserve private-only history on Forgejo.
- [x] Prepare Docker broker account, workspace image, internal configuration and recoverable backup.
- [x] Resolve the production migration execution gate, cut over all relevant services with rollback.
- [x] Verify final SHA, authenticated public endpoint, runtime readiness and real browser preview evidence.

Fresh inventory: production API and Web are d278b7628c5d; the Pi/OpenAI workers still use the older saas-03b72b2e9190 sources. Target is awwo-acceptance i-0eda5599cbd603c8b in us-east-2; its historical staging directory name does not imply staging. No Bytebase connector was found in tools or installed-plugin discovery.

Merged release checks: 100 frontend test files / 1380 cases passed, generic and SaaS TypeScript passed. Pi 53 passed; OpenAI Agents 177 passed / 9 explicitly skipped. The host configuration and existing vault key have private on-host backups; the EBS baseline snapshot was requested but DescribeSnapshots is not permitted, so it is not a verified recovery point and cannot replace the pending consistent backup/recovery check.

Release candidate `a16098b365c78f63e4a87c4d6e64db4772ec8bac` is pushed to GitHub main; Forgejo main `af1bc4967e00ebc1775b7cf5c8813619cb8ce9dc` preserves private-only history and files. The full merged backend race suite and vet passed; SaaS CI validation jobs passed. The native archive is being rebuilt with the verified ClawHunt public URL before promotion. Production PG is on loopback port 55483; the recovery clone uses 55439.

Consistent cold backup and isolated built-in migration rehearsal passed. The same migrated clone passed old-API startup and authenticated business/artifact reads. One real default-provider task completed with three model invocations, approved HTML/ZIP publication and knowledge ingestion; cleanup reported no errors. Production first promotion automatically rolled back at broker readiness because the existing Python worker owns 8099; task admission was restored. Broker 8109 is verified free, and the second promotion is in progress.

Production completed: API/web/Pi/OpenAI and managed execution now serve `a16098b365c78f63e4a87c4d6e64db4772ec8bac`; existing Python worker on 8099 remains intact, broker uses 8109. Authenticated public and origin health, HTML/JS/CSS bytes and worker readiness passed. Maintenance is removed and operator mode/vault key remain unchanged. SaaS six-job CI and general Linux/Windows CI are green for the released application. Production browser verified knowledge reads, shared model selection, HTML interaction, real 3D rotation, PDF rendering/zoom and IDE file switching. A native nginx `.mjs` MIME issue found during browser acceptance was fixed without changing application bytes; the corresponding container nginx configuration passed a real Docker HTTP smoke. Final evidence and rollback scope are documented in `docs/awwo-managed-execution-release-20261002.md`.
