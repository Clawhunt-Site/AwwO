from __future__ import annotations

import json
import os
import sys
import unicodedata
from pathlib import Path
from urllib.parse import urlparse


APP_ENV_NAME = "APP_ENV"
# Two build identities only — selected once at compile time and baked into the
# bundle (build-profile.json), never edited at runtime:
#   * staging     — the development / acceptance build; points the whole app at
#                   the online TEST server (staging.clawhunt.store).
#   * production  — the shipping build; points at the production endpoints.
# A pure-localhost "development" tier no longer exists: a dev who wants to talk
# to 127.0.0.1 sets CLAWHUNT_BASE_URL (or the relevant SUPERCLAW_*_URL) explicitly
# instead of occupying a third baked environment.
APP_ENV_CHOICES = ("staging", "production")
DEFAULT_APP_ENV = "staging"

CLAWHUNT_BASE_URL_ENV = "CLAWHUNT_BASE_URL"
RELAY_BASE_URL_ENV = "SUPERCLAW_RELAY_BASE_URL"
RUNNINGHUB_BASE_URL_ENV = "SUPERCLAW_RUNNINGHUB_BASE_URL"
ANTHROPIC_BASE_URL_ENV = "SUPERCLAW_ANTHROPIC_BASE_URL"

# --- Per-environment service endpoints (single source of truth) -------------
# These are PUBLIC endpoints, not secrets. They are the one place a service URL
# may be written: every other module resolves through the helpers below so the
# "one schema, two modes" rule holds and an explicit env/config override always
# wins. The dev-rules architecture test (tests/test_environment_url_centralization.py)
# fails the build if a staging/production host string leaks into any other source file.
CLAWHUNT_BASE_URLS = {
    "staging": "https://staging.clawhunt.store",
    "production": "https://clawhunt.store",
}

# LLMgate model relay (OpenAI/Anthropic-compatible /v1). staging and production
# currently share one deployment; the per-environment map keeps them independently
# overridable so they can diverge later without touching call sites.
RELAY_BASE_URLS = {
    "staging": "https://gate.clawhunt.site/v1",
    "production": "https://gate.clawhunt.site/v1",
}

# Remote telemetry collection server (operator-side, opt-in upload target). Baked
# per environment so a staging build reports to the operator's collector without
# any runtime config; production has none baked yet. An explicit
# SUPERCLAW_TELEMETRY_ENDPOINT env var always wins. Empty ⇒ telemetry stays inert.
TELEMETRY_BASE_URLS = {
    "staging": "http://8.134.141.94:8900",
    "production": "",
}

# WRITE-ONLY ingest token baked per environment (upload only — it cannot read or
# delete; the operator query token is NEVER baked). Baking a write-only token is
# the standard phone-home pattern (cf. a Sentry DSN). Empty ⇒ no token sent.
TELEMETRY_INGEST_TOKENS = {
    "staging": "0d9d78c649b163e6172ec37777fc0dd02cf35c541c94a379",
    "production": "",
}

# Tier C envelope-encryption PUBLIC key (PEM), baked per environment. The client
# encrypts Tier C raw payloads under this key (telemetry_envelope.seal); only an
# operator holding the matching PRIVATE half — kept OFFLINE in escrow/HSM, NEVER on
# the collector server (zero-knowledge) nor baked here — can unseal. Empty until the
# operator provisions a keypair (telemetry_envelope.generate_keypair) and bakes the
# public half; empty ⇒ Tier C upload stays inert (no public key ⇒ nothing sealed).
TELEMETRY_TIER_C_PUBLIC_KEYS = {
    "staging": "",
    "production": "",
}

# Product capability-signing PUBLIC key, baked per environment (the "official" trust
# root that end-user SuperClaw verifies signed capabilities against). The PRIVATE
# half is held offline by the product / configured on the ClawHunt signer; only the
# public key is ever baked here.
#
# staging and production carry SEPARATE keys (environment isolation: a staging-key
# leak must never mint production "official" capabilities). The matching PRIVATE key
# is configured on that environment's ClawHunt signer (CLAWHUNT_OFFICIAL_SIGNING_KEY).
# Leaving an environment's value empty fails closed (no official capability trusted)
# rather than letting a wrong key serve as that environment's trust root.
OFFICIAL_ROOT_PUBLIC_KEYS = {
    "staging": "MmPYuR66nJZ+KvWeZD7Zs0nzcKY8iGSCrHj1+ZYXLK4=",
    "production": "za6+eU91Bswm6PGqAxjeSYQu6UG6NIiNG6grhtcfwcY=",
}

# Kind-scoped trust-root env vars that default to the baked official public key.
_OFFICIAL_ROOT_PUBLIC_KEY_ENV_NAMES = (
    "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY",
    "SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY",
    "SUPERCLAW_SKILL_ROOT_PUBLIC_KEY",
)

# Localhost fallbacks for LOCAL-from-source development. There is no longer a
# "development" APP_ENV; these are reached only via an explicit override or, for
# local-only daemons, when running from source (see _running_from_source below).
DEFAULT_CLAWHUNT_LOCAL_BASE_URL = "http://127.0.0.1:8787"
DEFAULT_RUNNINGHUB_LOCAL_BASE_URL = "http://127.0.0.1:8790"
DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com"

# Name of the build-baked profile shipped next to the frozen backend executable.
# prepare-macos-bundle.mjs writes it so an installed staging/production app knows
# which environment it is without the end user editing any config.
BUILD_PROFILE_NAME = "build-profile.json"

# Alias normalization. Every legacy / shorthand non-production spelling folds to
# ``staging`` (the single non-production tier); ``prod`` folds to ``production``. This
# applies wherever APP_ENV is actually consulted — an explicit ``APP_ENV`` env var or a
# pre-existing build profile baked as ``development`` resolves to staging instead of
# raising. (A stale APP_ENV persisted in ~/.superclaw/config.json is no longer consulted
# at all: it was removed from the runtime-config schema, so the compile-time baked
# identity / explicit env var is authoritative and a config-file value can't override it.)
_APP_ENV_ALIASES = {
    "development": "staging",
    "dev": "staging",
    "local": "staging",
    "test": "staging",
    "stage": "staging",
    "prod": "production",
}

# Cache the (immutable for a process) baked-profile lookup. ``None`` means "not
# yet resolved"; an empty string means "resolved, no baked profile present".
_baked_app_env_cache: str | None = None


def _baked_app_env() -> str:
    """Return the APP_ENV baked into the bundle at build time, or "" if none.

    The frozen backend ships a ``build-profile.json`` (written by
    prepare-macos-bundle.mjs) next to its executable. This is the LOWEST-priority
    environment signal: an explicit ``APP_ENV`` env var always wins over it. The
    lookup is best-effort and never raises — a missing/corrupt profile simply
    yields "" so resolution falls through to the staging default.
    """
    global _baked_app_env_cache
    if _baked_app_env_cache is not None:
        return _baked_app_env_cache
    _baked_app_env_cache = ""
    try:
        profile = Path(sys.executable).resolve().parent / BUILD_PROFILE_NAME
        if profile.is_file():
            data = json.loads(profile.read_text(encoding="utf-8"))
            value = data.get("app_env")
            if isinstance(value, str):
                _baked_app_env_cache = value.strip().lower()
    except (OSError, ValueError, TypeError):
        _baked_app_env_cache = ""
    return _baked_app_env_cache


def app_environment(raw: str | None = None) -> str:
    if raw is not None:
        value = raw.strip().lower()
    else:
        value = os.environ.get(APP_ENV_NAME, "").strip().lower()
        if not value:
            value = _baked_app_env()
    if not value:
        return DEFAULT_APP_ENV
    normalized = _APP_ENV_ALIASES.get(value, value)
    if normalized not in APP_ENV_CHOICES:
        raise ValueError(f"{APP_ENV_NAME} must be one of: {', '.join(APP_ENV_CHOICES)}")
    return normalized


def _baked_environment() -> str:
    """The baked build identity as a CANONICAL APP_ENV value ("" if none/invalid).

    ``_baked_app_env()`` returns the raw lowercased profile value, which may be an
    alias (e.g. ``prod``); the contamination guard must compare against the
    normalized form, otherwise a legitimate production build baked as ``prod`` would
    read as non-production and fail closed against its own production endpoint.
    """
    raw = _baked_app_env()
    if not raw:
        return ""
    normalized = _APP_ENV_ALIASES.get(raw, raw)
    return normalized if normalized in APP_ENV_CHOICES else ""


def _running_from_source() -> bool:
    """True when running from a source checkout / editable install rather than a
    frozen (PyInstaller) staging/production bundle.

    Uses ``sys.frozen`` — the bundle's own tamper-proof marker — NOT the presence of
    ``build-profile.json``. A distributed bundle whose profile is missing or corrupt is
    still a bundle and MUST stay fail-closed for local-only service defaults; keying off
    the profile file would let a damaged bundle masquerade as "source" and silently leak
    a localhost URL into shipped traffic (adversarial review). Local-only daemons (fusion
    previews) and the RunningHub dev mock fall back to localhost only in this mode; a
    bundle configures them explicitly or fails closed.
    """
    return not getattr(sys, "frozen", False)


def _clean_env_url(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value.rstrip("/") if value else None


def _stage_default_url(name: str, defaults: dict[str, str]) -> str:
    configured = _clean_env_url(name)
    if configured:
        return configured
    env = app_environment()
    default = defaults.get(env)
    if default:
        return default
    raise RuntimeError(f"{name} must be configured when {APP_ENV_NAME}={env}")


def _canonical_host(value: str) -> str:
    """Canonicalize a URL's host the way the HTTP client (httpx) does, so a homoglyph
    host that would *resolve* to the production host cannot slip past a naive string
    compare. urlparse alone returns the raw Unicode host (e.g. ``clawhunt。store`` with
    a U+3002 ideographic full stop, or fullwidth letters), but httpx applies IDNA/UTS-46
    and connects to ``clawhunt.store`` — that mismatch is the contamination bypass
    (adversarial review). Fold via the same IDNA path; fall back to an NFKC + dot-variant
    normalization for non-IDN hosts (IP / localhost) or if idna is unavailable.
    """
    raw = (urlparse(value).hostname or "").strip().rstrip(".")
    if not raw:
        return ""
    try:
        import idna

        return idna.encode(raw, uts46=True).decode("ascii").rstrip(".")
    except Exception:
        folded = unicodedata.normalize(
            "NFKC", raw.translate({0x3002: ".", 0xFF0E: ".", 0xFF61: "."})
        )
        return folded.lower().rstrip(".")


def _guard_no_production_contamination(url: str) -> None:
    """Fail closed if a non-production build/environment resolves ClawHunt to production.

    The dangerous case (adversarial review, both advisors): a staging acceptance bundle
    runs on a machine whose state silently redirects it to PRODUCTION, so a tester's
    dirty data / deletes / destructive E2E land in the prod database. The dev-rules
    constitution forbids staging touching production resources, so we refuse to start.

    Two independent hijack vectors are covered by one invariant — *a build that is not
    baked-as-production, and any environment that resolves to staging, must never reach
    the production endpoint*:

    1. ``build identity`` — a staging build (baked ``app_env``) whose effective
       environment was flipped to ``production`` by a stale persisted ``APP_ENV``
       override (config.json is injected into env, env > baked profile).
    2. ``url override`` — a staging environment whose ``CLAWHUNT_BASE_URL`` was pinned
       to the production URL by a stale override.

    ``staging`` is now the only non-production environment (and the default), so a
    from-source run that genuinely needs the production endpoint must declare
    ``APP_ENV=production`` — which makes the run production and the guard does not fire.
    """
    # Compare by HOST, not exact string: a stale override like
    # "https://clawhunt.store/" (trailing slash) or "https://clawhunt.store/api"
    # (extra path) would slip past an "==" check while still pointing the build at
    # the production host. Any URL whose host is the production host is contamination.
    production_host = _canonical_host(CLAWHUNT_BASE_URLS["production"])
    is_production_url = bool(production_host) and _canonical_host(url) == production_host
    if not is_production_url:
        return
    baked = _baked_environment()
    effective = app_environment()
    if baked and baked != "production":
        raise RuntimeError(
            f"cross-environment contamination: this build is baked as APP_ENV={baked} but "
            f"resolved {CLAWHUNT_BASE_URL_ENV} to the production endpoint ({url}). A "
            f"non-production build must never talk to production. Remove the stale APP_ENV / "
            f"{CLAWHUNT_BASE_URL_ENV} override (e.g. in ~/.superclaw/config.json) that is "
            f"redirecting it to production."
        )
    if effective == "staging":
        raise RuntimeError(
            f"cross-environment contamination: APP_ENV=staging resolved {CLAWHUNT_BASE_URL_ENV} "
            f"to the production endpoint ({url}). Staging must never talk to production. Remove "
            f"the stale {CLAWHUNT_BASE_URL_ENV} override (e.g. in ~/.superclaw/config.json) so the "
            f"staging default applies, or set the correct staging URL. To intentionally target "
            f"production, declare APP_ENV=production."
        )


def clawhunt_base_url() -> str:
    url = _stage_default_url(CLAWHUNT_BASE_URL_ENV, CLAWHUNT_BASE_URLS)
    _guard_no_production_contamination(url)
    return url


def relay_base_url() -> str:
    """Resolve the LLMgate model-relay base URL for the active environment.

    Precedence: explicit ``SUPERCLAW_RELAY_BASE_URL`` env/config override >
    build-baked per-environment default. Callers that send the relay key as a
    Bearer token MUST still pass the result through
    ``relay_key.validate_relay_base_url`` for the https / no-userinfo / no-query
    security checks — this helper only selects the URL, it does not vet it.
    """
    return _stage_default_url(RELAY_BASE_URL_ENV, RELAY_BASE_URLS)


def baked_telemetry_endpoint() -> str:
    """The telemetry endpoint baked into THIS BUILD, or "" if none. Resolved off
    the BAKED build identity (``_baked_environment`` — the compile-time
    build-profile), NOT the env-var-overridable ``app_environment`` which
    defaults to staging. Returns "" for a source checkout (sys.frozen absent) or
    a bundle whose profile is missing/corrupt — so dev/CI and a damaged
    production bundle never resolve a phone-home endpoint. The explicit
    SUPERCLAW_TELEMETRY_ENDPOINT override is applied by the spooler config, not
    here."""
    if _running_from_source():
        return ""
    return TELEMETRY_BASE_URLS.get(_baked_environment(), "").strip().rstrip("/")


def baked_telemetry_ingest_token() -> str:
    """The WRITE-ONLY ingest token baked into THIS BUILD (same frozen + baked-
    identity gating as :func:`baked_telemetry_endpoint`). "" if none."""
    if _running_from_source():
        return ""
    return TELEMETRY_INGEST_TOKENS.get(_baked_environment(), "").strip()


def telemetry_auto_enabled() -> bool:
    """Whether telemetry uploads default to ON for this build. ONLY a frozen
    STAGING bundle (build-profile baked as ``staging``) auto-enables — the
    operator's own acceptance fleet. Keyed off the BAKED identity so a
    missing/corrupt profile (which ``app_environment`` would default to staging)
    on a production bundle cannot be misread as staging and start phoning home;
    a source checkout returns "" from ``baked_telemetry_endpoint`` and is
    excluded too. Production bundles stay default-OFF (end users need consent).
    The kill switch and an explicit ``telemetry disable`` still override this."""
    return _baked_environment() == "staging" and bool(baked_telemetry_endpoint())


def baked_tier_c_public_key() -> str:
    """The Tier C envelope-encryption PUBLIC key baked into THIS build (PEM), or ""
    if none. Resolved off the BAKED build identity (same gating as
    :func:`baked_telemetry_endpoint`) so a source checkout / damaged bundle never
    resolves a key. "" ⇒ Tier C upload stays inert. The explicit
    ``SUPERCLAW_TELEMETRY_TIER_C_PUBLIC_KEY`` override is applied by the spooler
    config, not here. The PRIVATE half is NEVER baked — it lives only in offline
    operator escrow."""
    if _running_from_source():
        return ""
    key = TELEMETRY_TIER_C_PUBLIC_KEYS.get(_baked_environment(), "").strip()
    # Never resolve misbaked PRIVATE key material as 'the public key' (a client must
    # only ever hold a public key; the private half stays in operator escrow).
    if "PRIVATE KEY" in key.upper():
        return ""
    return key


def runninghub_base_url() -> str:
    """Resolve the RunningHub media API base URL.

    Precedence: explicit ``SUPERCLAW_RUNNINGHUB_BASE_URL`` override > the localhost dev
    mock (``http://127.0.0.1:8790``) when running from source > fail-closed. RunningHub
    is a third-party service, so a distributed bundle (staging / production) must point
    at a real endpoint explicitly — it never silently falls back to localhost (which
    would risk sending real generation traffic to a dead/wrong host). This mirrors the
    old development-only default, now keyed on "running from source" since the
    development environment is gone.
    """
    configured = _clean_env_url(RUNNINGHUB_BASE_URL_ENV)
    if configured:
        return configured
    if _running_from_source():
        return DEFAULT_RUNNINGHUB_LOCAL_BASE_URL.rstrip("/")
    raise RuntimeError(
        f"{RUNNINGHUB_BASE_URL_ENV} must be configured when {APP_ENV_NAME}={app_environment()}"
    )


def local_service_url(name: str, local_default: str) -> str | None:
    """Resolve a LOCAL-only daemon URL (fusion previews: OSIRIS / open-design /
    openpencil) — services that run on localhost and have no online deployment.

    Precedence: explicit ``name`` env/config override > localhost default when
    running from source > ``None``. The localhost fallback is gated on running from
    source (no baked build profile), not on a particular APP_ENV: a developer running
    the stack from source gets working previews without configuration, while a
    distributed staging/production bundle returns ``None`` (the preview is simply
    unavailable) unless an operator points it somewhere real.
    """
    configured = _clean_env_url(name)
    if configured:
        return configured
    if _running_from_source():
        return local_default.rstrip("/")
    return None


def anthropic_base_url() -> str:
    return _clean_env_url(ANTHROPIC_BASE_URL_ENV) or DEFAULT_ANTHROPIC_BASE_URL


SUPERCLAW_HOME_ENV = "SUPERCLAW_HOME"


def superclaw_home() -> Path:
    """Single source of truth for the SuperClaw **user-data root**.

    Defaults to ``~/.superclaw`` (an absolute HOME path, like ``~/.codex`` /
    ``~/.claude``) and is overridable via ``SUPERCLAW_HOME``. This is deliberately
    NOT cwd-relative: a cwd-relative ``.superclaw/`` lands the user's state /
    telemetry / artifacts inside whatever directory the CLI happens to run in — and
    when that directory is an iCloud-synced ``~/Documents`` checkout, the data (and
    the credentials' sensitive siblings) get synced off-machine. Credentials already
    resolve under ``~/.superclaw``; this aligns the operational data with them.
    """
    configured = os.environ.get(SUPERCLAW_HOME_ENV, "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".superclaw"


def superclaw_data_path(*parts: str) -> Path:
    """Resolve a user-data file under :func:`superclaw_home`, with a backward-compat
    fallback to a legacy cwd-relative ``./.superclaw/<...>``.

    New data defaults under HOME. But a user who already has data in the old
    cwd-relative location (``<cwd>/.superclaw/state.db``) must not be silently
    orphaned: when defaulting to ``~/.superclaw`` and the HOME path does not exist yet
    while a legacy cwd path does, the legacy path is honored (read-compatible). A
    one-time ``superclaw migrate-home`` can relocate it; until then existing runs/state
    remain reachable.

    The legacy cwd fallback is consulted ONLY when defaulting to ``~/.superclaw``. An
    explicit ``SUPERCLAW_HOME`` means the caller chose a data root deliberately, so it
    is honored verbatim and never silently diverted to a cwd-relative ``.superclaw/``.
    This also keeps tests that pin ``SUPERCLAW_HOME`` fully hermetic regardless of
    whatever ``.superclaw/`` happens to sit in the working directory.
    """
    home_path = superclaw_home().joinpath(*parts)
    if home_path.exists():
        return home_path
    if not os.environ.get(SUPERCLAW_HOME_ENV, "").strip():
        legacy = Path(".superclaw").joinpath(*parts)
        if legacy.exists():
            return legacy
    return home_path


SUPERCLAW_STATE_PATH_ENV = "SUPERCLAW_STATE_PATH"


def default_state_path() -> Path:
    """Canonical resolver for the SuperClaw ``state.db`` path.

    The state DB is a process-global singleton with MULTIPLE entrypoints (the CLI,
    the FastAPI ``create_app`` surface, the desktop sidecar fast-path). They MUST all
    land in one place — per the CLI/clients parity rule — so this is the single source
    of truth they share. Honors ``SUPERCLAW_STATE_PATH`` (explicit override), else
    :func:`superclaw_data_path` (``~/.superclaw/state.db`` with legacy cwd fallback).
    """
    configured = os.environ.get(SUPERCLAW_STATE_PATH_ENV, "").strip()
    return Path(configured) if configured else superclaw_data_path("state.db")


SUPERCLAW_ARTIFACT_DIR_ENV = "SUPERCLAW_ARTIFACT_DIR"


def default_artifact_dir() -> Path:
    """Canonical resolver for the SuperClaw run-artifacts root.

    Honors ``SUPERCLAW_ARTIFACT_DIR`` (explicit override), else
    :func:`superclaw_data_path` (``~/.superclaw/artifacts`` with legacy cwd fallback).
    Shared by every entrypoint (CLI, API, orchestrator, daemon, plugin/media/fusion
    surfaces) so run outputs never default into a cwd-relative ``.superclaw/`` — which
    for the iCloud-synced repo checkout would sync artifacts off-machine. Sub-roots use
    :func:`superclaw_data_path` directly, e.g. ``superclaw_data_path("artifacts", "plugins")``.
    """
    configured = os.environ.get(SUPERCLAW_ARTIFACT_DIR_ENV, "").strip()
    return Path(configured) if configured else superclaw_data_path("artifacts")


def legacy_clawhunt_auth_path() -> Path:
    return Path.home() / ".superclaw" / "clawhunt-auth.json"


def default_clawhunt_auth_path() -> Path:
    return Path.home() / ".superclaw" / f"clawhunt-auth.{app_environment()}.json"


def official_root_public_key() -> str:
    """The product capability-signing PUBLIC key baked for the active environment.

    Empty string when none is baked (e.g. production before the owner bakes its key),
    which keeps the trust roots unset and fail-closed.
    """
    return OFFICIAL_ROOT_PUBLIC_KEYS.get(app_environment(), "").strip()


def hydrate_official_root_public_keys() -> list[str]:
    """Default the kind-scoped trust roots to the baked official public key.

    Sets each ``SUPERCLAW_*_ROOT_PUBLIC_KEY`` from the per-environment baked official
    key when it is not already set — an explicit env override ALWAYS wins. Returns
    the env-var names actually applied.

    Only applies in a frozen build (``sys.frozen``): the baked key is the identity of
    a SHIPPED bundle, so source/dev/test runs are never silently given a trust root
    (they stay fail-closed unless the operator sets one explicitly). A no-op when the
    baked key is empty (e.g. production pre-bake — fail closed).
    """
    if _running_from_source():
        return []
    key = official_root_public_key()
    if not key:
        return []
    applied: list[str] = []
    for name in _OFFICIAL_ROOT_PUBLIC_KEY_ENV_NAMES:
        # Respect an EXPLICITLY-SET var even when it is empty: an operator who
        # exports SUPERCLAW_*_ROOT_PUBLIC_KEY="" is deliberately disabling that
        # trust root (fail-closed), and must NOT be silently re-armed with the
        # baked key. Key on presence, not truthiness.
        if name in os.environ:
            continue
        os.environ[name] = key
        applied.append(name)
    return applied
