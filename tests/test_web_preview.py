"""Tests for the kernel preview-proxy (docs/reference-viewer-panel.md §10).

Covers the SSRF vetting (default-deny not-is-global, CGNAT, link-local,
IPv4-mapped), the http(s)-only link guard, the nh3 zero-attribute sanitizer, the
stateless bearer ticket, and the fetch path (content-type reject, byte cap,
manual redirect, protocol/private blocks) via a loopback test server.
"""
from __future__ import annotations

import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from superclaw import web_preview as wp


@pytest.fixture(autouse=True)
def _no_ambient_proxy(monkeypatch):
    """Neutralize any OS/system proxy so the resolve-and-pin path is the default
    in these tests regardless of the dev machine's env (env-independence iron law:
    a machine with HTTP(S)_PROXY set must not change SSRF test outcomes). The
    proxy-path tests opt back in by monkeypatching ``_proxy_for_host`` directly,
    and the ``_proxy_for_host`` unit test re-patches ``getproxies`` itself."""
    import urllib.request

    monkeypatch.setattr(urllib.request, "getproxies", lambda: {})


# --------------------------------------------------------------------------- #
# SSRF IP vetting
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "ip,allowed",
    [
        ("8.8.8.8", True),
        ("1.1.1.1", True),
        ("127.0.0.1", False),
        ("10.0.0.1", False),
        ("192.168.1.1", False),
        ("172.16.0.1", False),
        ("169.254.169.254", False),   # cloud metadata / link-local
        ("100.64.0.1", False),         # CGNAT (is_private=False but not global)
        ("0.0.0.0", False),
        ("::1", False),
        ("fe80::1", False),
        ("fc00::1", False),            # ULA
        ("::ffff:127.0.0.1", False),   # IPv4-mapped loopback
        ("::ffff:8.8.8.8", True),      # IPv4-mapped public is fine
        ("::127.0.0.1", False),        # IPv4-COMPATIBLE loopback (is_global=True trap)
        ("::192.168.1.1", False),      # IPv4-compatible private
        ("64:ff9b::127.0.0.1", False), # NAT64 well-known prefix embedding loopback
        ("64:ff9b::8.8.8.8", True),    # NAT64 embedding a public IPv4 is fine
        ("2002:7f00:1::", False),      # 6to4 of 127.0.0.1
        ("not-an-ip", False),
    ],
)
def test_ip_is_public(ip, allowed):
    assert wp._ip_is_public(ip) is allowed


def test_resolve_and_pin_rejects_private(monkeypatch):
    import socket

    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 80))],
    )
    with pytest.raises(wp.PreviewError) as exc:
        wp._resolve_and_pin("evil.example", 80)
    assert exc.value.code == "blocked_private"


def test_resolve_and_pin_rejects_if_any_ip_private(monkeypatch):
    import socket

    # one public + one private -> reject the whole host (rebinding defence)
    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda *a, **k: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80)),
        ],
    )
    with pytest.raises(wp.PreviewError) as exc:
        wp._resolve_and_pin("mixed.example", 80)
    assert exc.value.code == "blocked_private"


# --------------------------------------------------------------------------- #
# Link guard + sanitizer
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("https://x.com/a", "https://x.com/a"),
        ("http://x.com", "http://x.com"),
        ("javascript:alert(1)", None),
        ("data:text/html,x", None),
        ("../relative", None),
        ("//proto-relative", None),
        ("mailto:a@b.com", None),
        ("", None),
        (None, None),
    ],
)
def test_safe_external_link(raw, expected):
    assert wp.safe_external_link(raw) == expected


def test_sanitizer_strips_everything_dangerous():
    html = (
        '<p onclick="x" style="color:red">hi</p>'
        '<script>bad()</script><style>p{color:red}</style>'
        '<img src="http://127.0.0.1/x"><iframe src="x"></iframe>'
        '<svg><use href="x"/></svg><object data="x"></object>'
        '<a href="https://e.com">link</a><form action="x"><input></form>'
        '<meta http-equiv="refresh" content="0;url=http://x">'
        '<link rel="prefetch" href="http://x">'
    )
    out = wp.sanitize_preview_html(html)
    # nothing that can issue a network request or run code survives
    for needle in ("script", "style", "iframe", "<img", "src=", "href=", "onclick",
                   "svg", "object", "form", "<input", "meta", "<link", "javascript"):
        assert needle not in out, f"{needle!r} leaked: {out!r}"
    assert "hi" in out and "link" in out  # text preserved


# --------------------------------------------------------------------------- #
# Faithful page builder (styled view)
# --------------------------------------------------------------------------- #
def test_build_faithful_page_injects_csp_and_base_first_in_head():
    raw = "<html><head><title>T</title></head><body><p>hi</p></body></html>"
    out = wp.build_faithful_page(raw, "https://example.com/a?b=1&c=2")
    head = out.lower().index("<head>")
    csp = out.index("Content-Security-Policy")
    base = out.index("<base ")
    title = out.index("<title>")
    # CSP + base are injected FIRST in <head>, before the page's own head content,
    # so they govern the document and our <base> wins over any the page ships.
    assert head < csp < base < title
    # the page CSP blocks ACTIVE content but must NOT deny passive subresources —
    # styles/images load so the page renders faithfully.
    assert "script-src 'none'" in out
    assert "object-src 'none'" in out
    assert "default-src 'none'" not in out
    assert "style-src 'none'" not in out
    assert "img-src 'none'" not in out
    # base href is HTML-attribute-escaped (& -> &amp;) so it cannot break the attr.
    assert '<base href="https://example.com/a?b=1&amp;c=2">' in out
    # original body preserved verbatim (faithful)
    assert "<p>hi</p>" in out


def test_build_faithful_page_escapes_attribute_breakout_in_base():
    # A url smuggling a double-quote + tag must be neutralised, never reproduced raw.
    out = wp.build_faithful_page("<head></head>", 'https://e.com/"><script>evil()</script>')
    assert '"><script>' not in out
    assert "&quot;&gt;&lt;script&gt;" in out


def test_build_faithful_page_synthesizes_head_when_missing():
    # No <head> and no <html>: a wrapper document is synthesized so CSP+base govern.
    bare = wp.build_faithful_page("<p>plain</p>", "https://e.com/")
    assert bare.startswith("<!doctype html><html><head>")
    assert "Content-Security-Policy" in bare and "<p>plain</p>" in bare
    # <html> present but no <head>: a <head> is inserted right after <html>.
    html_only = wp.build_faithful_page("<html><body><p>x</p></body></html>", "https://e.com/")
    assert '<html><head><meta http-equiv="Content-Security-Policy"' in html_only
    assert '<base href="https://e.com/">' in html_only
    assert "<p>x</p>" in html_only


def test_extract_links_http_only_and_dedup():
    html = (
        '<a href="https://a.com">A</a>'
        '<a href="javascript:alert(1)">evil</a>'
        '<a href="https://a.com">dup</a>'
        '<a href="http://b.com">B</a>'
        '<a href="data:text/html,x">data</a>'
    )
    links = wp._extract_links(html)
    urls = [link["url"] for link in links]
    assert urls == ["https://a.com", "http://b.com"]  # http(s) only, deduped


# --------------------------------------------------------------------------- #
# Bearer ticket
# --------------------------------------------------------------------------- #
def test_ticket_roundtrip():
    key = b"k" * 32
    now = 1000.0
    t = wp.sign_preview_ticket("https://e.com/", "op1", key, now=now, nonce="n1")
    claims = wp.verify_preview_ticket(t, key, now=now + 5)
    assert claims["url"] == "https://e.com/"
    assert claims["principal"] == "op1"
    assert claims["aud"] == "preview" and claims["method"] == "GET"


def test_ticket_bad_signature():
    key = b"k" * 32
    t = wp.sign_preview_ticket("https://e.com/", "op1", key, now=1000.0, nonce="n1")
    with pytest.raises(wp.PreviewError) as exc:
        wp.verify_preview_ticket(t, b"other-key" * 4, now=1001.0)
    assert exc.value.code == "invalid_ticket"


def test_ticket_expired():
    key = b"k" * 32
    t = wp.sign_preview_ticket("https://e.com/", "op1", key, now=1000.0, nonce="n1", ttl=60)
    with pytest.raises(wp.PreviewError) as exc:
        wp.verify_preview_ticket(t, key, now=1000.0 + 61)
    assert exc.value.code == "invalid_ticket"


def test_ticket_tamper_payload():
    key = b"k" * 32
    t = wp.sign_preview_ticket("https://e.com/", "op1", key, now=1000.0, nonce="n1")
    body, sig = t.split(".", 1)
    tampered = wp._b64u(b'{"aud":"preview","method":"GET","exp":9999999999,"url":"x"}') + "." + sig
    with pytest.raises(wp.PreviewError):
        wp.verify_preview_ticket(tampered, key, now=1001.0)


# --------------------------------------------------------------------------- #
# Fetch path (loopback test server; SSRF IP gate relaxed for these only)
# --------------------------------------------------------------------------- #
class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):  # silence
        pass

    def do_GET(self):  # noqa: N802
        body = self.server.body  # type: ignore[attr-defined]
        status = self.server.status  # type: ignore[attr-defined]
        headers = self.server.extra_headers  # type: ignore[attr-defined]
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.body = b"<html><body><p>ok</p></body></html>"
    httpd.status = 200
    httpd.extra_headers = {"Content-Type": "text/html"}
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()


def _url(server) -> str:
    return f"http://127.0.0.1:{server.server_address[1]}/"


def test_fetch_happy_path(server, monkeypatch):
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)  # allow loopback for this test only
    result = wp.fetch_url_preview(_url(server))
    assert result.ok is True
    assert "<p>ok</p>" in result.sanitized_html
    assert result.status == 200
    # The faithful styled view is built from the SAME fetch: real body + the
    # script-blocking page CSP + a <base> pinned to the final URL.
    assert "<p>ok</p>" in result.page_html
    assert "script-src 'none'" in result.page_html
    assert f'<base href="{_url(server)}"' in result.page_html


def test_fetch_rejects_bad_content_type(server, monkeypatch):
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)
    server.extra_headers = {"Content-Type": "application/zip"}
    with pytest.raises(wp.PreviewError) as exc:
        wp.fetch_url_preview(_url(server))
    assert exc.value.code == "bad_content_type"


def test_fetch_byte_cap_truncates(server, monkeypatch):
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)
    server.body = b"<p>" + b"a" * 5000 + b"</p>"
    result = wp.fetch_url_preview(_url(server), max_bytes=1000)
    assert result.truncated is True


def test_fetch_blocks_non_http_protocol():
    with pytest.raises(wp.PreviewError) as exc:
        wp.fetch_url_preview("file:///etc/passwd")
    assert exc.value.code == "blocked_protocol"


def test_fetch_blocks_private_resolution(monkeypatch):
    import socket

    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))],
    )
    with pytest.raises(wp.PreviewError) as exc:
        wp.fetch_url_preview("http://evil.example/")
    assert exc.value.code == "blocked_private"


# --------------------------------------------------------------------------- #
# Acceptance-round fixes: hard deadline, throttle, compression reject, ticket
# --------------------------------------------------------------------------- #
class _SlowHandler(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_GET(self):  # noqa: N802
        time.sleep(self.server.delay)  # hold before sending ANY response (slow header)
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


@pytest.fixture
def slow_server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _SlowHandler)
    httpd.delay = 5.0
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()


def test_fetch_hard_deadline_aborts_slow_header(slow_server, monkeypatch):
    # The watchdog must abort a slow-header drip near the budget, not after the
    # server's 5s delay (proves the header-phase Slowloris hole is closed).
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)
    url = f"http://127.0.0.1:{slow_server.server_address[1]}/"
    start = time.monotonic()
    with pytest.raises(wp.PreviewError) as exc:
        wp.fetch_url_preview(url, timeout=0.5)
    elapsed = time.monotonic() - start
    assert exc.value.code == "timeout"
    assert elapsed < 3.0, f"deadline not enforced (took {elapsed:.1f}s)"


def test_fetch_rejects_compressed_response(server, monkeypatch):
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)
    server.extra_headers = {"Content-Type": "text/html", "Content-Encoding": "gzip"}
    with pytest.raises(wp.PreviewError) as exc:
        wp.fetch_url_preview(_url(server))
    assert exc.value.code == "fetch_failed"


def test_admission_per_target_throttle():
    with wp._PreviewAdmission("host.example"), wp._PreviewAdmission("host.example"):
        with pytest.raises(wp.PreviewError) as exc:  # 3rd > per-target limit (2)
            with wp._PreviewAdmission("host.example"):
                pass
        assert exc.value.code == "throttled"
    # released on exit -> usable again
    with wp._PreviewAdmission("host.example"):
        pass


def test_ticket_principal_and_route_binding():
    key = b"k" * 32
    t = wp.sign_preview_ticket("https://e.com/", "gen-1", key, now=1000.0, nonce="n1")
    # matching principal passes
    assert wp.verify_preview_ticket(t, key, now=1001.0, expected_principal="gen-1")["principal"] == "gen-1"
    # rotated/other principal is rejected
    with pytest.raises(wp.PreviewError) as exc:
        wp.verify_preview_ticket(t, key, now=1001.0, expected_principal="gen-2")
    assert exc.value.code == "invalid_ticket"


def test_fetch_dns_slowloris_is_bounded(monkeypatch):
    # A stuck/slow resolver must not pin the worker past the budget (DNS is run
    # under the remaining wall-clock deadline, admission held around it).
    import socket

    def slow_resolve(*_a, **_k):
        time.sleep(5)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80))]

    monkeypatch.setattr(socket, "getaddrinfo", slow_resolve)
    start = time.monotonic()
    with pytest.raises(wp.PreviewError) as exc:
        wp.fetch_url_preview("http://slow-dns.example/", timeout=0.5)
    elapsed = time.monotonic() - start
    assert exc.value.code == "timeout"
    assert elapsed < 3.0, f"DNS deadline not enforced (took {elapsed:.1f}s)"


def test_dns_resolver_threads_are_bounded(monkeypatch):
    # Repeated DNS timeouts must NOT accumulate unbounded zombie resolver threads
    # (and no unbounded queue): the global DNS semaphore caps physically-stuck
    # threads at its size; over-cap requests fail fast on acquire timeout.
    import socket

    release = threading.Event()

    def stuck(*_a, **_k):
        release.wait(30)  # interruptible by the test (so no exit hang)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80))]

    monkeypatch.setattr(socket, "getaddrinfo", stuck)
    attempts = wp._PREVIEW_DNS_CONCURRENCY + 12  # exceed the cap
    try:
        for _ in range(attempts):
            with pytest.raises(wp.PreviewError) as exc:
                wp.fetch_url_preview("http://slow.example/", timeout=0.05)
            assert exc.value.code in {"timeout", "throttled"}
        dns_threads = [t for t in threading.enumerate() if t.name == "preview-dns"]
        assert len(dns_threads) <= wp._PREVIEW_DNS_CONCURRENCY, (
            f"resolver threads not bounded: {len(dns_threads)} > {wp._PREVIEW_DNS_CONCURRENCY}"
        )
    finally:
        release.set()  # let the stuck resolver threads finish + release their slots


def test_dns_resolver_start_failure_does_not_leak_slot(monkeypatch):
    # If Thread.start() fails (pids/ulimit), the acquired DNS slot must be
    # returned by the caller — else the pool drains to 0 and never recovers.
    import socket

    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80))],
    )
    before = wp._dns_semaphore._value

    def boom(self):
        raise RuntimeError("can't start new thread")

    orig_start = threading.Thread.start
    threading.Thread.start = boom  # type: ignore[method-assign]
    try:
        for _ in range(40):  # far more than the cap — must NOT exhaust the semaphore
            with pytest.raises(wp.PreviewError) as exc:
                wp._resolve_with_deadline("x.example", 80, time.monotonic() + 1.0)
            assert exc.value.code == "throttled"
    finally:
        threading.Thread.start = orig_start  # type: ignore[method-assign]
    assert wp._dns_semaphore._value == before  # no slot leaked
    # and a normal resolve still works (getaddrinfo is still patched to public)
    assert wp._resolve_with_deadline("x.example", 80, time.monotonic() + 1.0)[1] == "8.8.8.8"


# --------------------------------------------------------------------------- #
# System-proxy path (§10.14): hostname gate + proxy routing
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "host,allowed",
    [
        ("example.com", True),
        ("sub.example.co.uk", True),
        ("8.8.8.8", True),               # public IP literal is fine
        ("localhost", False),
        ("local", False),                # bare internal label must not bypass
        ("internal", False),
        ("app.localhost", False),
        ("printer.local", False),
        ("svc.internal", False),
        ("[::127.0.0.1]", False),        # IPv4-compatible loopback via proxy gate
        ("127.0.0.1", False),
        ("10.0.0.1", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),      # link-local / metadata
        ("0177.0.0.1", False),           # octal -> 127.0.0.1
        ("2130706433", False),           # decimal -> 127.0.0.1
        ("0x7f.0.0.1", False),           # hex -> 127.0.0.1
        ("[::1]", False),
        ("[fc00::1]", False),            # ULA
        ("[::ffff:127.0.0.1]", False),   # IPv4-mapped loopback
        ("EXAMPLE.com.", True),          # case + trailing dot normalize to public
        ("localhost.", False),           # trailing dot must not bypass
        # Unicode/IDNA bypass vectors: httpx normalizes these before connecting, so
        # the gate must judge the normalized host (regression for the SSRF bypass).
        ("127。0。0。1", False),   # ideographic dots -> 127.0.0.1
        ("foo。localhost", False),          # -> foo.localhost
        ("localhost。", False),             # -> localhost.
        ("１２７.0.0.1", False),    # fullwidth digits (httpx rejects)
        ("", False),
    ],
)
def test_require_host_allowed_for_proxy(host, allowed):
    url = f"http://{host}/" if host else "http:///"
    if allowed:
        wp._require_host_allowed_for_proxy(url)  # must not raise
    else:
        with pytest.raises(wp.PreviewError) as exc:
            wp._require_host_allowed_for_proxy(url)
        assert exc.value.code in ("blocked_private", "blocked_protocol")


def test_proxy_for_host_reads_env_and_bypass(monkeypatch):
    import urllib.request

    monkeypatch.setattr(urllib.request, "getproxies", lambda: {"https": "http://127.0.0.1:9", "http": "http://127.0.0.1:9"})
    monkeypatch.setattr(urllib.request, "proxy_bypass", lambda host: host == "localhost")
    assert wp._proxy_for_host("https", "example.com") == "http://127.0.0.1:9"
    assert wp._proxy_for_host("https", "localhost") is None  # bypass -> direct
    # bare host:port gets an http:// scheme
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {"http": "127.0.0.1:9"})
    monkeypatch.setattr(urllib.request, "proxy_bypass", lambda host: False)
    assert wp._proxy_for_host("http", "example.com") == "http://127.0.0.1:9"
    # no proxy configured -> None
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {})
    assert wp._proxy_for_host("https", "example.com") is None


def test_fetch_routes_public_host_through_proxy(server, monkeypatch):
    # The loopback server doubles as a forward proxy: it answers any GET (it
    # ignores the absolute-URI request line) with its body. Routing a PUBLIC host
    # through it must succeed WITHOUT any local DNS resolve/pin.
    proxy_url = _url(server).rstrip("/")
    monkeypatch.setattr(wp, "_proxy_for_host", lambda scheme, host: proxy_url)

    def _no_resolve(*_a, **_k):  # the proxy path must not touch the resolver
        raise AssertionError("proxy path must not resolve+pin locally")

    monkeypatch.setattr(wp, "_resolve_with_deadline", _no_resolve)
    result = wp.fetch_url_preview("http://example.com/", allow_proxy=True)
    assert result.ok is True
    assert "<p>ok</p>" in result.sanitized_html


def test_fetch_proxy_path_still_blocks_internal_hosts(server, monkeypatch):
    # Even with a proxy configured, an internal target is refused by the hostname
    # gate BEFORE any fetch (no SSRF via the proxy).
    monkeypatch.setattr(wp, "_proxy_for_host", lambda scheme, host: _url(server).rstrip("/"))
    for url, code in [
        ("http://localhost/", "blocked_private"),
        ("http://127.0.0.1/", "blocked_private"),
        ("http://10.0.0.1/", "blocked_private"),
    ]:
        with pytest.raises(wp.PreviewError) as exc:
            wp.fetch_url_preview(url, allow_proxy=True)
        assert exc.value.code == code


def test_allow_proxy_false_forces_pin_path(monkeypatch):
    # allow_proxy=False must skip the proxy lookup entirely and use resolve+pin,
    # which rejects a private resolution.
    import socket

    seen = {"proxy": False}

    def _spy(scheme, host):
        seen["proxy"] = True
        return "http://127.0.0.1:9"

    monkeypatch.setattr(wp, "_proxy_for_host", _spy)
    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 80))],
    )
    with pytest.raises(wp.PreviewError) as exc:
        wp.fetch_url_preview("http://internal.example/", allow_proxy=False)
    assert exc.value.code == "blocked_private"
    assert seen["proxy"] is False  # proxy lookup never consulted


def test_no_proxy_configured_uses_pin_path(server, monkeypatch):
    # allow_proxy=True but NO proxy configured -> resolve+pin path (loopback ok'd
    # for this test) behaves exactly as before.
    monkeypatch.setattr(wp, "_proxy_for_host", lambda scheme, host: None)
    monkeypatch.setattr(wp, "_ip_is_public", lambda ip: True)
    result = wp.fetch_url_preview(_url(server), allow_proxy=True)
    assert result.ok is True
    assert "<p>ok</p>" in result.sanitized_html


@pytest.mark.parametrize("bad_proxy", ["://", "http://[::1", "ht!tp://x"])
def test_proxy_malformed_url_fails_closed(bad_proxy, monkeypatch):
    # A malformed system/env proxy value (proxy mode is default-on) must surface
    # as the stable fetch_failed refusal, never a raw exception / 500.
    monkeypatch.setattr(wp, "_proxy_for_host", lambda scheme, host: bad_proxy)
    with pytest.raises(wp.PreviewError) as exc:
        wp.fetch_url_preview("http://example.com/", allow_proxy=True)
    assert exc.value.code in ("fetch_failed", "timeout")
