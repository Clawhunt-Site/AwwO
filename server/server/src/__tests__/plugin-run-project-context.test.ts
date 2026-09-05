import { describe, expect, it } from "vitest";
import { applyPluginToolRunContext } from "../services/plugin-run-project.js";

const BIN = "/abs/plugin-bridge-stdio.js";

describe("applyPluginToolRunContext", () => {
  it("writes the server-derived context onto a clean runtimeConfig", () => {
    const out = applyPluginToolRunContext({ model: "x" }, { projectId: "proj-1", bridgeBin: BIN });
    expect(out).toEqual({ model: "x", pluginToolRunContext: { projectId: "proj-1", bridgeBin: BIN } });
  });

  it("omits the key entirely when no server context is derived", () => {
    const out = applyPluginToolRunContext({ model: "x" }, null);
    expect(out).toEqual({ model: "x" });
    expect(out).not.toHaveProperty("pluginToolRunContext");
  });

  it("strips a FORGED pluginToolRunContext when the gate produced none", () => {
    // an agent/user/issue-merged config plants the reserved key; the gate failed
    // (null), so it must NOT survive into the adapter config.
    const out = applyPluginToolRunContext(
      { model: "x", pluginToolRunContext: { projectId: "attacker-project", bridgeBin: "/evil.js" } },
      null,
    );
    expect(out).toEqual({ model: "x" });
    expect(out).not.toHaveProperty("pluginToolRunContext");
  });

  it("overwrites a FORGED pluginToolRunContext with the server-derived value", () => {
    const out = applyPluginToolRunContext(
      { model: "x", pluginToolRunContext: { projectId: "attacker-project", bridgeBin: "/evil.js" } },
      { projectId: "trusted-project", bridgeBin: BIN },
    );
    expect(out).toEqual({
      model: "x",
      pluginToolRunContext: { projectId: "trusted-project", bridgeBin: BIN },
    });
  });

  it("does not mutate the input runtimeConfig", () => {
    const input = { model: "x", pluginToolRunContext: { projectId: "forged", bridgeBin: "/evil.js" } };
    applyPluginToolRunContext(input, { projectId: "trusted", bridgeBin: BIN });
    expect(input.pluginToolRunContext).toEqual({ projectId: "forged", bridgeBin: "/evil.js" });
  });
});
