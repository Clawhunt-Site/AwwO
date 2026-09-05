# superclaw-adapter-imagegen

External adapter plugin for the SuperClaw (Paperclip) server: an image-generation
agent runtime (`imagegen_local`) backed by the RunningHub OpenAPI (ComfyUI
workflows).

On each wake it:

1. Takes the latest USER comment from the wake payload as the prompt
   (falling back to issue title + description).
2. Creates a RunningHub task — `POST /task/openapi/create` with
   `{apiKey, workflowId, nodeInfoList}` for plain-digit workflow ids, or
   `POST /task/openapi/ai-app/run` with `{webappId, apiKey, nodeInfoList}`
   for `app:<digits>` ids. The prompt rides `nodeInfoList` into the configured
   prompt node (`promptNodeId`, default `6`; `promptField`, default `text`).
3. Polls `POST /task/openapi/status` every 3s until `SUCCESS`/`FAILED` or the
   deadline (`timeoutSec`, default 300); on deadline it best-effort cancels the
   task and returns `timedOut: true`.
4. Fetches `POST /task/openapi/outputs` (short retry on 804/813; 805 is a
   terminal failure), downloads every `fileUrl`, and writes the files to
   `imagegen/{runId}-{n}.{fileType}` inside the execution workspace.
5. Uploads each file as an issue attachment
   (`POST /api/companies/{companyId}/issues/{issueId}/attachments`), creates an
   artifact work product (`POST /api/issues/{issueId}/work-products` with
   `type: "artifact"`, `provider: "paperclip"`, `metadata.attachmentId`), and
   posts a final issue comment listing the images and the prompt node used.

Fail-closed: a missing `RUNNINGHUB_API_KEY` (neither the per-agent env secret
binding nor the instance environment variable) fails both `testEnvironment()`
(error-level check; warn-level when only the instance env provides it) and
`execute()` (exit 1). A missing workflow id also fails closed with
instructions. The API key is sent only in RunningHub request bodies and is
never logged. Download/upload failures are never swallowed — they are
reported in `errorMessage`, `summary`, and `resultJson.uploadErrors`.

## Workflow selection (the model field)

The agent's `model` field carries the RunningHub id — the model combo accepts
free text:

- plain digits → `workflowId` (create endpoint)
- `app:<digits>` → `webappId` (ai-app/run endpoint)
- empty/unparseable → fallback: `config.workflowId` → instance env
  `RUNNINGHUB_WORKFLOW_ID` → fail-closed with instructions

When `RUNNINGHUB_WORKFLOW_ID` is set at adapter load time, the model dropdown
shows it as `默认工作流 <id>`; otherwise it shows a placeholder entry telling
the user to type the numeric id (the placeholder itself is not a usable id and
is treated as "no selection").

## Config

- `env.RUNNINGHUB_API_KEY` (per-agent secret binding — preferred; instance env
  `RUNNINGHUB_API_KEY` is the fallback)
- `model` / `workflowId` (RunningHub workflow id or `app:<webappId>`)
- `promptNodeId` (default: instance env `RUNNINGHUB_PROMPT_NODE_ID`, then `6`)
- `promptField` (default `text`)
- `timeoutSec` (default 300 — total create+poll+download deadline)
- `pollIntervalMs` (default 3000)
- `cwd` (optional fallback working directory; the workspace projection wins)
- `apiUrl` (optional Paperclip API base override)
- `runninghubApiBase` (default `https://www.runninghub.cn`)

## Build

```sh
npm install
npm run build
```

`@paperclipai/adapter-utils` is consumed as a `file:` link to
`../../server/packages/adapter-utils` and is used for **types only** — the
in-repo package ships TypeScript source (no dist), so this plugin imports no
runtime values from it and its compiled `dist/` runs under plain Node.

## Test

```sh
npm test
```

Runs `npm run build` then `node --test "tests/*.test.mjs"` — pure unit tests with a mocked
global `fetch` (no real subprocesses, no network).

## Install into Paperclip (manual, not done by this repo)

Register via the adapters API with `localPath` pointing at this directory, or
add an entry to `~/.paperclip/adapter-plugins.json`. This package deliberately
does not touch any adapter-plugins.json itself.
