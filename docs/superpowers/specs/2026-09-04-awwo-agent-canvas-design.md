# AwwO Agent Canvas — first usable workspace

Approved direction: the operator approved the Agent-to-Agent diagram and requested implementation, with frontend quality the immediate priority (2026-09-04).

## Product

AwwO is a workspace of independent conversational Agent sessions. Each node owns a responsibility, conversation, runtime binding, input form and output form. Connections specify how one Agent's output supplies another Agent's input. Frontend, backend, data governance, user systems, material production and review are responsibility templates of the same session primitive.

The workspace must make the next action obvious: create a draft Agent, describe its responsibility, connect a real runtime, supply inputs, converse, inspect its result and run the connected downstream Agent. Runtime/model/effort choices stay governed by the existing server inventory. Draft nodes are explicitly drafts; templates never invent agents, conversations, successful runs or generated assets.

## Interface

- A calm, light, high-contrast workbench with a compact AwwO identity, project navigation, an Agent list, a canvas header, and a bottom viewport toolbar. Dark mode remains usable.
- Agent cards are legible working surfaces: identity and real status, responsibility, conversation/input/output tabs, composer, and accessible configuration/focus/run actions. Normal-size cards show a composer without requiring an undiscoverable focus gesture.
- Input and output forms live inside the session node. New creation emphasizes responsibility templates and a blank Agent; legacy standalone form nodes remain readable to preserve existing documents.
- The empty state offers an explicit product-development template. Creating it adds only editable draft sessions and typed links. No first-load seeding or fabricated execution.
- The inspector retains runtime binding and configuration; no fake terminal control is presented. Existing runtime execution is resumable CLI conversation, not a PTY.

## Contracts and handoff

`SessionNode.contract?: NodeContract` is an additive versioned schema. `ContractField` contains `id`, `label`, `type`, `required`, `value`; type is `text | markdown | number | boolean | file`. Markdown is the canonical rich-text field serialization. File fields contain references, never implicit file uploads. Old session nodes without contracts retain their legacy context/result ports.

Contract nodes expose `in:<field-id>` and `out:<field-id>` ports. Text and Markdown use the text wire channel; number, boolean and file are typed channels. Required inputs are validated before an Agent starts; wired inputs are resolved from the selected upstream output field. Multi-field results must satisfy their declared output schema before downstream execution. A single text/Markdown output may accept plain text. Failed or malformed output blocks dependent nodes. Manual results must be validated before being published.

Freshness policy: editing execution configuration, an input/output field definition or its value invalidates the existing result and dependent results. Output draft edits require a new validated publication; the UI states this explicitly. Position and size changes do not invalidate results. Connected inputs display the upstream published value and its source, while the local fallback remains stored separately.

Preserve per-node conversation IDs, streaming, topology validation, run snapshots, run locks, scoped execution, undo/redo and existing document recovery. This slice uses the existing graph executor and gateway. Server-persisted graph scheduling, conditional loops and persistent PTY process ownership are subsequent backend changes; do not claim them as implemented by this frontend delivery.

## Acceptance

1. Open a clean workspace, create the explicit development template, and see only independent draft Agent nodes.
2. Edit a rich-text input, switch previews, save/reload and retain content and schema.
3. Connect two compatible fields; incompatible fields are refused. Missing required inputs and malformed outputs cannot run downstream.
4. Two runtime-bound nodes use separate conversation IDs through the existing SSE gateway adapter. A terminal success event, not text alone, determines execution success.
5. User can search/focus an Agent, pan/zoom, inspect inputs/outputs, run a selected node and reopen saved state.
6. Focused unit/component tests, affected build, and browser checks at desktop and narrow widths. Browser fixtures are labeled local fixtures and are not live runtime acceptance.

## Integration boundary

Worktree: `.worktrees/awwo-agent-canvas`, branch `feat/awwo-agent-canvas`, base `feat/workflow-canvas-m1@c8db2818be40511bbb42ad5435028105a738e61c`.

Ruling: continue the Session canvas source discussed and approved in this conversation. Fresh origin fetch found `origin/main@e298e5a87` on a substantially divergent product line (230/4004 commits relative to the canvas feature); no local or remote `dev/server-refactor` exists. This delivery does not merge either line or modify dirty local `main/CLAUDE.md`.

All implementation and checks use development-local intent. No remote write, production deployment, desktop packaging, production data mutation or credential migration is part of this change.


## 2026-09-04 refinement: a workstation inside every component

The user requested a simpler Codex-style layout inside each node. A node now owns a left Session list, an always-visible central conversation, and an optional right delivery drawer. Node responsibilities/runtime settings are secondary configuration; inputs open within the component, and output schema editing is collapsed under the delivery view. The outer canvas uses a compact navigation rail.

The component retains one active Session for execution and can keep several independent conversations. Each has a stable local identifier, real server issue ID when created, binding identity, draft, preview, and historical delivery evidence. Legacy single-Session documents remain readable. Switching never automatically republishes a historical result downstream. Running/binding locks prevent switching or sending into an incompatible execution context. The delivery drawer flag and geometry persist together without creating edit-history entries.


## 2026-09-04 refinement: compact overview and one open workstation

The user requested less visual complexity while retaining all existing functions. The default canvas now displays 260x128 summary cards with identity, status, Session count and delivery summary. Only the focused node displays the full workstation. Opening another node folds the prior one; closing the workstation returns to the compact graph. A collapsed component keeps its conversation store subscription, pending execution, persisted drafts, inputs/outputs and original full workspace dimensions.

Rendering geometry is a pure projection, used consistently for nodes, ports, wires, marquee selection, minimap and viewport fitting. Execution and persistence continue to use document nodes. Full workspaces are resizable; summary cards cannot overwrite their stored workspace dimensions through resizing. Binding locks protect disclosure changes.

An explicit Arrange Layout action positions the existing nodes by dependency layers. It preserves all fields except x/y and records one undo step. Cyclic/unresolved nodes are placed deterministically without unbounded traversal. Existing preview geometry was arranged through this local UI action. Overview labels avoid permanent form/editor controls; field-specific port labels appear on hover/focus. Each node establishes a stacking context so neighbouring ports cannot paint above the focused workstation.


## Personalized component templates

The user's next refinement makes each component a complete role template while keeping the compact overview and a single open workstation. Seven roles are retained; backend services and identity/user management have distinct scopes. Each template owns its inputs, output sections, help text, blank structural placeholders, workflow, acceptance criteria, starter messages, empty-state language and delivery heading. Existing canonical graph ports remain stable.

The add-library uses a role list and an in-place detail preview. The right-click menu keeps immediate creation with a concise role subtitle. Inside a node, a secondary Template control discloses the guide, and two role-specific starters append to the active Session draft. They do not send a message or replace existing drafts. Role identity persists independently from the editable title. Old recognized nodes can display reference guidance without overwriting their forms, configuration, history or published output.

Field help and output structure references participate in the execution prompt and output freshness key. They are metadata, never entered form values, evidence of completion or fabricated output. New output sections use the existing keyed JSON contract; only the linked field is passed downstream. The UI continues to display rich text sections rather than transport JSON.

## Conversational architecture refinement

The first screen is a requirement conversation. A real planning provider receives the current graph, the seven typed template schemas and recent planning intent; it returns versioned operations. The frontend validates and atomically applies them to the same document used by manual editing. On an existing graph the conversation is a collapsible sidebar. Users can request incremental changes or edit contracts, links and layout directly. A stale revision rejects an older AI proposal; each accepted proposal has a single undo step. Planning does not execute Agents or fabricate deliverables. Node Sessions stay independent from the canvas-planning conversation. The gateway provider is configured per environment and retains existing local authentication boundaries. See docs/canvas-planner.md for the API and configuration.
