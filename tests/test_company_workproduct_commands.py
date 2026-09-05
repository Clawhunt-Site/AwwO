"""P2: work_product.update write command.

The operator can curate an issue's delivery facts from chat — patch a work
product's mutable fields (status/title/url/summary/primary). Covered here:

  * dispatch: update patches via team_kernel.update_work_product;
  * risk: reversible field patch → LOW;
  * governance: a CONFINED agent is default-denied (operator-only curation);
  * scope: a cross-company target is forbidden; an unknown work product fails closed.

(work_product.delete is deliberately deferred — it is irreversible HIGH and the
existing direct-delete routes would bypass the human-approval gate; see the NOTE
in company_commands.py.)
"""

from __future__ import annotations

import pytest

from superclaw.company_commands import UpdateWorkProductCommand, get_command_model
from superclaw.company_handler import execute_company_command
from superclaw.company_scope import CompanyScope, CompanyScopeError
from superclaw.models import CompanyProfile, Issue, WorkProduct
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, *, name="Acme"):
    return store.save_company_profile(CompanyProfile(name=name, owner_id="u"))


def _wp(store, company_id, *, status="open"):
    iss = store.save_issue(Issue(title="T", company_profile_id=company_id))
    return store.save_work_product(
        WorkProduct(issue_id=iss.issue_id, company_profile_id=company_id, title="PR", status=status)
    )


def _operator(company_id):
    return CompanyScope(principal_id="u", actor_company_id=company_id, is_admin=True)


def _run(store, scope, command_type, args):
    cmd = get_command_model(command_type).from_dict(args)
    return execute_company_command(cmd, scope=scope, store=store, requested_by="u")


def test_update_patches_fields(store):
    c = _company(store)
    wp = _wp(store, c.company_profile_id)
    res = _run(store, _operator(c.company_profile_id), "work_product.update",
               {"work_product_id": wp.work_product_id, "status": "merged", "title": "PR v2"})
    assert res.outcome == "executed"
    saved = store.get_work_product(wp.work_product_id)
    assert saved.status == "merged" and saved.title == "PR v2"


def test_update_rejects_unknown_status(store):
    c = _company(store)
    wp = _wp(store, c.company_profile_id)
    with pytest.raises(ValueError):
        _run(store, _operator(c.company_profile_id), "work_product.update",
             {"work_product_id": wp.work_product_id, "status": "bogus"})


def test_confined_agent_denied_update(store):
    c = _company(store)
    wp = _wp(store, c.company_profile_id)
    conf = CompanyScope(principal_id="u", actor_company_id=c.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, conf, "work_product.update", {"work_product_id": wp.work_product_id, "title": "x"})


def test_cross_company_update_forbidden(store):
    a = _company(store, name="Acme")
    b = _company(store, name="Beta")
    foreign = _wp(store, b.company_profile_id)
    scoped_to_a = CompanyScope(principal_id="u", actor_company_id=a.company_profile_id, is_admin=False)
    with pytest.raises(CompanyScopeError):
        _run(store, scoped_to_a, "work_product.update", {"work_product_id": foreign.work_product_id, "title": "x"})


def test_unknown_work_product_fails_closed(store):
    c = _company(store)
    with pytest.raises(CompanyScopeError):
        _run(store, _operator(c.company_profile_id), "work_product.update",
             {"work_product_id": "wp_nope", "title": "x"})


def test_update_validation_fail_closed():
    with pytest.raises(ValueError):
        UpdateWorkProductCommand.from_dict({"work_product_id": "w1"}).validate()  # no fields
    with pytest.raises(ValueError):
        UpdateWorkProductCommand.from_dict({"work_product_id": "w1", "is_primary": "yes"}).validate()
    with pytest.raises(ValueError):
        UpdateWorkProductCommand.from_dict({"work_product_id": "w1", "bogus": 1})
