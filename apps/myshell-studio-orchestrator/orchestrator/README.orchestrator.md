# Orchestrator Backend

The backend exposes the Studio API for MyShell page and agent dispatch. It keeps projects, segments, jobs, auth status, and evidence trails in a SQLite store so a backend restart can recover active Studio state.

## Core Surfaces

- `GET /api/health` reports backend, SQLite storage, Chrome CDP, MyShell cookie, cookie injection result evidence, Dreamy API auth state, and FFmpeg media export readiness.
- `GET /api/pages` lists registered page adapters and miniapp navigation surfaces, including `dreamy-miniapp`, `myshell-art`, Explore, AI Picks, Bot Detail, Upload, Tag Generator, Library, Library Detail, Energy, Energy History, Earn, Share Invite, Settings, Profile, and Checkin.
- `GET /api/studio/readiness` includes a `page-registry` route coverage evidence block that compares registered `appRoute` values with the frontend `<Route>` paths when the App source is available. Missing or extra production routes block readiness; missing source is reported as `source_unavailable` without blocking runtime startup.
- `GET /api/agents` lists the dispatch graph agents.
- `POST /api/studio/run` routes a prompt, creates a persisted job, and streams Studio SSE events. Dreamy jobs use the authenticated browser miniapp session by default; when `DREAMY_TELEGRAM_INIT_DATA` is configured, the backend submits Dreamy `get-by-slug` -> `generate` -> `generate/result` directly and updates the segment/job with accepted media or explicit running/error evidence.
- `GET /api/studio/delivery-audit` returns machine-readable acceptance status, requirements, de-duplicated operator `actions` from both readiness fixes and handoff gaps, artifacts, and embedded reports for deployment handoff. Pending dispatch session targets are promoted as executable `run-target` actions, cancelled dispatch targets are promoted as safe `retry-queue` actions, and dispatch targets marked `visited` or `error` are promoted into handoff/audit operator actions with Studio `uiUrl` values for exact `/dreamy` restore. Manual and retry actions include a materialized `next` instruction with concrete operator `url`/`retryUrl`/`cancelUrl`/`uiUrl` values where applicable. Artifacts include both stable template `endpoint` values and concrete `url` values with project/session/source context filled in. Add `download=1` to receive `myshell-studio-audit-{project_id|current}.json` as a JSON attachment.
- `POST /api/studio/actions/resolve` executes safe audit actions such as targeted `verify-ready` and dispatch-session `run-target`, or returns explicit `manual_required` instructions with concrete `url`/`retryUrl`/`cancelUrl` values for every handoff/audit operator action. Dispatch target actions can include `session_id`, which resolves to the exact dispatch session API `url` plus `target_id` and a Studio `uiUrl` for `/dreamy` target restore.
- `POST /api/studio/actions/resolve-batch` executes multiple safe audit actions, including `verify-ready` coverage checks, dispatch-session `run-target` actions, and cancelled-session `retry-queue` actions, preserves every manual operator action with instructions, and returns a refreshed audit. Batch `run-target` entries include the dispatch target run result so the Studio UI can continue into client execution requests.
- `POST /api/studio/dispatch-batch` and `POST /api/studio/dispatch-sessions` accept `exclude_covered=true` for resume mode. Covered pages are skipped with `reason: "already_covered"` and `summary.coveredSkipped`, so operators can plan all pages or only the remaining unverified surfaces.
- `GET /api/studio/dispatch-sessions/{session_id}` restores one recoverable dispatch queue and accepts `target_id` to return `focusedTargetId`, `focusedTargetIndex`, and `focusedTarget` for exact handoff inspection links. The Studio UI accepts `/dreamy?dispatch_session_id={session_id}&target_id={target_id}` or `/dreamy?session_id={session_id}&target_id={target_id}` to restore and highlight that exact target. `POST /api/studio/dispatch-sessions/{session_id}/cancel` marks unfinished targets `cancelled`, `POST /api/studio/dispatch-sessions/{session_id}/retry` reopens `cancelled` and `error` targets, `POST /api/studio/dispatch-sessions/{session_id}/targets/{target_id}/run` turns a queued target into a navigation handoff or adapter `executionRequest`, and `POST /api/studio/dispatch-sessions/{session_id}/targets/{target_id}` marks a target `visited`, `completed`, `skipped`, or `error`. Dreamy client target runs carry `dispatchSessionId` and `dispatchTargetId` through `/client-result`, so successful client media automatically completes the target. The Studio UI exposes Cancel Queue, Retry Queue, Run Next, Done, Error, and Skip controls for queue targets.
- `GET /api/studio/projects` lists recent persisted projects for Studio restore.
- `GET /api/studio/projects/{project_id}/delivery-bundle?download=1` returns the operator handoff bundle as a downloadable JSON attachment. Bundle artifacts include session-level restore links and target-level `target_id` restore links for exact page handoff inspection. Dispatch artifacts keep API `url` values and include Studio-facing `uiUrl` values that open `/dreamy` with the matching session and target. Bundle `remainingTargets` includes both `pending` and `visited` dispatch targets, so opened-but-uncompleted pages stay visible during handoff. Bundle `skippedTargets` includes both plan-time skips and operator-skipped dispatch targets, `errorTargets` lists dispatch targets that need operator review, and `summary.cancelledTargets` keeps cancelled queue scope visible for retry/resume decisions.
- `GET /api/studio/jobs` lists the persisted queue with optional `project_id` and `status` filters.
- `GET /api/studio/jobs/{job_id}` and `/evidence` return current state plus evidence history.
- `POST /api/studio/jobs/{job_id}/cancel`, `/retry`, and `/poll` manage persisted jobs. Retry returns an `executionRequest` for client-side miniapp execution when needed. Poll refreshes server-side Dreamy `generate/result` evidence for running jobs and updates the project timeline with accepted media, `running`, `auth_missing`, or explicit error evidence.

When `/api/studio/run` receives the default Dreamy page selection, the backend can infer registered miniapp navigation targets from the prompt, for example Library, Upload, Tag Generator, Settings, Energy, Earn, Share Invite, Explore, AI Picks, Bot Detail, or Checkin. Explicit non-default `page_id` values always take priority over prompt inference.

`POST /api/studio/run` accepts optional `agent_id`. Registered agent ids are persisted on the job and included in route/execution/retry payloads; unknown ids fall back to the default executor agent for the selected page.

Miniapp navigation pages are loaded from `backend/studio_pages_manifest.json`. Set `STUDIO_PAGES_MANIFEST=/path/to/pages.json` to extend or replace the page set per environment. Manifest entries support `id`, `name`, `appRoute`, `capabilities`, optional `routeParams`, optional `routeDefaults`, and optional `intentKeywords`; matching intent keywords join the same prompt router used by the default page selection. `routeDefaults` are merged into the generated navigation query before dynamic values like `slug_id` and `img`, unless a route uses a matching path placeholder such as `/library/:id`, in which case Studio replaces the placeholder before computing `missingRouteParams`. Set `STUDIO_FRONTEND_APP_ROUTES_FILE=/path/to/App.tsx` when the frontend route source is outside the default repository layout and should be included in readiness route coverage.

## Evidence Rules

The backend never marks placeholder media as complete. Generation `done` is accepted only when a fresh media URL or task result is registered. Navigation pages complete with accepted route evidence and return `clientAction: navigate` plus `navigationPath` for the Studio frontend to execute while keeping the return dock available. Missing cookies become `auth_missing`; long-running or failed adapters become `timeout` or `error`.

Contextual navigation pages can declare `routeParams`. The current registry uses this to append `slug_id` for Bot Detail, Upload, and Tag Generator, add `img` for Tag Generator when source media exists, and replace the `id` path parameter for Library Detail.

## Local Backend

```bash
cd orchestrator/backend
python -m pip install -r requirements.txt
PORT=8090 python main.py
```

## MyShell Art CDP

Start Chrome with remote debugging and provide cookies:

```bash
google-chrome-stable --remote-debugging-port=9222 --user-data-dir=/tmp/myshell-chrome
export MYSHELL_COOKIES_FILE=/tmp/myshell-cookies.json
```

The Cloud Run startup script writes the latest cookie injection result to `.studio/cookie-injection-status.json` by default; set `MYSHELL_COOKIE_INJECTION_STATUS_PATH` to use a different path. Without cookies, MyShell Art jobs are visible in Studio but stop as `auth_missing`. If cookies exist but injection fails, health/readiness report degraded cookie-injection evidence instead of marking the adapter ready. If cookie injection succeeded but the current Chrome CDP endpoint is unavailable, the Art adapter still reports `auth_missing` with CDP evidence so stale status files cannot masquerade as a live browser session.

## Dreamy Server Execution

To let Cloud Run execute Dreamy generation without waiting for a Telegram webview client, provide server-side miniapp init data:

```bash
export DREAMY_TELEGRAM_INIT_DATA='query_id=...&user=...&auth_date=...&hash=...'
export DREAMY_API_BASE_URL=https://api.myshell.fun
export DREAMY_SERVER_POLL_ATTEMPTS=3
export DREAMY_SERVER_POLL_INTERVAL_SECONDS=0.75
```

With this configured, `dreamy-miniapp` auth reports `ready` and `/api/studio/run` emits `executor: "server"` for Dreamy jobs. The backend accepts only fresh `generate/result` media as `done`; unfinished tasks remain `running` with the Dreamy task id so the operator can poll through `POST /api/studio/jobs/{job_id}/poll`, retry, or cancel from the Studio job queue.

## Cloud Run Secret Binding

Cloud Build deploys through `orchestrator/deploy-cloud-run.sh`. The script requires authenticated Cloud Run invocation, keeps the service single-instance for the SQLite store, and automatically binds generation credentials when these Secret Manager secrets exist:

```bash
printf '%s' "$DREAMY_TELEGRAM_INIT_DATA" | gcloud secrets create myshell-dreamy-init-data --data-file=-
printf '%s' "$MYSHELL_COOKIES" | gcloud secrets create myshell-cookies --data-file=-
```

If a secret already exists, add a new version instead:

```bash
printf '%s' "$DREAMY_TELEGRAM_INIT_DATA" | gcloud secrets versions add myshell-dreamy-init-data --data-file=-
printf '%s' "$MYSHELL_COOKIES" | gcloud secrets versions add myshell-cookies --data-file=-
```

After the next Cloud Build deploy, `/api/health` exposes `credentialSetup`. It reports `ready` only when `DREAMY_TELEGRAM_INIT_DATA` and `MYSHELL_COOKIES` are injected into the Cloud Run runtime. Without those secrets, Dreamy remains client-delegated and MyShell Art remains `auth_missing`.

Cloud Run invocation is authenticated. Operator smoke scripts read `STUDIO_AUTH_TOKEN`; `scripts/configure_generation_secrets.sh` obtains an identity token from the active `gcloud` account automatically.

## Live Generation Smoke

`GET /api/studio/generation-smoke` reports whether the deployed backend is ready to prove a real generation. It does not spend generation credits. When `DREAMY_TELEGRAM_INIT_DATA` is missing it returns `needs_configuration` and no job is created.

After credentials are configured, run a real Dreamy backend generation smoke:

```bash
cd orchestrator/backend
python -m generation_smoke \
  --base-url https://YOUR-CLOUD-RUN-URL \
  --execute \
  --require-live
```

The smoke creates a persisted Studio project/job, calls Dreamy `get-by-slug` -> `generate` -> `generate/result`, and only passes `--require-live` when the latest evidence contains accepted media. The result is also exposed in `/api/studio/delivery-audit` as `live-generation-smoke`, so delivery evidence survives backend restarts through the SQLite store.

### Local Credential Handoff

When the operator is logged into MyShell in local Chrome, export cookies without printing their values:

```bash
python3 scripts/export_myshell_chrome_cookies.py \
  --profile Default \
  --output /tmp/myshell-cookies.json \
  --summary-json
```

The summary is value-safe: it includes cookie names, profile coverage, and missing required cookie names such as `ms_token`, but never cookie values. To verify whether those cookies are accepted by the MyShell Art homepage API before uploading anything, run:

```bash
python scripts/probe_myshell_art_api.py --cookies-file /tmp/myshell-cookies.json
python scripts/generation_chain_check.py \
  --base-url https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app \
  --project k-project-481102 \
  --check-local-cookies \
  --probe-local-art-api \
  --local-cookies-file /tmp/myshell-cookies.json \
  --require-live
```

These default probes call non-generating auth/task endpoints only. Use `probe_myshell_art_api.py --execute --bot-id <targetBotId> --input-value <form-value>` only when a real Art generation run is intended. The scripts probe auth first and will not submit generation if MyShell returns `UNAUTHORIZED`; do not upload cookies until the probe is ready.

Get `DREAMY_TELEGRAM_INIT_DATA` from a real Telegram Miniapp session. It must look like Telegram WebApp `initData` and include `auth_date` plus `hash`.

Then configure Secret Manager, deploy, and require a real media result:

```bash
scripts/configure_generation_secrets.sh \
  --project k-project-481102 \
  --init-data-file /tmp/dreamy-init-data.txt \
  --cookies-file /tmp/myshell-cookies.json \
  --apply
```

Without `--apply`, this command is a dry-run and does not upload values. With `--apply`, the script validates the init data shape, validates cookie JSON, probes MyShell Art API auth with the provided cookies, updates `myshell-dreamy-init-data` plus `myshell-cookies` in the explicit Google Cloud project, triggers Cloud Build, and runs `python -m generation_smoke --execute --require-live` against the public service. If the Art API probe is `UNAUTHORIZED`, no secrets are uploaded.

To dry-run the complete post-credential finalization chain without spending generation capacity:

```bash
python scripts/complete_generation_chain.py \
  --base-url https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app \
  --project k-project-481102
```

When valid Dreamy init data and MyShell Art cookies are ready, run the full chain explicitly:

```bash
python scripts/complete_generation_chain.py \
  --base-url https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app \
  --project k-project-481102 \
  --apply \
  --configure-secrets \
  --init-data-file /tmp/dreamy-init-data.txt \
  --cookies-file /tmp/myshell-cookies.json \
  --execute-live \
  --execute-art-targets \
  --import-dreamy-targets \
  --materialize \
  --deploy-after-materialize
```

The complete-chain runner is safe by default: it only prints a plan unless `--apply` is present, and live Dreamy generation plus Art target execution each require explicit flags. When `--cookies-file` is supplied, the Art target execution step receives it as `MYSHELL_COOKIES_FILE` so the same probed cookie file is reused without printing cookie values.
`--deploy-after-materialize` triggers Cloud Build after target evidence is merged into the local preview manifest, so the final public gate checks the deployed Cloud Run revision instead of stale preview data.

Target bot preview execution evidence is collected before materializing preview assets:

```bash
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
  --resolve-public-metadata \
  --output .studio-delivery-check/target-bot-preview-urls.json \
  --merge-existing
python scripts/materialize_bot_preview_manifest.py \
  --input .studio-delivery-check/target-bot-preview-urls.json \
  --merge-existing-manifest
```

Dreamy preview bots are Studio-level abstractions. After real Dreamy server jobs have accepted media, import that persisted evidence explicitly before merging the manifest:

```bash
python scripts/materialize_dreamy_target_previews.py \
  --base-url https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app \
  --output .studio-delivery-check/dreamy-target-preview-urls.json
python scripts/materialize_bot_preview_manifest.py \
  --input .studio-delivery-check/dreamy-target-preview-urls.json \
  --merge-existing-manifest
```

The Dreamy importer does not start generation and does not read credentials; it only marks `targetBotExecuted: true` for `done` Dreamy jobs whose evidence is already accepted and has an HTTP(S) media URL.

The runner prefers `--executor art-api`, which resolves public Art metadata and calls the target bot API directly with the public-page `targetBotId`. It reads cookies from `MYSHELL_COOKIES`, `MYSHELL_COOKIES_FILE`, or backend-local cookie files, and only marks `targetBotExecuted: true` after the target bot returns a fresh output URL. The default CDP executor remains available for browser-session fallback; with `--resolve-public-metadata`, the plan/report also records the exact public-page `targetBotId`, `targetSlugId`, template, and generate button text. `GET /api/studio/art-api-auth-smoke` verifies deployed Art API auth without printing secret values. Materialize partial target runs with `--merge-existing-manifest` so unchanged bot previews remain present while newly verified bots update their execution evidence. If health or runner evidence reports `captcha_required`, the browser reached a MyShell/Cloudflare challenge page after cookie injection; use a verified browser session or complete the challenge before rerunning target-bot execution.

## Tests

```bash
cd orchestrator
python -m unittest discover -s backend/tests -v
```

After the backend is running, verify the operator delivery surface:

```bash
cd orchestrator/backend
python -m studio_smoke --base-url http://127.0.0.1:8090
```

The smoke validates health, page registry, agent registry, required readiness gates, dispatch matrix coverage, coverage summary, and delivery audit artifacts.

From the repository root, the full local handoff can also be checked with one command:

```bash
python scripts/studio_delivery_check.py
```

It starts a temporary backend on a free port, builds the frontend with that backend URL, serves the production build through `npm run preview`, runs backend and frontend smoke checks, writes `.studio-delivery-check/summary.json` with log paths plus Canvas workspace, Delivery Evidence drawer, and `frontend-smoke.json` paths, emits the same JSON summary, and cleans up its own processes. The summary embeds `reports.backendSmoke` and `reports.frontendSmoke`; the frontend report verifies the Delivery Command Center, includes the selected Explore `Plan Selected` → `Start Selected` → `Open Next` → `Return to Studio` interaction, and confirms the recoverable queue returns with the target marked `visited`. Pass `--frontend-mode dev` for a faster development-server check.

For the full operator handoff surface, also start the frontend against this backend and run:

```bash
cd ../frontend
STUDIO_FRONTEND_URL=http://127.0.0.1:5174 npm run smoke:studio
```

That browser smoke opens `/dreamy`, checks the Canvas workspace and Evidence drawer controls, and writes its screenshot to `frontend/.studio-smoke/`.
