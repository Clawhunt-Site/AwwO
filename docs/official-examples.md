# AwwO official examples

The workspace home and sign-in page include six authored reference implementations. The gallery can also be opened at `/?examples=1` without an application session. An outer hosting access gate, if configured, still applies. The gallery makes no API requests until a signed-in editor explicitly copies a workflow.

| Example | Working reference | Workflow |
| --- | --- | --- |
| Orbit | Plan, seat and billing-period price calculation; local proposal state | Scope → copy and pricing states in parallel → page → review → delivery |
| Signal Run | A playable 7×7 maze, collectible energy, locked exit, win/loss and reset; focused keyboard and touch controls | Rules → mechanics and visual feedback in parallel → game → regression → guide |
| FIELD | Three-dimensional mesh projection, depth ordering, shading, drag/keyboard orbit, presets, material and zoom | Scene → geometry and controls in parallel → renderer → mathematical checks → guide |
| Knowledge | Editable documents; weighted TF-IDF cosine retrieval, source text and unmatched queries | Corpus → indexing and query evaluation in parallel → interface → citation checks → guide |
| Model Lab | Actual batch gradient descent for logistic regression; 180 training and 60 held-out samples, loss curves, probability regions and prediction | Data → optimization and evaluation in parallel → experiment → numerical review → model card |
| Control | Searchable budget requests, approval/rejection with reason, completion, totals and local action history | Business model → validation/copy and state rules in parallel → operations UI → consistency review → handoff |

## Reuse

Open an example, select **Workflow canvas**, and choose a node to read its task, expected output, acceptance criteria and incoming/outgoing handoffs. Canvas zoom and horizontal scrolling support larger graphs and small screens. **Build your version** includes the full brief and a JSON download.

**Copy to my canvases** posts a complete, independent `CanvasDocument` to the existing tenant canvas endpoint. Every node and edge receives a new ID. Model, runtime, effort, bindings, conversations and outputs are empty; a copy never submits a plan, starts a run, spends model credits, or overwrites the home prompt. Initialize nodes using the workspace engine before execution. Read-only members can inspect and download but cannot create a copy.

Visitors selecting an example before unified sign-in retain only its allowlisted public ID in tab-local storage for 30 minutes. The selection cannot redirect to another origin and does not create anything after sign-in. It is cleared after a successful copy.

## Evidence and limits

These are authored demonstration implementations and executable workflow templates, not a fabricated record of model-generated work. The references run locally in the browser and do not use external services. Knowledge retrieval is lexical, not an enterprise semantic index. Model Lab trains a small classifier on synthetic data, not a large language model. Budget approvals only change local demo state and do not implement server authorization or make payments. FIELD uses perspective projection in SVG, not a GPU engine or a downloadable model.

Each workflow is a six-node DAG with a separate input port for every upstream dependency. Build nodes output a complete HTML artifact; review nodes receive the actual source and must distinguish source review from observed execution. The final node receives both the artifact and review findings. No unsupported feedback execution or invented success history is stored.

## Implementation and checks

- `apps/web/src/saas/examples/officialWorkflows.ts`: bilingual catalog and document factory.
- `OfficialExamples.tsx` and `official-examples.css`: gallery, graph inspector and reuse/download controls.
- `CreativeDemos.tsx`: configurator, game and projected 3D scene.
- `IntelligenceDemos.tsx` / `intelligenceMath.ts`: retrieval, training and operations.
- `officialSelection.ts`: bounded sign-in handoff.
- `WorkspaceHome.tsx` / `SaaSApp.tsx`: homepage and existing API integration.

Run `npm run test:saas --prefix apps/web`, `npm run typecheck:saas --prefix apps/web`, and `npm run build:saas --prefix apps/web`. The official workflow tests exercise real frontend graph validation and scheduler handoffs with fixture executors; demo tests exercise the actual game and learning/retrieval algorithms. These tests do not make paid provider calls.

For a local browser preview, run `npm run dev:saas --prefix apps/web` and open `/?examples=1`. Verify each demo, both languages, graph selection/zoom, JSON download, the authenticated copy action, and a mobile viewport. Deployment must be verified separately from build and test success.
