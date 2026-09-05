# AwwO repository

The operator requested a new Forgejo repository on 2026-09-05 to carry forward all current AwwO work. The repository is `ClawHunt-Store/AwwO`, private like its source project. `dev` is the default development integration branch. The first version is `v0.2.0`; production deployment is separate.

## Import provenance

- Source: `https://git.clawhunt.store/ClawHunt-Store/clawhunt-superclaw`.
- Source worker branch: `feat/awwo-agent-canvas`.
- Source worker base: `feat/workflow-canvas-m1@c8db2818be40511bbb42ad5435028105a738e61c`.
- Import: a current-source snapshot, including the uncommitted AwwO implementation, tests and verification documents. The original repository and its Git history remain intact. Other workers' branches and unrelated shared-checkout edits are not merged into this release.
- Initial export: 12,323 files / 360,375,151 bytes before release-specific additions and portability fixes. Executable modes and the two tracked vendor symlink blobs are preserved.
- The source `server/` tree is `729b741740efba9dae8807db58db7b730a8a0b93`; no upstream server implementation is changed by the import.
- One provider-key-shaped value in an inherited planning document was replaced by a placeholder before the snapshot was staged. Its value was not printed, tested or copied into the new repository's Git history.
- Excluded: tracked orchestration machine state, local configuration, dependency installs, live databases, authentication state, runtime secrets, process logs and caches. The generated knowledge-workbench source and necessary licensed data are included as a portable example.

## Iteration workflow

Clone the repository and branch from `origin/dev` into a dedicated `codex/*` or `feat/*` worktree. Preserve shared work, validate affected tests/builds and independently review changes before committing and proposing integration into `dev`. Keep commits focused. Use the same feature branch for review rather than treating the integration branch as an unrelated PR source.

The inherited SuperClaw instructions mention branches and hosts that belong to the original repository. This AwwO bootstrap creates `dev` as the actual integration baseline; it does not create or deploy a production `main`, change branch protection, rewrite shared history or grant broader remote-action permission. Approval, secret separation and independent-review requirements remain in force.

## Verification records

- The original real Codex graph and repair evidence remains in `docs/superpowers/`.
- Current release checks and clean-directory startup evidence are recorded in `docs/releases/0.2.0-verification.md` before publication.
- The local prototype's real-service limitations remain explicit. A provider run succeeding does not prove the generated business system is deployed or connected to real authentication/data services.
