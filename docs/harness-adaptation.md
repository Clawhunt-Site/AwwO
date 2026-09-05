# Harness Adaptation

SuperClaw now treats harness compatibility as a first-class runtime layer. The implementation is intentionally productized rather than vendored: it imports the contracts and degradation rules, then exposes them through the same CLI/API/orchestrator core used by Web and agent execution.

## Source Findings

`Arxchibobo/agents` is a multi-harness marketplace with Claude Code markdown as source of truth. The important pieces are:

- capability matrix for Claude Code, Codex, Cursor, OpenCode, and Gemini
- adapters that convert agents, skills, and commands to each target harness
- graceful degradation rules for unsupported fields
- generated artifact validation, especially Codex skill body limits
- plugin inventory rather than whole-repo vendoring

`Arxchibobo/claude-code/src` adds the execution model SuperClaw should align with:

- task types are explicit: `local_bash`, `local_agent`, `remote_agent`, `in_process_teammate`, `local_workflow`, `monitor_mcp`, and `dream`
- terminal task states are guarded
- background tasks emit notifications and output files, not only in-memory status
- read-only tool batches can run concurrently while mutating tools serialize
- agents can own tools, disallowed tools, MCP servers, skills, model, max turns, memory, isolation, and permission mode
- context is split into user/system/git/memory boundaries instead of a single hidden prompt blob

## SuperClaw Surfaces

- `superclaw.harness` holds the capability matrix, model/tool mappings, task runtime profile, plugin inventory, and agent/skill adaptation helpers.
- `superclaw harness matrix` prints the matrix and Claude Code runtime alignment.
- `superclaw harness inventory <source_root>` inspects an Agents-style plugin root without copying secrets or generated artifacts.
- `superclaw harness adapt-agent <file> --target codex` previews field degradation and worker policy.
- `superclaw harness adapt-skill <SKILL.md> --target codex` previews body rewriting and split overflow.
- `superclaw harness emit <source_root> <output_root> --target cursor|opencode|gemini|codex|claude-code` writes target-native artifacts.
- `superclaw harness validate <output_root> --target cursor|opencode|gemini|codex|claude-code` validates emitted structure.
- `GET /api/harnesses` exposes the same profile to the Web workbench.
- `POST /api/harnesses/emit` exposes the same emitter behind the SuperClaw control token.
- `POST /api/harnesses/validate` exposes the same validator behind the SuperClaw control token.
- Runs accept `harness_policy`, and evidence records the harness profile used for the run.

## Emitted Paths

| Target | Generated paths |
|---|---|
| Codex | `.codex/agents/*.toml`, `.codex/skills/*/SKILL.md`, `AGENTS.md` |
| Cursor | `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`, `.claude/commands/<plugin>/*.md`, `.cursor/rules/*.mdc`, `.cursor-plugin/*.json` |
| OpenCode | `.opencode/agents/*.md`, `.opencode/skills/*/SKILL.md`, `.opencode/commands/*.md`, `opencode.json` |
| Gemini | `agents/*.md`, `skills/*/SKILL.md`, `commands/<plugin>/*.toml`, `GEMINI.md` |
| Claude Code | `plugins/<plugin>/...`, `.claude-plugin/marketplace.json` |

## Current Degradation Rules

For Codex:

- Claude command assets are treated as skills at product boundaries.
- `tools:` on agents degrades to `sandbox_mode` because Codex does not honor per-agent tool allowlists.
- read-only Claude tools map to `read-only`; mixed or absent allowlists map to `workspace-write`.
- `model: opus|sonnet|haiku|inherit` maps to the GPT-5 family.
- tool-name prose is rewritten toward action verbs.
- oversized skill bodies split into an overflow reference.

For OpenCode/Gemini/Cursor, SuperClaw now emits deterministic artifacts into an explicit output directory. The emitter is deliberately non-destructive: it does not delete stale generated files or copy source `.git`, secrets, caches, browser profiles, or runtime state.

## Acceptance Checks

A SuperClaw run is harness-aware only when evidence includes:

- `backend_summary.harness`
- `harness_profile` probe
- worker results or command evidence
- adversarial findings
- artifact references

The harness layer does not make `E2E_PROVEN` by itself. It strengthens portability and execution proof; ClawHunt submission response is still required for full E2E proof.

## Validation

The validator checks the target-specific structure after emission:

- Codex: TOML agent fields, sandbox mode, SKILL.md frontmatter, name-directory match, 8 KB cap, `AGENTS.md` line budget.
- Cursor: marketplace JSON, per-plugin JSON, `.cursor/rules/*.mdc` key whitelist, emitted skills.
- OpenCode: strict lowercase artifact names, agent/command/skill frontmatter, permission values, `opencode.json`.
- Gemini: `GEMINI.md` line budget, agent/skill frontmatter, command TOML fields.
- Claude Code: marketplace JSON plus plugin agent/skill frontmatter.
