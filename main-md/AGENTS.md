# AGENTS.md instructions

SuperClaw's project-specific workflow is Goal Go style: develop in a dedicated
worker worktree and branch, merge the completed worker branch into
`dev/roadmap` only for local development/test integration, then open or update
the PR from the verified original worker or feature branch unless the operator
explicitly approves a different source.

<!-- dev-rules:start -->
## Dev Rules Policy

This project follows a three-environment development flow. Keep code, config, tests, and deployment state aligned with these rules before treating work as complete.

### Branch Roles

- `main` is the production mirror.
  - Do not use `main` for active development.
  - Do not commit directly to `main`.
  - Production deployments may only come from `main`.
  - Local `main` must stay aligned with `origin/main` unless explicitly preparing a release.
  - Protect `main` with GitHub branch protection when the repo account has admin or maintain permission. If protection cannot be applied, this direct-push ban still applies as team policy.

- `staging` is the optional online acceptance branch once the remote branch
  exists and the operator has enabled staging-first PRs for this repository.
  - Feature branches are proposed to `staging` from their original worker
    branch before production only after that branch exists and is enabled.
  - `staging` deploys to the staging environment only.
  - Full end-to-end testing, browser smoke tests, capability workshop flows, admin review flows, and registry sync tests must run against staging.
  - Staging must never use production database, production object storage, production payment keys, production OAuth callbacks, or production webhook targets.
  - Staging domains are treated as discoverable and must sit behind an outer access gate before serving the app shell.
  - Protect `staging` with GitHub branch protection when possible. If protection cannot be applied, direct pushes require explicit operator approval recorded in the handoff.

- `dev`, `development`, and `dev/roadmap` are development integration or coordination branches.
  - They are not production branches.
  - They are not production deployment targets.
  - They may be unstable and may be used for integration planning, roadmap validation, coordinated worker development, mock flows, and early debugging.

- `codex/*` and feature branches are development branches.
  - They target the operator-approved remote branch after local `dev/roadmap`
    verification.
  - Use `staging` as the first PR target only when that branch exists and the
    operator has enabled staging-first acceptance for this repository.
  - They remain the PR source branch for later production PRs after any staging
    verification.
  - They should run CI before PR. Note: as of 2026-06-21 the remote GitHub
    Actions CI for this repo is paused (`gh workflow disable ci.yml`); until it is
    re-enabled, run the FULL `ci.yml` steps locally and pass them before pushing a
    PR (the local self-check is the only gate). See the "远端 CI 已暂停" rule in
    `CLAUDE.md` for the exact command checklist and how to restore remote CI.
  - They must not deploy directly to production.

### Environment Roles

- `development`
  - Local developer environment.
  - May use SQLite, mocks, local files, fixtures, and test credentials.

- `staging`
  - Production-like online acceptance environment.
  - Must be protected by an outer access gate such as OAuth-backed Cloudflare Access, Google Cloud IAP, Basic Auth, VPN, or IP allowlist.
  - Unauthorized visitors must see only the gate login or block page, never the app.
  - Must use separate staging database, staging object storage buckets, staging API keys, staging OAuth callbacks, sandbox payment credentials, staging webhook targets, and staging queue or worker resources.
  - May contain test data.
  - Must be safe for full end-to-end testing.
  - If no sandbox exists for a provider, do not test that provider's live side effects in staging. Document the missing sandbox and keep the feature disabled, mocked, or excluded from acceptance evidence.

- `production`
  - Real user environment.
  - Must not receive test posts, mock data, destructive E2E tests, fake marketplace submissions, or experimental worker output.
  - Only read-only smoke checks are allowed after deploy.

### Required Promotion Flow

The required promotion path is:

```text
codex/* or feature branch -> dev/roadmap local integration -> PR from same branch to approved target branch
```

The worker or feature branch stays the source branch throughout the promotion
chain. Do not open `dev/roadmap` -> `main` by default; that is an
integration-branch PR and requires explicit operator approval. If a remote
`staging` branch exists and the operator enables staging-first acceptance, use
the same worker branch as the source for the staging-target PR and, after
staging verification, for the main-target PR.

Do not require a staging-target PR before the remote `staging` branch exists.
Once staging-first acceptance is enabled, do not skip staging unless the user
explicitly approves an emergency production hotfix. If a hotfix skips staging,
record the reason and reconcile the change back into `staging` immediately
after production stabilization.

### Staging Domain and Access Policy

- Treat staging URLs as public knowledge. DNS records, certificate transparency logs, crawlers, screenshots, and shared links can expose them.
- Prefer a protected subdomain under the production brand domain, such as `staging.<primary-domain>`, for normal staging. Use a separate top-level domain only for intentionally isolated experiments, regional compliance sites, or brand tests.
- Put the entire staging site behind an outer access gate before the application shell loads. OAuth-backed Cloudflare Access or Google Cloud IAP are preferred; Basic Auth, VPN, or IP allowlist are acceptable when they match the team workflow.
- Keep the outer access-gate login separate from the app login. Testers may first authenticate with the gate, then log into the app with staging test accounts. The gate may use a bounded session cookie so users are not challenged on every page load.
- Expose third-party callback paths only when required. Keep callback URLs, sandbox credentials, signature verification, and webhook secrets separate from production.
- Add staging crawl controls: `robots.txt` should disallow all crawling and staging responses should set `X-Robots-Tag: noindex, nofollow`. These are crawler hints, not a security boundary.
- Show a clear `STAGING` marker in the UI, such as a top banner, watermark, distinct title, or distinct favicon.
- Scope staging cookies so they cannot collide with production. Avoid broad parent-domain cookies such as `.example.com` unless explicitly justified.
- Restrict staging CORS to the staging origin and explicitly approved preview origins. Do not mix production origins into staging by default.

### Staging Secret Reuse Exceptions

The default rule is separate staging resources and separate staging secrets. Production secrets must not be reused for staging acceptance.

When the operator has no staging/sandbox account for a provider, a temporary production-backed exception is allowed only under all of these conditions:

- The variable is explicitly documented as `production-backed` in the runbook, deployment notes, or PR handoff.
- The related feature is disabled, mocked, or excluded from acceptance. Do not count it as staging-verified.
- The staging test plan does not trigger real user email, real payment, real webhook delivery, real repository writes, real marketplace execution, real wallet movement, or other irreversible provider side effects.
- The exception has an owner and a follow-up to replace it with a sandbox or staging provider.

Treat these variables as dangerous if they point at production and do not exercise their side effects from staging: `SMTP_PASS`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, production OAuth callbacks, production database credentials, production webhook targets, production wallet keys or addresses, `GITHUB_PROVISION_TOKEN`, and `AGENT_MALL_EXECUTOR_KEY`.

`ADMIN_PASSWORD_HASH` should be a staging-only hash for a staging-only admin password. Do not reuse the production admin hash except for an explicitly approved, read-only emergency check, and rotate it afterward.

### Unified Configuration Policy

- Use one configuration schema for all three modes: `development`, `staging`, and `production`.
- Prefer the repo's existing environment selector. If none exists, use one explicit selector such as `APP_ENV=development|staging|production`.
- Every environment-sensitive feature must expose configurable values for all three modes before it is considered complete, even if the exact staging or production value is not known yet.
- Keep configuration names stable across environments. Change values by environment, not code paths.
- Add or update `.env.example`, config validation, deployment docs, tests, and CI secret names when new environment variables are introduced.
- Use placeholders for secrets in committed files. Real secrets must live outside git.
- Do not hardcode production URLs, database names, object storage buckets, OAuth callback URLs, payment keys, webhook targets, or queue names in application code or tests.
- Staging tests must prove that staging uses staging resources. If any staging variable points at production, stop and report the exact variable before running acceptance tests.

### Progressive Environment Discovery

Project initialization may not know every environment variable the system will eventually need. That is acceptable. The requirement is that development work must discover and externalize environment-sensitive values as they appear.

During implementation, Codex must treat these as config candidates before hardcoding them:

- hostnames, API URLs, callback URLs, webhook URLs, redirect origins, ports, and public app URLs
- database DSNs, schema names, migration targets, bucket names, storage prefixes, queue names, and worker namespaces
- API keys, OAuth clients, payment keys, signing secrets, tokens, model names, provider accounts, and feature flags
- cron schedules, retry policies, rate limits, admin IDs, allowlists, and external service modes

If a value can differ between local development, staging, and production, put it behind the project config system first. If the correct variable name, environment value, or secret owner is unclear, stop and ask the user a targeted question. Use local-safe defaults only for development and placeholders for staging or production until confirmed.

### Project Initialization Expectations

When initializing or refreshing this project, Codex should:

- inspect the existing config system before adding new files
- ask the user for missing environment decisions rather than guessing production-like values
- keep one variable schema that can be filled for local development, staging, and production
- preserve unknown future values as named placeholders instead of blocking initialization
- update non-secret examples or docs so future agents know which values must exist
- clearly report unset secrets, staging gaps, and production gates before code is considered ready

### Required Configuration Surfaces

When a feature touches any of these surfaces, leave enough variables or secret references for `development`, `staging`, and `production`:

- public app URL and API base URL
- database URL and migration target
- object storage bucket, region, endpoint, and prefix
- OAuth client, callback URL, and allowed redirect origin
- payment provider mode, account, public key, and secret key
- webhook signing secret and delivery target
- background queue, worker namespace, scheduler, and retry policy
- email, notification, analytics, and third-party API credentials
- admin review, registry sync, artifact publishing, and marketplace endpoints

### CI Policy

- Pull requests from feature branches run lightweight checks:
  - unit tests
  - lint
  - type or static checks
  - affected build checks

- Pushes or merges to `staging` run full acceptance checks:
  - backend tests
  - frontend tests
  - build
  - browser smoke
  - local or mock E2E
  - staging deploy verification
  - staging release gate

- Pushes or merges to `main` run production release checks:
  - deploy verification
  - production release gate
  - read-only production smoke only

### Capability Workshop Policy

Capability Workshop full-chain tests must run on staging before production:

- developer upload
- admin review
- official publish
- immutable artifact storage
- registry sync
- SuperClaw plugin, skill, or company list consumption

Production must not be used to generate test submissions, fake marketplace data, destructive review flows, or experimental capability artifacts.
<!-- dev-rules:end -->

## SuperClaw Standalone Chat Worktree Protocol

This repository is often worked on from separate Codex or Claude chats. Treat each standalone delivery chat as an isolated worker unless the user explicitly says it is read-only.

### Source Of Truth

- `/Users/leongong/Documents/superClaw` stays on `main` and is only the local mirror of `origin/main`.
- `/Users/leongong/superclaw-wt/roadmap` stays on `dev/roadmap` and is the local development/testing integration worktree, not the default PR source branch.
- `coordination.md` is the first project-specific coordination file to read before merge, push, PR, or branch-topology work.
- Do not infer branch freshness from memory. Verify the actual branch, worktree, remote, and dirty state every run.

### New Chat Startup

At the start of any non-trivial implementation chat:

1. Confirm `pwd`, `git rev-parse --show-toplevel`, `git status --short --branch`, `git branch --show-current`, `git remote -v`, and `git worktree list --porcelain`.
2. Read `coordination.md`, `AGENTS.md`, and `CLAUDE.md` before choosing a write location.
3. Fetch remote refs before comparing branch freshness. If a networked fetch, push, package install, or API command fails due to connection, TLS, HTTP/2, or reachability, retry once through `http://127.0.0.1:10808` before calling it blocked.
4. If `/Users/leongong/Documents/superClaw` or `/Users/leongong/superclaw-wt/roadmap` is dirty or divergent, report the exact files or commits before merging, rebasing, resetting, pushing, or opening a PR.
5. Refresh `main` only by fast-forwarding to `origin/main`. Do not reset, force checkout, or overwrite local files without explicit user approval.
6. Refresh `dev/roadmap` from the updated `main` before using it as the baseline when the worktree is clean. Resolve or report conflicts in `dev/roadmap`; do not hide them inside a worker branch.

### Worker Worktree Rules

- Use one dedicated worktree and one `codex/<slug>` or `feat/<slug>` branch per independent change.
- Prefer the chat-provided worktree when Codex has already created one. If creating a manual worktree, place it under `/Users/leongong/Desktop/LeonProjects/gho_workspace/superClaw-worktrees/<slug>` and add `creator.md` in the new folder root.
- Create worker branches from the latest `origin/main` mirror, not from stale `main`, `dev/roadmap`, or another unfinished worker branch.
- Keep write ownership narrow. Do not edit files owned by another active worker unless the user explicitly assigns integration ownership.
- Do not commit directly on `main` or `dev/roadmap`. Worker commits happen on the worker branch; integration into `dev/roadmap` happens only after local verification and acceptance review.

### Merge And PR Flow

Default local flow:

```text
origin/main -> worker worktree branch -> verified worker commit -> dev/roadmap integration -> PR from worker branch
```

Operational rules:

- Merge worker branches into `dev/roadmap` only after tests/checks for the touched scope pass.
- Before integrating a worker branch, re-fetch and re-check `main`, `dev/roadmap`, and sibling worktrees for dirty or conflicting state.
- Use `dev/roadmap` only to prove the combined local integration/test state; do not treat it as the default remote PR source branch.
- Open or update the remote PR from the verified original worker branch after `dev/roadmap` is synced, tested, and accepted.
- Target `staging` first for online acceptance only after the remote branch
  exists and the operator has enabled staging-first acceptance for this
  repository.
- If staging-first acceptance is enabled, open or update the `main`-target PR
  from the same worker branch after staging verification; do not switch the PR
  source to `staging`.
- Never target `main` before local `dev/roadmap` verification. After
  staging-first acceptance is enabled, also require staging verification unless
  the operator approves an emergency-hotfix path.
- For frontend-touching PRs, apply the global frontend sync gate before PR creation or update: fetch the target branch, absorb latest frontend changes using the repo's normal merge/rebase workflow, then re-check that the diff does not clobber teammate work.
- Before any `git push`, pass the version/changelog gate in the global instructions: `VERSION`, `CHANGELOG.md`, SemVer, `Unreleased`, at least one release heading, and current changes recorded.

### Desktop Packaging Intent Gate

Before building, packaging, replacing, or distributing any SuperClaw desktop APP bundle, identify the operator intent as exactly one of:

- `test` / `staging acceptance`: build with `APP_ENV=staging` and matching `VITE_APP_ENV=staging`, using staging ClawHunt URLs and staging-safe secrets only.
- `production release`: build with `APP_ENV=production` and matching `VITE_APP_ENV=production`, using production ClawHunt URLs only after the user explicitly asks for production/release.
- `development local`: build with `APP_ENV=development` only for local debugging or local service testing.

Rules:

- If the user's wording is ambiguous, ask whether they want a testing/staging build or a production build before starting the package step.
- Do not infer production intent from "build", "package", "replace app", "I want to test", or "make it runnable". Default unclear local operator testing to `staging` or `development`, not `production`.
- Never build or replace a production APP bundle unless the user explicitly says production, release, or production ClawHunt.
- Keep `APP_ENV` and `VITE_APP_ENV` aligned. If both are present, they must normalize to the same environment.
- Keep backend/frontend ClawHunt URL pairs aligned. If both `CLAWHUNT_*` and `VITE_CLAWHUNT_*` are present, they must point at the same URL.
- Do not bake secrets such as `CLAWHUNT_AGENT_API_KEY`, account tokens, relay keys, OAuth secrets, payment keys, or webhook secrets into desktop builds. Configure secrets at runtime through login, Runtime Settings, local environment, or a secret manager.
- After packaging, verify the built `.app` or `.dmg` contains only the intended ClawHunt target and does not include the other environment's URL or the local marketplace default.

### Approval Gates

- Local inspection, local worktree creation, local edits, local tests, and local commits are allowed when the user asks for implementation and the worktree is clean enough to isolate the requested change.
- Remote state changes require explicit user approval in the active chat: `git push`, opening/updating/closing PRs, merging PRs, branch protection changes, deployments, releases, and destructive cleanup.
- Destructive or history-rewriting commands require explicit approval: `git reset --hard`, `git checkout -- <path>`, `git clean`, force push, branch deletion, worktree removal with unmerged commits, or any command that can overwrite user work.

### Verification And Handoff

- Match verification to scope: Python tests/lint for core changes, web tests/build for frontend changes, desktop build and installed-app proof for desktop-visible changes, and integration checks from `dev/roadmap` before remote PR work.
- Keep commits atomic: one independent change per commit, with `type(scope): summary`.
- Final handoff must report the worktree path, branch, base branch and base SHA, changed files, commits, verification commands and results, PR URL if created, and any residual risk or approval still needed.
