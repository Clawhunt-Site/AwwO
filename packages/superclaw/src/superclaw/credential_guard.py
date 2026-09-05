"""Defense-in-depth credential guard for agent-invoked File/Command tools (B3).

The main chat runs on the local machine under the human operator's OS account.
An agent that drives File/Command tools (read_file/write_file/run_shell/...) is
*not* the operator, but it shares the OS identity — so the OS-level 0600 perms on
``~/.superclaw/credentials`` do NOT stop it from reading operator credentials, nor
from shelling out ``security find-generic-password`` to dump the keychain. That
would let a compromised agent exfiltrate the human's tokens and defeat the
structural isolation B3 builds at the auth-authority layer.

This module is the *innermost* interceptor: it hard-blacklists the operator
**credential material**, **keychain-read commands**, and the **ambient-admin
operator CLI** (``superclaw`` / ``python -m superclaw`` — which would open the
local StateStore under the operator's admin scope and bypass the kernel's
agent→approval hire gate; route B) for agent tool calls,
**realpath-normalizing** the target first so ``../../`` traversal and symlink
indirection cannot smuggle a path past a naive string-prefix check. Containment is
decided by canonicalized path containment (real inode / resolved path), never by a
raw string ``startswith`` (which would both miss ``~/proj/../.superclaw`` and
falsely reject a sibling like ``~/.superclaw-evil``).

Scope of the blacklist — NARROW, credential material only, NOT the whole tree.
    ``~/.superclaw`` also hosts the *managed agent workspaces* that agents are
    SUPPOSED to read/write: ``chats/`` (default chat workspace), ``workspaces/``
    (legacy personal), ``companies/`` (company managed clones). Blacklisting the
    whole directory would regress legitimate work, so the guard blocks only:
      * the whole ``~/.config/superclaw`` directory (no workspace lives there),
      * specific credential FILES directly under ``~/.superclaw``: ``credentials``,
        ``secrets.key``, ``config.json``, ``state.db``, ``device-id``,
        ``relay-key.lock``, ``relay-audit.jsonl``, ``clawhunt-auth*.json``,
      * credential GLOBS directly under ``~/.superclaw``: ``*.env`` (incl.
        ``clawhunt-staging-*.env``), ``*.key``, ``*.pem``, ``credentials*``,
        ``secrets*``.
    The ``chats/`` ``workspaces/`` ``companies/`` subtrees are explicitly NOT
    protected, so agent file ops inside a managed workspace work normally.

Scope of invocation: this guard is invoked ONLY from the agent tool-execution
choke point (``_RealToolExecution._exec_tool`` in ``backends.py``). Kernel-internal
config access (reading ``~/.superclaw`` to load operator state) does NOT route
through the tool layer and is therefore unaffected.

Limitations — this is DEFENCE-IN-DEPTH, not a complete sandbox.
    File-tool path checks are robust (the path is realpath-normalized). But the
    ``run_shell`` command check is BEST-EFFORT token scanning: a determined agent
    can still read a file through shell indirection the scanner does not model —
    pipes/redirection (``cat < f``), command substitution (``$(...)``/backticks),
    an interpreter (``python -c "open(...)"``), or further env/quoting tricks. We
    expand ``~`` and resolve relative tokens against the tool's real cwd and reject
    the direct/naive vectors (raising the bar against the obvious
    ``cat ~/.superclaw/credentials`` / keychain dumps), but the AUTHORITATIVE B3
    guarantee is NOT this layer: it is that operator credentials are never a
    readable bearer secret at rest (the human-presence signing of PR-C), so even a
    full shell read yields nothing to steal. This guard exists to make casual
    exfiltration fail loudly, not to be the sole barrier.
"""

from __future__ import annotations

import fnmatch
import os
import shlex
from pathlib import Path

__all__ = [
    "CredentialAccessError",
    "is_protected_path",
    "assert_file_access_allowed",
    "assert_command_allowed",
    "protected_roots",
    "OPERATOR_AUTHORITY_ENV",
    "scrub_operator_authority_env",
]

# Operator-authority environment variables that must NEVER reach an agent backend
# subprocess: holding them lets an agent act as the operator without ever touching
# the CLI or a protected path. ``SUPERCLAW_CONTROL_TOKEN`` is the local API admin
# bearer — with it an agent could ``curl`` the loopback API (e.g. the company
# command endpoint) under ambient admin scope and bypass the agent→approval hire
# gate (route B). Scrubbed at the agent subprocess spawn, NOT in the generic
# trace child_env (the desktop→API-worker handoff legitimately propagates it).
OPERATOR_AUTHORITY_ENV: frozenset[str] = frozenset({"SUPERCLAW_CONTROL_TOKEN"})


def scrub_operator_authority_env(env: dict[str, str]) -> dict[str, str]:
    """Return ``env`` with operator-authority variables removed (in place + returned).

    Idempotent and None-safe on missing keys. Applied to the environment of an
    agent backend subprocess so the agent never inherits the operator's ambient
    API authority.
    """
    for name in OPERATOR_AUTHORITY_ENV:
        env.pop(name, None)
    return env

# Whole directories under ~ that are credential-only (no managed workspace lives
# there) — every path inside is protected.
_PROTECTED_REL_DIRS: tuple[tuple[str, ...], ...] = (
    (".config", "superclaw"),
)

# The managed-workspace ROOT: ``~/.superclaw``. Credential material sits as files
# *directly* inside it; the matching is by basename of the entry immediately under
# this root, NOT the whole subtree (so chats/ workspaces/ companies/ stay allowed).
_SUPERCLAW_REL: tuple[str, ...] = (".superclaw",)

# Exact credential file basenames directly under ~/.superclaw (case-folded compare).
_PROTECTED_BASENAMES: frozenset[str] = frozenset(
    {
        "credentials",
        "secrets.key",
        "config.json",
        "state.db",
        "device-id",
        "relay-key.lock",
        "relay-audit.jsonl",
        "clawhunt-auth.json",
    }
)

# Credential basename GLOBS directly under ~/.superclaw (case-folded fnmatch).
# Catches per-env auth (clawhunt-auth.staging.json), staging env files
# (clawhunt-staging-*.env), and any *.env / *.key / *.pem / secrets* / credentials*.
_PROTECTED_GLOBS: tuple[str, ...] = (
    "*.env",
    "*.key",
    "*.pem",
    "credentials*",
    "secrets*",
    "clawhunt-auth.*.json",
    "clawhunt-*.env",
    # SQLite sidecars hold recent-transaction PLAINTEXT (incl. company_secrets):
    # state.db-wal / state.db-shm / state.db-journal must be blocked too, not just
    # the main db file.
    "state.db*",
    # PR-4 (柱子 2): the team-MCP run-ticket sidecar (a 0600 bearer secret the
    # orchestrator writes next to state.db for the team_mcp_proxy child to read).
    # Even though the ticket is least-privilege (is_admin=False, single run/agent/
    # company) — NOT operator authority like SUPERCLAW_CONTROL_TOKEN — an agent's
    # own shell tool must not be able to read its bearer secret out of the state
    # dir (reduces accidental leakage / logging / prompt exfiltration). Covered by
    # ``*.key`` already; named explicitly so a rename can never silently drop it.
    "superclaw-team-ticket-*",
    # The OPERATOR-channel run-ticket sidecar (direct user chat, admin scope). This
    # one IS operator authority for company commands, so blocking the agent's own
    # shell tool from reading it matters MORE, not less. Covered by ``*.key`` already;
    # named explicitly for the same rename-safety reason as the team sidecar.
    "superclaw-operator-ticket-*",
)

# Keychain / credential-store read commands that exfiltrate secrets without ever
# touching a protected *path* (so the path check alone would miss them). Matched
# against the resolved executable basename + the first subcommand token,
# case-folded. macOS ``security`` keychain dumps are the canonical B3 vector.
_BLOCKED_COMMAND_SUBCOMMANDS: frozenset[tuple[str, str]] = frozenset(
    {
        ("security", "find-generic-password"),
        ("security", "find-internet-password"),
        ("security", "dump-keychain"),
        ("security", "unlock-keychain"),
    }
)

# The ambient-admin operator entrypoint. An autonomous agent must NEVER reach
# company-mutation authority by shelling out to the operator CLI: ``superclaw``
# opens the local StateStore under the human operator's AMBIENT admin scope
# (CompanyScope.is_admin=True), which would bypass the kernel choke point that
# routes an agent-initiated hire to a human approval (design Pillar 1 / route B).
# The agent's ONLY sanctioned path to company state is the kernel company-tool
# resolver (restricted, is_admin=False). Matched by resolved executable basename
# (``superclaw`` / ``superclaw.exe``) so an absolute path cannot bypass it.
_BLOCKED_AMBIENT_CLI_EXES: frozenset[str] = frozenset({"superclaw", "superclaw.exe"})

# ``python -m superclaw`` (and python3 / py launchers) is the same ambient-admin
# entrypoint by another name. Matched as a python interpreter invoking the
# ``superclaw`` package as a module.
_PYTHON_EXES: frozenset[str] = frozenset({"python", "python3", "py", "python.exe", "python3.exe"})


class CredentialAccessError(PermissionError):
    """Raised when an agent File/Command tool tries to touch operator credentials.

    Carries the offending path/command so the caller can surface a precise denial
    back to the model (and so it is auditable). Subclasses ``PermissionError`` so
    callers that already catch permission failures degrade gracefully.
    """

    def __init__(self, message: str, *, target: str | None = None) -> None:
        super().__init__(message)
        self.target = target


def _home(home: Path | None) -> Path:
    return home if home is not None else Path.home()


def protected_roots(home: Path | None = None) -> list[Path]:
    """Return the realpath-normalized credential-only directory roots under ``home``.

    These are WHOLE-directory blacklists (currently just ``~/.config/superclaw``).
    The ``~/.superclaw`` root is NOT here — it hosts managed workspaces and is
    handled by file-level matching in ``is_protected_path``. ``home`` is injectable
    for tests; defaults to ``Path.home()``.
    """
    base = _home(home)
    roots: list[Path] = []
    for rel in _PROTECTED_REL_DIRS:
        candidate = base.joinpath(*rel)
        # realpath resolves the existing prefix and leaves the rest literal — the
        # correct canonical form to compare against even when it does not exist.
        roots.append(Path(os.path.realpath(str(candidate))))
    return roots


def _realpath_or_none(target: str | os.PathLike[str], cwd: str | os.PathLike[str] | None) -> Path | None:
    """Best-effort realpath of ``target``, resolving relative targets against
    ``cwd`` (the tool's real working directory) rather than the process cwd. Returns
    None for empty/unresolvable input so the caller can fail-closed."""
    raw = os.fspath(target)
    if not raw or not str(raw).strip():
        return None
    # Expand ~ AND $VAR/${VAR}: the shell would expand '$HOME/.superclaw/...'
    # before reading, so a token-scan that only did expanduser would miss it and
    # wave the path through (best-effort, see module Limitations).
    expanded = os.path.expandvars(os.path.expanduser(str(raw)))
    if cwd is not None and not os.path.isabs(expanded):
        expanded = os.path.join(os.fspath(cwd), expanded)
    try:
        return Path(os.path.realpath(expanded))
    except (OSError, ValueError):
        return None


def _is_within(child: Path, parent: Path) -> bool:
    """True when ``child`` is ``parent`` or nested under it, by canonical path
    containment (NOT string prefix — defeats ``~/.superclaw-evil`` false-match)."""
    try:
        return os.path.commonpath([str(child), str(parent)]) == str(parent)
    except ValueError:
        # Different drives (Windows: child on E:, a protected root on C:) or an
        # abs/rel mix. Every caller passes os.path.realpath'd ABSOLUTES, so this is
        # the cross-drive case — and a path on one drive is PROVABLY NOT nested
        # under a directory on another. That is a definitive "not within", NOT an
        # unknown to fail closed on: the POSIX code returned True because
        # commonpath practically never raises under a single "/" root, but on
        # Windows that wrongly flagged every cross-drive benign path/command as
        # credential material. Return False (not contained).
        return False
    except OSError:
        # A genuine filesystem error resolving containment -> fail closed (treat as
        # protected) so an unreadable parent can't be used to smuggle a read past.
        return True


def _matches_credential_basename(name: str) -> bool:
    folded = name.casefold()
    if folded in {b.casefold() for b in _PROTECTED_BASENAMES}:
        return True
    return any(fnmatch.fnmatch(folded, glob.casefold()) for glob in _PROTECTED_GLOBS)


def is_protected_path(
    target: str | os.PathLike[str] | None,
    *,
    home: Path | None = None,
    cwd: str | os.PathLike[str] | None = None,
) -> bool:
    """Return True when ``target`` resolves to operator credential MATERIAL.

    Protected =
      * inside a credential-only directory (``~/.config/superclaw``), OR
      * a credential FILE directly under ``~/.superclaw`` (exact basename or glob:
        credentials / secrets.key / *.env / *.key / clawhunt-auth*.json / ...).
    NOT protected = the managed-workspace subtrees ``~/.superclaw/{chats,workspaces,
    companies}/...`` and any non-credential file under ``~/.superclaw``.

    Both ``target`` and the roots are ``os.path.realpath``-normalized first;
    relative targets resolve against ``cwd`` (the tool's real cwd) when given.
    Empty / None / unresolvable paths fail-closed to True (deny).
    """
    if target is None:
        return True
    resolved = _realpath_or_none(target, cwd)
    if resolved is None:
        return True  # fail-closed

    # (1) whole credential-only directories.
    for root in protected_roots(home):
        if _is_within(resolved, root):
            return True

    # (2) credential material directly under ~/.superclaw (realpath'd root so a
    # symlinked target that lands inside the real ~/.superclaw is caught too).
    sc_root = Path(os.path.realpath(str(_home(home).joinpath(*_SUPERCLAW_REL))))
    if _is_within(resolved, sc_root):
        try:
            rel = resolved.relative_to(sc_root)
        except ValueError:
            return True  # fail-closed: within but unrelatable
        if not rel.parts:
            # The ~/.superclaw directory itself: listing the dir does not leak file
            # contents, and blocking it would break list_files at the root. Allow.
            return False
        first = rel.parts[0]
        # Credential material lives as a FILE directly under the root. A workspace
        # subtree (chats/ workspaces/ companies/ — or any other dir) is allowed.
        if len(rel.parts) == 1 and _matches_credential_basename(first):
            return True
        return False

    return False


def assert_file_access_allowed(
    path: str | os.PathLike[str] | None,
    *,
    home: Path | None = None,
    cwd: str | os.PathLike[str] | None = None,
) -> None:
    """Raise ``CredentialAccessError`` if ``path`` touches operator credentials."""
    if is_protected_path(path, home=home, cwd=cwd):
        shown = "" if path is None else os.fspath(path)
        raise CredentialAccessError(
            f"access to operator credential material is forbidden for agent tools: "
            f"{shown!r}",
            target=None if path is None else str(shown),
        )


def _tokenize_command(command: str | list[str] | tuple[str, ...]) -> list[str] | None:
    """Tokenize a command into argv. Returns None when a string command cannot be
    parsed (e.g. unbalanced quotes) so the caller can fail-closed."""
    if isinstance(command, (list, tuple)):
        return [str(tok) for tok in command]
    if isinstance(command, str):
        try:
            tokens = shlex.split(command)
        except ValueError:
            return None
        if os.name == "nt":
            # POSIX shlex treats backslash as an escape, so a Windows credential
            # path (``C:\Users\...\credentials``) collapses to ``C:Users...`` and
            # would slip the scan when the command is later run under cmd.exe
            # (backslashes literal there). ALSO scan the Windows-style (non-POSIX)
            # tokenization so a backslash credential path is caught under either
            # execution semantics. The guard only DENIES on a match, so scanning
            # these additional real tokens stays fail-closed (no false-allow).
            try:
                tokens = tokens + shlex.split(command, posix=False)
            except ValueError:
                return None
        return tokens
    return None


def _exe_basename(token: str) -> str:
    """Resolve a command token to its bare executable name, case-folded.

    Handles absolute/relative paths (``/usr/bin/security`` -> ``security``) and is
    case-folded so ``Security`` / ``SECURITY`` cannot bypass on case-insensitive
    matching. Does NOT realpath the executable (that would require it to exist);
    basename is sufficient to match the blocklisted command family.
    """
    return os.path.basename(token).strip().casefold()


def assert_command_allowed(
    command: str | list[str] | tuple[str, ...] | None,
    *,
    home: Path | None = None,
    cwd: str | os.PathLike[str] | None = None,
) -> None:
    """Raise ``CredentialAccessError`` if ``command`` reads operator credentials.

    Two blocked classes:
      1. Keychain / credential-store read commands (``security find-generic-password``
         etc.) — matched by resolved executable basename + first subcommand token.
      2. Any token (INCLUDING argv[0]) that resolves into operator credential
         material (e.g. ``cat ~/.superclaw/credentials``,
         ``~/.superclaw/credentials/tool``) — realpath-normalized per token,
         resolving relative tokens against ``cwd`` (the tool's real cwd) so the
         scan matches the path the shell would actually open.

    Fail-closed: an empty/None command, or a string command that cannot be
    tokenized (suspicious), is denied.
    """
    if command is None:
        raise CredentialAccessError("empty command is forbidden for agent tools", target=None)
    tokens = _tokenize_command(command)
    shown = command if isinstance(command, str) else " ".join(str(t) for t in command)
    if tokens is None:
        raise CredentialAccessError(
            f"unparseable command refused (fail-closed): {shown!r}", target=str(shown)
        )
    if not tokens:
        raise CredentialAccessError("empty command is forbidden for agent tools", target=str(shown))

    # (1) Blocklisted keychain/credential-store subcommands.
    exe = _exe_basename(tokens[0])
    sub = ""  # first non-flag token after the executable
    for tok in tokens[1:]:
        if tok.startswith("-"):
            continue
        sub = tok.strip().casefold()
        break
    if (exe, sub) in _BLOCKED_COMMAND_SUBCOMMANDS:
        raise CredentialAccessError(
            f"keychain/credential-store read command is forbidden for agent tools: {shown!r}",
            target=str(shown),
        )

    # (1b) Ambient-admin operator entrypoint. Block ``superclaw ...`` and
    # ``python -m superclaw ...`` — both open the local StateStore under the
    # operator's ambient admin scope, bypassing the kernel's agent→approval hire
    # gate (route B: the agent's only sanctioned path is the restricted company
    # tool resolver, never the operator CLI).
    if exe in _BLOCKED_AMBIENT_CLI_EXES:
        raise CredentialAccessError(
            f"the operator CLI is forbidden for agent tools (use the company tools, "
            f"not ambient admin): {shown!r}",
            target=str(shown),
        )
    if exe in _PYTHON_EXES:
        # Detect ``-m superclaw`` / ``-m superclaw.<sub>`` anywhere in argv.
        for i, tok in enumerate(tokens[1:], start=1):
            if tok == "-m" and i + 1 < len(tokens):
                module = tokens[i + 1].strip().casefold()
                if module == "superclaw" or module.startswith("superclaw."):
                    raise CredentialAccessError(
                        f"the operator CLI (python -m superclaw) is forbidden for "
                        f"agent tools (use the company tools, not ambient admin): {shown!r}",
                        target=str(shown),
                    )

    # (2) Any token — INCLUDING argv[0] (a credential path run as an executable) —
    # that resolves into credential material. Flags are skipped; argv[0] is checked.
    for index, tok in enumerate(tokens):
        if not tok:
            continue
        if index > 0 and tok.startswith("-"):
            continue
        if is_protected_path(tok, home=home, cwd=cwd):
            raise CredentialAccessError(
                f"command references operator credential material: {shown!r}",
                target=str(shown),
            )
