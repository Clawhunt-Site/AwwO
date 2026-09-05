// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "./agent-config-patch";

function makeAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      env: {
        OPENAI_API_KEY: {
          type: "plain",
          value: "secret",
        },
      },
      promptTemplate: "Work the issue.",
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
      },
    },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "agent",
    permissions: {
      canCreateAgents: false,
    },
    metadata: null,
  };
}

function makeOverlay(patch?: Partial<AgentConfigOverlay>): AgentConfigOverlay {
  return {
    identity: {},
    adapterConfig: {},
    heartbeat: {},
    pluginTools: {},
    runtime: {},
    ...patch,
  };
}

describe("buildAgentUpdatePatch", () => {
  it("replaces adapter config and drops env when the last env binding is cleared", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterConfig: {
          env: undefined,
        },
      }),
    );

    expect(patch).toEqual({
      adapterConfig: {
        model: "claude-sonnet-4-6",
        promptTemplate: "Work the issue.",
      },
      replaceAdapterConfig: true,
    });
  });

  it("writes the cheap profile under runtimeConfig.modelProfiles, never on primary adapterConfig", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "claude-haiku-4-5" },
          },
        },
      }),
    );

    expect(patch).toEqual({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
        },
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "claude-haiku-4-5" },
          },
        },
      },
    });
    // The primary adapterConfig is untouched.
    expect(patch.adapterConfig).toBeUndefined();
  });

  it("writes max-turn continuation policy under runtimeConfig.heartbeat", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        heartbeat: {
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      }),
    );

    expect(patch).toEqual({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      },
    });
  });

  it("merges cheap profile changes onto existing runtimeConfig.modelProfiles state", () => {
    const agent = makeAgent();
    agent.runtimeConfig = {
      heartbeat: { enabled: true, intervalSec: 300 },
      modelProfiles: {
        cheap: {
          enabled: false,
          adapterConfig: { model: "old-cheap" },
        },
      },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        modelProfiles: {
          cheap: {
            enabled: true,
          },
        },
      }),
    );

    expect((patch.runtimeConfig as Record<string, unknown>).modelProfiles).toEqual({
      cheap: {
        enabled: true,
        adapterConfig: { model: "old-cheap" },
      },
    });
  });

  it("clears the cheap profile when the overlay marks it cleared", () => {
    const agent = makeAgent();
    agent.runtimeConfig = {
      heartbeat: { enabled: true, intervalSec: 300 },
      modelProfiles: {
        cheap: {
          enabled: true,
          adapterConfig: { model: "claude-haiku-4-5" },
        },
      },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        modelProfiles: { cheap: { cleared: true } },
      }),
    );

    expect(patch.runtimeConfig).toEqual({
      heartbeat: { enabled: true, intervalSec: 300 },
    });
  });

  it("writes the persistent plugin-bridge opt-in under runtimeConfig.pluginTools", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({ pluginTools: { enabled: true } }),
    );
    expect((patch.runtimeConfig as Record<string, unknown>).pluginTools).toEqual({ enabled: true });
  });

  it("writes only the enabled flag and preserves other runtimeConfig keys", () => {
    const agent = makeAgent();
    agent.runtimeConfig = {
      heartbeat: { enabled: true, intervalSec: 300 },
      pluginTools: { enabled: false },
    };
    const patch = buildAgentUpdatePatch(agent, makeOverlay({ pluginTools: { enabled: true } }));
    const rc = patch.runtimeConfig as Record<string, unknown>;
    expect(rc.pluginTools).toEqual({ enabled: true });
    expect(rc.heartbeat).toEqual({ enabled: true, intervalSec: 300 });
  });

  it("heals a legacy typo'd pluginTools instead of re-sending it (strict backend)", () => {
    const agent = makeAgent();
    // A pre-existing misspelled key the backend strict schema would reject.
    agent.runtimeConfig = { pluginTools: { enable: true } };
    const patch = buildAgentUpdatePatch(agent, makeOverlay({ pluginTools: { enabled: true } }));
    // The stray `enable` is dropped; only the schema-known `enabled` survives.
    expect((patch.runtimeConfig as Record<string, unknown>).pluginTools).toEqual({ enabled: true });
  });

  it("does not touch runtimeConfig when there is no pluginTools/heartbeat/profile change", () => {
    const patch = buildAgentUpdatePatch(makeAgent(), makeOverlay({ identity: { name: "Renamed" } }));
    expect(patch.runtimeConfig).toBeUndefined();
  });

  it("heals a legacy typo'd pluginTools when an UNRELATED runtimeConfig field changes (no collateral save block)", () => {
    const agent = makeAgent();
    agent.runtimeConfig = { pluginTools: { enable: true } };
    // User only edits heartbeat; they never touched the plugin toggle.
    const patch = buildAgentUpdatePatch(agent, makeOverlay({ heartbeat: { enabled: true } }));
    const rc = patch.runtimeConfig as Record<string, unknown>;
    // The stray typo is sanitized away so the strict backend accepts the save.
    expect(rc.pluginTools).toEqual({});
    expect(rc.heartbeat).toEqual({ enabled: true });
  });

  it("preserves a valid existing pluginTools when an unrelated runtimeConfig field changes", () => {
    const agent = makeAgent();
    agent.runtimeConfig = { pluginTools: { enabled: true } };
    const patch = buildAgentUpdatePatch(agent, makeOverlay({ heartbeat: { enabled: false } }));
    expect((patch.runtimeConfig as Record<string, unknown>).pluginTools).toEqual({ enabled: true });
  });

  it("preserves adapter-agnostic keys when changing adapter types", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "gpt-5.4",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      replaceAdapterConfig: true,
    });
  });
});
