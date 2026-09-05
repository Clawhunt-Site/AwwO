"""Loopback bridge to the co-launched Node (Paperclip) server for the company-upload
chain (capability workshop, slice 2).

A company is a live Paperclip-DB entity; the only way to obtain a *portability* bundle
(the COMPANY.md format the workshop import side consumes) is Paperclip's own
``exportBundle``. This module lets the Python developer-submission CLI:

* ``export_company_portability`` — POST ``/api/companies/{id}/export`` to snapshot a live
  company into a portability bundle, then
* ``freeze_export_to_dir`` — write that snapshot to an immutable on-disk artifact (so the
  review/digest binds frozen bytes, not a live DB that could still mutate — Codex's TOCTOU
  note), and
* ``make_preview_fn`` — a ``preview_fn`` for ``review_company_portability_bundle`` backed
  by POST ``/api/companies/import/preview`` (Node is the single source of truth for
  importability).

Transport posture: loopback only, ``trust_env=False`` + ``follow_redirects=False`` so no
ambient proxy / redirect can intercept a local request carrying company bytes (mirrors the
project's other outbound-HTTP guards). In a ``local_trusted`` deployment the co-launched
Node authorises a loopback caller as the local board, so no token is needed; loopback is a
transport constraint, not the trust boundary (the receipt/digest are, downstream).

Every transport/HTTP/JSON failure in the preview path is wrapped as
``CompanyPortabilityPreviewError`` so the review gate fails closed instead of bubbling a
500 (per the Codex slice-1 review).
"""

from __future__ import annotations

import base64
import ipaddress
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from superclaw.company_portability_review import CompanyPortabilityPreviewError, PreviewFn
from superclaw.environment import superclaw_data_path
from superclaw.node_runtime import read_node_base_url

DEFAULT_TIMEOUT_SECONDS = 60.0
NODE_BASE_URL_ENV = "SUPERCLAW_NODE_BASE_URL"
_LOOPBACK_HOSTNAMES = {"localhost"}


class CompanyExportLoopbackError(RuntimeError):
    """The live-company export over the Node loopback failed (no server / non-200 / non-JSON /
    a non-loopback target)."""


def _is_loopback_url(url: str) -> bool:
    """True only for an http(s) URL whose host is a loopback address/name. Company bytes must
    never leave the machine — a remote target is rejected BEFORE any request is sent."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    host = parsed.hostname
    if host in _LOOPBACK_HOSTNAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _assert_loopback(base_url: str) -> str:
    if not _is_loopback_url(base_url):
        raise CompanyExportLoopbackError(
            f"refusing a non-loopback Node base URL (company bytes must stay local): {base_url!r}"
        )
    return base_url


def resolve_node_base_url(explicit: str | None = None) -> str | None:
    """Resolve the co-launched Node server's base URL: explicit arg → env override → the
    on-disk run-dir marker (the actual bound port). ``None`` when Node was never
    co-launched (a plain-Python deployment) — the caller fails closed with a clear error.

    A configured (explicit/env) target that is NOT loopback is rejected outright, so a
    misconfigured ``SUPERCLAW_NODE_BASE_URL=https://prod`` can never receive company bytes.
    """
    if explicit and explicit.strip():
        return _assert_loopback(explicit.strip().rstrip("/"))
    env = (os.environ.get(NODE_BASE_URL_ENV) or "").strip()
    if env:
        return _assert_loopback(env.rstrip("/"))
    marker = read_node_base_url(superclaw_data_path("run"))
    if not marker:
        return None
    return _assert_loopback(marker.rstrip("/"))


def _client(base_url: str, timeout: float) -> httpx.Client:
    # Defence in depth: enforce loopback again at the transport, plus trust_env=False /
    # follow_redirects=False so no ambient proxy or redirect can exfiltrate the request.
    _assert_loopback(base_url)
    return httpx.Client(base_url=base_url, timeout=timeout, trust_env=False, follow_redirects=False)


def export_company_portability(
    company_id: str,
    *,
    base_url: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    include: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Snapshot a live company into a CompanyPortability export result (``files`` +
    ``manifest`` + ``warnings``). Raises ``CompanyExportLoopbackError`` on any failure."""
    if not company_id or company_id.strip() != company_id or "/" in company_id or "\x00" in company_id:
        raise CompanyExportLoopbackError(f"invalid company id: {company_id!r}")
    body: dict[str, Any] = {"include": include} if include else {}
    try:
        with _client(base_url, timeout) as client:
            resp = client.post(f"/api/companies/{quote(company_id, safe='')}/export", json=body)
    except httpx.HTTPError as exc:
        raise CompanyExportLoopbackError(f"company export loopback failed: {exc}") from exc
    if resp.status_code != 200:
        raise CompanyExportLoopbackError(
            f"company export returned HTTP {resp.status_code}: {resp.text[:500]}"
        )
    try:
        result = resp.json()
    except json.JSONDecodeError as exc:
        raise CompanyExportLoopbackError(f"company export returned non-JSON: {exc}") from exc
    if not isinstance(result, dict):
        raise CompanyExportLoopbackError("company export returned a non-object body")
    return result


def _safe_join(root: Path, rel: str) -> Path:
    """Resolve ``rel`` under ``root``, rejecting absolute paths, backslashes, and any
    ``""``/``.``/``..`` segment (a normalised ``a/../x`` is rejected, not silently
    collapsed — so freeze/review/import all see the same canonical path)."""
    if not rel or rel.strip() != rel or "\x00" in rel or "\\" in rel or rel.startswith("/"):
        raise CompanyExportLoopbackError(f"unsafe path in export: {rel!r}")
    if any(segment in ("", ".", "..") for segment in rel.split("/")):
        raise CompanyExportLoopbackError(f"unsafe path segment in export: {rel!r}")
    candidate = (root / rel).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and not str(candidate).startswith(str(root_resolved) + os.sep):
        raise CompanyExportLoopbackError(f"path escapes bundle root: {rel!r}")
    return candidate


def freeze_export_to_dir(export_result: dict[str, Any], dest: Path) -> Path:
    """Write the export's ``files`` map verbatim into ``dest`` — the frozen artifact the
    review/digest binds. The ``manifest`` (carries ``generatedAt``) and ``warnings``
    envelope are intentionally NOT written into the bundle.

    Bounded: the file count and cumulative bytes are capped (same limits as the review
    gate) so an over-large export cannot fill the disk/temp before review rejects it.
    ``dest`` must be empty or absent so stale files cannot leak into the frozen artifact.
    """
    # Import here to avoid a hard module-load coupling and to share the single source of limits.
    from superclaw.company_portability_review import MAX_PORTABILITY_BYTES, MAX_PORTABILITY_FILES

    files = export_result.get("files")
    if not isinstance(files, dict) or not files:
        raise CompanyExportLoopbackError("company export contained no files")
    if len(files) > MAX_PORTABILITY_FILES:
        raise CompanyExportLoopbackError(f"export has too many files: {len(files)} > {MAX_PORTABILITY_FILES}")
    dest = Path(dest)
    if dest.is_symlink():
        raise CompanyExportLoopbackError(f"freeze destination must not be a symlink: {dest}")
    if dest.exists() and not dest.is_dir():
        raise CompanyExportLoopbackError(f"freeze destination exists and is not a directory: {dest}")
    if dest.exists() and any(dest.iterdir()):
        raise CompanyExportLoopbackError(f"freeze destination must be empty: {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    written = 0
    for rel, entry in files.items():
        if not isinstance(rel, str):
            raise CompanyExportLoopbackError(f"non-string file key in export: {rel!r}")
        target = _safe_join(dest, rel)
        if isinstance(entry, str):
            payload = entry.encode("utf-8")
        elif isinstance(entry, dict) and entry.get("encoding") == "base64" and isinstance(entry.get("data"), str):
            try:
                # binascii.Error (raised on invalid base64) subclasses ValueError.
                payload = base64.b64decode(entry["data"], validate=True)
            except ValueError as exc:
                raise CompanyExportLoopbackError(f"invalid base64 for {rel!r}: {exc}") from exc
        else:
            raise CompanyExportLoopbackError(f"unsupported file entry for {rel!r}")
        written += len(payload)
        if written > MAX_PORTABILITY_BYTES:
            raise CompanyExportLoopbackError(f"export exceeds {MAX_PORTABILITY_BYTES} bytes")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    return dest


def make_preview_fn(base_url: str, *, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> PreviewFn:
    """Build a ``preview_fn`` for ``review_company_portability_bundle`` backed by Node
    ``POST /api/companies/import/preview``. ALL transport/HTTP/JSON failures are wrapped as
    ``CompanyPortabilityPreviewError`` so the review gate fails closed (never a bare 500)."""

    def _preview(request: dict[str, Any]) -> dict[str, Any]:
        try:
            with _client(base_url, timeout) as client:
                resp = client.post("/api/companies/import/preview", json=request)
        except CompanyExportLoopbackError as exc:
            # A non-loopback target reaching the transport — surface as a preview failure so
            # the review gate fails closed (it expects CompanyPortabilityPreviewError).
            raise CompanyPortabilityPreviewError(str(exc)) from exc
        except httpx.HTTPError as exc:
            raise CompanyPortabilityPreviewError(f"preview loopback failed: {exc}") from exc
        if resp.status_code in (400, 422):
            # 400 (malformed request) and 422 (Node's `unprocessable` — a bad/invalid bundle)
            # are clean BUSINESS rejections, not infrastructure failures. Surface Node's reason
            # as a preview *error* so the review gate fails with the real cause (and metrics
            # don't read it as an outage). 401/403/5xx fall through to raise (infra/access).
            try:
                body = resp.json()
            except (json.JSONDecodeError, ValueError):
                body = {}
            reason = (isinstance(body, dict) and (body.get("error") or body.get("message"))) or resp.text[:300]
            return {"errors": [str(reason) or f"preview rejected (HTTP {resp.status_code})"], "warnings": [], "plan": {}}
        if resp.status_code != 200:
            raise CompanyPortabilityPreviewError(
                f"preview returned HTTP {resp.status_code}: {resp.text[:300]}"
            )
        try:
            return resp.json()
        except json.JSONDecodeError as exc:
            raise CompanyPortabilityPreviewError(f"preview returned non-JSON: {exc}") from exc

    return _preview
