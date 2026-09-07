# AwwO conversation turn lifecycle

This acceptance implementation targets the vendored Node API shipped with AwwO v0.3.0, one Gateway process, and a private server with one operator. A browser request owns one comment-driven native run. Native terminal status and the canvas output contract determine the result; parking the conversation never marks an issue `done`.

## First request and recovery

New operation journals declare `deliveryMode: "comment"`. The Gateway creates an assigned issue in `backlog`, then posts the user's message through `/api/issues/:id/comments`. The official assignment-wake service skips backlog creation. Comment wakes are excluded from successful-run-handoff recovery and from the required-comment retry policy. Subsequent requests use the same comment route, with the native resume gate for `done` or `blocked` issues.

The durable boundaries are independent:

1. `mutation-started.json` reserves issue creation. A unique operation label permits readback after a lost creation response.
2. `container.json` confirms only the passive conversation container. It does not confirm message delivery.
3. `comment-started.json` reserves one comment insertion.
4. `issue.json` records the confirmed comment ID; `run.json` records its exact native run.

Comment metadata contains an operation UUID and request digest. A lost comment response is reconciled with a bounded, issue-scoped read. Ambiguous, absent or differently scoped evidence remains uncertain; the Gateway does not replay the comment. A container recovered before comment insertion can be continued by an explicit retry of the same request. GET recovery never creates a container, comment, run or hold.

Old journals without `deliveryMode` retain their original todo-creation semantics. They are not reinterpreted as undelivered comments.

## Parking a terminal turn

`POST /api/conversations/:companyId/agents/:agentId/issues/:issueId/settle`

Request: `{ "runId": "<native run UUID>" }`

Confirmed response, HTTP 200:

```json
{
  "confirmed": true,
  "status": "succeeded",
  "holdId": "<native hold UUID>",
  "stoppedAutomaticRunIds": []
}
```

`status` is the actual `succeeded`, `failed`, `cancelled` or `timed_out` native state. HTTP 409 returns `{ "confirmed": false, "detail": "..." }`; an invalid run ID returns 400 and an unavailable settlement implementation returns 503. The existing loopback and Gateway-token gates apply.

Before creating a hold, the Gateway verifies the issue binding, exact terminal run, run ordering, comments, and isolated issue scope. A newer user run, a newer user comment whose run is not visible yet, a child issue, or an unattributed execution prevents settlement. The Gateway serializes dispatch and settlement for the same company/Agent, including first requests that do not yet have an issue ID.

The exact source comment must appear once in the bounded comment readback. Its timestamp, rather than the later native run timestamp, anchors comparison with other comments. A comment with the same timestamp has ambiguous ordering and prevents settlement regardless of UUID or returned array position. Only comments attributed to the exact source run or its verified automatic continuation chain are treated as that turn's evidence. Missing, duplicate or invalid source-comment evidence keeps settlement unconfirmed. Older assignment-driven runs without a comment anchor also remain unconfirmed; they must not release the UI recovery lock or publish a successful result through this protocol.

Known system continuations must refer to this source run or its already verified continuation chain. They may be stopped because the user turn has ended. Their actual cancelled native IDs appear in `stoppedAutomaticRunIds`. The native hold's persisted member snapshot also identifies a system continuation that started between preview and hold creation.

The native creation schema accepts `metadata` but its hold service does not persist that field. Ownership therefore uses the persisted `releasePolicy.note`: `awwo_agent_canvas:settle:<runId>` or `awwo_agent_canvas:stop:<runId>`. The exact older Stop reason, `Stopped by AwwO Agent canvas`, remains recognized. User-created holds are preserved. On the next explicit request, the Gateway releases only its own hold.

Every explicit send discovers all active root pause holds and reads `/tree-control/state`, including after a Gateway restart. The ordinary native comment path can wake an `in_progress` issue while a pause hold remains active, so a successful comment or an expected 409 cannot prove release. Multiple owned Stop and settlement holds must all be released and read back absent, with no remaining effective or inherited pause state, before dispatch. Manual, inherited or unreadable pause state prevents dispatch; no manual hold is released.

`settlements/<runId>/request.json` reserves native hold creation. If the response is lost, an exact persisted note permits readback across a Gateway restart. If no hold can be established by readback, another creation is refused. The UI must retain recovery state until it receives `confirmed: true`.

## Native API boundary

The native tree-hold API has no expected-run revision or compare-and-set option, and pause creation can cancel active subtree runs. This implementation does not provide atomic isolation against a second Gateway process, another direct native API writer, or simultaneous external subtree edits. The private single-operator acceptance setup is the supported boundary. Moving to shared or multiple-Gateway deployment requires a conditional native hold/dispatch primitive or equivalent server-level coordination.

Comment dispatch removes the immediate successful-run-handoff extra turn. It does not disable the kernel's separate periodic stranded-issue recovery; the confirmed pause hold is what parks a completed conversation against that recovery. A resumed user request releases the hold through an existing native API before its comment insertion, so those two native writes also do not constitute a cross-process transaction.

All participating browser tabs must load the same reviewed client revision. An already-loaded older client does not implement the settlement barrier and can clear shared recovery state without confirming a hold. A Gateway update cannot add that barrier to JavaScript already running in another tab; reload all tabs before validating restart/recovery behavior. Mixed old/new clients are outside this acceptance guarantee.

## Local validation

On 2026-09-06, Gateway `tsc -p tsconfig.json --noEmit` and the complete `src/conversation` Vitest group passed: 11 files, 189 tests. Coverage includes response loss, restart, concurrent mutation reservation, old journals, exact comment attribution (including legacy calls without an operation ID), rejected/uncertain delivery, all terminal statuses, stale settlement, source-comment ordering and missing anchors, system continuation receipts, manual-hold preservation, and HTTP authentication/validation. Web scoped-run and revision-race checks passed separately: 14 files, 138 tests.

These are local contract tests. Remote acceptance must additionally verify a fresh first Session, native comment wake context, the persisted hold note, Gateway restart followed by continuation of the same Session, and the absence of unexpected user-turn cancellation.

The private remote acceptance on 2026-09-06 completed those checks. The original restart failure is retained separately; acceptance.4 passed owned-hold release, preserved manual pause state, original-Session continuation and an exact two-run/two-node graph. acceptance.5 then passed same-version cross-tab recovery with one new native run, one user/Agent reply per tab, correct history order and retained published deliverables. Final full-database active runs, pending wakeups and Codex processes were zero. The detailed evidence and deployment boundary are recorded in [server acceptance results](awwo-server-acceptance-results-2026-09-06.md).
