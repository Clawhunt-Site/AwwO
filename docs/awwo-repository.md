# AwwO repository

The operator requested a new Forgejo repository on 2026-09-05 to carry forward all current AwwO work. The repository is `ClawHunt-Store/AwwO`, private like its source project. On 2026-09-06 the operator requested that local and remote branches be reduced to `main` and `online`. `main` is the default source baseline; `online` is the reviewed release reference. The first version was `v0.2.0`; production deployment is separate.

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

Use `main` as the default source baseline and maintain only `main` and `online` as named branches. Do not recreate `dev` or named worker branches. Preserve isolated work directories and use an exact-SHA detached worktree where unfinished work must stay isolated. Review a specific commit/diff, validate affected tests/builds, and keep commits focused before the authorized integration/release step.

The inherited SuperClaw instructions mention branches and hosts belonging to the original repository. The operator's 2026-09-06 two-branch decision supersedes those topology rules for AwwO only. Approval, secret separation, independent review and relevant verification remain in force. Initializing `online` from an existing release commit is not a production deployment. Historical acceptance documents retain their original branch names as provenance.

The 2026-09-06 cleanup preserves in-progress server acceptance changes in their existing worktree. Neither branch creation nor deletion publishes those uncommitted changes. Consult the dated cleanup record for remote readback, metadata repairs and any remaining operational blocker.

## Verification records

- The original real Codex graph and repair evidence remains in `docs/superpowers/`.
- Current release checks and clean-directory startup evidence are recorded in `docs/releases/0.2.0-verification.md` before publication.
- The local prototype's real-service limitations remain explicit. A provider run succeeding does not prove the generated business system is deployed or connected to real authentication/data services.
