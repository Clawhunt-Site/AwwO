# CodePilot → ClawHunt Desktop: Capability Absorption Roadmap

> Goal: iteratively make ClawHunt's desktop "completely absorb the capabilities and
> strengths" of [op7418/CodePilot](https://github.com/op7418/CodePilot) (an
> Electron + Next.js multi-model AI-agent desktop client).
>
> **License guardrail (non-negotiable):** CodePilot is **BSL-1.1** (commercial use
> restricted). Every item below is "**adopt the pattern / re-implement from
> scratch**" — we never copy CodePilot source into this commercial product.
>
> Status legend: ✅ done · 🔨 in progress · ⬜ planned

---

## 1. Executive summary

The single highest-leverage lesson from CodePilot is **storage architecture**.
CodePilot's *entire* persistence layer is **one WAL-mode SQLite file** at
`~/.codepilot/codepilot.db` — a library linked into the process, **no server, no
daemon, no port, nothing to orphan** on Windows. ClawHunt's desktop instead ships
an **embedded PostgreSQL** that spawns a real `postgres.exe` child cluster. That
child is exactly what caused the recurring `node_unavailable` / `/api/chat/stream
503`: it is started detached by `pg_ctl`, survives the app's `taskkill /F /T`, and
the next launch collides two Postgres servers on one datadir (`ECONNRESET`).

- **P0 (shipped, v0.1.6):** stop the bleeding — a Windows orphan-sweep in
  `node_runtime.py` reaps the detached postmaster by datadir so each launch owns its
  DB exclusively. This makes the *current* architecture reliable.
- **P2 (strategic):** evaluate migrating the desktop's local store off embedded
  PostgreSQL toward a single-file/zero-process store, which eliminates the entire
  orphan-DB fragility class rather than policing it.

Everything else (session rewind, reasoning levels, model switching, cost tracking,
generative UI, scheduler, remote IM bridge, persona/memory) is UX surface area we
absorb incrementally on top of a now-stable base.

---

## 2. Capability gap table

| Capability | CodePilot | ClawHunt today | Value | Effort | Verdict |
|---|---|---|---|---|---|
| **Local store = single-file SQLite (WAL)** | 1 file, 0 processes, nothing to orphan | Embedded PostgreSQL child (orphaned on Win → 503) | High | High | **P2 strategic** (P0 mitigation shipped) |
| **Reliable sidecar teardown** | Electron reaps forked server on quit | Watchdog `taskkill` missed detached PG | High | Low | ✅ **v0.1.6** (orphan-sweep) |
| **Random-port server + marker discovery** | forks Next.js on random free port | dynamic-port fallback + run-dir marker already | High | — | ✅ **Already have** |
| **Code-driven idempotent migrations** | `ADD COLUMN` on boot, no tool | `ensure_column()` (Python) + 125 Drizzle pg migs (Node) | Med | Low | ✅ Already have (Python); N/A (Node) |
| **Session rewind / checkpoints** | context-compaction summary + boundary rowid on session | goals/runs, no explicit rewind-to-checkpoint | High | Med | ⬜ **P1** |
| **Model switch mid-conversation** | per-turn provider/model on the session row | backend-policy per chat; limited in-UI switch | High | Med | ⬜ **P1** |
| **Reasoning levels + Thinking toggle** | Low/Med/High/Max + thinking flag in settings | Fable-5 adaptive thinking server-side; not user-exposed | Med | Low | ⬜ **P1** |
| **Per-message token + cost tracking** | `messages.token_usage` JSON, daily charts | usage in relay; not surfaced per message | Med | Med | ⬜ **P1** |
| **Code / Plan / Ask modes** | 3 explicit modes on session | Workbench + board modes; not the same triad | Med | Med | ⬜ P1 (align naming/UX) |
| **Generative UI (AI-authored dashboards)** | model emits live widgets | static React surfaces | Med | High | ⬜ P2 |
| **Task scheduler (cron/interval)** | in-app scheduler table | automation gateway (cron) exists | Med | Med | ◑ Partial → **P1** (surface UI) |
| **MCP servers (stdio/SSE/HTTP)** | runtime-monitored | plugins/MCP + Composio connectors | — | — | ✅ Already have |
| **Skills (custom/project/global + marketplace)** | skills.sh | Workshop + skill install bridge | — | — | ✅ Already have |
| **Remote IM bridge (TG/Feishu/Discord/QQ/WeChat)** | control from phone | none | Med | High | ⬜ P2 |
| **Assistant persona + long-term memory files** | soul/user/claude/memory.md | charter `CLAUDE.md` (v0.1.5) — persona only | Med | Med | ◑ Partial → **P1** (add memory) |
| **File browser + Git panel** | syntax preview, branches/worktrees | workspace attach + reveal; no rich panel | Low | Med | ⬜ P2 |
| **17+ BYO providers** | direct keys per provider | relay-first + BYO Anthropic/codex | Med | Med | ⬜ P2 (broaden BYO) |
| **Image generation + gallery** | Gemini batch + gallery | none in desktop | Low | Med | ⬜ P2 |
| **Multimodal attachments (file/image)** | vision in chat | limited | Med | Med | ⬜ P1 |
| **Slash commands (/clear /cost /compact…)** | in composer | none | Low | Low | ⬜ P1 (quick win) |

---

## 3. Phased plan

### P0 — this iteration (v0.1.6) ✅ SHIPPED

**Recurring-503 root fix.** `packages/superclaw/src/superclaw/node_runtime.py`:
Windows orphan-sweep that kills any `node.exe`/`postgres.exe` whose command line
carries *this instance's* server entry (`<server_dir>/dist/index.js`) or instance
home (`<node_home>/instances/<id>`, under which the postmaster's `-D` datadir
sits). Runs at startup pre-clean (guarantees exclusive datadir → the fix) and on
clean-exit `stop()`. Identity by path match, never bare process name. Tests +
green suite. This makes the embedded-PG architecture reliable *now*.

### P1 — next iterations (low/medium effort, high value)

1. **Slash commands** (quick win). Add `/clear`, `/compact`, `/cost` to the chat
   composer in `apps/web/src/App.tsx`; wire to existing chat/session endpoints.
2. **Reasoning-level + Thinking toggle in UI.** Surface a Low/Med/High/Max +
   Thinking control; thread it to the chat request. Backend already runs adaptive
   thinking (agent_chat) — expose it. Files: `apps/web/src/App.tsx`,
   `server/server/src/services/chat-compat.ts`.
3. **Per-message token + cost.** Persist + render `token_usage` per assistant
   message (CodePilot's `messages.token_usage` JSON pattern); add a daily usage
   view. Relay already meters — join it to the message.
4. **Model switch mid-conversation.** Let the session change model/provider between
   turns (CodePilot stores model+provider on the session row). Add a model picker
   in the chat header bound to the session.
5. **Session rewind / checkpoints.** Adopt CodePilot's cheap pattern: a
   `context_summary` + boundary marker on the session so long chats compact and can
   rewind to a boundary — no separate snapshot subsystem.
6. **Assistant memory files.** Extend the v0.1.5 charter `CLAUDE.md` into a
   `memory.md`/`user.md` pair the agent reads + appends (long-term memory), seeded
   in the relay-isolated config dir (`claude-config.ts`).
7. **Surface the existing scheduler.** The automation gateway already does cron;
   give it a small management UI (list/create/cron/interval).
8. **Multimodal attachments** in the composer (file + image → vision).

### P2 — strategic bets (high effort)

1. **Local store off embedded PostgreSQL (the flagship).** Evaluate a
   single-file/zero-process store for the desktop to delete the orphan-DB class
   entirely. **Honest effort/risk:** the Node control plane has **125 Drizzle
   `pg-core` migrations** and uses Postgres-specific features (`fuzzystrmatch`,
   JSON ops, `gen_random_uuid`, partial indexes). A full SQLite port is a large,
   risky rewrite of the data layer. **Pragmatic incremental option:** keep server
   deployments on Postgres; for the *desktop* profile, target a lighter embedded
   engine — either (a) **PGlite** (Postgres-in-WASM, single process, no external
   `postgres.exe` to orphan — smallest schema change, keeps pg SQL) or (b) a
   Drizzle SQLite dialect behind a build flag (largest change, best robustness).
   Recommendation: **prototype PGlite for the desktop profile first** — it removes
   the detached-postmaster failure mode while preserving the pg SQL + migrations.
2. **Generative UI** — model-authored interactive widgets rendered live.
3. **Remote IM bridge** — Telegram/Feishu first (op7418 has a separate
   `Claude-to-IM-skill` we can study for the *pattern*).
4. **Broaden BYO providers** beyond relay + Anthropic/codex.
5. **Rich file browser + Git panel**, image generation + gallery.

---

## 4. Notes

- CodePilot keys conversations to the Claude Agent SDK's own `~/.claude/projects/
  <cwd>/<uuid>.jsonl` transcripts via a stored `sdk_session_id`, mirroring them
  into a local table. ClawHunt's `claude_local` adapter already drives that SDK —
  a **`.jsonl` import** (adopt-the-pattern) would let users pull existing Claude
  Code CLI history into the desktop. Candidate P1/P2.
- The 503 fix's real proof is the v0.1.6 build booting node+PG with **no
  "Removing stale embedded PostgreSQL lock file" → ECONNRESET** loop.
