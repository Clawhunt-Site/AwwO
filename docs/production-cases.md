# Production cases and the work-mode tutorial

The homepage's nine production cases each have a real AwwO canvas that ran, and every case dialog shows how it was made: the canvas stage by stage, what each agent actually delivered, and the run receipt. The eight HTML cases also show the delivered result in a sandbox; the knowledge-base case shows its recorded demo and run evidence instead. New accounts first go through a seven-step work-mode tutorial.

## The work-mode tutorial

`apps/web/src/saas/WorkModeTutorial.tsx`, hosted by `SaaSOnboarding.tsx`.

- **What it explains**: brief → canvas → agents → handoffs → parallel stages → run states → review and delivery. Its scenes use the real canvas behind the pixel-platformer case, and that case's recorded run for timings once a record is published. The run-state scene is labelled as an illustration of the status display.
- **Who must see it**: an account is new when the first workspace it owns was created on or after `TUTORIAL_REQUIRED_SINCE` (2026-10-03) and less than `TUTORIAL_REQUIRED_DAYS` (14) days ago. The identity carries no other per-account date. For a new account the tutorial has no close or skip control, Escape does nothing, a browser's forced close reopens it, and it returns until it is finished. Each step unlocks after its scene has played (`STEP_DWELL_MS`).
- **Everyone else** sees it once on each device and can skip it. A finished tutorial is never downgraded by a skipped replay.
- **Replay** is under More options → 「AwwO 工作模式」 / “How AwwO works”. The page-by-page spotlight tour (「使用引导」) stays available on request.
- **State** is browser-only: `awwo.workmode.v1:<user>` = `completed` | `dismissed`, and `completed` from any tab wins. The API stores no onboarding state. A new account that opens AwwO on a second device within its first 14 days is shown the tutorial again until it finishes it there. Where browser storage is unavailable, a new account is still shown it, on every page load until it has been finished there, since nothing can be remembered; anyone else is not shown it by itself. If its chunk fails to load, a new account gets a notice that reloads the page (the tutorial opens again) instead of the workspace; anyone else carries on without it.
- It never creates, runs or submits anything. Its last step can focus the home prompt box.

## The case canvases

- `apps/web/src/saas/productionWorkflows.ts`: the eight canvases, as `OfficialWorkflow`s, so `createOfficialDocument`, the copy dialog and the stage views work unchanged. Each card's team (`productionCatalog.ts` `stages`) is pinned to its canvas by tests.
- Tasks are sized for AwwO's default execution settings on production: the openai-agents Python worker gives `qwen3.8-27b-p6` one model call per node, a 32,768-token context (about 28 KB of input text) and at most 4,096 output tokens. Hand-offs are therefore short, and every build is one self-contained HTML file of at most 8,000 characters (about 3,000 tokens: the default model writes about 36 tokens a second against a 120-second node timeout), with no network, storage or external resources.
- The canvases assume the model's hidden thinking is switched off (`AWWO_OPENAI_AGENTS_DISABLE_THINKING=true` on the worker; see `docs/awwo-openai-agents-runtime.md`). With thinking on, `qwen3.8-27b-p6` spends 2,000–8,000 of a node's 4,096 output tokens before answering and the larger nodes fail with `output_limit`.
- Their tasks carry what the runs taught. Every node that writes code the build pastes must deliver code that runs as pasted (balanced brackets, nothing running on its own at the top level). Every build checks itself silently, starts with `<!DOCTYPE html>` with nothing before it, fits its frame, and never reads an object, such as an `AudioContext`, before the first user action creates it. Games with several phases name them and the keys between them (menu → countdown → play → end); feel is given as baseline numbers rather than adjectives; the 3D projection is written out; large pages are held to 7,000 characters so they finish inside the 120-second node timeout.
- The homepage says every case ran only when every case has a published record (`summary.json`); a case's caption points to its delivery only when its record exists.
- The ad case does not make video. AwwO's agents deliver the script, storyboard, edit sheet, grade and a playable HTML animatic, and the case says so. Every cover except the knowledge base's is AI-generated illustration footage and is labelled 「封面示意 · AI 生成」.
- Members copy a case's canvas through the same dialog as an official example (`OfficialCopySetup`): it creates a clean draft and never starts a run. The knowledge-base canvas (2026-09-04, desktop Codex runtime) is not offered as a copy.

## Run records

`apps/web/src/saas/production-runs/<case>.ts` (one lazy chunk per case) plus `summary.json` (what the cards show). Records are generated, never edited:

1. **Run.** Start a private stack: the API and openai-agents Python worker at the production revisions, a throwaway PostgreSQL, and the production limits above. Then run
   `AWWO_SHOWCASE_EMAIL=… AWWO_SHOWCASE_PASSWORD=… node scripts/showcase/run-production-cases.mjs --api <url> --out <dir> [--cases a,b]`.
   It creates each canvas, initializes it, starts a graph run exactly as the canvas does, waits, and writes the raw record: the frozen graph run, every node's state and output, each node run and its model invocations, and the runtime catalog. It refuses any API that is not on this machine.
2. **Check** the delivered result in a real browser with every network request blocked, play it by hand, and write down only what was actually observed, defects included.
3. **Publish.** Run `node scripts/showcase/publish-run.mjs <raw.json> <notes.json>`. `notes.json` holds `note` (what happened in the run, failures included) and `verification` (what the browser check observed), both bilingual, plus `source` (`{ "api": "<commit>", "worker": "<commit>" }`, the revisions that ran) and `thinking` (`false` when the worker had thinking switched off), all required. Each node's value is read with the canvas's own contract parser. Machine paths and identifiers are redacted. The result's SHA-256 is recorded.

A published run must have used exactly the canvas text in `productionWorkflows.ts`: `publish-run.mjs` refuses any other run and stores the SHA-256 of that text (`canvasSHA256`, see `productionCanvasText.ts`), which `saas-production-runs` recomputes from the canvas a member copies. When a task changes, its case runs again. A canvas may run more than once: the record's note counts every run of the published text and says what went wrong in the ones that were not published, and names the problems of an earlier text that led to the change.

`scripts/showcase/publish-knowledge-base.mjs` builds the knowledge-base record from the 2026-09-04 evidence in `docs/superpowers/evidence/2026-09-04-awwo/`. That run used its own canvas on the desktop Codex runtime, not one from `productionWorkflows.ts`, so its record carries no `canvasSHA256` or result checksum and its canvas is not offered as a copy.

Tests: `saas-production-workflows`, `saas-production-runs`, `saas-production-cases`, `saas-production-cases-placement`, `saas-work-mode-tutorial` and `saas-onboarding-host`. They pin, among other things, record ↔ canvas identity, summary ↔ record identity, checksums, the absence of private identifiers, and that delivery is claimed only where a run delivered.
