"""Inject MyShell cookies into headless Chrome via CDP.
Reads cookies from: 1) MYSHELL_COOKIES env var, 2) myshell-cookies.json, 3) embedded fallback
"""
import json, os, asyncio, httpx, websockets, time, sys
from datetime import UTC, datetime

DEFAULT_CDP_URL = "http://127.0.0.1:9222"
STATUS_PATH = os.environ.get(
    "MYSHELL_COOKIE_INJECTION_STATUS_PATH",
    os.path.join(os.path.dirname(__file__), ".studio", "cookie-injection-status.json"),
)

def _cdp_url():
    return (os.environ.get("MYSHELL_CDP_URL") or DEFAULT_CDP_URL).rstrip("/")


class CookieSourceError(ValueError):
    pass


def _write_status(status, message, cookie_count=0, energy_display=""):
    os.makedirs(os.path.dirname(STATUS_PATH) or ".", exist_ok=True)
    with open(STATUS_PATH, "w", encoding="utf-8") as status_file:
        json.dump(
            {
                "status": status,
                "message": message,
                "cookieCount": cookie_count,
                "energyDisplay": energy_display,
                "checkedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            },
            status_file,
            ensure_ascii=False,
        )


def _write_status_payload(payload):
    os.makedirs(os.path.dirname(STATUS_PATH) or ".", exist_ok=True)
    payload = {
        "checkedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        **payload,
    }
    with open(STATUS_PATH, "w", encoding="utf-8") as status_file:
        json.dump(payload, status_file, ensure_ascii=False)


def _classify_post_injection_state(current_url, body_text, energy_display, is_login=False):
    url = str(current_url or "")
    text = str(body_text or "")
    energy = str(energy_display or "")
    login_detected = bool(is_login)
    if "cf-captcha" in url or "connection is secure" in text.lower() or "challenge-platform" in text:
        return {
            "status": "captcha_required",
            "message": "Cloudflare captcha challenge blocked the headless browser; use a verified browser session or complete the challenge before target-bot execution.",
            "energyDisplay": energy,
            "currentUrl": url,
            "loginDetected": login_detected,
        }
    success = login_detected or "not found" not in energy
    return {
        "status": "success" if success else "failed",
        "message": "Cookie injection succeeded" if success else "Cookie injection did not reveal a logged-in energy display",
        "energyDisplay": energy,
        "currentUrl": url,
        "loginDetected": login_detected,
    }


def _validate_cookie_payload(payload, source):
    if not isinstance(payload, list):
        raise CookieSourceError(f"{source} must be a valid JSON cookie array")
    for index, cookie in enumerate(payload):
        if not isinstance(cookie, dict) or not cookie.get("name") or cookie.get("value") is None:
            raise CookieSourceError(f"{source}[{index}] must include cookie name and value")
    return payload


def _load_cookie_json(source, loader):
    try:
        payload = loader()
    except Exception as exc:
        raise CookieSourceError(f"{source} must be valid JSON cookie array: {exc}") from exc
    return _validate_cookie_payload(payload, source)


def _load_cookies():
    """Load cookies from env, file, or embedded fallback."""
    # 1. Environment variable
    env = os.environ.get("MYSHELL_COOKIES", "")
    if env:
        return _load_cookie_json("MYSHELL_COOKIES", lambda: json.loads(env))

    # 2. Environment file path
    cookie_file_env = os.environ.get("MYSHELL_COOKIES_FILE", "")
    if cookie_file_env:
        cookie_file_path = os.path.expanduser(cookie_file_env)
        with open(cookie_file_path, encoding="utf-8") as f:
            return _load_cookie_json("MYSHELL_COOKIES_FILE", lambda: json.load(f))

    # 3. External file
    cookie_file = os.path.join(os.path.dirname(__file__), "myshell-cookies.json")
    if os.path.exists(cookie_file):
        with open(cookie_file) as f:
            return _load_cookie_json("myshell-cookies.json", lambda: json.load(f))

    # 4. Embedded fallback
    embedded_file = os.path.join(os.path.dirname(__file__), "myshell_cookies_embedded.json")
    if os.path.exists(embedded_file):
        with open(embedded_file) as f:
            return _load_cookie_json("myshell_cookies_embedded.json", lambda: json.load(f))

    return None


def _select_cdp_page(pages):
    page_targets = [page for page in pages if page.get("type") == "page" and page.get("webSocketDebuggerUrl")]
    if not page_targets:
        return pages[0] if pages else None
    return next((page for page in page_targets if "art.myshell.ai" in page.get("url", "")), page_targets[0])

async def inject_cookies():
    try:
        cookies = _load_cookies()
    except CookieSourceError as exc:
        print(f"[COOKIES] Invalid cookie source: {exc}")
        _write_status("failed", str(exc), 0)
        return False
    if not cookies:
        print("[COOKIES] No cookies found — MyShell bots will not work")
        _write_status("missing_cookies", "No cookies found", 0)
        return False

    print(f"[COOKIES] Loaded {len(cookies)} cookies")

    # Wait for Chrome
    for i in range(30):
        try:
            pages = httpx.Client().get(f"{_cdp_url()}/json", timeout=2).json()
            break
        except:
            time.sleep(1)
    else:
        print("[COOKIES] Chrome not ready after 30s")
        _write_status("failed", "Chrome not ready after 30s", len(cookies))
        return False

    page = _select_cdp_page(pages)
    if not page:
        print("[COOKIES] Chrome CDP returned no inspectable pages")
        _write_status("failed", "Chrome CDP returned no inspectable pages", len(cookies))
        return False
    ws_url = page["webSocketDebuggerUrl"]

    async with websockets.connect(ws_url, max_size=10*1024*1024) as ws:
        mid = [0]
        async def cdp(method, params=None):
            mid[0] += 1
            m = {"id": mid[0], "method": method}
            if params: m["params"] = params
            await ws.send(json.dumps(m))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == mid[0]: return r

        # Navigate to myshell first (cookies need matching domain)
        await cdp("Page.navigate", {"url": "https://art.myshell.ai"})
        await asyncio.sleep(3)

        # Inject cookies
        for cookie in cookies:
            params = {
                "name": cookie["name"],
                "value": cookie["value"],
                "domain": cookie.get("domain", ".myshell.ai"),
                "path": cookie.get("path", "/"),
                "secure": cookie.get("secure", True),
                "httpOnly": cookie.get("httpOnly", False),
            }
            if cookie.get("expires", 0) > 0:
                params["expires"] = cookie["expires"]
            if cookie.get("sameSite"):
                params["sameSite"] = cookie["sameSite"]

            await cdp("Network.setCookie", params)

        print(f"[COOKIES] Injected {len(cookies)} cookies")

        # Reload page to apply cookies
        await cdp("Page.navigate", {"url": "https://art.myshell.ai"})
        await asyncio.sleep(5)

        # Verify login
        async def ev(expr):
            r = await cdp("Runtime.evaluate", {"expression": expr, "returnByValue": True})
            return r.get("result",{}).get("result",{}).get("value","")

        energy = await ev("document.body.innerText.match(/(\\d+)\\s*\\/\\s*(\\d+)/)?.[0] || 'not found'")
        current_url = await ev("location.href")
        body_text = await ev("document.body.innerText.slice(0, 1000)")
        is_login = await ev("Boolean(window.$global && window.$global.isLogin)")
        print(f"[COOKIES] Energy display: {energy}")
        state = _classify_post_injection_state(current_url, body_text, energy, is_login)
        _write_status_payload({**state, "cookieCount": len(cookies)})
        return state["status"] == "success"

def main():
    try:
        result = asyncio.run(inject_cookies())
    except Exception as exc:
        _write_status("failed", str(exc), 0)
        raise
    print(f"[COOKIES] {'SUCCESS' if result else 'FAILED'}")
    return 0 if result else 1


if __name__ == "__main__":
    sys.exit(main())
