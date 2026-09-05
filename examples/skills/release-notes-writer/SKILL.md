---
name: release-notes-writer
description: Use this when the user wants to turn a list of merged pull requests or commits into clear, user-facing release notes.
version: 1.0.0
---

# Release Notes Writer

A pure-prose SuperClaw skill (Route A). It has no side effects — it only returns
guidance the model reads when drafting release notes from merged work.

When the user gives you merged PRs, commits, or a changelog dump:

- Group changes into **Added**, **Changed**, **Fixed**, and **Removed**. Drop any
  group that has no entries; never emit an empty heading.
- Write each line for the user, not the developer: lead with the user-visible
  effect, not the internal module name. ("Faster cold start" beats "lazy-import
  refactor in main.py".)
- Keep each entry to one sentence. Link the PR/commit id in parentheses at the
  end when one is available.
- Put breaking changes first, prefixed with **Breaking:**, and say what the user
  must do to migrate.
- If a change is internal-only (tests, CI, refactor with no user-visible effect),
  omit it from the notes unless the user explicitly asks for a full changelog.

Never invent a change that is not in the source material. If the input is empty
or ambiguous, ask for the merged PR list rather than guessing.
