# SuperClaw Plugin Developer Guide

Status: Phase 5B local plugin cloud contract guide plus Phase 2 local configuration manager

This guide is the developer-facing companion to `docs/plugin-ecosystem-framework.md`.
The normative requirements for settings, secrets, validation rules, desktop
controls, API persistence, and fail-closed behavior live in
`docs/plugin-configuration-protocol-requirements.md`. The review, approval,
signing, registry-allow, entitlement, and revocation trust boundary lives in
`docs/plugin-submission-approval-signing.md`.
It covers the Phase 0 distribution pack, Phase 1 local package verification,
Phase 2 local proxy and MCP stdio slices, Phase 3A ClawHunt ingestion, Phase 4A
developer-upload intake, Phase 5A/5B local fake-cloud governance contracts, and
the local plugin configuration manager used by Phase 2 proxy calls.
It does not claim that production SuperClaw Cloud, marketplace publishing,
payment settlement, production entitlement JWT validation, production signing,
production keychain storage, or backend runtime auto-injection is implemented
yet.

## Feature Boundary

Feature id: `phase0-plugin-distribution-pack`

Phase: `Phase 0: Spec and Fixtures`

Owned files:

- `schemas/superclaw-plugin.schema.json`
- `schemas/plugin-configuration-policy.schema.json`
- `schemas/plugin-invocation-evidence.schema.json`
- `examples/plugins/**`
- `docs/plugin-developer-guide.md`
- `tests/test_plugin_distribution_pack.py`

Out of scope:

- package signing and digest verification;
- local plugin cache;
- SuperClaw MCP proxy execution;
- cloud registry, entitlement, revocation, or policy sync;
- developer upload API;
- marketplace or payment UI.

Security boundary:

- manifests may describe secret descriptors;
- manifests and fixtures must not include real secret values;
- credential-requiring fixtures must show `PLUGIN_CONFIG_REQUIRED` when the
  local credential is absent.

## Fixture Layout

The distribution pack includes three valid plugin fixtures:

- `examples/plugins/hello-world`: minimal first-party plugin with no permissions.
- `examples/plugins/repo-scanner`: workspace-read plugin fixture.
- `examples/plugins/github-scanner`: credential-requiring plugin fixture.

It also includes one invalid fixture:

- `examples/plugins/invalid-missing-id`: intentionally missing `id`.

## Local Smoke Commands

Run the fixture smoke scripts directly:

```bash
examples/plugins/hello-world/tests/smoke.sh
examples/plugins/repo-scanner/tests/smoke.sh
examples/plugins/github-scanner/tests/smoke.sh
```

Run the Phase 0 validation tests:

```bash
pytest tests/test_plugin_distribution_pack.py
```

Expected results:

- all valid plugin manifests validate against `schemas/superclaw-plugin.schema.json`;
- expensive plugin manifests include `resource_profile` metadata for expected
  latency, CPU, memory, and I/O class;
- the GitHub configuration policy validates against
  `schemas/plugin-configuration-policy.schema.json`;
- all evidence fixtures validate against
  `schemas/plugin-invocation-evidence.schema.json`;
- `invalid-missing-id` fails deterministically because `id` is required;
- every manifest-declared test and evidence fixture path exists;
- smoke scripts do not require SuperClaw Cloud credentials.

## What Comes Next

The next feature group is Phase 1 local package verification:

- package reader;
- digest verifier;
- Ed25519 signature verifier;
- local plugin cache layout;
- `superclaw plugin list` and `superclaw plugin verify`.

Do not implement marketplace, payment, or direct protected plugin loading before
local signed plugin execution through the SuperClaw proxy is proven.

## Phase 0 Developer Quickstart CLI

Feature id: `plugin-devkit-quickstart`

Phase: `Phase 0: Spec and Fixtures`

Owned files:

- `packages/superclaw/src/superclaw/plugin_devkit.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_devkit.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- `superclaw plugin init` creates a schema-valid starter package with
  `superclaw-plugin.json`, executable sidecar, `skills/README.md`,
  `mcp/server.json`, smoke test, evidence fixture, `resource_profile`, README,
  and LICENSE;
- `superclaw plugin dev` runs a declared starter sidecar tool locally without
  cloud credentials, entitlement state, cache writes, or runtime-agent config;
- `superclaw plugin pack` creates a `.scplug` archive, refreshes the package
  digest, and can apply an explicit local/dev Ed25519 signature for verification
  exercises.

Out of scope:

- production SuperClaw Cloud signing;
- package publication, marketplace listing, payment, billing, or payout;
- cloud entitlement, revocation, or policy sync;
- installing protected plugin directories into Codex, Claude Code, Hermes, or
  OpenClaw;
- changing proxy, sandbox, or sidecar execution semantics for installed
  plugins.

Security boundary:

- `plugin dev` is local developer tooling only; it does not prove entitlement or
  production sandbox behavior;
- starter package files must not contain secret values, entitlement tokens,
  signing keys, or cloud credentials;
- dev-signed archives are for local verification exercises only and must still
  go through `plugin submit` or production signing before marketplace use.

Create a starter package:

```bash
superclaw plugin init com.example.repo-scanner --tool-name repo_scan
cd com.example.repo-scanner
```

Run the starter sidecar locally:

```bash
superclaw plugin dev . --tool repo_scan --json '{"name":"developer"}'
```

Pack with an ephemeral local/dev signature:

```bash
superclaw plugin pack . --dev-sign --json
```

The JSON output includes `package_path` and, for `--dev-sign`, a `public_key`
that can be passed to `superclaw plugin verify` for local verification:

```bash
superclaw plugin verify dist/com.example.repo-scanner-0.1.0.scplug --public-key '<public_key>'
```

Expected results:

- invalid plugin ids fail before files are written;
- existing output directories are not overwritten unless `--force` is supplied;
- undeclared tools fail before sidecar startup;
- dev-signed archives verify with the returned public key;
- unsigned archives report `requires_platform_signing = true`.

## Phase 1 Local Verification

Feature id: `plugin-package-validation`

Phase: `Phase 1: Local Package Verification`

Owned files:

- `packages/superclaw/src/superclaw/plugins.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_local_verification.py`
- `docs/plugin-developer-guide.md`

In scope:

- reading plugin packages from a directory or `.scplug` archive;
- rejecting unsafe `.scplug` archive members before extraction;
- computing the stable package digest;
- verifying Ed25519 signatures over the computed digest;
- rejecting tampered packages;
- rejecting revoked packages using local revocation metadata;
- caching verified packages under the local plugin cache;
- listing cached packages with `superclaw plugin list`.

Out of scope:

- MCP proxy execution;
- sidecar startup;
- cloud entitlement sync;
- cloud revocation download;
- developer upload API;
- marketplace listing or payment.

### Digest And Signature Contract

The local verifier computes a stable SHA-256 package digest over every package
file. For `superclaw-plugin.json`, the verifier first canonicalizes the manifest
with `provenance.package_digest` and `provenance.signature` blanked out. This
avoids a circular hash while still making any package content change detectable.

The Ed25519 signature signs the computed digest string, for example:

```text
sha256:<64 lowercase hex characters>
```

The public key may be provided by:

- `--public-key <base64-ed25519-public-key>`; or
- `SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY`.

### CLI Commands

Verify and cache a plugin:

```bash
superclaw plugin verify examples/plugins/hello-world --public-key "$SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY"
```

Return machine-readable output:

```bash
superclaw plugin verify examples/plugins/hello-world --public-key "$SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" --json
```

List cached plugins:

```bash
superclaw plugin list
superclaw plugin list --json
```

Use a custom cache during tests:

```bash
SUPERCLAW_PLUGIN_CACHE_PATH=/tmp/superclaw-plugin-cache superclaw plugin list
```

### Local Verification Tests

Run the Phase 1 tests:

```bash
pytest tests/test_plugin_local_verification.py
```

Expected results:

- a signed fixture verifies and is copied into the local cache;
- a signed `.scplug` archive verifies and is copied into the local cache;
- a tampered fixture fails with a package digest mismatch;
- an unsigned fixture fails before caching;
- a package signed by another key fails signature verification;
- an unsafe `.scplug` archive member path is rejected before extraction;
- local revocation metadata blocks a verified package before it is cached;
- `superclaw plugin verify --json` and `superclaw plugin list --json` expose stable CLI output.

## Phase 2A Local Proxy Invocation

Feature id: `plugin-proxy-sidecar-invocation`

Phase: `Phase 2: MCP Proxy and Sidecar Execution`

Owned files:

- `packages/superclaw/src/superclaw/plugin_proxy.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_proxy.py`
- `docs/plugin-developer-guide.md`

In scope:

- resolving an already verified plugin from the local cache;
- exposing a SuperClaw-owned proxy call surface through `superclaw plugin call`;
- proving the sidecar path is not returned in model-visible CLI output;
- re-verifying digest, signature, and revocation metadata before every sidecar execution;
- denying non-free plugins when local entitlement metadata is missing;
- returning `PLUGIN_CONFIG_REQUIRED` before sidecar startup when a required secret is absent;
- injecting only manifest-declared environment secrets into the sidecar;
- running the declared `mcp_sidecar` entrypoint through a restricted environment;
- validating the sidecar JSON output against the declared tool `output_schema`;
- dropping undeclared output fields when the schema sets `additionalProperties: false`;
- truncating oversized model-visible output to the manifest output budget;
- returning `PLUGIN_OUTPUT_SCHEMA_INVALID` for malformed plugin output;
- redacting secret-like stdout/stderr content before model-visible errors or evidence;
- writing a `plugin-invocation` artifact compatible with `schemas/plugin-invocation-evidence.schema.json`.

Out of scope:

- a long-running network MCP server;
- Codex, Claude Code, Hermes, or OpenClaw runtime config generation;
- secure OS keychain storage;
- cloud entitlement sync;
- cloud revocation sync;
- ClawHunt ingestion;
- developer upload API;
- marketplace listing or payment.

### Local Entitlement Fixture

Paid, private beta, subscription, and usage-metered plugins require a local
entitlement record before the proxy starts the sidecar. The Phase 2A test fixture
uses this local shape:

```json
{
  "entitlements": [
    {
      "plugin_id": "dev.superclaw.github-scanner",
      "version": "0.1.0",
      "entitlement_id": "ent_test",
      "expires_at": "2030-01-01T00:00:00Z"
    }
  ]
}
```

Free plugins do not require an entitlement record.

### Proxy Call Command

Call a cached plugin through the local proxy:

```bash
superclaw plugin call dev.superclaw.hello-world hello_world --input-json '{"name":"Ada"}'
```

Return machine-readable output:

```bash
superclaw plugin call dev.superclaw.hello-world hello_world \
  --input-json '{"name":"Ada"}' \
  --public-key "$SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" \
  --json
```

Call a non-free plugin with a local entitlement fixture:

```bash
superclaw plugin call dev.superclaw.github-scanner github_scan \
  --input-json '{"owner":"ClawHunt-Store","repo":"SuperClaw"}' \
  --public-key "$SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" \
  --entitlement-file /tmp/superclaw-entitlements.json \
  --json
```

### Local Proxy Tests

Run the Phase 2A tests:

```bash
pytest tests/test_plugin_proxy.py
```

Expected results:

- a verified cached hello-world plugin is called only through the SuperClaw proxy entrypoint;
- the CLI output does not expose the sidecar path or plugin cache path;
- a non-free plugin without entitlement returns `PLUGIN_ENTITLEMENT_MISSING` before sidecar startup;
- a revoked plugin returns `PLUGIN_REVOKED` before sidecar startup;
- a credential-requiring plugin with entitlement but no secret returns `PLUGIN_CONFIG_REQUIRED` before sidecar startup;
- a declared secret is injected only into the sidecar environment and is not written to evidence;
- undeclared output fields are dropped before model exposure;
- oversized output is truncated before model exposure;
- invalid sidecar output returns `PLUGIN_OUTPUT_SCHEMA_INVALID`;
- sidecar timeout returns `PLUGIN_TIMEOUT` and records timeout evidence;
- sidecar stderr secrets are redacted before evidence and model-visible errors;
- every invocation writes a schema-compatible `plugin-invocation` artifact.

## Phase 2B MCP Stdio Proxy Projection

Feature id: `plugin-mcp-stdio-proxy`

Phase: `Phase 2: MCP Proxy and Sidecar Execution`

Owned files:

- `packages/superclaw/src/superclaw/plugin_mcp_proxy.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_mcp_proxy.py`
- `docs/plugin-developer-guide.md`

In scope:

- projecting cached plugin tools into model-visible MCP tool metadata;
- using globally unique projected tool names such as `superclaw__dev_superclaw_hello_world__hello_world`;
- keeping the projected-name to raw plugin tool routing table private to the proxy process;
- exposing `initialize`, `tools/list`, and `tools/call` over line-delimited JSON-RPC stdio;
- routing every `tools/call` through `invoke_cached_plugin_tool`;
- generating an agent-facing MCP config with `superclaw plugin mcp-config`;
- proving the config and tool list do not expose sidecar paths, cache paths, entitlement files, revocation files, signing internals, or secrets;
- preserving Phase 2A denial behavior for unknown tools and missing entitlement.

Out of scope:

- backend-specific config injection for Codex, Claude Code, Hermes, or OpenClaw;
- multi-plugin registry selection in one MCP server process;
- cloud entitlement sync;
- secure OS keychain storage;
- network MCP transport;
- marketplace listing or payment.

### MCP Config Command

Generate a config that points to the SuperClaw proxy, not to a plugin directory:

```bash
superclaw plugin mcp-config dev.superclaw.hello-world --json
```

The generated server command uses:

```bash
python -m superclaw.plugin_mcp_proxy serve --plugin-id dev.superclaw.hello-world
```

The generated config MUST NOT include plugin cache paths, sidecar entrypoints,
entitlement tokens, local secret names, or secret values. Runtime operators pass
local state through the SuperClaw process environment and local policy files, not
through model-visible tool metadata.

### MCP Stdio Contract

The proxy supports the minimum local MCP-compatible JSON-RPC surface:

- `initialize`
- `tools/list`
- `tools/call`

`tools/list` returns only:

- projected tool name;
- tool description;
- input schema.

`tools/call` accepts the projected tool name and JSON arguments, then routes to
the raw plugin tool through the private in-process routing table.

### Local MCP Proxy Tests

Run the Phase 2B tests:

```bash
pytest tests/test_plugin_mcp_proxy.py
```

Expected results:

- projected tool metadata contains only name, description, and input schema;
- projected tool metadata and generated MCP config do not expose sidecar/cache/entitlement/secret paths;
- a JSON-RPC `tools/call` reaches hello-world only through the SuperClaw proxy;
- the stdio process supports an end-to-end `tools/list` then `tools/call` flow;
- unknown projected tools return a proxy-level `PLUGIN_TOOL_NOT_DECLARED` error;
- non-free plugins without entitlement return `PLUGIN_ENTITLEMENT_MISSING` through MCP without sidecar startup;
- malformed frames and unsupported methods fail closed as JSON-RPC errors;
- successful and denied calls still write `plugin-invocation` artifacts through the Phase 2A proxy core.

## Phase 2D Codex-Compatible Proxy View Export

Feature id: `codex-compatible-proxy-view-export`

Phase: `Phase 2: MCP Proxy and Sidecar Execution`

Owned files:

- `packages/superclaw/src/superclaw/plugin_codex_view.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_codex_view.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- generating `.codex-plugin/plugin.json` from a local SuperClaw plugin manifest;
- generating `.mcp.json` that points to `superclaw.plugin_mcp_proxy`;
- generating `skills/<tool>/SKILL.md` files that tell Codex to call the
  projected SuperClaw MCP tool;
- using the SuperClaw manifest as the source of truth;
- exporting proxy-only metadata for both free and commercial plugins;
- fail-closed behavior when the output directory already exists unless
  `--force` is provided;
- proving generated files do not expose sidecar paths, absolute plugin source
  paths, package cache paths, entitlement tokens, local secret names, MCP `env`,
  or `plugin_dirs`.

Out of scope:

- installing generated files into Codex;
- starting Codex;
- letting Codex directly load a protected plugin directory;
- exporting developer private source;
- signing packages;
- cloud registry publication;
- marketplace distribution;
- entitlement sync;
- payment, billing, or payout flows.

### Codex View Command

Generate a local derived Codex-compatible view:

```bash
superclaw plugin codex-view /path/to/plugin \
  --output-dir dist/codex-view/dev.superclaw.hello-world \
  --json
```

Generated paths:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/<tool>/SKILL.md`

The generated `.mcp.json` must call:

```bash
python -m superclaw.plugin_mcp_proxy serve --plugin-id <plugin-id> --version <version>
```

The view is deliberately a proxy stub. It is safe to hand to Codex only because
the original sidecar path, source tree, cache path, entitlement files, and
secrets stay behind the SuperClaw runtime boundary.

### Codex View Tests

Run the Phase 2D tests:

```bash
pytest tests/test_plugin_codex_view.py
```

Expected results:

- `.codex-plugin/plugin.json`, `.mcp.json`, and one skill file per tool are
  generated;
- `.mcp.json` points only to the SuperClaw MCP proxy;
- generated files contain projected MCP tool names;
- generated files do not include sidecar entrypoints, absolute package paths,
  cache paths, entitlement tokens, local secret names, MCP `env`, or
  `plugin_dirs`;
- existing output directories fail closed unless `--force` is passed.

## Phase 2C Local Sidecar Sandbox Preflight

Feature id: `plugin-sidecar-sandbox-preflight`

Phase: `Phase 2: MCP Proxy and Sidecar Execution`

Owned files:

- `packages/superclaw/src/superclaw/plugin_proxy.py`
- `tests/test_plugin_proxy.py`
- `docs/plugin-developer-guide.md`

In scope:

- pre-sidecar fail-closed checks in the SuperClaw proxy;
- blocking script-visible undeclared absolute filesystem access;
- blocking script-visible undeclared network hosts;
- blocking script-visible undeclared environment variable reads;
- blocking explicit child-process escape patterns such as `python -c`, `node -e`,
  `sh -c`, `nc`, `open`, and `osascript`;
- returning `PLUGIN_SANDBOX_VIOLATION` before sidecar startup;
- preserving earlier denial priority for missing entitlement and missing required
  local config.

Out of scope:

- kernel-level sandboxing;
- container, WASI, Deno, or seccomp enforcement;
- dynamic syscall tracing;
- binary reverse engineering;
- network egress firewalling;
- filesystem mount namespaces;
- production notarization or malware scanning.

This slice is intentionally a local preflight guardrail. It closes the current
contract gap for shell-sidecar fixtures and keeps unsafe scripts from starting,
but the production design still requires a real OS/container/WASI sandbox for
untrusted third-party binaries.

### Sandbox Violation Contract

The proxy returns `PLUGIN_SANDBOX_VIOLATION` when the entrypoint script attempts
behavior outside the declared manifest permissions. The error is model-visible
only as a stable code and generic message; raw secrets, local paths, cache paths,
sidecar paths, and private diagnostics must not be exposed to the underlying
agent.

The order remains:

1. installed package verification;
2. declared tool check;
3. entitlement check;
4. required config preflight;
5. sandbox preflight;
6. sidecar startup.

### Sandbox Preflight Tests

Run the Phase 2C tests:

```bash
pytest tests/test_plugin_proxy.py
```

Expected results:

- undeclared absolute filesystem paths return `PLUGIN_SANDBOX_VIOLATION`;
- undeclared network hosts return `PLUGIN_SANDBOX_VIOLATION`;
- undeclared inherited/local environment variable access returns
  `PLUGIN_SANDBOX_VIOLATION`;
- explicit child-process escape attempts return `PLUGIN_SANDBOX_VIOLATION`;
- sidecar marker files are not created for blocked scripts;
- missing required config still returns `PLUGIN_CONFIG_REQUIRED` before sandbox
  inspection changes the error surface.

## Phase 2D Local Plugin Configuration Manager

Feature id: `plugin-local-configuration-manager`

Phase: `Phase 2: MCP Proxy and Sidecar Execution`

Owned files:

- `packages/superclaw/src/superclaw/plugin_config.py`
- `packages/superclaw/src/superclaw/plugin_proxy.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_config.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- storing local non-secret plugin settings through `superclaw plugin config set`;
- storing local plugin secrets through `superclaw plugin secret set`;
- binding local plugin secrets to a declared plugin version range through
  `superclaw plugin secret set --version-range`;
- binding local plugin secrets to a local user/device scope through
  `--user-id` and `--device-id` or `SUPERCLAW_USER_ID` and
  `SUPERCLAW_DEVICE_ID`;
- rotating local plugin secrets by repeating `superclaw plugin secret set`;
- deleting local plugin secrets through `superclaw plugin secret delete`;
- reporting configured secret descriptors through `superclaw plugin secret status`
  without printing secret values;
- loading only manifest-declared secrets into the sidecar environment during
  `superclaw plugin call`;
- failing with `PLUGIN_CONFIG_REQUIRED` before sidecar startup when a required
  manifest secret is absent;
- failing with `PLUGIN_SECRET_UNAVAILABLE` when the local config store cannot be
  read safely;
- preventing the proxy from inheriting parent shell environment variables by
  default.

Out of scope:

- production macOS Keychain, Windows Credential Manager, Linux Secret Service,
  HSM, or cloud-backed secret storage;
- server-hosted user secrets or automatic cloud secret sync;
- automatic in-agent prompting during plugin calls; operators must configure
  values through explicit CLI or desktop plugin configuration surfaces;
- marketplace purchase, payment, payout, entitlement, revocation, or policy
  semantic changes;
- direct protected plugin installation into Codex, Claude Code, Hermes, or
  OpenClaw.

Security boundary:

- the local JSON config file is a development/test stand-in and is written with
  user-only `0600` permissions where the platform supports it;
- CLI output, model-visible proxy errors, generated MCP metadata, and invocation
  artifacts must not contain secret values;
- sidecars receive only secrets declared by their own manifest
  `configuration.secrets[]`;
- parent shell variables such as `GITHUB_TOKEN` are ignored unless they have
  been explicitly stored in the SuperClaw local config store or passed through a
  test-only explicit environment override.

### Manifest Configuration Contract

The plugin manifest is the source of truth for every setting or secret shown by
the desktop Plugins workspace, CLI status commands, and the local proxy. The
configuration block lives in `superclaw-plugin.json`:

```json
{
  "configuration": {
    "settings": [
      {
        "name": "default_owner",
        "type": "string",
        "description": "Default GitHub owner used when a scan request omits one.",
        "required": false,
        "validation": {
          "pattern": "^[A-Za-z0-9_.-]{1,80}$",
          "minLength": 1,
          "maxLength": 80
        },
        "ui": {
          "control": "text",
          "label": "Default owner",
          "placeholder": "ClawHunt-Store",
          "help": "Used only as non-secret local plugin configuration."
        },
        "default": "ClawHunt-Store"
      }
    ],
    "secrets": [
      {
        "name": "GITHUB_TOKEN",
        "description": "GitHub token used only by the plugin sidecar.",
        "required": false,
        "inject_as": "env",
        "env_name": "GITHUB_TOKEN"
      }
    ]
  }
}
```

Rules:

- `configuration.settings[]` entries MUST include `name`, `type`,
  `description`, and `required`;
- setting names MUST be lowercase snake case and are non-secret values;
- setting `type` MUST be one of `string`, `integer`, `number`, or `boolean`;
- setting `default` MAY be omitted, but required settings without stored values
  are reported as missing configuration;
- setting `validation` MAY declare `enum`, `minimum`, `maximum`, `step`,
  `minLength`, `maxLength`, `pattern`, and `format: "uri"`;
- setting `ui` MAY declare `control`, `label`, `placeholder`, `help`, and
  `advanced`; supported controls are `text`, `textarea`, `url`, `number`,
  `switch`, and `select`;
- UI controls MUST be compatible with the descriptor type: `switch` requires
  `boolean`, `number` requires `integer` or `number`, `url` requires `string`
  plus `validation.format: "uri"`, and `select` requires `validation.enum`;
- `configuration.secrets[]` entries MUST include `name`, `description`,
  `required`, `inject_as`, and `env_name`;
- secret names and environment names MUST be uppercase snake case;
- local secret set/delete APIs MUST reject names not declared by the installed
  manifest;
- secret values MUST NOT be stored in the manifest, package fixtures, generated
  MCP config, logs, evidence, or model-visible output.

The desktop app uses this same manifest block when an operator opens
`Manage configuration` for an installed plugin. The UI may show setting names,
types, descriptions, required/default/configured state, and sanitized secret
status, and it chooses typed controls from `type`, `validation.enum`, and
`ui.control`, but it MUST NOT show decrypted secret values. The local API
endpoint `GET /api/plugins/{plugin_id}/configuration?version=<version>` returns
this sanitized view from the cached manifest plus local configuration status.
Saving a setting through the desktop API must include the plugin version so the
runtime can validate the value against the same cached manifest descriptor.
Developer upload review and local package verification both run the semantic
configuration contract described in
`docs/plugin-configuration-protocol-requirements.md` before a package can be
signed or cached.

Store a non-secret setting:

```bash
superclaw plugin config set dev.superclaw.github-scanner default_owner ClawHunt-Store --json
```

Store a manifest-declared secret:

```bash
superclaw plugin secret set dev.superclaw.github-scanner GITHUB_TOKEN --value "$GITHUB_TOKEN" --json
```

Bind a secret to compatible plugin versions:

```bash
superclaw plugin secret set dev.superclaw.github-scanner GITHUB_TOKEN \
  --value "$GITHUB_TOKEN" \
  --version-range ">=0.1.0 <0.2.0" \
  --json
```

Bind a secret to a local user/device scope:

```bash
superclaw plugin secret set dev.superclaw.github-scanner GITHUB_TOKEN \
  --value "$GITHUB_TOKEN" \
  --user-id user_alpha \
  --device-id device_alpha \
  --json
```

When `--user-id` or `--device-id` are omitted, the local runtime uses
`SUPERCLAW_USER_ID` and `SUPERCLAW_DEVICE_ID`, falling back to `local-user` and
`local-device` for development and tests.

Check configured secret descriptors:

```bash
superclaw plugin secret status dev.superclaw.github-scanner --json
```

Rotate a secret by setting a new value for the same descriptor:

```bash
superclaw plugin secret set dev.superclaw.github-scanner GITHUB_TOKEN --value "$NEW_GITHUB_TOKEN" --json
```

Delete a local secret:

```bash
superclaw plugin secret delete dev.superclaw.github-scanner GITHUB_TOKEN --json
```

Call a credential-requiring plugin using a specific local config file:

```bash
superclaw plugin call dev.superclaw.github-scanner github_scan \
  --input-json '{"owner":"ClawHunt-Store","repo":"SuperClaw"}' \
  --public-key "$SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" \
  --entitlement-file /tmp/superclaw-entitlements.json \
  --config-file .superclaw/plugins/local-config.json \
  --json
```

Run the Phase 2D tests:

```bash
pytest tests/test_plugin_config.py
```

Expected results:

- `plugin config set`, `plugin secret set`, and `plugin secret status` do not
  print secret values;
- the local config store is created with `0600` permissions;
- secret status reports descriptor names, local user/device scope, and version
  ranges, never values;
- an identity-scoped secret is injected only when the local runtime user/device
  scope matches;
- a version-scoped secret is injected only when the cached plugin version matches
  that range;
- repeated `plugin secret set` overwrites the prior value without retaining it
  in the local JSON store;
- `plugin secret delete` removes the value and leaves status reporting no
  configured secret;
- `plugin call` injects the declared secret from the local store and does not
  write it to invocation artifacts;
- a parent shell secret is not inherited by default;
- invalid secret descriptor names fail closed without echoing the provided
  value.

## Phase 2E Backend Runtime MCP Policy Projection

Feature id: `plugin-runtime-mcp-policy`

Phase: `Phase 2: MCP Proxy and Sidecar Execution`

Owned files:

- `packages/superclaw/src/superclaw/backends.py`
- `tests/test_worker_backends.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- projecting SuperClaw-generated MCP proxy JSON configs into Codex CLI
  `-c mcp_servers.<name>.*` overrides;
- preserving Claude Code's existing `--mcp-config` path for the same
  secret-free SuperClaw proxy config files;
- keeping Hermes and OpenClaw fail-closed on SuperClaw MCP proxy configs until
  documented projection bridges exist;
- rejecting Codex and Claude Code `plugin_dirs` instead of silently allowing
  direct protected plugin-directory loading;
- rejecting Hermes `plugin_dirs` for the same protected package boundary;
- rejecting OpenClaw `plugin_dirs` for the same protected package boundary;
- rejecting MCP config `env` blocks during Codex projection or Claude Code
  config validation, or Hermes/OpenClaw guardrail validation, so secret values
  are not copied into command-line config overrides, transcripts, or
  model-visible errors;
- proving the generated backend command points at
  `superclaw.plugin_mcp_proxy` and not a package cache or sidecar directory.

Out of scope:

- production Codex or Claude online execution;
- Hermes or OpenClaw MCP bridge semantics;
- marketplace install, purchase, payment, metering, payout, or production
  entitlement JWT validation;
- direct protected plugin installation into Codex, Claude Code, Hermes, or
  OpenClaw.

Security boundary:

- generated runtime config may expose only the SuperClaw proxy command and
  secret-free arguments;
- plugin directories, sidecar entrypoints, entitlement tokens, cloud
  credentials, local secret values, and MCP `env` values must not be passed to
  Codex, Claude Code, or Hermes;
- invalid runtime config fails closed before the backend process starts.

Run the Phase 2E tests:

```bash
pytest tests/test_worker_backends.py
```

Expected results:

- Codex exec-mode commands receive `mcp_servers.*` overrides generated from a
  SuperClaw MCP proxy config;
- Claude Code commands receive the same secret-free config file only through
  `--mcp-config`;
- Hermes rejects safe SuperClaw MCP configs with
  `PLUGIN_RUNTIME_CONFIG_INVALID` until projection support exists, without
  invoking the Hermes process;
- OpenClaw rejects safe SuperClaw MCP configs with
  `PLUGIN_RUNTIME_CONFIG_INVALID` until projection support exists, without
  invoking the OpenClaw process;
- supported backend commands include `superclaw.plugin_mcp_proxy` and the
  plugin id;
- Codex, Claude Code, Hermes, and OpenClaw `plugin_dirs` fail with
  `PLUGIN_RUNTIME_CONFIG_INVALID` before process startup;
- MCP configs with `env` blocks fail closed for Codex, Claude Code, Hermes, and
  OpenClaw without leaking secret values into worker output or transcripts.

## Phase 3A ClawHunt Local Ingestion

Feature id: `plugin-clawhunt-local-ingestion`

Phase: `Phase 3: ClawHunt Ingestion`

Owned files:

- `packages/superclaw/src/superclaw/plugin_ingestion.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_ingestion.py`
- `docs/plugin-developer-guide.md`

In scope:

- reading an accepted ClawHunt delivery directory from local disk;
- validating that the delivery contains a reusable wrapper contract;
- requiring an EvidenceBundle reference before package generation;
- copying the declared wrapper entrypoint, acceptance tests, evidence fixtures,
  evidence bundle reference, and README into a staged plugin package;
- generating package-local `mcp/server.json` metadata that mirrors the stable
  tool schema while marking SuperClaw proxy routing as required;
- generating `replay/plugin-invocation.json` from a declared or schema-derived
  replay input;
- writing a SuperClaw plugin manifest with `source.type = clawhunt_delivery`;
- deriving `resource_profile` for ClawHunt-generated manifests when the wrapper
  omits explicit profile metadata;
- writing package-local ingestion metadata in `clawhunt-ingestion.json`;
- recording the ClawHunt problem id, submitter id, source artifacts, and stable
  source digest;
- recording attribution-only revenue metadata that links the original submitter,
  package owner, maintainer, optional bounty sponsor, pricing model, and
  `not_settled` settlement status;
- proving the staged package can be signed by a test key, verified by the
  existing local package verifier, cached, and invoked through the SuperClaw
  proxy outside the original delivery workspace.

Out of scope:

- production ClawHunt Cloud ingestion jobs;
- production cloud signing;
- direct MCP config injection into Codex, Claude Code, Hermes, or OpenClaw;
- registry upload;
- entitlement sync;
- revocation sync;
- marketplace listing;
- revenue settlement;
- payment account collection, payout splitting, or automated settlement;
- automatic wrapper synthesis from arbitrary one-off patches or prose answers;
- backend auto-injection for Codex, Claude Code, Hermes, or OpenClaw.

### Delivery Manifest Contract

Phase 3A expects a local `delivery-manifest.json` in an accepted ClawHunt delivery
directory. The minimum reusable contract is:

```json
{
  "accepted": true,
  "problem_id": "problem_123",
  "submitter_id": "dev_123",
  "package_owner_id": "owner_789",
  "bounty_sponsor_id": "sponsor_001",
  "evidence_bundle_ref": "evidence/bundle.json",
  "acceptance_tests": ["tests/smoke.sh"],
  "evidence_fixtures": ["evidence-fixtures/clawhunt-replay.json"],
  "replay_input": { "path": "." },
  "source_artifacts": [{ "kind": "wrapper", "path": "bin/repo-report" }],
  "wrapper": {
    "plugin_id": "dev.superclaw.clawhunt-repo-report",
    "tool_name": "repo_report",
    "entrypoint": "bin/repo-report",
    "description": "Run the reusable ClawHunt repository report wrapper.",
    "input_schema": { "type": "object" },
    "output_schema": { "type": "object" },
    "permissions": {
      "filesystem": [{ "mode": "read", "scope": "workspace" }],
      "network": [],
      "environment": []
    }
  }
}
```

All paths must be relative to the delivery directory. Absolute paths and `..`
segments are rejected. Phase 3A also rejects wrappers that require private account
state, environment-secret access, or runtime executable-code downloads.

### Ingestion Command

Build an unsigned staged plugin package:

```bash
superclaw plugin ingest-clawhunt /path/to/delivery --output-root dist/superclaw-plugins --json
```

The generated package is a candidate, not a trusted runtime package. It must be
signed by the platform signing step before `superclaw plugin verify` accepts it
for execution. This keeps local ingestion separate from production cloud signing.

If the wrapper omits `resource_profile`, ingestion derives declarative profile
metadata from wrapper latency, memory, filesystem, and network declarations so
the generated `superclaw-plugin.json` still satisfies the local manifest schema.
This derivation is review metadata only; it does not measure runtime resources
or grant Certified-budget exceptions.

Phase 3B also writes package-local runtime contract files:

```text
mcp/server.json
replay/plugin-invocation.json
```

`mcp/server.json` is metadata for SuperClaw's proxy boundary. Underlying agents
must still call through the SuperClaw MCP proxy; they must not load the protected
ClawHunt-derived package directly. `replay/plugin-invocation.json` records a
repeatable tool input and expected output schema so later review can replay the
wrapper outside the original delivery workspace.

Phase 3C writes attribution-only commerce metadata into
`clawhunt-ingestion.json`:

```json
{
  "revenue_attribution": {
    "source": "clawhunt_delivery",
    "policy": "attribution_only",
    "settlement_status": "not_settled",
    "problem_id": "problem_123",
    "pricing_model": "paid_per_invocation",
    "metering": "per_invocation",
    "original_submitter_id": "dev_123",
    "package_owner_id": "owner_789",
    "maintainer_id": "maintainer_456",
    "bounty_sponsor_id": "sponsor_001"
  }
}
```

This metadata is deliberately not part of `superclaw-plugin.json` v1. The
runtime manifest remains a strict execution contract, while
`clawhunt-ingestion.json` preserves marketplace/accounting context for later
cloud review. Non-free ClawHunt-derived plugins must include `submitter_id` and
either `package_owner_id` or `maintainer_id`; otherwise ingestion fails before a
candidate package is generated. This does not perform settlement or expose
payment accounts to underlying agents.

### Local Ingestion Tests

Run the Phase 3A tests:

```bash
pytest tests/test_plugin_ingestion.py
```

Expected results:

- an accepted reusable delivery emits a schema-valid staged plugin package;
- the manifest records `source.type = clawhunt_delivery`, problem id, developer id,
  source digest, and `provenance.build_type = clawhunt_delivery`;
- package-local ingestion metadata links the copied EvidenceBundle reference and
  source artifacts;
- package-local ingestion metadata includes attribution-only revenue metadata
  for the original submitter and package owner;
- generated packages contain `mcp/server.json` and
  `replay/plugin-invocation.json`;
- replay fixtures use `replay_input` when declared and otherwise derive a
  minimal input from the wrapper input schema;
- generated manifest and metadata do not expose original absolute workspace paths,
  local secret names, entitlement tokens, or plugin cache paths;
- a staged package can be signed in test, verified by `verify_plugin_package`,
  cached, and called through `invoke_cached_plugin_tool`;
- missing evidence blocks ingestion before package generation;
- one-off deliveries without reusable wrapper contracts are rejected;
- missing stable input/output schemas are rejected;
- unsafe paths and private-account wrapper contracts fail closed.
- non-free deliveries missing submitter or package owner/maintainer attribution
  ids fail closed before package generation.

## Phase 3D ClawHunt Ingestion Local REST Contract

Feature id: `plugin-clawhunt-ingestion-rest-local`

Phase: `Phase 3: ClawHunt Ingestion`

Owned files:

- `apps/api/main.py`
- `tests/test_plugin_cloud_api.py`
- `docs/plugin-developer-guide.md`

In scope:

- local `POST /v1/clawhunt/ingestions` contract backed by the fake-cloud
  filesystem root;
- accepting a local `delivery_root`, optional `manifest_path`, and optional
  `output_root` for contract tests;
- reusing `ingest_clawhunt_delivery_plugin` for accepted reusable deliveries;
- writing a sanitized local ingestion job record under the fake-cloud root;
- returning `ingestion_id`, `status`, `plugin_id`, `version`, package/source
  digests, an opaque `package_ref`, and `requires_signing`;
- failing closed for missing EvidenceBundle, missing reusable wrapper, unsafe
  paths, private account state, or other local ingestion validation failures.

Out of scope:

- connecting to real ClawHunt Cloud;
- asynchronous production job queues or background workers;
- automatic wrapper synthesis;
- production signing;
- registry upload;
- marketplace listing;
- payment, payout, settlement, or revenue calculation;
- exposing local package roots, manifest paths, metadata paths, cache paths,
  workspace paths, entitlement tokens, or secrets in REST responses.

### ClawHunt Ingestion REST Endpoint

```text
POST /v1/clawhunt/ingestions
```

Example local contract request:

```json
{
  "delivery_root": "/path/to/local/accepted-delivery",
  "manifest_path": "delivery-manifest.json"
}
```

Example response:

```json
{
  "ingestion_id": "ing_123",
  "status": "staged",
  "plugin_id": "dev.superclaw.clawhunt-rest",
  "version": "0.1.0",
  "package_digest": "sha256:...",
  "source_digest": "sha256:...",
  "package_ref": "superclaw-local://clawhunt-ingestions/packages/dev.superclaw.clawhunt-rest/0.1.0",
  "requires_signing": true
}
```

The REST response intentionally returns an opaque package reference rather than
`package_root`, `manifest_path`, or `metadata_path`.

Run the local REST contract tests:

```bash
pytest tests/test_plugin_cloud_api.py tests/test_plugin_ingestion.py
```

Expected results:

- accepted reusable deliveries stage a package and return sanitized REST
  metadata;
- missing EvidenceBundle fails before package generation;
- private-account wrappers fail closed;
- unsafe path errors are sanitized;
- REST responses and job records do not expose local workspace paths, signing
  internals, entitlement tokens, or secrets.

## Phase 4A Developer Upload Local Intake

Feature id: `plugin-developer-upload-local-intake`

Phase: `Phase 4: Developer Upload`

Owned files:

- `packages/superclaw/src/superclaw/plugin_submission.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_submission.py`
- `docs/plugin-developer-guide.md`

In scope:

- local/fake-cloud developer submission records under `.superclaw/plugins/submissions`;
- `superclaw plugin submit` for local automated intake;
- `superclaw plugin submission-status` for deterministic review-status lookup;
- manifest schema validation;
- developer source validation with `source.type = developer_upload`;
- entrypoint existence and path-safety validation;
- entrypoint executability validation before smoke tests run;
- stable package digest preflight;
- static secret scanning across text package files;
- dependency declaration or bundled dependency detection that requires a lockfile or SBOM;
- local dependency vulnerability policy enforcement from package-local
  `sbom.cdx.json`, `sbom.spdx.json`, or `dependency-vulnerabilities.json`
  fixtures, with `high` and `critical` findings blocking signing;
- Section 26 submission-document gates for support contact, license,
  permission justification, security notes, and changelog;
- pricing-intent consistency checks for obvious `commerce.pricing_model` and
  `commerce.metering` contradictions;
- rejection of direct root LLM API key requests such as `OPENAI_API_KEY`;
- rejection of manifest-embedded secret values, including secret descriptor
  `value` fields and sensitive setting defaults;
- matching `permissions.environment[]` entries and `configuration.secrets[]`
  descriptors when a plugin requires sidecar-injected credentials;
- rejection of runtime code-download markers in entrypoints, acceptance tests,
  and package scripts;
- package-local `mcp/server.json` metadata with `proxy_required=true` and tool
  plugin/runtime identity plus tool name/input/output schemas that exactly
  match `superclaw-plugin.json`;
- static acceptance-test permission hygiene that rejects undeclared HTTP(S)
  hosts and absolute filesystem paths before smoke tests are trusted;
- bounded smoke-test execution with a scrubbed environment;
- signing a copied package artifact only after every automated gate passes;
- proving the signed artifact can be verified by the existing local package verifier.

Out of scope:

- production `POST /v1/developer/plugins`;
- real cloud artifact upload or download;
- production signing service;
- marketplace listing;
- pricing, payment, or payout flows;
- entitlement sync;
- revocation sync;
- policy sync;
- evidence upload;
- continuous verification;
- manual security review;
- backend auto-injection for Codex, Claude Code, Hermes, or OpenClaw;
- changes to MCP proxy execution semantics.

### Submission Commands

Submit a local developer package for automated Phase 4A review:

```bash
superclaw plugin submit /path/to/plugin \
  --signing-private-key "$SUPERCLAW_PLUGIN_SIGNING_PRIVATE_KEY" \
  --json
```

Read the local review status:

```bash
superclaw plugin submission-status plugsub_123 --json
```

The signing key is a local fake-cloud/testing input for Phase 4A. Passing packages
receive a signed package copy in the local submission store. Failing packages do
not receive a signed artifact.

Production SuperClaw must not expose the signing private key through this local
CLI path. The production server must first bind automated gates and any required
manual approvals to the exact package digest, then an isolated signing service
may issue the SuperClaw signature. Accepting a plugin in production means the
exact reviewed package is signed and registry/governance state allows the
intended audience to install or run it. See
`docs/plugin-submission-approval-signing.md` for the full protocol.

### Local Intake Gates

Phase 4A records the following gates:

- `manifest_valid`
- `developer_source_type`
- `entrypoint_present`
- `entrypoint_runnable`
- `package_digest_stable`
- `static_secret_scan`
- `dependency_or_sbom_scan`
- `dependency_vulnerability_policy`
- `support_contact_present`
- `license_declaration_present`
- `permission_justification_present`
- `security_notes_present`
- `changelog_present`
- `pricing_intent_consistent`
- `root_llm_key_denied`
- `manifest_secret_values_denied`
- `secret_descriptors_match_environment`
- `runtime_code_download_denied`
- `runtime_tool_schema_match`
- `acceptance_test_permissions_declared`
- `evidence_fixture_present`
- `sandbox_smoke_run`
- `local_signature_issued`

The review record includes gate names, pass/fail state, digest metadata, status,
and signed artifact path when applicable. It must not include the signing private
key, user secrets, plugin cache paths, entitlement tokens, or full workspace
content.

### Dependency Vulnerability Policy

The local developer-upload path enforces a deterministic vulnerability threshold
only from package-local evidence:

- accepted evidence files are `sbom.cdx.json`, `sbom.spdx.json`, and
  `dependency-vulnerabilities.json`;
- `critical` and `high` severities block signing;
- `medium`, `moderate`, `low`, and `none` are recorded as non-blocking for this
  local slice;
- malformed vulnerability fixture JSON fails closed;
- review details include only sanitized severity counts and a small set of
  vulnerability ids.

This is not a live vulnerability scanner. The local gate does not call `npm
audit`, `pip-audit`, GitHub Advisory, OSV, cloud policy services, package
registries, or any network endpoint. It does not grant Certified status or
replace manual security review.

### Local Review Classification

Phase 4A also records the local governance classification for developer uploads:

- `requested_acceptance_level` mirrors `acceptance.level` from the manifest and
  falls back to `L1` for invalid local input;
- `listing_review_level` is `Unlisted` until automated gates pass and a local
  signed artifact is issued, then becomes `Verified`;
- `acceptance_recommendation` can be `L1` or `L2` from local automated gates,
  but never exceeds the manifest's requested level;
- `L3` requests are capped at an `L2` local recommendation and list the manual
  requirements that remain before commercial promotion;
- `certified_allowed` and `l3_allowed` are always `false` in this local slice.

This classification is review metadata only. It does not publish a marketplace
listing, grant Certified status, approve commercial promotion, run continuous
verification, or replace manual security review.

### Developer Upload Tests

Run the Phase 4A tests:

```bash
pytest tests/test_plugin_submission.py
```

Expected results:

- a valid developer-upload package passes review, receives a signed artifact, and
  the signed artifact verifies with `verify_plugin_package`;
- valid `L1` packages receive a `Verified` listing classification with an `L1`
  acceptance recommendation after local signing;
- valid `L2` packages can receive an `L2` acceptance recommendation after the
  same automated gates pass;
- valid `L3` packages are locally capped at `L2` and record the remaining manual
  security, adversarial, continuous-verification, and commercial-readiness
  requirements;
- `plugin submit` and `plugin submission-status` return deterministic JSON;
- secret-like package content fails before signing;
- dependency declarations without a lockfile or SBOM fail before signing;
- dependency vulnerability fixtures with `high` or `critical` findings fail
  before signing;
- dependency vulnerability fixtures below the local threshold do not block
  signing;
- malformed vulnerability fixtures fail closed without leaking local absolute
  paths;
- packages missing required Section 26 submission documents fail before
  signing;
- packages with contradictory pricing intent, such as `free` plus billable
  metering, fail before signing;
- packages that request root LLM keys directly fail before signing;
- packages that embed secret values in manifest secret descriptors or setting
  defaults fail before signing;
- packages whose sidecar entrypoint is present but not executable fail before
  signing;
- packages with runtime code-download markers fail before signing;
- packages missing `mcp/server.json`, omitting `proxy_required=true`, or
  drifting plugin id, version, runtime entrypoint, transport, args, or tool
  names/input/output schemas from the manifest fail before signing;
- acceptance tests that reference undeclared HTTP(S) hosts or absolute
  filesystem paths fail before signing;
- failing smoke tests fail before signing;
- non-`developer_upload` source packages fail this path;
- a missing local signing key fails after automated gates without producing a
  signed artifact.

## Phase 4A Developer Submission Local REST Contract

Feature id: `plugin-developer-submission-rest-local`

Phase: `Phase 4: Developer Upload`

Owned files:

- `apps/api/main.py`
- `packages/superclaw/src/superclaw/plugin_submission.py`
- `tests/test_plugin_cloud_api.py`
- `docs/plugin-developer-guide.md`

In scope:

- local `POST /v1/developer/plugins` submission creation backed by the
  fake-cloud filesystem root;
- local `POST /v1/developer/plugins/{submission_id}/artifact` contract that
  accepts a test-controlled local `package_path`;
- reusing the existing Phase 4A developer-upload review, smoke tests, dependency
  policy gates, and local signing path;
- local `GET /v1/developer/plugins/{submission_id}/verification` review-status
  lookup;
- returning sanitized submission ids, review status, gate outcomes, package
  digest, public signing metadata, and opaque `superclaw-local://` signed-package
  references;
- failing closed for unknown submissions or invalid package paths without
  leaking local absolute paths.

Out of scope:

- production developer upload API;
- browser or multipart artifact upload;
- remote artifact download;
- production signing service;
- marketplace listing;
- pricing approval, payment, payout, settlement, or revenue calculation;
- entitlement sync;
- revocation sync;
- policy sync;
- evidence upload;
- continuous verification;
- manual security review;
- backend auto-injection for Codex, Claude Code, Hermes, or OpenClaw;
- changes to MCP proxy execution semantics.

### Developer Submission REST Endpoints

Create a local fake-cloud submission:

```text
POST /v1/developer/plugins
```

Example request:

```json
{
  "developer_id": "dev_123",
  "plugin_id": "dev.superclaw.example",
  "requested_acceptance_level": "L1"
}
```

Attach a local package artifact and run the existing Phase 4A review:

```text
POST /v1/developer/plugins/{submission_id}/artifact
```

Example local contract request:

```json
{
  "package_path": "/path/to/local/plugin",
  "signing_private_key": "base64-ed25519-private-key-for-local-tests"
}
```

The request uses a local path because this is a fake-cloud contract test. The
response and persisted API record must not expose that path or the signing
private key.

Read the sanitized verification record:

```text
GET /v1/developer/plugins/{submission_id}/verification
```

Example response:

```json
{
  "schema_version": "0.1.0",
  "submission_id": "plugsub_123",
  "status": "verified",
  "plugin_id": "dev.superclaw.example",
  "version": "0.1.0",
  "ready_for_signing": true,
  "listing_review_level": "Verified",
  "acceptance_recommendation": "L1",
  "package_digest": "sha256:...",
  "signature_issued": true,
  "signed_package_ref": "superclaw-local://developer-submissions/plugsub_123/signed-package"
}
```

Run the local REST contract tests:

```bash
pytest tests/test_plugin_cloud_api.py tests/test_plugin_submission.py
```

Expected results:

- creating a submission returns a stable `plugsub_` id;
- uploading a valid developer package runs the existing local review and returns
  sanitized `Verified` status with an opaque signed-package reference;
- rejected packages return `Unlisted` review metadata without a signed-package
  reference;
- invalid package paths return `400` with a generic validation error and no
  absolute path leakage;
- unknown submissions return `404`;
- responses and persisted fake-cloud API records omit package paths, review
  paths, private signing keys, entitlement tokens, cache paths, and secrets.

## Phase 4B Plugin Update Compatibility Preflight

Feature id: `plugin-update-compatibility-preflight`

Phase: `Phase 4: Developer Upload`

Owned files:

- `packages/superclaw/src/superclaw/plugin_updates.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_updates.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- read-only comparison of two local plugin package directories or `.scplug`
  archives;
- sanitized `plugin-update-preflight.json` review records;
- SemVer classification for patch, minor, major, invalid, and non-increasing
  updates;
- tool input-schema changes mapped to `compatibility_review`;
- tool output-schema changes mapped to `evidence_replay`;
- new filesystem, network, environment, or future process permissions mapped to
  `security_review`;
- runtime metadata changes mapped to `sandbox_smoke`;
- commerce metadata changes mapped to `commerce_review`;
- major-version updates mapped to `side_by_side_install`;
- patch updates with no tool schema, permission, runtime, or commerce change
  marked as `automated_review_allowed` with `automated_tests` still required.

Out of scope:

- production signing;
- cloud policy publication;
- marketplace listing;
- entitlement sync;
- payment, billing, or payout flows;
- plugin cache mutation;
- real sidecar replay execution;
- real sandbox smoke execution;
- backend auto-injection for Codex, Claude Code, Hermes, or OpenClaw.

### Update Preflight Command

Compare a previous and candidate package:

```bash
superclaw plugin update-preflight /path/to/previous /path/to/candidate \
  --output-dir .superclaw/plugins/update-reviews \
  --json
```

Expected JSON fields:

- `status`: `automated_review_allowed`, `manual_review_required`, or
  `rejected`;
- `automated_review_allowed`: true only for low-risk patch updates that still
  require automated tests;
- `required_reviews`: ordered review gates such as `automated_tests`,
  `compatibility_review`, `evidence_replay`, `security_review`,
  `sandbox_smoke`, `commerce_review`, and `side_by_side_install`;
- `record.findings`: sanitized findings that name the changed contract surface
  without exposing local package paths, entitlement tokens, cache paths, or
  secret values.

### Update Preflight Tests

Run the Phase 4B tests:

```bash
pytest tests/test_plugin_updates.py
```

Expected results:

- patch updates without tool schema, permission, runtime, or commerce changes
  allow automated review while still requiring `automated_tests`;
- tool input-schema changes require `compatibility_review`;
- tool output-schema changes require `evidence_replay`;
- new filesystem, network, and environment permissions require
  `security_review`;
- runtime entrypoint changes require `sandbox_smoke`;
- commerce changes require `commerce_review`;
- major updates require `side_by_side_install`;
- CLI JSON output writes a sanitized review report and does not leak local
  package paths.

## Phase 5A Local Cloud Sync and Governance

Feature id: `plugin-cloud-sync-local-governance`

Phase: `Phase 5: Cloud Sync and Governance`

Owned files:

- `packages/superclaw/src/superclaw/plugin_cloud.py`
- `packages/superclaw/src/superclaw/plugin_proxy.py`
- `packages/superclaw/src/superclaw/plugin_mcp_proxy.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_cloud.py`
- `docs/plugin-developer-guide.md`

In scope:

- local fake-cloud registry metadata under `.superclaw/plugins/cloud/registry`;
- sanitized local registry search through `superclaw plugin search`;
- user-friendly registry install through `superclaw plugin install <plugin_id>[@version]`;
- installing a package from registry metadata only through existing digest,
  signature, revocation, and cache verification;
- local fake-cloud entitlement sync into `~/.superclaw/plugins/entitlements.json`;
- local offline entitlement grace clamping with a 72-hour platform maximum;
- local offline entitlement grace disabling when entitlement or synced policy
  marks a plugin as high risk, live-metered, or offline-grace denied;
- local fake-cloud revocation sync into `~/.superclaw/plugins/revocations.json`;
- local fake-cloud runtime policy sync into
  `~/.superclaw/plugins/runtime-policy.json`;
- proxy enforcement of synced runtime policy before sidecar startup;
- policy-based minimum SuperClaw runtime version enforcement;
- policy-based sidecar timeout tightening;
- policy-based model-output budget tightening;
- privacy-preserving evidence summary upload into the local fake-cloud evidence
  store;
- CLI commands for local contract testing.

Out of scope:

- production SuperClaw Cloud HTTP APIs;
- marketplace listing, payment, metering settlement, or payouts;
- production entitlement JWT validation;
- production registry storage;
- production signing service;
- remote artifact upload or download;
- custom RPC protocol;
- direct protected plugin loading by Codex, Claude Code, Hermes, OpenClaw, or any
  underlying agent runtime;
- backend auto-injection of plugin MCP configs.

### Local Fake-Cloud Layout

Phase 5A uses a local directory as the cloud contract fixture:

```text
.superclaw/plugins/cloud/
  registry/plugins/<plugin_id>/<version>/metadata.json
  registry/plugins/<plugin_id>/<version>/package/
  governance/entitlements.json
  governance/revocations.json
  governance/runtime-policy.json
  evidence/
```

Registry metadata points to a signed package directory inside the registry tree.
`cloud-install` never trusts metadata alone: it still calls the existing package
verifier before caching.

### Cloud Sync Commands

Search local fake-cloud registry metadata:

```bash
superclaw plugin search hello --runtime mcp_sidecar --json
```

Install a plugin with the user-facing command from Section 7.1:

```bash
superclaw plugin install dev.superclaw.hello-world@0.1.0 \
  --public-key "$SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" \
  --json
```

Install a plugin from local fake-cloud registry metadata:

```bash
superclaw plugin cloud-install dev.superclaw.hello-world 0.1.0 \
  --public-key "$SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY" \
  --json
```

Sync local governance files:

```bash
superclaw plugin cloud-sync --json
```

Upload a cloud-safe evidence summary:

```bash
superclaw plugin evidence-upload-local .superclaw/artifacts/run/evidence.json \
  --json
```

`plugin install` resolves the latest local registry version when `@version` is
omitted. It is a thin user-facing wrapper over the same fake-cloud metadata and
package verifier used by `cloud-install`.

The CLI output is intentionally minimal. Search and install output must not
print registry package paths, cache paths, sidecar paths, entitlement tokens,
cloud credentials, signing internals, or secret values.

### Runtime Governance Rules

The proxy enforces synced governance before sidecar execution:

- expired entitlement records return `PLUGIN_ENTITLEMENT_EXPIRED`;
- entitlement records whose `offline_grace_expires_at` is stale, or whose synced
  offline window exceeds 72 hours, return `PLUGIN_ENTITLEMENT_EXPIRED` before
  sidecar startup;
- entitlement records whose synced policy or entitlement metadata disables
  offline grace receive `offline_grace_expires_at == synced_at` plus
  `offline_grace_disabled_reason`, so offline proxy execution returns
  `PLUGIN_ENTITLEMENT_EXPIRED` before sidecar startup;
- entitlement records whose `version_range` does not include the cached package
  version are ignored, so the invocation returns `PLUGIN_ENTITLEMENT_MISSING`
  before sidecar startup if no matching entitlement remains;
- synced revocation metadata returns `PLUGIN_REVOKED` for already cached
  packages;
- synced revocation metadata must include one of the framework-defined reason
  codes, otherwise local sync and `/v1/plugins/revocations` fail closed before
  the metadata is accepted;
- denylisted runtime permissions return `PLUGIN_PERMISSION_DENIED`;
- synced `minimum_runtime_version` returns `PLUGIN_PERMISSION_DENIED` when the
  local SuperClaw runtime version is below the policy minimum, before sidecar
  startup;
- synced `max_tool_timeout_ms` can only tighten the plugin-declared sidecar
  timeout and returns `PLUGIN_TIMEOUT` when the sidecar exceeds the synced
  policy limit;
- synced `max_model_output_bytes` can only tighten model-visible output size.

Local Phase 0 package validation also enforces v1 platform ceilings directly in
`schemas/superclaw-plugin.schema.json`: startup timeout <= 3000 ms, tool timeout
<= 30000 ms, model-visible output <= 65536 bytes, raw evidence <= 5242880 bytes,
and sidecar memory <= 512 MB. A manifest that exceeds these ceilings fails
schema validation before install. Certified-budget overrides are reserved for a
future signed cloud policy path and are not encoded by raising local manifest
`limits`.

The same schema requires `resource_profile` for expensive local manifests:
`acceptance.latency_budget_ms > 10000`, `limits.tool_timeout_ms > 10000`,
`limits.max_model_output_bytes > 32768`, `limits.max_evidence_bytes > 1048576`,
or `limits.max_memory_mb > 256`. The profile is declarative review metadata
only in Phase 0. It does not start a sidecar, measure runtime CPU/memory, change
proxy scheduling, or grant Certified-budget exceptions.

Policy sync stores secret descriptors only. It must not contain secret values,
private keys, entitlement tokens, local credential paths, cache paths, or
sidecar paths.

### Evidence Upload Contract

Evidence upload stores a summary, not the full EvidenceBundle. The summary may
include counts, verdicts, plugin ids, plugin versions, package digests,
entitlement ids, artifact ids, and stable digests of raw fields.

`POST /v1/evidence/plugin-invocations` enforces the Section 6.4 minimum
invocation summary contract before storing the record. Required fields are
`run_id`, `plugin_id`, `plugin_version`, `package_digest`, `tool_name`,
`started_at`, `finished_at`, `status`, `entitlement_id`, `input_digest`,
`output_digest`, and `evidence_artifact_id`. Digests must use `sha256:<64 hex>`,
status must be one of `ok`, `error`, `denied`, or `timeout`, and `finished_at`
must not be earlier than `started_at`.

It must not include:

- raw command output;
- raw worker transcript output;
- full workspace paths;
- raw plugin inputs or outputs;
- stderr content;
- secret values;
- local cache paths or sidecar paths.

### Cloud Sync Tests

Run the Phase 5A tests:

```bash
pytest tests/test_plugin_cloud.py
```

Expected results:

- fake-cloud registry install verifies and caches a signed package;
- `plugin search` returns sanitized registry metadata without package paths;
- `plugin install` resolves explicit or latest registry versions and still
  verifies package signature/digest before caching;
- expired synced entitlement blocks paid-plugin execution before sidecar startup;
- cloud sync clamps overlong offline entitlement grace to the 72-hour platform
  maximum;
- cloud sync and `/v1/entitlements/sync` disable offline grace for high-risk,
  live-metered, or explicitly offline-denied entitlement policy;
- the proxy rejects overlong local offline entitlement grace before sidecar
  startup;
- the proxy accepts matching entitlement version ranges and rejects mismatched
  version ranges before sidecar startup;
- synced revocation blocks an already cached plugin;
- synced policy updates max output size and denylisted permissions;
- synced minimum runtime version blocks sidecar execution before startup;
- synced max tool timeout can shorten sidecar execution and record
  `PLUGIN_TIMEOUT`;
- policy denylist blocks sidecar execution before startup;
- evidence upload omits raw outputs and workspace paths;
- evidence upload rejects missing minimum invocation fields, malformed digests,
  invalid statuses, and reversed timestamp windows;
- CLI install/upload output does not expose cache paths.

## Phase 5D Local Plugin Evidence Retention

Feature id: `plugin-evidence-retention-local`

Phase: `Phase 5: Cloud Sync and Governance`

Owned files:

- `packages/superclaw/src/superclaw/plugin_evidence.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_evidence.py`
- `docs/plugin-developer-guide.md`

In scope:

- listing local plugin invocation evidence summaries from
  `.superclaw/artifacts/plugins`;
- pruning successful invocation evidence older than the default 7-day retention
  window;
- clearing selected local evidence artifacts by artifact id;
- locking failed, disputed, revoked, timeout, sandbox/security-flagged, or
  explicitly retention-locked records against automatic prune and user clear;
- avoiding raw plugin input/output, raw stderr/stdout, absolute artifact roots,
  cache paths, sidecar paths, entitlement tokens, and secret values in CLI
  summary output.

Out of scope:

- production cloud retention policy;
- raw EvidenceBundle upload;
- dispute workflow creation or resolution;
- package cache deletion;
- revocation metadata deletion;
- billing, payments, or marketplace quality scoring.

### Evidence Retention Commands

List local plugin invocation evidence:

```bash
superclaw plugin evidence-list --json
```

Prune successful evidence older than 7 days:

```bash
superclaw plugin evidence-prune --retention-days 7 --json
```

Clear selected unlocked evidence:

```bash
superclaw plugin evidence-clear plugininv_abc123 --json
```

The commands operate on `.superclaw/artifacts/plugins` by default. Use
`--artifact-dir` in tests or controlled local environments. `evidence-list`
returns summaries only: artifact id, relative path, plugin id, version, tool
name, status, timestamps, entitlement id, and lock status. It does not print raw
plugin inputs, raw plugin outputs, stderr, stdout, absolute artifact-root paths,
cache paths, sidecar paths, entitlement tokens, or secret values.

### Evidence Retention Tests

Run the Phase 5D tests:

```bash
pytest tests/test_plugin_evidence.py
```

Expected results:

- local evidence listing returns sanitized summaries without raw fields or
  absolute artifact roots;
- expired successful evidence is pruned after the retention window;
- recent successful evidence is retained;
- failed, timeout, and explicitly retention-locked evidence is retained;
- selected clear deletes unlocked evidence and refuses locked records.

## Section 23 Local Plugin Runtime Diagnostics

Feature id: `plugin-runtime-diagnostics-local`

Phase: `Phase 5: Cloud Sync and Governance`

Owned files:

- `packages/superclaw/src/superclaw/plugin_evidence.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_evidence.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- summarizing local plugin invocation evidence from
  `.superclaw/artifacts/plugins`;
- reporting slow plugin calls based on `started_at` and `finished_at`;
- reporting high per-plugin/per-tool failure rates above a configurable
  threshold;
- reporting repeated sandbox/security kills based on
  `PLUGIN_SANDBOX_VIOLATION` evidence;
- returning only aggregate counters, thresholds, finding codes, plugin/tool
  identifiers, and artifact ids.

Out of scope:

- changing sidecar startup, timeout, concurrency, or sandbox enforcement;
- running plugin replays or continuous verification jobs;
- uploading diagnostics to production cloud;
- marketplace ranking, billing, payment, payout, or dispute adjudication;
- exposing raw plugin inputs, raw outputs, stdout/stderr, absolute artifact
  roots, cache paths, sidecar paths, entitlement tokens, or secret values.

### Runtime Diagnostics Command

Generate a local runtime-health report:

```bash
superclaw plugin diagnostics --json
```

Tune thresholds for controlled tests or local investigation:

```bash
superclaw plugin diagnostics \
  --slow-call-ms 30000 \
  --failure-rate-threshold 0.5 \
  --failure-rate-min-invocations 3 \
  --sandbox-kill-threshold 2 \
  --json
```

The command is read-only. It does not prune evidence, start sidecars, mutate
plugin caches, sync cloud governance, or upload reports. JSON output includes
`ok`, `artifact_count`, aggregate `summary`, active `thresholds`, and sanitized
`findings`.

### Runtime Diagnostics Tests

Run the Section 23 local diagnostics tests:

```bash
pytest tests/test_plugin_evidence.py
```

Expected results:

- healthy or empty evidence directories return `ok = true`;
- slow calls produce `PLUGIN_RUNTIME_SLOW_CALL`;
- failure rates above threshold produce
  `PLUGIN_RUNTIME_HIGH_FAILURE_RATE`;
- repeated sandbox/security kills produce
  `PLUGIN_RUNTIME_REPEATED_SANDBOX_KILLS`;
- invalid records are ignored rather than leaking parser errors;
- CLI output omits raw plugin data, absolute artifact roots, and secret-like
  values.

## Section 12 Local Developer Onboarding Contract

Feature id: `plugin-developer-onboarding-contract-local`

Phase: `Cross-phase developer ecosystem governance`

Owned files:

- `packages/superclaw/src/superclaw/plugin_developer_onboarding.py`
- `tests/test_plugin_developer_onboarding.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- validating that developer onboarding includes a verified identity or
  organization;
- requiring a payout profile reference, not raw payout account data;
- requiring support contact, license declaration, vulnerability disclosure
  contact, accepted plugin-policy version and timestamp, and a sample evidence
  fixture;
- accepting only V1 commerce states: `free`, `private_beta`, and
  `paid_manual`;
- returning a sanitized profile payload that exposes presence booleans and
  review references instead of sensitive values;
- rejecting raw payment, identity, or secret-like field names such as account
  numbers, routing numbers, card numbers, tax ids, tokens, and private keys.

Out of scope:

- production developer accounts or KYC;
- storing bank, card, tax, or identity-document values;
- marketplace listing approval;
- payment, billing, payout, settlement, or revenue-split execution;
- package signing, entitlement sync, cloud upload, or runtime proxy behavior;
- direct access to protected plugin source by Codex, Claude Code, Hermes, or
  OpenClaw.

Run the Section 12 local onboarding tests:

```bash
pytest tests/test_plugin_developer_onboarding.py
```

Expected results:

- a verified developer profile with an existing repo-relative evidence fixture
  passes;
- pending or missing identity verification fails closed;
- raw sensitive payout fields are rejected without leaking field values in the
  sanitized payload;
- absolute or parent-traversal evidence fixture paths are rejected without
  leaking the absolute path;
- unsupported future commerce states fail until the marketplace/payment layer
  is explicitly implemented;
- missing policy acceptance, contacts, license declaration, or evidence fixture
  fails before any package can be treated as marketplace-ready.

## Section 13 Framework Extension Port Contracts

Feature id: `plugin-extension-ports-contract-local`

Phase: `Cross-phase extension port governance`

Owned files:

- `packages/superclaw/src/superclaw/plugin_ports.py`
- `tests/test_plugin_ports.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- representing all Section 13 extension ports as runtime-checkable Python
  `Protocol` contracts;
- publishing a stable local port-spec registry for `cloud-client`,
  `signature-verifier`, `entitlement`, `sandbox`, `mcp-proxy`,
  `bounty-ingestion`, `developer-submission`, and `credential-manager`;
- documenting each port id, Section id, protocol name, and responsibility list;
- exposing a sanitized contract payload with `runtime_behavior_changed=false`
  and `production_adapters_included=false`;
- proving the contract module imports without running sidecars, contacting
  cloud services, reading credentials, or mutating runtime state.

Out of scope:

- refactoring existing runtime modules to depend on these protocols;
- production SuperClaw Cloud clients;
- production signature services;
- entitlement JWT validation;
- production sandbox engines;
- MCP proxy routing changes;
- ClawHunt ingestion behavior changes;
- developer-upload review behavior changes;
- credential storage behavior changes;
- marketplace publication, payment, billing, payout, or product UI.

Run the Section 13 port contract tests:

```bash
pytest tests/test_plugin_ports.py
```

Expected results:

- every Section 13.1 through 13.8 port is represented by a stable port id and a
  runtime-checkable Protocol class;
- cloud-client responsibilities cover registry lookup, entitlement sync,
  package download, revocation sync, policy sync, and evidence upload;
- runtime/security ports keep entitlement, sandbox, MCP proxy, and
  credential-manager responsibilities explicit;
- ecosystem ports cover bounty ingestion and developer submission boundaries;
- the contract payload omits token values, private keys, secret values, local
  absolute paths, and direct `plugin_dirs`;
- importing `superclaw.plugin_ports` is contract-only and does not change
  runtime behavior.

## Section 22 Local Plugin Conformance Suite

Feature id: `plugin-conformance-suite-local`

Phase: `Cross-phase conformance`

Owned files:

- `packages/superclaw/src/superclaw/plugin_conformance.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_conformance.py`
- `docs/plugin-developer-guide.md`

In scope:

- mapping Section 22 package validation, runtime proxy, sandbox, cloud contract,
  and ClawHunt ingestion conformance groups to concrete local commands;
- mapping the Section 22.1 package-validation group to schema, distribution
  pack, and local verification tests;
- mapping the Section 4.0 / Section 19 / Phase 0B developer quickstart CLI to a
  `developer-devkit` conformance check;
- mapping the Phase 1 local package verification slice to a
  `local-package-verification` conformance check;
- mapping the Section 22.2 runtime-proxy group to proxy and MCP projection
  tests;
- mapping the Section 6 / Phase 5B local cloud REST API contract to a dedicated
  `cloud-rest-contract` conformance check;
- mapping the Section 21 runtime error contract to a dedicated
  `runtime-error-contract` conformance check;
- mapping the Section 7.4 local credential-manager slice to its own
  `credential-manager` conformance check;
- mapping the Section 24/25 backend runtime policy slice to a
  `backend-runtime-policy` conformance check;
- mapping the Section 24/25 adversarial plugin policy slice to an
  `adversarial-policy` conformance check;
- mapping the Section 13 framework extension ports contract to an
  `extension-ports-contract` conformance check;
- mapping the Section 24 Delivery Protocol plugin evidence export slice to a
  `protocol-adapter-plugin-evidence-export` conformance check;
- mapping the Section 23 local runtime diagnostics slice to a
  `runtime-diagnostics` conformance check;
- mapping the Phase 5D local evidence retention slice to an
  `evidence-retention` conformance check;
- mapping the Section 22.3 sandbox group to local proxy preflight tests;
- mapping the Section 22.4 cloud-contract group to local fake-cloud governance
  and privacy tests, including minimum invocation-summary validation;
- mapping the Section 7.1 / Phase 5E local registry UX slice to a
  `registry-ux` conformance check;
- mapping the Phase 5C offline entitlement governance slice to an
  `entitlement-governance` conformance check;
- mapping the Section 6.6 / Section 26 / Phase 4A developer-upload intake slice
  to a `developer-upload` conformance check;
- mapping the Section 6.6 developer submission REST contract to a
  `developer-submission-rest` conformance check;
- mapping the Section 22.5 / Phase 3 ClawHunt ingestion slice to a
  `clawhunt-ingestion` conformance check;
- mapping the Section 25 local release checklist to a `release-checklist`
  conformance check;
- dry-run listing of check ids, requirements, commands, and evidence files;
- optional `--run` execution of the mapped local commands;
- returning pass/fail/not-run summaries without echoing raw test stdout or
  stderr;
- matrix integrity guardrails for unique check ids, local pytest-only commands,
  repo-relative paths, existing evidence files, and command targets listed as
  evidence;
- failing closed when an unknown conformance check id is requested.

Out of scope:

- replacing the underlying pytest suites;
- contacting production SuperClaw Cloud;
- uploading raw evidence;
- mutating plugin caches, entitlement files, or revocation files;
- running marketplace payment, billing, payout, or dispute workflows.

List the local conformance matrix:

```bash
superclaw plugin conformance --json
```

Run the runtime proxy group:

```bash
superclaw plugin conformance --check-id runtime-proxy --run --json
```

Run the package validation group:

```bash
superclaw plugin conformance --check-id package-validation --run --json
```

Run the developer quickstart CLI group:

```bash
superclaw plugin conformance --check-id developer-devkit --run --json
```

Run the local package verification group:

```bash
superclaw plugin conformance --check-id local-package-verification --run --json
```

Run the runtime error contract group:

```bash
superclaw plugin conformance --check-id runtime-error-contract --run --json
```

Run the local credential-manager group:

```bash
superclaw plugin conformance --check-id credential-manager --run --json
```

Run the backend runtime policy group:

```bash
superclaw plugin conformance --check-id backend-runtime-policy --run --json
```

Run the adversarial plugin policy group:

```bash
superclaw plugin conformance --check-id adversarial-policy --run --json
```

Run the extension ports contract group:

```bash
superclaw plugin conformance --check-id extension-ports-contract --run --json
```

Run the developer onboarding contract group:

```bash
superclaw plugin conformance --check-id developer-onboarding-contract --run --json
```

Run the Delivery Protocol plugin evidence export group:

```bash
superclaw plugin conformance --check-id protocol-adapter-plugin-evidence-export --run --json
```

Run the local runtime diagnostics group:

```bash
superclaw plugin conformance --check-id runtime-diagnostics --run --json
```

Run the local evidence retention group:

```bash
superclaw plugin conformance --check-id evidence-retention --run --json
```

Run the local sandbox guardrail group:

```bash
superclaw plugin conformance --check-id sandbox --run --json
```

Run the local cloud governance contract group:

```bash
superclaw plugin conformance --check-id cloud-contract --run --json
```

Run the local registry UX group:

```bash
superclaw plugin conformance --check-id registry-ux --run --json
```

Run the local cloud REST contract group:

```bash
superclaw plugin conformance --check-id cloud-rest-contract --run --json
```

Run the offline entitlement governance group:

```bash
superclaw plugin conformance --check-id entitlement-governance --run --json
```

Run the developer-upload intake group:

```bash
superclaw plugin conformance --check-id developer-upload --run --json
```

Run the developer submission REST contract group:

```bash
superclaw plugin conformance --check-id developer-submission-rest --run --json
```

Run the plugin update compatibility preflight group:

```bash
superclaw plugin conformance --check-id plugin-update-preflight --run --json
```

Run the ClawHunt ingestion adapter group:

```bash
superclaw plugin conformance --check-id clawhunt-ingestion --run --json
```

Run the local release checklist group:

```bash
superclaw plugin conformance --check-id release-checklist --run --json
```

Run all mapped groups:

```bash
superclaw plugin conformance --run --json
```

Expected results:

- dry-run output includes all Section 22 groups, the Section 7.4
  credential-manager group, the Section 4.0/19 developer-devkit group, the
  Phase 1 local-package-verification group, the Section 23
  runtime-diagnostics group, the Phase 5D evidence-retention group, the
  Section 21 runtime-error-contract group, the Section 24/25
  backend-runtime-policy group, the Section 24/25 adversarial-policy group, the
  Section 24 protocol-adapter-plugin-evidence-export group, the Section 12
  developer-onboarding-contract group, the Section 7.1 registry-ux group, the
  Section 6 cloud-rest-contract group, the Phase 5C entitlement-governance
  group, the Section 6.6 developer-upload group, the Section 6.6
  developer-submission-rest group, the Section 10.3/Phase 4B
  plugin-update-preflight group, the Section 13 extension-ports-contract group,
  the Section 25 release-checklist group, and their mapped evidence files;
- `package-validation` maps to `tests/test_plugin_distribution_pack.py`,
  `tests/test_plugin_local_verification.py`, and
  `schemas/superclaw-plugin.schema.json`;
- `cloud-rest-contract` maps to `tests/test_plugin_cloud_api.py`;
- `developer-devkit` maps to `tests/test_plugin_devkit.py`;
- `local-package-verification` maps to `tests/test_plugin_local_verification.py`;
- `runtime-proxy` maps to `tests/test_plugin_proxy.py` and
  `tests/test_plugin_mcp_proxy.py`;
- `entitlement-governance` maps to `tests/test_plugin_cloud.py` and
  `tests/test_plugin_cloud_api.py`;
- `developer-upload` maps to `tests/test_plugin_submission.py`;
- `developer-submission-rest` maps to `tests/test_plugin_cloud_api.py`,
  `tests/test_plugin_submission.py`, `apps/api/main.py`, and
  `packages/superclaw/src/superclaw/plugin_submission.py`;
- `plugin-update-preflight` maps to `tests/test_plugin_updates.py`,
  `packages/superclaw/src/superclaw/plugin_updates.py`, and
  `packages/superclaw/src/superclaw/cli.py`;
- `runtime-error-contract` maps to `tests/test_plugin_proxy.py` and
  `tests/test_plugin_cloud.py`;
- `credential-manager` maps to `tests/test_plugin_config.py`;
- `runtime-diagnostics` maps to `tests/test_plugin_evidence.py`;
- `evidence-retention` maps to `tests/test_plugin_evidence.py`;
- `sandbox` maps to `tests/test_plugin_proxy.py` and
  `tests/test_plugin_mcp_proxy.py`;
- `cloud-contract` maps to `tests/test_plugin_cloud.py` and
  `tests/test_plugin_cloud_api.py`;
- `backend-runtime-policy` maps to `tests/test_worker_backends.py`;
- `adversarial-policy` maps to `tests/test_adversarial.py` and
  `tests/test_adversarial_hardening.py`;
- `extension-ports-contract` maps to `tests/test_plugin_ports.py`,
  `packages/superclaw/src/superclaw/plugin_ports.py`, and
  `docs/plugin-ecosystem-framework.md`;
- `developer-onboarding-contract` maps to
  `tests/test_plugin_developer_onboarding.py`,
  `packages/superclaw/src/superclaw/plugin_developer_onboarding.py`, and
  `docs/plugin-ecosystem-framework.md`;
- `protocol-adapter-plugin-evidence-export` maps to
  `tests/test_protocol_adapter.py`;
- `registry-ux` maps to `tests/test_plugin_cloud.py`;
- `clawhunt-ingestion` maps to `tests/test_plugin_ingestion.py`;
- `release-checklist` maps to `tests/test_plugin_release.py`;
- `--run` returns `passed` only when the mapped command exits successfully;
- failures return `ok = false` and a non-zero CLI exit code;
- raw command stdout/stderr is not copied into the JSON payload.
- every default check id is unique, every command is local pytest-only, every
  evidence path is repo-relative and exists, and each command test target is
  included in that check's evidence list.

## Section 24 Delivery Protocol Plugin Evidence Export

Feature id: `protocol-adapter-plugin-evidence-export`

Phase: `Cross-phase delivery protocol integration`

Owned files:

- `packages/superclaw/src/superclaw/protocol_adapter.py`
- `tests/test_protocol_adapter.py`
- `docs/plugin-developer-guide.md`
- `docs/plugin-ecosystem-framework.md`

In scope:

- deriving sanitized plugin invocation summaries from existing
  `plugin_invocation` probes and `plugin-invocation` artifact metadata;
- exporting those summaries under `plugin_evidence.invocations[]` in the
  ClawHunt Delivery Protocol manifest;
- de-duplicating probe+artifact evidence for the same `evidence_artifact_id`
  while preferring the richer probe summary;
- exposing only plugin id, plugin version, tool name, status, timestamps,
  package/input/output digests, evidence artifact id, policy decision code,
  sandbox exit status, and non-secret entitlement id;
- preserving non-plugin Delivery Protocol output and not mutating the original
  `EvidenceBundle`.

Out of scope:

- changing plugin proxy execution, EvidenceBundle schema, or artifact record
  shape;
- reading local plugin artifact files;
- exporting raw plugin input/output, stdout/stderr, full policy diagnostics,
  absolute artifact paths, cache paths, sidecar paths, entitlement tokens, or
  secret values;
- uploading evidence to ClawHunt or SuperClaw Cloud;
- changing ClawHunt ingestion or package signing behavior.

Run the protocol adapter tests:

```bash
pytest tests/test_protocol_adapter.py
```

Expected results:

- non-plugin delivery protocol manifests remain unchanged and omit
  `plugin_evidence`;
- plugin delivery manifests include sanitized `plugin_evidence.invocations[]`;
- probe+artifact records for the same invocation appear once;
- artifact-only records still produce a minimal artifact-reference summary;
- plugin invocation probes are excluded from generic manifest examples so raw
  diagnostics cannot leak through `body_preview`;
- the source `EvidenceBundle` is unchanged after export.

## Section 24 Local Plugin Adversarial Policy Checks

Feature id: `plugin-adversarial-policy-local`

Phase: `Cross-phase adversarial verification`

Owned files:

- `packages/superclaw/src/superclaw/adversarial.py`
- `tests/test_adversarial.py`
- `tests/test_adversarial_hardening.py`
- `docs/plugin-developer-guide.md`

In scope:

- a fail-closed `plugin_policy_boundary` adversarial rule;
- detecting direct plugin-directory or `plugin_dirs` exposure in command,
  worker, probe, artifact metadata, or submission evidence;
- detecting entitlement/license token field exposure in model-visible evidence;
- rejecting plugin invocation records where a revoked plugin is still recorded
  with status `ok`;
- detecting secret-like values inside raw plugin output fields such as
  `output_payload`, `stdout`, `stderr`, or `tool_output`;
- allowing clean SuperClaw-proxy invocation evidence that contains plugin ids,
  tool names, status, digests, and artifact references only.

Out of scope:

- replacing proxy-time package verification, entitlement checks, revocation
  enforcement, output-schema validation, or sandbox preflight;
- reading plugin artifact files from disk;
- contacting SuperClaw Cloud or a marketplace service;
- changing backend command construction or plugin invocation behavior;
- automatically redacting evidence after a failure is detected.

Run the local adversarial checks:

```bash
pytest tests/test_adversarial.py tests/test_adversarial_hardening.py
```

Expected results:

- the rule contract list includes `plugin_policy_boundary`;
- clean proxy-only plugin invocation evidence passes;
- direct protected plugin directory exposure fails closed;
- revoked-plugin success evidence fails closed, while revoked-denial evidence
  remains valid;
- secret-bearing raw plugin output evidence fails closed;
- the rule remains idempotent when `apply_adversarial_profile` is called
  repeatedly.

## Section 25 Local Release Checklist

Feature id: `plugin-release-checklist-local`

Phase: `Cross-phase release governance`

Owned files:

- `packages/superclaw/src/superclaw/plugin_release.py`
- `packages/superclaw/src/superclaw/plugin_conformance.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_release.py`
- `tests/test_plugin_conformance.py`
- `docs/plugin-developer-guide.md`

In scope:

- listing every Section 25 local release criterion as a stable checklist item;
- mapping each item to one or more existing conformance checks and
  repo-relative evidence files;
- mapping local `/v1` plugin cloud REST contract readiness to the
  `cloud-rest-contract` conformance check;
- mapping local registry search/install readiness to the `registry-ux`
  conformance check;
- mapping Section 27 engineering workflow readiness to the
  `engineering-workflow-gate` conformance check;
- mapping release checklist integrity readiness to the `release-checklist`
  conformance check;
- mapping sandbox readiness to the `sandbox` conformance check;
- mapping Delivery Protocol plugin evidence export readiness to the
  `protocol-adapter-plugin-evidence-export` conformance check;
- mapping Section 13 extension port contract readiness to the
  `extension-ports-contract` conformance check;
- marking real Codex-backed runs, real Claude-backed runs, and payment UI
  release review as explicit manual gates instead of pretending unit tests prove
  them;
- accepting an optional operator-supplied manual evidence JSON file for manual
  gate item ids;
- optional `--run` execution of the mapped local conformance checks;
- returning sanitized JSON with `ok`, `release_ready`, status summaries, item
  ids, evidence paths, manual reasons, and manual evidence references;
- failing closed when a checklist item references an unknown conformance check,
  unsafe evidence path, missing evidence file, duplicate id, or non-Section 25
  section;
- failing closed when manual evidence references a non-manual item, unknown
  item, duplicate id, unsafe local path, missing local evidence file, unsupported
  URI scheme, invalid timestamp, or overlong summary.

Out of scope:

- performing an actual production release;
- contacting production SuperClaw Cloud;
- running real Codex or Claude Code online jobs;
- approving manual release gates without explicit evidence rows;
- implementing marketplace payment, billing, payout, purchase, or public
  listing workflows;
- uploading, storing, or syncing the referenced manual evidence;
- changing plugin runtime, proxy, cloud-sync, package verification,
  ClawHunt-ingestion, or developer-upload behavior.

List the local release checklist:

```bash
superclaw plugin release-checklist --json
```

Run the mapped local conformance checks:

```bash
superclaw plugin release-checklist --run --json
```

Attach operator evidence for manual gates:

```bash
superclaw plugin release-checklist \
  --run \
  --manual-evidence release/manual-evidence.json \
  --json
```

Manual evidence file format:

```json
{
  "manual_gates": [
    {
      "item_id": "codex-backed-proxy-run",
      "evidence_uri": "release/codex-proxy-run.json",
      "verified_by": "release-manager",
      "verified_at": "2026-06-01T00:00:00Z",
      "summary": "Codex proxy run reviewed with sanitized evidence."
    },
    {
      "item_id": "claude-backed-proxy-run",
      "evidence_uri": "gh://ClawHunt-Store/SuperClaw/actions/runs/123",
      "verified_by": "release-manager",
      "verified_at": "2026-06-01T00:00:00Z",
      "summary": "Claude proxy run reviewed with sanitized evidence."
    },
    {
      "item_id": "marketplace-payment-no-go",
      "evidence_uri": "https://github.com/ClawHunt-Store/SuperClaw/pull/75",
      "verified_by": "release-manager",
      "verified_at": "2026-06-01T00:00:00Z",
      "summary": "Release scope reviewed and payment UI is not included."
    }
  ]
}
```

Expected results:

- dry-run output includes all Section 25 checklist items;
- every non-manual item maps to existing local conformance coverage and
  repo-relative evidence;
- `cloud-rest-contract-required` maps to `cloud-rest-contract`,
  `tests/test_plugin_cloud_api.py`, `apps/api/main.py`, and
  `packages/superclaw/src/superclaw/plugin_cloud.py`;
- `developer-submission-rest-contract` maps to `developer-submission-rest`,
  `tests/test_plugin_cloud_api.py`, `tests/test_plugin_submission.py`, and
  `apps/api/main.py`, and
  `packages/superclaw/src/superclaw/plugin_submission.py`;
- `plugin-update-preflight-required` maps to `plugin-update-preflight`,
  `tests/test_plugin_updates.py`,
  `packages/superclaw/src/superclaw/plugin_updates.py`,
  `packages/superclaw/src/superclaw/cli.py`, and
  `docs/plugin-ecosystem-framework.md`;
- `registry-ux-required` maps to `registry-ux`, `tests/test_plugin_cloud.py`,
  `packages/superclaw/src/superclaw/plugin_cloud.py`, and
  `packages/superclaw/src/superclaw/cli.py`;
- `engineering-workflow-gate-required` maps to `engineering-workflow-gate`,
  `tests/test_plugin_workflow.py`,
  `packages/superclaw/src/superclaw/plugin_workflow.py`, and
  `docs/plugin-ecosystem-framework.md`;
- `release-checklist-integrity` maps to `release-checklist`,
  `tests/test_plugin_release.py`,
  `packages/superclaw/src/superclaw/plugin_release.py`, and
  `packages/superclaw/src/superclaw/cli.py`;
- `extension-ports-contract-required` maps to `extension-ports-contract`,
  `tests/test_plugin_ports.py`,
  `packages/superclaw/src/superclaw/plugin_ports.py`, and
  `docs/plugin-ecosystem-framework.md`;
- `developer-onboarding-contract-required` maps to
  `developer-onboarding-contract`,
  `tests/test_plugin_developer_onboarding.py`,
  `packages/superclaw/src/superclaw/plugin_developer_onboarding.py`, and
  `docs/plugin-ecosystem-framework.md`;
- `sandbox-preflight-required` maps to `sandbox`,
  `tests/test_plugin_proxy.py`, and `tests/test_plugin_mcp_proxy.py`;
- `delivery-protocol-plugin-evidence-export` maps to
  `protocol-adapter-plugin-evidence-export`, `tests/test_protocol_adapter.py`,
  and `packages/superclaw/src/superclaw/protocol_adapter.py`;
- `codex-backed-proxy-run`, `claude-backed-proxy-run`, and
  `marketplace-payment-no-go` remain `manual` until an operator records the
  external release evidence;
- manual evidence is accepted only for manual gate item ids and only with
  repo-relative existing local paths or non-local `https://` / `gh://`
  references;
- `release_ready` is false until all local checks have passed and no manual
  gates remain;
- raw command stdout/stderr is not copied into the JSON payload.

## Section 27 Local Engineering Workflow Gate

Feature id: `plugin-workflow-gate-local`

Phase: `Cross-phase engineering workflow governance`

Owned files:

- `packages/superclaw/src/superclaw/plugin_workflow.py`
- `packages/superclaw/src/superclaw/plugin_conformance.py`
- `packages/superclaw/src/superclaw/plugin_release.py`
- `packages/superclaw/src/superclaw/cli.py`
- `tests/test_plugin_workflow.py`
- `tests/test_plugin_conformance.py`
- `tests/test_plugin_release.py`
- `docs/plugin-ecosystem-framework.md`
- `docs/plugin-developer-guide.md`

In scope:

- checking that Section 27 still defines every required feature boundary card
  field;
- checking that Section 27 requires positive and negative tests per feature;
- checking that Section 27 maps behavior changes to required documentation;
- checking atomic commit, pre-commit, feature-group PR, and pre-PR sync rules;
- checking that Gemini review remains an explicit pre-commit and post-sync
  expectation;
- checking local `VERSION` SemVer shape plus `CHANGELOG.md` Unreleased and
  released-version headings;
- exposing the check through `superclaw plugin workflow-gate --json`;
- mapping the workflow gate into `superclaw plugin conformance` and the Section
  25 release checklist.

Out of scope:

- running tests, Gemini, git fetch, git rebase, git commit, git push, or PR
  creation;
- deciding whether a specific PR truly satisfied Gemini or remote-sync review;
- replacing human review of feature boundaries, manual release gates, or PR
  scope;
- contacting GitHub, production SuperClaw Cloud, payment systems, or runtime
  agents;
- changing plugin runtime, proxy, cloud, package verification, ClawHunt
  ingestion, developer-upload, or release-checklist execution behavior.

Check the local engineering workflow gates:

```bash
superclaw plugin workflow-gate --json
```

Expected results:

- `feature-boundary-card` passes only when Section 27 lists feature id, phase,
  owned modules, out-of-scope, runtime boundary, security boundary, positive
  tests, negative tests, documentation updates, and Gemini verification;
- `tests-per-feature` passes only when Section 27 still requires positive and
  negative tests and fail-closed security/cloud test expectations;
- `documentation-loop` passes only when Section 27 maps developer, architecture,
  CLI, cloud API, security, and fixture changes to required documentation;
- `atomic-commit-policy`, `pre-commit-gate`, `feature-group-pr-policy`, and
  `pre-pr-sync-gate` pass only when the corresponding process rules remain
  explicit in the framework document;
- `version-changelog-gate` passes only when `VERSION` is SemVer,
  `CHANGELOG.md` includes `## [Unreleased]`, and at least one released version
  heading exists;
- output is read-only, sanitized JSON and does not mutate repository state.

## Phase 5B Local Cloud REST Contract API

Feature id: `plugin-cloud-rest-contract-local`

Phase: `Phase 5: Cloud Sync and Governance`

Owned files:

- `apps/api/main.py`
- `packages/superclaw/src/superclaw/plugin_cloud.py`
- `tests/test_plugin_cloud_api.py`
- `docs/plugin-developer-guide.md`

In scope:

- local REST contract endpoints backed by the same fake-cloud filesystem store;
- searchable plugin registry metadata;
- sanitized plugin-version metadata;
- opaque short-lived download references that do not expose local filesystem
  paths;
- device/runtime-scoped entitlement sync responses;
- revocation sync endpoint;
- runtime-policy sync endpoint;
- evidence invocation summary upload endpoint;
- API tests proving endpoint shape and non-leakage.

Out of scope:

- production SuperClaw Cloud hosting;
- real package download URLs;
- account login, purchase, payment, billing, or payout flows;
- production entitlement JWT issuing or validation;
- public marketplace discovery ranking;
- production evidence retention policy;
- direct protected plugin loading by Codex, Claude Code, Hermes, OpenClaw, or any
  other underlying agent runtime.

### Local REST Endpoints

The Phase 5B endpoints mirror the framework ports in
`docs/plugin-ecosystem-framework.md`:

```text
GET  /v1/plugins
GET  /v1/plugins/{plugin_id}/versions/{version}
GET  /v1/plugins/{plugin_id}/versions/{version}/download
POST /v1/entitlements/sync
GET  /v1/plugins/revocations
GET  /v1/policies/runtime
POST /v1/evidence/plugin-invocations
```

These are local contract endpoints. They use
`SUPERCLAW_PLUGIN_CLOUD_PATH` or `.superclaw/plugins/cloud` as the fake-cloud
root and are protected by `SUPERCLAW_CONTROL_TOKEN` when that token is
configured.

### API Non-Leakage Rules

The REST API must not expose:

- local registry package paths;
- plugin cache paths;
- sidecar entrypoint paths;
- local workspace paths;
- signing private keys;
- secret values;
- raw command output or raw worker transcript output.

The download endpoint returns an opaque `superclaw-local://...` reference for
local contract testing, not a real filesystem path or production URL.

### API Tests

Run the Phase 5B API tests:

```bash
pytest tests/test_plugin_cloud_api.py
```

Expected results:

- registry list/version/download endpoints return sanitized metadata and support
  filter parameters;
- entitlement sync returns device/runtime/plugin-scoped local entitlement tokens;
- entitlement sync includes `synced_at` and an `offline_grace_expires_at` capped
  to the 72-hour platform maximum;
- revocation and runtime policy endpoints return only governance metadata;
- evidence upload accepts digest-based summaries;
- evidence upload rejects summaries containing raw output, workspace paths, or
  secret-looking values.
