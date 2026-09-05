from __future__ import annotations

import json
import os
from urllib.parse import urlencode, urljoin
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from superclaw.environment import (
    DEFAULT_CLAWHUNT_LOCAL_BASE_URL,
    app_environment,
    clawhunt_base_url,
    default_clawhunt_auth_path,
    legacy_clawhunt_auth_path,
)
from superclaw.secure_fs import harden_path


CLAWHUNT_AUTH_ENV = "SUPERCLAW_CLAWHUNT_AUTH_PATH"
DEFAULT_CLAWHUNT_AUTH_PATH = default_clawhunt_auth_path()
SUPERCLAW_LOGIN_SOURCE = "superclaw"
CLAWHUNT_BROWSER_LOGIN_STATE_TTL_SECONDS = 10 * 60


def clawhunt_auth_path() -> Path:
    configured = os.environ.get(CLAWHUNT_AUTH_ENV, "").strip()
    if configured:
        return Path(configured)
    default_path = default_clawhunt_auth_path()
    if default_path.exists():
        return default_path
    legacy_path = legacy_clawhunt_auth_path()
    # The legacy un-suffixed clawhunt-auth.json predates per-environment auth files
    # and is treated as a non-production (staging) credential — never honored in a
    # production build, so a stale dev token cannot leak into production.
    if app_environment() == "staging" and legacy_path.exists():
        return legacy_path
    return default_path


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned or any(ord(ch) < 32 or ord(ch) == 127 for ch in cleaned):
        return None
    return cleaned


def _safe_user_payload(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    allowed = {
        "id",
        "username",
        "email",
        "handle",
        "display_name",
        "avatar_url",
        "github_username",
        "is_admin",
        # Wallet / credits + subscription, so the desktop Account surface mirrors the
        # main ClawHunt site instead of showing only the relay LLM meters.
        # All *_balance are integer cents from the main-site /api/auth/me UserResponse.
        "wallet_balance",
        "frozen_balance",
        "withdrawal_holding_balance",
        "tier",
        "superclaw_plan",
        "access_status",
    }
    return {key: raw for key, raw in value.items() if key in allowed and raw is not None}


def load_clawhunt_auth() -> dict[str, Any]:
    path = clawhunt_auth_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def save_clawhunt_auth(payload: dict[str, Any]) -> dict[str, Any]:
    path = clawhunt_auth_path()
    current = load_clawhunt_auth()
    # 切号/重新登录失效解锁上限缓存（issue #452）：本次写入带来**不同**的 access_token 时，
    # 旧账号的 superclaw_tier_ceiling 必须作废——否则会串档（账号 A 的 plus 上限残留给账号 B，
    # 致 B 越级漏拦）。relay key 发放 / ceiling 刷新自身的 save 不带 access_token，不受影响；
    # 与 relay_key_owner 的切号隔离同源。
    new_token = payload.get("access_token")
    if isinstance(new_token, str) and new_token.strip() and new_token != current.get("access_token"):
        # 切号/重新登录：作废上一账号的解锁上限 **和** 当前套餐 / is_admin 缓存——否则账号 A 的
        # superclaw_plan（如 advanced）或 admin 无限会残留给账号 B，设置页串显别人的套餐/权益。
        current.pop("superclaw_tier_ceiling", None)
        current.pop("superclaw_plan", None)
        current.pop("superclaw_is_admin", None)
    for key, value in payload.items():
        if value is None:
            current.pop(key, None)
        else:
            current[key] = value
    # ~/.superclaw 存放 access_token + relay key 等凭据：目录也收紧到 0700（仅属主可
    # 遍历），与目录内 0600 文件一致，杜绝同机其它本地用户列目录探测（纵深，顾问 F-M2）。
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    # chmod(0o700) is a no-op on NTFS; restrict the credential dir to the current
    # user via an explicit ACL so the temp/final secret files below inherit an
    # owner-only directory (no silent fail-open — harden_path logs if it can't).
    if os.name == "nt":
        harden_path(path.parent, is_dir=True)
    serialized = json.dumps(current, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(serialized)
        os.replace(temp_path, path)
    except OSError:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise
    try:
        path.chmod(0o600)
    except OSError:
        pass
    if os.name == "nt":
        harden_path(path, is_dir=False)  # NTFS: owner-only ACL (chmod 0o600 is a no-op)
    hydrate_clawhunt_auth_environment(current)
    return current


def clear_clawhunt_auth() -> None:
    os.environ.pop("CLAWHUNT_AGENT_API_KEY", None)
    # relay env + provenance 标记的清理委托给 relay_key（单一定义点，避免漏清标记）
    from superclaw import relay_key as _relay_key

    os.environ.pop(_relay_key.RELAY_KEY_ENV, None)
    os.environ.pop(_relay_key.RELAY_KEY_HYDRATED_ENV, None)
    path = clawhunt_auth_path()
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def hydrate_clawhunt_auth_environment(payload: dict[str, Any] | None = None) -> list[str]:
    auth = payload if payload is not None else load_clawhunt_auth()
    applied: list[str] = []
    agent_key = _clean_string(auth.get("agent_api_key"))
    if agent_key and not os.environ.get("CLAWHUNT_AGENT_API_KEY"):
        os.environ["CLAWHUNT_AGENT_API_KEY"] = agent_key
        applied.append("CLAWHUNT_AGENT_API_KEY")
    # 桥接自动发放的中转站 key 走同一条注水通道：SUPERCLAW_RELAY_API_KEY 注入
    # 后对所有只读 env 的消费方生效（clawwork backend 另经 resolve_relay_api_key
    # 读同一条链）。注入/刷新/provenance 逻辑单一定义在
    # relay_key.hydrate_relay_environment（含跨进程 stale env 刷新）；
    # 延迟 import 打破 relay_key→clawhunt_auth 的循环依赖。
    from superclaw import relay_key as _relay_key

    if _relay_key.hydrate_relay_environment():
        applied.append(_relay_key.RELAY_KEY_ENV)
    # Non-production runs (e.g. a Finder-launched staging build that never sourced a
    # shell rc) load the CF Access service token from its well-known file so the
    # account client can pass the Cloudflare gate. No-op in production.
    from superclaw import cf_access as _cf_access

    if _cf_access.hydrate_cf_access_environment():
        applied.append(_cf_access.CF_ACCESS_CLIENT_ID_ENV)
    return applied


def clawhunt_auth_summary() -> dict[str, Any]:
    auth = load_clawhunt_auth()
    access_token = _clean_string(auth.get("access_token"))
    agent_key = os.environ.get("CLAWHUNT_AGENT_API_KEY") or _clean_string(auth.get("agent_api_key"))
    return {
        "account": "set" if access_token else "unset",
        "agent_api_key": "set" if agent_key else "unset",
        "account_user": _safe_user_payload(auth.get("account_user")),
        "agent_key_source": _clean_string(auth.get("agent_key_source")),
        "agent_key_name": _clean_string(auth.get("agent_key_name")),
        "account_source": _clean_string(auth.get("account_source")),
        "login_source": _clean_string(auth.get("login_source")),
        "auth_path": str(clawhunt_auth_path()),
    }


def saved_clawhunt_access_token() -> str | None:
    return _clean_string(load_clawhunt_auth().get("access_token"))


def classify_login_probe_result(*, base_url: str, response: dict[str, Any]) -> dict[str, Any]:
    raw_status = response.get("status_code")
    status_code = raw_status if isinstance(raw_status, int) else 0
    body = response.get("body")
    expected_auth_rejection = status_code in {400, 401, 422} and isinstance(body, dict)
    login_endpoint = bool(response.get("ok")) or expected_auth_rejection
    if expected_auth_rejection:
        detail = "login endpoint reachable; credentials rejected as expected"
    elif response.get("ok"):
        detail = "login endpoint returned success to probe credentials"
    elif status_code:
        detail = "login endpoint returned unexpected status"
    else:
        detail = "login endpoint did not return a response"
    body_detail = body.get("detail") if isinstance(body, dict) and isinstance(body.get("detail"), str) else None
    return {
        "ok": login_endpoint,
        "reachable": status_code > 0,
        "login_endpoint": login_endpoint,
        "base_url": base_url,
        "status_code": status_code,
        "detail": detail,
        "body_detail": body_detail,
    }


def login_probe_error_result(*, base_url: str, exc: Exception) -> dict[str, Any]:
    return {
        "ok": False,
        "reachable": False,
        "login_endpoint": False,
        "base_url": base_url,
        "status_code": 0,
        "detail": f"{exc.__class__.__name__}: {str(exc)[:200]}",
        "body_detail": None,
    }


def build_clawhunt_browser_login_url(
    *,
    base_url: str,
    callback_url: str,
    provider: str = "google",
    invite_code: str | None = None,
) -> str:
    normalized_provider = provider.strip().lower() if isinstance(provider, str) else "google"
    if normalized_provider in {"google", "google-oauth", "google_oauth"}:
        path = "google-oauth-bridge.html"
        params = {
            "redirect_uri": callback_url,
            "source": SUPERCLAW_LOGIN_SOURCE,
            "client": SUPERCLAW_LOGIN_SOURCE,
        }
        if invite_code and invite_code.strip():
            params["invite_code"] = invite_code.strip()
    elif normalized_provider in {"website", "clawhunt", "password"}:
        path = "login"
        params = {
            "redirect": callback_url,
            "source": SUPERCLAW_LOGIN_SOURCE,
            "client": SUPERCLAW_LOGIN_SOURCE,
        }
    else:
        raise ValueError(f"unsupported ClawHunt login provider: {provider}")
    return f"{urljoin(base_url.rstrip('/') + '/', path)}?{urlencode(params)}"


@dataclass(frozen=True)
class ClawHuntAccountSettings:
    base_url: str = DEFAULT_CLAWHUNT_LOCAL_BASE_URL

    @classmethod
    def from_env(cls) -> "ClawHuntAccountSettings":
        return cls(base_url=clawhunt_base_url())


class ClawHuntAccountClient:
    def __init__(
        self,
        settings: ClawHuntAccountSettings | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 20.0,
    ) -> None:
        self.settings = settings or ClawHuntAccountSettings.from_env()
        # Load the CF Access service token (non-production only) before any request is
        # built, so direct CLI one-shots (e.g. exchange-handoff-code) that construct
        # this client without first hitting the auth-env choke point still pass the
        # staging Cloudflare gate.
        from superclaw.cf_access import hydrate_cf_access_environment

        hydrate_cf_access_environment(self.settings.base_url)
        self._client = httpx.Client(
            base_url=self.settings.base_url.rstrip("/"),
            transport=transport,
            timeout=timeout,
            trust_env=False,
        )

    def _response_payload(self, response: httpx.Response) -> dict[str, Any]:
        try:
            body: Any = response.json()
        except ValueError:
            body = response.text[:1000]
        return {"status_code": response.status_code, "ok": 200 <= response.status_code < 300, "body": body}

    def _source_headers(self, *, content_type: bool = False) -> dict[str, str]:
        # CF Access service-token headers let these server-to-server calls through the
        # Cloudflare gate that fronts the private TEST host; cf_access_headers returns
        # {} for production / when no token is configured (single definition point).
        from superclaw.cf_access import cf_access_headers

        headers = {
            "Accept": "application/json",
            "X-ClawHunt-Login-Source": SUPERCLAW_LOGIN_SOURCE,
            "X-SuperClaw-Login-Source": SUPERCLAW_LOGIN_SOURCE,
            **cf_access_headers(self.settings.base_url),
        }
        if content_type:
            headers["Content-Type"] = "application/json"
        return headers

    def _account_headers(self, access_token: str) -> dict[str, str]:
        return {
            **self._source_headers(),
            "Authorization": f"Bearer {access_token}",
        }

    def login(self, username: str, password: str) -> dict[str, Any]:
        response = self._client.post(
            "/api/auth/login",
            json={"username": username, "password": password},
            headers=self._source_headers(content_type=True),
        )
        return self._response_payload(response)

    def login_probe(self) -> dict[str, Any]:
        response = self._client.post(
            "/api/auth/login",
            json={"username": "__superclaw_login_probe__", "password": "__superclaw_login_probe__"},
            headers=self._source_headers(content_type=True),
        )
        return self._response_payload(response)

    def register_developer_key(self, access_token: str, developer_id: str, public_key: str) -> dict[str, Any]:
        """Register the developer's PUBLIC key to their ClawHunt account.

        Sends only the public key (private key never leaves the machine). The server
        derives the keyid and ties it to the authenticated account, making signed
        submissions traceable to this developer.
        """
        response = self._client.post(
            "/v1/capabilities/developers/register",
            json={"developer_id": developer_id, "public_key": public_key},
            headers={**self._account_headers(access_token), "Content-Type": "application/json"},
            # Short, explicit timeout: this runs as a best-effort login hook, so a
            # slow/half-open server must not stall sign-in (the client default is 20s).
            timeout=5.0,
        )
        return self._response_payload(response)

    def ensure_hosted_developer_key(
        self,
        access_token: str,
        developer_id: str,
        *,
        private_key: str | None = None,
        public_key: str | None = None,
    ) -> dict[str, Any]:
        """Ensure the account's single ESCROWED developer keypair, returning the pair.

        Posts to ``/v1/capabilities/developers/key/ensure``. Per the owner's escrow
        decision the keypair is server-held and recoverable (one per USER), so unlike
        :meth:`register_developer_key` this call MAY send the local private key —
        either to adopt a key the client already minted (no server row yet) or to
        backfill a legacy public-only registration on proof of the matching key. When
        both are omitted the server mints or recovers the canonical pair. The response
        body carries the PRIVATE key (escrow recovery); callers must treat it as
        sensitive and never log it.
        """
        payload: dict[str, Any] = {"developer_id": developer_id}
        if private_key:
            payload["private_key"] = private_key
        if public_key:
            payload["public_key"] = public_key
        response = self._client.post(
            "/v1/capabilities/developers/key/ensure",
            json=payload,
            headers={**self._account_headers(access_token), "Content-Type": "application/json"},
            # Best-effort login hook: a slow/half-open server must not stall sign-in.
            timeout=5.0,
        )
        return self._response_payload(response)

    def me(self, access_token: str) -> dict[str, Any]:
        response = self._client.get("/api/auth/me", headers=self._account_headers(access_token))
        return self._response_payload(response)

    def agent_chat_usage(self, access_token: str) -> dict[str, Any]:
        """主站 ``GET /api/agent-chat/usage``：当前账号的有效权益/额度视图（unlimited /
        chats_remaining / free_chats_remaining / free_chat_limit / chat_credits）。供设置页
        "当前权益"行展示——与网页"Pro · unlimited"徽章同源。返回 {ok, status_code, body}。"""
        response = self._client.get(
            "/api/agent-chat/usage", headers=self._account_headers(access_token)
        )
        return self._response_payload(response)

    def profile(self, access_token: str) -> dict[str, Any]:
        response = self._client.get("/api/auth/profile", headers=self._account_headers(access_token))
        return self._response_payload(response)

    def exchange_cli_handoff(self, handoff_code: str) -> dict[str, Any]:
        response = self._client.post(
            "/api/auth/cli/exchange",
            headers=self._source_headers(content_type=True),
            json={"handoff_code": handoff_code},
        )
        return self._response_payload(response)

    def agents(self, access_token: str) -> dict[str, Any]:
        response = self._client.get("/api/agents/my/agents", headers=self._account_headers(access_token))
        return self._response_payload(response)

    def agent_keys(self, access_token: str, *, active_only: bool = True) -> dict[str, Any]:
        response = self._client.get(
            "/api/auth/agent-keys",
            headers=self._account_headers(access_token),
            params={"active_only": "true"} if active_only else None,
        )
        return self._response_payload(response)

    def create_agent_key(
        self,
        access_token: str,
        *,
        name: str,
        agent_id: int,
        permissions: list[str],
    ) -> dict[str, Any]:
        response = self._client.post(
            "/api/auth/agent-keys",
            headers={**self._account_headers(access_token), "Content-Type": "application/json"},
            json={"name": name, "agent_id": agent_id, "permissions": permissions},
        )
        return self._response_payload(response)


def extract_login_session(payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    body = payload.get("body")
    if not payload.get("ok") or not isinstance(body, dict):
        detail = body.get("detail") if isinstance(body, dict) else None
        raise ValueError(str(detail or "ClawHunt login failed"))
    access_token = _clean_string(body.get("access_token"))
    if not access_token:
        raise ValueError("ClawHunt login response did not include access_token")
    user = _safe_user_payload(body.get("user")) or {}
    return access_token, user
