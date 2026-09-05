"""`superclaw migrate-home` — relocate legacy cwd `.superclaw/` data into the HOME root.

Locks the migration contract: only known HOME data roots move (state/telemetry DBs with
sidecars, artifacts, plugins, companies, registry, capabilities, evals, keys); repo/
workspace-bound trees (chat-attachments, git worktrees, fusion/acceptance reports) stay
put; existing destination files are never overwritten; `--dry-run` mutates nothing.
"""

from __future__ import annotations

import json

from typer.testing import CliRunner

from superclaw.cli import app


def _seed_legacy(src):
    src.mkdir(parents=True)
    (src / "state.db").write_text("state", encoding="utf-8")
    (src / "state.db-wal").write_text("wal", encoding="utf-8")
    (src / "telemetry.db").write_text("telemetry", encoding="utf-8")
    (src / "artifacts").mkdir()
    (src / "artifacts" / "run.json").write_text("{}", encoding="utf-8")
    (src / "plugins").mkdir()
    (src / "companies").mkdir()
    (src / "registry").mkdir()
    # repo/workspace-bound — must NOT move
    (src / "chat-attachments").mkdir()
    (src / "chat-attachments" / "f.bin").write_text("x", encoding="utf-8")
    (src / "worktrees").mkdir()


def test_dry_run_plans_without_moving(tmp_path, monkeypatch):
    home = tmp_path / "home" / ".superclaw"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    _seed_legacy(src)

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--dry-run", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["dry_run"] is True
    assert set(payload["moved"]) == {"state.db", "state.db-wal", "telemetry.db", "artifacts", "plugins", "companies", "registry"}
    assert set(payload["skip"]) == {"chat-attachments", "worktrees"}
    # Nothing actually moved.
    assert (src / "state.db").exists()
    assert not home.exists()


def test_migrate_moves_data_roots_and_leaves_repo_bound(tmp_path, monkeypatch):
    home = tmp_path / "home" / ".superclaw"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    _seed_legacy(src)

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["ok"] is True

    # Data roots moved to HOME...
    assert (home / "state.db").read_text(encoding="utf-8") == "state"
    assert (home / "state.db-wal").exists()
    assert (home / "telemetry.db").exists()
    assert (home / "artifacts" / "run.json").exists()
    assert (home / "plugins").is_dir()
    assert (home / "companies").is_dir()
    assert (home / "registry").is_dir()
    # ...and removed from the legacy source.
    assert not (src / "state.db").exists()
    assert not (src / "artifacts").exists()
    # Repo/workspace-bound trees stayed in the legacy dir.
    assert (src / "chat-attachments" / "f.bin").exists()
    assert (src / "worktrees").is_dir()
    assert not (home / "chat-attachments").exists()
    assert not (home / "worktrees").exists()


def test_migrate_never_overwrites_existing_destination(tmp_path, monkeypatch):
    home = tmp_path / "home" / ".superclaw"
    home.mkdir(parents=True)
    (home / "state.db").write_text("EXISTING-HOME-STATE", encoding="utf-8")  # pre-existing
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    _seed_legacy(src)

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert "state.db" in payload["conflict"]
    # The pre-existing HOME state.db is untouched; the legacy one stays put.
    assert (home / "state.db").read_text(encoding="utf-8") == "EXISTING-HOME-STATE"
    assert (src / "state.db").read_text(encoding="utf-8") == "state"
    # Non-conflicting roots still migrated.
    assert (home / "telemetry.db").exists()


def test_migrate_noop_when_no_legacy_dir(tmp_path, monkeypatch):
    home = tmp_path / "home" / ".superclaw"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    result = CliRunner().invoke(app, ["migrate-home", "--from", str(tmp_path / "nope" / ".superclaw"), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["moved"] == []
    assert "nothing to migrate" in payload["note"]


def test_migrate_noop_when_source_is_home(tmp_path, monkeypatch):
    home = tmp_path / "home" / ".superclaw"
    home.mkdir(parents=True)
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    result = CliRunner().invoke(app, ["migrate-home", "--from", str(home), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert "nothing to migrate" in payload["note"]


def test_migrate_does_not_move_symlinked_data_root(tmp_path, monkeypatch):
    """A symlinked data root must NOT be migrated — moving the link (not its target) would
    leave HOME pointing back at the original and import an untrusted link into HOME."""
    home = tmp_path / "home" / ".superclaw"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    src.mkdir(parents=True)
    real_plugins = tmp_path / "elsewhere" / "plugins"
    real_plugins.mkdir(parents=True)
    (real_plugins / "p.json").write_text("{}", encoding="utf-8")
    (src / "plugins").symlink_to(real_plugins)  # symlinked data root
    (src / "state.db").write_text("state", encoding="utf-8")  # normal root alongside

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["symlink"] == ["plugins"]
    assert "plugins" not in payload["moved"]
    assert (src / "plugins").is_symlink()  # left in place
    assert not (home / "plugins").exists()
    # The non-symlink root still migrated.
    assert payload["moved"] == ["state.db"]
    assert (home / "state.db").exists()


def test_migrate_treats_broken_symlink_at_dest_as_conflict(tmp_path, monkeypatch):
    """A broken symlink already at the destination must count as a conflict (never
    silently replaced) — Path.exists() is False for it, so the guard uses os.path.lexists."""
    home = tmp_path / "home" / ".superclaw"
    home.mkdir(parents=True)
    (home / "state.db").symlink_to(tmp_path / "does-not-exist")  # broken symlink at dest
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    src.mkdir(parents=True)
    (src / "state.db").write_text("state", encoding="utf-8")

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert "state.db" in payload["conflict"]
    assert payload["moved"] == []
    assert (src / "state.db").read_text(encoding="utf-8") == "state"  # not moved
    assert (home / "state.db").is_symlink()  # broken symlink untouched


def test_migrate_keeps_db_family_atomic_on_partial_dest_conflict(tmp_path, monkeypatch):
    """A SQLite DB and its WAL/SHM sidecars migrate as one atomic family: if even a single
    sidecar already exists at the destination, the WHOLE family stays put — never split
    (moving state.db while leaving state.db-wal could orphan committed WAL data)."""
    home = tmp_path / "home" / ".superclaw"
    home.mkdir(parents=True)
    (home / "state.db-wal").write_text("EXISTING-WAL", encoding="utf-8")  # only a sidecar pre-exists
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    src.mkdir(parents=True)
    (src / "state.db").write_text("state", encoding="utf-8")
    (src / "state.db-wal").write_text("wal", encoding="utf-8")
    (src / "telemetry.db").write_text("telemetry", encoding="utf-8")  # unrelated family

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    # Whole state.db family is a conflict (not split); neither member moved.
    assert set(payload["conflict"]) >= {"state.db", "state.db-wal"}
    assert "state.db" not in payload["moved"]
    assert (src / "state.db").read_text(encoding="utf-8") == "state"
    assert (src / "state.db-wal").exists()
    assert (home / "state.db-wal").read_text(encoding="utf-8") == "EXISTING-WAL"  # untouched
    assert not (home / "state.db").exists()
    # The unrelated telemetry family still migrated.
    assert "telemetry.db" in payload["moved"]
    assert (home / "telemetry.db").exists()


def test_migrate_rolls_back_db_family_on_midgroup_move_failure(tmp_path, monkeypatch):
    """If a DB family move fails partway (e.g. cross-filesystem copy error on a sidecar),
    the WHOLE family is restored to src with no leftover at dest — never split, and the
    intact source is never overwritten by the rollback. Unrelated families still migrate."""
    import os
    import shutil as _shutil

    from superclaw import cli as cli_mod

    home = tmp_path / "home" / ".superclaw"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    src.mkdir(parents=True)
    (src / "state.db").write_text("state", encoding="utf-8")
    (src / "state.db-wal").write_text("wal", encoding="utf-8")
    (src / "telemetry.db").write_text("telemetry", encoding="utf-8")

    real_move = _shutil.move

    def fake_move(s, d, *a, **k):
        if os.fspath(s).endswith("state.db-wal"):
            raise OSError("simulated cross-fs move failure")
        return real_move(s, d, *a, **k)

    monkeypatch.setattr(cli_mod.shutil, "move", fake_move)

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    assert any(f["family"] == "state.db" for f in payload["failed"])
    # The state.db family is fully restored to src with nothing left at dest (no split).
    assert (src / "state.db").read_text(encoding="utf-8") == "state"
    assert (src / "state.db-wal").read_text(encoding="utf-8") == "wal"
    assert not (home / "state.db").exists()
    assert not (home / "state.db-wal").exists()
    # The unrelated telemetry family (separate group) still migrated.
    assert (home / "telemetry.db").exists()
    assert not (src / "telemetry.db").exists()


def test_migrate_toctou_conflict_midgroup_leaves_foreign_dest_untouched(tmp_path, monkeypatch):
    """If a foreign object appears at the destination AFTER planning but before a family
    member's move-time re-check, rollback must NOT delete it (it isn't command-owned) —
    only the members this command actually moved are restored."""
    import os
    import shutil as _shutil

    from superclaw import cli as cli_mod

    home = tmp_path / "home" / ".superclaw"
    home.mkdir(parents=True)
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    src.mkdir(parents=True)
    (src / "state.db").write_text("state", encoding="utf-8")
    (src / "state.db-wal").write_text("wal", encoding="utf-8")

    real_move = _shutil.move

    def fake_move(s, d, *a, **k):
        result = real_move(s, d, *a, **k)
        # Simulate a concurrent writer dropping a FOREIGN wal at dest right after the main
        # DB moves, so the next member's lexists() re-check trips the conflict path.
        if os.fspath(s).endswith("/state.db") and not os.path.lexists(home / "state.db-wal"):
            (home / "state.db-wal").write_text("FOREIGN-NOT-OURS", encoding="utf-8")
        return result

    monkeypatch.setattr(cli_mod.shutil, "move", fake_move)

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 1
    # state.db restored to src; the foreign dest wal is left untouched; no dest state.db.
    assert (src / "state.db").read_text(encoding="utf-8") == "state"
    assert (home / "state.db-wal").read_text(encoding="utf-8") == "FOREIGN-NOT-OURS"
    assert not (home / "state.db").exists()


def test_migrate_rollback_attempts_every_member_no_short_circuit(tmp_path, monkeypatch):
    """Rollback must attempt EVERY touched member even if an earlier restore fails — a
    short-circuit could strand a split DB family."""
    import os
    import shutil as _shutil

    from superclaw import cli as cli_mod

    home = tmp_path / "home" / ".superclaw"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    src = tmp_path / "repo" / ".superclaw"
    src.mkdir(parents=True)
    for member in ("state.db", "state.db-shm", "state.db-wal"):
        (src / member).write_text(member, encoding="utf-8")

    real_move = _shutil.move

    def fake_move(s, d, *a, **k):
        if os.fspath(s).endswith("state.db-wal"):  # last member fails -> triggers rollback
            raise OSError("simulated failure")
        return real_move(s, d, *a, **k)

    restored: list[str] = []

    def fake_restore(src_member, dest_member):
        restored.append(os.path.basename(os.fspath(src_member)))
        return False  # every restore "fails" — must NOT stop the loop

    monkeypatch.setattr(cli_mod.shutil, "move", fake_move)
    monkeypatch.setattr(cli_mod, "_restore_data_member", fake_restore)

    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 1
    # All three touched members (2 moved + 1 failed) were attempted, despite each failing.
    assert set(restored) == {"state.db", "state.db-shm", "state.db-wal"}


def test_migrate_refuses_nested_source_and_dest(tmp_path, monkeypatch):
    # dest is INSIDE src -> must refuse (moving a parent into its own child corrupts).
    src = tmp_path / "repo" / ".superclaw"
    src.mkdir(parents=True)
    home = src / "nested-home"
    monkeypatch.setenv("SUPERCLAW_HOME", str(home))
    result = CliRunner().invoke(app, ["migrate-home", "--from", str(src), "--json"])
    assert result.exit_code == 1
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    assert "nested" in payload["note"]
