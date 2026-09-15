# OpenAI Agents worker

Independent private runtime for AwwO's Go control plane, implemented with the official `@openai/agents` JavaScript SDK. Go retains tenant authorization, durable sessions, graph/team orchestration, invocation accounting and admission. Each accepted turn runs one SDK Agent in a fresh child process with its own instructions, selected model and approved functions. This directory does not replace the Pi worker.

## Run and verify

Node 26.3.0 was used for verification; this package declares Node >= 22.19.0. Dependencies are pinned in the local package and lockfile: `@openai/agents` 0.18.0, `openai` 7.15.0 and `zod` 4.6.2. Installation does not edit the root workspace lockfile.

```sh
npm --prefix apps/openai-agents-worker ci --ignore-scripts --no-audit --no-fund
npm --prefix apps/openai-agents-worker run check
npm --prefix apps/openai-agents-worker test
# Use a private env file with actual environment-specific values:
node --env-file=/absolute/private/worker.env apps/openai-agents-worker/server.mjs
```

`.env.example` contains the complete configuration surface and placeholders. The default listener is `127.0.0.1:8098`. Go uses the optional `AWWO_OPENAI_AGENTS_URL` / `AWWO_OPENAI_AGENTS_TOKEN` pair; use a dedicated internal token different from the Pi worker. Keep this listener private to the API service. Missing required settings leave `/health` unconfigured and reject execution. Invalid catalog structure fails startup with a sanitized configuration error.

`APP_ENV=development|staging|production` uses identical variable names. Configure separate resources and secrets per environment. Outside development, upstream endpoints require HTTPS except for literal loopback/localhost HTTP. The worker excludes parent proxy environment from its child; configure the intended endpoint directly. No key, endpoint or model connectivity is tested by `/health`.

## Private protocol

- `GET /health` is public metadata: `ready`, `provider`, default `model`, `runtime:"openai-agents"`, `sdkVersion`, `activeRuns`, `limits`, `models`, `supportsEffortSelection`, and enabled `tools`. `modelConnectivityVerified:false` explicitly means configuration readiness. Catalog entries include `id`, provider model `name`, runtime, protocol, context/output limits, the model's `reasoningEfforts` and its display-only `defaultReasoningEffort`. Tools include `id`, `name`, `type:"function"`, `readOnly:true`, description and `contextTextBytes`. Keys, key references and upstream base URLs are excluded.
- `POST /internal/runs` requires `Authorization: Bearer <internal token>` and JSON. Body: `{runId,tenantId,sessionId,prompt,messages:[{role:"user"|"assistant",content}],systemPrompt?,runtime?:"openai-agents",model?,effort?,tools?:["calculator"|"current_time"]}`. Unknown fields, tool code/schema, credentials, history system/tool roles, malformed selectors and unsupported runtimes are rejected. Go always sends the explicit runtime; omission selects this worker's sole runtime for internal compatibility.
- The model selector is an exact public catalog ID. Omission uses the required default model ID (`AWWO_OPENAI_AGENTS_MODEL`). Unknown IDs never fall back. `AWWO_OPENAI_AGENTS_MODELS_JSON` adds unique profiles with `id`, `provider:"openai"`, `model`, optional `baseURL`, required `apiKeyEnv`, optional `protocol`, `contextWindow`, `maxTokens`, `reasoningEfforts` and `defaultReasoningEffort` (never inherited from the default model, whose levels come from `AWWO_OPENAI_AGENTS_REASONING_EFFORTS` and `AWWO_OPENAI_AGENTS_DEFAULT_REASONING_EFFORT`). An optional request `effort` must be one of the selected profile's levels or the run is refused with `EFFORT_NOT_SUPPORTED`; without it no reasoning setting is sent, and the advertised default is display-only. Keys resolve once from the service environment; only the selected credential enters a run's IPC.
- Accepted requests stream SSE `data: <JSON>` events: `{type:"text_delta",delta}`, then exactly one `{type:"completed",text}`, `{type:"failed",code,message}`, or `{type:"cancelled"}`. Tool-enabled turns buffer provisional model text so only the final direct tool result is delivered. A terminal event is published after child teardown and slot release; partial text may precede a failure or cancellation and is not a successful result.
- `DELETE /internal/runs/{runId}` requires the internal token, returns 202 for an active exact run or 404. Disconnection, deadline and service shutdown also cancel the child. Duplicate run IDs and active `(tenantId,sessionId)` pairs are rejected independently. The worker trusts the authenticated Go service's tenant identifiers; it is not a public tenant API or durable run store.

Input limits match the Pi transport: 1 MiB HTTP body, 128,000 prompt UTF-16 units, 32,768 instruction/history-message units, 100 history messages, 262,144 combined text units. Admission also requires UTF-8 text bytes + 32 per message + selected tools' `contextTextBytes` <= `contextWindow - maxTokens - 256`. These are conservative byte limits, not a tokenizer claim. Go can use the same public budgets before reserving quota. Instructions and history are never silently truncated.

Admission codes include `UNAUTHORIZED` (401), `INVALID_INPUT` / `MODEL_NOT_FOUND` / `EFFORT_NOT_SUPPORTED` / `TOOL_DENIED` (400), `CONTEXT_LIMIT` (413), `RUN_BUSY` / `SESSION_BUSY` (409), `CAPACITY_EXCEEDED` (429), and `RUNTIME_UNAVAILABLE` (503). Runtime failure codes distinguish authentication, rate limiting, unavailability, protocol/output errors, invalid/denied tools, deadline, output bound and child loss. Messages come from a fixed safe allowlist; upstream bodies, stack traces and keys are not returned.

## Models, tools and accounting

The `openai` provider means OpenAI-compatible protocol, including self-hosted compatible services. Choose `chat_completions` (default, `/chat/completions`) or `responses` (`/responses`) explicitly. Chat Completions uses the SDK's `max_tokens` field; Responses uses its native conversion. A provider must support the selected protocol, streaming and configured model. Native Anthropic endpoints, hosted OpenAI tools, handoffs, arbitrary functions, MCP, shell, browser, filesystem and network tools are not enabled.

Every run makes **at most one provider request**: SDK `maxTurns:1`, `stop_on_first_tool`, zero SDK/client retries, no redirects and an additional model-call guard. A successful ordinary turn returns model text. When a function is selected by the model, its validated result is the final output: **there is no second model call to summarize the tool result**. At most one function call is accepted, including when a provider ignores `parallel_tool_calls:false`; multiple or unapproved calls fail before any function executes. The Go node output contract still validates this final output and can reject a tool result that does not meet the node's requested schema.

The static registry is disabled by default. Both the service's `AWWO_OPENAI_AGENTS_TOOLS_JSON` and the request's `tools` must allow a function:

| ID | Strict input | Output and bounds |
| --- | --- | --- |
| `calculator` | `{expression:string}` | JSON `{value:number}`; decimal arithmetic, unary signs, `+ - * /`, parentheses; at most 256 characters, 128 tokens, nesting 16, magnitude 1e12; rejects division by zero. Recursive-descent parser, never `eval`/`Function`. |
| `current_time` | `{timeZone:string|null}` | JSON `{iso,timeZone,local}`; UTC ISO timestamp, optional validated IANA timezone display, maximum timezone length 80; null uses UTC. |

No additional properties are allowed. Invalid model-generated JSON is checked before SDK execution because SDK-generated error strings must not be mistaken for successful function results.

## Isolation and evidence boundaries

The parent passes only the chosen model and validated request through private IPC. Child environment contains the Node runtime directory, private temporary directory, bundled-library search path and fixed tracing/logging-disable flags; it excludes parent credentials, HOME, NODE_OPTIONS, proxies, user configuration and catalog keys. Each directory is mode 0700 (mkdtemp), contains a 0600 provenance file, and is removed after exit. Child stdout/stderr are discarded; the parent reports sanitized events. Timeout, cancellation grace and byte output limits are bounded. Shutdown includes runs still waiting for their launch handle.

Tracing is disabled through environment, SDK global tracing and empty processor list, and Runner configuration; sensitive model/tool logging is disabled. The OpenAI client only calls the selected endpoint and does not follow redirects. Process separation is **not an operating-system sandbox**: deploy with the existing restricted service user, filesystem permissions and network controls. No durable state or real-model connectivity claim is made by this worker alone.

Tests exercise unit validation/parsing, real child lifecycle, real HTTP/SSE boundaries and the installed official SDK against loopback fixtures for both protocols, independent personas/history, concurrent model/key isolation, safe functions with exact request counts, error redaction, cancellation/deadline/output limits, and forced teardown. They make no real provider inference calls.

Official SDK references: [models](https://openai.github.io/openai-agents-js/guides/models/), [streaming](https://openai.github.io/openai-agents-js/guides/streaming/), [tracing](https://openai.github.io/openai-agents-js/guides/tracing/).

## Backend observability protocol v1

Every terminal event carries an additive `observability` object; existing text/error semantics and one-request execution remain unchanged. `text_delta` carries no usage. Go remains the sole tenant authority, accounting ledger and estimator. Worker output never contains pricing or SDK cost.

Provider SSE telemetry follows event boundaries: multiline `data:` JSON and LF, CRLF or CR separators are supported across fragmented network chunks. One event has a one-MiB telemetry budget; exceeding it marks usage invalid without changing the bytes delivered to the model SDK.

`observability.version=1`; usage contains `status` (reported, partial, unavailable, invalid, unknown), `source` (provider_raw or none in these adapters), a bounded `reason`, and nullable nonnegative safe-integer `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens`, `providerTotalTokens`, `computedTotalTokens`. The raw existing provider response stream is observed before SDK normalization, without a duplicate response/body buffer. A missing object/field stays null; explicit zero stays zero. Cache-read is a subset of input and reasoning is a subset of output; neither is added twice. Anthropic input excludes cache categories, so the adapter adds explicitly reported cache read/write counts to canonical input while absent optional cache fields remain null. Provider total mismatches, invalid ranges and oversized telemetry become invalid usage. Failure/cancellation retains reliable usage already received; missing usage after a possibly accepted provider call is unknown. No usage is inferred from restored history.

Timings are monotonic integer milliseconds: `setupMs` includes process setup until actual provider fetch, `providerMs` ends at provider terminal or observed stream end/error, `providerTtftMs` uses first actual provider text delta, and `workerFirstDeltaMs` uses first parent output. Nontext/tool-only output has null provider TTFT. Parent `workerTotalMs` is filled only after child close, cleanup and capacity release. A per-run monotonic timestamp reaches the child over private IPC; it and all exporter configuration stay outside model payloads.

Set `AWWO_METRICS_ENABLED=true` to enable the independent `AWWO_METRICS_LISTEN_ADDR` listener (default `127.0.0.1:9103`). Only literal loopback addresses are accepted. `GET /metrics` on this listener returns Prometheus text; the authenticated business listener continues to return 404 for this path. Exposed measurements include completed/failed/cancelled invocation counters by bounded catalog model/runtime/usage status, worker/provider/TTFT/first-delta histograms, active/capacity gauges, RSS, and bounded exporter failure/drop counters. No tenant, run, session, request, trace ID or content appears in labels.

Self-hosted traces are independently opt-in with `AWWO_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, fixed `OTEL_SERVICE_NAME=awwo-openai-agents-worker` and `OTEL_TRACES_SAMPLER_ARG` (development/staging 1, production 0.05). The endpoint must be internal; remote non-development collectors require HTTPS. `OTEL_TRACES_SAMPLER`, when present, must be `parentbased_traceidratio`. Only authenticated and accepted Go requests can supply W3C parents. Workers ignore baggage/tracestate and explicitly strip all three headers before provider requests. Controlled `worker.run` and `worker.provider.call` spans use fixed names and allowlisted runtime/catalog/provider/protocol/outcome attributes. Arbitrary `OTEL_RESOURCE_ATTRIBUTES` and exporter-header env values are ignored. Hosted SDK tracing remains OFF and its health field remains false; `selfHostedTracingEnabled` reports this separate mechanism.

The exporter uses OTLP/HTTP JSON, a 512-span bounded queue, batches of at most 128, one in-flight export, a two-second timeout and no retries. Its failures do not block terminal delivery or reissue inference. No collector, dashboard, alert destination or production deployment is installed by the worker. Automated tests exercise real SDK/child/SSE usage, cancellation, missing/zero distinctions, private listener access, sanitized export payloads and collector failure isolation.

The trusted `/health.models` catalog exposes `id` (application selector), `providerModel` (exact upstream model sent in requests), and `protocol` (actual normalized wire protocol), independently of the display `name`. Go should freeze these fields at admission for historical accounting and never infer upstream model identity from the display name. Pi advertises `chat_completions` for OpenAI/Ollama and `anthropic_messages` for Anthropic; OpenAI Agents advertises the configured `chat_completions` or `responses`.
