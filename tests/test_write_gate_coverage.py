"""Architecture test (Test-as-Policy): every write sink in ``state.py`` must be
gated by the maintenance write gate (contract B4 — 全局写冻结).

This is the self-enforcing coverage net behind PR-A.5. The B4 guarantee is that
*all* persistent mutations refuse during a maintenance window. The behavioral
tests in ``test_write_gate.py`` prove a handful of representative sinks are
gated; this test proves the property holds for the WHOLE ``StateStore`` surface
and — crucially — keeps holding: a future method that runs a write statement but
forgets ``assert_writes_allowed(...)`` turns this test red in CI, so the freeze
can never be silently bypassed by a newly added door.

How it works (ast + regex)
--------------------------
  * Parse ``superclaw.state`` from its real ``__file__`` source.
  * For every method defined on a class, take its source and **strip its leading
    docstring** (docstrings here legitimately contain the English words
    "insert"/"update"/"delete"/"replace", which would otherwise false-positive).
  * If the remaining *code* matches a write-SQL keyword
    (``INSERT`` / ``UPDATE`` / ``DELETE`` / ``REPLACE`` / ``BEGIN IMMEDIATE``,
    case-insensitive), the method is a write sink and MUST contain a literal
    ``assert_writes_allowed(`` call.
  * A small, explicit all-list (`_EXEMPT`) covers methods that match the keyword
    but are NOT runtime mutations — see the per-name justification there.
"""

from __future__ import annotations

import ast
import re

import superclaw.state as state_module

# Write-SQL keywords. Covers DML (INSERT/UPDATE/DELETE/REPLACE), the implicit
# write-transaction opener BEGIN IMMEDIATE, AND schema DDL
# (CREATE TABLE/INDEX, ALTER/DROP TABLE/INDEX). Schema construction is a
# persistent write too: contract B4 freezes the WHOLE construction face, so a
# method that builds/alters schema must also be gated (construction during a
# real cutover runs under the migrator hatch). CREATE/ALTER/DROP appear only in
# _init + the two _migrate_* methods, all gated at their top.
_WRITE_SQL = re.compile(
    r"\b(INSERT|UPDATE|DELETE|REPLACE|BEGIN IMMEDIATE"
    r"|CREATE TABLE|CREATE INDEX|ALTER TABLE|DROP TABLE|DROP INDEX)\b",
    re.IGNORECASE,
)

# Methods that contain a write-SQL keyword in their *code* but must NOT be gated.
# Each entry needs a justification — this list is deliberately tiny and audited.
#
# Currently EMPTY. The construction-time DML that used to live here — ``_init``'s
# instance_user_roles governance seed and the two ``_migrate_*`` column backfills —
# is now gated like every other persistent mutation (a whole-method exemption was
# too coarse: it would have let any future DML added to those methods bypass the
# freeze). Construction during a real cutover runs under the migrator's
# ``allow_writes_during_maintenance()`` hatch, so gating them does not freeze the
# migrator; outside a window the guard is a no-op. Schema DDL (CREATE/ALTER/DROP)
# now matches the write-SQL regex too, so those construction methods are gated
# like everything else — there is nothing left to exempt.
_EXEMPT: dict[str, str] = {}


def _strip_docstring(node: ast.FunctionDef | ast.AsyncFunctionDef, lines: list[str]) -> str:
    """Return the method's source with its leading docstring removed.

    Docstrings in state.py describe DB behavior in prose ("inserts a row",
    "updates the lease") and would false-positive against the write-SQL regex.
    We only care whether the *code* runs a write.
    """
    body = node.body
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        code_start = body[0].end_lineno  # 0-based index of first line AFTER docstring
    else:
        code_start = node.lineno - 1
    return "\n".join(lines[code_start : node.end_lineno])


def _iter_methods():
    src = open(state_module.__file__, encoding="utf-8").read()
    lines = src.splitlines()
    tree = ast.parse(src)
    for cls in ast.walk(tree):
        if not isinstance(cls, ast.ClassDef):
            continue
        for node in cls.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                yield cls.name, node, _strip_docstring(node, lines)


def test_all_state_write_sinks_are_gated():
    """Every method that runs a write statement must call assert_writes_allowed."""
    ungated: list[str] = []
    gated: list[str] = []
    for _cls, node, code in _iter_methods():
        if not _WRITE_SQL.search(code):
            continue  # not a write sink
        if node.name in _EXEMPT:
            continue  # audited exemption
        if "assert_writes_allowed(" in code:
            gated.append(node.name)
        else:
            ungated.append(node.name)

    assert not ungated, (
        "These state.py methods run a write statement but are NOT guarded by "
        "assert_writes_allowed(...) — the maintenance freeze (contract B4) can be "
        "bypassed through them. Add assert_writes_allowed(\"<name>\") as the first "
        "statement (after the docstring), or, if it is genuinely not a runtime "
        f"mutation, add it to _EXEMPT with a justification:\n  {ungated}"
    )
    # Sanity floor: this PR wired ~50 sinks; if the count collapses, the detector
    # broke (e.g. parsing changed) and the test would be vacuously green.
    assert len(gated) >= 40, (
        f"only {len(gated)} gated write sinks detected — the AST/regex detector "
        "may have stopped matching; this test would otherwise pass vacuously"
    )


def test_exempt_list_is_empty_no_method_level_bypass():
    """The exemption list must stay EMPTY: no method-level bypass of the freeze.

    A whole-method exemption is too coarse — it would let any DML later added to
    an "exempt" method silently skip the gate. Every write-DML method, including
    construction-time ones, is gated and relies on the migrator hatch instead.
    If a genuine need to exempt ever arises, it must be re-justified here AND the
    guard below (existence + write-keyword) re-enabled — never a bare name add.
    """
    assert _EXEMPT == {}, (
        "_EXEMPT is non-empty — method-level freeze exemptions are disallowed. "
        f"Gate the method instead (use the migrator hatch for construction): {_EXEMPT}"
    )
    # If the list is ever re-populated, each name must exist and actually contain
    # a write keyword (kept here so the guard is ready, not rotted).
    by_name = {node.name: code for _cls, node, code in _iter_methods()}
    for name in _EXEMPT:
        assert name in by_name, f"_EXEMPT lists '{name}' but no such method exists in state.py"
        assert _WRITE_SQL.search(by_name[name]), (
            f"_EXEMPT lists '{name}' but it contains no write-SQL keyword — remove it"
        )


def test_read_only_accessors_are_not_gated():
    """Pure read accessors (get_*/list_*) must NOT carry the write guard — gating
    a read would make reads fail during maintenance, which contract B4 does not
    intend (the freeze is writes-only)."""
    wrongly_gated: list[str] = []
    for _cls, node, code in _iter_methods():
        if not (node.name.startswith("get_") or node.name.startswith("list_")):
            continue
        if _WRITE_SQL.search(code):
            continue  # a conditional-write get_*/list_* legitimately needs the guard
        if "assert_writes_allowed(" in code:
            wrongly_gated.append(node.name)
    assert not wrongly_gated, (
        "These read-only accessors carry assert_writes_allowed(...) but run no "
        f"write statement — reads must not be frozen: {wrongly_gated}"
    )
