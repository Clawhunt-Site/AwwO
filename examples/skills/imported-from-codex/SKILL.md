---
name: changelog-summarizer
description: Use this when the user wants a terse, reviewer-ready summary of a git diff or a list of commit messages.
---

# Changelog Summarizer

Converted from a Codex skill (Route B). The original used a Codex-style
`title:` field and put its trigger inside a `when_to_use:` block; both were
normalized into the standard `name` / `description` frontmatter above, and the
Codex-specific "run `git log` yourself" instruction was removed because reading
the repo is a side effect — the skill now only shapes prose the model already
has.

When given a diff or commit list:

- Group changes by intent (feature / fix / refactor / docs / chore), not by file.
- Lead each group with the user-visible effect, then the mechanism in one clause.
- Flag anything that looks risky (migrations, deletions, public API changes).
- Keep it scannable: short bullets, no restating the raw diff.

If the input is empty or unparseable, say so rather than inventing a changelog.
