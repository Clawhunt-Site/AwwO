# AwwO official industry systems

The home page and sign-in page now distinguish **12 flagship industry systems** from the **6 starter studies**. The public entry is `/?examples=1`; a direct example link is `/?examples=1&official=<allowlisted-id>`. Hosting access gates still apply. Viewing the collection does not request credentials or call a model. The public page opens a split-screen example above the searchable collection.

For step-by-step Chinese walkthroughs, see the [industry tour](official-industry-tour.zh-CN.md).

## Flagship collection

Each system is a local, interactive reference with connected state, multiple views, synthetic domain data and deterministic calculations. Different actions affect the same underlying business model; metrics are computed from that model.

| Industry / reference | What to explore | An exception to try |
| --- | --- | --- |
| Games — **KEPLER** colony command | Seeded map, infrastructure connectivity, resource production, maintenance, technology, weather, mission goals and replayable actions | Build disconnected infrastructure, exhaust life support or replay the same seed |
| Logistics — **NEXUS** urban dispatch | Directed shortest paths, two depots, four vehicles, capacity, delivery windows, assignment policies and route progress | Close a bridge, isolate a destination or tighten windows |
| Enterprise R&D — **ATLAS** evidence workspace | Document versions, passage BM25, role visibility before indexing, entity evidence, explicit claim differences and query evaluation | Switch visible roles, change a source version or compare conflicting values |
| Architecture — **HABITAT** digital twin | Three-dimensional buildings and floors, camera controls, asset selection, live local sensor scenarios, maintenance and energy comparison | Inspect an affected floor and compare operating scenarios |
| Retail — **MERIDIAN** fulfillment | Multi-item baskets, three warehouses, reservations, approval, shipping, whole-order returns, refunds and margin reconciliation | Reserve beyond available stock or transfer goods already reserved |
| Machine learning — **FOUNDRY** experiments | Separate training/validation/test partitions, logistic regression and a decision stump, parameter trials, confusion matrix, ROC, thresholds, cost and drift | Change the threshold and compare errors, or introduce distribution shift |
| Media — **FRAME** production | Multi-track timeline, storyboard preview, materials, dependencies, versions, budget and production checks | Create a timing/dependency problem and inspect the generated production record |
| Manufacturing — **FORGE** scheduling | BOM inventories, shifts, machines, dependent operations, Gantt scheduling, downtime and quality quarantine | Reduce materials, stop equipment or fail a quality check |
| Education — **CAMPUS** learning paths | Prerequisite graph, question feedback, mastery updates, explainable recommendations, time budgets and learning history | Attempt a locked prerequisite or reduce the available study budget |
| Hospitality — **STAY** revenue scenarios | Room types, dated inventory, pricing, channel commission, reservations, cancellations and demand scenarios | Attempt an overbooking, cancel a booking and check availability recovery |
| Energy — **FLUX** microgrid | Twenty-four-hour load, solar, tariffs, battery state of charge, power/efficiency constraints, policy comparison and energy balance | Introduce an outage, change solar/load or lower battery capacity |
| Professional services — **CLAUSE** delivery review | Synthetic contract versions, line differences, explicit obligations, simulated deadlines, source-linked findings and versioned review records | Add an impossible date or edit a reviewed version |

The six original studies remain available under **Starter studies**: Orbit pricing, Signal Run maze, FIELD 3D projection, Knowledge retrieval, Model Lab logistic regression and Control budget approvals. Their existing IDs and links remain valid.

## Process and result together

The default **Workflow + result** tab keeps a dependency-stage rail on the left and the working result on the right. Select a node to inspect its output and real upstream/downstream contracts; the optional play control explains successive DAG stages, including parallel branches. It is a local tour, not a replay of provider timestamps or a new model run. It never marks unexecuted nodes successful.

The result remains mounted when selecting nodes, focusing the result, or visiting the canvas/reuse tabs. **Reset result** explicitly starts the embedded result again. Switching cases starts a fresh case. Smaller screens stack the panes, and embedded systems use their container width for layout.

**Browser-checked model output** entries use curated artifacts rather than the authored reference. The initial collection contains Signal Run (6/6 completed), Orbit pricing (5/6, guide quota failure), Model Lab (4/6, numerical review quota failure and blocked model card), and FLUX (a continuation with 2/4 completed and five reused inputs; final delivery failed HTML validation). Game, training and energy outputs explicitly disclose their official QA revisions. Their run receipts retain failed/blocked nodes and separate newly executed steps from reused upstream results. A completed build can be useful even when the guide or final delivery failed; these are not advertised as successful whole-graph runs. Original output and any explicit QA revision have separate SHA-256 digests. Public receipts exclude tenant, canvas, session and private run identifiers; original evidence remains private.

Generated HTML is rendered only for its selected case and runs inside the existing artifact sanitizer with an opaque `allow-scripts` iframe sandbox. It receives no same-origin, navigation, popup, form, network or credential access. Checked-in source strings are inert data, never inserted into the parent DOM. Reuse still creates a clean draft rather than copying execution history.

## Explore the orchestration

Every flagship carries 12–13 domain-specific nodes. The gallery shows the actual node and handoff counts. The workflow view includes:

- A node directory that moves to the selected node in the canvas.
- Zoom and fit controls for large graphs.
- A dependency-chain view that highlights transitive ancestors and descendants.
- Node tasks, concrete output contracts, acceptance criteria, and clickable upstream/downstream handoffs.
- Parallel work, merges, review, a finite repair pass and delivery with review evidence.

The displayed graph is compiled into the actual `CanvasDocument`; it is not a separate decorative diagram. The repair pass is an ordinary dependency path, not unsupported scheduler looping or conditional execution. Each upstream result has its own required input port. Reviewers must distinguish source inspection from observed execution.

## Reuse

**Copy to my canvases** opens a setup dialog and uses the existing tenant canvas endpoint. The default copies an unconfigured draft. Alternatively, choose an available workspace runtime and model to apply to every copied session node; availability is checked again before creation. Both options create fresh identities without credentials, bindings, history or invented outputs. Copying never submits a model request or initializes execution. Run the copied canvas explicitly when ready. Reader members can inspect and download but cannot create copies. Downloaded reference JSON stays unconfigured.

After a run, **Export this graph’s evidence** collects the selected graph's frozen canvas, node run records, evidence summaries and paginated model invocation ledger through the current workspace permissions. It marks active, changed, incomplete or bounded observations, and cancels if the graph/workspace changes or authorization is lost. Raw event archives are linked; artifact bodies and team turns are not included. The download contains private task content and is not a redacted public-sharing artifact. Complete records do not establish that the generated application passed human acceptance.

The **Build your version** tab provides the full brief, expected deliverables and downloadable canvas JSON. An allowlisted example selection survives sign-in for 30 minutes in tab-local storage. Existing invitation validation is preserved; arbitrary redirect URLs are not carried across sign-in.

## Evidence and scope

Entries labeled **Interactive reference** are authored implementations and reusable workflows. Entries labeled **Model-generated result** or **QA revision** have an explicit curated run snapshot and browser acceptance record. A reference is not evidence that an agent generated it, and a node result does not prove the entire graph completed. All business data is synthetic and computations run locally. Simulated roles are not server authorization; local orders, approvals, dispatch, registry actions and deadlines do not contact production systems. Knowledge retrieval is lexical, claim differences require human interpretation, and model training uses small synthetic data rather than LLM fine-tuning. Contract examples illustrate explicit rules rather than legal judgments. Currency, taxes, prices and rates are fictional example inputs.

An implementation being visible, a graph being valid, a model run succeeding and production deployment are separate acceptance claims. Hosting the references does not prove the future generated artifacts will have identical behavior.

## Implementation

- `examples/advanced/*Catalog.ts`: complete domain briefs, data scope and step contracts.
- `examples/advanced/*Engine.ts`: pure scenario algorithms and state transitions.
- `examples/advanced/Advanced*Demos.tsx`: interactive systems, loaded on demand.
- `examples/advanced/industryWorkflow.ts`: checked topological compilation and graph metrics.
- `examples/advanced/catalog.ts`: industry catalog registry.
- `examples/OfficialExamples.tsx`: discovery, direct links, graph exploration and reuse.
- `examples/OfficialShowcase.tsx`: simultaneous dependency tour and persistent interactive result.
- `examples/generatedRecords.ts` and `examples/generated/*`: sanitized public run receipts and curated artifact strings.
- `examples/GeneratedOfficialDemo.tsx`: lazy, sandboxed HTML presentation using the existing artifact security policy.
- `examples/officialWorkflows.ts`: starter catalog plus clean document generation.

All paths above are relative to `apps/web/src/saas/`.

```sh
npm run test:saas --prefix apps/web -- --maxWorkers=2
npm run typecheck:saas --prefix apps/web
npm run build:saas --prefix apps/web
VITE_AWWO_WEB_PORT=5196 npm run dev:saas --prefix apps/web
```

Algorithm tests check invariants and meaningful edge cases: inventory conservation, resource connectivity, energy balance, scheduling constraints, train/validation/test isolation and source visibility. Graph tests use the real frontend scheduler with fixture executors and verify failure blocking. No paid provider calls are made by these tests. Actual browser acceptance should exercise the industry exceptions, linked totals, responsive layouts, graph navigation, locale switching and exports. Deployment is verified separately.
