# AwwO conversation UX implementation — 2026-09-07

Publication update: on 2026-09-07 the operator explicitly waived Gemini review for this iteration and approved commit/publication. The original pre-publication status below is retained as the audit record; the exception and v0.3.1 verification are recorded in [the release report](releases/0.3.1-verification.md). Future dual-review requirements are unchanged.

This iteration implements the first conversation and reliability improvements from the user-value review. It does not introduce subscription charging or claim that pricing hypotheses have been validated.

## Delivered behavior

- A manual message shows the user's original request. The complete execution request remains available in a disclosure, and the Agent still receives its inputs and output contract unchanged.
- A confirmed structured reply uses the field labels and types captured for that run. Markdown is rendered without raw HTML; raw responses remain available. Streaming, failed, cancelled or unconfirmed replies are not presented as final structured deliveries.
- Display metadata is optional and scoped to company, Agent, node and Session. History joins also require the exact operation/run identity, issue and original text. Storage errors fall back to the raw transcript.
- Native task descriptions remain available as collapsible conversation context after refresh. They are not deleted or guessed from message wording.
- Drafts are consumed only after durable acceptance, and only if the submitted draft is still current. Another Session's draft and a newer draft typed while ownership is pending remain intact.
- Existing deliveries can be opened while execution is running. This changes local disclosure state only; Session switching, node configuration, output editing/publishing and structural mutations remain locked.
- Structural edits check current execution ownership at invocation, including callbacks captured before a run. Add/delete, undo/redo, drag/resize, connections, configuration and layout operations remain blocked through native settlement. The command palette reflects those locks; legitimate service identity and result writes still persist.
- Recovery preserves different operations with identical text, and fills only a missing user or Agent message when part of a conversation is already present.
- Local manual-history retention removes a recovery copy only after complete native history proves both messages using their exact operation/run identity and raw text. A known full store is checked before dispatch; unavailable or incomplete native history preserves the draft and recovery evidence. An unexpectedly oversized output without durable native proof remains recoverable and locked rather than being silently discarded.
- Agent-authored Markdown images appear as explicit safe links. Viewing a transcript does not automatically contact their remote hosts.
- New Codex Agents use the native creation contract without prohibited legacy prompt-template fields. The native comment wake carries each task on both first execution and continuation; workspace sandbox settings remain intact.

## Verification environment

Dedicated worktree: `E:\Bobo's Coding cache\bo-work\AwwO-worktrees\server-acceptance`, detached from `6e1dc158a79e2f18c7bdf82610a353883b883f31`. Existing server-acceptance changes were preserved. No new source commit or server deployment is implied by this report.

The current local Web preview is `http://127.0.0.1:15181/`. It proxies unchanged request paths through the existing SSH-only acceptance endpoint on `127.0.0.1:15188`. The remote Web remains acceptance.5. Its existing Gateway and Node services execute real Codex requests. No new public listener or authentication exception was added; the local preview has its own browser storage.

Real browser evidence uses the isolated Agent `414e4923-dd0b-4e86-a834-fecc16eea491`, conversation `a6f57c0f-123b-4c27-9876-35264e4421b8`. Initial binding exposed and verified the legacy-template rejection. After repair, the browser confirmed an idle binding with its persona saved. First execution returned a welcome sentence plus the requested follow-up text, displayed under their declared labels. Native run: `b062752d-370d-4281-bd2b-0ad2e6fde701`. Complete native history is preserved locally in `.local/server-acceptance/ux-native-first-turn.json`.

The second manual request changed both fields in the same Session. A following graph execution completed 1/1 and populated the delivery drawer with those updated values. Refresh restored the original requests, all three labeled replies, collapsed conversation context and execution details; the accepted composer draft stayed empty. Chinese/English UI switching retained user content. The native history endpoint returned `complete: true`, three distinct user comments and three Agent replies with distinct native run IDs; the Agent returned to `idle`. Evidence: `.local/server-acceptance/ux-native-three-turns.json` and `.local/server-acceptance/ux-browser-receipt.json`.

This browser scenario verifies conversation presentation and repeated execution with one node. It is not a new multi-node application delivery or a payment experiment. Earlier multi-node, account and restart acceptance remains documented separately in `awwo-server-acceptance-results-2026-09-06.md`.

## Checks and release boundary

- Final Web default suite: `npm test` passed 99 files and 1,170 tests, plus the static UI gate. Log: `.local/server-acceptance/ux-web-tests-final.log`.
- `node node_modules/typescript/bin/tsc --noEmit` passed. `APP_ENV=staging VITE_APP_ENV=staging SUPERCLAW_GATEWAY_SIDECAR=off npm run build` passed; log: `.local/server-acceptance/ux-web-build-final.log`. Existing vendor CSS, mixed-import and bundle-size warnings remain.
- Independent review reproduced the recovery defects before repair and verified identity separation, half-history repair and idempotency afterward.
- A final real run verified the previously enabled Delete command is now disabled alongside Add, Undo and Redo. Automated regressions also cover non-streaming settlement and callbacks captured while idle; successful settlement still writes the output.
- That last browser run completed 1/1; native readback confirmed four user comments, four Agent replies, complete history and an idle Agent. Its run ID is `34a1d6fd-bf91-4f2a-b3d0-3e75ef27295a`; raw receipt: `.local/server-acceptance/ux-native-final.json`.
- Native Codex `gpt-5.5` adversarial re-review returned `PASS / no blocking findings` for retention, execution locks and Markdown image handling. The self-contained source packet and transcript are saved as `.local/server-acceptance/ux-rereview-packet.txt` and `ux-codex-rereview.txt`. The final full suite subsequently passed.
- Gemini CLI could not review: its cached OAuth authentication did not succeed and headless consent failed (exit 41). Two read-only official SDK metadata requests using the existing environment API key returned `403 / PERMISSION_DENIED / CONSUMER_SUSPENDED`; the provider's reason for suspending the associated consumer is unknown. No inference or code submission occurred, and no global authentication or consent setting was changed. Safe result: `.local/server-acceptance/gemini-api-status-probe.json`. The inherited `CLAUDE.md` rule requires both Codex and Gemini approval before a source commit; that gate has not been waived for this iteration. No commit or release is claimed while this remains unresolved.

Branch cleanup is independently complete: local and Forgejo contain only `main` and `online`, both at the unchanged baseline commit. See [the branch cleanup record](awwo-branch-cleanup-2026-09-06.md) for exact refs, recovery bundle and worktree preservation evidence.

## Handoff

- Source worktree: `E:\Bobo's Coding cache\bo-work\AwwO-worktrees\server-acceptance`; detached HEAD. Baseline is now `main` / `online` at `6e1dc158a79e2f18c7bdf82610a353883b883f31` (the previous v0.3.0 release).
- This iteration changes conversation rendering/presentation, Session transport and persistence, manual recovery retention, `CanvasSurface`/`CommandBar` execution guards, the Codex creation payload, bilingual messages and their tests. Source and verification records remain together in the worktree.
- Earlier Gateway, server-acceptance tooling and account verification changes were preserved. `server/` vendor remains unchanged. See the separate server-acceptance record for that scope's existing checks and deployments.
- Commits: none this iteration. Source pushes: none. PR: none. Private remote deployment remains acceptance.5; the updated local Web preview uses the real remote services through the existing loopback SSH tunnel.
- Remaining publication condition: obtain the required Gemini review through a working authorized account, or receive an explicit operator exception for this iteration's dual-review requirement. No requirement has been silently removed.
