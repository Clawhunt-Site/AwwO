"""Authoritative TrustState derivation for the Capability Workshop (方向二 §1).

THE single place that decides ``official / developer / local / untrusted``. Trust
is DERIVED from verification results + namespace ownership + delegation + revocation
/ freshness — NEVER from a package's self-declared ``manifest.source`` (路线图护栏 2).

This consumes the Direction-1 ``PackageTrustVerifier`` output (a non-raising
``signer_class`` from :meth:`superclaw.trust.PackageTrustVerifier.classify_signer`
plus the integrity/digest verdict) and folds in namespace ownership, the delegated
developer key set (TUF registry, 方向二 §2 — injected, ``None`` until it lands so
developer signatures fail closed), revocation, freshness and anti-rollback.

``derive_trust_state`` is a PURE function (no I/O; verdict/registry are injected) so
the state machine can be exhaustively unit-tested. fail-closed: every uncertain or
failed path short-circuits to ``UNTRUSTED`` (路线图护栏 4).
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from superclaw.trust import PackageTrustVerdict

# Reserved first-party namespaces (hard-coded; cross-checked at the loader in 方向二 §3).
# Only a root-key signature may own these prefixes; anyone else = namespace hijack.
FIRST_PARTY_NAMESPACES: tuple[str, ...] = ("superclaw.", "first_party.")


class TrustState(str, Enum):
    OFFICIAL = "official"      # root public key verified
    DEVELOPER = "developer"    # registered delegated developer key, not revoked, fresh
    LOCAL = "local"            # local_dev trust / local build, NOT in a reserved namespace
    UNTRUSTED = "untrusted"    # any verification failure / revoked / stale / namespace hijack


@dataclass(frozen=True)
class TrustDerivation:
    state: TrustState
    signer_class: str               # "root" | "developer:<keyid>" | "local_dev" | "none"
    namespace_reserved: bool        # id falls in FIRST_PARTY_NAMESPACES?
    revoked: bool
    freshness_ok: bool              # TUF timestamp fresh (required for high-risk)
    rollback_ok: bool               # snapshot sequence >= local watermark
    reasons: tuple[str, ...]        # human-readable diagnostics


def derive_trust_state(
    *,
    plugin_id: str,
    verdict: PackageTrustVerdict,
    revoked: bool,
    source_is_local: bool,
    rollback_ok: bool,
    freshness_ok: bool,
    high_risk: bool,
    developer_keyids: frozenset[str] | None = None,
) -> TrustDerivation:
    """Derive the authoritative :class:`TrustState` (pure, fail-closed).

    Every security input is REQUIRED — there are NO trusted defaults, so a caller
    that forgets to supply a verification fact cannot accidentally get a trusted
    state (a missing verdict simply can't be passed). ``verdict`` is the single
    authoritative verification result (signer class + integrity) from
    :meth:`PackageTrustVerifier.assess`; trust is derived from it, never from
    ``manifest.source`` (护栏 2).

    - ``source_is_local``: a ``local_dev`` signer only yields ``LOCAL`` for a
      genuinely local-sourced artifact; a non-local (registry/remote) entry with
      a ``local_dev`` classification fails closed (an unverifiable remote package
      must never read as locally trusted).
    - ``rollback_ok``: anti-rollback is UNCONDITIONAL — a sequence rollback is an
      attack at any risk level (revert to an earlier signed-but-vulnerable
      version), so ``False`` always demotes to ``UNTRUSTED``.
    - ``freshness_ok``: TUF timestamp freshness; gates high-risk developer entries
      only (offline low-risk use stays available, per TUF).
    - ``developer_keyids``: active delegated developer key set (方向二 §2);
      ``None`` (registry not loaded) fails any developer signature closed.

    Invariant: ``OFFICIAL``/``DEVELOPER`` ⟹ ``integrity_ok and not revoked and
    rollback_ok``. ``LOCAL`` never lands in a reserved namespace and only for a
    local source. A tampered package's signer identity is scrubbed to ``"none"``.
    """
    signer_class = verdict.signer_class
    namespace_reserved = any(plugin_id.startswith(p) for p in FIRST_PARTY_NAMESPACES)

    def result(
        state: TrustState, reason: str | None = None, *, scrub_signer: bool = False
    ) -> TrustDerivation:
        return TrustDerivation(
            state=state,
            signer_class="none" if scrub_signer else signer_class,
            namespace_reserved=namespace_reserved,
            revoked=revoked,
            freshness_ok=freshness_ok,
            rollback_ok=rollback_ok,
            reasons=() if reason is None else (reason,),
        )

    # 1. revocation wins outright.
    if revoked:
        return result(TrustState.UNTRUSTED, "revoked")
    # 2. integrity: a content-hash mismatch can never be trusted, and a tampered
    #    package's signer identity is meaningless — scrub it (审计防误导).
    if not verdict.integrity_ok:
        return result(TrustState.UNTRUSTED, "integrity_failed", scrub_signer=True)
    # 3. anti-rollback is UNCONDITIONAL (attack at any risk level).
    if not rollback_ok:
        return result(TrustState.UNTRUSTED, "sequence_rollback")
    # 4. namespace hijack: reserved prefixes are root-only (deep-defense; the
    #    loader raises a second, fatal time in 方向二 §3).
    if namespace_reserved and signer_class != "root":
        return result(TrustState.UNTRUSTED, "namespace_hijack")
    # 5. signer classification.
    if signer_class == "root":
        return result(TrustState.OFFICIAL)
    if signer_class.startswith("developer:"):
        keyid = signer_class.split(":", 1)[1]
        if developer_keyids is None:
            return result(TrustState.UNTRUSTED, "developer_no_registry")
        if keyid not in developer_keyids:
            return result(TrustState.UNTRUSTED, "developer_not_registered")
        if high_risk and not freshness_ok:
            return result(TrustState.UNTRUSTED, "developer_freshness_stale")
        return result(TrustState.DEVELOPER)
    if signer_class == "local_dev":
        if not source_is_local:
            return result(TrustState.UNTRUSTED, "local_dev_on_nonlocal")
        # Reserved-namespace local_dev was already rejected in step 4.
        return result(TrustState.LOCAL)
    # 6. signature invalid / unrecognized signer — scrub identity.
    return result(TrustState.UNTRUSTED, "sig_invalid", scrub_signer=True)


__all__ = [
    "FIRST_PARTY_NAMESPACES",
    "TrustState",
    "TrustDerivation",
    "derive_trust_state",
]
