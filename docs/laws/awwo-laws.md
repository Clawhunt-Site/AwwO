# AwwO laws

The observable invariants of the AwwO SaaS. How to read, cite, add and retire them: [README](README.md).

Evidence paths are repo-relative and were checked against this tree on 2026-10-15. PostgreSQL tests
(`TestPostgres*`) skip without `AWWO_TEST_DATABASE_URL`, and a skipped test is not evidence.
`no automated check yet` marks a debt, not a pass.

| ID | Area | Law in brief |
| --- | --- | --- |
| AWWO-LAW-001 | Tenancy | Another tenant's resource answers 404 |
| AWWO-LAW-002 | Tenancy | References between tenant rows are composite foreign keys |
| AWWO-LAW-003 | Tenancy | Authorization is re-checked inside the write transaction |
| AWWO-LAW-004 | Runs | A run completes only on a real, stored answer |
| AWWO-LAW-005 | Runs | An operationId makes run creation idempotent |
| AWWO-LAW-006 | Runs | Run events are committed before they are streamed |
| AWWO-LAW-007 | Runs | A reconnect replays from the database and never re-runs the model |
| AWWO-LAW-008 | Runs | Quota and plan admission is atomic with the run insert |
| AWWO-LAW-009 | Canvas | Canvas saves are compare-and-swap on the version read |
| AWWO-LAW-010 | Models | Untrusted content reaches models only as quoted user-message data |
| AWWO-LAW-011 | Workers | Workers expose no tool outside the fixed allowlist |
| AWWO-LAW-012 | Workers | Workers connect only to their configured endpoints |
| AWWO-LAW-013 | Models | Requests stay byte-identical while no new feature is in use |
| AWWO-LAW-014 | Network | Server-side fetches dial only public addresses, checked at connect time |
| AWWO-LAW-015 | Network | Server-side page fetches obey robots.txt |
| AWWO-LAW-016 | Network | Network scanning and probing fails closed |
| AWWO-LAW-017 | Secrets | Secrets and provider keys never reach the browser |
| AWWO-LAW-018 | Product | Media models are shown only by generic names |
| AWWO-LAW-019 | Database | Shipped migrations are never edited |
| AWWO-LAW-020 | Database | New migrations are idempotent |
| AWWO-LAW-021 | Database | New migrations set a local lock timeout |
| AWWO-LAW-022 | UI | zh and en UI strings stay in parity |
| AWWO-LAW-023 | Source | Source files use LF line endings |
| AWWO-LAW-024 | Source | Source files contain no hidden Unicode or control characters |
| AWWO-LAW-025 | Process | While CI is paused, pushes carry their passed local gates |

## Tenancy

### AWWO-LAW-001: Another tenant's resource answers 404

- **Law.** A request that names a resource of another tenant, or a tenant the caller does not belong to, MUST
  answer 404, the same status as for an id that does not exist.
- **Why.** A 403 or a different answer would confirm that the id exists, which leaks other customers' data and
  helps anyone enumerate it.
- **Evidence.** `backend/internal/app/app_test.go` (`TestPostgresTenancyAuthenticationAndCAS`,
  `TestPostgresRunsSSEIdempotencyCancellationAndAdmin`); `backend/internal/app/artifacts_test.go` (a second
  tenant reading a deliverable); `backend/internal/app/knowledge_test.go`
  (`TestPostgresKnowledgeArtifactCopyDeduplicationAndTenantIsolation`).

### AWWO-LAW-002: References between tenant rows are composite foreign keys

- **Law.** A foreign key from one tenant-owned table to another MUST include `tenant_id` on both sides, as in
  `FOREIGN KEY (tenant_id, canvas_id) REFERENCES canvases (tenant_id, id)`.
- **Why.** Even a query that forgets its tenant filter then cannot link tenant A's session to tenant B's agent
  or canvas: the database refuses the write.
- **Evidence.** The constraints in `backend/internal/app/migrations/001_initial.sql` and
  `backend/internal/app/migrations/019_knowledge.sql`, which PostgreSQL enforces on every write. No automated
  check that a new table follows the rule.

### AWWO-LAW-003: Authorization is re-checked inside the write transaction

- **Law.** A tenant write MUST re-check the caller's membership, role and the tenant's status after locking the
  tenant row, in the same transaction that performs the write.
- **Why.** Reading a request body or waiting for a lock can outlast a removal, a downgrade or a suspension; the
  middleware's earlier yes is then stale, and only the in-transaction check sees what the write commits against.
- **Evidence.** `backend/internal/app/invitations.go` (`lockTenantRow`, `mutationRole`);
  `backend/internal/app/authorization_test.go` (`TestPostgresMutationRechecksAuthorizationAfterBodyWait`,
  `TestPostgresBodylessMutationRechecksAuthorization`).

## Runs

### AWWO-LAW-004: A run completes only on a real, stored answer

- **Law.** A run MUST NOT be marked `completed` unless the model returned an answer without error or
  interruption and that answer was persisted; an HTTP 200, an accepted request, a stream that ends without a
  terminal event, or reasoning with no answer is not a completion.
- **Why.** A false "completed" is the worst failure a delivery product can have: the user trusts output that
  never existed, and downstream nodes build on it.
- **Evidence.** `backend/internal/app/app_test.go` (`TestPostgresRunFailuresAndStreamRevocation`: a stream that
  ends without completing fails as `runtime_stream_ended`, a final text that contradicts its deltas as
  `inconsistent_runtime_output`); `backend/internal/app/reasoning_leak_test.go`
  (`TestPostgresReasoningOnlyOutputFailsWithoutStoringTheScratchpad`);
  `backend/internal/app/invocation_ledger_test.go` (`TestPostgresInvocationLedgerAtomicAndIdempotent`);
  `backend/internal/app/media_runs_test.go` (`TestPostgresMediaRunFailuresSettleWithClosedCodes`, including
  `media_no_output`); `apps/pi-worker/worker.test.mjs` ("model-requested tools cannot execute or create a
  successful response").

### AWWO-LAW-005: An operationId makes run creation idempotent

- **Law.** A run request that repeats an operationId already used in the tenant MUST return the original run
  without executing again when the request is the same, and MUST answer 409 when it differs.
- **Why.** Clients retry after timeouts and double clicks; without the key a retry pays for and runs the model a
  second time. The key deduplicates runs; it does not make a provider's side effects exactly-once.
- **Evidence.** `backend/internal/app/app_test.go` (`TestPostgresRunsSSEIdempotencyCancellationAndAdmin`: the
  same request returns the same run after one model call, a changed prompt is 409;
  `TestPostgresPlannerAndConcurrentIdempotency`: four concurrent requests yield one run);
  `backend/internal/app/invocation_ledger_test.go` (`TestPostgresInvocationLedgerAtomicAndIdempotent`).

### AWWO-LAW-006: Run events are committed before they are streamed

- **Law.** A run event MUST be committed to PostgreSQL before any SSE client receives it.
- **Why.** A client must never see an event that a rollback or a crash could erase; the database is the record
  that replay, recovery and billing read.
- **Evidence.** `backend/internal/app/run_event_notify_test.go` (`TestRunEventsWakeAfterCommittedDelta`,
  `TestAppendDeltaFailureIsAtomic`, `TestAppendDeltaNeverCommitsAfterTerminalEvent`).

### AWWO-LAW-007: A reconnect replays from the database and never re-runs the model

- **Law.** Reconnecting to a run's event stream MUST replay the committed events after the client's
  `Last-Event-ID` from the database, without dispatching the model again.
- **Why.** Connections drop; a reconnect that re-ran the model would double the cost and could show a different
  answer from the one the user already saw. After an API restart, a run whose outcome is unknown becomes
  `interrupted` rather than being sent again.
- **Evidence.** `backend/internal/app/app_test.go` (`TestPostgresRunsSSEIdempotencyCancellationAndAdmin`: a
  `Last-Event-ID` reconnect resumes after the cursor with one model call in total, and a queued run left by a
  crash becomes `interrupted` on restart); `backend/internal/app/authorization_test.go`
  (`TestPostgresSSEHeartbeatForcesAuthorizationAfterReplayPhaseShift`).

### AWWO-LAW-008: Quota and plan admission is atomic with the run insert

- **Law.** The quota and plan check that admits a run MUST happen in the same transaction that inserts the run,
  under the tenant row lock.
- **Why.** Checking first and inserting later lets parallel requests all take the last unit of an allowance,
  and every overshoot is spent on AwwO's shared provider accounts.
- **Evidence.** `backend/internal/app/runs.go` (`createRun`: `mutationRole` locks the tenant row, then the
  active runs and today's calls are counted and the run is inserted in that transaction);
  `backend/internal/app/plans.go` (`planRunSlot`); `backend/internal/app/app_test.go` (429 once
  `maxRunsPerDay` is used up); `backend/internal/app/teams_test.go`
  (`TestPostgresTeamQuotaCancellationAndSnapshots`). No test yet races two requests for the last unit.

## Canvas

### AWWO-LAW-009: Canvas saves are compare-and-swap on the version read

- **Law.** A canvas save MUST succeed only for the version it was based on; a stale version is refused with 409
  and never overwrites or merges into the newer document.
- **Why.** Two tabs, two members or a late autosave would otherwise destroy each other's edits without a
  trace; on a 409 the browser keeps the refused edit as a draft the user can restore or export.
- **Evidence.** `backend/internal/app/app_test.go` (`TestPostgresTenancyAuthenticationAndCAS`);
  `backend/internal/app/node_setup_test.go` (`TestPostgresInitializeConcurrentCASAndAtomicFailure`);
  `apps/web/tests/saas-drafts.test.tsx` ("reload_after_409 retains the local draft, blocks the editor and never
  overwrites the newer cloud version").

## Models and workers

### AWWO-LAW-010: Untrusted content reaches models only as quoted user-message data

- **Law.** Untrusted content (knowledge evidence, imported web pages, memory notes, uploaded files and upstream
  file deliverables) MUST reach a model only inside the user message, quoted as data behind an explicit
  untrusted-data boundary, never as system instructions.
- **Why.** Text from outside the conversation can carry instructions (prompt injection); quoted, labelled and
  kept at user-message priority, it stays below the operator's and the node's own instructions instead of
  posing as one of them. Skills are not in this class: a workspace chooses them as instructions, and they carry
  their own guard line.
- **Evidence.** `backend/internal/app/knowledge_test.go` (`TestPostgresKnowledgeRunInjectionAndEvidence`: the
  evidence is in the prompt, not the system prompt, which carries `knowledgeEvidenceBoundary`);
  `backend/internal/app/uploads_test.go` (`TestFreezeUploadAttachmentsQuotesTextAndDescribesMedia`);
  `backend/internal/app/uploads_postgres_test.go` (`TestPostgresUploadedFilesGoWithTheMessage`);
  `backend/internal/app/graph_file_inputs_test.go`
  (`TestGraphTextFilePromptPreservesExactStoredBytesAndReferences`). Imported web pages become knowledge
  sources (`backend/internal/app/webread_import.go`) and memory notes are framed by `memoryNotesBoundary`
  (`backend/internal/app/memory.go`); no automated check yet follows either path end to end.

### AWWO-LAW-011: Workers expose no tool outside the fixed allowlist

- **Law.** A worker MUST offer a model only the tools in the code-defined allowlist for its runtime and mode
  (Pi: none; an OpenAI Agents single call: `calculator` and `current_time`; workspace and managed execution:
  their sandboxed workspace tools), and MUST refuse a request that names any other tool.
- **Why.** A tool is authority; if a request or a model could name its own tools, a prompt injection would
  become code execution.
- **Evidence.** `apps/pi-worker/worker.test.mjs` (tools stay disabled; a request carrying `tools` is rejected;
  model-requested tools cannot execute); `apps/openai-agents-worker/config.test.mjs` ("strict request fields,
  roles and dual tool allowlists reject executable or secret input");
  `apps/openai-agents-python-worker/test_runner.py`; `backend/internal/app/runtime_workers.go`
  (`runtimeTools`); `backend/internal/app/teams_test.go` (`TestTeamRejectsUnsupportedConfiguration` refuses a
  `bash` tool); `backend/internal/app/computer_queue_test.go` (`TestComputerAutoAllowPolicy` refuses tools
  outside the workspace).

### AWWO-LAW-012: Workers connect only to their configured endpoints

- **Law.** A worker process MUST connect only to the model endpoints named in its server-side configuration,
  refusing redirects and any endpoint, base URL or credential supplied in a request.
- **Why.** If a request or a redirect could move a worker's connection, a tenant could send AwwO's provider key
  to a server of their choosing, or reach internal addresses from inside AwwO.
- **Evidence.** `apps/openai-agents-worker/history-boundary.test.mjs` ("fetch guard forwards only the exact
  endpoint, with redirects refused"); `apps/pi-worker/worker.test.mjs` ("request schema accepts catalog
  selectors but rejects execution overrides": `provider`, `baseURL`, `apiKey` and `env` are refused);
  `apps/openai-agents-worker/config.test.mjs` (strict request fields refuse `apiKey`); `apps/pi-worker/usage.mjs`
  (provider fetches use `redirect: 'error'`; no Pi test of redirects yet). The Python worker: no automated
  check yet.

### AWWO-LAW-013: Requests stay byte-identical while no new feature is in use

- **Law.** While no new feature is switched on, the request bodies the API sends to workers (and the run rows
  and API projections pinned with them) MUST stay byte-identical to the goldens in
  `backend/internal/app/testdata/golden/`.
- **Why.** A field or prompt line that leaks into every request silently changes model behaviour, cost and
  prompt-cache hits for every tenant; a closed feature gate must be invisible.
- **Evidence.** `backend/internal/app/request_characterization_test.go` and
  `backend/internal/app/testdata/golden/`. Goldens are regenerated only on purpose
  (`AWWO_UPDATE_GOLDEN=1 AWWO_TEST_DATABASE_URL=... go test -count=1 -p 1 -run RequestCharacterization
  ./internal/app`) and the diff is reviewed before it is committed.

## Network

### AWWO-LAW-014: Server-side fetches dial only public addresses, checked at connect time

- **Law.** A server-side fetch of a URL that operator configuration did not fix MUST connect only to public
  unicast addresses, checked on the address actually dialed, for every connection including redirects.
- **Why.** A check on the host name alone is defeated by DNS rebinding and by redirects; only the dial-time
  check keeps a URL from reaching loopback, the cloud metadata service or the private network (SSRF).
- **Evidence.** `backend/internal/webread/url_test.go` (`TestDialControlRefusesNonPublicAddresses`,
  `TestPublicAddress`); `backend/internal/webread/fetch_test.go` (`TestFetchRefusesLoopbackWithoutTheTestSeam`,
  `TestFetchRedirectRules`); `backend/internal/app/runninghub.go` (`publicOnlyTransport`, for media results);
  `backend/internal/app/media_test.go` (`TestRunningHubResultHostsAndAddresses`).

### AWWO-LAW-015: Server-side page fetches obey robots.txt

- **Law.** A server-side fetch of a web page MUST obey that site's robots.txt for AwwO's product token as
  RFC 9309 defines it, treating a robots.txt that fails with a server error as disallowing everything.
- **Why.** Reading pages a site has asked crawlers to leave alone invites complaints and blocks against AwwO's
  addresses, and every import is made under AwwO's name.
- **Evidence.** `backend/internal/webread/robots_test.go` (`TestRobotsMatchingFollowsRFC9309`);
  `backend/internal/webread/fetch_test.go` (`TestFetchHonoursRobotsAndCachesThem`, `TestFetchRobotsStatusRules`).

### AWWO-LAW-016: Network scanning and probing fails closed

- **Law.** AwwO MUST NOT scan or probe networks or hosts (port scans, host discovery, vulnerability probes)
  unless a person has approved that exact target and scope, and without such an approval it MUST refuse.
- **Why.** Probing systems AwwO does not own is abuse that lands on AwwO's addresses and accounts. Today no
  model-reachable path can open a connection of its own choosing; each new network feature must keep it so,
  as the web reader does by fetching only http and https on the default ports.
- **Evidence.** Structural only: the tool allowlists of AWWO-LAW-011;
  `apps/openai-agents-worker/workspace-sandbox.test.ts` (the execution sandbox runs with `--network=none`);
  `backend/internal/webread/url_test.go` (`TestValidateURLRefusesUnsafeAddresses`: any other port is
  `blocked_port`). The managed-execution sandbox's lack of network is stated in
  `apps/openmaus-worker/transport.ts` but not tested in this repository. No approval gate exists, because
  nothing may scan; no automated check yet for scanning intent.

## Secrets and product

### AWWO-LAW-017: Secrets and provider keys never reach the browser

- **Law.** Provider keys, personal connection keys and internal service tokens MUST NOT reach the browser, in an
  API response, an SSE event or the web build's environment.
- **Why.** Anything the browser receives can be read by the user, a browser extension or an injected script,
  and a leaked provider key is spent on AwwO's account.
- **Evidence.** `backend/internal/app/personal_credentials_test.go` (a saved key never appears in a response:
  `addPersonalConnection`, `TestPostgresPersonalConnectionRefresh`); `scripts/awwo-saas-scripts.test.mjs`
  ("local services receive only their own provider credentials": the web process gets none). No check yet
  scans SSE events or the built web bundle for secrets.

### AWWO-LAW-018: Media models are shown only by generic names

- **Law.** The UI, and every catalogue or record the browser shows, MUST name a media model only generically,
  never by its provider, vendor or model family.
- **Why.** Owner decision of 2026-10-11: users see what a model is good for, not which services make AwwO's
  pictures, clips and 3D models.
- **Evidence.** `backend/internal/app/planning_media_test.go` (`TestMediaModelNamesNeverNameTheirProvider`);
  `apps/web/tests/canvas-model-names.test.ts`; `apps/web/src/canvas/mediaModelIds.ts` (`hideMediaModelIds`
  for raw records).

## Database

### AWWO-LAW-019: Shipped migrations are never edited

- **Law.** A migration file that has shipped MUST NOT be edited, renamed or deleted; every schema change is a
  new, numbered migration.
- **Why.** Each applied migration is recorded with the SHA-256 of its bytes, and `Migrate`, which runs when the
  API starts, refuses a database whose record no longer matches; editing a shipped file therefore stops the API
  from starting, and a database built from the edited file would differ from production.
- **Evidence.** `backend/internal/app/migration_identity.go` (`applyIdentifiedMigration`);
  `backend/internal/app/migration_identity_test.go` (`TestMigrationChecksumDriftRejected`);
  `backend/internal/app/database.go` (the ordered migration list).

### AWWO-LAW-020: New migrations are idempotent

- **Law.** A new migration MUST succeed, and change nothing further, on a schema that already has some or all
  of its changes.
- **Why.** Operators pre-create columns before risky deploys and repair schemas by hand; a migration that
  assumes a fresh schema fails there and blocks every later release.
- **Evidence.** No automated check yet. Migrations from `023_media_generation.sql` on use `IF NOT EXISTS` and
  `duplicate_object` guards; several of 001 to 022 are not idempotent and stay as shipped (AWWO-LAW-019).

### AWWO-LAW-021: New migrations set a local lock timeout

- **Law.** A new migration MUST begin with `SET LOCAL lock_timeout`.
- **Why.** Migrations run in one transaction at startup, and a migration waiting for a busy table's lock makes
  every later query on that table queue behind it, stalling the live site; with a timeout the deploy fails
  visibly instead. Each file sets its own, because a database upgraded by one step runs only that file.
- **Evidence.** No automated check yet. `023_media_generation.sql` to `027_signup_ip_days.sql` and the
  migrations from `029_workspace_checkins.sql` on begin with `SET LOCAL lock_timeout = '10s'`; 001 to 022 and
  `028_parallel_graph_runs.sql` predate the rule.

## UI and source

### AWWO-LAW-022: zh and en UI strings stay in parity

- **Law.** Every UI string MUST exist in both zh and en; a text shown in one interface language has its
  counterpart in the other.
- **Why.** Both languages ship to every user, and a missing entry shows a raw key or the other language in the
  middle of a screen. Content is not UI text: the production cases read in English in both languages (owner
  decision of 2026-10-14).
- **Evidence.** `apps/web/src/canvas/i18n.tsx` (`const ZH: Record<CanvasTextKey, string>`, so a key missing from
  either table fails `npm run typecheck:saas --prefix apps/web`); `apps/web/tests/saas-canvas-errors.test.ts`
  (every error code is explained in both languages). The SaaS views' inline `locale === 'zh' ? ... : ...` pairs:
  no automated check yet.

### AWWO-LAW-023: Source files use LF line endings

- **Law.** Source files MUST use LF line endings, except the file types `.gitattributes` checks out as CRLF
  (`*.ps1`, `*.bat`, `*.cmd`) and the byte-frozen records under `docs/superpowers/evidence/`.
- **Why.** A carriage return changes the bytes that migration checksums (AWWO-LAW-019) and golden files
  (AWWO-LAW-013) are compared on, so a build from a CRLF checkout can stop the API from starting or fail every
  golden test.
- **Evidence.** `.gitattributes` (`* text=auto eol=lf`); `scripts/check-source-hygiene.mjs` (category `cr`);
  `scripts/check-source-hygiene.test.mjs`; `scripts/source-hygiene-allow.json` (each CRLF exception with its
  reason).

### AWWO-LAW-024: Source files contain no hidden Unicode or control characters

- **Law.** Source files MUST NOT contain control characters other than tab and LF, zero-width characters,
  bidirectional controls or Unicode tag characters, unless `scripts/source-hygiene-allow.json` lists the file
  and category with a reason.
- **Why.** These characters render as nothing or reorder text, so code, a prompt or a skill can read one way to
  a reviewer and another way to the compiler or the model. When a program needs one, write it as an escape of
  its code point (Go and JavaScript both have one), never as the raw character.
- **Evidence.** `scripts/check-source-hygiene.mjs` (categories `control`, `zero-width`, `bidi`, `tag`);
  `scripts/check-source-hygiene.test.mjs`.

## Process

### AWWO-LAW-025: While CI is paused, pushes carry their passed local gates

- **Law.** While GitHub CI is paused, a change MUST NOT be pushed to `main` unless the full local gates of every
  part it touches passed on that exact tree, as its commit message records.
- **Why.** With CI paused nothing else stops a red tree from reaching `main`, which is what gets released; the
  commit message is the one durable record of what was actually run.
- **Evidence.** No automated check yet. Each release record in `docs/awwo-saas-deploy.md` lists its gates under
  **Gates**; `scripts/check-source-hygiene.mjs` and `scripts/awwo-doctor.mjs` are local gate steps.
