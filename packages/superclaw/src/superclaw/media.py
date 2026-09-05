from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Literal

import httpx

from superclaw.environment import (
    DEFAULT_RUNNINGHUB_LOCAL_BASE_URL,
    runninghub_base_url as _configured_runninghub_base_url,
    superclaw_data_path,
)
from superclaw.secrets_scan import redact_secrets


MEDIA_SCHEMA_VERSION = "0.1.0"
RUNNINGHUB_DEFAULT_BASE_URL = DEFAULT_RUNNINGHUB_LOCAL_BASE_URL
RUNNINGHUB_API_KEYS_ENV = "SUPERCLAW_RUNNINGHUB_API_KEYS"
RUNNINGHUB_API_KEY_ENV = "SUPERCLAW_RUNNINGHUB_API_KEY"
RUNNINGHUB_BASE_URL_ENV = "SUPERCLAW_RUNNINGHUB_BASE_URL"
RUNNINGHUB_TEMPLATES_ENV = "SUPERCLAW_RUNNINGHUB_MEDIA_TEMPLATES_JSON"
RUNNINGHUB_ARTIFACT_ROOT_ENV = "SUPERCLAW_MEDIA_ARTIFACT_ROOT"
RUNNINGHUB_UPLOAD_MAX_BYTES = 30 * 1024 * 1024
RUNNINGHUB_SKU_DETAIL_PATH = "/api/sku/detail"

_KEY_CURSOR = 0
_KEY_LOCK = threading.Lock()
_ARTIFACT_ID_RE = re.compile(r"^runninghub_media_[a-f0-9]{12}$")


class RunningHubMediaError(ValueError):
    """Raised for operator-correctable RunningHub media request issues."""


@dataclass(frozen=True)
class RunningHubMediaTemplate:
    id: str
    label: str
    webapp_id: str
    docs_url: str
    output_kind: Literal["image", "video"]
    required_inputs: tuple[str, ...] = ()
    mode: Literal["standard-api", "ai-app", "quick-ai-app"] = "standard-api"
    api_detail_id: str | None = None
    endpoint_path: str | None = None
    quick_create_code: str | None = None
    default_inputs: dict[str, Any] = field(default_factory=dict)
    input_map: dict[str, str] = field(default_factory=dict)
    default_nodes: tuple[dict[str, Any], ...] = ()
    field_map: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True)
class RunningHubMediaRequest:
    template: str
    prompt: str | None = None
    negative_prompt: str | None = None
    source_image: str | None = None
    source_video: str | None = None
    node_info_list: tuple[dict[str, Any], ...] = ()
    inputs: dict[str, Any] = field(default_factory=dict)
    dry_run: bool = False
    artifact_dir: Path | None = None
    timeout_seconds: float = 60.0


@dataclass(frozen=True)
class RunningHubMediaUploadRequest:
    file_path: Path
    file_type: str = "input"
    dry_run: bool = False
    artifact_dir: Path | None = None
    timeout_seconds: float = 60.0


@dataclass(frozen=True)
class RunningHubMediaRenderRequest:
    generation: RunningHubMediaRequest
    wait_for_outputs: bool = True
    max_polls: int = 24
    poll_interval_seconds: float = 5.0
    query_timeout_seconds: float = 30.0


DEFAULT_RUNNINGHUB_MEDIA_TEMPLATES: dict[str, RunningHubMediaTemplate] = {
    "text_to_image": RunningHubMediaTemplate(
        id="text_to_image",
        label="RunningHub text to image",
        webapp_id="2004543847939751938",
        docs_url="https://www.runninghub.ai/call-api/api-detail/2004543847939751938",
        output_kind="image",
        required_inputs=("prompt",),
        api_detail_id="2004543847939751938",
        endpoint_path="/rhart-image-n-pro/text-to-image",
        default_inputs={"aspectRatio": "9:16", "resolution": "1k"},
    ),
    "image_to_image": RunningHubMediaTemplate(
        id="image_to_image",
        label="RunningHub image to image",
        webapp_id="2004543527918551041",
        docs_url="https://www.runninghub.ai/call-api/api-detail/2004543527918551041",
        output_kind="image",
        required_inputs=("prompt", "source_image"),
        api_detail_id="2004543527918551041",
        endpoint_path="/rhart-image-n-pro/edit",
        default_inputs={"aspectRatio": "3:4", "resolution": "1k"},
        input_map={"source_image": "imageUrls"},
    ),
    "image_to_video": RunningHubMediaTemplate(
        id="image_to_video",
        label="RunningHub image to video",
        webapp_id="2012067220412493826",
        docs_url="https://www.runninghub.ai/call-api/api-detail/2012067220412493826",
        output_kind="video",
        required_inputs=("prompt", "source_image"),
        api_detail_id="2012067220412493826",
        endpoint_path="/rhart-video-s-official/image-to-video-pro",
        default_inputs={"resolution": "720p", "duration": "4"},
        input_map={"source_image": "imageUrl"},
    ),
    "text_to_video": RunningHubMediaTemplate(
        id="text_to_video",
        label="RunningHub text to video",
        webapp_id="2012065966164602881",
        docs_url="https://www.runninghub.ai/call-api/api-detail/2012065966164602881",
        output_kind="video",
        required_inputs=("prompt",),
        api_detail_id="2012065966164602881",
        endpoint_path="/rhart-video-s-official/text-to-video-pro",
        default_inputs={"size": "720x1280", "duration": "12"},
    ),
}


def runninghub_base_url() -> str:
    return _configured_runninghub_base_url()


def _runninghub_base_url_or_none() -> str | None:
    """Resolve the RunningHub base URL for read-only status/catalog payloads without
    raising. ``runninghub_base_url()`` is fail-closed (raises in a distributed bundle when
    SUPERCLAW_RUNNINGHUB_BASE_URL is unset), which is correct for actual generation but
    must NOT turn a routine status/diagnostic probe into a 500 — these surfaces report the
    unconfigured state (``base_url: null``) instead. Generation call sites keep using the
    raising resolver so they fail loudly when truly unconfigured.
    """
    try:
        return runninghub_base_url()
    except RuntimeError:
        return None


def runninghub_artifact_root() -> Path:
    configured = os.environ.get(RUNNINGHUB_ARTIFACT_ROOT_ENV, "").strip()
    return Path(configured) if configured else superclaw_data_path("artifacts", "media")


def runninghub_api_keys() -> list[str]:
    values: list[str] = []
    for raw in (os.environ.get(RUNNINGHUB_API_KEYS_ENV, ""), os.environ.get(RUNNINGHUB_API_KEY_ENV, "")):
        for item in re.split(r"[\s,;]+", raw.strip()):
            if item and item not in values:
                values.append(item)
    return values


def _next_api_key(keys: list[str]) -> tuple[str, int]:
    global _KEY_CURSOR
    if not keys:
        raise RunningHubMediaError(f"{RUNNINGHUB_API_KEYS_ENV} is not configured")
    with _KEY_LOCK:
        index = _KEY_CURSOR % len(keys)
        _KEY_CURSOR += 1
    return keys[index], index


def _parse_template_overrides() -> dict[str, Any]:
    raw = os.environ.get(RUNNINGHUB_TEMPLATES_ENV, "").strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RunningHubMediaError(f"{RUNNINGHUB_TEMPLATES_ENV} must be valid JSON") from exc
    if not isinstance(payload, dict):
        raise RunningHubMediaError(f"{RUNNINGHUB_TEMPLATES_ENV} must be a JSON object")
    return payload


def runninghub_media_templates() -> dict[str, RunningHubMediaTemplate]:
    templates = dict(DEFAULT_RUNNINGHUB_MEDIA_TEMPLATES)
    overrides = _parse_template_overrides()
    for template_id, raw_override in overrides.items():
        if template_id not in templates or not isinstance(raw_override, dict):
            continue
        current = templates[template_id]
        data = {
            "webapp_id": str(raw_override.get("webapp_id", raw_override.get("webappId", current.webapp_id))),
            "api_detail_id": raw_override.get("api_detail_id", raw_override.get("apiDetailId", current.api_detail_id)),
            "endpoint_path": raw_override.get("endpoint_path", raw_override.get("endpointPath", current.endpoint_path)),
            "quick_create_code": raw_override.get("quick_create_code", raw_override.get("quickCreateCode", current.quick_create_code)),
            "default_inputs": dict(raw_override.get("default_inputs", raw_override.get("defaultInputs", current.default_inputs)) or {}),
            "input_map": dict(raw_override.get("input_map", raw_override.get("inputMap", current.input_map)) or {}),
            "default_nodes": tuple(raw_override.get("nodes", raw_override.get("node_info_list", current.default_nodes)) or ()),
            "field_map": dict(raw_override.get("field_map", raw_override.get("fieldMap", current.field_map)) or {}),
        }
        mode = str(raw_override.get("mode", current.mode))
        if mode not in {"standard-api", "ai-app", "quick-ai-app"}:
            raise RunningHubMediaError(f"{template_id}.mode must be standard-api, ai-app, or quick-ai-app")
        templates[template_id] = replace(current, mode=mode, **data)
    return templates


def _template_payload(template: RunningHubMediaTemplate) -> dict[str, Any]:
    payload = asdict(template)
    payload["required_inputs"] = list(template.required_inputs)
    payload["default_inputs_configured"] = sorted(template.default_inputs)
    payload["input_map_configured"] = sorted(template.input_map)
    payload["default_nodes_configured"] = bool(template.default_nodes)
    payload["field_map_configured"] = sorted(template.field_map)
    payload.pop("default_inputs", None)
    payload.pop("input_map", None)
    payload.pop("default_nodes", None)
    payload.pop("field_map", None)
    return payload


def runninghub_media_catalog() -> dict[str, Any]:
    templates = runninghub_media_templates()
    return {
        "schema_version": MEDIA_SCHEMA_VERSION,
        "provider": "runninghub",
        "base_url": _runninghub_base_url_or_none(),
        "templates": [_template_payload(template) for template in templates.values()],
        "node_contract": {
            "request_override": "Standard API templates use built-in endpoint fields; ai-app templates still accept node_info_list from the RunningHub API detail page.",
            "env_override": RUNNINGHUB_TEMPLATES_ENV,
            "standard_api_query": "/openapi/v2/query",
        },
        "endpoints": {
            "submit": "/api/media/generate",
            "upload": "/api/media/upload",
            "task_status": "/api/media/task-status",
            "task_outputs": "/api/media/outputs",
            "status": "/api/media/status",
            "templates": "/api/media/templates",
        },
    }


def runninghub_media_status() -> dict[str, Any]:
    keys = runninghub_api_keys()
    return {
        "schema_version": MEDIA_SCHEMA_VERSION,
        "provider": "runninghub",
        "configured": bool(keys),
        "configured_key_count": len(keys),
        "key_rotation": "round_robin",
        "base_url": _runninghub_base_url_or_none(),
        "artifact_root": str(runninghub_artifact_root()),
        "api_key_env": RUNNINGHUB_API_KEYS_ENV,
        "single_key_env": RUNNINGHUB_API_KEY_ENV,
        "templates_env": RUNNINGHUB_TEMPLATES_ENV,
        "templates": runninghub_media_catalog()["templates"],
        "secret_policy": "API keys are read from process environment only and are never persisted in request artifacts.",
    }


def _doctor_check(
    name: str,
    passed: bool,
    detail: str,
    *,
    severity: Literal["info", "warning", "error"] = "error",
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "passed": bool(passed),
        "severity": severity,
        "detail": detail,
        "data": data or {},
    }


def _normalize_runninghub_endpoint_path(value: str | None) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if text.startswith("/openapi/v2/"):
        text = text[len("/openapi/v2") :]
    elif text == "/openapi/v2":
        text = ""
    return text if text.startswith("/") else f"/{text}"


def _runninghub_template_contract_checks(templates: dict[str, RunningHubMediaTemplate]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for template_id, expected in DEFAULT_RUNNINGHUB_MEDIA_TEMPLATES.items():
        template = templates.get(template_id)
        if template is None:
            checks.append(_doctor_check(f"template.{template_id}.present", False, "built-in template is missing"))
            continue
        checks.append(
            _doctor_check(
                f"template.{template_id}.standard_api_contract",
                template.mode == "standard-api"
                and template.api_detail_id == expected.api_detail_id
                and _normalize_runninghub_endpoint_path(template.endpoint_path) == expected.endpoint_path
                and bool(template.docs_url),
                "standard API detail id, endpoint path, and docs URL match the built-in contract",
                data={
                    "template_id": template_id,
                    "mode": template.mode,
                    "api_detail_id": template.api_detail_id,
                    "endpoint_path": template.endpoint_path,
                    "expected_endpoint_path": expected.endpoint_path,
                    "docs_url": template.docs_url,
                },
            )
        )
        missing_required = [
            name
            for name in expected.required_inputs
            if name not in template.required_inputs and template.input_map.get(name) is None
        ]
        checks.append(
            _doctor_check(
                f"template.{template_id}.required_inputs",
                not missing_required,
                "required logical inputs are represented by direct inputs or input_map",
                data={
                    "template_id": template_id,
                    "required_inputs": list(template.required_inputs),
                    "input_map_configured": sorted(template.input_map),
                    "missing": missing_required,
                },
            )
        )
    return checks


def _runninghub_secret_safety_check(keys: list[str]) -> dict[str, Any]:
    status_text = json.dumps(runninghub_media_status(), ensure_ascii=False, sort_keys=True)
    catalog_text = json.dumps(runninghub_media_catalog(), ensure_ascii=False, sort_keys=True)
    leaked = [key for key in keys if key and (key in status_text or key in catalog_text)]
    return _doctor_check(
        "secret_safety.status_and_catalog_redaction",
        not leaked,
        "status and catalog payloads expose key counts and configured state without key values",
        data={"configured_key_count": len(keys), "leaked_key_count": len(leaked)},
    )


def _runninghub_live_sku_checks(
    templates: dict[str, RunningHubMediaTemplate],
    *,
    client: httpx.Client,
    timeout_seconds: float,
    keys: list[str],
) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    endpoint = _runninghub_path(RUNNINGHUB_SKU_DETAIL_PATH)
    for template_id, expected in DEFAULT_RUNNINGHUB_MEDIA_TEMPLATES.items():
        template = templates.get(template_id)
        if template is None or not template.api_detail_id:
            checks.append(_doctor_check(f"live_sku.{template_id}", False, "template or API detail id is missing"))
            continue
        started = time.perf_counter()
        try:
            response = client.post(endpoint, json={"id": template.api_detail_id})
            elapsed_ms = int(round((time.perf_counter() - started) * 1000))
            try:
                payload = response.json()
            except ValueError:
                payload = {"raw_text": response.text}
            sanitized_payload = _sanitize_for_artifact(payload, keys)
            if response.status_code >= 400:
                checks.append(
                    _doctor_check(
                        f"live_sku.{template_id}",
                        False,
                        f"RunningHub SKU detail returned HTTP {response.status_code}",
                        data={"api_detail_id": template.api_detail_id, "elapsed_ms": elapsed_ms, "response": sanitized_payload},
                    )
                )
                continue
            if not isinstance(payload, dict) or payload.get("code") not in (0, "0", None):
                checks.append(
                    _doctor_check(
                        f"live_sku.{template_id}",
                        False,
                        "RunningHub SKU detail returned a non-success code",
                        data={"api_detail_id": template.api_detail_id, "elapsed_ms": elapsed_ms, "response": sanitized_payload},
                    )
                )
                continue
            data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            remote_endpoint = _normalize_runninghub_endpoint_path(str(data.get("rhEndpoint") or ""))
            expected_endpoint = _normalize_runninghub_endpoint_path(expected.endpoint_path)
            checks.append(
                _doctor_check(
                    f"live_sku.{template_id}",
                    remote_endpoint == expected_endpoint,
                    "RunningHub SKU detail id resolves to the expected standard API endpoint",
                    data={
                        "api_detail_id": template.api_detail_id,
                        "remote_endpoint": remote_endpoint,
                        "expected_endpoint": expected_endpoint,
                        "remote_name": data.get("nameEn") or data.get("name") or "",
                        "elapsed_ms": elapsed_ms,
                    },
                )
            )
        except Exception as exc:  # pragma: no cover - exercised through operator live diagnostics.
            checks.append(
                _doctor_check(
                    f"live_sku.{template_id}",
                    False,
                    f"RunningHub SKU detail check failed: {type(exc).__name__}",
                    data={"api_detail_id": template.api_detail_id, "timeout_seconds": timeout_seconds},
                )
            )
    return checks


def runninghub_media_doctor(
    *,
    live_metadata: bool = False,
    timeout_seconds: float = 20.0,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    if timeout_seconds <= 0 or timeout_seconds > 120:
        raise RunningHubMediaError("timeout_seconds must be between 0 and 120")
    keys = runninghub_api_keys()
    templates = runninghub_media_templates()
    # Resolve once (non-raising): a frozen bundle without SUPERCLAW_RUNNINGHUB_BASE_URL
    # yields None. Live generation is impossible without it, so it gates both the live
    # SKU probe and the readiness verdict below.
    base_url = _runninghub_base_url_or_none()
    checks: list[dict[str, Any]] = [
        _doctor_check(
            "api_keys.configured",
            bool(keys),
            "RunningHub live generation keys are configured in process environment",
            data={"configured_key_count": len(keys), "env": RUNNINGHUB_API_KEYS_ENV},
        ),
        _doctor_check(
            "key_rotation.round_robin",
            len(keys) >= 2,
            "two or more keys are available for round-robin rotation",
            severity="warning",
            data={"configured_key_count": len(keys), "rotation": "round_robin"},
        ),
        _runninghub_secret_safety_check(keys),
        *_runninghub_template_contract_checks(templates),
        _doctor_check(
            "query_endpoint.standard_api",
            True,
            "standard API task polling uses /openapi/v2/query and extracts results[].url",
            severity="info",
            data={"endpoint": "/openapi/v2/query"},
        ),
        _doctor_check(
            "credit_safety.live_metadata",
            True,
            "doctor live metadata checks use SKU detail only and never submit generation tasks",
            severity="info",
            data={"live_metadata": live_metadata, "consumes_generation_credits": False},
        ),
    ]
    if live_metadata:
        # Fail-closed (a distributed bundle without SUPERCLAW_RUNNINGHUB_BASE_URL) must not
        # turn this read-only diagnostic into a 500: the live SKU probe needs a base URL, so
        # when it is unresolvable we record a skipped check instead of letting the underlying
        # _runninghub_path() -> runninghub_base_url() raise. Generation paths still fail loud.
        if base_url is None:
            checks.append(
                _doctor_check(
                    "live_sku.skipped",
                    False,
                    f"{RUNNINGHUB_BASE_URL_ENV} is not configured; live SKU metadata check skipped",
                    severity="warning",
                    data={"base_url": None},
                )
            )
        else:
            owns_client = client is None
            active_client = client or httpx.Client(timeout=timeout_seconds)
            try:
                checks.extend(
                    _runninghub_live_sku_checks(
                        templates,
                        client=active_client,
                        timeout_seconds=timeout_seconds,
                        keys=keys,
                    )
                )
            finally:
                if owns_client:
                    active_client.close()
    passed = sum(1 for check in checks if check["passed"])
    failed = sum(1 for check in checks if not check["passed"] and check["severity"] == "error")
    warnings = sum(1 for check in checks if not check["passed"] and check["severity"] == "warning")
    payload = {
        "schema_version": MEDIA_SCHEMA_VERSION,
        "provider": "runninghub",
        "ok": failed == 0,
        "checked_at": datetime.now(UTC).isoformat(),
        "live_metadata": live_metadata,
        "base_url": base_url,
        "configured_key_count": len(keys),
        "ready_for_live_generation": bool(keys) and base_url is not None and failed == 0,
        "summary": {
            "check_count": len(checks),
            "passed": passed,
            "failed": failed,
            "warnings": warnings,
        },
        "checks": checks,
        "secret_policy": "API keys are reported only by count/configured state and are redacted from diagnostics.",
    }
    return _sanitize_for_artifact(payload, keys)


def _request_inputs(request: RunningHubMediaRequest) -> dict[str, Any]:
    merged = dict(request.inputs)
    for key, value in {
        "prompt": request.prompt,
        "negative_prompt": request.negative_prompt,
        "source_image": request.source_image,
        "source_video": request.source_video,
    }.items():
        if value is not None and key not in merged:
            merged[key] = value
    return merged


def _replace_placeholders(value: Any, inputs: dict[str, Any]) -> Any:
    if isinstance(value, str):
        resolved = value
        for key, replacement in inputs.items():
            if replacement is None:
                continue
            resolved = resolved.replace(f"{{{{{key}}}}}", str(replacement))
        return resolved
    if isinstance(value, list):
        return [_replace_placeholders(item, inputs) for item in value]
    if isinstance(value, dict):
        return {str(key): _replace_placeholders(item, inputs) for key, item in value.items()}
    return value


def _build_nodes_from_field_map(template: RunningHubMediaTemplate, inputs: dict[str, Any]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for input_name, descriptor in template.field_map.items():
        if input_name not in inputs or inputs[input_name] in (None, ""):
            continue
        if not isinstance(descriptor, dict):
            raise RunningHubMediaError(f"{template.id}.field_map.{input_name} must be an object")
        node = dict(descriptor)
        node.setdefault("fieldName", input_name)
        node["fieldValue"] = inputs[input_name]
        nodes.append(node)
    return nodes


def _build_node_info_list(template: RunningHubMediaTemplate, request: RunningHubMediaRequest) -> list[dict[str, Any]]:
    if request.node_info_list:
        return [dict(item) for item in request.node_info_list]
    inputs = _request_inputs(request)
    mapped = _build_nodes_from_field_map(template, inputs)
    if mapped:
        return mapped
    if template.default_nodes:
        return [_replace_placeholders(dict(item), inputs) for item in template.default_nodes]
    if request.dry_run:
        return [
            {
                "nodeName": "SuperClawDryRun",
                "fieldName": key,
                "fieldType": "STRING",
                "fieldValue": value,
            }
            for key, value in inputs.items()
            if value not in (None, "")
        ]
    raise RunningHubMediaError(
        "node_info_list is required for live RunningHub media generation until this template's node ids are configured"
    )


def _build_standard_api_payload(template: RunningHubMediaTemplate, request: RunningHubMediaRequest) -> dict[str, Any]:
    inputs = _request_inputs(request)
    payload: dict[str, Any] = dict(template.default_inputs)
    for key, value in inputs.items():
        if value in (None, ""):
            continue
        payload_key = template.input_map.get(key, key)
        payload[payload_key] = value
    return payload


def _has_required_input(template: RunningHubMediaTemplate, inputs: dict[str, Any], name: str) -> bool:
    if inputs.get(name) not in (None, ""):
        return True
    mapped_name = template.input_map.get(name)
    return bool(mapped_name and inputs.get(mapped_name) not in (None, ""))


def _validate_request(template: RunningHubMediaTemplate, request: RunningHubMediaRequest) -> None:
    inputs = _request_inputs(request)
    missing = [name for name in template.required_inputs if not _has_required_input(template, inputs, name)]
    if missing:
        raise RunningHubMediaError(f"{template.id} missing required inputs: {', '.join(missing)}")
    if request.timeout_seconds <= 0 or request.timeout_seconds > 600:
        raise RunningHubMediaError("timeout_seconds must be between 0 and 600")


def _redact_known_secret_values(text: str, secret_values: list[str]) -> str:
    redacted = text
    for secret in secret_values:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redact_secrets(redacted)


def _sanitize_for_artifact(value: Any, secret_values: list[str]) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            lowered = key_text.lower().replace("-", "_")
            if lowered in {"apikey", "api_key", "authorization", "auth_token", "access_token", "secret"}:
                sanitized[key_text] = "[REDACTED]"
            else:
                sanitized[key_text] = _sanitize_for_artifact(item, secret_values)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_for_artifact(item, secret_values) for item in value]
    if isinstance(value, str):
        return _redact_known_secret_values(value, secret_values)
    return value


def _extract_runninghub_output_urls(value: Any) -> list[str]:
    output_keys = {"fileUrl", "file_url", "outputUrl", "output_url", "downloadUrl", "download_url", "url"}
    urls: list[str] = []
    seen: set[str] = set()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for key, item in node.items():
                if key in output_keys and isinstance(item, str) and item.startswith(("http://", "https://")):
                    if item not in seen:
                        seen.add(item)
                        urls.append(item)
                else:
                    visit(item)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(value)
    return urls


def _artifact_path(artifact_id: str, artifact_dir: Path | None = None) -> Path:
    if not _ARTIFACT_ID_RE.fullmatch(artifact_id):
        raise RunningHubMediaError("invalid media artifact id")
    root = (artifact_dir or runninghub_artifact_root()).resolve()
    return root / f"{artifact_id}.json"


def _write_media_artifact(artifact_id: str, payload: dict[str, Any], artifact_dir: Path | None = None) -> Path:
    path = _artifact_path(artifact_id, artifact_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def _runninghub_endpoint(template: RunningHubMediaTemplate) -> str:
    if template.mode == "standard-api":
        if not template.endpoint_path:
            raise RunningHubMediaError(f"{template.id} standard-api template requires endpoint_path")
        endpoint_path = template.endpoint_path if template.endpoint_path.startswith("/") else f"/{template.endpoint_path}"
        return f"{runninghub_base_url()}/openapi/v2{endpoint_path}"
    path = "/task/openapi/quick-ai-app/run" if template.mode == "quick-ai-app" else "/task/openapi/ai-app/run"
    return f"{runninghub_base_url()}{path}"


def _runninghub_path(path: str) -> str:
    return f"{runninghub_base_url()}{path}"


def _extract_task_fields(response_payload: Any) -> dict[str, Any]:
    if not isinstance(response_payload, dict):
        return {}
    data = response_payload.get("data")
    if not isinstance(data, dict):
        data = response_payload
    return {
        "task_id": data.get("taskId") or data.get("task_id"),
        "client_id": data.get("clientId") or data.get("client_id"),
        "task_status": data.get("taskStatus") or data.get("task_status") or data.get("status") or response_payload.get("taskStatus") or response_payload.get("status"),
    }


def _raise_for_runninghub_error(response_payload: Any, *, action: str, keys: list[str]) -> None:
    if not isinstance(response_payload, dict) or "code" not in response_payload:
        return
    code = response_payload.get("code")
    if code in (0, "0", None):
        return
    sanitized_error = _sanitize_for_artifact(response_payload, keys)
    raise RunningHubMediaError(f"RunningHub {action} failed: {sanitized_error}")


def submit_runninghub_media_task(
    request: RunningHubMediaRequest,
    *,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    templates = runninghub_media_templates()
    template = templates.get(request.template)
    if template is None:
        raise RunningHubMediaError(f"unsupported media template: {request.template}")
    _validate_request(template, request)
    keys = runninghub_api_keys()
    endpoint = _runninghub_endpoint(template)
    artifact_id = f"runninghub_media_{uuid.uuid4().hex[:12]}"
    started_at = datetime.now(UTC).isoformat()
    live_key: str | None = None
    selected_key_index: int | None = None
    if template.mode == "standard-api":
        request_body = _build_standard_api_payload(template, request)
    else:
        node_info_list = _build_node_info_list(template, request)
        request_body = {
            "webappId": template.webapp_id,
            "nodeInfoList": node_info_list,
        }
    if template.mode == "quick-ai-app":
        if not template.quick_create_code:
            raise RunningHubMediaError("quick-ai-app templates require quick_create_code")
        request_body["quickCreateCode"] = template.quick_create_code
    if not request.dry_run:
        live_key, selected_key_index = _next_api_key(keys)
        if template.mode != "standard-api":
            request_body["apiKey"] = live_key
    response_payload: Any
    elapsed_ms: int
    status: str
    if request.dry_run:
        elapsed_ms = 0
        status = "dry_run"
        response_payload = {
            "dry_run": True,
            "detail": "RunningHub task was not submitted.",
        }
    else:
        started = time.perf_counter()
        owns_client = client is None
        active_client = client or httpx.Client(timeout=request.timeout_seconds)
        try:
            response = active_client.post(
                endpoint,
                json=request_body,
                headers={"Authorization": f"Bearer {live_key}"},
            )
            elapsed_ms = int(round((time.perf_counter() - started) * 1000))
            try:
                response_payload = response.json()
            except ValueError:
                response_payload = {"raw_text": response.text}
            if response.status_code >= 400:
                sanitized_error = _sanitize_for_artifact(response_payload, keys)
                raise RunningHubMediaError(f"RunningHub request failed: HTTP {response.status_code} {sanitized_error}")
            _raise_for_runninghub_error(response_payload, action="request", keys=keys)
            status = "submitted"
        finally:
            if owns_client:
                active_client.close()
    sanitized_request = _sanitize_for_artifact(request_body, keys)
    sanitized_response = _sanitize_for_artifact(response_payload, keys)
    task_fields = _extract_task_fields(response_payload)
    artifact_payload = {
        "schema_version": MEDIA_SCHEMA_VERSION,
        "artifact_id": artifact_id,
        "created_at": started_at,
        "provider": "runninghub",
        "status": status,
        "template": _template_payload(template),
        "endpoint": endpoint,
        "request": sanitized_request,
        "response": sanitized_response,
        "duration_ms": elapsed_ms,
        "key_rotation": {
            "configured_key_count": len(keys),
            "selected_key_index": selected_key_index,
        },
        "secret_policy": "Secrets are redacted before artifact persistence.",
    }
    artifact_path = _write_media_artifact(artifact_id, artifact_payload, request.artifact_dir)
    result = {
        "ok": True,
        "schema_version": MEDIA_SCHEMA_VERSION,
        "provider": "runninghub",
        "status": status,
        "template": _template_payload(template),
        "endpoint": endpoint,
        "artifact_id": artifact_id,
        "artifact_path": str(artifact_path),
        "artifact_url": f"/api/media/artifacts/{artifact_id}",
        "task_id": task_fields.get("task_id"),
        "client_id": task_fields.get("client_id"),
        "task_status": task_fields.get("task_status"),
        "response": sanitized_response,
        "key_rotation": {
            "configured_key_count": len(keys),
            "selected_key_index": selected_key_index,
        },
    }
    return _sanitize_for_artifact(result, keys)


def upload_runninghub_media_file(
    request: RunningHubMediaUploadRequest,
    *,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    if request.timeout_seconds <= 0 or request.timeout_seconds > 600:
        raise RunningHubMediaError("timeout_seconds must be between 0 and 600")
    file_path = request.file_path.expanduser().resolve()
    if not file_path.exists() or not file_path.is_file():
        raise RunningHubMediaError("upload file does not exist")
    file_size = file_path.stat().st_size
    if file_size > RUNNINGHUB_UPLOAD_MAX_BYTES:
        raise RunningHubMediaError("upload file exceeds RunningHub 30MB limit")
    keys = runninghub_api_keys()
    artifact_id = f"runninghub_media_{uuid.uuid4().hex[:12]}"
    endpoint = _runninghub_path("/task/openapi/upload")
    started_at = datetime.now(UTC).isoformat()
    selected_key_index: int | None = None
    response_payload: Any
    elapsed_ms: int
    status: str
    if request.dry_run:
        elapsed_ms = 0
        status = "upload_dry_run"
        response_payload = {
            "dry_run": True,
            "data": {
                "fileName": file_path.name,
                "fileType": request.file_type,
                "size": file_size,
            },
        }
    else:
        live_key, selected_key_index = _next_api_key(keys)
        started = time.perf_counter()
        owns_client = client is None
        active_client = client or httpx.Client(timeout=request.timeout_seconds)
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        try:
            with file_path.open("rb") as handle:
                response = active_client.post(
                    endpoint,
                    data={"apiKey": live_key, "fileType": request.file_type},
                    files={"file": (file_path.name, handle, content_type)},
                    headers={"Authorization": f"Bearer {live_key}"},
                )
            elapsed_ms = int(round((time.perf_counter() - started) * 1000))
            try:
                response_payload = response.json()
            except ValueError:
                response_payload = {"raw_text": response.text}
            if response.status_code >= 400:
                sanitized_error = _sanitize_for_artifact(response_payload, keys)
                raise RunningHubMediaError(f"RunningHub upload failed: HTTP {response.status_code} {sanitized_error}")
            _raise_for_runninghub_error(response_payload, action="upload", keys=keys)
            status = "uploaded"
        finally:
            if owns_client:
                active_client.close()
    sanitized_response = _sanitize_for_artifact(response_payload, keys)
    data = response_payload.get("data") if isinstance(response_payload, dict) else None
    file_name = None
    if isinstance(data, dict):
        file_name = data.get("fileName") or data.get("filename")
    artifact_payload = {
        "schema_version": MEDIA_SCHEMA_VERSION,
        "artifact_id": artifact_id,
        "created_at": started_at,
        "provider": "runninghub",
        "status": status,
        "endpoint": endpoint,
        "upload": {
            "file_name": file_path.name,
            "file_size": file_size,
            "file_type": request.file_type,
        },
        "response": sanitized_response,
        "duration_ms": elapsed_ms,
        "key_rotation": {
            "configured_key_count": len(keys),
            "selected_key_index": selected_key_index,
        },
        "secret_policy": "Secrets are redacted before artifact persistence.",
    }
    artifact_path = _write_media_artifact(artifact_id, artifact_payload, request.artifact_dir)
    return _sanitize_for_artifact(
        {
            "ok": True,
            "schema_version": MEDIA_SCHEMA_VERSION,
            "provider": "runninghub",
            "status": status,
            "endpoint": endpoint,
            "artifact_id": artifact_id,
            "artifact_path": str(artifact_path),
            "artifact_url": f"/api/media/artifacts/{artifact_id}",
            "file_name": file_name,
            "response": sanitized_response,
            "key_rotation": {
                "configured_key_count": len(keys),
                "selected_key_index": selected_key_index,
            },
        },
        keys,
    )


def query_runninghub_media_task(
    task_id: str,
    *,
    query: Literal["status", "outputs"],
    mode: Literal["standard-api", "webapp"] = "standard-api",
    artifact_dir: Path | None = None,
    timeout_seconds: float = 30.0,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    safe_task_id = str(task_id).strip()
    if not safe_task_id:
        raise RunningHubMediaError("task_id is required")
    if timeout_seconds <= 0 or timeout_seconds > 600:
        raise RunningHubMediaError("timeout_seconds must be between 0 and 600")
    if query not in {"status", "outputs"}:
        raise RunningHubMediaError("query must be status or outputs")
    if mode not in {"standard-api", "webapp"}:
        raise RunningHubMediaError("mode must be standard-api or webapp")
    keys = runninghub_api_keys()
    live_key, selected_key_index = _next_api_key(keys)
    endpoint = _runninghub_path("/openapi/v2/query" if mode == "standard-api" else ("/task/openapi/status" if query == "status" else "/task/openapi/outputs"))
    owns_client = client is None
    active_client = client or httpx.Client(timeout=timeout_seconds)
    request_body = {"taskId": safe_task_id} if mode == "standard-api" else {"apiKey": live_key, "taskId": safe_task_id}
    artifact_id = f"runninghub_media_{uuid.uuid4().hex[:12]}"
    started_at = datetime.now(UTC).isoformat()
    started = time.perf_counter()
    try:
        response = active_client.post(
            endpoint,
            json=request_body,
            headers={"Authorization": f"Bearer {live_key}"},
        )
        elapsed_ms = int(round((time.perf_counter() - started) * 1000))
        try:
            response_payload = response.json()
        except ValueError:
            response_payload = {"raw_text": response.text}
        if response.status_code >= 400:
            sanitized_error = _sanitize_for_artifact(response_payload, keys)
            raise RunningHubMediaError(f"RunningHub {query} query failed: HTTP {response.status_code} {sanitized_error}")
        _raise_for_runninghub_error(response_payload, action=f"{query} query", keys=keys)
    finally:
        if owns_client:
            active_client.close()
    sanitized_response = _sanitize_for_artifact(response_payload, keys)
    output_urls = _extract_runninghub_output_urls(sanitized_response) if query == "outputs" else []
    artifact_payload = {
        "schema_version": MEDIA_SCHEMA_VERSION,
        "artifact_id": artifact_id,
        "created_at": started_at,
        "provider": "runninghub",
        "status": f"{query}_queried",
        "query": query,
        "mode": mode,
        "endpoint": endpoint,
        "request": _sanitize_for_artifact(request_body, keys),
        "response": sanitized_response,
        "output_urls": output_urls,
        "duration_ms": elapsed_ms,
        "key_rotation": {
            "configured_key_count": len(keys),
            "selected_key_index": selected_key_index,
        },
        "secret_policy": "Secrets are redacted before artifact persistence.",
    }
    artifact_path = _write_media_artifact(artifact_id, artifact_payload, artifact_dir)
    return _sanitize_for_artifact(
        {
            "ok": True,
            "schema_version": MEDIA_SCHEMA_VERSION,
            "provider": "runninghub",
            "status": f"{query}_queried",
            "query": query,
            "mode": mode,
            "endpoint": endpoint,
            "task_id": safe_task_id,
            "artifact_id": artifact_id,
            "artifact_path": str(artifact_path),
            "artifact_url": f"/api/media/artifacts/{artifact_id}",
            "response": sanitized_response,
            "output_urls": output_urls,
            "key_rotation": {
                "configured_key_count": len(keys),
                "selected_key_index": selected_key_index,
            },
        },
        keys,
    )


def render_runninghub_media_task(
    request: RunningHubMediaRenderRequest,
    *,
    client: httpx.Client | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    if request.max_polls < 0 or request.max_polls > 240:
        raise RunningHubMediaError("max_polls must be between 0 and 240")
    if request.poll_interval_seconds < 0 or request.poll_interval_seconds > 3600:
        raise RunningHubMediaError("poll_interval_seconds must be between 0 and 3600")
    if request.query_timeout_seconds <= 0 or request.query_timeout_seconds > 600:
        raise RunningHubMediaError("query_timeout_seconds must be between 0 and 600")

    steps: list[dict[str, Any]] = []
    generation = submit_runninghub_media_task(request.generation, client=client)
    steps.append({"step": "generate", "attempt": 1, "result": generation})

    task_id = generation.get("task_id")
    template_payload = generation.get("template") if isinstance(generation.get("template"), dict) else {}
    query_mode: Literal["standard-api", "webapp"] = "standard-api" if template_payload.get("mode") == "standard-api" else "webapp"
    output_urls: list[str] = []
    final_status = str(generation.get("status") or "submitted")
    timed_out = False
    if request.generation.dry_run:
        final_status = "dry_run"
    elif not task_id:
        final_status = "submitted_without_task_id"
    elif request.wait_for_outputs and request.max_polls > 0:
        final_status = "outputs_pending"
        for attempt in range(1, request.max_polls + 1):
            status_result = query_runninghub_media_task(
                str(task_id),
                query="status",
                mode=query_mode,
                artifact_dir=request.generation.artifact_dir,
                timeout_seconds=request.query_timeout_seconds,
                client=client,
            )
            steps.append({"step": "status", "attempt": attempt, "result": status_result})
            outputs_result = query_runninghub_media_task(
                str(task_id),
                query="outputs",
                mode=query_mode,
                artifact_dir=request.generation.artifact_dir,
                timeout_seconds=request.query_timeout_seconds,
                client=client,
            )
            steps.append({"step": "outputs", "attempt": attempt, "result": outputs_result})
            output_urls = [str(item) for item in outputs_result.get("output_urls", [])]
            if output_urls:
                final_status = "outputs_ready"
                break
            if attempt < request.max_polls and request.poll_interval_seconds:
                sleep(request.poll_interval_seconds)
        else:
            timed_out = True
    elif request.wait_for_outputs:
        final_status = "outputs_pending"
        timed_out = True

    artifacts = [
        {
            "step": step["step"],
            "attempt": step["attempt"],
            "artifact_id": step["result"].get("artifact_id"),
            "artifact_url": step["result"].get("artifact_url"),
            "artifact_path": step["result"].get("artifact_path"),
            "run_artifact_url": step["result"].get("run_artifact_url"),
            "status": step["result"].get("status"),
            "query": step["result"].get("query"),
        }
        for step in steps
    ]
    keys = runninghub_api_keys()
    return _sanitize_for_artifact(
        {
            "ok": final_status in {"dry_run", "submitted", "outputs_ready", "submitted_without_task_id"},
            "schema_version": MEDIA_SCHEMA_VERSION,
            "provider": "runninghub",
            "status": final_status,
            "task_id": task_id,
            "template": generation.get("template"),
            "output_urls": output_urls,
            "timed_out": timed_out,
            "wait_for_outputs": request.wait_for_outputs,
            "max_polls": request.max_polls,
            "poll_interval_seconds": request.poll_interval_seconds,
            "steps": steps,
            "artifacts": artifacts,
            "artifact_count": len(artifacts),
        },
        keys,
    )


def load_runninghub_media_artifact(artifact_id: str, artifact_dir: Path | None = None) -> dict[str, Any]:
    path = _artifact_path(artifact_id, artifact_dir)
    if not path.exists():
        raise FileNotFoundError(artifact_id)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("artifact_id") != artifact_id:
        raise RunningHubMediaError("media artifact id mismatch")
    return _sanitize_for_artifact(payload, runninghub_api_keys())
