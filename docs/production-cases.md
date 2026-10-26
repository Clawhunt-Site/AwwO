# Production cases and the work-mode tutorial

The homepage's 17 production cases each have a real AwwO canvas that ran, and every case dialog shows how it was made: the canvas stage by stage, what each agent actually delivered, the run receipt, and the delivered result in a sandbox. A member can copy any of the 17 canvases with its recorded run. New accounts first go through a seven-step work-mode tutorial.

## The work-mode tutorial

`apps/web/src/saas/WorkModeTutorial.tsx`, hosted by `SaaSOnboarding.tsx`.

- **What it explains**: brief → canvas → agents → handoffs → parallel stages → run states → review and delivery. Its scenes use the real canvas behind the pixel-platformer case, and that case's recorded run for timings once a record is published. The run-state scene is labelled as an illustration of the status display.
- **Who must see it**: an account is new when the first workspace it owns was created on or after `TUTORIAL_REQUIRED_SINCE` (2026-10-03) and less than `TUTORIAL_REQUIRED_DAYS` (14) days ago. The identity carries no other per-account date. For a new account the tutorial has no close or skip control, Escape does nothing, a browser's forced close reopens it, and it returns until it is finished. Each step unlocks after its scene has played (`STEP_DWELL_MS`).
- **Everyone else** sees it once on each device and can skip it. A finished tutorial is never downgraded by a skipped replay.
- **Replay** is under More options → 「AwwO 工作模式」 / “How AwwO works”. The page-by-page spotlight tour (「使用引导」) stays available on request.
- **State** is browser-only: `awwo.workmode.v1:<user>` = `completed` | `dismissed`, and `completed` from any tab wins. The API stores no onboarding state. A new account that opens AwwO on a second device within its first 14 days is shown the tutorial again until it finishes it there. Where browser storage is unavailable, a new account is still shown it, on every page load until it has been finished there, since nothing can be remembered; anyone else is not shown it by itself. If its chunk fails to load, a new account gets a notice that reloads the page (the tutorial opens again) instead of the workspace; anyone else carries on without it.
- It never creates, runs or submits anything. Its last step can focus the home prompt box.

## The case canvases

- Every case is English in both interface languages (owner, 2026-10-14: 「中文界面也用英文案例」, 「标题和按钮也改成英文」). The cases section, its cards, the case dialog and the copy dialog render with `lang="en"` whatever the interface language; the rest of the site, the work-mode tutorial included, stays localized. Case, run-record and catalog texts are plain English strings, and `createOfficialDocument`, `createOfficialCopyDocument` and `createProductionCopyDocument` take no language: there is one canvas per case.
- `apps/web/src/saas/productionWorkflows.ts`: the 17 canvases, compiled from tasks, as `OfficialWorkflow`s, so `createOfficialDocument`, the copy dialog and the stage views work unchanged. Each card's team (`productionCatalog.ts` `stages`) is pinned to its canvas by tests.
- The knowledge-base case first ran on 2026-09-04 with a canvas of its own, in Chinese, in AwwO's local development preview (a local control plane and Codex agents), and that canvas was kept as it ran until 2026-10-14. It is now compiled from tasks like every other case and ran in English on production: upstream nodes deliver the access rules, the documents, the interface copy and a business layer as data and code, and its page pastes them into a working knowledge-base workspace on simulated data.
- Tasks are sized for Claude Opus 5.5 on the openai-agents runtime: one model call per node, a 200,000-token context and at most 32,000 output tokens, the model's own thinking included (it stays on). A node that has to think a whole piece through and also write it runs out of that call (`output_limit`), so the work is split: upstream nodes deliver data and code modules, each with its own length limit (`scene`, `code`, `sizedScene`, `sizedCode`), and the build pastes them as delivered. A 2D build writes its page itself (at most 16,000 characters); a 3D build pastes its scene modules and writes the rest (24,000, or 28,000 where the scene is split into two 7,000-character halves); the car plant's page pastes its six modules (36,000, `assembleModules`); the knowledge base's page pastes its data, copy and business layer and writes the interface (24,000, `assembleApp`).
- The four largest cases (Crystal Keep, Beat Studio, Mars mission control, Neon Circuit) build in two steps, after a one-step build ran out of its call on 2026-10-13 with about 46,000 characters of modules to put together: a wiring node reads every module and writes only the code that connects them (`wiring`), and the page node then only pastes the modules and the wiring into one HTML frame (`paste`, at most 56,000 characters). Nodes whose first runs spent their whole call thinking are told to think only a few sentences before writing.
- Neon Circuit and the EV plant run on three.js r186 (`stack: 'r186'` in their `OfficialWorkflow`, since 2026-10-14); every other case stays on r128 by its one script line. Their pages write the import map that names the pinned release (`THREE_MODULES_IMPORT_MAP`, `previewImportMap.ts`) and import three and its addons as ES modules, which AwwO's preview supplies with no network (`previewModules.ts`). An r186 page renders through an EffectComposer with bloom and a PMREM environment, and each case states its own exposure, environment strength, bloom threshold, lights and backdrop, because the right numbers depend on the scene and a model left to choose them washed both cases out: the race is a night city (exposure 0.95, bloom above 0.85, no light brighter than the kerbs near the road and no extra lamps), the plant a white diorama on a darker studio backdrop (exposure 1.0, environment 0.25, bloom above 1.4 so lit white never blooms, and no fog, which a far orthographic camera turns into an even white haze). These numbers were found by changing them in a delivered page and screenshotting it before any task changed; their records' notes name the failures of the earlier texts.
- Their tasks carry what the runs taught. Every node that writes code the build pastes must deliver code that runs as pasted (balanced brackets, nothing running on its own at the top level). Every build checks itself silently, starts with `<!DOCTYPE html>` with nothing before it, fits its frame, and never reads an object, such as an `AudioContext`, before the first user action creates it. Games with several phases name them and the keys between them (menu → countdown → play → end); feel is given as baseline numbers rather than adjectives; the 3D projection is written out; and every module has a length limit the build can hold.
- The homepage says every case ran only when every case has a published record (`summary.json`); a case's caption points to its delivery only when its record exists.
- The ad case does not make video. AwwO's agents deliver the script, storyboard, edit sheet, grade and a playable HTML animatic, and the case says so. THE LONG CHORD does: it is a film case, below. Every cover is a screen recording of what its published run delivered, played with scripted input (`recording` in `productionCatalog.ts`); a cover that is not would be labelled an illustration.
- Members copy a case's canvas through the copy dialog (`OfficialCopySetup`), and the copy carries the case's run. `productionCopy.ts` gives every node that delivered its recorded delivery as `lastOutput`, with `source: 'case'` and the run's model and date. Each node therefore shows what its agent delivered and each input what it received, labelled 「案例实录」 and never as a run of the member's workspace. The copy never starts a run. Running the whole graph replaces every recording, and rerunning one node reuses its upstream recordings. Settings, task and wire edits keep the recordings (`invalidateOutputs` treats them as references); a node's own new result clears the recordings downstream of it. When the record cannot be loaded, no canvas is created. Records carry no language field: every case is run and published in English (`publish-run.mjs` refuses a run in any other language).

## Run records

`apps/web/src/saas/production-runs/<case>.ts` (one lazy chunk per case) plus `summary.json` (what the cards show). Records are generated, never edited:

1. **Run.** Create the case's canvas with `createOfficialDocument`, initialize it, start a graph run exactly as the canvas does, wait, and keep the raw record: the frozen graph run, every node's state and output, each node run and its model invocations, and the runtime catalog. The published records ran on production, in the operator's own workspace, on the openai-agents runtime with Claude Opus 5.5 at the limits above, driven from a browser signed in as the owner (that runner is kept outside this repository). The same run on a private stack (the API and openai-agents Python worker at the production revisions, a throwaway PostgreSQL and the production limits) is
   `AWWO_SHOWCASE_EMAIL=… AWWO_SHOWCASE_PASSWORD=… node scripts/showcase/run-production-cases.mjs --api <url> --out <dir> [--cases a,b] [--model <id>]`,
   which refuses any API that is not on this machine.
2. **Check** the delivered result in a real browser, run the way AwwO's preview runs it, play it with scripted input, and write down only what was actually observed, defects included.
3. **Publish.** Run `node scripts/showcase/publish-run.mjs <raw.json> <notes.json>`. `notes.json` holds `note` (what happened in the run, failures included), `verification` (what the browser check observed) and `edition` (where it ran), all in English, plus `source` (`{ "api": "<commit>", "worker": "<commit>" }`, the revisions that ran), `thinking` (whether the model's thinking was on) and `limits` (`contextWindow`, `maxOutputTokens`, `modelCallsPerNode` and `concurrency`, the settings the run had), all required, and optionally `model`, the model name the record shows. Each node's value is read with the canvas's own contract parser. Machine paths and identifiers are redacted. The result's SHA-256 is recorded.

A published run must have used exactly the canvas text in `productionWorkflows.ts`: `publish-run.mjs` refuses any other run and stores the SHA-256 of that text (`canvasSHA256`, see `productionCanvasText.ts`), which `saas-production-runs` recomputes from the canvas a member copies. When a task changes, its case runs again. A canvas may run more than once: the record's note counts every run of the published text and says what went wrong in the ones that were not published, and names the problems of an earlier text that led to the change.

## Film cases (recorded canvases)

THE LONG CHORD, Episode I (2026-10-22; its Act I alone from 2026-10-20) is the first case that delivers a film, and the
first whose canvas is *recorded*: the run's own document, not a workflow compiled from tasks. Its canvas (image, video and
audio nodes, six editor agents and ten edit nodes, 298 nodes in all) was built and run by the operator's scripts on
production, over 93 graph runs (each after the first scoped to the nodes it named), and its texts name files by node id (an editor's brief lists
`vid_s05_04/video-1.mp4`; an act's own timeline names `edit_R1/r1.mp4`, the episode's `edit_act1/act-1.mp4`), while a
video numbers its pictures by where their nodes sit. A compiled copy, with fresh ids and its own layout, would not be the
canvas that ran. Its three acts are on one canvas because a generation reads pictures only from its own canvas and an
edit only its own canvas's files.

- **Raw record.** The operator reads the live canvas (outside the repo: every graph run with its frozen document, the run
  that made each output, each node's run and an agent's model calls, and every file those outputs name, downloaded by
  artifact id with its SHA-256 and checked against the canvas's whole artifact listing (read page by page to its end), AwwO's own SHA-256 and size of
  each file, which the read keeps beside it). It must show the film's lineage: for every wire, the output its source had
  in the document its target's run started from is the source's published output. Any gap means making that node again.
- **Publish.** `node scripts/showcase/publish-recorded-run.mjs <raw.json> <notes.json>` (the same notes as above, plus
  `footage`: the homepage excerpt's stem, start and length, and `releases`: the API releases in order, each with the
  time it went live, which name the release each media node ran on). It writes the record (`canvas: 'recorded'`; agents
  and edits in `nodes`, edits as `kind: 'edit'` with their film's facts; the media nodes in `media` with their stage and
  words), the stored canvas (`apps/web/src/saas/production-canvases/<case>.ts`: each node as frozen in the run that made
  its output, without bindings, conversations, outputs or an agent's runtime and model), its `canvasSHA256`
  (`recordedCanvasText.ts`, which covers media models, settings and words, timelines, ids and places), posters (WebP) for
  every picture and clip, the last edit's stills, its subtitles as WebVTT, and the excerpt (`showcase/<stem>.mp4`/`.jpg`,
  without sound). It refuses lineage gaps, a node whose run did not finish with its output, a wire from a node it does
  not publish, a stored file that is not the bytes the listing names, placeholder notes and any media provider's name in
  what the case says. Its gates are tested offline: `node --test scripts/showcase/publish-recorded-run.test.mjs`.
- **The film is staged, not shipped.** The web copy (1280 px, its sound copied as mixed) and the file as delivered go
  once to the host's store of earlier website files, as `showcase/staged/<case>/<sha16>.mp4` (checked by their SHA-256
  after the copy and never overwritten), which nginx serves for any `/showcase/` path the live release lacks. No release carries them (`saas-production-film` refuses any file over 10 MB under `showcase/`). The dev server
  serves them from `AWWO_STAGED_SHOWCASE/<case>/` when that is set (`apps/web/scripts/staged-showcase.mjs`).
- **Self-hosted sites.** A site deployed with `deploy/saas` has no store of earlier files: its nginx serves `/showcase/`
  from the build alone, so a film case's dialog says the film could not be loaded (with Try again), and its stages,
  nodes, receipt and copy still work. To show the film there, put the staged files at `showcase/staged/<case>/` in the
  web root that nginx serves, under the same names.
- **Dialog.** A recorded case opens `ProductionFilm.tsx`: the film from its staged URL with English subtitles and its
  stills, a download of the file as delivered, every node by stage (the media nodes as strips of posters), each node's
  words, brief or answer verbatim, and the run receipt. No page runs; the subtitles are the one file fetched, as text, and
  given to the player as WebVTT whatever type the server sends them with.
- **Copy.** A member's copy is the stored canvas, copied only while its text still hashes to the record; nothing is
  pre-filled, since the film's deliveries are files, so its first run makes every picture, clip and sound again.

### Films written as code

The eight films from the YouMind Opus 5.5 prompts (2026-10-26) are recorded canvases too, with no media node: a film's
picture and sound are written as code on one canvas. A Director agent writes the brief and a sheet; builder agents, each
in its own sandbox computer, write the kernel, the scene modules and the sound; an assembly pastes them into one page
with no model; a tester checks the page in a real browser; an Editor writes the edit's timeline, whose cards are that
page rendered from given moments (`data-offset`) and whose music is the same page's `window.renderAudio` (a page-made
sound, `apps/render-worker/README.md`); the edit renders and mixes it. Their Review node reads the tester's and the
editor's reports beside the edit, off the film's chain, and is not published: a case ends on the film's edit, and what
was checked before publishing says what the operator looked at.

- **Publish.** The same `publish-recorded-run.mjs`. An assembly is stored with its template, contract and file name, and
  its record names the page file it made (checked by its bytes, as every file). An agent with a contract shows its result
  as what it is (a page as its source; code, a sheet or a timeline as plain text, `outputType: 'text'`; Markdown as
  Markdown), its report beside it and any other text field (a Director's sheet) after them, all verbatim. An agent that
  worked in a sandbox computer keeps `runtime: 'sandbox'` in the stored canvas, and the record marks it. A wire into a
  contract's input is labelled as that input is. The excerpt and its poster keep a film narrower than 1280 px at its
  own width, and put a portrait film whole into the card's 16:9 frame.
- **Dialog.** The heading counts the kinds the canvas has (agents, media nodes, assemblies, edits); an assembly shows
  the file it pasted together; a sandbox agent its model calls; the player and stills take the film's own frame.
- **Copy.** A sandbox agent stays in its sandbox computer and takes the chosen model only when the sandbox offers it, as
  a flagship's copy does; the copy dialog says the first run writes every module, the page and the timeline again.

Tests: `saas-production-workflows`, `saas-production-runs`, `saas-production-copy`, `saas-production-cases` (and `saas-production-film`, which pins a film case's record, stored canvas, files and dialog, and `saas-staged-showcase`, the dev server's staged files), `saas-production-cases-placement`, `saas-work-mode-tutorial` and `saas-onboarding-host`. They pin, among other things, record ↔ canvas identity, summary ↔ record identity, checksums, the absence of private identifiers, and that delivery is claimed only where a run delivered.
