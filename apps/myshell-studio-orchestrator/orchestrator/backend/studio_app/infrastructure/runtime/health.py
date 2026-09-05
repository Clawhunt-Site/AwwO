from __future__ import annotations

import json
import os
import shutil
from datetime import UTC, datetime
from typing import Any

import httpx


DEFAULT_CDP_URL = "http://127.0.0.1:9222"
COOKIE_FILE_NAMES = ("myshell-cookies.json", "myshell_cookies_embedded.json")
COOKIE_FILE_ENV = "MYSHELL_COOKIES_FILE"
DREAMY_INIT_DATA_ENV_NAMES = ("DREAMY_TELEGRAM_INIT_DATA", "MYSHELL_DREAMY_INIT_DATA")
DREAMY_DEFAULT_API_BASE_URL = "https://api.myshell.fun"
MYSHELL_ART_REQUIRED_COOKIE_NAMES = ("ms_token",)
DREAMYPORN_WEB_REQUIRED_COOKIE_NAMES = ("ms_token",)
DREAMYPORN_WEB_DOMAIN_FRAGMENT = "dreamyporn.ai"
SECRET_BINDINGS = (
    {
        "env": "DREAMY_TELEGRAM_INIT_DATA",
        "secret": "myshell-dreamy-init-data",
        "purpose": "server-side Dreamy miniapp generation",
    },
    {
        "env": "MYSHELL_COOKIES",
        "secret": "myshell-cookies",
        "purpose": "MyShell Art browser cookie injection",
    },
)


def _backend_dir() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


DEFAULT_COOKIE_INJECTION_STATUS_PATH = os.path.join(_backend_dir(), ".studio", "cookie-injection-status.json")


def _cookie_name_status(payload: list[dict[str, Any]]) -> dict[str, Any]:
    names = sorted({str(cookie.get("name") or "") for cookie in payload if isinstance(cookie, dict) and cookie.get("name")})
    missing = [name for name in MYSHELL_ART_REQUIRED_COOKIE_NAMES if name not in names]
    return {
        "cookieNames": names,
        "requiredCookieNames": list(MYSHELL_ART_REQUIRED_COOKIE_NAMES),
        "missingCookieNames": missing,
        "artApiAuthCookieStatus": "ready" if not missing else "missing",
    }


def cdp_url() -> str:
    return (os.environ.get("MYSHELL_CDP_URL") or DEFAULT_CDP_URL).rstrip("/")


def _cookie_payload_status(payload: Any, *, mode: str, source: str) -> dict[str, Any]:
    if not isinstance(payload, list):
        return {
            "status": "error",
            "mode": mode,
            "source": source,
            "message": f"{source} must be a valid JSON cookie array",
        }
    if not payload:
        return {
            "status": "auth_missing",
            "mode": mode,
            "source": source,
            "cookieCount": 0,
            "cookieNames": [],
            "requiredCookieNames": list(MYSHELL_ART_REQUIRED_COOKIE_NAMES),
            "missingCookieNames": list(MYSHELL_ART_REQUIRED_COOKIE_NAMES),
            "artApiAuthCookieStatus": "missing",
            "message": f"{source} contains no cookies",
        }
    for index, cookie in enumerate(payload):
        if not isinstance(cookie, dict) or not cookie.get("name") or cookie.get("value") is None:
            return {
                "status": "error",
                "mode": mode,
                "source": source,
                "cookieCount": len(payload),
                "message": f"{source}[{index}] must include cookie name and value",
            }
    cookie_names = _cookie_name_status(payload)
    message = "Cookies configured"
    if cookie_names["missingCookieNames"]:
        message = (
            "Cookies configured, but ms_token is missing; MyShell Art API auth may remain logged out after injection."
        )
    return {
        "status": "ready",
        "mode": mode,
        "source": source,
        "cookieCount": len(payload),
        **cookie_names,
        "message": message,
    }


def cookie_source_payload() -> list[dict[str, Any]]:
    env = os.environ.get("MYSHELL_COOKIES")
    if env:
        payload = json.loads(env)
        return payload if isinstance(payload, list) else []

    cookie_file_path = os.environ.get(COOKIE_FILE_ENV)
    if cookie_file_path:
        with open(os.path.expanduser(cookie_file_path), encoding="utf-8") as cookie_file:
            payload = json.load(cookie_file)
        return payload if isinstance(payload, list) else []

    base = _backend_dir()
    for filename in COOKIE_FILE_NAMES:
        path = os.path.join(base, filename)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as cookie_file:
            payload = json.load(cookie_file)
        return payload if isinstance(payload, list) else []
    return []


def dreamyporn_web_cookie_status() -> dict[str, Any]:
    source = cookie_source_status()
    if source.get("status") != "ready":
        return {
            "status": source.get("status") or "auth_missing",
            "mode": source.get("mode") or "env-or-file",
            "message": str(source.get("message") or "DreamyPorn web cookies are not configured"),
            "cookieCount": source.get("cookieCount", 0),
            "missingCookieNames": list(DREAMYPORN_WEB_REQUIRED_COOKIE_NAMES),
        }
    try:
        payload = cookie_source_payload()
    except Exception as exc:
        return {
            "status": "error",
            "mode": source.get("mode") or "env-or-file",
            "message": f"DreamyPorn cookies could not be read: {exc}",
            "cookieCount": 0,
            "missingCookieNames": list(DREAMYPORN_WEB_REQUIRED_COOKIE_NAMES),
        }
    domain_cookies = [
        cookie
        for cookie in payload
        if isinstance(cookie, dict) and DREAMYPORN_WEB_DOMAIN_FRAGMENT in str(cookie.get("domain") or "")
    ]
    names = sorted({str(cookie.get("name") or "") for cookie in domain_cookies if cookie.get("name")})
    missing = [name for name in DREAMYPORN_WEB_REQUIRED_COOKIE_NAMES if name not in names]
    return {
        "status": "ready" if domain_cookies and not missing else "auth_missing",
        "mode": source.get("mode") or "env-or-file",
        "source": source.get("source", ""),
        "cookieCount": len(domain_cookies),
        "cookieNames": names,
        "requiredCookieNames": list(DREAMYPORN_WEB_REQUIRED_COOKIE_NAMES),
        "missingCookieNames": missing,
        "message": (
            "DreamyPorn web cookies are configured; Studio can call api.dreamyporn.ai directly."
            if domain_cookies and not missing
            else "DreamyPorn web cookies are missing required login cookies."
        ),
    }


def cookie_source_status() -> dict[str, Any]:
    env = os.environ.get("MYSHELL_COOKIES")
    if env:
        try:
            return _cookie_payload_status(json.loads(env), mode="env", source="MYSHELL_COOKIES")
        except Exception as exc:
            return {
                "status": "error",
                "mode": "env",
                "source": "MYSHELL_COOKIES",
                "message": f"MYSHELL_COOKIES must be valid JSON: {exc}",
            }

    cookie_file_path = os.environ.get(COOKIE_FILE_ENV)
    if cookie_file_path:
        try:
            with open(os.path.expanduser(cookie_file_path), encoding="utf-8") as cookie_file:
                return _cookie_payload_status(json.load(cookie_file), mode="file-env", source=COOKIE_FILE_ENV)
        except Exception as exc:
            return {
                "status": "error",
                "mode": "file-env",
                "source": COOKIE_FILE_ENV,
                "message": f"{COOKIE_FILE_ENV} must point to a valid JSON cookie array: {exc}",
            }

    base = _backend_dir()
    for filename in COOKIE_FILE_NAMES:
        path = os.path.join(base, filename)
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as cookie_file:
                return _cookie_payload_status(json.load(cookie_file), mode="file", source=filename)
        except Exception as exc:
            return {
                "status": "error",
                "mode": "file",
                "source": filename,
                "message": f"{filename} must be valid JSON: {exc}",
            }

    return {
        "status": "auth_missing",
        "mode": "env-or-file",
        "message": "No MyShell cookies configured",
    }


def cookies_available() -> bool:
    return cookie_source_status().get("status") == "ready"


def dreamy_init_data() -> str:
    for env_name in DREAMY_INIT_DATA_ENV_NAMES:
        value = os.environ.get(env_name)
        if value and value.strip():
            return value.strip()
    return ""


def dreamy_api_base_url() -> str:
    return (os.environ.get("DREAMY_API_BASE_URL") or DREAMY_DEFAULT_API_BASE_URL).rstrip("/")


def dreamyporn_web_api_base_url() -> str:
    return (os.environ.get("DREAMYPORN_API_BASE_URL") or "https://api.dreamyporn.ai").rstrip("/")


def dreamy_api_auth_status() -> dict[str, Any]:
    configured_env = next((name for name in DREAMY_INIT_DATA_ENV_NAMES if os.environ.get(name)), "")
    if dreamy_init_data():
        return {
            "status": "ready",
            "mode": "server-telegram-init-data",
            "message": "Server-side Dreamy init data is configured; Studio can run Dreamy generation from the backend.",
            "source": configured_env,
            "baseUrl": dreamy_api_base_url(),
        }
    web_cookie_status = dreamyporn_web_cookie_status()
    if web_cookie_status.get("status") == "ready":
        return {
            "status": "ready",
            "mode": "dreamyporn-web-cookies",
            "message": "DreamyPorn web cookies are configured; Studio can run Dreamy generation from the backend.",
            "source": web_cookie_status.get("source", ""),
            "cookieCount": web_cookie_status.get("cookieCount", 0),
            "baseUrl": dreamyporn_web_api_base_url(),
        }
    return {
        "status": "client_delegated",
        "mode": "telegram-init-data",
        "message": "Uses the authenticated Telegram miniapp browser session",
        "baseUrl": dreamy_api_base_url(),
    }


def ffmpeg_status() -> dict[str, Any]:
    path = shutil.which("ffmpeg")
    if not path:
        return {
            "status": "unavailable",
            "message": "FFmpeg is unavailable; long-video exports will return timeline manifests only.",
        }
    return {
        "status": "ok",
        "path": path,
        "message": "FFmpeg is available for long-video timeline export.",
    }


def credential_setup_status() -> dict[str, Any]:
    bindings: list[dict[str, Any]] = []
    missing: list[str] = []
    for binding in SECRET_BINDINGS:
        env_name = str(binding["env"])
        configured = bool(os.environ.get(env_name))
        bindings.append(
            {
                **binding,
                "configured": configured,
                "status": "ready" if configured else "missing",
            }
        )
        if not configured:
            missing.append(env_name)
    if not missing:
        return {
            "status": "ready",
            "mode": "cloud-run-secrets",
            "bindings": bindings,
            "message": "Dreamy and MyShell Art credentials are injected into the runtime.",
        }
    return {
        "status": "needs_configuration",
        "mode": "cloud-run-secrets",
        "bindings": bindings,
        "message": "Create Secret Manager secrets myshell-dreamy-init-data and myshell-cookies; Cloud Build binds them automatically when present.",
        "missingEnv": missing,
    }


def live_generation_status(
    *,
    credential_setup: dict[str, Any] | None = None,
    cookie_source: dict[str, Any] | None = None,
    injection_status: dict[str, Any] | None = None,
    cdp_ready: bool | None = None,
) -> dict[str, Any]:
    credential_setup = credential_setup or credential_setup_status()
    cookie_source = cookie_source or cookie_source_status()
    dreamy_auth = dreamy_api_auth_status()
    missing_env = list(credential_setup.get("missingEnv") or [])
    checks = {
        "dreamyServer": {
            "status": dreamy_auth.get("status"),
            "message": dreamy_auth.get("message", ""),
            "required": True,
        },
        "myshellCookies": {
            "status": cookie_source.get("status"),
            "message": cookie_source.get("message", ""),
            "required": True,
        },
    }
    if injection_status is not None:
        checks["cookieInjection"] = {
            "status": injection_status.get("status"),
            "message": injection_status.get("message", ""),
            "required": True,
        }
    if cdp_ready is not None:
        checks["chromeCdp"] = {
            "status": "ok" if cdp_ready else "unavailable",
            "message": "Chrome CDP is reachable" if cdp_ready else "Chrome CDP is not reachable",
            "required": True,
        }
    if dreamy_auth.get("status") != "ready":
        if missing_env:
            return {
                "status": "needs_configuration",
                "mode": "live-generation-smoke",
                "endpoint": "/api/studio/generation-smoke",
                "message": "Live generation smoke needs Cloud Run secrets or DreamyPorn web cookies before it can prove real media output.",
                "missingEnv": missing_env,
                "checks": checks,
            }
        return {
            "status": "auth_missing",
            "mode": "live-generation-smoke",
            "endpoint": "/api/studio/generation-smoke",
            "message": "Dreamy server auth is not ready; live generation cannot run from the backend.",
            "checks": checks,
        }
    blocking_art_checks = [
        key
        for key, check in checks.items()
        if key != "dreamyServer" and check.get("status") not in {"ok", "ready"}
    ]
    if blocking_art_checks:
        return {
            "status": "auth_missing",
            "mode": "live-generation-smoke",
            "endpoint": "/api/studio/generation-smoke",
            "message": "Dreamy server auth is ready, but MyShell Art CDP auth is not ready for the full chain.",
            "checks": checks,
            "blockedChecks": blocking_art_checks,
        }
    return {
        "status": "ready",
        "mode": "live-generation-smoke",
        "endpoint": "/api/studio/generation-smoke",
        "message": "Live Dreamy generation and MyShell Art authentication prerequisites are ready to verify.",
        "missingEnv": missing_env,
        "checks": checks,
    }


async def chrome_cdp_ready() -> bool:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            response = await client.get(f"{cdp_url()}/json")
        return response.status_code == 200
    except Exception:
        return False


def chrome_cdp_status(timeout: float = 0.75) -> dict[str, Any]:
    url = cdp_url()
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.get(f"{url}/json")
    except Exception as exc:
        return {
            "status": "unavailable",
            "url": url,
            "message": f"Chrome CDP is unavailable: {exc}",
        }
    if response.status_code != 200:
        return {
            "status": "unavailable",
            "url": url,
            "message": f"Chrome CDP returned HTTP {response.status_code}",
        }
    return {
        "status": "ok",
        "url": url,
        "message": "Chrome CDP is reachable",
    }


def cookie_injection_status(has_cookies: bool, cookie_source: dict[str, Any] | None = None) -> dict[str, Any]:
    status_path = os.environ.get("MYSHELL_COOKIE_INJECTION_STATUS_PATH") or DEFAULT_COOKIE_INJECTION_STATUS_PATH
    cookie_source = cookie_source or cookie_source_status()
    if cookie_source.get("status") == "error":
        return {
            "status": "error",
            "mode": "cookie-source",
            "statusPath": status_path,
            "message": str(cookie_source.get("message") or "Cookie source is invalid"),
        }
    if not has_cookies:
        return {
            "status": "auth_missing",
            "mode": "env-or-file",
            "statusPath": status_path,
            "message": str(cookie_source.get("message") or "Set MYSHELL_COOKIES or a backend cookie file"),
        }
    if not os.path.exists(status_path):
        return {
            "status": "pending",
            "mode": "cdp-status-file",
            "statusPath": status_path,
            "message": "Cookie source is available; no Chrome injection result has been recorded yet",
        }
    try:
        with open(status_path, encoding="utf-8") as status_file:
            payload = json.load(status_file)
    except Exception as exc:
        return {
            "status": "error",
            "mode": "cdp-status-file",
            "statusPath": status_path,
            "message": f"Cookie injection status could not be read: {exc}",
        }

    raw_status = str(payload.get("status") or "").strip().lower()
    if raw_status in {"success", "ready", "ok"}:
        normalized_status = "ready"
    elif raw_status in {"captcha_required", "challenge_required"}:
        normalized_status = "captcha_required"
    else:
        normalized_status = "error"
    return {
        "status": normalized_status,
        "mode": "cdp-status-file",
        "statusPath": status_path,
        "checkedAt": payload.get("checkedAt") or payload.get("updatedAt") or "",
        "cookieCount": payload.get("cookieCount", 0),
        "energyDisplay": payload.get("energyDisplay", ""),
        "currentUrl": payload.get("currentUrl", ""),
        "message": str(payload.get("message") or ("Cookie injection succeeded" if normalized_status == "ready" else "Cookie injection failed")),
    }


async def runtime_health(store_path: str) -> dict[str, Any]:
    storage_ready = os.path.exists(os.path.dirname(store_path)) and os.access(os.path.dirname(store_path), os.W_OK)
    cookie_source = cookie_source_status()
    has_cookies = cookie_source.get("status") == "ready"
    cdp_ready = await chrome_cdp_ready()
    art_auth = "ready" if has_cookies else "auth_missing"
    injection_status = cookie_injection_status(has_cookies, cookie_source)
    media_export_status = ffmpeg_status()
    credential_setup = credential_setup_status()
    generation_status = live_generation_status(
        credential_setup=credential_setup,
        cookie_source=cookie_source,
        injection_status=injection_status,
        cdp_ready=cdp_ready,
    )
    degraded_component = (
        not storage_ready
        or not cdp_ready
        or str(injection_status.get("status") or "") in {"auth_missing", "error", "pending", "captcha_required"}
        or generation_status.get("status") != "ready"
    )
    overall = "degraded" if degraded_component else "ok"
    return {
        "status": overall,
        "version": "0.2.0",
        "checkedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "components": {
            "backend": {"status": "ok", "message": "FastAPI runtime is serving requests"},
            "storage": {"status": "ok" if storage_ready else "error", "path": store_path},
            "chromeCdp": {"status": "ok" if cdp_ready else "unavailable", "url": cdp_url()},
            "myshellCookies": {**cookie_source, "status": "ready" if has_cookies else cookie_source.get("status", art_auth)},
            "cookieInjection": injection_status,
            "dreamyApiAuth": dreamy_api_auth_status(),
            "ffmpeg": media_export_status,
            "credentialSetup": credential_setup,
            "liveGeneration": generation_status,
        },
    }


def adapter_auth_status(page_id: str) -> dict[str, Any]:
    if page_id == "myshell-art":
        cookie_source = cookie_source_status()
        has_cookies = cookie_source.get("status") == "ready"
        injection_status = cookie_injection_status(has_cookies, cookie_source)
        injection_state = str(injection_status.get("status") or "")
        cdp_status = (
            chrome_cdp_status()
            if has_cookies and injection_state == "ready"
            else {
                "status": "not_checked",
                "url": cdp_url(),
                "message": "Chrome CDP is checked after cookie injection succeeds",
            }
        )
        cdp_state = str(cdp_status.get("status") or "unknown")
        ready = has_cookies and injection_state == "ready" and cdp_state == "ok"
        message = str(injection_status.get("message") or "Set MYSHELL_COOKIES or myshell-cookies.json")
        if ready:
            message = "MyShell cookies are injected into Chrome and CDP is reachable"
        elif has_cookies and injection_state == "ready":
            message = str(cdp_status.get("message") or "Chrome CDP is unavailable")
        return {
            "status": "ready" if ready else "auth_missing",
            "mode": "browser-cookies",
            "message": message,
            "injectionStatus": injection_state,
            "cdpStatus": cdp_state,
            "cdpUrl": cdp_status.get("url", ""),
            "statusPath": injection_status.get("statusPath", ""),
        }
    if page_id == "dreamy-miniapp":
        return dreamy_api_auth_status()
    return {
        "status": "client_delegated",
        "mode": "telegram-init-data",
        "message": "Uses the authenticated Telegram miniapp browser session",
    }
