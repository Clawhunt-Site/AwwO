"""Tests for CF Access service-token plumbing (cf_access.py) and its wiring into the
ClawHunt account/capability clients.

The invariant under test: the CF Access service token is attached to private
(non-production) ClawHunt requests so they pass the Cloudflare gate, and is NEVER
attached to a production host or a production environment.
"""

from __future__ import annotations

import httpx
import pytest

from superclaw import cf_access
from superclaw.cf_access import (
    CF_ACCESS_CLIENT_ID_ENV,
    CF_ACCESS_CLIENT_SECRET_ENV,
    CF_ACCESS_ENV_FILE_ENV,
    _parse_env_file,
    cf_access_headers,
    hydrate_cf_access_environment,
)
from superclaw.clawhunt import ClawHuntClient, ClawHuntSettings
from superclaw.clawhunt_auth import ClawHuntAccountClient, ClawHuntAccountSettings

STAGING_BASE = "https://staging.clawhunt.store"
PRODUCTION_BASE = "https://clawhunt.store"
ID_HEADER = "CF-Access-Client-Id"
SECRET_HEADER = "CF-Access-Client-Secret"


@pytest.fixture(autouse=True)
def _clean_cf_env(monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory) -> None:
    """Start every test from a known env: no CF creds, staging tier, and an env-file
    path that points at a guaranteed-missing file so the implicit hydrate in client
    __init__ can never pick up the operator's real ~/.superclaw credentials file."""
    monkeypatch.delenv(CF_ACCESS_CLIENT_ID_ENV, raising=False)
    monkeypatch.delenv(CF_ACCESS_CLIENT_SECRET_ENV, raising=False)
    missing = tmp_path_factory.mktemp("cf-iso") / "absent.env"
    monkeypatch.setenv(CF_ACCESS_ENV_FILE_ENV, str(missing))
    monkeypatch.setenv("APP_ENV", "staging")
    # Reset the once-per-process file-read latch so each test starts fresh.
    monkeypatch.setattr(cf_access, "_hydration_attempted", False)


def _set_creds(monkeypatch: pytest.MonkeyPatch, client_id: str = "cid-123", secret: str = "secret-xyz") -> None:
    monkeypatch.setenv(CF_ACCESS_CLIENT_ID_ENV, client_id)
    monkeypatch.setenv(CF_ACCESS_CLIENT_SECRET_ENV, secret)


# --------------------------------------------------------------------------- headers


def test_headers_empty_without_credentials() -> None:
    assert cf_access_headers(STAGING_BASE) == {}


def test_headers_empty_with_only_client_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(CF_ACCESS_CLIENT_ID_ENV, "cid-123")
    assert cf_access_headers(STAGING_BASE) == {}


def test_headers_present_for_staging_host(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    assert cf_access_headers(STAGING_BASE) == {
        ID_HEADER: "cid-123",
        SECRET_HEADER: "secret-xyz",
    }


def test_headers_strip_whitespace(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch, client_id="  cid-123  ", secret="  secret-xyz  ")
    assert cf_access_headers(STAGING_BASE) == {
        ID_HEADER: "cid-123",
        SECRET_HEADER: "secret-xyz",
    }


def test_headers_blocked_in_production_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    monkeypatch.setenv("APP_ENV", "production")
    # Even toward the staging host, a production *environment* never sends the token.
    assert cf_access_headers(STAGING_BASE) == {}


def test_headers_blocked_for_production_host(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    # staging env, but the target host is production -> never leak the token there.
    assert cf_access_headers(PRODUCTION_BASE) == {}
    assert cf_access_headers("https://clawhunt.store/api/foo") == {}


def test_headers_blocked_for_arbitrary_third_party_host(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    # Allowlist: the service token is never sent to an arbitrary CLAWHUNT_BASE_URL
    # override / third-party host, even in a non-production environment.
    assert cf_access_headers("https://evil.example/api") == {}
    assert cf_access_headers("https://staging.clawhunt.store.evil.example/api") == {}
    assert cf_access_headers("http://127.0.0.1:8787") == {}


def test_headers_blocked_for_cleartext_http(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    # Even the right host over cleartext http must never carry the token.
    assert cf_access_headers("http://staging.clawhunt.store/api") == {}


def test_headers_blocked_for_nondefault_port(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    # Right host+scheme but an alternate port -> some other listener on the box.
    assert cf_access_headers("https://staging.clawhunt.store:8443/api") == {}


def test_headers_allowed_for_explicit_default_port(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    assert cf_access_headers("https://staging.clawhunt.store:443/api") == {
        ID_HEADER: "cid-123",
        SECRET_HEADER: "secret-xyz",
    }


def test_headers_blocked_for_embedded_userinfo(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    assert cf_access_headers("https://user:pass@staging.clawhunt.store/api") == {}


def test_headers_blocked_for_homoglyph_production_host(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    # U+3002 ideographic full stop canonicalizes to the production host via IDNA.
    assert cf_access_headers("https://clawhunt。store") == {}


def test_headers_fail_closed_on_invalid_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    monkeypatch.setenv("APP_ENV", "not-a-real-tier")
    # app_environment() raises -> treated as production -> no token attached.
    assert cf_access_headers(STAGING_BASE) == {}


# ------------------------------------------------------------------------- env file


def test_parse_env_file_handles_quotes_comments_and_export() -> None:
    text = (
        "# a comment\n"
        "\n"
        "CF_ACCESS_CLIENT_ID='single-quoted'\n"
        'CF_ACCESS_CLIENT_SECRET="double-quoted"\n'
        "export OTHER=plain\n"
        "MALFORMED_NO_EQUALS\n"
    )
    parsed = _parse_env_file(text)
    assert parsed["CF_ACCESS_CLIENT_ID"] == "single-quoted"
    assert parsed["CF_ACCESS_CLIENT_SECRET"] == "double-quoted"
    assert parsed["OTHER"] == "plain"
    assert "MALFORMED_NO_EQUALS" not in parsed


def test_hydrate_loads_credentials_from_file(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    env_file = tmp_path / "cf.env"
    env_file.write_text(
        "CF_ACCESS_CLIENT_ID='from-file-id'\nCF_ACCESS_CLIENT_SECRET='from-file-secret'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(CF_ACCESS_ENV_FILE_ENV, str(env_file))

    assert hydrate_cf_access_environment() is True
    import os

    assert os.environ[CF_ACCESS_CLIENT_ID_ENV] == "from-file-id"
    assert os.environ[CF_ACCESS_CLIENT_SECRET_ENV] == "from-file-secret"
    # Idempotent: a second call sees the vars already set and does nothing.
    assert hydrate_cf_access_environment() is False


def test_hydrate_does_not_overwrite_existing_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    env_file = tmp_path / "cf.env"
    env_file.write_text(
        "CF_ACCESS_CLIENT_ID='from-file-id'\nCF_ACCESS_CLIENT_SECRET='from-file-secret'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(CF_ACCESS_ENV_FILE_ENV, str(env_file))
    monkeypatch.setenv(CF_ACCESS_CLIENT_ID_ENV, "explicit-id")

    # Only the missing secret is filled; the explicit id is preserved.
    assert hydrate_cf_access_environment() is True
    import os

    assert os.environ[CF_ACCESS_CLIENT_ID_ENV] == "explicit-id"
    assert os.environ[CF_ACCESS_CLIENT_SECRET_ENV] == "from-file-secret"


def test_hydrate_skipped_in_production(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    env_file = tmp_path / "cf.env"
    env_file.write_text(
        "CF_ACCESS_CLIENT_ID='from-file-id'\nCF_ACCESS_CLIENT_SECRET='from-file-secret'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(CF_ACCESS_ENV_FILE_ENV, str(env_file))
    monkeypatch.setenv("APP_ENV", "production")

    assert hydrate_cf_access_environment() is False
    import os

    assert CF_ACCESS_CLIENT_ID_ENV not in os.environ


def test_hydrate_missing_file_returns_false(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv(CF_ACCESS_ENV_FILE_ENV, str(tmp_path / "does-not-exist.env"))
    assert hydrate_cf_access_environment() is False


def test_hydrate_skipped_for_non_staging_target(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    env_file = tmp_path / "cf.env"
    env_file.write_text(
        "CF_ACCESS_CLIENT_ID='from-file-id'\nCF_ACCESS_CLIENT_SECRET='from-file-secret'\n",
        encoding="utf-8",
    )
    monkeypatch.setenv(CF_ACCESS_ENV_FILE_ENV, str(env_file))
    import os

    # A client bound for localhost / a third-party host never pulls the secret in.
    assert hydrate_cf_access_environment("http://127.0.0.1:8787") is False
    assert hydrate_cf_access_environment("https://evil.example") is False
    assert CF_ACCESS_CLIENT_ID_ENV not in os.environ
    # The gated staging origin does load it.
    assert hydrate_cf_access_environment(STAGING_BASE) is True
    assert os.environ[CF_ACCESS_CLIENT_ID_ENV] == "from-file-id"


def test_hydrate_attempts_file_once_per_process(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """A machine without the credentials file reads at most once, not on every call."""
    reads = {"count": 0}
    real_read_text = type(tmp_path).read_text

    def counting_read_text(self, *args, **kwargs):
        reads["count"] += 1
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setenv(CF_ACCESS_ENV_FILE_ENV, str(tmp_path / "absent.env"))
    monkeypatch.setattr(type(tmp_path), "read_text", counting_read_text)

    assert hydrate_cf_access_environment() is False
    assert hydrate_cf_access_environment() is False
    assert hydrate_cf_access_environment(STAGING_BASE) is False
    assert reads["count"] == 1


# ----------------------------------------------------------------------- client wiring


def _capture_handler(sink: list[httpx.Request]):
    def handler(request: httpx.Request) -> httpx.Response:
        sink.append(request)
        return httpx.Response(200, json={"ok": True, "user": {"username": "bobo"}})

    return handler


def test_account_client_sends_cf_headers_on_staging(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    requests: list[httpx.Request] = []
    client = ClawHuntAccountClient(
        ClawHuntAccountSettings(base_url=STAGING_BASE),
        transport=httpx.MockTransport(_capture_handler(requests)),
    )

    client.profile("token-abc")
    client.agents("token-abc")
    client.create_agent_key("token-abc", name="k", agent_id=1, permissions=["run"])

    assert requests, "expected captured requests"
    for request in requests:
        assert request.headers[ID_HEADER] == "cid-123"
        assert request.headers[SECRET_HEADER] == "secret-xyz"


def test_account_client_omits_cf_headers_without_creds(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[httpx.Request] = []
    client = ClawHuntAccountClient(
        ClawHuntAccountSettings(base_url=STAGING_BASE),
        transport=httpx.MockTransport(_capture_handler(requests)),
    )
    client.profile("token-abc")
    assert ID_HEADER not in requests[0].headers


def test_capability_client_sends_cf_headers_on_staging(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    requests: list[httpx.Request] = []
    client = ClawHuntClient(
        ClawHuntSettings(base_url=STAGING_BASE, agent_api_key="agent-key"),
        transport=httpx.MockTransport(_capture_handler(requests)),
    )
    client.me()
    assert requests[0].headers[ID_HEADER] == "cid-123"
    assert requests[0].headers["Authorization"] == "Bearer agent-key"


def test_live_probe_sends_cf_headers_on_staging(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True})

    client = ClawHuntClient(
        ClawHuntSettings(base_url=STAGING_BASE),
        transport=httpx.MockTransport(handler),
    )
    client.live_read_only_probe()

    assert requests, "expected probe requests"
    # Every gated /api/* probe request carries the CF header pair.
    for request in requests:
        assert request.headers[ID_HEADER] == "cid-123"
        assert request.headers[SECRET_HEADER] == "secret-xyz"


def test_clients_never_send_cf_headers_to_production_host(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_creds(monkeypatch)
    requests: list[httpx.Request] = []
    client = ClawHuntClient(
        ClawHuntSettings(base_url=PRODUCTION_BASE, agent_api_key="agent-key"),
        transport=httpx.MockTransport(_capture_handler(requests)),
    )
    client.me()
    assert ID_HEADER not in requests[0].headers
    assert SECRET_HEADER not in requests[0].headers
