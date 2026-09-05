# SuperClaw Skill Author

A thin entry pointer. The real workflow lives in the agent meta-skill
[`skills/superclaw-skill-author/SKILL.md`](../skills/superclaw-skill-author/SKILL.md);
the deep mechanism reference lives in
[`docs/plugin-developer-guide.md`](./plugin-developer-guide.md). This page only
says *when* to reach for them.

## When to use

- You have a **requirement** and want a governed SuperClaw skill built from it.
- You have an **existing skill** (Codex / Claude Code / Gemini / any `SKILL.md`)
  and want it converted into a governed SuperClaw skill.

Ask the agent to "author a SuperClaw skill" or "convert this skill into
SuperClaw" — it loads the meta-skill and runs the flow.

## What it actually does

It **orchestrates the existing plugin CLI** — there is no new mechanism:

| Step | Command |
| --- | --- |
| Convert / wrap pure prose | `superclaw plugin import-skill <SKILL.md> --plugin-id skill.<slug>` |
| Scaffold a side-effecting plugin | `superclaw plugin init <reverse-dns-id>` |
| Local smoke | `superclaw plugin dev <dir>` |
| Sign / pack | `superclaw plugin pack <dir> --dev-sign` |
| Contract check | `superclaw plugin conformance <dir>` |
| Install + project to runtimes | `superclaw plugin install <id> --sync-skills` |

## The one rule that matters

**Pure prose → `import-skill`. Anything with side effects (network, filesystem,
credentials, payment, approval) → a governed plugin (`plugin init`), not prose.**

SuperClaw's native skill format is the Anthropic/Claude `SKILL.md`, so authoring
and converting end at the same governed package — the difference is only where
the `SKILL.md` came from.
