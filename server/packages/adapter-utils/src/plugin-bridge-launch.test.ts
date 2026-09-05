import { describe, expect, it } from "vitest";
import {
  NODE_USE_ENV_PROXY_FLAG,
  PLUGIN_BRIDGE_MCP_SERVER_KEY,
  buildPluginBridgeMcpServerSpec,
  readPluginBridgeRunContext,
} from "./plugin-bridge-launch.js";

describe("readPluginBridgeRunContext", () => {
  it("reads a complete server-derived context", () => {
    expect(
      readPluginBridgeRunContext({
        pluginToolRunContext: { projectId: "p1", bridgeBin: "/abs/bin.js" },
      }),
    ).toEqual({ projectId: "p1", bridgeBin: "/abs/bin.js" });
  });

  it.each([
    ["missing key", {}],
    ["null config", null],
    ["non-object context", { pluginToolRunContext: "x" }],
    ["missing bridgeBin", { pluginToolRunContext: { projectId: "p1" } }],
    ["missing projectId", { pluginToolRunContext: { bridgeBin: "/b" } }],
    ["blank bridgeBin", { pluginToolRunContext: { projectId: "p1", bridgeBin: "  " } }],
  ])("returns null for %s (fail-closed)", (_label, config) => {
    expect(readPluginBridgeRunContext(config as Record<string, unknown> | null)).toBeNull();
  });
});

describe("buildPluginBridgeMcpServerSpec", () => {
  const base = {
    runContext: { projectId: "proj-1", bridgeBin: "/abs/plugin-bridge.js" },
    agentId: "agent-1",
    companyId: "co-1",
    runId: "run-1",
    nodeExecPath: "/usr/bin/node",
  };

  it("assembles the spawn spec with only SUPERCLAW_* run credentials", () => {
    const spec = buildPluginBridgeMcpServerSpec({
      ...base,
      agentEnv: { SUPERCLAW_API_URL: "http://h/api", SUPERCLAW_API_KEY: "jwt", OTHER: "leak" },
    });
    expect(spec).toEqual({
      command: "/usr/bin/node",
      args: ["/abs/plugin-bridge.js"],
      env: {
        SUPERCLAW_API_URL: "http://h/api",
        SUPERCLAW_API_KEY: "jwt",
        SUPERCLAW_AGENT_ID: "agent-1",
        SUPERCLAW_COMPANY_ID: "co-1",
        SUPERCLAW_RUN_ID: "run-1",
        SUPERCLAW_PROJECT_ID: "proj-1",
      },
    });
    // the broad agent env must NOT bleed into the bridge subprocess env
    expect(spec?.env).not.toHaveProperty("OTHER");
  });

  it("falls back to PAPERCLIP_* aliases for url + key", () => {
    const spec = buildPluginBridgeMcpServerSpec({
      ...base,
      agentEnv: { PAPERCLIP_API_URL: "http://h/api", PAPERCLIP_API_KEY: "jwt" },
    });
    expect(spec?.env.SUPERCLAW_API_URL).toBe("http://h/api");
    expect(spec?.env.SUPERCLAW_API_KEY).toBe("jwt");
  });

  it("prefers SUPERCLAW_* over PAPERCLIP_* when both present", () => {
    const spec = buildPluginBridgeMcpServerSpec({
      ...base,
      agentEnv: {
        SUPERCLAW_API_URL: "http://super/api",
        PAPERCLIP_API_URL: "http://pc/api",
        SUPERCLAW_API_KEY: "super-jwt",
        PAPERCLIP_API_KEY: "pc-jwt",
      },
    });
    expect(spec?.env.SUPERCLAW_API_URL).toBe("http://super/api");
    expect(spec?.env.SUPERCLAW_API_KEY).toBe("super-jwt");
  });

  it.each([
    ["no api url", { SUPERCLAW_API_KEY: "jwt" }],
    ["no api key", { SUPERCLAW_API_URL: "http://h/api" }],
    ["empty env", {}],
  ])("returns null (fail-closed) when %s", (_label, agentEnv) => {
    expect(buildPluginBridgeMcpServerSpec({ ...base, agentEnv })).toBeNull();
  });

  it("returns null when an identity field is blank", () => {
    expect(
      buildPluginBridgeMcpServerSpec({
        ...base,
        agentId: "  ",
        agentEnv: { SUPERCLAW_API_URL: "http://h/api", SUPERCLAW_API_KEY: "jwt" },
      }),
    ).toBeNull();
  });

  it("wires under the canonical 'superclaw' key", () => {
    expect(PLUGIN_BRIDGE_MCP_SERVER_KEY).toBe("superclaw");
  });

  it("passes through proxy / custom-CA infra env from the host env", () => {
    const spec = buildPluginBridgeMcpServerSpec({
      ...base,
      agentEnv: { SUPERCLAW_API_URL: "http://h/api", SUPERCLAW_API_KEY: "jwt" },
      hostEnv: {
        HTTPS_PROXY: "http://proxy:8080",
        NO_PROXY: "localhost",
        NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
        SECRET_UNRELATED: "do-not-copy",
      },
    });
    expect(spec?.env).toMatchObject({
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      SUPERCLAW_API_KEY: "jwt",
    });
    // only the curated infra allowlist crosses over — not arbitrary host env
    expect(spec?.env).not.toHaveProperty("SECRET_UNRELATED");
  });

  it("prepends --use-env-proxy when a proxy var is present and Node supports it", () => {
    const spec = buildPluginBridgeMcpServerSpec({
      ...base,
      agentEnv: { SUPERCLAW_API_URL: "http://h/api", SUPERCLAW_API_KEY: "jwt" },
      hostEnv: { HTTPS_PROXY: "http://proxy:8080" },
      nodeSupportsEnvProxy: true,
    });
    expect(spec?.args).toEqual([NODE_USE_ENV_PROXY_FLAG, "/abs/plugin-bridge.js"]);
  });

  it("omits --use-env-proxy when Node does not support it (flag would crash spawn)", () => {
    const spec = buildPluginBridgeMcpServerSpec({
      ...base,
      agentEnv: { SUPERCLAW_API_URL: "http://h/api", SUPERCLAW_API_KEY: "jwt" },
      hostEnv: { HTTPS_PROXY: "http://proxy:8080" },
      nodeSupportsEnvProxy: false,
    });
    expect(spec?.args).toEqual(["/abs/plugin-bridge.js"]);
  });

  it("does not add --use-env-proxy when only NODE_EXTRA_CA_CERTS is present (no proxy)", () => {
    const spec = buildPluginBridgeMcpServerSpec({
      ...base,
      agentEnv: { SUPERCLAW_API_URL: "http://h/api", SUPERCLAW_API_KEY: "jwt" },
      hostEnv: { NODE_EXTRA_CA_CERTS: "/etc/ca.pem" },
      nodeSupportsEnvProxy: true,
    });
    expect(spec?.args).toEqual(["/abs/plugin-bridge.js"]);
  });

  it("does not pass infra env when no hostEnv is supplied", () => {
    const spec = buildPluginBridgeMcpServerSpec({
      ...base,
      agentEnv: { SUPERCLAW_API_URL: "http://h/api", SUPERCLAW_API_KEY: "jwt" },
    });
    expect(Object.keys(spec?.env ?? {})).toEqual([
      "SUPERCLAW_API_URL",
      "SUPERCLAW_API_KEY",
      "SUPERCLAW_AGENT_ID",
      "SUPERCLAW_COMPANY_ID",
      "SUPERCLAW_RUN_ID",
      "SUPERCLAW_PROJECT_ID",
    ]);
  });
});
