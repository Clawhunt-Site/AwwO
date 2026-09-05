# Accounts, languages, and reliable execution

## Requested behavior

Continue from the published AwwO Agent canvas. A component remains an independent Agent workspace with Session management, conversation, and expandable deliverables. Preserve the compact canvas and existing node/template contracts.

The operator authorized implementation, complete-chain testing, and publication. Work is isolated on `codex/accounts-i18n-state`, based on `v0.2.0` (`22e5089360c230fcf8fba4d7ecadce5f7d7f62d1`).

## Account foundation

Expose the existing control-plane account, profile, workspace, membership, role, and invite APIs in AwwO. The server remains the authority for access and the last-owner invariant. Copying an invite link does not send an email or notification.

ClawHunt's external identity and the control-plane session are currently separate trust domains. A ClawHunt display identity must never confer a workspace role or administrator permission. Show local trusted mode explicitly and provide the native login/team entry when authenticated mode has no session. Workspace selection in the account panel selects the membership administration context; it does not silently rebind nodes or claim to isolate an existing canvas.

Cross-service ClawHunt session exchange requires a separately verified identity contract. Do not introduce an unverified token-to-admin shortcut or modify the vendored server to simulate it.

## Languages

Use the existing explicit language preference (`superclaw_locale`), falling back to the browser language. Cover Chinese and English across canvas navigation, built-in templates, component labels, forms, inspector, planning, and execution status. Keep locale selection available from the canvas.

The document language follows the chosen UI language. Template IDs, ports, schema keys, and execution protocol stay stable. Never translate or overwrite existing user-authored titles, messages, field values, or deliverables when switching language.

## Execution-state audit

Verify planning, applying plans, manual edits, binding, independent Sessions, contract validation, dependency fan-in, streaming, successful output, failure, cancellation, rerun, and reload recovery against the real server lifecycle.

The initial audit found that UI abort did not cancel the native Agent run, bound-node configuration could drift from the Agent, and late events could mutate terminal output. Scoped progress and reload recovery also need explicit states. The implementation must preserve backend truth: an unconfirmed stop cannot be reported as a completed cancellation, and a lost browser connection cannot unlock duplicate execution.

## Verification and delivery

1. Add focused regressions for confirmed defects and account/language contracts.
2. Run the affected Web and Gateway suites, type checks, and builds.
3. Run a fresh local instance and exercise the real Codex planner and Agent chain. Check native run IDs and final statuses, Session continuity, structured outputs, cancellation, and reload behavior.
4. Inspect both languages and the account controls in the actual browser; distinguish local-mode evidence from authenticated membership evidence.
5. Complete independent review, record exact verified limits, version the iteration, and push only the verified changes. Keep `v0.2.0` immutable.

## Initial release readback

Forgejo Git transport accepted `dev` and annotated `v0.2.0`. A separate remote bare clone matches commit `22e5089360c230fcf8fba4d7ecadce5f7d7f62d1`, tree `14593ebcd66d293873a99f59fab6364530fe71ed`, and vendored server tree `729b741740efba9dae8807db58db7b730a8a0b93`.

At iteration start, Forgejo REST metadata still reported `empty: true` and no branches despite those Git refs. Treat this as an unresolved repository-service metadata fault, not missing source or successful UI acceptance. No repository deletion, history rewrite, or global maintenance is authorized by this record.
