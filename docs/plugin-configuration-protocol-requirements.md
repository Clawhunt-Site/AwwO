# Plugin Configuration Protocol Requirements

Status: required contract for desktop-managed SuperClaw plugins.

This document defines the normative requirements for plugin configuration
descriptors. It is the requirements source for the desktop `Manage
configuration` panel, local configuration APIs, developer upload review, and
local package verification.

Normative terms:

- MUST means the requirement is mandatory.
- MUST NOT means the behavior is forbidden.
- SHOULD means the expected best practice unless a reviewed exception exists.
- MAY means optional behavior that cannot be required by another component.

## 1. Source Of Truth

The installed plugin manifest is the source of truth for every local plugin
configuration item:

```text
superclaw-plugin.json
configuration.settings[]
configuration.secrets[]
```

Marketplace listing metadata, marketing copy, registry cards, `panel_url`,
`config_url`, generated Codex views, and MCP tool descriptions MUST NOT become
independent configuration sources. If a plugin exposes a configurable URL, mode,
limit, flag, account id, or endpoint, it MUST be represented as a
`configuration.settings[]` descriptor in the SuperClaw manifest.

The desktop panel and local API MUST read the installed cached manifest for the
selected plugin id and version before rendering or saving configuration.

## 2. Setting Descriptor Format

Each non-secret setting descriptor MUST use this shape:

```json
{
  "name": "panel_url",
  "type": "string",
  "description": "HTTPS URL for the plugin's operator panel.",
  "required": false,
  "default": "https://example.com/plugin",
  "validation": {
    "format": "uri"
  },
  "ui": {
    "control": "url",
    "label": "Panel URL",
    "placeholder": "https://example.com/plugin",
    "help": "Used by SuperClaw to open the plugin operator panel."
  }
}
```

Required fields:

- `name`: lowercase snake case, unique within the plugin.
- `type`: one of `string`, `integer`, `number`, or `boolean`.
- `description`: non-empty human-readable purpose and effect.
- `required`: boolean.

Optional fields:

- `default`: scalar default value matching `type` and `validation`.
- `validation`: machine-readable constraints.
- `ui`: desktop rendering hints.
- `env_name`: UPPER_SNAKE_CASE environment variable name. When present, the
  setting's configured value (or its `default`) is delivered to the plugin
  sidecar at invocation as this environment variable (the runtime half of the
  protocol — see §6). Settings without `env_name` are never delivered to the
  sidecar.
- `options_source`: a dynamic option provider (see §2a) — a plugin tool the
  config UI calls to populate a searchable select with runtime-discovered,
  machine-specific values (e.g. "the Chrome profiles installed on this device").
- `actions`: a list of config-time actions (see §2a) — plugin tools the config
  UI renders as buttons for interactive setup (e.g. bind / login a profile).

Settings MUST remain non-secret. API keys, tokens, passwords, private keys,
refresh tokens, session cookies, and credential-bearing URLs MUST be declared as
secrets or rejected.

## 2a. Dynamic Configuration (options discovery and setup actions)

A setting MAY declare dynamic, runtime-resolved configuration. Both shapes
reference a plugin tool by name and are invoked through the SAME governed proxy
(`invoke_cached_plugin_tool`) as any other plugin call, so they inherit
signature / revocation / entitlement / runtime-policy enforcement. Only tools
declared in the manifest can be invoked this way.

```json
{
  "name": "chrome_profile_directory",
  "type": "string",
  "env_name": "PAY_SWITCH_CHROME_PROFILE_DIRECTORY",
  "ui": { "control": "select", "label": "Chrome profile" },
  "options_source": {
    "tool": "list_chrome_profiles",
    "label": "Installed Chrome profiles",
    "arguments": { "browser": "chrome" }
  },
  "actions": [
    { "id": "bind", "tool": "bind_chrome_profile", "label": "Bind profile" }
  ]
}
```

Invocation descriptor fields:

- `tool` (required): a plugin tool name declared by the manifest. Matches
  `^[A-Za-z][A-Za-z0-9_.-]{0,127}$`.
- `id` (actions only, optional): stable identifier the UI/API uses to select the
  action; falls back to `tool`.
- `label` (optional): display label.
- `arguments` (optional): fixed arguments merged into the call (caller-supplied
  arguments take precedence).

`options_source` tools MUST return either a top-level `options` array or a bare
array; each item is a scalar or `{ "value": ..., "label"?: ... }`. The desktop
config dialog renders a searchable select populated from these and a refresh
control; `actions` render as buttons that re-run discovery afterward.

Endpoints:

- `POST /api/plugins/{id}/configuration/options` — body `{ setting, version?,
  arguments? }` → runs the setting's `options_source` and returns `{ options }`.
- `POST /api/plugins/{id}/configuration/action` — body `{ setting, action_id?,
  version?, arguments? }` → runs the matching declared action and returns
  `{ result }`.

Malformed `options_source` / `actions` are dropped (fail-soft): a bad dynamic
descriptor yields no options/buttons rather than a broken config panel.

## 3. Validation Descriptor

`validation` MAY contain:

- `enum`: non-empty list of allowed scalar values; every item MUST match
  `type`.
- `minimum`: numeric lower bound for `integer` or `number`.
- `maximum`: numeric upper bound for `integer` or `number`.
- `step`: numeric increment for `integer` or `number`, evaluated from
  `minimum` when present, otherwise from `0`.
- `minLength`: string minimum length.
- `maxLength`: string maximum length.
- `pattern`: full-string regular expression for string settings.
- `format`: currently only `uri`, restricted to HTTP(S) URLs.

Rules:

- numeric validation fields MUST only appear on `integer` or `number` settings;
- string validation fields MUST only appear on `string` settings;
- `minimum` MUST be less than or equal to `maximum`;
- `minLength` MUST be less than or equal to `maxLength`;
- `step` MUST be greater than zero;
- `format: "uri"` MUST reject values without an `http` or `https` scheme and
  host;
- `default` values MUST pass the same type and validation checks as saved
  values.

## 4. UI Descriptor

`ui.control` MAY be one of:

- `text`: single-line string input.
- `textarea`: multi-line string input.
- `url`: URL input; MUST be paired with `validation.format: "uri"`.
- `number`: numeric input; MUST be paired with `integer` or `number`.
- `switch`: boolean toggle; MUST be paired with `boolean`.
- `select`: select menu; MUST be paired with `validation.enum`.

The desktop renderer MUST derive the control from `ui.control`,
`validation.enum`, and `type`. Client-side HTML validation is a convenience only;
the backend MUST enforce the same contract before persistence.

### 4a. Two-Tier Exposure (basic steps vs. advanced)

Every exposed setting and secret MUST be classifiable into exactly one of two
tiers. This keeps the configuration surface a short, ordered checklist instead
of a flat wall of cards: a user completes the **basic** steps and the plugin is
`configured` (usable); everything optional or diagnostic stays collapsed.

The tier is declared on the `ui` object (settings and, optionally, secrets):

- `section`: `"basic"` or `"advanced"`. When omitted, the item defaults to
  `"basic"`. The legacy boolean `advanced: true` is honored as
  `section: "advanced"`.
- `step` (basic only): a positive integer (`>= 1`) that orders basic items into
  Step 1 / Step 2 / … Items without a step are ordered after numbered steps in
  declaration order.
- `step_title` (basic only): short human title for the step (e.g. "Select a
  Chrome profile").
- `step_description` (basic only): one-line guidance shown under the title.

Surfaces MUST:

- render `basic` items up-front as numbered, step-by-step required operations,
  with clear guidance, and mark the plugin ready once every basic step is
  satisfied;
- collapse all `advanced` items behind a single, default-collapsed "Advanced
  settings" disclosure at the bottom.

The canonical tier vocabulary is exported to every surface in the plugin status
contract under `configuration.tiers` (see `ui_contracts.build_plugin_status_payload`)
and enforced by `plugin_config.CONFIG_UI_SECTIONS` at install time. Malformed
tier metadata (unknown `section`, non-positive/non-integer `step`, non-string
titles) MUST be rejected fail-closed by the manifest configuration contract.

```json
{
  "name": "chrome_profile_directory",
  "type": "string",
  "ui": {
    "control": "select",
    "label": "Chrome profile",
    "section": "basic",
    "step": 1,
    "step_title": "Select a Chrome profile",
    "step_description": "Pick a signed-in profile with a saved payment method."
  }
}
```

## 5. Secret Descriptor Format

Each secret descriptor MUST use this shape:

```json
{
  "name": "PAY_SWITCH_AGENT_TOKEN",
  "description": "Token injected only into the Pay-Switch sidecar.",
  "required": false,
  "inject_as": "env",
  "env_name": "PAY_SWITCH_AGENT_TOKEN"
}
```

Rules:

- `name` and `env_name` MUST be uppercase snake case.
- `name` MUST be unique within the plugin.
- `inject_as` MUST be `env` in the current protocol.
- secret values MUST NOT appear in manifests, marketplace metadata, generated
  MCP config, generated Codex views, logs, evidence, model-visible errors, or
  desktop configuration status.
- local APIs MUST reject setting or deleting a secret that is not declared by
  the installed manifest.
- a secret MAY carry a `ui` object solely for two-tier classification (`section`,
  and the `step*` fields when basic) per §4a; secrets never expose a value-bearing
  control beyond their masked input.

### 5a. Auto-Provisioned Credentials

Some secrets are not entered by the user at all: SuperClaw provisions them from
account / login state. The canonical case is the ClawHunt account bridge
(`clawhunt_account_bridge`, see the runtime proxy): when the user is signed in,
SuperClaw performs the ClawHunt plugin-auth exchange itself and injects only the
resulting **scoped** token into the sidecar — the account access token is never
passed to the plugin.

Such credentials MUST NOT be presented as a required, user-filled step. The
kernel derives this in `plugin_configuration_status()` and the status payload is
the single source of truth every surface renders:

- A secret is **auto-provisioned** when its `env_name` (or `name`) matches the
  account bridge's `token_env` (so installed/signed packages get this for free,
  without any manifest `ui` edit). The status payload then carries:
  - `auto_provisioned: true`
  - `provisioning_provider`: human label of the provider (e.g. "ClawHunt Account")
  - `provisioning_status`: `"available"` when a login token is present locally,
    else `"unavailable"` (this is a liveness hint only — it does NOT mean a scoped
    token exchange will succeed, and the status endpoint MUST NOT perform the
    exchange or any network call).
- The kernel forces an auto-provisioned secret into the `advanced` tier
  (`ui.section = "advanced"`) and forces effective `required = false`, so it can
  never gate plugin readiness or appear as a basic step.
- A locally-saved value (manual override) still wins over the auto value at
  runtime, so surfaces SHOULD keep an optional, collapsed manual-override input.

Surfaces (Web/CLI/TUI) MUST NOT hardcode specific secret names or re-derive the
bridge rule; they render from the status payload's `auto_provisioned` /
`provisioning_*` fields and the (already coerced) `ui.section`.

## 6. Persistence And Runtime Boundaries

The local config store persists only user-provided scalar setting values and
secret records. It is not a manifest source.

Save flow:

1. Resolve installed plugin manifest by plugin id and version.
2. Confirm the requested setting or secret descriptor exists.
3. Normalize setting values to the declared JSON type.
4. Apply all descriptor validation rules.
5. Persist the normalized scalar setting value or secret record.
6. Return sanitized status.

Runtime flow:

1. Verify package digest and signature.
2. Validate manifest configuration descriptors.
3. Check revocation, entitlement, policy, and permissions.
4. Resolve required settings and secrets.
5. Inject only declared secrets through approved channels.
6. Inject only declared settings that carry an `env_name` (configured value, or
   `default`) as environment variables to the sidecar. Settings without
   `env_name`, and any env name not declared by the manifest, are never
   delivered. On an `env_name` clash, a secret value takes precedence over a
   setting value.
7. Never expose raw secret values to the underlying agent.

Dynamic-config invocations (`options_source` / `actions`, §2a) run through the
same governed proxy as a normal tool call (verify → revocation → entitlement →
policy → declared-tool check) and may only target manifest-declared tools.

## 7. Fail-Closed Requirements

SuperClaw MUST fail closed when:

- a setting or secret descriptor name is duplicated;
- a descriptor uses unsupported fields or incompatible `type`, `validation`, or
  `ui` combinations;
- a default value fails its type or validation rules;
- a saved value fails type, enum, numeric, string, URL, or step validation;
- a config API request targets an undeclared setting or secret;
- a secret-like value is found in manifest defaults, fixtures, or descriptors;
- a package tries to rely on marketplace listing metadata for runtime
  configuration.

## 8. Acceptance Criteria

A plugin configuration protocol change is accepted only when all of these pass:

- manifest schema validation for valid fixtures;
- configuration-policy schema validation for valid fixtures;
- semantic configuration contract validation during developer upload review;
- semantic configuration contract validation during local package verification;
- API tests proving undeclared setting and secret writes are rejected;
- API tests proving type, enum, string, numeric, step, and URL rules are
  enforced server-side;
- UI/build tests proving the desktop panel can render typed controls;
- secret-safety tests proving secret values do not appear in API responses or
  model-visible output;
- documentation updates in this requirements document, the developer guide, and
  the ecosystem framework.

## 9. Current Known Non-Goals

- Production macOS Keychain, Windows Credential Manager, Linux Secret Service,
  HSM, and cloud-backed secret sync remain outside this local protocol slice.
- Server-hosted user secrets are not accepted unless a future server-backed
  plugin mode records explicit user consent.
- Arbitrary JSON object/array settings are not supported. Settings are scalar
  by design so the desktop panel, CLI, API, and evidence redaction behavior stay
  predictable.

## 10. Deep Review Corrections Applied

The current protocol review found and closed these correctness gaps:

- URL controls are not only UI hints. A `ui.control: "url"` descriptor now MUST
  also declare `validation.format: "uri"`, and backend persistence MUST reject
  non-HTTP(S) URLs.
- Numeric `step` is not only an HTML input attribute. Backend persistence MUST
  enforce step alignment after type normalization, using `minimum` as the base
  when present.
- Secret writes and deletes are not free-form key/value operations. Local APIs
  MUST load the selected installed manifest and reject any secret name not
  declared in `configuration.secrets[]`.
- Package verification MUST perform semantic configuration contract validation,
  not only JSON Schema validation, before caching a plugin package.
- Developer upload review MUST run the same semantic configuration contract gate
  before signing a package.
- Marketplace cards, `config_url`, and `panel_url` MUST stay install/listing
  metadata unless the installed manifest declares a corresponding setting.

These corrections are required because the desktop `Manage configuration` panel
must be generated from one trusted source of truth and every saved value must be
validated by the runtime that will later inject settings or secrets into a
plugin process.
