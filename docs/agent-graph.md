# Agent Graph

AwwO supports two collaboration modes. **Workflow** runs the same-round data connections once. **Review Graph** repeats that DAG using explicit feedback from the preceding round, until the selected reviewer approves or the round limit is reached.

## Start a review loop

1. Select the Agent that will create a deliverable. Define its task inputs and output fields.
2. Open **Graph settings → Add review partner**. AwwO adds an independent reviewer Session, a typed deliverable input, a boolean approval output, and a feedback connection back to the producer.
3. Bind the new reviewer to a real Agent and check its acceptance criteria. The shortcut copies currently filled producer requirements as an editable starting point.
4. Set the round limit (1–5). Choose the final review node and its boolean approval field.
5. Start review. `true` approves; `false` passes the review feedback into the next round. Reaching the limit without approval is an unsuccessful review, never a completed delivery.

Select a connection on the canvas or in Graph settings to choose **same-round result** or **next-round feedback**. Same-round connections must remain acyclic. Feedback must return to an ancestor of its source and contribute to the final review. The final reviewer is the end of the same-round graph. On the first round feedback is absent, so required feedback inputs need an explicit seed value.

Review mode runs the complete canvas. Every node must reach the final reviewer through same-round data connections; detached or unreviewed branches are rejected before dispatch. Scoped node execution is refused with an explanation; independent manual conversations remain available when no graph execution owns the canvas. Switching back to Workflow preserves feedback connections as inactive structure; scoped Workflow runs follow data connections only.

The canvas assistant can also create or update the mode, review policy, HTML fields and connection roles. The existing preview/apply, conflict checks, structural locks and undo behavior still apply. Plans cannot bind Agents, dispatch runs or fill output values.

## Delivery formats

Choose **HTML (.html)** or **Markdown (.md)** in a node's output form. HTML requires a complete document with explicit `html`, `head` and `body` elements. A single HTML field accepts document source, one complete HTML code fence, or its declared JSON field; multi-field output follows the keyed JSON contract. Invalid content blocks downstream execution and remains available as failed-run evidence.

Markdown includes ordinary prose; the application does not invent a requirement for headings or list syntax. HTML/Markdown downloads contain the validated published response. HTML source is escaped, not executed in the application. A `file` field is still a reference: this feature does not prove that a file exists in an Agent's workspace.

## Execution and recovery

Each native turn receives a fresh operation ID which is saved before dispatch. A node continues its original Session across rounds. Intermediate outputs stay in the run journal; final publication applies one coherent batch so a feedback cycle cannot invalidate its own successful outputs.

Stop uses the existing native cancellation and settlement path. Uncertain execution keeps its recovery lock. Reload reads exact operation/run identities without dispatching another turn; an interrupted review cannot become approved merely because its last observed native calls succeeded. Outputs from an unapproved review are partial and are rejected as downstream cached deliverables.

Connections show direction at rest. Animation indicates a real transfer into a running node, with distinct waiting, delivered, failed, blocked and cancelled states. Feedback animation begins only when a later round receives prior feedback. Reduced-motion settings keep the arrows and state colors while disabling motion.
