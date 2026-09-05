"""Contract tests for the SuperClaw user-data root resolver.

state.db / telemetry.db default under ``~/.superclaw`` (HOME), not a cwd-relative
``.superclaw/`` — a cwd default lands operational data inside whatever directory the
CLI runs in, which for the iCloud-synced repo checkout means the data (and credential
siblings) sync off-machine. (Artifacts and other roots move in a follow-up.) These
tests lock:

* the HOME default + ``SUPERCLAW_HOME`` override,
* the legacy cwd fallback (don't orphan existing data),
* the rule that the legacy fallback is consulted ONLY when defaulting to ``~/.superclaw``
  (an explicit ``SUPERCLAW_HOME`` is honored verbatim, never diverted to cwd),
* ``default_state_path`` honoring ``SUPERCLAW_STATE_PATH``.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from superclaw.environment import (
    default_state_path,
    superclaw_data_path,
    superclaw_home,
)


def test_superclaw_home_defaults_to_dot_superclaw_under_home(monkeypatch) -> None:
    monkeypatch.delenv("SUPERCLAW_HOME", raising=False)
    assert superclaw_home() == Path.home() / ".superclaw"


def test_superclaw_home_env_override_expands_user(monkeypatch) -> None:
    monkeypatch.setenv("SUPERCLAW_HOME", "~/custom-sc-root")
    assert superclaw_home() == (Path.home() / "custom-sc-root")


def test_data_path_prefers_home_when_it_exists(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home" / ".superclaw"
    (home).mkdir(parents=True)
    (home / "state.db").write_text("home", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    assert superclaw_data_path("state.db") == home / "state.db"


def test_explicit_home_is_never_diverted_to_cwd_legacy(tmp_path, monkeypatch) -> None:
    # HOME root chosen explicitly but empty; a legacy .superclaw/ sits in the cwd.
    home = tmp_path / "home" / ".superclaw"
    home.mkdir(parents=True)
    workdir = tmp_path / "work"
    (workdir / ".superclaw").mkdir(parents=True)
    (workdir / ".superclaw" / "state.db").write_text("legacy", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    monkeypatch.chdir(workdir)
    # Explicit SUPERCLAW_HOME wins — the cwd legacy DB must NOT be picked up.
    assert superclaw_data_path("state.db") == home / "state.db"


def test_legacy_cwd_fallback_only_when_defaulting_to_home(tmp_path, monkeypatch) -> None:
    # No explicit SUPERCLAW_HOME, default ~/.superclaw absent, legacy cwd present.
    fake_home = tmp_path / "fakehome"
    fake_home.mkdir()
    workdir = tmp_path / "work"
    (workdir / ".superclaw").mkdir(parents=True)
    (workdir / ".superclaw" / "state.db").write_text("legacy", encoding="utf-8")
    monkeypatch.delenv("SUPERCLAW_HOME", raising=False)
    # Path.home() uses USERPROFILE on Windows, so isolate the resolver itself.
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    monkeypatch.chdir(workdir)
    assert superclaw_data_path("state.db") == Path(".superclaw") / "state.db"


def test_default_state_path_honors_explicit_env(monkeypatch) -> None:
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", "/var/tmp/explicit-state.db")
    assert default_state_path() == Path("/var/tmp/explicit-state.db")


def test_default_state_path_blank_env_falls_back_to_data_path(tmp_path, monkeypatch) -> None:
    home = tmp_path / "home" / ".superclaw"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", "   ")  # whitespace-only -> ignored
    assert default_state_path() == home / "state.db"
    assert not os.path.isabs("state.db")  # sanity: we did not accidentally return cwd


def test_create_app_with_explicit_state_path_does_not_create_default_db(tmp_path, monkeypatch) -> None:
    """Building the API app with an explicit state_path must NOT also open the default
    HOME state.db. Guards the eager ``app = create_app()`` side effect from regressing.
    """
    from apps.api.main import create_app

    home = tmp_path / "home" / ".superclaw"
    custom = tmp_path / "custom.db"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    monkeypatch.delenv("SUPERCLAW_STATE_PATH", raising=False)
    create_app(state_path=str(custom))
    assert custom.exists()
    assert not (home / "state.db").exists()


def test_importing_api_module_has_no_default_db_side_effect(tmp_path) -> None:
    """Importing ``apps.api.main`` (for its factory) must not create a state.db.

    Runs in a fresh subprocess so the assertion is deterministic regardless of whatever
    already imported the module in this test session (the module-level ASGI ``app`` is
    lazy via PEP 562 ``__getattr__``).
    """
    home = tmp_path / "home" / ".superclaw"
    repo_root = Path(__file__).resolve().parents[1]
    src = repo_root / "packages" / "superclaw" / "src"
    env = dict(os.environ)
    env["SUPERCLAW_HOME"] = str(home)
    env.pop("SUPERCLAW_STATE_PATH", None)
    env["PYTHONPATH"] = os.pathsep.join([str(src), str(repo_root)])
    script = (
        "import os\n"
        "import apps.api.main  # import for factory; must NOT build the ASGI app\n"
        "from apps.api.main import create_app\n"
        f"assert not os.path.exists(r'{home / 'state.db'}'), 'import created default state.db'\n"
        "print('OK')\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"
    assert "OK" in result.stdout
