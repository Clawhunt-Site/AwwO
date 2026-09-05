from __future__ import annotations

import inspect
import json

from superclaw import plugin_ports


def test_plugin_extension_ports_map_every_section_13_port():
    ports = plugin_ports.DEFAULT_PLUGIN_EXTENSION_PORTS

    assert [port.port_id for port in ports] == [
        "cloud-client",
        "signature-verifier",
        "entitlement",
        "sandbox",
        "mcp-proxy",
        "bounty-ingestion",
        "developer-submission",
        "credential-manager",
    ]
    assert [port.section for port in ports] == ["13.1", "13.2", "13.3", "13.4", "13.5", "13.6", "13.7", "13.8"]
    assert all(port.responsibilities for port in ports)


def test_plugin_extension_ports_reference_existing_protocol_classes():
    for port in plugin_ports.DEFAULT_PLUGIN_EXTENSION_PORTS:
        protocol = getattr(plugin_ports, port.protocol_name)

        assert getattr(protocol, "_is_protocol", False) is True
        assert getattr(protocol, "_is_runtime_protocol", False) is True


def test_cloud_client_port_covers_registry_governance_and_evidence_upload():
    methods = _public_protocol_methods(plugin_ports.PluginCloudClientPort)

    assert {
        "list_registry_plugins",
        "get_registry_plugin_version",
        "get_download_reference",
        "sync_entitlements",
        "sync_revocations",
        "get_runtime_policy",
        "upload_evidence_summary",
    } <= methods


def test_signature_verifier_port_covers_trust_chain_contract():
    assert {
        "load_root_keys",
        "verify_digest",
        "verify_signature",
        "trust_chain_report",
    } <= _public_protocol_methods(plugin_ports.PluginSignatureVerifierPort)


def test_runtime_ports_keep_security_boundaries_explicit():
    assert {
        "validate_token",
        "decide_offline_grace",
        "check_license_scope",
        "denial_reason",
    } <= _public_protocol_methods(plugin_ports.PluginEntitlementPort)
    assert {
        "launch",
        "apply_permissions",
        "enforce_timeout",
        "capture_exit_status",
    } <= _public_protocol_methods(plugin_ports.PluginSandboxPort)
    assert {
        "project_tool_registry",
        "authorize_request",
        "route_tool_call",
        "normalize_output",
        "record_invocation_evidence",
        "shape_model_safe_error",
    } <= _public_protocol_methods(plugin_ports.PluginMcpProxyPort)


def test_ecosystem_ports_cover_bounty_developer_and_credential_boundaries():
    assert {
        "import_delivery_manifest",
        "import_evidence_references",
        "map_delivery_metadata",
        "validate_reusable_wrapper",
        "assign_revenue_attribution",
        "create_package_build_job",
    } <= _public_protocol_methods(plugin_ports.PluginBountyIngestionPort)
    assert {
        "validate_package_metadata",
        "link_developer_identity",
        "start_verification_job",
        "review_status",
    } <= _public_protocol_methods(plugin_ports.PluginDeveloperSubmissionPort)
    assert {
        "load_configuration_policy",
        "prompt_required_secret",
        "store_secret",
        "inject_secret",
        "delete_secret",
        "rotate_secret",
        "missing_configuration_error",
    } <= _public_protocol_methods(plugin_ports.PluginCredentialManagerPort)


def test_plugin_extension_port_payload_is_sanitized_contract_only():
    payload = plugin_ports.plugin_extension_port_contract_payload()
    encoded = json.dumps(payload)

    assert payload["runtime_behavior_changed"] is False
    assert payload["production_adapters_included"] is False
    assert len(payload["ports"]) == 8
    assert "token_value" not in encoded
    assert "private_key" not in encoded
    assert "secret_value" not in encoded
    assert "/Users/" not in encoded
    assert "plugin_dirs" not in encoded


def _public_protocol_methods(protocol: type) -> set[str]:
    return {
        name
        for name, value in inspect.getmembers(protocol)
        if not name.startswith("_") and inspect.isfunction(value)
    }
