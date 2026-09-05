"""Live model discovery — the REAL model list per agent runtime.

The runtime-selector contract carries hand-written ``suggested_models`` as a
last-resort hint, but hand-written lists drift from reality (account plans,
relay catalogs, and CLI releases all change what is actually selectable). This
module asks each runtime itself, through whatever channel it natively exposes:

- ``opencode`` / ``cursor`` / ``grok``: their CLIs ship a model-listing command
  (``opencode models`` / ``cursor-agent models`` / ``grok models``).
- ``http``: OpenAI-compatible ``GET <base>/v1/models``.
- ``clawwork``: the relay's super-group packages (套餐: core/plus/max…) via the
  kernel ``relay_packages()``, NOT the relay's raw ``/v1/models`` (a relay-backed
  runtime exposes package tiers, never raw model ids).
- ``anthropic`` / ``anthropic-agent``: ``GET <base>/v1/models`` with the
  configured API key.
- ``gemini``: OpenAI-compatible ``GET <base>/models`` on its configured base.
- ``codex`` / ``codex-app-server``: the app-server protocol's official
  ``model/list`` method (the account's REAL catalog over the
  ChatGPT-subscription credential plane).
- ``claude``: the Anthropic ``/v1/models`` API when a key is configured.
- everything else (hermes, bobo, ...): no headless listing channel — we fall
  back to the static contract hints and say so honestly.

Discovery is fail-soft: a probe error never breaks the selector — the catalog
degrades to the static hints with ``source`` and ``error`` reporting what
happened. Every surface (CLI / API / Web) renders the SAME catalog, including
the honest ``source`` marker, so a static hint is never presented as live.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.error
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from superclaw.environment import anthropic_base_url
from superclaw.runtime_config import applied_runtime_environment
from superclaw.ui_contracts import AGENT_CONTROL_SPECS

# Listing a catalog must feel interactive: probes are capped well below the
# worker-run budgets, tiered by channel cost (Codex/Gemini review).
HTTP_PROBE_TIMEOUT_SECONDS = 4.0
CLI_PROBE_TIMEOUT_SECONDS = 8.0
MAX_MODELS = 200

# Catalog cache (kernel layer, so CLI / shell / API share one semantics).
# Positive hits live for CACHE_TTL; FAILED probes use the short NEGATIVE TTL so
# a user who just fixed a key/relay is not stuck staring at the stale static
# fallback for a whole minute. In-process only: per uvicorn worker, lost on
# restart — acceptable for a local-first tool.
CACHE_TTL_SECONDS = 60.0
NEGATIVE_CACHE_TTL_SECONDS = 10.0

# The cache key carries a credential/config fingerprint so a key/base-url/
# executable change invalidates immediately. The fingerprint is an
# HMAC-SHA256 under a per-process random salt, truncated — it never reaches
# logs or responses and cannot be replayed across processes (Codex review:
# safer than echoing key length/suffix).
_FINGERPRINT_SALT = secrets.token_bytes(16)
_CACHE: dict[str, tuple[float, "ModelCatalog"]] = {}
_CACHE_LOCK = threading.Lock()
_PROBE_LOCKS: dict[str, threading.Lock] = {}

# Env vars whose values shape each backend's catalog (key presence/value,
# base URLs). CLI-channel backends key on the resolved executable instead.
_FINGERPRINT_ENVS: dict[str, tuple[str, ...]] = {
    "clawwork": ("SUPERCLAW_RELAY_BASE_URL", "SUPERCLAW_RELAY_API_KEY"),
    "http": ("SUPERCLAW_HTTP_URL", "SUPERCLAW_HTTP_API_KEY"),
    "claude": ("SUPERCLAW_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "SUPERCLAW_ANTHROPIC_BASE_URL"),
    "anthropic": ("SUPERCLAW_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "SUPERCLAW_ANTHROPIC_BASE_URL"),
    "anthropic-agent": ("SUPERCLAW_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "SUPERCLAW_ANTHROPIC_BASE_URL"),
    "gemini": ("SUPERCLAW_GEMINI_API_KEY", "GEMINI_API_KEY", "SUPERCLAW_GEMINI_BASE_URL"),
}


def _cache_key(backend_name: str, backend: Any) -> str:
    parts: list[str] = [backend_name]
    resolver = getattr(backend, "_resolve_executable", None)
    if callable(resolver):
        try:
            parts.append(str(resolver() or ""))
        except Exception:
            parts.append("")
    for env_name in _FINGERPRINT_ENVS.get(backend_name, ()):
        parts.append(f"{env_name}={os.environ.get(env_name, '')}")
    if backend_name == "clawwork":
        # The probe rides the kernel resolver chain (manual env > cached key),
        # so the fingerprint must too: a rotate/ensure/clear of the cached key
        # in a long-lived process (API/shell) has to invalidate the catalog
        # cache immediately, not after the TTL.
        from superclaw.relay_key import resolve_relay_api_key

        try:
            resolved_key, source = resolve_relay_api_key()
        except Exception:
            resolved_key, source = None, "error"
        parts.append(f"relay_key[{source}]={resolved_key or ''}")
        # The clawwork catalog is now the relay PACKAGE list, whose availability also
        # flips on a bare ClawHunt login (access_token, no cached key yet). Fold the
        # token's presence (not its value) into the fingerprint so logging in/out
        # invalidates the cached package list immediately, not after the TTL.
        from superclaw.clawhunt_auth import saved_clawhunt_access_token

        try:
            parts.append(f"clawhunt_login={'1' if saved_clawhunt_access_token() else '0'}")
        except Exception:
            parts.append("clawhunt_login=err")
    digest = hmac.new(_FINGERPRINT_SALT, "\x1f".join(parts).encode("utf-8"), hashlib.sha256)
    return f"{backend_name}:{digest.hexdigest()[:24]}"


def _classify_probe_error(exc: Exception) -> str:
    """Prefix the failure so surfaces can route the user (Gemini review):
    auth: fix your key/login; network: endpoint unreachable; probe: other."""
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (401, 403):
            return f"auth: HTTP {exc.code}: {exc.reason}"
        return f"probe: HTTP {exc.code}: {exc.reason}"
    # httpx 网络/超时异常也归 network（_http_get_json 已迁到 httpx，顾问第三轮：否则
    # ConnectError/ReadTimeout 会落默认分支被误标为 probe:）。延迟 import 避免顶层硬依赖。
    import httpx

    if isinstance(exc, (httpx.TransportError, httpx.TimeoutException)):
        return f"network: {type(exc).__name__}: {exc}"
    if isinstance(exc, (urllib.error.URLError, TimeoutError, subprocess.TimeoutExpired)):
        return f"network: {type(exc).__name__}: {exc}"
    text = str(exc)
    lowered = text.lower()
    if "not logged in" in lowered or "api key" in lowered or "unauthorized" in lowered:
        return f"auth: {type(exc).__name__}: {text}"
    return f"probe: {type(exc).__name__}: {text}"


@dataclass(frozen=True)
class ModelCatalog:
    """The model list for one backend, with an honest provenance marker."""

    backend: str
    models: list[str] = field(default_factory=list)
    default_model: str | None = None
    # "live"        — fetched from the runtime itself just now
    # "static"      — the hand-written contract hint (no live channel, or the
    #                 live probe failed; see ``error``)
    # "unavailable" — backend has neither a live channel nor static hints
    source: str = "static"
    error: str | None = None
    # True when this catalog was served from the kernel TTL cache (the probe ran
    # up to ``age_seconds`` ago). force_refresh / ?refresh=1 bypasses it.
    cached: bool = False
    age_seconds: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "models": list(self.models),
            "default_model": self.default_model,
            "source": self.source,
            "error": self.error,
            "cached": self.cached,
            "age_seconds": round(self.age_seconds, 1),
        }


def _run_cli(command: list[str]) -> str:
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=CLI_PROBE_TIMEOUT_SECONDS,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()
        raise RuntimeError(f"{command[0]} exited {completed.returncode}: {detail[0] if detail else 'no output'}")
    return completed.stdout or ""


def _http_get_json(url: str, headers: Mapping[str, str] | None = None, *, transport: Any = None) -> Any:
    # follow_redirects=False + trust_env=False：探测请求可能带 Authorization: Bearer
    # <relay key>，绝不跟随 30x 把 key 转发到重定向的（未校验）目的地，也不吃系统代理
    # （防重定向 / MITM 截获 key，顾问统一收口阻断项）。非 200（含 30x）按 HTTPError 走
    # 既有 _classify_probe_error 分类（401/403→auth，其余→probe）。transport 注入口供测试。
    import httpx

    with httpx.Client(
        timeout=HTTP_PROBE_TIMEOUT_SECONDS, follow_redirects=False, trust_env=False, transport=transport
    ) as client:
        resp = client.get(url, headers=dict(headers or {}))
    if resp.status_code != 200:
        raise urllib.error.HTTPError(url, resp.status_code, resp.reason_phrase or "", None, None)
    return resp.json()


def _openai_models(base_url: str, *, api_key: str | None = None) -> list[str]:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    payload = _http_get_json(f"{base_url.rstrip('/')}/models", headers)
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise RuntimeError("models response carried no data list")
    return [str(item["id"]) for item in data if isinstance(item, dict) and item.get("id")]


def _resolve_cli_executable(backend: Any, fallback: str) -> str:
    resolver = getattr(backend, "_resolve_executable", None)
    executable = resolver() if callable(resolver) else None
    if isinstance(executable, tuple):  # codex returns (path, source)
        executable = executable[0]
    if not executable:
        raise RuntimeError(f"{fallback} executable not found")
    return str(executable)


# --- per-backend probers ------------------------------------------------------

def _probe_opencode(backend: Any) -> list[str]:
    output = _run_cli([_resolve_cli_executable(backend, "opencode"), "models"])
    return [line.strip() for line in output.splitlines() if line.strip() and "/" in line]


def _probe_cursor(backend: Any) -> list[str]:
    output = _run_cli([_resolve_cli_executable(backend, "cursor-agent"), "models"])
    models = [line.strip() for line in output.splitlines() if line.strip() and not line.lower().startswith("no models")]
    return models


_GROK_MODEL_LINE = re.compile(r"^\s*[-*]\s+(\S+)")


def _probe_grok(backend: Any) -> list[str]:
    output = _run_cli([_resolve_cli_executable(backend, "grok"), "models"])
    models: list[str] = []
    for line in output.splitlines():
        match = _GROK_MODEL_LINE.match(line)
        if match:
            models.append(match.group(1))
    return models


def _probe_clawwork(backend: Any) -> list[str]:
    del backend
    # ClawWork 是 relay-backed runtime：它的"可选项"是 super 分组的套餐（core/plus/max…），
    # 不是 relay 背后的裸模型 id。所有通用模型通道（CLI `models clawwork`、shell
    # `/models`、API `/api/agents/clawwork/models`）经此一律返回套餐 id，绝不再打
    # `/v1/models` 暴露裸模型——与 `/api/relay/packages`、CLI `relay packages` 同一内核
    # 事实源 relay_packages()（单一事实源 / 表层零偏差，顾问对抗项 #7）。relay_packages
    # 自身 fail-safe（catalog → groups → 默认 floor），故此处恒返回非空套餐列表。
    from superclaw.relay_packages import relay_packages

    payload = relay_packages()
    return [str(p["id"]) for p in payload.get("packages", []) if p.get("id")]


def _probe_http(backend: Any) -> list[str]:
    del backend
    base_url = os.environ.get("SUPERCLAW_HTTP_URL", "").strip()
    if not base_url:
        raise RuntimeError("SUPERCLAW_HTTP_URL not set")
    # SUPERCLAW_HTTP_URL points at the chat endpoint; the catalog lives at the
    # sibling /models route of the same /v1 root.
    root = re.sub(r"/(chat/completions|completions|responses)/?$", "", base_url.rstrip("/"))
    return _openai_models(root, api_key=os.environ.get("SUPERCLAW_HTTP_API_KEY") or None)


def _probe_gemini(backend: Any) -> list[str]:
    base_url = getattr(backend, "base_url", "").rstrip("/")
    if not base_url:
        raise RuntimeError("gemini base_url not configured")
    key = backend._resolve_api_key() if hasattr(backend, "_resolve_api_key") else None
    if not key:
        raise RuntimeError("gemini API key not set")
    return _openai_models(base_url, api_key=key)


def _probe_anthropic(backend: Any) -> list[str]:
    base_url = getattr(backend, "base_url", "").rstrip("/")
    if not base_url:
        raise RuntimeError("anthropic base_url not configured")
    key = backend._resolve_api_key() if hasattr(backend, "_resolve_api_key") else None
    if not key:
        raise RuntimeError("anthropic API key not set")
    payload = _http_get_json(
        f"{base_url}/v1/models",
        {"x-api-key": key, "anthropic-version": getattr(backend, "ANTHROPIC_VERSION", "2023-06-01")},
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise RuntimeError("models response carried no data list")
    return [str(item["id"]) for item in data if isinstance(item, dict) and item.get("id")]


def _probe_claude(backend: Any) -> list[str]:
    """Claude Code has no headless model-listing command; the Anthropic
    /v1/models API serves the same model-id family, so an available API key
    gives a LIVE catalog. Without a key we fall back to the static hints
    (honestly marked static)."""
    key = (os.environ.get("SUPERCLAW_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not key:
        raise RuntimeError(
            "claude CLI exposes no model-listing command; set SUPERCLAW_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) "
            "to list models live from the Anthropic API"
        )
    base_url = getattr(backend, "base_url", "").strip() or anthropic_base_url()
    payload = _http_get_json(
        f"{base_url.rstrip('/')}/v1/models?limit=100",
        {"x-api-key": key, "anthropic-version": "2023-06-01"},
    )
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise RuntimeError("models response carried no data list")
    return [str(item["id"]) for item in data if isinstance(item, dict) and item.get("id")]


def _probe_codex(backend: Any) -> list[str]:
    """Codex's app-server protocol ships an official ``model/list`` method that
    returns the ACCOUNT's real catalog over the ChatGPT-subscription credential
    plane — the semantically correct channel (unlike an OPENAI_API_KEY catalog,
    which lives on the separate Platform billing plane and can diverge)."""
    executable = _resolve_cli_executable(backend, "codex")
    proc = subprocess.Popen(
        [executable, "app-server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )

    def _send(obj: dict[str, Any]) -> None:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    try:
        _send({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "superclaw-model-discovery", "title": "SuperClaw", "version": "0.1.0"}},
        })
        deadline = time.monotonic() + CLI_PROBE_TIMEOUT_SECONDS
        models: list[str] = []
        while time.monotonic() < deadline:
            assert proc.stdout is not None
            line = proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("id") == 1:
                _send({"jsonrpc": "2.0", "id": 2, "method": "model/list", "params": {}})
            elif msg.get("id") == 2:
                if "error" in msg:
                    raise RuntimeError(f"model/list error: {msg['error'].get('message', 'unknown')}")
                data = (msg.get("result") or {}).get("data") or []
                for item in data:
                    if isinstance(item, dict) and item.get("id") and not item.get("hidden"):
                        models.append(str(item["id"]))
                return models
        raise RuntimeError("codex app-server model/list timed out")
    finally:
        proc.kill()


_PROBERS: dict[str, Callable[[Any], list[str]]] = {
    "claude": _probe_claude,
    "codex": _probe_codex,
    "codex-app-server": _probe_codex,
    "opencode": _probe_opencode,
    "cursor": _probe_cursor,
    "grok": _probe_grok,
    "clawwork": _probe_clawwork,
    "http": _probe_http,
    "gemini": _probe_gemini,
    "anthropic": _probe_anthropic,
    "anthropic-agent": _probe_anthropic,
}


def live_capable_backends() -> set[str]:
    """Backends with a real (non-static) discovery channel."""
    return set(_PROBERS)


# Product curation: model ids withheld from a backend's SELECTABLE catalog,
# applied to the LIVE probe result. The Anthropic /v1/models probe
# (_probe_claude / _probe_anthropic) returns the account's RAW catalog, which can
# still carry a model the owner has chosen not to offer for these Claude agent
# runtimes; this denylist re-applies the same curation the hand-written
# ``suggested_models`` already encodes, so the model never reaches a selector via
# the live path either (Codex/Gemini review: a static-only removal still leaked
# the model to every key-configured user through the live catalog). This governs
# what the catalog OFFERS, not what the kernel ACCEPTS — free-form model entry
# stays physically possible on every surface; the run lane is untouched.
_CURATED_MODEL_DENYLIST: dict[str, frozenset[str]] = {
    "claude": frozenset({"claude-fable-5"}),
    "anthropic": frozenset({"claude-fable-5"}),
    "anthropic-agent": frozenset({"claude-fable-5"}),
}


def _curate(backend_name: str, models: list[str]) -> list[str]:
    """Drop denylisted model ids from a backend's catalog (order-preserving)."""
    denied = _CURATED_MODEL_DENYLIST.get(backend_name)
    if not denied:
        return models
    return [model for model in models if model not in denied]


def _static_catalog(backend_name: str, *, error: str | None = None) -> ModelCatalog:
    spec = AGENT_CONTROL_SPECS.get(backend_name, {})
    models = [str(m) for m in (spec.get("suggested_models") or [])]
    default_model = spec.get("default_model")
    if not models and not default_model:
        return ModelCatalog(backend=backend_name, source="unavailable", error=error)
    return ModelCatalog(
        backend=backend_name,
        models=models,
        default_model=str(default_model) if default_model else None,
        source="static",
        error=error,
    )


def _probe_catalog(backend_name: str, backend: Any) -> ModelCatalog:
    """Run the live probe for one backend (no cache). Never raises."""
    prober = _PROBERS[backend_name]
    try:
        with applied_runtime_environment():
            models = prober(backend)
    except Exception as exc:  # fail-soft: never break the selector
        return _static_catalog(backend_name, error=_classify_probe_error(exc))
    deduped = list(dict.fromkeys(model.strip() for model in models if model and model.strip()))
    # Curation is applied to the LIVE result too: a key-configured user must not
    # see a denylisted model the static hint already drops (single curation, both
    # catalog sources). Drop before the MAX_MODELS slice so denied ids never cost
    # a slot.
    deduped = _curate(backend_name, deduped)[:MAX_MODELS]
    if not deduped:
        return _static_catalog(backend_name, error="probe: live probe returned no models")
    spec = AGENT_CONTROL_SPECS.get(backend_name, {})
    default_model = spec.get("default_model")
    return ModelCatalog(
        backend=backend_name,
        models=deduped,
        default_model=str(default_model) if default_model else None,
        source="live",
    )


def clear_catalog_cache() -> None:
    """Drop every cached catalog (tests / explicit reset)."""
    with _CACHE_LOCK:
        _CACHE.clear()


def discover_models(
    backend_name: str,
    *,
    backends: Mapping[str, Any] | None = None,
    force_refresh: bool = False,
) -> ModelCatalog:
    """Return the model catalog for one backend, live when possible.

    Never raises: a probe failure degrades to the static contract hints with
    ``source="static"`` and the failure classified in ``error`` (auth: /
    network: / probe:) — surfaces must show the marker rather than passing a
    stale list off as live.

    Results are cached in-process under a credential/config fingerprint key:
    successful probes for CACHE_TTL_SECONDS, failed ones for the short
    NEGATIVE_CACHE_TTL_SECONDS (so a freshly fixed key shows up fast). A
    per-key lock collapses concurrent probes for the same backend into one.
    ``force_refresh`` bypasses the cache (API ``?refresh=1`` / CLI
    ``--refresh``).
    """
    prober = _PROBERS.get(backend_name)
    if prober is None:
        return _static_catalog(backend_name)
    if backends is None:
        from superclaw.backends import default_backends

        backends = default_backends()
    backend = backends.get(backend_name)
    if backend is None:
        return _static_catalog(backend_name, error=f"unknown backend: {backend_name}")

    key = _cache_key(backend_name, backend)
    now = time.monotonic()
    if not force_refresh:
        with _CACHE_LOCK:
            hit = _CACHE.get(key)
        if hit is not None:
            probed_at, catalog = hit
            ttl = CACHE_TTL_SECONDS if catalog.source == "live" else NEGATIVE_CACHE_TTL_SECONDS
            age = now - probed_at
            if age < ttl:
                return ModelCatalog(
                    backend=catalog.backend,
                    models=list(catalog.models),
                    default_model=catalog.default_model,
                    source=catalog.source,
                    error=catalog.error,
                    cached=True,
                    age_seconds=age,
                )

    with _CACHE_LOCK:
        probe_lock = _PROBE_LOCKS.setdefault(key, threading.Lock())
    with probe_lock:
        # Re-check after acquiring: a concurrent caller may have just probed.
        if not force_refresh:
            with _CACHE_LOCK:
                hit = _CACHE.get(key)
            if hit is not None:
                probed_at, catalog = hit
                ttl = CACHE_TTL_SECONDS if catalog.source == "live" else NEGATIVE_CACHE_TTL_SECONDS
                age = time.monotonic() - probed_at
                if age < ttl:
                    return ModelCatalog(
                        backend=catalog.backend,
                        models=list(catalog.models),
                        default_model=catalog.default_model,
                        source=catalog.source,
                        error=catalog.error,
                        cached=True,
                        age_seconds=age,
                    )
        catalog = _probe_catalog(backend_name, backend)
        with _CACHE_LOCK:
            _CACHE[key] = (time.monotonic(), catalog)
        return catalog
