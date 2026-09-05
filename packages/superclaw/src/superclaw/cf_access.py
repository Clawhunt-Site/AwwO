"""Cloudflare Access service-token plumbing for the private (non-production) ClawHunt host.

The online TEST server (the staging ClawHunt host, ``CLAWHUNT_BASE_URLS["staging"]``)
sits behind a Cloudflare Access gate: any ``/api/*`` request that does not carry a
valid CF Access identity is bounced
with a ``302`` to the Cloudflare login page. The desktop app's *interactive* Google
login works because it happens in the operator's real browser (which passes the gate),
but the backend's own server-to-server calls — fetching the account profile, listing
agents, minting an agent key — carry no CF identity, so they silently fail. The result
is a half-linked account: a saved ``access_token`` but an empty ``account_user`` and no
agent / relay key (so no name, no avatar, "agent key 尚未就绪", and "余额：未知").

A CF Access *service token* (the ``CF-Access-Client-Id`` / ``CF-Access-Client-Secret``
header pair) lets a non-interactive client through the gate. This module is the single
definition point for two things:

* :func:`cf_access_headers` — build that header pair for a request, but ONLY when the
  target is exactly the gated staging origin (https, default port, no userinfo, the
  staging host) AND the environment is non-production. The service token is a credential
  scoped to the one Cloudflare Access application fronting the private TEST server; it
  must never be sent over cleartext, to another port, to a third-party host, or to the
  public production origin (which has no CF gate at all).
* :func:`hydrate_cf_access_environment` — load the token from a well-known file into
  the process environment for non-production runs. A Finder-launched desktop app never
  sources a shell rc file, so a token written only to ``~/.superclaw/...env`` would
  otherwise be invisible to the backend.

Both are fail-closed: if the environment cannot be determined, or the target is not the
gated staging origin, no token is attached and nothing is loaded.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

from superclaw.environment import (
    CLAWHUNT_BASE_URLS,
    _canonical_host,
    app_environment,
)

CF_ACCESS_CLIENT_ID_ENV = "CF_ACCESS_CLIENT_ID"
CF_ACCESS_CLIENT_SECRET_ENV = "CF_ACCESS_CLIENT_SECRET"
# Optional override for the well-known staging credentials file. Defaults to the path
# the operator's refresh script already writes (see ~/.superclaw).
CF_ACCESS_ENV_FILE_ENV = "SUPERCLAW_CF_ACCESS_ENV_FILE"
DEFAULT_CF_ACCESS_ENV_FILE = Path("~/.superclaw/clawhunt-staging-cloudflare-access.env")

# Best-effort guard so a process that lacks the credentials file performs at most one
# file read per process instead of an OSError on every client construction / probe.
_hydration_attempted = False


def _clean(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _is_gated_staging_origin(url: str) -> bool:
    """True when ``url``'s ORIGIN is exactly the gated staging ClawHunt origin.

    This is an *origin allowlist* (not merely a host check): the CF Access service
    token is attached ONLY to ``https://<staging-host>`` on the default port and with
    no embedded userinfo. Host alone is insufficient — a stale ``CLAWHUNT_BASE_URL``
    override of ``http://<staging-host>`` would leak the token in cleartext, and a
    ``:<alt-port>`` override would send it to some other listener on the box
    (adversarial review). Concretely, all of the following must hold:

    * scheme is exactly ``https`` (never cleartext ``http``);
    * no userinfo (``user:pass@``) is present;
    * port is the default (``None``) or ``443``;
    * the canonical (IDNA/UTS-46) host equals the staging host, so a homoglyph host
      that *resolves* to staging matches while a look-alike that resolves elsewhere
      (e.g. a ``<staging-host>.evil.example`` suffix) does not.

    The token is scoped to the one Cloudflare Access application that fronts this
    origin; it is never sent to a third-party host, a localhost dev server, or the
    production host (which differs by construction).
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    if parsed.username or parsed.password:
        return False
    try:
        port = parsed.port
    except ValueError:
        return False
    if port not in (None, 443):
        return False
    staging_host = _canonical_host(CLAWHUNT_BASE_URLS["staging"])
    return bool(staging_host) and _canonical_host(url) == staging_host


def _active_environment_is_production() -> bool:
    """Fail-closed environment probe: any resolution failure counts as production
    so a credential is never attached / loaded when we are unsure of the tier."""
    try:
        return app_environment() == "production"
    except ValueError:
        return True


def cf_access_headers(base_url: str) -> dict[str, str]:
    """CF Access service-token headers for ``base_url``, or ``{}`` when not applicable.

    The header pair is returned ONLY when all of the following hold:

    * both ``CF_ACCESS_CLIENT_ID`` and ``CF_ACCESS_CLIENT_SECRET`` are set, AND
    * the active environment is not ``production``, AND
    * ``base_url`` is exactly the gated staging ClawHunt origin (see
      :func:`_is_gated_staging_origin` — https, default port, no userinfo, staging host).

    The origin allowlist (rather than a "not production" denylist) is the load-bearing
    guard: the service token is a credential scoped to the one Cloudflare Access
    application, so it is never sent over cleartext ``http``, to an alternate port, to an
    arbitrary ``CLAWHUNT_BASE_URL`` override, a third-party host, a localhost dev server,
    or the production host. The environment check is an independent second guard so a
    production build never emits the token at all.
    """
    client_id = _clean(os.environ.get(CF_ACCESS_CLIENT_ID_ENV))
    secret = _clean(os.environ.get(CF_ACCESS_CLIENT_SECRET_ENV))
    if not client_id or not secret:
        return {}
    if _active_environment_is_production():
        return {}
    if not _is_gated_staging_origin(base_url):
        return {}
    return {
        "CF-Access-Client-Id": client_id,
        "CF-Access-Client-Secret": secret,
    }


def _parse_env_file(text: str) -> dict[str, str]:
    """Minimal ``KEY=VALUE`` parser for the CF credentials file.

    Skips blank lines and ``#`` comments, tolerates a leading ``export``, splits on the
    first ``=``, and strips one layer of matching single/double quotes around the value
    (the refresh script writes single-quoted secrets).
    """
    result: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            result[key] = value
    return result


def hydrate_cf_access_environment(target_url: str | None = None) -> bool:
    """Load the CF Access service token into ``os.environ`` for non-production runs.

    Returns ``True`` iff at least one variable was newly set. Never runs in production,
    never overwrites a variable already present in the environment, and never raises —
    a missing/unreadable file simply yields ``False``. The source file path may be
    overridden with ``SUPERCLAW_CF_ACCESS_ENV_FILE``; otherwise the well-known
    ``~/.superclaw/clawhunt-staging-cloudflare-access.env`` is read.

    When ``target_url`` is given (the base URL of the client about to make a request),
    the token is loaded ONLY if that URL is the gated staging origin — so a client
    bound for localhost or a third-party host never pulls the secret into the process
    environment at all (avoids needless env pollution and file IO). A ``None`` target
    (the generic auth-env choke point) loads whenever the environment is non-production.

    The first actual file-read attempt per process flips a module flag so a machine
    without the credentials file does not re-stat / re-raise on every client
    construction or probe.
    """
    global _hydration_attempted
    if _active_environment_is_production():
        return False
    if target_url is not None and not _is_gated_staging_origin(target_url):
        return False
    have_id = bool(_clean(os.environ.get(CF_ACCESS_CLIENT_ID_ENV)))
    have_secret = bool(_clean(os.environ.get(CF_ACCESS_CLIENT_SECRET_ENV)))
    if have_id and have_secret:
        return False
    if _hydration_attempted:
        return False
    _hydration_attempted = True
    raw_path = _clean(os.environ.get(CF_ACCESS_ENV_FILE_ENV)) or str(DEFAULT_CF_ACCESS_ENV_FILE)
    try:
        text = Path(raw_path).expanduser().read_text(encoding="utf-8")
    except OSError:
        return False
    parsed = _parse_env_file(text)
    applied = False
    for name in (CF_ACCESS_CLIENT_ID_ENV, CF_ACCESS_CLIENT_SECRET_ENV):
        if _clean(os.environ.get(name)):
            continue
        value = _clean(parsed.get(name))
        if value:
            os.environ[name] = value
            applied = True
    return applied
