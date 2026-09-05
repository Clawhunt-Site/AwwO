# AwwO AI canvas planning

The gateway hosts a planning-only Codex CLI provider, independent of the Node upstream server. It does not create issues, hire Agents, dispatch conversations, execute canvas nodes, or write canvas documents. The browser provides the current protocol, templates, graph and conversation context, then validates the returned proposal against the current document before applying one undoable change.

## API

Both routes require a loopback socket peer and the existing `x-superclaw-gateway-token`. The web Vite `/gateway-api` proxy injects that token on the server; do not expose it in browser configuration.

- `GET /api/canvas/planner` returns `{ available, provider, error? }`. Availability means that the configured provider is enabled and its executable can be resolved. It does not spend tokens or claim that authentication, quota or the selected model has been verified.
- `POST /api/canvas/plan` accepts only `{ prompt: string, context: string }` and returns `{ plan: object, provider: "codex" }`. Prompt is limited to 8,000 characters, context to 120,000 characters, and the encoded HTTP body to 200 KiB. Multibyte text may reach the byte limit sooner.

The provider accepts only a completed final JSON message containing `version: 1`, a string summary and an operations array of at most 100 items. The frontend's `canvasPlan.ts` remains the authoritative operation whitelist and graph validator. Invalid output fails explicitly; no deterministic plan is substituted. `/api/missions/plan` remains a separate deterministic company-matching feature.

Only one planning request runs at once per gateway. A second request receives 429. Browser disconnects cancel the child process tree; the configured timeout also terminates the process tree and returns 504. CLI diagnostics, environment values and filesystem paths are not returned in errors.

## Configuration

All three environments use the same schema in `apps/gateway/.env.example`:

| Setting | Development | Staging / production |
| --- | --- | --- |
| `APP_ENV` | `development` (default) | Set explicitly to `staging` or `production` |
| `SUPERCLAW_CANVAS_PLANNER_PROVIDER` | Empty defaults to `codex` | Empty defaults to `disabled`; explicit `codex` enables the configured host |
| `SUPERCLAW_CANVAS_PLANNER_CLI_PATH` | `codex` via PATH by default | Host-managed executable path when explicitly enabled |
| `SUPERCLAW_CANVAS_PLANNER_MODEL` | Empty uses CLI default | Same; optional server-side model ID |
| `SUPERCLAW_CANVAS_PLANNER_TIMEOUT_MS` | `120000` | Same; valid range 1000–300000 |

The gateway does not load this example as a dotenv file. Supply environment variables through the existing launcher or shell. Model and CLI options cannot be supplied by HTTP clients. Existing Codex authentication is reused without reading or copying credentials into the app.

Each invocation uses an isolated temporary working directory, stdin for the request, `--ephemeral`, `--ignore-user-config`, and the read-only sandbox. Shell, apps, plugins, multi-agent delegation, browser/computer use, images, memories, hooks, workspace dependency tools, goals and web search are disabled. User execution rules are not ignored, and permission bypass flags are never passed. CLI versions that reject the required isolation flags fail instead of retrying with weaker options. Native executables and recognized npm Codex wrappers are resolved without a shell; arbitrary `.cmd`/`.ps1` scripts are not evaluated.

## Local start

Install the gateway's locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund` from `apps/gateway`. Set `APP_ENV=development`, `SUPERCLAW_GATEWAY_PORT=8796`, and `SUPERCLAW_GATEWAY_AUTOMATION_FILE` to a new isolated local store for this preview. The latter keeps the gateway's separate automation ticker away from existing schedules.

From `apps/gateway`, run:

```text
node node_modules/tsx/dist/cli.mjs src/index.ts
```

The explicit Node entry avoids Windows shim-launch issues. `/gateway-id` proves gateway readiness without requiring upstream on port 3100. The frontend at its configured development port calls `/gateway-api/canvas/planner` and `/gateway-api/canvas/plan`; it needs no Python service. Real node execution still requires the separate Node upstream and configured Agents.

Validation: `npm test -- src/canvas src/__tests__/health.test.ts` and `npm run build`. A successful actual planning call, separate from executable detection and mock tests, is needed to verify the host's CLI login/model service.
