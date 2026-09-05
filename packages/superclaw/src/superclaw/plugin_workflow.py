from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PluginWorkflowGate:
    gate_id: str
    requirement: str
    evidence: list[str]
    required_markers: list[str]


@dataclass(frozen=True)
class PluginWorkflowGateResult:
    gate_id: str
    requirement: str
    evidence: list[str]
    status: str
    missing_markers: list[str]


DEFAULT_PLUGIN_WORKFLOW_GATES: tuple[PluginWorkflowGate, ...] = (
    PluginWorkflowGate(
        gate_id="feature-boundary-card",
        requirement="Section 27 defines the feature boundary fields required before implementation starts.",
        evidence=["docs/plugin-ecosystem-framework.md"],
        required_markers=[
            "Feature id",
            "Phase",
            "Owned modules",
            "Out of scope",
            "Runtime boundary",
            "Security boundary",
            "Positive tests",
            "Negative tests",
            "Documentation updates",
            "Gemini verification",
        ],
    ),
    PluginWorkflowGate(
        gate_id="tests-per-feature",
        requirement="Section 27 requires positive and negative tests for each feature boundary.",
        evidence=["docs/plugin-ecosystem-framework.md"],
        required_markers=[
            "No feature is complete without tests",
            "at least one positive test and one negative test",
            "Security features must include fail-closed negative tests",
            "Cloud-sync features must include fake-cloud tests",
        ],
    ),
    PluginWorkflowGate(
        gate_id="documentation-loop",
        requirement="Section 27 maps every feature change type to required maintainer or developer documentation.",
        evidence=["docs/plugin-ecosystem-framework.md", "docs/plugin-developer-guide.md"],
        required_markers=[
            "Documentation must be updated in the same atomic commit",
            "public developer workflow",
            "architecture boundary",
            "CLI behavior",
            "cloud API contract",
            "security behavior",
            "test fixture",
        ],
    ),
    PluginWorkflowGate(
        gate_id="atomic-commit-policy",
        requirement="Section 27 requires one independently reviewable change per commit.",
        evidence=["docs/plugin-ecosystem-framework.md"],
        required_markers=[
            "One commit equals one independently reviewable feature",
            "Do not mix unrelated feature",
            "Commit messages must use",
            "Do not commit generated local noise",
        ],
    ),
    PluginWorkflowGate(
        gate_id="pre-commit-gate",
        requirement="Section 27 requires tests, patch hygiene, and Gemini review before each commit.",
        evidence=["docs/plugin-ecosystem-framework.md"],
        required_markers=[
            "Run the smallest relevant test set",
            "Run any broader regression suite",
            "Run `git diff --check`",
            "Ask Gemini to review the changed diff",
            "Commit only after tests pass",
        ],
    ),
    PluginWorkflowGate(
        gate_id="feature-group-pr-policy",
        requirement="Section 27 requires PRs to represent complete feature groups with scoped atomic commits.",
        evidence=["docs/plugin-ecosystem-framework.md"],
        required_markers=[
            "Pull requests should be opened for complete feature groups",
            "A PR may contain multiple atomic commits",
            "must not include unrelated local files",
            "draft PR is allowed",
        ],
    ),
    PluginWorkflowGate(
        gate_id="pre-pr-sync-gate",
        requirement="Section 27 requires synchronizing with the latest remote base before opening or updating a PR.",
        evidence=["docs/plugin-ecosystem-framework.md"],
        required_markers=[
            "git fetch origin",
            "git rebase origin/main",
            "git status -sb",
            "conflicts were resolved without rerunning relevant tests",
            "Gemini has not reviewed the final post-sync diff",
        ],
    ),
    PluginWorkflowGate(
        gate_id="version-changelog-gate",
        requirement="Repository release hygiene includes SemVer VERSION and Keep-a-Changelog sections.",
        evidence=["VERSION", "CHANGELOG.md"],
        required_markers=["semver-version", "unreleased-heading", "released-version-heading"],
    ),
)


def run_plugin_workflow_gate(
    *,
    repo_root: Path,
    gates: tuple[PluginWorkflowGate, ...] = DEFAULT_PLUGIN_WORKFLOW_GATES,
) -> list[PluginWorkflowGateResult]:
    repo_root = repo_root.resolve()
    results: list[PluginWorkflowGateResult] = []
    for gate in gates:
        missing = _missing_markers(repo_root, gate)
        results.append(
            PluginWorkflowGateResult(
                gate_id=gate.gate_id,
                requirement=gate.requirement,
                evidence=list(gate.evidence),
                status="passed" if not missing else "failed",
                missing_markers=missing,
            )
        )
    return results


def plugin_workflow_gate_payload(results: list[PluginWorkflowGateResult]) -> dict[str, object]:
    return {
        "ok": all(result.status == "passed" for result in results),
        "summary": {
            "passed": sum(1 for result in results if result.status == "passed"),
            "failed": sum(1 for result in results if result.status == "failed"),
        },
        "gates": [
            {
                "gate_id": result.gate_id,
                "requirement": result.requirement,
                "evidence": result.evidence,
                "status": result.status,
                "missing_markers": result.missing_markers,
            }
            for result in results
        ],
    }


def _missing_markers(repo_root: Path, gate: PluginWorkflowGate) -> list[str]:
    if gate.gate_id == "version-changelog-gate":
        return _missing_version_changelog_markers(repo_root)

    evidence_text = []
    missing: list[str] = []
    for evidence in gate.evidence:
        path = _safe_repo_path(repo_root, evidence)
        if not path.exists():
            missing.append(f"missing evidence file: {evidence}")
            continue
        evidence_text.append(path.read_text(encoding="utf-8"))
    combined = "\n".join(evidence_text)
    for marker in gate.required_markers:
        if marker not in combined:
            missing.append(marker)
    return missing


def _missing_version_changelog_markers(repo_root: Path) -> list[str]:
    missing: list[str] = []
    version_path = _safe_repo_path(repo_root, "VERSION")
    changelog_path = _safe_repo_path(repo_root, "CHANGELOG.md")
    version = version_path.read_text(encoding="utf-8").strip() if version_path.exists() else ""
    changelog = changelog_path.read_text(encoding="utf-8") if changelog_path.exists() else ""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        missing.append("semver-version")
    if "## [Unreleased]" not in changelog:
        missing.append("unreleased-heading")
    if not re.search(r"^## \[\d+\.\d+\.\d+\]", changelog, flags=re.MULTILINE):
        missing.append("released-version-heading")
    return missing


def _safe_repo_path(repo_root: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"workflow gate evidence path is unsafe: {raw_path}")
    return repo_root / path
