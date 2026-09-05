"""relay key 链（clawwork ↔ LLMgate bridge）的安全与编排不变量。

对应内核模块 superclaw/relay_key.py；服务端契约是 PaySwitch-LLMgate 的
/api/v1/bridge（exchange → scoped bridge token → keys/ensure|rotate）。

钉死的硬约束：
  1. 解析链优先级：env 手动覆盖 > 本地缓存 > 自动 ensure > fail-closed；
  2. 主站 token / key 明文绝不出现在 status 输出里（只有掩码前缀）；
  3. 服务端已有同名 key 但本地无明文 → 自动走 rotate，绝不无限增发；
  4. 未登录 / 409 冲突 / 桥未开启 → 可操作的 RelayKeyError，不静默；
  5. hydrate 把缓存 key 注入 SUPERCLAW_RELAY_API_KEY，但绝不覆盖显式 env。
"""

from __future__ import annotations

import json

import httpx
import pytest

from superclaw import relay_key as rk
from superclaw.clawhunt_auth import (
    hydrate_clawhunt_auth_environment,
    load_clawhunt_auth,
    save_clawhunt_auth,
)


@pytest.fixture
def isolated_env(tmp_path, monkeypatch):
    """隔离 auth 文件 / device-id / 相关环境变量。"""
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(tmp_path / "clawhunt-auth.json"))
    monkeypatch.setenv(rk.DEVICE_ID_PATH_ENV, str(tmp_path / "device-id"))
    monkeypatch.setenv(rk.RELAY_LOCK_PATH_ENV, str(tmp_path / "relay-key.lock"))
    monkeypatch.setenv(rk.RELAY_AUDIT_PATH_ENV, str(tmp_path / "relay-audit.jsonl"))
    monkeypatch.delenv(rk.RELAY_KEY_ENV, raising=False)
    # provenance 标记由 _set_hydrated_env 直接写 os.environ（非 monkeypatch），
    # 每个测试开始时清，防止跨测试泄漏
    monkeypatch.delenv(rk.RELAY_KEY_HYDRATED_ENV, raising=False)
    monkeypatch.delenv(rk.RELAY_BASE_URL_ENV, raising=False)
    monkeypatch.delenv(rk.RELAY_BRIDGE_URL_ENV, raising=False)
    # ceiling 刷新（cached_or_refresh_tier_ceiling）触网走 CLAWHUNT_BASE_URL：指向不可达 loopback
    # 端口，让 best-effort 刷新瞬间 connection-refused 回退 core，保证测试 hermetic 且不久等
    # （注入 _FakeMeClient 的 refresh 测试 client 不经 URL，不受影响）。
    monkeypatch.setenv("CLAWHUNT_BASE_URL", "http://127.0.0.1:9")
    # payagent 设备 id 文件可能在本机存在：屏蔽掉，保证测试确定性
    monkeypatch.setattr(rk, "_payagent_device_id", lambda: None)
    return tmp_path


def _mock_bridge(handler) -> rk.RelayBridgeClient:
    # 白名单 host：exchange 的可信闸门始终强制（不靠"注入 transport 跳过"——那是被
    # 否决的绕过）。mock 走真实白名单路径（host 命中即过，MockTransport 拦住实际网络）。
    return rk.RelayBridgeClient(
        base_url="https://api.clawhunt.site", transport=httpx.MockTransport(handler)
    )


def _ok_bridge(*, ensure_created: bool = True, rotate_calls: list | None = None):
    """正常服务端：exchange 成功；ensure 按参数返回 created；rotate 永远发新 key。"""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v1/bridge/exchange":
            body = json.loads(request.content)
            assert "access_token" in body and "device_id" in body
            return httpx.Response(200, json={
                "bridge_token": "bt-test", "token_type": "bearer",
                "expires_in_seconds": 600, "user_id": 1,
                "auth_source": "clawhunt_bridge", "account_created": True,
            })
        if path == "/api/v1/bridge/keys/ensure":
            assert request.headers["Authorization"] == "Bearer bt-test"
            payload = {
                "id": 1, "name": "superclaw-clawwork:dev-1", "key_prefix": "sk-llmgate-en...",
                "quota_limit": "2.0", "rate_limit": 30, "credits_used": "0",
                "expires_at": None, "status": "active", "is_active": True,
                "created": ensure_created,
                "key": "sk-llmgate-ensure-PLAINTEXT" if ensure_created else None,
            }
            return httpx.Response(200, json=payload)
        if path == "/api/v1/bridge/keys/rotate":
            if rotate_calls is not None:
                rotate_calls.append(1)
            return httpx.Response(200, json={
                "id": 2, "name": "superclaw-clawwork:dev-1", "key_prefix": "sk-llmgate-ro...",
                "quota_limit": "2.0", "rate_limit": 30, "credits_used": "0",
                "expires_at": None, "status": "active", "is_active": True,
                "created": True, "key": "sk-llmgate-rotate-PLAINTEXT",
            })
        raise AssertionError(f"unexpected path {path}")

    return handler


# ---------------------------------------------------------------------------
# 1. 解析链优先级
# ---------------------------------------------------------------------------

def test_env_key_wins_over_stored(isolated_env, monkeypatch):
    # 用户显式 export 先于 hydrate（真实顺序）：env 无 provenance 标记 → 算手动逃生口
    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-manual")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-stored"})
    key, source = rk.resolve_relay_api_key()
    assert key == "sk-llmgate-manual"
    assert source == "env"


def test_stored_key_used_when_no_env(isolated_env):
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-stored"})
    key, source = rk.resolve_relay_api_key()
    assert key == "sk-llmgate-stored"
    assert source == "stored"


def test_unset_chain(isolated_env):
    key, source = rk.resolve_relay_api_key()
    assert key is None
    assert source == "unset"


def test_ensure_short_circuits_on_env(isolated_env, monkeypatch):
    """env 手动覆盖时 ensure 不触网（mock 网络会 assert 失败）。"""
    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-manual-key-xyz")

    def explode(request):  # pragma: no cover - 不应被调用
        raise AssertionError("network must not be touched")

    summary = rk.ensure_relay_key(client=_mock_bridge(explode))
    assert summary["source"] == "env"
    assert summary["ensured"] is False
    assert "sk-llmgate-manual-key-xyz" not in json.dumps(summary)  # 不漏明文


def test_ensure_short_circuits_on_stored(isolated_env):
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-stored", "relay_key_prefix": "sk-llmgate-st..."})

    def explode(request):  # pragma: no cover
        raise AssertionError("network must not be touched")

    summary = rk.ensure_relay_key(client=_mock_bridge(explode))
    assert summary["source"] == "stored"
    assert "sk-llmgate-stored" not in json.dumps(summary)


def test_ensure_fail_closed_without_login(isolated_env):
    with pytest.raises(rk.RelayKeyError, match="RELAY_LOGIN_REQUIRED"):
        rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))


@pytest.mark.parametrize("app_env", ["staging", "production"])
def test_exchange_sends_canonical_environment(isolated_env, monkeypatch, app_env):
    """exchange 请求体必须携带本构建的 canonical 环境，供中转站回源对应 ClawHunt
    验真——staging token 缺该信号会被生产主站拒（跨环境验真失败）。"""
    monkeypatch.setenv("APP_ENV", app_env)
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/bridge/exchange"
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "bridge_token": "bt", "token_type": "bearer", "expires_in_seconds": 600,
            "user_id": 1, "auth_source": "clawhunt_bridge", "account_created": True,
        })

    _mock_bridge(handler).exchange("hunt-token", "dev-1")
    assert captured["body"]["environment"] == app_env
    assert captured["body"]["access_token"] == "hunt-token"
    assert captured["body"]["device_id"] == "dev-1"


# ---------------------------------------------------------------------------
# 2. 自动发放与持久化
# ---------------------------------------------------------------------------

def test_ensure_provisions_and_persists(isolated_env, monkeypatch):
    save_clawhunt_auth({"access_token": "main-site-token"})
    summary = rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    assert summary["source"] == "auto"
    assert summary["ensured"] is True
    # 摘要绝不含明文
    assert "PLAINTEXT" not in json.dumps(summary)
    # 明文持久化到 auth 文件 + 注水进 env
    auth = load_clawhunt_auth()
    assert auth["relay_api_key"] == "sk-llmgate-ensure-PLAINTEXT"
    assert auth["relay_key_source"] == "auto"
    import os

    assert os.environ[rk.RELAY_KEY_ENV] == "sk-llmgate-ensure-PLAINTEXT"
    # 第二次 ensure 走 stored，不再触网
    def explode(request):  # pragma: no cover
        raise AssertionError("second ensure must not touch network")

    monkeypatch.delenv(rk.RELAY_KEY_ENV)  # 模拟新进程：env 由 hydrate 重新注入
    again = rk.ensure_relay_key(client=_mock_bridge(explode))
    assert again["source"] == "stored"


def test_ensure_rotates_when_server_has_key_but_plaintext_lost(isolated_env):
    """服务端 created=false（同名 key 已存在）而本地无明文 → 必须 rotate。"""
    save_clawhunt_auth({"access_token": "main-site-token"})
    rotate_calls: list = []
    summary = rk.ensure_relay_key(
        client=_mock_bridge(_ok_bridge(ensure_created=False, rotate_calls=rotate_calls))
    )
    assert rotate_calls, "ensure must fall back to rotate when plaintext is unrecoverable"
    assert load_clawhunt_auth()["relay_api_key"] == "sk-llmgate-rotate-PLAINTEXT"
    assert summary["source"] == "auto"


def test_explicit_rotate(isolated_env):
    save_clawhunt_auth({"access_token": "main-site-token", "relay_api_key": "sk-llmgate-old"})
    rotate_calls: list = []
    summary = rk.ensure_relay_key(
        rotate=True,
        client=_mock_bridge(_ok_bridge(rotate_calls=rotate_calls)),
    )
    assert rotate_calls
    assert summary["rotated"] is True
    assert load_clawhunt_auth()["relay_api_key"] == "sk-llmgate-rotate-PLAINTEXT"


def test_clear_relay_key(isolated_env, monkeypatch):
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-stored", "relay_key_name": "n", "relay_key_prefix": "p"})
    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-stored")
    assert rk.clear_relay_key() is True
    auth = load_clawhunt_auth()
    assert "relay_api_key" not in auth
    import os

    assert rk.RELAY_KEY_ENV not in os.environ


# ---------------------------------------------------------------------------
# 3. 服务端错误 → 可操作错误（fail-closed）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "status_code,match",
    [
        (401, "RELAY_EXCHANGE_REJECTED"),
        (404, "RELAY_BRIDGE_DISABLED"),
        (409, "RELAY_EMAIL_CONFLICT"),
        (429, "RELAY_RATE_LIMITED"),
        (503, "RELAY_BRIDGE_STAGING_UNAVAILABLE"),
        (422, "RELAY_BRIDGE_BAD_ENVIRONMENT"),
    ],
)
def test_exchange_errors_are_actionable(isolated_env, status_code, match):
    save_clawhunt_auth({"access_token": "main-site-token"})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json={"detail": "x"})

    with pytest.raises(rk.RelayKeyError, match=match):
        rk.ensure_relay_key(client=_mock_bridge(handler))


# ---------------------------------------------------------------------------
# 4. hydrate / status 的脱敏与不覆盖
# ---------------------------------------------------------------------------

def test_hydrate_injects_relay_key(isolated_env):
    import os

    save_clawhunt_auth({"relay_api_key": "sk-llmgate-stored"})
    os.environ.pop(rk.RELAY_KEY_ENV, None)
    applied = hydrate_clawhunt_auth_environment()
    assert rk.RELAY_KEY_ENV in applied
    assert os.environ[rk.RELAY_KEY_ENV] == "sk-llmgate-stored"


def test_hydrate_never_overwrites_explicit_env(isolated_env, monkeypatch):
    import os

    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-manual")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-stored"})
    hydrate_clawhunt_auth_environment()
    assert os.environ[rk.RELAY_KEY_ENV] == "sk-llmgate-manual"


def test_status_is_masked(isolated_env):
    save_clawhunt_auth({
        "relay_api_key": "sk-llmgate-super-secret-value",
        "relay_key_prefix": "sk-llmgate-su...",
        "relay_key_name": "superclaw-clawwork:dev-1",
    })
    payload = rk.relay_status()
    assert payload["relay_key"] == "set"
    assert "sk-llmgate-super-secret-value" not in json.dumps(payload)


# ---------------------------------------------------------------------------
# 5. 设备 id 与 bridge URL 解析
# ---------------------------------------------------------------------------

def test_device_id_persists_and_sanitizes(isolated_env):
    first = rk.superclaw_device_id()
    second = rk.superclaw_device_id()
    assert first == second
    assert rk._DEVICE_ID_SAFE_RE.search(first) is None
    assert 1 <= len(first) <= 64


def test_payagent_device_id_preferred(isolated_env, monkeypatch):
    monkeypatch.setattr(rk, "_payagent_device_id", lambda: "PAY device/01")
    assert rk.superclaw_device_id() == "PAY-device-01"


def test_bridge_url_resolution(isolated_env, monkeypatch):
    assert rk.relay_bridge_base_url() == rk.DEFAULT_BRIDGE_BASE_URL
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    assert rk.relay_bridge_base_url() == "https://api.clawhunt.site"
    monkeypatch.setenv(rk.RELAY_BRIDGE_URL_ENV, "http://127.0.0.1:8001/")
    assert rk.relay_bridge_base_url() == "http://127.0.0.1:8001"


def test_bridge_does_not_derive_non_allowlisted_relay_host(isolated_env, monkeypatch):
    """relay API and the access_token bridge can live on different hosts (relay
    gate.clawhunt.site vs bridge api.clawhunt.site). Deriving the bridge from a
    non-allowlisted relay host would surface READY then fail the exchange at the
    allowlist (adversarial review #4), so it must fall back to the canonical bridge."""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://gate.clawhunt.site/v1")
    monkeypatch.delenv(rk.RELAY_BRIDGE_URL_ENV, raising=False)
    assert rk.relay_bridge_base_url() == rk.DEFAULT_BRIDGE_BASE_URL
    assert rk._is_allowed_bridge_url(rk.relay_bridge_base_url()) is True


# ---------------------------------------------------------------------------
# 6. 顾问评审阻断项的回归保护
# ---------------------------------------------------------------------------

def test_status_no_write_side_effect(isolated_env):
    """status 是只读命令：绝不生成 device-id 文件（顾问 #4）。"""
    payload = rk.relay_status()
    assert payload["device_id"] == "pending"
    assert not rk.device_id_path().exists()


def test_status_ignores_polluted_prefix_field(isolated_env):
    """auth 文件里 relay_key_prefix 被污染成完整 key 也无所谓：status 根本不读它，

    prefix 一律从明文 key 本地重算（顾问 #3）。"""
    leaked = "sk-llmgate-FULL-SECRET-aaaaaaaaaaaaaaaaaaaaaaaa"
    save_clawhunt_auth({
        "relay_api_key": "sk-llmgate-realkeyaaaaaaaaaaaaaaaa",
        "relay_key_prefix": leaked,
    })
    payload = rk.relay_status()
    assert leaked not in json.dumps(payload)
    assert payload["relay_key_prefix"].endswith("...")


def test_ensure_summary_masks_polluted_prefix(isolated_env):
    """服务端若返回超长 key_prefix（bug/stub），ensure summary 也本地兜底截断。"""
    save_clawhunt_auth({"access_token": "main-site-token"})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": True})
        return httpx.Response(200, json={
            "name": "superclaw-clawwork:dev", "key_prefix": "sk-llmgate-LEAKED-WHOLE-KEY-zzzzzzzzzz",
            "quota_limit": "2.0", "rate_limit": 30, "expires_at": None,
            "created": True, "key": "sk-llmgate-real-PLAINTEXT",
        })

    summary = rk.ensure_relay_key(client=_mock_bridge(handler))
    assert "LEAKED-WHOLE-KEY" not in summary["key_prefix"]
    assert summary["key_prefix"].endswith("...")


def test_network_error_becomes_actionable(isolated_env):
    """httpx 网络异常 → RelayKeyError，不向用户抛裸 traceback（顾问 #4）。"""
    save_clawhunt_auth({"access_token": "main-site-token"})

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with pytest.raises(rk.RelayKeyError, match="RELAY_UNREACHABLE"):
        rk.ensure_relay_key(client=_mock_bridge(handler))


def test_rotate_ensure_interleave_stays_consistent(isolated_env):
    """rotate 与普通 ensure 并发交错：锁串行化保证最终 env 与缓存一致，不留 stale。

    顾问 #4：普通 ensure 的 stored 命中已移进锁内，rotate 持锁吊销+建新时，
    ensure 拿锁后重读到的是 rotate 写完的新值，绝不会注入即将被吊销的旧 key。
    """
    import threading

    # 同账号（sub:3）已有 auto key（带 owner）；rotate 与 ensure 交错都在同账号下。
    save_clawhunt_auth({
        "access_token": "main-site-token",
        "account_user": {"id": 3},
        "relay_api_key": "sk-llmgate-initial-key",
        "relay_key_owner": "sub:3",
    })

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": False})
        return httpx.Response(200, json={
            "name": "superclaw-clawwork:dev", "key_prefix": "sk-llmgate-ro...",
            "quota_limit": "2.0", "rate_limit": 30, "expires_at": None,
            "created": True, "key": "sk-llmgate-rotated-fresh-key",
        })

    barrier = threading.Barrier(2)

    def do_rotate():
        barrier.wait()
        rk.ensure_relay_key(rotate=True, client=_mock_bridge(handler))

    def do_ensure():
        barrier.wait()
        rk.ensure_relay_key(client=_mock_bridge(handler))

    threads = [threading.Thread(target=do_rotate), threading.Thread(target=do_ensure)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 关键不变量：落盘的 key 与进程内 env 一致（无 stale env 注入已吊销 key）
    import os

    final_stored = load_clawhunt_auth()["relay_api_key"]
    assert os.environ.get(rk.RELAY_KEY_ENV) == final_stored


def test_logout_clears_relay_env(isolated_env, monkeypatch):
    """clear_clawhunt_auth（logout 路径）必须一并清掉进程内 relay env，

    否则长生命周期 backend 里用户退出后 relay key 仍在 env，绕过 fail-closed（顾问 #2）。
    """
    import os

    from superclaw.clawhunt_auth import clear_clawhunt_auth

    save_clawhunt_auth({"relay_api_key": "sk-llmgate-x", "access_token": "t"})
    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-x")
    clear_clawhunt_auth()
    assert rk.RELAY_KEY_ENV not in os.environ


@pytest.mark.parametrize(
    "polluted",
    ["sk-bad", "short", "x" * 200, "not-a-key-prefix-but-long-enough-zzzzzzzz"],
)
def test_status_rejects_non_key_pollution(isolated_env, polluted):
    """status 的 prefix 从明文 key 重算并经 key 格式白名单；任何非法明文 → 占位，不回显。"""
    save_clawhunt_auth({"relay_api_key": polluted})
    payload = rk.relay_status()
    assert polluted not in json.dumps(payload)
    assert payload["relay_key_prefix"] in ("set", "unset")


def test_mask_key_rejects_non_string_and_bad_format():
    assert rk._mask_key(["sk-llmgate-x"]) == "set"
    assert rk._mask_key({"k": "v"}) == "set"
    assert rk._mask_key("plain-garbage") == "set"
    assert rk._mask_key("sk-llmgate-abcdefghijklmnop").endswith("...")
    assert rk._mask_key("") == "unset"


def _simulate_other_process_rotate(new_key: str) -> None:
    """模拟另一进程 rotate：直接改 auth 文件（不经 save_clawhunt_auth，

    因为 save 在本进程会触发 hydrate 刷新本进程 env，掩盖跨进程不共享 env 的本质）。
    """
    from superclaw.clawhunt_auth import clawhunt_auth_path

    path = clawhunt_auth_path()
    data = json.loads(path.read_text(encoding="utf-8"))
    data["relay_api_key"] = new_key
    path.write_text(json.dumps(data), encoding="utf-8")


def test_stale_hydrated_env_not_treated_as_manual(isolated_env):
    """跨进程 stale env 闭合（顾问 #4 第三轮）：

    本进程 P hydrate 出 old（带 provenance 标记）；另一进程 R rotate 把 auth 改成
    new（不影响 P 的 env）。P 再 ensure 时绝不能把 stale old 当手动逃生口返回，必须
    进锁、刷新 env 为 new、按 stored 返回。
    """
    import os

    # auto key 在账号归属机制下必带 owner；这里模拟同账号（sub:7）的跨进程 rotate，
    # owner 不变、只有 relay_api_key 被另一进程改写。
    save_clawhunt_auth({
        "access_token": "t",
        "account_user": {"id": 7},
        "relay_api_key": "sk-llmgate-oldkeyaaaaaaaa",
        "relay_key_owner": "sub:7",
    })
    rk.hydrate_relay_environment()  # P: env=old + 标记
    assert os.environ[rk.RELAY_KEY_ENV] == "sk-llmgate-oldkeyaaaaaaaa"
    assert os.environ.get(rk.RELAY_KEY_HYDRATED_ENV) == "1"

    _simulate_other_process_rotate("sk-llmgate-newkeybbbbbbbb")  # R rotate，P 的 env 仍 old

    def explode(request):  # pragma: no cover - 必须走 stored，不触网
        raise AssertionError("stale hydrated env must not trigger network/exchange")

    summary = rk.ensure_relay_key(client=_mock_bridge(explode))
    assert summary["source"] == "stored"
    # 关键：stale env 已被刷新为 new，P 不会继续用已吊销的 old
    assert os.environ[rk.RELAY_KEY_ENV] == "sk-llmgate-newkeybbbbbbbb"


def test_status_reflects_stored_over_stale_hydrated_env(isolated_env):
    """status 对 stale hydrate env 显示当前 stored（new），不显示 env 旧值（old）。"""
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-oldkeyaaaaaaaa"})
    rk.hydrate_relay_environment()
    _simulate_other_process_rotate("sk-llmgate-newkeybbbbbbbb")
    payload = rk.relay_status()
    assert payload["relay_key_source"] == "stored"
    # 不泄露任何完整 key，且展示的是基于 new 的截断
    assert "sk-llmgate-oldkeyaaaaaaaa" not in json.dumps(payload)
    assert payload["relay_key_prefix"].endswith("...")


def _simulate_other_process_clear() -> None:
    """模拟另一进程 logout/clear：直接删 auth 文件里的 relay_api_key（不影响本进程 env）。"""
    from superclaw.clawhunt_auth import clawhunt_auth_path

    path = clawhunt_auth_path()
    data = json.loads(path.read_text(encoding="utf-8"))
    data.pop("relay_api_key", None)
    path.write_text(json.dumps(data), encoding="utf-8")


def test_stale_hydrated_env_cleared_when_stored_emptied(isolated_env):
    """跨进程 old→unset 闭合（顾问 #4 第四轮）：

    本进程 P hydrate 出 old（带标记）；另一进程 R logout/clear 清空 stored。P 后续
    hydrate/ensure 必须清掉 stale old env，绝不把已吊销 key 继续传给 backend。
    """
    import os

    save_clawhunt_auth({
        "access_token": "t",
        "account_user": {"id": 9},
        "relay_api_key": "sk-llmgate-oldkeyaaaaaaaa",
        "relay_key_owner": "sub:9",
    })
    rk.hydrate_relay_environment()  # P: env=old + 标记
    assert os.environ[rk.RELAY_KEY_ENV] == "sk-llmgate-oldkeyaaaaaaaa"

    _simulate_other_process_clear()  # R logout：stored 清空

    # 仅 hydrate 就应清掉 stale env（backend 启动路径走 hydrate）
    rk.hydrate_relay_environment()
    assert rk.RELAY_KEY_ENV not in os.environ
    assert rk.RELAY_KEY_HYDRATED_ENV not in os.environ


def test_ensure_clears_stale_env_after_other_process_logout(isolated_env):
    """logout 后 P 再 ensure：无登录态则 fail-closed，且 stale old env 已被清（不残留）。"""
    import os

    save_clawhunt_auth({"relay_api_key": "sk-llmgate-oldkeyaaaaaaaa"})
    rk.hydrate_relay_environment()
    # R 清空 stored 和 access_token（彻底 logout）
    from superclaw.clawhunt_auth import clawhunt_auth_path
    clawhunt_auth_path().write_text("{}", encoding="utf-8")

    def explode(request):  # pragma: no cover
        raise AssertionError("no login → must fail-closed before network")

    with pytest.raises(rk.RelayKeyError, match="RELAY_LOGIN_REQUIRED"):
        rk.ensure_relay_key(client=_mock_bridge(explode))
    # 关键：fail-closed 路径也已清掉 stale old env（锁内 hydrate 先跑）
    assert rk.RELAY_KEY_ENV not in os.environ


def test_manual_env_survives_stored_change(isolated_env, monkeypatch):
    """真正的用户显式 env（无标记）始终是最高优先级逃生口，不被 stored 变化刷新。"""
    import os

    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-usermanualkey")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-storedkey"})
    rk.hydrate_relay_environment()  # 不得覆盖用户显式 env
    assert os.environ[rk.RELAY_KEY_ENV] == "sk-llmgate-usermanualkey"
    key, source = rk.resolve_relay_api_key()
    assert source == "env"


def test_concurrent_ensure_is_serialized(isolated_env):
    """两个线程并发 ensure：跨进程锁确保只发放一次，最终缓存非空且自洽。"""
    import threading

    save_clawhunt_auth({"access_token": "main-site-token"})
    call_count = {"exchange": 0}
    lock = threading.Lock()

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v1/bridge/exchange":
            with lock:
                call_count["exchange"] += 1
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": True})
        # 每次都返回 created=true（首发），名义上同 device
        return httpx.Response(200, json={
            "name": "superclaw-clawwork:dev", "key_prefix": "sk-llmgate-cc...",
            "quota_limit": "2.0", "rate_limit": 30, "expires_at": None,
            "created": True, "key": "sk-llmgate-concurrent-PLAINTEXT",
        })

    results: list = []

    def worker():
        # 每个线程独立 client（独立 MockTransport），但共享同一锁文件
        results.append(rk.ensure_relay_key(client=_mock_bridge(handler)))

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 锁让两次 ensure 串行：第二个拿锁后重读缓存命中，只有一次 exchange
    assert call_count["exchange"] == 1
    assert load_clawhunt_auth()["relay_api_key"] == "sk-llmgate-concurrent-PLAINTEXT"
    sources = sorted(r["source"] for r in results)
    assert sources == ["auto", "stored"]


# ---------------------------------------------------------------------------
# 合并集成不变量：CLI 注水接线 + clawwork 可用性 fail-closed + provider 落盘姿态
# （对应 Codex/Gemini 验收阻断项：run/chat/models 必须 hydrate；缺 key 不得放行
#  clawwork；models.json 明文 key 收紧为 0700/0600 并走内核解析链。）
# ---------------------------------------------------------------------------


def _cli():
    from typer.testing import CliRunner

    import superclaw.cli as cli_module

    return CliRunner(), cli_module


def test_cli_relay_namespace_status_and_clear(isolated_env, monkeypatch):
    """relay 命名空间在 CLI 层真实挂载：status --json 输出掩码状态，clear 幂等。"""
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))
    runner, cli_module = _cli()

    result = runner.invoke(cli_module.app, ["relay", "status", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["relay_key"] == "unset"
    assert payload["relay_key_source"] == "unset"

    cleared = runner.invoke(cli_module.app, ["relay", "clear-key"])
    assert cleared.exit_code == 0, cleared.output


def test_cli_run_chat_models_hydrate_environment(isolated_env, monkeypatch):
    """run/chat/models 三个执行入口都必须先注水：缓存 key 才能进新进程的执行路径。"""
    runner, cli_module = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))
    calls: list[str] = []
    monkeypatch.setattr(cli_module, "_hydrate_cli_environment", lambda: calls.append("hydrated"))

    class _Stop(RuntimeError):
        pass

    def _stop(*args, **kwargs):
        raise _Stop()

    monkeypatch.setattr(cli_module.SuperClawOrchestrator, "from_path", classmethod(_stop))
    result = runner.invoke(cli_module.app, ["run", "--title", "t", "--description", "d"])
    assert isinstance(result.exception, _Stop)
    assert calls == ["hydrated"]

    calls.clear()
    monkeypatch.setattr(cli_module, "_execute_chat_turn", _stop)
    result = runner.invoke(cli_module.app, ["chat", "--message", "hi"])
    assert isinstance(result.exception, _Stop)
    assert calls == ["hydrated"]

    calls.clear()
    result = runner.invoke(cli_module.app, ["models", "local", "--json"])
    assert result.exit_code == 0, result.output
    assert calls == ["hydrated"]


def _governed_clawwork_env(tmp_path, monkeypatch):
    """凑齐 key 之外的全部可用性前置：可执行文件 + 治理扩展 + relay base URL。"""
    fake = tmp_path / "bin" / "clawwork"
    fake.parent.mkdir(parents=True, exist_ok=True)
    fake.write_text("#!/bin/sh\necho clawwork 0.0.1\n", encoding="utf-8")
    fake.chmod(0o755)
    ext = tmp_path / "governance-ext.js"
    ext.write_text("// governance extension stub", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_EXECUTABLE", str(fake))
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", str(ext))
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://relay.test/v1")


def test_clawwork_availability_fails_closed_without_relay_key(isolated_env, monkeypatch):
    """env 无 key 且无缓存 → clawwork 不可用并给出 ensure-key 指引（fail-closed）。"""
    from superclaw.backends import ClawWorkBackend

    _governed_clawwork_env(isolated_env, monkeypatch)
    availability = ClawWorkBackend().available()
    assert availability.available is False
    assert "relay" in availability.reason and "ensure-key" in availability.reason


def test_clawwork_availability_accepts_env_or_stored_key(isolated_env, monkeypatch):
    """手动 env 或登录态缓存任一在场即可用（解析链与 resolve_relay_api_key 一致）。"""
    from superclaw.backends import ClawWorkBackend

    _governed_clawwork_env(isolated_env, monkeypatch)
    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-manual")
    assert ClawWorkBackend().available().available is True

    monkeypatch.delenv(rk.RELAY_KEY_ENV)
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-stored"})
    assert ClawWorkBackend().available().available is True


def test_clawwork_provider_config_writes_passed_key_and_tight_permissions(isolated_env, monkeypatch):
    """models.json 写入 run() 传入的 owner 校验后 key（seed 不再自 resolve 全局状态，
    顾问第三轮），且明文落盘姿态与缓存文件一致：目录 0700、文件 0600。

    直接驱动 _seed_clawrelay_provider：run() 仅在真实 spawn 路径（非 rpc_fn 注入）
    调用它，注入式 run 测试到不了这段。"""
    import os as _os

    from superclaw.backends import ClawWorkBackend

    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://relay.test/v1")

    agent_dir = isolated_env / "artifacts" / "clawwork-agent"
    # seed 不再 resolve：key 必须由调用方（run）显式传入。
    ClawWorkBackend._seed_clawrelay_provider(
        agent_dir, "relay/some-model", api_key="sk-llmgate-stored-key",
    )

    provider_path = agent_dir / "models.json"
    provider = json.loads(provider_path.read_text(encoding="utf-8"))
    assert provider["providers"]["clawrelay"]["apiKey"] == "sk-llmgate-stored-key"
    assert provider["providers"]["clawrelay"]["models"] == [{"id": "relay/some-model"}]
    if _os.name == "posix":
        assert (agent_dir.stat().st_mode & 0o777) == 0o700
        assert (provider_path.stat().st_mode & 0o777) == 0o600


# ---------------------------------------------------------------------------
# 复审第二轮阻断项：已登录自动 ensure 进 run 路径 / artifact 明文不留长期副本 /
# 模型发现跨 surface 一致（_probe_clawwork 走 resolver）
# ---------------------------------------------------------------------------


def test_clawwork_availability_treats_login_as_provisionable(isolated_env, monkeypatch):
    """无 key 但有 ClawHunt 登录态 → 可用（run() 会走自动发放，解析链第三级）。"""
    from superclaw.backends import ClawWorkBackend

    _governed_clawwork_env(isolated_env, monkeypatch)
    save_clawhunt_auth({"access_token": "tok-logged-in"})
    assert ClawWorkBackend().available().available is True


def _real_path_clawwork(isolated_env, monkeypatch, spawn_capture):
    """真实 spawn 路径（非注入）的 clawwork：_spawn_rpc 打桩为成功并抓取现场。"""
    from superclaw.backends import ClawWorkBackend

    _governed_clawwork_env(isolated_env, monkeypatch)

    def fake_spawn(
        self, command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check, event_sink=None
    ):
        provider_path = isolated_env / "artifacts" / "clawwork-agent" / "models.json"
        spawn_capture["provider"] = json.loads(provider_path.read_text(encoding="utf-8"))
        spawn_capture["env"] = dict(env)  # 抓子进程 env，校验 relay key 归属隔离
        return {"exit_code": 0, "output": "clawwork ok"}

    monkeypatch.setattr(ClawWorkBackend, "_spawn_rpc", fake_spawn)
    return ClawWorkBackend()


def _run_clawwork(backend, isolated_env):
    from superclaw.backends import WorkerLimits
    from superclaw.models import GoalSpec, RunSession
    from superclaw.runtime import PermissionPolicy

    goal = GoalSpec(title="Ship", description="relay chain")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_chain")
    limits = WorkerLimits(
        repo_path=isolated_env,
        artifact_dir=isolated_env / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="default"),
    )
    return backend.run(_relay_task(), goal, session, limits)


def test_clawwork_run_auto_provisions_when_logged_in(isolated_env, monkeypatch):
    """已登录但无缓存 key → run() 自动 ensure，发放的 key 进 provider 配置。"""
    save_clawhunt_auth({"access_token": "tok-logged-in"})
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)

    def fake_ensure(**kwargs):
        # 真实 ensure 会把 owner 钉死在当前账号上；mock 也照做，否则下游 resolve
        # 会因归属失配拒用这把刚发的 key。
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-auto-provisioned",
            "relay_key_owner": rk._current_account_identity(),
        })
        return {"relay_key": "sk-l...oned", "source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)

    assert result.exit_code == 0
    assert capture["provider"]["providers"]["clawrelay"]["apiKey"] == "sk-llmgate-auto-provisioned"
    # 明文副本只活到 clawwork 进程结束：run 收尾后 artifact 树里不留 models.json
    assert not (isolated_env / "artifacts" / "clawwork-agent" / "models.json").exists()


def test_clawwork_run_fails_closed_when_provision_impossible(isolated_env, monkeypatch):
    """未登录且无 key → run() 给出 CLAWWORK_RELAY_KEY_MISSING（exit 125），不带空 key 起跑。"""
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)

    def fake_ensure(**kwargs):
        raise rk.RelayKeyError("not logged in: run `superclaw clawhunt account login` first")

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)

    assert result.exit_code == 125
    assert "CLAWWORK_RELAY_KEY_MISSING" in result.output
    assert "provider" not in capture  # 从未带空 key 起跑


def test_clawwork_run_child_env_excludes_stale_other_account_key(isolated_env, monkeypatch):
    """切号后 run：子进程 env 的 relay key 是当前账号的，绝不带上一账号残留的 stale key。

    顾问第二轮阻断项：backends 在 ensure 前就 env=dict(os.environ) 会把 A 的 hydrated key
    复制进子进程 env。修复后 ensure 先于快照、且快照后用 owner 校验的 resolver 规范化。
    """
    import os as _os

    # A 登录发 key + hydrate（模拟长驻进程进程内已有 A 的 env）
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    assert _os.environ.get(rk.RELAY_KEY_ENV) == "sk-llmgate-ensure-PLAINTEXT"

    # 切到 B（直接改文件，不触发 hydrate）——此刻进程 env 仍残留 A 的 stale key
    from superclaw.clawhunt_auth import clawhunt_auth_path
    p = clawhunt_auth_path()
    data = json.loads(p.read_text(encoding="utf-8"))
    data["account_user"] = {"id": "B"}
    data["access_token"] = "tok-B"
    p.write_text(json.dumps(data), encoding="utf-8")
    assert _os.environ.get(rk.RELAY_KEY_ENV) == "sk-llmgate-ensure-PLAINTEXT"  # 危险态：env 还是 A 的

    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)

    def fake_ensure(**kwargs):  # run 内 ensure 为当前账号 B 重发
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-B-key",
            "relay_key_owner": rk._current_account_identity(),
        })
        return {"source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    _run_clawwork(backend, isolated_env)

    # 子进程 env 是 B 的 key，绝不含 A 的 stale key
    assert capture["env"].get(rk.RELAY_KEY_ENV) == "sk-llmgate-B-key"
    assert "sk-llmgate-ensure-PLAINTEXT" not in capture["env"].get(rk.RELAY_KEY_ENV, "")


def test_clawwork_run_fails_closed_when_owned_key_empty_after_ensure(isolated_env, monkeypatch):
    """ensure 后规范化 resolve 得空 key（切号/登出竞态）→ run fail-closed 125；
    绝不空 key 起跑，也不让 seed 二次 resolve 出别账号 key（顾问第三轮阻断项）。"""
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)

    def fake_ensure(**kwargs):
        # 模拟 ensure 后归属已切：写入一把 owner=B 的 key，当前账号仍 A → resolve 失配得空
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-Bkey", "relay_key_owner": "sub:B",
        })
        return {"source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)
    assert result.exit_code == 125
    assert "CLAWWORK_RELAY_KEY_MISSING" in result.output
    assert "provider" not in capture  # 从未带空 key 起跑，seed 未被调用


def test_model_discovery_clawwork_probe_returns_super_packages(isolated_env, monkeypatch):
    """_probe_clawwork 返回 super 分组套餐 id（core/plus/max…），不再打 /v1/models 暴露
    裸模型——与 /api/relay/packages、CLI relay packages 同一内核 relay_packages()。"""
    from superclaw import model_discovery as md
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {
            "packages": [
                {"id": "core", "name": "core", "tier": "core", "group_slug": "superclaw-core"},
                {"id": "plus", "name": "Plus", "tier": "plus", "group_slug": "superclaw-plus"},
            ],
            "source": "catalog",
            "available": True,
        },
    )
    assert md._probe_clawwork(None) == ["core", "plus"]  # 套餐 id，绝非裸模型


def _relay_task():
    from superclaw.models import TaskNode, WorkerRole

    return TaskNode(task_id="task_relay_1", role=WorkerRole.IMPLEMENT, title="implement task")


def test_model_discovery_cache_invalidates_on_stored_key_rotation(isolated_env, monkeypatch):
    """缓存指纹必须跟随 resolver 链：stored key rotate 后（env 未 hydrate 的长生命
    周期进程，如 API/shell），catalog 缓存立即失效并用新 key 重探测，不等 TTL。"""
    from superclaw import model_discovery as md
    from superclaw.backends import default_backends

    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://relay.test/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-key-a"})
    probes: list = []

    import superclaw.relay_packages as rp

    def fake_packages():
        # 套餐探针：观察解析链此刻看到的 key（套餐列表与 key 无关，只需观测是否重探测）。
        key, _ = rk.resolve_relay_api_key()
        probes.append(key)
        return {
            "packages": [{"id": "plus", "name": "plus", "tier": "plus", "group_slug": "superclaw-plus"}],
            "source": "catalog",
            "available": True,
        }

    monkeypatch.setattr(rp, "relay_packages", fake_packages)
    registry = default_backends()

    first = md.discover_models("clawwork", backends=registry)
    assert first.cached is False
    # 模拟另一进程 rotate：绕过 save_clawhunt_auth（它会顺带 hydrate 本进程 env），
    # 直接改写 auth 文件——本进程 env 保持 stale 的 key-a（带 HYDRATED 标记），
    # 这正是"stored 变、env 未变"的跨进程漏洞形态（顾问第三/四轮）
    auth_path = isolated_env / "clawhunt-auth.json"
    stored = json.loads(auth_path.read_text(encoding="utf-8"))
    stored["relay_api_key"] = "sk-llmgate-key-b"
    auth_path.write_text(json.dumps(stored), encoding="utf-8")
    import os as _os

    assert _os.environ.get(rk.RELAY_KEY_ENV) == "sk-llmgate-key-a"  # env 仍是 stale 旧值
    second = md.discover_models("clawwork", backends=registry)

    # 缓存指纹跟随 resolver(stored) 失效 → 用新 key 重探测，不等 TTL、未 force_refresh。
    assert second.cached is False
    assert probes == ["sk-llmgate-key-a", "sk-llmgate-key-b"]
    assert _os.environ.get(rk.RELAY_KEY_ENV) == "sk-llmgate-key-a"


# ---------------------------------------------------------------------------
# 账务/安全审计日志 + rotate 网络残留自愈（吸收自 SuperClaw#223）
# ---------------------------------------------------------------------------

def _read_audit() -> list[dict]:
    path = rk.relay_audit_path()
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_provision_writes_audit_no_plaintext(isolated_env):
    """发放成功 → 写 provisioned 审计，含 device/quota/key_prefix，绝不含明文。"""
    save_clawhunt_auth({"access_token": "main-site-token"})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    audit = _read_audit()
    assert "provisioned" in [a["event"] for a in audit]
    rec = next(a for a in audit if a["event"] == "provisioned")
    assert rec["device_id"]
    assert rec["quota_limit"] == "2.0"
    assert rec["key_prefix"].endswith("...")  # 脱敏
    assert "PLAINTEXT" not in rk.relay_audit_path().read_text()


def test_audit_file_is_0600(isolated_env):
    import stat

    save_clawhunt_auth({"access_token": "t"})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    assert stat.S_IMODE(rk.relay_audit_path().stat().st_mode) == 0o600


def test_fail_closed_writes_audit(isolated_env):
    """未登录 fail-closed 也留审计（带 error_code），便于追溯失败尝试。"""
    with pytest.raises(rk.RelayKeyError):
        rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    audit = _read_audit()
    assert any(a["event"] == "fail_closed" and a.get("error_code") == "RELAY_LOGIN_REQUIRED" for a in audit)


def test_clear_writes_audit_masked(isolated_env):
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-secret-zzzzzzzzzzzzzzzz"})
    rk.clear_relay_key()
    rec = next(a for a in _read_audit() if a["event"] == "cleared")
    assert rec["key_prefix"].endswith("...")
    assert "secret-zzzz" not in rk.relay_audit_path().read_text()


def test_rotate_network_residue_self_heals(isolated_env):
    """rotate 客户端响应丢失(可能已吊销旧key)+auto+归属未变 → 清本地 + 审计 self_heal。"""
    save_clawhunt_auth({
        "access_token": "main-site-token",
        "account_user": {"id": "X"},
        "relay_api_key": "sk-llmgate-oldautoaaaaaaaa",
        "relay_key_source": "auto",
        "relay_key_owner": "sub:X",
    })

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": False})
        raise httpx.ReadTimeout("client timeout")

    with pytest.raises(rk.RelayKeyError, match="RELAY_RESPONSE_LOST"):
        rk.ensure_relay_key(rotate=True, client=_mock_bridge(handler))
    assert rk._stored_key() == ""
    assert rk.RELAY_KEY_ENV not in __import__("os").environ
    assert any(a["event"] == "rotate_self_heal" and a.get("error_code") == "RELAY_RESPONSE_LOST" for a in _read_audit())


def test_rotate_self_heal_skips_on_owner_mismatch(isolated_env):
    """A 的 rotate RESPONSE_LOST 时若已切到 B（B 有 auto key），绝不清 B 的有效 key（顾问第三轮）。"""
    save_clawhunt_auth({
        "access_token": "tok-A", "account_user": {"id": "A"},
        "relay_api_key": "sk-llmgate-Akeyaaaaaaaa", "relay_key_source": "auto",
        "relay_key_owner": "sub:A",
    })

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            # exchange 进行中另一进程切到 B（连同 B 自己的 auto key + owner）
            from superclaw.clawhunt_auth import clawhunt_auth_path
            path = clawhunt_auth_path()
            data = json.loads(path.read_text(encoding="utf-8"))
            data.update({
                "access_token": "tok-B", "account_user": {"id": "B"},
                "relay_api_key": "sk-llmgate-Bkey-valid", "relay_key_source": "auto",
                "relay_key_owner": "sub:B",
            })
            path.write_text(json.dumps(data), encoding="utf-8")
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": False})
        raise httpx.ReadTimeout("client timeout")  # rotate RESPONSE_LOST

    with pytest.raises(rk.RelayKeyError, match="RELAY_RESPONSE_LOST"):
        rk.ensure_relay_key(rotate=True, client=_mock_bridge(handler))
    # 归属已是 B；A 的异常自愈必须跳过——B 的有效 key 绝不能被清掉
    assert load_clawhunt_auth()["relay_api_key"] == "sk-llmgate-Bkey-valid"
    assert any(
        a["event"] == "rotate_self_heal" and a.get("reason") == "skip_owner_mismatch"
        for a in _read_audit()
    )


def test_clear_relay_key_if_matches_guards_against_toctou(isolated_env):
    """条件清：stored 已变（切号写入别账号 key）→ 绝不清；仍匹配 → 才清（防 check-clear TOCTOU，顾问第四轮）。"""
    # 当前 stored 是 B 的；想清 A 的 (auto, sub:A, Akey) → 失配，绝不动 B 的 key
    save_clawhunt_auth({
        "relay_api_key": "sk-llmgate-Bkey", "relay_key_source": "auto", "relay_key_owner": "sub:B",
    })
    cleared = rk._clear_relay_key_if_matches(
        expected_source="auto", expected_owner="sub:A", expected_key="sk-llmgate-Akey",
    )
    assert cleared is False
    assert load_clawhunt_auth()["relay_api_key"] == "sk-llmgate-Bkey"  # B 的有效 key 没被误清
    # 全部匹配 → 才清
    cleared2 = rk._clear_relay_key_if_matches(
        expected_source="auto", expected_owner="sub:B", expected_key="sk-llmgate-Bkey",
    )
    assert cleared2 is True
    assert "relay_api_key" not in load_clawhunt_auth()


def test_rotate_self_heal_skips_on_owner_missing(isolated_env):
    """auto key 但 owner 缺失（legacy ownerless auto）：rotate RESPONSE_LOST 只审计 skip_owner_missing，不清。"""
    save_clawhunt_auth({
        "access_token": "tok-A", "account_user": {"id": "A"},
        "relay_api_key": "sk-llmgate-ownerless-auto", "relay_key_source": "auto",
        # 无 relay_key_owner（legacy 无主 auto key）
    })

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": False})
        raise httpx.ReadTimeout("client timeout")

    with pytest.raises(rk.RelayKeyError, match="RELAY_RESPONSE_LOST"):
        rk.ensure_relay_key(rotate=True, client=_mock_bridge(handler))
    assert load_clawhunt_auth()["relay_api_key"] == "sk-llmgate-ownerless-auto"  # 无主 → 不清
    assert any(
        a["event"] == "rotate_self_heal" and a.get("reason") == "skip_owner_missing"
        for a in _read_audit()
    )


@pytest.mark.parametrize("bad", [None, "", "   "])
def test_seed_rejects_empty_api_key(isolated_env, monkeypatch, bad):
    """seed 对 None/空/纯空白 api_key 一律 raise，绝不写空白 apiKey 起跑（顾问第四/五轮纵深）。"""
    from superclaw.backends import ClawWorkBackend

    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://relay.test/v1")
    agent_dir = isolated_env / "artifacts" / "seed-empty"
    with pytest.raises(ValueError, match="non-empty api_key"):
        ClawWorkBackend._seed_clawrelay_provider(
            agent_dir, "relay/m", api_key=bad, base_url="https://relay.test/v1",
        )
    assert not (agent_dir / "models.json").exists()  # 从未写入


@pytest.mark.parametrize(
    "exc",
    [
        httpx.ConnectError("refused"),
        httpx.ConnectTimeout("timeout"),
        httpx.WriteTimeout("write timeout"),  # 写出阶段失败：请求没发完，不能证明已提交
        httpx.WriteError("write error"),
        httpx.UnsupportedProtocol("bad scheme"),
        httpx.LocalProtocolError("malformed"),
        httpx.TooManyRedirects("loop"),
        httpx.InvalidURL("malformed url"),
    ],
)
def test_not_submitted_errors_never_clear_auto_key(isolated_env, exc):
    """请求未提交类错误（连接失败/URL非法/协议错/重定向超限）一律不清有效 auto key。"""
    save_clawhunt_auth({
        "access_token": "t",
        "relay_api_key": "sk-llmgate-keepvalidaa",
        "relay_key_source": "auto",
    })

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": False})
        raise exc

    with pytest.raises(rk.RelayKeyError, match="RELAY_UNREACHABLE"):
        rk.ensure_relay_key(rotate=True, client=_mock_bridge(handler))
    assert rk._stored_key() == "sk-llmgate-keepvalidaa"
    assert not any(a["event"] == "rotate_self_heal" for a in _read_audit())


def test_self_heal_skips_non_auto_key(isolated_env):
    """source 非 auto 的 stored key，即便 RESPONSE_LOST 也不被自愈清。"""
    save_clawhunt_auth({
        "access_token": "t",
        "relay_api_key": "sk-llmgate-nonautokey1",
        "relay_key_source": "imported",
    })

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": False})
        raise httpx.ReadTimeout("lost")

    with pytest.raises(rk.RelayKeyError, match="RELAY_RESPONSE_LOST"):
        rk.ensure_relay_key(rotate=True, client=_mock_bridge(handler))
    assert rk._stored_key() == "sk-llmgate-nonautokey1"


def test_audit_rejects_non_whitelisted_fields(isolated_env):
    """审计字段白名单：access_token/key/url 明文字段名不会落盘。"""
    rk._audit(
        "provisioned",
        access_token="SHOULD-NOT-APPEAR",
        key="ALSO-SECRET",
        bridge_base_url="https://user:tok@host?token=SECRETURL",
        device_id="d1",
    )
    raw = rk.relay_audit_path().read_text()
    assert "SHOULD-NOT-APPEAR" not in raw
    assert "ALSO-SECRET" not in raw
    assert "SECRETURL" not in raw
    assert "d1" in raw


def test_audit_caps_field_length(isolated_env):
    """超长受控字段截断到 _AUDIT_FIELD_MAXLEN，防撑爆磁盘（DoS）。"""
    rk._audit("fail_closed", reason="X" * 5000, device_id="d1")
    assert len(_read_audit()[-1]["reason"]) <= rk._AUDIT_FIELD_MAXLEN


def test_logging_path_emits_no_plaintext(isolated_env, caplog):
    """logging 侧（logger.info + extra）也绝不含明文 key。"""
    import logging

    save_clawhunt_auth({"access_token": "t"})
    with caplog.at_level(logging.INFO, logger="superclaw.relay_key"):
        rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    blob = " ".join(r.getMessage() + str(getattr(r, "relay_audit", "")) for r in caplog.records)
    assert "PLAINTEXT" not in blob


def test_self_heal_uses_structured_code_not_substring(isolated_env):
    """rotate 异常 *message 含 'RELAY_RESPONSE_LOST' 子串、但结构化 code 是 UNREACHABLE* 时，
    自愈绝不误清有效 key。

    自愈用结构化 exc.code 判定，绝不靠 str(exc) substring：真实错误文案会带上 base_url
    （见 RelayBridgeClient._post），异常/恶意 URL 可让 'RELAY_RESPONSE_LOST' 子串混进文案，
    旧的 substring 判定会被污染而误清有效 key（顾问评审阻断项）。这里直接构造"文案含子串、
    但 code=UNREACHABLE（请求根本没发出）"的异常，确定性地复现该污染，无需依赖 httpx 对
    保留域名做真实网络 I/O（那会引入 capture 相关的非确定性）。
    """
    save_clawhunt_auth({
        "access_token": "t",
        "relay_api_key": "sk-llmgate-keepvalidaa",
        "relay_key_source": "auto",
    })

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": False})
        raise AssertionError("rotate 由下方 monkeypatch 接管，不应触达 transport")

    bridge = rk.RelayBridgeClient(
        base_url="https://api.clawhunt.site",
        transport=httpx.MockTransport(handler),
    )

    # rotate 抛"文案含 RELAY_RESPONSE_LOST 子串、但 code 明确为 UNREACHABLE"的异常——模拟真实
    # 场景：错误文案带了一个恰好含该子串的污染 base_url，而请求其实根本没发出（ConnectError）。
    def _rotate_poisoned_message(_token: str):
        raise rk.RelayKeyError(
            "RELAY_UNREACHABLE: 无法完成中转站桥接请求 "
            "http://relay.example/RELAY_RESPONSE_LOST（ConnectError）；请检查网络",
            code="RELAY_UNREACHABLE",
        )

    bridge.rotate_key = _rotate_poisoned_message  # type: ignore[method-assign]

    with pytest.raises(rk.RelayKeyError, match="RELAY_UNREACHABLE"):
        rk.ensure_relay_key(rotate=True, client=bridge)
    # 旧的 `"RELAY_RESPONSE_LOST" in str(exc)` 会在此误命中并清 key；结构化 code 判定不会。
    assert rk._stored_key() == "sk-llmgate-keepvalidaa"
    assert not any(a["event"] == "rotate_self_heal" for a in _read_audit())


def test_post_wraps_connect_error_as_unreachable_with_masked_url(isolated_env):
    """_post 把 ConnectError 包成 code=RELAY_UNREACHABLE；base_url 经 _mask_base_url 脱敏，
    即使 base 含污染子串/secret（如 path 里的 RELAY_RESPONSE_LOST），文案也只留 host 不回显。

    与 self-heal gate 测试互补：self-heal 靠结构化 code 判定（见 test_self_heal_uses_
    structured_code），绝不靠 str(exc) substring；这里进一步证明文案本身已脱敏掉 path 污染串
    （base URL 信任统一收口）。MockTransport 直接抛异常，不触网，确定性。
    """
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")  # 请求没发出 → UNREACHABLE

    bridge = rk.RelayBridgeClient(
        base_url="https://api.clawhunt.site/RELAY_RESPONSE_LOST",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(rk.RelayKeyError) as exc_info:
        bridge.exchange("tok", "device")
    assert exc_info.value.code == "RELAY_UNREACHABLE"
    # base_url 脱敏：path 里的污染子串绝不进文案（只留 scheme://host）。
    assert "RELAY_RESPONSE_LOST" not in str(exc_info.value)
    assert "https://api.clawhunt.site" in str(exc_info.value)


def test_audit_rejects_nonscalar_values(isolated_env):
    """白名单字段若值是嵌套 dict/list（恶意/异常服务端塞的），绝不原样落盘。"""
    rk._audit(
        "provisioned",
        quota_limit={"access_token": "SECRET-NESTED"},
        expires_at=["sk-llmgate-LEAKEDKEY"],
        device_id="d1",
    )
    raw = rk.relay_audit_path().read_text()
    assert "SECRET-NESTED" not in raw
    assert "LEAKEDKEY" not in raw
    rec = _read_audit()[-1]
    assert rec["quota_limit"] == "<non-scalar>"
    assert rec["expires_at"] == "<non-scalar>"
    assert rec["device_id"] == "d1"  # 标量正常落盘


def test_fallback_rotate_no_auto_key_skips_self_heal(isolated_env):
    """fallback rotate(首次 ensure，本地无 auto key)遇 RESPONSE_LOST：无 key 可清，守卫跳过。"""
    save_clawhunt_auth({"access_token": "main-site-token"})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            return httpx.Response(200, json={"bridge_token": "bt", "account_created": True})
        if request.url.path == "/api/v1/bridge/keys/ensure":
            return httpx.Response(200, json={"created": False, "key": None})
        raise httpx.ReadTimeout("lost")

    with pytest.raises(rk.RelayKeyError, match="RELAY_RESPONSE_LOST"):
        rk.ensure_relay_key(client=_mock_bridge(handler))
    assert not any(a["event"] == "rotate_self_heal" for a in _read_audit())


# ---------------------------------------------------------------------------
# 账号归属隔离：防"切号串 key"（B 绝不能复用 A 发放的 relay key —— 否则 B 的
# 用量会扣 A 的真金白银、记到 A 的账单。顾问对抗评审判定的 P1 阻断项）
# ---------------------------------------------------------------------------

def test_account_switch_does_not_reuse_other_account_key(isolated_env):
    """账号 A 发 key 后切到 B：resolve 绝不返回 A 的 key（账务盗刷 + 隐私串号防线）。"""
    # A 登录并发放 key（owner 钉死为 sub:A）
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    auth = load_clawhunt_auth()
    assert auth["relay_api_key"] == "sk-llmgate-ensure-PLAINTEXT"
    assert auth["relay_key_owner"] == "sub:A"
    key_a, source_a = rk.resolve_relay_api_key()
    assert key_a == "sk-llmgate-ensure-PLAINTEXT" and source_a == "stored"

    # 切到 B（覆盖 access_token + account_user；relay_api_key 仍是 A 的，未被显式清）
    save_clawhunt_auth({"access_token": "tok-B", "account_user": {"id": "B"}})
    key_b, source_b = rk.resolve_relay_api_key()
    assert key_b is None and source_b == "unset", "切号后绝不能复用 A 的 key"


def test_account_switch_reprovisions_for_current_account(isolated_env):
    """切号后 ensure 用当前账号重新发放，新 key 归属当前账号（达成目的 + 隔离）。"""
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    save_clawhunt_auth({"access_token": "tok-B", "account_user": {"id": "B"}})
    summary = rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    assert summary["source"] == "auto"  # 没有复用 A 的 stored，走了重新发放
    assert load_clawhunt_auth()["relay_key_owner"] == "sub:B"


def test_switch_account_clears_stale_hydrated_env(isolated_env):
    """切号瞬间（save_clawhunt_auth→hydrate）清掉 A 残留在进程 env 的 key（防 env 污染）。"""
    import os

    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    assert os.environ[rk.RELAY_KEY_ENV] == "sk-llmgate-ensure-PLAINTEXT"
    # 切 B：save 触发 hydrate，A 的 key 归属失配 → env 被当场清掉
    save_clawhunt_auth({"access_token": "tok-B", "account_user": {"id": "B"}})
    assert rk.RELAY_KEY_ENV not in os.environ
    assert rk.RELAY_KEY_HYDRATED_ENV not in os.environ


def test_owner_match_survives_access_token_rotation(isolated_env):
    """同账号 access_token 轮换（user id 不变）→ 仍命中 stored，绝不误判失配触发重发。

    这是用 sub:<id> 而非 access_token 指纹做 owner 的关键收益：token 短效会刷新，
    但 relay key 长效，同账号 token 轮换不该把有效 key 误杀（顾问指出的惊群 rotate 坑）。
    """
    save_clawhunt_auth({"access_token": "tok-old", "account_user": {"id": "A"}})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    save_clawhunt_auth({"access_token": "tok-refreshed", "account_user": {"id": "A"}})

    def explode(request):  # pragma: no cover - 同账号必须命中 stored，不触网
        raise AssertionError("same-account token rotation must not re-provision")

    summary = rk.ensure_relay_key(client=_mock_bridge(explode))
    assert summary["source"] == "stored"
    key, source = rk.resolve_relay_api_key()
    assert key == "sk-llmgate-ensure-PLAINTEXT" and source == "stored"


def test_ownerless_stored_with_login_is_not_trusted(isolated_env):
    """向后兼容：有登录态但 stored 无 owner（历史遗留）→ unknown，不信任、不返回。

    现网桥接 flag 未开、零存量 key，此路径零成本；安全优先于"信任无主 key"。
    """
    save_clawhunt_auth({
        "access_token": "tok-A", "account_user": {"id": "A"},
        "relay_api_key": "sk-llmgate-ownerless",
    })
    key, source = rk.resolve_relay_api_key()
    assert key is None and source == "unset"


def test_legacy_stored_without_login_still_usable(isolated_env):
    """无登录态 + stored 无 owner：无冒用方，沿用本机历史 key（不破坏纯缓存场景）。"""
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-legacy"})
    key, source = rk.resolve_relay_api_key()
    assert key == "sk-llmgate-legacy" and source == "stored"


def test_provision_audit_records_account_owner(isolated_env):
    """发放审计记 account_owner（sub:<id>，非密钥），账务可按账号归因串号。"""
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    rec = next(a for a in _read_audit() if a["event"] == "provisioned")
    assert rec["account_owner"] == "sub:A"


def test_manual_env_unaffected_by_account_switch(isolated_env, monkeypatch):
    """手动 env 逃生口与账号归属正交：显式 env 始终最高优先，不被归属校验拦截。"""
    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-manualescape")
    save_clawhunt_auth({
        "access_token": "tok-B", "account_user": {"id": "B"},
        "relay_api_key": "sk-llmgate-othersaccount", "relay_key_owner": "sub:A",
    })
    key, source = rk.resolve_relay_api_key()
    assert source == "env" and key == "sk-llmgate-manualescape"


# ---------------------------------------------------------------------------
# 安全加固回归：~/.superclaw 目录 0700 + 客户端禁重定向
# ---------------------------------------------------------------------------

def test_secure_parent_dir_is_0700(isolated_env, tmp_path):
    """_ensure_secure_parent 把凭据目录收紧到 0700（仅属主可遍历，F-M2）。"""
    import stat

    target = tmp_path / "sec-sub" / "file.txt"
    rk._ensure_secure_parent(target)
    assert target.parent.exists()
    assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700


def test_audit_write_creates_0700_parent(isolated_env, tmp_path):
    """实际写审计日志时，其父目录也被收紧到 0700。"""
    import stat

    rk._audit("provisioned", device_id="d1")
    audit_dir = rk.relay_audit_path().parent
    assert stat.S_IMODE(audit_dir.stat().st_mode) == 0o700


def test_bridge_client_disables_redirects(isolated_env):
    """RelayBridgeClient 显式 follow_redirects=False，防 3xx 把 bridge token 泄露给攻击者主机（F-N3）。"""
    client = rk.RelayBridgeClient(base_url="http://x.test")
    try:
        assert client._client.follow_redirects is False
    finally:
        client.close()


# ---------------------------------------------------------------------------
# bridge base 可信白名单：防 access_token 被污染的 env 外泄到恶意主机
# （顾问对抗评审判定的 P1 阻断项：客户端无白名单管控的 token exfil / SSRF）
# ---------------------------------------------------------------------------

def test_bridge_url_allowlist(isolated_env, monkeypatch):
    """白名单：仅 https + host 精确命中 + 端口 None/443 放行；仿冒/注入/非默认端口一律拒。"""
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site") is True
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site/api/v1/bridge") is True
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site:443") is True      # 显式默认端口
    assert rk._is_allowed_bridge_url("http://api.clawhunt.site") is False      # 非 https
    assert rk._is_allowed_bridge_url("https://evil.attacker.test") is False    # host 不在白名单
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site.evil.test") is False  # 后缀仿冒
    assert rk._is_allowed_bridge_url("https://evilapi.clawhunt.site") is False  # 前缀仿冒
    # 对抗绕过：host 大小写不敏感（urlparse 小写化）放行；其余仿冒/注入/非默认端口一律拒
    assert rk._is_allowed_bridge_url("https://API.CLAWHUNT.SITE") is True          # 大小写
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site:8443/x") is False  # 非默认端口（origin 约束）
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site.") is False        # 尾点 FQDN（fail-safe）
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site@evil.test") is False  # userinfo 注入→host=evil
    assert rk._is_allowed_bridge_url("https://evil.test#api.clawhunt.site") is False  # fragment 干扰
    assert rk._is_allowed_bridge_url("https://1.2.3.4") is False                   # 裸 IP
    assert rk._is_allowed_bridge_url("https://аpi.clawhunt.site") is False    # IDN 仿冒（西里尔 а）
    assert rk._is_allowed_bridge_url("https://user:pass@api.clawhunt.site") is False  # userinfo Basic auth
    assert rk._is_allowed_bridge_url("https://user@api.clawhunt.site") is False  # 仅 username
    assert rk._is_allowed_bridge_url("https://@api.clawhunt.site") is False  # 空 userinfo（须 is None 拦截）
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site\twith-tab") is False  # 控制符(tab)
    assert rk._is_allowed_bridge_url("https://api.clawhunt.site\x00") is False  # 空字节
    assert rk._is_allowed_bridge_url("http\n://api.clawhunt.site") is False  # 换行注入
    assert rk._is_allowed_bridge_url("not-a-url") is False
    assert rk._is_allowed_bridge_url("") is False
    # 默认生产 base 恰好命中白名单（不设任何 env 时不被自己拦）
    assert rk._is_allowed_bridge_url(rk.DEFAULT_BRIDGE_BASE_URL) is True
    # 绝不提供 env 级 unsafe 逃生口：即便攻击者设了该环境变量，白名单外地址仍被拒
    # （原始威胁就是 env 污染——unsafe 只能走代码级 RelayBridgeClient(allow_insecure=True)）
    monkeypatch.setenv("SUPERCLAW_RELAY_ALLOW_INSECURE_BRIDGE", "1")
    assert rk._is_allowed_bridge_url("http://127.0.0.1:8001") is False


def test_exchange_rejects_untrusted_bridge_url_without_network(isolated_env):
    """真实 client（无注入 transport）对白名单外地址：exchange 在发网络前就拒绝，绝不外发 token。"""
    client = rk.RelayBridgeClient(base_url="http://evil.attacker.test")
    try:
        with pytest.raises(rk.RelayKeyError, match="RELAY_BRIDGE_UNTRUSTED") as exc:
            client.exchange("super-secret-access-token", "device-1")
        # 错误文案绝不回显 access_token 明文
        assert "super-secret-access-token" not in str(exc.value)
    finally:
        client.close()


def test_ensure_refuses_untrusted_bridge_url(isolated_env, monkeypatch):
    """端到端：BRIDGE_URL 被污染到恶意地址时，ensure 自建真实 client → 闸门拦截，token 不外发。"""
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    monkeypatch.setenv(rk.RELAY_BRIDGE_URL_ENV, "http://evil.attacker.test")
    with pytest.raises(rk.RelayKeyError, match="RELAY_BRIDGE_UNTRUSTED"):
        rk.ensure_relay_key()  # client=None → 自建真实 client（无注入 transport）
    # 闸门挡在发放之前：本地不会留下任何 key
    assert rk._stored_key() == ""


def test_allow_insecure_is_code_level_only_not_env(isolated_env, monkeypatch):
    """自定义中转只走代码级 allow_insecure 构造参数；env 永远开不了 unsafe（防污染）。

    锁住顾问第二轮阻断项：env 级逃生口已删除，真实 HTTPTransport 注入也不再绕过白名单。
    """
    # 代码级 allow_insecure=True：白名单外 host 也放行（开发自建中转）
    ok = rk.RelayBridgeClient(
        base_url="http://localhost:8001", allow_insecure=True,
        transport=httpx.MockTransport(_ok_bridge()),
    )
    try:
        assert ok.exchange("tok", "device")["bridge_token"] == "bt-test"
    finally:
        ok.close()
    # env 试图开 unsafe：无效，白名单外 host 仍被拒（绝不从环境读逃生口）。
    # 即便注入真实风格 transport 也挡住——闸门不再看 transport 是否注入。
    monkeypatch.setenv("SUPERCLAW_RELAY_ALLOW_INSECURE_BRIDGE", "1")
    blocked = rk.RelayBridgeClient(
        base_url="http://evil.attacker.test",
        transport=httpx.MockTransport(_ok_bridge()),
    )
    try:
        with pytest.raises(rk.RelayKeyError, match="RELAY_BRIDGE_UNTRUSTED"):
            blocked.exchange("tok", "device")
    finally:
        blocked.close()


def test_mock_bridge_uses_allowlisted_host(isolated_env):
    """mock 走白名单 host 通过 exchange 闸门（不靠"注入 transport 跳过"——那是被否决的绕过）。"""
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    summary = rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))
    assert summary["source"] == "auto"


def test_owner_uses_exchange_snapshot_not_post_persist_account(isolated_env):
    """切号竞态：exchange 期间另一进程切到 B，owner 必须标成发 key 的 A（snapshot），不是 B。

    顾问第二轮阻断项：若 _persist 重读当前账号，会把 A 发的 key 误标成 B → 正中切号串 key。
    """
    import os as _os

    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/bridge/exchange":
            # 模拟 exchange 进行中另一进程切号到 B（直接改 auth 文件）
            from superclaw.clawhunt_auth import clawhunt_auth_path
            path = clawhunt_auth_path()
            data = json.loads(path.read_text(encoding="utf-8"))
            data["account_user"] = {"id": "B"}
            data["access_token"] = "tok-B"
            path.write_text(json.dumps(data), encoding="utf-8")
            return httpx.Response(200, json={"bridge_token": "bt-test", "account_created": True})
        return httpx.Response(200, json={
            "name": "superclaw-clawwork:dev", "key_prefix": "sk-llmgate-en...",
            "quota_limit": "2.0", "rate_limit": 30, "expires_at": None,
            "created": True, "key": "sk-llmgate-ensure-PLAINTEXT",
        })

    rk.ensure_relay_key(client=_mock_bridge(handler))
    auth = load_clawhunt_auth()
    # owner 是发 key 的 A（snapshot），不是竞态切到的 B
    assert auth["relay_key_owner"] == "sub:A"
    # 切号竞态下绝不把 A 的 key 注入 B 的 env；当前 B 视角下 A 的 key 归属失配 → 不可用
    assert rk.RELAY_KEY_ENV not in _os.environ
    _key, source = rk.resolve_relay_api_key()
    assert source == "unset"


def test_resolve_uses_single_auth_snapshot(isolated_env, monkeypatch):
    """resolve 单次 load auth：stored 与归属判定同源，杜绝跨快照切号竞态（顾问第二轮阻断项）。"""
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    rk.ensure_relay_key(client=_mock_bridge(_ok_bridge()))  # stored=key owner sub:A
    calls = {"n": 0}
    real_load = rk.load_clawhunt_auth

    def counting_load(*a, **k):
        calls["n"] += 1
        return real_load(*a, **k)

    monkeypatch.setattr(rk, "load_clawhunt_auth", counting_load)
    rk.resolve_relay_api_key()
    assert calls["n"] == 1, f"resolve 必须单次 load(实际 {calls['n']})——多次 load 会有跨快照竞态"


def test_clear_relay_key_also_clears_owner(isolated_env):
    """clear 必须一并清 relay_key_owner（merge 语义），否则后续 ownerless key 继承旧 owner 被误判可信。"""
    save_clawhunt_auth({
        "access_token": "tok-A", "account_user": {"id": "A"},
        "relay_api_key": "sk-llmgate-akey", "relay_key_owner": "sub:A",
    })
    rk.clear_relay_key()
    assert "relay_key_owner" not in load_clawhunt_auth()
    # 后续写入一个 ownerless key（手动/历史路径），有登录态时绝不被旧 owner 误判可信
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-ownerless"})
    key, source = rk.resolve_relay_api_key()
    assert key is None and source == "unset"


def test_seed_uses_passed_api_key_not_global_resolve(isolated_env, monkeypatch):
    """run 传入的 api_key 优先，seed 绝不二次 resolve 全局状态（防 seed 期间并发切号写错 key）。"""
    from superclaw.backends import ClawWorkBackend

    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://relay.test/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-GLOBAL-A"})  # 全局 stored 是 A 的
    agent_dir = isolated_env / "artifacts" / "seed-agent"
    ClawWorkBackend._seed_clawrelay_provider(
        agent_dir, "relay/m",
        api_key="sk-llmgate-PASSED-B", base_url="https://relay.test/v1",
    )
    raw = (agent_dir / "models.json").read_text(encoding="utf-8")
    provider = json.loads(raw)
    assert provider["providers"]["clawrelay"]["apiKey"] == "sk-llmgate-PASSED-B"
    assert "GLOBAL-A" not in raw  # 绝不二次 resolve 全局 stored


def test_owned_key_not_released_without_identity(isolated_env):
    """登出/无身份状态下，带 owner 的 stored key 绝不放行（防无身份进程取用别账号 key，顾问第三轮）。"""
    # 无 access_token / account_user（无身份），但 key 带 owner=sub:A
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-akey", "relay_key_owner": "sub:A"})
    key, source = rk.resolve_relay_api_key()
    assert key is None and source == "unset"
    # 对照：无身份 + *无主*历史 key 仍可用（无串号方，不破坏纯缓存场景）
    rk.clear_relay_key()
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-ownerless-legacy"})
    key2, source2 = rk.resolve_relay_api_key()
    assert key2 == "sk-llmgate-ownerless-legacy" and source2 == "stored"


# ---------------------------------------------------------------------------
# relay base 信任统一收口：validate_relay_base_url / _mask_base_url + 余额查询 +
# relay_status/_post/model_discovery 脱敏与校验（顾问统一收口：防 relay key/secret
# 经整条 relay base 链路 exfil/回显）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("ok_base,expect", [
    ("https://api.clawhunt.site/v1", "https://api.clawhunt.site/v1"),
    ("https://api.clawhunt.site/v1/", "https://api.clawhunt.site/v1"),
    ("https://api.clawhunt.site", "https://api.clawhunt.site/v1"),  # 裸 host 规范化补 /v1
    ("http://localhost:8001/v1", "http://localhost:8001/v1"),
    ("http://127.0.0.1/v1", "http://127.0.0.1/v1"),
    ("http://127.0.0.2/v1", "http://127.0.0.2/v1"),  # 127/8 全是 loopback（ipaddress 判定）
    ("http://[::1]:8001/v1", "http://[::1]:8001/v1"),  # IPv6 loopback
])
def test_validate_relay_base_url_accepts_safe(ok_base, expect):
    assert rk.validate_relay_base_url(ok_base) == expect


@pytest.mark.parametrize("bad_base,code", [
    ("", "RELAY_BASE_URL_MISSING"),
    (None, "RELAY_BASE_URL_MISSING"),
    ("http://api.clawhunt.site/v1", "RELAY_BASE_URL_INSECURE"),            # remote http
    ("https://user@api.clawhunt.site/v1", "RELAY_BASE_URL_INVALID"),       # userinfo
    ("https://user:pass@api.clawhunt.site/v1", "RELAY_BASE_URL_INVALID"),
    ("https://api.clawhunt.site@evil.example/v1", "RELAY_BASE_URL_INVALID"),  # host→evil
    ("https://api.clawhunt.site/v1?x=1", "RELAY_BASE_URL_INVALID"),        # query
    ("https://api.clawhunt.site/v1#f", "RELAY_BASE_URL_INVALID"),          # fragment
    ("https://api.clawhunt.site\\@evil/v1", "RELAY_BASE_URL_INVALID"),     # 反斜杠
    ("https://api.clawhunt.site/v1\twith-tab", "RELAY_BASE_URL_INVALID"),  # 控制符
    ("ftp://api.clawhunt.site/v1", "RELAY_BASE_URL_INVALID"),              # scheme
    ("not-a-url", "RELAY_BASE_URL_INVALID"),                               # no host
    ("https://api.clawhunt.site/v2", "RELAY_BASE_URL_INVALID"),            # path
    ("https://api.clawhunt.site/v1/extra", "RELAY_BASE_URL_INVALID"),      # path
    ("https://api.clawhunt.site%40evil.example/v1", "RELAY_BASE_URL_INVALID"),  # %40=@ 编码绕过
    ("https://api.clawhunt.site/v1%2fx", "RELAY_BASE_URL_INVALID"),        # %2f 编码
    ("https://api%2eclawhunt%2esite/v1", "RELAY_BASE_URL_INVALID"),        # %2e=. 编码
    ("http://0.0.0.0/v1", "RELAY_BASE_URL_INSECURE"),                      # unspecified 非 loopback
    ("http://[::]/v1", "RELAY_BASE_URL_INSECURE"),                         # IPv6 unspecified 非 loopback
    ("http://[fd00::1]/v1", "RELAY_BASE_URL_INSECURE"),                    # IPv6 ULA 非 loopback
])
def test_validate_relay_base_url_rejects_unsafe(bad_base, code):
    with pytest.raises(rk.RelayKeyError, match=code):
        rk.validate_relay_base_url(bad_base)


def test_validate_relay_base_url_error_does_not_leak_secret():
    """invalid base 错误绝不回显原始 base（可能含 secret）。"""
    with pytest.raises(rk.RelayKeyError) as exc:
        rk.validate_relay_base_url("https://api.clawhunt.site/v1?token=SUPERSECRET")
    assert "SUPERSECRET" not in str(exc.value)


@pytest.mark.parametrize("url,expect", [
    ("https://api.clawhunt.site/v1?token=SECRET", "https://api.clawhunt.site"),
    ("https://user:pass@api.clawhunt.site/v1", "https://api.clawhunt.site"),
    ("https://api.clawhunt.site:8443/v1", "https://api.clawhunt.site:8443"),
    ("https://api.clawhunt.site", "https://api.clawhunt.site"),
    (None, "unset"),
    ("", "unset"),
    ("http://[::1]:8001/v1", "http://[::1]:8001"),  # IPv6 补回中括号
    ("not-a-url", "invalid"),
])
def test_mask_base_url(url, expect):
    assert rk._mask_base_url(url) == expect


def test_mask_base_url_never_leaks_secret():
    assert "SECRET" not in rk._mask_base_url("https://h/v1?token=SECRET")
    assert "pass" not in rk._mask_base_url("https://user:pass@h/v1")


def _balance_handler(*, status_code=200, body=None):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/user/balance"
        assert request.headers["Authorization"].startswith("Bearer ")
        return httpx.Response(
            status_code,
            json=body if body is not None else {"is_active": True, "balance": 12.34, "currency": "USD"},
        )

    return handler


def test_relay_balance_success(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    s = rk.relay_balance(transport=httpx.MockTransport(_balance_handler()))
    assert s["balance"] == 12.34 and s["currency"] == "USD" and s["is_active"] is True
    assert "sk-llmgate-balkey1" not in json.dumps(s)
    assert s["relay_key_prefix"].endswith("...")


@pytest.mark.parametrize("base,expect_url", [
    ("https://api.clawhunt.site/v1", "https://api.clawhunt.site/v1/user/balance"),
    ("https://api.clawhunt.site", "https://api.clawhunt.site/v1/user/balance"),
])
def test_relay_balance_url_and_bearer(isolated_env, monkeypatch, base, expect_url):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, base)
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-bearer1"})
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"] = str(request.url), request.headers.get("Authorization")
        return httpx.Response(200, json={"is_active": True, "balance": 1.0, "currency": "USD"})

    rk.relay_balance(transport=httpx.MockTransport(handler))
    assert seen["url"] == expect_url
    assert seen["auth"] == "Bearer sk-llmgate-bearer1"


def test_relay_balance_fail_closed_without_key(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    with pytest.raises(rk.RelayKeyError, match="RELAY_LOGIN_REQUIRED"):
        rk.relay_balance(transport=httpx.MockTransport(_balance_handler()))


def test_relay_balance_uses_baked_default_without_explicit_base(isolated_env):
    """No explicit SUPERCLAW_RELAY_BASE_URL → the env-baked per-environment relay
    default applies (relay is now configured-by-build, not fail-closed-without-config)."""
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"is_active": True, "balance": 12.34, "currency": "USD"})

    s = rk.relay_balance(transport=httpx.MockTransport(handler))
    assert s["balance"] == 12.34
    assert seen["url"] == rk.resolve_relay_base_url() + "/user/balance"


def test_relay_status_shows_resolved_baked_base_not_unset(isolated_env):
    """status must reflect the resolved relay base (single source). Without an explicit
    SUPERCLAW_RELAY_BASE_URL it shows the masked baked default, never 'unset'."""
    from superclaw.environment import relay_base_url
    from superclaw.relay_key import _mask_base_url

    status = rk.relay_status()
    assert status["relay_base_url"] == _mask_base_url(relay_base_url())
    assert status["relay_base_url"] not in ("unset", None)


def test_relay_balance_rejects_remote_http(isolated_env, monkeypatch):
    """remote http base → relay key 明文出网，fail-closed（统一收口阻断项）。"""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "http://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    with pytest.raises(rk.RelayKeyError, match="RELAY_BASE_URL_INSECURE"):
        rk.relay_balance(transport=httpx.MockTransport(_balance_handler()))


def test_relay_balance_allows_loopback_http(isolated_env, monkeypatch):
    """loopback http 允许（本地开发，无明文出网风险）。"""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "http://localhost:8001/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    s = rk.relay_balance(transport=httpx.MockTransport(_balance_handler()))
    assert s["balance"] == 12.34


def test_relay_balance_rejects_userinfo_base(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site@evil.example/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    with pytest.raises(rk.RelayKeyError, match="RELAY_BASE_URL_INVALID"):
        rk.relay_balance(transport=httpx.MockTransport(_balance_handler()))


def test_relay_balance_401(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    with pytest.raises(rk.RelayKeyError, match="RELAY_BALANCE_UNAUTHORIZED"):
        rk.relay_balance(transport=httpx.MockTransport(_balance_handler(status_code=401, body={"detail": "x"})))


@pytest.mark.parametrize("bad_currency", ["SECRET", "APIKEY", "sk-llmgate-LEAK", "usd", "AB1"])
def test_relay_balance_currency_whitelist(isolated_env, monkeypatch, bad_currency):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    s = rk.relay_balance(transport=httpx.MockTransport(_balance_handler(body={"is_active": True, "balance": 1.0, "currency": bad_currency})))
    assert s["currency"] == "USD"
    assert bad_currency not in json.dumps(s)


def test_relay_balance_overflow_and_nonfinite(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    s = rk.relay_balance(transport=httpx.MockTransport(_balance_handler(body={"is_active": True, "balance": 10 ** 400})))
    assert s["balance"] is None

    def nan_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b'{"is_active": true, "balance": NaN}', headers={"content-type": "application/json"})

    s2 = rk.relay_balance(transport=httpx.MockTransport(nan_handler))
    assert s2["balance"] is None


def test_relay_balance_is_active_strict(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-balkey1"})
    s = rk.relay_balance(transport=httpx.MockTransport(_balance_handler(body={"is_active": "false", "balance": 1.0})))
    assert s["is_active"] is False


def test_relay_status_masks_base_url_secret(isolated_env, monkeypatch):
    """relay status 的 base URL 展示脱敏：误配 secret 进 RELAY_BASE_URL 也不经 status 泄露。"""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1?token=SUPERSECRET")
    payload = rk.relay_status()
    assert "SUPERSECRET" not in json.dumps(payload)
    assert payload["relay_base_url"] == "https://api.clawhunt.site"


def test_bridge_post_error_masks_base_url_secret(isolated_env):
    """RelayBridgeClient 网络错误文案脱敏 base_url（不回显含 secret 的原始 URL）。"""
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = rk.RelayBridgeClient(
        base_url="https://api.clawhunt.site/v1?token=SUPERSECRET",
        transport=httpx.MockTransport(boom), allow_insecure=True,
    )
    try:
        with pytest.raises(rk.RelayKeyError) as exc:
            client.exchange("tok", "dev")
        assert "SUPERSECRET" not in str(exc.value)
    finally:
        client.close()


def test_model_discovery_probe_failsafe_on_unsafe_base(isolated_env, monkeypatch):
    """unsafe base(userinfo) → relay_packages 在 resolve_relay_base_url 处 fail-safe 降级，
    _probe_clawwork 返回默认套餐 floor，绝不外抛、绝不触网（套餐查询本就不带 relay key，
    且校验失败时根本不发任何请求）。"""
    from superclaw import model_discovery as md
    import superclaw.relay_packages as rp

    monkeypatch.setenv("SUPERCLAW_RELAY_BASE_URL", "https://api.clawhunt.site@evil.example/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-probekey"})
    fetched: dict = {}

    def boom_get(url, headers, *, transport=None):
        fetched["hit"] = url
        raise AssertionError("校验失败时绝不应发起套餐查询")

    monkeypatch.setattr(rp, "_get_json", boom_get)
    result = md._probe_clawwork(None)  # 不抛
    assert result == ["core", "plus", "max"]  # 默认 floor
    assert "hit" not in fetched  # base 校验失败 → 绝不发任何套餐查询请求


def test_http_get_json_refuses_redirect():
    """_http_get_json 禁重定向：30x 不发第二跳，带 Authorization 的 relay key 绝不外泄到
    重定向目的地（顾问统一收口阻断项：urllib 默认会把 Authorization 复制到 redirect）。"""
    import urllib.error

    from superclaw import model_discovery as md

    hops: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hops.append(str(request.url))
        if "evil" in str(request.url):  # 第二跳（绝不应到达）
            return httpx.Response(200, json={"data": []})
        return httpx.Response(302, headers={"Location": "https://evil.example/models"})

    with pytest.raises(urllib.error.HTTPError):  # 302 → HTTPError → probe error
        md._http_get_json(
            "https://api.clawhunt.site/v1/models",
            {"Authorization": "Bearer SECRETKEY"},
            transport=httpx.MockTransport(handler),
        )
    assert hops == ["https://api.clawhunt.site/v1/models"]  # 只第一跳，绝不跟随到 evil


def test_openai_models_no_redirect_follow_leaks_key():
    """端到端：_openai_models 经 _http_get_json，30x 不会把 Bearer key 带到 evil host。"""
    from superclaw import model_discovery as md

    hops: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hops.append(str(request.url))
        return httpx.Response(302, headers={"Location": "https://evil.example/v1/models"})

    import urllib.error
    with pytest.raises(urllib.error.HTTPError):
        # 直接驱动 _http_get_json（_openai_models 内部用它），注入 mock transport
        md._http_get_json(
            "https://api.clawhunt.site/v1/models",
            {"Authorization": "Bearer SECRETKEY"},
            transport=httpx.MockTransport(handler),
        )
    assert all("evil" not in h for h in hops)


def test_classify_probe_error_httpx_network():
    """_http_get_json 迁 httpx 后，httpx 网络/超时异常归 network:（顾问第三轮回归修复）。"""
    from superclaw import model_discovery as md

    assert md._classify_probe_error(httpx.ConnectError("refused")).startswith("network:")
    assert md._classify_probe_error(httpx.ReadTimeout("timeout")).startswith("network:")
    assert md._classify_probe_error(httpx.ConnectTimeout("timeout")).startswith("network:")


def test_probe_clawwork_builds_api_v1_url_from_bare_base(isolated_env, monkeypatch):
    """裸 host base 经 validate 规范化后，套餐查询打 <base>/api/v1/...（管理面，剥掉
    OpenAI 面的 /v1 再拼），消除 endpoint 漂移；_probe_clawwork 仍只返回套餐 id。"""
    from superclaw import model_discovery as md
    import superclaw.relay_packages as rp

    monkeypatch.setenv("SUPERCLAW_RELAY_BASE_URL", "https://relay.test")  # 裸 host，无 /v1
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-probekey"})
    seen: dict = {"urls": []}

    def fake_get(url, headers, *, transport=None):
        seen["urls"].append(url)
        return None  # 无目录 → 降级默认 floor

    monkeypatch.setattr(rp, "_get_json", fake_get)
    result = md._probe_clawwork(None)
    assert result == ["core", "plus", "max"]  # 降级默认 floor
    assert seen["urls"][0] == "https://relay.test/api/v1/bridge/packages"


def test_cli_relay_balance(isolated_env, monkeypatch):
    runner, cli_module = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))
    monkeypatch.setattr(
        cli_module, "relay_balance",
        lambda: {"balance": 5.0, "currency": "USD", "is_active": True,
                 "relay_key_source": "stored", "relay_key_prefix": "sk-llmgate-cl..."},
    )
    result = runner.invoke(cli_module.app, ["relay", "balance", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["balance"] == 5.0 and payload["currency"] == "USD"


def test_cli_relay_balance_error_json(isolated_env, monkeypatch):
    runner, cli_module = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))

    def boom():
        raise rk.RelayKeyError("RELAY_LOGIN_REQUIRED: x")

    monkeypatch.setattr(cli_module, "relay_balance", boom)
    result = runner.invoke(cli_module.app, ["relay", "balance", "--json"])
    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False and "RELAY_LOGIN_REQUIRED" in payload["error"]


# --- relay usage（消费 + 配额查询，调 LLMgate /v1/user/usage，与 balance 同一安全姿态）---


def _usage_handler(*, status_code=200, body=None):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/user/usage"
        assert request.headers["Authorization"].startswith("Bearer ")
        return httpx.Response(
            status_code,
            json=body if body is not None else {
                "key_credits_used": 3.5, "key_quota_limit": 10.0,
                "account_balance": 6.5, "is_active": True, "currency": "USD",
            },
        )

    return handler


def test_relay_usage_success(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    s = rk.relay_usage(transport=httpx.MockTransport(_usage_handler()))
    assert s["key_credits_used"] == 3.5
    assert s["key_quota_limit"] == 10.0
    assert s["account_balance"] == 6.5
    assert s["currency"] == "USD" and s["is_active"] is True
    # 绝不回显 key 明文，只回脱敏前缀
    assert "sk-llmgate-usekey1" not in json.dumps(s)
    assert s["relay_key_prefix"].endswith("...")


@pytest.mark.parametrize("base,expect_url", [
    ("https://api.clawhunt.site/v1", "https://api.clawhunt.site/v1/user/usage"),
    ("https://api.clawhunt.site", "https://api.clawhunt.site/v1/user/usage"),
])
def test_relay_usage_url_and_bearer(isolated_env, monkeypatch, base, expect_url):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, base)
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-bearer2"})
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"] = str(request.url), request.headers.get("Authorization")
        return httpx.Response(200, json={
            "key_credits_used": 1.0, "key_quota_limit": 0.0,
            "account_balance": 1.0, "is_active": True, "currency": "USD",
        })

    rk.relay_usage(transport=httpx.MockTransport(handler))
    assert seen["url"] == expect_url
    assert seen["auth"] == "Bearer sk-llmgate-bearer2"


def test_relay_usage_fail_closed_without_key(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    with pytest.raises(rk.RelayKeyError, match="RELAY_LOGIN_REQUIRED"):
        rk.relay_usage(transport=httpx.MockTransport(_usage_handler()))


def test_relay_usage_uses_baked_default_without_explicit_base(isolated_env):
    """No explicit SUPERCLAW_RELAY_BASE_URL → the env-baked per-environment relay
    default applies (relay is now configured-by-build, not fail-closed-without-config)."""
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(
            200,
            json={
                "key_credits_used": 3.5, "key_quota_limit": 10.0,
                "account_balance": 6.5, "is_active": True, "currency": "USD",
            },
        )

    rk.relay_usage(transport=httpx.MockTransport(handler))
    assert seen["url"] == rk.resolve_relay_base_url() + "/user/usage"


def test_relay_usage_rejects_remote_http(isolated_env, monkeypatch):
    """remote http base → relay key 明文出网，fail-closed（与 balance 同一统一收口）。"""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "http://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    with pytest.raises(rk.RelayKeyError, match="RELAY_BASE_URL_INSECURE"):
        rk.relay_usage(transport=httpx.MockTransport(_usage_handler()))


def test_relay_usage_rejects_userinfo_base(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site@evil.example/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    with pytest.raises(rk.RelayKeyError, match="RELAY_BASE_URL_INVALID"):
        rk.relay_usage(transport=httpx.MockTransport(_usage_handler()))


def test_relay_usage_401(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    with pytest.raises(rk.RelayKeyError, match="RELAY_USAGE_UNAUTHORIZED"):
        rk.relay_usage(transport=httpx.MockTransport(_usage_handler(status_code=401, body={"detail": "x"})))


@pytest.mark.parametrize("bad_currency", ["SECRET", "APIKEY", "sk-llmgate-LEAK", "usd", "AB1"])
def test_relay_usage_currency_whitelist(isolated_env, monkeypatch, bad_currency):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    s = rk.relay_usage(transport=httpx.MockTransport(_usage_handler(body={
        "is_active": True, "key_credits_used": 1.0, "key_quota_limit": 0.0,
        "account_balance": 1.0, "currency": bad_currency,
    })))
    assert s["currency"] == "USD"
    assert bad_currency not in json.dumps(s)


def test_relay_usage_overflow_and_nonfinite(isolated_env, monkeypatch):
    """三个数值字段均经 _coerce_finite_amount：超大整数 / NaN 一律收敛为 None。"""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    s = rk.relay_usage(transport=httpx.MockTransport(_usage_handler(body={
        "is_active": True, "key_credits_used": 10 ** 400,
        "key_quota_limit": 10 ** 400, "account_balance": 10 ** 400,
    })))
    assert s["key_credits_used"] is None
    assert s["key_quota_limit"] is None
    assert s["account_balance"] is None

    def nan_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b'{"is_active": true, "key_credits_used": NaN, "key_quota_limit": 1.0, "account_balance": 1.0}',
            headers={"content-type": "application/json"},
        )

    s2 = rk.relay_usage(transport=httpx.MockTransport(nan_handler))
    assert s2["key_credits_used"] is None
    assert s2["key_quota_limit"] == 1.0  # 同响应里的合法值不受污染


def test_relay_usage_quota_zero_is_unlimited_not_missing(isolated_env, monkeypatch):
    """quota_limit=0（不限额）必须收敛为数值 0.0，绝不被当缺失（None）——否则 CLI 误显 unknown。"""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    s = rk.relay_usage(transport=httpx.MockTransport(_usage_handler(body={
        "is_active": True, "key_credits_used": 0, "key_quota_limit": 0, "account_balance": 5.0,
    })))
    assert s["key_quota_limit"] == 0.0 and s["key_quota_limit"] is not None
    assert s["key_credits_used"] == 0.0 and s["key_credits_used"] is not None


def test_relay_usage_is_active_strict(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    s = rk.relay_usage(transport=httpx.MockTransport(_usage_handler(body={"is_active": "false", "key_credits_used": 1.0})))
    assert s["is_active"] is False


def test_cli_relay_usage(isolated_env, monkeypatch):
    runner, cli_module = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))
    monkeypatch.setattr(
        cli_module, "relay_usage",
        lambda: {"key_credits_used": 3.5, "key_quota_limit": 10.0, "account_balance": 6.5,
                 "currency": "USD", "is_active": True,
                 "relay_key_source": "stored", "relay_key_prefix": "sk-llmgate-cl..."},
    )
    result = runner.invoke(cli_module.app, ["relay", "usage", "--json"])
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["key_credits_used"] == 3.5 and payload["key_quota_limit"] == 10.0
    assert payload["account_balance"] == 6.5


def test_cli_relay_usage_unknown_render(isolated_env, monkeypatch):
    """非 json：三个数值字段缺失（None）时显式渲染 unknown，绝不被 _print_relay_summary 静默跳过。"""
    runner, cli_module = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))
    monkeypatch.setattr(
        cli_module, "relay_usage",
        lambda: {"key_credits_used": None, "key_quota_limit": None, "account_balance": None,
                 "currency": "USD", "is_active": True,
                 "relay_key_source": "stored", "relay_key_prefix": "sk-llmgate-cl..."},
    )
    result = runner.invoke(cli_module.app, ["relay", "usage"])
    assert result.exit_code == 0, result.output
    assert "key_credits_used=unknown" in result.output
    assert "key_quota_limit=unknown" in result.output
    assert "account_balance=unknown" in result.output


def test_cli_relay_usage_error_json(isolated_env, monkeypatch):
    runner, cli_module = _cli()
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(isolated_env / "shell-config.json"))

    def boom():
        raise rk.RelayKeyError("RELAY_LOGIN_REQUIRED: x")

    monkeypatch.setattr(cli_module, "relay_usage", boom)
    result = runner.invoke(cli_module.app, ["relay", "usage", "--json"])
    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False and "RELAY_LOGIN_REQUIRED" in payload["error"]


# --- ClawWork 执行路径收口（最核心消费点：clawwork 用 relay key 调 base，顾问阻断项）---

def test_clawwork_availability_rejects_unsafe_base(isolated_env, monkeypatch):
    """available() 校验 base：不安全 base（userinfo 注入）→ not available，不显示假 READY。"""
    from superclaw.backends import ClawWorkBackend

    _governed_clawwork_env(isolated_env, monkeypatch)
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site@evil.example/v1")
    av = ClawWorkBackend().available()
    assert av.available is False
    assert "invalid/unsafe" in av.reason


def test_clawwork_run_fails_closed_on_unsafe_base(isolated_env, monkeypatch):
    """run() 对不安全 base fail-closed（125），绝不把 relay key 写进 models.json 给攻击者 host。"""
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"}})
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site@evil.example/v1")

    def fake_ensure(**kwargs):
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-k", "relay_key_owner": rk._current_account_identity(),
        })
        return {"source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)
    assert result.exit_code == 125
    assert "CLAWWORK_RELAY_BASE_INVALID" in result.output
    assert "provider" not in capture  # 不安全 base → 从未 seed / spawn


def test_clawwork_seed_rejects_unsafe_base(isolated_env):
    """seed 写 models.json 前校验 base（纵深）：不安全 base → raise，绝不写 baseUrl。"""
    from superclaw.backends import ClawWorkBackend

    agent_dir = isolated_env / "artifacts" / "seed-unsafe"
    with pytest.raises(rk.RelayKeyError, match="RELAY_BASE_URL_INVALID"):
        ClawWorkBackend._seed_clawrelay_provider(
            agent_dir, "m", api_key="sk-llmgate-k",
            base_url="https://api.clawhunt.site@evil.example/v1",
        )
    assert not (agent_dir / "models.json").exists()


# ---------------------------------------------------------------------------
# 7. 套餐档位绑定（issue #452：relay key 按 tier 绑分组）
# ---------------------------------------------------------------------------

def _tier_capture_bridge(captured: dict, *, ensure_created: bool = True):
    """正常服务端 + 捕获每次 exchange 的请求体；按所选 tier 返回**不同**的 key 明文，
    以便断言切档真正换池（不同 device → 不同 key）。"""
    state = {"last_tier": None}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v1/bridge/exchange":
            body = json.loads(request.content)
            state["last_tier"] = body.get("tier") or "core"
            captured.setdefault("exchanges", []).append(body)
            return httpx.Response(200, json={
                "bridge_token": "bt-test", "token_type": "bearer",
                "expires_in_seconds": 600, "user_id": 1,
                "auth_source": "clawhunt_bridge", "account_created": True,
            })
        tier = state["last_tier"] or "core"
        if path == "/api/v1/bridge/keys/ensure":
            return httpx.Response(200, json={
                "id": 1, "name": f"superclaw-clawwork:dev-{tier}", "key_prefix": "sk-llmgate-en...",
                "quota_limit": "2.0", "rate_limit": 30, "credits_used": "0",
                "expires_at": None, "status": "active", "is_active": True,
                "created": ensure_created,
                "key": f"sk-llmgate-ensure-{tier}-PLAINTEXT" if ensure_created else None,
            })
        if path == "/api/v1/bridge/keys/rotate":
            return httpx.Response(200, json={
                "id": 2, "name": f"superclaw-clawwork:dev-{tier}", "key_prefix": "sk-llmgate-ro...",
                "quota_limit": "2.0", "rate_limit": 30, "credits_used": "0",
                "expires_at": None, "status": "active", "is_active": True,
                "created": True, "key": f"sk-llmgate-rotate-{tier}-PLAINTEXT",
            })
        raise AssertionError(f"unexpected path {path}")

    return handler


@pytest.mark.parametrize("raw,expect", [
    ("plus", "plus"), ("PLUS", "plus"), ("  Max ", "max"), ("core", "core"),
    ("bogus", None), ("", None), (None, None), ("superclaw-plus", None), (123, None),
])
def test_normalize_tier(raw, expect):
    assert rk._normalize_tier(raw) == expect


@pytest.mark.parametrize("tier,expect", [
    ("plus", "superclaw-plus"), ("max", "superclaw-max"), ("core", "superclaw-core"),
    ("bogus", None), (None, None),
])
def test_group_slug_for_tier(tier, expect):
    assert rk._group_slug_for_tier(tier) == expect


def test_apply_tier_to_device_id():
    assert rk._apply_tier_to_device_id("sc-abc", "plus") == "sc-abc-plus"
    assert rk._apply_tier_to_device_id("sc-abc", "MAX") == "sc-abc-max"
    # 非法/缺失 tier → 基础 device 原样（fail-safe core，不分档）
    assert rk._apply_tier_to_device_id("sc-abc", "bogus") == "sc-abc"
    assert rk._apply_tier_to_device_id("sc-abc", None) == "sc-abc"
    # 总长 ≤64（与服务端 _DEVICE_ID_RE 上限一致）
    long_base = "sc-" + "a" * 70
    plus_id = rk._apply_tier_to_device_id(long_base, "plus")
    max_id = rk._apply_tier_to_device_id(long_base, "max")
    assert len(plus_id) <= 64 and len(max_id) <= 64
    # 回归（Codex 对抗项 #6）：长 base device id 也绝不丢 tier 后缀——否则 plus/max/core 会撞到
    # 同一服务端 key name，重引入 #452 撞名。tier 标记必须存活且 plus≠max。
    assert plus_id.endswith("-plus") and max_id.endswith("-max")
    assert plus_id != max_id
    # 边界：base 恰好 64 时,仍要为后缀腾出空间(截 base 而非丢后缀)
    edge = rk._apply_tier_to_device_id("d" * 64, "max")
    assert edge.endswith("-max") and len(edge) <= 64


def test_exchange_sends_normalized_tier(isolated_env):
    captured: dict = {}
    _mock_bridge(_tier_capture_bridge(captured)).exchange("tok", "dev-1", tier="PLUS")
    body = captured["exchanges"][0]
    assert body["tier"] == "plus"           # 规范化小写
    assert body["device_id"] == "dev-1"


def test_exchange_omits_invalid_or_absent_tier(isolated_env):
    captured: dict = {}
    _mock_bridge(_tier_capture_bridge(captured)).exchange("tok", "dev-1", tier="bogus")
    _mock_bridge(_tier_capture_bridge(captured)).exchange("tok", "dev-1")  # 无 tier（向后兼容）
    # 非法 tier 与缺失 tier 都不带 tier 字段（中转站 fail-safe core）
    assert all("tier" not in body for body in captured["exchanges"])


def test_ensure_with_tier_binds_and_persists(isolated_env):
    save_clawhunt_auth({"access_token": "main-site-token", "account_user": {"id": 42}})
    captured: dict = {}
    summary = rk.ensure_relay_key(tier="plus", client=_mock_bridge(_tier_capture_bridge(captured)))
    # exchange 收到规范化 tier + device 分档后缀
    body = captured["exchanges"][0]
    assert body["tier"] == "plus"
    assert body["device_id"].endswith("-plus")
    # 摘要含档位 + 分组 slug（验收：可见 superclaw-plus），且无明文
    assert summary["tier"] == "plus"
    assert summary["group_slug"] == "superclaw-plus"
    assert "PLAINTEXT" not in json.dumps(summary)
    # 落盘 relay_key_tier，与 owner 平行隔离
    auth = load_clawhunt_auth()
    assert auth["relay_key_tier"] == "plus"
    assert auth["relay_key_owner"] == "sub:42"


def test_ensure_same_tier_cache_hit_no_network(isolated_env):
    save_clawhunt_auth({"access_token": "tok", "account_user": {"id": 1}})
    rk.ensure_relay_key(tier="plus", client=_mock_bridge(_tier_capture_bridge({})))

    def explode(request):  # pragma: no cover - 同档命中不应触网
        raise AssertionError("same-tier ensure must not touch network")

    summary = rk.ensure_relay_key(tier="plus", client=_mock_bridge(explode))
    assert summary["source"] == "stored"
    assert summary["tier"] == "plus"
    assert summary["group_slug"] == "superclaw-plus"


def test_ensure_tier_switch_reprovisions(isolated_env):
    """验收 #4：切档（plus↔max）触发重发，新 key 绑新分组，绝不复用旧档 key。"""
    save_clawhunt_auth({"access_token": "tok", "account_user": {"id": 1}})
    rk.ensure_relay_key(tier="plus", client=_mock_bridge(_tier_capture_bridge({})))
    plus_key = load_clawhunt_auth()["relay_api_key"]

    captured: dict = {}
    summary = rk.ensure_relay_key(tier="max", client=_mock_bridge(_tier_capture_bridge(captured)))
    assert summary["source"] == "auto"            # 重发，非缓存命中
    assert summary["tier"] == "max"
    assert summary["group_slug"] == "superclaw-max"
    body = captured["exchanges"][0]
    assert body["tier"] == "max"
    assert body["device_id"].endswith("-max")
    auth = load_clawhunt_auth()
    assert auth["relay_key_tier"] == "max"
    assert auth["relay_api_key"] != plus_key      # 换池，不复用旧 plus key


def test_ensure_core_does_not_reuse_paid_cached_key(isolated_env):
    """Codex 终审阻断项：账号已有 max 缓存 key 时，显式 ensure(tier='core')（动态套餐走的路径）
    绝不复用 max key —— 档位闸命中失配触发重发 core-bound key，保证 key 隔离确定性。"""
    save_clawhunt_auth({"access_token": "tok", "account_user": {"id": 1}})
    rk.ensure_relay_key(tier="max", client=_mock_bridge(_tier_capture_bridge({})))
    max_key = load_clawhunt_auth()["relay_api_key"]
    assert load_clawhunt_auth()["relay_key_tier"] == "max"
    # 显式 core（动态档 backends 传 "core"）：不复用 max，重发 core-bound key
    summary = rk.ensure_relay_key(tier="core", client=_mock_bridge(_tier_capture_bridge({})))
    assert summary["source"] == "auto"            # 重发，非缓存命中
    assert summary["tier"] == "core"
    auth = load_clawhunt_auth()
    assert auth["relay_key_tier"] == "core"
    assert auth["relay_api_key"] != max_key       # 绝不挪用付费档 max key


def test_owned_stored_key_tier_gate():
    base = {"relay_api_key": "k", "relay_key_owner": "sub:1",
            "account_user": {"id": 1}, "relay_key_tier": "plus"}
    assert rk._owned_stored_key(base, tier="plus") == "k"   # 同档命中
    assert rk._owned_stored_key(base, tier="max") == ""     # 切档 miss
    assert rk._owned_stored_key(base, tier=None) == "k"     # tier=None 不 gate（通用消费方）
    # 无档位标签的旧 key 视同 core（fail-safe 绑定档）
    legacy = {"relay_api_key": "k", "relay_key_owner": "sub:1", "account_user": {"id": 1}}
    assert rk._owned_stored_key(legacy, tier="core") == "k"
    assert rk._owned_stored_key(legacy, tier="plus") == ""


def test_status_shows_bound_tier(isolated_env):
    save_clawhunt_auth({"access_token": "tok", "account_user": {"id": 1}})
    rk.ensure_relay_key(tier="plus", client=_mock_bridge(_tier_capture_bridge({})))
    status = rk.relay_status()
    assert status["relay_key_tier"] == "plus"
    assert status["relay_key_group_slug"] == "superclaw-plus"


def test_clear_clears_tier(isolated_env):
    save_clawhunt_auth({"access_token": "tok", "account_user": {"id": 1}})
    rk.ensure_relay_key(tier="plus", client=_mock_bridge(_tier_capture_bridge({})))
    assert load_clawhunt_auth().get("relay_key_tier") == "plus"
    rk.clear_relay_key()
    assert load_clawhunt_auth().get("relay_key_tier") is None


def test_manual_env_key_is_tier_agnostic(isolated_env, monkeypatch):
    """手动 env 逃生口不分档：ensure(tier=plus) 仍走 env 快速返回，不触网。"""
    monkeypatch.setenv(rk.RELAY_KEY_ENV, "sk-llmgate-manual-xyz")

    def explode(request):  # pragma: no cover
        raise AssertionError("manual env must not touch network")

    summary = rk.ensure_relay_key(tier="plus", client=_mock_bridge(explode))
    assert summary["source"] == "env"


# ---------------------------------------------------------------------------
# 8. 解锁上限缓存（issue #452 方案 B：读 /api/auth/me 的 tier）
# ---------------------------------------------------------------------------

class _FakeMeClient:
    """ClawHuntAccountClient.me() 的进程内替身（无真网络）。"""

    def __init__(self, payload, *, raise_exc: Exception | None = None):
        self._payload = payload
        self._raise = raise_exc
        self.calls: list[str] = []

    def me(self, token: str):
        self.calls.append(token)
        if self._raise is not None:
            raise self._raise
        return self._payload


def test_refresh_tier_ceiling_unlogged_no_fetch(isolated_env):
    fake = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": "plus"}})
    assert rk.refresh_tier_ceiling(client=fake) is None
    assert fake.calls == []          # 未登录绝不触网


def test_refresh_tier_ceiling_reads_and_caches(isolated_env):
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": "PLUS"}})
    assert rk.refresh_tier_ceiling(client=fake) == "plus"     # 规范化
    assert load_clawhunt_auth()["superclaw_tier_ceiling"] == "plus"
    assert fake.calls == ["tok"]


def test_refresh_tier_ceiling_null_tier_falls_core(isolated_env):
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": None}})
    assert rk.refresh_tier_ceiling(client=fake) == "core"     # 未持卡 → core
    assert load_clawhunt_auth()["superclaw_tier_ceiling"] == "core"


def test_refresh_tier_ceiling_non_ok_keeps_cache(isolated_env):
    """/me 抖动（非 200）绝不把付费用户降级到 core——保留已缓存上限。"""
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "plus"})
    fake = _FakeMeClient({"ok": False, "status_code": 500, "body": {}})
    assert rk.refresh_tier_ceiling(client=fake) == "plus"
    assert load_clawhunt_auth()["superclaw_tier_ceiling"] == "plus"


def test_refresh_tier_ceiling_network_error_keeps_cache(isolated_env):
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "max"})
    fake = _FakeMeClient(None, raise_exc=RuntimeError("boom"))
    assert rk.refresh_tier_ceiling(client=fake) == "max"      # best-effort 保留


def test_cached_tier_ceiling_unlogged_none(isolated_env):
    assert rk.cached_tier_ceiling() is None                   # 未登录 → 不 clamp


def test_cached_tier_ceiling_logged_defaults_core(isolated_env):
    save_clawhunt_auth({"access_token": "tok"})
    assert rk.cached_tier_ceiling() == "core"                 # 已登录至少 core


def test_cached_tier_ceiling_logged_value_and_invalid(isolated_env):
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "plus"})
    assert rk.cached_tier_ceiling() == "plus"
    save_clawhunt_auth({"superclaw_tier_ceiling": "enterprise"})  # 非法残留回落 core
    assert rk.cached_tier_ceiling() == "core"


def test_cached_or_refresh_tier_ceiling(isolated_env):
    """Codex 复审阻断项 #1：已登录但**从未缓存**上限（刚登录——save 清旧 ceiling——/ 旧 auth）→
    刷新一次并缓存，不再被当 core；字段已存在则纯缓存不触网；未登录 → None 不触网。"""
    # 未登录 → None，绝不触网
    fake0 = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": "plus"}})
    assert rk.cached_or_refresh_tier_ceiling(client=fake0) is None
    assert fake0.calls == []
    # 已登录但无 ceiling 字段 → 刷新一次并落盘
    save_clawhunt_auth({"access_token": "tok"})
    fake1 = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": "plus"}})
    assert rk.cached_or_refresh_tier_ceiling(client=fake1) == "plus"
    assert fake1.calls == ["tok"]
    assert load_clawhunt_auth()["superclaw_tier_ceiling"] == "plus"
    # 字段已缓存 → 纯缓存，绝不再触网
    fake2 = _FakeMeClient(None, raise_exc=AssertionError("must not refresh when already cached"))
    assert rk.cached_or_refresh_tier_ceiling(client=fake2) == "plus"
    assert fake2.calls == []


def test_status_includes_tier_ceiling(isolated_env):
    assert rk.relay_status()["tier_ceiling"] is None          # 未登录
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "max"})
    assert rk.relay_status()["tier_ceiling"] == "max"


# ---------------------------------------------------------------------------
# 9. 越级 clamp 判定 + 切号失效上限（issue #452 方案 C）
# ---------------------------------------------------------------------------

def test_check_tier_within_ceiling_unlogged_allows(isolated_env):
    # 未登录：无账号上限概念，任何档位都放行（交 LLMgate/余额兜底），且不触网刷新
    fake = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": "core"}})
    allowed, ceiling, sel = rk.check_tier_within_ceiling("max", refresh_client=fake)
    assert allowed is True and ceiling is None and sel == "max"
    assert fake.calls == []


def test_check_tier_within_ceiling_within_limit_no_refresh(isolated_env):
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "plus"})
    # plus ≤ plus：放行且**不触网**（正常路径零刷新）
    fake = _FakeMeClient(None, raise_exc=AssertionError("must not refresh within-limit"))
    allowed, ceiling, sel = rk.check_tier_within_ceiling("plus", refresh_client=fake)
    assert allowed is True and ceiling == "plus" and sel == "plus"
    assert fake.calls == []


def test_check_tier_within_ceiling_over_limit_refreshes_then_blocks(isolated_env):
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "core"})
    # 选 max 超过 core：先刷新（fetch 确认仍 core）再拦
    fake = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": "core"}})
    allowed, ceiling, sel = rk.check_tier_within_ceiling("max", refresh_client=fake)
    assert allowed is False and ceiling == "core" and sel == "max"
    assert fake.calls == ["tok"]            # 疑似越级才触网


def test_check_tier_within_ceiling_over_limit_refresh_unblocks_upgraded(isolated_env):
    """刚升级、本地 ceiling 仍 stale：刷新拿到新上限后放行（不误拦）。"""
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "core"})
    fake = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": "max"}})
    allowed, ceiling, sel = rk.check_tier_within_ceiling("max", refresh_client=fake)
    assert allowed is True and ceiling == "max"


def test_check_tier_within_ceiling_nonstandard_passthrough(isolated_env):
    # 动态套餐 / 裸模型不参与 clamp（selected_norm=None → 原样放行）
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "core"})
    allowed, ceiling, sel = rk.check_tier_within_ceiling("some-dynamic-pkg")
    assert allowed is True and sel is None


def test_account_switch_invalidates_tier_ceiling(isolated_env):
    """切号（写入不同 access_token）必须作废旧账号的解锁上限，杜绝串档越级漏拦。"""
    save_clawhunt_auth({"access_token": "tok-A", "account_user": {"id": "A"},
                        "superclaw_tier_ceiling": "max"})
    assert load_clawhunt_auth()["superclaw_tier_ceiling"] == "max"
    # 账号 B 登录：旧 max 上限作废
    save_clawhunt_auth({"access_token": "tok-B", "account_user": {"id": "B"}})
    assert load_clawhunt_auth().get("superclaw_tier_ceiling") is None
    # 已登录但无 ceiling → cached 回落 core（B 越级选 max 会被 clamp）
    assert rk.cached_tier_ceiling() == "core"


def test_same_account_resave_keeps_tier_ceiling(isolated_env):
    """同账号重复 save（如 relay key 刷新）不得误清上限。"""
    save_clawhunt_auth({"access_token": "tok-A", "superclaw_tier_ceiling": "plus"})
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-x"})   # 不带 access_token
    assert load_clawhunt_auth()["superclaw_tier_ceiling"] == "plus"
    save_clawhunt_auth({"access_token": "tok-A"})           # 同 token 再写
    assert load_clawhunt_auth()["superclaw_tier_ceiling"] == "plus"


# ---------------------------------------------------------------------------
# 10. ClawWork run 的档位 clamp + 默认跟随上限 + ensure 绑档（方案 C 集成）
# ---------------------------------------------------------------------------

def test_clawwork_run_blocks_over_tier(isolated_env, monkeypatch):
    """选超过解锁上限的档 → run fail-closed CLAWWORK_TIER_NOT_UNLOCKED（125），从不起跑。"""
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "core"})
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "plus")
    monkeypatch.setattr(rk, "refresh_tier_ceiling", lambda **kw: "core")  # 刷新确认仍 core
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)
    result = _run_clawwork(backend, isolated_env)
    assert result.exit_code == 125
    assert "CLAWWORK_TIER_NOT_UNLOCKED" in result.output
    assert "provider" not in capture            # 越级在 ensure/seed 之前就拦，从未起跑


def test_clawwork_run_default_follows_ceiling_and_binds_tier(isolated_env, monkeypatch):
    """未显式选档 → 默认跟随解锁上限（plus），ensure 收到 tier=plus（绑 superclaw-plus）。"""
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "plus"})
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_MODEL", raising=False)
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)
    seen: dict = {}

    def fake_ensure(*, tier=None, **kw):
        seen["tier"] = tier
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-plus-key",
            "relay_key_owner": rk._current_account_identity(),
            "relay_key_tier": tier,  # 忠实于真实 ensure:落档位,使 post-ensure tier-aware resolve 命中
        })
        return {"source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)
    assert result.exit_code == 0
    assert seen["tier"] == "plus"               # 默认档跟随 ceiling，并传给 ensure 绑档


def test_clawwork_run_passes_explicit_tier_to_ensure(isolated_env, monkeypatch):
    """显式选 max（≤ 上限 max）→ ensure 收到 tier=max。"""
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "max"})
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "max")
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)
    seen: dict = {}

    def fake_ensure(*, tier=None, **kw):
        seen["tier"] = tier
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-max-key",
            "relay_key_owner": rk._current_account_identity(),
            "relay_key_tier": tier,  # 忠实于真实 ensure:落档位,使 post-ensure tier-aware resolve 命中
        })
        return {"source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)
    assert result.exit_code == 0
    assert seen["tier"] == "max"


def test_clawwork_run_dynamic_tier_runs_not_refused(isolated_env, monkeypatch):
    """动态套餐（经 catalog 翻成 superclaw-* slug，如 pro）**不被 refuse**——照常起跑，保留既有
    动态翻译执行契约（见 test_worker_backends 的动态翻译测试）。selected_tier=None → ensure 收到
    **显式 "core"**（绝不 None，否则档位闸被跳过会复用付费 key；绑 fail-safe core，逐档 key 绑定列
    backlog）；命令模型是翻译后的动态分组 slug。Codex 复审：refuse-guard 会破坏既有契约,改为仅 log。"""
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "max"})
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "pro")  # 动态档：非 core/plus/max
    import superclaw.relay_packages as rp
    monkeypatch.setattr(rp, "relay_packages", lambda: {
        "packages": [{"id": "pro", "name": "Pro", "tier": "pro", "group_slug": "superclaw-pro"}],
        "source": "catalog", "available": True,
    })
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)
    seen: dict = {}

    def fake_ensure(*, tier=None, **kw):
        seen["tier"] = tier
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-pro-key",
            "relay_key_owner": rk._current_account_identity(),
        })
        return {"source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)
    assert result.exit_code == 0                                  # 不 refuse，照常起跑
    assert "CLAWWORK_DYNAMIC_TIER_UNSUPPORTED" not in result.output
    # 动态档 ensure 收到显式 "core"（绝不 None——否则档位闸被跳过会复用付费档 key，Codex 终审阻断项）
    assert seen.get("tier") == "core"
    assert capture["provider"]["providers"]["clawrelay"]["models"] == [{"id": "superclaw-pro"}]  # 翻译后 slug


def test_clawwork_run_bare_model_binds_core_not_paid_key(isolated_env, monkeypatch):
    """裸模型 override（relay/raw-model：selected_tier=None 且翻译后**非** superclaw-*，既有测试允许
    透传）也走 ensure_tier="core"，绝不传 None → 绝不复用账号已有的付费缓存 key（Codex 终审阻断项：
    标准档/动态档/裸模型全覆盖，ensure 永不收到 None）。"""
    save_clawhunt_auth({"access_token": "tok", "superclaw_tier_ceiling": "max"})
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "relay/raw-model")  # 裸模型 override
    import superclaw.relay_packages as rp
    # 钉死套餐目录为默认 floor（不含 raw-model）→ translate 判定非套餐 → 原样透传，且不触网。
    monkeypatch.setattr(rp, "relay_packages", lambda: {
        "packages": rp.default_relay_packages(), "source": "default", "available": True,
    })
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)
    seen: dict = {}

    def fake_ensure(*, tier=None, **kw):
        seen["tier"] = tier
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-core-key",
            "relay_key_owner": rk._current_account_identity(),
        })
        return {"source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)
    assert result.exit_code == 0
    assert seen.get("tier") == "core"           # 裸模型也显式 core，绝不 None
    assert capture["provider"]["providers"]["clawrelay"]["models"] == [{"id": "relay/raw-model"}]  # 透传


def test_clawwork_run_post_ensure_rejects_concurrent_paid_key_swap(isolated_env, monkeypatch):
    """Codex 终审阻断项：ensure(core) 后、pin key 前，若同账号缓存被并发 run / `ensure-key --tier max`
    换成 max key（别档），post-ensure 的 **tier-aware** resolve 必须按档位闸拒绝（want=core≠have=max）
    → 空 key → fail-closed 125，绝不用付费档 max key 起跑 / seed。"""
    save_clawhunt_auth({"access_token": "tok", "account_user": {"id": 1}, "superclaw_tier_ceiling": "max"})
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "core")  # 本 run 选 core（≤ max，clamp 放行）
    capture: dict = {}
    backend = _real_path_clawwork(isolated_env, monkeypatch, capture)

    def fake_ensure(*, tier=None, **kw):
        # 模拟并发窗口：ensure(core) 完成后，缓存被另一路写成绑 max 的 key（别档）
        save_clawhunt_auth({
            **load_clawhunt_auth(),
            "relay_api_key": "sk-llmgate-max-key",
            "relay_key_owner": rk._current_account_identity(),
            "relay_key_tier": "max",
        })
        return {"source": "auto"}

    monkeypatch.setattr(rk, "ensure_relay_key", fake_ensure)
    result = _run_clawwork(backend, isolated_env)
    assert result.exit_code == 125
    assert "CLAWWORK_RELAY_KEY_MISSING" in result.output
    assert "provider" not in capture            # 绝不用别档 max key 起跑 / seed 进 models.json


# ---------------------------------------------------------------------------
# v18 当前套餐（superclaw_plan）：从 /me 缓存 + 投影进 relay_usage（设置页展示用）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("raw,expect", [
    ("basic", "basic"), ("STANDARD", "standard"), ("  Advanced  ", "advanced"),
    ("core", None), ("plus", None), ("", None), ("gold", None), (None, None), (123, None),
])
def test_normalize_plan(raw, expect):
    # 仅 basic/standard/advanced（大小写/空白容错）；tier 名/非法/非串一律 None。
    assert rk._normalize_plan(raw) == expect


def test_cached_plan_unlogged_none(isolated_env):
    # 未登录（无 access_token）→ None，绝不臆造套餐。
    assert rk.cached_plan() is None
    save_clawhunt_auth({"superclaw_plan": "standard"})   # 有 plan 但无 token
    assert rk.cached_plan() is None


def test_cached_plan_logged_value_and_invalid(isolated_env):
    save_clawhunt_auth({"access_token": "tok", "superclaw_plan": "Advanced"})
    assert rk.cached_plan() == "advanced"                # 规范化
    save_clawhunt_auth({"superclaw_plan": "gold"})       # 非法档 → None
    assert rk.cached_plan() is None
    save_clawhunt_auth({"superclaw_plan": None})         # 已确认未订阅 → None
    assert rk.cached_plan() is None


def test_refresh_tier_ceiling_caches_plan(isolated_env):
    # 同一次 /me 取回：tier 落 ceiling，superclaw_plan 一并缓存（规范化）。
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeMeClient({"ok": True, "status_code": 200,
                          "body": {"tier": "max", "superclaw_plan": "STANDARD"}})
    assert rk.refresh_tier_ceiling(client=fake) == "max"
    assert load_clawhunt_auth()["superclaw_plan"] == "standard"
    assert rk.cached_plan() == "standard"


def test_refresh_tier_ceiling_null_plan_clears_stale(isolated_env):
    # 降级：曾订阅（缓存有 plan）后 /me 不再返回 plan → 落空串哨兵（已确认未订阅），
    # cached_plan → None；绝不残留把已退订用户继续显示成付费档。
    save_clawhunt_auth({"access_token": "tok", "superclaw_plan": "advanced"})
    fake = _FakeMeClient({"ok": True, "status_code": 200, "body": {"tier": "plus"}})
    assert rk.refresh_tier_ceiling(client=fake) == "plus"
    assert load_clawhunt_auth()["superclaw_plan"] == ""   # 已取过、无订阅（哨兵，非缺失）
    assert rk.cached_plan() is None


def test_save_clawhunt_auth_clears_plan_on_account_switch(isolated_env):
    # Codex 阻断 #1：切号必须作废上一账号的 superclaw_plan，否则串显别人套餐。
    save_clawhunt_auth({"access_token": "tokA", "superclaw_plan": "advanced"})
    assert rk.cached_plan() == "advanced"
    save_clawhunt_auth({"access_token": "tokB"})           # 换账号 token（未带 plan）
    assert "superclaw_plan" not in load_clawhunt_auth()    # 旧 plan 被清
    assert rk.cached_plan() is None
    # 同账号再 save（token 不变）绝不误清
    save_clawhunt_auth({"access_token": "tokB", "superclaw_plan": "basic"})
    save_clawhunt_auth({"access_token": "tokB", "relay_key_name": "n"})
    assert rk.cached_plan() == "basic"


def test_cached_or_refresh_plan(isolated_env):
    # 未登录 → None，绝不触网
    fake0 = _FakeMeClient({"ok": True, "status_code": 200, "body": {"superclaw_plan": "max"}})
    assert rk.cached_or_refresh_plan(client=fake0) is None
    assert fake0.calls == []
    # 已登录但 plan 字段缺失（刚切号/老登录态）→ 刷新一次并落盘
    save_clawhunt_auth({"access_token": "tok"})
    fake1 = _FakeMeClient({"ok": True, "status_code": 200,
                           "body": {"tier": "plus", "superclaw_plan": "standard"}})
    assert rk.cached_or_refresh_plan(client=fake1) == "standard"
    assert fake1.calls == ["tok"]
    # 字段已缓存（含空串哨兵）→ 纯缓存，绝不再触网
    fake2 = _FakeMeClient(None, raise_exc=AssertionError("must not refresh when already cached"))
    assert rk.cached_or_refresh_plan(client=fake2) == "standard"
    assert fake2.calls == []
    save_clawhunt_auth({"superclaw_plan": ""})             # 已确认未订阅哨兵
    fake3 = _FakeMeClient(None, raise_exc=AssertionError("sentinel must not trigger refresh"))
    assert rk.cached_or_refresh_plan(client=fake3) is None
    assert fake3.calls == []


def test_relay_usage_includes_plan(isolated_env, monkeypatch):
    # relay_usage 把当前套餐投影进返回（设置页"当前套餐"数据源）。真值/刷新由 test_cached_or_
    # refresh_plan 覆盖，这里只验"投影"这一步，故 monkeypatch 隔离 owner-key + 触网复杂度。
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    save_clawhunt_auth({"relay_api_key": "sk-llmgate-usekey1"})
    monkeypatch.setattr(rk, "cached_or_refresh_plan", lambda: "advanced")
    s = rk.relay_usage(transport=httpx.MockTransport(_usage_handler()))
    assert s["superclaw_plan"] == "advanced"
    monkeypatch.setattr(rk, "cached_or_refresh_plan", lambda: None)   # 未订阅 → None（不臆造）
    s2 = rk.relay_usage(transport=httpx.MockTransport(_usage_handler()))
    assert s2["superclaw_plan"] is None


# ---------------------------------------------------------------------------
# P1: 账户聚合 account_overview —— 购买套餐 vs 有效权益 vs 自费 relay 分源（v18 + 顾问设计）
# ---------------------------------------------------------------------------


class _FakeAccountClient:
    """ClawHuntAccountClient 替身：me() + agent_chat_usage() 都返回预置 body。"""

    def __init__(self, me_body, usage_body=None, *, usage_ok=True):
        self._me = me_body
        self._usage = usage_body
        self._usage_ok = usage_ok
        self.me_calls: list[str] = []
        self.usage_calls: list[str] = []

    def me(self, token):
        self.me_calls.append(token)
        return {"ok": True, "status_code": 200, "body": self._me}

    def agent_chat_usage(self, token):
        self.usage_calls.append(token)
        if not self._usage_ok:
            return {"ok": False, "status_code": 503, "body": None}
        return {"ok": True, "status_code": 200, "body": self._usage}


def test_cached_is_admin(isolated_env):
    assert rk.cached_is_admin() is False                       # 未登录
    save_clawhunt_auth({"access_token": "tok", "superclaw_is_admin": "1"})
    assert rk.cached_is_admin() is True
    save_clawhunt_auth({"superclaw_is_admin": ""})             # 非管理员哨兵
    assert rk.cached_is_admin() is False


def test_refresh_caches_is_admin_and_switch_clears(isolated_env):
    save_clawhunt_auth({"access_token": "tokA"})
    fake = _FakeAccountClient({"tier": "max", "superclaw_plan": None, "is_admin": True})
    rk.refresh_tier_ceiling(client=fake)
    assert rk.cached_is_admin() is True
    save_clawhunt_auth({"access_token": "tokB"})               # 切号
    assert "superclaw_is_admin" not in load_clawhunt_auth()
    assert rk.cached_is_admin() is False


def test_clawhunt_entitlement_unlogged_and_parse(isolated_env):
    # 未登录 → ok=False/logged_in=False，绝不触网
    fake0 = _FakeAccountClient({}, {"unlimited": True})
    assert rk.clawhunt_entitlement(client=fake0) == {"ok": False, "logged_in": False}
    assert fake0.usage_calls == []
    # 已登录 + 200：解析无限/免费/积分；bool 不当计数；trial 由 expires 推
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeAccountClient({}, {
        "unlimited": True, "free_chats_remaining": 2, "free_chat_limit": 3,
        "chat_credits": 5, "superclaw_trial_expires_at": "2026-07-01T00:00:00Z",
    })
    ent = rk.clawhunt_entitlement(client=fake)
    assert ent["ok"] and ent["unlimited"] is True and ent["trial_active"] is True
    assert ent["free_chats_remaining"] == 2 and ent["free_chat_limit"] == 3
    assert ent["chat_credits"] == 5.0
    # 上游非 200 → ok=False（不臆造权益）
    save_clawhunt_auth({"access_token": "tok"})
    fakebad = _FakeAccountClient({}, None, usage_ok=False)
    assert rk.clawhunt_entitlement(client=fakebad) == {"ok": False, "logged_in": True}


def test_account_overview_admin_unlimited(isolated_env):
    # admin：未购套餐(billing_plan None)但有效权益=无限，来源=admin —— 绝不伪装成已购套餐。
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeAccountClient(
        {"tier": None, "superclaw_plan": None, "is_admin": True},
        {"unlimited": True, "free_chats_remaining": -1, "free_chat_limit": 3,
         "chat_credits": 0, "superclaw_trial_expires_at": None},
    )
    rk.refresh_tier_ceiling(client=fake)
    ov = rk.account_overview(client=fake)
    assert ov["billing_plan"] is None
    assert ov["entitlement"] == "unlimited"
    assert ov["entitlement_source"] == "admin"
    assert ov["unlimited"] is True
    assert ov["relay"]["ok"] is False           # 无 relay key → 自费用量降级，不拖垮聚合


def test_account_overview_real_subscription(isolated_env):
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeAccountClient(
        {"tier": "max", "superclaw_plan": "standard", "is_admin": False},
        {"unlimited": False, "free_chats_remaining": 1, "free_chat_limit": 3,
         "chat_credits": 5, "superclaw_trial_expires_at": None},
    )
    rk.refresh_tier_ceiling(client=fake)
    ov = rk.account_overview(client=fake)
    assert ov["billing_plan"] == "standard"          # 买了 standard
    assert ov["entitlement"] == "standard"           # 有效权益=该套餐
    assert ov["entitlement_source"] == "subscription"
    assert ov["unlimited"] is False
    assert ov["chat_credits"] == 5.0


def test_account_overview_payg_and_free(isolated_env):
    # payg：无套餐、无限=False、有积分 → entitlement=payg/source=payg
    save_clawhunt_auth({"access_token": "tok"})
    f1 = _FakeAccountClient(
        {"tier": None, "superclaw_plan": None, "is_admin": False},
        {"unlimited": False, "free_chats_remaining": 0, "free_chat_limit": 3, "chat_credits": 8},
    )
    rk.refresh_tier_ceiling(client=f1)
    ov1 = rk.account_overview(client=f1)
    assert ov1["entitlement"] == "payg" and ov1["entitlement_source"] == "payg"
    # free：无套餐、无限=False、无积分 → free
    save_clawhunt_auth({"access_token": "tok2"})
    f2 = _FakeAccountClient(
        {"tier": None, "superclaw_plan": None, "is_admin": False},
        {"unlimited": False, "free_chats_remaining": 3, "free_chat_limit": 3, "chat_credits": 0},
    )
    rk.refresh_tier_ceiling(client=f2)
    ov2 = rk.account_overview(client=f2)
    assert ov2["entitlement"] == "free" and ov2["entitlement_source"] == "free"


def test_account_overview_entitlement_degrades_when_usage_down(isolated_env):
    # /api/agent-chat/usage 挂掉 → entitlement 不臆造无限；有套餐则回落套餐，否则 free。
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeAccountClient(
        {"tier": "plus", "superclaw_plan": "basic", "is_admin": False},
        None, usage_ok=False,
    )
    rk.refresh_tier_ceiling(client=fake)
    ov = rk.account_overview(client=fake)
    assert ov["unlimited"] is False                  # usage 不可用 → 不臆造无限
    assert ov["billing_plan"] == "basic"
    assert ov["entitlement"] == "basic" and ov["entitlement_source"] == "subscription"


def test_account_overview_admin_with_plan_source_is_admin(isolated_env):
    # Codex 阻断 #3：既买套餐又 admin 无限 → 权益来源必须是 admin（无限的真实来源），
    # 绝不误标 subscription（购买事实已在独立 billing_plan 行展示）。
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeAccountClient(
        {"tier": "max", "superclaw_plan": "standard", "is_admin": True},
        {"unlimited": True, "free_chats_remaining": -1, "free_chat_limit": 3, "chat_credits": 0},
    )
    rk.refresh_tier_ceiling(client=fake)
    ov = rk.account_overview(client=fake)
    assert ov["billing_plan"] == "standard"          # 买过套餐（独立行）
    assert ov["entitlement"] == "unlimited"
    assert ov["entitlement_source"] == "admin"       # 来源=admin，不误标 subscription


def test_cached_or_refresh_plan_refreshes_when_is_admin_missing(isolated_env):
    # Codex 阻断 #2：老登录态只有 plan 哨兵、缺新字段 superclaw_is_admin → 触发一次 /me 刷新
    # 补齐 is_admin（否则 account_overview 把 admin 无限误标成 grant）。
    save_clawhunt_auth({"access_token": "tok", "superclaw_plan": ""})  # 有 plan 字段、无 is_admin
    fake = _FakeAccountClient({"tier": "max", "superclaw_plan": None, "is_admin": True})
    assert rk.cached_or_refresh_plan(client=fake) is None  # plan 仍未订阅
    assert fake.me_calls == ["tok"]                        # 缺 is_admin → 触发了刷新
    assert rk.cached_is_admin() is True                    # is_admin 已补齐

    class _NoRefresh:
        def me(self, t):
            raise AssertionError("must not refresh when both plan & is_admin cached")

        def agent_chat_usage(self, t):
            return {"ok": False}

    assert rk.cached_or_refresh_plan(client=_NoRefresh()) is None  # 两字段齐 → 不再触网


def test_is_admin_dirty_value_not_admin(isolated_env):
    # 上游脏值 is_admin="false"(字符串) → 只认真实 bool True，cached_is_admin 必须 False；
    # 故 admin 无限误标风险被堵：unlimited 归 grant 而非 admin。
    save_clawhunt_auth({"access_token": "tok"})
    fake = _FakeAccountClient(
        {"tier": None, "superclaw_plan": None, "is_admin": "false"},
        {"unlimited": True, "free_chats_remaining": -1, "free_chat_limit": 3, "chat_credits": 0},
    )
    rk.refresh_tier_ceiling(client=fake)
    assert rk.cached_is_admin() is False
    ov = rk.account_overview(client=fake)
    assert ov["entitlement"] == "unlimited" and ov["entitlement_source"] == "grant"


def test_account_overview_survives_plan_refresh_exception(isolated_env, monkeypatch):
    # cached_or_refresh_plan 触网刷新抛异常 → account_overview 不崩，降级到 cached_plan。
    save_clawhunt_auth({"access_token": "tok", "superclaw_plan": "standard", "superclaw_is_admin": ""})

    def _boom(*a, **k):
        raise RuntimeError("me down")

    monkeypatch.setattr(rk, "cached_or_refresh_plan", _boom)
    fake = _FakeAccountClient({}, {"unlimited": False, "chat_credits": 0})
    ov = rk.account_overview(client=fake)
    assert ov["ok"] is True
    assert ov["billing_plan"] == "standard"   # 异常降级到纯缓存值，不抛、不丢套餐


# ---------------------------------------------------------------------------
# relay_package_models：套餐内具体模型列表（clawwork 二级模型选择器数据源）
# ---------------------------------------------------------------------------


def _models_handler(*, status_code=200, body=None):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/v1/models")
        assert request.headers["Authorization"].startswith("Bearer ")
        return httpx.Response(
            status_code,
            json=body if body is not None else {
                "data": [
                    {"id": "claude-opus-4-8"},
                    {"id": "claude-sonnet-4-6"},
                    {"id": ""},               # 空 id 过滤
                    {"id": "claude-opus-4-8"},  # 去重
                    {"nope": "no-id"},        # 无 id 跳过
                ]
            },
        )

    return handler


def test_relay_package_models_success(isolated_env, monkeypatch):
    # 隔离 ensure/resolve（各自有专测），专验 /v1/models 的 HTTP + 解析 + 去空 + 去重。
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    calls: dict = {}
    monkeypatch.setattr(rk, "ensure_relay_key", lambda **k: calls.update(k) or {"ensured": True})
    monkeypatch.setattr(rk, "resolve_relay_api_key", lambda **k: ("sk-llmgate-usekey1", "stored"))
    s = rk.relay_package_models("PLUS", transport=httpx.MockTransport(_models_handler()))
    assert s["ok"] is True and s["tier"] == "plus" and s["group_slug"] == "superclaw-plus"
    assert s["models"] == ["claude-opus-4-8", "claude-sonnet-4-6"]   # 去空 + 去重，保序
    assert calls.get("tier") == "plus"                                # 确实把 key 绑到该档
    assert "sk-llmgate-usekey1" not in json.dumps(s)                  # 绝不回显 key 明文


def test_relay_package_models_invalid_tier(isolated_env):
    with pytest.raises(rk.RelayKeyError, match="RELAY_PACKAGE_INVALID"):
        rk.relay_package_models("gold")


def test_relay_package_models_unauthorized(isolated_env, monkeypatch):
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    monkeypatch.setattr(rk, "ensure_relay_key", lambda **k: {})
    monkeypatch.setattr(rk, "resolve_relay_api_key", lambda **k: ("sk-llmgate-x", "stored"))
    with pytest.raises(rk.RelayKeyError, match="RELAY_PACKAGE_MODELS_UNAUTHORIZED"):
        rk.relay_package_models(
            "max", transport=httpx.MockTransport(_models_handler(status_code=401))
        )


@pytest.mark.parametrize("bad_body", [{}, {"data": "bad"}, {"data": {"id": "x"}}, [1, 2, 3]])
def test_relay_package_models_malformed_upstream_fails_closed(isolated_env, monkeypatch, bad_body):
    """Fail-closed (Codex finding #4): a malformed /v1/models envelope (no ``data`` list,
    a non-list ``data``, or a non-dict body) is a protocol error and must RAISE — never
    be coerced into ``ok: true, models: []`` (which would masquerade a broken upstream as
    'this tier genuinely has no models')."""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    monkeypatch.setattr(rk, "ensure_relay_key", lambda **k: {})
    monkeypatch.setattr(rk, "resolve_relay_api_key", lambda **k: ("sk-llmgate-x", "stored"))
    with pytest.raises(rk.RelayKeyError, match="RELAY_PACKAGE_MODELS_FAILED"):
        rk.relay_package_models(
            "plus", transport=httpx.MockTransport(_models_handler(body=bad_body))
        )


def test_relay_package_models_genuinely_empty_group_is_ok(isolated_env, monkeypatch):
    """A well-formed ``{"data": []}`` IS a valid empty group — it passes through as an
    empty model list (ok: true), distinct from the malformed cases above."""
    monkeypatch.setenv(rk.RELAY_BASE_URL_ENV, "https://api.clawhunt.site/v1")
    monkeypatch.setattr(rk, "ensure_relay_key", lambda **k: {})
    monkeypatch.setattr(rk, "resolve_relay_api_key", lambda **k: ("sk-llmgate-x", "stored"))
    s = rk.relay_package_models(
        "core", transport=httpx.MockTransport(_models_handler(body={"data": []}))
    )
    assert s["ok"] is True and s["models"] == []
