"""Digest-bound install-entry provenance for cached plugin packages (PR-1, §3.7).

The owner's trust model grades an equippable artifact by **provenance** — where
the package came from — not by whether it was signed. A ``skill_origin`` package
installed through a *local* entry (install-local / ``skill import`` /
``skill build``) is the user's own responsibility and is equippable sign-free; a
package that arrives over the *remote* channel (registry / github / cloud
ingestion) must verify or it is ``untrusted``.

Provenance is fixed **at the install entry**, recorded once, and read by the
governance gate. It is NOT inferred from the (forgeable) manifest ``source``
field. Two things make the stamp non-bypassable:

1. **It lives beside the cache entry, OUTSIDE the digested file set.** The record
   is a sibling of the cached version directory (``<id>/<version>`` ⇒
   ``<id>/<version>.superclaw-provenance.json``), so writing it never perturbs
   ``compute_package_digest`` (which hashes the files *inside* the version dir).

2. **It is digest-bound.** The record pins the install-time ``package_digest``;
   the gate recomputes the cached bytes' digest and compares. Two fail-closed
   conditions cover every swap / stale-stamp / hand-written-record bypass:

   - **no record ⇒ remote** (an un-stamped cache entry is never trusted as local);
   - **stamped digest ≠ recomputed digest ⇒ remote** (a byte swap or a record
     forged against other bytes can never satisfy a ``local`` stamp).

   Only when the recomputed digest matches the stamp is the recorded provenance
   honored. A remote attacker cannot mint a valid ``local`` stamp: they can write
   neither a stamp that arrived through a local install entry NOR one whose digest
   matches their swapped bytes.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from superclaw.plugins import PluginPackage, compute_package_digest

Provenance = Literal["local", "remote"]

# Sibling-file suffix for the per-(id,version) provenance record. Placed in the
# parent of the cached version directory so it is never part of the package's
# own digested tree.
PROVENANCE_SUFFIX = ".superclaw-provenance.json"
PROVENANCE_SCHEMA_VERSION = "0.1.0"


def _provenance_path(*, cache_version_dir: Path) -> Path:
    """Sibling record path for a cached ``<id>/<version>`` directory."""
    return cache_version_dir.parent / f"{cache_version_dir.name}{PROVENANCE_SUFFIX}"


def write_install_provenance(
    *,
    cache_version_dir: Path,
    provenance: Provenance,
    entry: str,
    package_digest: str,
) -> Path:
    """Write the digest-bound install-entry provenance record (kernel-owned).

    ``package_digest`` is the digest of the exact bytes admitted at install (the
    caller passes the value it already computed during verification). ``entry`` is
    the install-entry id (e.g. ``"install-local"``, ``"skill-import"``,
    ``"registry-install"``) recorded for audit. The record is written atomically
    beside the cache entry.
    """
    if provenance not in ("local", "remote"):
        raise ValueError(f"provenance must be 'local' or 'remote', got {provenance!r}")
    record = {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "provenance": provenance,
        "entry": entry,
        "package_digest": package_digest,
        "stamped_at": datetime.now(timezone.utc).isoformat(),
    }
    path = _provenance_path(cache_version_dir=cache_version_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
    return path


def read_install_provenance(package: PluginPackage) -> Provenance:
    """Resolve a cached package's provenance, fail-closed to ``remote``.

    SECURITY (§3.7): returns ``"local"`` ONLY when a record exists AND its stamped
    ``package_digest`` equals the freshly recomputed digest of the current cached
    bytes. Every other case — no record, unreadable/malformed record, a record
    whose ``provenance`` is not exactly ``"local"``, or a stamp-digest mismatch
    (swap / stale / forged-against-other-bytes) — resolves to ``"remote"`` so the
    gate makes the remote branch verify or drop. There is no path that defaults an
    unverifiable package to ``local``.
    """
    path = _provenance_path(cache_version_dir=package.root)
    if not path.exists():
        return "remote"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "remote"
    if not isinstance(record, dict) or record.get("provenance") != "local":
        # Only an explicit local stamp can yield local; remote/unknown ⇒ remote.
        return "remote"
    stamped_digest = record.get("package_digest")
    if not isinstance(stamped_digest, str) or not stamped_digest:
        return "remote"
    try:
        recomputed = compute_package_digest(package)
    except Exception:
        # An un-digestible cache entry cannot be trusted as local.
        return "remote"
    if recomputed != stamped_digest:
        # Bytes changed since the stamp, or the stamp was forged against other
        # bytes — never honor the local claim.
        return "remote"
    return "local"


__all__ = [
    "PROVENANCE_SUFFIX",
    "PROVENANCE_SCHEMA_VERSION",
    "Provenance",
    "read_install_provenance",
    "write_install_provenance",
]
