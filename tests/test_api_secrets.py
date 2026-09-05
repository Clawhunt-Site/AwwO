"""Secrets / InstanceSettings 的 API 表层契约（零偏差：同一内核函数，CLI 同语义）。

钉死的硬约束：
  1. API 永远不返回明文：列表/创建/轮换响应只有掩码台账元数据；没有 resolve 端点；
  2. 错误映射：not found → 404，其余 SecretStoreError → 400，detail 不含明文；
  3. access-log 的删除遗迹回溯与 CLI 共用 find_audit_secret_id（单一定义点）；
  4. control token 在场时所有 secrets 端点都要带 token。
"""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw import secrets_store as ss


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_CONTROL_TOKEN", raising=False)
    monkeypatch.setenv(ss.KEY_PATH_ENV, str(tmp_path / "secrets.key"))
    monkeypatch.delenv(ss.MASTER_KEY_ENV, raising=False)
    app = create_app(state_path=tmp_path / "state.db")
    return TestClient(app)


def test_secrets_crud_masked_and_no_resolve_endpoint(client):
    created = client.post("/api/secrets", json={"name": "gh-token", "value": "ghp_PLAINTEXT", "description": "ci"})
    assert created.status_code == 200, created.text
    assert "PLAINTEXT" not in created.text

    listed = client.get("/api/secrets")
    assert listed.status_code == 200
    assert "PLAINTEXT" not in listed.text
    assert listed.json()["secrets"][0]["name"] == "gh-token"

    rotated = client.post("/api/secrets/gh-token/rotate", json={"value": "ghp_PLAINTEXT2"})
    assert rotated.status_code == 200 and rotated.json()["secret"]["current_version"] == 2
    assert "PLAINTEXT" not in rotated.text

    # 没有 resolve 端点（明文不出 API）
    assert client.get("/api/secrets/gh-token/resolve").status_code in (404, 405)
    assert client.post("/api/secrets/gh-token/resolve", json={}).status_code in (404, 405)


def test_secrets_error_mapping(client):
    assert client.post("/api/secrets/ghost/rotate", json={"value": "v"}).status_code == 404
    client.post("/api/secrets", json={"name": "dup", "value": "v"})
    duplicate = client.post("/api/secrets", json={"name": "dup", "value": "v2"})
    assert duplicate.status_code == 400
    assert "already exists" in duplicate.json()["detail"]
    bad_bind = client.post(
        "/api/secrets/dup/bindings",
        json={"target_type": "martian", "target_id": "x", "env": "E"},
    )
    assert bad_bind.status_code == 400


def test_bindings_invokability_and_access_log_roundtrip(client):
    client.post("/api/secrets", json={"name": "deploy", "value": "v1"})
    bound = client.post(
        "/api/secrets/deploy/bindings",
        json={"target_type": "agent_profile", "target_id": "p1", "env": "DEPLOY"},
    )
    assert bound.status_code == 200, bound.text
    binding_id = bound.json()["binding"]["binding_id"]

    rows = client.get("/api/secrets/bindings", params={"target_type": "agent_profile", "target_id": "p1"})
    assert [b["binding_id"] for b in rows.json()["bindings"]] == [binding_id]

    ok = client.get("/api/secrets/invokability", params={"target_type": "agent_profile", "target_id": "p1"})
    assert ok.json()["ok"] is True

    archived = client.post("/api/secrets/deploy/archive", json={"archived": True})
    assert archived.status_code == 200
    blocked = client.get("/api/secrets/invokability", params={"target_type": "agent_profile", "target_id": "p1"})
    assert blocked.json()["ok"] is False and "deploy" in blocked.json()["reason"]

    removed = client.delete(f"/api/secrets/bindings/{binding_id}")
    assert removed.status_code == 200
    assert client.delete(f"/api/secrets/bindings/{binding_id}").status_code == 404

    # access-log：归档/绑定/解绑全在审计里；删除后按名字仍可回溯（ghost recovery）
    log = client.get("/api/secrets/deploy/access-log")
    actions = {e["action"] for e in log.json()["events"]}
    assert {"create", "bind", "unbind", "archive"} <= actions
    deleted = client.delete("/api/secrets/deploy")
    assert deleted.status_code == 200
    ghost = client.get("/api/secrets/deploy/access-log")
    assert ghost.status_code == 200
    assert "delete" in {e["action"] for e in ghost.json()["events"]}
    assert client.get("/api/secrets/never-existed/access-log").status_code == 404


def test_instance_settings_buckets(client):
    patched = client.patch("/api/instance-settings/general", json={"patch": {"keyboard_shortcuts": True}})
    assert patched.status_code == 200
    assert patched.json()["general"]["keyboard_shortcuts"] is True
    unknown = client.patch("/api/instance-settings/space", json={"patch": {"x": 1}})
    assert unknown.status_code == 400
    shown = client.get("/api/instance-settings")
    assert shown.json()["general"] == {"keyboard_shortcuts": True}
    cleared = client.patch("/api/instance-settings/general", json={"patch": {"keyboard_shortcuts": None}})
    assert cleared.json()["general"] == {}


def test_secrets_contract_endpoint(client):
    contract = client.get("/api/secrets/contract")
    assert contract.status_code == 200
    payload = contract.json()
    assert payload["instance_settings_buckets"] == ["general", "experimental"]
    assert payload["masking"]["plaintext_never_listed"] is True


def test_control_token_guards_secrets_surfaces(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    monkeypatch.setenv(ss.KEY_PATH_ENV, str(tmp_path / "secrets.key"))
    monkeypatch.setenv(ss.MASTER_KEY_ENV, base64.b64encode(b"\x01" * 32).decode())
    client = TestClient(create_app(state_path=tmp_path / "state.db"))
    assert client.get("/api/secrets").status_code in (401, 403)
    assert client.post("/api/secrets", json={"name": "n", "value": "v"}).status_code in (401, 403)
    assert client.get("/api/instance-settings").status_code in (401, 403)
    headers = {"X-SuperClaw-Token": "secret-control"}
    assert client.get("/api/secrets", headers=headers).status_code == 200
    assert client.get("/api/instance-settings", headers=headers).status_code == 200


def test_audit_actor_cannot_be_forged_by_client(client):
    """API 审计主体由服务端派生：请求体里的 actor 字段被忽略（CLI 没有的能力，表层不得新增）。"""
    created = client.post("/api/secrets", json={"name": "forge", "value": "v", "actor": "evil-actor"})
    assert created.status_code == 200, created.text
    log = client.get("/api/secrets/forge/access-log")
    actors = {e["actor"] for e in log.json()["events"]}
    assert actors == {"api_user"}


def test_bindings_endpoint_filters_by_secret_and_company(client):
    client.post("/api/secrets", json={"name": "f1", "value": "v", "company": "co_a"})
    client.post("/api/secrets", json={"name": "f2", "value": "v", "company": "co_a"})
    client.post("/api/secrets/f1/bindings", json={"target_type": "plugin", "target_id": "x", "env": "E1", "company": "co_a"})
    client.post("/api/secrets/f2/bindings", json={"target_type": "plugin", "target_id": "x", "env": "E2", "company": "co_a"})
    only_f1 = client.get("/api/secrets/bindings", params={"secret": "f1", "company": "co_a"})
    assert [b["config_path"] for b in only_f1.json()["bindings"]] == ["E1"]
    assert client.get("/api/secrets/bindings", params={"secret": "ghost", "company": "co_a"}).status_code == 404
