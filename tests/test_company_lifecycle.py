"""Company lifecycle state + active-status guard (design contract B5 foundation).

See docs/company-chat-management-design.md.
"""

from __future__ import annotations

import pytest

from superclaw.company_lifecycle import CompanyFrozenError, assert_company_active
from superclaw.models import CompanyProfile, CompanyStatus
from superclaw.state import StateStore


def test_new_company_defaults_to_active_epoch_one():
    company = CompanyProfile(name="Acme")
    assert company.status == CompanyStatus.ACTIVE.value
    assert company.epoch == 1
    assert company.is_active is True
    assert company.is_dissolved is False


def test_status_properties_track_state():
    frozen = CompanyProfile(name="Acme", status=CompanyStatus.FROZEN.value)
    assert frozen.is_active is False
    assert frozen.is_dissolved is False

    dissolved = CompanyProfile(name="Acme", status=CompanyStatus.DISSOLVED.value)
    assert dissolved.is_active is False
    assert dissolved.is_dissolved is True


def test_to_dict_from_dict_round_trips_lifecycle_fields():
    company = CompanyProfile(name="Acme", status=CompanyStatus.FROZEN.value, epoch=4)
    restored = CompanyProfile.from_dict(company.to_dict())
    assert restored.status == CompanyStatus.FROZEN.value
    assert restored.epoch == 4


def test_legacy_row_without_lifecycle_fields_deserializes_active():
    # A row persisted before contract B5 has no status/epoch keys; defaults
    # must keep it ACTIVE @ epoch 1 (backward compatible, no migration).
    legacy = {"name": "Acme", "company_profile_id": "company_legacy"}
    company = CompanyProfile.from_dict(legacy)
    assert company.status == CompanyStatus.ACTIVE.value
    assert company.epoch == 1
    assert company.is_active is True


def test_assert_company_active_passes_for_active():
    assert_company_active(CompanyProfile(name="Acme"))  # no raise


@pytest.mark.parametrize("status", [CompanyStatus.FROZEN.value, CompanyStatus.DISSOLVED.value])
def test_assert_company_active_rejects_non_active(status):
    company = CompanyProfile(name="Acme", company_profile_id="company_x", status=status)
    with pytest.raises(CompanyFrozenError) as exc:
        assert_company_active(company)
    assert exc.value.company_profile_id == "company_x"
    assert exc.value.status == status


def test_assert_company_active_fails_closed_on_unknown_status():
    # An unknown/garbled status must be treated as non-active, not allowed.
    company = CompanyProfile(name="Acme", status="totally-bogus")
    with pytest.raises(CompanyFrozenError):
        assert_company_active(company)


def test_company_frozen_error_is_value_error():
    # Governance-error convention: 4xx-mappable ValueError subclass.
    assert issubclass(CompanyFrozenError, ValueError)


def test_lifecycle_fields_persist_through_state_store(tmp_path):
    store = StateStore(tmp_path / "superclaw.db")
    company = CompanyProfile(name="Acme", status=CompanyStatus.FROZEN.value, epoch=7)
    store.save_company_profile(company)

    loaded = store.get_company_profile(company.company_profile_id)
    assert loaded.status == CompanyStatus.FROZEN.value
    assert loaded.epoch == 7
    assert loaded.is_active is False
