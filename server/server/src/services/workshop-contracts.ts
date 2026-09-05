/**
 * Capability Workshop — static contract builders (slice 1).
 *
 * Faithful Node port of the SuperClaw kernel contract source
 * `packages/superclaw/src/superclaw/ui_contracts.py`:
 *   - GITHUB_PLUGIN_CATALOG               (apps/api/main.py:1059)
 *   - build_catalog_contract_payload()    (ui_contracts.py:901)
 *   - build_capability_upload_contract()  (ui_contracts.py:998)
 *
 * These three endpoints carry NO governance decision and need no Python runtime,
 * crypto, R2 or DB — they are the lowest-risk first slice that proves the Node
 * route module + mount + frontend zero-drift. The web surface contract source of
 * truth is the frontend TS types in apps/web/src/App.tsx (CatalogContractPayload,
 * CapabilityUploadContract); these builders MUST stay byte-for-shape identical to
 * the Python originals — the workshop-contracts vitest golden-tests them.
 */

// ui_contracts.py:37 — PROVENANCE_TRUST_STATES (untrusted→official, least→most trusted)
const PROVENANCE_TRUST_STATES = ["untrusted", "local", "developer", "official"] as const;

// ui_contracts.py:38 — PROVENANCE_TRUST_COPY
const PROVENANCE_TRUST_COPY: Record<string, string> = {
  official: "Official",
  developer: "Developer signed",
  local: "Local",
  untrusted: "Untrusted",
};

// capability_registry.py:21 — CAPABILITY_KINDS (kernel set; drift guard below)
const CAPABILITY_KINDS = ["plugin", "skill", "company"] as const;

// plugin_submission.py:70 — REQUIRED_SUBMISSION_DOCS canonical filenames (first
// candidate of each gate, in declaration order).
const PLUGIN_REQUIRED_DOCS = ["SUPPORT.md", "LICENSE", "PERMISSIONS.md", "SECURITY.md", "CHANGELOG.md"];

/**
 * GITHUB_PLUGIN_CATALOG — static GitHub-release plugin config (apps/api/main.py:1059).
 * No pinned digest: authenticity is enforced by the Ed25519 signature against the
 * root key at install time, id/version re-checked post-install.
 */
// Currently empty: the pay-switch-agent entry was removed when its signed .scplug
// release asset was lost with the GitHub org suspension (ClawHunt-Store/pay-switch-0.2.0
// is private with no releases). Re-add an entry here (public release URL) to make a
// plugin installable from GitHub again.
export const GITHUB_PLUGIN_CATALOG: ReadonlyArray<Record<string, string>> = [];

/** GET /api/plugins/github-catalog payload. */
export function buildGithubCatalogPayload(): { plugins: Array<Record<string, string>> } {
  return { plugins: GITHUB_PLUGIN_CATALOG.map((entry) => ({ ...entry })) };
}

/**
 * build_catalog_contract_payload() — shared Capability Workshop catalog contract
 * for all user-facing surfaces (ui_contracts.py:901).
 */
export function buildCatalogContractPayload(): Record<string, unknown> {
  const itemFields = [
    "kind",
    "plugin_id",
    "version",
    "name",
    "summary",
    "description",
    "trust",
    "trust_reasons",
    "signer_class",
    "namespace_reserved",
    "install_state",
    "entitlement_state",
    "revoked",
    "sources",
    "instantiable",
  ];
  return {
    capability: "capability-catalog",
    schema_version: "0.1.0",
    status_url: "/v1/catalog",
    refresh_url: "/v1/catalog/refresh",
    trust_state_url_template: "/v1/catalog/trust/{plugin_id}/{version}",
    legacy_views: {
      plugins_url: "/v1/plugins",
      skills_url: "/v1/skills",
    },
    kinds: ["plugin", "skill", "company"],
    // Most→least trusted: reversed(PROVENANCE_TRUST_STATES).
    trust_states: [...PROVENANCE_TRUST_STATES].reverse(),
    signer_classes: ["root", "developer", "local_dev", "explicit", "none"],
    item_fields: itemFields,
    plugin_view_backfill_fields: [
      "catalog_kind",
      "trust",
      "trust_reasons",
      "signer_class",
      "namespace_reserved",
      "install_state",
      "entitlement_state",
      "revoked",
      "sources",
      "instantiable",
    ],
    conflict_reasons: [
      { id: "same_id_different_signer", severity: "error", blocks_install: true },
      { id: "namespace_hijack", severity: "error", blocks_install: true },
      { id: "revoked", severity: "error", blocks_install: true },
    ],
    install_blocking: {
      untrusted: true,
      revoked: true,
      namespace_hijack: true,
    },
    instantiable_semantics: {
      plugin: "install",
      skill: "install",
      company: "bootstrap_proposal",
      derived_from_trust: true,
      company_instantiable_trust: ["official", "local"],
      company_developer_disabled_reason: "developer_source_not_instantiable_pending_verify",
    },
    copy: {
      trust: { ...PROVENANCE_TRUST_COPY },
      conflict_banner: "Catalog conflicts require review before install.",
      refresh_failed: "Catalog refresh failed; cached catalog remains active.",
      company_instantiate_cta: "Instantiate company",
      company_developer_disabled: "Developer-source companies are not yet instantiable.",
      company_untrusted_disabled: "Untrusted companies cannot be instantiated.",
    },
  };
}

/**
 * build_capability_upload_contract() — single source for the LOCAL developer-upload
 * surface (ui_contracts.py:998). Frames the package as a local path, excludes
 * signing/publish/listing, and advertises per-kind review depth.
 */
export function buildCapabilityUploadContract(): Record<string, unknown> {
  const kinds = [
    {
      value: "plugin",
      label: "Plugin",
      id_field: "plugin_id",
      id_placeholder: "dev.namespace.plugin",
      summary: "An MCP tool/runtime your agents can call.",
      package_format: "A directory (or .scplug archive) built on this machine.",
      contents: [
        {
          path: "superclaw-plugin.json",
          required: true,
          detail:
            "Manifest: id, version, runtime, tools, permissions, acceptance, commerce, provenance.",
        },
        {
          path: "runtime entrypoint",
          required: true,
          detail: "The executable the manifest points at (must exist and be runnable).",
        },
        ...PLUGIN_REQUIRED_DOCS.map((doc) => ({
          path: doc,
          required: true,
          detail: "Required developer documentation.",
        })),
        {
          path: "acceptance tests + evidence fixtures",
          required: true,
          detail: "Declared in the manifest's acceptance block; permissions must be declared.",
        },
        {
          path: "lockfile or SBOM",
          required: false,
          detail: "Required only when the package declares or bundles dependencies.",
        },
      ],
      review: "Full automated preflight gate battery, including a sandbox smoke run.",
    },
    {
      value: "skill",
      label: "Skill",
      id_field: "skill_id",
      id_placeholder: "skill.namespace.name",
      summary: "A reusable instruction/playbook surfaced to runtimes.",
      package_format: "A SKILL.md file (or a folder containing SKILL.md).",
      contents: [
        {
          path: "SKILL.md",
          required: true,
          detail:
            "Frontmatter must declare name, description and a MAJOR.MINOR.PATCH version; the body must be non-empty.",
        },
      ],
      review: "Lightweight review (markdown/frontmatter validity + secret scan).",
    },
    {
      value: "company",
      label: "Company",
      id_field: "company_id",
      id_placeholder: "company.namespace.name",
      summary: "A pre-built agent company template.",
      package_format: "A company template manifest built on this machine.",
      contents: [
        {
          path: "superclaw-company.json",
          required: true,
          detail:
            "Company template manifest with a MAJOR.MINOR.PATCH version that loads and passes contract validation.",
        },
      ],
      review: "Lightweight review (template load + contract validity + version).",
    },
  ];

  // Defensive: keep the contract's kind vocabulary locked to the kernel's set so a
  // future kind added to one but not the other surfaces as a contract drift.
  const contractKinds = new Set(kinds.map((entry) => entry.value));
  const kernelKinds = new Set<string>(CAPABILITY_KINDS);
  if (
    contractKinds.size !== kernelKinds.size ||
    [...contractKinds].some((value) => !kernelKinds.has(value))
  ) {
    const missing = [...kernelKinds].filter((value) => !contractKinds.has(value)).sort();
    const extra = [...contractKinds].filter((value) => !kernelKinds.has(value)).sort();
    throw new Error(
      `capability-upload contract drifted from CAPABILITY_KINDS (missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)})`,
    );
  }

  return {
    capability: "capability-upload",
    schema_version: "0.1.0",
    artifact_source: "local_path",
    excludes: ["signing_private_key", "publish", "marketplace_listing"],
    kinds,
    acceptance_levels: [
      { value: "L1", label: "L1 · baseline", detail: "Manifest valid, tool schemas match, sandbox smoke run passes." },
      {
        value: "L2",
        label: "L2 · hardened",
        detail: "Adds stable digest, runnable entrypoint, declared test permissions and evidence fixtures.",
      },
      {
        value: "L3",
        label: "L3 · high assurance",
        detail: "Adds manual security review and commercial-readiness checks.",
      },
    ],
    copy: {
      source_hint:
        "Pick a capability package you built on this machine — the local control plane reads the path directly.",
      signing_excluded:
        "Signing is a separate, post-review step and is never part of uploading. Don't paste a signing key here.",
      review_note:
        "Uploading runs local preflight review only. It never signs, publishes, or lists your capability.",
      smoke_note:
        "Plugin review runs your entrypoint in a sandbox smoke test; skills and companies get a lighter, code-free review.",
    },
  };
}
