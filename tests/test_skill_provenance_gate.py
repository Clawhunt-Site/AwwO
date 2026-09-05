"""PR-1 governance tests: the digest-bound provenance gate for skill-origin packages.

These are the canary tests the design (§7/§8) requires: they assert the gate
lives at the single shared primitive ``_verify_cached_package_before_execution``
(so enumeration, equipment, proxy execution, and resume all enforce it), that a
``local``-stamped skill is equippable sign-free, and that the env-flag
``local_dev`` path can never mint a ``local`` verdict.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

import superclaw.team_kernel as team_kernel
from superclaw.models import AgentProfile
from superclaw.plugin_provenance import read_install_provenance, write_install_provenance
from superclaw.plugin_proxy import (
    load_cached_package,
    verify_cached_package_before_execution,
)
from superclaw.plugins import (
    PluginVerificationError,
    compute_package_digest,
    derive_skill_trust,
    load_plugin_package,
    verify_plugin_package,
)
from superclaw.trust_state import TrustState

SKILL_ID = "skill.local-helper"
VERSION = "0.1.0"


def _keypair() -> tuple[Ed25519PrivateKey, str]:
    pk = Ed25519PrivateKey.generate()
    pub = base64.b64encode(pk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
    return pk, pub


def _write_skill_origin_package(
    pkg_dir: Path,
    *,
    plugin_id: str = SKILL_ID,
    sign_key: Ed25519PrivateKey | None = None,
    skill_origin: bool = True,
) -> None:
    """Write a schema-valid, zero-permission skill_origin mcp_sidecar package.

    If ``sign_key`` is None the package is left UNSIGNED (placeholder signature) —
    cacheable only with SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST=1, mirroring a self-built
    local skill.
    """
    pkg_dir.mkdir(parents=True, exist_ok=True)
    (pkg_dir / "bin").mkdir(exist_ok=True)
    (pkg_dir / "bin" / "sidecar").write_text("#!/bin/sh\ncat\n", encoding="utf-8")
    manifest = {
        "schema_version": "0.1.0",
        "id": plugin_id,
        "name": "Local Helper",
        "version": VERSION,
        "summary": "A locally built skill.",
        "skill_origin": skill_origin,
        "source": {"type": "developer_upload", "clawhunt_problem_id": None, "developer_id": "local"},
        "runtime": {
            "type": "mcp_sidecar",
            "entrypoint": "bin/sidecar",
            "args": ["mcp"],
            "transport": "stdio",
            "mcp_protocol_versions": ["2025-06-18"],
            "platforms": ["darwin-arm64", "linux-x64"],
        },
        "tools": [
            {
                "name": "help",
                "description": "Help.",
                "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
                "output_schema": {"type": "object", "properties": {}, "additionalProperties": False},
            }
        ],
        "permissions": {"filesystem": [], "network": [], "environment": []},
        "acceptance": {"level": "L0", "tests": [], "evidence_fixtures": [], "latency_budget_ms": 1000},
        "limits": {
            "startup_timeout_ms": 3000,
            "tool_timeout_ms": 30000,
            "max_model_output_bytes": 65536,
            "max_evidence_bytes": 5242880,
            "max_memory_mb": 128,
        },
        "provenance": {"package_digest": "", "signature": ""},
    }
    mp = pkg_dir / "superclaw-plugin.json"
    mp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    digest = compute_package_digest(load_plugin_package(pkg_dir))
    manifest["provenance"]["package_digest"] = digest
    if sign_key is not None:
        manifest["provenance"]["signature"] = "ed25519:" + base64.b64encode(
            sign_key.sign(digest.encode())
        ).decode()
    else:
        manifest["provenance"]["signature"] = "ed25519:unsigned-dev-package"
    mp.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _install_local_unsigned(tmp_path: Path, monkeypatch, *, plugin_id: str = SKILL_ID) -> Path:
    """Install an UNSIGNED skill_origin package through a LOCAL entry, SIGN-FREE.

    The owner's model makes a local-provenance skill equippable without a
    signature, so NO SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST is set here — the sign-free
    admission must come purely from the local provenance, not the env flag.
    """
    # Explicitly ensure the env flag is OFF so this proves sign-free-by-provenance.
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    src = tmp_path / "src"
    _write_skill_origin_package(src, plugin_id=plugin_id)
    cache_root = tmp_path / "cache"
    verify_plugin_package(
        src, cache_root=cache_root, cache=True, provenance="local", install_entry="skill-build"
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    return cache_root


def _cached(plugin_id: str = SKILL_ID):
    pkg = load_cached_package(plugin_id, version=VERSION)
    assert pkg is not None
    return pkg


# --------------------------------------------------------------------------- #
# P-local / P2: a local-stamped unsigned skill is equippable AND executes.
# --------------------------------------------------------------------------- #


def test_p_local_sign_free_without_local_dev_trust_env(tmp_path, monkeypatch):
    # The canary for the owner's model: a local-stamped UNSIGNED skill installs,
    # is graded local, and passes the primitive with SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST
    # explicitly UNSET — proving sign-free admission comes from provenance, NOT the
    # env flag.
    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    _install_local_unsigned(tmp_path, monkeypatch)
    assert "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST" not in __import__("os").environ
    pkg = _cached()
    assert derive_skill_trust(pkg) is TrustState.LOCAL
    assert verify_cached_package_before_execution(pkg) is None
    assert SKILL_ID in team_kernel.available_skill_ids()


def test_p_local_unsigned_is_equippable_and_passes_primitive(tmp_path, monkeypatch):
    _install_local_unsigned(tmp_path, monkeypatch)
    pkg = _cached()

    # provenance resolves to local (digest-matched stamp)
    assert read_install_provenance(pkg) == "local"
    assert derive_skill_trust(pkg) is TrustState.LOCAL
    # the SHARED primitive lets it run (None == pass) — the proxy execution path
    # funnels through exactly this call.
    assert verify_cached_package_before_execution(pkg) is None

    # and it is in the equippable universe / granted to a profile that asks for it
    assert SKILL_ID in team_kernel.available_skill_ids()
    profile = AgentProfile(name="Eng", role="engineer", skill_allowlist=[SKILL_ID])
    resolution = team_kernel.resolve_equipment(profile)
    assert resolution.skills_granted == (SKILL_ID,)


# --------------------------------------------------------------------------- #
# P1 / P-remote: a remote-stamped unsigned skill is refused at the PRIMITIVE
# (the proxy execution path), absent from the universe, NOT re-admitted as local.
# --------------------------------------------------------------------------- #


def test_p_remote_unsigned_refused_at_primitive_and_absent(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "1")
    src = tmp_path / "src"
    _write_skill_origin_package(src)
    cache_root = tmp_path / "cache"
    # Same package, but installed through a REMOTE entry.
    verify_plugin_package(
        src, cache_root=cache_root, cache=True, provenance="remote", install_entry="registry-install"
    )
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    pkg = _cached()

    assert read_install_provenance(pkg) == "remote"
    # remote + unsigned ⇒ UNTRUSTED even with LOCAL_DEV_TRUST=1 set.
    assert derive_skill_trust(pkg) is TrustState.UNTRUSTED
    # Refused at the shared primitive itself (the canary: this is the proxy
    # execution call, not just the enumerator).
    assert verify_cached_package_before_execution(pkg) == "PLUGIN_SIGNATURE_INVALID"
    # Absent from the equippable universe, and never re-admitted as local.
    assert SKILL_ID not in team_kernel.available_skill_ids()


def test_p_remote_no_stamp_treated_remote(tmp_path, monkeypatch):
    # No provenance record at all ⇒ remote (fail-closed). install_entry/provenance
    # omitted so no record is written.
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "1")
    src = tmp_path / "src"
    _write_skill_origin_package(src)
    cache_root = tmp_path / "cache"
    verify_plugin_package(src, cache_root=cache_root, cache=True)  # NO provenance arg
    monkeypatch.setenv("SUPERCLAW_PLUGIN_CACHE_PATH", str(cache_root))
    pkg = _cached()

    assert read_install_provenance(pkg) == "remote"
    assert verify_cached_package_before_execution(pkg) == "PLUGIN_SIGNATURE_INVALID"
    assert SKILL_ID not in team_kernel.available_skill_ids()


# --------------------------------------------------------------------------- #
# P-stamp: a digest mismatch (byte swap / forged stamp) ⇒ remote ⇒ untrusted.
# --------------------------------------------------------------------------- #


def test_p_stamp_digest_mismatch_treated_remote(tmp_path, monkeypatch):
    cache_root = _install_local_unsigned(tmp_path, monkeypatch)
    pkg = _cached()
    assert read_install_provenance(pkg) == "local"

    # Swap the cached bytes AFTER the local stamp: the recomputed digest no longer
    # matches the stamped package_digest ⇒ treated remote ⇒ unsigned ⇒ untrusted.
    sidecar = cache_root / SKILL_ID / VERSION / "bin" / "sidecar"
    sidecar.write_text("#!/bin/sh\necho pwned\n", encoding="utf-8")
    pkg2 = _cached()
    assert read_install_provenance(pkg2) == "remote"
    assert derive_skill_trust(pkg2) is TrustState.UNTRUSTED
    assert verify_cached_package_before_execution(pkg2) is not None


def test_p_stamp_forged_local_record_against_other_bytes(tmp_path, monkeypatch):
    cache_root = _install_local_unsigned(tmp_path, monkeypatch)
    version_dir = cache_root / SKILL_ID / VERSION
    # Hand-write a `local` stamp whose package_digest does NOT match the bytes.
    write_install_provenance(
        cache_version_dir=version_dir,
        provenance="local",
        entry="attacker",
        package_digest="sha256:" + "0" * 64,
    )
    pkg = _cached()
    assert read_install_provenance(pkg) == "remote"  # mismatch ⇒ remote
    assert derive_skill_trust(pkg) is TrustState.UNTRUSTED


# --------------------------------------------------------------------------- #
# P-env: SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST=1 must NOT mint a local verdict.
# --------------------------------------------------------------------------- #


def test_p_env_local_dev_trust_does_not_mint_local(tmp_path, monkeypatch):
    # Covered implicitly above, but assert the property directly: a remote-stamped
    # unsigned package under LOCAL_DEV_TRUST=1 stays UNTRUSTED.
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "1")
    src = tmp_path / "src"
    _write_skill_origin_package(src)
    cache_root = tmp_path / "cache"
    verify_plugin_package(src, cache_root=cache_root, cache=True, provenance="remote", install_entry="x")
    pkg = load_cached_package(SKILL_ID, version=VERSION, cache_root=cache_root)
    assert pkg is not None
    assert derive_skill_trust(pkg) is TrustState.UNTRUSTED


# --------------------------------------------------------------------------- #
# P3 / no-grade-spoof: a local-stamped package in a reserved namespace ⇒ untrusted.
# --------------------------------------------------------------------------- #


def test_p3_reserved_namespace_local_stamp_is_untrusted(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", "1")
    src = tmp_path / "src"
    reserved_id = "superclaw.evil-skill"
    _write_skill_origin_package(src, plugin_id=reserved_id)
    cache_root = tmp_path / "cache"
    verify_plugin_package(
        src, cache_root=cache_root, cache=True, provenance="local", install_entry="skill-build"
    )
    pkg = load_cached_package(reserved_id, version=VERSION, cache_root=cache_root)
    assert pkg is not None
    # A local stamp can NEVER own a reserved first-party namespace (no spoofing).
    assert read_install_provenance(pkg) == "local"
    assert derive_skill_trust(pkg) is TrustState.UNTRUSTED


# --------------------------------------------------------------------------- #
# Generic plugins are NOT affected by the skill-origin branch.
# --------------------------------------------------------------------------- #


def test_local_sign_free_waiver_matches_runtime_predicate(tmp_path, monkeypatch):
    # The install-time sign-free waiver keys on the SAME predicate as the runtime
    # gate: manifest skill_origin IS True — NOT the bare `skill.` id-prefix. A
    # package that sets id="skill.spoof" but does NOT declare skill_origin must
    # NOT get the keyless waiver: unsigned + no local-dev-trust => install fails
    # closed (signature required), identical to a generic plugin.
    from superclaw.plugins import PluginVerificationError

    monkeypatch.delenv("SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST", raising=False)
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)
    src = tmp_path / "src"
    _write_skill_origin_package(src, plugin_id="skill.spoof", skill_origin=False)
    cache_root = tmp_path / "cache"
    with pytest.raises(PluginVerificationError):
        verify_plugin_package(
            src, cache_root=cache_root, cache=True, provenance="local", install_entry="skill-build"
        )


def test_generic_plugin_does_not_enter_skill_branch(tmp_path, monkeypatch):
    # A non-skill_origin package whose id is not skill.* must NOT be graded by
    # derive_skill_trust at the gate. We install a signed generic plugin and
    # assert the primitive passes it (the skill clause never fires).
    pk, pub = _keypair()
    src = tmp_path / "src"
    _write_skill_origin_package(src, plugin_id="dev.example.tool", sign_key=pk, skill_origin=False)
    cache_root = tmp_path / "cache"
    verify_plugin_package(
        src, public_key=pub, cache_root=cache_root, cache=True, provenance="remote", install_entry="x"
    )
    pkg = load_cached_package("dev.example.tool", version=VERSION, cache_root=cache_root)
    assert pkg is not None
    # Signed generic plugin: primitive passes (the skill_origin branch is skipped;
    # no provenance grading applied to generic plugins).
    assert verify_cached_package_before_execution(pkg, public_key=pub) is None


# --------------------------------------------------------------------------- #
# P4 / override-injection: a request that lists an ungated id never grants it.
# --------------------------------------------------------------------------- #


def test_p4_override_injection_refused_in_resolve_equipment():
    # resolve_equipment's override is a pure GATED-universe seam: an id not in it
    # is dropped. (The production injection vector is closed in
    # build_bootstrap_proposal, tested below.)
    profile = AgentProfile(name="Eng", role="engineer", skill_allowlist=["ungated.skill"])
    resolution = team_kernel.resolve_equipment(
        profile, available_ids=[], available_skill_ids_override=[]
    )
    assert resolution.skills_granted == ()
    assert "ungated.skill" in resolution.skills_dropped


def test_p4_bootstrap_proposal_does_not_grant_ungated_request_skill(tmp_path):
    from superclaw.team_templates import build_bootstrap_proposal

    template = {
        "company": {"name": "Acme", "company_profile_id": "company_acme"},
        "roles": [
            {
                "role_id": "eng",
                "name": "Eng",
                "role": "engineer",
                "skill_allowlist": ["ungated.skill"],
                "required_skills": [],
            }
        ],
    }
    # Gated universe is EMPTY; the request hint names an ungated skill. It must
    # not appear as granted (the hint is intersected with the gated universe).
    proposal = build_bootstrap_proposal(
        template,
        available_skill_ids=["ungated.skill"],  # attacker-controlled request hint
        gated_skill_ids=[],  # authoritative gated universe (empty)
        gated_plugin_ids=[],
    )
    payload = proposal.to_dict()
    granted_skills = payload["equipment_resolution"][0]["granted"]["skills"]
    assert "ungated.skill" not in granted_skills


# --------------------------------------------------------------------------- #
# P-manifest: the REMOTE plugin-install sinks pass reject_skill_origin=True so a
# SIGNED manifest skill_origin:true fails closed at verification — the
# authoritative layer BEHIND the feed-metadata guards. A skill can never be
# plugin-installed even if a drifted/hostile feed grades it kind=plugin with a
# non-"skill." id. Local / verify / build / execute callers keep the default
# False (covered by the P-local tests above).
# --------------------------------------------------------------------------- #


def test_p_manifest_remote_sink_rejects_signed_skill_origin_with_nonskill_id(tmp_path):
    # The exact drift Codex flagged: a feed could grade kind=plugin and the id is
    # NOT "skill."-prefixed, so neither the metadata guard nor the id-prefix
    # fallback fires — only the authoritative signed manifest field can catch it.
    # A REMOTE sink (reject_skill_origin=True) must fail closed BEFORE any cache
    # write, mirroring the external_mcp curated-only gate.
    pkg = tmp_path / "pkg"
    sign_key, public_key = _keypair()
    _write_skill_origin_package(
        pkg, plugin_id="dev.acme.looks-like-a-plugin", sign_key=sign_key, skill_origin=True
    )
    cache_root = tmp_path / "cache"
    with pytest.raises(PluginVerificationError, match="skill capability"):
        verify_plugin_package(
            pkg,
            public_key=public_key,
            cache_root=cache_root,
            cache=True,
            provenance="remote",
            install_entry="registry-install",
            reject_skill_origin=True,
        )
    # Stronger than the runtime gate (which lets it cache, then refuses execution):
    # this rejects BEFORE the cache write, so nothing is ever committed.
    assert (
        load_cached_package("dev.acme.looks-like-a-plugin", version=VERSION, cache_root=cache_root)
        is None
    )


def test_p_manifest_default_admits_signed_skill_for_nonsink_callers(tmp_path):
    # The mirror: build / verify / install-local / execute callers keep the default
    # reject_skill_origin=False, so a genuine signed skill still verifies and caches
    # — the sink gate must NOT bleed into the skill build/equip/run paths.
    pkg = tmp_path / "pkg"
    sign_key, public_key = _keypair()
    _write_skill_origin_package(pkg, plugin_id=SKILL_ID, sign_key=sign_key, skill_origin=True)
    cache_root = tmp_path / "cache"
    result = verify_plugin_package(pkg, public_key=public_key, cache_root=cache_root, cache=True)
    assert result.plugin_id == SKILL_ID
    assert load_cached_package(SKILL_ID, version=VERSION, cache_root=cache_root) is not None


def test_p_manifest_remote_sink_rejects_skill_prefixed_id_without_field(tmp_path):
    # F1 (Codex R7): the gate keys on the kernel single source is_skill_origin_plugin,
    # so a reserved "skill." id is rejected at a REMOTE sink EVEN WITHOUT
    # skill_origin:true. The feed guards already reject "skill." ids on metadata; this
    # is the manifest-side mirror so BOTH layers use the IDENTICAL predicate and a
    # "skill."-id package a feed mis-graded as a plain plugin still fails closed.
    pkg = tmp_path / "pkg"
    sign_key, public_key = _keypair()
    _write_skill_origin_package(pkg, plugin_id="skill.sneaky", sign_key=sign_key, skill_origin=False)
    cache_root = tmp_path / "cache"
    with pytest.raises(PluginVerificationError, match="skill capability"):
        verify_plugin_package(
            pkg,
            public_key=public_key,
            cache_root=cache_root,
            cache=True,
            provenance="remote",
            install_entry="registry-install",
            reject_skill_origin=True,
        )
    assert load_cached_package("skill.sneaky", version=VERSION, cache_root=cache_root) is None


# --------------------------------------------------------------------------- #
# P-projection: a skill is equipped ONLY via skill_allowlist, never plugin_allowlist.
# A tool-skill STAYS in available_plugins (so its MCP proxy can still be projected for
# superclaw__call_tool); the red line is enforced in resolve_equipment's plugin grant,
# which excludes skill_origin packages on the same is_skill_origin_plugin source as
# available_skill_ids' IN-filter (capability-workshop red line, Codex R7 finding 3).
# --------------------------------------------------------------------------- #


def test_p_projection_skill_in_available_plugins_but_never_granted_as_plugin(tmp_path, monkeypatch):
    # F3 (Codex R7), re-fixed after a full-suite regression: a tool-skill MUST stay in
    # available_plugins so it can be MCP-projected (superclaw__call_tool /
    # _skill_overlay_lines resolve tool-skill calls off this set) — but it must NEVER
    # be grantable as PLUGIN equipment. So the red line lives in resolve_equipment's
    # plugin grant, NOT an OUT-filter in available_plugins (which would wrongly hide
    # tool-skills from MCP projection).
    from superclaw.plugin_runtime_projection import available_plugins

    _install_local_unsigned(tmp_path, monkeypatch)
    # Positive control: it IS a governed skill.
    assert SKILL_ID in team_kernel.available_skill_ids()
    # It IS in available_plugins (tool-skill MCP projection still sees it), flagged
    # skill_origin so the plugin grant can exclude it.
    avail = {p.plugin_id: p for p in available_plugins()}
    assert SKILL_ID in avail
    assert avail[SKILL_ID].skill_origin is True
    # But plugin_allowlist can NEVER grant it as a plugin, while skill_allowlist still
    # grants it as a skill — the two equipment dimensions stay disjoint.
    profile = AgentProfile(
        name="Eng", role="engineer", plugin_allowlist=[SKILL_ID], skill_allowlist=[SKILL_ID]
    )
    resolution = team_kernel.resolve_equipment(profile)
    assert SKILL_ID not in resolution.granted  # NOT as a plugin
    assert resolution.skills_granted == (SKILL_ID,)  # YES as a skill


def test_p_projection_template_plugin_allowlist_never_grants_a_skill(tmp_path, monkeypatch):
    # F3 (Codex R10): the team_templates resolver_plugin_ids OVERRIDE path must also
    # exclude skill-origin packages. A template role listing a skill in plugin_allowlist
    # must NEVER grant it AS plugin equipment — the override (resolve_equipment
    # available_ids) bypasses the None-branch OUT-filter, so the exclusion lives at the
    # template's derive lambda (the gated plugin universe excludes skills).
    from superclaw.team_templates import build_bootstrap_proposal

    _install_local_unsigned(tmp_path, monkeypatch)  # installs SKILL_ID (skill.local-helper)
    template = {
        "company": {"name": "Acme", "company_profile_id": "company_acme"},
        "roles": [
            {
                "role_id": "eng",
                "name": "Eng",
                "role": "engineer",
                "plugin_allowlist": [SKILL_ID],
                "skill_allowlist": [SKILL_ID],
                "required_skills": [],
            }
        ],
    }
    # gated=None => derive from the kernel: available_plugins now excludes skills from
    # the plugin universe, while available_skill_ids still includes it as a skill.
    proposal = build_bootstrap_proposal(template)
    granted = proposal.to_dict()["equipment_resolution"][0]["granted"]
    assert SKILL_ID not in granted["plugins"]  # NEVER granted as a plugin (derive path)
    assert SKILL_ID in granted["skills"]  # YES granted as a skill
    # R11 override hole: an EXPLICIT gated_plugin_ids listing the skill must ALSO be
    # refused — it bypasses the derive lambda, so the skill exclusion is applied to the
    # resolved plugin universe regardless of where the gated set came from.
    granted_override = build_bootstrap_proposal(
        template, gated_plugin_ids=[SKILL_ID], gated_skill_ids=[SKILL_ID]
    ).to_dict()["equipment_resolution"][0]["granted"]
    assert SKILL_ID not in granted_override["plugins"]  # override hole closed
    assert SKILL_ID in granted_override["skills"]


def test_p_projection_field_only_skill_never_granted_via_gated_override(tmp_path, monkeypatch):
    # F3 (Codex R12): a FIELD-ONLY skill-origin id (skill_origin:true, NON-"skill." id)
    # injected via an explicit gated_plugin_ids override must NOT be granted as plugin
    # equipment. is_skill_origin_plugin(pid) alone can't catch it (its id is not
    # "skill."-prefixed), so the filter also subtracts the full skill universe
    # (available_skill_ids), which — unlike available_plugins — never drops the package.
    from superclaw.team_templates import build_bootstrap_proposal

    field_id = "dev.acme.field-skill"
    _install_local_unsigned(tmp_path, monkeypatch, plugin_id=field_id)  # skill_origin:true, non-"skill." id
    assert field_id in team_kernel.available_skill_ids()  # it IS a governed skill
    # Simulate the exact NO-TOOL case (Codex R12): available_plugins drops a package
    # with no projected tools, so the field-only id is absent from _plugin_skill_origin_ids
    # and ONLY _skill_universe (available_skill_ids, tools-agnostic) can catch it. Drop it
    # from available_plugins here so the resolver MUST go down that path.
    _real_available_plugins = team_kernel.available_plugins
    monkeypatch.setattr(
        team_kernel,
        "available_plugins",
        lambda **kw: [p for p in _real_available_plugins(**kw) if p.plugin_id != field_id],
    )
    assert field_id not in {p.plugin_id for p in team_kernel.available_plugins()}  # dropped, as if no-tool
    template = {
        "company": {"name": "Acme", "company_profile_id": "company_acme"},
        "roles": [
            {
                "role_id": "eng",
                "name": "Eng",
                "role": "engineer",
                "plugin_allowlist": [field_id],
                "skill_allowlist": [field_id],
                "required_skills": [],
            }
        ],
    }
    # Inject the field-only skill id through the gated_plugin_ids override (the R12 hole).
    granted = build_bootstrap_proposal(
        template, gated_plugin_ids=[field_id], gated_skill_ids=[field_id]
    ).to_dict()["equipment_resolution"][0]["granted"]
    assert field_id not in granted["plugins"]  # NEVER as a plugin (field-only override closed)
    assert field_id in granted["skills"]  # YES as a skill
