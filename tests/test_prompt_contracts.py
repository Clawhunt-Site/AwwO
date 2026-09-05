"""Tests for the PromptEnvelope IR contract (Prompt Envelope roadmap P1).

P1 is inert and additive: it defines the layered prompt contract but nothing
projects it yet. Coverage is therefore the contract's own invariants — the
six-layer static->dynamic order, intrinsic (unforgeable) authority, and
fail-closed construction — plus the conservative system-channel defaults the
runtime spec inherits.
"""

import dataclasses
from typing import get_args

import pytest

from superclaw.local_agent_runtime import (
    api_agent_runtime_spec,
    app_server_runtime_spec,
    cli_agent_runtime_spec,
)
from superclaw.prompt_contracts import (
    DEFAULT_SYSTEM_CHANNEL,
    LAYER_AUTHORITY,
    LAYER_ORDER,
    SYSTEM_CHANNELS,
    LayerAuthority,
    PromptContractError,
    PromptEnvelope,
    PromptLayer,
    PromptLayerKind,
    PromptProjectionCapabilities,
    SystemChannel,
    prompt_layer,
)


def _full_layers() -> list[PromptLayer]:
    return [prompt_layer(kind) for kind in LAYER_ORDER]


# --- layer authority is intrinsic, not caller-supplied ---------------------


def test_authority_is_derived_from_kind():
    assert prompt_layer(PromptLayerKind.GOVERNANCE_CORE).authority is LayerAuthority.KERNEL_FROZEN
    assert prompt_layer(PromptLayerKind.AGENT_CHARTER).authority is LayerAuthority.KERNEL_PER_RUN
    assert prompt_layer(PromptLayerKind.TASK_CONTEXT).authority is LayerAuthority.KERNEL
    # Only the current user turn is surface-writable.
    assert prompt_layer(PromptLayerKind.USER_TURN).authority is LayerAuthority.SURFACE_USER


def test_every_kind_maps_to_exactly_one_authority():
    assert set(LAYER_AUTHORITY) == set(PromptLayerKind)


def test_authority_cannot_be_forged_via_constructor():
    # authority is init=False, so a caller physically cannot pass one.
    with pytest.raises(TypeError):
        PromptLayer(  # type: ignore[call-arg]
            kind=PromptLayerKind.GOVERNANCE_CORE,
            authority=LayerAuthority.SURFACE_USER,
        )


def test_layer_is_frozen():
    layer = prompt_layer(PromptLayerKind.USER_TURN, "hi")
    with pytest.raises(dataclasses.FrozenInstanceError):
        layer.content = "tampered"  # type: ignore[misc]


# --- envelope ordering, dedup, subsetting ----------------------------------


def test_full_envelope_preserves_canonical_order():
    env = PromptEnvelope.build(_full_layers())
    assert env.kinds() == LAYER_ORDER
    assert env.get(PromptLayerKind.GOVERNANCE_CORE).authority is LayerAuthority.KERNEL_FROZEN


def test_subset_envelope_is_allowed():
    env = PromptEnvelope.build(
        [
            prompt_layer(PromptLayerKind.GOVERNANCE_CORE, "no payments"),
            prompt_layer(PromptLayerKind.USER_TURN, "do it"),
        ]
    )
    assert env.kinds() == (PromptLayerKind.GOVERNANCE_CORE, PromptLayerKind.USER_TURN)
    assert env.get(PromptLayerKind.TOOL_CONTRACT) is None


def test_out_of_order_layers_fail_closed():
    with pytest.raises(PromptContractError):
        PromptEnvelope.build(
            [
                prompt_layer(PromptLayerKind.USER_TURN, "u"),
                prompt_layer(PromptLayerKind.GOVERNANCE_CORE, "g"),
            ]
        )


def test_duplicate_layers_fail_closed():
    with pytest.raises(PromptContractError):
        PromptEnvelope.build(
            [
                prompt_layer(PromptLayerKind.GOVERNANCE_CORE),
                prompt_layer(PromptLayerKind.GOVERNANCE_CORE),
            ]
        )


def test_non_layer_element_fails_closed():
    with pytest.raises(PromptContractError):
        PromptEnvelope.build(["not a layer"])  # type: ignore[list-item]


def test_envelope_is_frozen_and_normalizes_to_tuple():
    env = PromptEnvelope.build(_full_layers())
    assert isinstance(env.layers, tuple)
    with pytest.raises(dataclasses.FrozenInstanceError):
        env.layers = ()  # type: ignore[misc]


# --- layer content + kind validation ---------------------------------------


def test_non_string_content_fails_closed():
    with pytest.raises(PromptContractError):
        prompt_layer(PromptLayerKind.GOVERNANCE_CORE, content=123)  # type: ignore[arg-type]


def test_raw_string_kind_fails_closed():
    # A bare string (not the enum) must be rejected so callers cannot smuggle an
    # unknown layer kind past authority derivation.
    with pytest.raises(PromptContractError):
        PromptLayer(kind="governance_core")  # type: ignore[arg-type]


def test_projection_flags_default_false_and_are_recorded():
    plain = prompt_layer(PromptLayerKind.TOOL_CONTRACT)
    assert plain.requires_native_system is False
    assert plain.requires_tool_projection is False
    flagged = prompt_layer(
        PromptLayerKind.AGENT_CHARTER,
        "sensitive role",
        requires_native_system=True,
    )
    assert flagged.requires_native_system is True


# --- runtime spec inherits conservative system-channel defaults ------------


def test_runtime_specs_default_to_flatten_only():
    assert DEFAULT_SYSTEM_CHANNEL == "flatten_only"
    cli = cli_agent_runtime_spec(backend="codex", executable="/bin/codex")
    app = app_server_runtime_spec(
        backend="codex-app-server", executable="/bin/codex", api_mode="codex_app_server"
    )
    api = api_agent_runtime_spec(
        backend="anthropic-agent",
        model="m",
        provider="p",
        api_mode="anthropic_messages",
        transport="anthropic_messages",
    )
    for spec in (cli, app, api):
        data = spec.to_dict()
        assert data["system_channel"] == "flatten_only"
        assert data["per_call_system"] is False
        assert data["append_preserves_default"] is False
        assert data["override_replaces_default"] is False
        assert data["supports_cache_control"] is False
        assert data["supports_tool_schema"] is False


def test_runtime_spec_can_declare_a_richer_channel():
    spec = cli_agent_runtime_spec(
        backend="claude",
        executable="/bin/claude",
        system_channel="native_cli_append",
        per_call_system=True,
        append_preserves_default=True,
        supports_cache_control=True,
    )
    data = spec.to_dict()
    assert data["system_channel"] == "native_cli_append"
    assert data["per_call_system"] is True
    assert data["append_preserves_default"] is True
    assert data["supports_cache_control"] is True


def test_unknown_system_channel_fails_closed():
    with pytest.raises(PromptContractError):
        cli_agent_runtime_spec(
            backend="claude",
            executable="/bin/claude",
            system_channel="native-structured",  # hyphen typo, not a valid channel
        )


def test_system_channels_stay_in_sync_with_literal():
    # Drift guard: the validation set and the SystemChannel Literal are two
    # declarations of the same thing; keep them aligned.
    assert set(get_args(SystemChannel)) == SYSTEM_CHANNELS
    assert DEFAULT_SYSTEM_CHANNEL in SYSTEM_CHANNELS


def test_projection_capabilities_from_runtime_mapping_are_validated():
    spec = api_agent_runtime_spec(
        backend="anthropic",
        model="claude",
        provider="anthropic",
        api_mode="anthropic_messages",
        transport="anthropic_messages",
        system_channel="native_structured",
        per_call_system=True,
        supports_cache_control=True,
        supports_tool_schema=True,
        notes=["native messages"],
    )

    capabilities = PromptProjectionCapabilities.from_mapping(spec.to_dict())

    assert capabilities.system_channel == "native_structured"
    assert capabilities.per_call_system is True
    assert capabilities.supports_cache_control is True
    assert capabilities.supports_tool_schema is True
    assert capabilities.backend == "anthropic"
    assert capabilities.notes == ("native messages",)


def test_projection_capabilities_reject_unknown_channel():
    with pytest.raises(PromptContractError):
        PromptProjectionCapabilities(system_channel="native-system")  # type: ignore[arg-type]


# --- hardening: read-only authority map, value-based lookup, iterable guard --


def test_layer_order_covers_every_kind_once():
    assert set(LAYER_ORDER) == set(PromptLayerKind)
    assert len(LAYER_ORDER) == len(PromptLayerKind)


def test_layer_authority_map_is_read_only():
    # The public authority map cannot be rebound to forge a layer's trust class.
    with pytest.raises(TypeError):
        LAYER_AUTHORITY[PromptLayerKind.GOVERNANCE_CORE] = LayerAuthority.SURFACE_USER  # type: ignore[index]


def test_get_matches_by_value_including_string_kind():
    env = PromptEnvelope.build([prompt_layer(PromptLayerKind.GOVERNANCE_CORE, "g")])
    assert env.get(PromptLayerKind.GOVERNANCE_CORE) is not None
    # PromptLayerKind is a str Enum; a bare string value matches by ==.
    assert env.get("governance_core") is not None  # type: ignore[arg-type]


def test_non_iterable_layers_fail_closed():
    with pytest.raises(PromptContractError):
        PromptEnvelope.build(None)  # type: ignore[arg-type]
    with pytest.raises(PromptContractError):
        PromptEnvelope(layers=None)  # type: ignore[arg-type]
