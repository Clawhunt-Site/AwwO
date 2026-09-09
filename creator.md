# AwwO main synchronization candidate

- Created by Codex for the repository owner on 2026-09-08.
- Purpose: resolve conflicts between the completed Go/Pi SaaS work and the fetched main baseline in an isolated detached worktree.
- Source: codex/awwo-node-setup-20260908 at b9a65390c237907f951232c4c03c758324546188.
- Target baseline: origin/main at fc5cbda9e4028837009369471ec2d54b94a985a5.
- Scope: conflict preparation, local verification and exact-SHA review. Existing branches, running services and user data are preserved; merge/publication remain separately gated.

## Previous worktree: AwwO Go and Pi SaaS development

- Created by Codex for the repository owner on 2026-09-07.
- Workspace: `/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-saas-20260907`.
- Branch: `feat/awwo-go-pi-saas`.
- Source: `ClawHunt-Store/AwwO`, `origin/main` at `6e1dc158a79e2f18c7bdf82610a353883b883f31`.
- Purpose: preserve the existing Agent canvas while implementing a Go multi-tenant API, an isolated Pi runtime, a SaaS user/admin entry, and local verification.
- Scope: local development and tests. Remote publication, merges and production deployment require their own authorization.

## Previous iteration provenance

- Owner: Codex, requested by the repository operator on 2026-09-05.
- Worktree: `AwwO-worktrees/accounts-i18n-state`.
- Branch: `codex/accounts-i18n-state`.
- Base: AwwO `v0.2.0`, commit `22e5089360c230fcf8fba4d7ecadce5f7d7f62d1`.
- Scope: account/workspace controls, Chinese/English canvas presentation, and verified execution-state transitions.
- Shared source and the published release stay intact. Sub-agents own separate modules in this iteration worktree.
- Remote publication is explicitly authorized by the operator. This is a local development release; production deployment and desktop distribution are outside this iteration.

## Node initialization repair worktree

- Created by Codex for the repository owner on 2026-09-08.
- Workspace: `/Users/leongong/Desktop/LeonProjects/gho_workspace/awwo-node-setup-20260908`.
- Branch: `codex/awwo-node-setup-20260908`.
- Base: `codex/awwo-node-teams-20260908` at `d0fb9a7445b00a238d87dcc5232d8941ab905f62`.
- Purpose: complete the SaaS configuration-to-runtime flow and remove persistent missing-binding notices.
- Scope: isolated Go/Web changes, tests, documentation and local browser acceptance. Existing source worktrees and user data are preserved.

## Upstream worktree: AwwO empty-server acceptance

- Owner: Codex, requested by the repository operator on 2026-09-05.
- Worktree: `AwwO-worktrees/server-acceptance`.
- Branch: `codex/server-acceptance`.
- Base: AwwO `v0.3.0`, commit `6e1dc158a79e2f18c7bdf82610a353883b883f31`.
- Scope: private Linux deployment tooling and real empty-server acceptance.
- Shared source and the published release stay intact. Sub-agents own separate modules in this iteration worktree.
- The operator authorized a dedicated AWS acceptance host; acceptance.5 is deployed and the real browser/native chain has passed. Production deployment and desktop distribution are outside this iteration. The increment remains uncommitted pending the remaining dual-advisor commit gate.

## Isolated online integration preview — 2026-09-09

Created by Codex for the user's request to push current main to online. This detached worktree materializes a merge-tree preview for conflict resolution and tests; it does not finalize a merge or update any named source/release ref. Inputs: main 48b96d7fd188d66215d313ddecdf2ad96ecb928d and online cd9b3b490e96529b5b3ee9e7c08a004b71fbe070. Scope: preserve both lines of work and prepare exact-SHA approval evidence.
