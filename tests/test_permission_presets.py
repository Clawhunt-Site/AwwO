"""Registry-wide conformance: every registered backend must declare its
permission preset mapping. This is the enforcement mechanism that makes
declaring the ask/allow -> native-mode mapping a hard requirement for every
new Agent Runtime backend (docs/permission-mode-framework.md)."""

from __future__ import annotations

from superclaw.backends import WorkerLimits, _RealToolExecution, default_backends
from superclaw.permissions import REQUIRED_PRESETS, check_preset_map
from superclaw.runtime import PermissionPolicy


def _defining_class(backend, method_name):
    for klass in type(backend).__mro__:
        if method_name in klass.__dict__:
            return klass
    return None


def test_every_backend_declares_valid_presets():
    for name, backend in default_backends().items():
        presets = backend.permission_presets()
        # raises ValueError on any gap (missing preset / empty native / empty note)
        check_preset_map(name, presets)
        assert frozenset(presets) == REQUIRED_PRESETS


def test_presets_not_silently_inherited():
    """A new backend must declare its OWN mapping. Allowed owners: the concrete
    backend class itself, or the sanctioned _RealToolExecution mixin (shared by
    the in-process B-class backends). Anything inheriting from a generic base is
    a missing declaration."""
    for name, backend in default_backends().items():
        owner = _defining_class(backend, "permission_presets")
        assert owner is not None, f"{name}: permission_presets() not found"
        assert owner is type(backend) or owner is _RealToolExecution, (
            f"{name}: permission_presets() must be defined on the concrete backend "
            f"class (or the _RealToolExecution mixin), not silently inherited from "
            f"{owner.__name__}"
        )


def test_interactive_flag_is_honest():
    """No backend prompts a HUMAN per-action today. Even the Codex app-server's
    approval callbacks are auto-answered by SuperClaw policy (no human sees a
    prompt), so interactive must be False everywhere until an approval queue
    actually surfaces requests to a person."""
    for name, backend in default_backends().items():
        for preset, realization in backend.permission_presets().items():
            assert realization.interactive is False, f"{name}/{preset}"


def test_preset_driven_mappings_actually_differ():
    """Semantic conformance: when a backend claims both presets are preset-driven,
    the two native realizations must actually differ; backends without a native
    gate must say so explicitly via preset_driven=False (no bogus no-op mappings
    passing as real ones)."""
    for name, backend in default_backends().items():
        presets = backend.permission_presets()
        ask, allow = presets["ask"], presets["allow"]
        if ask.preset_driven and allow.preset_driven:
            assert ask.native != allow.native, (
                f"{name}: both presets claim preset_driven but map to the same "
                f"native realization — declare preset_driven=False or differentiate"
            )


def test_in_process_tools_all_classified():
    """Every tool handled by the B-class _exec_tool must be classified as either
    mutating or read-only; an unclassified new tool would silently bypass the
    read-only posture."""
    import inspect
    import re

    from superclaw.permissions import _MUTATING_TOOLS, _READONLY_TOOLS

    source = inspect.getsource(_RealToolExecution._exec_tool)
    handled = set(re.findall(r'name == "(\w+)"', source))
    assert handled, "could not introspect _exec_tool handled tools"
    unclassified = handled - _MUTATING_TOOLS - _READONLY_TOOLS
    assert not unclassified, f"unclassified in-process tools: {sorted(unclassified)}"


def test_readonly_posture_denies_delegate_before_broker(tmp_path):
    runner = _RealToolExecution()
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        permission_policy=PermissionPolicy(mode="plan"),
    )

    result = runner._exec_tool(
        "delegate",
        {"subtask": "inspect the repo"},
        limits,
        deadline=9999999999.0,
    )

    assert "read-only mode" in result
    assert "delegate" in result
