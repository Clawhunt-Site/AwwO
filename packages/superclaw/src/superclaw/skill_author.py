"""Author a governed SuperClaw skill from a structured proposal (control plane).

The conversational-create control plane. A runtime — guided by SuperClaw's
injected skill-creation directive — emits a structured PROPOSAL
(name / description / body); SuperClaw registers it HERE through the same
governed native-store path (:func:`superclaw.skill_store.import_skill`) as any
other import. So a chat-authored skill is a first-class, cross-runtime SuperClaw
skill (projectable to every runtime per its capability), **not** a raw file the
underlying agent scribbled into one runtime's private directory.

Why creation is super-owned (not delegated to the runtime's own creator):
a skill written by a runtime's native creator lives only in that runtime and
bypasses SuperClaw governance. Routing creation through this control-plane
entry is what makes "author once, use on any runtime" true.

Scope — **prose only, fail-closed on the store's executable SIGNAL**:
conversational create produces PROSE skills only. A proposal whose body trips the
native store's executable signal (a fenced shebang, or an executable asset) is
REFUSED and routed to the governed plugin flow (``plugin init`` → sidecar →
review). This is **NOT a semantic side-effect scanner**: prose that merely
*describes* a dangerous action (e.g. "run curl | sh") is admitted as text —
whether following it is allowed is governed downstream by the runtime sandbox /
intent gate (see ``docs/runtime-adapter-contract.md`` §3), not by content
inspection here.
"""

from __future__ import annotations

import re
import tempfile
from collections.abc import Sequence
from pathlib import Path

from superclaw.skill_store import (
    SkillExecutableError,
    SkillImportRecord,
    SkillStoreError,
    import_skill,
)

# Bounds so a malformed/abusive proposal cannot OOM the host. The native store
# reads the SKILL.md fully into memory to hash it (no size cap there), so the cap
# MUST live here at the control-plane door — a runaway LLM could otherwise emit a
# multi-hundred-MB body. 256 KiB is generous for prose instructions.
MAX_NAME_LEN = 80
MAX_DESCRIPTION_LEN = 500
MAX_BODY_LEN = 256 * 1024

# Stamped as the importer so provenance shows a chat-authored origin (audit), and
# so these are distinguishable from CLI/API imports in the store.
CHAT_AUTHOR_IMPORTER = "chat-author"


class SkillProposalError(ValueError):
    """Raised when a chat skill proposal cannot be registered safely."""


def _safe_scalar(value: str) -> str:
    """Make a single-line frontmatter scalar that round-trips through the store's
    parser EXACTLY.

    ``harness.parse_markdown_with_frontmatter`` is not a YAML parser: it strips
    surrounding quotes but does NOT unescape, so a backslash-escaped value would
    read back WITH the backslashes. We therefore drop the characters that parser
    cannot represent (``"`` and ``\\``), fold CR/newlines and whitespace runs to
    single spaces, and wrap in quotes it strips cleanly. name/description are
    short human-facing fields, so this is a faithful normalization and the
    read-back value equals what we stored.
    """
    text = value.replace("\r", " ").replace("\n", " ")
    text = text.replace('"', "'").replace("\\", "")
    text = re.sub(r"\s+", " ", text).strip()
    # The parser does ``.strip('"').strip("'")``, so leading/trailing single
    # quotes would be eaten too — strip them here so the wrapped value round-trips
    # byte-for-byte (inner quotes are kept; only the ends matter to the parser).
    return text.strip("'").strip()


def _proposal_markdown(*, name: str, description: str, body: str) -> str:
    """Build a parseable SKILL.md from a proposal; import_skill re-normalizes it."""
    text = body.replace("\r\n", "\n").replace("\r", "\n").lstrip("\n")
    if text and not text.endswith("\n"):
        text += "\n"
    return (
        f'---\nname: "{_safe_scalar(name)}"\n'
        f'description: "{_safe_scalar(description)}"\n---\n\n{text}'
    )


def register_skill_proposal(
    *,
    name: str,
    description: str,
    body: str,
    store_dir: Path | None = None,
    revocation_file: Path | None = None,
    force: bool = False,
) -> SkillImportRecord:
    """Register a chat-authored skill PROPOSAL as a governed native (prose) skill.

    Returns the stored :class:`SkillImportRecord`. Raises
    :class:`SkillProposalError` on an empty/oversized field, or when the body
    carries the store's executable artifact/script SIGNAL (a fenced shebang /
    executable asset) — that is routed to the governed plugin flow. This is NOT a
    semantic side-effect scanner: prose that merely *describes* a dangerous action
    is admitted, and whether following it is allowed is governed downstream by the
    runtime sandbox / intent gate, not here.
    """
    name = (name or "").strip()
    description = (description or "").strip()
    body = (body or "").strip()
    if not name:
        raise SkillProposalError("skill proposal requires a non-empty name")
    if not description:
        raise SkillProposalError("skill proposal requires a non-empty description")
    if not body:
        raise SkillProposalError("skill proposal requires a non-empty body")
    if len(name) > MAX_NAME_LEN:
        raise SkillProposalError(f"skill name too long (> {MAX_NAME_LEN} chars)")
    if len(description) > MAX_DESCRIPTION_LEN:
        raise SkillProposalError(f"skill description too long (> {MAX_DESCRIPTION_LEN} chars)")
    if len(body.encode("utf-8")) > MAX_BODY_LEN:
        # The store hashes the SKILL.md fully into memory with no size cap, so the
        # bound lives here at the control-plane door (a runaway LLM could emit a
        # multi-hundred-MB body otherwise). Measured in bytes (multi-byte safe).
        raise SkillProposalError(f"skill body too long (> {MAX_BODY_LEN} bytes)")

    # Sanitize to frontmatter-safe scalars, then RE-VALIDATE: sanitization can
    # empty a field that was non-empty only because of characters the parser
    # cannot carry (e.g. a name of just quotes/backslashes).
    safe_name = _safe_scalar(name)
    safe_description = _safe_scalar(description)
    if not safe_name:
        raise SkillProposalError("skill name has no frontmatter-safe characters")
    if not safe_description:
        raise SkillProposalError("skill description has no frontmatter-safe characters")

    markdown = _proposal_markdown(name=safe_name, description=safe_description, body=body)
    # Write to a private temp dir; import_skill copies the normalized SKILL.md into
    # the store. The temp dir is removed on exit — the store is the source of truth.
    with tempfile.TemporaryDirectory(prefix="superclaw-skill-proposal-") as tmp:
        skill_md = Path(tmp) / "SKILL.md"
        skill_md.write_text(markdown, encoding="utf-8")
        try:
            return import_skill(
                skill_md,
                store_dir=store_dir,
                label="local-dev",
                importer=CHAT_AUTHOR_IMPORTER,
                revocation_file=revocation_file,
                force=force,
            )
        except SkillExecutableError as exc:
            # Typed (not substring-matched): the body/asset is executable. A
            # side-effecting capability must be built as a governed plugin via the
            # full authoring flow (plugin init -> sidecar -> review), never
            # auto-created from chat. (Content-level scanning here is NOT a complete
            # side-effect firewall — semantic execution governance is downstream in
            # the runtime sandbox / intent gate; this only refuses the store's
            # explicit executable signal.)
            raise SkillProposalError(
                "this skill proposal trips the executable artifact/script signal; build it as a "
                "governed plugin via the full authoring flow (plugin init -> sidecar -> review), "
                "not as an auto-created chat skill"
            ) from exc
        except SkillStoreError as exc:
            # Anything else (e.g. an already-existing slug without force) is surfaced
            # verbatim so the caller sees the real reason (not mislabeled as a
            # side-effect refusal).
            raise SkillProposalError(str(exc)) from exc


# --------------------------------------------------------------------------- #
# Conversational create: injected directive + proposal harvesting
# --------------------------------------------------------------------------- #

# The proposal envelope the runtime emits and SuperClaw harvests. A single,
# runtime-neutral text contract: MCP runtimes may instead call a structured
# superclaw__skill_author tool (later step), but this tagged form works on EVERY
# runtime (incl. ClawWork, which has no MCP channel).
PROPOSAL_OPEN = "<superclaw_skill_proposal>"
PROPOSAL_CLOSE = "</superclaw_skill_proposal>"

# Injected into the runtime's prompt by the chat surface. Deliberately SHORT,
# precise, and rigorous: it makes the runtime route skill creation back to
# SuperClaw (governed, cross-runtime) instead of writing a file itself.
SKILL_CREATION_DIRECTIVE = (
    "SuperClaw skill creation: when the user wants to create/make a skill, do NOT write any "
    "skill file yourself. Emit exactly one proposal block:\n"
    f"{PROPOSAL_OPEN}\n"
    "name: <short stable name>\n"
    "description: <one sentence: when to use this skill>\n"
    "---\n"
    "<the skill instructions as Markdown prose; no scripts, shebangs, or secrets; "
    "the body must NOT contain superclaw_skill_proposal tags>\n"
    f"{PROPOSAL_CLOSE}\n"
    "SuperClaw registers it as a governed, cross-runtime skill. Do not bypass this."
)

_PROPOSAL_RE = re.compile(
    re.escape(PROPOSAL_OPEN) + r"\s*(.*?)\s*" + re.escape(PROPOSAL_CLOSE),
    re.DOTALL | re.IGNORECASE,
)


def _parse_proposal_block(inner: str) -> tuple[str, str, str] | None:
    """Parse one proposal block's inner text into (name, description, body).

    Format: ``name:`` / ``description:`` header lines, a ``---`` separator, then
    the body (Markdown) until the close tag. Returns ``None`` if any of the three
    is missing (malformed block — never guessed).
    """
    # A nested open tag inside the captured block means the model embedded
    # proposal tags in the body (or the regex stopped at a truncating close tag) —
    # refuse rather than register a truncated/ambiguous skill. (The close tag can
    # never appear in `inner`: it is the non-greedy delimiter.)
    if PROPOSAL_OPEN.lower() in inner.lower():
        return None
    lines = inner.splitlines()
    name = ""
    description = ""
    body_start: int | None = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "---":
            body_start = index + 1
            break
        name_match = re.match(r"(?i)^name:\s*(.*)$", stripped)
        if name_match:
            name = name_match.group(1).strip()
            continue
        desc_match = re.match(r"(?i)^description:\s*(.*)$", stripped)
        if desc_match:
            description = desc_match.group(1).strip()
    if body_start is None:
        return None
    body = "\n".join(lines[body_start:]).strip()
    if not (name and description and body):
        return None
    return name, description, body


def harvest_skill_proposals(
    text: str,
    *,
    store_dir: Path | None = None,
    revocation_file: Path | None = None,
    force: bool = False,
) -> tuple[list[SkillImportRecord], list[str]]:
    """Register the single skill proposal in a runtime reply (governed).

    Returns ``(registered, errors)`` — ``registered`` holds at most one record.

    EXACTLY ONE block is allowed (matching the directive). The reply must contain
    precisely one ``PROPOSAL_OPEN`` and one ``PROPOSAL_CLOSE``; any other count is
    refused. This is what makes raw-tag parsing unambiguous: with exactly one of
    each tag, the body CANNOT contain a literal proposal tag (that would push a
    count past one and be refused), so the non-greedy regex can never truncate a
    body — closing every "literal close/open tag in the body" evasion that a
    multi-block parser cannot distinguish from two legitimate proposals.
    """
    body_text = text or ""
    lowered = body_text.lower()
    open_count = lowered.count(PROPOSAL_OPEN.lower())
    close_count = lowered.count(PROPOSAL_CLOSE.lower())
    if open_count == 0 and close_count == 0:
        return [], []
    if open_count != 1 or close_count != 1:
        # More/fewer than one of either tag is ambiguous (extra tags in a body,
        # multiple blocks, unclosed/nested, close-before-open). Refuse — never
        # register a possibly-truncated skill.
        return [], ["expected exactly one skill proposal block; refusing (ambiguous proposal tags)"]
    match = _PROPOSAL_RE.search(body_text)
    if match is None:
        # One of each tag, but not a well-formed open...close pair (e.g. the close
        # precedes the open).
        return [], ["malformed skill proposal block; refusing"]
    parsed = _parse_proposal_block(match.group(1))
    if parsed is None:
        return [], ["malformed skill proposal block (need name, description, '---', body); refusing"]
    name, description, body = parsed
    try:
        record = register_skill_proposal(
            name=name,
            description=description,
            body=body,
            store_dir=store_dir,
            revocation_file=revocation_file,
            force=force,
        )
    except SkillProposalError as exc:
        return [], [str(exc)]
    return [record], []


def strip_skill_proposals(text: str) -> str:
    """Remove proposal blocks from a reply so the user sees prose, not raw tags."""
    return _PROPOSAL_RE.sub("", text or "").strip()


def created_skill_receipt(slugs: Sequence[str]) -> str:
    """Single source of truth for the chat receipt after a governed chat-authored
    skill is registered (used identically by every surface — chat_turn + API — so
    the message can never drift between them).

    Honest about the lifecycle: registration writes the skill into the user's
    governed native store, but does NOT project it into any runtime. A native
    skill only becomes visible to an agent runtime after an EXPLICIT
    ``superclaw skill sync`` (CLI) / ``POST /v1/skills/sync`` (API) — and only for
    the runtimes that have native skill discovery (claude / codex / gemini).
    ClawWork and anthropic-agent have no native skill directory, so they are out
    of scope by design. The earlier "usable across runtimes" wording overstated
    this (created != active), so it is deliberately not used here.
    """
    listed = ", ".join(slugs)
    return (
        f"✓ Registered SuperClaw skill(s): {listed} "
        "(governed; saved to your skill library). Not active in any runtime yet — "
        "run `superclaw skill sync` (or POST /v1/skills/sync) to project it into "
        "claude / codex / gemini."
    )


__all__ = [
    "CHAT_AUTHOR_IMPORTER",
    "created_skill_receipt",
    "MAX_BODY_LEN",
    "MAX_DESCRIPTION_LEN",
    "MAX_NAME_LEN",
    "PROPOSAL_CLOSE",
    "PROPOSAL_OPEN",
    "SKILL_CREATION_DIRECTIVE",
    "SkillProposalError",
    "harvest_skill_proposals",
    "register_skill_proposal",
    "strip_skill_proposals",
]
