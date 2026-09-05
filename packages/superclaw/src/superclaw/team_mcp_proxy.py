"""Team-company MCP proxy — project the company command contract to A-class backends.

This is the PR-4 leg of 柱子 2 in ``docs/agent-company-autonomy-design.md``.

WHY THIS EXISTS
---------------
B-class backends (the native-harness providers ``anthropic-agent`` / ``gemini``)
own their own tool loop, so the orchestrator hands them an *in-loop*
``company_command_resolver`` (``orchestrator._build_company_command_resolver``)
that executes a company command synchronously inside that loop.

A-class native backends (``codex`` / ``claude``) do NOT expose such a loop — the
only governed way to give them the company command vocabulary is an MCP server.
This module is that server: a stdio MCP proxy (mirroring
``plugin_mcp_proxy.py``) that fronts the SINGLE company command choke point
(``company_handler.execute_company_command``). There is no second execution
semantics — A-class MCP and B-class in-loop both dispatch the same typed
commands through the same gates.

TWO CHANNELS (confined TEAM + admin OPERATOR)
---------------------------------------------
The proxy serves two distinct channels, selected by ``operator_scope`` and pinned
to a distinct ``audience`` each:

  * TEAM channel (``operator_scope=False``, ``audience=team-mcp``): a confined
    sub-agent run. Scope is re-derived with ``is_admin=False`` + a single allowed
    company — a ticket-authed team actor is never admin and cannot self-report one.
  * OPERATOR channel (``operator_scope=True``, ``audience=operator-mcp``): the
    DIRECT user chat, which is the operator acting for the single owner of ALL
    companies. Scope is re-derived with ``is_admin=True`` — exactly the parity the
    B-class in-loop resolver and the CLI (``_cli_operator_scope``) already grant the
    operator. This admin is NOT a field on the ticket (``VerifiedTicket`` still
    carries none — the ``company_ticket`` primitive invariant holds): it is a
    decision THIS proxy makes when launched in operator mode against an
    operator-audience ticket.

SECURITY MODEL (run-bound ticket, fail-closed)
----------------------------------------------
The proxy is a child process the orchestrator spawns for one run. It MUST NOT
self-report identity. Instead:

  * (0) BINDING — ``operator_scope`` is bound to ``audience == operator-mcp`` and
    refused otherwise (``_execute`` step 0). ``operator_scope`` and ``audience``
    arrive as INDEPENDENT argv the launching client controls, and a confined team
    agent can rewrite its own MCP config; without this binding it could keep
    ``--audience team-mcp`` (so its team ticket passes verification) while adding
    ``--operator-scope`` to get admin. The binding is what makes the audience seam
    actually closed: operator mode can only ever verify an operator-audience ticket,
    which the kernel mints SOLELY for the operator direct chat — a team run's sidecar
    never holds one.
  * The orchestrator mints a run-bound ticket (``company_ticket.issue_run_ticket``)
    and writes the opaque token to a ``0600`` SIDECAR FILE next to the state DB,
    then passes only that file's PATH to this proxy via ``--ticket-file`` in argv.
    The token itself is never in argv (``ps``-visible) and never in the MCP config
    file. This matches the codebase invariant that MCP configs are secret-free and
    are NOT a secret carrier (``backends._secret_free_mcp_servers`` REFUSES an
    ``env`` block), and that codex/claude do NOT forward process env to MCP
    children — so a file-path transport is the only one that reaches the child while
    keeping the config clean. When the state dir is the default ``~/.superclaw``,
    the sidecar is name-blacklisted in ``credential_guard`` so the B-class agent's
    own File/Command tools cannot read it.
    HONEST RESIDUAL (the ``0600`` sidecar is NOT a cross-privilege wall): the sidecar
    PATH IS in the MCP-config argv the agent can see, and an A-class native backend's
    own tools do NOT pass through ``credential_guard`` (it gates only the B-class
    ``_exec_tool`` path), so an agent that can run a same-user shell can read the
    file. This is acceptable ONLY under the re-ratified single-user threat model
    (``company_scope`` docstring): there is no weaker-privilege tenant to defend
    against, and an attacker who can run code as the user ALREADY has the whole state
    DB — the operator ticket grants nothing beyond that existing same-user access.
    What the (0) binding DOES protect is the ASYMMETRIC case: a CONFINED team agent
    (a different, lower authority within the SAME process model) cannot use its own
    least-privilege team sidecar to reach admin. The bearer-token replay window is
    bounded by the run-budget TTL.
  * On every ``tools/call`` the proxy re-reads the token from the file and
    re-verifies it against the durable StateStore
    (``company_ticket.verify_run_ticket``), keyed by the action's command_type,
    the fixed ``audience``, and the expected run/agent/company the orchestrator
    pinned into argv (argv is only an EXPECTATION the ticket must match — the
    ticket, not argv, is the authority).
  * The acting :class:`~superclaw.company_scope.CompanyScope` is RE-DERIVED from
    the verified ticket fields (NOT from tool arguments): ``is_admin`` is ``False``
    on the team channel and ``True`` on the operator channel (see TWO CHANNELS); the
    acting agent / company come from the verified record.

FAIL-CLOSED ERROR DISCIPLINE
----------------------------
A verification failure, an unknown tool, a malformed argument payload, a scope /
lifecycle / autonomy denial, or any kernel error is mapped to a model-facing
error string inside the MCP ``content`` (``isError: true``). It is NEVER raised
into the agent's tool loop — a company command that the kernel refuses must read
back to the model as a refusal, not crash the run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from superclaw.ui_contracts import (
    COMPANY_COMMAND_TOOLS,
    COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE,
    COMPANY_READ_TOOLS,
    TOOL_NAME_TO_COMMAND_TYPE,
)

MCP_PROTOCOL_VERSION = "2025-06-18"

# The single verifier surface this proxy authenticates against. A ticket minted
# for any other audience is refused, so a team ticket cannot be replayed across
# surfaces that share the StateStore (e.g. a future REST/MCP bridge).
TEAM_MCP_AUDIENCE = "team-mcp"

# The closed set of company command tool actions this channel can ever invoke,
# derived from the single-source contract (never hand-copied). Used as the
# ticket's allowed_actions and to bound list_tools / call_tool.
TEAM_COMMAND_ACTIONS: tuple[str, ...] = tuple(sorted(set(TOOL_NAME_TO_COMMAND_TYPE.values())))

# The closed set of company READ tool actions (roadmap P0): discovery + snapshot.
# Read-only, scope-confined — added to the ticket's allowed_actions so the A-class
# (codex/claude) path can SEE a company, mirroring the B-class read resolver. Kept
# DISJOINT from the mutation actions (asserted in ui_contracts), so a read can never
# be confused with a mutation by the verifier's action match.
TEAM_READ_ACTIONS: tuple[str, ...] = tuple(
    sorted(set(COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE.values()))
)

# The operator (single-user owner) MCP audience. The DIRECT user chat is the
# operator acting for the owner of ALL companies, so its channel re-derives an
# ADMIN scope — exactly the parity the B-class in-loop resolver already grants the
# operator chat (is_admin=True) and the CLI grants every `superclaw company …`.
# A SEPARATE audience from ``TEAM_MCP_AUDIENCE`` is the security seam: a confined
# team ticket (audience=team-mcp) can NEVER be replayed on an operator-mode proxy
# (audience=operator-mcp) — ``verify_run_ticket``'s audience match refuses it — so
# a confined team agent cannot escalate to admin by rewriting the MCP-config argv.
# The admin decision lives in WHICH proxy mode the kernel launched (``operator_scope``)
# gated by the audience match, NOT in a self-reportable flag on the ticket: the
# ``VerifiedTicket`` still carries NO admin bit, so the ticket-primitive invariant
# ("verify never returns an admin flag") holds unchanged.
OPERATOR_MCP_AUDIENCE = "operator-mcp"


@dataclass(frozen=True)
class TeamMcpProxyOptions:
    """Run-scoped configuration for a single team-MCP proxy process.

    Every field here is an EXPECTATION the ticket must satisfy, except
    ``state_path`` (which durable store to verify against) and ``ticket_file``
    (the 0600 sidecar holding the secret). None of these is trusted as authority —
    the ticket is. They pin the proxy so a ticket for a DIFFERENT run / agent /
    company is refused by ``verify_run_ticket``'s scope-match.

    ``operator_scope`` selects the OPERATOR channel: when True the proxy re-derives
    an admin scope (parity with the CLI / B-class in-loop operator) AFTER a normal
    ticket verification. It is reachable ONLY with an operator-audience ticket (a
    team ticket fails the audience match), so flipping this flag on a confined team
    run's argv cannot escalate it — the ticket, not the flag, is the gate.
    """

    state_path: str
    run_id: str
    agent_profile_id: str
    company_id: str
    ticket_file: str | None
    audience: str = TEAM_MCP_AUDIENCE
    operator_scope: bool = False

    def read_ticket_token(self) -> str | None:
        """Read the opaque token from the 0600 sidecar, or None (fail-closed).

        Any read error degrades to None so the proxy refuses the call with 'no run
        ticket' rather than crashing — the store is the authority, an unreadable
        sidecar just means unauthenticated. Both OSError (missing / permission) AND
        a DECODE error must be caught: a non-UTF-8 / corrupted sidecar raises
        ``UnicodeDecodeError`` (a ``ValueError``, NOT an ``OSError``), which would
        otherwise escape ``_execute``'s handler catch-all and surface as a raw
        JSON-RPC frame error instead of a model-facing fail-closed refusal."""
        if not self.ticket_file:
            return None
        try:
            token = Path(self.ticket_file).read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            return None
        return token or None


def write_ticket_file(path: str | Path, token: str) -> Path:
    """Write ``token`` to a 0600 file at ``path`` (created/truncated atomically-ish).

    The orchestrator calls this to stage the secret for the proxy child. The file
    is created with mode 0600 (owner read/write only) BEFORE the secret is written
    — an existing file is truncated and its mode re-asserted, so a pre-existing
    world-readable file cannot leak the new token. ``O_NOFOLLOW`` refuses to follow
    a pre-planted SYMLINK at the path (a symlinked sidecar would otherwise let an
    attacker redirect the secret write elsewhere / pre-read it). Returns the
    resolved path."""
    resolved = Path(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    # Open with O_CREAT|O_WRONLY|O_TRUNC|O_NOFOLLOW at 0600 so the secret is never
    # briefly world-readable and a symlinked target is refused; re-chmod defends
    # against a pre-existing looser-mode regular file.
    flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(resolved, flags, 0o600)
    try:
        if hasattr(os, "fchmod"):  # POSIX only; os.fchmod is absent on Windows
            os.fchmod(fd, 0o600)
        os.write(fd, token.encode("utf-8"))
    finally:
        os.close(fd)
    if os.name == "nt":
        # NTFS ignores the 0o600 mode arg above, so the secret would keep the
        # parent's inherited ACL. Restrict it to the current user explicitly.
        from superclaw.secure_fs import harden_path

        harden_path(resolved, is_dir=False)
    return resolved


def build_team_mcp_config(
    *,
    python_executable: str | None = None,
    run_id: str,
    agent_profile_id: str,
    company_id: str,
    state_path: str | Path,
    ticket_file: str | Path,
    audience: str = TEAM_MCP_AUDIENCE,
    server_name: str = "superclaw-team",
    operator_scope: bool = False,
) -> dict[str, Any]:
    """Build an A-class MCP config pointing at this proxy for ONE run.

    The opaque ticket token is NOT placed here — argv carries only the PATH to a
    0600 sidecar file (``--ticket-file``) the proxy reads, plus the non-secret pins
    (run / agent / company / audience) and the state DB path. The token itself is
    never in argv (``ps``-visible) and never in the MCP config (which
    ``_secret_free_mcp_servers`` keeps secret-free). The ticket — verified against
    the store — is the authority; argv is only the expectation it must match.

    ``operator_scope`` adds ``--operator-scope`` so the proxy re-derives the operator
    admin scope. It is NOT a privilege the flag confers on its own: the proxy still
    verifies a ticket, and operator mode only succeeds for an operator-audience
    ticket (pass ``audience=OPERATOR_MCP_AUDIENCE``), so the flag and the audience
    travel together.
    """
    args = [
        "-m", "superclaw.team_mcp_proxy", "serve",
        "--state-path", os.fspath(state_path),
        "--ticket-file", os.fspath(ticket_file),
        "--run-id", run_id,
        "--agent-profile-id", agent_profile_id,
        "--company-id", company_id,
        "--audience", audience,
    ]
    if operator_scope:
        args.append("--operator-scope")
    return {
        "mcpServers": {
            server_name: {
                "command": python_executable or sys.executable,
                "args": args,
            }
        }
    }


class TeamMcpProxyServer:
    """stdio MCP server fronting the company command choke point for one run."""

    def __init__(self, options: TeamMcpProxyOptions):
        self.options = options
        self._store: Any = None

    def _get_store(self) -> Any:
        """Open (once) the durable StateStore the ticket is verified against.

        Lazily constructed so a tools/list (no store needed) never touches the
        DB, and so a construction failure surfaces as a fail-closed error string
        on the first call rather than crashing the server at startup.
        """
        if self._store is None:
            from superclaw.state import StateStore

            self._store = StateStore(self.options.state_path)
        return self._store

    def handle_message(self, message: dict[str, Any]) -> dict[str, Any] | None:
        message_id = message.get("id")
        if message_id is None:
            return None
        method = str(message.get("method") or "")
        if method == "initialize":
            return _ok(
                message_id,
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "superclaw-team-proxy", "version": "0.1.0"},
                },
            )
        if method == "tools/list":
            return _ok(message_id, {"tools": list(_team_tool_defs())})
        if method == "tools/call":
            params = message.get("params") or {}
            name = str(params.get("name") or "")
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                return _err(message_id, -32602, "tools/call arguments must be an object")
            return self._handle_call(message_id, name, arguments)
        return _err(message_id, -32601, f"unsupported method: {method}")

    def _handle_call(self, message_id: Any, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        # An unknown tool name is a model-facing error, never a route into the
        # kernel. The closed map is the single source — a name not in it is not a
        # company command and is refused here.
        command_type = TOOL_NAME_TO_COMMAND_TYPE.get(name) or COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE.get(name)
        if command_type is None:
            return _error_content(message_id, f"unknown tool: {name!r}; not a company command; do not retry")

        # Outermost fail-closed boundary for the WHOLE tools/call path: any
        # exception that escapes _execute (a verifier/store/scope-build error
        # outside its named catches) must still surface as a model-facing
        # ``isError`` tools/call RESULT, never a raw stdio JSON-RPC ``id:null``
        # frame error. _execute already maps the common cases; this guarantees the
        # contract holds even for an unforeseen escape (advisor non-blocking note).
        try:
            text = self._execute(command_type, arguments)
        except Exception as exc:  # noqa: BLE001 — never raise into the agent loop
            text = f"error: company command failed: {type(exc).__name__}: {exc}; do not retry"
        # ``_execute`` returns either an ``error: ...`` string (refusal) or a JSON
        # status string (executed / pending_approval). Map the refusal to
        # ``isError`` so the agent reads it as a failed call, not a success.
        is_error = text.startswith("error:")
        return _content_text(message_id, text, is_error=is_error)

    def _execute(self, command_type: str, arguments: dict[str, Any]) -> str:
        """Verify the ticket, re-derive scope, and dispatch — fail-closed to a string.

        Mirrors ``orchestrator._build_company_command_resolver`` exactly so the
        A-class MCP path and the B-class in-loop path return the same model-facing
        contract. Every failure mode is a string; nothing raises into the loop.
        """
        from superclaw.company_commands import get_command_model
        from superclaw.company_handler import execute_company_command
        from superclaw.company_lifecycle import CompanyFrozenError
        from superclaw.company_scope import CompanyScope, CompanyScopeError
        from superclaw.company_ticket import TicketError, verify_run_ticket

        # (0) BIND operator mode to the operator audience — THE escalation seam.
        # ``operator_scope`` and ``audience`` arrive as INDEPENDENT argv the launching
        # client controls (and a confined team agent can rewrite its own MCP config).
        # The ``--operator-scope`` flag is NOT a privilege on its own: without this
        # check a team agent could keep ``--audience team-mcp`` (so its team ticket
        # passes the audience match at step (1)) while ALSO passing ``--operator-scope``
        # (so step (2) builds an admin scope) — laundering a confined team ticket into
        # cross-company admin. Refusing the mismatch fail-closed forces the two to
        # travel together: operator mode can ONLY verify against an operator-audience
        # ticket, which the kernel mints solely for the operator direct chat (a team
        # run's sidecar never holds one). This is the binding the audience seam relies
        # on; without it the seam is open. (advisors: agy R1 / codex R1)
        if self.options.operator_scope and self.options.audience != OPERATOR_MCP_AUDIENCE:
            return (
                "error: forbidden: operator scope requires the operator-mcp audience; "
                "do not retry"
            )

        token = self.options.read_ticket_token()
        if not token:
            # No secret reached the child (no sidecar / unreadable / not minted):
            # the channel is unauthenticated and must execute nothing. Fail-closed.
            return "error: forbidden: no run ticket presented to the team MCP channel; do not retry"

        # Open the store FIRST (verification authority). A store that cannot be
        # opened is a fail-closed refusal, not a crash.
        try:
            store = self._get_store()
        except Exception as exc:  # noqa: BLE001 — any store-open failure is fail-closed
            return f"error: company command failed: cannot open state ({type(exc).__name__}); do not retry"

        # (1) Authenticate the ticket against the durable store, scoped to THIS
        # action + audience + the orchestrator-pinned run/agent/company. A
        # mismatch / expiry / unknown / action-not-permitted is a hard refusal.
        try:
            verified = verify_run_ticket(
                store,
                token,
                action=command_type,
                audience=self.options.audience,
                expected_run_id=self.options.run_id,
                expected_agent_profile_id=self.options.agent_profile_id,
                expected_company_id=self.options.company_id,
            )
        except TicketError as exc:
            return f"error: forbidden: ticket verification failed ({exc}); do not retry"

        # (2) Re-derive scope from the VERIFIED ticket — never from tool args.
        if self.options.operator_scope:
            # OPERATOR channel: the verified ticket authenticated a run-bound,
            # operator-AUDIENCE credential the kernel minted for the direct user
            # chat. Re-derive the SAME admin scope the CLI (``_cli_operator_scope``)
            # and the B-class in-loop resolver build for the operator
            # (is_admin=True, principal_id = the verified ticket's agent_profile_id,
            # which the orchestrator pinned to the run principal — so audit/owner
            # attribution matches B-class), so create / manage / cross-company all
            # work uniformly across every runtime. ``is_admin`` is
            # NOT read from the ticket (it carries none) — it follows from this proxy
            # being in operator mode, which is only reachable WITH an operator-audience
            # ticket: a confined team ticket fails the audience match at step (1)
            # above, so a team agent can never land here. The scope gate downstream
            # still enforces same-origin correctness even for an admin.
            scope = CompanyScope(
                principal_id=verified.agent_profile_id,
                actor_company_id=verified.company_id,
                is_admin=True,
                # Carried for parity; an operator ticket never holds a respond
                # grant (the kernel mints one only on the confined team channel),
                # so this is None in practice — an admin already owns everything.
                respond_issue_id=verified.respond_issue_id,
            )
        else:
            # TEAM channel: is_admin is hard False (a ticket-authed actor is never
            # admin), and the acting agent / company come from the verified record.
            # This is the same confined, fail-closed scope the orchestrator builds
            # for a team run.
            scope = CompanyScope(
                principal_id=verified.agent_profile_id,
                actor_company_id=verified.company_id,
                allowed_company_ids=frozenset({verified.company_id}),
                is_admin=False,
                actor_agent_profile_id=verified.agent_profile_id,
                # Run-scoped respond grant (#2): carried from the verified ticket so
                # the A-class (proxy) path authorizes the SAME single non-owned
                # comment the B-class (in-loop) scope does. None when no grant.
                respond_issue_id=verified.respond_issue_id,
                # Bind to the verified run so the grant is single-use: the
                # autonomy门 consumes it keyed by (run_id, issue_id) — the SAME
                # capping the B-class in-loop scope gets. run_id is the run the
                # ticket was minted for (server-pinned), never self-reported.
                run_id=verified.run_id,
            )

        # (3-read) Company READ tools (roadmap P0): a read command_type dispatches
        # through the read choke point using the SAME ticket-verified scope derived
        # above (no read-privilege bypass — reads honour the same audience/confinement
        # as writes). Read-only: no lifecycle/risk gate, just scope.permits inside
        # execute_company_read. Returns the DTO as a JSON string; every failure is a
        # refusal string (parity with the B-class read resolver).
        if command_type in COMPANY_READ_TOOL_NAME_TO_COMMAND_TYPE.values():
            from superclaw.company_read import execute_company_read, get_company_read_model

            try:
                read_model = get_company_read_model(command_type)
                read = read_model.from_dict(arguments)
            except (KeyError, ValueError, TypeError) as exc:
                return f"error: invalid company read ({command_type}): {exc}; do not retry"
            try:
                payload = execute_company_read(read, scope=scope, store=store)
            except CompanyScopeError as exc:
                return (
                    f"error: forbidden: {exc.reason}; this company is outside the "
                    f"current scope; do not retry"
                )
            except (ValueError, KeyError, TypeError) as exc:
                return f"error: company read failed: {type(exc).__name__}: {exc}; do not retry"
            return json.dumps({"status": "ok", "data": payload})

        # (3) Rebuild the typed command (fail-closed on unknown fields), then
        # dispatch through the SINGLE choke point. Every governance gate (scope /
        # lifecycle / autonomy / risk) lives there and runs unchanged.
        try:
            model = get_command_model(command_type)
            command = model.from_dict(arguments)
        except (KeyError, ValueError, TypeError) as exc:
            return f"error: invalid company command ({command_type}): {exc}; do not retry"

        try:
            result = execute_company_command(
                command, scope=scope, store=store, requested_by=verified.agent_profile_id
            )
        except CompanyScopeError as exc:
            return (
                f"error: forbidden: {exc.reason}; this target is outside the "
                f"current scope; do not retry"
            )
        except CompanyFrozenError as exc:
            return f"error: company is frozen/archived: {exc}; do not retry"
        except NotImplementedError as exc:
            return f"error: not supported yet: {exc}; do not retry"
        except (ValueError, KeyError) as exc:
            return f"error: company command failed: {type(exc).__name__}: {exc}; do not retry"
        except Exception as exc:  # noqa: BLE001 — never raise into the agent loop
            # Final catch-all (parity-plus over the B-class resolver's named set): an
            # unexpected handler error must read back as a refusal string, not crash
            # the MCP server / agent loop. Fail-closed.
            return f"error: company command failed: {type(exc).__name__}: {exc}; do not retry"

        if result.outcome == "executed":
            return json.dumps({"status": "executed", "detail": result.detail})
        # pending_approval (HIGH = archive): a durable, human-decidable approval
        # is already recorded; the mutation has NOT happened. Tell the agent
        # unambiguously to STOP and not assume the company changed (parity with
        # the B-class resolver).
        approval_id = result.detail.get("approval_id")
        return json.dumps(
            {
                "status": "pending_approval",
                "approval_id": approval_id,
                "executed": False,
                "message": (
                    f"This is an irreversible action and was NOT executed. It "
                    f"has been queued for human approval (approval_id={approval_id}). "
                    f"STOP: do not assume the company was changed. Tell the user "
                    f"they must approve it in the Web UI or CLI approvals queue."
                ),
            }
        )


def _team_tool_defs() -> list[dict[str, Any]]:
    """Project the single-source COMPANY_COMMAND_TOOLS into MCP tool defs.

    Returns a fresh deep copy (a client mutating the result can never corrupt the
    contract source). The MCP ``inputSchema`` is the JSON-Schema the command
    model's ``from_dict`` re-validates — the schema is a guide, ``from_dict`` is
    the authority.
    """
    defs: list[dict[str, Any]] = []
    for tool in (*COMPANY_COMMAND_TOOLS, *COMPANY_READ_TOOLS):
        defs.append(
            {
                "name": str(tool["name"]),
                "description": str(tool["description"]),
                "inputSchema": json.loads(json.dumps(tool["input_schema"])),
            }
        )
    return defs


def _ok(message_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def _err(message_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "error": {"code": code, "message": message}}


def _content_text(message_id: Any, text: str, *, is_error: bool) -> dict[str, Any]:
    return _ok(message_id, {"content": [{"type": "text", "text": text}], "isError": is_error})


def _error_content(message_id: Any, text: str) -> dict[str, Any]:
    return _content_text(message_id, f"error: {text}" if not text.startswith("error:") else text, is_error=True)


def serve_stdio(options: TeamMcpProxyOptions, *, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
    server = TeamMcpProxyServer(options)
    for line in stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("message must be a JSON object")
            response = server.handle_message(message)
        except Exception as exc:  # keep stdio server alive for malformed client frames
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}}
        if response is not None:
            stdout.write(json.dumps(response, ensure_ascii=False, sort_keys=True) + "\n")
            stdout.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m superclaw.team_mcp_proxy")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve_parser = subparsers.add_parser("serve")
    serve_parser.add_argument("--state-path", required=True)
    serve_parser.add_argument("--ticket-file", required=True)
    serve_parser.add_argument("--run-id", required=True)
    serve_parser.add_argument("--agent-profile-id", required=True)
    serve_parser.add_argument("--company-id", required=True)
    serve_parser.add_argument("--audience", default=TEAM_MCP_AUDIENCE)
    # Operator channel: re-derive the admin scope (only succeeds with an
    # operator-audience ticket; the flag alone confers nothing — see _execute).
    serve_parser.add_argument("--operator-scope", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "serve":
        serve_stdio(
            TeamMcpProxyOptions(
                state_path=args.state_path,
                run_id=args.run_id,
                agent_profile_id=args.agent_profile_id,
                company_id=args.company_id,
                # The secret is read from the 0600 sidecar at call time, never argv.
                ticket_file=args.ticket_file,
                audience=args.audience,
                operator_scope=args.operator_scope,
            )
        )
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
