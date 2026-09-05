"""Local review gate for Paperclip CompanyPortability company bundles (capability
workshop, slice 1 of the company-upload bridge).

Why this exists
---------------
The company capability chain has two ends that historically spoke different formats:

* **download / import side** (workshop S5) feeds a verified bundle to Paperclip's native
  ``importBundle``, which materialises a live company — and it ONLY accepts a
  CompanyPortability bundle (it rejects anything missing ``COMPANY.md``).
* **upload / review side** (``capability_submission._review_company``) only understood the
  legacy ``superclaw-company.json`` ``CompanyTemplate`` blueprint.

So a company published the legacy way could never round-trip through the import side, and a
Paperclip export could never pass the upload review. This module adds the missing review
gate for the *portability* format so the upload side can speak the same language as the
import side ("上传按 Paperclip 取项目逻辑").

Design (per the Codex architecture review)
------------------------------------------
* Python does **not** re-implement Paperclip's portability parser. The authoritative
  "is this importable?" judgement is delegated to Node ``previewImport`` through an
  **injected** ``preview_fn`` (the real one is a loopback HTTP call wired in a later
  slice; tests inject a fake). This keeps the gate unit-testable without a live Node
  server while making Node the single source of truth for portability semantics.
* **Fail-closed everywhere**:
  - a symlink / non-regular-file pre-scan runs FIRST and short-circuits — no later gate
    ever follows a link out of the bundle root;
  - exceeding the file-count / size limits short-circuits before the secret scan, preview
    or digest read the (potentially huge) tree;
  - the publish identity (``capability_id``/``version``) is required;
  - a review WITHOUT a ``preview_fn`` cannot confirm importability, so the preview gate
    fails closed, and a malformed preview response is rejected, not trusted;
  - the secret scan streams every text file in full (no size cap) and records any binary
    files it cannot text-scan (those remain gated behind ``manual_security_review``).
* The stable digest binds only the normalised bundle file tree using the same
  length-prefixed framing as ``capability_submission._hash_file`` (so distinct trees can
  never collide), never an export's ``generatedAt``/``warnings`` envelope.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
from pathlib import Path
from typing import Any, Callable

from superclaw.plugin_submission import _gate
from superclaw.secrets_scan import contains_secret

# Where COMPANY.md may live inside a portability bundle: at any depth. Mirrors Paperclip
# ``importBundle``'s own lookup (``entry === "COMPANY.md" || entry.endsWith("/COMPANY.md")``).
COMPANY_MARKER = "COMPANY.md"

# Fail-closed resource bounds — a runaway/zip-bomb-expanded bundle is rejected before it
# reaches the secret scan or Node preview. Generous enough for a real company export.
MAX_PORTABILITY_FILES = 10_000
MAX_PORTABILITY_BYTES = 200 * 1024 * 1024  # 200 MiB

_SCAN_CHUNK = 1024 * 1024
_SCAN_OVERLAP = 256  # carry the tail across chunks so a secret split on a boundary is seen

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
# Marketplace publish id: a slug safe to use as a registry/distribution key. No
# whitespace, control characters, path separators, or leading punctuation.
SAFE_CAPABILITY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")

PreviewFn = Callable[[dict[str, Any]], dict[str, Any]]


class CompanyPortabilityPreviewError(RuntimeError):
    """Raised when the Node portability preview cannot be obtained (transport/loopback/auth
    failure) or the bundle cannot be safely enumerated. Distinct from a preview that
    *returns* errors — that is a clean rejection, not an infrastructure failure."""


def _safe_file_list(root: Path) -> tuple[list[Path], str | None]:
    """Enumerate regular files under ``root`` WITHOUT ever following a symlink.

    Returns ``(sorted_files, None)`` on success, or ``([], reason)`` if the tree cannot be
    safely enumerated — the caller fails closed. Rejections: the root itself being a
    symlink (``os.walk`` would happily enumerate the link target), any symlink (file or
    directory) inside, any non-regular file, and any walk error (``os.walk`` swallows
    these by default — we surface them as a fail-closed reason).
    """
    if os.path.islink(root):
        return [], "bundle root must not be a symlink"
    if not os.path.isdir(root):
        return [], "bundle root is not a directory"
    walk_errors: list[str] = []
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False, onerror=lambda exc: walk_errors.append(str(exc))):
        base = Path(dirpath)
        for name in dirnames:
            if (base / name).is_symlink():
                return [], f"symlink directory not allowed: {(base / name).relative_to(root).as_posix()}"
        for name in filenames:
            candidate = base / name
            if candidate.is_symlink():
                return [], f"symlink not allowed: {candidate.relative_to(root).as_posix()}"
            if not candidate.is_file():
                return [], f"non-regular file not allowed: {candidate.relative_to(root).as_posix()}"
            files.append(candidate)
    if walk_errors:
        return [], f"could not fully enumerate bundle (fail-closed): {walk_errors[0]}"
    return sorted(files), None


def _find_company_md(files: list[Path], root: Path) -> Path | None:
    """Shallowest ``COMPANY.md`` among an already symlink-checked file list (any depth)."""
    candidates = [p for p in files if p.name == COMPANY_MARKER]
    if not candidates:
        return None
    return min(candidates, key=lambda p: len(p.relative_to(root).parts))


def find_company_md(root: Path) -> Path | None:
    """Locate the bundle's ``COMPANY.md`` (any depth), or ``None`` (also ``None`` if the
    tree cannot be safely enumerated, e.g. contains a symlink)."""
    files, err = _safe_file_list(root)
    if err is not None:
        return None
    return _find_company_md(files, root)


def is_company_portability_bundle(blob_ref: Path) -> bool:
    """True when ``blob_ref`` looks like a CompanyPortability bundle (has COMPANY.md)."""
    root = blob_ref if blob_ref.is_dir() else blob_ref.parent
    return find_company_md(root) is not None


def _inline_from_files(files: list[Path], root: Path) -> dict[str, Any]:
    """Build the inline ``files`` map from an already symlink-checked file list.

    Matches the Node ``buildCompanyInlineFiles`` heuristic: any strict-UTF-8 file becomes a
    string (no size cap, so local review and real import agree); anything else is base64.
    """
    out: dict[str, Any] = {}
    for path in files:
        rel = path.relative_to(root).as_posix()
        raw = path.read_bytes()
        try:
            out[rel] = raw.decode("utf-8")
        except UnicodeDecodeError:
            out[rel] = {"encoding": "base64", "data": base64.b64encode(raw).decode("ascii")}
    return out


def build_portability_inline_files(root: Path) -> dict[str, Any]:
    """Public: walk a bundle directory into the inline ``files`` map Paperclip import
    expects. Raises ``CompanyPortabilityPreviewError`` if the tree contains a symlink."""
    files, err = _safe_file_list(root)
    if err is not None:
        raise CompanyPortabilityPreviewError(err)
    return _inline_from_files(files, root)


def _digest_files(files: list[Path], root: Path) -> str:
    """Length-prefixed sha256 over a symlink-checked file list (mirrors
    ``capability_submission._hash_file`` so distinct trees can never collide).

    Sort by the POSIX relative path string (not Path-object order, which compares by path
    *segments* — ``a/b`` vs ``a-c`` would order differently) so the digest is a stable,
    string-canonical hash of the tree.
    """
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda p: p.relative_to(root).as_posix()):
        name = path.relative_to(root).as_posix().encode("utf-8")
        data = path.read_bytes()
        digest.update(len(name).to_bytes(8, "big"))
        digest.update(name)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return f"sha256:{digest.hexdigest()}"


def compute_portability_digest(root: Path) -> str:
    """Public: stable ``sha256:`` digest over the normalised bundle file tree. Raises if
    the tree cannot be safely enumerated (symlink/non-regular)."""
    files, err = _safe_file_list(root)
    if err is not None:
        raise CompanyPortabilityPreviewError(err)
    return _digest_files(files, root)


def check_bundle_safety_and_limits(root: Path) -> tuple[bool, str]:
    """Pre-copy guard: reject a symlink/non-regular/un-enumerable tree or an over-limit
    bundle BEFORE any expensive copy. Mirrors the review's symlink + limits gates so a
    caller can bound resources (disk/temp) before materialising the artifact."""
    files, err = _safe_file_list(root)
    if err is not None:
        return False, err
    if len(files) > MAX_PORTABILITY_FILES:
        return False, f"too many files: {len(files)} > {MAX_PORTABILITY_FILES}"
    total = sum(p.stat().st_size for p in files)
    if total > MAX_PORTABILITY_BYTES:
        return False, f"bundle too large: {total} bytes > {MAX_PORTABILITY_BYTES}"
    return True, "ok"


def _identity_gate(capability_id: str | None, version: str | None) -> dict[str, Any]:
    """Publish identity is required (explicit marketplace id+semver, never inferred).

    ``capability_id`` must match a safe slug pattern verbatim (no leading/trailing
    whitespace, no control chars, no path separators) so it cannot poison the downstream
    registry/distribution key.
    """
    if not capability_id:
        return _gate(
            "company_publish_identity", False, "capability_id is required (explicit marketplace publish identity)"
        )
    if not SAFE_CAPABILITY_ID_RE.fullmatch(capability_id):
        return _gate(
            "company_publish_identity",
            False,
            "capability_id must match ^[a-z0-9][a-z0-9._-]{0,127}$ (no whitespace/control/path separators)",
        )
    if not version:
        return _gate(
            "company_publish_identity", False, "version is required (explicit marketplace publish identity)"
        )
    if not SEMVER_RE.fullmatch(version):
        return _gate("company_publish_identity", False, "version must be MAJOR.MINOR.PATCH")
    return _gate("company_publish_identity", True, f"{capability_id}@{version}")


def _secret_scan_gate(files: list[Path], root: Path) -> dict[str, Any]:
    """Stream every text file in full (no size cap) and reject any secret-like content.

    Binary files (NUL in the first chunk) cannot be meaningfully text-scanned; they are
    counted and left to ``manual_security_review`` rather than silently ignored.
    """
    hits: list[str] = []
    unreadable: list[str] = []
    binary_skipped: list[str] = []
    for path in files:
        rel = path.relative_to(root).as_posix()
        try:
            with open(path, "rb") as handle:
                if b"\x00" in handle.read(8192):
                    binary_skipped.append(rel)
                    continue
                handle.seek(0)
                carry = ""
                found = False
                while True:
                    chunk = handle.read(_SCAN_CHUNK)
                    if not chunk:
                        break
                    text = carry + chunk.decode("latin-1", errors="replace")
                    if contains_secret(text):
                        found = True
                        break
                    carry = text[-_SCAN_OVERLAP:]
                if found:
                    hits.append(rel)
        except OSError as exc:
            # A file we cannot read cannot be cleared — fail closed, never skip silently.
            unreadable.append(f"{rel}: {exc}")
    if unreadable:
        return _gate(
            "company_portability_secret_scan", False, f"could not read (fail-closed): {'; '.join(unreadable[:5])}"
        )
    if hits:
        return _gate("company_portability_secret_scan", False, f"secret-like values found in: {', '.join(hits)}")
    detail = "no secret-like values in scanned text files"
    if binary_skipped:
        sample = ", ".join(binary_skipped[:3])
        detail += (
            f" ({len(binary_skipped)} binary file(s) not text-scanned, e.g. {sample}"
            " — covered by manual_security_review)"
        )
    return _gate("company_portability_secret_scan", True, detail)


def _preview_gate(files: list[Path], root: Path, preview_fn: PreviewFn | None) -> dict[str, Any]:
    """Authoritative importability gate — delegated to Node ``previewImport``.

    Fail-closed: no ``preview_fn`` → cannot confirm importability → reject. The response is
    strictly schema-checked (a malformed/forged shape is rejected, not trusted). Preview
    errors or warnings are blockers (warnings block an official publish absent an explicit
    allowlist). The plan must create a company and define at least one agent.
    """
    if preview_fn is None:
        return _gate(
            "company_portability_preview", False, "Node portability preview unavailable (no preview_fn) — fail-closed"
        )
    try:
        inline = _inline_from_files(files, root)
        preview = preview_fn(
            {"source": {"type": "inline", "files": inline}, "target": {"mode": "new_company"}}
        )
    except CompanyPortabilityPreviewError as exc:
        return _gate("company_portability_preview", False, f"preview unavailable: {exc}")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return _gate("company_portability_preview", False, f"preview failed: {exc}")

    if not isinstance(preview, dict):
        return _gate("company_portability_preview", False, "malformed preview response (not an object)")
    errors = preview.get("errors")
    warnings = preview.get("warnings")
    plan = preview.get("plan")
    if not isinstance(errors, list) or not isinstance(warnings, list) or not isinstance(plan, dict):
        return _gate("company_portability_preview", False, "malformed preview response schema")
    agent_plans = plan.get("agentPlans")
    if not isinstance(agent_plans, list):
        return _gate("company_portability_preview", False, "malformed preview response: plan.agentPlans is not a list")
    if errors:
        return _gate("company_portability_preview", False, f"preview reported errors: {errors}")
    if warnings:
        return _gate(
            "company_portability_preview", False, f"preview reported warnings (blocker for official publish): {warnings}"
        )
    if plan.get("companyAction") != "create":
        return _gate(
            "company_portability_preview", False, f"expected companyAction=create, got {plan.get('companyAction')!r}"
        )
    if len(agent_plans) < 1:
        return _gate("company_portability_preview", False, "bundle must define at least one agent")
    # Each agent plan must be a well-formed dict that actually CREATES into the fresh
    # company. A `skip`/`update` (or a malformed entry) means the bundle would not
    # materialise as previewed — reject rather than trust a forged/odd shape.
    for entry in agent_plans:
        if not isinstance(entry, dict):
            return _gate("company_portability_preview", False, "malformed preview response: agent plan is not an object")
        slug = entry.get("slug")
        if not isinstance(slug, str) or not slug.strip():
            return _gate("company_portability_preview", False, "malformed preview response: agent plan missing slug")
        if entry.get("action") != "create":
            return _gate(
                "company_portability_preview",
                False,
                f"agent plan {slug!r} action must be 'create' for a new company, got {entry.get('action')!r}",
            )
    return _gate(
        "company_portability_preview", True, f"preview clean: companyAction=create, agents={len(agent_plans)}"
    )


def _record(
    gates: list[dict[str, Any]], capability_id: str | None, version: str | None, package_digest: str | None
) -> dict[str, Any]:
    return {
        "review_type": "developer_company_portability_local_preflight",
        "capability_id": capability_id or "unknown",
        "company_id": capability_id or "unknown",
        "version": version or "unknown",
        "package_digest": package_digest,
        "company_source_format": "portability",
        "listing_review_level": "Unlisted",
        "acceptance_recommendation": "none",
        "certified_allowed": False,
        "l3_allowed": False,
        "manual_requirements": ["manual_security_review", "marketplace_listing_review"],
        "gates": gates,
    }


def review_company_portability_bundle(
    blob_ref: Path,
    *,
    preview_fn: PreviewFn | None = None,
    capability_id: str | None = None,
    version: str | None = None,
) -> dict[str, Any]:
    """Run the fail-closed review gates over a CompanyPortability company bundle.

    Returns a review-record fragment (``review_type``/``package_digest``/``gates``) shaped
    like ``capability_submission._review_company`` so the submission orchestrator can adopt
    it. Order matters: the symlink pre-scan and the limits gate SHORT-CIRCUIT so no later
    gate follows a link or reads an over-budget tree.
    """
    root = blob_ref if blob_ref.is_dir() else blob_ref.parent
    gates: list[dict[str, Any]] = []

    # EVERY early gate fails closed and SHORT-CIRCUITS: a bad publish identity, a symlink,
    # a missing/ambiguous COMPANY.md, an over-limit tree, or a secret hit each returns
    # immediately — so an invalid submission never reaches the Node loopback preview or the
    # digest. (Order: identity → symlink → structure → limits → secret → preview → digest.)
    identity_gate = _identity_gate(capability_id, version)
    gates.append(identity_gate)
    if not identity_gate["passed"]:
        return _record(gates, capability_id, version, None)

    files, sym_err = _safe_file_list(root)
    if sym_err is not None:
        gates.append(_gate("company_portability_no_symlink", False, sym_err))
        return _record(gates, capability_id, version, None)
    gates.append(_gate("company_portability_no_symlink", True, f"{len(files)} regular files, no symlinks"))

    company_mds = [p for p in files if p.name == COMPANY_MARKER]
    if not company_mds:
        gates.append(
            _gate(
                "company_portability_structure",
                False,
                "bundle must contain COMPANY.md (Paperclip CompanyPortability format)",
            )
        )
        return _record(gates, capability_id, version, None)
    # The structure gate only confirms a company bundle is plausible (≥1 readable COMPANY.md);
    # it does NOT add a surface-only "exactly one" rule the kernel lacks. The Node preview gate
    # is the authority on which entry import selects and whether it is importable. Report the
    # shallowest COMPANY.md (deterministic, by depth then posix path).
    company_md = min(company_mds, key=lambda p: (len(p.relative_to(root).parts), p.relative_to(root).as_posix()))
    try:
        company_md.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        gates.append(_gate("company_portability_structure", False, f"COMPANY.md not readable UTF-8: {exc}"))
        return _record(gates, capability_id, version, None)
    detail = f"COMPANY.md present: {company_md.relative_to(root).as_posix()}"
    if len(company_mds) > 1:
        detail += f" ({len(company_mds)} COMPANY.md present; Node import selects the entry — preview is authoritative)"
    gates.append(_gate("company_portability_structure", True, detail))

    total_bytes = sum(p.stat().st_size for p in files)
    if len(files) > MAX_PORTABILITY_FILES:
        gates.append(
            _gate("company_portability_limits", False, f"too many files: {len(files)} > {MAX_PORTABILITY_FILES}")
        )
        return _record(gates, capability_id, version, None)
    if total_bytes > MAX_PORTABILITY_BYTES:
        gates.append(
            _gate("company_portability_limits", False, f"bundle too large: {total_bytes} bytes > {MAX_PORTABILITY_BYTES}")
        )
        return _record(gates, capability_id, version, None)
    gates.append(_gate("company_portability_limits", True, f"files={len(files)} bytes={total_bytes}"))

    secret_gate = _secret_scan_gate(files, root)
    gates.append(secret_gate)
    if not secret_gate["passed"]:
        # Never hand a bundle that failed (or could not complete) the secret scan to the
        # Node loopback preview — short-circuit before any bytes leave the review.
        return _record(gates, capability_id, version, None)

    preview_gate = _preview_gate(files, root, preview_fn)
    gates.append(preview_gate)
    if not preview_gate["passed"]:
        return _record(gates, capability_id, version, None)

    package_digest = _digest_files(files, root)
    gates.append(_gate("company_portability_digest_stable", True, f"computed_digest={package_digest}"))

    return _record(gates, capability_id, version, package_digest)
