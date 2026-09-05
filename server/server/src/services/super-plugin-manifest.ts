/**
 * SuperClaw plugin manifest (`superclaw-plugin.json`) parser + validator — P1 of
 * the Node dual-format plugin runtime (docs/capability-workshop-dual-plugin-runtime-design.md).
 *
 * Validation is delegated to the CANONICAL schema (`schemas/superclaw-plugin.schema.json`,
 * mirrored into `super-plugin.schema.ts` with a drift test) compiled with AJV
 * (draft 2020-12). The schema is the single source of truth — it already enforces
 * the security-relevant shapes the Node runners depend on:
 *   - `id` pattern (lowercase dotted segments, no path separators)
 *   - `runtime.type` enum: mcp_sidecar | external_mcp (unknown types fail closed)
 *   - mcp_sidecar REQUIRES `entrypoint` (pattern `^(?!/)(?!.*\.\.).+` — no absolute / no `..`)
 *   - external_mcp+stdio REQUIRES a BARE `command` (pattern `^[^/\\]+$`) — never an
 *     on-disk path; external_mcp+sse/http REQUIRES `url`
 *   - `additionalProperties: false` everywhere
 * Re-implementing these by hand (the schema uses `$ref`/`$defs`/conditional `allOf`)
 * would drift; AJV resolves them faithfully.
 *
 * This is structure + identity ONLY. Cryptographic admission (cosign/digest/
 * revocation/R2) stays in the Python gate (H architecture). Runtime exec gates
 * (exec-bit, realpath jail inside the package root, launcher allowlist, env
 * allowlist, timeout) live in the runners (P3/P4) — the schema's `command`/
 * `entrypoint` patterns are the manifest-level half of that defense in depth.
 */

import Ajv2020 from "ajv/dist/2020.js";
import { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

import { SUPER_PLUGIN_SCHEMA } from "./super-plugin.schema.js";

export const SUPER_PLUGIN_MANIFEST_NAME = "superclaw-plugin.json";

/** The ONLY runtime types the schema allows (kept in sync via the schema drift test). */
export const KNOWN_SUPER_RUNTIME_TYPES = new Set(["mcp_sidecar", "external_mcp"]);

export class SuperPluginManifestError extends Error {}

export interface SuperPluginTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
}

export interface SuperPluginRuntime {
  /** "mcp_sidecar" | "external_mcp". */
  readonly type: string;
  /** "stdio" | "sse" | "http". */
  readonly transport: string;
  readonly args: readonly string[];
  /** mcp_sidecar: package-relative entrypoint script/binary (non-escaping). */
  readonly entrypoint?: string;
  /** external_mcp + stdio: a BARE launcher name (no path), allowlisted by the runner. */
  readonly command?: string;
  /** external_mcp + sse/http: the remote MCP endpoint. */
  readonly url?: string;
}

export interface SuperPluginManifest {
  readonly schemaVersion: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly summary?: string;
  readonly runtime: SuperPluginRuntime;
  readonly tools: readonly SuperPluginTool[];
  /** Signed skill-origin marker — a skill must never be loaded as a plugin. */
  readonly skillOrigin: boolean;
}

// Compile the canonical schema once. Interop shims mirror plugin-config-validator.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
const AjvCtor = (Ajv2020 as any).default ?? Ajv2020;
const applyFormats = (addFormats as any).default ?? addFormats;
/* eslint-enable @typescript-eslint/no-explicit-any */
const ajv = new AjvCtor({ allErrors: true, strict: false });
applyFormats(ajv);
const validateManifestSchema = ajv.compile(SUPER_PLUGIN_SCHEMA);

function formatAjvErrors(): string {
  const errors: ErrorObject[] = validateManifestSchema.errors ?? [];
  if (errors.length === 0) return "unknown validation error";
  return errors
    .slice(0, 6)
    .map((err: ErrorObject) => `${err.instancePath || "(root)"} ${err.message ?? "is invalid"}`.trim())
    .join("; ");
}

/** Parse + schema-validate a `superclaw-plugin.json` (string JSON or already-parsed value). */
export function parseSuperPluginManifest(raw: unknown): SuperPluginManifest {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SuperPluginManifestError(`invalid superclaw-plugin.json: ${(err as Error).message}`);
    }
  }
  if (!validateManifestSchema(parsed)) {
    throw new SuperPluginManifestError(`superclaw-plugin.json failed schema validation: ${formatAjvErrors()}`);
  }

  // Past validation: every required field is present and every pattern matched.
  const manifest = parsed as Record<string, unknown>;
  const runtime = manifest.runtime as Record<string, unknown>;
  const tools = manifest.tools as Array<Record<string, unknown>>;

  return {
    schemaVersion: String(manifest.schema_version),
    id: String(manifest.id),
    name: String(manifest.name),
    version: String(manifest.version),
    summary: typeof manifest.summary === "string" ? manifest.summary : undefined,
    runtime: {
      type: String(runtime.type),
      transport: String(runtime.transport),
      args: (runtime.args as string[]) ?? [],
      entrypoint: typeof runtime.entrypoint === "string" ? runtime.entrypoint : undefined,
      command: typeof runtime.command === "string" ? runtime.command : undefined,
      url: typeof runtime.url === "string" ? runtime.url : undefined,
    },
    tools: tools.map((tool) => ({
      name: String(tool.name),
      description: String(tool.description),
      inputSchema: tool.input_schema as Record<string, unknown>,
      outputSchema: tool.output_schema as Record<string, unknown>,
    })),
    skillOrigin: manifest.skill_origin === true,
  };
}

/**
 * Mirror plugins.py `is_skill_origin_plugin`: a skill is graded by its SIGNED
 * `skill_origin: true` field OR a reserved `skill.` id prefix. A skill must never
 * be loaded/run as a plugin.
 */
export function isSkillOriginManifest(manifest: SuperPluginManifest): boolean {
  return manifest.skillOrigin || manifest.id.startsWith("skill.");
}
