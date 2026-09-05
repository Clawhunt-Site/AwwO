# AwwO Agent canvas — local handoff

Updated: 2026-09-05. Status: frontend, contracts and a real seven-node Codex graph run verified locally. Subsequent repair and Session revalidation evidence is recorded at the end. Real identity/business backend, desktop PTY packaging and production acceptance are not established by this work.

## Delivery location

- Worktree: E:\Bobo's Coding cache\bo-work\superclaw\.worktrees\awwo-agent-canvas
- Branch: feat/awwo-agent-canvas
- Base: feat/workflow-canvas-m1 at c8db2818be40511bbb42ad5435028105a738e61c
- Local preview: http://localhost:5188/ (real Codex-bound graph); the earlier http://127.0.0.1:5188/ canvas is preserved separately. Development only.
- Commits: none. PR/deployment: none.
- Shared main checkout preserved: only its pre-existing CLAUDE.md edit remains.
- dev/server-refactor is absent locally/remotely. Fresh origin/main is substantially divergent; no automatic integration was attempted. See design spec for the baseline ruling.

## What changed

AwwO branding and a workspace shell with explicit onboarding, seven Agent responsibility templates, node navigation/search, theme controls and responsive navigation. A product-development template creates five draft Sessions and five typed links only after an explicit user action.

Nodes have independent conversations and editable text, Markdown, number, boolean and file-reference input/output schemas. Markdown supports formatting and preview. Ports show field labels. Connected inputs show validated upstream content and provenance without overwriting the local fallback. Conversations and graph runs receive contract inputs; a graph result must match its output schema before downstream execution. Manual publishing is explicitly labeled.

Configuration/schema/value/wire changes invalidate dependent outputs. Retries clear previous success before execution; partial output cannot be reused. Inspector changes preserve live card inputs and server thread IDs. Run locks cover configuration and bindings. In-flight binding results cannot be lost through parent Escape, switching nodes, deletion, undo/redo or navigation. Undo preserves a same-agent server thread ID. Scoped preflight errors are visible.

## Verification

- Baseline: 4 canvas suites / 100 tests passed before modifications.
- Integrated final functional suite: 26 files / 420 tests passed (Vitest; all canvas, workspace, app shell and SSO).
- After the overview framing adjustment: 3 directly affected suites / 54 tests passed.
- TypeScript noEmit passed; static-ui.test.mjs passed.
- Vite web build passed with APP_ENV=development and VITE_APP_ENV=development. This is a web asset build, not desktop packaging or deployment.
- Existing vendor build warnings remain: CSS highlight pseudo-elements, a mixed static/dynamic MarkdownEditor import, and large bundle chunks. No dependency added.
- Browser at 1280x720 and 390x844: draft creation, node focus, theme change, Markdown editing/preview, field persistence after page reload, no-runtime refusal, manual publication/source readback, upstream form value display, port connection (5 to 6 edges) and undo (back to 5), component library, responsive navigation, full-graph overview.
- Default chat transport and graph transport tested with local in-memory gateway/SSE fixtures, including independent conversation IDs and real terminal-status interpretation. These tests are not a live Agent-runtime acceptance.
- Independent code and screenshot review: no remaining P1 after identified issues were fixed.
- Codex CLI gpt-5.5 re-review: PASS/no blocking findings. Evidence: .codex-cli-advisor/recheck.md. Its first review found server-thread undo and silent scoped refusal; both fixed with regression tests. Output freshness wording/spec aligned with implementation.

Commands run from apps/web:

    node node_modules/vitest/vitest.mjs run tests/canvas tests/awwo-workspace.test.tsx tests/app-shell.test.tsx tests/clawhunt-sso.test.ts
    node node_modules/typescript/bin/tsc --noEmit --pretty false
    node tests/static-ui.test.mjs
    node node_modules/vite/bin/vite.js build --configLoader runner --config vite.config.mjs

## Review/commit gate

The named advisor wrapper skills are not installed, so the available official Codex/Gemini CLIs were used as a fallback. Codex required a supported high reasoning setting instead of the inherited max and passed on re-review. Gemini failed authentication with FatalAuthenticationError: Interactive consent could not be obtained. Per CLAUDE.md's dual-advisor commit gate on this feature baseline, no commit was made. No authentication settings were modified and no remote writes were performed.

## Remaining boundary

The localhost gateway/control plane is unavailable in this preview; nodes remain honestly unbound. Persistent PTY ownership, server-persisted graph scheduling, conditional state transitions, deployment and real runtime acceptance are subsequent backend work. The current session gateway/issue routing was preserved, not replaced with a fake terminal.

Branding changes cover the new workspace and startup shell. Historical technical identifiers, configuration names, saved-document keys and ClawHunt account integration remain compatible. The added package test command retains the pre-existing upstream bridge test identifier as a required compatibility reference.

## Evidence

- evidence/2026-09-04-awwo/mobile.png
- evidence/2026-09-04-awwo/desktop-input.png
- evidence/2026-09-04-awwo/agent-library.png
- evidence/2026-09-04-awwo/upstream-input.png
- evidence/2026-09-04-awwo/canvas-overview.png

Browser sample text and manual output are local preview data, not model-generated production results.

## Changed files

- apps/web/index.html
- apps/web/package.json
- apps/web/src/App.tsx
- apps/web/src/canvas/AddNodeMenu.tsx
- apps/web/src/canvas/agentTemplates.ts
- apps/web/src/canvas/AgentWorkspace.tsx
- apps/web/src/canvas/awwo-node.css
- apps/web/src/canvas/awwo-workspace.css
- apps/web/src/canvas/canvasDoc.ts
- apps/web/src/canvas/CanvasSurface.tsx
- apps/web/src/canvas/ContractFields.tsx
- apps/web/src/canvas/InspectorPanel.tsx
- apps/web/src/canvas/invalidateOutputs.ts
- apps/web/src/canvas/nodeContracts.ts
- apps/web/src/canvas/nodeConversation.ts
- apps/web/src/canvas/ports.ts
- apps/web/src/canvas/runGraph.ts
- apps/web/src/canvas/SessionTile.tsx
- apps/web/src/canvas/TileComposer.tsx
- apps/web/src/canvas/TilePorts.tsx
- apps/web/tests/awwo-workspace.test.tsx
- apps/web/tests/canvas-agent-card.test.tsx
- apps/web/tests/canvas-contract-fields.test.tsx
- apps/web/tests/canvas-contracts.test.ts
- apps/web/tests/canvas-inspector-lock.test.tsx
- apps/web/tests/canvas-invalidation.test.ts
- apps/web/tests/canvas-node-conversation.test.ts
- apps/web/tests/canvas-port-labels.test.tsx
- apps/web/tests/canvas-workspace-integration.test.tsx
- creator.md
- docs/superpowers/2026-09-04-awwo-handoff.md
- docs/superpowers/evidence/2026-09-04-awwo/agent-library.png
- docs/superpowers/evidence/2026-09-04-awwo/canvas-overview.png
- docs/superpowers/evidence/2026-09-04-awwo/desktop-input.png
- docs/superpowers/evidence/2026-09-04-awwo/mobile.png
- docs/superpowers/evidence/2026-09-04-awwo/upstream-input.png
- docs/superpowers/plans/2026-09-04-awwo-agent-canvas.md
- docs/superpowers/specs/2026-09-04-awwo-agent-canvas-design.md


## Follow-up: simplified component workstation

Implemented the user's screenshot feedback: compact global navigation, left Session management inside each node, central conversation, optional right delivery pane, internal configuration, and secondary input/output forms. Removed the node's permanent responsibility block, runtime paragraph, top-level conversation/input/output tabs and bottom action strip. Actions live in header icons and the overflow menu.

Added persisted Session creation/selection with independent server IDs and drafts. Transport and history stores are keyed by conversation; callbacks retain their Session identity. Session changes invalidate downstream publications while preserving labeled historical deliveries. Review found and fixed stale configuration after Session switching and loss of binding identity during undo. Drawer geometry updates are atomic, idempotent and persistent.

Additional implementation files: apps/web/src/canvas/NodeDeliverables.tsx, nodeThreads.ts, sessionTransport.ts, runTransport.ts, invalidateOutputs.ts and their integration in canvasDoc/CanvasSurface/SessionTile. Added tests: canvas-deliverables.test.tsx, canvas-node-workbench.test.tsx, canvas-node-threads.test.ts, canvas-thread-persistence.test.tsx; updated existing UI tests for the new controls.

Before the final review fixes, the integrated UI/runtime suite passed 434 tests in 29 files; TypeScript and development web build passed. Four further review regressions were added and verified after reproducing their failures. Final evidence is recorded below. Original branch/base and no-commit/no-deployment boundary remain unchanged; this is a local frontend/runtime-routing iteration, not live backend acceptance.


Final follow-up validation (2026-09-04 19:10): **29 files / 438 tests passed** using `vitest run tests/canvas tests/awwo-workspace.test.tsx tests/app-shell.test.tsx`; TypeScript passed; development Vite build passed. Independent review recheck: no remaining P1/P2 in the changed Session/config/undo/drawer paths. `git diff --check` passed.

Browser readback: all three regions are inside the backend component; at 1280x800 the expanded node is 825 screen pixels, chat is 317.5 and delivery pane 325. Closing/reopening restores the same width. Focused node stacking keeps it above nearby nodes. Manual Session creation/selection persisted across HMR reloads, historical manual output was labeled accurately, and navigation/focus were checked at 390x844. Live backend remains unavailable and was not represented as tested.

Screenshots: `evidence/2026-09-04-awwo/workbench-three-columns.png` and `evidence/2026-09-04-awwo/workbench-conversation.png`. The local preview remains on http://127.0.0.1:5188/ with the backend node focused and its delivery pane expanded. No commit, push, PR or deployment was made.


## Follow-up: compact graph overview (2026-09-04 19:53)

Status: implemented and verified locally. Default view is now compact summary nodes. Only one full Session workstation opens at a time; switching or folding retains all prior functional state. Added an explicit dependency-based Arrange Layout action with a single undo step. The current preview is arranged and all five nodes are folded.

Changed in this iteration: CanvasSurface.tsx, SessionTile.tsx, agentTemplates.ts, awwo-node.css, package.json; new nodePresentation.ts, canvas-node-presentation.test.ts and canvas-node-disclosure.test.ts; existing Surface tests updated for explicit opening. Previous branch/base and no-commit/no-deployment boundary remain unchanged.

Final validation: **31 files / 450 tests passed** (`vitest run tests/canvas tests/awwo-workspace.test.tsx tests/app-shell.test.tsx`); TypeScript noEmit and development Vite build passed. New coverage verifies one open workstation, complete preservation of Session drafts/full geometry, projected port/wire alignment, deterministic arrangement and one-step undo. Independent code review found no new P1/P2 in disclosure, binding locks or geometry isolation. Build retains the existing vendor chunk warnings.

Browser readback on the existing preview: overview has five compact nodes and zero composers; opening the backend has four compact nodes and one composer; folding returns to zero composers. Fixed a real layering issue where neighbouring ports appeared above the focused workbench and verified the overlapping element is now the workbench header. No backend or provider execution was triggered.

Screenshots: `evidence/2026-09-04-awwo/compact-agent-overview.png` and `evidence/2026-09-04-awwo/compact-single-workbench.png`.


## Follow-up: personalized component templates (2026-09-04 20:44)

Status: implemented and verified locally. All seven roles now have complete, distinct input/output forms, field guidance and blank structural examples, execution steps, acceptance criteria, starter prompts, empty states, delivery titles, glyphs and subtle role colors. Backend services and user identity are separate responsibilities. New nodes persist template identity/version independently from their editable title. Legacy nodes keep their original values, persona, Session history, published results and graph connections; compatible old nodes can show reference guidance without migration.

The template library now provides a role list with detail preview. The right-click menu includes concise role descriptions and keeps its position within the canvas. The node's secondary Template control shows guidance using its current customized field schema. Starter actions append only to the current Session draft and never send automatically. Empty delivery panes list the expected role-specific sections as pending, not completed results. Field help and output structure guidance reach the execution prompt; changes to those instructions invalidate old output appropriately. Keyed multi-output JSON is validated before named fields reach downstream nodes.

Files changed in this iteration: apps/web/src/canvas/agentTemplates.ts, canvasDoc.ts, nodeContracts.ts, ContractFields.tsx, runGraph.ts, invalidateOutputs.ts, NodeDeliverables.tsx, AgentWorkspace.tsx, SessionTile.tsx, AddNodeMenu.tsx, awwo-workspace.css, awwo-node.css; new AgentTemplateDetails.tsx. New tests: canvas-agent-templates.test.ts, canvas-template-prompts.test.ts, canvas-template-workbench.test.tsx. Updated tests: awwo-workspace, canvas-contract-fields, canvas-contracts, canvas-deliverables, canvas-invalidation, canvas-workspace-integration and canvas-node-presentation. package.json includes the new test files; the design spec records the refined behavior.

Final validation: **34 files / 490 tests passed** (`node node_modules/vitest/vitest.mjs run tests/canvas tests/awwo-workspace.test.tsx tests/app-shell.test.tsx`, 20:43:06, 23.38 seconds). `node node_modules/typescript/bin/tsc --noEmit --pretty false` passed. Development-only Vite build passed in 3.23 seconds; existing vendor chunk warnings remain. Independent review found no new P1/P2 in role identity, blank-field handling, draft scoping, output prompt guidance, template graph connections or compact disclosure.

Browser readback: desktop template library distinguishes frontend/user identity field structures; a newly created user-system node had 4 input and 3 output ports, a personalized persona, and role-specific starters. A starter populated the local Session draft while send stayed disabled; that draft and template fields survived a reload. Input placeholders stayed empty values. The right drawer displayed three pending identity deliverables without output markers. At 390x844 the modal remained inside viewport bounds (x16..374, y20..824) with its create button visible and contents scrollable. The temporary identity node created for validation was removed through the UI; the original five nodes remain. Preview is left on the template library at http://127.0.0.1:5188/.

Evidence: personalized-template-library.png, personalized-template-mobile.png, personalized-identity-workbench.png and personalized-identity-deliverables.png under evidence/2026-09-04-awwo/.

Worktree remains E:/Bobo's Coding cache/bo-work/superclaw/.worktrees/awwo-agent-canvas, branch feat/awwo-agent-canvas, base feat/workflow-canvas-m1@c8db2818be40511bbb42ad5435028105a738e61c. No commits, remote writes, PR or deployment. The prior advisor-auth commit gate remains unchanged; the shared main checkout still has only the pre-existing CLAUDE.md modification. The live runtime backend remains unavailable, so this result covers local template/UI behavior and fixture execution rather than live Agent execution.

## Follow-up: conversational canvas architecture (2026-09-04 21:45)

Status: implemented and verified with the real local Codex provider. An empty workspace now starts with a requirement composer; existing graphs have a collapsible canvas assistant. Users can generate a graph, continue the same conversation to change nodes, fields and connections, and keep editing manually. Node Session management, conversations and delivery panels remain inside each component.

The shared foundation is a versioned, strict canvas-operation protocol: add/update/remove nodes, set input values, add/update/remove contract fields, connect/disconnect edges. Every proposal is applied to a private clone, checked for references, types, fan-in and cycles, then written as one undoable document change. It cannot assign runtime bindings, Session transcripts or generated outputs. A document revision check rejects proposals made against an older manually edited graph. Cancellation and late responses never apply a partial plan. Current graph structure is authoritative; the separately persisted planning conversation is intent context. Existing Session identities, drafts, outputs and manual coordinates are preserved by incremental edits.

New frontend files: canvasPlan.ts, canvasPlanning.ts, CanvasAssistant.tsx and canvas-assistant.css. Integration changes: CanvasSurface.tsx, AgentWorkspace.tsx, awwo-workspace.css and package.json. New frontend tests: canvas-plan.test.ts, canvas-assistant.test.tsx, canvas-planning-client.test.ts and canvas-planning-integration.test.tsx. The initial overview now measures after the assistant sidebar is mounted, and mobile canvas controls stay below the overlay in a separate stacking context.

New gateway files: apps/gateway/src/canvas/{config,provider,routes}.ts and their tests; router mounted in app.ts and index.ts. Configuration and start instructions: apps/gateway/.env.example and docs/canvas-planner.md. GET /api/canvas/planner detects provider availability; POST /api/canvas/plan invokes real Codex CLI in a temporary read-only planning context. Existing loopback/control-token access is retained. Requests, output size, concurrency and execution time are bounded; cancellation terminates the wrapper/native process tree. Development defaults to Codex, staging/production default disabled. No credentials are embedded in the browser. The gateway has a separate isolated empty automation store for this preview.

Verified browser flow on an independent local origin (http://localhost:5188/):

- A knowledge-base SaaS requirement generated 6 independent Agent nodes and 10 typed connections, including product scope, identity, document governance, backend, frontend and review. The AI added the extra identity/data input fields required by the graph and populated business inputs; pending technology choices were labeled.
- A follow-up added an independent launch-materials Agent and 2 connections, preserving the existing graph and renaming the frontend to Knowledge Base Web Workbench (Chinese display name). Result: 7 nodes / 12 connections.
- One AI undo restored 6 nodes / 10 connections and the former title; Redo restored 7 / 12. Manual Arrange Layout remained available.
- A manual frontend input supplement survived a later AI edit and browser reload. Another AI turn added a 90-day audit requirement to the data node without replacing the rest of the graph.
- A longer planning request was cancelled in the browser. The request text was restored, graph stayed unchanged, and process inspection found zero remaining planner child processes.
- Responsive check at 390x844 verified the composer, send and close controls; fixed the minimap stacking above the assistant. Existing user canvas on 127.0.0.1 was preserved (6 nodes at this turn's live readback).

Final validation: 38 frontend files / 541 tests passed at 21:42:44 (29.35 s), including atomic generation/undo, Session/layout preservation, stale/cancel behavior, schema/privacy context and post-sidebar fit. TypeScript noEmit passed. Development Vite build passed. Gateway canvas tests: 18 / 18; gateway production TypeScript build passed. Independent scoped frontend and gateway reviews found no blocking issue. git diff --check passed; existing vendor chunk warnings remain. The gateway's broader test-inclusive typecheck has a pre-existing unknown-type error in src/auth/routes.test.ts:133; production build and all new planner tests pass.

Evidence: canvas-planner-welcome.png, canvas-planner-generated.png, canvas-planner-edited.png, canvas-planner-mobile.png and canvas-planner-final.png in evidence/2026-09-04-awwo/. Generated screenshots are real model-produced architecture drafts, not executed application code or completed materials.

Worktree: E:/Bobo's Coding cache/bo-work/superclaw/.worktrees/awwo-agent-canvas. Branch: feat/awwo-agent-canvas. Base: feat/workflow-canvas-m1@c8db2818be40511bbb42ad5435028105a738e61c. No commits, push, PR or deployment. The prior advisor-auth commit gate remains unchanged. This iteration verifies AI graph planning and editing; Agent task execution still requires binding real runtimes. Persistent terminal ownership, server-side graph persistence and production deployment are not claimed by this local planning delivery.

## Follow-up: binding the local Codex runtime (2026-09-04)

The user explicitly requested real Codex binding and execution. The seven-node knowledge-base graph on http://localhost:5188/ was bound through the actual configuration UI to seven separate `codex_local` Agents in a new isolated local company. The existing 127.0.0.1 canvas was preserved. Each persona was written through the control-plane instructions API; each Agent has a separate working directory under C:/tmp/awwo-codex-live-20260904/.

Local company ID: b1056300-e885-4146-b5dc-5489b19d0324. The control plane listens on 127.0.0.1:3100; the gateway listens on 127.0.0.1:8796 and explicitly targets that upstream. The gateway uses a separate empty automation store. The local control plane uses isolated runtime configuration, data and logs under this worktree's ignored .local/codex-live/. Its Agent JWT was initialized with the existing official helper without exposing the secret. Scheduled heartbeat execution is disabled.

`codex login status` reports ChatGPT login. The older npm CLI (0.143.0) rejected the host's default model, so the binding uses the current desktop application's existing bundled native CLI (0.153.1) and an explicit external CODEX_HOME pointing to that logged-in user's directory. No package upgrade or authentication-token copy was needed. Host-specific settings are runtime data, not new frontend defaults. Both bypass aliases are explicitly false, the workspace-write sandbox remains active, and unrelated plugins/apps/MCP services are disabled for this local verification. Empty runtime skill selection prevents platform skill injection into the user's Codex home.

Two startup problems were reproduced rather than represented as successful execution:

- The default managed Codex home could not symlink auth.json on Windows (`EPERM`). The adapter's already supported explicit external CODEX_HOME resolves that without changing privileges.
- The experimental PGlite database deadlocked after failed heartbeat finalization because a transaction awaited an outer connection query. A completely in-memory reproduction at .local/codex-live/diagnostics/pglite-transaction-reentry.mjs verifies the re-entry timeout against a passing transaction control. The run uses the already supported native embedded PostgreSQL implementation instead. The original PGlite data is retained; no vendored server files were edited.

The root requirement now explicitly authorizes this local execution and asks for concise contracts. A frontend static prototype may be created in its isolated directory; simulated behavior and unimplemented backend/login must be labeled. No publication, deployment, external business actions or package installation are part of this test.

The original full graph completed with seven successful provider runs and valid structured outputs. Detailed execution evidence and the separate acceptance result are recorded below.

Code changes from this binding verification: canvasHire.ts and canvas-hire.test.ts now preserve Codex's workspace sandbox, disable timer wakes for canvas-created Agents, and map explicit Codex reasoning effort to the native adapter's modelReasoningEffort field. Other adapters retain their existing effort contract. The gateway conversation projector and tests now decode Codex JSONL instead of forwarding it as raw stdout; final answers are separate from process messages and tool output. The local runbook is docs/canvas-codex-local.md.

Runtime migration readback: 24 business tables / 110 rows restored to native PostgreSQL in one transaction, with all original IDs and seven Agent configurations preserved, foreign keys verified and serial sequences synchronized. The source PGlite database and private export remain in the ignored local runtime folder. The resulting instance has one company, seven Agents and a healthy loopback API. No business source files in the shared main checkout or vendored server were modified.

The live run exposed oversized and redacted stdout records. The gateway now recovers truncated stdout from the same observed run ID, validates record boundaries, and distinguishes damaged command records from malformed assistant output. Final Agent content is published once, after the actual terminal event. Failed recovery or malformed assistant output remains an error. The successful root replay and regression suite cover these actual failure modes; no fixture response substitutes for a live run.

Scoped binding verification: in apps/web, `node node_modules/vitest/vitest.mjs run tests/canvas-hire.test.ts tests/canvas-inspector-lock.test.tsx tests/canvas-panels.test.tsx` passed 40/40, TypeScript noEmit passed and the development Vite build passed. In apps/gateway, `node node_modules/vitest/vitest.mjs run src/conversation` passed 72/72 across six suites; `node node_modules/typescript/bin/tsc -p tsconfig.build.json` passed. An independent final review found no new blocker in the conversation changes. The pre-existing fast-run discovery race remains outside this patch and is documented in the local runbook.

### Actual seven-node execution

The browser reported `运行完成：7/7 节点成功。` after real Codex execution. The control plane independently reported `succeeded` for the same seven pinned run IDs, and every final response decoded to its declared output fields:

| Node | Observed canvas run | Output fields |
| --- | --- | --- |
| 产品边界与架构需求 | e33071e4-2539-4e75-ac91-a7108d08b07d | result, followups |
| 用户登录与工作区权限 | d0065c0d-5744-4cd2-8cb0-e18cc5703dd6 | identity, permissions, checks |
| 文档数据治理 | 24812df4-2121-450f-8b35-b337ec94a7ed | schema, quality, lineage |
| 后端接口与业务规则 | 5fd4be45-9ac5-4c73-a163-8636bc4c0a00 | api, implementation, checks |
| 知识库 Web 工作台 | 59376352-1dab-4786-b480-6192051ea67a | delivery, preview, checks |
| 交付验收 | 6af0e76f-f933-4c03-a886-9934d09b489e | report, issues, verification |
| 知识库上线物料 | 62dcab65-053d-481f-b816-21ad92d206d6 | assets, copy, specifications |

The twelve connected inputs were read from actual downstream server issue descriptions and compared with the specific upstream output fields: **12/12 exact matches**. An internal backend review and subsequent repair tasks were excluded from the seven-node count. Each bound Agent has a distinct canvas issue and Codex task session. Historical root Session 1 retained the same Codex session across a continuation; new root Session 2 obtained a different issue and Codex session without overwriting Session 1.

Frozen first-pass evidence: `evidence/2026-09-04-awwo/codex-live-first-pass.json`, `codex-live-inputs.json`, `codex-live-bindings.json` and `codex-live-completed.png`. The runtime's usage metadata reports the model as `unknown`; this evidence establishes the actual native Codex CLI and sessions, not a verified specific model identifier.

Provider success means that the Agent ran and returned a valid contract. It does not mean that the generated SaaS passed business acceptance. The frontend and review issues explicitly retained a blocked acceptance status because real identity/business services were not implemented and the Codex subprocess could not launch a browser. The review also reproduced two frontend demo defects: Unicode caseless matching (`Straße`/`STRASSE`) and stale quality failures after reactivating a tag. The review created real repair tasks assigned to the frontend Agent; their later runs and modifications are tracked separately from the frozen first pass.

The generated frontend exists at `C:/tmp/awwo-codex-live-20260904/a784236e-c48a-468d-b14f-8392297e0452`. Its own loopback server is running at http://127.0.0.1:4173/. The outer browser independently verified demo login, keyword search, document detail, workspace isolation, Viewer menus, dashboard scope, draft saving, invalid-publication feedback and unavailable real authentication. A final-version refresh was checked at 23:46. Evidence and scope: `evidence/2026-09-04-awwo/codex-prototype-browser.md` and its screenshots. This browser pass does not replace real backend, accessibility or production acceptance.

### Subsequent repairs and Session continuation (2026-09-05)

The real frontend Agent completed AWW-15, AWW-16 and AWW-17 after the original graph. Their three successful runs repaired Unicode full case folding and cleared stale governance failures after tag reactivation. Independent verification matched eleven source hashes and passed 31 model/regression tests plus three DOM groups. The original seven-run and twelve-input snapshots remain unchanged; subsequent repair evidence is `evidence/2026-09-04-awwo/codex-live-rework.json`.

Two canvas presentation defects found while reviewing real outputs were fixed locally. Compact cards now summarize the first declared output value instead of displaying the closing JSON brace. Local Windows/file references in delivery Markdown provide a selectable path and Copy Path action instead of navigating to a broken localhost URL. The existing Markdown URL sanitizer still applies to ordinary links and images. Scoped tests passed 20/20 for tile history and 26/26 for deliverables; TypeScript and a development-configured web build passed.

A follow-up on the original review Session exposed a real dependency gate: AWW-12 depends on unfinished browser review AWW-11. The previous gateway saved a comment but then waited for a run that the control plane had declined to start. The dispatcher now validates issue ownership and uses the official guarded resume intent for blocked/done issues. Actual verification returned the unresolved-blockers error in approximately 2.2 seconds, without claiming that an Agent had been woken. Conversation regression tests passed 86/86 and the gateway build passed. Live gate evidence is `evidence/2026-09-04-awwo/codex-live-resume-gate.json`.

The outer browser automation bridge subsequently failed to initialize with a local kernel-assets path error. The already generated Playwright tests were therefore executed directly on the host against the same loopback prototype, using the installed browser runtime; the Agent's sandbox was not relaxed. The actual-app smoke passed at 1440, 768, 375 and 320 pixels. The independent fixture initially passed 13/14 checks and failed modal Tab focus containment. That failure and matching source hashes are frozen under `evidence/2026-09-04-awwo/aww-11-browser-failed-20260904T161201Z/`. A bounded real Codex continuation on AWW-11 was started to repair the failure and await a fresh host browser check. This intermediate result is not recorded as completed acceptance.

The real Codex repair run `72a25f95-a8ad-486d-85d3-0ab01ba10c6e` succeeded at 2026-09-04T16:18:29Z and retained AWW-11's original Codex Session `01a06d0b-2d7a-7bb2-9ef5-3a683487588b`. It changed only the delivered accessibility helper and added a local modal-focus regression test. The regression moved from six failing cases to 8/8 passing; existing DOM checks remained 3/3. The unchanged original browser harness then passed 14/14 on host Chrome 152.0.7977.82, and the actual-app browser smoke passed again. An independent browser comparison replayed the frozen old helper against the same application: its first forward/backward Tab moved to BODY with document focus lost; the new helper retained focus across three presses in each direction and preserved Escape restoration. The replay is explicitly identified as a controlled old-module replay, not a historical live sample. Green reports, screenshots, harness and source hashes are frozen under `evidence/2026-09-04-awwo/aww-11-browser-passed-20260904T161819Z/`.

Synchronization boundary: an externally initiated API continuation produces real server run/comment records, but it does not automatically replace an already-open canvas tab's local `lastOutput`. The original graph's published delivery fields remain its frozen first-pass results. A page reload can retrieve persistent issue comments when the Session is opened; it is not a substitute for the original live SSE transcript. Later review artifacts and evidence are reported separately rather than silently labeled as updated canvas output.

### Final revalidation and closeout

The original review issue AWW-12 resumed automatically after its prerequisites completed. Run `cb0e4332-1797-4bb1-8545-18ced4772991` succeeded at 2026-09-04T16:25:46.772Z. Both its before/after Codex Session IDs equal the original `01a06d17-8ee1-7ee3-9f69-6f6a85c35d37`. The final answer validates as three string fields: `report`, `issues`, `verification`. AWW-12 is done with zero unresolved blockers. The review re-ran the two original defect reproductions and passed 31 model/Unicode checks, four application DOM checks and eight modal-focus checks, while independently reading back the host browser reports and screenshots.

Two already-existing frontend issues also resumed through the control plane. AWW-10 completed successfully and is done; AWW-8's run succeeded and retained a blocked issue status for its broader real-service integration scope. An additional internal screenshot-review issue AWW-18 was created during the final review and completed without a separate Agent run. These are separate from the original seven-run graph. Five checked frontend source hashes remained identical to the passed browser snapshot. Final readback at 2026-09-04T16:26:11Z found zero active runs and zero scheduled monitors.

Canonical follow-up evidence is `evidence/2026-09-04-awwo/codex-live-revalidation.json`. The original graph/input and business-rework evidence hashes remain unchanged. The final real Agent report is `C:/tmp/awwo-codex-live-20260904/513806c8-269e-4221-a536-b52956f519ce/artifacts/reacceptance-20260905/acceptance-report-v2.md`. It closes the two original defects and browser-evidence blocker for this bounded acceptance, while retaining two low-impact visual observations and explicit exclusions for real services, full browser business E2E, full accessibility and production acceptance.

Final local checks: `git diff --check` passed; control-plane health returned `ok`, and both local web previews returned HTTP 200. Worktree/branch/base remain those listed at the start; no commits, integration, PR or remote changes were made. The shared main checkout still has only its pre-existing `CLAUDE.md` modification. Both worktrees retain vendor tree `729b741740efba9dae8807db58db7b730a8a0b93`. The local control plane, gateway and previews remain running for inspection.

The final Agent acceptance report and 57 associated files are also preserved inside this worktree at `evidence/2026-09-04-awwo/codex-live-final-acceptance-20260905/`, with report-copy hash equality verified. The last independent runtime readback at 2026-09-04T16:27:45Z still reports success, same Session, done review, zero active runs and zero monitors. The evidence distinguishes an early observed wake reason from mutable final context metadata rather than inventing an unavailable initial snapshot.
