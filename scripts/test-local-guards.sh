#!/bin/sh
# Self-contained behavioural test for the local worktree-isolation guards.
# Builds a throwaway repo in a temp dir, installs the guards, and asserts every
# branch of the gate. Exits non-zero on the first failure. Re-runnable.
#   sh scripts/test-local-guards.sh
set -e
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); WTREE="$T.wt"
cleanup() { git -C "$T" worktree remove --force "$WTREE" 2>/dev/null || true; rm -rf "$T" "$WTREE"; }
trap cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }

git init -b main -q "$T"
git -C "$T" config user.email t@t; git -C "$T" config user.name t
mkdir -p "$T/.githooks"
cp "$SRC/.githooks/pre-commit" "$SRC/.githooks/post-checkout" "$SRC/.githooks/.superclaw-guard" "$T/.githooks/"
( cd "$T" && sh "$SRC/scripts/install-local-guards.sh" >/dev/null )
echo a > "$T/f"; git -C "$T" add -A

# 1) commit on main → allowed
git -C "$T" commit -qm base || fail "commit on main blocked"

# 2) commit on feature branch → blocked
git -C "$T" checkout -q -b feat/x; echo b > "$T/f2"; git -C "$T" add -A
if git -C "$T" commit -qm feat 2>/dev/null; then fail "feature-branch commit not blocked"; fi
echo "ok: feature-branch commit blocked"

# 3) clean (no-conflict) auto-committing merge on a feature branch → blocked via
#    pre-merge-commit (this is the path that SKIPS pre-commit).
git -C "$T" checkout -q main; git -C "$T" checkout -q -b other; echo c > "$T/fo"; git -C "$T" add -A
git -C "$T" commit -qm other --no-verify
git -C "$T" checkout -q -b feat/merge main
echo d > "$T/fm"; git -C "$T" add -A; git -C "$T" commit -qm "feat own" --no-verify   # diverge
if git -C "$T" merge --no-ff -m "merge other" other >/dev/null 2>&1; then fail "clean auto-commit merge on feature branch not blocked"; fi
echo "ok: clean merge auto-commit on feature branch blocked"
git -C "$T" merge --abort 2>/dev/null || true

# 4) detached HEAD (e.g. mid-rebase) → allowed
git -C "$T" checkout -q --detach; echo e > "$T/f4"; git -C "$T" add -A
git -C "$T" commit -qm detached || fail "detached-HEAD commit blocked"
echo "ok: detached-HEAD commit allowed"

# 5) main-mirror via guard.allowBranch → allowed
git -C "$T" checkout -q -b work/main-latest-20260625
git -C "$T" config --add guard.allowBranch 'work/main-latest-*'
echo f > "$T/f5"; git -C "$T" add -A
git -C "$T" commit -qm mirror || fail "main-mirror commit blocked despite allowBranch"
echo "ok: main-mirror commit allowed via config"

# 6) installer refuses to clobber a foreign hook
hooks=$(cd "$T" && git rev-parse --git-path hooks); hooks="$T/$hooks"
printf '#!/bin/sh\necho husky\n' > "$hooks/pre-commit"
if ( cd "$T" && sh "$SRC/scripts/install-local-guards.sh" ) 2>/dev/null; then fail "installer clobbered a foreign hook"; fi
echo "ok: installer refused to overwrite a foreign hook"
cp "$SRC/.githooks/pre-commit" "$hooks/pre-commit"; chmod +x "$hooks/pre-commit"

# 7) installer refuses an external/missing core.hooksPath (no false success)
git -C "$T" config core.hooksPath "/tmp/nonexistent-ext-hooks-$$"
if ( cd "$T" && sh "$SRC/scripts/install-local-guards.sh" ) >/dev/null 2>&1; then fail "installer accepted an external core.hooksPath"; fi
echo "ok: installer refused an external/missing core.hooksPath"
git -C "$T" config --unset core.hooksPath

# 8) linked worktree on a feature branch → allowed (worktrees are free)
git -C "$T" worktree add -q "$WTREE" -b feat/wt
echo w > "$WTREE/fw"; git -C "$WTREE" add -A
git -C "$WTREE" commit -qm "in worktree" || fail "linked-worktree commit blocked"
echo "ok: linked-worktree feature commit allowed"

echo "ALL GUARD TESTS PASSED"
