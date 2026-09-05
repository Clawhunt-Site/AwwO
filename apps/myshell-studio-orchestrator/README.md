# MyShell Studio Orchestrator

MyShell Studio Orchestrator is a unified agent dispatch center for Dreamy miniapp flows and MyShell Art pages. It routes natural-language creative requests into registered page adapters, tracks jobs and evidence, and keeps project timelines recoverable after backend restarts.

## What Is Included

- `/dreamy` Studio UI with conversation, preview timeline, canvas mode, mobile-ready page/agent selection, persisted job queue restore, cancel/retry, auth state, evidence status, and a return dock after cross-page dispatch.
- `/dreamy` keeps CanvasPro as the primary workspace and adds a lazy-loaded Creative Director workspace with AI Script Director, Storyboard, 3D Director, VR360 Panorama, and Pose Editor tools.
- FastAPI backend with persistent Studio projects/jobs/evidence trails, SSE routing, and typed MyShell page/agent registries.
- Dreamy miniapp client executor for `generate`, `generate/result`, `task/running`, `task/cancel`, `task/retry`, and library-backed refresh flows.
- MyShell Art CDP adapter surface for browser-cookie-backed page execution. Missing cookies become `auth_missing`, not fake success.
- Navigation dispatch registry for the existing miniapp surfaces: Explore, AI Picks, Bot Detail, Upload, Tag Generator, Library, Library Detail, Energy Store, Energy History, Earn, Share Invite, Settings, Profile, and Checkin.
- Prompt-aware page routing: default Studio runs can infer page targets such as Library, Upload, Settings, Energy, Earn, or Checkin from natural language; explicit page selections still win.
- Manifest-driven page expansion via `orchestrator/backend/studio_pages_manifest.json` or `STUDIO_PAGES_MANIFEST`, so new MyShell miniapp surfaces can be added without changing Python router code.
- Health checks that report backend, storage, Chrome CDP, MyShell cookies, cookie injection result evidence, and Dreamy auth delegation separately, with the same status visible in Studio.
- Delivery readiness gates that combine health, registry coverage, frontend route coverage, dispatch preview, overview, MyShell Art auth, and job-store checks into a single Studio handoff status.
- Machine-readable delivery audit that packages readiness, dispatch matrix, coverage, handoff, downloadable bundle evidence, requirements, and artifacts into one acceptance payload.
- Project delivery reports that summarize accepted evidence, pending evidence, issue counts, unresolved actions, and per-segment evidence trails for operator handoff.
- Dispatch matrix coverage for every registered MyShell page, including executor, default agent, route path, missing route params, auth status, and recommended dispatch action.
- Batch dispatch planning for all ready MyShell targets, with openable navigation paths, executor groups, and explicit skip reasons for auth gaps or missing route params.
- Recoverable dispatch sessions that persist batch target progress, next openable target, visited/completed/skipped/cancelled/error states, queue cancel/retry, and queue recovery after refresh or cross-page navigation.
- Real MyShell-generated bot preview assets for Dreamy and the registered MyShell Art bot catalog, served from `frontend/public/generated/bot-previews/manifest.json` and exposed through `/api/studio/bot-previews`.
- One-click coverage verification for ready navigation surfaces, with accepted dispatch evidence for each verified page and explicit skip reasons for missing params, auth gaps, or non-batch-safe executors.
- Handoff snapshots that package health, readiness, overview, dispatch matrix, coverage, project delivery evidence, artifacts, gaps, and next actions into a single delivery decision.

## Repository Layout

- `frontend/` - Vite + React miniapp frontend.
- `orchestrator/backend/` - FastAPI backend, Studio API, registries, SQLite job store, and CDP bridge.
- `orchestrator/Dockerfile` - Cloud Run image that builds the root frontend and backend together.

## Local Run

Install dependencies once:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r orchestrator/backend/requirements.txt

cd frontend
npm install
cd ..
```

Run backend and frontend together from the repository root:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5174/dreamy
```

CanvasPro remains the default workspace inside `/dreamy`. Use the top-right workspace switch to open
Creative Director, or deep-link with `/dreamy?workspace=creative-director`. Switching back preserves
the mounted CanvasPro session. Creative Director runs locally and does not submit paid generation by
itself.

CanvasPro API requests are routed through the Studio backend by default. If the original
AI-CanvasPro `server.py` is not available, Studio uses a compatibility store for runtime info,
redacted config, user settings, prompt presets, and project JSON so the canvas can still open from
the same Studio URL. Generation and provider-specific CanvasPro tasks still require the native
CanvasPro backend.

Optional native CanvasPro backend:

```bash
bash scripts/setup-canvaspro.sh
npm run dev
```

The setup script clones `https://github.com/ashuoAI/AI-CanvasPro` into
`.external/AI-CanvasPro`, creates a separate `.external/AI-CanvasPro/.venv`, installs its
`requirements.txt`, prepares the ignored `frontend/public/ai-canvaspro/` static mount, and keeps
that external source out of git. You can pin the external checkout to a known commit/tag/branch:

```bash
AI_CANVASPRO_REF=<commit-or-tag> bash scripts/setup-canvaspro.sh
```

You can also point to an existing checkout:

```bash
AI_CANVASPRO_SERVER_DIR=/path/to/AI-CanvasPro npm run dev
```

Commercial/license boundary: AI-CanvasPro source and assets are not committed to this repository.
Only Studio-owned bridge files, scripts, and docs live here. The local upstream license files describe
AI-CanvasPro as Source Available/non-OSI and require separate written authorization for commercial
use, SaaS/cloud service use, paid delivery, or packaged redistribution. Confirm those upstream terms
and any third-party asset/model-provider terms before commercial deployment.

Optional ports:

```bash
BACKEND_PORT=8090 FRONTEND_PORT=5174 npm run dev
```

Local `npm run dev` and `bash scripts/dev.sh` automatically load environment variables from
`.env.local` first, then `.env`. Copy `.env.example` to `.env.local` for machine-local values such as
SuperClaw control tokens. Set `STUDIO_ENV_FILE=/path/to/file` when you want to load a different env
file.

Advanced: point the Studio backend at an already-running CanvasPro API:

```bash
AI_CANVASPRO_API_BASE=http://127.0.0.1:8777 npm run dev
```

Advanced: connect Studio canvas orchestration to a local SuperClaw instance:

```bash
STUDIO_SUPERCLAW_API_BASE=http://127.0.0.1:8788 \
STUDIO_SUPERCLAW_CONTROL_TOKEN=<control-token> \
STUDIO_SUPERCLAW_GATEWAY_TOKEN=<gateway-token> \
npm run dev
```

By default, the Studio backend only falls back on known missing CanvasPro compatibility endpoints
or when the native service is unreachable. It does not hide native upstream `502/503/504` responses
unless `AI_CANVASPRO_COMPAT_ON_UPSTREAM_STATUS=1` is explicitly set.

Manual backend:

```bash
cd orchestrator/backend
python -m pip install -r requirements.txt
PORT=8090 python main.py
```

Manual frontend:

```bash
cd frontend
npm install
VITE_DREAMY_ORCHESTRATOR_PROXY_TARGET=http://127.0.0.1:8090 npm run dev -- --host 0.0.0.0 --port 5174
```

## Studio APIs

- `GET /api/health`
- `GET /api/pages`
- `GET /api/agents`
- `GET /api/studio/overview`
- `GET /api/studio/bot-previews`
- `GET /api/studio/dispatch-matrix`
- `POST /api/studio/dispatch-batch`
- `POST /api/studio/dispatch-sessions`
- `GET /api/studio/dispatch-sessions`
- `GET /api/studio/dispatch-sessions/{session_id}`
- `POST /api/studio/dispatch-sessions/{session_id}/cancel`
- `POST /api/studio/dispatch-sessions/{session_id}/retry`
- `POST /api/studio/dispatch-sessions/{session_id}/targets/{target_id}/run`
- `POST /api/studio/dispatch-sessions/{session_id}/targets/{target_id}`
- `GET /api/studio/coverage`
- `POST /api/studio/coverage/verify`
- `GET /api/studio/handoff-snapshot`
- `GET /api/studio/readiness`
- `GET /api/studio/delivery-audit`
- `POST /api/studio/actions/resolve`
- `POST /api/studio/actions/resolve-batch`
- `GET /api/studio/dispatch-preview`
- `POST /api/studio/run`
- `GET /api/studio/projects`
- `GET /api/studio/projects/{project_id}`
- `GET /api/studio/projects/{project_id}/delivery-report`
- `GET /api/studio/projects/{project_id}/delivery-bundle`
- `POST /api/studio/projects/{project_id}/client-result`
- `POST /api/studio/projects/{project_id}/reset`
- `GET /api/studio/jobs`
- `POST /api/studio/jobs/bulk`
- `GET /api/studio/jobs/{job_id}`
- `GET /api/studio/jobs/{job_id}/evidence`
- `POST /api/studio/jobs/{job_id}/cancel`
- `POST /api/studio/jobs/{job_id}/retry`

`/api/pages` returns registry metadata plus runtime `authStatus`, `dispatchReady`, `dispatchStatus`, and `dispatchMessage` for each MyShell page, so operators can tell whether a page is ready, client-delegated, or blocked by missing credentials before dispatch.

`/api/studio/overview` aggregates pages, agents, latest jobs, and status counts for the Studio command center. Page summaries include runtime readiness, related agent ids, per-status job counts, and the latest job for that page.

`/api/studio/bot-previews` returns the Studio bot preview registry for Dreamy and all registered MyShell Art bots. Each preview includes `status`, `accepted`, `mediaUrl`, `source`, source widget metadata, `botSpecific`, `targetBotExecuted`, and evidence. The checked-in manifest uses real MyShell OpenAPI image results stored under `/generated/bot-previews/`; representative images can still render as visual guidance, but only bot-specific generated assets are counted as `accepted`/`ready`. Missing future assets report `needs_generation` or `auth_missing` instead of being shown as completed previews.

`/api/studio/dispatch-matrix` returns a full page-to-agent routing matrix for every registered MyShell surface. It includes the recommended action (`navigate`, `execute-client`, or `execute-server`), default agent id, executor, auth status, navigation path, route params, missing params, and readiness summary so operators can audit and launch dispatch targets from one panel. Pass `project_id` and optional `source_segment_id` to compute contextual routes from the current media segment, such as filling Tag Generator's required `img` parameter from an accepted image. The Studio UI exposes each navigation target with Dispatch, Open, and Copy controls so operators can either run the adapter path or open/share the exact resolved page URL.

`POST /api/studio/dispatch-batch` turns the current dispatch matrix into an actionable batch plan without pretending to execute external adapters. Pass `project_id`, optional `source_segment_id`, optional `page_ids`, optional `limit`, and optional `exclude_covered=true` to resume only pages that do not already have accepted coverage. The response includes ready `targets`, `skippedTargets`, executor counts, navigation paths, source media context, the underlying matrix, and a fresh `handoffSnapshot`; covered pages skipped by resume mode use `reason: "already_covered"` and increment `summary.coveredSkipped`. The Studio UI exposes this as Plan All, Plan Remaining, Plan Selected, and Open Next so operators can move through all ready MyShell navigation targets or a chosen page subset while blocked client/server/auth/parameter targets stay visible.

`POST /api/studio/dispatch-sessions` persists a batch plan as a recoverable queue. It accepts the same `project_id`, optional `source_segment_id`, optional `page_ids`, optional `limit`, and optional `exclude_covered` as dispatch batch, then returns `sessionId`, `status`, `summary.pending`, `summary.visited`, `summary.completed`, `targets`, `skippedTargets`, and `nextTarget`. `GET /api/studio/dispatch-sessions` restores recent queues, `GET /api/studio/dispatch-sessions/{session_id}` restores one queue, `POST /api/studio/dispatch-sessions/{session_id}/cancel` marks unfinished targets as `cancelled`, `POST /api/studio/dispatch-sessions/{session_id}/retry` reopens `cancelled` and `error` targets as `pending`, `POST /api/studio/dispatch-sessions/{session_id}/targets/{target_id}/run` materializes a queued target into a navigation handoff or standard `executionRequest`, and `POST /api/studio/dispatch-sessions/{session_id}/targets/{target_id}` marks a target `visited`, `completed`, `skipped`, or `error`. Add `target_id` to the single-session restore URL to receive `focusedTargetId`, `focusedTargetIndex`, and `focusedTarget` for direct handoff inspection links. The Studio UI also accepts `/dreamy?dispatch_session_id={session_id}&target_id={target_id}` or `/dreamy?session_id={session_id}&target_id={target_id}` to restore and highlight an exact dispatch target. Completing a navigation target writes accepted navigation job evidence with `dispatchSessionId` and `dispatchTargetId`; running a Dreamy client target returns `dispatchSessionId` and `dispatchTargetId` inside the client `executionRequest`, and the later `/client-result` automatically completes or errors the target. The Studio UI exposes this as Start Queue, Start Selected, Cancel Queue, Retry Queue, Open Next or Run Next, Mark Done, Mark Error, and Skip; opening or running a target records progress before leaving Studio or handing off to an adapter, so returning to `/dreamy` can continue with the next pending target instead of losing progress.

`/api/studio/coverage` turns the dispatch matrix and persisted job evidence into a page-level delivery report. It marks each MyShell surface as `covered`, `pending`, `ready_unverified`, or `blocked`, includes the latest job/evidence per page, and summarizes covered, unverified, pending, blocked, and issue counts for release handoff.

`POST /api/studio/coverage/verify` batch-verifies ready navigation pages for a project. It creates accepted navigation jobs for `ready_unverified` pages, reuses `project_id` and optional `source_segment_id` for contextual routes, and returns `createdCount`, `skippedPages`, touched jobs, the updated project, and refreshed coverage. Client and server executors are skipped with explicit reasons instead of being marked successful without a real adapter run.

`/api/studio/handoff-snapshot` packages the current delivery evidence into one operator-ready payload. Pass `project_id` and optional `source_segment_id` to include contextual routes and project delivery evidence. The response includes top-level `status`, `readyForDelivery`, `summary`, `gates`, `gaps`, `actions`, `artifacts`, and embedded `reports` for health, readiness, overview, dispatch matrix, coverage, and project delivery. Every artifact keeps its stable template `endpoint` and includes a concrete `url` with project/session/source context already filled in. Dispatch target actions include a Studio `uiUrl` so operators can reopen `/dreamy` at the exact failed or opened-but-uncompleted target from the action queue. Any blocked page, missing route parameter, auth gap, unresolved job action, unverified surface, or dispatch session target marked `visited` or `error` stays visible as a gap/action instead of being treated as success.

`/api/studio/readiness` returns delivery gates for the handoff surface: backend, storage, Chrome CDP, cookie injection, page registry, agent registry, dispatch preview, overview, MyShell Art auth, and job store. The `page-registry` gate includes `routeCoverage`, which compares registered `appRoute` values with the real frontend `<Route>` paths when `frontend/src/App.tsx` is available; internal test routes are ignored, missing or extra production routes block readiness, and source-unavailable runtimes report `source_unavailable` without blocking startup. Cookie injection reads the latest Chrome injection result file instead of treating cookie presence as success, so failed injection appears as degraded/error evidence. Required gate failures make the response `blocked`; optional auth/CDP gaps are surfaced as `degraded` or `auth_missing` rather than hidden as success.

`/api/studio/delivery-audit` returns a machine-readable acceptance report for operators and deployment checks. Pass optional `project_id` and `source_segment_id` to include project-specific handoff evidence, and add `download=1` to receive a JSON attachment named `myshell-studio-audit-{project_id|current}.json`. The response includes top-level `status`, `summary`, `requirements`, `actions`, `artifacts`, and embedded `reports` for health, readiness, overview, dispatch matrix, coverage, project delivery, and handoff snapshot. Artifact entries include direct `url` values for reproducing each report or download without manually replacing `{project_id}` or `{session_id}` templates. The `actions` list merges readiness requirement fixes and handoff gaps such as `start-chrome-cdp`, `restore-auth`, `verify-ready`, `run-target`, `retry-queue`, `provide-project-id`, or dispatch target inspection into one de-duplicated operator queue; manual and retry actions include a materialized `next` instruction with concrete `url`/`retryUrl`/`cancelUrl`/`uiUrl` values when available, and dispatch target entries carry a Studio `uiUrl` for exact `/dreamy` restore. The Studio UI surfaces this as the Audit strip with refresh, safe action resolution, direct Open links, and Audit JSON download actions.

`POST /api/studio/actions/resolve` turns one audit or handoff action into an executable result or explicit operator instruction. `verify-ready` runs targeted coverage verification for the page; `run-target` materializes a pending dispatch session target into the same navigation handoff or adapter `executionRequest` as `/targets/{target_id}/run`; `retry-queue` reopens cancelled or errored dispatch session targets so they return to the pending queue; auth, cookie, CDP, project-selection, route-param, readiness, adapter-wait, polling, retry/cancel, error-inspection, and evidence-verification actions return `manual_required` with the exact next step and concrete `url`/`retryUrl`/`cancelUrl` values instead of pretending the external state changed. Dispatch target inspection actions preserve `session_id` and return both a concrete dispatch session API `url` with `target_id` and a Studio `uiUrl` that opens `/dreamy` at the exact target.

`POST /api/studio/actions/resolve-batch` runs all supplied safe audit actions in one pass. It batch-executes `verify-ready` page actions, dispatch-session `run-target` actions, and cancelled-session `retry-queue` actions, returns every manual operator action unchanged with instructions, and includes a refreshed audit so the Studio UI can update the action queue after one click. Batch `run-target` results include the same dispatch target run payload as the single-action resolver, so the Studio UI can continue into client execution requests instead of leaving runnable targets as manual follow-up.

`/api/studio/dispatch-preview` preflights a target page without creating a job. It returns the resolved page, executor, agent, auth status, navigation path, route params, and `missingRouteParams`, which lets the Studio UI show exactly where a dispatch will go before it runs.

`/api/studio/run` streams `meta`, `route`, `progress`, `execution_request`, `job`, `project`, and `done` events. Placeholder posters are always evidence-only drafts; generation completion requires fresh media, a task result, or an explicit failure/auth/timeout state. When no non-default page is selected, the intent router can infer registered miniapp pages directly from prompts like "open my generated library", "upload an image", or "go to settings". Navigation pages return `executor: "navigation"`, `clientAction: "navigate"`, and `navigationPath`; the Studio frontend executes the route switch, keeps a return dock available, and the backend stores accepted route evidence with `pageId`, `agentId`, `navigationPath`, and missing-parameter details.

If a navigation target is missing required route params, the `execution_request` includes `missingRouteParams`, the frontend stays in Studio, and the job records `error` evidence instead of marking the dispatch successful. This keeps contextual pages such as Tag Generator from being opened without required source media.

`/api/studio/projects` and `/api/studio/jobs` power restart recovery and queue views. Job responses include `evidenceTrail`, and retry responses include a client `executionRequest` when the adapter must run from the authenticated miniapp browser. The job queue supports `status`, `page_id`, and `agent_id` filters for the Studio dispatch center.

`/api/studio/projects/{project_id}/delivery-report` turns a persisted project into a handoff report with `handoffStatus`, `readyForHandoff`, status counts, accepted/pending/issue evidence counts, unresolved actions, and each segment's evidence trail. The Studio UI surfaces this as the Project Delivery strip above the page registry.

`/api/studio/projects/{project_id}/delivery-bundle` packages the current project into a single operator handoff payload. It includes the project delivery report, coverage report, handoff snapshot, recent dispatch sessions, accepted jobs, remaining targets, skipped targets, error targets, and artifact endpoints plus concrete artifact URLs for reproducing each report. Dispatch session artifacts include both session-level restore links and target-level `target_id` links for exact page handoff inspection; each dispatch artifact keeps its API `url` and also includes a Studio-facing `uiUrl` that opens `/dreamy` with the matching session and target. Remaining targets include both `pending` and `visited` dispatch targets, so a page that was opened but not marked done still appears in handoff. Skipped targets include both plan-time skips, such as auth or route blockers, and operator-skipped dispatch targets with `reason: "operator_skipped"`. Error targets preserve dispatch targets marked `error` with review messages so handoff never hides broken page dispatches. Pass optional `source_segment_id` to keep contextual page routes and source-media coverage aligned with the active segment. Add `download=1` to return the JSON with an attachment filename of `myshell-studio-delivery-{project_id}.json`. The Studio UI exposes this from the Handoff strip as Bundle and downloads the same JSON handoff file after refresh.

`POST /api/studio/jobs/bulk` applies `cancel` or `retry` to filtered queue slices using the same `status`, `page_id`, `agent_id`, and `project_id` filters. Bulk cancel skips terminal `done` and `cancelled` jobs by default unless `include_terminal` is set. It returns updated jobs, skipped jobs, touched projects, and retry execution requests when adapter execution must resume.

Contextual miniapp pages receive route parameters automatically: Bot Detail, Upload, and Tag Generator include the selected `slug_id`; Tag Generator also carries source media as `img` when the dispatch starts from an existing segment. Dynamic path pages can declare placeholders such as `/library/:id`; Studio replaces the placeholder from `routeDefaults` before dispatch and only reports `missingRouteParams` when the placeholder or query value cannot be resolved.

The miniapp shell also accepts external deep links for the same page set before `MemoryRouter` starts. Use `?page=explore`, `ai-picks`, `bot-detail`, `upload`, `tag-generator`, `library`, `library-detail`, `energy-store`, `energy-history`, `earn`, `share-invite`, `settings`, `profile`, `checkin`, or `dreamy`; parameterized pages accept `slug_id`, `img`, or `id` as needed. Legacy aliases such as `page=energy`, `page=checkin-demo`, and `page=self-director` are preserved. Telegram `startapp` values still support `earn`, `buy`, `library`, `dreamy`, page ids, and bot slugs.

`/api/studio/run` also accepts `agent_id`. When provided and registered, that agent id is echoed in `route`, persisted on the job, returned in `execution_request`, and preserved through retry so operators can intentionally dispatch through a specific Studio agent.

To add a MyShell page, append a manifest entry with `id`, `name`, `appRoute`, `capabilities`, optional `routeParams`, optional `routeDefaults`, and optional `intentKeywords`. `routeDefaults` are merged into the navigation query string unless the route uses a matching path placeholder such as `:id`, in which case Studio replaces that placeholder. This lets a page carry fixed parameters such as source, tab, page mode, referral context, or detail ids without Python changes. For deployment-specific page sets, point `STUDIO_PAGES_MANIFEST` at another JSON file with the same shape. Readiness will also compare those routes against the frontend route source; set `STUDIO_FRONTEND_APP_ROUTES_FILE` if the source file lives outside the default repository layout.

## Environment

Copy the example files and fill local values:

- `.env.example` for the repository-root local dev script
- `frontend/.env.example`
- `orchestrator/.env.example`

Important backend settings:

- `STUDIO_STORE_PATH` - SQLite path for project/job/evidence persistence. Defaults to `orchestrator/backend/.studio/studio.sqlite3`.
- `STUDIO_PAGES_MANIFEST` - Optional path to a JSON manifest that extends or replaces registered MyShell miniapp pages.
- `STUDIO_BOT_PREVIEWS_MANIFEST` - Optional path to a JSON manifest for real MyShell-generated bot preview assets. Defaults to the checked-in `/generated/bot-previews` manifest.
- `STUDIO_FRONTEND_APP_ROUTES_FILE` - Optional path to the frontend App route source used for readiness route coverage. Defaults to `frontend/src/App.tsx` when present.
- `DREAMY_TELEGRAM_INIT_DATA` - Optional Telegram miniapp init data for server-side Dreamy execution. If set, `/api/studio/run` can submit Dreamy generate/result jobs from the backend; if omitted, Dreamy remains `client_delegated` and the browser miniapp session runs jobs.
- `DREAMY_API_BASE_URL` - Dreamy API origin, default `https://api.myshell.fun`.
- `DREAMY_SERVER_POLL_ATTEMPTS` / `DREAMY_SERVER_POLL_INTERVAL_SECONDS` - Fast server polling controls after Dreamy submit. Running jobs stay recoverable instead of being marked successful without media.
- `MYSHELL_COOKIES` - JSON cookie array for MyShell Art CDP execution. If omitted, MyShell Art jobs report `auth_missing`.
- `MYSHELL_COOKIES_FILE` - Local JSON cookie file path for MyShell Art CDP/API diagnostics. Prefer this over putting cookie JSON directly in shell history.
- `MYSHELL_CDP_URL` - Chrome DevTools endpoint, default `http://127.0.0.1:9222`.
- `MYSHELL_COOKIE_INJECTION_STATUS_PATH` - Optional path for the Chrome cookie injection result JSON. Defaults to backend `.studio/cookie-injection-status.json`.
- `STUDIO_ROUTER_MODE=local|gemini` - local catalog matching by default; Gemini requires `GEMINI_API_KEY`.
- `AI_CANVASPRO_API_BASE` - Optional native AI-CanvasPro API origin. Defaults to `http://127.0.0.1:8777`.
- `AI_CANVASPRO_COMPAT_DIR` - Optional directory for Studio's CanvasPro compatibility JSON store. Defaults to `orchestrator/backend/.studio/canvaspro`.
- `AI_CANVASPRO_COMPAT_ON_UPSTREAM_STATUS=1` - Optional escape hatch to fall back on native CanvasPro `502/503/504`; disabled by default so real upstream failures stay visible.
- `STUDIO_SUPERCLAW_API_BASE` - Optional SuperClaw HTTP API origin for Studio canvas orchestration. Defaults to `http://127.0.0.1:8788`.
- `STUDIO_SUPERCLAW_GATEWAY_BASE` - Optional SuperClaw Gateway origin. Defaults to `http://127.0.0.1:8796`.
- `STUDIO_SUPERCLAW_CONTROL_TOKEN` - Optional SuperClaw control token sent only by the Studio backend.
- `STUDIO_SUPERCLAW_GATEWAY_TOKEN` - Optional SuperClaw Gateway automation token sent only by the Studio backend.
- `STUDIO_SUPERCLAW_ALLOW_REMOTE=1` - Allows non-loopback SuperClaw origins; leave disabled for local development unless the remote endpoint is trusted.

Dreamy is marked `ready` when server init data is configured, otherwise it is still dispatch-ready as `client_delegated` so the authenticated Telegram browser can execute it. In both modes, placeholder posters are not accepted as completion evidence.

MyShell Art is marked ready only when cookies are configured, cookie injection succeeded, and the current Chrome CDP endpoint is reachable. A stale success file with an offline CDP is reported as `auth_missing` with CDP evidence instead of a successful adapter.

## Verification

One-command local handoff check:

```bash
python scripts/studio_delivery_check.py
```

This starts a temporary backend on a free local port, builds the frontend with that backend URL, serves the production build through `npm run preview`, runs the backend API smoke and frontend browser smoke, writes logs, a Canvas workspace screenshot, a Delivery Evidence drawer screenshot, `.studio-delivery-check/frontend-smoke.json`, and `.studio-delivery-check/summary.json`, prints the same JSON summary, and cleans up the processes it started. The frontend smoke also verifies the Delivery Command Center, then exercises a selected Explore dispatch queue through `Plan Selected` → `Start Selected` → `Open Next` → `Return to Studio`, recording the machine-readable `reports.frontendSmoke` check list with queue-active, target-opened, return-restored, and target-visited readiness. Use `--frontend-mode dev` for a faster development-server check, or `--artifacts-dir` / `--report` to place handoff evidence somewhere else.

Frontend:

```bash
cd frontend
npm run build
npm run test:studio-smoke
```

Creative Director browser acceptance (with the frontend already running):

```bash
cd frontend
STUDIO_FRONTEND_URL=http://127.0.0.1:5174 npm run smoke:creative-director
```

Backend:

```bash
cd orchestrator
python -m unittest discover -s backend/tests -v
```

Running backend smoke after the service starts:

```bash
cd orchestrator/backend
python -m studio_smoke --base-url http://127.0.0.1:8090
```

The smoke checks `/api/health`, `/api/pages`, `/api/agents`, readiness, dispatch matrix, coverage, and delivery audit. It fails if required MyShell pages or agents are missing, required readiness gates are blocked, or delivery artifacts are not exposed.

Full generation-chain gate:

```bash
python scripts/generation_chain_check.py \
  --base-url https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app \
  --project k-project-481102 \
  --check-local-cookies \
  --probe-local-art-api \
  --local-cookies-file /tmp/myshell-cookies.json \
  --require-live
```

This check does not print secret values. It verifies Cloud Run traffic, Secret Manager presence, public health components, MyShell Art API auth smoke, bot-specific generated preview coverage, target-bot execution evidence, optional local MyShell cookie availability, optional non-generating local Art API auth probing, and the live generation smoke. It stays blocked until `/api/studio/bot-previews` reports `summary.botSpecific == summary.total` and `summary.targetBotExecuted == summary.total`, `myshell-dreamy-init-data` and `myshell-cookies` exist, Cloud Run injects them, `/api/studio/art-api-auth-smoke` or CDP auth is ready, and `/api/studio/generation-smoke` accepts fresh media. If the local Art API probe returns `UNAUTHORIZED`, refresh the MyShell login before uploading cookies.

Bot-specific preview refresh workflow:

```bash
python scripts/materialize_bot_preview_manifest.py --print-worklist
python scripts/run_target_bot_previews.py --plan-only --slug brat-generator --executor art-api
MYSHELL_COOKIES_FILE=/tmp/myshell-cookies.json \
  python scripts/run_target_bot_previews.py \
  --slug brat-generator \
  --executor art-api \
  --output .studio-delivery-check/target-bot-preview-urls.json \
  --merge-existing
MYSHELL_CDP_URL=http://127.0.0.1:9222 \
  python scripts/run_target_bot_previews.py \
  --slug brat-generator \
  --output .studio-delivery-check/target-bot-preview-urls.json \
  --merge-existing
python scripts/materialize_bot_preview_manifest.py \
  --input .studio-delivery-check/target-bot-preview-urls.json \
  --merge-existing-manifest
```

`run_target_bot_previews.py` can use `--executor art-api` to call the MyShell Art homepage API with the public-page `targetBotId`, or the default CDP bridge as a fallback. It reads cookies from `MYSHELL_COOKIES`, `MYSHELL_COOKIES_FILE`, or backend-local cookie files, and only writes `targetBotExecuted: true` when the target bot returns a fresh output URL. Add `--resolve-public-metadata` with CDP mode to fetch the public Art page first and include the exact `targetBotId`, `targetSlugId`, template, and button text in the plan/report without running generation. Its output is a materializer input file. The input JSON maps each `botSlug` to a real MyShell image URL or an object with `remoteUrl`, optional `prompt`, `sourceWidgetId`, `sourceWidgetName`, and `targetBotExecuted`. The materializer downloads the images into `frontend/public/generated/bot-previews/`, writes `manifest.json`, and marks each entry as `botSpecific`. Use `--merge-existing-manifest` for incremental target-bot runs so unchanged bot previews stay in the manifest while the newly verified bot flips `targetBotExecuted`.

If `/api/health` or the target runner reports `captcha_required`, the cookies were present but the headless/new Chrome profile landed on MyShell/Cloudflare challenge pages. Complete the challenge in a verified browser session or rerun against a trusted CDP profile before expecting target-bot execution evidence.

For local MyShell Art API diagnosis, export cookies to a temporary file and probe auth without printing cookie values:

```bash
python scripts/export_myshell_chrome_cookies.py --profile Default --output /tmp/myshell-cookies.json --summary-json
python scripts/probe_myshell_art_api.py --cookies-file /tmp/myshell-cookies.json
```

The summary includes cookie names and whether `ms_token` is present, but never cookie values. `probe_myshell_art_api.py` defaults to non-generating auth/task probes; pass `--execute --bot-id <targetBotId> --input-value <form-value>` only when you intentionally want to submit a real MyShell Art generation. The script first probes auth and will not submit generation if MyShell returns `UNAUTHORIZED`.

Running frontend browser smoke after backend and frontend dev servers start:

```bash
cd frontend
STUDIO_FRONTEND_URL=http://127.0.0.1:5174 npm run smoke:studio
```

The frontend smoke opens `/?test_route=dreamy`, forces Canvas mode, verifies the Dreamy Studio title, Layers & Agents, Inspector, footer queue controls, Evidence drawer, Page/Agent selectors, Page Registry, Dispatch Matrix, Dispatch Queue, and Audit JSON action, then captures a screenshot under `frontend/.studio-smoke/`.

Cloud Run build from the SuperClaw repository root:

```bash
gcloud builds submit --config apps/myshell-studio-orchestrator/orchestrator/cloudbuild.yaml .
```

The image builds MyShell Studio and the supplemental Creative Canvas from the same repository context. The current Cloud Run blueprint requires authenticated invocation and sets `--max-instances 1` because Studio projects, jobs, and evidence use the container-local SQLite store. Move `STUDIO_STORE_PATH` to a shared durable store before increasing instance count.

Cloud and CI install the hash-locked `orchestrator/backend/requirements.lock`. After changing direct dependencies in `requirements.txt`, regenerate the lock from this app directory with the command recorded at the top of `requirements.lock`.
