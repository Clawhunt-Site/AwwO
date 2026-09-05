"""Read/uninstall the capabilities the co-launched Node S4 super-workshop has LANDED.

The install bridge (``capability_workshop_install_bridge``) lands a downloaded capability in
Node's ``super_plugin_runtimes`` + ``workshop_provenance``. This module is its read/uninstall
counterpart: a neutral, loopback-only view of what Node has installed, so the front door can
present a single "installed capabilities" surface that unions the legacy Python plugin cache
with the Node store (the BFF the CLI/API/Web all consume).

Loopback discipline mirrors the bridge: ``resolve_node_base_url`` enforces a loopback target,
``trust_env=False`` / ``follow_redirects=False`` so no ambient proxy or redirect can reach a
non-local host. Node's board-org gate is satisfied by the ``local_trusted`` deployment's
``local_implicit`` board principal (the coexistence/desktop target); in ``authenticated`` mode
the loopback read is unauthenticated and Node returns non-2xx — we treat that as "degraded /
node unavailable" (empty), never as a hard error and never as a silent "nothing installed".
"""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any

import httpx

from superclaw.company_portability_loopback import (
    CompanyExportLoopbackError,
    resolve_node_base_url,
)

logger = logging.getLogger("superclaw.workshop.installed")

DEFAULT_TIMEOUT_SECONDS = 15.0

# SCOPE: this read currently covers workshop-installed PLUGINS — the only kind the Node
# ``/api/super-plugins`` runtime catalog exposes (filtered to official=workshop-cosigned).
# Workshop-installed skills (global skill store) and companies (companies store) live in other
# Node stores with no list endpoint over workshop_provenance yet; surfacing them in this neutral
# read is a follow-up (would need a Node `GET` over workshop_provenance across kinds).


class WorkshopInstalledReadError(RuntimeError):
    """A Node-installed read/uninstall could not be completed (fail-closed)."""


def _normalize_entry(raw: Any) -> dict[str, Any] | None:
    """Map one Node ``/api/super-plugins`` entry to the neutral installed shape, or None to DROP.

    ``/api/super-plugins`` is Node's UNIFIED plugin runtime catalog (``kind: "paperclip_js" |
    "super"``) — it lists native JS plugins too, not just workshop installs, and its
    ``DELETE /api/super-plugins/:pluginKey`` only removes SUPER plugins (a JS plugin 404s). So we
    include ONLY entries that are BOTH ``official === true`` (workshop-provenance-cosigned) AND
    ``kind === "super"`` — ``official`` alone is insufficient because a native ``paperclip_js``
    plugin can carry STALE official provenance. The super gate makes the listed set exactly the
    set ``DELETE`` can remove, so ``uninstallable: true`` is honest. We surface the capability
    ``kind: "plugin"`` (a super plugin IS a plugin capability). (Workshop-installed skills/
    companies live in other Node stores and are a separate read — see the module docstring.)
    """
    if not isinstance(raw, dict):
        return None
    # Require BOTH official (workshop-cosigned provenance) AND super-format. `official` alone is
    # NOT sufficient: a native `paperclip_js` plugin can carry STALE official provenance, but
    # DELETE /api/super-plugins/:pluginKey only removes SUPER plugins (a JS plugin 404s) — so
    # listing a JS plugin as uninstallable would be a lie. The super gate makes uninstallable true.
    if raw.get("official") is not True or raw.get("kind") != "super":
        return None
    native_key = raw.get("pluginKey")
    if not isinstance(native_key, str) or not native_key:
        return None
    version = raw.get("version")
    return {
        "origin": "node-workshop",
        # A workshop-installed super plugin IS a plugin capability (the raw runtime kind is
        # "super"/"paperclip_js", not the capability kind).
        "kind": "plugin",
        # No provenance capability_id is exposed by the Node read; native_key is the stable id.
        "capability_id": native_key,
        "native_key": native_key,
        "version": version if isinstance(version, str) else None,
        "name": raw.get("name") if isinstance(raw.get("name"), str) else native_key,
        "official": True,
        # Node-landed capabilities have no Python-cache configuration surface.
        "configurable": False,
        # official ⟹ super-format ⟹ removable via DELETE /api/super-plugins/:pluginKey.
        "uninstallable": True,
    }


def list_installed_node_capabilities(
    *,
    node_base_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> tuple[list[dict[str, Any]], bool]:
    """Return ``(capabilities, node_available)``.

    ``node_available`` is False (and the list empty) when Node was never co-launched OR the
    loopback read fails/returns non-2xx — a DEGRADED signal the surface must show, never a
    silent "nothing installed". Raises nothing for the normal degraded path; only a programming
    error would surface.
    """
    try:
        base_url = resolve_node_base_url(node_base_url)
    except CompanyExportLoopbackError as exc:
        # A misconfigured non-loopback target — fail closed to degraded, never call out.
        logger.warning("node installed read: base url rejected: %s", exc)
        return [], False
    if not base_url:
        return [], False  # no co-launched Node (plain-Python deployment)
    url = f"{base_url}/api/super-plugins"
    try:
        resp = httpx.get(url, timeout=timeout, trust_env=False, follow_redirects=False)
    except httpx.HTTPError as exc:
        logger.warning("node installed read: loopback GET failed: %s", exc)
        return [], False
    if resp.status_code != 200:
        # 401/403 in authenticated mode, or a transient Node error: degraded, not a hard fail.
        logger.warning("node installed read: HTTP %s", resp.status_code)
        return [], False
    try:
        payload = resp.json()
    except ValueError as exc:
        logger.warning("node installed read: non-JSON body: %s", exc)
        return [], False
    if not isinstance(payload, list):
        logger.warning("node installed read: expected a list, got %s", type(payload).__name__)
        return [], False
    capabilities = [entry for entry in (_normalize_entry(item) for item in payload) if entry is not None]
    return capabilities, True


def uninstall_node_capability(
    native_key: str,
    *,
    node_base_url: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Uninstall a Node-landed capability by its ``native_key`` (Node ``pluginKey``) via the
    loopback ``DELETE /api/super-plugins/:pluginKey``. Raises ``WorkshopInstalledReadError``
    fail-closed on no co-launched Node / non-2xx (so the surface never reports a false success)."""
    if not isinstance(native_key, str) or not native_key.strip():
        raise WorkshopInstalledReadError("native_key is required to uninstall a node capability")
    try:
        base_url = resolve_node_base_url(node_base_url)
    except CompanyExportLoopbackError as exc:
        raise WorkshopInstalledReadError(f"node base url rejected: {exc}") from exc
    if not base_url:
        raise WorkshopInstalledReadError("no co-launched Node to uninstall from")
    # Percent-encode the key so it can't inject a different route segment.
    url = f"{base_url}/api/super-plugins/{urllib.parse.quote(native_key, safe='')}"
    try:
        resp = httpx.request("DELETE", url, timeout=timeout, trust_env=False, follow_redirects=False)
    except httpx.HTTPError as exc:
        raise WorkshopInstalledReadError(f"node uninstall loopback failed: {exc}") from exc
    if resp.status_code not in (200, 204):
        raise WorkshopInstalledReadError(f"node uninstall returned HTTP {resp.status_code}")
    return {"ok": True, "origin": "node-workshop", "native_key": native_key}
