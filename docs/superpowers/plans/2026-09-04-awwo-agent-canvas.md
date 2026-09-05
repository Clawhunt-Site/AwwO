# AwwO Agent Canvas Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. The operator approved implementation; continue through the tasks without requesting repeated permission.

**Goal:** Deliver a usable AwwO Agent workspace with conversational cards, in-node input/output forms and validated Agent-to-Agent handoff.

**Architecture:** Evolve the existing Session canvas and real gateway conversation transport. Add versioned node contracts without breaking existing documents. Keep runtime selection and execution success governed by existing backend facts.

**Tech Stack:** Existing React 19, TypeScript, Vite, Lucide, react-markdown, Vitest and Testing Library; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-04-awwo-agent-canvas-design.md`

## Global Constraints

- Product copy uses AwwO. Preserve compatibility identifiers and saved documents.
- Development-local verification only. Never fabricate runtime connections or generated content.
- Each worker has its own worktree. Root integrates reviewed file patches; no overlapping ownership.
- Preserve existing history recovery, runtime governance, run snapshots and structural run locks.
- Only related tests/build. Remote changes and packaging are excluded.

## Task 1 — Contract execution

**Owner:** contract worker, `.worktrees/awwo-node-contracts`.

**Files:** `apps/web/src/canvas/nodeContracts.ts` (new), `canvasDoc.ts`, `ports.ts`, `runGraph.ts`; tests `canvas-contracts.test.ts` (new), relevant existing canvas tests.

**Interfaces:** Export `ContractFieldType`, `ContractField`, `NodeContract`, `emptyContract()`, `normalizeContract(value)`, `validateContractFields(fields)` and helpers needed by execution. `SessionNode` gets optional `contract`. Field ids map to `in:<id>`/`out:<id>`.

- [x] Add failing tests for schema persistence, required-value validation, typed links, selected-field handoff and malformed-result blocking.
- [x] Implement additive schema parsing and dynamic ports.
- [x] Include local inputs and output instructions in node prompts. Validate successful result payloads; pass only the connected field to downstream inputs.
- [x] Preserve nodes without contracts and all existing graph execution behaviors.
- [x] Run contract, core, fan-in, scoped-run and transport tests and produce a bounded patch for root review.

## Task 2 — Conversational Agent cards

**Owner:** card worker, `.worktrees/awwo-agent-cards`.

**Files:** `SessionTile.tsx`, `TileComposer.tsx`, new `ContractFields.tsx`, new `awwo-node.css`; tests `canvas-agent-card.test.tsx` and `canvas-contract-fields.test.tsx`.

**Interfaces:** `SessionTile` adds optional `onUpdateNode(node: CanvasNode): void` and `onRunNode(id: string): void`. `ContractFields` accepts `fields: ContractField[]`, `onChange(fields): void`, `readOnly?: boolean`, `label: string`. Contracts match Task 1. Root passes callbacks from the canvas document owner.

- [x] Add failing behavior tests for visible composer, per-card tabs, editing fields and Markdown preview.
- [x] Build legible Agent headers, state labels, conversation/input/output tabs and focus/configure/run actions with Lucide icons.
- [x] Render native form controls for typed fields and a Markdown editing toolbar/preview. Show validation errors and preserve raw content.
- [x] Keep session history/stream state and legacy form display intact.
- [x] Run card, history, sessions and field-editor tests and produce a bounded patch for root review.

## Task 3 — Workspace and responsibility templates

**Owner:** root, `.worktrees/awwo-agent-canvas`.

**Files:** `CanvasSurface.tsx`, new `AgentWorkspace.tsx`, new `agentTemplates.ts`, new `awwo-workspace.css`, `AddNodeMenu.tsx`, `CommandBar.tsx`, `InspectorPanel.tsx`, `App.tsx`, `index.html`, focused workspace tests.

**Interfaces:** Templates create `SessionNode[]` and typed `CanvasEdge[]`; they never create backend agents. Workspace navigation invokes existing focus/add/run/fit methods. Existing graph state stays in CanvasSurface.

- [x] Verify baseline canvas tests before changing behavior.
- [x] Add tests for explicit template creation, session-only defaults, node search/focus and persistence.
- [x] Implement sidebar, project header, empty state, node list, viewport controls and explicit role templates.
- [x] Wire card contract edits, local graph controls and runtime inspector into existing mutations/history.
- [x] Change the visible canvas brand to AwwO while retaining backend/config compatibility names.

## Task 4 — Integration and evidence

- [x] Integrate worker patches and review spec compliance and code quality.
- [x] Run affected canvas/core/contract/transport/component tests and the web build.
- [x] Start an isolated local preview and inspect desktop/narrow layouts in the browser.
- [x] Exercise template creation, node focus, rich-text editing, reload, wiring and refused execution with no runtime.
- [x] Exercise two-node transport with local gateway fixtures and label evidence correctly; use live runtime only if an authorized local runtime is available.
- [x] Capture screenshots, perform independent visual review, fix concrete issues and document results in the handoff.
- [ ] Obtain required advisor review before any commit. Gemini authentication is unavailable; no commit was made. Do not claim remote integration or production acceptance.

## Conversational architecture implementation completed

- Added strict versioned canvas operations, atomic validation and revision conflicts.
- Added welcome requirement composer, persistent planning conversation and collapsible graph assistant.
- Added a real, bounded Codex planning provider on the authenticated local gateway.
- Integrated AI mutations with existing manual editing, Session preservation, undo and graph layout.
- Verified real generation, incremental edits, manual input preservation, reload, undo/redo and cancellation.
- Final related checks: 541 frontend tests, 18 gateway planner tests, frontend/gateway TypeScript builds; see handoff for evidence and execution boundaries.
