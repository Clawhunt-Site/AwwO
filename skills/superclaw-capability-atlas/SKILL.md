---
name: superclaw-capability-atlas
description: Query and apply the SuperClaw capability atlas — the embedded profile of every skill, plugin, tool, and service the agent can draw on.
---

# SuperClaw Capability Atlas

The atlas is the packaged capability profile (`superclaw/capability_atlas.json`): a typed
catalog of the OpenClaw/ClawHunt ecosystem capability units — self-built skills, vendored
external skills, the wshobson plugin arsenal, OpenClaw built-ins, and external tools and
services — each with provenance, triggers, and an availability grade.

Default workflow:

1. At goal intake, run `superclaw capabilities suggest "<goal text>"` and attach the top
   suggestions to the run plan as candidate capabilities.
2. Before promising a capability, check its `availability`:
   - `vendored` / `local` — the source is on disk; safe to rely on.
   - `external` — upstream or network dependency; verify reachability first.
   - `declared` — cataloged but no source found; treat as a gap, never as a feature.
3. Use `superclaw capabilities adaptable --target <harness>` plus `superclaw harness emit`
   to materialize skill/plugin units into a target harness (codex, cursor, opencode, gemini).
4. Track gaps with `superclaw capabilities coverage`; the `declared_gaps` list is the
   vendoring backlog, and `external_dependencies` is the runtime risk list.

Query surfaces:

- `superclaw capabilities summary | list | show <id> | search <q> | matrix | doctor`
- `GET /api/capabilities?q=&category=&availability=` — filtered catalog with summary.
- `GET /api/capabilities/suggest?goal=` — same ranking as the CLI for Web/API callers.
- `GET /api/capabilities/coverage` and `GET /api/capabilities/{id}`.

Evidence policy:

- When a suggestion influences a run plan, record the suggestion payload (ids + scores)
  as run evidence, not just the chosen capability name.
- Coverage reports cited in deliverables must come from `coverage_report()` output, not
  hand-counted numbers.
