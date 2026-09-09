# AwwO main synchronization — 2026-09-08

## Scope and exact inputs

The operator requested the latest remote code, conflict resolution and integration back into the project. The fetched AwwO policy identifies `main` as the default source baseline and `online` as a separately reviewed release reference. This candidate targets `main`; it does not promote `online` or deploy a service.

- Common base and unchanged primary checkout: `6e1dc158a79e2f18c7bdf82610a353883b883f31`.
- Completed SaaS source: `codex/awwo-node-setup-20260908` at `b9a65390c237907f951232c4c03c758324546188` (50 commits beyond the common base).
- Fetched target: `origin/main` at `fc5cbda9e4028837009369471ec2d54b94a985a5` (one commit beyond the common base).
- Separate release reference: `origin/online` at `cd9b3b490e96529b5b3ee9e7c08a004b71fbe070`, two commits beyond `origin/main`; those two commits are outside this candidate.
- Isolated candidate directory: `/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-main-sync-20260908`, detached at the SaaS source.

`git fetch origin` succeeded directly. A `git merge-tree --write-tree` preview reported 12 conflicting files. Its provisional tree was materialized only in the fresh isolated worktree. No branch was merged, reset or deleted. Named refs and the running local SaaS stack remain unchanged during preparation. Dependency symlinks and private verification artifacts must not be staged.

## Conflict resolution contract

Preserve the complete Go/Pi SaaS implementation, multi-member execution records, per-member instructions, conversation/task separation, session-scoped history, tenant storage boundaries and exact member cancellation. Preserve the remote native Codex acceptance, durable terminal settlement, readable transcript projections, accepted-draft handling, capacity checks and history recovery.

Native conversation settlement uses Gateway pause holds. SaaS completion is persisted by the Go API and does not implement that native hold protocol. Calls must remain scoped to the correct runtime mode. Optional display metadata must retain exact run/operation identity and must never hide raw history or turn a chat into a published deliverable.

The package test command retains both input branches' test entries. SaaS commands remain available. `VERSION`, root package and Web package/lock metadata follow the fetched `0.3.1` baseline. Both changelog histories are retained, with unpublished SaaS work under `Unreleased` and the upstream release under `0.3.1`.

## Verification and integration state

The frozen implementation was verified in this isolated worktree:

| Surface | Command / evidence | Result |
| --- | --- | --- |
| Web main test inventory | `npm test --prefix apps/web` | 105 files / 1,247 tests pass; static UI checks pass |
| SaaS test inventory | `npm run test:saas --prefix apps/web` | 27 files / 237 tests pass; overlaps the Web inventory |
| Web types | `npm run typecheck:saas --prefix apps/web` | Pass |
| SaaS build | `npm run build:saas --prefix apps/web` | Pass |
| Native Web build | `npm run build --prefix apps/web` | Pass |
| Gateway | `npm test`, `npm run typecheck`, `npm run build`, under `apps/gateway` | 39 files / 486 tests pass; types/build pass |
| Go API | `go test -race -count=1 -v ./...`, `go vet ./...`, under `backend` | 59 top-level cases / 52 subcases pass, zero skips; vet passes |
| Pi runtime | `npm test`, `npm run check`, under `apps/pi-worker` | 27 tests and syntax checks pass |
| Launch/install scripts | Five Node test files, exact arguments in the private results JSON | 60 tests pass |
| Complete local protocol chain | `node --test scripts/awwo-saas-stack.test.mjs` | One test passes; HTTP → Go → real Pi SDK → local protocol fixture → PostgreSQL, including history/cancel/restart; 7.17 seconds |
| Browser, candidate port 5191 | Existing acceptance canvas, Session 1 | Restored both member outputs in order, with team process records and prior conversation history |
| Browser, new write / real inference | Attempted new Session on candidate port 5191 | Blocked by the existing API origin allowlist; no new inference was submitted. This is excluded from passing execution evidence |

The initial Web run had eight failures in four files. Resolution retained the native conversation index URL, SaaS session filtering, accepted-draft identity and history projection, and reconciled older scoped-run assertions with the upstream rule that an unexecuted prerequisite must not receive a blocked badge. The full final suite passes; the initial failure log is retained.

The browser reused the authorized local administrator session and the separate earlier acceptance canvas. The original user canvas and its tabs were not reloaded. The new Session draft remained local after the expected origin rejection. The temporary candidate tab was closed and its 5191 Vite process stopped after evidence capture. The existing 5189/8087/8097 services were not restarted or replaced.

Both builds retain bundle-size warnings; the native build also reports existing mixed static/dynamic imports. No production deployment, new real native Codex session, public installer deployment or new external inference is certified by these local checks. PostgreSQL tests used isolated schemas on the development loopback database.

Evidence is private and ignored under `.local/`: `web-full-tests-final.log`, `web-saas-tests-final.log`, the type/build logs, `backend-verification-20260908/results.json`, `browser-team-history.png`, `browser-team-history.txt` and `browser-origin-rejection.txt`. Codex GPT-5.5 and Gemini 3.1 Pro (High) both pass. Gemini initially assumed SPA workspace switching and a browser-owned SaaS graph loop; the current full-page navigation and Go scheduling code disproved that reachable path, and Gemini explicitly withdrew the blocker in `gemini-sync-followup.log`. Any future SPA navigation change must revisit the remaining dynamic journal/document storage calls. Initial and final review transcripts are retained.

The implementation review input tree is `b3a74da2a138178d74464377435dcfb39b7ae3fc`; subsequent report-only edits do not change the tested implementation. The 187-file implementation manifest is in `.local/implementation-manifest.json`. A source-preservation comparison found 60 remote-only and 193 local-only changed files: all retain their source blobs except the intentional namespace-aware history helper and two extended regression test files. The final candidate tree and patch digests are in `.local/merge-candidate.json`.

The remote `main` and `online` identities were re-read with `git ls-remote` after verification and remained equal to the exact inputs above. The primary checkout remains clean at `6e1dc158`; the source branch remains at `b9a65390` with only its pre-existing dependency symlinks untracked. No merge commit or remote write has been performed.

The intended approval request consists of two local operations: fast-forward the clean local `main` from `6e1dc158a79e2f18c7bdf82610a353883b883f31` to fetched `origin/main` at `fc5cbda9e4028837009369471ec2d54b94a985a5`, then merge the existing SaaS source branch at `b9a65390c237907f951232c4c03c758324546188` into that updated `main` using the verified conflict resolution. Remote push and `online` promotion are separate operations and are not performed by this preparation.

The active-chat human merge gate requires approval for the exact source, target and operation after conflict resolution and verification. Preparation is not an executed Git merge, a push, a release or a production acceptance claim. Before any approved integration, re-check the source/target identities and worktree state; any drift requires a new assessment.
