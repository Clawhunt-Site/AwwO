# AWWO Pi worker

Internal Node service for the Go SaaS backend. Every request runs the real Pi SDK in a separate child process and temporary directory. It supports text conversations, server-owned agent instructions, and streaming responses. This first version deliberately exposes no tools, file access, shell execution, tenant extensions, arbitrary code, or runtime configuration in requests.

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
| `AWWO_PI_TIMEOUT_MS` | `120000`; includes worker startup and the full request |
| `AWWO_PI_CANCEL_GRACE_MS` | `2000`; terminate the owned child after this grace period |
| `AWWO_PI_MAX_CONCURRENCY` | `4`; excess requests get HTTP 429 |
| `AWWO_PI_MAX_OUTPUT_BYTES` | `1048576`; bounded streamed response size |
| `AWWO_PI_CONTEXT_WINDOW` / `AWWO_PI_MAX_TOKENS` | Application limits `32768` / `4096`; adjust for the selected model |

OpenAI-compatible providers use the chat completions protocol. Anthropic uses the messages protocol. Ollama uses its `/v1` compatibility endpoint. Provider compatibility and access to a particular model require a separate live acceptance check. Reasoning, images, tools, and provider-specific options are not part of this initial API. No mock mode exists in the production entrypoint.

## Internal contract

`GET /health` requires no authentication and returns configuration readiness without secrets. HTTP 200 means required configuration is present; it does not prove provider connectivity. Missing configuration returns HTTP 503 with `ready: false`. The response always includes `modelConnectivityVerified: false`.

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
  "systemPrompt": "Optional instructions from the authorized saved agent"
}
```

`messages` contains completed historical messages only, excluding the current `prompt`. Go must check tenant/session/agent ownership before constructing this request. IDs accept ASCII letters, digits, `_`, and `-`, up to 128 characters. Only the documented fields are accepted. `systemPrompt` is plain text; it never names a file. The adapter derives a Pi session identifier from both tenant and session IDs.

Transport limits are 128000 characters for `prompt`, 32768 characters for `systemPrompt` and each history message, at most 100 history messages, 262144 characters across all text, and a 1 MiB HTTP body. Character limits count JavaScript UTF-16 code units: an emoji outside the basic multilingual plane counts as two. Go applies the stricter 128000-byte planner prompt limit. These transport limits are separate from model capacity: before starting a worker, the service uses a conservative UTF-8 byte admission budget of `contextWindow - maxTokens - 256`, including 32 additional bytes per input/history message. It returns HTTP 413 / `CONTEXT_LIMIT` if the text does not fit, without trimming content or calling the model. This guard is not a provider-tokenizer measurement. The default 32768-token context therefore cannot accept the largest transported planner prompt; configure a larger context only when the actual model supports it. `/health.limits` exposes the active bounds. No frontend or tenant request can increase them.

Accepted requests return HTTP 200 with `text/event-stream`. Each SSE frame contains exactly one JSON object in its `data:` line:

```text
data: {"type":"text_delta","delta":"Hello"}

data: {"type":"completed","text":"Hello"}

```

The final event is exactly one of `completed`, `failed` (`code`, `message`), or `cancelled`. Heartbeats are SSE comments. Provider errors, internal paths, and credentials are excluded from error responses. Duplicate active run IDs or another active run in the same tenant/session return HTTP 409. Runtime configuration missing before streaming returns HTTP 503. Malformed input returns HTTP 400; wrong content type 415; internal authentication failure 401.

`DELETE /internal/runs/{runId}` requests cancellation and returns HTTP 202; an unknown run returns 404. A client disconnect also cancels that run. Cancellation clears Pi's queues and aborts the model request; the supervisor forcibly stops the child if needed. It deletes the temporary directory only after child exit. Final SSE events are published after the child stops, cleanup finishes, and the session/concurrency reservation is released, so the next turn may start immediately without overlapping child processes. A child that hangs after reporting its result is forcibly stopped within the configured cancellation grace period before that result is delivered.

HTTP 409 / `RUN_BUSY` means this run ID is already active; do not resubmit it. HTTP 409 / `SESSION_BUSY` means another run still reserves the session and this submitted run was never accepted. The Go caller may retry that specific rejection with a bounded wait and the same run ID/body, for example while a previously cancelled run finishes cleanup. No other error implies that retry is safe.

## State and isolation

Go owns all durable history and run records. Workers create memory-only Pi sessions from the authorized text history and do not reuse processes across requests. This adapter has no durable event replay or crash resumption; Go must mark an interrupted stream as failed/interrupted, preserve completed history, and avoid automatically repeating a possibly accepted request. Automatic provider retries and automatic compaction are disabled; an overlong conversation fails rather than silently discarding history. The adapter does not claim billing usage from reconstructed history.

Each child receives an explicit environment without host provider credentials, `HOME`, `NODE_OPTIONS`, or proxy secrets. `PI_CODING_AGENT_DIR` points inside its private temporary directory. Model runtime credentials and settings live in memory; `modelsPath: null` prevents global model file discovery. Extension, skill, prompt-template, theme, and context-file loading are disabled. Pi's outgoing system prompt is restricted to the configured application prompt through its public `Agent.streamFunction` hook, removing the coding harness's appended local working-directory metadata.

Process separation and a tool allowlist are not an operating-system sandbox. Public deployment needs its own container/process identity, resource limits, restricted network access, TLS between hosts, secret management, and Go tenant authorization. This implementation has not been deployed or accepted against a real provider account.

## Verification scope

`npm test` uses the real Pi package and real child processes against local test HTTP providers. It verifies OpenAI/Anthropic/Ollama-compatible framing, role-based history, system instructions, authentication, unconfigured behavior, tenant process separation, tool suppression, poisoned runtime-resource rejection, redacted model failures, subprocess cancellation, timeout, temporary-directory cleanup, duplicate-run rejection, and HTTP disconnect cancellation. These fixtures are confined to tests and do not prove actual cloud credentials or an installed Ollama model.

SDK reference snapshot: [Pi 0.85.1 SDK](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md). Repository: [earendil-works/pi](https://github.com/earendil-works/pi), formerly `badlogic/pi-mono`.
