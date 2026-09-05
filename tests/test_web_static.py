from pathlib import Path


def test_web_workbench_contains_required_operational_surfaces():
    source = Path("apps/web/src/App.tsx").read_text(encoding="utf-8")

    # NOTE: run/evidence cockpit, the Fusion workbench and Media Studio surfaces
    # were removed from apps/web (their kernel/CLI fallbacks stay). Only the live
    # chat + evals surfaces are asserted here; the dropped fusion/run/media strings
    # were pruned alongside the removal (mirrors apps/web/tests/static-ui.test.mjs).
    for text in [
        "composer-card",
        "Worker Timeline",
        "downloadEvalReport",
        "eval-report-download-button",
        "fetch(`/api/evals/${evalReport.eval_id}/report${format === 'pdf' ? '.pdf' : ''}`, { headers: authHeaders() })",
        "URL.createObjectURL",
        "Eval delivery gap",
        "Eval delivery gap summary",
        "Verdict:",
        "Plugins",
    ]:
        assert text in source

    assert "fetch(" in source
    assert "EventSource" in source
    assert "/api/backends" in source
    assert "async_execution" in source
    assert "/api/runs" in source
    assert "/api/pay-switch/status" in source
    assert "/api/evals" in source
    assert "downloadEvalReport('pdf')" in source
    assert "eval-report-download-button" in source
    assert "mini-pay-webhook" in source
    assert "mini-order-ledger" in source
    assert "mini-awd-arena" in source
    assert "X-SuperClaw-Token" in source
    assert "Control token" in source
    assert "URL.revokeObjectURL(objectUrl)" in source
    # Desktop startup keeps the backend unselected until a persisted default or
    # live runtime inventory is available, then still prefers available Claude.
    assert "useState('')" in source
    assert "preferredComposerRuntimeAgent" in source
    assert "backend.name === 'claude'" in source


def test_web_workbench_wires_permission_preset() -> None:
    """The two-state permission shell must be wired in the web surface: an
    Ask/Allow dropdown in the composer footer (below the input) plus the preset
    riding on chat and run request bodies (docs/permission-mode-framework.md)."""
    source = Path("apps/web/src/App.tsx").read_text(encoding="utf-8")
    for marker in [
        # settings-redesign: the preset rides the in-page Dropdown framework
        "selectPermissionPreset(next as 'ask' | 'allow')",
        # the preset now rides the Node-native chat turn body (per-turn pinned var);
        # the old run-creation body (permissionPreset) was removed with the run path.
        "permission_preset: turnPermissionPreset,",
        "'Permission ask hint'",
        "'Permission allow hint'",
    ]:
        assert marker in source, marker
    # the dropdown lives in the composer footer (below the input), not the header
    assert source.index("selectPermissionPreset(next as 'ask' | 'allow')") > source.index('className="composer-footer"')
    styles = Path("apps/web/src/styles.css").read_text(encoding="utf-8")
    assert ".sc-dropdown" in styles  # in-page dropdown framework styles present
