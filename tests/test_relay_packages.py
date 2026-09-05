"""super 套餐（package/tier）目录的展示不变量。

对应内核 superclaw/relay_packages.py —— 把 LLMgate 裸模型抽象成 ClawHunt 主站定义的
super 套餐（core/plus/max）。钉死的硬约束：

  1. 登录后才发实网查询；未登录返回默认 floor + available=False；
  2. 查询优先级 catalog(/api/v1/bridge/packages) → groups(/api/v1/groups) → 默认；
  3. fail-safe：任何网络/解析失败一律降级默认，绝不外抛；
  4. 永不把 relay 裸模型 id 当套餐暴露（只认 tier 短名或 superclaw-* slug）；
  5. 套餐选择翻译成 group slug（plus → superclaw-plus）再发 relay。
"""

from __future__ import annotations

import httpx
import pytest

from superclaw import relay_key as rk
from superclaw import relay_packages as rp
from superclaw.clawhunt_auth import save_clawhunt_auth


@pytest.fixture
def isolated_env(tmp_path, monkeypatch):
    """隔离 auth 文件与 relay 相关环境变量（与 test_relay_key 同口径）。"""
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(tmp_path / "clawhunt-auth.json"))
    monkeypatch.setenv(rk.DEVICE_ID_PATH_ENV, str(tmp_path / "device-id"))
    monkeypatch.delenv(rk.RELAY_KEY_ENV, raising=False)
    monkeypatch.delenv(rk.RELAY_KEY_HYDRATED_ENV, raising=False)
    monkeypatch.delenv(rk.RELAY_BASE_URL_ENV, raising=False)
    monkeypatch.delenv(rk.RELAY_BRIDGE_URL_ENV, raising=False)
    monkeypatch.delenv(rp._PACKAGES_PATH_ENV, raising=False)
    monkeypatch.delenv(rp._CATALOG_TOKEN_ENV, raising=False)
    monkeypatch.delenv(rp._GROUPS_TOKEN_ENV, raising=False)
    monkeypatch.setattr(rk, "_payagent_device_id", lambda: None)
    return tmp_path


def _login(monkeypatch):
    """模拟已登录：显式 base + 已发放 relay key。"""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-pkgkey1"})


# ---------------------------------------------------------------------------
# 1. 纯转换函数
# ---------------------------------------------------------------------------

def test_default_packages_are_core_plus_max():
    pkgs = rp.default_relay_packages()
    assert [p["id"] for p in pkgs] == ["core", "plus", "max"]
    assert pkgs[1] == {"id": "plus", "name": "plus", "tier": "plus", "group_slug": "superclaw-plus"}


def test_packages_from_groups_normalizes_slug_and_keeps_name():
    groups = [
        {"slug": "superclaw-core", "name": "Core Pack"},
        {"slug": "superclaw-max", "name": "Max"},
    ]
    pkgs = rp.packages_from_groups(groups)
    assert pkgs == [
        {"id": "core", "name": "Core Pack", "tier": "core", "group_slug": "superclaw-core"},
        {"id": "max", "name": "Max", "tier": "max", "group_slug": "superclaw-max"},
    ]


def test_packages_from_groups_rejects_non_superclaw_groups():
    # 非 superclaw-* 的分组（别的产品线）绝不混进套餐列表。
    groups = [{"slug": "openai-passthrough", "name": "Raw"}, {"slug": "superclaw-plus"}]
    pkgs = rp.packages_from_groups(groups)
    assert [p["id"] for p in pkgs] == ["plus"]


def test_packages_from_catalog_flexible_schema_and_rejects_raw_models():
    items = [
        {"id": "superclaw-core", "display_name": "Core Pack"},
        {"id": "plus"},
        {"id": "gpt-4o"},          # 裸模型 id → 拒绝
        {"tier": "max", "label": "Max Tier"},
    ]
    pkgs = rp.packages_from_catalog(items)
    assert [p["id"] for p in pkgs] == ["core", "plus", "max"]
    assert pkgs[0]["name"] == "Core Pack"
    assert pkgs[2]["name"] == "Max Tier"


def test_catalog_dedupes_by_id():
    items = [{"id": "plus"}, {"id": "superclaw-plus", "name": "dup"}]
    assert [p["id"] for p in rp.packages_from_catalog(items)] == ["plus"]


def test_catalog_rejects_injected_raw_group_slug():
    # A hostile/misconfigured catalog must not smuggle a raw model id in as the
    # group_slug (would echo a raw model in CLI/API JSON and, if execution uses
    # dynamic packages, route straight at it). Only superclaw-* slugs are honored,
    # and a custom slug is allowed only for a NON-canonical (dynamic) package.
    items = [
        {"id": "plus", "group_slug": "gpt-4o"},                       # raw → rejected
        {"id": "superclaw-pro", "group_slug": "superclaw-pro-beta"},  # dynamic + superclaw-* → kept
    ]
    pkgs = rp.packages_from_catalog(items)
    by_id = {p["id"]: p["group_slug"] for p in pkgs}
    assert by_id["plus"] == "superclaw-plus"            # canonical, NOT gpt-4o
    assert by_id["pro"] == "superclaw-pro-beta"          # dynamic custom superclaw-* kept


def test_catalog_cannot_hijack_canonical_tier_slug():
    # The catalog may ADD packages but must not REDIRECT a standard tier's routing
    # (fail-closed: a buggy/hostile catalog can't silently reroute a paid tier).
    # This also keeps display == execution for tiers without a run-time live lookup.
    items = [{"id": "plus", "group_slug": "superclaw-plus-2026"}]
    pkgs = rp.packages_from_catalog(items)
    assert pkgs[0]["group_slug"] == "superclaw-plus"  # canonical wins over catalog override


@pytest.mark.parametrize("value,expect", [
    ("plus", "plus"),
    ("superclaw-plus", "plus"),
    ("MAX", "max"),
    ("gpt-4o", None),
    ("", None),
])
def test_normalize_relay_package_id(value, expect):
    assert rp.normalize_relay_package_id(value) == expect


def test_clawwork_contract_marks_relay_packages():
    # The relay-backed runtime declares it via contract (surfaces never hardcode
    # the backend name): clawwork → uses_relay_packages, others → not.
    from superclaw.ui_contracts import AGENT_CONTROL_SPECS

    assert AGENT_CONTROL_SPECS["clawwork"].get("uses_relay_packages") is True
    assert AGENT_CONTROL_SPECS["codex"].get("uses_relay_packages") in (None, False)


def test_group_slug_for_package_prefers_dynamic_then_static():
    dyn = [{"id": "plus", "group_slug": "superclaw-plus-2026"}]
    assert rp.relay_group_slug_for_package("plus", dyn) == "superclaw-plus-2026"
    # 无动态列表 → 静态映射
    assert rp.relay_group_slug_for_package("max") == "superclaw-max"
    # 未知 → 原样返回（让 relay 自己 fail-closed）
    assert rp.relay_group_slug_for_package("mystery") == "mystery"


# ---------------------------------------------------------------------------
# 2. relay_packages() 编排：登录门 + 优先级 + fail-safe
# ---------------------------------------------------------------------------

def test_packages_unavailable_without_login(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    # 未发放 relay key → 不发实网查询。
    def handler(request):  # pragma: no cover - 不应被调用
        raise AssertionError(f"网络不应被触发: {request.url}")

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    assert out["available"] is False
    assert out["source"] == "default"
    assert [p["id"] for p in out["packages"]] == ["core", "plus", "max"]


def test_packages_available_with_clawhunt_login_without_cached_key(isolated_env, monkeypatch):
    # Logged-in口径与 ClawWorkBackend.available() 一致：ClawHunt access_token 但还没缓存
    # relay key 也算可用（run() 会经 bridge 自动发放）。否则"已登录但 key 未缓存"的用户
    # 会被错误地挡在套餐之外（顾问对抗项 #1）。
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"access_token": "tok-abc"})  # 登录但无 relay key
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["hit"] = True
        return httpx.Response(200, json=[{"id": "plus"}])

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    assert out["available"] is True
    assert seen.get("hit") is True  # 已登录 → 发了实网查询
    assert [p["id"] for p in out["packages"]] == ["plus"]


def test_packages_prefers_dynamic_catalog(isolated_env, monkeypatch):
    _login(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/bridge/packages"
        return httpx.Response(200, json=[{"id": "superclaw-core", "display_name": "Core"}, {"id": "plus"}])

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    assert out["available"] is True
    assert out["source"] == "catalog"
    assert [p["id"] for p in out["packages"]] == ["core", "plus"]
    assert out["packages"][0]["name"] == "Core"


def test_packages_falls_back_to_groups(isolated_env, monkeypatch):
    _login(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/packages":
            return httpx.Response(404, json={"detail": "not found"})
        assert request.url.path == "/api/v1/groups"
        return httpx.Response(200, json=[{"slug": "superclaw-max", "name": "Max"}])

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    assert out["source"] == "groups"
    assert [p["id"] for p in out["packages"]] == ["max"]


def test_packages_default_floor_when_relay_exposes_nothing(isolated_env, monkeypatch):
    _login(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={})

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    # 已登录但 relay 未暴露目录 → 默认 floor，但 available 仍为 True。
    assert out["available"] is True
    assert out["source"] == "default"
    assert [p["id"] for p in out["packages"]] == ["core", "plus", "max"]


def test_packages_fail_safe_on_transport_error(isolated_env, monkeypatch):
    _login(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("relay down")

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    assert out["source"] == "default"
    assert out["available"] is True
    assert [p["id"] for p in out["packages"]] == ["core", "plus", "max"]


def test_catalog_custom_path_and_token_header(isolated_env, monkeypatch):
    _login(monkeypatch)
    monkeypatch.setenv(rp._PACKAGES_PATH_ENV, "superclaw/catalog")
    monkeypatch.setenv(rp._CATALOG_TOKEN_ENV, "secret-token")
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["token"] = request.headers.get("X-Bridge-Catalog-Token")
        return httpx.Response(200, json=[{"id": "plus"}])

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    assert seen["path"] == "/api/v1/superclaw/catalog"
    assert seen["token"] == "secret-token"
    assert out["source"] == "catalog"


def test_groups_optional_bearer_token(isolated_env, monkeypatch):
    _login(monkeypatch)
    monkeypatch.setenv(rp._GROUPS_TOKEN_ENV, "grp-token")
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/packages":
            return httpx.Response(404, json={})
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json=[{"slug": "superclaw-core"}])

    rp.relay_packages(transport=httpx.MockTransport(handler))
    assert seen["auth"] == "Bearer grp-token"


@pytest.mark.parametrize("body,expect", [
    ([{"id": "plus"}], ["plus"]),
    ({"packages": [{"id": "core"}]}, ["core"]),
    ({"data": [{"id": "superclaw-max"}]}, ["max"]),
    ({"models": [{"id": "plus"}, {"id": "core"}]}, ["plus", "core"]),
])
def test_catalog_response_shapes(isolated_env, monkeypatch, body, expect):
    _login(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    assert [p["id"] for p in out["packages"]] == expect


def test_packages_never_leak_relay_key(isolated_env, monkeypatch):
    import json as _json
    _login(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"id": "plus"}])

    out = rp.relay_packages(transport=httpx.MockTransport(handler))
    assert "sk-llmgate-pkgkey1" not in _json.dumps(out)


# ---------------------------------------------------------------------------
# 3. CLI 表层：superclaw relay packages（与内核零偏差）
# ---------------------------------------------------------------------------

def _cli():
    import json as _json

    from typer.testing import CliRunner

    import superclaw.cli as cli_module

    return CliRunner(), cli_module, _json


def test_cli_relay_packages_json(isolated_env, monkeypatch):
    runner, cli_module, _json = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))
    monkeypatch.setattr(
        cli_module, "relay_packages",
        lambda: {
            "packages": [
                {"id": "core", "name": "core", "tier": "core", "group_slug": "superclaw-core"},
                {"id": "plus", "name": "Plus Tier", "tier": "plus", "group_slug": "superclaw-plus"},
            ],
            "source": "catalog",
            "available": True,
        },
    )
    result = runner.invoke(cli_module.app, ["relay", "packages", "--json"])
    assert result.exit_code == 0, result.output
    payload = _json.loads(result.output)
    assert payload["source"] == "catalog" and payload["available"] is True
    assert [p["id"] for p in payload["packages"]] == ["core", "plus"]


def test_cli_relay_packages_human_lists_tiers(isolated_env, monkeypatch):
    runner, cli_module, _ = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))
    monkeypatch.setattr(
        cli_module, "relay_packages",
        lambda: {
            "packages": [{"id": "plus", "name": "Plus Tier", "tier": "plus", "group_slug": "superclaw-plus"}],
            "source": "groups",
            "available": True,
        },
    )
    result = runner.invoke(cli_module.app, ["relay", "packages"])
    assert result.exit_code == 0, result.output
    assert "source=groups" in result.output
    assert "plus" in result.output and "Plus Tier" in result.output


def test_cli_relay_packages_login_required_floor(isolated_env, monkeypatch):
    runner, cli_module, _ = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))
    monkeypatch.setattr(
        cli_module, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": False},
    )
    result = runner.invoke(cli_module.app, ["relay", "packages"])
    assert result.exit_code == 0, result.output
    assert "login required" in result.output
