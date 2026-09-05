from __future__ import annotations

import contextlib
import json
import os
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator

try:  # POSIX file locking
    import fcntl
except ImportError:  # pragma: no cover - platform dependent
    fcntl = None  # type: ignore[assignment]

try:  # Windows file locking
    import msvcrt
except ImportError:  # pragma: no cover - platform dependent
    msvcrt = None  # type: ignore[assignment]

DEFAULT_SHELL_CONFIG_PATH = Path.home() / ".superclaw" / "config.json"
SHELL_CONFIG_ENV = "SUPERCLAW_SHELL_CONFIG_PATH"
SHELL_MODES = {"auto", "chat", "delivery"}


# Field-level UI schema vocabulary for runtime config entries. The kernel is
# the single source of truth for how a config value should be edited; every
# surface (CLI prompts, web settings, desktop) renders from this contract
# instead of hardcoding per-field widgets.
RUNTIME_CONFIG_UI_SECTIONS = ("basic", "advanced")
RUNTIME_CONFIG_UI_TYPES = ("text", "path", "url", "number", "toggle", "select", "secret")

# Values the kernel treats as booleans ('0'/'1'/'true'/'false' strings).
_BOOLEAN_CONFIG_NAMES = {
    "delegation",
    "SUPERCLAW_HTTP_ALLOW_PRIVATE",
    "SUPERCLAW_OPENCLAW_GATEWAY_ALLOW_INSECURE",
    "SUPERCLAW_AUTO_PROJECT_PLUGINS",
    "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST",
}

# Values consumed as plain numbers (the app-server timeout is parsed as a
# float — renderers must not assume integer-only input). SUPERCLAW_HTTP_TIMEOUT_SEC
# is excluded on purpose: its default is the sentinel string 'run-budget'.
_NUMBER_CONFIG_NAMES = {
    "SUPERCLAW_CODEX_APP_SERVER_POST_TOOL_TIMEOUT_SECONDS",
    "SUPERCLAW_GEMINI_MAX_ITERATIONS",
    "SUPERCLAW_GEMINI_MAX_TOKENS",
}


@dataclass(frozen=True)
class RuntimeConfigSpec:
    name: str
    category: str
    description: str
    default: str | None = None
    secret: bool = False
    persist_allowed: bool = True
    # Enumerated choices, only when the kernel actually validates them
    # (claiming an enum the kernel does not enforce would be a schema lie).
    choices: tuple[str, ...] | None = None
    # 'basic' renders by default; 'advanced' sits behind a disclosure,
    # mirroring the plugin-config CONFIG_UI_SECTIONS precedent.
    ui_section: str = "advanced"
    # Explicit control-type override; derived from the spec when None.
    ui_type: str | None = None


def _derived_ui_type(spec: "RuntimeConfigSpec") -> str:
    if spec.ui_type:
        return spec.ui_type
    if spec.secret:
        return "secret"
    if spec.choices:
        return "select"
    name = spec.name
    if name == "repo" or name.endswith("_EXECUTABLE") or name.endswith("_KEY_PATH"):
        return "path"
    if name in _BOOLEAN_CONFIG_NAMES:
        return "toggle"
    if name in _NUMBER_CONFIG_NAMES:
        return "number"
    if name.endswith("_URL"):
        return "url"
    return "text"


def runtime_config_ui_descriptor(spec: "RuntimeConfigSpec") -> dict[str, Any]:
    return {
        "type": _derived_ui_type(spec),
        "section": spec.ui_section,
        "choices": list(spec.choices) if spec.choices else None,
    }


# APP_ENV is deliberately NOT a runtime config entry. The environment (staging vs
# production) is a compile-time identity baked into the bundle (build-profile.json),
# not a value the end user edits — exposing it here would let a production build be
# silently flipped to staging (or vice-versa) and split the app's identity. The
# kernel still honors an explicit APP_ENV env var for builds / power users
# (superclaw.environment.app_environment), but it is not surfaced, persisted, or
# editable through any settings surface.
_RUNTIME_CONFIG_SPECS = {
    "backend": RuntimeConfigSpec("backend", "shell", "Default backend for new interactive turns.", default="claude", ui_section="basic"),
    "mode": RuntimeConfigSpec("mode", "shell", "Default shell mode for new sessions.", default="auto", choices=("auto", "chat", "delivery"), ui_section="basic"),
    "repo": RuntimeConfigSpec("repo", "shell", "Default workspace root for new shell sessions.", ui_section="basic"),
    "delegation": RuntimeConfigSpec("delegation", "shell", "Allow the chat agent to delegate subtasks across runtimes (governed; default off / fail-closed). When off, the delegate tool is not injected and the model cannot delegate.", default="false", ui_section="advanced"),
    "semantic_skill_autotrigger": RuntimeConfigSpec("semantic_skill_autotrigger", "shell", "Let the chat agent semantically discover and apply a relevant native skill without an explicit @skill (default on). The available-skill catalog it sees is built fail-closed (only real registered skills) and bounded; turn off to require explicit @skill.", default="true", ui_section="advanced"),
    "CLAWHUNT_BASE_URL": RuntimeConfigSpec("CLAWHUNT_BASE_URL", "clawhunt", "Base URL for ClawHunt API requests. Resolved per-environment from APP_ENV (staging/production); set this only to override the built-in default (e.g. point a local dev build at http://127.0.0.1:8787).", default=None, ui_section="basic"),
    "SUPERCLAW_CODEX_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_CODEX_EXECUTABLE", "backend", "Path to the local Codex executable.", ui_section="basic"),
    "SUPERCLAW_CODEX_MODE": RuntimeConfigSpec("SUPERCLAW_CODEX_MODE", "backend", "Codex execution mode.", default="exec"),
    "SUPERCLAW_CODEX_MODEL": RuntimeConfigSpec("SUPERCLAW_CODEX_MODEL", "backend", "Codex model override (codex exec / app-server; legacy CLI mode refuses it).", default="configured-default"),
    "SUPERCLAW_HTTP_MODEL": RuntimeConfigSpec("SUPERCLAW_HTTP_MODEL", "backend", "Model forwarded in the HTTP backend request body (the endpoint owns whether to honor it).", default="configured-default"),
    "SUPERCLAW_CODEX_APP_SERVER_POST_TOOL_TIMEOUT_SECONDS": RuntimeConfigSpec(
        "SUPERCLAW_CODEX_APP_SERVER_POST_TOOL_TIMEOUT_SECONDS",
        "backend",
        "Seconds to wait for Codex app-server activity after a tool event before interrupting a stalled turn.",
        default="30",
    ),
    "SUPERCLAW_CLAUDE_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_CLAUDE_EXECUTABLE", "backend", "Path to the local Claude Code executable.", ui_section="basic"),
    "SUPERCLAW_CLAUDE_MODEL": RuntimeConfigSpec("SUPERCLAW_CLAUDE_MODEL", "backend", "Claude Code model override.", default="claude-opus-4-8"),
    "SUPERCLAW_HERMES_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_HERMES_EXECUTABLE", "backend", "Path to the local Hermes executable.", ui_section="basic"),
    "SUPERCLAW_HERMES_MODEL": RuntimeConfigSpec("SUPERCLAW_HERMES_MODEL", "backend", "Hermes model override.", default="configured-default"),
    "SUPERCLAW_HERMES_PROVIDER": RuntimeConfigSpec("SUPERCLAW_HERMES_PROVIDER", "backend", "Hermes provider override.", default="configured-default"),
    "SUPERCLAW_HERMES_TOOLSETS": RuntimeConfigSpec("SUPERCLAW_HERMES_TOOLSETS", "backend", "Hermes toolset bundle names."),
    "SUPERCLAW_HERMES_SKILLS": RuntimeConfigSpec("SUPERCLAW_HERMES_SKILLS", "backend", "Hermes skill bundle names."),
    "SUPERCLAW_OPENCLAW_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_OPENCLAW_EXECUTABLE", "backend", "Path to the local OpenClaw executable.", ui_section="basic"),
    "SUPERCLAW_OPENCLAW_ARGS": RuntimeConfigSpec("SUPERCLAW_OPENCLAW_ARGS", "backend", "Extra OpenClaw CLI arguments.", default="--print"),
    "SUPERCLAW_OPENCLAW_MODEL": RuntimeConfigSpec("SUPERCLAW_OPENCLAW_MODEL", "backend", "OpenClaw model override.", default="configured-default"),
    "SUPERCLAW_OPENCLAW_GATEWAY_URL": RuntimeConfigSpec("SUPERCLAW_OPENCLAW_GATEWAY_URL", "backend", "OpenClaw Gateway WebSocket URL (ws:// loopback or wss://) for the openclaw-gateway backend."),
    "SUPERCLAW_OPENCLAW_GATEWAY_TOKEN": RuntimeConfigSpec("SUPERCLAW_OPENCLAW_GATEWAY_TOKEN", "backend", "Shared OpenClaw Gateway token.", secret=True, persist_allowed=False),
    "SUPERCLAW_OPENCLAW_DEVICE_KEY_PATH": RuntimeConfigSpec("SUPERCLAW_OPENCLAW_DEVICE_KEY_PATH", "backend", "Path to a stable Ed25519 device key (PEM) so the gateway device stays paired across runs."),
    "SUPERCLAW_OPENCLAW_GATEWAY_ALLOW_INSECURE": RuntimeConfigSpec("SUPERCLAW_OPENCLAW_GATEWAY_ALLOW_INSECURE", "backend", "Allow plaintext ws:// to a non-loopback gateway host (insecure; default false).", default="false"),
    "SUPERCLAW_OPENCODE_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_OPENCODE_EXECUTABLE", "backend", "Path to the local OpenCode executable.", ui_section="basic"),
    "SUPERCLAW_OPENCODE_MODEL": RuntimeConfigSpec("SUPERCLAW_OPENCODE_MODEL", "backend", "OpenCode model override (provider/model).", default="configured-default"),
    "SUPERCLAW_GROK_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_GROK_EXECUTABLE", "backend", "Path to the local grok executable.", ui_section="basic"),
    "SUPERCLAW_GROK_MODEL": RuntimeConfigSpec("SUPERCLAW_GROK_MODEL", "backend", "Grok model override.", default="configured-default"),
    # SUPERCLAW_GROK_EFFORT removed: no Grok model honors a reasoning-effort
    # selection (GrokCliBackend.supports_effort=False), so the knob did nothing.
    "SUPERCLAW_CURSOR_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_CURSOR_EXECUTABLE", "backend", "Path to the local cursor-agent executable.", ui_section="basic"),
    "SUPERCLAW_CURSOR_MODEL": RuntimeConfigSpec("SUPERCLAW_CURSOR_MODEL", "backend", "Cursor model override.", default="configured-default"),
    "SUPERCLAW_HTTP_URL": RuntimeConfigSpec("SUPERCLAW_HTTP_URL", "backend", "HTTP backend endpoint URL (the operator-configured trust boundary)."),
    "SUPERCLAW_HTTP_METHOD": RuntimeConfigSpec("SUPERCLAW_HTTP_METHOD", "backend", "HTTP backend request method.", default="POST"),
    "SUPERCLAW_HTTP_HEADERS": RuntimeConfigSpec("SUPERCLAW_HTTP_HEADERS", "backend", "HTTP backend request headers (JSON object; may carry an auth token).", secret=True, persist_allowed=False),
    "SUPERCLAW_HTTP_TIMEOUT_SEC": RuntimeConfigSpec("SUPERCLAW_HTTP_TIMEOUT_SEC", "backend", "HTTP backend request timeout in seconds (defaults to the run budget).", default="run-budget"),
    "SUPERCLAW_HTTP_ALLOW_PRIVATE": RuntimeConfigSpec("SUPERCLAW_HTTP_ALLOW_PRIVATE", "backend", "Allow the HTTP backend to call private/loopback hosts (SSRF guard override; default false).", default="false"),
    "SUPERCLAW_CLAWWORK_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_CLAWWORK_EXECUTABLE", "backend", "Path to the ClawWork (pi fork) executable for the experimental model-relay backend.", ui_section="basic"),
    "SUPERCLAW_CLAWWORK_MODEL": RuntimeConfigSpec("SUPERCLAW_CLAWWORK_MODEL", "backend", "ClawWork relay package (套餐) id; provider is clawrelay.", default="core"),
    "SUPERCLAW_CLAWWORK_GOVERNANCE_EXT": RuntimeConfigSpec("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", "backend", "Path to the ClawWork superclaw-governance extension (.ts). Optional override — defaults to the vendored third_party/clawwork extension; ClawWork still refuses to run if neither is present (fail-closed)."),
    "SUPERCLAW_RELAY_BASE_URL": RuntimeConfigSpec("SUPERCLAW_RELAY_BASE_URL", "backend", "Model relay (LLMgate, OpenAI/Anthropic-compatible /v1) feeding ClawWork's clawrelay provider. Resolved per-environment from APP_ENV; set this only to override the built-in default."),
    "SUPERCLAW_RELAY_API_KEY": RuntimeConfigSpec("SUPERCLAW_RELAY_API_KEY", "backend", "Model relay API key for ClawWork's clawrelay provider.", secret=True, persist_allowed=False),
    "SUPERCLAW_BOBO_EXECUTABLE": RuntimeConfigSpec("SUPERCLAW_BOBO_EXECUTABLE", "backend", "Path to the local bobo executable.", ui_section="basic"),
    "SUPERCLAW_BOBO_MODEL": RuntimeConfigSpec("SUPERCLAW_BOBO_MODEL", "backend", "bobo model override.", default="configured-default"),
    # No baked default: the kernel only falls back to localhost when running from
    # source (local-only daemons with no online deployment); a distributed bundle
    # resolves these to None unless explicitly configured, so the surface must not
    # advertise a localhost value it would not actually use.
    "SUPERCLAW_FUSION_OSIRIS_URL": RuntimeConfigSpec("SUPERCLAW_FUSION_OSIRIS_URL", "fusion", "OSIRIS fusion preview/service URL (defaults to localhost only when running from source)."),
    "SUPERCLAW_FUSION_OPEN_DESIGN_URL": RuntimeConfigSpec("SUPERCLAW_FUSION_OPEN_DESIGN_URL", "fusion", "Open Design fusion preview/service URL (defaults to localhost only when running from source)."),
    "SUPERCLAW_FUSION_OPENPENCIL_URL": RuntimeConfigSpec("SUPERCLAW_FUSION_OPENPENCIL_URL", "fusion", "OpenPencil fusion preview/service URL (defaults to localhost only when running from source)."),
    "SUPERCLAW_GEMINI_API_KEY": RuntimeConfigSpec("SUPERCLAW_GEMINI_API_KEY", "backend", "Gemini API key for local API-agent runs.", secret=True, persist_allowed=False),
    "SUPERCLAW_GEMINI_MODEL": RuntimeConfigSpec("SUPERCLAW_GEMINI_MODEL", "backend", "Gemini model override.", default="gemini-2.5-flash"),
    "SUPERCLAW_GEMINI_BASE_URL": RuntimeConfigSpec("SUPERCLAW_GEMINI_BASE_URL", "backend", "Gemini API base URL."),
    "SUPERCLAW_GEMINI_MAX_ITERATIONS": RuntimeConfigSpec("SUPERCLAW_GEMINI_MAX_ITERATIONS", "backend", "Gemini agent max iterations.", default="12"),
    "SUPERCLAW_GEMINI_MAX_TOKENS": RuntimeConfigSpec("SUPERCLAW_GEMINI_MAX_TOKENS", "backend", "Gemini agent max output tokens.", default="8192"),
    "ANTHROPIC_API_KEY": RuntimeConfigSpec("ANTHROPIC_API_KEY", "backend", "Anthropic API key for direct API-agent runs.", secret=True, persist_allowed=False),
    "SUPERCLAW_ANTHROPIC_BASE_URL": RuntimeConfigSpec("SUPERCLAW_ANTHROPIC_BASE_URL", "backend", "Anthropic API base URL override."),
    "SUPERCLAW_ANTHROPIC_MODEL": RuntimeConfigSpec("SUPERCLAW_ANTHROPIC_MODEL", "backend", "Anthropic model override.", default="claude-opus-4-8"),
    "SUPERCLAW_ANTHROPIC_AGENT_MODEL": RuntimeConfigSpec("SUPERCLAW_ANTHROPIC_AGENT_MODEL", "backend", "Anthropic API-agent model override.", default="claude-opus-4-8"),
    "SUPERCLAW_RUNNINGHUB_API_KEYS": RuntimeConfigSpec(
        "SUPERCLAW_RUNNINGHUB_API_KEYS",
        "media",
        "Comma-separated RunningHub API keys for governed image/video generation rotation.",
        secret=True,
        persist_allowed=False,
    ),
    "SUPERCLAW_RUNNINGHUB_API_KEY": RuntimeConfigSpec(
        "SUPERCLAW_RUNNINGHUB_API_KEY",
        "media",
        "Single RunningHub API key fallback for local image/video generation.",
        secret=True,
        persist_allowed=False,
    ),
    "SUPERCLAW_RUNNINGHUB_BASE_URL": RuntimeConfigSpec(
        "SUPERCLAW_RUNNINGHUB_BASE_URL",
        "media",
        # No baked default: RunningHub is a third-party service, fail-closed in a
        # distributed bundle (defaults to the localhost dev mock only when running
        # from source). The surface must not present a localhost value it won't use.
        "RunningHub API base URL. Required explicitly in a distributed build (defaults to the localhost dev mock only when running from source).",
    ),
    "SUPERCLAW_RUNNINGHUB_MEDIA_TEMPLATES_JSON": RuntimeConfigSpec(
        "SUPERCLAW_RUNNINGHUB_MEDIA_TEMPLATES_JSON",
        "media",
        "Optional JSON override for RunningHub media template node ids and quick-create codes.",
    ),
    "SUPERCLAW_AUTO_PROJECT_PLUGINS": RuntimeConfigSpec(
        "SUPERCLAW_AUTO_PROJECT_PLUGINS",
        "plugin",
        "Auto-project installed plugins as callable tools into delivery runs.",
        default="1",
    ),
    "SUPERCLAW_PLUGIN_PROJECTION_MODE": RuntimeConfigSpec(
        "SUPERCLAW_PLUGIN_PROJECTION_MODE",
        "plugin",
        "Plugin tool exposure: 'dispatch' (low-context meta-tools) or 'full'.",
        default="dispatch",
    ),
    "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY": RuntimeConfigSpec(
        "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY",
        "plugin",
        "Ed25519 root public key used to verify official plugin signatures.",
    ),
    "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST": RuntimeConfigSpec(
        "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST",
        "plugin",
        "Dev-only: trust locally-installed plugins whose signature cannot be verified by a root key (integrity, revocation, entitlement and policy are still enforced). Off by default.",
        default="0",
    ),
}


def runtime_config_specs() -> dict[str, RuntimeConfigSpec]:
    return dict(_RUNTIME_CONFIG_SPECS)


def _contains_control_character(value: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in value)


def _clean_config_string(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if not value or _contains_control_character(value):
        return None
    return value


def shell_config_path() -> Path:
    return Path(os.environ.get(SHELL_CONFIG_ENV, DEFAULT_SHELL_CONFIG_PATH))


def load_shell_config() -> dict[str, Any]:
    path = shell_config_path()
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


@contextmanager
def _hold_shell_config_lock() -> Iterator[None]:
    """Serialize the shell-config read-modify-write across processes.

    Uses ``fcntl`` (POSIX) or ``msvcrt`` (Windows). Without a locking primitive
    we fail closed rather than write unlocked — a silent unlocked write lets a
    concurrent ``config set`` and an onboarding write clobber each other's keys.
    """
    path = shell_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    guard = path.with_name(path.name + ".lock")
    handle = open(guard, "a+")  # noqa: SIM115 - released in finally
    try:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        elif msvcrt is not None:  # pragma: no cover - platform dependent
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:  # pragma: no cover - platform dependent
            raise RuntimeError("no file-locking primitive available; refusing unlocked shell-config write")
        yield
    finally:
        with contextlib.suppress(OSError):
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            elif msvcrt is not None:  # pragma: no cover - platform dependent
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        handle.close()


def _write_shell_config(config: dict[str, Any]) -> None:
    """Atomically replace the shell config (write a sibling temp, then rename).

    The temp lives in the same directory so ``os.replace`` is atomic on the same
    filesystem — a crash mid-write can never leave a half-written config.json.
    Callers must hold ``_hold_shell_config_lock`` to avoid lost updates.
    """
    path = shell_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _locked_update_shell_config(mutate: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    """Locked read-modify-write: read the latest config under the lock, apply
    ``mutate`` in place, then atomically persist. Returns the written config."""
    with _hold_shell_config_lock():
        config = load_shell_config()
        mutate(config)
        _write_shell_config(config)
        return config


def save_shell_config_value(name: str, value: str) -> None:
    if not name or _contains_control_character(name):
        raise ValueError("invalid shell config name")
    if _contains_control_character(value):
        raise ValueError("invalid shell config value")
    _locked_update_shell_config(lambda config: config.__setitem__(name, value))


def configured_shell_backend() -> str | None:
    return _clean_config_string(load_shell_config().get("backend"))


def configured_shell_mode() -> str | None:
    configured = _clean_config_string(load_shell_config().get("mode"))
    if configured:
        mode = configured.lower()
        if mode in SHELL_MODES:
            return mode
    return None


def configured_shell_repo() -> str | None:
    return _clean_config_string(load_shell_config().get("repo"))


def configured_shell_delegation() -> str | None:
    """The persisted delegation toggle's RAW value ('true'/'false'/'1'/'0'), or None.

    Shell-scoped like backend/mode/repo so it reads from the shell config rather
    than a literal lowercase env var. Returns the stored string for display
    (e.g. the config payload), NOT a truthiness verdict — never write
    ``if configured_shell_delegation():`` (the string ``"false"`` is truthy in
    Python). Use ``delegation_enabled()`` for the on/off decision.

    fail-closed on read, not just on write: a hand-edited / legacy config value
    that is not a recognized boolean is treated as unset (-> default off), never
    surfaced as a configured toggle. The kernel never trusts persisted state to
    be well-formed.
    """
    raw = _clean_config_string(load_shell_config().get("delegation"))
    if raw is None or raw.lower() not in {"true", "false", "1", "0"}:
        return None
    return raw


def delegation_enabled() -> bool:
    """Whether cross-runtime delegation is effectively ON (fail-closed bool).

    The ONLY truthy spellings are ``true``/``1``; everything else — ``false``,
    ``0``, unset, or a malformed persisted value — is OFF. This is the effective
    on/off contract a consumer must use (the delegate tool is injected, in a
    later PR, only when this is True); the kernel default is off so delegation
    never silently turns on.
    """
    raw = configured_shell_delegation()
    return raw is not None and raw.lower() in {"true", "1"}


def configured_shell_semantic_skill() -> str | None:
    """The persisted semantic-skill-autotrigger toggle's RAW value, or None.

    Shell-scoped like delegation; returns the stored string for display, NOT a
    truthiness verdict (``"false"`` is truthy in Python — use
    ``semantic_skill_autotrigger_enabled()`` for the decision). A garbled/legacy
    value reads as unset (-> product default)."""
    raw = _clean_config_string(load_shell_config().get("semantic_skill_autotrigger"))
    if raw is None or raw.lower() not in {"true", "false", "1", "0"}:
        return None
    return raw


def semantic_skill_autotrigger_enabled() -> bool:
    """Whether the chat agent may semantically discover + apply a relevant native
    skill WITHOUT an explicit @skill (default ON).

    Only a recognized ``false``/``0`` disables it; unset or a garbled value keeps the
    product default (ON) the owner chose. Unlike a mutating kill switch, the catalog
    this gates is model-visible PROSE only — built fail-closed (only real registered
    skills, :func:`build_available_skill_catalog`) and length-bounded — so "default
    on" relaxes no hard gate; it only decides whether the available-skill catalog is
    offered to the model. The explicit @skill path is unaffected by this toggle."""
    raw = configured_shell_semantic_skill()
    if raw is None:
        return True
    return raw.lower() in {"true", "1"}


COMPANY_TOOLS_ENV = "SUPERCLAW_COMPANY_TOOLS"


def company_tools_enabled() -> bool:
    """Whether the chat agent's company-management tools are projected (default ON).

    Under the single-user threat model (design §1) the user owns all their
    companies and "user-triggered => allowed", so these tools default ON. This
    differs from ``delegation_enabled`` (default OFF): cross-runtime delegation
    spawns child runs and is opt-in; company tools just let the chat assistant do
    company bookkeeping the user asked for, with irreversible ops (archive) still
    gated behind a human approval inside the handler.

    Fail-closed kill switch on a GARBLED value: because this gates a *mutating*
    projection, an unrecognized / malformed value must NOT silently keep the tools
    on (a kill switch you cannot trust is no kill switch). So:

      * UNSET            -> ON  (product default under the single-user model)
      * true/1/on/yes    -> ON  (recognized enable)
      * false/0/off/no   -> OFF (recognized disable)
      * anything else    -> OFF (fail-closed: an ambiguous toggle disables the
                                 mutating projection rather than enabling it)

    The governance that actually matters (archive => human approval, scope /
    lifecycle gates, the read-only-posture / low-trust-containment fence in the
    backend tool layer) runs regardless of this projection toggle, so "default
    ON" never relaxes a hard gate — it only decides whether the convenience tools
    are advertised to the chat agent at all.
    """
    raw = os.environ.get(COMPANY_TOOLS_ENV)
    if raw is None:
        return True
    normalized = raw.strip().lower()
    if normalized in {"true", "1", "on", "yes"}:
        return True
    if normalized in {"false", "0", "off", "no"}:
        return False
    # Unrecognized => fail-closed (OFF) for a mutating projection's kill switch.
    return False


MARKETPLACE_TOOLS_ENV = "SUPERCLAW_MARKETPLACE_TOOLS"


def marketplace_tools_enabled() -> bool:
    """Whether the chat agent's ClawHunt marketplace tools are projected (default ON).

    Same single-user rationale + fail-closed kill-switch semantics as
    ``company_tools_enabled`` (UNSET→ON; recognized enable→ON; recognized
    disable/garbled→OFF). The governance that matters — every marketplace WRITE is
    a human approval, the connected-agent-key auth gate, the read-only-posture /
    low-trust-containment fence (marketplace write tools are in
    ``permissions._MUTATING_TOOLS``) — runs regardless of this toggle; it only
    decides whether the convenience tools are advertised to the chat agent.
    """
    raw = os.environ.get(MARKETPLACE_TOOLS_ENV)
    if raw is None:
        return True
    normalized = raw.strip().lower()
    if normalized in {"true", "1", "on", "yes"}:
        return True
    if normalized in {"false", "0", "off", "no"}:
        return False
    return False


def persisted_runtime_environment() -> dict[str, str]:
    config = load_shell_config()
    persisted: dict[str, str] = {}
    for name, spec in _RUNTIME_CONFIG_SPECS.items():
        if not spec.persist_allowed or spec.secret or name in {"backend", "mode", "repo", "delegation"}:
            continue
        value = _clean_config_string(config.get(name))
        if value:
            persisted[name] = value
    return persisted


def hydrate_runtime_environment() -> list[str]:
    applied: list[str] = []
    for name, value in persisted_runtime_environment().items():
        if os.environ.get(name):
            continue
        os.environ[name] = value
        applied.append(name)
    return applied


@contextmanager
def applied_runtime_environment() -> Iterator[None]:
    previous: dict[str, str | None] = {}
    for name, value in persisted_runtime_environment().items():
        if os.environ.get(name):
            continue
        previous[name] = os.environ.get(name)
        os.environ[name] = value
    try:
        yield
    finally:
        for name, old_value in previous.items():
            if old_value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old_value


def set_runtime_config(
    name: str,
    value: str,
    *,
    allow_secret: bool = False,
    apply_process_env: bool = False,
) -> dict[str, Any]:
    if _contains_control_character(name):
        raise ValueError("unsupported config key")
    spec = _RUNTIME_CONFIG_SPECS.get(name)
    if name == "CLAWHUNT_AGENT_API_KEY":
        raise ValueError("use /login CLAWHUNT_AGENT_KEY for auth secrets")
    if spec is None:
        raise ValueError(f"unsupported config key: {name}")
    resolved = value.strip()
    if not resolved:
        raise ValueError(f"{name} requires a non-empty value")
    if _contains_control_character(resolved):
        raise ValueError(f"{name} must not contain control characters")
    if name == "mode" and resolved.lower() not in SHELL_MODES:
        raise ValueError("mode must be one of: auto, chat, delivery")
    # A spec that declares choices is enforced here, so the UI schema never
    # promises an enum the kernel would silently accept other values for.
    if spec.choices and name != "mode" and resolved not in spec.choices:
        raise ValueError(f"{name} must be one of: {', '.join(spec.choices)}")
    # Boolean configs carry a real contract: a governance toggle (e.g.
    # delegation) must not let an arbitrary string become a "configured" value.
    # Validate at the kernel config layer (a later reader still fail-closed
    # parses truthiness as defense in depth).
    if name in _BOOLEAN_CONFIG_NAMES and resolved.lower() not in {"true", "false", "1", "0"}:
        raise ValueError(f"{name} must be a boolean: true, false, 1, or 0")
    if spec.secret and not allow_secret:
        raise ValueError(f"{name} must be configured through a dedicated secret flow")
    persisted = False
    if spec.persist_allowed:
        save_shell_config_value(name, resolved)
        persisted = True
    if apply_process_env or spec.secret:
        # backend/mode/delegation are shell-scoped (read live from the shell
        # config), not process env vars — never hydrate them into os.environ.
        if name not in {"backend", "mode", "delegation"}:
            os.environ[name] = resolved
    return {
        "name": name,
        "value": None if spec.secret else resolved,
        "display_value": "set" if spec.secret else resolved,
        "secret": spec.secret,
        "persisted": persisted,
        "restart_required": bool(persisted and name not in {"backend", "mode", "delegation"}),
    }


def runtime_config_payload() -> dict[str, Any]:
    config = load_shell_config()
    entries: list[dict[str, Any]] = []
    for name, spec in _RUNTIME_CONFIG_SPECS.items():
        persisted_raw = config.get(name)
        persisted_value = _clean_config_string(persisted_raw)
        if name == "backend":
            value = configured_shell_backend() or spec.default
            source = "persisted" if configured_shell_backend() else "default"
            configured = configured_shell_backend() is not None
        elif name == "mode":
            value = configured_shell_mode() or spec.default
            source = "persisted" if configured_shell_mode() else "default"
            configured = configured_shell_mode() is not None
        elif name == "repo":
            value = configured_shell_repo()
            source = "persisted" if value else "default"
            configured = value is not None
        elif name == "delegation":
            configured_value = configured_shell_delegation()
            value = configured_value if configured_value is not None else spec.default
            source = "persisted" if configured_value is not None else "default"
            configured = configured_value is not None
        else:
            env_value = _clean_config_string(os.environ.get(name))
            if env_value:
                value = env_value
                source = "persisted" if persisted_value and env_value == persisted_value else "environment"
                configured = True
            elif persisted_value is not None:
                value = persisted_value
                source = "persisted"
                configured = True
            else:
                value = spec.default
                source = "default"
                configured = False
        entries.append(
            {
                "name": name,
                "category": spec.category,
                "description": spec.description,
                "default": spec.default,
                "configured": configured,
                "persist_allowed": spec.persist_allowed,
                "persisted": bool(persisted_value) if name not in {"backend", "mode"} else configured,
                "secret": spec.secret,
                "source": source,
                "value": None if spec.secret else value,
                "display_value": "set" if spec.secret and configured else "unset" if spec.secret else value,
                "ui": runtime_config_ui_descriptor(spec),
            }
        )
    return {
        "schema_version": "0.1.0",
        "config_path": str(shell_config_path()),
        "defaults": {
            "backend": configured_shell_backend() or "claude",
            "mode": configured_shell_mode() or "auto",
            "repo": configured_shell_repo(),
        },
        "auth": {
            "clawhunt_agent_api_key": "set" if os.environ.get("CLAWHUNT_AGENT_API_KEY") else "unset",
            "control_token": "set" if os.environ.get("SUPERCLAW_CONTROL_TOKEN") else "unset",
            "anthropic_api_key": "set" if os.environ.get("ANTHROPIC_API_KEY") else "unset",
            "gemini_api_key": "set" if (os.environ.get("SUPERCLAW_GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")) else "unset",
            "runninghub_api_keys": "set"
            if (os.environ.get("SUPERCLAW_RUNNINGHUB_API_KEYS") or os.environ.get("SUPERCLAW_RUNNINGHUB_API_KEY"))
            else "unset",
        },
        "entries": entries,
        "writable_names": sorted(_RUNTIME_CONFIG_SPECS),
        "ui_sections": list(RUNTIME_CONFIG_UI_SECTIONS),
    }


# Web onboarding tour completion. This is a presentation-layer preference (the
# tour itself lives only in the web/desktop surface), but it is persisted in the
# kernel shell config so completion is durable and consistent across surfaces —
# the kernel stays the single source of truth and the surface only reads/writes
# through it. It lives under a RESERVED namespaced key, never as a runtime config
# spec, so it can never be hydrated into the process environment
# (``persisted_runtime_environment`` only walks ``_RUNTIME_CONFIG_SPECS``).
ONBOARDING_CONFIG_KEY = "web_onboarding"


def _coerce_onboarding_version(value: Any) -> int:
    """A version is a strict non-negative ``int``; anything else normalizes to 0.

    ``bool`` is excluded explicitly because ``isinstance(True, int)`` is True —
    without this, a hand-edited ``version: true`` would survive as ``1`` and a
    surface's ``version >= TOUR_VERSION`` gate would WRONGLY suppress the tour.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def load_onboarding_state() -> dict[str, Any]:
    """The persisted onboarding-tour state, fail-closed to "not completed".

    A missing, malformed, or hand-edited value is treated as *unseen* (never
    silently "completed"), so a corrupt config can only ever re-show the tour —
    never suppress it. ``version`` lets the surface re-prompt finished users once
    when the walkthrough content materially changes, and is normalized to a
    strict non-negative int (a bad version can only lower the gate, never raise
    it past a real completion).
    """
    raw = load_shell_config().get(ONBOARDING_CONFIG_KEY)
    if not isinstance(raw, dict):
        return {"completed": False, "version": 0}
    completed = raw.get("completed") is True
    return {"completed": completed, "version": _coerce_onboarding_version(raw.get("version"))}


def set_onboarding_completed(version: int) -> dict[str, Any]:
    """Record the onboarding tour as completed for ``version`` in the shell config."""
    if not isinstance(version, int) or isinstance(version, bool) or version < 0:
        raise ValueError("version must be a non-negative integer")
    _locked_update_shell_config(
        lambda config: config.__setitem__(ONBOARDING_CONFIG_KEY, {"completed": True, "version": version})
    )
    return {"completed": True, "version": version}


GOAL_AUTONOMY_CONFIG_KEY = "goal_autonomous_continuation"


def goal_autonomous_continuation_enabled() -> bool:
    """Whether the autonomous goal-continuation daemon (PR8) may auto-start confirmed
    goals. Fail-closed default OFF: a missing / malformed / hand-edited value is treated
    as disabled, so the daemon NEVER auto-runs work unless the value is explicitly the
    boolean ``True`` — autonomy is opt-in and a corrupt config can only disable it."""
    return load_shell_config().get(GOAL_AUTONOMY_CONFIG_KEY) is True


def set_goal_autonomous_continuation(enabled: bool) -> bool:
    """Enable/disable the autonomous goal-continuation daemon in the shell config."""
    if not isinstance(enabled, bool):
        raise ValueError("enabled must be a boolean")
    _locked_update_shell_config(
        lambda config: config.__setitem__(GOAL_AUTONOMY_CONFIG_KEY, enabled)
    )
    return enabled


def reset_onboarding_state() -> dict[str, Any]:
    """Clear the persisted onboarding state so the tour auto-shows again."""
    _locked_update_shell_config(lambda config: config.pop(ONBOARDING_CONFIG_KEY, None))
    return {"completed": False, "version": 0}
