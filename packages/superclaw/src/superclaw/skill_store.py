"""Native SuperClaw skill store.

Skills are markdown artifacts, not governed plugin runtimes. This module owns
the install-time gate and the normalized local store under ``~/.superclaw``;
runtime projection copies the stored files into native agent skill directories
without routing execution through the plugin MCP proxy.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from superclaw.environment import superclaw_home
from superclaw.harness import parse_markdown_with_frontmatter
from superclaw.trust import PackageTrustVerifier, SignedArtifactError

DEFAULT_SKILL_STORE = superclaw_home() / "skills"
PROVENANCE_NAME = ".provenance.json"
SKILL_LABELS = {"official", "reviewed", "community", "local-dev"}

# The native-skill revocation source — the skill analogue of
# ``plugins.default_revocation_file()``. Native skills are intentionally sign-free
# (local provenance), so the *only* withdrawal mechanism is this revocation list;
# it is bound to the RECOMPUTED on-disk digest (never the mutable
# ``.provenance.json`` digest), so a store-writer cannot forge a digest to dodge
# revocation. Resolved through ``default_skill_revocation_file()`` at EVERY call
# site (import / list / load / sync) so the four paths can never diverge.
DEFAULT_SKILL_REVOCATION_FILE = DEFAULT_SKILL_STORE / "revocations.json"

_SKILL_SIGNATURE_VERIFIER = PackageTrustVerifier(
    manifest_name="SKILL.md",
    label="skill",
    root_key_env="SUPERCLAW_SKILL_ROOT_PUBLIC_KEY",
    local_dev_env="SUPERCLAW_SKILL_LOCAL_DEV_TRUST",
)


class SkillStoreError(ValueError):
    """Raised when a native skill cannot be imported or read safely."""


class SkillExecutableError(SkillStoreError):
    """Raised when a skill carries executable assets / script blocks and was not
    explicitly allowed. A typed subclass (still a ``SkillStoreError``) so callers
    can distinguish "this is a side-effecting artifact" from other store errors
    without fragile substring matching on the message."""


@dataclass(frozen=True)
class SkillImportRecord:
    slug: str
    name: str
    description: str
    root: Path
    skill_path: Path
    provenance_path: Path
    label: str
    source_digest: str
    store_digest: str
    signature: str | None
    executable: bool
    executable_assets: list[str]
    imported_at: str
    importer: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "name": self.name,
            "description": self.description,
            "root": str(self.root),
            "skill_path": str(self.skill_path),
            "provenance_path": str(self.provenance_path),
            "label": self.label,
            "source_digest": self.source_digest,
            "store_digest": self.store_digest,
            "signature": self.signature,
            "executable": self.executable,
            "executable_assets": list(self.executable_assets),
            "imported_at": self.imported_at,
            "importer": self.importer,
        }


def default_skill_store() -> Path:
    # Anchored on the single data root (superclaw_home / SUPERCLAW_HOME) so skills move
    # with the rest of the user data; SUPERCLAW_SKILL_STORE_DIR overrides just this leg.
    override = os.environ.get("SUPERCLAW_SKILL_STORE_DIR")
    return Path(override).expanduser() if override else superclaw_home() / "skills"


def default_skill_revocation_file() -> Path:
    """The native-skill revocation list, overridable via env.

    Single resolution point shared by ``import_skill`` / ``list_skills`` /
    ``load_skill`` / ``sync_native_skills`` (and the CLI/API surfaces) so the
    revocation source can never diverge between the import door, the read path,
    and the runtime projection. Resolved at call time so tests can redirect it
    after import (mirrors ``default_skill_store``).
    """
    override = os.environ.get("SUPERCLAW_SKILL_REVOCATION_FILE")
    # Call-time under the (possibly post-import-overridden) skill store, so it tracks
    # SUPERCLAW_HOME / SUPERCLAW_SKILL_STORE_DIR like default_skill_store().
    return Path(override).expanduser() if override else default_skill_store() / "revocations.json"


def load_skill_revocations(revocation_file: Path | None = None) -> list[dict[str, Any]]:
    """Read the native-skill revocation entries, fail-CLOSED on a corrupt file.

    Each entry may pin a ``slug`` and/or a digest (``store_digest`` /
    ``source_digest``); an entry that omits the digest revokes every version of
    that slug (the coarse "revoke all" key, §5 5b).

    Fail posture (parity with the plugin verifier, which raises on a malformed
    revocation source rather than silently admitting):

    - **Missing file ⇒ ``[]``** — a legitimately absent revocation list means
      "nothing revoked yet"; this is the normal first-run state, not an error.
    - **Present but unreadable / non-JSON / not an object / ``revoked`` not a
      list ⇒ raise** ``SkillStoreError``. A corrupt revocation source must NOT be
      treated as "no revocations" (that would let a revoked skill load whenever
      the list is damaged). Callers surface this as a hard failure so the store is
      not enumerated against a broken governance source.
    """
    path = revocation_file or default_skill_revocation_file()
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SkillStoreError(f"skill revocation file is unreadable: {path}") from exc
    if not isinstance(payload, dict):
        raise SkillStoreError(f"skill revocation file is malformed (expected an object): {path}")
    revoked = payload.get("revoked", [])
    if not isinstance(revoked, list):
        raise SkillStoreError(f"skill revocation file 'revoked' must be a list: {path}")
    return [item for item in revoked if isinstance(item, dict)]


def _skill_revocation_matches(
    *,
    slug: str,
    store_digest: str,
    source_digest: str | None,
    revoked: list[dict[str, Any]],
) -> bool:
    """Match a stored skill against the revocation entries.

    SECURITY: the digest comparison must only ever use a NON-FORGEABLE digest. The
    ``store_digest`` is recomputed from the live on-disk bytes by the caller
    (``compute_stored_skill_digest``), so it is authoritative. The
    ``source_digest`` is only authoritative when the caller recomputed it from the
    live *source* tree (the import door does this); on the read/sync paths there is
    no source tree to recompute from, so callers pass ``source_digest=None`` and a
    ``{"source_digest": ...}`` entry simply does NOT match there. (If it matched
    against the mutable ``.provenance.json`` value — which is excluded from
    ``compute_stored_skill_digest`` — a store-writer could forge only that field,
    keep the store digest valid, and dodge a source-digest revocation. So
    source-digest matching is confined to the import door, and the read paths rely
    on the recomputed ``store_digest`` and the ``slug`` key.) An entry that omits
    both digests revokes the whole slug.
    """
    for item in revoked:
        entry_slug = item.get("slug")
        if entry_slug not in {None, slug}:
            continue
        store_match = item.get("store_digest")
        source_match = item.get("source_digest")
        if store_match is None and source_match is None:
            # No digest pinned: a slug-only entry revokes every version.
            if entry_slug is None:
                # Neither slug nor digest pinned: not a usable entry, skip.
                continue
            return True
        if store_match is not None and store_match == store_digest:
            return True
        # source_digest only matches when the caller supplied a recomputed value
        # (import door); read/sync paths pass None so a forged provenance field
        # can never satisfy a source-digest revocation.
        if source_match is not None and source_digest is not None and source_match == source_digest:
            return True
    return False


def import_skill(
    skill_path: Path,
    *,
    store_dir: Path | None = None,
    label: str = "local-dev",
    publisher: str | None = None,
    source_url: str | None = None,
    signature: str | None = None,
    public_key: str | None = None,
    importer: str = "superclaw",
    allow_executable: bool = False,
    force: bool = False,
    revocation_file: Path | None = None,
) -> SkillImportRecord:
    """Import a ``SKILL.md`` directory into the native skill store.

    Non-local labels fail closed unless ``signature`` verifies the source digest
    under ``public_key`` or ``SUPERCLAW_SKILL_ROOT_PUBLIC_KEY``. A skill whose
    recomputed source digest (or slug) is on the revocation list is refused at
    the door (§5 5d) — fail-closed before anything is written to the store.
    """
    label = _normalize_label(label)
    source_file = _resolve_skill_file(skill_path)
    source_root = source_file.parent
    source_digest = compute_skill_source_digest(source_file)
    if label != "local-dev":
        _verify_skill_signature(source_digest, signature, public_key)

    raw = source_file.read_text(encoding="utf-8")
    frontmatter, body = parse_markdown_with_frontmatter(raw)
    name = _skill_name(frontmatter, source_file)
    description = _skill_description(frontmatter)
    slug = _slugify(name)
    revoked = load_skill_revocations(revocation_file)
    if _skill_revocation_matches(
        slug=slug, store_digest="", source_digest=source_digest, revoked=revoked
    ):
        raise SkillStoreError(f"skill is revoked and cannot be imported: {slug}")
    normalized = _normalized_skill_markdown(name=name, description=description, body=body)

    assets = _asset_files(source_root, source_file)
    executable_assets = _executable_assets(assets, body, source_root)
    executable = bool(executable_assets)
    if executable and not allow_executable:
        raise SkillExecutableError(
            "skill contains executable assets or script blocks; pass --yes-executable after reviewing: "
            + ", ".join(executable_assets)
        )

    root = (store_dir or default_skill_store()).expanduser() / slug
    if root.exists():
        if not force:
            raise SkillStoreError(f"skill already exists: {slug} (pass --force to replace)")
        if not root.is_dir():
            raise SkillStoreError(f"skill store path is not a directory: {root}")
        shutil.rmtree(root)

    root.mkdir(parents=True, exist_ok=True)
    skill_out = root / "SKILL.md"
    skill_out.write_text(normalized, encoding="utf-8")

    assets_root = root / "assets"
    for asset in assets:
        relative = _store_asset_relative(asset.relative_to(source_root))
        dest = assets_root / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(asset, dest)

    store_digest = compute_stored_skill_digest(root)
    imported_at = datetime.now(timezone.utc).isoformat()
    provenance = {
        "schema_version": "0.1.0",
        "publisher": publisher,
        "source_url": source_url,
        "source_digest": source_digest,
        "store_digest": store_digest,
        "signature": signature,
        "label": label,
        "executable": executable,
        "executable_assets": executable_assets,
        "imported_at": imported_at,
        "importer": importer,
    }
    provenance_path = root / PROVENANCE_NAME
    provenance_path.write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    return SkillImportRecord(
        slug=slug,
        name=name,
        description=description,
        root=root,
        skill_path=skill_out,
        provenance_path=provenance_path,
        label=label,
        source_digest=source_digest,
        store_digest=store_digest,
        signature=signature,
        executable=executable,
        executable_assets=executable_assets,
        imported_at=imported_at,
        importer=importer,
    )


def list_skills(
    *, store_dir: Path | None = None, revocation_file: Path | None = None
) -> list[SkillImportRecord]:
    """List native stored skills, fail-closed on tamper or revocation.

    SECURITY (§5 5b): the revocation/tamper decision is taken on the RECOMPUTED
    on-disk digest (``compute_stored_skill_digest``), never the mutable
    ``.provenance.json`` ``store_digest`` — a store-writer could forge the latter
    to dodge a digest-keyed revocation. A skill whose recomputed store digest
    disagrees with its declared digest is a tamper indicator and is dropped; a
    skill whose recomputed digest (or slug) is revoked is dropped. The declared
    digest is still surfaced as metadata for callers that want it.
    """
    root = (store_dir or default_skill_store()).expanduser()
    if not root.exists():
        return []
    revoked = load_skill_revocations(revocation_file)
    records: list[SkillImportRecord] = []
    for child in sorted(path for path in root.iterdir() if path.is_dir()):
        with_provenance = child / PROVENANCE_NAME
        skill_file = child / "SKILL.md"
        if not skill_file.exists() or not with_provenance.exists():
            continue
        try:
            provenance = json.loads(with_provenance.read_text(encoding="utf-8"))
            frontmatter, _ = parse_markdown_with_frontmatter(skill_file.read_text(encoding="utf-8"))
            declared_store_digest = str(provenance.get("store_digest") or "")
            source_digest = str(provenance.get("source_digest") or "")
            # Recompute the on-disk digest and bind both tamper- and
            # revocation-detection to it (never the writable provenance value).
            recomputed_store_digest = compute_stored_skill_digest(child)
            if declared_store_digest and recomputed_store_digest != declared_store_digest:
                # Bytes changed since import (tamper / corruption) → fail-closed drop.
                continue
            if _skill_revocation_matches(
                slug=child.name,
                store_digest=recomputed_store_digest,
                # No source tree to recompute from on the read path; pass None so a
                # forged provenance source_digest cannot satisfy a revocation.
                source_digest=None,
                revoked=revoked,
            ):
                continue
            records.append(
                SkillImportRecord(
                    slug=child.name,
                    name=str(frontmatter.get("name") or child.name),
                    description=str(frontmatter.get("description") or ""),
                    root=child,
                    skill_path=skill_file,
                    provenance_path=with_provenance,
                    label=str(provenance.get("label") or "local-dev"),
                    source_digest=source_digest,
                    store_digest=recomputed_store_digest,
                    signature=provenance.get("signature"),
                    executable=bool(provenance.get("executable")),
                    executable_assets=[str(item) for item in provenance.get("executable_assets", [])],
                    imported_at=str(provenance.get("imported_at") or ""),
                    importer=str(provenance.get("importer") or ""),
                )
            )
        except (OSError, ValueError, TypeError):
            continue
    return records


def load_skill(
    slug: str, *, store_dir: Path | None = None, revocation_file: Path | None = None
) -> SkillImportRecord:
    for record in list_skills(store_dir=store_dir, revocation_file=revocation_file):
        if record.slug == slug:
            return record
    raise SkillStoreError(f"skill not found: {slug}")


def compute_skill_source_digest(skill_file: Path) -> str:
    source = _resolve_skill_file(skill_file)
    root = source.parent
    entries = [(Path("SKILL.md"), source), *[(path.relative_to(root), path) for path in _asset_files(root, source)]]
    digest = hashlib.sha256()
    digest.update(b"superclaw-native-skill-source-v1\0")
    for relative, path in sorted(entries, key=lambda item: item[0].as_posix()):
        name = relative.as_posix().encode("utf-8")
        payload = path.read_bytes()
        digest.update(len(name).to_bytes(8, "big"))
        digest.update(name)
        mode_signal = 1 if path.stat().st_mode & stat.S_IXUSR else 0
        digest.update(bytes([mode_signal]))
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return f"sha256:{digest.hexdigest()}"


def compute_stored_skill_digest(skill_root: Path) -> str:
    entries: list[tuple[Path, Path]] = []
    for path in skill_root.rglob("*"):
        if path.name == PROVENANCE_NAME or path.is_dir():
            continue
        if path.is_symlink():
            raise SkillStoreError(f"stored skill may not contain symlinks: {path.relative_to(skill_root).as_posix()}")
        entries.append((path.relative_to(skill_root), path))
    digest = hashlib.sha256()
    digest.update(b"superclaw-native-skill-store-v1\0")
    for relative, path in sorted(entries, key=lambda item: item[0].as_posix()):
        name = relative.as_posix().encode("utf-8")
        payload = path.read_bytes()
        digest.update(len(name).to_bytes(8, "big"))
        digest.update(name)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return f"sha256:{digest.hexdigest()}"


def _resolve_skill_file(skill_path: Path) -> Path:
    source = skill_path.expanduser().resolve()
    if source.is_dir():
        candidate = source / "SKILL.md"
        if candidate.exists():
            return candidate
        raise SkillStoreError(f"missing SKILL.md in {source}")
    if source.is_file():
        if source.name != "SKILL.md":
            raise SkillStoreError(f"native skill import expects SKILL.md, got: {source.name}")
        return source
    raise SkillStoreError(f"skill path not found: {skill_path}")


def _asset_files(root: Path, skill_file: Path) -> list[Path]:
    paths: list[Path] = []
    for path in root.rglob("*"):
        if path == skill_file or path.name == PROVENANCE_NAME:
            continue
        if path.is_symlink():
            raise SkillStoreError(f"skill assets may not contain symlinks: {path.relative_to(root).as_posix()}")
        if path.is_file():
            paths.append(path)
    return sorted(paths)


def _store_asset_relative(relative: Path) -> Path:
    if relative.parts and relative.parts[0] == "assets":
        return Path(*relative.parts[1:]) if len(relative.parts) > 1 else Path(relative.name)
    return relative


def _normalize_label(label: str) -> str:
    value = label.strip()
    if value not in SKILL_LABELS:
        raise SkillStoreError(f"unknown skill label: {label!r} (expected one of {', '.join(sorted(SKILL_LABELS))})")
    return value


def _verify_skill_signature(source_digest: str, signature: str | None, public_key: str | None) -> None:
    if not signature:
        raise SkillStoreError("non-local skill imports require an Ed25519 signature")
    key = public_key or os.environ.get("SUPERCLAW_SKILL_ROOT_PUBLIC_KEY")
    if not key:
        raise SkillStoreError("non-local skill imports require --public-key or SUPERCLAW_SKILL_ROOT_PUBLIC_KEY")
    try:
        _SKILL_SIGNATURE_VERIFIER.verify_signature(source_digest, signature, key)
    except SignedArtifactError as exc:
        raise SkillStoreError(str(exc)) from exc


def _skill_name(frontmatter: dict[str, Any], source_file: Path) -> str:
    raw = frontmatter.get("name")
    name = str(raw).strip() if isinstance(raw, str) else ""
    return name or source_file.parent.name or source_file.stem


def _skill_description(frontmatter: dict[str, Any]) -> str:
    raw = frontmatter.get("description")
    description = str(raw).strip() if isinstance(raw, str) else ""
    if not description:
        raise SkillStoreError("skill frontmatter must declare a description")
    return description


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not slug:
        raise SkillStoreError(f"cannot derive a skill slug from name: {value!r}")
    if not slug[0].isalpha():
        slug = f"s-{slug}"
    return slug


def _yaml_scalar(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def _normalized_skill_markdown(*, name: str, description: str, body: str) -> str:
    body = body.lstrip("\n")
    if body and not body.endswith("\n"):
        body += "\n"
    return f'---\nname: "{_yaml_scalar(name)}"\ndescription: "{_yaml_scalar(description)}"\n---\n\n{body}'


def _executable_assets(assets: Iterable[Path], body: str, source_root: Path) -> list[str]:
    found: list[str] = []
    for asset in assets:
        if asset.suffix.lower() != ".md" or asset.stat().st_mode & stat.S_IXUSR:
            found.append(asset.relative_to(source_root).as_posix())
    if re.search(r"```[^\n]*\n#!", body):
        found.append("SKILL.md:fenced-shebang")
    return sorted(set(found))
