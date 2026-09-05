---
name: superclaw-skill-author
description: Create a governed SuperClaw skill from a requirement, or convert an existing Codex/Claude/Gemini SKILL.md into one, by orchestrating the existing plugin CLI.
---

# SuperClaw Skill Author

Use this when the user wants to **author** a SuperClaw skill from a requirement,
or **convert** an external skill (Codex / Claude Code / Gemini / any
`SKILL.md`) into a governed SuperClaw skill.

SuperClaw's native skill format **is** the Anthropic/Claude `SKILL.md` (YAML
frontmatter + Markdown body). So both jobs end at the same place: one governed,
signable, installable, sync-able skill package. The only difference is where the
`SKILL.md` comes from — you write it, or you normalize an existing one.

This skill **orchestrates existing CLI**. Do not invent new mechanisms, and do
not write into a runtime's skill directory yourself — projection only happens
through `plugin sync-skills` (see `superclaw-skill-author` companion doc
`docs/superclaw-skill-author.md`).

## Non-negotiables

- **Never bypass plugin governance.** Every skill becomes a signed, revocable,
  entitled, policy-checked plugin package.
- **Pure prose → import; side effects → plugin.** A skill that is only
  model-visible instructions may be wrapped with `plugin import-skill`. The
  moment it needs network, filesystem writes, environment/credentials, payment,
  or any execution side effect, it **must** be built as a governed plugin
  (`plugin init` → sidecar), not packaged as prose.
- **Never write `~/.codex/skills` (or `.claude`/`.gemini`) directly.** Projection
  is `plugin sync-skills` only.
- **Never embed secrets, tokens, private source paths, or "call the native
  runtime tool directly / skip SuperClaw" instructions** in a `SKILL.md`.

## Entry decision

1. Input is **a requirement only** → Route A (author from zero).
2. Input is **an existing `SKILL.md` / skill directory** → Route B (convert).
3. The requested behavior needs **network / filesystem / env / payment / human
   approval / any side effect** → it is not a pure skill. Use Route A2 (build a
   governed plugin) regardless of which input you started from.

## Route A — author a pure-prose skill from a requirement

1. Pull out the intent: trigger conditions ("use this when…"), expected output,
   constraints. Confirm it is pure prose (no side effects); if not, go to A2.
2. Draft a standard `SKILL.md`:
   - `name`: a short stable identifier (lowercase, hyphen/underscore).
   - `description`: one searchable, trigger-bearing sentence (this is what makes
     the runtime pick the skill — do not lose the trigger semantics).
   - body: progressive-disclosure instructions. Keep it focused; long detail can
     overflow into `skill/reference.md` automatically.
3. Wrap it into a governed package:
   ```bash
   superclaw plugin import-skill path/to/SKILL.md \
     --plugin-id skill.<slug> --output-dir dist/skill.<slug> --json
   ```
4. Pack + install + project:
   ```bash
   superclaw plugin import-skill path/to/SKILL.md --pack --dev-sign --json   # signed .scplug
   superclaw plugin install skill.<slug>@<version> --sync-skills --json
   ```
5. Verify (see Verification) and report paths.

## Route A2 — build a governed plugin (side-effecting capability)

1. `superclaw plugin init <reverse-dns-id> --name "<name>" --tool-name <tool> --json`
2. Edit the generated `superclaw-plugin.json` (declare the real
   `permissions.{network,filesystem,environment}` and the tool input schema),
   the sidecar under `bin/`, and the skill docs under `skills/<tool>/SKILL.md`.
3. `superclaw plugin dev <dir> --json` — local smoke of the sidecar.
4. `superclaw plugin pack <dir> --dev-sign --json` — signed archive.
5. `superclaw plugin conformance <dir> --json` — contract/acceptance check.
6. `superclaw plugin submit <dir> ...` when ready for distribution.

## Route B — convert an existing skill

1. Locate the source `SKILL.md` (or the skill directory).
2. Parse its frontmatter + body, then **normalize into standard form** (do this
   in your own reasoning before calling the CLI — `import-skill` expects a
   standard `SKILL.md`):
   - `name` ← `name` / `title` / `display_name`; strip colons, spaces, emoji into
     a stable slug, keep the original as a human display name in the body if useful.
   - `description` ← `description` / `summary` / `when_to_use` / `trigger` /
     `purpose`; **preserve the trigger meaning** — compress to one retrievable
     sentence.
   - body: keep the instructions; **remove any runtime-specific bypass text**
     (e.g. "run the shell directly", "skip approval").
   - references: fold external `references/` / `assets/` content into the body or
     a `reference.md`; if the skill ships real `scripts/` it is side-effecting →
     Route A2.
3. **Classify side effects.** If it reads credentials, hits the network, writes
   files, or takes payment/approval actions → Route A2 (governed plugin), not a
   prose import.
4. **Security scan** the normalized content for secrets, hardcoded tokens,
   private paths, and governance-bypass instructions. Strip or refuse.
5. Pure prose → `superclaw plugin import-skill <normalized SKILL.md> --plugin-id skill.<slug> --json`.
6. Pack / install / sync as in Route A.

## Verification

- Read the generated `superclaw-plugin.json`: `skill_origin` is `true` for prose
  imports; `permissions` reflect declared side effects for plugins.
- Confirm `skill/SKILL.md` (prose) or `skills/<tool>/SKILL.md` (plugin) exists.
- Watch for the body-overflow warning; if present, confirm `skill/reference.md`.
- Run the dev/smoke command and (for plugins) `plugin pack` / `plugin conformance`.
- Confirm projection happens **only** through `plugin sync-skills` /
  `plugin install --sync-skills`.

## Final report contract

Report back:
- route used (A / A2 / B)
- `package_root`
- `plugin_id` and version
- `tool_name`
- the generated/normalized `SKILL.md` path
- packed archive path + digest (if packed)
- install / sync status
- warnings and residual risks (overflow, stripped bypass text, redacted secrets)
