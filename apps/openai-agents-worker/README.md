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

- `GET /health` is public metadata: `ready`, `provider`, default `model`, `runtime:"openai-agents"`, `sdkVersion`, `activeRuns`, `limits`, `models`, and enabled `tools`. `modelConnectivityVerified:false` explicitly means configuration readiness. Catalog entries include `id`, provider model `name`, runtime, protocol and context/output limits. Tools include `id`, `name`, `type:"function"`, `readOnly:true`, description and `contextTextBytes`. Keys, key references and upstream base URLs are excluded.
- `POST /internal/runs` requires `Authorization: Bearer <internal token>` and JSON. Body: `{runId,tenantId,sessionId,prompt,messages:[{role:"user"|"assistant",content}],systemPrompt?,runtime?:"openai-agents",model?,tools?:["calculator"|"current_time"]}`. Unknown fields, tool code/schema, credentials, history system/tool roles, malformed selectors and unsupported runtimes are rejected. Go always sends the explicit runtime; omission selects this worker's sole runtime for internal compatibility.
- The model selector is an exact public catalog ID. Omission uses the required default model ID (`AWWO_OPENAI_AGENTS_MODEL`). Unknown IDs never fall back. `AWWO_OPENAI_AGENTS_MODELS_JSON` adds unique profiles with `id`, `provider:"openai"`, `model`, optional `baseURL`, required `apiKeyEnv`, optional `protocol`, `contextWindow`, `maxTokens`. Keys resolve once from the service environment; only the selected credential enters a run's IPC.
- Accepted requests stream SSE `data: <JSON>` events: `{type:"text_delta",delta}`, then exactly one `{type:"completed",text}`, `{type:"failed",code,message}`, or `{type:"cancelled"}`. Tool-enabled turns buffer provisional model text so only the final direct tool result is delivered. A terminal event is published after child teardown and slot release; partial text may precede a failure or cancellation and is not a successful result.
- `DELETE /internal/runs/{runId}` requires the internal token, returns 202 for an active exact run or 404. Disconnection, deadline and service shutdown also cancel the child. Duplicate run IDs and active `(tenantId,sessionId)` pairs are rejected independently. The worker trusts the authenticated Go service's tenant identifiers; it is not a public tenant API or durable run store.

Input limits match the Pi transport: 1 MiB HTTP body, 128,000 prompt UTF-16 units, 32,768 instruction/history-message units, 100 history messages, 262,144 combined text units. Admission also requires UTF-8 text bytes + 32 per message + selected tools' `contextTextBytes` <= `contextWindow - maxTokens - 256`. These are conservative byte limits, not a tokenizer claim. Go can use the same public budgets before reserving quota. Instructions and history are never silently truncated.

Admission codes include `UNAUTHORIZED` (401), `INVALID_INPUT` / `MODEL_NOT_FOUND` / `TOOL_DENIED` (400), `CONTEXT_LIMIT` (413), `RUN_BUSY` / `SESSION_BUSY` (409), `CAPACITY_EXCEEDED` (429), and `RUNTIME_UNAVAILABLE` (503). Runtime failure codes distinguish authentication, rate limiting, unavailability, protocol/output errors, invalid/denied tools, deadline, output bound and child loss. Messages come from a fixed safe allowlist; upstream bodies, stack traces and keys are not returned.

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
