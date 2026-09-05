"""Company secrets + instance settings 内核不变量（Paperclip 拿取清单 §6 本地 v1）。

钉死的硬约束：
  1. 明文只从 resolve_* 返回；台账/列表/审计/异常永远只有掩码与哈希；
  2. 解析必经 binding 授权，无 binding → 拒绝 + denied 审计（fail-closed）；
  3. 归档 secret 不可解析；required binding 缺失/归档 → 目标不可调用（invokability 闸门，
     在 team_kernel.checkout_issue 强制执行）；
  4. master key：env 覆盖 > key 文件（0600 自动生成）；密文+key 缺一不可解；
  5. instance_settings 单例：general/experimental 两桶，未知桶拒绝。
"""

from __future__ import annotations

import base64
import json
import os

import pytest

from superclaw import secrets_store as ss
from superclaw.models import AgentProfile, Issue
from superclaw.state import StateStore


@pytest.fixture
def isolated_keys(tmp_path, monkeypatch):
    monkeypatch.delenv(ss.MASTER_KEY_ENV, raising=False)
    monkeypatch.setenv(ss.KEY_PATH_ENV, str(tmp_path / "secrets.key"))
    return tmp_path


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


# --- master key + crypto -----------------------------------------------------


def test_master_key_autogenerates_0600_and_is_stable(isolated_keys):
    key1 = ss.load_master_key()
    key_file = isolated_keys / "secrets.key"
    assert key_file.exists()
    if os.name == "posix":
        assert (key_file.stat().st_mode & 0o777) == 0o600
    assert ss.load_master_key() == key1  # 第二次读同一把


def test_master_key_env_override_beats_file(isolated_keys, monkeypatch):
    file_key = ss.load_master_key()
    env_key = b"\x01" * 32
    monkeypatch.setenv(ss.MASTER_KEY_ENV, base64.b64encode(env_key).decode())
    assert ss.load_master_key() == env_key != file_key


def test_master_key_env_invalid_fails_closed(isolated_keys, monkeypatch):
    monkeypatch.setenv(ss.MASTER_KEY_ENV, "definitely-not-32-bytes!")
    with pytest.raises(ss.SecretStoreError, match="32-byte"):
        ss.load_master_key()


def test_encrypt_roundtrip_and_tamper_detection(isolated_keys):
    material = ss._encrypt("hunter2-but-longer")
    assert material["scheme"] == "local_encrypted_v1"
    assert "hunter2" not in json.dumps(material)
    assert ss._decrypt(material) == "hunter2-but-longer"
    tampered = dict(material, ciphertext=base64.b64encode(b"x" * 16).decode())
    with pytest.raises(ss.SecretStoreError, match="decryption failed"):
        ss._decrypt(tampered)


def test_decrypt_with_wrong_key_fails_closed(isolated_keys, monkeypatch):
    material = ss._encrypt("topsecret-value")
    monkeypatch.setenv(ss.MASTER_KEY_ENV, base64.b64encode(b"\x02" * 32).decode())
    with pytest.raises(ss.SecretStoreError, match="decryption failed"):
        ss._decrypt(material)


# --- ledger lifecycle（永远掩码） ---------------------------------------------


def test_create_list_summary_never_contains_plaintext(isolated_keys, store):
    summary = ss.create_secret(store, name="github-token", value="ghp_PLAINTEXT_VALUE", description="CI token")
    assert summary["current_version"] == 1
    blob = json.dumps(ss.list_secret_summaries(store)) + json.dumps(summary)
    assert "PLAINTEXT" not in blob
    # 数据库里的所有行也不含明文
    raw = json.dumps([s.to_dict() for s in store.list_secrets()])
    assert "PLAINTEXT" not in raw


def test_create_duplicate_name_rejected(isolated_keys, store):
    ss.create_secret(store, name="dup", value="v1")
    with pytest.raises(ss.SecretStoreError, match="already exists"):
        ss.create_secret(store, name="dup", value="v2")


def test_rotate_bumps_version_and_keeps_old_material(isolated_keys, store):
    ss.create_secret(store, name="api-key", value="old-value-123")
    summary = ss.rotate_secret(store, name="api-key", value="new-value-456")
    assert summary["current_version"] == 2
    secret = store.find_secret_by_name("api-key")
    assert ss._decrypt(store.get_secret_version(secret.secret_id, 1).material) == "old-value-123"
    assert ss._decrypt(store.get_secret_version(secret.secret_id, 2).material) == "new-value-456"


def test_archive_blocks_rotate_and_delete_removes_versions(isolated_keys, store):
    ss.create_secret(store, name="gone", value="v")
    ss.set_secret_archived(store, name="gone", archived=True)
    with pytest.raises(ss.SecretStoreError, match="archived"):
        ss.rotate_secret(store, name="gone", value="v2")
    secret_id = store.find_secret_by_name("gone").secret_id
    ss.delete_secret(store, name="gone")
    assert store.find_secret_by_name("gone") is None
    with pytest.raises(KeyError):
        store.get_secret_version(secret_id, 1)
    # 审计事件在删除后存活
    actions = [e.action for e in store.list_secret_access_events(secret_id=secret_id)]
    assert "delete" in actions and "create" in actions


# --- binding 门 + 审计 --------------------------------------------------------


def test_resolve_without_binding_denied_and_audited(isolated_keys, store):
    ss.create_secret(store, name="locked", value="nope")
    with pytest.raises(ss.SecretStoreError, match="access denied"):
        ss.resolve_secret(store, name="locked", target_type="agent_profile", target_id="agent_x")
    secret_id = store.find_secret_by_name("locked").secret_id
    events = store.list_secret_access_events(secret_id=secret_id)
    denied = [e for e in events if e.action == "denied"]
    assert denied and denied[0].target_id == "agent_x"


def test_resolve_with_binding_returns_plaintext_and_audits(isolated_keys, store):
    ss.create_secret(store, name="ok", value="the-plain-value")
    ss.bind_secret(store, name="ok", target_type="agent_profile", target_id="agent_1", config_path="MY_TOKEN")
    value = ss.resolve_secret(store, name="ok", target_type="agent_profile", target_id="agent_1", run_id="run_9")
    assert value == "the-plain-value"
    secret_id = store.find_secret_by_name("ok").secret_id
    resolves = [e for e in store.list_secret_access_events(secret_id=secret_id) if e.action == "resolve"]
    assert resolves and resolves[0].run_id == "run_9"


def test_archived_secret_never_resolves_even_with_binding(isolated_keys, store):
    ss.create_secret(store, name="cold", value="v")
    ss.bind_secret(store, name="cold", target_type="agent_profile", target_id="a", config_path="X")
    ss.set_secret_archived(store, name="cold", archived=True)
    with pytest.raises(ss.SecretStoreError, match="archived"):
        ss.resolve_secret(store, name="cold", target_type="agent_profile", target_id="a")


def test_bind_validates_target_type_and_config_path(isolated_keys, store):
    ss.create_secret(store, name="s", value="v")
    with pytest.raises(ss.SecretStoreError, match="target type"):
        ss.bind_secret(store, name="s", target_type="martian", target_id="x", config_path="E")
    with pytest.raises(ss.SecretStoreError, match="config_path"):
        ss.bind_secret(store, name="s", target_type="plugin", target_id="x", config_path="  ")


def test_resolve_env_for_target_collects_bindings_and_skips_optional_archived(isolated_keys, store):
    ss.create_secret(store, name="a", value="va")
    ss.create_secret(store, name="b", value="vb")
    ss.bind_secret(store, name="a", target_type="backend", target_id="clawwork", config_path="ENV_A")
    ss.bind_secret(store, name="b", target_type="backend", target_id="clawwork", config_path="ENV_B", required=False)
    ss.set_secret_archived(store, name="b", archived=True)
    env = ss.resolve_env_for_target(store, target_type="backend", target_id="clawwork")
    assert env == {"ENV_A": "va"}  # optional+archived 的 b 被跳过
    ss.set_secret_archived(store, name="a", archived=True)
    with pytest.raises(ss.SecretStoreError, match="not invokable"):
        ss.resolve_env_for_target(store, target_type="backend", target_id="clawwork")


# --- invokability 闸门 --------------------------------------------------------


def _seed_agent_issue(store):
    profile = AgentProfile(name="Eng", role="engineer")
    store.save_agent_profile(profile)
    issue = Issue(title="ship", assignee_agent_profile_id=profile.profile_id, status="todo")
    store.save_issue(issue)
    return profile, issue


def test_invokability_ok_without_bindings_and_with_live_required(isolated_keys, store):
    assert ss.check_invokability(store, target_type="agent_profile", target_id="anyone").ok
    ss.create_secret(store, name="t", value="v")
    ss.bind_secret(store, name="t", target_type="agent_profile", target_id="p1", config_path="T")
    assert ss.check_invokability(store, target_type="agent_profile", target_id="p1").ok


def test_checkout_blocked_when_required_secret_archived(isolated_keys, store):
    from superclaw.team_kernel import checkout_issue

    profile, issue = _seed_agent_issue(store)
    ss.create_secret(store, name="deploy-key", value="v")
    ss.bind_secret(
        store, name="deploy-key", target_type="agent_profile",
        target_id=profile.profile_id, config_path="DEPLOY_KEY",
    )
    ss.set_secret_archived(store, name="deploy-key", archived=True)
    with pytest.raises(ValueError, match="not invokable"):
        checkout_issue(store, issue.issue_id, run_id="run_1")
    # 修复后（restore）即可签出
    ss.set_secret_archived(store, name="deploy-key", archived=False)
    assert checkout_issue(store, issue.issue_id, run_id="run_1").status == "in_progress"


def test_checkout_blocked_when_required_secret_deleted_but_optional_passes(isolated_keys, store):
    from superclaw.team_kernel import checkout_issue

    profile, issue = _seed_agent_issue(store)
    ss.create_secret(store, name="tmp", value="v")
    binding = ss.bind_secret(
        store, name="tmp", target_type="agent_profile",
        target_id=profile.profile_id, config_path="TMP",
    )
    ss.delete_secret(store, name="tmp")
    # delete_secret 级联删 binding → 闸门放行
    assert ss.check_invokability(store, target_type="agent_profile", target_id=profile.profile_id).ok
    # 重新造一个被删 secret 的悬空 binding（直接写 store 模拟历史数据）
    binding.secret_id = "secret_ghost"
    store.save_secret_binding(binding)
    result = ss.check_invokability(store, target_type="agent_profile", target_id=profile.profile_id)
    assert not result.ok and "deleted" in result.reason()
    with pytest.raises(ValueError, match="not invokable"):
        checkout_issue(store, issue.issue_id, run_id="run_2")


# --- instance settings --------------------------------------------------------


def test_instance_settings_singleton_roundtrip_and_unset(store):
    payload = ss.update_instance_settings(store, bucket="general", patch={"keyboard_shortcuts": True})
    assert payload["general"]["keyboard_shortcuts"] is True
    payload = ss.update_instance_settings(store, bucket="experimental", patch={"enable_daemon": False})
    assert payload["experimental"] == {"enable_daemon": False}
    assert payload["general"] == {"keyboard_shortcuts": True}  # 两桶互不串
    payload = ss.update_instance_settings(store, bucket="general", patch={"keyboard_shortcuts": None})
    assert payload["general"] == {}
    # 单例：重读同一行
    assert ss.get_instance_settings(store)["experimental"] == {"enable_daemon": False}


def test_instance_settings_unknown_bucket_rejected(store):
    with pytest.raises(ss.SecretStoreError, match="bucket"):
        ss.update_instance_settings(store, bucket="space", patch={"x": 1})


# --- 契约 + CLI 冒烟 -----------------------------------------------------------


def test_secrets_contract_shape():
    from superclaw.ui_contracts import build_secrets_contract

    contract = build_secrets_contract()
    ready = [p for p in contract["providers"] if p["ready"]]
    assert [p["id"] for p in ready] == ["local_encrypted"]
    assert "agent_profile" in contract["binding_target_types"]
    assert contract["masking"]["plaintext_never_listed"] is True
    assert contract["instance_settings_buckets"] == ["general", "experimental"]


def test_cli_secret_and_instance_smoke(isolated_keys, tmp_path, monkeypatch):
    from typer.testing import CliRunner

    import superclaw.cli as cli_module

    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    monkeypatch.setattr(cli_module, "_state_path", lambda: tmp_path / "state.db")
    runner = CliRunner()

    created = runner.invoke(cli_module.app, ["secret", "create", "ci-token", "--stdin"], input="sk-PLAINTEXT\n")
    assert created.exit_code == 0, created.output
    assert "PLAINTEXT" not in created.output

    listed = runner.invoke(cli_module.app, ["secret", "list", "--json"])
    assert listed.exit_code == 0, listed.output
    assert "PLAINTEXT" not in listed.output
    assert json.loads(listed.output)[0]["name"] == "ci-token"

    bound = runner.invoke(cli_module.app, [
        "secret", "bind", "ci-token",
        "--target-type", "agent_profile", "--target-id", "p1", "--env", "CI_TOKEN",
    ])
    assert bound.exit_code == 0, bound.output

    log = runner.invoke(cli_module.app, ["secret", "access-log", "ci-token"])
    assert log.exit_code == 0 and "create" in log.output and "bind" in log.output

    # 删除后审计遗迹仍可按名字找回（从 delete 事件恢复 secret_id，Gemini 验收修复项）
    deleted = runner.invoke(cli_module.app, ["secret", "delete", "ci-token", "--yes"])
    assert deleted.exit_code == 0, deleted.output
    ghost_log = runner.invoke(cli_module.app, ["secret", "access-log", "ci-token"])
    assert ghost_log.exit_code == 0 and "delete" in ghost_log.output and "create" in ghost_log.output

    set_result = runner.invoke(cli_module.app, ["instance", "set", "general", "keyboard_shortcuts", "true"])
    assert set_result.exit_code == 0, set_result.output
    shown = runner.invoke(cli_module.app, ["instance", "settings", "--json"])
    assert json.loads(shown.output)["general"]["keyboard_shortcuts"] is True


# --- Codex 验收阻断项的回归锁 ---------------------------------------------------


def test_create_with_unusable_key_leaves_no_dangling_ledger_row(isolated_keys, store, monkeypatch):
    """加密失败必须发生在任何台账写入之前：不存在"活 secret 无 material"。"""
    monkeypatch.setenv(ss.MASTER_KEY_ENV, "not-a-valid-key")
    with pytest.raises(ss.SecretStoreError, match="32-byte"):
        ss.create_secret(store, name="broken", value="v")
    assert store.find_secret_by_name("broken") is None
    assert store.list_secrets() == []


def test_invokability_fails_when_material_missing_or_undecryptable(isolated_keys, store, monkeypatch):
    """闸门必须验证"真可解"：version 行缺失或 master key 不可用都不可调用。"""
    ss.create_secret(store, name="k", value="v")
    ss.bind_secret(store, name="k", target_type="agent_profile", target_id="p", config_path="K")
    assert ss.check_invokability(store, target_type="agent_profile", target_id="p").ok
    # 模拟 version 行丢失（直接删版本，台账仍 current_version=1）
    secret = store.find_secret_by_name("k")
    with store._connect() as conn:
        conn.execute("DELETE FROM company_secret_versions WHERE secret_id = ?", (secret.secret_id,))
    result = ss.check_invokability(store, target_type="agent_profile", target_id="p")
    assert not result.ok and "material missing" in result.reason()
    # 模拟 master key 不可用（先用 A key 加密，再换成 B key 去解）
    monkeypatch.setenv(ss.MASTER_KEY_ENV, base64.b64encode(b"\x07" * 32).decode())
    ss.create_secret(store, name="k2", value="v2")  # 用错 key 加密的新 secret 自身可解
    monkeypatch.setenv(ss.MASTER_KEY_ENV, base64.b64encode(b"\x08" * 32).decode())
    ss.bind_secret(store, name="k2", target_type="agent_profile", target_id="p2", config_path="K2")
    result = ss.check_invokability(store, target_type="agent_profile", target_id="p2")
    assert not result.ok and "unresolvable" in result.reason()


def test_bindings_are_company_scoped(isolated_keys, store):
    """同名 target 跨 company 不得互相阻断/污染（阶段 1 company_id 作用域）。"""
    ss.create_secret(store, name="shared-name", value="va", company_profile_id="co_a")
    ss.create_secret(store, name="shared-name", value="vb", company_profile_id="co_b")
    ss.bind_secret(
        store, name="shared-name", target_type="backend", target_id="clawwork",
        config_path="TOKEN_A", company_profile_id="co_a",
    )
    ss.bind_secret(
        store, name="shared-name", target_type="backend", target_id="clawwork",
        config_path="TOKEN_B", company_profile_id="co_b",
    )
    env_a = ss.resolve_env_for_target(store, target_type="backend", target_id="clawwork", company_profile_id="co_a")
    assert env_a == {"TOKEN_A": "va"}  # B 公司的 binding 不进 A 的解析
    # A 公司把 secret 归档 → 只有 A 的同名 target 不可调用，B 不受影响
    ss.set_secret_archived(store, name="shared-name", archived=True, company_profile_id="co_a")
    assert not ss.check_invokability(store, target_type="backend", target_id="clawwork", company_profile_id="co_a").ok
    assert ss.check_invokability(store, target_type="backend", target_id="clawwork", company_profile_id="co_b").ok


def test_key_file_rejects_symlink_and_permissive_mode(isolated_keys, tmp_path, monkeypatch):
    real = tmp_path / "real.key"
    ss.load_master_key()  # 生成默认 key 文件
    key_file = isolated_keys / "secrets.key"
    if os.name == "posix":
        key_file.chmod(0o644)
        with pytest.raises(ss.SecretStoreError, match="group/world"):
            ss.load_master_key()
        key_file.chmod(0o600)
    # symlink 拒绝
    import base64 as _b64
    real.write_text(_b64.b64encode(b"\x05" * 32).decode())
    real.chmod(0o600)
    link = tmp_path / "link.key"
    link.symlink_to(real)
    monkeypatch.setenv(ss.KEY_PATH_ENV, str(link))
    with pytest.raises(ss.SecretStoreError, match="symlink"):
        ss.load_master_key()


def test_key_file_creation_race_loser_reads_winner(isolated_keys, monkeypatch):
    """O_EXCL 输家不得裸抛：回读赢家的 key（双 key 会让一半密文报废）。"""
    winner_key = ss.load_master_key()  # 文件已存在
    real_exists = type(isolated_keys).exists

    def fake_exists(self):
        if self == isolated_keys / "secrets.key":
            return False  # 骗 load 走创建路径 → O_EXCL 撞 FileExistsError
        return real_exists(self)

    monkeypatch.setattr(type(isolated_keys), "exists", fake_exists)
    assert ss.load_master_key() == winner_key


def test_cli_stdin_preserves_multiline_value(isolated_keys, tmp_path, monkeypatch):
    from typer.testing import CliRunner

    import superclaw.cli as cli_module

    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    monkeypatch.setattr(cli_module, "_state_path", lambda: tmp_path / "state.db")
    runner = CliRunner()
    pem = "-----BEGIN KEY-----\nline-one\nline-two\n-----END KEY-----\n"
    created = runner.invoke(cli_module.app, ["secret", "create", "ssh-key", "--stdin"], input=pem)
    assert created.exit_code == 0, created.output
    store = StateStore(tmp_path / "state.db")
    ss.bind_secret(store, name="ssh-key", target_type="runtime", target_id="t", config_path="SSH")
    value = ss.resolve_secret(store, name="ssh-key", target_type="runtime", target_id="t")
    assert value == pem[:-1]  # 只去掉最后一个换行，内部换行原样保留


def test_cli_access_log_ghost_recovery_is_company_scoped(isolated_keys, tmp_path, monkeypatch):
    """跨公司同名 secret 删除后，access-log 遗迹回溯必须只回本公司的 secret_id。"""
    from typer.testing import CliRunner

    import superclaw.cli as cli_module

    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell-config.json"))
    monkeypatch.setattr(cli_module, "_state_path", lambda: tmp_path / "state.db")
    store = StateStore(tmp_path / "state.db")
    ss.create_secret(store, name="dup-name", value="va", company_profile_id="co_a")
    ss.create_secret(store, name="dup-name", value="vb", company_profile_id="co_b")
    id_a = store.find_secret_by_name("dup-name", company_profile_id="co_a").secret_id
    id_b = store.find_secret_by_name("dup-name", company_profile_id="co_b").secret_id
    ss.delete_secret(store, name="dup-name", company_profile_id="co_a")
    ss.delete_secret(store, name="dup-name", company_profile_id="co_b")

    runner = CliRunner()
    log_a = runner.invoke(cli_module.app, ["secret", "access-log", "dup-name", "--company", "co_a", "--json"])
    assert log_a.exit_code == 0, log_a.output
    events = json.loads(log_a.output)
    assert events and all(e["secret_id"] == id_a for e in events)
    assert all(e["secret_id"] != id_b for e in events)
