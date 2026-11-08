# Reference videos on the canvas: analysis, same-structure remakes and cutaway films (design)

Status: 2026-11-08. The skills and the analysis worker below have landed; the analysis node, its web tile, the
worker's image and the later phases have not. Owner request: 「这些我们全部都已经项目合作了，按照你觉得最合适的往下落地吧」,
about four projects: rea-video, hypit, video-clone-lite and cutaway.

## What each project brings

| Project | What it does | License | How AwwO uses it |
| --- | --- | --- | --- |
| [rea-video](https://github.com/JuneYaooo/rea-video) (`b32fbbdb`) | Watches a video and says, per shot, whether it was filmed, generated, rendered in 3D or code, screen-recorded or a still, with evidence; reads subtitles and overlays with their timings; splits voice and music; plans a remake by model limits | Apache-2.0 | Runs unmodified in `apps/video-analysis-worker`; its method is adapted in the `video-breakdown` (v2) and `video-remake` skills |
| [hypit](https://github.com/hypit-ai/hypit) (`2d31e887`) | Turns a reference video into a word-anchored workflow and renders variants | Apache-2.0 with conditions: running it in a multi-tenant service or supplying it to third parties needs Hypit.AI's written authorization | Ideas only (timing tied to words, variants that change one thing): `video-remake` |
| [video-clone-lite](https://github.com/liangdabiao/video-clone-lite) (`925a61f0`) | One plan file, references before clips, shot-by-shot generation, ffmpeg assembly, a price before every paid call | none declared | Ideas only: `video-remake` |
| [cutaway](https://github.com/Nyxera0x/cutaway) (`5d8f1c6e`) | One picture into a three.js object that takes itself apart, graded against the picture before it is filmed | MIT | Its method is adapted in the `cutaway` skill |

No text or code of hypit or video-clone-lite is copied. Running hypit itself inside AwwO would need Hypit.AI's
written authorization first, whatever the partnership covers otherwise.

## Measurements behind the decisions

- **rea-video** on a 19 s, 480x854, 24 fps clip (10 shots), Apple M4: 41.6 s, 128 CPU seconds, 2.3 GB peak memory,
  14 MB of outputs (9.6 MB stems); the subtitle and overlay layer is 23 s of the 40. Through the worker with summary
  and review: 140 s with under 4 GB free.
- **The workspace sandbox** gives a command 1 CPU, 1 GiB, 30 s (120 s with the web), takes inputs of at most 2 MiB a
  file and publishes files of at most 2 MiB; its image has no ffmpeg. The Blender workstation has 8 CPUs, 8 GiB and
  600 s commands, but its inputs arrive by the same path, at most 2 MiB a file. A reference video fits neither.
- **cutaway** at 1920x1080 (about 260 small parts, clearcoat, glass, bloom): about 0.1 s a frame on the M4's GPU and
  about 8.9 s a frame on SwiftShader, with 50 s before the page was ready. The render worker launches Chromium with
  `--use-angle=swiftshader` (`apps/render-worker/render.mjs`), so a 10 s, 60 fps cutaway film would take about
  90 minutes there, against the API's 8-minute wait. Its score (pure Python, 10 s) took 4.5 s on one CPU.
- The edit node writes subtitles as a separate `.srt` and composites nothing over clips; a timeline can already tie a
  sound or a subtitle to a video item by `anchor` and `offset`.

## Decisions

1. **The analysis runs on its own worker**, as edits run on the render worker: the API streams the stored upload to
   it, it runs rea-video with no network and no provider key, and its files become canvas artifacts. Not in the
   sandbox (too small) and not in the render worker (one job at a time there; an analysis would hold renders and
   edits for minutes and needs 2–3 GB).
2. **No model in the analysis by default.** It is free and deterministic. Vision comes from the canvas: an agent
   node that can see images answers rea-video's `review_tasks.json` from the shot sheets. A VLM pass through the
   user's own connection is a later, opt-in phase.
3. **Remakes use AwwO's own nodes** (image, video, speech, music, rendered pages, the edit node), not capsule-cinema
   or hypit's runtime: one billing, admission and credential path, and no license question.
4. **Cutaway delivers the page now.** It runs on the viewer's GPU in the canvas preview. Its film needs a GPU render
   path; until then the skill tells the agent to keep films short and within a frame budget, or to say the film needs
   a GPU render.

## Landed on 2026-11-08

- `backend/internal/app/skills/video-breakdown.md` version 2, `video-remake.md`, `cutaway.md`; their licenses in
  `third_party/adapted/rea-video/` and `third_party/adapted/cutaway/`, `scripts/build-skill-licences.mjs` and
  `apps/web/src/saas/skillLicences.txt`; `THIRD_PARTY_NOTICES.md`.
- `apps/video-analysis-worker`: the service, its tests against fakes, and an integration test that passed against
  rea-video `b32fbbdb` on the clip above (`npm run test:saas:video-analysis`).

## Next phases

**A. The analysis node** (kind `analyze`, 「视频拆解」). Inputs: one video, either an upload of this canvas named in the
node's own settings (form nodes deliver text only, and media references take only pictures today) or a wired video
or edit node's result. Output port `result`, text: rea-video's summary plus the public report as JSON, and the
worker's files as artifacts (report, storyboard, shot sheets, subtitles, review tasks; stems when asked). Mirror the
edit node: `analyses.go`, `analysis_worker.go` (the edit worker's client with other paths), `analysis_outputs.go`, a
migration for analysis jobs, `graph_contracts.go` ports, `AWWO_ANALYSIS_URL` and `AWWO_ANALYSIS_TOKEN` in the config
and `.env.example`, a daily allowance per workspace, a cache by the video's sha256 and the rea-video version, and the
operator's deletion plan. Web: the node in `canvasDoc.ts`, `SessionTile.tsx`, `InspectorPanel.tsx`, `TilePorts.tsx`,
`CanvasResults.tsx` and `i18n.tsx`. Deploy: the worker's image (README, "Image") and a compose service with
`--network=none`, 2–4 CPUs and 4 GB. For scale: the edit node's first API commit was 19 files and 2,064 lines.

**B. Review on the canvas.** Shot sheets reach an image-capable agent node as pictures; it answers the review tasks,
and a second worker call merges them (`rea-video apply-review`) into a corrected breakdown and report.

**C. 「做同款」 in the canvas assistant.** A request with a reference video plans: analysis → a planning agent with
`video-breakdown` and `video-remake` → image nodes for the locked references → one video node per generation unit →
speech and music nodes → an edit node whose timeline anchors sounds and subtitles to their shots. The analysis's first
and last frames become reference pictures (`media_refs.go` learns this canvas's analysis pictures).

**D. Vision through the user's own connection** (opt-in, paid): a job-scoped OpenAI-compatible completion endpoint on
the API, on the pattern of the OpenMaus task bearer (`computer_model_proxy.go`), set as rea-video's `REA_VLM_BASE_URL`,
admitted and billed per call.

**E. The packaging layer in the edit node:** burned-in styled subtitles (rea-video's `overlays.ass`, through libass)
and an overlay track of transparent rendered pages over clips, so 花字, labels and stickers can be put back.

**F. A GPU render path:** the render worker on a GPU host with ANGLE on the GPU (as the Blender workstation's
`DOCKER_CONTEXT` reaches a GPU host), or the local edition's render service on the user's own GPU.

## Risks and open items

- The stem separation model rea-video pins (`UVR-MDX-NET-Inst_HQ_3.onnx`) comes from a repository that declares no
  license; confirm its terms before a commercial deployment or swap the separator.
- rea-video is young (created 2026-10-29, version 0.1.0, changing daily): pin a commit and test the breakdown's
  schema (`rea_video.breakdown.v1`) before each upgrade.
- Accuracy on platform downloads: rea-video's own evaluation reports 98–99% by running time on original files with
  tools only, 88.6% on re-encoded files, and 46% on two Douyin sales videos, which reach 97.5% after an agent's visual
  review. Most uploads will be platform downloads, so Phase B matters, and the node must show confidence and
  "unconfirmed" openly.
- Rights: the skills keep structure and technique and never reuse words, music, characters or likeness; generated
  media is marked where platforms require it.
