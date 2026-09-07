# SuperClaw Coordination

## Current AwwO override — 2026-09-06

The operator requested only `main` and `online` in the independent AwwO repository, locally and in Forgejo. This replaces the inherited branch topology below. Do not recreate worker/integration branches from those historical instructions. Preserve worktree contents; detached worktrees are allowed for unfinished work. `main` is the default source baseline and `online` is the reviewed release reference; neither a branch name nor cleanup proves runtime deployment. Tests, review, environment boundaries and release authorization remain required. See `docs/awwo-repository.md` for current usage; the remainder describes the legacy SuperClaw workflow.

## Branch Roles

- `main` is a mirror of `origin/main` only. Do not stack local development on
  `main`, and do not commit directly in the `/Users/leongong/Documents/superClaw`
  worktree.
- `dev/roadmap` is the local integration and verification branch. It is a
  development test worktree, not the default PR source branch.
- Feature, fix, and worker branches must be developed in their own worker
  worktrees before integration.
- Completed worker branches are merged into `dev/roadmap` to prove the combined
  development/test state.
- After `dev/roadmap` is synced, tested, and accepted, open or update the remote
  PR from the original worker or feature branch unless the operator explicitly
  approves a different source branch.

## Integration Order

Before merging any branch into `dev/roadmap`:

1. Fetch remote refs.
2. Confirm `/Users/leongong/Documents/superClaw` on `main` is only a clean
   mirror of `origin/main`. If it is dirty, stop and report the exact files
   instead of modifying it.
3. Fast-forward local `main` to `origin/main` only when that mirror is clean
   and the operator-approved workflow allows it. Do not reset `main` unless the
   operator explicitly approves that destructive action.
4. In the `dev/roadmap` worktree, merge or fast-forward from the latest
   `origin/main` mirror.
5. Resolve any conflicts in `dev/roadmap`.
6. Merge the feature or worker branch into `dev/roadmap`.
7. Run the relevant verification from `dev/roadmap`.
8. Re-check the original worker branch against the latest `origin/main` and the
   verified integration result.
9. Push or open a PR from the original worker branch only after verification
   passes and the operator approves that remote step.

## Worktree Hygiene

- Keep `/Users/leongong/Documents/superClaw` on `main`.
- Keep `/Users/leongong/superclaw-wt/roadmap` on `dev/roadmap`.
- Treat worker worktrees as temporary, isolated commit spaces.
- Remove clean worker worktrees only after their branch has been reviewed,
  verified through `dev/roadmap`, and either merged remotely or intentionally
  parked.
- Branches with unique commits may be parked as branch refs without a dedicated worktree after they are audited and clean.
- Keep a dedicated worktree only for branches with dirty files, active review work, or an approved extraction task.
