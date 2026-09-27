# Mu patterns in AwwO

This adaptation takes design ideas from [qybaihe/mu](https://github.com/qybaihe/mu),
without importing its runtime. AwwO continues to use its Go SaaS API, saved canvas
revisions, PostgreSQL event storage and existing workers. Cloud Windows and Mac
clients load the same hosted UI.

## Human-authored requirements

Session nodes may contain `taskFrame` with `version: 1`, `source: "manual"`,
`constraints: string[]` and `acceptanceCriteria: string[]`. Unknown keys or
versions are preserved by the editor but cannot be saved or executed as v1.
Both arrays are required. Blank entries are ignored; each array allows 20
nonblank entries, each entry 2,000 Unicode characters and both arrays 12,000
characters in total. Nonblank text retains its original whitespace and newlines.

Save uses the existing canvas revision comparison. A client that omits the field
on an existing session cannot accidentally remove it; explicit v1 empty arrays
clear it. Deleting the node still deletes its requirements. Changes invalidate
the same downstream output and recovery state as other execution inputs.

Requirements come from the saved node, are frozen in the execution snapshot,
and are rendered once into single, team, graph and collaboration prompts. Their
size participates in admission limits before workers are invoked. Runs without
requirements retain their previous request format.

## Evidence and downloads

Authenticated workspace readers may use:

- `GET /api/v1/tenants/{tenantId}/runs/{id}/evidence`
- `GET /api/v1/tenants/{tenantId}/runs/{id}/archive`

Evidence is observational: stored output presence/bytes, saved artifacts, and
validation against the frozen machine output contract when available. Text-only
policies do not establish machine validation. Human acceptance is always
unverified; the model cannot approve its own work. Preview text is sanitized
before being shortened to 4,096 bytes on a UTF-8 boundary.

Downloads are NDJSON projections of **currently retained database events**, not
provider stdout, deleted history, or a backup of the execution snapshot. A
repeatable-read snapshot fixes the status, output and event cursor. Every retained
event through that cursor is represented; unknown payloads are omitted explicitly.
For a running task, completeness applies only through the recorded cursor.
The first record carries scope, status, event count, cursor and completeness;
response headers include SHA-256 and byte count. Membership and login validity
are checked again before releasing the archive.

Only known event fields are exported. Common credential assignments, bearer
tokens, key patterns, private keys and configured internal secrets are removed.
Text deltas are joined for detection before replacements are mapped back to
events, including credentials split across chunks. This is a sanitized review
artifact, not a guarantee that arbitrary user-entered sensitive prose can be
identified; handle downloads with the same care as other workspace documents.

## Configuration and rollout

`AWWO_RUN_ARCHIVE_MAX_BYTES` uses the same name in development, staging and
production. Default: `16777216` (16 MiB). Allowed: 1 MiB through 256 MiB. The
source size and serialized response are checked; oversized requests return
`413 archive_too_large` without a partial attachment. No migration is needed.

Keep current model routing, personal credential mode, encryption key and worker
units unchanged. Deploy the reviewed API binary and SaaS bundle as an immutable
release, preserving previous paths for rollback. Verify actual API revision and
served asset hashes, authentication boundaries and worker readiness after rollout.
Run synthetic functional acceptance against an isolated database before release;
production checks remain read-only.
