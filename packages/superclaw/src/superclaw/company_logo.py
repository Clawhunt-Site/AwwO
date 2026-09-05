"""Company visual identity: custom logo storage & retrieval (core harness).

Logos are *instance-level visual assets*, not company-as-code logic. Each logo
lives as a file under ``<state-dir>/company-logos/`` and the ``CompanyProfile``
carries only a reference string (the stored filename) — never the image bytes.

All validation (size / MIME / magic-bytes) is centralized in
:func:`set_company_logo` so the CLI and the API share one fail-closed gate and
can never drift (CLAUDE.md 铁律2: CLI 与客户端 APP 必须功能统一). The web
surface only adds presentation: it renders the served logo, or — when none is
set — a deterministic identicon derived from the company id.

SVG is intentionally **not** accepted on upload: it is untrusted XML and an XSS
surface. Only raster formats with a sniffable magic-byte signature are allowed.
The caller's declared Content-Type is **ignored entirely** — only the sniffed
magic bytes decide the format — so a lying Content-Type cannot smuggle a
non-image through (there is no separate declared-vs-sniffed comparison because
the declared type is never consulted).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

from .models import CompanyProfile

if TYPE_CHECKING:
    from .state import StateStore

# Capability limits. Aligned with the plugin-logo precedent (apps/api/main.py)
# so the two image surfaces behave identically. These are the single source of
# truth; ui_contracts.py re-exports them for the client surfaces (铁律3).
COMPANY_LOGO_MAX_BYTES = 256 * 1024  # 256 KB
# Upload formats: raster only (no SVG — see module docstring). Each must have a
# magic-byte signature in ``_MAGIC_SNIFFERS`` below.
COMPANY_LOGO_MIME_TYPES: tuple[str, ...] = ("image/png", "image/jpeg", "image/webp")

_MIME_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
_EXT_TO_MIME = {ext: mime for mime, ext in _MIME_TO_EXT.items()}

_LOGO_DIR_NAME = "company-logos"

# Stable error-code set — the single source the contract re-exports (铁律3) and
# the API maps to HTTP status. ``empty`` → 400, ``too_large`` → 413,
# ``unsupported_type`` → 415. Surfaces must not re-hardcode this set.
COMPANY_LOGO_ERROR_CODES: tuple[str, ...] = ("empty", "too_large", "unsupported_type")


class CompanyLogoError(ValueError):
    """Raised on a rejected logo upload. ``code`` maps to an HTTP status.

    Codes: ``empty`` (→400) / ``too_large`` (→413) / ``unsupported_type`` (→415).
    """

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def _sniff_mime(data: bytes) -> str | None:
    """Return the MIME inferred from leading magic bytes, or None if unknown."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def company_logos_dir(store: "StateStore") -> Path:
    """The per-instance directory that holds company logo files."""
    return store.path.parent / _LOGO_DIR_NAME


def _path_is_within(path: Path, root: Path) -> bool:
    """True iff ``path`` resolves inside ``root`` (path-traversal guard)."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _company_logo_dir(root: Path, company_id: str) -> Path:
    """The per-company subdirectory that holds its logo file.

    A dedicated subdirectory makes the stale-file sweep unambiguous (everything
    in it belongs to exactly this company), so a new upload can use a unique
    filename without any cross-company prefix/glob ambiguity (e.g. ``ab`` vs
    ``ab.cd``).
    """
    return root / company_id


def set_company_logo(store: "StateStore", company_id: str, data: bytes) -> CompanyProfile:
    """Validate, persist a custom logo for ``company_id`` and update its profile.

    The sniffed magic bytes are authoritative (anti-spoof); the declared
    Content-Type is never consulted. Any validation failure raises
    :class:`CompanyLogoError` (fail-closed — never silently accept a bad upload).
    The company must already exist (``get_company_profile`` raises ``KeyError``).

    Persistence upholds one invariant under any interleaving, with no lock:
    **the DB pointing at file X implies file X exists on disk.**

    * the new image is written under a **unique** filename in the company's
      subdirectory, so it never overwrites the file the current pointer
      references, and the unique name is never reused;
    * the DB pointer is then saved;
    * finally we unlink ONLY the *specific predecessor* captured at the start —
      never a file a concurrent op just created. Since a deleted predecessor's
      unique name is never referenced again, GET can never 404 a committed logo.

    Failure modes stay safe: a save failure leaves the new file as a harmless
    orphan and the prior logo fully intact (we never unlink on the error path);
    concurrent ops may leave an unreferenced orphan, never a dangling pointer.
    """
    profile = store.get_company_profile(company_id)  # KeyError if missing → fail-closed
    if not data:
        raise CompanyLogoError("logo file is empty", code="empty")
    if len(data) > COMPANY_LOGO_MAX_BYTES:
        raise CompanyLogoError(
            f"logo exceeds {COMPANY_LOGO_MAX_BYTES // 1024} KB limit", code="too_large"
        )
    mime = _sniff_mime(data)
    if mime is None or mime not in COMPANY_LOGO_MIME_TYPES:
        raise CompanyLogoError(
            "unsupported logo format (allowed: PNG, JPEG, WebP)",
            code="unsupported_type",
        )

    root = company_logos_dir(store)
    company_dir = _company_logo_dir(root, company_id)
    # Fail closed unless the company dir is a DIRECT child of the logo root.
    # This rejects an id carrying path separators or traversal (``..`` / ``a/b``)
    # regardless of platform, so a crafted/legacy id can never write or delete
    # outside the per-instance logo directory.
    if company_dir.resolve().parent != root.resolve():
        raise CompanyLogoError("invalid company id for logo path", code="unsupported_type")
    company_dir.mkdir(parents=True, exist_ok=True)
    ext = _MIME_TO_EXT[mime]

    # Write the new logo under a unique name, fsync, and close BEFORE the commit
    # (the close also keeps os semantics sane on Windows). The old file is left
    # untouched until the DB pointer flips.
    fd, tmp_name = tempfile.mkstemp(dir=company_dir, prefix="logo.", suffix=ext)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        tmp_path.unlink(missing_ok=True)  # nothing references it yet → safe
        raise

    old_name = Path(profile.logo or "").name  # the predecessor, captured BEFORE we overwrite
    profile.logo = f"{company_id}/{tmp_path.name}"
    # If this raises we deliberately do NOT unlink the new file: the store's save
    # is not a single transaction, so the row may already point at it. The prior
    # logo stays intact; a never-referenced new file is swept by the next op.
    saved = store.save_company_profile(profile)

    # Drop ONLY the specific file we replaced — never one a concurrent op just
    # created. A unique predecessor name is never referenced again, so this can
    # never delete the file a committed pointer (ours or a racer's) names.
    if old_name and old_name != tmp_path.name:
        (company_dir / old_name).unlink(missing_ok=True)
    return saved


def resolve_company_logo(store: "StateStore", company_id: str) -> tuple[Path, str] | None:
    """Return ``(path, mime)`` for the company's stored logo, or None if unset.

    Returns None (not an error) when the company has no logo, the reference is
    stale, or the file is missing — callers map that to a 404 / identicon
    fallback. Path-traversal is guarded even though the stored name is ours.
    """
    try:
        profile = store.get_company_profile(company_id)
    except KeyError:
        return None
    ref = (profile.logo or "").strip()
    if not ref:
        return None
    root = company_logos_dir(store)
    company_dir = _company_logo_dir(root, company_id)
    path = root / ref
    # Constrain to THIS company's own subdir, not merely the shared root — else a
    # tampered reference (``company_b/logo.x.png``) could read a sibling
    # company's logo. Also rejects traversal out of the root entirely.
    if not _path_is_within(path, company_dir) or not path.is_file():
        return None
    mime = _EXT_TO_MIME.get(path.suffix)
    if mime is None:
        return None
    return path, mime


def clear_company_logo(store: "StateStore", company_id: str) -> CompanyProfile:
    """Remove the company's custom logo (reference + files). Idempotent.

    Fail-closed: the DB reference is cleared FIRST (the commit point), then ONLY
    the file we just dereferenced is removed. A save failure leaves both the
    reference and file intact; and because we never delete a file a concurrent
    ``set`` created, a racing set's committed logo can never be left dangling.
    """
    profile = store.get_company_profile(company_id)  # KeyError if missing → fail-closed
    old_name = Path(profile.logo or "").name  # the only file this clear owns
    if profile.logo:
        profile.logo = ""
        saved = store.save_company_profile(profile)  # <-- commit before any unlink
    else:
        saved = profile
    # Remove ONLY the file we dereferenced — never a file a concurrent set just
    # created (that would 404 its committed logo). ``.name`` is a bare basename;
    # the parent check rejects a crafted id pointing outside the logo root.
    if old_name:
        root = company_logos_dir(store)
        company_dir = _company_logo_dir(root, company_id)
        if company_dir.resolve().parent == root.resolve():
            (company_dir / old_name).unlink(missing_ok=True)
    return saved
