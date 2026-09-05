from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence, runtime_checkable


@dataclass(frozen=True)
class PluginExtensionPortSpec:
    port_id: str
    section: str
    protocol_name: str
    responsibilities: tuple[str, ...]


@runtime_checkable
class PluginCloudClientPort(Protocol):
    def list_registry_plugins(self, filters: Mapping[str, str] | None = None) -> Sequence[Mapping[str, Any]]: ...

    def get_registry_plugin_version(self, plugin_id: str, version: str) -> Mapping[str, Any]: ...

    def get_download_reference(self, plugin_id: str, version: str) -> Mapping[str, Any]: ...

    def sync_entitlements(self, device_id: str, runtime_version: str, plugin_ids: Sequence[str]) -> Mapping[str, Any]: ...

    def sync_revocations(self) -> Mapping[str, Any]: ...

    def get_runtime_policy(self) -> Mapping[str, Any]: ...

    def upload_evidence_summary(self, summary: Mapping[str, Any]) -> Mapping[str, Any]: ...


@runtime_checkable
class PluginSignatureVerifierPort(Protocol):
    def load_root_keys(self) -> Sequence[str]: ...

    def verify_digest(self, package_path: Path, expected_digest: str) -> bool: ...

    def verify_signature(self, package_path: Path, public_key: str, signature: str) -> bool: ...

    def trust_chain_report(self, package_path: Path) -> Mapping[str, Any]: ...


@runtime_checkable
class PluginEntitlementPort(Protocol):
    def validate_token(self, token_ref: str, plugin_id: str, version: str) -> Mapping[str, Any]: ...

    def decide_offline_grace(self, entitlement: Mapping[str, Any], policy: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def check_license_scope(self, entitlement: Mapping[str, Any], plugin_id: str, version: str) -> Mapping[str, Any]: ...

    def denial_reason(self, decision: Mapping[str, Any]) -> str | None: ...


@runtime_checkable
class PluginSandboxPort(Protocol):
    def launch(self, command: Sequence[str], policy: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def apply_permissions(self, process_ref: str, policy: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def enforce_timeout(self, process_ref: str, timeout_ms: int) -> Mapping[str, Any]: ...

    def capture_exit_status(self, process_ref: str) -> Mapping[str, Any]: ...


@runtime_checkable
class PluginMcpProxyPort(Protocol):
    def project_tool_registry(self, package_ref: str) -> Mapping[str, Any]: ...

    def authorize_request(self, tool_name: str, request: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def route_tool_call(self, tool_name: str, request: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def normalize_output(self, output: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def record_invocation_evidence(self, record: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def shape_model_safe_error(self, error: Exception | Mapping[str, Any]) -> Mapping[str, Any]: ...


@runtime_checkable
class PluginBountyIngestionPort(Protocol):
    def import_delivery_manifest(self, delivery_root: Path) -> Mapping[str, Any]: ...

    def import_evidence_references(self, delivery_root: Path) -> Sequence[Mapping[str, Any]]: ...

    def map_delivery_metadata(self, manifest: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def validate_reusable_wrapper(self, delivery_root: Path) -> Mapping[str, Any]: ...

    def assign_revenue_attribution(self, manifest: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def create_package_build_job(self, delivery_root: Path) -> Mapping[str, Any]: ...


@runtime_checkable
class PluginDeveloperSubmissionPort(Protocol):
    def validate_package_metadata(self, package_path: Path) -> Mapping[str, Any]: ...

    def link_developer_identity(self, developer_id: str, package_metadata: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def start_verification_job(self, package_path: Path, developer_ref: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def review_status(self, submission_id: str) -> Mapping[str, Any]: ...


@runtime_checkable
class PluginCredentialManagerPort(Protocol):
    def load_configuration_policy(self, plugin_id: str, version: str) -> Mapping[str, Any]: ...

    def prompt_required_secret(self, plugin_id: str, secret_name: str) -> Mapping[str, Any]: ...

    def store_secret(self, plugin_id: str, secret_name: str, value_ref: str) -> Mapping[str, Any]: ...

    def inject_secret(self, sidecar_ref: str, plugin_id: str, secret_name: str) -> Mapping[str, Any]: ...

    def delete_secret(self, plugin_id: str, secret_name: str) -> Mapping[str, Any]: ...

    def rotate_secret(self, plugin_id: str, secret_name: str, value_ref: str) -> Mapping[str, Any]: ...

    def missing_configuration_error(self, plugin_id: str, missing_names: Sequence[str]) -> Mapping[str, Any]: ...


DEFAULT_PLUGIN_EXTENSION_PORTS: tuple[PluginExtensionPortSpec, ...] = (
    PluginExtensionPortSpec(
        port_id="cloud-client",
        section="13.1",
        protocol_name="PluginCloudClientPort",
        responsibilities=(
            "registry lookup",
            "entitlement sync",
            "package download",
            "revocation sync",
            "policy sync",
            "evidence upload",
        ),
    ),
    PluginExtensionPortSpec(
        port_id="signature-verifier",
        section="13.2",
        protocol_name="PluginSignatureVerifierPort",
        responsibilities=("root key loading", "digest verification", "signature verification", "trust chain reporting"),
    ),
    PluginExtensionPortSpec(
        port_id="entitlement",
        section="13.3",
        protocol_name="PluginEntitlementPort",
        responsibilities=("token validation", "offline grace decision", "license scope check", "denial reason reporting"),
    ),
    PluginExtensionPortSpec(
        port_id="sandbox",
        section="13.4",
        protocol_name="PluginSandboxPort",
        responsibilities=("process launch", "permission application", "network and filesystem policy", "timeout and kill", "exit status capture"),
    ),
    PluginExtensionPortSpec(
        port_id="mcp-proxy",
        section="13.5",
        protocol_name="PluginMcpProxyPort",
        responsibilities=("tool registry projection", "request authorization", "routing to sidecar", "output normalization", "evidence capture", "model-safe error shaping"),
    ),
    PluginExtensionPortSpec(
        port_id="bounty-ingestion",
        section="13.6",
        protocol_name="PluginBountyIngestionPort",
        responsibilities=(
            "importing ClawHunt delivery manifests",
            "importing EvidenceBundle references",
            "mapping delivery metadata to plugin metadata",
            "rejecting task-specific deliveries",
            "validating wrapper files and mcp/server.json",
            "assigning revenue attribution",
            "creating package build jobs",
        ),
    ),
    PluginExtensionPortSpec(
        port_id="developer-submission",
        section="13.7",
        protocol_name="PluginDeveloperSubmissionPort",
        responsibilities=("validating uploaded package metadata", "linking developer identity", "starting verification jobs", "exposing review status"),
    ),
    PluginExtensionPortSpec(
        port_id="credential-manager",
        section="13.8",
        protocol_name="PluginCredentialManagerPort",
        responsibilities=(
            "loading plugin configuration policy",
            "prompting for required user secrets outside the underlying agent",
            "storing secrets in local secure storage",
            "injecting approved secrets into sidecars",
            "deleting and rotating plugin secrets",
            "reporting missing configuration without exposing values",
        ),
    ),
)


def plugin_extension_port_contract_payload() -> dict[str, Any]:
    return {
        "schema_version": "0.1.0",
        "ports": [
            {
                "port_id": port.port_id,
                "section": port.section,
                "protocol_name": port.protocol_name,
                "responsibilities": list(port.responsibilities),
            }
            for port in DEFAULT_PLUGIN_EXTENSION_PORTS
        ],
        "runtime_behavior_changed": False,
        "production_adapters_included": False,
    }
