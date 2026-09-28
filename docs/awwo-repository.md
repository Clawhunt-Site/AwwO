# AwwO repository

The canonical public product repository is [Clawhunt-Site/AwwO](https://github.com/Clawhunt-Site/AwwO). On 2026-09-28 the operator requested that `main` be the only named branch locally and on both remotes. GitHub `main` carries the latest verified public product source. The private Forgejo repository, `ClawHunt-Store/AwwO`, retains its operational history and any private-only legacy implementation without exporting those records to GitHub. The first version was `v0.2.0`; source publication, native package releases and production deployment are separate operations.

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

Use GitHub `main` as the source baseline and retain only `main` as a named branch. Do not recreate `online`, `staging`, `dev` or named worker branches. Develop in an exact-SHA detached worktree, review the final diff, and validate affected tests/builds. Integrate verified work by an explicitly authorized fast-forward push to `main`; never force-push shared history. Check the remote URL before pushing: existing clones may still name Forgejo `origin`.

This single-branch decision supersedes the 2026-09-06 two-branch policy and all inherited SuperClaw branch/promotion rules for AwwO only. Authorization, secret separation, independent review and relevant verification remain required. Test and production environments stay isolated even though they can deploy different reviewed commits from the same branch. Historical acceptance documents retain their original branch names as provenance.

Preserve existing detached worktrees, recordings and uncommitted files. They are working directories, not extra branches. Delete a redundant remote branch only after its completed changes have been integrated or equivalently preserved. Keep release tags and downloads immutable, including `macos-v0.8.1-build6`; advancing `main` does not rebuild or deploy an existing artifact.

## Verification records

- The original real Codex graph and repair evidence remains in `docs/superpowers/`.
- Current release checks and clean-directory startup evidence are recorded in `docs/releases/0.2.0-verification.md` before publication.
- The local prototype's real-service limitations remain explicit. A provider run succeeding does not prove the generated business system is deployed or connected to real authentication/data services.
