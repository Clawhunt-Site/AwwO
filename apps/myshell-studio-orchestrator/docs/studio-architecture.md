# Studio Architecture

This repository uses a Clean Architecture-inspired backend and a feature-sliced frontend while
keeping the existing Studio API contract stable.

## Backend Boundaries

- `orchestrator/backend/main.py` is the ASGI entrypoint. It should stay thin.
- `orchestrator/backend/app/` owns FastAPI app construction, settings, middleware, and route mounting.
- `orchestrator/backend/studio_app/composition/` owns Studio route-registration entrypoints and
  dependency container wiring.
- `orchestrator/backend/studio_app/api/` owns HTTP routers and static file integration.
- `orchestrator/backend/studio_app/application/use_cases/` owns business workflow orchestration.
- `orchestrator/backend/studio_app/application/policies/` owns deterministic application policies,
  routing decisions, readiness gates, and response-shaping rules.
- `orchestrator/backend/studio_app/application/services/` owns reusable application services that
  coordinate workflows but are not HTTP handlers.
- `orchestrator/backend/studio_app/application/state/` owns state factories, default payloads, and
  state transition helpers.
- `orchestrator/backend/studio_app/domain/` owns stable business vocabulary and pure policies.
- `orchestrator/backend/studio_app/ports/` owns repository and external adapter protocols.
- `orchestrator/backend/studio_app/infrastructure/` owns concrete adapters such as CanvasPro,
  Chrome/CDP, Dreamy, MyShell Art, storage, runtime health, timeline video composition, and future
  database implementations.
- `orchestrator/backend/studio_app/ports/task_runner.py` owns the async work execution boundary.
  The default implementation is in-process; a dedicated worker can replace it without changing API
  router signatures.
- `orchestrator/backend/studio_app/registry/` owns page/agent registry loading and Studio bot
  catalog/preview metadata.

Root-level legacy facades were removed. New code imports from `studio_app` directly.

## Frontend Boundaries

- `frontend/src/features/studio/` is the stable Studio feature entrypoint.
- `frontend/src/features/studio/api/` owns Studio API contracts, endpoint clients, Dreamy miniapp
  client adapters, dispatch-link probes, generated OpenAPI-derived types, and Studio API contract
  probes.
- `frontend/src/features/studio/components/` owns reusable Studio UI components such as status
  strips, delivery panels, the delivery evidence drawer, dispatch queues, matrix panels, chat/bot
  panels, Canvas side panels, and the Canvas workspace shell.
- `frontend/src/features/studio/hooks/` owns page-level controllers and use cases that coordinate
  Studio UI state with API/session/model boundaries. Keep streaming run orchestration, client
  execution handoff, delivery state, audit actions, dispatch target running, CanvasPro generation
  drafts, and CanvasPro quick command state here instead of in route components.
- `frontend/src/features/studio/model/` owns Studio page view-models, presets, canvas graph helpers,
  and UI-adjacent pure formatting rules.
- `frontend/src/features/studio/model/dreamyWorkspace.ts` is the public Studio model barrel. Keep
  concrete responsibilities in sibling modules: `workspaceTypes.ts`, `dreamyPresets.ts`,
  `studioAssets.ts`, `studioRuntime.ts`, and `canvasGraph.ts`.
- `frontend/src/features/studio/api/index.ts` is the public Studio API barrel. Keep API path
  construction in `endpointPaths.ts`, SSE parsing in `sse.ts`, dispatch link helpers in
  `studioDispatchLinks.ts`, contract barrels in `studioContracts.ts`, concrete contract domains
  in `studioBaseContracts.ts`, `studioCatalogContracts.ts`, `studioProjectContracts.ts`, and
  `studioDeliveryContracts.ts`; keep endpoint domains in `studioStreamingEndpoints.ts`,
  `studioProjectEndpoints.ts`, `studioDiscoveryEndpoints.ts`, `studioDeliveryEndpoints.ts`, and
  `studioJobEndpoints.ts`, with `studioEndpoints.ts` as the endpoint barrel. Keep Dreamy miniapp
  client integration in `dreamyMiniappClient.ts`.
- `frontend/src/features/studio/session/` owns Studio dispatch/session state helpers and session
  contract probes.
- Large page components should depend on feature entrypoints instead of importing Studio services
  directly from `frontend/src/services`.

## Backend Layout

Use capability-based placement:

- HTTP path handling goes to `studio_app/api/routers`.
- `studio_app/composition/studio.py` is the thin route-registration entrypoint; dependency wiring
  lives in `studio_app/composition/container.py`; API handlers stay in `studio_app/api/routers/`.
- Studio job queue HTTP endpoints live in `studio_app/api/routers/jobs.py`; keep
  route order stable when extracting dynamic paths such as `/api/studio/jobs/{job_id}`.
- Studio dispatch batch/session HTTP endpoints live in
  `studio_app/api/routers/dispatch_sessions.py`; the router owns payload parsing and
  delegates state transitions to the existing application/session use cases.
- Studio core, delivery/readiness, generation/CanvasPro, run, and project HTTP endpoints live in
  `studio_app/api/routers/core.py`, `delivery.py`, `generation.py`,
  `run.py`, and `projects.py`.
- Studio router mounting lives in `studio_app/api/route_mounting.py`; bootstrap passes dependency
  objects into the API layer instead of including individual routers directly.
- Business rules go to `studio_app/domain/policies.py`.
- Application use cases go to `studio_app/application/use_cases/`.
- Application policies go to `studio_app/application/policies/`.
- Application services go to `studio_app/application/services/`.
- State helpers and default payloads go to `studio_app/application/state/`.
- External platform calls go to `studio_app/infrastructure/adapters`.
- MyShell Art HTTP API and CLI adapters go to
  `studio_app/infrastructure/adapters/myshell_art/`.
- Persistence contracts go to `studio_app/ports/repositories.py`.
- SQLite-backed Studio state goes to `studio_app/infrastructure/db/sqlite_store.py`.
- Page and agent registry logic goes to `studio_app/registry/page_registry.py`.
- Runtime health, credential, cookie, and Chrome/CDP readiness checks go to
  `studio_app/infrastructure/runtime/health.py`.
- Async work dispatch goes through `studio_app/ports/task_runner.py`; the local default lives in
  `studio_app/infrastructure/runtime/task_runner.py`. API routers should depend on the port, not
  direct `asyncio.create_task` or deployment-specific queues.
- Backend/repository path discovery goes to `studio_app/infrastructure/paths.py`.
- Generated media filesystem roots and `/generated/...` path resolution go to
  `studio_app/infrastructure/storage/media.py`.
- Timeline export manifest/project mutation logic goes to
  `studio_app/application/use_cases/timeline_exports.py`; generated-media lookup, remote media
  download, ffprobe/ffmpeg normalization, and video composition go to
  `studio_app/infrastructure/storage/timeline_video.py`.
- CanvasPro source asset staging, generation task execution/sync, settings, cost, outputs, and sync
  response rules go to
  `studio_app/application/use_cases/canvaspro.py`.
- Client/server execution request shaping goes to `studio_app/application/services/execution_requests.py`.
- Studio SSE run orchestration, including manual bot sequence dispatch, generated event payloads,
  navigation dispatch completion, Dreamy server execution handoff, and MyShell Art execution
  handoff, goes to `studio_app/application/use_cases/run.py`.
- Dispatch/navigation request parsing, route coverage, path construction, dispatch preview shaping, default dispatch
  route shaping, navigation evidence payloads, overview summaries, coverage status, batch target/skip
  shaping, batch summaries, and boolean parsing rules go to
  `studio_app/application/policies/dispatch.py`.
- Studio delivery orchestration is a package under `studio_app/application/use_cases/delivery/`:
  `overview.py` owns overview aggregation, `coverage.py` owns dispatch matrix/coverage/batch
  planning, `sessions.py` owns dispatch session execution, `handoff.py` owns readiness, handoff
  snapshots and delivery audits, `actions.py` owns action resolution, and `preview.py` owns dispatch
  preview use cases.
- Dispatch session view, next-target, run-target state mutation, cancel, retry, and target status
  mutation rules go to `studio_app/application/state/dispatch_session.py`.
- Handoff policies are split by responsibility under `studio_app/application/policies/handoff/`:
  artifact links in `artifacts.py`, handoff snapshots/gaps in `snapshot.py`, readiness gates in
  `readiness.py`, audit requirements/responses in `audit.py`, and operator/action resolution rules
  in `actions.py`.
- Studio project/job/segment payloads, verified workshop project payloads, job cancel/retry state
  patches, bulk job action response rules, client-result segment/job patch rules, message append rules,
  segment selection, evidence shaping, and delivery report/bundle summaries go to
  `studio_app/application/state/project.py`.
- Project/job orchestration, including project create/restore, verified workshop project materialization,
  job create/update, execution request reconstruction, delivery report, and delivery bundle assembly,
  goes to `studio_app/application/use_cases/projects.py`.
- Studio job cancel/retry record orchestration goes to
  `studio_app/application/use_cases/jobs.py`.
- Client-result project mutation orchestration goes to
  `studio_app/application/use_cases/client_results.py`.
- Dreamy bot route normalization, manual bot sequence parsing, LLM intent route shaping, and local
  keyword routing go to `studio_app/application/policies/routing.py`.
- Route selection orchestration, including environment-gated LLM fallback and local keyword fallback,
  goes to `studio_app/application/services/route_selection.py`.
- Dreamy job graph views, persisted-evidence context merging, media result patch rules, dispatch
  target update decisions including client-result completion sync, live generation smoke/workshop
  orchestration, and generation smoke context/summaries go to
  `studio_app/application/services/dreamy_jobs.py`.
- Dreamy/DreamyPorn catalog loading, server-side submit/poll orchestration, media result persistence,
  and dispatch-target completion synchronization go to
  `studio_app/application/use_cases/dreamy_generation.py`.
- Dreamy/DreamyPorn protocol constants, environment numeric parsing, and pure task-media extraction
  go to `studio_app/application/services/dreamy_protocol.py`; infrastructure clients reuse those
  rules instead of leaking adapter imports into use cases.
- Static Studio defaults, readiness gates, delivery scope constants, and verified Dreamy workshop
  seed payloads go to `studio_app/application/state/defaults.py`.
- Dreamy and DreamyPorn HTTP/cookie/upload adapters go to
  `studio_app/infrastructure/adapters/dreamy/client.py`.
- Frontend Studio API/session/model/component/page imports go through `frontend/src/features/studio`;
  Studio-specific API, session, Dreamy, CanvasPro, delivery drawer, Canvas panel, component, and
  view-model modules should not be placed under generic `frontend/src/services` or
  `frontend/src/pages`.
- Delivery UI belongs under `frontend/src/features/studio/components/delivery/`; do not recreate
  broad mixed component files for utilities, evidence panels, and dispatch panels.
- Dreamy route composition belongs in `frontend/src/features/studio/pages/Dreamy.tsx`; keep
  business orchestration in `useStudioRunController`, `useStudioClientExecution`,
  `useStudioDeliveryController`, `useStudioDeliveryState`, `useStudioDispatchSessionController`,
  `useStudioAuditActions`, and `useStudioDispatchTargetRunner`.
- CanvasPro route composition belongs in `frontend/src/features/studio/pages/CanvasPro.tsx`; keep
  generation draft and quick command state in `useCanvasProGenerationDrafts` and
  `useCanvasProQuickCommands`.
- OpenAPI contract export is available through
  `orchestrator/backend/studio_app/scripts/export_openapi.py`; frontend generated Studio API types
  are produced by `npm run generate:studio-api` into
  `frontend/src/features/studio/api/generated/`.

Endpoint paths and response fields remain stable until the generated OpenAPI/TypeScript contract
replaces handwritten shared types.
