"""Unit tests for the context-pointers git capture (Paperclip §2.7 break ②).

Drives a real git repo in a private tmp dir so the capture exercises the actual
git probes (argv list, -z parsing, baseline diffing, pre-existing-dirty exclusion).
"""

import subprocess
from pathlib import Path

import pytest

from superclaw.context_pointers import (
    CAPTURED,
    FAILED,
    NO_CHANGES,
    SKIPPED,
    UNAVAILABLE,
    ContextPointersCapture,
    capture_baseline,
    capture_context_pointers,
)


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir(mode=0o700)
    _git(r, "init", "-q")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "user.name", "t")
    (r / "seed.txt").write_text("seed\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "seed")
    return r


def test_captures_committed_and_uncommitted_minus_preexisting_dirty(repo):
    # A file already dirty BEFORE the run must not be attributed to the child.
    (repo / "seed.txt").write_text("preexisting edit\n")
    baseline = capture_baseline(repo)
    assert baseline["is_git"] is True and baseline["sha"]
    assert "seed.txt" in baseline["dirty"]

    # The child commits one file and leaves another uncommitted + an untracked one.
    (repo / "committed.py").write_text("x=1\n")
    _git(repo, "add", "committed.py")
    _git(repo, "commit", "-qm", "child work")
    (repo / "working.py").write_text("y=2\n")
    (repo / "untracked.txt").write_text("z\n")

    cap = capture_context_pointers(repo, baseline)
    assert cap.status == CAPTURED
    # committed + uncommitted-tracked + untracked, all attributed; seed.txt excluded
    assert set(cap.paths) == {"committed.py", "working.py", "untracked.txt"}
    assert "seed.txt" not in cap.paths  # pre-existing dirty is NOT the child's change
    assert cap.preexisting_dirty_count == 1
    assert cap.total_count == 3


def test_preexisting_staged_rename_is_fully_excluded(repo):
    # A rename already staged BEFORE the run must not be attributed to the child.
    # (Regression guard for the porcelain `-z` two-field rename parse hole: the
    # baseline dirty set must capture BOTH the old and new rename paths so the
    # terminal subtraction filters them.)
    (repo / "old.txt").write_text("data\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "add old.txt")
    _git(repo, "mv", "old.txt", "new.txt")  # staged rename = pre-existing dirty
    baseline = capture_baseline(repo)
    # The rename registers as pre-existing dirty (exact path shape — old+new vs a
    # detected rename — is git-version dependent; the invariant below is not).
    assert baseline["dirty"]

    (repo / "child.py").write_text("c=1\n")  # the only change the child makes
    cap = capture_context_pointers(repo, baseline)
    assert cap.status == CAPTURED
    assert cap.paths == ["child.py"]  # rename fully excluded, no false attribution


def test_no_changes_is_distinct_from_failure(repo):
    baseline = capture_baseline(repo)
    cap = capture_context_pointers(repo, baseline)
    assert cap.status == NO_CHANGES
    assert cap.paths == []


def test_non_git_workspace_is_unavailable_not_empty(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir(mode=0o700)
    baseline = capture_baseline(plain)
    assert baseline["is_git"] is False
    cap = capture_context_pointers(plain, baseline)
    # MUST be unavailable, never no_changes — the parent has to re-scan.
    assert cap.status == UNAVAILABLE
    assert cap.paths == []


def test_dry_run_is_skipped(repo):
    baseline = capture_baseline(repo)
    cap = capture_context_pointers(repo, baseline, dry_run=True)
    assert cap.status == SKIPPED


def test_invalid_baseline_sha_is_unavailable_not_passed_to_git(repo):
    # A non-sha (e.g. an injection attempt) is rejected before reaching git.
    cap = capture_context_pointers(repo, {"is_git": True, "sha": "--upload-pack=evil", "dirty": []})
    assert cap.status == UNAVAILABLE


def test_render_brief_distinguishes_statuses():
    captured = ContextPointersCapture(status=CAPTURED, paths=["a.py", "b.py"], total_count=2)
    assert "a.py, b.py" in captured.render_brief()
    capped = ContextPointersCapture(status=CAPTURED, paths=[f"f{i}.py" for i in range(60)], total_count=60)
    assert "+10 more" in capped.render_brief()  # full list stored, render capped at 50
    assert ContextPointersCapture(status=NO_CHANGES).render_brief() == "Files changed by this child: (none reported)"
    assert "UNKNOWN" in ContextPointersCapture(status=FAILED, reason="git timed out").render_brief()
    assert ContextPointersCapture(status=SKIPPED).render_brief() is None


def test_render_brief_custom_prefix():
    # The prefix labels the line for its context (a child's files vs an issue's own).
    cap = ContextPointersCapture(status=CAPTURED, paths=["x.py"], total_count=1)
    assert cap.render_brief(prefix="Files you changed last pass").startswith(
        "Files you changed last pass: x.py"
    )
    assert ContextPointersCapture(status=FAILED).render_brief(prefix="Mine").startswith("Mine: UNKNOWN")


def test_render_brief_is_type_defensive_on_corrupt_captured():
    # A structurally-corrupt `captured` record (non-list paths / non-int total_count
    # that slipped past from_dict's field filter) must render UNKNOWN, never raise,
    # and never a misleading empty.
    bad_paths = ContextPointersCapture(status=CAPTURED, paths=None, total_count=1)  # type: ignore[arg-type]
    out = bad_paths.render_brief()
    assert out is not None and "UNKNOWN" in out
    bad_count = ContextPointersCapture(status=CAPTURED, paths=["a.py"], total_count="1")  # type: ignore[arg-type]
    out2 = bad_count.render_brief()
    assert out2 is not None and "a.py" in out2  # tolerates bad total_count, no crash
    # CAPTURED with empty/all-non-str paths is structurally impossible for a real
    # capture (→ NO_CHANGES) → corrupt record → explicit UNKNOWN, never an empty line.
    empty_cap = ContextPointersCapture(status=CAPTURED, paths=[], total_count=0)
    assert "UNKNOWN" in empty_cap.render_brief()
    nonstr_cap = ContextPointersCapture(status=CAPTURED, paths=[1, 2], total_count=2)  # type: ignore[list-item]
    out3 = nonstr_cap.render_brief()
    assert "UNKNOWN" in out3 and not out3.rstrip().endswith(":")  # never an empty "..: " line


def test_from_dict_ignores_unknown_fields():
    # Forward/backward compatible: an extra field never crashes deserialization.
    restored = ContextPointersCapture.from_dict(
        {"status": CAPTURED, "paths": ["a"], "total_count": 1, "some_future_field": 99}
    )
    assert restored.status == CAPTURED and restored.paths == ["a"]


def test_from_dict_tolerates_non_dict_records():
    # A corrupt/legacy stored value may be a list/str/None — must NOT crash the
    # reflow render (the real root cause behind a malformed pointer payload).
    for bad in ([1, 2, 3], "garbage", 42, None):
        cap = ContextPointersCapture.from_dict(bad)
        assert cap.status == UNAVAILABLE  # safe default, no exception
        assert cap.render_brief() is not None or cap.status == SKIPPED


def test_capture_baseline_never_raises_on_git_failure(tmp_path, monkeypatch):
    # A git timeout / missing-binary at run start must fail-open, never abort.
    import superclaw.context_pointers as cp

    def _boom(*a, **k):
        raise OSError("git not found")

    monkeypatch.setattr(cp.subprocess, "run", _boom)
    baseline = cp.capture_baseline(tmp_path)  # must not raise
    assert baseline["is_git"] is False
    cap = cp.capture_context_pointers(tmp_path, baseline)  # also must not raise
    assert cap.status in {UNAVAILABLE, FAILED}


def test_none_baseline_surfaces_unavailable_not_faked():
    # A persisted fail-open None baseline must surface UNKNOWN at terminal, never a
    # fabricated no_changes/captured (the consequence of resume idempotency).
    assert capture_context_pointers(".", None).status == UNAVAILABLE


def test_baseline_not_recaptured_on_resume(tmp_path, monkeypatch):
    """A baseline is captured exactly ONCE at first run start; re-entering
    execute_existing_session (resume) must REUSE the persisted baseline, keyed on
    presence — never re-capture, which would reset it to the resume-time HEAD."""
    import superclaw.orchestrator as orch_mod
    from superclaw.models import GoalSpec

    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    _git(ws, "init", "-q")
    _git(ws, "config", "user.email", "t@t")
    _git(ws, "config", "user.name", "t")
    (ws / "seed.txt").write_text("s\n")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-qm", "s")

    orch = orch_mod.SuperClawOrchestrator.from_path(tmp_path / "run.db")
    calls = {"n": 0}
    real = orch_mod.capture_baseline
    monkeypatch.setattr(orch_mod, "capture_baseline", lambda r: (calls.__setitem__("n", calls["n"] + 1), real(r))[1])

    res = orch.run_goal(
        title="x", description="y", backend_policy="local", dry_run=False,
        repo_path=str(ws), concurrency=1, budget_seconds=30,
    )
    assert calls["n"] == 1  # captured once at first start
    assert "git_pointer_baseline" in res.session.execution_context

    # Re-enter execute_existing_session on the persisted session. The baseline
    # branch runs early (before the run-status machinery rejects re-running a
    # terminal run); we only assert that branch did NOT re-capture.
    try:
        orch.execute_existing_session(
            GoalSpec(title="x", description="y"), res.session, backend_policy="local",
            dry_run=False, repo_path=str(ws), budget_seconds=30,
        )
    except ValueError:
        pass  # re-running an already-terminal run is rejected downstream — irrelevant here
    assert calls["n"] == 1, "key present → baseline must NOT be re-captured on resume"


def test_delivery_run_captures_pointers_onto_evidence(tmp_path):
    """End-to-end orchestrator wiring: a run against a real git workspace stamps a
    baseline at start and writes a structured context-pointers record to evidence."""
    from superclaw.orchestrator import SuperClawOrchestrator

    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    _git(ws, "init", "-q")
    _git(ws, "config", "user.email", "t@t")
    _git(ws, "config", "user.name", "t")
    (ws / "seed.txt").write_text("seed\n")
    _git(ws, "add", "-A")
    _git(ws, "commit", "-qm", "seed")

    orch = SuperClawOrchestrator.from_path(tmp_path / "run.db")
    res = orch.run_goal(
        title="smoke",
        description="exercise context-pointers capture",
        backend_policy="local",
        dry_run=False,
        repo_path=str(ws),
        concurrency=1,
        budget_seconds=30,
    )
    evidence = orch.store.get_evidence(res.session.run_id)
    cp = (evidence.backend_summary or {}).get("context_pointers")
    assert cp is not None, "terminal finalize must stamp a context-pointers record"
    # Ran against a real git repo with a captured baseline → structured, not unavailable.
    assert cp["status"] in {CAPTURED, NO_CHANGES}
    assert cp["base_sha"], "baseline sha must have been captured at run start"
    # The run-start baseline is persisted on the session for idempotent resume.
    assert res.session.execution_context.get("git_pointer_baseline", {}).get("is_git") is True
    # The on-disk evidence artifact and the store row agree (capture happens BEFORE
    # the artifact is frozen) — auditing via either source sees the same pointers.
    import json as _json

    artifact = next(a for a in evidence.artifacts if getattr(a, "kind", None) == "evidence-json")
    on_disk = _json.loads(Path(artifact.path).read_text())
    assert on_disk["backend_summary"]["context_pointers"]["status"] == cp["status"]
