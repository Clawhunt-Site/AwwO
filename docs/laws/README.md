# AwwO laws

This folder holds AwwO's laws: short, numbered rules about what the running product must and must not do.
They are the checklist a reviewer holds every change against. The list itself is in
[awwo-laws.md](awwo-laws.md).

The idea comes from the `LAWS/` folder of Block's Berd (Apache-2.0). The wording and the laws are AwwO's own.

## What a law is

A law is an **observable invariant**: something a user, an API client, a test or an operator can see hold or
break from outside the code. "A run is marked completed only after the model's answer is stored" is a law.
"Use pgx for PostgreSQL" is a design choice, "functions stay under 50 lines" is a coding standard, and "the
assistant suggests next steps" is a feature. None of those three is a law.

Each law:

- states **one requirement** in **one sentence**, using the RFC 2119 words MUST, MUST NOT, SHOULD and SHOULD
  NOT. If a sentence needs "and" to join two separate demands, it is two laws.
- says **why** in one or two sentences: the failure it prevents, in terms a user or operator would notice.
- lists its **evidence**: the repo-relative paths of the tests or code that enforce it, naming the test
  function when a file holds many. When nothing enforces it, the evidence says `no automated check yet`.

`no automated check yet` marks a debt, not a pass. A change that touches such a law gets an explicit question
in its review, and the change that adds the missing check updates the evidence line.

A law is not a feature spec. It does not say how something is built, only what must stay true while it is
rebuilt. Designs live in [the architecture](../awwo-saas-architecture.md) and
the design standards; a law keeps only the part that must survive any
redesign.

## How to cite laws

Every change, tests included, MUST keep the laws. When a change and a law disagree, either the change is wrong,
or the same change amends the law with the owner's agreement. A law is never broken silently.

Every commit body and every review brief lists the laws the change touches:

```text
Affected laws: AWWO-LAW-003, AWWO-LAW-008
```

Write `Affected laws: none` when no law is touched, so a missing line is visibly missing rather than
ambiguous. The review brief template asks the reviewer to check each
affected law against the diff and against its evidence. A change that weakens a law's evidence (deletes,
skips or loosens a test the law cites) says so next to that law, in the commit body and in the brief.

PostgreSQL tests (`TestPostgres*`) skip when `AWWO_TEST_DATABASE_URL` is not set. A skipped test is not
evidence; say which database the tests ran against.

## How to add a law

1. Take the next unused number. IDs are append-only: never reused, never renumbered.
2. Write the law as one sentence with RFC 2119 wording and one requirement.
3. Add the why, and the evidence as repo-relative paths you have checked exist.
4. If nothing enforces it yet, write `no automated check yet` and say what a check would be.
5. Land the law in the same change as the code or test that makes it true, or say plainly that it is debt.

## How to change or retire a law

- **Clarifying the wording or updating the evidence:** edit in place and keep the ID.
- **Changing what the law demands:** retire the old law and add a new one, so older commits that cite the old
  ID stay truthful.
- **Retiring:** keep the entry and its ID, and add a line `Retired: <YYYY-MM-DD>, <why>` (naming the
  replacement, if there is one). Never delete an entry.

## Why numbered rules, when prose cannot stop drift

The legacy SuperClaw plan in architecture-invariants-roadmap.md
rejected numbered prose invariants, because text does not stop a change from drifting; tests do. The laws
agree with that. A law is an index entry over the checks that enforce it, and every law without one says so
out loud. Its job is to make a reviewer ask the right question and to make a missing test visible, not to
stand in for the test.
