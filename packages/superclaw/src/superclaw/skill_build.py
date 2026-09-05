"""Build a local ``SKILL.md`` into an equippable, governed skill-origin plugin.

This is the kernel orchestration the design (§3, PR-2) calls for: a thin
composition over EXISTING primitives — it adds NO new trust primitive.

    SKILL.md
      → import_skill_as_plugin()   (skill_import.py)  wrap as mcp_sidecar, skill_origin:true, zero perms
      → pack_plugin_package()      (plugin_devkit.py) recompute digest; sign ONLY if the dev asks
      → verify_plugin_package(..., provenance="local", install_entry="skill-build")  (plugins.py)
                                                       install through the LOCAL entry → digest-bound
                                                       `local` provenance stamp (plugin_provenance.py)

Per the owner-ratified provenance model (design R5/§3.6): a local-origin skill is
the user's own responsibility and is **equippable SIGN-FREE** — graded ``local``.
Signing is therefore **optional** (a dev who wants a signature may pass one); a
self-signature does NOT upgrade ``local`` to ``developer``/``official`` (no grade
spoofing — the runtime gate grades by the digest-bound install provenance, not the
signature). No keygen, no trusted-signers enrollment (that apparatus was cut in
R5).

The install funnels through ``verify_plugin_package`` (the single cache write
chokepoint), so the package is graded by the very same fail-closed gate the
execution path enforces (``plugin_proxy._verify_cached_package_before_execution``).
A built skill is never written to the cache by any other path.
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path

from superclaw.plugin_devkit import PluginDevkitError, pack_plugin_package
from superclaw.plugins import (
    MANIFEST_NAME,
    PluginVerificationError,
    derive_skill_trust,
    plugin_cache_root,
)
from superclaw.skill_import import SkillImportError, import_skill_as_plugin
from superclaw.trust_state import TrustState

# The install-entry id stamped into the digest-bound provenance record for a
# locally built skill (mirrors the other LOCAL entries: install-local /
# plugin-verify-local). Recorded for audit; the gate keys on the `local`
# provenance, not on this string.
SKILL_BUILD_INSTALL_ENTRY = "skill-build"


class SkillBuildError(ValueError):
    """Raised when a SKILL.md cannot be built into an equippable skill plugin."""


@dataclass(frozen=True)
class InstalledSkillPlugin:
    plugin_id: str
    version: str
    package_digest: str
    trust_state: str
    equippable: bool
    signed: bool
    cached_path: str
    warnings: list[str]


def build_and_install_skill_plugin(
    skill_path: Path,
    *,
    plugin_id: str | None = None,
    version: str = "0.1.0",
    developer_id: str = "local-dev",
    sign: bool = False,
    signing_private_key: str | None = None,
    cache_root: Path | None = None,
    revocation_file: Path | None = None,
    force: bool = False,
) -> InstalledSkillPlugin:
    """Wrap a local ``SKILL.md`` and install it as an equippable ``local`` skill.

    Orchestration only — no new trust primitive. The artifact is installed through
    the LOCAL entry (``verify_plugin_package(provenance="local")``), which records
    the digest-bound ``local`` provenance stamp; the runtime gate then grades it
    ``local`` (equippable, sign-free). ``sign`` / ``signing_private_key`` are
    OPTIONAL — a signature does not change the ``local`` grade (no spoof).

    Returns the installed plugin's id/version/digest, the kernel-derived
    ``trust_state`` (``local``), and ``equippable``.

    Raises :class:`SkillBuildError` on any wrap/pack/install failure (fail-closed:
    if the artifact does not derive to an equippable ``local`` skill, it is an
    error, never a silent downgrade).
    """
    do_sign = sign or signing_private_key is not None
    # Wrap + pack happen in a throwaway workspace; only the cache install persists.
    with tempfile.TemporaryDirectory(prefix="superclaw-skill-build-") as workspace:
        work = Path(workspace)
        try:
            imported = import_skill_as_plugin(
                skill_path,
                output_dir=work / "package",
                plugin_id=plugin_id,
                version=version,
                developer_id=developer_id,
                force=True,
            )
        except SkillImportError as exc:
            raise SkillBuildError(str(exc)) from exc

        # Honor `force` as a REAL replacement gate (not a silent no-op): refuse to
        # overwrite an already-cached build of this id/version unless force=True.
        # Checked BEFORE pack/install so a non-forced collision touches nothing.
        if not force and _is_already_cached(imported.plugin_id, imported.version, cache_root):
            raise SkillBuildError(
                f"a skill is already installed at {imported.plugin_id}@{imported.version}; "
                "pass force=True (CLI --force) to replace it"
            )

        try:
            packed = pack_plugin_package(
                imported.package_root,
                dist_dir=work / "dist",
                signing_private_key=signing_private_key,
                dev_sign=do_sign,
            )
        except PluginDevkitError as exc:
            raise SkillBuildError(str(exc)) from exc

        try:
            # The LOCAL install entry: stamps provenance="local" (digest-bound) and
            # admits the skill-origin package sign-free. The public key (when the
            # dev signed) is NOT used to mint a higher grade — derive_skill_trust
            # grades by provenance, so a self-signature stays `local`.
            result = verify_plugin_package_local(
                packed.package_path,
                cache_root=cache_root,
                revocation_file=revocation_file,
            )
        except PluginVerificationError as exc:
            raise SkillBuildError(str(exc)) from exc

    # Confirm the kernel actually graded it equippable `local` before reporting
    # success (fail-closed: never claim equippable without the gate's verdict). If
    # the post-install verdict is NOT a local equippable grade, ROLL BACK the cache
    # write so a failed build never leaves a poisoning partial entry behind.
    cached_pkg = _load_cached(result.plugin_id, result.version, cache_root)
    if cached_pkg is None:
        _rollback_cache(result.plugin_id, result.version, cache_root)
        raise SkillBuildError(
            f"built skill was not found in the cache after install: {result.plugin_id}@{result.version}"
        )
    try:
        trust = derive_skill_trust(cached_pkg, revocation_file=revocation_file)
    finally:
        cached_pkg.cleanup()
    if trust is not TrustState.LOCAL:
        _rollback_cache(result.plugin_id, result.version, cache_root)
        raise SkillBuildError(
            f"built skill did not derive to a local equippable grade (got {trust.value}): "
            f"{result.plugin_id}@{result.version}"
        )

    return InstalledSkillPlugin(
        plugin_id=result.plugin_id,
        version=result.version,
        package_digest=result.digest,
        trust_state=trust.value,
        equippable=True,
        signed=do_sign,
        cached_path=str(result.cached_path) if result.cached_path else "",
        warnings=list(imported.warnings),
    )


def verify_plugin_package_local(
    package_path: Path,
    *,
    cache_root: Path | None = None,
    revocation_file: Path | None = None,
):
    """Install a local package through the LOCAL provenance entry.

    Thin wrapper that pins ``provenance="local"`` / ``install_entry="skill-build"``
    so callers cannot accidentally install a built skill as ``remote``.
    """
    from superclaw.plugins import verify_plugin_package

    return verify_plugin_package(
        package_path,
        cache_root=cache_root,
        revocation_file=revocation_file,
        cache=True,
        provenance="local",
        install_entry=SKILL_BUILD_INSTALL_ENTRY,
    )


def _load_cached(plugin_id: str, version: str, cache_root: Path | None):
    from superclaw.plugin_proxy import load_cached_package

    root = plugin_cache_root(cache_root)
    return load_cached_package(plugin_id, version=version, cache_root=root)


def _is_already_cached(plugin_id: str, version: str, cache_root: Path | None) -> bool:
    """Whether this id/version already has a cache entry on disk.

    Existence check by directory (not a full package load) so a corrupt prior
    entry still counts as "present" and a non-forced build refuses to overwrite it.
    """
    root = plugin_cache_root(cache_root)
    return (root / plugin_id / version / MANIFEST_NAME).exists()


def _rollback_cache(plugin_id: str, version: str, cache_root: Path | None) -> None:
    """Remove a just-installed cache entry after a post-install failure.

    Fail-closed cleanup: a build whose post-install verdict is not equippable
    `local` must not leave a partial/untrusted entry that could poison a later
    install of the same id/version. Best-effort — a cleanup error never masks the
    original build failure.
    """
    from superclaw.plugins import uninstall_cached_plugin

    try:
        uninstall_cached_plugin(plugin_id, version=version, cache_root=plugin_cache_root(cache_root))
    except (PluginVerificationError, OSError, ValueError):
        # Cleanup is best-effort; the build already failed and we re-raise that.
        pass


__all__ = [
    "SKILL_BUILD_INSTALL_ENTRY",
    "InstalledSkillPlugin",
    "SkillBuildError",
    "build_and_install_skill_plugin",
]
