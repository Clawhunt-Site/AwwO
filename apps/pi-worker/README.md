# AWWO Pi worker

Internal Node service for the Go SaaS backend. Every request runs the real Pi SDK in a separate child process and temporary directory. It supports text conversations, server-owned agent instructions, independent selection from a server-configured model catalog, and streaming responses. This version exposes no tools, file access, shell execution, tenant extensions, arbitrary code, or provider credentials in requests.

Use Node >= 22.19.0. Dependencies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are pinned to `0.85.1`; commit `package-lock.json` and install with `npm ci --ignore-scripts`. There is no build step. Validation on this implementation used Node 26.3.0.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Run from this directory with environment variables already supplied using `npm start`, or put local values in the ignored `.env` file and use `node --env-file=.env server.mjs`. `.env.example` documents the configuration. Do not put credentials in the request body, repository, or command line. The Go backend uses `AWWO_PI_URL=http://127.0.0.1:8097` and the same `AWWO_PI_TOKEN`.

| Variable | Default / requirement |
| --- | --- |
| `AWWO_PI_TOKEN` | Required; at least 32 characters. Use a generated random service secret. |
| `AWWO_PI_HOST` / `AWWO_PI_PORT` | `127.0.0.1` / `8097` |
| `AWWO_PI_PROVIDER` | Required: `openai`, `anthropic`, or `ollama` |
| `AWWO_PI_MODEL` | Required: exact provider model ID |
| `AWWO_PI_API_KEY` | Required for OpenAI/Anthropic; optional for local Ollama |
| `AWWO_PI_BASE_URL` | Provider default when omitted: OpenAI `https://api.openai.com/v1`, Anthropic `https://api.anthropic.com`, Ollama `http://127.0.0.1:11434/v1` |
| `AWWO_PI_MODELS_JSON` | Optional JSON array of additional model profiles; described below. Existing default model variables remain required. |
| `AWWO_PI_TIMEOUT_MS` | `120000`; includes worker startup and the full request |
| `AWWO_PI_CANCEL_GRACE_MS` | `2000`; terminate the owned child after this grace period |
| `AWWO_PI_MAX_CONCURRENCY` | `4`; excess requests get HTTP 429 |
| `AWWO_PI_MAX_OUTPUT_BYTES` | `1048576`; bounded streamed response size |
| `AWWO_PI_CONTEXT_WINDOW` / `AWWO_PI_MAX_TOKENS` | Application limits `32768` / `4096`; adjust for the selected model |

OpenAI-compatible providers use the chat completions protocol. Anthropic uses the messages protocol. Ollama uses its `/v1` compatibility endpoint. Provider compatibility and access to a particular model require a separate live acceptance check. Reasoning, images, tools, and provider-specific options are not part of this initial API. No mock mode exists in the production entrypoint.

## Server-owned model catalog

Each Agent can select a stable catalog ID. Define additional profiles in `AWWO_PI_MODELS_JSON`; the JSON contains references to secret environment variables, never key values:

```json
[
  {
    "id": "reviewer",
    "provider": "anthropic",
    "model": "your-approved-model-id",
    "apiKeyEnv": "AWWO_REVIEWER_API_KEY",
    "contextWindow": 32768,
    "maxTokens": 4096
  }
]
```

Profile fields are `id`, `provider`, `model`, optional `baseURL`, `apiKeyEnv`, `contextWindow`, and `maxTokens`. IDs accept ASCII letters, digits, `_`, `-`, and `.`, up to 128 characters and beginning with a letter or digit. Up to 32 additional profiles are supported. IDs must be unique and cannot equal the existing default model ID. The default model remains the first catalog item with `id = AWWO_PI_MODEL`; omitting a request model continues to use that default. Profile IDs identify the selection; a profile's provider model name is not an alternative selector.

`apiKeyEnv` must name an environment variable visible to the Pi service. It is required for OpenAI/Anthropic profiles and optional for Ollama. Resolve every referenced secret through the environment-specific secret manager or a private environment file. Child processes receive only the selected profile's resolved key over private IPC; they never inherit the full catalog or host environment. Neither key values nor environment references nor endpoint URLs appear in `/health`.

Omitted profile capacities inherit the application default model's capacity settings; explicitly set them to the real selected model's supported limits. `contextWindow` accepts integers from 4096 to 2000000; `maxTokens` accepts 128 to 32768 and must leave room for input plus 256 bytes of reserved framing. URLs use the same trusted server configuration rules as the default provider: HTTP or HTTPS only, with a host, no credentials, query, fragment, whitespace, or backslash. Use HTTPS for remote providers; HTTP supports private local-compatible endpoints.

Malformed JSON, duplicate IDs, unknown fields (including embedded `apiKey`), invalid providers, URLs, or capacities cause startup to fail with a redacted configuration error. A valid profile whose referenced credential is missing makes the whole service unconfigured (HTTP 503), preventing partial catalog readiness. Requests cannot define profiles, credentials, endpoints, or capacity overrides. Unknown or malformed selectors fail without starting a worker or falling back to another model. Settings and secret values should be separately provided for development, staging, and production using the same variable schema.

## Internal contract

`GET /health` requires no authentication and returns configuration readiness without secrets. HTTP 200 means required configuration is present; it does not prove provider connectivity. Missing configuration returns HTTP 503 with `ready: false`. The response always includes `modelConnectivityVerified: false`. Legacy `provider`, `model`, and `limits` describe the default. `models` lists `{id, name, provider, runtime: "pi", contextWindow, maxOutputTokens, maxContextTextBytes, messageOverheadBytes}` for each selection, so Go can enforce the selected Agent's capacity before accepting a run.

All `/internal/*` routes require `Authorization: Bearer <AWWO_PI_TOKEN>`. Keep this service private. Browser users authenticate and authorize through Go; this token grants internal service authority and must never reach a browser.

`POST /internal/runs` requires `Content-Type: application/json`:

```json
{
  "runId": "run_01",
  "tenantId": "tenant_01",
  "sessionId": "session_01",
  "prompt": "The current user message",
  "messages": [
    { "role": "user", "content": "A previous user message" },
    { "role": "assistant", "content": "A previous completed answer" }
  ],
  "systemPrompt": "Optional instructions from the authorized saved agent",
  "model": "reviewer",
  "runtime": "pi"
}
```

`messages` contains completed historical messages only, excluding the current `prompt`. Go must check tenant/session/agent ownership before constructing this request. IDs accept ASCII letters, digits, `_`, and `-`, up to 128 characters. Only the documented fields are accepted. `systemPrompt` is plain text; it never names a file. The adapter derives a Pi session identifier from both tenant and session IDs.

`model` and `runtime` are optional for compatibility. `model` selects one published catalog ID. Only the `pi` runtime is currently supported. An unknown model ID returns HTTP 400 / `MODEL_NOT_FOUND`; a malformed selector or unsupported runtime returns HTTP 400 / `INVALID_INPUT`. Both fail before capacity is reserved. A team coordinator must use separate member session IDs for concurrent Agent turns, then own the resulting history, ordering, and persistence in Go.

Transport limits are 128000 characters for `prompt`, 32768 characters for `systemPrompt` and each history message, at most 100 history messages, 262144 characters across all text, and a 1 MiB HTTP body. Character limits count JavaScript UTF-16 code units: an emoji outside the basic multilingual plane counts as two. Go applies the stricter 128000-byte planner prompt limit. These transport limits are separate from model capacity: before starting a worker, the service resolves the requested catalog profile and uses its conservative UTF-8 byte admission budget of `contextWindow - maxTokens - 256`, including 32 additional bytes per input/history message. It returns HTTP 413 / `CONTEXT_LIMIT` if the text does not fit, without trimming content or calling the model. This guard is not a provider-tokenizer measurement. The default 32768-token context therefore cannot accept the largest transported planner prompt; configure a larger context only when the actual model supports it. `/health.limits` exposes default bounds and `/health.models` exposes each profile's bounds. No frontend or tenant request can increase them.

Accepted requests return HTTP 200 with `text/event-stream`. Each SSE frame contains exactly one JSON object in its `data:` line:

```text
data: {"type":"text_delta","delta":"Hello"}

data: {"type":"completed","text":"Hello"}

```

The final event is exactly one of `completed`, `failed` (`code`, `message`), or `cancelled`. Heartbeats are SSE comments. Provider errors, internal paths, and credentials are excluded from error responses. Duplicate active run IDs or another active run in the same tenant/session return HTTP 409. Runtime configuration missing before streaming returns HTTP 503. Malformed input returns HTTP 400; wrong content type 415; internal authentication failure 401.

`DELETE /internal/runs/{runId}` requests cancellation and returns HTTP 202; an unknown run returns 404. A client disconnect also cancels that run. Cancellation clears Pi's queues and aborts the model request; the supervisor forcibly stops the child if needed. It deletes the temporary directory only after child exit. Final SSE events are published after the child stops, cleanup finishes, and the session/concurrency reservation is released, so the next turn may start immediately without overlapping child processes. A child that hangs after reporting its result is forcibly stopped within the configured cancellation grace period before that result is delivered.

Shutdown also waits for admitted runs still awaiting startup, cancels them as soon as their handle exists, and waits for their reservation release. Requests that finish uploading after shutdown starts are rejected before admission.

HTTP 409 / `RUN_BUSY` means this run ID is already active; do not resubmit it. HTTP 409 / `SESSION_BUSY` means another run still reserves the session and this submitted run was never accepted. The Go caller may retry that specific rejection with a bounded wait and the same run ID/body, for example while a previously cancelled run finishes cleanup. No other error implies that retry is safe.

## State and isolation

Go owns all durable history and run records. Workers create memory-only Pi sessions from the authorized text history and do not reuse processes across requests. This adapter has no durable event replay or crash resumption; Go must mark an interrupted stream as failed/interrupted, preserve completed history, and avoid automatically repeating a possibly accepted request. Automatic provider retries and automatic compaction are disabled; an overlong conversation fails rather than silently discarding history. The adapter does not claim billing usage from reconstructed history.

Each child receives an explicit environment without host provider credentials, `HOME`, `NODE_OPTIONS`, or proxy secrets. `PI_CODING_AGENT_DIR` points inside its private temporary directory. Model runtime credentials and settings live in memory; `modelsPath: null` prevents global model file discovery. Extension, skill, prompt-template, theme, and context-file loading are disabled. Pi's outgoing system prompt is restricted to the configured application prompt through its public `Agent.streamFunction` hook, removing the coding harness's appended local working-directory metadata.

Process separation and a tool allowlist are not an operating-system sandbox. Public deployment needs its own container/process identity, resource limits, restricted network access, TLS between hosts, secret management, and Go tenant authorization. This implementation has not been deployed or accepted against a real provider account.

## Verification scope

`npm test` uses the real Pi package and real child processes against local test HTTP providers. It verifies OpenAI/Anthropic/Ollama-compatible framing, role-based history, system instructions, authentication, unconfigured behavior, tenant process separation, tool suppression, poisoned runtime-resource rejection, redacted model failures, subprocess cancellation, timeout, temporary-directory cleanup, duplicate-run rejection, and HTTP disconnect cancellation. Catalog tests run two profiles concurrently through separate actual Pi child processes and local providers, asserting model names, URLs, credentials, output limits, context admission, isolation, redaction, malformed configuration, and unknown-selector rejection. These fixtures are confined to tests and do not prove actual cloud credentials or an installed Ollama model.

SDK reference snapshot: [Pi 0.85.1 SDK](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md). Repository: [earendil-works/pi](https://github.com/earendil-works/pi), formerly `badlogic/pi-mono`.

## Backend observability protocol v1

Every terminal event carries an additive `observability` object; existing text/error semantics and one-request execution remain unchanged. `text_delta` carries no usage. Go remains the sole tenant authority, accounting ledger and estimator. Worker output never contains pricing or SDK cost.

Provider SSE telemetry follows event boundaries: multiline `data:` JSON and LF, CRLF or CR separators are supported across fragmented network chunks. One event has a one-MiB telemetry budget; exceeding it marks usage invalid without changing the bytes delivered to the model SDK.

`observability.version=1`; usage contains `status` (reported, partial, unavailable, invalid, unknown), `source` (provider_raw or none in these adapters), a bounded `reason`, and nullable nonnegative safe-integer `inputTokens`, `outputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens`, `providerTotalTokens`, `computedTotalTokens`. The raw existing provider response stream is observed before SDK normalization, without a duplicate response/body buffer. A missing object/field stays null; explicit zero stays zero. Cache-read is a subset of input and reasoning is a subset of output; neither is added twice. Anthropic input excludes cache categories, so the adapter adds explicitly reported cache read/write counts to canonical input while absent optional cache fields remain null. Provider total mismatches, invalid ranges and oversized telemetry become invalid usage. Failure/cancellation retains reliable usage already received; missing usage after a possibly accepted provider call is unknown. No usage is inferred from restored history.

Timings are monotonic integer milliseconds: `setupMs` includes process setup until actual provider fetch, `providerMs` ends at provider terminal or observed stream end/error, `providerTtftMs` uses first actual provider text delta, and `workerFirstDeltaMs` uses first parent output. Nontext/tool-only output has null provider TTFT. Parent `workerTotalMs` is filled only after child close, cleanup and capacity release. A per-run monotonic timestamp reaches the child over private IPC; it and all exporter configuration stay outside model payloads.

Set `AWWO_METRICS_ENABLED=true` to enable the independent `AWWO_METRICS_LISTEN_ADDR` listener (default `127.0.0.1:9102`). Only literal loopback addresses are accepted. `GET /metrics` on this listener returns Prometheus text; the authenticated business listener continues to return 404 for this path. Exposed measurements include completed/failed/cancelled invocation counters by bounded catalog model/runtime/usage status, worker/provider/TTFT/first-delta histograms, active/capacity gauges, RSS, and bounded exporter failure/drop counters. No tenant, run, session, request, trace ID or content appears in labels.

Self-hosted traces are independently opt-in with `AWWO_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, fixed `OTEL_SERVICE_NAME=awwo-pi-worker` and `OTEL_TRACES_SAMPLER_ARG` (development/staging 1, production 0.05). The endpoint must be internal; remote non-development collectors require HTTPS. `OTEL_TRACES_SAMPLER`, when present, must be `parentbased_traceidratio`. Only authenticated and accepted Go requests can supply W3C parents. Workers ignore baggage/tracestate and explicitly strip all three headers before provider requests. Controlled `worker.run` and `worker.provider.call` spans use fixed names and allowlisted runtime/catalog/provider/protocol/outcome attributes. Arbitrary `OTEL_RESOURCE_ATTRIBUTES` and exporter-header env values are ignored. Hosted SDK tracing remains OFF and its health field remains false; `selfHostedTracingEnabled` reports this separate mechanism.

The exporter uses OTLP/HTTP JSON, a 512-span bounded queue, batches of at most 128, one in-flight export, a two-second timeout and no retries. Its failures do not block terminal delivery or reissue inference. No collector, dashboard, alert destination or production deployment is installed by the worker. Automated tests exercise real SDK/child/SSE usage, cancellation, missing/zero distinctions, private listener access, sanitized export payloads and collector failure isolation.

The trusted `/health.models` catalog exposes `id` (application selector), `providerModel` (exact upstream model sent in requests), and `protocol` (actual normalized wire protocol), independently of the display `name`. Go should freeze these fields at admission for historical accounting and never infer upstream model identity from the display name. Pi advertises `chat_completions` for OpenAI/Ollama and `anthropic_messages` for Anthropic; OpenAI Agents advertises the configured `chat_completions` or `responses`.
