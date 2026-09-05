import json

import pytest

from superclaw.capability_atlas import (
    CAPABILITY_AVAILABILITIES,
    CAPABILITY_CATEGORIES,
    CAPABILITY_INTEGRATIONS,
    CapabilityAtlasError,
    CapabilityUnit,
    adaptable_capabilities,
    atlas_summary,
    category_matrix,
    coverage_report,
    get_capability,
    load_capability_atlas,
    search_capabilities,
    suggest_capabilities,
    validate_facets,
)


def _unit(**overrides) -> CapabilityUnit:
    base = {
        "capability_id": "sample-skill",
        "name": "Sample Skill",
        "category": "engineering",
        "origin": "self-built",
        "source_url": "https://example.test/sample-skill",
        "description": "Sample capability for tests.",
        "triggers": ("sample trigger",),
        "integration": "skill",
        "availability": "vendored",
    }
    base.update(overrides)
    return CapabilityUnit(**base)


def test_packaged_atlas_loads_with_valid_units():
    units = load_capability_atlas()

    assert len(units) >= 200
    assert len({unit.capability_id for unit in units}) == len(units)
    for unit in units:
        assert unit.category in CAPABILITY_CATEGORIES
        assert unit.availability in CAPABILITY_AVAILABILITIES
        assert unit.integration in CAPABILITY_INTEGRATIONS
        assert unit.description
        assert unit.source_url


def test_packaged_atlas_contains_anchor_units_from_every_origin():
    units = load_capability_atlas()
    by_id = {unit.capability_id: unit for unit in units}

    # adversarial-verification resolved to its own GitHub repo (was an empty
    # orphan submodule), so it is external with a dedicated source URL now.
    assert by_id["adversarial-verification"].availability == "external"
    assert by_id["adversarial-verification"].source_url.endswith("/adversarial-verification")
    assert by_id["semrush"].availability == "vendored"
    assert by_id["agent-orchestration"].origin == "wshobson-arsenal"
    assert by_id["weather"].origin == "openclaw-builtin"


def test_atlas_summary_counts_align_with_total():
    units = load_capability_atlas()
    summary = atlas_summary(atlas=units)

    assert summary["total"] == len(units)
    assert sum(summary["by_category"].values()) == len(units)
    assert sum(summary["by_availability"].values()) == len(units)
    assert summary["adaptable"] <= summary["total"]


def test_get_capability_is_case_insensitive_and_fails_loud():
    atlas = (_unit(),)

    assert get_capability("Sample-Skill", atlas=atlas).name == "Sample Skill"
    with pytest.raises(KeyError):
        get_capability("missing-skill", atlas=atlas)


def test_search_filters_by_query_and_facets():
    atlas = (
        _unit(),
        _unit(capability_id="seo-helper", name="SEO Helper", category="marketing-seo", description="Optimize search rankings.", triggers=("seo audit",)),
    )

    assert [unit.capability_id for unit in search_capabilities("seo", atlas=atlas)] == ["seo-helper"]
    assert [unit.capability_id for unit in search_capabilities(category="engineering", atlas=atlas)] == ["sample-skill"]
    assert search_capabilities("seo", category="engineering", atlas=atlas) == []


def test_suggest_capabilities_ranks_trigger_phrase_hits_first():
    atlas = (
        _unit(capability_id="video-maker", description="Render product videos.", triggers=("render video", "product video")),
        _unit(capability_id="video-notes", description="Take notes about video meetings.", triggers=("meeting notes",)),
    )

    suggestions = suggest_capabilities("please render video for the launch", atlas=atlas)

    assert suggestions
    assert suggestions[0]["capability"]["capability_id"] == "video-maker"
    assert "render video" in suggestions[0]["matched_triggers"]


def test_suggest_capabilities_matches_english_tokens_inside_mixed_language_goal():
    atlas = (
        _unit(capability_id="seo-audit-helper", description="Audits site SEO health.", triggers=("technical seo",)),
        _unit(capability_id="payment-webhook", description="Handles payment webhooks.", triggers=("payment webhook",)),
    )

    suggestions = suggest_capabilities("帮我做一个 seo audit 然后发布", atlas=atlas)

    assert [item["capability"]["capability_id"] for item in suggestions] == ["seo-audit-helper"]


def test_suggest_capabilities_returns_empty_for_blank_or_unrelated_goal():
    atlas = (_unit(triggers=("payment webhook",)),)

    assert suggest_capabilities("", atlas=atlas) == []
    assert suggest_capabilities("zzz qqq", atlas=atlas) == []


def test_suggest_capabilities_handles_nonpositive_limit():
    atlas = (_unit(triggers=("sample trigger",)),)

    assert suggest_capabilities("sample trigger", limit=0, atlas=atlas) == []
    assert suggest_capabilities("sample trigger", limit=-5, atlas=atlas) == []
    assert len(suggest_capabilities("sample trigger", limit=1, atlas=atlas)) == 1


def test_validate_facets_flags_typos_but_accepts_known_values():
    atlas = (_unit(origin="self-built"),)

    assert validate_facets(category="engineering", availability="vendored", integration="skill", atlas=atlas) == []
    assert validate_facets(origin="self-built", atlas=atlas) == []

    problems = validate_facets(
        category="bogus",
        availability="nope",
        integration="weird",
        origin="who",
        atlas=atlas,
    )
    assert len(problems) == 4
    assert any("unknown category" in problem for problem in problems)
    assert any("unknown origin" in problem for problem in problems)


def test_coverage_report_lists_declared_gaps_and_external_dependencies():
    atlas = (
        _unit(),
        _unit(capability_id="declared-skill", availability="declared"),
        _unit(capability_id="external-tool", availability="external", integration="tool"),
    )

    report = coverage_report(atlas=atlas)

    assert report["total"] == 3
    assert report["ready"] == 1
    assert [gap["id"] for gap in report["declared_gaps"]] == ["declared-skill"]
    assert [dep["id"] for dep in report["external_dependencies"]] == ["external-tool"]


def test_category_matrix_drops_empty_categories():
    atlas = (_unit(),)

    matrix = category_matrix(atlas=atlas)

    assert list(matrix) == ["engineering"]
    assert matrix["engineering"]["vendored"] == 1


def test_adaptable_excludes_external_availability_and_tool_integration():
    atlas = (
        _unit(),
        _unit(capability_id="external-skill", availability="external"),
        _unit(capability_id="local-tool", integration="tool", availability="local"),
        _unit(capability_id="local-plugin", integration="plugin", availability="local"),
    )

    assert [unit.capability_id for unit in adaptable_capabilities(atlas=atlas)] == ["sample-skill", "local-plugin"]


def test_load_rejects_malformed_atlas(tmp_path):
    bad_category = tmp_path / "bad-category.json"
    bad_category.write_text(
        json.dumps({"capabilities": [{"id": "x", "category": "nope", "integration": "skill", "availability": "vendored"}]}),
        encoding="utf-8",
    )
    with pytest.raises(CapabilityAtlasError):
        load_capability_atlas(bad_category)

    duplicate = tmp_path / "duplicate.json"
    entry = {
        "id": "dup",
        "category": "engineering",
        "integration": "skill",
        "availability": "vendored",
        "triggers": [],
    }
    duplicate.write_text(json.dumps({"capabilities": [entry, entry]}), encoding="utf-8")
    with pytest.raises(CapabilityAtlasError):
        load_capability_atlas(duplicate)

    missing = tmp_path / "missing.json"
    with pytest.raises(CapabilityAtlasError):
        load_capability_atlas(missing)
