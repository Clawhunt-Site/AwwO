import json
import os
import stat

import httpx

from superclaw.clawhunt_auth import (
    ClawHuntAccountClient,
    ClawHuntAccountSettings,
    SUPERCLAW_LOGIN_SOURCE,
    build_clawhunt_browser_login_url,
    classify_login_probe_result,
    clawhunt_auth_summary,
    clear_clawhunt_auth,
    hydrate_clawhunt_auth_environment,
    load_clawhunt_auth,
    login_probe_error_result,
    save_clawhunt_auth,
    saved_clawhunt_access_token,
)


def test_clawhunt_auth_store_persists_with_private_permissions_and_sanitized_summary(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)

    saved = save_clawhunt_auth(
        {
            "access_token": " account-token ",
            "agent_api_key": " cph_secret_123 ",
            "account_user": {
                "username": "leon",
                "password": "must-not-surface",
                "email": "leon@example.test",
            },
            "agent_key_source": "account",
            "agent_key_name": "Desktop key",
        }
    )

    assert saved["agent_api_key"] == " cph_secret_123 "
    assert load_clawhunt_auth()["access_token"] == " account-token "
    assert os.environ["CLAWHUNT_AGENT_API_KEY"] == "cph_secret_123"
    assert stat.S_IMODE(auth_path.stat().st_mode) == 0o600
    assert saved_clawhunt_access_token() == "account-token"
    summary = clawhunt_auth_summary()
    assert summary["account"] == "set"
    assert summary["agent_api_key"] == "set"
    assert summary["account_user"] == {"username": "leon", "email": "leon@example.test"}
    assert "password" not in json.dumps(summary)


def test_clawhunt_auth_hydrate_does_not_override_existing_environment_key(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(tmp_path / "clawhunt-auth.json"))
    monkeypatch.setenv("CLAWHUNT_AGENT_API_KEY", "cph_existing")

    save_clawhunt_auth({"agent_api_key": "cph_saved"})
    applied = hydrate_clawhunt_auth_environment()

    assert applied == []
    assert os.environ["CLAWHUNT_AGENT_API_KEY"] == "cph_existing"
    assert clawhunt_auth_summary()["agent_api_key"] == "set"


def test_clawhunt_auth_clear_removes_file_and_environment(tmp_path, monkeypatch):
    auth_path = tmp_path / "clawhunt-auth.json"
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(auth_path))
    monkeypatch.delenv("CLAWHUNT_AGENT_API_KEY", raising=False)
    save_clawhunt_auth({"access_token": "account-token", "agent_api_key": "cph_saved"})

    clear_clawhunt_auth()

    assert not auth_path.exists()
    assert "CLAWHUNT_AGENT_API_KEY" not in os.environ
    assert clawhunt_auth_summary()["account"] == "unset"
    assert clawhunt_auth_summary()["agent_api_key"] == "unset"


def test_clawhunt_login_probe_classification_accepts_expected_auth_rejections():
    probe = classify_login_probe_result(
        base_url="https://clawhunt.test",
        response={"ok": False, "status_code": 401, "body": {"detail": "用户名或密码错误"}},
    )

    assert probe["ok"] is True
    assert probe["reachable"] is True
    assert probe["login_endpoint"] is True
    assert probe["body_detail"] == "用户名或密码错误"


def test_clawhunt_login_probe_classification_rejects_unexpected_status_and_network_errors():
    unexpected = classify_login_probe_result(
        base_url="https://clawhunt.test",
        response={"ok": False, "status_code": 500, "body": {"detail": "boom"}},
    )
    network = login_probe_error_result(base_url="https://clawhunt.test", exc=httpx.ConnectError("no route"))

    assert unexpected["ok"] is False
    assert unexpected["reachable"] is True
    assert unexpected["login_endpoint"] is False
    assert network["ok"] is False
    assert network["reachable"] is False
    assert network["status_code"] == 0


def test_clawhunt_browser_login_url_uses_clawhunt_google_bridge_and_superclaw_source():
    login_url = build_clawhunt_browser_login_url(
        base_url="https://clawhunt.store",
        callback_url="http://127.0.0.1:43123/api/auth/clawhunt/browser/callback?state=abc&source=superclaw",
        provider="google",
        invite_code="BETA1",
    )

    assert login_url.startswith("https://clawhunt.store/google-oauth-bridge.html?")
    assert "source=superclaw" in login_url
    assert "client=superclaw" in login_url
    assert "invite_code=BETA1" in login_url
    assert "redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Fapi%2Fauth%2Fclawhunt%2Fbrowser%2Fcallback" in login_url


def test_account_client_exchanges_cli_handoff_with_superclaw_source_headers():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["source"] = request.headers.get("X-ClawHunt-Login-Source")
        seen["superclaw_source"] = request.headers.get("X-SuperClaw-Login-Source")
        seen["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(200, json={"access_token": "account-token", "token_type": "bearer", "user": {"username": "leon"}})

    client = ClawHuntAccountClient(
        settings=ClawHuntAccountSettings(base_url="https://clawhunt.test"),
        transport=httpx.MockTransport(handler),
    )

    response = client.exchange_cli_handoff("handoff-code")

    assert seen == {
        "url": "https://clawhunt.test/api/auth/cli/exchange",
        "source": SUPERCLAW_LOGIN_SOURCE,
        "superclaw_source": SUPERCLAW_LOGIN_SOURCE,
        "body": {"handoff_code": "handoff-code"},
    }
    assert response["ok"] is True
    assert response["body"]["access_token"] == "account-token"


def test_account_client_marks_password_login_and_probe_with_superclaw_source_headers():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            {
                "url": str(request.url),
                "source": request.headers.get("X-ClawHunt-Login-Source"),
                "superclaw_source": request.headers.get("X-SuperClaw-Login-Source"),
                "content_type": request.headers.get("Content-Type"),
                "body": json.loads(request.content.decode("utf-8")),
            }
        )
        return httpx.Response(401, json={"detail": "invalid credentials"})

    client = ClawHuntAccountClient(
        settings=ClawHuntAccountSettings(base_url="https://clawhunt.test"),
        transport=httpx.MockTransport(handler),
    )

    client.login("leon", "secret")
    client.login_probe()

    assert seen[0] == {
        "url": "https://clawhunt.test/api/auth/login",
        "source": SUPERCLAW_LOGIN_SOURCE,
        "superclaw_source": SUPERCLAW_LOGIN_SOURCE,
        "content_type": "application/json",
        "body": {"username": "leon", "password": "secret"},
    }
    assert seen[1] == {
        "url": "https://clawhunt.test/api/auth/login",
        "source": SUPERCLAW_LOGIN_SOURCE,
        "superclaw_source": SUPERCLAW_LOGIN_SOURCE,
        "content_type": "application/json",
        "body": {"username": "__superclaw_login_probe__", "password": "__superclaw_login_probe__"},
    }


def test_account_client_uses_base_url_override_and_disables_proxy_environment(monkeypatch):
    monkeypatch.setenv("CLAWHUNT_BASE_URL", "https://staging.clawhunt.test")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(401, json={"detail": "用户名或密码错误"})

    client = ClawHuntAccountClient(transport=httpx.MockTransport(handler))

    response = client.login_probe()

    assert client.settings == ClawHuntAccountSettings(base_url="https://staging.clawhunt.test")
    assert seen["url"] == "https://staging.clawhunt.test/api/auth/login"
    assert response["status_code"] == 401
