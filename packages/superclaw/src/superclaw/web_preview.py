"""Reference viewer — kernel preview-proxy (single source of truth).

Server-side fetch of an untrusted URL into a *sanitized, non-navigable reader
document* the surfaces can embed without the browser making ANY network request.
Design + adversarial review trail (R3→R10 dual-PASS): docs/reference-viewer-panel.md §10.

Security posture (fail-closed; forced out across 8 rounds of Codex+Gemini review):

- SSRF (confidentiality): default-deny ``not ip.is_global`` over EVERY resolved
  A/AAAA (catches CGNAT 100.64/10, link-local 169.254.169.254, …); IPv4-mapped
  IPv6 is down-converted before the check; the vetted IP is pinned at the socket
  while the original hostname drives SNI + cert (so DNS rebinding between check
  and connect is impossible); redirects are followed manually with per-hop
  re-vetting; ``trust_env`` is off and no credentials are ever sent.
- Integrity: two-step sanitize — extract ``<a href>`` (http(s)-only) for the
  parent UI, then nh3 (html5ever) zero-attribute text-only clean for the body.
- Availability: streaming byte cap (also bounds decompression), wall-clock
  deadline, redirect cap, content-type early-reject.
- Ticket: stateless HMAC bearer bound to {url, principal, method, exp, …}.

This module owns the fetch/sanitize/ticket primitives; admission-control and the
HTTP surface live at the API stage (docs §10.11).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import socket
import threading
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from html import escape as _html_escape
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
import nh3
from httpcore._backends.sync import SyncBackend as _SyncBackend

__all__ = [
    "PREVIEW_MAX_BYTES",
    "PREVIEW_TICKET_TTL_S",
    "PreviewError",
    "PreviewResult",
    "build_faithful_page",
    "canonical_preview_url",
    "fetch_url_preview",
    "safe_external_link",
    "sanitize_preview_html",
    "sign_preview_ticket",
    "verify_preview_ticket",
]

#: Hard cap on the DECODED response body (httpx decompresses during iteration, so
#: this also bounds a decompression bomb). Beyond it the fetch aborts.
PREVIEW_MAX_BYTES = 5 * 1024 * 1024
#: Absolute wall-clock budget for one fetch (incl. all redirect hops) — defends
#: against Slowloris / slow-drip targets holding a concurrency slot.
PREVIEW_TIMEOUT_S = 8.0
PREVIEW_MAX_REDIRECTS = 5
PREVIEW_TICKET_TTL_S = 60
#: Only these content types are sanitized; anything else (video/zip/binary) is
#: rejected before it reaches the parser. A missing type is treated as text.
_PREVIEW_TEXT_TYPES = ("text/html", "text/plain", "application/xhtml+xml")

_PREVIEW_ERROR_CODES = (
    "blocked_protocol",
    "blocked_private",
    "blocked_dns",
    "blocked_redirect",
    "bad_content_type",
    "too_large",
    "timeout",
    "throttled",
    "fetch_failed",
    "invalid_ticket",
)

# nh3 zero-attribute text-only allowlist. Tags not listed are unwrapped (text
# kept); CLEAN_CONTENT tags are removed with their content (so CSS/JS/SVG text
# never surfaces). ``<a>`` is deliberately NOT allowed — links are extracted
# separately and the body keeps only inert text.
_PREVIEW_ALLOWED_TAGS = {
    "p", "div", "span", "section", "article", "header", "footer", "main", "aside",
    "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
    "code", "pre", "em", "strong", "b", "i", "u", "s", "small", "sub", "sup",
    "br", "hr", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
    "dl", "dt", "dd", "figure", "figcaption", "abbr", "cite", "q", "mark",
}
_PREVIEW_CLEAN_CONTENT_TAGS = {
    "script", "style", "iframe", "object", "embed", "form", "svg", "math",
    "audio", "video", "source", "track", "picture", "canvas", "noscript",
    "template", "head", "title", "meta", "link", "base", "applet", "frame",
    "frameset", "button", "input", "select", "textarea", "option",
}


class PreviewError(Exception):
    """A fail-closed refusal with a stable ``code`` from ``_PREVIEW_ERROR_CODES``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class PreviewResult:
    ok: bool
    final_url: str
    status: int
    content_type: str
    sanitized_html: str
    #: Faithful, embeddable rendering of the SAME fetched page: the real HTML with
    #: a first-in-<head> CSP (blocks scripts/plugins/frames) + injected <base> so
    #: its styles/images load directly from the origin. Surfaces that can render
    #: HTML (Web reference viewer) embed this for a styled, desktop-parity view;
    #: ``sanitized_html`` remains the inert text-only fallback. Defaulted so legacy
    #: constructors (tests, older callers) keep working.
    page_html: str = ""
    extracted_links: list[dict[str, str]] = field(default_factory=list)
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------------------- #
# SSRF vetting + pinned-IP transport
# --------------------------------------------------------------------------- #
#: IPv6 prefixes whose low 32 bits ARE an IPv4 the host stack may route to that
#: IPv4 — yet Python's ``is_global`` returns True for them (e.g. ``::127.0.0.1``
#: and NAT64 ``64:ff9b::127.0.0.1``). We down-convert and judge the embedded IPv4.
_IPV4_COMPAT_NET = ipaddress.IPv6Network("::/96")
_NAT64_WK_NET = ipaddress.IPv6Network("64:ff9b::/96")


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """Return the IPv4 an IPv6 address embeds (mapped ``::ffff:``, compatible
    ``::/96``, NAT64 ``64:ff9b::/96``, 6to4, Teredo), else None. Used so an IPv6
    that smuggles a non-global IPv4 is judged by that IPv4, not by Python's
    ``is_global`` (which is True for several of these forms)."""
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip.teredo is not None:
        return ip.teredo[1]
    if ip in _IPV4_COMPAT_NET or ip in _NAT64_WK_NET:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def _ip_is_public(ip_text: str) -> bool:
    """True only for a canonical, globally-routable address. Any IPv6 that embeds
    an IPv4 (mapped/compatible/NAT64/6to4/Teredo) is judged by that embedded IPv4,
    so ``::ffff:127.0.0.1``, ``::127.0.0.1`` and ``64:ff9b::127.0.0.1`` cannot
    smuggle a loopback/private address past the gate."""
    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            return bool(embedded.is_global)
    return bool(ip.is_global)


def _resolve_and_pin(host: str, port: int) -> tuple[int, str]:
    """Resolve ``host`` and require EVERY result to be public; return (family, ip)
    of the first vetted address to pin. Vetting the resolver OUTPUT also defeats
    octal/hex/decimal IP-literal tricks (``0177.0.0.1`` resolves to 127.0.0.1,
    which is then rejected). Any non-public/unresolvable/scoped address -> deny.
    """
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise PreviewError("blocked_dns", "host could not be resolved") from exc
    if not infos:
        raise PreviewError("blocked_dns", "host did not resolve to any address")
    pinned: tuple[int, str] | None = None
    for family, _type, _proto, _canon, sockaddr in infos:
        ip_text = sockaddr[0]
        if "%" in ip_text:  # scoped/zoned IPv6 (e.g. fe80::1%eth0) -> fail closed
            raise PreviewError("blocked_private", "scoped address is not allowed")
        if not _ip_is_public(ip_text):
            raise PreviewError("blocked_private", "host resolves to a non-public address")
        if pinned is None:
            pinned = (family, ip_text)
    assert pinned is not None
    return pinned


class _PinnedBackend(_SyncBackend):
    """Always connect to the single pre-vetted IP, ignoring the host string.

    Each fetch builds a fresh single-use client for ONE vetted origin and never
    follows redirects internally, so every connect on this backend targets that
    origin. Connecting to the fixed vetted IP (rather than matching the host —
    which is fragile across IDNA/Unicode normalisation and would fail OPEN on a
    miss) makes DNS rebinding between check and connect impossible. TLS still
    uses the URL's original hostname for SNI + cert (httpcore's start_tls derives
    server_hostname from the request URL, not from this connect host)."""

    def __init__(self, pinned_ip: str) -> None:
        super().__init__()
        self._pinned_ip = pinned_ip

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):  # type: ignore[override]
        return super().connect_tcp(
            self._pinned_ip, port, timeout=timeout, local_address=local_address, socket_options=socket_options
        )


def _pinned_transport(ip: str) -> httpx.HTTPTransport:
    transport = httpx.HTTPTransport(trust_env=False, retries=0)
    # Replace the connection pool's network backend with our pinned one.
    transport._pool._network_backend = _PinnedBackend(ip)  # noqa: SLF001
    return transport


# --------------------------------------------------------------------------- #
# Optional system-proxy path (docs/reference-viewer-panel.md §10.14)
#
# Under a fake-IP / split-tunnel proxy (Clash/Surge/…), the OS resolver hands out
# non-routable placeholder IPs (e.g. 198.18.0.0/15) for public hostnames, so the
# resolve-and-pin path correctly refuses them as non-global — yet the ONLY way to
# reach the real host is THROUGH the proxy. When a system proxy is configured and
# the caller allows it, we route the fetch through that proxy instead of pinning.
#
# Because the proxy then owns DNS+connect, the resolved-IP SSRF gate cannot run;
# it is replaced by a HOSTNAME-level gate that still refuses obviously-internal
# targets (localhost, link-local/private/loopback IP literals in any classic
# IPv4 form, *.local/.internal). NO_PROXY (localhost/loopback by default) keeps
# those direct rather than proxied, so they never escape this gate.
# --------------------------------------------------------------------------- #
def _proxy_for_host(scheme: str, host: str) -> str | None:
    """Return the configured proxy URL for ``scheme``/``host``, or None.

    Reads env (``HTTPS_PROXY``/``HTTP_PROXY``/``ALL_PROXY``) and — when env is
    empty — the platform system-proxy config, via the stdlib (which also honours
    ``NO_PROXY`` and the macOS/Windows bypass lists through ``proxy_bypass``)."""
    try:
        proxies = urllib.request.getproxies()
    except Exception:  # noqa: BLE001 - any proxy-config read failure -> no proxy
        return None
    proxy = proxies.get(scheme) or proxies.get("all")
    if not proxy:
        return None
    try:
        if urllib.request.proxy_bypass(host):
            return None
    except Exception:  # noqa: BLE001 - bypass check failure -> still use the proxy
        pass
    return proxy if "://" in proxy else f"http://{proxy}"


def _require_host_allowed_for_proxy(url: str) -> None:
    """Hostname-level SSRF gate for the proxy path (raises ``PreviewError``).

    We do NOT resolve here (the proxy does DNS), so an IP literal is the only
    thing we can vet numerically: reject any non-global IPv4 (in decimal, octal,
    hex, or short forms via ``inet_aton``) or IPv6. A plain hostname is allowed
    unless it is a well-known internal name (localhost / *.localhost / *.local /
    *.internal).

    CRITICAL: the gate must judge the EXACT host httpx will connect to, not the
    raw text. httpx IDNA/UTS46-normalizes the host before connecting (e.g. the
    ideographic dot ``。`` -> ``.``, so ``127。0。0。1`` -> ``127.0.0.1`` and
    ``foo。localhost`` -> ``foo.localhost``); checking the raw string would let
    those bypass. We therefore re-derive the host via ``httpx.URL`` — the same
    normalization the outbound request uses — and a host httpx itself rejects
    (e.g. fullwidth digits) is refused here too."""
    try:
        candidate = (httpx.URL(url).host or "").rstrip(".").lower()
    except (httpx.InvalidURL, ValueError, UnicodeError, TypeError) as exc:
        raise PreviewError("blocked_protocol", "malformed host") from exc
    if not candidate:
        raise PreviewError("blocked_protocol", "URL has no host")
    # IPv6 (and canonical IPv4) literal.
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        ip = None
    if ip is not None:
        if not _ip_is_public(str(ip)):
            raise PreviewError("blocked_private", "host is a non-public address")
        return
    # IPv4 in any classic BSD form (octal 0177.., hex 0x7f.., decimal 2130706433,
    # short 127.1) — inet_aton parses these the way a resolver/proxy would, so we
    # must vet them too; a real hostname raises OSError and falls through.
    try:
        packed = socket.inet_aton(candidate)
    except OSError:
        packed = None
    if packed is not None:
        if not ipaddress.IPv4Address(packed).is_global:
            raise PreviewError("blocked_private", "host is a non-public address")
        return
    if candidate in ("localhost", "local", "internal") or candidate.endswith(
        (".localhost", ".local", ".internal")
    ):
        raise PreviewError("blocked_private", "internal hostname is not allowed")


# --------------------------------------------------------------------------- #
# Sanitize + link extraction
# --------------------------------------------------------------------------- #
def safe_external_link(raw: str | None) -> str | None:
    """Return ``raw`` only if it is an absolute http(s) URL with no control chars;
    else None. Used to keep ``javascript:``/``data:`` out of the parent UI."""
    if not raw:
        return None
    candidate = raw.strip()
    if not candidate or any(ord(c) < 0x20 or ord(c) == 0x7f for c in candidate):
        return None
    try:
        parts = urlsplit(candidate)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return None
    return urlunsplit(parts)


class _LinkExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            href = next((v for k, v in attrs if k.lower() == "href"), None)
            self._href = safe_external_link(href)
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href is not None:
            text = "".join(self._text).strip() or self._href
            self.links.append({"text": text[:300], "url": self._href})
            self._href = None
            self._text = []


def _extract_links(html: str, *, limit: int = 200) -> list[dict[str, str]]:
    parser = _LinkExtractor()
    try:
        parser.feed(html)
    except Exception:  # noqa: BLE001 - a malformed page must not crash extraction
        pass
    # de-dup by url, keep order, cap count
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for link in parser.links:
        if link["url"] in seen:
            continue
        seen.add(link["url"])
        out.append(link)
        if len(out) >= limit:
            break
    return out


def sanitize_preview_html(html: str) -> str:
    """Zero-attribute, text-only nh3 clean. No tag in the output can carry a URL
    or style, so the rendered srcdoc makes no network request and runs no script."""
    return nh3.clean(
        html,
        tags=set(_PREVIEW_ALLOWED_TAGS),
        clean_content_tags=set(_PREVIEW_CLEAN_CONTENT_TAGS),
        attributes={},          # zero attributes on every tag
        url_schemes=set(),      # no attribute carries a URL anyway
        strip_comments=True,
        link_rel=None,
    )


# A page-level CSP injected FIRST into the faithful view's <head> (so it governs
# the whole document). Unlike the inert reader's full-deny policy, this
# DELIBERATELY permits passive subresources — the page's own styles, images and
# fonts load (directly from the origin, via the injected <base>) so it renders
# faithfully — while still blocking ALL active content: no scripts, plugins,
# nested frames or workers run, and forms cannot submit. ``base-uri`` is
# deliberately OMITTED (no fallback to default-src) so the injected <base> takes
# effect; ``default-src`` is omitted too so passive fetch directives stay
# unrestricted. Combined with the surface's ``sandbox=""`` iframe (opaque origin,
# no allow-scripts), the embedded page is a passive visual mirror that can neither
# run code nor reach the embedding app's origin.
_PREVIEW_PAGE_CSP = (
    "script-src 'none'; object-src 'none'; frame-src 'none'; "
    "child-src 'none'; worker-src 'none'; form-action 'none'"
)

_HEAD_OPEN_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)
_HTML_OPEN_RE = re.compile(r"<html\b[^>]*>", re.IGNORECASE)


def build_faithful_page(raw_html: str, base_url: str) -> str:
    """Return a standalone document that renders the FETCHED page faithfully.

    Injected as the FIRST children of ``<head>`` (so they govern the whole
    document): a page-level CSP (``_PREVIEW_PAGE_CSP`` — blocks scripts/plugins/
    frames, permits passive styles+images) and ``<base href="{base_url}">`` so the
    page's RELATIVE subresources resolve to the real origin and are loaded DIRECTLY
    by the browser. Those subresource fetches never traverse the kernel, so this
    re-introduces no server-side SSRF surface; the embedding surface frames it with
    ``sandbox=""`` (opaque origin) so its content can read neither the app's origin
    nor (cross-origin) the subresources it triggers.

    ``base_url`` is HTML-attribute-escaped (it is the post-redirect final URL,
    already http(s)+host-validated). The fetched HTML body is otherwise passed
    through verbatim — its own scripts are inert under the CSP+sandbox — so layout
    and styling match what the page ships. The injected ``<base>`` is first, so a
    page that also ships its own ``<base>`` does not override ours (browsers honour
    the first ``<base>``).
    """
    inject = (
        f'<meta http-equiv="Content-Security-Policy" content="{_PREVIEW_PAGE_CSP}">'
        f'<base href="{_html_escape(base_url, quote=True)}">'
    )
    match = _HEAD_OPEN_RE.search(raw_html)
    if match:
        return raw_html[: match.end()] + inject + raw_html[match.end() :]
    match = _HTML_OPEN_RE.search(raw_html)
    if match:
        return raw_html[: match.end()] + "<head>" + inject + "</head>" + raw_html[match.end() :]
    return "<!doctype html><html><head>" + inject + "</head><body>" + raw_html + "</body></html>"


# --------------------------------------------------------------------------- #
# Admission control (docs §10.11/§10.13): cap concurrent fetches globally and
# per target host so a leaked short-TTL ticket cannot be replayed to exhaust the
# proxy. Thread-based (each fetch runs in a worker thread / sync request).
# --------------------------------------------------------------------------- #
_PREVIEW_GLOBAL_CONCURRENCY = 8
_PREVIEW_PER_TARGET_CONCURRENCY = 2
_preview_global_sem = threading.BoundedSemaphore(_PREVIEW_GLOBAL_CONCURRENCY)
_preview_target_lock = threading.Lock()
_preview_target_counts: dict[str, int] = {}


class _PreviewAdmission:
    def __init__(self, target: str) -> None:
        self._target = target

    def __enter__(self) -> "_PreviewAdmission":
        if not _preview_global_sem.acquire(blocking=False):
            raise PreviewError("throttled", "preview proxy is at capacity")
        with _preview_target_lock:
            if _preview_target_counts.get(self._target, 0) >= _PREVIEW_PER_TARGET_CONCURRENCY:
                _preview_global_sem.release()
                raise PreviewError("throttled", "too many concurrent previews for this host")
            _preview_target_counts[self._target] = _preview_target_counts.get(self._target, 0) + 1
        return self

    def __exit__(self, *_exc: Any) -> None:
        with _preview_target_lock:
            remaining = _preview_target_counts.get(self._target, 1) - 1
            if remaining <= 0:
                _preview_target_counts.pop(self._target, None)
            else:
                _preview_target_counts[self._target] = remaining
        _preview_global_sem.release()


def canonical_preview_url(url: str) -> str:
    """Validate (http/https + host) and return the canonical form of ``url``,
    or raise ``PreviewError``. Used to bind a ticket to a normalized URL."""
    return _normalize_url(url)[3]


def _normalize_url(url: str) -> tuple[str, str, int, str]:
    try:
        parts = urlsplit(url.strip())
        host = parts.hostname
        port = parts.port  # may raise ValueError for an out-of-range port
    except ValueError as exc:
        raise PreviewError("blocked_protocol", "malformed URL") from exc
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise PreviewError("blocked_protocol", "only http and https URLs can be previewed")
    if not host:
        raise PreviewError("blocked_protocol", "URL has no host")
    port = port or (443 if scheme == "https" else 80)
    canonical = urlunsplit((scheme, parts.netloc, parts.path or "/", parts.query, ""))
    return scheme, host, port, canonical


def _read_capped_raw(response: httpx.Response, *, max_bytes: int, deadline: float) -> tuple[bytes, bool]:
    """Stream the RAW (undecoded) body up to ``max_bytes``. Compression was
    refused (Accept-Encoding: identity) and rejected on the header, so raw == the
    real content — there is no decompression step, hence no decompression bomb."""
    chunks: list[bytes] = []
    total = 0
    truncated = False
    for chunk in response.iter_raw():
        if time.monotonic() > deadline:
            raise PreviewError("timeout", "preview fetch exceeded its time budget")
        total += len(chunk)
        if total > max_bytes:
            chunks.append(chunk[: max_bytes - (total - len(chunk))])
            truncated = True
            break
        chunks.append(chunk)
    return b"".join(chunks), truncated


#: Bounds the number of OS threads that can be PHYSICALLY stuck on a slow,
#: non-interruptible ``getaddrinfo`` at once. A semaphore (not a ThreadPoolExecutor)
#: is used deliberately: (a) the slot is released by the RESOLVER thread on
#: completion, not by a timed-out caller, so stuck resolvers are truly capped and
#: a saturated resolver fails fast (acquire timeout) instead of piling unbounded
#: queued work items; (b) the resolver runs on a DAEMON thread, so a stuck
#: getaddrinfo can never hang process shutdown (ThreadPoolExecutor's atexit
#: join(wait=True) would). Sized for headroom over natural public-DNS latency.
_PREVIEW_DNS_CONCURRENCY = 32
_dns_semaphore = threading.Semaphore(_PREVIEW_DNS_CONCURRENCY)


def _resolve_with_deadline(host: str, port: int, deadline: float) -> tuple[int, str]:
    """Vet+resolve ``host`` under the remaining wall-clock budget, bounded by the
    global DNS semaphore. Caller never blocks past the deadline; a stuck resolver
    holds its semaphore slot (capping stuck threads) and releases it itself."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise PreviewError("timeout", "preview fetch exceeded its time budget")
    if not _dns_semaphore.acquire(timeout=remaining):
        raise PreviewError("throttled", "the preview resolver is saturated")

    box: dict[str, Any] = {}
    done = threading.Event()

    def _run() -> None:
        try:
            box["ok"] = _resolve_and_pin(host, port)
        except PreviewError as exc:
            box["err"] = exc
        except Exception:  # noqa: BLE001 - any resolver failure -> blocked
            box["err"] = PreviewError("blocked_dns", "host could not be resolved")
        finally:
            _dns_semaphore.release()  # released by THIS thread, never the caller
            done.set()

    try:
        threading.Thread(target=_run, name="preview-dns", daemon=True).start()
    except RuntimeError as exc:
        # OS refused a new thread (pids/ulimit) -> the resolver's finally never
        # runs, so the CALLER must return the slot it just took, or it leaks.
        _dns_semaphore.release()
        raise PreviewError("throttled", "could not start a resolver thread") from exc
    if not done.wait(max(0.0, deadline - time.monotonic())):
        raise PreviewError("timeout", "DNS resolution exceeded the time budget")
    if "err" in box:
        raise box["err"]
    return box["ok"]


def _fetch_one_hop(
    url: str,
    *,
    ip: str | None = None,
    proxy: str | None = None,
    max_bytes: int,
    deadline: float,
) -> dict[str, Any]:
    """One GET under a hard wall-clock deadline. Either pin to a pre-vetted ``ip``
    (default SSRF path) OR route through ``proxy`` (system-proxy path; the proxy
    owns DNS+connect). Returns a dict with kind='redirect'(location) or
    kind='ok'(raw/status/final_url/truncated/ct)."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise PreviewError("timeout", "preview fetch exceeded its time budget")
    # Pre-bind so the finally is safe even if client/transport construction raises
    # (a malformed proxy URL, an exhausted fd table) — no UnboundLocalError, and
    # any partially-built resource is still closed.
    transport: httpx.HTTPTransport | None = None
    client: httpx.Client | None = None
    watchdog: threading.Timer | None = None
    try:
        if proxy is not None:
            client = httpx.Client(
                proxy=proxy,
                timeout=httpx.Timeout(remaining),
                follow_redirects=False,  # manual: re-vet every hop
                trust_env=False,  # the proxy is already resolved; don't re-read env
            )
        else:
            transport = _pinned_transport(str(ip))
            client = httpx.Client(
                transport=transport,
                timeout=httpx.Timeout(remaining),
                follow_redirects=False,  # manual: re-vet every hop
                trust_env=False,
            )
        # Hard wall-clock: a watchdog closes the client at the deadline so a slow
        # header drip (which keeps resetting httpx's per-read timeout) cannot pin a
        # worker past the budget — closing the pool unblocks the blocked read.
        watchdog = threading.Timer(max(0.05, remaining), client.close)
        watchdog.daemon = True
        watchdog.start()
        with client.stream(
            "GET", url, headers={"Accept": "text/html,text/plain", "Accept-Encoding": "identity"}
        ) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise PreviewError("fetch_failed", "redirect without a location")
                return {"kind": "redirect", "location": str(response.url.join(location))}
            encoding = (response.headers.get("content-encoding") or "").strip().lower()
            if encoding and encoding != "identity":
                # server ignored our identity request and compressed anyway
                raise PreviewError("fetch_failed", "server returned a compressed response")
            content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
            if content_type and content_type not in _PREVIEW_TEXT_TYPES:
                raise PreviewError("bad_content_type", f"cannot preview content type {content_type!r}")
            raw, truncated = _read_capped_raw(response, max_bytes=max_bytes, deadline=deadline)
            return {
                "kind": "ok",
                "raw": raw,
                "truncated": truncated,
                "status": response.status_code,
                "final_url": str(response.url),
                "content_type": content_type or "text/plain",
            }
    except PreviewError:
        raise
    except httpx.TimeoutException as exc:
        raise PreviewError("timeout", "preview fetch timed out") from exc
    except (httpx.HTTPError, httpx.InvalidURL, RuntimeError, OSError, ValueError) as exc:
        # httpx.InvalidURL / ValueError also cover a malformed proxy URL at client
        # construction (e.g. a bad system/env proxy value) — with proxy mode
        # default-on, that must fail closed as `fetch_failed`, never a raw 500.
        if time.monotonic() >= deadline:
            raise PreviewError("timeout", "preview fetch exceeded its time budget") from exc
        raise PreviewError("fetch_failed", "preview fetch failed") from exc
    finally:
        if watchdog is not None:
            watchdog.cancel()
        if client is not None:
            client.close()
        if transport is not None:
            transport.close()


def fetch_url_preview(
    url: str,
    *,
    max_bytes: int = PREVIEW_MAX_BYTES,
    timeout: float = PREVIEW_TIMEOUT_S,
    max_redirects: int = PREVIEW_MAX_REDIRECTS,
    allow_proxy: bool = True,
) -> PreviewResult:
    """Fetch + sanitize ``url`` into a PreviewResult, fail-closed on every guard.

    When ``allow_proxy`` is true (default) AND the OS has a proxy configured for
    the target, the hop is routed through that proxy under the hostname-level gate
    (``_require_host_allowed_for_proxy``) — this is what makes preview work behind
    a fake-IP/split-tunnel proxy. Otherwise (no proxy configured, or
    ``allow_proxy`` false) the resolve-and-pin SSRF path is used unchanged. The
    decision is re-evaluated per redirect hop, so each hop is independently vetted.
    """
    deadline = time.monotonic() + timeout
    _scheme, _host, _port, current = _normalize_url(url)

    for _hop in range(max_redirects + 1):
        if time.monotonic() > deadline:
            raise PreviewError("timeout", "preview fetch exceeded its time budget")
        scheme, host, port, current = _normalize_url(current)
        proxy = _proxy_for_host(scheme, host) if allow_proxy else None
        # Vet the host BEFORE taking admission / resolving so a blocked target
        # never consumes a concurrency slot or a resolver thread.
        if proxy is not None:
            # Vet the EXACT host httpx will connect to (post IDNA/UTS46), not the
            # raw text — see _require_host_allowed_for_proxy for the bypass it closes.
            _require_host_allowed_for_proxy(current)
        # Admission is taken BEFORE DNS so a slow/stuck resolver cannot pin a
        # worker outside the concurrency caps; resolution itself is bounded by the
        # remaining wall-clock budget (blocking getaddrinfo has no native timeout).
        with _PreviewAdmission(host):
            if proxy is not None:
                hop = _fetch_one_hop(current, proxy=proxy, max_bytes=max_bytes, deadline=deadline)
            else:
                _family, ip = _resolve_with_deadline(host, port, deadline)
                hop = _fetch_one_hop(current, ip=ip, max_bytes=max_bytes, deadline=deadline)
        if hop["kind"] == "redirect":
            current = hop["location"]
            continue

        # Force UTF-8 (errors='replace') BEFORE parsing — a hostile charset must
        # not desync the parser from the browser.
        text = hop["raw"].decode("utf-8", errors="replace")
        links = _extract_links(text)
        sanitized = sanitize_preview_html(text)
        # Faithful styled view embeds the real HTML (base-rewritten + CSP-locked);
        # sanitized_html stays the inert text-only fallback. Both come from the
        # SAME vetted fetch, so no extra network hop and no new SSRF surface.
        page = build_faithful_page(text, hop["final_url"])
        return PreviewResult(
            ok=True,
            final_url=hop["final_url"],
            status=hop["status"],
            content_type=hop["content_type"],
            sanitized_html=sanitized,
            page_html=page,
            extracted_links=links,
            truncated=hop["truncated"],
        )

    raise PreviewError("blocked_redirect", "too many redirects")


# --------------------------------------------------------------------------- #
# Stateless signed bearer ticket (docs §10.10)
# --------------------------------------------------------------------------- #
def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def sign_preview_ticket(
    url_canonical: str,
    principal: str,
    key: bytes,
    *,
    ttl: int = PREVIEW_TICKET_TTL_S,
    now: float,
    nonce: str,
    kid: str = "v1",
    allow_proxy: bool = True,
) -> str:
    """Sign a short-TTL bearer ticket bound to {url, principal, GET, exp, proxy}.

    ``allow_proxy`` is HMAC-signed into the ticket so the operator's per-request
    choice (Security tab toggle / CLI flag) cannot be tampered with between mint
    and fetch."""
    payload = {
        "aud": "preview",
        "route": "/api/preview",
        "method": "GET",
        "url": url_canonical,
        "principal": principal,
        "iat": int(now),
        "exp": int(now) + int(ttl),
        "kid": kid,
        "nonce": nonce,
        "allow_proxy": bool(allow_proxy),
    }
    body = _b64u(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    sig = _b64u(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_preview_ticket(
    ticket: str,
    key: bytes,
    *,
    now: float,
    expected_principal: str | None = None,
) -> dict[str, Any]:
    """Verify signature + bindings (aud/route/method/exp) + expiry; return claims.

    Pass ``expected_principal`` (the CURRENT control-token generation/fingerprint)
    so a ticket minted under a rotated/earlier operator session is rejected — the
    short-TTL bearer is bound to the session that minted it (docs §10.10)."""
    try:
        body, sig = ticket.split(".", 1)
    except ValueError as exc:
        raise PreviewError("invalid_ticket", "malformed ticket") from exc
    expected = _b64u(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        raise PreviewError("invalid_ticket", "bad ticket signature")
    try:
        payload = json.loads(_b64u_decode(body))
    except (ValueError, json.JSONDecodeError) as exc:
        raise PreviewError("invalid_ticket", "unreadable ticket") from exc
    if (
        payload.get("aud") != "preview"
        or payload.get("method") != "GET"
        or payload.get("route") != "/api/preview"
    ):
        raise PreviewError("invalid_ticket", "wrong ticket binding")
    if not isinstance(payload.get("exp"), int) or payload["exp"] < now:
        raise PreviewError("invalid_ticket", "expired ticket")
    if expected_principal is not None and payload.get("principal") != expected_principal:
        raise PreviewError("invalid_ticket", "ticket principal mismatch")
    return payload
