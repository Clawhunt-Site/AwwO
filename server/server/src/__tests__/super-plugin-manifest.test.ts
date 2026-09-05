import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isSkillOriginManifest,
  KNOWN_SUPER_RUNTIME_TYPES,
  parseSuperPluginManifest,
  SuperPluginManifestError,
} from "../services/super-plugin-manifest.js";
import { SUPER_PLUGIN_SCHEMA } from "../services/super-plugin.schema.js";

// A complete, schema-valid manifest (the real examples/plugins/text-stats fixture).
function validManifest(): Record<string, unknown> {
  return structuredClone({
    schema_version: "0.1.0",
    id: "dev.leon.text-stats",
    name: "Text Stats",
    version: "1.0.0",
    summary: "Compute deterministic word and character counts.",
    source: { type: "developer_upload", clawhunt_problem_id: null, developer_id: "leon" },
    runtime: {
      type: "mcp_sidecar",
      entrypoint: "bin/text-stats",
      args: ["mcp"],
      transport: "stdio",
      mcp_protocol_versions: ["2025-06-18"],
      platforms: ["darwin-arm64", "linux-x64"],
    },
    tools: [
      {
        name: "text_stats",
        description: "Return the word count and character count of the provided text.",
        input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        output_schema: { type: "object", properties: { words: { type: "integer" } }, required: ["words"], additionalProperties: false },
      },
    ],
    permissions: { filesystem: [], network: [], environment: [] },
    acceptance: { level: "L1", tests: ["tests/smoke.sh"], evidence_fixtures: ["evidence-fixtures/smoke.json"], latency_budget_ms: 1000 },
    commerce: { pricing_model: "free", metering: "none" },
    provenance: {
      build_type: "developer_upload",
      source_digest: null,
      package_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      signature: "ed25519:fixture-signature",
    },
  });
}

function withRuntime(runtime: Record<string, unknown>): Record<string, unknown> {
  const m = validManifest();
  m.runtime = runtime;
  return m;
}

// A schema-valid external_mcp (stdio) runtime block.
function externalMcpRuntime(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "external_mcp",
    transport: "stdio",
    command: "npx",
    args: ["some-server"],
    mcp_protocol_versions: ["2025-06-18"],
    platforms: ["darwin-arm64"],
    ...over,
  };
}

describe("parseSuperPluginManifest (AJV against the canonical schema)", () => {
  it("parses a valid mcp_sidecar manifest", () => {
    const m = parseSuperPluginManifest(validManifest());
    expect(m.id).toBe("dev.leon.text-stats");
    expect(m.runtime.type).toBe("mcp_sidecar");
    expect(m.runtime.entrypoint).toBe("bin/text-stats");
    expect(m.runtime.args).toEqual(["mcp"]);
    expect(m.tools[0].name).toBe("text_stats");
    expect(m.skillOrigin).toBe(false);
  });

  it("accepts a JSON string or an already-parsed object", () => {
    expect(parseSuperPluginManifest(JSON.stringify(validManifest())).id).toBe("dev.leon.text-stats");
  });

  it("parses a valid external_mcp (stdio) manifest with a bare command and no entrypoint", () => {
    const m = parseSuperPluginManifest(withRuntime(externalMcpRuntime()));
    expect(m.runtime.type).toBe("external_mcp");
    expect(m.runtime.command).toBe("npx");
    expect(m.runtime.entrypoint).toBeUndefined();
  });

  it("parses a valid external_mcp (sse) manifest with a url", () => {
    const m = parseSuperPluginManifest(
      withRuntime(externalMcpRuntime({ transport: "sse", url: "https://mcp.example/sse", command: undefined })),
    );
    expect(m.runtime.url).toBe("https://mcp.example/sse");
  });

  it("turns invalid JSON into a SuperPluginManifestError (not a raw SyntaxError)", () => {
    expect(() => parseSuperPluginManifest("{ not json")).toThrow(SuperPluginManifestError);
  });

  it("rejects unknown top-level fields (additionalProperties: false)", () => {
    expect(() => parseSuperPluginManifest({ ...validManifest(), evil: 1 })).toThrow(SuperPluginManifestError);
  });

  it("rejects a missing id", () => {
    const m = validManifest();
    delete m.id;
    expect(() => parseSuperPluginManifest(m)).toThrow(/id/);
  });

  it.each(["dev/evil", "Dev.Bad", "a", "trailing.", "_x.y"])("rejects an invalid id (%s)", (id) => {
    expect(() => parseSuperPluginManifest({ ...validManifest(), id })).toThrow(SuperPluginManifestError);
  });

  it("rejects an unknown runtime.type (schema enum is mcp_sidecar | external_mcp)", () => {
    expect(() => parseSuperPluginManifest(withRuntime({ ...externalMcpRuntime(), type: "wasm_future" }))).toThrow(
      /type/,
    );
    expect(KNOWN_SUPER_RUNTIME_TYPES.has("wasm_future")).toBe(false);
  });

  it("rejects a mcp_sidecar missing entrypoint", () => {
    const r = validManifest().runtime as Record<string, unknown>;
    delete r.entrypoint;
    expect(() => parseSuperPluginManifest(withRuntime(r))).toThrow(/entrypoint/);
  });

  it.each(["/etc/passwd", "../../bin/x", "bin/../../escape"])(
    "rejects an escaping mcp_sidecar entrypoint (%s)",
    (entrypoint) => {
      expect(() => parseSuperPluginManifest(withRuntime({ ...(validManifest().runtime as object), entrypoint }))).toThrow(
        SuperPluginManifestError,
      );
    },
  );

  it("rejects an external_mcp (stdio) manifest missing the command", () => {
    const r = externalMcpRuntime();
    delete r.command;
    expect(() => parseSuperPluginManifest(withRuntime(r))).toThrow(/command/);
  });

  it.each(["/usr/bin/evil", "../npx", "dir/npx", "node_modules\\.bin\\x"])(
    "rejects a path-bearing external_mcp command (%s)",
    (command) => {
      expect(() => parseSuperPluginManifest(withRuntime(externalMcpRuntime({ command })))).toThrow(
        SuperPluginManifestError,
      );
    },
  );

  it("rejects a missing transport", () => {
    const r = externalMcpRuntime();
    delete r.transport;
    expect(() => parseSuperPluginManifest(withRuntime(r))).toThrow(/transport/);
  });

  it("rejects an empty tools array", () => {
    expect(() => parseSuperPluginManifest({ ...validManifest(), tools: [] })).toThrow(/tools/);
  });

  it("rejects a tool missing required fields", () => {
    expect(() => parseSuperPluginManifest({ ...validManifest(), tools: [{ name: "x" }] })).toThrow(
      SuperPluginManifestError,
    );
  });
});

describe("isSkillOriginManifest", () => {
  it("is false for a normal plugin", () => {
    expect(isSkillOriginManifest(parseSuperPluginManifest(validManifest()))).toBe(false);
  });

  it("is true when skill_origin is the signed boolean true", () => {
    expect(isSkillOriginManifest(parseSuperPluginManifest({ ...validManifest(), skill_origin: true }))).toBe(true);
  });

  it("is true for a reserved skill. id prefix", () => {
    expect(isSkillOriginManifest(parseSuperPluginManifest({ ...validManifest(), id: "skill.foo" }))).toBe(true);
  });

  it("does NOT treat a non-true skill_origin as a skill", () => {
    // skill_origin must be a boolean per schema; a string fails validation, so test the parsed-object guard directly.
    const m = parseSuperPluginManifest(validManifest());
    expect(isSkillOriginManifest({ ...m, skillOrigin: false })).toBe(false);
  });
});

describe("embedded schema drift guard", () => {
  it("super-plugin.schema.ts is byte-identical to the canonical schema", () => {
    const canonicalUrl = new URL("../../../../schemas/superclaw-plugin.schema.json", import.meta.url);
    const canonical = JSON.parse(readFileSync(canonicalUrl, "utf8"));
    expect(SUPER_PLUGIN_SCHEMA).toEqual(canonical);
  });
});
