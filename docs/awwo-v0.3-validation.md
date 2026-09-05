# AwwO 0.3 development acceptance

Date: 2026-09-05. This report covers the isolated `codex/accounts-i18n-state` worktree based on published 0.2.0, commit `22e5089360c230fcf8fba4d7ecadce5f7d7f62d1`.

Status: 0.3.0 is implemented and locally verified. On 2026-09-05, after being explicitly asked to waive the unavailable Gemini review and authorize this version's commit and Forgejo push, the operator replied “全部批准”. This grants a release-specific review exception; it is not a claim that Gemini reviewed or passed the code. Publication uses the original worker branch, the development branch `dev`, and immutable tag `v0.3.0` in the private AwwO repository.

## Delivered behavior

The compact Agent canvas keeps an independent Session list, conversation and optional deliverables panel inside each component. Chinese and English interface text includes templates, planning, forms, configuration and execution notices. Changing language does not rewrite user content or schema IDs.

Account controls use the existing server profile, membership and invitation APIs. The server enforces permissions and protects the final owner. Local trusted mode is identified explicitly. Selecting a workspace in account management does not rebind existing nodes or establish tenant isolation for the browser's local canvas. See [account architecture and environment boundaries](accounts-and-languages.md).

The execution protocol records an operation identity before sending work. Native run state remains authoritative: a dropped stream is recoverable, a stop is pending until confirmed, and malformed or incomplete output cannot satisfy downstream contracts. A browser ownership lock covers dispatch and recovery. Accepted manual messages clear their draft only after the recovery record is durable.

## State transition acceptance

| Trigger | Required behavior | Evidence |
| --- | --- | --- |
| Missing runtime, input or invalid dependency | Refuse before dispatch; keep draft and existing outputs | Web preflight and composer regressions |
| First accepted request | Persist operation, issue and native run identity | Gateway operation protocol and Web journal tests |
| Duplicate operation | Recover the original dispatch; reject changed request content | Operation-store and dispatch regressions |
| Native queued, running or scheduled retry | Keep the canvas locked and observe | Native-state recovery regressions |
| Native success with valid output contract | Publish output and release downstream dependencies | Real two-node Codex chain |
| Native success with invalid structured output | Mark graph failure; retain partial evidence | Real second-node Markdown rejection |
| Scoped repair | Execute only the selected node, reuse validated upstream output | Real repair run `460f72c4-2264-4ba4-a2d3-e052e0e57499` |
| Stop requested | Confirm native cancellation; uncertain replies remain locked | Gateway cancellation and Web race regressions |
| Reload while running | Recover identity and output without dispatching again | Real two-tab browser test; one message POST and native success |
| Changed binding, Session or executable inputs | Preserve history; refuse publication of stale recovered output | Recovery-document and Session regressions |
| Manual conversation | Preserve replies and original issue identity; do not auto-publish graph output | Manual recovery and publication regressions |

An Agent saying “done” or “blocked” in prose is not a state transition. Native process success and business/contract validity are distinct checks. The control plane owns Agent execution; the current browser owns graph scheduling. Recovery does not silently launch waiting downstream nodes after a detached graph.

Cross-tab Stop completion is serialized with execution/recovery and rechecks the journal ID plus operation, run, issue, company, Agent and Session identity. A late Stop for an old run cannot mutate a new run. Recovery rereads durable state after network waits, even if a `storage` event is delayed. History restoration has a 15-second deadline.

## Automated verification and review

- Web: 91 files / 999 tests passed; TypeScript, static UI checks and development build passed (`.local/iteration/web-final-gates-v2.log`).
- After correcting detached-stream transcript copy and adding early-Stop regressions: 2 directly affected files / 39 tests passed; TypeScript and Web build passed again.
- After the operator approved publication: the complete Web suite passed again with 91 files / 1,001 tests, followed by TypeScript, static UI checks and development build (`web-release-approved.log`). Gateway 389 tests, type check, build and the 12 launcher tests also passed again. No runtime source changed between that verification and publication.
- Gateway: 36 files / 389 tests, type check and build passed on the final protocol implementation.
- Development launcher: 12/12 tests passed.
- Independent review: Codex CLI `gpt-5.5` passed account/runtime catalog review, Gateway protocol review and final Web execution re-review. A separate cross-tab review passed after the two identified race conditions were fixed and covered by delayed-event regressions.
- Gemini CLI was attempted twice, including a final review of the staged candidate, but failed with `FatalAuthenticationError: Interactive consent could not be obtained` (exit 41). It has not provided an acceptance result. The operator explicitly approved the exception above after reviewing the completed local acceptance and publication request.

The review's initial claims that early Stop unlocked the graph, native timeout deadlocked recovery and missing Web Locks needed a localStorage fallback were checked against source and withdrawn on re-review. The actual misleading “stopped” transcript on transport loss was corrected. Unsupported browsers without Web Locks deliberately refuse execution; the supported local Windows Chrome target was used for acceptance.

Existing build warnings concern vendor CSS selectors, mixed static/dynamic imports and bundle size. No vendored source or dependencies were changed to suppress them.

## Real Codex evidence

The planner created two connected nodes from a Chinese request. Both nodes were bound to real local `codex_local` Agents using `gpt-5.6-sol`. An AI edit renamed the second node while preserving IDs, bindings, contracts and connections. Manual dragging preserved the edge. New Sessions retained old conversation records.

The first node wrote and read `artifacts/spec.md`; the second consumed its result through the typed edge, wrote and read `artifacts/verification.md`. The first second-node attempt returned Markdown instead of its required JSON object and was rejected. Editing the constraints and running only that node produced valid structured output. The first node's previously validated output remained byte-for-byte unchanged.

- First successful native run: `8a8f6198-6b08-4ffa-94c7-45591309899d`, issue `6f273cc7-e28f-4bb0-9cd6-1fdd301651d0`.
- Invalid second-node reply: `85df75cb-5bee-4aa7-b03b-80a94d7cf8e6`, issue `43af5ffb-5fc8-45bb-bed3-ecab388889ad`.
- Successful scoped repair: `460f72c4-2264-4ba4-a2d3-e052e0e57499`, same second-node issue; native status read back as `succeeded`.
- Shared marker: `AWWO-CHAIN-20260905`.
- `spec.md`: 274 bytes, SHA-256 `e5aae2a7b4118d6fbdd2e81c8c75f91aa3aa1f92d6f8845642acddde67f3d799`.
- `verification.md`: 707 bytes, SHA-256 `bb8b3540ac96bdb2167a38a7a134fa975825779823b0b07a016b0f8582c4624d`.

Files reside in separate Agent directories under `C:/tmp/awwo-acceptance-20260905/`. The edge transfers structured text; this test does not claim automatic copying of files between independent working directories or implementation of the sample canvas requirements described inside these files.

Local evidence is kept under ignored `.local/iteration/`: planner/binding/edit browser logs, `repaired-chain.json`, `repair-journals.json`, `chain-artifacts.json` and screenshots. Authenticated account acceptance is recorded separately in `.local/release/account-authenticated-3102-20260905T0905/result.json`: 14/14 checks passed, SHA-256 `8e47189020dc7ebc67b1ea6e87ec22faa3352fd6342250c23033d1f05bac3d38`.

### Final browser run against the current build

- Stop run `03088f6a-342b-4e7f-97e9-6f5f10388799`: the Agent wrote a start marker and entered a 90-second foreground wait. UI Stop was confirmed by native `cancelled`; the post-wait file was still absent after more than 90 seconds.
- Continue run `a64e29cc-165f-4903-bd8b-72ecf6e1c832`: same issue/Session, native `succeeded`, `resume-ok-v1.txt` read back as `AWWO-RESUME-OK`. Manual replies did not replace the graph's published output.
- Refresh run `29a730c6-5087-4066-af0d-3a6062d3f3b6`, operation `0327ff44-0b7e-45e8-b021-2e38b8abad87`: two browser tabs were open before dispatch; the second locked its wiring. The first reloaded while the native command was running. Exactly one message POST was observed across both tabs. The native run succeeded, `AWWO-REFRESH-DONE` was read from the actual file, the journal cleared, and another fresh page load displayed exactly one matching Agent reply. Published graph output and issue identity stayed unchanged.
- Account panel: current built preview passed Chinese/English rendering, Escape focus restoration, 320px overflow check and language persistence after reload. No uncaught browser errors were recorded.

Evidence: `stop-resume-evidence.json`, `refresh-tabs-evidence.json`, `refresh-native-readback.json`, `account-browser.json`, corresponding logs and screenshots under `.local/iteration/`.

## Windows runtime findings

The installed Codex CLI was updated during acceptance. The runtime was re-bound to the current installed executable. Each test Agent uses a dedicated `C:/tmp` working directory, workspace-write sandboxing, ignored personal project configuration and the existing Codex authentication home. The native Windows sandbox uses the installed elevated sandbox mode; permission bypass is false and the user's global configuration was not changed.

An existing native Session pins its working directory. Changing adapter configuration alone did not move an existing Session; new Sessions were created through the UI to test the new directory. Earlier attempts in an inherited repository directory and an inaccessible AppData directory are recorded as failed attempts, not passed acceptance.

## Scope and publication boundaries

This is a local development iteration. No production deployment, installer, email delivery, production database write or shared-checkout cleanup was performed. Authenticated account APIs were tested on an isolated server; authenticated multi-tenant canvas execution and cross-service ClawHunt identity exchange are not certified.

The original shared checkout and its pre-existing `CLAUDE.md` edit remain untouched. The vendored `server/` source must remain at tree `729b741740efba9dae8807db58db7b730a8a0b93`.

Publication also preserves existing local commit `ea464f12a2fd423f44ee82a829066f99f4e4908b`, which updates the managed engineering description from the inherited Python project type to AwwO/Node. It changes only `CLAUDE.md`. The runtime source remains the tested candidate; no production branch or service is promoted. Release readback must verify remote `dev`, the worker branch and the peeled version tag against the same local commit and compare their source tree through an independent bare repository.

Forgejo Git transport contains the published 0.2.0 source. A fresh REST read still reports repository `ClawHunt-Store/AwwO` as `empty: true` despite those refs. This is an unresolved repository metadata problem. No deletion, force push, hook bypass or global server repair was attempted. A new Git push alone must not be represented as proof that Forgejo's repository UI is repaired.

Recovery is deliberately bounded. A continuation whose upstream comment was accepted immediately before a gateway crash can remain uncertain if the comment identity was not durably observed; it is not blindly reposted. Historical run lookup is capped at 1,000 entries. More than 2,000 comments is reported as unreadable instead of pretending the prefix is complete. Local manual-reply recovery retains at most 50 entries and approximately 1 MB per Session; corruption, capacity or quota failures preserve the active journal instead of silently discarding the reply. These limits and server-side scheduling/tenant isolation remain follow-up product work.
