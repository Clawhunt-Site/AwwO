# AwwO video analysis worker

An internal service that tells, shot by shot, how a reference video was made: filmed, generated, rendered in 3D or
code, screen-recorded or a still; what was laid over it (subtitles with their timings and style, titles, stickers);
how its sound was made (voice and music stems, tempo, effects); and how a same-structure remake would be split into
generation units. It runs [rea-video](https://github.com/JuneYaooo/rea-video) (Apache-2.0) unmodified, as a separate
program, on one video at a time. No model runs and no provider is paid: the analysis is deterministic and offline.

Status: the worker and its tests. The API's analysis node, its web tile and the worker's image are the next steps in
`docs/reference-video-remake-design.md`; nothing calls this service yet.

## API

All routes except `/health` need `Authorization: Bearer <AWWO_ANALYSIS_TOKEN>`. Errors are
`{"error": {"code", "message", …}}`. The protocol follows the render worker's edit jobs (`apps/render-worker`), so the
API's client for this worker can be the edit worker's (`backend/internal/app/edit_worker.go`) with other paths.

| Route | Answer |
|---|---|
| `GET /health` | 200 when ready, else 503: `{ready, service:"awwo-video-analysis", version:1, rea, ffmpeg, models, limits:{maxInputBytes, maxSeconds, maxSide, timeoutMs}, busy}` |
| `POST /internal/analyses` | JSON manifest (at most 64 KiB) → 201 `{analysisId, expiresInSeconds}`; 400 `INVALID_ANALYSIS` + `field`; 429 `WORKER_BUSY`; 503 `ANALYSIS_UNAVAILABLE` |
| `PUT /internal/analyses/{id}/file` | `application/octet-stream`, the video's bytes, streamed to disk → 204; 400 `ANALYSIS_FILE_MISMATCH` (size or sha256; it may be sent again) or `ANALYSIS_FILE_UNSUPPORTED`; 409 when already received |
| `POST /internal/analyses/{id}/run` | probes and analyses it → 200 `{analysisId, report, summary, outputs}`; 400 `INVALID_ANALYSIS` on `file` (`too_long`, `too_large`, `no_video`, `probe_failed`); 409 `ANALYSIS_FILE_MISSING`; 422 `ANALYSIS_FAILED` + `detail` (`analysis_failed`, `timeout`, `aborted`, `output_too_large`); a caller that disconnects stops it |
| `GET /internal/analyses/{id}/outputs/{name}` | one output; `name` is one listed in `outputs` (`breakdown.json`, `shots/shot_001.jpg`, …) |
| `DELETE /internal/analyses/{id}` | stops and removes the job (204); a job left without a request for `AWWO_ANALYSIS_IDLE_MS` is removed too |

Manifest:

```json
{"analysisId": "…", "file": {"name": "reference.mp4", "size": 12345678, "sha256": "…"},
 "options": {"lang": "zh", "ocr": true, "ocrLang": "zh", "packaging": true, "stems": false, "review": true}}
```

- `analysisId` `^[A-Za-z0-9_-]{8,80}$`; `file.name` is a display name only (the worker stores the video as
  `input.<ext>`); `file.size` 1 … `AWWO_ANALYSIS_MAX_INPUT_MB`; the container is sniffed from the bytes: MP4, MOV,
  M4V, WebM, MKV, AVI, FLV or WMV.
- `lang` `zh` or `en` is the language of the report and summary. `ocr` reads subtitles and on-screen text;
  `ocrLang` `ja` reads Japanese ones (its model is not in the image yet: see Image). `packaging` reads the subtitle
  timeline, titles and stickers (about half the analysis time); `stems` returns `stems/original.wav`,
  `stems/vocals.wav` and `stems/music.wav` (about 10 MB a minute each); `review` writes `review_tasks.json` and
  `review_answers.json`, the per-shot questions an agent that can see images answers to correct the verdicts.

Reply 200: `report` is the public part of `breakdown.json` (`schema`, `tool`, `lang`, `video` {seconds, width,
height, fps, aspect, sound}, `verdict`, `shots`, `confidence`, `averageShotSeconds`, `production`, `vlm`: "off",
`warnings`), `summary` the compact text rea-video's `summary` prints (at most 64 KiB, what a downstream node reads),
and `outputs` `[{name, kind, contentType, size, sha256}]`: `breakdown.json`, `summary.txt`, `report.html`,
`report.md`, `storyboard.jpg`, `audio.png`, `review_tasks.json`, `review_answers.json`, `shots/*.jpg` (per-shot
sheets, first and last frames), `packaging/*` (`subtitles.srt`, `overlays.ass`, `timeline.json`, sticker frames)
and, when asked, `stems/*.wav`. Nothing else the analysis writes is served.

## Configuration

| Variable | Default | |
|---|---|---|
| `AWWO_ANALYSIS_LISTEN` | `127.0.0.1:8121` | `host:port` (`[::1]:port` for IPv6) |
| `AWWO_ANALYSIS_TOKEN` | — | Shared bearer token; shorter than 32 characters = not ready |
| `AWWO_ANALYSIS_REA` | `rea-video` | rea-video's executable: a path, or a name on the children's PATH |
| `AWWO_ANALYSIS_FFPROBE` | `ffprobe` | ffprobe, likewise; `ffmpeg` must be on the children's PATH too |
| `AWWO_ANALYSIS_PATH` | `/usr/local/bin:/usr/bin:/bin` | The children's PATH |
| `AWWO_ANALYSIS_MODELS` | — | Absolute, read-only directory with the models `MODEL_FILES` (config.mjs) pins by sha256; required for ready |
| `AWWO_ANALYSIS_TMP` | `os.tmpdir()` | Root of each job's own directory |
| `AWWO_ANALYSIS_MAX_INPUT_MB` | `512` | Largest video, 1–8192 |
| `AWWO_ANALYSIS_MAX_SECONDS` | `300` | Longest video, 1–3600 |
| `AWWO_ANALYSIS_MAX_SIDE` | `4096` | Largest picture side, 64–8192 |
| `AWWO_ANALYSIS_TIMEOUT_MS` | `1800000` | Whole-analysis limit, 60,000–14,400,000 |
| `AWWO_ANALYSIS_IDLE_MS` | `600000` | How long a job may sit without a request, 1,000–3,600,000 |
| `AWWO_ANALYSIS_THREADS` | CPUs, at most 8 | Threads the numeric libraries may use, 1–64 |

A malformed value stops the worker at startup. The models are hashed once at startup.

## Cost, measured

On an Apple M4 (10 cores), a 19 s, 480x854, 24 fps clip with 10 shots: `decompose` alone took 41.6 s and 128 CPU
seconds, with a peak of 2.3 GB of memory and 14 MB of outputs (9.6 MB of them stems); reading the subtitle and
packaging layer was 23 s of the 40. Through this worker (decompose, summary and review) the same clip took 140 s on
that machine with less than 4 GB of memory free. Plan for about 7 CPU seconds per second of 480p video, more for
1080p, and at least 4 GB of memory per worker: the workspace sandbox (1 CPU, 1 GiB, 30 s per command, 2 MiB inputs)
cannot run it.

## Security model

- **Its own program, no shell**: rea-video and ffprobe run with an argument list, never a command line, in a process
  group of their own; a timeout, an abort or their exit stops the whole group.
- **Allowlisted environment**: `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, three Python switches, the thread counts,
  `REA_VIDEO_MODELS` and `REA_VIDEO_HOME`. `HOME` and `REA_VIDEO_HOME` are inside the job's directory, so rea-video's
  memory of corrections and preferences never carries from one workspace's video to another's. No `REA_VLM_*`
  setting, provider key or the worker's token reaches a child.
- **No network**: run the container with `--network=none`. rea-video downloads its models when they are missing;
  with them baked into `AWWO_ANALYSIS_MODELS` and checked at startup, it never needs to.
- **No paths out**: every text output (and the summary) is rewritten without the job's directory: an output's path
  becomes its output name, the input `input.<ext>`. Errors carry the worker's own words; rea-video's stderr goes to
  the worker's log only.
- **One job at a time**, bounded by `AWWO_ANALYSIS_TIMEOUT_MS`; each job's directory (and only it) is removed when the
  job is deleted or idle; at startup, what a stopped worker left is removed.

## Image (next step)

The image is not written yet. It needs: Python 3.11 with rea-video at commit
`b32fbbdb074adbd72f54505114ed8600366cdaa5` and its dependencies hash-pinned (numpy, opencv-python-headless, Pillow,
PyYAML, onnxruntime, and rapidocr-onnxruntime installed without its `opencv-python`, which would take the same `cv2`
directory as the headless build); ffmpeg and ffprobe; Node 22 for this service; the two models of `MODEL_FILES`
fetched and checked by sha256 at build time into a read-only directory (plus the Japanese OCR model rea-video pins,
when `ocrLang: "ja"` is to work offline); a non-root user and a read-only root filesystem. The stem separation model
comes from a repository that declares no license: confirm its terms before a commercial deployment, or replace it.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install "rea-video[ocr] @ git+https://github.com/JuneYaooo/rea-video@b32fbbdb074adbd72f54505114ed8600366cdaa5"
# the OCR extra brings opencv-python, which shares the cv2 directory with the headless build: put the headless one back
.venv/bin/pip uninstall -y opencv-python && .venv/bin/pip install --force-reinstall --no-deps "opencv-python-headless>=4.8,<5"
AWWO_ANALYSIS_TOKEN=<32+ characters> AWWO_ANALYSIS_REA="$PWD/.venv/bin/rea-video" \
AWWO_ANALYSIS_MODELS=<directory with the two models> AWWO_ANALYSIS_PATH="/opt/homebrew/bin:/usr/bin:/bin" \
npm start
```

## Tests

```bash
npm test     # unit and HTTP tests against fakes of rea-video and ffprobe (fixtures/); no Python or ffmpeg needed
AWWO_ANALYSIS_TEST_REA=<rea-video> AWWO_ANALYSIS_TEST_MODELS=<models> AWWO_ANALYSIS_TEST_VIDEO=<short video> \
AWWO_ANALYSIS_TEST_PATH=<PATH with ffmpeg and ffprobe> node --test integration.test.mjs
```

The integration test sends a real video through the real server and checks the report, the outputs, their sha256
and that no text output names the worker's disk.
