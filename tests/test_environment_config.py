from __future__ import annotations

import pytest

import superclaw.environment as environment
from superclaw.environment import (
    CLAWHUNT_BASE_URLS,
    RELAY_BASE_URLS,
    app_environment,
    clawhunt_base_url,
    default_clawhunt_auth_path,
    local_service_url,
    relay_base_url,
    runninghub_base_url,
)


def _no_baked_profile(monkeypatch):
    """Force "no baked build profile" so app_environment falls back to the default."""
    monkeypatch.setattr(environment, "_baked_app_env_cache", "")


def _as_frozen_bundle(monkeypatch):
    """Simulate a frozen (PyInstaller) distributed bundle: _running_from_source is False
    regardless of build-profile.json state (which is exactly the corrupt-bundle case)."""
    monkeypatch.setattr(environment.sys, "frozen", True, raising=False)


def test_app_environment_defaults_to_staging(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    _no_baked_profile(monkeypatch)
    assert app_environment() == "staging"
    assert clawhunt_base_url() == CLAWHUNT_BASE_URLS["staging"]


def test_only_two_environments_exist():
    """The whole framework has exactly two environments — there is no localhost
    'development' tier (a dev points 127.0.0.1 via an explicit override instead)."""
    assert environment.APP_ENV_CHOICES == ("staging", "production")
    assert environment.DEFAULT_APP_ENV == "staging"
    assert set(CLAWHUNT_BASE_URLS) == {"staging", "production"}
    assert set(RELAY_BASE_URLS) == {"staging", "production"}


def test_legacy_non_production_spellings_fold_to_staging():
    """An old persisted APP_ENV (development/dev/local/test/stage) or a pre-existing
    build profile baked as 'development' migrates to staging instead of crashing."""
    for raw in ("development", "dev", "local", "test", "stage", "STAGING", "  staging "):
        assert app_environment(raw) == "staging"
    assert app_environment("prod") == "production"
    assert app_environment("production") == "production"


@pytest.mark.parametrize("env", ["staging", "production"])
def test_clawhunt_and_relay_resolve_baked_per_environment(monkeypatch, env):
    """ClawHunt + relay carry a built-in URL for every environment (no manual config)."""
    monkeypatch.setenv("APP_ENV", env)
    monkeypatch.delenv("CLAWHUNT_BASE_URL", raising=False)
    monkeypatch.delenv("SUPERCLAW_RELAY_BASE_URL", raising=False)

    assert clawhunt_base_url() == CLAWHUNT_BASE_URLS[env]
    assert relay_base_url() == RELAY_BASE_URLS[env]


def test_baked_urls_are_https_for_online_environments():
    """staging/production endpoints must never ship as plaintext http."""
    for env in ("staging", "production"):
        assert CLAWHUNT_BASE_URLS[env].startswith("https://")
        assert RELAY_BASE_URLS[env].startswith("https://")


def test_explicit_env_override_wins_over_baked_default(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("CLAWHUNT_BASE_URL", "https://clawhunt.example/")
    monkeypatch.setenv("SUPERCLAW_RELAY_BASE_URL", "https://relay.example/v1/")
    assert clawhunt_base_url() == "https://clawhunt.example"
    assert relay_base_url() == "https://relay.example/v1"


def test_staging_pinned_to_production_url_fails_closed(monkeypatch):
    """A stale prod CLAWHUNT_BASE_URL override on a staging build must not silently
    connect staging to production — fail closed (dev-rules: staging never touches prod)."""
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("CLAWHUNT_BASE_URL", CLAWHUNT_BASE_URLS["production"])
    with pytest.raises(RuntimeError, match="cross-environment contamination"):
        clawhunt_base_url()


@pytest.mark.parametrize(
    "override",
    [
        "https://clawhunt.store/",          # trailing slash
        "https://clawhunt.store/api",       # extra path
        "http://clawhunt.store",            # downgraded scheme, same host
        "https://clawhunt.store:443",       # explicit default port
        "https://CLAWHUNT.STORE",           # uppercase host
        "https://clawhunt.store.",          # trailing FQDN dot
        "https://clawhunt。store",      # U+3002 ideographic full stop
        "https://clawhunt．store",      # U+FF0E fullwidth full stop
        "https://clawhunt｡store",      # U+FF61 halfwidth ideographic full stop
        "https://ｃlawhunt.store",      # fullwidth leading letter (ｃlawhunt)
    ],
)
def test_staging_contamination_guard_compares_host_not_exact_string(monkeypatch, override):
    """Any URL whose host is the production host is contamination — a stale override
    with a trailing slash / extra path / scheme change must not slip past the guard."""
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("CLAWHUNT_BASE_URL", override)
    with pytest.raises(RuntimeError, match="cross-environment contamination"):
        clawhunt_base_url()


def test_staging_default_is_not_treated_as_contamination(monkeypatch):
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.delenv("CLAWHUNT_BASE_URL", raising=False)
    assert clawhunt_base_url() == CLAWHUNT_BASE_URLS["staging"]


def test_staging_baked_build_flipped_to_production_fails_closed(monkeypatch, tmp_path):
    """A staging-baked build whose APP_ENV is overridden to production (stale persisted
    config) must fail closed — the build identity must not be silently hijacked to prod."""
    exe = tmp_path / "superclaw-backend"
    exe.write_text("", encoding="utf-8")
    (tmp_path / environment.BUILD_PROFILE_NAME).write_text('{"app_env": "staging"}', encoding="utf-8")
    monkeypatch.setattr(environment.sys, "executable", str(exe))
    monkeypatch.setattr(environment, "_baked_app_env_cache", None)
    # Stale override flips the effective environment to production.
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("CLAWHUNT_BASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="baked as APP_ENV=staging"):
        clawhunt_base_url()


def test_production_build_baked_with_alias_is_not_self_blocked(monkeypatch, tmp_path):
    """A legitimate production build baked as the alias 'prod' must resolve to production
    without the contamination guard mistaking it for a non-production build."""
    exe = tmp_path / "superclaw-backend"
    exe.write_text("", encoding="utf-8")
    (tmp_path / environment.BUILD_PROFILE_NAME).write_text('{"app_env": "prod"}', encoding="utf-8")
    monkeypatch.setattr(environment.sys, "executable", str(exe))
    monkeypatch.setattr(environment, "_baked_app_env_cache", None)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("CLAWHUNT_BASE_URL", raising=False)
    assert environment._baked_environment() == "production"
    assert clawhunt_base_url() == CLAWHUNT_BASE_URLS["production"]


def test_production_resolves_production_without_guard(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("CLAWHUNT_BASE_URL", raising=False)
    assert clawhunt_base_url() == CLAWHUNT_BASE_URLS["production"]


def test_from_source_may_target_production_when_declared(monkeypatch):
    """A developer running from source can still hit production by declaring it
    explicitly (APP_ENV=production) — which makes the run production, so no guard fires.
    This replaces the old 'development sandbox may point at prod' carve-out: declaring
    production is now the deliberate, explicit way to do it."""
    _no_baked_profile(monkeypatch)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("CLAWHUNT_BASE_URL", CLAWHUNT_BASE_URLS["production"])
    assert clawhunt_base_url() == CLAWHUNT_BASE_URLS["production"]


def test_runninghub_uses_local_mock_from_source_but_fails_closed_in_a_bundle(monkeypatch):
    """RunningHub defaults to the localhost dev mock only when running from source; a
    frozen distributed bundle fails closed rather than silently pointing real generation
    traffic at localhost. An explicit override always wins."""
    monkeypatch.delenv("SUPERCLAW_RUNNINGHUB_BASE_URL", raising=False)

    # From source (not a frozen bundle) -> localhost dev mock.
    assert runninghub_base_url() == "http://127.0.0.1:8790"

    # Frozen distributed bundle -> fail closed (no localhost leak).
    _as_frozen_bundle(monkeypatch)
    with pytest.raises(RuntimeError, match="SUPERCLAW_RUNNINGHUB_BASE_URL must be configured"):
        runninghub_base_url()

    # Explicit override always wins, source or bundle.
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_BASE_URL", "https://runninghub.example/")
    assert runninghub_base_url() == "https://runninghub.example"


def test_baked_profile_supplies_app_env_when_env_unset(monkeypatch, tmp_path):
    """A build-baked profile sets APP_ENV; an explicit env var still wins over it."""
    exe = tmp_path / "superclaw-backend"
    exe.write_text("", encoding="utf-8")
    (tmp_path / environment.BUILD_PROFILE_NAME).write_text(
        '{"app_env": "staging"}', encoding="utf-8"
    )
    monkeypatch.setattr(environment.sys, "executable", str(exe))
    monkeypatch.setattr(environment, "_baked_app_env_cache", None)

    monkeypatch.delenv("APP_ENV", raising=False)
    assert app_environment() == "staging"

    # Explicit env var overrides the baked profile.
    monkeypatch.setenv("APP_ENV", "production")
    assert app_environment() == "production"


def test_baked_profile_lookup_never_raises(monkeypatch, tmp_path):
    """A missing/corrupt profile degrades to the staging default, never crashes."""
    exe = tmp_path / "superclaw-backend"
    exe.write_text("", encoding="utf-8")
    (tmp_path / environment.BUILD_PROFILE_NAME).write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(environment.sys, "executable", str(exe))
    monkeypatch.setattr(environment, "_baked_app_env_cache", None)
    monkeypatch.delenv("APP_ENV", raising=False)
    assert app_environment() == "staging"


def test_online_environment_uses_explicit_urls_and_env_scoped_auth_path(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("CLAWHUNT_BASE_URL", "https://clawhunt.example/")
    monkeypatch.setenv("SUPERCLAW_RUNNINGHUB_BASE_URL", "https://runninghub.example/")

    assert clawhunt_base_url() == "https://clawhunt.example"
    assert runninghub_base_url() == "https://runninghub.example"
    assert default_clawhunt_auth_path().name == "clawhunt-auth.production.json"


def test_staging_auth_path_preserves_legacy_file(monkeypatch, tmp_path):
    from superclaw.clawhunt_auth import clawhunt_auth_path

    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setenv("HOME", str(tmp_path))
    legacy_path = tmp_path / ".superclaw" / "clawhunt-auth.json"
    legacy_path.parent.mkdir(parents=True)
    legacy_path.write_text("{}", encoding="utf-8")

    assert clawhunt_auth_path() == legacy_path


def test_production_auth_path_ignores_legacy_file(monkeypatch, tmp_path):
    """A stale dev-era clawhunt-auth.json must never be honored by a production build —
    a leaked non-production token cannot become a production credential."""
    from superclaw.clawhunt_auth import clawhunt_auth_path

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("HOME", str(tmp_path))
    legacy_path = tmp_path / ".superclaw" / "clawhunt-auth.json"
    legacy_path.parent.mkdir(parents=True)
    legacy_path.write_text("{}", encoding="utf-8")

    resolved = clawhunt_auth_path()
    assert resolved != legacy_path
    assert resolved.name == "clawhunt-auth.production.json"


def test_local_service_url_defaults_to_localhost_only_when_running_from_source(monkeypatch):
    """Fusion previews (OSIRIS / open-design / openpencil) are local-only daemons with no
    online deployment. Their localhost default applies only when running from source; a
    frozen distributed bundle returns None so no localhost URL leaks into a shipped app.
    An explicit override always wins regardless of source/bundle."""
    monkeypatch.delenv("SUPERCLAW_FUSION_OSIRIS_URL", raising=False)

    # Running from source (not a frozen bundle) -> localhost preview default.
    assert local_service_url("SUPERCLAW_FUSION_OSIRIS_URL", "http://127.0.0.1:3000") == "http://127.0.0.1:3000"

    # Frozen distributed bundle -> no localhost leak.
    _as_frozen_bundle(monkeypatch)
    assert local_service_url("SUPERCLAW_FUSION_OSIRIS_URL", "http://127.0.0.1:3000") is None

    # Explicit override always wins.
    monkeypatch.setenv("SUPERCLAW_FUSION_OSIRIS_URL", "https://osiris.example/")
    assert local_service_url("SUPERCLAW_FUSION_OSIRIS_URL", "http://127.0.0.1:3000") == "https://osiris.example"


def test_frozen_bundle_with_corrupt_profile_does_not_leak_localhost(monkeypatch, tmp_path):
    """A frozen distributed bundle whose build-profile.json is missing/corrupt is STILL a
    bundle (sys.frozen) and must stay fail-closed for local-only service defaults — it must
    never masquerade as 'source' and leak a localhost URL into shipped traffic. Regression
    for the adversarial-review finding that keyed source-detection off the profile file."""
    exe = tmp_path / "superclaw-backend"
    exe.write_text("", encoding="utf-8")
    (tmp_path / environment.BUILD_PROFILE_NAME).write_text("{corrupt json", encoding="utf-8")
    monkeypatch.setattr(environment.sys, "executable", str(exe))
    monkeypatch.setattr(environment, "_baked_app_env_cache", None)
    _as_frozen_bundle(monkeypatch)
    monkeypatch.delenv("SUPERCLAW_RUNNINGHUB_BASE_URL", raising=False)
    monkeypatch.delenv("SUPERCLAW_FUSION_OSIRIS_URL", raising=False)

    assert environment._baked_environment() == ""        # corrupt profile -> no identity
    assert environment._running_from_source() is False   # but sys.frozen -> still a bundle
    with pytest.raises(RuntimeError, match="SUPERCLAW_RUNNINGHUB_BASE_URL must be configured"):
        runninghub_base_url()
    assert local_service_url("SUPERCLAW_FUSION_OSIRIS_URL", "http://127.0.0.1:3000") is None


def test_invalid_app_environment_fails_closed(monkeypatch):
    monkeypatch.setenv("APP_ENV", "prodction")
    with pytest.raises(ValueError, match="APP_ENV must be one of"):
        app_environment()
