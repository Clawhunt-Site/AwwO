from superclaw.team_routines import author_routine


def _base_spec(**overrides):
    spec = {
        "title": "Daily issue triage",
        "enabled": True,
        "owner_id": "local_user",
        "company_profile_id": "company_1",
        "workspace_id": "workspace_1",
        "agent_profile_id": "agent_1",
        "cadence": {"interval_sec": 3600},
        "issue_seed": {
            "title": "Review incoming issues",
            "description": "Summarize blockers and create follow-up tasks.",
            "priority": "medium",
        },
        "governance": {
            "requested_budget_seconds": 300,
            "max_budget_seconds": 600,
        },
    }
    spec.update(overrides)
    return spec


def _author(spec):
    return author_routine(
        spec,
        known_companies={"company_1"},
        known_workspaces={"workspace_1"},
        known_agents={"agent_1"},
        agent_company_map={"agent_1": "company_1"},
        workspace_company_map={"workspace_1": "company_1"},
    )


def test_valid_interval_routine_normalizes_to_schedule_payload():
    result = _author(_base_spec())

    assert result.status == "ready"
    assert result.valid is True
    assert result.schedule_ready is True
    assert result.proposal is not None
    payload = result.proposal.to_schedule_payload()
    assert payload["agent_profile_id"] == "agent_1"
    assert payload["company_profile_id"] == "company_1"
    assert payload["title"] == "Daily issue triage"
    assert payload["enabled"] is True
    assert payload["interval_sec"] == 3600
    assert payload["idempotency_key"].startswith("routine:")
    assert payload["context_snapshot"]["routine"]["issue_seed"]["title"] == "Review incoming issues"


def test_authoring_result_materializes_durable_schedule_definition():
    result = _author(_base_spec(cadence="1h"))

    schedule = result.to_team_routine_schedule(now=10.0)

    assert schedule.agent_profile_id == "agent_1"
    assert schedule.company_profile_id == "company_1"
    assert schedule.title == "Daily issue triage"
    assert schedule.enabled is True
    assert schedule.interval_sec == 3600
    assert schedule.next_run_at == 3610.0
    assert schedule.idempotency_key == result.proposal.idempotency_key
    assert schedule.context_snapshot["routine"]["references"]["workspace_id"] == "workspace_1"


def test_disabled_routine_is_valid_but_not_enabled():
    result = _author(_base_spec(enabled=False, cadence="1h"))

    assert result.status == "disabled"
    assert result.valid is True
    assert result.schedule_ready is True
    assert result.proposal is not None
    assert result.proposal.to_schedule_payload()["enabled"] is False


def test_invalid_cadence_fails_closed():
    result = _author(_base_spec(cadence="30s"))

    assert result.status == "invalid"
    assert result.valid is False
    assert result.schedule_ready is False
    assert any("at least 60 seconds" in error for error in result.errors)


def test_missing_required_references_fail_closed():
    result = author_routine(
        {
            "title": "Incomplete routine",
            "cadence": "1h",
            "issue_seed": {"title": "Do work"},
        }
    )

    assert result.status == "invalid"
    assert result.proposal is None
    assert {
        "owner_id is required",
        "company_profile_id is required",
        "workspace_id is required",
        "agent_profile_id is required",
    }.issubset(set(result.errors))


def test_high_risk_routine_requires_approval_before_schedule():
    result = _author(
        _base_spec(
            cadence={"kind": "cron", "cron": "0 */2 * * *"},
            governance={
                "risk_flags": ["payment"],
                "network_access": "open",
                "requested_budget_seconds": 300,
                "max_budget_seconds": 600,
            },
        )
    )

    assert result.status == "requires_approval"
    assert result.valid is True
    assert result.schedule_ready is False
    reasons = {approval.requested_permission["routine_authoring"] for approval in result.approvals_required}
    assert reasons == {"network_access", "payment"}
    assert result.proposal is not None
    assert result.proposal.cadence.interval_sec == 7200
    try:
        result.to_team_routine_schedule(now=10.0)
    except ValueError as exc:
        assert "not schedule-ready" in str(exc)
    else:
        raise AssertionError("approval-gated routine should not materialize a schedule")


def test_budget_escalation_requires_budget_override():
    result = _author(
        _base_spec(
            governance={
                "requested_budget_seconds": 1200,
                "max_budget_seconds": 600,
            }
        )
    )

    assert result.status == "requires_approval"
    assert result.schedule_ready is False
    assert [approval.type for approval in result.approvals_required] == ["budget_override"]
    assert result.approvals_required[0].requested_permission == {"routine_authoring": "budget_seconds"}


def test_context_absent_is_no_narrowing():
    """No ``context`` block → both axes None (inherit the agent's full grants)."""
    result = _author(_base_spec())
    assert result.proposal is not None
    ctx = result.proposal.context
    assert ctx.plugin_ids is None and ctx.skill_ids is None
    assert ctx.is_empty
    # The schedule payload still carries a stable (all-None) context shape.
    sched = result.proposal.to_schedule_payload()["context_snapshot"]["routine"]["context"]
    assert sched == {"plugin_ids": None, "skill_ids": None}


def test_context_distinguishes_none_from_empty_list():
    """Explicit ``[]`` (use zero plugins) must NOT collapse into None (inherit)."""
    result = _author(_base_spec(context={"plugin_ids": []}))
    assert result.proposal is not None
    ctx = result.proposal.context
    assert ctx.plugin_ids == []  # explicit empty preserved
    assert ctx.skill_ids is None  # the unspecified axis stays None
    assert not ctx.is_empty  # one axis IS specified


def test_context_subset_is_cleaned_deduped_and_roundtrips():
    spec = _base_spec(context={"plugin_ids": ["p1", "p2", "p1"], "skill_ids": ["s1"]})
    result = _author(spec)
    assert result.proposal is not None
    assert result.proposal.context.plugin_ids == ["p1", "p2"]  # order-preserving de-dupe
    assert result.proposal.context.skill_ids == ["s1"]
    # Idempotent round-trip through to_dict().
    second = _author(result.proposal.to_dict())
    assert second.proposal is not None
    assert second.proposal.context.to_dict() == result.proposal.context.to_dict()


def test_context_camelcase_aliases_accepted():
    result = _author(_base_spec(context={"pluginIds": ["x"], "skills": ["y"]}))
    assert result.proposal is not None
    assert result.proposal.context.plugin_ids == ["x"]
    assert result.proposal.context.skill_ids == ["y"]


def test_context_malformed_is_dropped_with_warning():
    """A present-but-non-object context is dropped to 'no narrowing' AND warned,
    so a wiring bug is visible at authoring instead of silently inheriting."""
    result = _author(_base_spec(context="git,fs"))
    assert result.proposal is not None
    assert result.proposal.context.is_empty  # no narrowing applied
    assert any("context must be an object" in w for w in result.warnings)


def test_context_changes_routine_identity():
    """Different per-fire context → a distinct routine (idempotency key differs)."""
    a = _author(_base_spec(context={"plugin_ids": ["p1"]}))
    b = _author(_base_spec(context={"plugin_ids": ["p2"]}))
    assert a.proposal is not None and b.proposal is not None
    assert a.proposal.idempotency_key != b.proposal.idempotency_key


def test_normalization_is_stable_and_idempotent():
    spec = _base_spec(
        metadata={"b": 2, "a": 1},
        governance={
            "risk_flags": ["network-open", "payment"],
            "approval_grants": ["payment", "network_access"],
            "requested_budget_seconds": 300,
            "max_budget_seconds": 600,
            "metadata": {"z": True, "a": False},
        },
    )
    first = _author(spec)
    assert first.status == "ready"
    assert first.proposal is not None

    second = _author(first.proposal.to_dict())

    assert second.status == "ready"
    assert second.proposal is not None
    assert second.proposal.to_dict() == first.proposal.to_dict()
