# SuperClaw Cloud Plugin Ecosystem Framework

Status: draft v0.1

This document defines the executable framework for SuperClaw Cloud plugins. It is a development specification, not a marketing roadmap. A feature is not accepted unless it can be verified against the acceptance criteria in this document.

The normative local plugin configuration requirements are specified in
`docs/plugin-configuration-protocol-requirements.md`. This framework references
that document for setting descriptors, secret descriptors, desktop rendering,
local API validation, and fail-closed behavior.

Normative terms:

- MUST means the requirement is mandatory for a compliant implementation.
- MUST NOT means the behavior is forbidden.
- SHOULD means the behavior is the default best practice; deviations require a documented reason.
- MAY means the behavior is optional and must not be required by other components.

## 1. Purpose

SuperClaw Cloud should turn agent capabilities into verified, signed, paid, and reusable plugin packages that can run through the local SuperClaw runtime.

Plugins can enter the ecosystem through two paths:

- ClawHunt bounty delivery ingestion: a completed delivery passes the ClawHunt Delivery Protocol and is converted into a plugin.
- Developer direct upload: a developer submits a plugin package to SuperClaw Cloud and it passes the same verification, signing, entitlement, and governance pipeline.

> **双轨注记（2026-06-10）**：本框架治理的是 **Plugin 轨**（受治理 MCP 能力：签名 + 授权 + 撤销 + 未来登录态/加密分发）。**Skill 是独立工件，不进本框架的运行时管线**：商城分发的 skill 只做分发时治理（来源标识 + install 一次性验签 + official/reviewed/community 分级标签 + executable 警告），运行时全文同步进 runtime 原生 skill 目录、零治理零 MCP。需要加密、授权或运行时门的能力一律以 Plugin 形态分发。详见 `docs/clawwork-two-track-dev-plan.md` D1/D2 与 PR‑2。

The public marketplace promise is:

- users get special agent capabilities they can install and pay for;
- developers get a distribution and revenue channel;
- SuperClaw provides the runtime, policy, signing, evidence, and trust layer.

## 2. Non-Negotiable Principles

- ClawHunt Delivery Protocol remains the canonical delivery and acceptance standard.
- SuperClaw plugins are runtime capability packages, not a replacement for ClawHunt problem submission payloads.
- Underlying agents such as Codex, Claude Code, Hermes, and OpenClaw must not load commercial plugin directories directly.
- Underlying agents may only see tool names, descriptions, schemas, inputs, and outputs exposed through the SuperClaw MCP proxy.
- Plugin source, license checks, signing chain, entitlement tokens, internal secrets, and binary layout must not be included in prompts, skills, or tool descriptions.
- Every paid plugin invocation must be attributable, policy-checked, and recorded as evidence.
- Missing signature, missing entitlement, revoked plugin status, or sandbox violation must fail closed.
- Client-side DRM is not a security boundary. Binary packaging is allowed for distribution and casual IP protection, but trust must come from signing, entitlements, sandboxing, and cloud revocation.

## 3. Architecture

```text
SuperClaw Cloud
  Registry
  Entitlement service
  Signing service
  Verification pipeline
  Revocation list
  Usage and dispute evidence intake

Local SuperClaw Runtime
  Plugin manager
  Signature verifier
  Entitlement cache
  Sandbox launcher
  MCP policy proxy
  Evidence recorder

Plugin Sandbox
  Signed plugin sidecar process
  MCP server over stdio or restricted local IPC
  No direct access to underlying agent

Underlying Agent Runtime
  Codex CLI
  Claude Code
  Hermes
  OpenClaw
  Anthropic backend
```

### 3.1 SuperClaw Cloud Responsibilities

- Store immutable plugin artifacts and metadata.
- Run static and dynamic verification before publication.
- Sign accepted packages and publish signature metadata.
- Issue short-lived entitlement tokens for purchased or granted plugins.
- Publish revocation and deprecation state.
- Receive usage, evidence summaries, and dispute records.
- Maintain developer payout, ownership, and provenance records.

### 3.2 Local SuperClaw Runtime Responsibilities

- Download plugin artifacts from SuperClaw Cloud.
- Verify package hash and cloud signature before caching.
- Refuse execution when entitlement is missing, expired, or revoked.
- Start each plugin in a separate sandboxed process.
- Expose a single SuperClaw MCP proxy to underlying agents.
- Enforce permission policy before routing tool calls.
- Record inputs, outputs, errors, timing, entitlement id, package digest, and sandbox verdicts into EvidenceBundle-compatible records.

### 3.3 Plugin Sandbox Responsibilities

- Run the plugin implementation.
- Expose only declared MCP tools.
- Receive tool calls only from the SuperClaw MCP proxy.
- Avoid returning secrets, source code, license tokens, or internal algorithms in tool responses.
- Emit structured operational events to SuperClaw when needed.

### 3.4 Underlying Agent Responsibilities

Underlying agents are consumers, not trusted plugin hosts.

They may:

- connect to the SuperClaw MCP proxy;
- call tools exposed by SuperClaw;
- receive sanitized tool results.

They must not:

- load commercial plugin source directories;
- receive plugin entitlement tokens;
- receive plugin signing metadata beyond non-sensitive provenance ids;
- invoke plugin binaries directly;
- read plugin cache directories.

## 4. Package Standard

The SuperClaw plugin package is a signed archive or single executable bundle with a manifest at the root.

Recommended extension:

```text
<plugin-id>-<version>.scplug
```

The package must contain:

```text
superclaw-plugin.json
bin/
skills/
mcp/
evidence-fixtures/
tests/
LICENSE
README.md
```

Binary-only packages are allowed if they still include the manifest, declared tool schemas, tests, and evidence fixtures.

### 4.0 Developer Quickstart Contract

The developer-facing package workflow MUST be simple enough to run without platform staff intervention.

Target v1 workflow:

```bash
superclaw plugin init com.example.repo-scanner
cd com.example.repo-scanner
superclaw plugin dev --tool repo_scan --json '{"path":"."}'
superclaw plugin pack .
superclaw plugin verify dist/com.example.repo-scanner-0.1.0.scplug
superclaw plugin submit dist/com.example.repo-scanner-0.1.0.scplug
```

The generated starter package MUST include:

```text
superclaw-plugin.json
bin/hello-plugin
skills/README.md
mcp/server.json
tests/smoke.sh
evidence-fixtures/smoke.json
README.md
LICENSE
```

The local validator MUST produce actionable errors. A developer should not need to inspect SuperClaw server logs to fix a manifest, permission, tool schema, or packaging issue.

### 4.1 Manifest

File: `superclaw-plugin.json`

Minimum shape:

```json
{
  "schema_version": "0.1.0",
  "id": "com.example.repo-scanner",
  "name": "Repository Scanner",
  "version": "0.1.0",
  "summary": "Scans a repository and returns a structured risk report.",
  "source": {
    "type": "developer_upload",
    "clawhunt_problem_id": null,
    "developer_id": "dev_123"
  },
  "runtime": {
    "type": "mcp_sidecar",
    "entrypoint": "bin/repo-scanner",
    "args": ["mcp"],
    "transport": "stdio",
    "mcp_protocol_versions": ["2025-06-18"],
    "platforms": ["darwin-arm64", "linux-x64"]
  },
  "tools": [
    {
      "name": "repo_scan",
      "description": "Scan a local repository path and produce a risk report.",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        },
        "required": ["path"]
      },
      "output_schema": {
        "type": "object",
        "properties": {
          "report_path": { "type": "string" },
          "finding_count": { "type": "integer" }
        },
        "required": ["report_path", "finding_count"]
      }
    }
  ],
  "permissions": {
    "filesystem": [
      {
        "mode": "read",
        "scope": "workspace"
      }
    ],
    "network": [],
    "environment": []
  },
  "configuration": {
    "secrets": [
      {
        "name": "GITHUB_TOKEN",
        "description": "GitHub token used only by the plugin sidecar.",
        "required": false,
        "inject_as": "env",
        "env_name": "GITHUB_TOKEN"
      }
    ],
    "settings": [
      {
        "name": "max_depth",
        "type": "integer",
        "description": "Maximum recursive repository scan depth.",
        "required": false,
        "validation": {
          "minimum": 1,
          "maximum": 5,
          "step": 1
        },
        "ui": {
          "control": "number",
          "label": "Maximum depth"
        },
        "default": 3
      }
    ]
  },
  "acceptance": {
    "level": "L2",
    "tests": ["tests/smoke.sh"],
    "evidence_fixtures": ["evidence-fixtures/smoke.json"],
    "latency_budget_ms": 10000
  },
  "limits": {
    "startup_timeout_ms": 3000,
    "tool_timeout_ms": 30000,
    "max_model_output_bytes": 65536,
    "max_evidence_bytes": 5242880,
    "max_memory_mb": 512
  },
  "resource_profile": {
    "latency_class": "standard",
    "expected_p95_latency_ms": 5000,
    "cpu_class": "medium",
    "memory_class": "medium",
    "io_profile": "filesystem_read"
  },
  "commerce": {
    "pricing_model": "free",
    "metering": "per_invocation"
  },
  "provenance": {
    "build_type": "developer_upload",
    "source_digest": null,
    "package_digest": "sha256:...",
    "signature": "ed25519:..."
  }
}
```

### 4.2 Required Manifest Rules

- `id` must be stable and globally unique.
- `version` must be SemVer.
- `runtime.type` must be `mcp_sidecar` in v1.
- `runtime.transport` must be `stdio` in v1 unless a specific local IPC exception is approved.
- `tools` must be declared statically. Dynamic tool injection is not allowed in v1.
- `permissions` must be explicit. Omitted permissions mean deny.
- `acceptance.level` must map to ClawHunt levels `L1`, `L2`, or `L3`.
- `limits` may be omitted, but omitted values must fall back to the platform defaults in Section 23.
- Local v1 schema validation rejects package `limits` above the Section 23
  default budgets. Certified-budget overrides are a future cloud governance
  path and are not accepted by unsigned local manifests.
- `resource_profile` is required when a package requests expensive local
  budgets: `acceptance.latency_budget_ms > 10000`,
  `limits.tool_timeout_ms > 10000`, `limits.max_model_output_bytes > 32768`,
  `limits.max_evidence_bytes > 1048576`, or `limits.max_memory_mb > 256`.
- `provenance.package_digest` must match the downloaded package bytes.
- `provenance.signature` must be verified before execution.

### 4.3 Normative Manifest Schema Contract

The repository MUST ship a machine-readable JSON Schema for `superclaw-plugin.json` before implementation work is considered complete.

Required schema file:

```text
schemas/superclaw-plugin.schema.json
```

Minimum normative constraints:

| Field | Required | Constraint |
|---|---:|---|
| `schema_version` | Yes | SemVer-compatible schema version |
| `id` | Yes | reverse-DNS string, stable across releases |
| `version` | Yes | SemVer plugin version |
| `logo` | No | package-local image path (`png`, `jpg`, `webp`, or `svg`) used only for UI presentation |
| `runtime.type` | Yes | enum: `mcp_sidecar` for v1 |
| `runtime.entrypoint` | Yes | relative path inside package; absolute paths rejected |
| `runtime.transport` | Yes | enum: `stdio` for v1 |
| `runtime.mcp_protocol_versions` | Yes | supported MCP protocol versions |
| `runtime.platforms` | Yes | non-empty list of supported platform triples |
| `tools[].name` | Yes | stable MCP tool name; unique in package |
| `tools[].input_schema` | Yes | JSON Schema object; no executable code |
| `tools[].output_schema` | Yes | JSON Schema object; proxy validates model-visible output against it |
| `permissions.filesystem[]` | No | enum mode plus declared scope; omitted means deny |
| `permissions.network[]` | No | explicit host allowlist; wildcard hosts rejected in v1 |
| `permissions.environment[]` | No | explicit variable names; secret-like names require review |
| `configuration.secrets[]` | No | user-provided secret descriptors; values are never stored in the manifest |
| `configuration.settings[]` | No | non-secret plugin settings; each descriptor requires name, type, description, and required; optional validation/ui hints drive desktop controls |
| `acceptance.tests[]` | Yes | relative paths to package-local executable tests |
| `acceptance.evidence_fixtures[]` | Yes | relative paths to expected evidence examples |
| `limits.tool_timeout_ms` | No | positive integer; cannot exceed platform maximum without certification |
| `limits.max_model_output_bytes` | No | positive integer; cannot exceed platform maximum |
| `resource_profile.latency_class` | Conditional | required for expensive packages; enum: interactive, standard, batch, long_running |
| `resource_profile.expected_p95_latency_ms` | Conditional | required for expensive packages; positive integer <= 30000 |
| `resource_profile.cpu_class` | Conditional | required for expensive packages; enum: low, medium, high |
| `resource_profile.memory_class` | Conditional | required for expensive packages; enum: low, medium, high |
| `resource_profile.io_profile` | Conditional | required for expensive packages; enum: none, filesystem_read, filesystem_write, network, mixed |
| `commerce.pricing_model` | Yes | enum controlled by platform commerce states |
| `provenance.package_digest` | Yes before signing | sha256 digest of final package bytes |
| `provenance.signature` | Yes before execution | platform signature over package digest |

Schema compatibility rules:

- Adding a new optional manifest field is a backward-compatible schema change.
- Removing a field, changing a field type, changing a tool name, changing a tool input schema, or changing a tool output schema is a breaking plugin interface change.
- Breaking plugin interface changes MUST require a new plugin version and fresh review.
- Tool schema changes MUST be replay-tested against existing evidence fixtures.
- Runtime-discovered tools MUST exactly match the static manifest; otherwise package verification fails.

Unstructured output rule:

- Plugins MUST still return a JSON object even when the useful content is unstructured text.
- The approved pattern is `{ "text": "...", "artifacts": [{ "uri": "...", "sha256": "..." }] }` with `text` size-limited by policy.
- Raw logs, HTML, markdown, or binary data MUST be returned as artifact references unless the declared output schema explicitly allows bounded text fields.
- The proxy MUST NOT forward raw stdout or arbitrary free-form sidecar output directly to the underlying agent.

## 5. Compatibility With Codex-Style Plugins

SuperClaw may generate a Codex-compatible package view, but the SuperClaw manifest remains the source of truth.

Codex-compatible generated paths:

```text
.codex-plugin/plugin.json
skills/<skill>/SKILL.md
.mcp.json
```

Rules:

- Codex-compatible files are derived artifacts.
- They must not contain SuperClaw entitlement tokens.
- They must not contain developer private source unless the package is explicitly open source.
- They must point to the SuperClaw MCP proxy or to a sandboxed sidecar approved by SuperClaw.
- Direct installation of commercial plugin directories into Codex is not accepted in v1.

Local Phase 2D implementation boundary:

- `superclaw plugin codex-view` generates a local derived view containing
  `.codex-plugin/plugin.json`, `.mcp.json`, and `skills/<tool>/SKILL.md`;
- `.mcp.json` points only to `python -m superclaw.plugin_mcp_proxy serve` with
  the plugin id and version;
- generated files must not include sidecar entrypoints, package cache paths,
  entitlement files, entitlement tokens, local secret names, MCP `env` blocks,
  `plugin_dirs`, or absolute plugin source paths;
- generated files are proxy stubs, not installable protected source bundles;
- the command does not install the view into Codex, start Codex, publish a
  marketplace artifact, or distribute private developer source.

## 6. Cloud Interfaces

These endpoints are framework ports. They may be implemented as REST, gRPC, or signed file sync, but the semantics must stay stable.

### 6.1 Registry

`GET /v1/plugins`

Returns searchable plugin metadata.

Required filters:

- `category`
- `runtime`
- `platform`
- `acceptance_level`
- `verified`
- `pricing_model`

`GET /v1/plugins/{plugin_id}/versions/{version}`

Returns version metadata, package digest, signature, compatibility, and entitlement requirements.

`GET /v1/plugins/{plugin_id}/versions/{version}/download`

Returns the signed package or a short-lived download URL.

### 6.2 Entitlements

`POST /v1/entitlements/sync`

Input:

```json
{
  "device_id": "device_...",
  "runtime_version": "0.1.0",
  "plugin_ids": ["com.example.repo-scanner"]
}
```

Output:

```json
{
  "entitlements": [
    {
      "plugin_id": "com.example.repo-scanner",
      "version_range": ">=0.1.0 <1.0.0",
      "subject": "user_123",
      "expires_at": "2026-06-01T00:00:00Z",
      "token": "jwt..."
    }
  ]
}
```

Rules:

- Tokens must be short-lived.
- Local runtime may cache tokens for offline grace only if policy permits.
- Offline grace is disabled by default and MUST have a hard maximum of 72 hours in v1.
- Offline grace MUST be disabled for revoked plugins, expired subscriptions, server-backed plugins that require live metering, and plugins marked high-risk by policy.
- A plugin cannot self-extend offline entitlement because entitlement state lives only in SuperClaw runtime.
- Plugins must not receive cloud root credentials.
- In v1, entitlement enforcement happens in the SuperClaw proxy, not inside the plugin.

### 6.3 Revocation

`GET /v1/plugins/revocations`

Returns revoked plugin ids, versions, signatures, and reason codes.

Required reason codes:

- `malware`
- `secret_leak`
- `license_violation`
- `broken_runtime`
- `fraud`
- `policy_violation`
- `developer_request`

The revocation contract is fail-closed: every synced revocation entry must
include one of these reason codes. Missing or unknown reasons must be rejected
by local fake-cloud sync and the `/v1/plugins/revocations` contract endpoint
instead of being accepted as ambiguous governance metadata.

Local runtime must block revoked plugin execution.

### 6.4 Evidence and Usage

`POST /v1/evidence/plugin-invocations`

Uploads invocation summaries for billing, quality scoring, and disputes.

Minimum payload:

```json
{
  "run_id": "run_...",
  "plugin_id": "com.example.repo-scanner",
  "plugin_version": "0.1.0",
  "package_digest": "sha256:...",
  "tool_name": "repo_scan",
  "started_at": "2026-05-31T00:00:00Z",
  "finished_at": "2026-05-31T00:00:01Z",
  "status": "ok",
  "entitlement_id": "ent_...",
  "input_digest": "sha256:...",
  "output_digest": "sha256:...",
  "evidence_artifact_id": "artifact_..."
}
```

Rules:

- Do not upload full user workspace content by default.
- Upload hashes and artifact references unless explicit user policy allows full evidence upload.
- Evidence used for disputes must be reconstructable from local EvidenceBundle artifacts.
- The invocation summary endpoint must fail closed when any minimum field is
  missing, digest fields are not `sha256:<64 hex>`, status is outside `ok`,
  `error`, `denied`, or `timeout`, or `finished_at` is earlier than
  `started_at`.

### 6.5 Policy Sync

`GET /v1/policies/runtime`

Returns cloud policy for sandbox limits, denied permissions, maximum tool result size, and minimum runtime version.

Local runtime must apply cloud policy before plugin startup.

### 6.6 Developer Submission

`POST /v1/developer/plugins`

Creates a plugin submission.

`POST /v1/developer/plugins/{submission_id}/artifact`

Uploads package artifact.

`GET /v1/developer/plugins/{submission_id}/verification`

Returns static scan, sandbox run, signature, and review status.

Production developer submission must follow the review and signing trust
boundary in `docs/plugin-submission-approval-signing.md`: approvals bind to an
immutable package digest, signing happens only after all required gates pass,
and registry publication is a separate allow decision after signed-artifact
verification.

### 6.7 ClawHunt Ingestion

`POST /v1/clawhunt/ingestions`

Creates a plugin ingestion job from an accepted ClawHunt delivery.

Not every accepted ClawHunt delivery is eligible to become a plugin. A delivery is only ingestible if it can be generalized into a repeatable tool contract.

Input:

```json
{
  "problem_id": "123",
  "delivery_manifest": {},
  "evidence_bundle_ref": "evidence://...",
  "source_artifacts": []
}
```

Output:

```json
{
  "ingestion_id": "ing_...",
  "status": "queued"
}
```

Eligibility requirements:

- delivery includes a reusable wrapper entrypoint, not only a one-off patch or prose answer;
- wrapper can run from a clean workspace using declared inputs;
- wrapper exposes at least one stable tool name, input schema, and output schema;
- tool behavior is documented in a package README;
- acceptance tests pass outside the original ClawHunt task workspace;
- task-specific secrets, account state, and private datasets are not embedded in the package;
- evidence fixtures demonstrate repeatability with synthetic or public-safe inputs;
- provenance records both the original ClawHunt submitter and the plugin maintainer.

Required wrapper files for ClawHunt-derived plugins:

```text
superclaw-plugin.json
bin/<tool-wrapper>
mcp/server.json
tests/smoke.sh
evidence-fixtures/clawhunt-replay.json
README.md
```

Rejected ingestion examples:

- a delivery that only edits a specific customer repository and cannot run elsewhere;
- a delivery that requires a private browser session owned by the bounty poster;
- a delivery whose output cannot be validated against a declared JSON schema;
- a delivery that downloads mutable code during runtime.

### 6.8 Plugin Configuration and Credential Policy

`GET /v1/plugins/{plugin_id}/configuration-policy`

Returns cloud policy for user-provided plugin configuration.

Minimum payload:

```json
{
  "plugin_id": "com.example.github-scanner",
  "version_range": ">=0.1.0 <1.0.0",
  "secrets": [
    {
      "name": "GITHUB_TOKEN",
      "required": true,
      "allowed_storage": ["local_keychain"],
      "inject_as": "env",
      "env_name": "GITHUB_TOKEN",
      "rotation_hint_days": 90
    }
  ],
  "settings": [
    {
      "name": "default_owner",
      "type": "string",
      "description": "Default GitHub owner used when a request omits one.",
      "validation": {
        "pattern": "^[A-Za-z0-9_.-]{1,80}$",
        "minLength": 1,
        "maxLength": 80
      },
      "ui": {
        "control": "text",
        "label": "Default owner"
      },
      "required": false
    }
  ]
}
```

Rules:

- SuperClaw Cloud may define what configuration is required, but it must not receive user secret values unless the plugin is explicitly server-backed and user consent is recorded.
- Local SuperClaw runtime owns secret prompting, local secure storage, and sidecar injection.
- Underlying agents may be told that a required credential is missing, but they must not receive the credential value, storage path, or decrypted environment.
- Secret values must never be written into generated Codex, Claude Code, Hermes, or OpenClaw runtime config.
- Secret injection happens only after signature, entitlement, revocation, permission, and policy checks pass.
- Local desktop configuration panels must be backed by the installed plugin
  manifest and may show only sanitized setting/secret status.
- Setting values saved through local APIs must be validated against the installed
  manifest descriptor, including declared type, enum, string, numeric, step, and
  URL rules.
- Local secret set/delete APIs must reject secret names that are not declared in
  the installed manifest.
- Developer upload review and local package verification must reject semantically
  invalid configuration descriptors before signing or caching plugin packages.

## 7. Local Runtime Interfaces

### 7.1 Plugin Manager CLI

Required commands:

```bash
superclaw plugin search <query>
superclaw plugin install <plugin_id>[@version]
superclaw plugin verify <plugin_id>
superclaw plugin list
superclaw plugin run <plugin_id> <tool_name> --json '<payload>'
superclaw plugin revoke-sync
superclaw plugin evidence <run_id>
superclaw plugin config set <plugin_id> <setting_name> <value>
superclaw plugin secret set <plugin_id> <secret_name>
superclaw plugin secret status <plugin_id>
```

### 7.2 MCP Proxy

Local SuperClaw must expose one proxy endpoint to underlying runtimes.

Allowed transports:

- stdio for local CLI invocation;
- localhost TCP only when the underlying runtime cannot use stdio;
- Unix domain socket where supported.

Rules:

- The proxy must enforce entitlement before forwarding.
- The proxy must enforce permissions before forwarding.
- The proxy must redact secrets before recording or returning errors.
- The proxy must normalize tool output size before passing it to the model.
- The proxy must write invocation evidence even when the tool call fails.

### 7.3 Sidecar Startup

For every plugin invocation session:

1. Verify package digest.
2. Verify signature.
3. Check revocation list.
4. Check entitlement token.
5. Resolve sandbox policy.
6. Resolve required non-secret settings.
7. Resolve required secrets from local secure storage.
8. Inject approved secrets into the sidecar only through declared channels.
9. Start sidecar process.
10. Register declared MCP tools.
11. Route tool calls through proxy.
12. Stop sidecar at session end or idle timeout.

### 7.4 Local Credential Manager

The local runtime MUST provide a credential manager for plugins that require user API keys, tokens, or account-specific secrets.

Minimum behavior:

- prompt the user out-of-band from the underlying agent when a required secret is missing;
- store secrets in the platform secure store where available, such as macOS Keychain;
- bind stored secrets to user, device, plugin id, plugin version range, and secret name;
- inject secrets only into the approved sidecar process environment or approved local IPC channel;
- never expose decrypted secrets to the underlying agent, generated MCP config, evidence bundle, logs, or model-visible errors;
- support deletion and rotation of each plugin secret.

Initial local implementation slice:

- `superclaw plugin config set <plugin_id> <setting_name> <value>` stores local
  non-secret plugin settings;
- `superclaw plugin secret set <plugin_id> <secret_name>` stores local plugin
  secrets in the SuperClaw-owned local config store;
- `superclaw plugin secret set <plugin_id> <secret_name> --user-id <id> --device-id <id>`
  binds a local secret to the active local user/device scope;
- `superclaw plugin secret set <plugin_id> <secret_name> --version-range <range>`
  binds a local secret to compatible plugin package versions;
- repeating `superclaw plugin secret set <plugin_id> <secret_name>` rotates the
  stored secret value for that descriptor;
- `superclaw plugin secret delete <plugin_id> <secret_name>` removes a stored
  secret value;
- `superclaw plugin secret status <plugin_id>` reports only descriptor names and
  configured status, never values;
- `superclaw plugin call ... --config-file <path>` resolves manifest-declared
  secrets from that store before sidecar startup;
- the local store is a development/test stand-in with user-only file permissions,
  not the final production keychain or cloud secret-sync system;
- the proxy MUST NOT inherit parent shell environment variables by default.
- the desktop Plugins workspace opens `Manage configuration` as a plugin-scoped
  panel backed by `GET /api/plugins/{plugin_id}/configuration`, not by
  marketplace listing metadata;
- the desktop Plugins workspace renders setting controls from manifest
  `type`, `validation.enum`, and `ui.control` descriptors before saving through
  the local config API.
- `config_url`, `panel_url`, marketplace cards, and registry metadata are not
  independent runtime configuration sources; configurable values must appear in
  the installed manifest configuration block.

Model-visible missing-secret response:

```json
{
  "error": {
    "code": "PLUGIN_CONFIG_REQUIRED",
    "message": "This plugin requires local configuration before it can run.",
    "retryable": true,
    "required_configuration": ["GITHUB_TOKEN"]
  }
}
```

Human-in-the-loop rule:

- A sidecar must not open arbitrary UI or block indefinitely waiting for user input.
- If a destructive action or missing credential requires user confirmation, the sidecar must return a structured proxy request.
- The proxy decides whether to ask the user, deny the action, or return a model-visible `PLUGIN_CONFIG_REQUIRED` or `PLUGIN_PERMISSION_DENIED` error.

## 8. Runtime Integration Matrix

| Runtime | v1 integration | Constraint |
|---|---|---|
| Codex CLI | MCP config points to SuperClaw proxy | Do not install commercial plugin dirs directly into Codex |
| Claude Code | `--mcp-config` points to SuperClaw proxy | `--plugin-dir` is allowed only for non-commercial generated skills, not protected binaries |
| Hermes | SuperClaw wrapper exposes MCP-compatible tool bridge or command adapter | Hermes must not receive entitlement tokens |
| OpenClaw | SuperClaw backend invokes proxy tools through command/MCP bridge | Plugin evidence must remain SuperClaw-owned |
| Anthropic API | SuperClaw tool adapter exposes plugin tools to the API caller | Do not send plugin implementation details in tool descriptions |

## 9. Security Model

### 9.1 Leakage Model

Underlying agents can see:

- tool names;
- tool descriptions;
- input schemas;
- user-provided tool arguments;
- sanitized outputs;
- sanitized error messages.

Underlying agents must not see:

- plugin source code;
- license tokens;
- cloud credentials;
- signing keys;
- plugin private API keys;
- raw sandbox filesystem;
- internal prompt or policy files that are not intended for model context.

Local users may still reverse engineer local binaries. The platform cannot fully prevent this. The goal is to prevent accidental leakage, casual copying, supply chain tampering, unauthorized updates, and unlicensed normal use.

### 9.2 Signing

Minimum signing design:

- SuperClaw Cloud signs package digest with Ed25519.
- Local runtime ships with trusted SuperClaw root public key.
- Signature verification happens before cache write and before execution.
- Repacked or modified artifacts must fail verification.
- Developer signatures may be recorded, but platform execution trust requires SuperClaw signature.

The production approval and signing lifecycle is defined in
`docs/plugin-submission-approval-signing.md`. The signing key is not a review
tool; it is a protected platform authority that may sign only after the approval
record authorizes the exact package digest.

### 9.3 Entitlement

- Entitlement tokens are short-lived JWTs or equivalent signed capability tokens.
- Tokens bind user, device, plugin id, version range, and expiry.
- Tokens are held by SuperClaw runtime and not exposed to the underlying agent.
- In v1, plugin local binaries do not enforce entitlement by themselves; the proxy enforces it.
- For SaaS-backed plugins, the plugin backend should verify entitlement server-side.
- Entitlement is checked before sidecar startup and again before each billable tool invocation.
- Long-running async plugin jobs may continue only while the invocation lease remains valid; resumed or paused jobs must re-check entitlement before producing additional outputs.
- If entitlement expires mid-job, the proxy must stop new work, preserve evidence, and return `PLUGIN_ENTITLEMENT_EXPIRED` rather than silently completing unlicensed execution.

### 9.4 Sandbox

Default policy:

- filesystem deny except declared workspace reads/writes;
- network deny except declared host allowlist;
- environment deny except declared variables;
- process spawning deny unless explicitly approved;
- no access to SuperClaw credentials;
- no access to other plugin cache directories.

Preferred v1 runtimes:

- compiled binary in restricted subprocess for trusted first-party plugins;
- Deno or WASI for developer-submitted plugins where feasible;
- container or OS sandbox for higher-risk plugins.

### 9.5 Tool Output Safety

The proxy must:

- cap output size;
- validate model-visible output against the plugin's declared `tools[].output_schema`;
- hard-fail or quarantine output that does not match the declared schema;
- redact known secret patterns after schema validation and before model exposure;
- drop undeclared output fields unless the output schema explicitly allows them;
- preserve raw output only in protected evidence artifacts when policy allows;
- return summarized errors to the underlying agent;
- mark suspected leakage as a verifier finding.

Output safety rules:

- Regex redaction is a backstop, not the primary safety boundary.
- The primary boundary is deterministic schema validation, output size caps, permission-scoped evidence storage, and deny-by-default model exposure.
- Plugins that need to return files MUST return artifact references and digests, not arbitrary local filesystem paths.
- Raw stdout and stderr MUST NOT be forwarded directly to the underlying agent.
- If schema validation fails, the proxy MUST return `PLUGIN_OUTPUT_SCHEMA_INVALID` and create protected evidence for support review.

### 9.6 Secret Injection Safety

Plugin secrets are user runtime configuration, not plugin package content.

Rules:

- Secret values MUST NOT appear in `superclaw-plugin.json`, generated MCP config, skills, prompts, tool descriptions, logs, or model-visible evidence.
- Secret descriptors may appear in the manifest, but descriptors must only include names, descriptions, required flags, storage policy, and injection channel.
- The proxy must inject secrets only after verifying package signature, revocation, entitlement, permission policy, and user consent.
- Secret injection must be scoped per invocation session and removed when the sidecar exits.
- Sidecars must receive only the secrets declared by their own manifest and approved by cloud policy.
- If a secret is missing, expired, or denied by policy, the sidecar must not start.
- `permissions.environment[]` grants access only to explicitly injected variables; it does not allow inheriting the parent shell environment.
- Evidence must record secret descriptor names and policy decisions, never secret values.

## 10. Lifecycle

### 10.1 Developer Upload Path

```text
developer creates package
  -> local packager validates manifest
  -> upload to SuperClaw Cloud
  -> static scan and dependency scan
  -> sandbox smoke run
  -> adversarial verification
  -> human or policy review
  -> SuperClaw signs package
  -> plugin is listed
  -> user installs
  -> proxy enforces entitlement and evidence capture
```

Acceptance gates:

- manifest valid;
- package digest stable;
- no secret scan blockers;
- dependency lockfile or SBOM is present when package bundles third-party dependencies;
- declared tools match runtime-discovered tools;
- sandbox run passes;
- evidence fixture generated;
- signature issued;
- revocation sync can block it.

### 10.2 ClawHunt Ingestion Path

```text
ClawHunt delivery accepted
  -> Delivery Protocol manifest and evidence are exported
  -> ingestion gate checks whether delivery is reusable, not only task-specific
  -> wrapper contract is generated or supplied
  -> SuperClaw ingestion job imports source artifacts
  -> packager maps delivery manifest to plugin manifest
  -> verifier runs acceptance tests
  -> package is signed with SuperClaw Verified provenance
  -> plugin is listed or staged for internal review
```

Acceptance gates:

- delivery manifest passes required ClawHunt level;
- EvidenceBundle exists and is linked;
- Delivery Protocol manifest exports sanitized plugin invocation summaries with
  digests and artifact ids, not raw plugin payloads or local paths;
- source artifacts are immutable references;
- package can run outside original task workspace;
- wrapper exposes stable tool schemas and output schemas;
- provenance links back to ClawHunt problem and submitter;
- revenue attribution is recorded before listing.

Non-ingestible deliveries may still be archived as evidence or examples, but they must not be listed as reusable plugins.

### 10.3 Plugin Update Path

```text
developer submits new version
  -> manifest schema diff is computed
  -> package diff and permission diff are computed
  -> automated tests and evidence replay run
  -> review level is recalculated
  -> signature is issued or update is rejected
  -> cloud policy publishes version availability
```

Update gates:

- patch version with no tool schema, permission, runtime, or commerce change may use automated review if tests pass;
- any tool input schema change requires compatibility review;
- any tool output schema change requires replay against existing evidence fixtures;
- any new filesystem, network, environment, or process permission requires security review;
- any runtime entrypoint or binary layout change requires sandbox smoke verification;
- any pricing, metering, or entitlement behavior change requires commerce review;
- major version updates may be installed side-by-side and must not silently replace existing user workflows.

Local Phase 4B implementation boundary:

- `superclaw plugin update-preflight` compares two local plugin package
  directories or `.scplug` archives and emits a sanitized
  `plugin-update-preflight.json` review report;
- the preflight computes manifest tool-schema, permission, runtime, commerce,
  and SemVer update findings, then maps them to the required review gates above;
- the preflight may mark a patch update as `automated_review_allowed` only when
  no tool schema, permission, runtime, or commerce finding is present;
- the preflight does not sign packages, publish cloud policy, mutate caches,
  run a marketplace, execute sidecar replay, or perform sandbox smoke tests; it
  only reports the gates that must be completed before those steps.

### 10.4 Evidence Retention

Local evidence is required for auditability, but it must not grow without bounds.

Default retention policy:

- failed, disputed, revoked, or security-flagged invocation evidence is retained until the dispute or policy window closes;
- successful invocation raw artifacts may be pruned after 7 days by default;
- summaries, digests, package ids, plugin versions, entitlement ids, and timestamps may be retained longer for billing and quality metrics;
- users must be able to inspect and clear local plugin evidence subject to active dispute locks;
- cloud upload must use digests and artifact references unless explicit user policy permits full evidence upload.

## 11. Governance

### 11.1 Review Levels

| Level | Meaning | Required gates |
|---|---|---|
| Unlisted | Uploaded but not public | manifest validation only |
| Verified | Runs and passes automated checks | static scan, sandbox run, signature |
| Certified | Higher trust and commercial promotion | manual review, security review, continuous verification |
| Revoked | Blocked from execution | revocation list synced |

Developer-uploaded plugins that do not originate from ClawHunt still receive an acceptance level:

- `L1`: manifest validates, smoke test passes, and package executes through the proxy.
- `L2`: L1 plus evidence fixtures, sandbox policy tests, output schema validation, and repeatable local verification.
- `L3`: L2 plus manual/security review, adversarial verification, continuous verification, and commercial readiness.

Local Phase 4C implementation boundary:

- developer-upload review records include `requested_acceptance_level`,
  `listing_review_level`, `acceptance_recommendation`, `certified_allowed`,
  `l3_allowed`, and remaining `manual_requirements`;
- local automated review may classify a signed passing package as `Verified`;
- local automated review may recommend `L1` or `L2`, but must not exceed the
  manifest's requested `acceptance.level`;
- local automated review must cap `L3` requests at `L2` and record the manual
  review, adversarial verification, continuous verification, and commercial
  readiness requirements that remain;
- local automated review must never grant `Certified`, public marketplace
  promotion, commercial readiness, or production trust by itself.

ClawHunt-derived plugins may inherit the source delivery level only after wrapper replay confirms that the plugin is reusable outside the original task.

### 11.2 Continuous Verification

Plugins must be periodically re-tested when:

- package version changes;
- dependency vulnerability is detected;
- user dispute is filed;
- tool failure rate exceeds threshold;
- runtime policy changes;
- ClawHunt-derived evidence is challenged.

### 11.3 Disputes

Dispute records must include:

- plugin id and version;
- package digest;
- entitlement id;
- tool invocation ids;
- input and output digests;
- EvidenceBundle artifact references;
- user-visible error;
- proxy policy decision;
- sandbox exit status.

### 11.4 Takedown and Revocation

SuperClaw Cloud may revoke a plugin for:

- malware or suspicious behavior;
- secret leakage;
- fraud or fake capability claims;
- broken runtime compatibility;
- license violation;
- developer request;
- platform policy violation.

Local runtime must refuse revoked plugin execution after revocation sync.

## 12. Payments and Developer Ecosystem

Payments are a platform feature, not a runtime trust boundary.

V1 commerce states:

- `free`
- `private_beta`
- `paid_manual`

Future commerce states:

- `paid_per_invocation`
- `subscription`
- `usage_metered`
- `enterprise_license`

Developer onboarding must require:

- verified developer identity or organization;
- payout profile;
- support contact;
- license declaration;
- vulnerability disclosure contact;
- acceptance of plugin policy;
- sample evidence fixture.

Initial local implementation slice: `superclaw.plugin_developer_onboarding`
defines the Section 12 developer-onboarding contract as a local validator. It
requires a verified developer identity or organization, a payout profile
reference, support contact, license declaration, vulnerability disclosure
contact, accepted plugin-policy version and timestamp, sample evidence fixture,
and a V1 commerce state. The validator returns only sanitized profile metadata
and rejects raw payment, identity, or secret-bearing fields. This slice is
developer-ecosystem governance only: it does not create production developer
accounts, store bank or tax details, perform KYC, run payout settlement,
publish marketplace listings, issue entitlements, sign packages, or change
runtime plugin execution.

Revenue attribution must support:

- developer-uploaded plugin owner;
- ClawHunt bounty submitter;
- organization owner;
- platform fee;
- optional reviewer or maintainer share.

Do not implement complex revenue splits before plugin verification, signing, install, and proxy execution work end-to-end.

## 13. Framework Extension Ports

These are reserved extension points. They should be represented in code as interfaces or adapters before product UI depends on them.

Initial local implementation slice: `superclaw.plugin_ports` represents every
Section 13 extension point as a runtime-checkable Python `Protocol` plus a
stable port-spec registry. The contract covers the cloud client, signature
verifier, entitlement, sandbox, MCP proxy, bounty ingestion, developer
submission, and credential-manager ports. This slice is interface governance
only: it does not refactor existing runtime modules to use the protocols, add
production cloud clients, implement product UI, create payment or marketplace
flows, expose protected plugin directories to underlying agents, or change
runtime proxy behavior.

### 13.1 Cloud Client Port

Responsible for:

- registry lookup;
- entitlement sync;
- package download;
- revocation sync;
- policy sync;
- evidence upload.

### 13.2 Signature Verifier Port

Responsible for:

- root key loading;
- digest verification;
- signature verification;
- trust chain reporting.

### 13.3 Entitlement Port

Responsible for:

- token validation;
- offline grace decision;
- license scope check;
- denial reason reporting.

### 13.4 Sandbox Port

Responsible for:

- process launch;
- permission application;
- network and filesystem policy;
- timeout and kill;
- exit status capture.

### 13.5 MCP Proxy Port

Responsible for:

- tool registry projection;
- request authorization;
- routing to sidecar;
- output normalization;
- evidence capture;
- model-safe error shaping.

### 13.6 Bounty Ingestion Port

Responsible for:

- importing ClawHunt delivery manifests;
- importing EvidenceBundle references;
- mapping delivery metadata to plugin metadata;
- rejecting task-specific deliveries that cannot become reusable tool contracts;
- validating required wrapper files and `mcp/server.json`;
- assigning revenue attribution;
- creating package build jobs.

### 13.7 Developer Submission Port

Responsible for:

- validating uploaded package metadata;
- linking developer identity;
- starting verification jobs;
- exposing review status.

### 13.8 Credential Manager Port

Responsible for:

- loading plugin configuration policy;
- prompting for required user secrets outside the underlying agent;
- storing secrets in local secure storage;
- injecting approved secrets into sidecars;
- deleting and rotating plugin secrets;
- reporting missing configuration without exposing values.

## 14. Minimal Build Plan

### Phase 0: Spec and Fixtures

Deliverables:

- this specification;
- sample `superclaw-plugin.json`;
- sample configuration policy fixture;
- one first-party hello-world plugin fixture;
- one ClawHunt-derived plugin fixture;
- one invalid plugin fixture.

Acceptance:

- fixture manifests validate;
- invalid fixture fails for deterministic reasons;
- no runtime execution required yet.

Second implementation slice: Phase 0B adds the local developer quickstart CLI
required by Section 4.0 and Section 19. `superclaw plugin init` scaffolds a
schema-valid starter package, `superclaw plugin dev` runs a declared local
sidecar tool without cloud or entitlement state, and `superclaw plugin pack`
creates a `.scplug` archive with a refreshed package digest and optional local
development signature. This slice is local developer tooling only: it must not
claim production SuperClaw Cloud signing, marketplace publication, entitlement
sync, payment, or runtime-agent installation of protected plugin directories.

### Phase 1: Local Package Verification

Deliverables:

- package reader;
- digest verifier;
- Ed25519 signature verifier;
- local plugin cache layout;
- CLI commands `plugin list`, `plugin verify`.

Acceptance:

- unsigned package fails;
- tampered package fails;
- valid signed package is cached;
- revocation metadata blocks execution before startup.

### Phase 2: MCP Proxy and Sidecar Execution

Deliverables:

- sidecar launcher;
- MCP proxy;
- tool registry projection;
- entitlement gate;
- credential manager, starting with the local config/secret store;
- evidence recording.

Acceptance:

- underlying agent can call a hello-world tool only through proxy;
- direct plugin process path is not exposed to the agent;
- unentitled plugin call returns proxy-level denial;
- missing required secret returns `PLUGIN_CONFIG_REQUIRED` before sidecar startup;
- parent shell secrets are not inherited by default;
- every invocation writes EvidenceBundle-compatible record;
- output that violates `output_schema` returns `PLUGIN_OUTPUT_SCHEMA_INVALID`;
- plugin stdout/stderr secrets are redacted before model-visible errors.

Backend runtime MCP policy slice: Phase 2E projects SuperClaw-owned MCP proxy
config into supported underlying agent CLIs without exposing protected plugin
directories. Codex receives only `mcp_servers.*` config overrides derived from
secret-free `superclaw plugin mcp-config` JSON. Claude Code may receive the same
config file through `--mcp-config` after SuperClaw validates that the generated
MCP config has no `env` block. Codex and Claude Code reject `plugin_dirs` and
MCP `env` blocks before backend startup, because protected package paths and
secret values must remain SuperClaw-owned.

Hermes/OpenClaw guardrail slice: until SuperClaw defines and implements MCP
projection bridges for these runtimes, `HermesCliBackend` and
`OpenClawCliBackend` must reject SuperClaw plugin runtime policy instead of
silently ignoring it. Safe MCP configs are validated for the same secret-free
shape, then fail closed with `PLUGIN_RUNTIME_CONFIG_INVALID`; direct
`plugin_dirs` and MCP `env` blocks also fail before Hermes or OpenClaw starts.

### Phase 3: ClawHunt Ingestion

Deliverables:

- ingestion adapter from ClawHunt delivery manifest;
- evidence reference linker;
- package builder;
- provenance writer.

Acceptance:

- accepted delivery becomes installable plugin fixture;
- missing EvidenceBundle blocks ingestion;
- delivery without reusable wrapper contract is rejected;
- wrapper declares stable tool input and output schemas;
- package provenance links problem id and source artifacts;
- package executes outside original task workspace.

Second implementation slice: Phase 3B extends local ingestion packages with
package-local runtime contract files. Generated packages include
`mcp/server.json` for proxy-routed MCP metadata and
`replay/plugin-invocation.json` for a repeatable invocation fixture. These files
make wrapper replay and later cloud review concrete without allowing Codex,
Claude Code, Hermes, OpenClaw, or any other underlying runtime to load protected
plugin directories directly.

Third implementation slice: Phase 3C records attribution-only revenue metadata
for ClawHunt-derived plugin candidates. The local ingestion metadata must include
the original submitter, package owner, maintainer when present, optional bounty
sponsor, pricing model, metering mode, and `not_settled` status. This is a
marketplace/accounting handoff record, not a payment system: it must not collect
payment accounts, compute complex payout splits, perform settlement, or expose
commerce internals to underlying agents.

Fourth implementation slice: Phase 3D exposes the local
`POST /v1/clawhunt/ingestions` contract. The endpoint is a synchronous local
fake-cloud wrapper around the existing ingestion adapter: it accepts a local
delivery root, stages an unsigned plugin package, writes a sanitized job record,
and returns only stable ids, digests, `requires_signing`, and an opaque
`superclaw-local://` package reference. It must not expose local package roots,
manifest paths, metadata paths, original workspace paths, entitlement tokens, or
secrets. It is not a production ClawHunt Cloud job system, async queue, wrapper
synthesis service, registry upload path, signing service, marketplace listing,
payment, payout, or settlement system.

### Phase 4: Developer Upload

Deliverables:

- upload API or CLI;
- static scan;
- dependency or SBOM scan;
- sandbox smoke run;
- review status API.

Acceptance:

- developer can submit a package;
- failing scan blocks signing;
- dependency vulnerability above policy threshold blocks signing;
- passing package receives SuperClaw signature;
- published package can be installed locally.

Local Phase 4D implementation boundary:

- developer-upload review includes a separate
  `dependency_vulnerability_policy` gate after lockfile/SBOM presence is
  checked;
- local review consumes only package-local `sbom.cdx.json`, `sbom.spdx.json`,
  or `dependency-vulnerabilities.json` evidence;
- the default local threshold blocks `high` and `critical` findings while
  allowing `medium`, `moderate`, `low`, and `none`;
- malformed vulnerability fixture JSON fails closed;
- review records may expose sanitized severity counts and vulnerability ids, but
  must not expose raw third-party scan logs, absolute workspace paths, cache
  paths, entitlement tokens, or secrets;
- this slice does not call live vulnerability feeds, package registries,
  `npm audit`, `pip-audit`, GitHub Advisory, OSV, SuperClaw Cloud policy sync,
  or any network endpoint.

Fifth implementation slice: Phase 4A now also exposes the local Section 6.6
developer submission REST contract. `POST /v1/developer/plugins` creates a
fake-cloud submission record, `POST /v1/developer/plugins/{submission_id}/artifact`
uses a test-controlled local package path to run the existing Phase 4A review
and local signing path, and `GET /v1/developer/plugins/{submission_id}/verification`
returns sanitized review metadata. Responses and persisted API records may
include submission ids, review status, gate outcomes, package digests, public
signing metadata, and opaque `superclaw-local://` signed-package references.
They must not expose local package paths, review paths, cache paths, signing
private keys, entitlement tokens, or secrets. This slice is not a production
developer upload API, browser/multipart upload path, cloud artifact storage
system, production signing service, marketplace listing, payment, payout,
settlement, entitlement sync, or runtime proxy change.

### Phase 5: Cloud Sync and Governance

Deliverables:

- registry API;
- entitlement sync;
- revocation sync;
- policy sync;
- evidence upload.

Acceptance:

- local runtime can install from cloud metadata;
- entitlement expiry blocks execution;
- revocation list blocks an already cached plugin;
- evidence summary uploads without full workspace leakage.

Initial implementation slice: Phase 5A is a local fake-cloud contract, not the
production cloud service. It may use a filesystem registry and governance store
to prove install, entitlement, revocation, policy, and evidence-upload behavior.
It must still enforce synced governance before sidecar startup and must keep
cloud credentials, entitlement tokens, cache paths, sidecar paths, raw evidence,
and secret values out of MCP metadata, CLI JSON, model-visible errors, and
uploaded summaries.

Second implementation slice: Phase 5B exposes the same semantics through local
`/v1` REST contract endpoints backed by the fake-cloud store. These endpoints
prove registry search, version metadata, opaque download references, entitlement
sync, revocation sync, policy sync, and evidence-summary upload without
claiming production cloud hosting, payment, public marketplace ranking,
production JWT issuing, or real artifact download infrastructure.

Third implementation slice: Phase 5C caps and disables offline entitlement
grace in both local fake-cloud sync and local REST entitlement-sync responses.
Synced entitlement records receive `synced_at` plus `offline_grace_expires_at`,
and runtime proxy execution fails closed before sidecar startup if the local
offline-grace window is stale, exceeds the 72-hour platform maximum, or is
disabled by entitlement metadata or synced runtime policy. High-risk policy,
live-metered entitlement/policy, and explicit `offline_grace_allowed: false`
produce `offline_grace_expires_at == synced_at` plus
`offline_grace_disabled_reason`. The local proxy also enforces synced entitlement
`version_range` constraints before sidecar startup, so version-scoped tokens
cannot authorize unrelated cached plugin versions. This is still local
governance metadata, not production entitlement JWT validation or online license
checking.

Fourth implementation slice: Phase 5D adds local plugin evidence retention
commands. Local SuperClaw can list plugin invocation evidence, prune successful
records older than the default 7-day retention window, and clear selected
unlocked records. Failed, disputed, revoked, timeout, sandbox/security-flagged,
or explicitly retention-locked records remain locked for later audit. This is a
local artifact lifecycle feature only; it must not upload raw evidence, modify
cloud policy, delete cached plugin packages, or weaken dispute/audit records.

Fifth implementation slice: Phase 5E adds the user-facing local registry
commands from Section 7.1. `superclaw plugin search` reads sanitized fake-cloud
registry metadata and applies local filters without exposing package paths.
`superclaw plugin install <plugin_id>[@version]` resolves an explicit or latest
local registry version and then uses the existing metadata, digest, signature,
revocation, and cache verifier path. This is local fake-cloud UX only; it must
not implement production artifact downloads, purchase flows, marketplace
ranking, production entitlement JWTs, or direct protected plugin loading by
underlying agents.

## 15. Definition of Done

A SuperClaw plugin framework feature is done only if:

- it has a manifest fixture;
- it has a positive test and a negative test;
- it has updated user-facing or developer-facing documentation for the changed behavior;
- failures are fail-closed;
- runtime actions are recorded as evidence;
- secret-bearing fields are not exposed to the underlying agent;
- public user-facing language does not imply unsafe reuse guarantees;
- signing and entitlement decisions are visible in diagnostics;
- revocation can stop execution without deleting local files manually.

## 16. No-Go Decisions

- Do not let Codex, Claude Code, Hermes, or OpenClaw load protected commercial plugin directories directly.
- Do not pass entitlement tokens or cloud credentials to the underlying agent.
- Do not build a custom RPC protocol in v1; use MCP as the runtime tool boundary.
- Do not implement local DRM as the primary protection mechanism.
- Do not inline large skills, binaries, logs, or MCP configs into the main manifest.
- Do not allow dynamic tool registration in v1.
- Do not allow plugins to download executable code at runtime.
- Do not implement a marketplace payment UI before local signed plugin execution works.
- Do not claim a plugin is safe because it is binary. Safety requires signing, sandboxing, policy, evidence, and revocation.

## 17. Open Questions

- Which sandbox technology is the first production target on macOS: subprocess policy, App Sandbox, Deno, WASI, or container runtime?
- What minimum evidence should be uploaded for paid disputes without leaking user workspace content?
- What revenue attribution model should apply when a ClawHunt bounty delivery becomes a paid plugin?
- Should Certified plugins require manual review for every version or only major versions?

## 18. First Engineering Task

The first implementation task is not a marketplace.

The first task is:

```text
Build a local signed hello-world SuperClaw plugin package that can only be called through the SuperClaw MCP proxy, records EvidenceBundle-compatible invocation evidence, is denied when entitlement is missing, and returns PLUGIN_CONFIG_REQUIRED when a declared secret is missing.
```

This proves the core framework boundary before commerce, catalog UI, or developer monetization is added.

## 19. Developer Distribution Pack

This framework is developer-distributable only when the repository contains a complete starter pack. The pack is not optional; it is the contract developers build against.

Required artifacts:

- `docs/plugin-ecosystem-framework.md`: this specification.
- `examples/plugins/hello-world/superclaw-plugin.json`: minimal valid package manifest.
- `examples/plugins/hello-world/bin/hello-world`: executable sidecar or script.
- `examples/plugins/hello-world/tests/smoke.sh`: local verification command.
- `examples/plugins/hello-world/evidence-fixtures/smoke.json`: expected EvidenceBundle-compatible fixture.
- `examples/plugins/repo-scanner/`: realistic filesystem-read plugin fixture.
- `examples/plugins/github-scanner/`: credential-requiring fixture using local secret injection.
- `schemas/superclaw-plugin.schema.json`: JSON Schema for `superclaw-plugin.json`.
- `schemas/plugin-configuration-policy.schema.json`: JSON Schema for configuration and secret descriptors.
- `schemas/plugin-invocation-evidence.schema.json`: JSON Schema for invocation evidence.
- `docs/plugin-developer-guide.md`: shorter developer onboarding guide derived from this spec.

Acceptance:

- a developer can create, run, pack, and verify the hello-world plugin from a clean checkout;
- every command in the developer guide has a corresponding test or fixture;
- the starter pack does not require SuperClaw Cloud credentials until `plugin submit`.

Initial implementation slice: `superclaw plugin init/dev/pack` covers local
starter creation, sidecar smoke execution, `.scplug` archive creation, digest
refresh, and optional local/dev Ed25519 signing. Verification of a dev-signed
archive requires the returned public key and does not replace platform signing.
Unsigned archives remain package candidates and must report that platform
signing is still required.

## 20. Reference Package Layout

Compliant packages SHOULD use this layout:

```text
com.example.repo-scanner/
  superclaw-plugin.json
  README.md
  LICENSE
  bin/
    repo-scanner-darwin-arm64
    repo-scanner-linux-x64
  skills/
    repo-scanner/SKILL.md
  mcp/
    server.json
  tests/
    smoke.sh
    fixture-repo/
  evidence-fixtures/
    smoke.json
  docs/
    runbook.md
    security.md
```

Rules:

- `bin/` MAY contain binaries or scripts, but each entrypoint must be declared in the manifest.
- `skills/` content is model-visible and MUST NOT contain secrets, license tokens, proprietary algorithms, or hidden policy.
- `mcp/server.json` is package-local metadata; the runtime MUST still route agent calls through the SuperClaw MCP proxy.
- `tests/` MUST run offline unless the manifest declares network permissions.
- `evidence-fixtures/` MUST include expected success and failure examples for paid or L2+ plugins.

## 21. Runtime Error Contract

The MCP proxy MUST return stable error codes so underlying agents, users, and support tooling can distinguish policy failure from plugin failure.

Required error codes:

| Code | Meaning | Retryable |
|---|---|---|
| `PLUGIN_NOT_INSTALLED` | Plugin is not present in local cache | Yes after install |
| `PLUGIN_SIGNATURE_INVALID` | Package signature or digest check failed | No |
| `PLUGIN_REVOKED` | Plugin or version is revoked by cloud policy | No |
| `PLUGIN_ENTITLEMENT_MISSING` | User/device lacks entitlement | Yes after purchase/sync |
| `PLUGIN_ENTITLEMENT_EXPIRED` | Entitlement token expired | Yes after sync |
| `PLUGIN_CONFIG_REQUIRED` | Required local setting or secret is missing | Yes after local configuration |
| `PLUGIN_SECRET_UNAVAILABLE` | Declared secret exists but cannot be loaded or injected by policy | Maybe after rotation |
| `PLUGIN_PERMISSION_DENIED` | Requested operation exceeds manifest permissions | No for same request |
| `PLUGIN_SANDBOX_VIOLATION` | Sidecar attempted forbidden filesystem/network/process action | No |
| `PLUGIN_TOOL_NOT_DECLARED` | Tool is not in static manifest | No |
| `PLUGIN_TIMEOUT` | Sidecar exceeded timeout | Maybe |
| `PLUGIN_RUNTIME_ERROR` | Sidecar returned a normal execution failure | Depends on tool |
| `PLUGIN_OUTPUT_SCHEMA_INVALID` | Sidecar output failed declared output schema validation | No until plugin fix |
| `PLUGIN_OUTPUT_REDACTED` | Output was truncated or redacted before model exposure | Maybe |

Model-visible error payload:

```json
{
  "error": {
    "code": "PLUGIN_ENTITLEMENT_MISSING",
    "message": "This plugin is not available for the current SuperClaw account or device.",
    "retryable": true,
    "evidence_id": "artifact_..."
  }
}
```

Rules:

- Model-visible errors MUST NOT include entitlement JWTs, filesystem paths outside the workspace, signing internals, or raw stderr that may contain secrets.
- Full diagnostic detail MAY be stored in protected local evidence artifacts.
- Every error MUST create an evidence record.

## 22. Conformance Suite

The framework is not implemented until the conformance suite exists. Unit tests alone are insufficient.

Initial implementation slice: the local conformance suite is exposed through
`superclaw plugin conformance`. Dry-run mode emits the Section 22 coverage
matrix with check ids, mapped commands, and evidence files. `--run` executes the
mapped local test commands and reports only status and exit codes, not raw
stdout/stderr. This suite is a local orchestration layer over repository tests;
it must not contact production cloud services, upload evidence, mutate plugin
caches, or weaken the underlying unit/integration tests.

Matrix integrity guardrail: every default conformance check must have a unique
check id, a local `.venv/bin/python -m pytest ...` command, repo-relative test
targets, repo-relative evidence paths, existing evidence files, and command test
targets that are also listed as evidence. This prevents the conformance matrix
from drifting into placeholder checks, remote commands, absolute local paths, or
unreviewable evidence references.

Package validation slice: the matrix includes a dedicated `package-validation`
check for Section 22.1. It maps schema validation, required manifest fields,
SemVer version enforcement, digest mismatch rejection, signature mismatch
rejection, missing-permission rejection, and wildcard network-permission
rejection to `tests/test_plugin_distribution_pack.py`,
`tests/test_plugin_local_verification.py`, and
`schemas/superclaw-plugin.schema.json`.

Developer devkit slice: the matrix includes a dedicated `developer-devkit`
check for Section 4.0, Section 19, and Phase 0B. It maps `superclaw plugin
init`, `superclaw plugin dev`, `superclaw plugin pack`, schema-valid starter
packages, undeclared-tool fail-closed behavior, and dev-signed archive
verification to `tests/test_plugin_devkit.py`.

Local package verification slice: the matrix includes a dedicated
`local-package-verification` check for Phase 1 and Section 22.1. It maps
directory and `.scplug` package loading, stable digest calculation, Ed25519
signature verification, tamper/wrong-key/unsigned rejection, unsafe archive
rejection, local revocation blocking, cache writes, and `plugin verify/list`
CLI behavior to `tests/test_plugin_local_verification.py`.

Runtime proxy slice: the matrix includes a dedicated `runtime-proxy` check for
Section 22.2. It maps SuperClaw-owned proxy invocation, MCP stdio projection,
entitlement and revocation gates, required-secret preflight, schema validation,
timeout handling, output-budget enforcement, and secret/path redaction to
`tests/test_plugin_proxy.py`, `tests/test_plugin_mcp_proxy.py`,
`packages/superclaw/src/superclaw/plugin_proxy.py`, and
`packages/superclaw/src/superclaw/plugin_mcp_proxy.py`.

Runtime error contract slice: the matrix includes a dedicated
`runtime-error-contract` check for Section 21. It maps stable plugin error
codes, sanitized model-visible error payloads, retryable flags, and evidence id
creation for entitlement, revocation, permission, sandbox, timeout, runtime, and
schema failures to `tests/test_plugin_proxy.py` and `tests/test_plugin_cloud.py`.

Credential-manager implementation slice: the matrix includes a dedicated
`credential-manager` check for Section 7.4. It maps local secret configuration,
identity scoping, version scoping, rotation, deletion, non-inherited shell
secrets, and sanitized CLI output to `tests/test_plugin_config.py`.

Backend runtime policy slice: the matrix includes a dedicated
`backend-runtime-policy` check for Sections 24 and 25. It maps Codex/Claude
runtime config projection, Hermes/OpenClaw fail-closed projection guardrails,
direct plugin-directory rejection, MCP env rejection, and worker-output
non-leakage to `tests/test_worker_backends.py`.

Adversarial policy slice: the matrix includes a dedicated
`adversarial-policy` check for Sections 24 and 25. It maps plugin policy bypass
evidence, revoked-success plugin records, secret-bearing plugin output, and
clean proxy-only invocation evidence to `tests/test_adversarial.py` and
`tests/test_adversarial_hardening.py`.

Extension ports contract slice: the matrix includes a dedicated
`extension-ports-contract` check for Section 13. It maps the cloud client,
signature verifier, entitlement, sandbox, MCP proxy, bounty ingestion, developer
submission, and credential-manager `Protocol` contracts and port-spec registry
to `tests/test_plugin_ports.py` and `plugin_ports.py`. This is a code-contract
boundary only; it does not change cloud sync, package verification, sandbox
execution, MCP proxy routing, ClawHunt ingestion, developer-upload review,
credential storage, payment, marketplace, or backend runtime behavior.

Developer onboarding contract slice: the matrix includes a dedicated
`developer-onboarding-contract` check for Section 12. It maps verified
identity, payout profile reference, support and vulnerability contacts, license
declaration, plugin-policy acceptance, sample evidence fixture validation, V1
commerce-state validation, and raw sensitive field rejection to
`tests/test_plugin_developer_onboarding.py` and
`packages/superclaw/src/superclaw/plugin_developer_onboarding.py`. This is a
local intake-policy contract only; it does not implement production developer
accounts, KYC, bank/tax storage, payment, payout, settlement, marketplace
publication, package signing, entitlement sync, or runtime proxy behavior.

Protocol adapter plugin evidence export slice: the matrix includes a dedicated
`protocol-adapter-plugin-evidence-export` check for Section 24. It maps
sanitized Delivery Protocol plugin invocation summaries, probe/artifact
de-duplication, artifact-only fallback summaries, generic-example non-leakage,
and source EvidenceBundle non-mutation to `tests/test_protocol_adapter.py` and
`packages/superclaw/src/superclaw/protocol_adapter.py`. This group is a
protocol-export conformance boundary only; it does not change plugin proxy
execution, EvidenceBundle schema, artifact formats, ClawHunt ingestion, cloud
upload, marketplace behavior, payment, signing, or backend runtime policy.

Runtime diagnostics slice: the matrix includes a dedicated
`runtime-diagnostics` check for Section 23. It maps local evidence-based
diagnostics for slow calls, high failure rates, repeated sandbox/security kills,
threshold validation, invalid-record tolerance, and output non-leakage to
`tests/test_plugin_evidence.py`.

Evidence retention slice: the matrix includes a dedicated `evidence-retention`
check for Phase 5D and Section 10.4. It maps sanitized local evidence listing,
default 7-day successful-record pruning, selected unlocked-record clear,
locked audit-record preservation, unsafe id rejection, and CLI non-leakage to
`tests/test_plugin_evidence.py`.

Sandbox slice: the matrix includes a dedicated `sandbox` check for Section
22.3. It maps pre-sidecar guardrails for undeclared filesystem paths, network
hosts, environment-variable reads, and child-process escapes to
`tests/test_plugin_proxy.py`, `tests/test_plugin_mcp_proxy.py`, and
`packages/superclaw/src/superclaw/plugin_proxy.py`. This conformance group is a
local static/preflight boundary, not a production kernel, container, network
firewall, or WASI sandbox.

Cloud contract slice: the matrix includes a dedicated `cloud-contract` check
for Section 22.4 and Phase 5A. It maps local fake-cloud registry/governance
sync, entitlement and revocation sync, offline grace caps, runtime policy
descriptors, minimum runtime version enforcement, policy-driven sidecar timeout
limits, policy-driven output limits, and privacy-preserving evidence
summaries, including the minimum invocation-summary validation contract, to
`tests/test_plugin_cloud.py`, `tests/test_plugin_cloud_api.py`,
`packages/superclaw/src/superclaw/plugin_cloud.py`, and
`packages/superclaw/src/superclaw/plugin_proxy.py`. This group proves the local
contract only; it does not provide production cloud hosting, purchase flows,
payment, billing, payouts, production JWT issuing, or online license checks.

Registry UX slice: the matrix includes a dedicated `registry-ux` check for
Section 7.1 and Phase 5E. It maps `superclaw plugin search` and
`superclaw plugin install <plugin_id>[@version]` to the local fake-cloud
registry tests in `tests/test_plugin_cloud.py`, including sanitized search
output, explicit/latest version resolution, verifier-backed install, and
package/cache path non-leakage.

Cloud REST contract slice: the matrix includes a dedicated
`cloud-rest-contract` check for Section 6 and Phase 5B. It maps local `/v1`
plugin cloud endpoints for registry metadata, version metadata, opaque download
references, entitlement sync, revocation sync, runtime policy sync, and
evidence-summary upload to `tests/test_plugin_cloud_api.py`, including
path/raw-evidence/secret non-leakage.

Entitlement governance slice: the matrix includes a dedicated
`entitlement-governance` check for Phase 5C and Section 22.4. It maps offline
grace capping and disabling, scoped entitlement sync tokens, runtime
version-range enforcement, stale/overlong/offline-denied local governance
denial, and pre-sidecar fail-closed behavior to `tests/test_plugin_cloud.py` and
`tests/test_plugin_cloud_api.py`.

Developer upload slice: the matrix includes a dedicated `developer-upload`
check for Section 6.6, Section 26, and Phase 4A. It maps local developer-upload
CLI/function intake, source validation, static gates, dependency evidence,
smoke tests, missing-signing-key failure, signed artifact issuance, and
review-status lookup to `tests/test_plugin_submission.py`.

Developer submission REST slice: the matrix includes a dedicated
`developer-submission-rest` check for Section 6.6 and Section 22.4. It maps
`POST /v1/developer/plugins`, `POST /v1/developer/plugins/{submission_id}/artifact`,
and `GET /v1/developer/plugins/{submission_id}/verification` to
`tests/test_plugin_cloud_api.py` and `tests/test_plugin_submission.py`,
including fake-cloud submission creation, local package-artifact review through
the Phase 4A path, sanitized verification metadata, opaque signed-package
references, unknown-submission handling, invalid-artifact-path sanitization, and
non-leakage for local paths, signing private keys, cache paths, entitlement
tokens, and secrets. This conformance group is a contract mapping only; it does
not change REST endpoint behavior, production upload/download, production
signing, marketplace listing, payment, payout, settlement, entitlement sync, or
runtime proxy behavior.

Plugin update preflight slice: the matrix includes a dedicated
`plugin-update-preflight` check for Section 10.3 and Phase 4B. It maps local
candidate-version comparison, SemVer risk classification, schema diff gates,
permission diff gates, runtime layout gates, commerce gates, major-version
side-by-side requirements, sanitized review-record output, and CLI behavior to
`tests/test_plugin_updates.py`,
`packages/superclaw/src/superclaw/plugin_updates.py`, and
`packages/superclaw/src/superclaw/cli.py`. This conformance group is a local
pre-release review boundary only; it does not sign packages, publish cloud
policy, list marketplace entries, sync entitlements, implement payment or
payout flows, mutate plugin caches, run sidecar replay, execute sandbox smoke
tests, or auto-inject backend runtimes.

ClawHunt ingestion slice: the matrix includes a dedicated
`clawhunt-ingestion` check for Section 22.5 and Phase 3. It maps accepted
reusable delivery conversion, missing-evidence and one-off delivery rejection,
package-local ingestion metadata, replay fixture generation, MCP contract file
generation, manifest provenance, and attribution-only revenue metadata to
`tests/test_plugin_ingestion.py`,
`packages/superclaw/src/superclaw/plugin_ingestion.py`, and
`packages/superclaw/src/superclaw/cli.py`. This group is a local adapter
boundary only; it does not perform production ClawHunt marketplace review,
cloud signing, payment settlement, payout splitting, or public listing.

Release checklist slice: the matrix includes a dedicated `release-checklist`
check for Section 25. It maps the local release checklist adapter, Section 25
item coverage, conformance-check references, existing repo-relative evidence,
manual-gate handling, and sanitized output to `tests/test_plugin_release.py`
and `packages/superclaw/src/superclaw/plugin_release.py`. This is a local
release-governance view only; it does not perform a production release, approve
manual Codex/Claude runs, approve marketplace payment UI, or change runtime,
cloud, package-verification, developer-upload, or ClawHunt-ingestion behavior.

Engineering workflow gate slice: the matrix includes a dedicated
`engineering-workflow-gate` check for Section 27. It maps the local workflow
gate command, feature-boundary field requirements, positive/negative test
requirements, documentation loop, atomic commit policy, pre-commit Gemini
review, feature-group PR policy, pre-PR sync gate, and version/changelog hygiene
to `tests/test_plugin_workflow.py`,
`packages/superclaw/src/superclaw/plugin_workflow.py`,
`packages/superclaw/src/superclaw/cli.py`, and this framework document. This
is a read-only process-governance check only; it does not contact GitHub,
start Gemini, run tests, stage files, create commits, push branches, open PRs,
or mutate repository state.

### 22.1 Package Validation Tests

Required tests:

- valid manifest passes;
- missing `id` fails;
- non-SemVer `version` fails;
- manifest that violates `schemas/superclaw-plugin.schema.json` fails with field-level diagnostics;
- undeclared tool fails;
- dynamic tool registration fixture fails;
- missing permission declaration defaults to deny;
- wildcard network permission fails in v1;
- package digest mismatch fails;
- signature mismatch fails.

### 22.2 Runtime Proxy Tests

Required tests:

- underlying agent can call a tool only through SuperClaw proxy;
- direct sidecar path is not exposed in generated runtime config;
- unentitled call is denied before sidecar invocation;
- revoked plugin is denied before sidecar invocation;
- missing required secret returns `PLUGIN_CONFIG_REQUIRED` before sidecar invocation;
- declared secret is injected only into the sidecar, not into generated MCP config;
- allowed call reaches sidecar and returns sanitized output;
- output that violates declared `output_schema` returns `PLUGIN_OUTPUT_SCHEMA_INVALID`;
- undeclared output fields are dropped or fail according to the schema policy;
- stdout/stderr secret patterns are redacted;
- timeout kills sidecar and records evidence;
- output larger than the configured budget is truncated before model exposure.

### 22.3 Sandbox Tests

Required tests:

- filesystem read outside declared scope fails;
- filesystem write outside declared scope fails;
- network call to undeclared host fails;
- environment variable access not declared in manifest fails;
- inherited parent shell environment is not exposed to sidecar by default;
- process spawn attempt is blocked unless explicitly allowed;
- sandbox violation produces `PLUGIN_SANDBOX_VIOLATION`.

Initial local implementation slice: Phase 2C uses SuperClaw proxy preflight to
reject script-visible undeclared filesystem paths, network hosts, environment
variables, and explicit child-process escape patterns before sidecar startup.
This is a fail-closed contract guardrail for local shell-sidecar fixtures, not a
replacement for the production OS/container/WASI sandbox.

Phase 2D adds the first local credential-manager slice. It stores plugin
settings and secrets in a SuperClaw-owned local config file, supports local
secret user/device binding, version-range binding, rotation, and deletion,
injects only manifest-declared secrets into sidecars, returns
`PLUGIN_CONFIG_REQUIRED` before startup when a required secret is absent or
scoped to a non-matching local identity/version, returns
`PLUGIN_SECRET_UNAVAILABLE` when the local config store is unreadable, and proves
parent shell secrets are not inherited by default. This is not the production
Keychain/cloud-sync design.

### 22.4 Cloud Contract Tests

Required tests:

- entitlement sync returns a token scoped to user, device, plugin id, and version range;
- expired entitlement blocks execution;
- offline grace never exceeds the 72-hour platform maximum;
- offline grace is disabled for high-risk, live-metered, or explicitly
  offline-denied entitlement policy;
- revocation sync blocks an already cached plugin;
- revocation sync and `/v1/plugins/revocations` reject missing or unknown
  revocation reason codes;
- configuration policy returns only secret descriptors and never secret values;
- evidence upload omits full workspace content by default;
- evidence upload rejects incomplete or malformed minimum invocation summaries;
- policy sync updates max output size and denylisted permissions;
- synced minimum runtime version blocks sidecar execution before startup;
- synced max tool timeout can shorten sidecar execution and produce a
  `PLUGIN_TIMEOUT` evidence record.

### 22.5 ClawHunt Ingestion Tests

Required tests:

- accepted L2 delivery converts into a package manifest;
- one-off delivery without wrapper contract is rejected;
- missing EvidenceBundle blocks ingestion;
- source artifact digest is preserved;
- generated wrapper contains `mcp/server.json`, smoke test, and replay fixture;
- generated package executes outside the original task workspace;
- revenue attribution includes original submitter and package owner.

## 23. Performance and Resource Budgets

Plugin execution must not make SuperClaw unusable as a local runtime.

Default v1 budgets:

| Resource | Default budget | Enforcement |
|---|---:|---|
| sidecar startup | 3 seconds | launcher timeout |
| tool call runtime | 30 seconds | proxy timeout |
| model-visible output | 64 KB | proxy truncation |
| raw evidence artifact | 5 MB per call | evidence storage policy |
| sidecar idle lifetime | 120 seconds | idle reap |
| concurrent plugin sidecars | 4 per run | orchestrator limit |
| memory per sidecar | 512 MB | sandbox/container limit where available |

Rules:

- Package `limits` may lower these budgets but cannot raise them beyond platform maximums unless the plugin is Certified.
- The Phase 0 local manifest schema enforces these default ceilings for all
  packages. Certified overrides require a signed cloud policy layer and must not
  be represented by simply raising local `superclaw-plugin.json` limits.
- `PLUGIN_TIMEOUT` semantics are based on the effective `limits.tool_timeout_ms` after platform policy is applied.
- Expensive plugins MUST declare expected latency and resource profile. In the
  local v1 manifest schema, expensive means any package declaring
  `acceptance.latency_budget_ms > 10000`, `limits.tool_timeout_ms > 10000`,
  `limits.max_model_output_bytes > 32768`,
  `limits.max_evidence_bytes > 1048576`, or `limits.max_memory_mb > 256`.
- `resource_profile` is declarative metadata for review, registry UX, and
  future scheduling policy. Phase 0 validation does not measure CPU, memory,
  latency, network usage, or filesystem I/O at runtime.
- Long-running plugins SHOULD use an async job pattern and return progress artifacts.
- Evidence storage MUST keep references and digests instead of embedding large payloads into primary run state.
- SuperClaw MUST expose diagnostics for slow startup, high failure rate, and repeated sandbox kills.

Initial local diagnostics slice: `superclaw plugin diagnostics` reads local
plugin invocation evidence and emits a sanitized runtime-health report. It
flags slow calls from invocation timestamps, high per-plugin/per-tool failure
rates, and repeated `PLUGIN_SANDBOX_VIOLATION` evidence. This is read-only
observability: it must not start sidecars, replay plugins, mutate caches, sync
cloud governance, upload reports, or claim production continuous verification.
Reports may include aggregate counters, thresholds, finding codes, plugin/tool
identifiers, and artifact ids, but must not expose raw plugin input/output,
stdout/stderr, absolute artifact roots, cache paths, sidecar paths, entitlement
tokens, or secret values.

## 24. Current SuperClaw Integration Map

The plugin framework should be implemented through new ports and adapters before changing existing backends.

Recommended modules:

| Concern | Suggested module |
|---|---|
| package parsing and validation | `superclaw.plugins.package` |
| signature verification | `superclaw.plugins.signing` |
| entitlement validation | `superclaw.plugins.entitlements` |
| local cache | `superclaw.plugins.cache` |
| sidecar launch | `superclaw.plugins.sandbox` |
| MCP proxy | `superclaw.plugins.proxy` |
| credential manager | `superclaw.plugin_config` for the local slice; `superclaw.plugins.credentials` for production secure-store work |
| cloud client | `superclaw.plugins.cloud` |
| ClawHunt ingestion | `superclaw.plugins.ingestion` |
| evidence mapping | `superclaw.plugins.evidence` |

Existing surfaces to integrate:

- `superclaw.runtime.PermissionPolicy`: add plugin permission projection without weakening existing MCP config behavior.
- `superclaw.backends.CodexCliBackend`: generated MCP config should point to the SuperClaw proxy, not plugin directories.
- `superclaw.backends.ClaudeCliBackend`: `--mcp-config` may point to the SuperClaw proxy; `--plugin-dir` must remain non-commercial/generated-skill only.
- `superclaw.backends.HermesCliBackend`: use command or MCP bridge to the proxy; never pass entitlement tokens.
- `superclaw.models.EvidenceBundle`: add plugin invocation artifacts as references.
- `superclaw.protocol_adapter`: export plugin evidence and provenance without mutating core evidence.
- `superclaw.adversarial`: add checks for plugin policy bypass, revoked package execution, and secret-bearing tool output.

Acceptance:

- no existing backend receives a protected plugin directory;
- all plugin invocation evidence is represented in EvidenceBundle-compatible form;
- plugin framework code can be tested without real cloud access through a fake cloud client.

Initial backend integration slice: Codex converts SuperClaw MCP proxy JSON into
CLI `mcp_servers.*` config overrides, while Claude Code receives the same
secret-free config file through `--mcp-config`. Both fail closed on
`plugin_dirs` or MCP `env` blocks. This proves backend command construction and
non-leakage locally; it does not claim production online Codex/Claude execution
or Hermes/OpenClaw bridge support.

Hermes/OpenClaw backend guardrail slice: because the local Hermes and OpenClaw
CLI integrations do not yet expose documented SuperClaw MCP projection bridges,
they validate incoming MCP configs for secret-free shape and then fail closed
with `PLUGIN_RUNTIME_CONFIG_INVALID`. They also reject `plugin_dirs` and MCP
`env` blocks before process startup, so protected package paths and secret
values cannot be handed to these runtimes while bridge support remains
undefined.

Protocol adapter plugin evidence slice: `superclaw.protocol_adapter` exports
sanitized `plugin_evidence.invocations[]` summaries into the ClawHunt Delivery
Protocol manifest. The adapter derives the summaries from existing
`plugin_invocation` probes and `plugin-invocation` artifact metadata, prefers
the richer probe record when both refer to the same artifact id, and never reads
artifact files or mutates the original EvidenceBundle. Exported fields are
limited to plugin identity, version, tool, status, timestamps, package/input/
output digests, evidence artifact id, policy decision code, sandbox exit status,
and non-secret entitlement id.

Initial adversarial policy slice: `superclaw.adversarial` exposes a
fail-closed `plugin_policy_boundary` rule over the existing `EvidenceBundle`
surface. It detects model-visible direct plugin directory usage, protected
plugin entitlement material, revoked plugin invocations recorded as successful,
and secret-bearing plugin output payloads. This is detection-only release
governance; it does not replace proxy-time package verification, revocation
checks, sandbox preflight, or credential injection.

Acceptance:

- backend command/output evidence MUST NOT contain `--plugin-dir`,
  `plugin_dirs`, plugin cache paths, or entitlement/license token material;
- revoked plugin evidence is acceptable only when it is denied before sidecar
  execution, never when the invocation status is `ok`;
- plugin invocation evidence MUST expose digests and artifact references, not
  raw output payloads containing secret-like values;
- clean proxy-only plugin invocation evidence passes without requiring cloud
  access or real paid marketplace state.

## 25. Release Checklist

Before any plugin framework release, verify:

- Package schema is versioned.
- JSON Schema fixtures pass.
- Configuration policy schema fixtures pass.
- Tool output schema validation rejects malformed sidecar output.
- Signature verifier rejects tampered packages.
- Revocation blocks cached plugin execution.
- Entitlement denial happens before sidecar startup.
- Missing required plugin secret returns `PLUGIN_CONFIG_REQUIRED` before sidecar startup.
- Generated runtime config does not contain plugin secret values.
- Offline entitlement grace cannot exceed the 72-hour policy maximum.
- Local `/v1` plugin cloud REST endpoints expose sanitized contracts without raw evidence, local paths, or secrets.
- Local registry search and install commands expose sanitized metadata and install only through verified package metadata.
- Section 27 engineering workflow gates remain explicit and locally checkable.
- Release checklist integrity checks remain mapped to local conformance coverage.
- MCP proxy hides sidecar path and entitlement token from the underlying agent.
- Section 13 framework extension ports remain represented as code-level
  contracts before product UI or production adapters depend on them.
- Section 12 developer onboarding remains a sanitized local contract before
  marketplace payment or payout workflows ship.
- Sandbox guardrails reject undeclared filesystem, network, environment, and process behavior before sidecar startup.
- At least one Codex-backed run can call a plugin through the proxy.
- At least one Claude-backed run can call a plugin through the proxy or documented bridge.
- At least one ClawHunt-derived reusable fixture converts into a plugin package.
- At least one one-off ClawHunt delivery fixture is rejected as non-ingestible.
- At least one developer-upload fixture passes scan and signing.
- Local developer submission REST endpoints create submissions, attach local
  package artifacts through review, and return sanitized verification metadata.
- Local plugin update compatibility preflight maps candidate versions to
  required review gates before release.
- Every plugin call writes evidence.
- Delivery Protocol manifests export sanitized plugin invocation evidence.
- Model-visible output is schema-validated, redacted, and size-limited.
- No marketplace payment UI is released before local signed execution works.

Initial local implementation slice: `superclaw plugin release-checklist` turns
this section into a local governance checklist. Dry-run mode emits stable item
ids, Section 25 requirements, mapped conformance checks, repo-relative evidence
files, and explicit manual reasons for external release gates. `--run` executes
the mapped local conformance checks and reports pass/fail/manual/not-run
statuses without copying raw command stdout/stderr into the JSON payload.
`release_ready` remains false until all local checks pass and no manual gates
remain. The manual gates are currently real Codex-backed proxy execution, real
Claude-backed proxy execution, and release-manager confirmation that no
marketplace payment UI ships prematurely.

Cloud REST release-gate slice: the release checklist includes a dedicated
`cloud-rest-contract-required` item that depends on the `cloud-rest-contract`
conformance check. It requires plugin framework releases to prove the local
`/v1` plugin cloud API contract for registry metadata, version metadata,
download references, entitlement sync, revocation sync, runtime policy sync,
and evidence-summary upload remains sanitized and does not leak raw evidence,
local paths, or secrets. This is release governance over the existing local
fake-cloud REST contract only; it does not contact production SuperClaw Cloud,
implement production JWT issuing, marketplace payment, billing, payout,
package signing, or direct underlying-agent plugin loading.

Developer submission REST release-gate slice: the release checklist includes a
dedicated `developer-submission-rest-contract` item that depends on the
`developer-submission-rest` conformance check. It requires plugin framework
releases to prove local developer submission REST endpoints can create
submissions, attach local package artifacts through the Phase 4A review path,
and return sanitized verification metadata without leaking local paths, signing
private keys, cache paths, entitlement tokens, or secrets. This is release
governance over the existing local developer submission contract only; it does
not implement production developer accounts, marketplace publication, payment,
billing, payout, or production artifact hosting.

Plugin update preflight release-gate slice: the release checklist includes a
dedicated `plugin-update-preflight-required` item that depends on the
`plugin-update-preflight` conformance check. It requires plugin framework
releases to prove local update candidates are classified and mapped to required
review gates before signing, cloud policy publication, marketplace listing,
payment, cache mutation, replay, or sandbox execution. This is release
governance over the existing local compatibility preflight only; it does not
perform production signing, publish cloud policy, change marketplace state,
sync entitlements, implement payment or payout flows, mutate plugin caches,
run sidecar replay, execute sandbox smoke tests, or change backend runtime
injection.

Registry UX release-gate slice: the release checklist includes a dedicated
`registry-ux-required` item that depends on the `registry-ux` conformance check.
It requires plugin framework releases to prove local `superclaw plugin search`
and `superclaw plugin install <plugin_id>[@version]` expose sanitized registry
metadata, resolve explicit or latest versions, and install only through
verifier-backed package metadata without leaking package paths, cache paths,
sidecar paths, entitlement tokens, or secrets. This is release governance over
the existing local fake-cloud registry UX only; it does not introduce
production registry hosting, purchase flows, payment, billing, payouts,
artifact downloads from production cloud, or direct protected plugin
installation into underlying agent runtimes.

Engineering workflow release-gate slice: the release checklist includes a
dedicated `engineering-workflow-gate-required` item that depends on the
`engineering-workflow-gate` conformance check. It requires plugin framework
releases to prove that Section 27 still defines feature boundaries, required
tests, documentation updates, Gemini review, atomic commit rules, feature-group
PR rules, pre-PR sync expectations, and version/changelog hygiene as explicit
local gates. This is release governance over the development process only; it
does not execute Gemini, contact GitHub, run a rebase, stage files, create
commits, push branches, open PRs, or replace operator judgment.

Release checklist integrity slice: the release checklist includes a dedicated
`release-checklist-integrity` item that depends on the `release-checklist`
conformance check. It requires plugin framework releases to prove that Section
25 items reference known conformance checks, existing repo-relative evidence,
explicit manual gates, and sanitized JSON output, and that every conformance
check is referenced by at least one release checklist item. This is a
non-recursive local test mapping; it does not approve manual gates, perform a
production release, run online Codex or Claude jobs, contact production cloud,
or change runtime behavior.

Extension ports release-gate slice: the release checklist includes a dedicated
`extension-ports-contract-required` item that depends on the
`extension-ports-contract` conformance check. It requires Section 13 framework
extension ports to remain represented as explicit code-level contracts before
product UI or production adapters depend on them. This is release governance
over interface shape only; it does not implement production cloud clients,
signature services, entitlement JWT validation, sandbox engines, runtime proxy
rewiring, marketplace publication, payment, billing, payout, or product UI.

Sandbox release-gate slice: the release checklist includes a dedicated
`sandbox-preflight-required` item that depends on the `sandbox` conformance
check. It requires plugin framework releases to prove local pre-sidecar
guardrails reject undeclared filesystem paths, network hosts, environment
variable reads, and child-process escape attempts before sidecar startup. This
is release governance over the existing local sandbox conformance group only;
it does not introduce a production kernel sandbox, container isolation, WASI
runtime, network firewall, malware analysis, or new proxy execution behavior.

Protocol evidence release-gate slice: the release checklist includes a
dedicated `delivery-protocol-plugin-evidence-export` item that depends on the
`protocol-adapter-plugin-evidence-export` conformance check. It requires the
release gate to prove that Delivery Protocol manifests expose sanitized plugin
invocation summaries without raw payload, path, secret, or source-evidence
mutation. This is a governance dependency only; it does not change protocol
adapter behavior, plugin proxy execution, EvidenceBundle schema, artifact
formats, ClawHunt ingestion, cloud upload, marketplace behavior, payment,
signing, or backend runtime policy.

Developer onboarding release-gate slice: the release checklist includes a
dedicated `developer-onboarding-contract-required` item that depends on the
`developer-onboarding-contract` conformance check. It requires plugin framework
releases to prove the local Section 12 onboarding contract still requires
verified identity, payout profile reference, support and vulnerability
contacts, license declaration, accepted plugin policy, sample evidence fixture,
and V1 commerce-state validation while rejecting raw payment, identity, or
secret fields. This is release governance over local intake policy only; it
does not create production developer accounts, store bank or tax details,
perform KYC, implement marketplace payment, billing, payout, settlement,
package signing, entitlement sync, or runtime proxy behavior.

Second local implementation slice: `superclaw plugin release-checklist
--manual-evidence <json>` lets an operator attach explicit evidence for manual
gates. The evidence file contains a `manual_gates` array. Each row must include
`item_id`, `evidence_uri`, `verified_by`, `verified_at`, and a short sanitized
`summary`. Evidence is accepted only for manual gate item ids, duplicate ids are
rejected, `verified_at` must be ISO-8601, local evidence paths must be
repo-relative and exist, and external evidence URIs are limited to non-local
`https://` or `gh://` references. Manual evidence can make a manual item pass,
but `release_ready` still requires `--run` and all non-manual local checks to
pass.

Boundary: this release checklist is read-only governance over existing local
tests and docs plus operator-supplied evidence references. It must not contact
production SuperClaw Cloud, start a real Codex or Claude Code job, approve
manual gates without an evidence row, implement payment or marketplace flows,
upload evidence, mutate plugin caches, store secrets, accept local absolute
paths, or change runtime execution behavior.

## 26. Developer Submission Checklist

Developers must provide:

- plugin manifest;
- runnable sidecar entrypoint;
- static tool schemas;
- configuration and secret descriptors when credentials are required;
- minimum smoke test;
- expected evidence fixture;
- permission justification;
- support contact;
- license declaration;
- pricing intent;
- security notes;
- changelog for updates.

Submission is rejected if:

- the package downloads code at runtime;
- tool names or schemas differ from runtime-discovered tools;
- tests require undeclared network or filesystem permissions;
- package contains obvious secrets;
- manifest embeds secret values instead of descriptors;
- the plugin needs user or platform root LLM keys directly;
- the plugin cannot run through the SuperClaw MCP proxy.

Initial local implementation slice: Phase 4A developer-upload intake now
enforces the machine-checkable subset of this checklist before local signing.
The local gates require non-empty support, license, permission-justification,
security, and changelog files; reject obvious pricing-intent contradictions such
as free plugins with billable metering; reject direct root LLM API key requests
in the manifest; reject manifest-embedded secret values in secret descriptors
and sensitive setting defaults; require declared sidecar entrypoints to be
executable before smoke tests run; and scan entrypoints, acceptance tests, and
package scripts for runtime code-download markers. A follow-up local slice requires every
`permissions.environment[]` credential to have a matching
`configuration.secrets[]` descriptor, and rejects secret descriptors that are
not also declared as environment permissions. Another follow-up local slice requires
package-local `mcp/server.json` metadata with `proxy_required=true` and exact
plugin/runtime identity plus tool name/input/output schema parity with
`superclaw-plugin.json`, using that metadata as the local runtime-discovery
contract before production sidecar introspection exists. A later local slice
checks acceptance-test scripts for undeclared HTTP(S) hosts and absolute
filesystem paths before their smoke results are trusted. These slices are still
local/fake-cloud only: they do not
implement production identity review, pricing approval, cloud artifact upload,
marketplace listing, payment, payout, manual security review, dynamic syscall
tracing, real network egress firewalling, or filesystem mount isolation.

## 27. Engineering Workflow and Contribution Protocol

This section is mandatory for implementing the framework. The architecture above defines what to build; this section defines how the work is accepted.

### 27.1 Feature Boundary Contract

Every implementation task must start with a feature boundary card. The card may be in the issue, PR body, or implementation note, but it must identify the exact feature boundary before coding starts.

Required fields:

| Field | Requirement |
|---|---|
| Feature id | Stable short id, such as `plugin-package-validation` or `mcp-proxy-execution` |
| Phase | One of the Section 14 phases |
| Owned modules | Exact files, packages, or adapters owned by the change |
| Out of scope | Explicitly named adjacent features that must not be changed |
| Runtime boundary | Which side of Cloud, local runtime, proxy, sidecar, sandbox, or underlying agent owns the behavior |
| Security boundary | What secret, entitlement, package, or evidence data must not cross the boundary |
| Positive tests | Tests proving the intended behavior works |
| Negative tests | Tests proving invalid, unauthorized, revoked, malformed, or unsafe behavior fails closed |
| Documentation updates | User, developer, architecture, or runbook docs updated by the feature |
| Gemini verification | Summary of the Gemini cross-check performed before commit |

Feature boundaries for the initial roadmap:

| Feature group | In scope | Out of scope |
|---|---|---|
| Phase 0: Spec and fixtures | schemas, sample manifests, hello-world fixture, invalid fixtures, developer guide | runtime execution, cloud calls, marketplace UI |
| Phase 1: Local package verification | package parsing, digest, signature verification, local cache, `plugin verify` | MCP proxy execution, entitlement purchase, developer uploads |
| Phase 2: MCP proxy and sidecar execution | proxy routing, sidecar launch, entitlement gate, credential manager, evidence recording | cloud marketplace, ClawHunt ingestion, revenue settlement |
| Phase 3: ClawHunt ingestion | delivery-manifest adapter, wrapper validation, package builder, provenance mapping | generic developer upload UI, payment UI |
| Phase 4: Developer upload | upload API/CLI, static/dependency scan, sandbox smoke run, review status | public marketplace merchandising, automated payouts |
| Phase 5: Cloud sync and governance | registry, entitlement, revocation, policy sync, evidence upload | custom RPC protocol, direct protected plugin loading by underlying agents |
| Cross-phase workflow gate | feature boundary, tests, docs, Gemini review, atomic commits, PR sync, changelog/version hygiene | running Gemini, running tests, rebasing, staging, committing, pushing, opening PRs |

### 27.2 Required Tests Per Feature

No feature is complete without tests. The default requirement is at least one positive test and one negative test for every feature boundary card.

Minimum test expectations:

- Package and schema features must include valid and invalid fixtures.
- Security features must include fail-closed negative tests.
- Credential features must prove secrets are not written to generated runtime config, logs, evidence, or model-visible errors.
- Runtime integration features must prove the underlying agent can call only the SuperClaw proxy and never a protected plugin directory.
- Cloud-sync features must include fake-cloud tests so local verification does not require production cloud access.
- Documentation-only changes must at minimum pass markdown/diff checks and any available documentation validation.

### 27.3 Documentation Loop

Every completed framework feature must update the documentation that a future maintainer or plugin developer would need to use or operate it.

Required documentation mapping:

| Change type | Required documentation |
|---|---|
| public developer workflow | `docs/plugin-developer-guide.md` or equivalent developer guide |
| architecture boundary | this framework spec or an ADR |
| CLI behavior | CLI help text and user-facing docs |
| cloud API contract | API contract docs, schema, and examples |
| security behavior | runbook or security note explaining threat model and failure mode |
| test fixture | fixture README or inline comments explaining purpose and expected failure/success |

Documentation must be updated in the same atomic commit as the feature behavior unless the commit is explicitly documentation-only.

### 27.4 Atomic Commit Policy

Commits must be atomic.

Rules:

- One commit equals one independently reviewable feature, fix, test, or documentation change.
- Do not mix unrelated feature, fix, refactor, and format-only changes in one commit.
- A commit that changes runtime behavior must include its tests and required documentation in the same commit.
- A commit that changes a public schema or manifest contract must include fixtures and migration notes.
- Commit messages must use `type(scope): summary`, such as `feat(plugins): verify package signatures`.
- Do not commit generated local noise such as `.DS_Store`, local transcripts, caches, or private credentials.

### 27.5 Pre-Commit Gate

Before every commit, the implementer must run the relevant local tests and Gemini cross-verification.

Required gate:

1. Run the smallest relevant test set for the changed feature.
2. Run any broader regression suite required by the touched module.
3. Run `git diff --check` for whitespace and patch hygiene.
4. Ask Gemini to review the changed diff, focusing on feature boundary, tests, security, and missing documentation.
5. Fix blocking findings.
6. Commit only after tests pass and Gemini has no unresolved blocker.

The PR body must summarize:

- exact tests run;
- Gemini verdict and unresolved non-blocking notes;
- why the selected tests cover the feature boundary.

### 27.6 Feature Group PR Policy

Pull requests should be opened for complete feature groups, not random fragments.

Rules:

- A feature group maps to one Section 14 phase or to a clearly named subset of a phase.
- A PR may contain multiple atomic commits if they are all required for one feature group.
- A PR must not include unrelated local files or opportunistic cleanup outside the feature group.
- A draft PR is allowed for early review, but it must not be marked ready until the feature group acceptance criteria pass.
- Marketplace, payment, and public listing PRs must not be opened until local signed plugin execution works end-to-end.

### 27.7 Pre-PR Sync Gate

Before opening or updating a PR for review, the implementer must synchronize with the latest remote base branch and resolve conflicts locally.

Required sequence:

```bash
git fetch origin
git rebase origin/main
git status -sb
```

If rebase is not appropriate for the repository policy, merge from `origin/main` instead, but the PR must still prove it was tested after synchronizing.

The PR is not ready if:

- it is behind the base branch and has not been locally synchronized;
- conflicts were resolved without rerunning relevant tests;
- Gemini has not reviewed the final post-sync diff;
- generated or private local files are staged;
- version and changelog gates fail.
