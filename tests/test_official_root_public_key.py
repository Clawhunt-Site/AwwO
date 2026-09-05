"""Build-baked official capability-signing public key -> kind-scoped trust roots.

The product public key is baked per environment; in a shipped (frozen) build it
defaults SUPERCLAW_*_ROOT_PUBLIC_KEY so installed SuperClaw verifies official
capabilities out of the box. Source/dev/test runs never get a silent trust root,
and production stays fail-closed until its real key is baked.
"""
from __future__ import annotations

import sys

import pytest

from superclaw import environment as env

_ROOT_VARS = (
    "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY",
    "SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY",
    "SUPERCLAW_SKILL_ROOT_PUBLIC_KEY",
)


@pytest.fixture(autouse=True)
def _clean_root_env(monkeypatch):
    for name in _ROOT_VARS:
        monkeypatch.delenv(name, raising=False)
    yield


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_baked_key_is_a_valid_ed25519_public_key(environment):
    # Canary: a typo'd / truncated baked key would silently make EVERY official
    # signature fail to verify. Assert each baked key decodes to a 32-byte raw
    # Ed25519 public key (loadable by the same primitive the verifier uses).
    import base64

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    raw = base64.b64decode(env.OFFICIAL_ROOT_PUBLIC_KEYS[environment], validate=True)
    assert len(raw) == 32
    Ed25519PublicKey.from_public_bytes(raw)  # raises if not a valid key


# Golden vectors: a signature produced OFFLINE by each environment's official PRIVATE
# key over a fixed message. Verifying it against the baked PUBLIC key proves the baked
# key is the public half of that real official signer — not merely some other valid
# key. A valid-but-wrong baked key (or a swapped key without regenerating its vector)
# fails verification, which a shape-only check cannot catch.
_GOLDEN_MESSAGE = b"superclaw-official-root-canary-v1"
_GOLDEN_SIGNATURES = {
    "staging": "2foNyX6aF7HxUUnYHB9Je/obntks4DXXXB2aa/twUtrCWynUo/5O/jbMi2mPtGEgiVrRnen+jT7g6C1sSDVyBQ==",
    "production": "F3ut+RbZLS2x3Jw8yv3f/H5JPcJd0so/x2CEhnN84iRa3T8xQIKu4Q0lLDKdDdtw3vlqx7fNKUZ9ztypb/81Bg==",
}


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_baked_key_matches_official_signer(environment):
    import base64

    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    pub = Ed25519PublicKey.from_public_bytes(
        base64.b64decode(env.OFFICIAL_ROOT_PUBLIC_KEYS[environment], validate=True)
    )
    try:
        pub.verify(base64.b64decode(_GOLDEN_SIGNATURES[environment], validate=True), _GOLDEN_MESSAGE)
    except InvalidSignature:  # pragma: no cover - the assertion below reports it
        raise AssertionError(
            f"baked {environment} public key does NOT verify its official signer's "
            "golden signature — the baked key and that private key have diverged"
        )


def test_official_root_public_key_per_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "staging")
    assert env.official_root_public_key() == env.OFFICIAL_ROOT_PUBLIC_KEYS["staging"]
    assert env.official_root_public_key() != ""
    monkeypatch.setenv("APP_ENV", "production")
    assert env.official_root_public_key() == env.OFFICIAL_ROOT_PUBLIC_KEYS["production"]
    assert env.official_root_public_key() != ""


def test_staging_and_production_use_separate_keys():
    # Environment isolation: a staging-key leak must never serve as the production
    # trust root, so the two baked keys must differ.
    assert env.OFFICIAL_ROOT_PUBLIC_KEYS["staging"] != env.OFFICIAL_ROOT_PUBLIC_KEYS["production"]


def test_hydrate_is_noop_from_source(monkeypatch):
    # The test process is not frozen -> no baked identity is applied.
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setattr(sys, "frozen", False, raising=False)
    assert env.hydrate_official_root_public_keys() == []
    for name in _ROOT_VARS:
        assert name not in __import__("os").environ


def test_hydrate_sets_trust_roots_in_frozen_staging(monkeypatch):
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    applied = env.hydrate_official_root_public_keys()
    assert set(applied) == set(_ROOT_VARS)
    import os

    for name in _ROOT_VARS:
        assert os.environ[name] == env.OFFICIAL_ROOT_PUBLIC_KEYS["staging"]


def test_hydrate_does_not_override_explicit_env(monkeypatch):
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", "operator-override")
    applied = env.hydrate_official_root_public_keys()
    import os

    assert os.environ["SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"] == "operator-override"
    assert "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" not in applied
    # the other two still default to the baked key
    assert os.environ["SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY"] == env.OFFICIAL_ROOT_PUBLIC_KEYS["staging"]


def test_hydrate_respects_explicit_empty_env(monkeypatch):
    # An operator who explicitly sets the var to "" is disabling that trust root
    # (fail-closed) and must NOT be silently re-armed with the baked key.
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", "")
    applied = env.hydrate_official_root_public_keys()
    import os

    assert os.environ["SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"] == ""  # untouched
    assert "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" not in applied


def test_hydrate_sets_trust_roots_in_frozen_production(monkeypatch):
    # production now carries its own baked key, so a frozen production build
    # defaults the trust roots to it (env override still wins).
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    applied = env.hydrate_official_root_public_keys()
    assert set(applied) == set(_ROOT_VARS)
    import os

    for name in _ROOT_VARS:
        assert os.environ[name] == env.OFFICIAL_ROOT_PUBLIC_KEYS["production"]


def test_hydrate_is_noop_when_baked_key_empty(monkeypatch):
    # If an environment's baked key is empty (fail-closed default), hydration is a
    # no-op even in a frozen build — no trust root is silently armed.
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setitem(env.OFFICIAL_ROOT_PUBLIC_KEYS, "production", "")
    assert env.hydrate_official_root_public_keys() == []
    import os

    for name in _ROOT_VARS:
        assert name not in os.environ
