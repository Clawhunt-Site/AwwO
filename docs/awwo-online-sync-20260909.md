# AwwO online integration preparation — 2026-09-09

## Exact inputs and operation

- Source: main / origin/main at 48b96d7fd188d66215d313ddecdf2ad96ecb928d.
- Target: origin/online at cd9b3b490e96529b5b3ee9e7c08a004b71fbe070.
- Target has 2 unique commits; source has 51. A fast-forward push is not possible.
- Isolated directory: /Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-online-integration-20260909, detached HEAD at the source SHA.
- This preparation uses merge-tree plus an isolated index; no actual Git merge, merge commit, branch update or push has occurred.
- Intended operation after exact human approval: merge the source into online using the tested resolution, preserve both input histories, then perform the already-requested normal push to Forgejo online. No force push, new named branch or main update is part of this operation.

## Reconciled behavior

Seven original conflicts were resolved: CHANGELOG.md, apps/web/package.json, CanvasSurface.tsx, RunControls.tsx, canvasPlanning.ts, i18n.tsx and runJournal.ts. Online's native bounded graph review, feedback links, HTML deliverables, run rounds and verdict-aware recovery are retained. Main's SaaS automatic initialization, read-only locks, tenant-scoped recovery, manual conversation history, accepted-draft identity and multi-agent node execution are retained. Each native review turn settles against its fresh operation identity.

The two runtime capabilities remain explicit. Native graph review runs across nodes; Go/Pi SaaS supports ordinary DAGs and a node's sequential, parallel or review team. Go does not yet implement native graph execution policies, feedback edges or HTML workflow contracts. The UI therefore hides unavailable new configuration, preserves imported metadata, and refuses unsupported graph runs both before and after canonical initialization. The Go API independently rejects execution metadata and unsupported edge kinds before admission, quota allocation or Pi calls. Saving, initialization and manual chat retain the imported fields. Node team review is still supported and is not confused with graph-level review.

The planning prompt and result guard follow the selected runtime. SaaS plans cannot contain native-only operations or fields. This is a compatibility boundary, not a claim that all native capabilities are implemented by the Go host.

## Verification

| Surface | Command | Current result |
| --- | --- | --- |
| Both Web inventories combined | package test inventory, Vitest maxWorkers=4; static-ui script | 116 files / 1,404 tests PASS; static checks PASS |
| SaaS inventory | test:saas, maxWorkers=4 | 27 files / 237 tests PASS; overlaps the main Web inventory |
| SaaS TypeScript | npm run typecheck:saas | PASS |
| Native and SaaS build | npm run build; npm run build:saas | Both PASS |
| Go API | go test -race -count=1 -v ./... | 63 top-level / 76 subcases PASS; 0 failures, 0 skips |
| Go static checks | go vet ./... | PASS |
| Pi runtime | npm test; npm run check | 27 tests PASS; syntax PASS |
| Full local protocol chain | node --test scripts/awwo-saas-stack.test.mjs | PASS: real Go + Pi SDK + development PostgreSQL + explicit local provider fixture; history, SSE, cancellation and restart |
| Native logger/auth regression | Focused existing online tests | 5 files / 42 tests PASS; initial dependency gaps preserved in private logs |
| Codex GPT-5.5 review | Read-only CLI source review | PASS; no blocking findings |
| Gemini 3.1 Pro High review | Supplied-source read-only review | PASS / no integration blockers after baseline comparison; first tool-based attempt lacked headless command permission |
| Version/changelog and whitespace | SemVer / package-lock equality / Unreleased + release headings / diff check | PASS, version 0.4.0 |

The local database fixture is explicitly development at loopback port 55483 with isolated random test schemas. No provider key or production database was used for the local test suite. Native and SaaS builds retain bundle-size warnings; the native build retains an existing mixed static/dynamic import warning. Native logger tests reuse existing third-party dependencies matching direct lock versions; the borrowed Drizzle peer installation uses Kysely 0.28.11 while the lock requires 0.29.2. Auth-route tests use a mocked database. This is not a full clean-lock native dependency or entire repository CI claim.

Gemini initially flagged the existing cloud admission-rejection path: a rejected retry clears the current cached published output. Exact comparison showed the entire cloud-admission block is byte-identical to main; Gemini explicitly revised its verdict to PASS for this integration and retained that baseline concern as a follow-up. This report does not claim it was fixed. The original and follow-up review transcripts are retained. Persisted execution/chat history was not established as lost by that finding. SaaS manual conversations use the existing transport adapter into Go/Pi, even though the shared factory retains its native name.

## Source preservation and reviewable artifact

Implementation review tree: 00aa582f53b9ec5798a569883c92bc62295ee0fb. A manifest of all 12,640 indexed source entries and the source-preservation comparison are stored privately under .local/. Of 204 main-only changed paths, 202 retain their source blob; the exceptions are the added Go capability guard and creator.md provenance. Of 43 online-only changed paths, 41 retain their source blob in the final candidate; ContractFields.tsx adds the SaaS HTML selector boundary and docs/agent-graph.md explains the runtime capability boundary. Fifteen paths changed in both inputs were reviewed. Native logger/auth source and associated tests retain the online blobs exactly.

Logs and evidence are private under .local/: verification-results.json, web-full.log, web-saas.log, web-types.log, web-native-build.log, web-saas-build.log, pi-test.log, pi-check.log, go-full.log, go-vet.log, protocol-stack.log, server-logger-tests.log, codex-review.log, gemini-evidence-review.log, gemini-followup.log, source-preservation.json and implementation-manifest.json. Report-only edits after the implementation freeze are not a new tested implementation.

## Separate deployment state

AWS currently has a private Go/Pi preview installed from main 48b96d7. It is not this integration candidate. The public Cloudflare Access-protected ingress still serves the preserved native v0.4.0 deployment. The first real two-agent preview run failed; direct SDK and complete isolated Pi lifecycle rechecks subsequently passed, while the original failure cause remains unknown. Controlled API multi-agent recheck has passed, including ordered personas, input audit and cancellation; restart persistence is pending. These results cannot certify this candidate, a public cutover or authenticated UI acceptance. No automatic Forgejo deployment was configured by this operation.

## Approval boundary

AGENTS.md Human Merge Approval Gate requires explicit approval for this exact source, target and merge operation. The user has requested pushing online, but the necessary divergent-history merge has not yet been approved at these exact SHAs. Before any approved merge, re-read remote refs, verify the candidate tree and primary checkout, and stop for reassessment on drift. The primary main checkout remains clean. Existing unrelated worktrees and uncommitted work are preserved.
