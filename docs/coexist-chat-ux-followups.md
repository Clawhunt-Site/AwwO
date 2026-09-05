# Coexist chat-UX session — follow-ups / not-yet-done

Handoff for the chat-experience work landed on `feat/coexist-clean` (2026-06-29).
What shipped is listed first for context; everything under **Open / not done** is
deliberately deferred, blocked externally, or out of this session's scope.

## Shipped this session (committed on feat/coexist-clean)

| commit | what |
|---|---|
| `afbcd920` | chat path uses its own lean system prompt (charter), company path unchanged; fail-closed eligibility |
| `c206052f` | codex_local: `--skip-git-repo-check` for local managed workspaces (chat no longer fails the git-trust gate) |
| `fcf80241` | gemini_local: report the real stderr error, not the "YOLO mode" notice |
| `178b6aa1` | persistent Projects/Chats sidebar via a server-provided built-in Chat home |
| `283bda1f` | chat composer defaults to claude_local (not the first alphabetical runtime) |
| `6ef5bbc9` | chat sessions excluded from the company board lists/counts |
| `492dbd2c` | acpx_local dropped as a chat backend (incomplete adapter) |

Acceptance: each gated by Codex (gpt-5.5). AGY was skipped per owner instruction
for the last four (acpx-disable, board-exclude, default-backend, built-in-home);
the first three (lean prompt, codex, gemini) had the full Codex+AGY dual gate.

## Open / not done

### 1. Packaged desktop/app routing gap (BIGGEST — pre-existing, not introduced here)
The coexist split (chat→Node, rest→Python) currently works only under `vite dev`
via the dev proxy (`apps/web/vite.config.mjs` `nodeOwnedProxy`). A **packaged**
desktop/web build has **no Node front door**, so in production:
- Node-owned routes (`/api/chat`, `/api/workspaces`, `/api/backends`, board
  `/paperclip-api`, …) are unreachable / fall through to Python.
- The vendored Node `server/server` is not started by the frozen desktop sidecar.
Fix direction (see [[coexist-packaged-routing-gap]] memory + dev/server-refactor
ledger): a single front door + a route-ownership manifest (Node-owned prefixes
fail-closed 503, never silently to Python), and the desktop bundle must launch +
supervise the vendored Node alongside Python. **None of this session's chat work
is reachable in a packaged app until this lands.**

### 2. acpx_local chat-output parsing (deferred — adapter disabled instead)
acpx_local is an incomplete ACP bridge: it emits raw `acpx.*` protocol frames and
`[paperclip]` operational notes into the chat output instead of clean text. This
session **disabled** it as a chat backend (removed from
`CHAT_ELIGIBLE_ADAPTER_TYPES`) rather than fixing the parsing. To re-enable acpx
for chat later, its streaming frames must be decoded into a clean assistant
message (and `[paperclip]` notes stripped) in the chat-compat output path; then
add it back to the allow-list.

### 3. gemini_local auth (EXTERNAL — not fixable in our code)
gemini_local fails with `IneligibleTierError: This client is no longer supported
for Gemini Code Assist for individuals … migrate to the Antigravity suite`. This
is Google deprecating the gemini-cli auth tier (same reason the gemini-cli-advisor
was retired). We only made the adapter report the real error (`fcf80241`). To make
gemini_local usable, the gemini CLI's auth must be migrated (Antigravity), or use
claude_local/codex_local instead. Tracking only — no code change available.

### 4. Sticky acpx sessions are intentionally not migrated
Existing chat sessions whose sticky runtime is `acpx_local` still list acpx in the
composer (so they are not orphaned) — by design (the reconciliation effect
early-returns on an existing selection). New sessions never get acpx. If a clean
migration is wanted, add a one-shot "move sticky acpx sessions to claude_local".

### 5. [paperclip] notes universal stripping (not done — mostly moot)
`[paperclip] …` adapter system-notes only leak into chat output on failure or for
acpx (now disabled); claude_local/codex_local are clean. A universal "strip
`[paperclip]`-prefixed system notes from the displayed assistant message" would
harden all backends/failure cases but was not needed once acpx was disabled.

### 6. Owner's "original projects/chats" location (ops, not code)
The chat test ran on an **isolated** instance (`~/.superclaw/coexist-e2e`). The 15
projects on port 3100 belong to a **different app ("BossFlow")** that merely shares
the `coexist-node` DB — not the SuperClaw coexist chat data. Where the owner's
original coexist projects/chats live (which `PAPERCLIP_HOME`) is unresolved; needs
the owner to confirm the instance before they can be reattached.

### 7. Pre-existing test failure (not introduced here)
`server/packages/adapters/gemini-local/.../execute.remote.test.ts >
"pre-selects gemini-api-key auth … sandbox execution"` fails on a clean tree too
("Could not determine remote file size" — an SSH/sandbox remote-mock issue, plus a
stale compiled `dist/*.test.js` being picked up). Unrelated to this session; worth
a separate look.
