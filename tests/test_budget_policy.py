from superclaw.budget_policy import BudgetLimit, BudgetPolicy, BudgetScopeCheck, hard_budget_preflight
from superclaw.models import CostEvent, CostMeterKind
from superclaw.state import StateStore


def test_budget_snapshot_uses_existing_cost_summary_for_agent_scope(tmp_path):
    store = StateStore(tmp_path / "state.db")
    store.record_cost_event(
        CostEvent(
            idempotency_key="a",
            agent_profile_id="agent_1",
            input_tokens=70,
            output_tokens=20,
            usage_status="actual",
        )
    )
    store.record_cost_event(
        CostEvent(idempotency_key="b", agent_profile_id="agent_2", input_tokens=999, usage_status="actual")
    )

    snapshot = BudgetPolicy().snapshot_from_store(
        store,
        scope="agent",
        scope_id="agent_1",
        hard_limits={"token_budget": 100},
        cost_governed=True,
    )

    assert snapshot.summary["total_tokens"] == 90
    assert snapshot.burn_down()[0].to_dict() == {
        "metric": "token_budget",
        "used": 90,
        "limit": 100,
        "remaining": 10,
        "ratio": 0.9,
        "exceeded": False,
        "source": "hard",
    }


def test_effective_limit_takes_strictest_positive_budget_layer():
    policy = BudgetPolicy()

    limit = policy.effective_limit(
        [
            BudgetLimit(token_budget=1_000, run_count_budget=10, source="company"),
            BudgetLimit(token_budget=750, external_tool_budget=5, source="agent"),
            BudgetLimit(token_budget=900, run_count_budget=3, source="issue"),
            BudgetLimit(token_budget=0, external_tool_budget=2, source="runtime"),
        ]
    )

    assert limit.token_budget == 750
    assert limit.run_count_budget == 3
    assert limit.external_tool_budget == 2


def test_budget_seconds_is_not_a_cost_budget():
    limit = BudgetLimit.from_mapping({"budget_seconds": 1, "token_budget": 0})

    assert limit.token_budget == 0
    assert limit.run_count_budget == 0


def test_soft_warning_reports_burn_down_before_hard_gate_blocks():
    snapshot = BudgetPolicy(soft_warning_threshold=0.8).build_snapshot(
        scope="company",
        scope_id="company_1",
        summary={"total_tokens": 81, "event_count": 1},
        hard_limits={"token_budget": 100, "run_count_budget": 10},
        cost_governed=True,
    )

    decision = BudgetPolicy(soft_warning_threshold=0.8).hard_gate(snapshot, action="chat")

    assert decision.allowed is True
    assert decision.reason_code == "within_budget"
    assert [warning.metric for warning in decision.warnings] == ["token_budget"]
    assert decision.burn_down[0].remaining == 19


def test_soft_limit_can_warn_without_hard_limit():
    snapshot = BudgetPolicy().build_snapshot(
        scope="chat",
        scope_id="session_1",
        summary={"event_count": 4},
        soft_limits={"run_count_budget": 4},
        cost_governed=False,
    )

    decision = BudgetPolicy().hard_gate(snapshot, action="chat")

    assert decision.allowed is True
    assert decision.warnings[0].metric == "run_count_budget"
    assert decision.warnings[0].exceeded is True


def test_hard_gate_blocks_declared_cost_governed_scope_at_limit():
    snapshot = BudgetPolicy().build_snapshot(
        scope="issue",
        scope_id="issue_1",
        summary={"total_tokens": 100, "event_count": 2},
        hard_limits={"token_budget": 100},
        cost_governed=True,
    )

    decision = BudgetPolicy().hard_gate(snapshot, action="checkout")

    assert decision.allowed is False
    assert decision.reason_code == "budget_limit_exceeded"
    assert decision.to_dict()["exceeded"][0]["metric"] == "token_budget"
    assert "issue issue_1 exceeded token_budget 100/100" in decision.message


def test_hard_gate_fails_closed_for_missing_governed_scope_id():
    snapshot = BudgetPolicy().build_snapshot(
        scope="company",
        scope_id="",
        summary={"total_tokens": 0},
        hard_limits={"token_budget": 100},
        cost_governed=True,
    )

    decision = BudgetPolicy().hard_gate(snapshot, action="run")

    assert decision.allowed is False
    assert decision.reason_code == "invalid_budget_scope"
    assert "missing company scope id" in decision.message


def test_hard_gate_is_report_only_for_ungoverned_scope():
    snapshot = BudgetPolicy().build_snapshot(
        scope="chat",
        scope_id="session_1",
        summary={"total_tokens": 150},
        hard_limits={"token_budget": 100},
        cost_governed=False,
    )

    decision = BudgetPolicy().hard_gate(snapshot, action="chat")

    assert decision.allowed is True
    assert decision.warnings[0].metric == "token_budget"
    assert decision.burn_down[0].exceeded is True


def test_budget_policy_supports_company_issue_and_chat_store_scopes(tmp_path):
    store = StateStore(tmp_path / "state.db")
    store.record_cost_event(
        CostEvent(
            idempotency_key="company",
            company_profile_id="company_1",
            issue_id="issue_1",
            chat_session_id="session_1",
            input_tokens=5,
            output_tokens=7,
        )
    )

    policy = BudgetPolicy()

    assert policy.snapshot_from_store(store, scope="company", scope_id="company_1").summary["total_tokens"] == 12
    assert policy.snapshot_from_store(store, scope="issue", scope_id="issue_1").summary["total_tokens"] == 12
    assert policy.snapshot_from_store(store, scope="chat", scope_id="session_1").summary["total_tokens"] == 12


def test_external_tool_budget_counts_existing_ledger_events(tmp_path):
    store = StateStore(tmp_path / "state.db")
    store.record_cost_event(
        CostEvent(
            idempotency_key="tool",
            company_profile_id="company_1",
            meter_kind=CostMeterKind.EXTERNAL_TOOL.value,
        )
    )

    snapshot = BudgetPolicy().snapshot_from_store(
        store,
        scope="company",
        scope_id="company_1",
        hard_limits={"external_tool_budget": 1},
        cost_governed=True,
    )
    decision = BudgetPolicy().hard_gate(snapshot, action="plugin task")

    assert snapshot.summary["external_tool_count"] == 1
    assert decision.allowed is False
    assert decision.exceeded[0].metric == "external_tool_budget"


def test_hard_budget_preflight_blocks_first_exceeded_governed_scope(tmp_path):
    store = StateStore(tmp_path / "state.db")
    store.record_cost_event(
        CostEvent(idempotency_key="company", company_profile_id="company_1", input_tokens=10)
    )
    store.record_cost_event(
        CostEvent(idempotency_key="chat", chat_session_id="chat_1", input_tokens=50)
    )

    preflight = hard_budget_preflight(
        store,
        [
            BudgetScopeCheck(
                scope="company",
                scope_id="company_1",
                cost_governed=True,
                hard_limits={"token_budget": 100},
            ),
            BudgetScopeCheck(
                scope="chat",
                scope_id="chat_1",
                cost_governed=True,
                hard_limits={"token_budget": 50},
            ),
        ],
        action="run_start",
    )

    payload = preflight.to_dict()
    assert preflight.allowed is False
    assert payload["reason_code"] == "budget_limit_exceeded"
    assert payload["blocked"][0]["scope"] == "chat"
    assert payload["blocked"][0]["exceeded"][0]["metric"] == "token_budget"


def test_hard_budget_preflight_fails_closed_for_missing_governed_scope_id(tmp_path):
    store = StateStore(tmp_path / "state.db")

    preflight = hard_budget_preflight(
        store,
        [
            {
                "scope": "issue",
                "scope_id": "",
                "cost_governed": True,
                "hard_limits": {"run_count_budget": 1},
            }
        ],
        action="checkout",
    )

    assert preflight.allowed is False
    assert preflight.to_dict()["reason_code"] == "invalid_budget_scope"


def test_hard_budget_preflight_allows_ungoverned_report_only_scope(tmp_path):
    store = StateStore(tmp_path / "state.db")
    store.record_cost_event(CostEvent(idempotency_key="issue", issue_id="issue_1", input_tokens=10))

    preflight = hard_budget_preflight(
        store,
        [
            BudgetScopeCheck(
                scope="issue",
                scope_id="issue_1",
                cost_governed=False,
                hard_limits={"token_budget": 1},
            )
        ],
        action="checkout",
    )

    assert preflight.allowed is True
    assert preflight.decisions[0].burn_down[0].exceeded is True
