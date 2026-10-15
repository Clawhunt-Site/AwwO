# AwwO adversarial review brief (template)

Copy this template for each change you want reviewed, fill in every section, and send the whole brief to a
reviewer that can read this worktree but not change it: Codex (through the codex-cli-advisor skill) or a
fresh-context Claude reviewer subagent. For changes to security, money, deletion, authorization or
migrations, send it to two different reviewers; one review of a risky change is not enough.

Keep filled briefs and their evidence under `.local/reviews/<yyyymmdd>-<slug>/` (ignored by git).

Rules for the author:

- The reviewer has not seen your conversation. The brief has to stand on its own.
- Every fact you state carries `path:line` and how you checked it. Anything you did not check is listed as an
  inference, labelled as such.
- One change per brief. Split a large diff by area and send the parts separately; a narrow brief gets a
  sharper review than a broad one.
- Never paste secrets, tokens, `.env` contents, cookies or production user data into a brief.
- Delete no section. Write `none` where a section is empty.

---

## Reviewer instructions

You are reviewing a change to AwwO, a multi-tenant SaaS: a Go API with PostgreSQL in `backend/`, a React web
app in `apps/web/`, and model workers in `apps/*-worker`. Your job is to find what is wrong, not to approve.

- Work read-only. Do not edit files, do not run commands that change the repository or any service, and never
  push, deploy or call a production system.
- Check the brief's claims against the code yourself where you can, and say which ones you checked.
- If a question or a premise in this brief is wrong, say so and explain why, instead of answering it as asked.
- Zero findings is a valid answer. Do not pad, and do not report a style preference as high or critical.
- The laws are in `docs/laws/awwo-laws.md`. Check every affected law against the diff and against its evidence.

## 1. Scope

- **Worktree:** `<absolute path>`
- **Base:** `<base commit sha>`; **head:** `<head commit sha>`
- **Exact range:** `git diff <base> <head>` (commit locally first; a local commit is not a push)
- **Files under review:** `<from changed_files in the evidence block>`
- **Out of scope:** `<files in the range that are not under review, and why>`

## 2. Change summary

`<Three to eight sentences: what changed, why, the effect a user or operator sees, and the owner decision it
implements, with its date.>`

## 3. Facts and inferences

Verified facts (each one checked by reading code, running a test or running a command):

| Fact | Where | How checked |
| --- | --- | --- |
| `<fact>` | `path/to/file.go:123` | `<read / test name / command>` |

Inferences (not verified; say what would confirm or refute each one):

- Inference: `<claim>`. Would be confirmed by `<test, query or reading>`.

## 4. Affected laws

```text
Affected laws: AWWO-LAW-0xx, AWWO-LAW-0yy
```

For each affected law: how the change interacts with it, whether its cited evidence was run and passed, and
whether the change weakens that evidence (deletes, skips or loosens a test the law cites). Write
`Affected laws: none` only after checking the list.

## 5. Questions for the reviewer

Keep the defaults that apply, delete the ones that do not, and add questions specific to this change. Each
question should be answerable with yes or no plus evidence.

1. Can any id, query or cache in this change reach another tenant's data, or answer other than 404 for it?
2. Is every write authorized again inside its transaction, after the tenant lock?
3. Can any path report success (a completed run, a saved document, a sent message) before the effect is stored?
4. Does every error path fail closed, or does one continue with a default that hides the failure?
5. Can any secret, provider key or internal token reach a response, an SSE event, a log line or the browser build?
6. Do model requests stay byte-identical when the new feature is off? Were goldens regenerated, and why?
7. Is new untrusted text (pages, files, notes, model output) quoted as user-message data behind a boundary?
8. Can concurrent requests (double clicks, two tabs, retries) break an invariant: duplicate runs, quota overshoot,
   a lost canvas edit?
9. Is any migration edited after shipping, non-idempotent, or missing `SET LOCAL lock_timeout`?
10. Does every new UI string exist in both zh and en? Did any hidden or control character enter a source file?
11. `<question specific to this change>`

## 6. Required answer shape

Answer each finding in this shape:

```text
### F1 [critical|high|medium|low] <one-line title>
- Where: path/to/file.go:123 (and any other lines involved)
- Failure scenario: the concrete inputs or sequence of events, and the wrong outcome someone would observe
- Rule broken: AWWO-LAW-0xx, a named contract or invariant, or a counter-example that shows the code is wrong
- Suggested fix: the smallest change that removes the cause
- Confidence: verified (how) or inferred
```

Severities:

| Severity | Meaning | Effect on merge |
| --- | --- | --- |
| critical | Security hole, cross-tenant leak, data loss, money or quota error, irreversible damage | Blocks |
| high | A real bug or regression users or operators will hit, or a broken law | Fix before merge |
| medium | Maintainability, a missing test on a real path, a misleading error | Fix or record as follow-up |
| low | Naming, wording, small clean-ups | Optional |

Then answer each question of section 5 by number, and end with one line:

```text
Verdict: no blocking findings
```

or `Verdict: blocking findings F1, F3`. A finding is blocking when it is critical or high.

## 7. Merge rubric

The reviewer holds every fix in the change to these rules:

- **A fix fixes a bug that exists today.** It comes with a failing test or a reproduction against the current
  code. A fix for a hypothetical problem is a feature and is reviewed as one.
- **Guards, fallbacks, retries, watchdogs and truncation are not fixes.** They hide the symptom. Name the root
  cause and show that the change removes it.
- **No second system.** Do not add a parallel path, cache, queue or fallback beside the buggy one; fix the one
  that exists.
- **The diff is proportional to the error.** A one-line cause gets a small diff. A large diff for a small bug
  has to explain why.
- **Fail closed, and never fake success.** An error path refuses rather than carrying on with defaults, and
  nothing reports success before its effect is stored (AWWO-LAW-004).

## 8. Changed-test integrity

For every test the diff adds, changes or removes:

- Was an assertion weakened: equality to contains, an exact count to "at least", a specific error to any error?
- Was a mock or fixture broadened, so the test no longer runs the real path?
- Were retries, sleeps or longer timeouts added to make it pass?
- Was a case deleted, skipped (`t.Skip`, `it.skip`, `test.todo`) or moved behind an environment switch?
- Were goldens regenerated (`AWWO_UPDATE_GOLDEN=1`), and is every changed golden line explained?
- Did the PostgreSQL tests really run (`AWWO_TEST_DATABASE_URL` set), or did they skip? A skip is not a pass.
- **If the bug this test guards against returned, would the changed test catch it?** Say how you know: you
  reverted the fix, mutated the code, or reasoned through the assertion.

## 9. Evidence record

The author fills in everything except `review`. Only the reviewer fills in `review`, and only the reviewer marks
the change accepted; green tests, a self-review or "looks fine" from the author never do.

```json
{
  "schema": "awwo.review-evidence/v1",
  "change": "<one-line summary>",
  "base": "<base commit sha>",
  "head": "<head commit sha>",
  "changed_files": ["backend/internal/app/runs.go"],
  "diff_stat": { "files": 1, "insertions": 0, "deletions": 0 },
  "affected_laws": ["AWWO-LAW-008"],
  "commands_run": [
    { "cwd": "backend", "command": "go test -count=1 -run TestPostgresRuns ./internal/app", "env": ["AWWO_TEST_DATABASE_URL (set, local)"], "exit": 0 }
  ],
  "results": [
    { "gate": "go test ./internal/app", "status": "pass", "detail": "<counts, and every skip named>" }
  ],
  "digest": "sha256:<hex digest of the exact diff>",
  "review": {
    "reviewer": null,
    "reviewed_digest": null,
    "verdict": null,
    "blocking_findings": [],
    "accepted": false
  }
}
```

- `results[].status` is `pass`, `fail`, `skip` or `blocked`. A skipped or blocked gate is not a pass, and its
  `detail` says why.
- `commands_run` names environment variables and never records their values.
- `digest` is the SHA-256 of the exact diff under review, computed in the worktree:
  `git diff --binary --no-color --no-ext-diff <base> <head> | sha256sum`.
- `accepted` may become `true` only when `reviewed_digest` equals `digest` and `blocking_findings` is empty.
  Any later change to the diff changes the digest, and the acceptance no longer applies.

---

## Attribution

- The laws practice and the changed-test integrity questions are adapted from Berd by Block, Inc. (Apache
  License 2.0).
- The merge rubric is adapted from the merge rubric of claude-mem by Alex Newman (Apache License 2.0).
- The review-package shape (verified facts with `path:line`, labelled inferences, a required answer shape,
  "say so if the question is wrong") and the per-change evidence record that only the reviewer accepts are
  adapted from zenpi by Weiyang (MIT License).
- The ideas were adapted; the wording here is AwwO's own and no text was copied.
