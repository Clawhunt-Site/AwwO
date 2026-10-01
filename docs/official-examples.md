# AwwO official industry systems

The home page and sign-in page now distinguish **12 flagship industry systems** from the **6 starter studies**. The public entry is `/?examples=1`; a direct example link is `/?examples=1&official=<allowlisted-id>`. Hosting access gates still apply. Viewing the collection does not request credentials or call a model.

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

## Explore the orchestration

Every flagship carries 12–13 domain-specific nodes. The gallery shows the actual node and handoff counts. The workflow view includes:

- A node directory that moves to the selected node in the canvas.
- Zoom and fit controls for large graphs.
- A dependency-chain view that highlights transitive ancestors and descendants.
- Node tasks, concrete output contracts, acceptance criteria, and clickable upstream/downstream handoffs.
- Parallel work, merges, review, a finite repair pass and delivery with review evidence.

The displayed graph is compiled into the actual `CanvasDocument`; it is not a separate decorative diagram. The repair pass is an ordinary dependency path, not unsupported scheduler looping or conditional execution. Each upstream result has its own required input port. Reviewers must distinguish source inspection from observed execution.

## Reuse

**Copy to my canvases** uses the existing tenant canvas endpoint. Copies have fresh identities and no model, runtime, credentials, bindings, history or invented outputs. Copying creates a draft; it does not run a planner, submit a model request, spend credits, or overwrite the home prompt. Initialize nodes with a configured workspace engine, choose models and execute when ready. Reader members can inspect and download but cannot create copies.

The **Build your version** tab provides the full brief, expected deliverables and downloadable canvas JSON. An allowlisted example selection survives sign-in for 30 minutes in tab-local storage. Existing invitation validation is preserved; arbitrary redirect URLs are not carried across sign-in.

## Evidence and scope

These are authored reference implementations and workflows awaiting execution. They are not fabricated evidence that an agent generated or deployed the reference. All business data is synthetic and computations run locally. Simulated roles are not server authorization; local orders, approvals, dispatch, registry actions and deadlines do not contact production systems. Knowledge retrieval is lexical, claim differences require human interpretation, and model training uses small synthetic data rather than LLM fine-tuning. Contract examples illustrate explicit rules rather than legal judgments. Currency, taxes, prices and rates are fictional example inputs.

An implementation being visible, a graph being valid, a model run succeeding and production deployment are separate acceptance claims. Hosting the references does not prove the future generated artifacts will have identical behavior.

## Implementation

- `examples/advanced/*Catalog.ts`: complete domain briefs, data scope and step contracts.
- `examples/advanced/*Engine.ts`: pure scenario algorithms and state transitions.
- `examples/advanced/Advanced*Demos.tsx`: interactive systems, loaded on demand.
- `examples/advanced/industryWorkflow.ts`: checked topological compilation and graph metrics.
- `examples/advanced/catalog.ts`: industry catalog registry.
- `examples/OfficialExamples.tsx`: discovery, direct links, graph exploration and reuse.
- `examples/officialWorkflows.ts`: starter catalog plus clean document generation.

All paths above are relative to `apps/web/src/saas/`.

```sh
npm run test:saas --prefix apps/web -- --maxWorkers=2
npm run typecheck:saas --prefix apps/web
npm run build:saas --prefix apps/web
VITE_AWWO_WEB_PORT=5196 npm run dev:saas --prefix apps/web
```

Algorithm tests check invariants and meaningful edge cases: inventory conservation, resource connectivity, energy balance, scheduling constraints, train/validation/test isolation and source visibility. Graph tests use the real frontend scheduler with fixture executors and verify failure blocking. No paid provider calls are made by these tests. Actual browser acceptance should exercise the industry exceptions, linked totals, responsive layouts, graph navigation, locale switching and exports. Deployment is verified separately.
