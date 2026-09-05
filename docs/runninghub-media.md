# RunningHub Media Integration

SuperClaw exposes governed image and video generation through RunningHub without
persisting API keys in repo files or evidence artifacts.

## Environment

Set one or more keys in the runtime environment:

```bash
SUPERCLAW_RUNNINGHUB_API_KEYS=key_one,key_two,key_three
SUPERCLAW_RUNNINGHUB_BASE_URL=https://www.runninghub.ai
```

`SUPERCLAW_RUNNINGHUB_API_KEYS` is secret-only runtime config. It is visible to
SuperClaw status as `set`/`unset` and key count only.

## Templates

The built-in template ids map to the RunningHub API detail/SKU ids requested for
this integration. These ids are not legacy `webappId` values; SuperClaw resolves
them as RunningHub standard API calls:

| SuperClaw template | RunningHub API detail id | RunningHub endpoint | Defaults |
| --- | --- | --- | --- |
| `text_to_image` | `2004543847939751938` | `/openapi/v2/rhart-image-n-pro/text-to-image` | `aspectRatio=9:16`, `resolution=1k` |
| `image_to_image` | `2004543527918551041` | `/openapi/v2/rhart-image-n-pro/edit` | `aspectRatio=3:4`, `resolution=1k` |
| `image_to_video` | `2012067220412493826` | `/openapi/v2/rhart-video-s-official/image-to-video-pro` | `resolution=720p`, `duration=4` |
| `text_to_video` | `2012065966164602881` | `/openapi/v2/rhart-video-s-official/text-to-video-pro` | `size=720x1280`, `duration=12` |

Standard API templates build request JSON from logical inputs:

- `prompt` maps to `prompt`.
- `source_image` maps to `imageUrls` for `image_to_image`.
- `source_image` maps to `imageUrl` for `image_to_video`.
- `Inputs JSON` / `--input-json` can override provider fields such as
  `aspectRatio`, `resolution`, `duration`, or `size`.

Legacy RunningHub WebApp/Workflow templates still use `nodeInfoList`. Configure
those reusable node ids through `SUPERCLAW_RUNNINGHUB_MEDIA_TEMPLATES_JSON`.

Example legacy override:

```json
{
  "text_to_image": {
    "field_map": {
      "prompt": {
        "nodeId": "6",
        "nodeName": "Prompt",
        "fieldName": "text",
        "fieldType": "STRING"
      }
    }
  }
}
```

## CLI

Validate the local template/key contract without printing keys:

```bash
superclaw media doctor --json
```

Validate the four built-in API detail/SKU ids against RunningHub's current
read-only SKU metadata without submitting a generation task or consuming
generation credits:

```bash
superclaw media doctor --live-metadata --json
```

Dry-run without calling RunningHub:

```bash
superclaw media generate text_to_image --prompt "studio product photo" --dry-run --json
```

Attach the generated artifact to an existing run EvidenceBundle:

```bash
superclaw media generate text_to_image --prompt "studio product photo" --dry-run --run-id run_abc123 --json
```

When `--run-id` is present, SuperClaw writes the sanitized media artifact under
that run's artifact root, appends an `ArtifactRef` to the EvidenceBundle, emits
`artifact.added` plus a `media.*.recorded` event, and returns a
`run_artifact_url` such as `/api/runs/{run_id}/artifacts/{artifact_id}`.
Explicit `--artifact-dir` values must stay inside the selected run artifact
root.

Upload a local input image/video and use the returned `file_name` as a node
`fieldValue`:

```bash
superclaw media upload ./input.png --json
```

Live submit with node info copied from RunningHub:

```bash
superclaw media generate text_to_image --prompt "studio product photo" --input-json '{"aspectRatio":"1:1","resolution":"2k"}' --json
```

Run a full task chain in one command. `render` submits the task and, for live
requests, polls status and outputs until result URLs are available or the poll
budget is exhausted:

```bash
superclaw media render text_to_image --prompt "studio product photo" --input-json '{"aspectRatio":"1:1"}' --run-id run_abc123 --json
```

The render response includes `steps` for `generate`, `status`, and `outputs`,
an `artifacts` summary, final `status`, and extracted `output_urls`. When a
`run_id` is supplied, every step artifact is attached to the run EvidenceBundle
with its own protected `run_artifact_url`.

Query task outputs after RunningHub returns a `task_id`:

```bash
superclaw media task-status 1904152026220003329 --json
superclaw media outputs 1904152026220003329 --json
```

Use `--mode webapp` only for older `task/openapi/ai-app` task ids:

```bash
superclaw media outputs 1904152026220003329 --mode webapp --json
```

## Workbench

The Fusion Shell includes a `Media Studio` tab for the same governed path. The
workbench can:

- choose any built-in RunningHub template;
- run a protected dry-run by default;
- switch to live standard API submission when runtime keys are present;
- attach generated, status, or output-query artifacts to the selected run;
- run a one-click `Generate and wait` chain that records generate/status/outputs
  artifacts together;
- refresh the run EvidenceBundle immediately after media actions;
- download the latest sanitized media artifact through the protected run
  artifact endpoint when a run is selected.

`Inputs JSON` accepts provider field overrides such as `{"duration":"8"}`. The
`nodeInfoList JSON` field is retained for legacy WebApp/Workflow templates and
accepts the same array passed to `superclaw media generate --node-json`.

## API

- `GET /api/media/status`
- `GET /api/media/templates`
- `GET /api/media/doctor`
- `POST /api/media/generate`
- `POST /api/media/render`
- `POST /api/media/upload`
- `POST /api/media/task-status`
- `POST /api/media/outputs`
- `GET /api/media/artifacts/{artifact_id}`

`POST /api/media/generate` writes a sanitized artifact for both dry-run and live
submissions. The artifact includes template id, endpoint, redacted request,
redacted response, key count, selected rotation index, and any RunningHub task id
returned by the provider.

`GET /api/media/doctor?live_metadata=true` returns the same operator-safe doctor
payload as the CLI. With `live_metadata=true`, it checks RunningHub SKU detail
metadata only; it never submits image/video generation tasks and never includes
API key values in the response.

`POST /api/media/generate`, `POST /api/media/upload`,
`POST /api/media/task-status`, and `POST /api/media/outputs` accept optional
`run_id` and `artifact_dir` fields. If `run_id` is supplied, the artifact is
attached to that run's EvidenceBundle and the response includes
`evidence_attached=true` plus `run_artifact_url`. If `artifact_dir` is supplied
with `run_id`, it must resolve inside the run artifact root.

`POST /api/media/outputs` also extracts provider file fields such as `fileUrl`
or standard API `results[].url` into an `output_urls` array so the workbench can
display image/video result links without parsing the raw RunningHub response.

`POST /api/media/render` accepts the same generation body plus
`wait_for_outputs`, `max_polls`, `poll_interval_seconds`, and
`query_timeout_seconds`. It returns a single render summary while preserving
each underlying provider artifact as a separate downloadable evidence item.
