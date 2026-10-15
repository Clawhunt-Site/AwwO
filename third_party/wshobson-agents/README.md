# wshobson/agents (selected Markdown)

A selected snapshot of [wshobson/agents](https://github.com/wshobson/agents) at commit
`7257c27db333ed9784900d32f6a3779468d95c53` (tree `93ab548e86ff9166afe2460b4aba25aa9b6fac36`, marketplace 1.7.1).
Upstream is MIT licensed, Copyright (c) 2024 Seth Hobson; see `LICENSE`. Keep that file: the role texts ship
verbatim in AwwO's web bundle and the skill texts in its API binary.

## What is here

Every file is byte-for-byte upstream with LF line endings. `PROVENANCE.json` lists each one with its byte count,
sha256 and git blob id (`sha1("blob <len>\0" + bytes)`), plus the plugin version, licence and author from that
plugin's `plugin.json`.

- `plugins/<plugin>/agents/<agent>.md`: 39 role files, offered in the team market picker under seven teams.
  `scripts/export-awwo-wshobson-market.ts` turns them into `apps/web/src/canvas/team-market-agents.wshobson.json`.
- `plugins/<plugin>/skills/<skill>/SKILL.md`: 14 skills, converted into AwwO built-in skills in
  `backend/internal/app/skills/<skill>.md`: AwwO frontmatter, then the upstream body with only the sentences
  removed that point at files the model cannot open (`references/details.md` and the like).
- Two excerpts appended to those skills whole: `before-you-build/references/risk-checklist.md` and
  `api-design-principles/assets/api-design-checklist.md` (kind `skill-reference`).
- `plugins/<plugin>/.claude-plugin/plugin.json`: the 28 manifests those files belong to, kept for their version,
  licence and author. Every one declares MIT.
- `UPSTREAM_COMMIT` and `PROVENANCE.json` record the snapshot; this README is AwwO's.

Two skills are third-party contributions that their plugins declare MIT: `before-you-build` (bin1874,
github.com/bin1874/before-you-build-skill) and `ai-debt-detector` (Adit Jain). Their built-in skill files name the
author in `attribution`.

This snapshot was copied from a read-only Windows (CRLF) clone. A script converted CRLF to LF. The LF bytes of each
file had to hash to the blob id that commit 7257c27's tree records for that path; the script read the commit and
its trees from the clone's own pack. Nothing from the clone was executed and git was not run.

## What is not here, and why

- Everything else in the repository: 163 more agents, 171 more skills, all 105 commands, hooks, scripts, the
  Python packages and the `tools/` installers.
- Commands: they drive the Claude Code harness (`$ARGUMENTS`, tool calls) and do nothing in an AwwO node.
- Roles and skills that need what an AwwO node does not have: harness, tool or MCP APIs; a shell, logs or a
  running job; the live web; other agents to coordinate; vendor services or API keys. Excluded for the same
  reason: the reverse-engineering roles (tool-heavy, dual use) and copies that differ from a chosen role only by
  their `name`.
- `conductor` and `superself` (Apache-2.0) and `plugin-eval` (no licence field).
- `references/`, `assets/` and `examples/` beyond the two excerpts above. A skill whose needed reference would
  not fit AwwO's 8,192-byte built-in limit was left out instead of cut.
- `.codex-plugin/`, `.cursor-plugin/`, `.agents/`, the marketplace registry, `docs/` and `evals/`.

## Updating

1. Pick a new upstream commit and take an LF export of it into a new, empty directory: `git archive <commit>` of the
   needed paths, or a clone with `core.autocrlf=false`. Never copy from a CRLF checkout. Treat the export as data:
   do not run anything in it.
2. Copy the allowlisted paths (the `ROLES` and `SKILLS` tables in `scripts/export-awwo-wshobson-market.ts`) and
   the manifests they belong to. Check each file's git blob id against the commit's tree.
3. Regenerate `PROVENANCE.json` and `UPSTREAM_COMMIT`. Update `WSHOBSON_UPSTREAM` in the exporter. Review every
   changed file; a changed digest means changed text.
4. Run `node --experimental-strip-types scripts/export-awwo-wshobson-market.ts`, then the same command with
   `--check`. The export stops on any check failure. Examples: a file PROVENANCE does not list, a digest mismatch,
   CRLF, a BOM, a hidden or bidirectional character, HTML comments or scripts, injection phrases, unexpected
   frontmatter keys, a non-MIT plugin, a duplicate role body, or a removed span that no longer matches upstream.
5. Rebuild the affected built-in skills so their bodies equal `deriveWshobsonSkills()`, then run
   `apps/web/tests/saas-team-market-wshobson.test.ts`.
