# Dreamy Unified Entry

## Frontend repo map

- `src/App.tsx`: Telegram deep-link parsing, providers, `MemoryRouter`, and route table.
- `src/pages`: route-level surfaces such as Explore, Upload, TagGenerator, Library, Energy, and Earn.
- `src/features/studio/pages`: Studio route-level surfaces such as Dreamy and CanvasPro.
- `src/services/api.ts`: shared Dreamy miniapp API client. Base URL defaults to `https://api.myshell.fun`, prefix is `/v1/telegram/miniapp/dreamy`.
- `src/services/tracking.ts`: buffered telemetry via `${API_PREFIX}/events`.
- `src/contexts`: init, energy, invite, check-in, and toast state.
- `src/i18n`: static namespace imports for the current locale set.
- `src/styles`: Fantasia shared tokens plus Dreamy-specific brand tokens.

## Existing Dreamy miniapp interfaces

All endpoints are POST through `apiRequest` unless noted.

- `POST /v1/telegram/miniapp/dreamy/init`
- `POST /v1/telegram/miniapp/dreamy/explore`
- `POST /v1/telegram/miniapp/dreamy/get-by-slug`
- `POST /v1/telegram/miniapp/dreamy/generate`
- `POST /v1/telegram/miniapp/dreamy/generate/result`
- `POST /v1/telegram/miniapp/dreamy/task/running`
- `POST /v1/telegram/miniapp/dreamy/task/detail`
- `POST /v1/telegram/miniapp/dreamy/task/retry`
- `POST /v1/telegram/miniapp/dreamy/task/delete`
- `POST /v1/telegram/miniapp/dreamy/task/cancel`
- `POST /v1/telegram/miniapp/dreamy/task/like`
- `POST /v1/telegram/miniapp/dreamy/library`
- `POST /v1/telegram/miniapp/dreamy/library/list`
- `POST /v1/telegram/miniapp/dreamy/library/feedback`
- `POST /v1/telegram/miniapp/dreamy/library/delete`
- `POST /v1/telegram/miniapp/dreamy/get_upload_presign_url`, then `PUT` to the returned upload URL.
- `POST /v1/shellchannel/telegram/miniapp/get_form_by_app_id`

## Reference repo interfaces

`art-chat-orchestrator` exposes:

- `POST /api/chat` as an SSE stream. Body is `FormData(message, conversation_id?, image?)`.
- `GET /api/gallery` for prompt presets.
- `GET /api/bots` for the bot catalog.
- `GET /api/health`.

`myshell-art-cli` maps the Art web API and documents the reliable browser-assisted path:

- `POST /v1/homepage/art/generate`
- `POST /v1/homepage/art/generate_result`
- `POST /v1/homepage/art/task/running`
- `POST /v1/homepage/art/task/cancel`
- `POST /v1/homepage/art/task/retry`
- `POST /v1/homepage/art/task/like`
- `POST /v1/homepage/art/library`
- `POST /v1/homepage/art/library/delete`
- `POST /v1/homepage/art/explore`
- `POST /v1/user/get_energy`
- `POST /v1/file/upload/presigned_url`

The browser cannot run the CLI's Playwright workflow directly, so the miniapp integrates the shared contract shapes and delegates server-side/browser-assisted execution to an orchestrator service when configured.

## New integration

- Route: `/dreamy`.
- Deep links: `?page=dreamy`, `?test_route=dreamy`, or Telegram `startapp=dreamy`.
- Page: `src/features/studio/pages/Dreamy.tsx`.
- Studio status strips, delivery drawer/panels, chat/bot panels, preview timeline panels, composer,
  Canvas workspace, and Canvas side panels: `src/features/studio/components/`.
- Studio page controllers and use cases: `src/features/studio/hooks/`, including streaming run
  orchestration, Dreamy client execution, delivery state, dispatch session control, audit actions,
  dispatch target running, CanvasPro generation drafts, and CanvasPro quick commands.
- Studio model public entry: `src/features/studio/model/dreamyWorkspace.ts`.
- Concrete model modules: `workspaceTypes.ts`, `dreamyPresets.ts`, `studioAssets.ts`,
  `studioRuntime.ts`, and `canvasGraph.ts`.
- Art catalog and local fallback router: `src/data/artBots.ts`.
- Studio API public entry: `src/features/studio/api/index.ts`.
- API paths/SSE/contracts/endpoints/client adapters: `endpointPaths.ts`, `sse.ts`,
  `studioDispatchLinks.ts`, `studioContracts.ts`, `studioBaseContracts.ts`,
  `studioCatalogContracts.ts`, `studioProjectContracts.ts`, `studioDeliveryContracts.ts`,
  `studioStreamingEndpoints.ts`, `studioProjectEndpoints.ts`, `studioDiscoveryEndpoints.ts`,
  `studioDeliveryEndpoints.ts`, `studioJobEndpoints.ts`, `studioEndpoints.ts`, and
  `dreamyMiniappClient.ts`.
- Generated Studio OpenAPI snapshot/types: `src/features/studio/api/generated/`, refreshed with
  `npm run generate:studio-api`.

The new service adapter supports:

- Streaming `POST /api/chat` SSE from `art-chat-orchestrator`.
- Submitting a Dreamy miniapp generation job through existing `uploadImage`, `fetchBotDetail`, and `generate`.
- Refreshing running/library state through existing Dreamy task APIs.

Set `VITE_DREAMY_ORCHESTRATOR_BASE_URL` when the orchestrator is hosted away from the same origin. If it is not set, `/dreamy` tries relative `/api/chat` and falls back to the local Art bot catalog when unavailable.
