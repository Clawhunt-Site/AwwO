#!/bin/sh
# Install SuperClaw's local worktree-isolation guards into THIS clone's hooks dir.
# Non-destructive + idempotent: refuses to clobber a foreign hook, refuses to write
# into a hooks dir outside this repo (e.g. a global core.hooksPath). The hooks
# self-gate to this repo's primary working tree, so worktrees are never restricted.
# Run once per clone (git does not distribute hooks automatically):
#   sh scripts/install-local-guards.sh
set -e
root=$(git rev-parse --show-toplevel)

# Resolve the effective hooks dir WITHOUT requiring it to exist yet (a custom
# core.hooksPath may point at a not-yet-created dir — don't cd into it, or a failed
# cd would silently fall back to .git/hooks and falsely report success while git
# keeps using the real, un-installed hooksPath).
hp=$(cd "$root" && git rev-parse --git-path hooks 2>/dev/null || echo .git/hooks)
case "$hp" in /*) hooks="$hp" ;; *) hooks="$root/$hp" ;; esac

# Reject any '..' component — a textual containment check below can't be trusted
# against a path that climbs out of the repo via '..'.
case "/$hooks/" in
  */../*) echo "✋ Refusing hooks path containing '..': $hooks" >&2; exit 1 ;;
esac

# The shared git dir DOES exist, so resolving it to absolute is safe.
gitcommon=$(cd "$root" && cd "$(git rev-parse --git-common-dir 2>/dev/null || echo .git)" && pwd)
case "$hooks" in
  "$gitcommon"/*|"$gitcommon") : ;;
  *) echo "✋ Hooks dir ($hooks) is outside this repo's git dir ($gitcommon)." >&2
     echo "   core.hooksPath looks global/shared — refusing, to avoid leaking the guard into other repos." >&2
     echo "   Unset it for this repo, or install the .githooks/* manually." >&2
     exit 1 ;;
esac

mkdir -p "$hooks"
# pre-commit catches `git commit`; pre-merge-commit catches a clean auto-committing
# `git merge` on a feature branch (which skips pre-commit). Same guard body.
for h in pre-commit pre-merge-commit; do
  dest="$hooks/$h"
  if [ -e "$dest" ] && ! grep -q 'superclaw-local-guard' "$dest" 2>/dev/null; then
    echo "✋ $dest already exists and is NOT a SuperClaw guard — refusing to overwrite." >&2
    echo "   Merge our .githooks/pre-commit into it manually (or back it up), then re-run." >&2
    exit 1
  fi
  cp "$root/.githooks/pre-commit" "$dest"
  chmod +x "$dest"
  echo "installed: $dest"
done
dest="$hooks/post-checkout"
if [ -e "$dest" ] && ! grep -q 'superclaw-local-guard' "$dest" 2>/dev/null; then
  echo "✋ $dest already exists and is NOT a SuperClaw guard — refusing to overwrite." >&2
  echo "   Merge our .githooks/post-checkout into it manually (or back it up), then re-run." >&2
  exit 1
fi
cp "$root/.githooks/post-checkout" "$dest"; chmod +x "$dest"; echo "installed: $dest"

# Convenience: if the primary is on a dated main-mirror branch, allow that pattern
# so routine main-mirror commits aren't blocked (one truth in the hook = main).
# grep -F: the stored value is the LITERAL string "work/main-latest-*" (the '*' is
# a glob for the hook, not a regex here) — fixed-string match keeps this idempotent.
cur=$(git -C "$root" symbolic-ref --short -q HEAD 2>/dev/null || echo "")
case "$cur" in
  work/main-latest-*)
    if ! git -C "$root" config --get-all guard.allowBranch 2>/dev/null | grep -Fqx 'work/main-latest-*'; then
      git -C "$root" config --add guard.allowBranch 'work/main-latest-*'
      echo "allowed main-mirror pattern: work/main-latest-*"
    fi ;;
esac
echo "Local guards active — the primary checkout refuses feature-branch commits; worktrees are unaffected."
