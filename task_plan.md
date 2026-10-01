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
