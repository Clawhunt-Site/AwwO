"""Session-wide test hygiene shared by the whole suite.

**Hermetic environment (fail-closed safety).** Two real, observed leaks are
closed here, both able to silently flip a fail-closed assertion — most
dangerously local-dev trust masking a plugin signature rejection
(``test_plugin_local_verification`` / ``test_plugin_warm_cache``):

1. The developer's persisted ``~/.superclaw/config.json`` must never be read by
   the suite. On a dev box it commonly holds
   ``SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST=1``; pointing ``SUPERCLAW_SHELL_CONFIG_PATH``
   at an empty file makes ``runtime_config`` hydration a deterministic no-op
   regardless of the host (which is also the true CI/new-machine shape).

2. Any *raw* ``os.environ`` write a test triggers — e.g.
   ``_hydrate_cli_environment()`` → ``hydrate_runtime_environment()`` injecting
   persisted runtime config process-wide (a real CLI feature, not a bug) — must
   not leak into later tests in the same process. Snapshotting and restoring
   ``os.environ`` around every test rolls such writes back at teardown.

A test that needs a specific shell config or environment still sets it itself;
its setting wins for its own scope and is restored here at teardown. This is a
test-isolation layer only — it changes no product semantics; the verification
path stays fail-closed.
"""

import logging
import os
import tempfile
from pathlib import Path

import pytest

from superclaw import diagnostics_store as _ds
from superclaw import logging_config as _lc

# --- import-time isolation (BEFORE any test module is collected) -------------- #
# state.db / telemetry.db now default under superclaw_home() (~/.superclaw). Some
# test modules import ``apps.api.main`` at module scope, which runs ``app =
# create_app()`` AT COLLECTION TIME — before the per-test ``_hermetic_environment``
# fixture can pin SUPERCLAW_HOME. A root conftest is imported before those test
# modules, so pinning the data root here closes that import-time window (otherwise
# collection would open the developer's REAL ~/.superclaw/state.db). The per-test
# fixture still re-points to a fresh throwaway dir for each test body.
#
# Also DROP any host-env SUPERCLAW_STATE_PATH: default_state_path() honors it ABOVE
# SUPERCLAW_HOME, so a developer's ambient override (shell/.env) would otherwise
# punch through the pin and make collection-time create_app() non-hermetic.
os.environ["SUPERCLAW_HOME"] = str(Path(tempfile.mkdtemp(prefix="sc-home-session-")) / ".superclaw")
os.environ.pop("SUPERCLAW_STATE_PATH", None)


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "posix_only: test encodes POSIX-only semantics (mode bits / signals / fork / "
        "killpg / select-on-pipe / a monkeypatched os.name='posix'). Auto-skipped on "
        "Windows, where the behavior has no equivalent — a Windows run stays "
        "green-AND-honest instead of red on assumptions that cannot hold there. "
        "See docs/windows-support-assessment.md.",
    )


def pytest_collection_modifyitems(config, items):
    """On Windows, skip POSIX-only tests (the honest Windows deselection).

    Two sources, both no-ops on POSIX:
      1. The ``posix_only`` marker — for tests authored to assert a POSIX-only
         behavior (owner-mode bits, signals, fork/killpg, select-on-pipe, or an
         ``os.name='posix'`` monkeypatch that on Windows additionally poisons
         ``pathlib`` and crashes the session).
      2. ``WINDOWS_POSIX_SKIPS`` (tests/_windows_posix_skips.py) — a curated,
         documented set of existing tests whose ASSERTIONS encode POSIX-only
         semantics with no Windows equivalent (the product itself runs on Windows;
         real Windows bugs were FIXED, not skipped). Centralized there so the
         team's test files stay untouched and the skip rationale lives in one place.

    A green Windows run therefore means "Windows is healthy", not "POSIX
    assumptions happened to pass".
    """
    if os.name != "nt":
        return
    try:
        from _windows_posix_skips import WINDOWS_POSIX_SKIPS
    except ImportError:  # pragma: no cover - the module ships beside this conftest
        WINDOWS_POSIX_SKIPS = frozenset()
    skip_marker = pytest.mark.skip(
        reason="POSIX-only semantics; not applicable on Windows (see tests/_windows_posix_skips.py)"
    )
    for item in items:
        if "posix_only" in item.keywords or item.nodeid in WINDOWS_POSIX_SKIPS:
            item.add_marker(skip_marker)


@pytest.fixture(scope="session")
def _empty_shell_config(tmp_path_factory):
    path = tmp_path_factory.mktemp("hermetic-shell-config") / "config.json"
    path.write_text("{}", encoding="utf-8")
    return str(path)


@pytest.fixture(scope="session", autouse=True)
def _telemetry_fallback_sink(tmp_path_factory):
    """Session-wide safe default for the diagnostics sink.

    Set ONCE so ``SUPERCLAW_TELEMETRY_PATH`` is part of every test's environment
    baseline. The per-test fixture overrides it with a per-test path and restores to
    THIS fallback (never to "unset") on teardown.

    Scope (not overclaimed): this closes the REPO-POLLUTION window — even a late
    background-thread emit between tests writes a throwaway tmp file, never the
    developer's real ``~/.superclaw/telemetry.db``. It does NOT fully synchronize
    arbitrary late producers (a stray async emit could land in the next test's tmp sink
    or be dropped after a store reset); that residual is harmless because telemetry-reading
    tests are synchronous and any bleed is tmp-only. The writer daemon, if one was lazily
    created, is joined at session end.
    """
    fallback = tmp_path_factory.mktemp("telemetry-fallback") / "telemetry.db"
    os.environ["SUPERCLAW_TELEMETRY_PATH"] = str(fallback)
    try:
        yield
    finally:
        _ds.reset_store_for_tests()


def _reset_superclaw_logging() -> None:
    """Return the ``superclaw`` logger to the library default between tests.

    ``configure_logging()`` mutates a process-global logger (handlers, level,
    ``propagate``, idempotency flag). Without a reset, one test calling
    ``create_app()`` would flip ``propagate`` to the production default (False)
    and silently break a later test relying on caplog (e.g. test_relay_key).
    Restoring the default (propagate=True, no managed handler) keeps the suite
    at the real library baseline rather than a suite-wide env bias.
    """
    logger = logging.getLogger(_lc._BASE_LOGGER)
    for handler in list(logger.handlers):
        if getattr(handler, _lc._MANAGED_HANDLER_FLAG, False):
            logger.removeHandler(handler)
            handler.close()
    if hasattr(logger, _lc._CONFIGURED_FLAG):
        delattr(logger, _lc._CONFIGURED_FLAG)
    logger.propagate = True
    logger.setLevel(logging.NOTSET)


@pytest.fixture(autouse=True)
def _hermetic_environment(_empty_shell_config, _telemetry_fallback_sink):
    """Snapshot/restore ``os.environ`` + logging, default the shell config to empty."""
    snapshot = os.environ.copy()
    os.environ["SUPERCLAW_SHELL_CONFIG_PATH"] = _empty_shell_config
    # Isolate the user-data root per test: state.db / telemetry.db now default under
    # superclaw_home() (~/.superclaw), so an un-isolated default would read/write the
    # developer's REAL home data. Pin it to a throwaway tmp dir.
    os.environ["SUPERCLAW_HOME"] = str(Path(tempfile.mkdtemp(prefix="sc-home-")) / ".superclaw")
    # Drop any ambient SUPERCLAW_STATE_PATH (snapshot above restores it on teardown):
    # default_state_path() honors it above SUPERCLAW_HOME, which would defeat the pin.
    os.environ.pop("SUPERCLAW_STATE_PATH", None)
    # Never materialize visible project folders in the developer's real
    # ~/SuperClaw: isolate the new-project root to a throwaway tmp dir per test.
    os.environ["SUPERCLAW_PROJECT_ROOT"] = str(
        Path(tempfile.mkdtemp(prefix="sc-project-root-")) / "SuperClaw"
    )
    # Isolate the diagnostics telemetry sink per test: any code path that emits a
    # receipt (e.g. the governance gate) must NOT write the developer's real
    # ~/.superclaw/telemetry.db nor leak its writer daemon thread across tests.
    os.environ["SUPERCLAW_TELEMETRY_PATH"] = str(
        Path(tempfile.mkdtemp(prefix="sc-telemetry-")) / "telemetry.db"
    )
    # Isolate the user-global plugin governance state per test. The cache,
    # revocations, entitlements and policy now default under ~/.superclaw/plugins
    # (see superclaw.plugins.plugin_state_root); without this a test that relies on
    # a default would read/write the developer's real home. One root isolates all
    # four call-time resolvers at once; a test that sets SUPERCLAW_PLUGIN_CACHE_PATH
    # itself still overrides the cache leg.
    os.environ["SUPERCLAW_PLUGIN_STATE_ROOT"] = str(
        Path(tempfile.mkdtemp(prefix="sc-plugin-state-")) / "plugins"
    )
    # Floor the *default* plugin sidecar/smoke timeout so a real sidecar
    # subprocess that is CPU-starved under a parallel run (pytest-xdist) or on a
    # busy host cannot trip a FALSE PLUGIN_TIMEOUT. Only the default is floored;
    # tests that explicitly tighten the timeout (manifest tool_timeout_ms /
    # policy max_tool_timeout_ms) still exercise the real timeout path. A test may
    # override this for its own scope. See superclaw.plugin_timeouts.
    os.environ.setdefault("SUPERCLAW_PLUGIN_TIMEOUT_SECONDS", "120")
    try:
        yield
    finally:
        _ds.reset_store_for_tests()  # close the per-test writer daemon if one was created
        os.environ.clear()
        os.environ.update(snapshot)
        _reset_superclaw_logging()
