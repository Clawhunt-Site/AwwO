"""Architecture test (Test-as-Policy): environment-divergent service hosts must
live in exactly ONE place — superclaw.environment — so a build can bake the right
URL per environment and an explicit env/config override always wins.

This is the enforcement teeth for the dev-rules constitution: "future code changes
cannot hardcode environment-specific values." If someone reintroduces a literal
staging/production ClawHunt host anywhere in the kernel OR in any client surface
(web / desktop / api), this test fails.

Scope note: only the ClawHunt ``*.clawhunt.store`` hosts are guarded — they differ
by environment (dev=localhost / staging / production). The relay + bridge
``*.clawhunt.site`` hosts are intentionally environment-INVARIANT (one LLMgate
deployment) and stay co-located with the bridge's security allowlist in
``relay_key.py``; guarding ``.store`` never matches ``.site``. Test files are
excluded — fixtures legitimately reference concrete hosts.
"""

from __future__ import annotations

from pathlib import Path

import superclaw.environment as environment

# Env-divergent host that may appear ONLY in environment.py. Substring "clawhunt.store"
# also covers "staging.clawhunt.store".
_FORBIDDEN_HOST = "clawhunt.store"

_OWNER_FILE = Path(environment.__file__).resolve()
# .../packages/superclaw/src/superclaw/environment.py → repo root is parents[4].
_REPO_ROOT = _OWNER_FILE.parents[4]

# Surfaces whose production source must resolve service URLs through the kernel /
# the backend, never hardcode an environment-specific host.
_SCANNED_ROOTS = (
    _REPO_ROOT / "packages" / "superclaw" / "src" / "superclaw",
    _REPO_ROOT / "apps" / "web" / "src",
    _REPO_ROOT / "apps" / "desktop" / "src-tauri" / "src",
    _REPO_ROOT / "apps" / "api",
)
_SCANNED_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".rs"}


def _is_test_path(path: Path) -> bool:
    parts = {p.lower() for p in path.parts}
    return (
        "tests" in parts
        or "test" in parts
        or "__tests__" in parts
        or path.name.startswith("test_")
        or ".test." in path.name
        or path.stem.endswith("_test")
    )


def test_clawhunt_hosts_centralized_in_environment_module():
    offenders: list[str] = []
    for root in _SCANNED_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in _SCANNED_SUFFIXES:
                continue
            if path.resolve() == _OWNER_FILE or _is_test_path(path):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            # Rust co-locates unit tests in the source file under `#[cfg(test)]`;
            # those test fixtures legitimately reference concrete hosts. Scan only
            # the production portion (everything before the first test module).
            if path.suffix == ".rs":
                text = text.split("#[cfg(test)]", 1)[0]
            for lineno, line in enumerate(text.splitlines(), start=1):
                if _FORBIDDEN_HOST in line:
                    offenders.append(f"{path.relative_to(_REPO_ROOT)}:{lineno}: {line.strip()}")
    assert not offenders, (
        "Environment-specific ClawHunt host found outside superclaw.environment "
        "(resolve through clawhunt_base_url()/CLAWHUNT_BASE_URLS in the kernel, or the "
        "backend-provided base_url on the client):\n" + "\n".join(offenders)
    )


def test_env_example_does_not_pin_environment_divergent_urls():
    """.env.example must not ACTIVELY set the per-environment service URLs. An explicit
    value always wins over the kernel's per-environment resolution, so an active entry
    here would pin every environment (including a staging build) to it and defeat the
    baked defaults. They may appear only as commented examples."""
    env_example = _REPO_ROOT / ".env.example"
    text = env_example.read_text(encoding="utf-8")
    guarded = {"CLAWHUNT_BASE_URL", "SUPERCLAW_RELAY_BASE_URL"}
    offenders: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        if key.strip() in guarded and value.strip():
            offenders.append(f".env.example:{lineno}: {stripped}")
    assert not offenders, (
        ".env.example must leave per-environment URLs empty (commented examples only); "
        "an active value pins all environments to it:\n" + "\n".join(offenders)
    )


def test_environment_module_actually_owns_the_hosts():
    """Guard against the guard silently passing because the hosts moved/renamed."""
    text = _OWNER_FILE.read_text(encoding="utf-8")
    assert "staging.clawhunt.store" in text
    assert _FORBIDDEN_HOST in text
