from __future__ import annotations

from superclaw.adversarial import (
    AdversarialProfileStrategy,
    apply_adversarial_profile,
    default_verification_strategies,
)
from superclaw.models import EvidenceBundle, VerificationFinding
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


def test_default_registry_maps_adversarial_to_profile_strategy():
    strategies = default_verification_strategies()
    assert isinstance(strategies["adversarial"], AdversarialProfileStrategy)


def test_adversarial_strategy_matches_legacy_function():
    bundle_a = EvidenceBundle(run_id="run_a")
    bundle_b = EvidenceBundle(run_id="run_b")
    legacy = [f.name for f in apply_adversarial_profile(bundle_a)]
    viastrategy = [f.name for f in AdversarialProfileStrategy().verify(bundle_b)]
    assert viastrategy == legacy
    assert [f.name for f in bundle_b.findings] == [f.name for f in bundle_a.findings]


class _SentinelStrategy:
    def __init__(self):
        self.calls = 0

    def verify(self, bundle: EvidenceBundle):
        self.calls += 1
        finding = VerificationFinding(name="sentinel_strategy", passed=True, detail="injected strategy ran")
        bundle.findings.append(finding)
        return [finding]


def test_orchestrator_uses_injected_verification_strategy(tmp_path):
    store = StateStore(tmp_path / "state.db")
    sentinel = _SentinelStrategy()
    orchestrator = SuperClawOrchestrator(store, verification_strategies={"adversarial": sentinel})

    result = orchestrator.run_goal(
        title="Injected strategy",
        description="Verification strategy is injectable.",
        dry_run=True,
    )

    assert sentinel.calls == 1
    finding_names = [f.name for f in store.get_evidence(result.session.run_id).findings]
    assert "sentinel_strategy" in finding_names
    event_types = [e["type"] for e in store.list_events(result.session.run_id)]
    assert "verification.finding" in event_types
    # The default adversarial profile did NOT run (we replaced the strategy).
    assert "command_backed_verification" not in finding_names


def test_orchestrator_skips_verification_for_unregistered_policy(tmp_path):
    store = StateStore(tmp_path / "state.db")
    orchestrator = SuperClawOrchestrator(store)  # default registry: only "adversarial"

    result = orchestrator.run_goal(
        title="No verification",
        description="Unregistered verification policy runs no strategy.",
        dry_run=True,
        verification_policy="none",
    )

    finding_names = [f.name for f in store.get_evidence(result.session.run_id).findings]
    assert "command_backed_verification" not in finding_names  # adversarial profile not applied
    assert result.session.status in {"completed", "failed"}


def test_trust_and_none_policies_are_noop_and_do_not_force_fail():
    from superclaw.adversarial import TrustVerificationStrategy

    strategies = default_verification_strategies()
    assert isinstance(strategies["trust"], TrustVerificationStrategy)
    assert isinstance(strategies["none"], TrustVerificationStrategy)

    # A bundle from a successful worker turn, with no command-backed evidence
    # (typical of a research / plugin task): adversarial would FAIL it, trust must not.
    bundle = EvidenceBundle(run_id="run_trust")
    from superclaw.models import WorkerResult

    bundle.worker_results.append(
        WorkerResult(task_id="t1", role="implement", backend="codex", command="codex", exit_code=0, output="done", duration_seconds=0.1)
    )
    findings = strategies["trust"].verify(bundle)
    assert findings == []
    # No failing findings -> verdict is not FAIL.
    assert bundle.chain_verdict.value != "FAIL"

    # Adversarial on the same evidence would inject a failing finding.
    adversarial_findings = strategies["adversarial"].verify(EvidenceBundle(run_id="run_adv"))
    assert any(not f.passed for f in adversarial_findings)
