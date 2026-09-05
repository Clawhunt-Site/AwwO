# Creative Canvas → Agent-Drivable Timeline (native NLE lane) — Design

> Status: **DRAFT for review** (no code yet). Owner decides whether to build after reading.
> Origin: assessment of fusing `palmier-io/palmier-pro` into superclaw. Conclusion: **no code merge is possible** (palmier is Swift / macOS-26 / Apple-Silicon-only, GPLv3, generation closed+paid). Instead **borrow the concept** — build a cross-platform, agent-drivable timeline natively, using palmier's tool taxonomy as a *design reference only*.

## 1. Goal
Give superclaw a **multi-track video timeline** that:
1. an **agent can read + mutate programmatically** (draft an edit), and a **human finishes/reviews** in the UI;
2. **renders to a real `.mp4`** (and interchange XML) via **Remotion**;
3. uses **Seedance** (the owner's existing path) as the generation provider;
4. runs **cross-platform** (Windows dev box + Linux CI), **fail-closed**, **no paid action on the default path**.

This closes the gap between what superclaw *intends* (Remotion + Seedance auto-production, today only rules/skills) and what it *ships* (Creative Canvas = prompt authoring + preview, no timeline, no render).

## 2. Non-goals & red lines
- **No palmier code.** Do not port/translate/vendor/link any of palmier's Swift source (GPLv3 copyleft). palmier is used ONLY as a UX + API-taxonomy reference. Nominative use only ("works like / inspired by"), never brand a module "Palmier".
- **No new standing branches.** Build lands via a single transient PR that is deleted on merge; repo stays `main` + `feat/creative-canvas-mvp`.
- **No Mac dependency, no external GUI process, no closed/paid runtime** on the default path.
- Not a Premiere clone — a *focused* agent-first timeline, not a full pro NLE.

## 3. Reuse (what already exists — verified)
| Asset | Path | Reused as |
|---|---|---|
| ComfyUI-style node-graph editor (React 19 + Vite, typed ports/edges, undo, autosave) | `apps/creative-canvas/` (~2.7k LOC, 5 node types) | Host surface + interaction patterns for the timeline |
| Deterministic Seedance four-block prompt tooling | `apps/creative-canvas/src/engine/seedancePrompt.ts` | Generation-prompt provider for timeline clips |
| Creative Canvas embedded as a first-class workspace | `apps/web/src/App.tsx` (`CreativeCanvasSurface` from `../../creative-canvas/src/embed`) | Where the timeline surfaces to users |
| superclaw's own **MCP-server posture** (fronting its capabilities TO agents, run-bound ticket auth) | `packages/superclaw/src/superclaw/team_mcp_proxy.py`, `plugin_mcp_proxy.py` | How the timeline tools reach agents |
| Remotion + Seedance auto-production corpus | `~/.claude/rules`, `.claude/skills/{remotion,seedance-prompt}` | Design intent to realize (Remotion is currently **owner intent only — in ZERO `package.json`**) |

## 4. Architecture

```
 Agent (claude_local / relay)
        │  timeline tools (read + mutate)  ── superclaw MCP-server posture (run-bound auth)
        ▼
 Timeline document  (JSON, versioned, undo/redo, local-safe autosave)
   ├─ tracks[]  (video / audio / text / overlay)
   ├─ clips[]   (source ref, in/out, transforms, keyframes, transitions)
   └─ generation refs  (Seedance prompt → asset, explicit + governed)
        │  (deterministic mapping)
        ▼
 Remotion composition  ──render──▶  .mp4   (+ FCPXML / Premiere XML interchange export)
        ▲
 Creative Canvas timeline UI  (human finish/review; new node-type OR sibling surface)
```

- **Timeline data model** — a new document type (tracks, clips, keyframes, transitions, markers). Reuses Creative Canvas's typed-port/edge/undo/autosave engine so agent + human edit the *same* document.
- **Render lane** — pure function `timelineDoc → Remotion composition → mp4`. **Adopt Remotion as a real dependency** (new `apps/video` or inside `apps/web`) — this is the biggest net-new build item.
- **Agent tool surface** — expose read + mutate as tools through superclaw's *existing* "expose-to-agent" MCP posture (NOT the external-MCP consumer path, which is stdio-only + POSIX-only + fail-closed on our Windows box).
- **Generation** — clips can carry a Seedance prompt; producing the asset is an **explicit, governed** action (never on default path), consistent with Creative Canvas's current "local safe mode".

## 5. Tool taxonomy (blueprint stolen from palmier's 46 tools — design only, zero code)
Map palmier's proven agent-NLE surface onto our stack. Start with a **minimal read+mutate+render** core; defer the rest.

| Group | Tools (P1 core in **bold**) | Notes |
|---|---|---|
| Read | **get_timeline**, **inspect_timeline** (render preview frame), get_media, get_transcript | read-only, always safe |
| Timeline mutate | **add_clip**, **move_clip**, **split_clip**, **remove_clip**, set_clip_properties, set_keyframes, apply_layout (split/PiP/grid), add_transition | the editing core |
| Text/caption | add_text, update_text, add_captions | reuse Seedance/whisper transcript if available |
| Color/FX/audio | apply_color, apply_effect, remove_silence, detect_beats | later phase |
| Generation | **generate_clip (Seedance)**, generate_image | explicit + governed, no paid on default |
| Export | **export_mp4 (Remotion)**, export_fcpxml | render lane output |

## 6. Governance (non-negotiable, per constitution)
- **Fail-closed + no-paid-default**: generation/export that spends anything is an explicit, human-gated action; default path is local-safe (matches `apps/creative-canvas` today).
- **Cross-platform**: must run on Windows dev + Linux CI; no OS-locked deps.
- **Runtime selectors** (铁律6) apply if any agent-runtime choice is surfaced.
- **Tests + gate**: new logic gets unit tests (timeline model, render mapping) + apps/web tests added to the whitelist; lands through the standard PR + full-CI + Codex gate.

## 7. Phased roadmap (each phase = one reviewable increment)
- **P0 — this doc.** Design approval.
- **P1 — Timeline data model + read tools.** Pure TS model (tracks/clips/keyframes) + unit tests; `get_timeline`/`inspect_timeline` read tools; NO UI yet. Small, safe, high-signal.
- **P2 — Timeline UI in Creative Canvas.** New timeline surface/node reusing the node-graph engine (tracks lane, drag clips, trim, keyframes). Human editing works.
- **P3 — Remotion render lane.** Adopt Remotion dep; `timelineDoc → composition → mp4`; `export_mp4`. This is the heaviest phase (net-new dep + render pipeline).
- **P4 — Agent mutate tools + Seedance generation.** `add/move/split/remove_clip`, `generate_clip` (governed), wired through the MCP-server posture so an agent can draft an edit end-to-end.
- **P5 (optional) — interchange export** (FCPXML) for handoff to external NLEs.

## 8. Risks / open questions
- **Remotion adoption cost** — it's currently intent-only (no `package.json` entry). P3 is the real lift; validate a minimal Remotion render on Windows + Linux CI early.
- **Scope creep** — a timeline can balloon into a full NLE. Hold to the minimal core (§5 bold) first.
- **Agent-mutate UX** — how the agent's draft edits surface to the human for review/finish (optimistic apply + review panel, mirroring the Mission Control dispatch pattern).
- **Where the surface lives** — extend `apps/creative-canvas` (a new document/node type) vs a sibling `apps/video`. Leaning: extend Creative Canvas (reuse engine, already embedded).

## 9. Bottom line
palmier validates the *shape* (agent-drivable timeline + generation + MCP) and hands us a free 46-tool API blueprint. We build it **natively, cross-platform, governed**, on assets we already own — no Mac, no GPL, no paid coupling, no vendor lock. Recommended first build step after approval: **P1 (timeline model + read tools + tests)** — smallest increment that proves the spine.
