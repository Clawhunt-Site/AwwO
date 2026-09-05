"""CLI + contract tests for company-as-code export (`superclaw company export`).

The kernel round-trip is covered in test_company_export.py; here we verify the
CLI surface (disk/zip writing, summary, safety) and the ui_contracts payload
stay aligned with the kernel and never write warnings into a shipped file.
"""

import json
import zipfile

import pytest
from typer.testing import CliRunner

from superclaw.cli import app
from superclaw.models import AgentProfile, CompanyProfile, WorkspaceProfile
from superclaw.state import StateStore
from superclaw.team_templates import build_bootstrap_proposal
from superclaw.ui_contracts import build_company_export_payload


def _seed(state_path):
    store = StateStore(state_path)
    store.save_company_profile(
        CompanyProfile(
            name="Acme",
            company_profile_id="company_acme",
            goal="Ship safely.",
            default_budget_seconds=120,
            metadata={"secret_note": "VAULT_xyz"},
        )
    )
    store.save_workspace_profile(
        WorkspaceProfile(
            name="repo",
            workspace_id="workspace_acme",
            company_profile_id="company_acme",
            repo_path="/Users/local/secret/acme",
            writable_paths=["/abs/danger", "src"],  # one unsafe → dropped + warned
        )
    )
    ceo = store.save_agent_profile(
        AgentProfile(
            name="CEO",
            role="ceo",
            company_profile_id="company_acme",
            workspace_id="workspace_acme",
            charter="Lead and delegate.",
        )
    )
    store.save_agent_profile(
        AgentProfile(
            name="Engineer",
            role="engineer",
            company_profile_id="company_acme",
            workspace_id="workspace_acme",
            reports_to=ceo.profile_id,
            charter="Build features.",
        )
    )
    return store


@pytest.fixture
def state_path(tmp_path, monkeypatch):
    p = tmp_path / "state.db"
    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(p))
    return p


def test_cli_export_writes_bundle_and_roundtrips(state_path, tmp_path):
    _seed(state_path)
    out = tmp_path / "export"
    result = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out)])
    assert result.exit_code == 0, result.output
    summary = json.loads(result.output)

    # Files landed on disk.
    assert (out / "manifest.json").exists()
    assert (out / "COMPANY.md").exists()
    assert (out / "agents" / "ceo" / "AGENTS.md").exists()
    assert summary["agent_count"] == 2
    assert summary["warnings"]  # unsafe path + dropped metadata surfaced

    # The written manifest round-trips through bootstrap.
    manifest = json.loads((out / "manifest.json").read_text())
    assert build_bootstrap_proposal(manifest).blocked is False

    # No warning text / machine-local secret written to ANY file on disk.
    blob = "\n".join(p.read_text() for p in out.rglob("*") if p.is_file())
    for leaked in ("/Users/local/secret", "/abs/danger", "VAULT_xyz"):
        assert leaked not in blob, f"leaked into written bundle: {leaked}"


def test_cli_export_zip(state_path, tmp_path):
    _seed(state_path)
    out = tmp_path / "acme.zip"
    result = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out), "--zip"])
    assert result.exit_code == 0, result.output
    assert out.exists()
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        assert "manifest.json" in names
        assert "agents/ceo/AGENTS.md" in names
        blob = "\n".join(zf.read(n).decode() for n in names)
    assert "/Users/local/secret" not in blob


def test_cli_export_unknown_company_fails(state_path, tmp_path):
    _seed(state_path)
    result = CliRunner().invoke(app, ["company", "export", "nope", "--out", str(tmp_path / "x")])
    assert result.exit_code == 1
    assert "unknown company" in result.output


def test_cli_export_refuses_nonempty_without_force(state_path, tmp_path):
    _seed(state_path)
    out = tmp_path / "export"
    out.mkdir()
    (out / "stale.txt").write_text("foreign file")
    result = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out)])
    assert result.exit_code == 1
    assert "not empty" in result.output
    # --force must NOT blindly wipe a foreign directory (no manifest.json) — that
    # would make `--out . --force` destructive. It is fail-closed here.
    forced = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out), "--force"])
    assert forced.exit_code == 1
    assert "not a prior SuperClaw export" in forced.output
    assert (out / "stale.txt").exists()  # untouched


def test_cli_force_clean_replaces_prior_export(state_path, tmp_path):
    """Re-exporting over a PRIOR export with --force is a clean replace: a stale
    file from the old export must not ride along in the new shareable bundle."""
    _seed(state_path)
    out = tmp_path / "export"
    first = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out)])
    assert first.exit_code == 0, first.output
    (out / "leftover.md").write_text("stale from a previous run")  # simulate drift
    again = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out), "--force"])
    assert again.exit_code == 0, again.output
    assert not (out / "leftover.md").exists()
    assert (out / "manifest.json").exists()


def test_cli_zip_to_existing_file_fails_closed(state_path, tmp_path):
    _seed(state_path)
    target = tmp_path / "afile"  # not a .zip, already a file
    target.write_text("i am a file")
    result = CliRunner().invoke(
        app, ["company", "export", "company_acme", "--out", str(target), "--zip"]
    )
    # Must be a controlled fail, NOT a mkdir-on-a-file traceback.
    assert result.exit_code == 1
    assert "not a directory" in result.output


def test_cli_zip_explicit_path_with_file_parent_fails_closed(state_path, tmp_path):
    """`--zip --out <file>/export.zip` (parent is a regular file) must fail-closed,
    not crash in mkdir."""
    _seed(state_path)
    parent = tmp_path / "afile"
    parent.write_text("i am a file")
    result = CliRunner().invoke(
        app, ["company", "export", "company_acme", "--out", str(parent / "export.zip"), "--zip"]
    )
    assert result.exit_code == 1
    assert "not a directory" in result.output


def test_cli_force_refuses_foreign_dir_with_bogus_manifest(state_path, tmp_path):
    """A foreign directory that merely CONTAINS a manifest.json (but not a real
    SuperClaw export manifest) must NOT be rmtree'd by --force."""
    _seed(state_path)
    out = tmp_path / "notmine"
    out.mkdir()
    (out / "manifest.json").write_text(json.dumps({"schema": "something/else", "hello": 1}))
    (out / "precious.txt").write_text("do not delete me")
    result = CliRunner().invoke(
        app, ["company", "export", "company_acme", "--out", str(out), "--force"]
    )
    assert result.exit_code == 1
    assert "not a prior SuperClaw export" in result.output
    assert (out / "precious.txt").exists()  # untouched


def test_cli_force_refuses_structurally_incomplete_manifest(state_path, tmp_path):
    """Even a manifest with the right schema + source prefix must NOT pass the
    prior-export gate if it is structurally incomplete (empty roles / no company /
    no digest) — a minimal forgery cannot trick --force into an rmtree."""
    _seed(state_path)
    out = tmp_path / "notmine"
    out.mkdir()
    (out / "manifest.json").write_text(
        json.dumps(
            {
                "schema": "agentcompanies/v1",
                "roles": [],  # empty → not a real export
                "metadata": {"source": "superclaw:company:x", "digest": ""},
            }
        )
    )
    (out / "precious.txt").write_text("keep me")
    result = CliRunner().invoke(
        app, ["company", "export", "company_acme", "--out", str(out), "--force"]
    )
    assert result.exit_code == 1
    assert "not a prior SuperClaw export" in result.output
    assert (out / "precious.txt").exists()


def test_cli_force_refuses_digest_mismatched_manifest(state_path, tmp_path):
    """A manifest that is structurally complete (right schema/roles/company/
    workspace/source) but whose digest does NOT match its own payload is a
    look-alike, not a genuine export — --force must refuse to rmtree it."""
    _seed(state_path)
    out = tmp_path / "lookalike"
    out.mkdir()
    (out / "manifest.json").write_text(
        json.dumps(
            {
                "schema": "agentcompanies/v1",
                "metadata": {"source": "superclaw:company:x", "digest": "0" * 64},
                "company": {"name": "X"},
                "workspace": {"workspace_id": "w"},
                "roles": [{"id": "ceo"}],
            }
        )
    )
    (out / "precious.txt").write_text("keep me")
    result = CliRunner().invoke(
        app, ["company", "export", "company_acme", "--out", str(out), "--force"]
    )
    assert result.exit_code == 1
    assert "not a prior SuperClaw export" in result.output
    assert (out / "precious.txt").exists()


def test_cli_force_accepts_genuine_prior_export_digest(state_path, tmp_path):
    """The genuine exporter-produced manifest (self-consistent digest) IS accepted
    as a prior export and clean-replaced."""
    _seed(state_path)
    out = tmp_path / "real"
    first = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out)])
    assert first.exit_code == 0, first.output
    manifest = json.loads((out / "manifest.json").read_text())
    # Sanity: its digest matches its own payload (what the gate verifies).
    from superclaw.company_export import manifest_self_digest

    assert manifest_self_digest(manifest) == manifest["metadata"]["digest"]
    again = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out), "--force"])
    assert again.exit_code == 0, again.output


def test_cli_export_under_symlinked_parent_succeeds(state_path, tmp_path):
    """Following a symlinked PARENT dir is correct (e.g. macOS /tmp -> /private/tmp);
    it must NOT be rejected — only the bundle's own paths are escape-clamped."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    _seed(state_path)
    out = link / "export"  # parent 'link' is a symlink; final 'export' is not
    result = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out)])
    assert result.exit_code == 0, result.output
    assert (real / "export" / "manifest.json").exists()


def test_cli_export_out_is_existing_file_fails_closed(state_path, tmp_path):
    _seed(state_path)
    target = tmp_path / "afile"
    target.write_text("i am a file")
    result = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(target)])
    # Fail-closed with a clear message, NOT an unhandled traceback.
    assert result.exit_code == 1
    assert "not a directory" in result.output


def test_cli_zip_to_directory_path_writes_export_zip(state_path, tmp_path):
    _seed(state_path)
    out = tmp_path / "dir"
    out.mkdir()
    result = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out), "--zip"])
    assert result.exit_code == 0, result.output
    assert (out / "export.zip").exists()


def test_cli_summary_matches_contract_payload(state_path, tmp_path, monkeypatch):
    """Zero-divergence: the CLI's emitted JSON (minus CLI-only write facts) is
    EXACTLY the shared contract projection — no hand-rolled parallel shape.

    Time is frozen because the sidecar carries a ``generated_at`` whose float
    repr length can shift a file's byte count between two separate exports; the
    point under test is the SHAPE, so we pin the clock to compare deterministically."""
    monkeypatch.setattr("superclaw.company_export.time", lambda: 1000.0)
    store = _seed(state_path)
    out = tmp_path / "export"
    result = CliRunner().invoke(app, ["company", "export", "company_acme", "--out", str(out)])
    assert result.exit_code == 0, result.output
    summary = json.loads(result.output)
    for cli_only in ("out", "format", "written"):
        summary.pop(cli_only)
    expected = build_company_export_payload(store, "company_acme", include_files=False)
    assert summary == expected


def test_write_bundle_rejects_unsafe_paths(state_path, tmp_path):
    """The writer is the explicit second line of defense: hostile bundle paths
    fail-closed even if they somehow reached the file map."""
    import typer

    from superclaw.cli import _write_export_bundle

    for bad in ("../escape.md", "/abs.md", r"C:\win.md", "a/../b.md", "./x.md", "a\\b.md", ""):
        with pytest.raises((typer.Exit, SystemExit)):
            _write_export_bundle({bad: "x"}, tmp_path / "o", zip_bundle=False, force=False)


def test_cli_export_includes_issues_flag(state_path, tmp_path):
    store = _seed(state_path)
    from superclaw.models import Issue

    store.save_issue(
        Issue(title="First task", company_profile_id="company_acme", workspace_id="workspace_acme")
    )
    out = tmp_path / "export"
    result = CliRunner().invoke(
        app, ["company", "export", "company_acme", "--out", str(out), "--include", "issues"]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["includes"]["issues"] is True
    assert list(out.glob("issues/*.md"))


def test_contract_payload_matches_kernel_and_preview_drops_files(state_path):
    store = _seed(state_path)
    full = build_company_export_payload(store, "company_acme")
    assert "files" in full
    assert full["file_tree"]
    assert full["manifest"]["metadata"]["digest"]
    # Preview shape omits file bodies but keeps the tree + warnings.
    preview = build_company_export_payload(store, "company_acme", include_files=False)
    assert "files" not in preview
    assert preview["file_tree"]
    assert "warnings" in preview
