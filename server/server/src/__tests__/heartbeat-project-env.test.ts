import { describe, expect, it, vi } from "vitest";
import { buildPluginMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import {
  LOW_TRUST_REVIEW_PRESET,
  applyRunScopedMentionedSkillKeys,
  extractAtSkillMentionKeys,
  extractMentionedSkillIdsFromSources,
  findUnresolvedAtSkillMentions,
  resolveExecutionRunAdapterConfig,
  runScopedPluginConsentForProject,
  sourcesMentionPlugin,
} from "../services/heartbeat.ts";

describe("resolveExecutionRunAdapterConfig", () => {
  it("overlays environment, project, and routine env on top of agent env and unions secret keys", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: {
        env: {
          SHARED_KEY: "agent",
          AGENT_ONLY: "agent-only",
        },
        other: "value",
      },
      secretKeys: new Set(["AGENT_SECRET"]),
      manifest: [
        {
          configPath: "env.AGENT_SECRET",
          envKey: "AGENT_SECRET",
          secretId: "secret-agent",
          secretKey: "agent-secret",
          version: 1,
          provider: "local_encrypted",
          outcome: "success",
        },
      ],
    });
    const resolveEnvBindings = vi
      .fn()
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "environment",
          ENV_ONLY: "environment-only",
        },
        secretKeys: new Set(["ENV_SECRET"]),
        manifest: [
          {
            configPath: "env.ENV_SECRET",
            envKey: "ENV_SECRET",
            secretId: "secret-environment",
            secretKey: "environment-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      })
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "project",
          PROJECT_ONLY: "project-only",
        },
        secretKeys: new Set(["PROJECT_SECRET"]),
        manifest: [
          {
            configPath: "env.PROJECT_SECRET",
            envKey: "PROJECT_SECRET",
            secretId: "secret-project",
            secretKey: "project-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      })
      .mockResolvedValueOnce({
        env: {
          SHARED_KEY: "routine",
          ROUTINE_ONLY: "routine-only",
        },
        secretKeys: new Set(["ROUTINE_SECRET"]),
        manifest: [
          {
            configPath: "env.ROUTINE_SECRET",
            envKey: "ROUTINE_SECRET",
            secretId: "secret-routine",
            secretKey: "routine-secret",
            version: 1,
            provider: "local_encrypted",
            outcome: "success",
          },
        ],
      });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { SHARED_KEY: "agent" } },
      environmentId: "environment-1",
      environmentEnv: { SHARED_KEY: "environment" },
      projectEnv: { SHARED_KEY: "project" },
      routineEnv: { SHARED_KEY: "routine" },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig).toMatchObject({
      other: "value",
      env: {
        SHARED_KEY: "routine",
        ENV_ONLY: "environment-only",
        AGENT_ONLY: "agent-only",
        PROJECT_ONLY: "project-only",
        ROUTINE_ONLY: "routine-only",
      },
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "ENV_SECRET", "PROJECT_SECRET", "ROUTINE_SECRET"]);
    expect(result.secretManifest.map((entry) => entry.secretId).sort()).toEqual([
      "secret-agent",
      "secret-environment",
      "secret-project",
      "secret-routine",
    ]);
    expect(JSON.stringify(result.secretManifest)).not.toContain("agent-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("environment-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("project-only");
    expect(JSON.stringify(result.secretManifest)).not.toContain("routine-only");
    expect(resolveEnvBindings.mock.calls[0]?.[2]).toMatchObject({
      consumerType: "environment",
      consumerId: "environment-1",
    });
    expect(resolveEnvBindings.mock.calls[2]?.[2]).toMatchObject({
      consumerType: "routine",
      consumerId: "routine-1",
    });
  });

  it("drops Paperclip runtime-owned env before resolving environment, agent, project, and routine overlays", async () => {
    const resolveAdapterConfigForRuntime = vi.fn(async (_companyId, config: Record<string, unknown>) => ({
      config: {
        ...config,
        env: { ...(config.env as Record<string, unknown>) },
      },
      secretKeys: new Set<string>(),
      manifest: [],
    }));
    const resolveEnvBindings = vi.fn(async (_companyId, env: Record<string, unknown>) => ({
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      secretKeys: new Set<string>(),
      manifest: [],
    }));

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      environmentId: "environment-1",
      environmentEnv: {
        PAPERCLIP_API_KEY: "environment-api-key",
        PAPERCLIP_AGENT_ID: "environment-agent",
        ENV_ONLY: "environment-only",
      },
      executionRunConfig: {
        env: {
          PAPERCLIP_API_KEY: { type: "secret_ref", secretId: "secret-api-key", version: "latest" },
          PAPERCLIP_AGENT_ID: "spoofed-agent",
          AGENT_ONLY: "agent-only",
        },
      },
      projectEnv: {
        PAPERCLIP_API_KEY: "project-api-key",
        PAPERCLIP_COMPANY_ID: "spoofed-company",
        PROJECT_ONLY: "project-only",
      },
      routineEnv: {
        PAPERCLIP_API_KEY: "routine-api-key",
        PAPERCLIP_RUN_ID: "spoofed-run",
        ROUTINE_ONLY: "routine-only",
      },
      routineId: "routine-1",
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveEnvBindings.mock.calls[0]?.[1]).toEqual({
      ENV_ONLY: "environment-only",
    });
    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[1]).toEqual({
      env: {
        AGENT_ONLY: "agent-only",
      },
    });
    expect(resolveEnvBindings.mock.calls[1]?.[1]).toEqual({
      PROJECT_ONLY: "project-only",
    });
    expect(resolveEnvBindings.mock.calls[2]?.[1]).toEqual({
      ROUTINE_ONLY: "routine-only",
    });
    expect(result.resolvedConfig.env).toEqual({
      ENV_ONLY: "environment-only",
      AGENT_ONLY: "agent-only",
      PROJECT_ONLY: "project-only",
      ROUTINE_ONLY: "routine-only",
    });
    expect(JSON.stringify(result.resolvedConfig.env)).not.toContain("PAPERCLIP_");
  });

  it("skips project env resolution when the project has no bindings", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn();

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({ AGENT_ONLY: "agent-only" });
    expect(result.secretManifest).toEqual([]);
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("passes low-trust allowed secret binding ids into all runtime secret contexts", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: {} },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {},
      secretKeys: new Set<string>(),
      manifest: [],
    });

    await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      environmentId: "environment-1",
      projectId: "project-1",
      routineId: "routine-1",
      executionRunConfig: { env: {} },
      environmentEnv: { ENVIRONMENT_FLAG: "plain" },
      projectEnv: { PROJECT_FLAG: "plain" },
      routineEnv: { ROUTINE_FLAG: "plain" },
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
          allowedSecretBindingIds: ["binding-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(resolveAdapterConfigForRuntime.mock.calls[0]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[0]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[1]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
    expect(resolveEnvBindings.mock.calls[2]?.[2]).toMatchObject({
      allowedBindingIds: ["binding-1"],
    });
  });

  it("rejects inline sensitive env values for low-trust runs", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: {
        env: {
          OPENAI_API_KEY: "inline-secret",
        },
      },
      projectEnv: null,
      trustPreset: {
        kind: "low_trust_review",
        preset: LOW_TRUST_REVIEW_PRESET,
        boundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: "company-1",
          issueIds: ["issue-1"],
        },
        sourcePresets: {},
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "low_trust_inline_sensitive_env_denied" },
    });
  });

  it("fails push-capability preflight when no GitHub write credential is bound at agent or project scope", async () => {
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { PROJECT_ONLY: "project-only" },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project"],
        reason: "push_write_credential_missing",
        remediation: "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at project or agent scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime: vi.fn(),
        resolveEnvBindings: vi.fn(),
      } as any,
    })).rejects.toMatchObject({
      code: "configuration_incomplete",
      message: expect.stringContaining("GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN"),
      resultJson: {
        configurationIncomplete: {
          reason: "push_write_credential_missing",
          requiredEnvKeys: ["GH_TOKEN", "GITHUB_TOKEN"],
          requiredScopes: ["agent", "project"],
          missingBindings: [],
        },
      },
    });
  });

  it("passes push-capability preflight when a project-scoped GitHub credential is configured", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
      manifest: [],
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: { GH_TOKEN: "github-token" },
      secretKeys: new Set(["GH_TOKEN"]),
      manifest: [],
    });
    const collectMissingRuntimeBindings = vi.fn().mockResolvedValue([]);

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      agentId: "agent-1",
      issueId: "issue-1",
      projectId: "project-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: { GH_TOKEN: { type: "plain", value: "github-token" } },
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN", "GITHUB_TOKEN"],
        consumerScopes: ["agent", "project"],
        reason: "push_write_credential_missing",
        remediation: "GitHub PR workflow requires GH_TOKEN or GITHUB_TOKEN bound at project or agent scope.",
      },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
        collectMissingRuntimeBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      AGENT_ONLY: "agent-only",
      GH_TOKEN: "github-token",
    });
    expect(resolveEnvBindings).toHaveBeenCalledOnce();
    expect(collectMissingRuntimeBindings).toHaveBeenCalledTimes(2);
    expect(collectMissingRuntimeBindings.mock.calls[1]?.[2]).toMatchObject({
      consumerType: "project",
      consumerId: "project-1",
    });
  });
});

describe("extractMentionedSkillIdsFromSources", () => {
  it("collects UUID skill mention ids across issue sources", () => {
    const releaseSkillId = "11111111-1111-4111-8111-111111111111";
    const browserSkillId = "22222222-2222-4222-8222-222222222222";
    const releaseHref = buildSkillMentionHref(releaseSkillId, "release-changelog");
    const browserHref = buildSkillMentionHref(browserSkillId, "agent-browser");

    expect(
      extractMentionedSkillIdsFromSources([
        `Please use [/release-changelog](${releaseHref})`,
        `And also [/agent-browser](${browserHref})`,
        `Duplicate mention [/release-changelog](${releaseHref})`,
      ]),
    ).toEqual([releaseSkillId, browserSkillId]);
  });

  it("ignores legacy non-UUID skill mention ids before runtime database lookup", () => {
    const validSkillId = "33333333-3333-4333-8333-333333333333";
    const validHref = buildSkillMentionHref(validSkillId, "greploop");
    const legacyHref = buildSkillMentionHref("skill-greploop", "greploop");

    expect(
      extractMentionedSkillIdsFromSources([
        `Use [/greploop](${legacyHref}) and [/prcheckloop](${validHref})`,
      ]),
    ).toEqual([validSkillId]);
  });
});

describe("extractAtSkillMentionKeys", () => {
  it("captures the FULL canonical key the picker inserts (namespaced global key)", () => {
    // The chat-skills picker fills the token with entry.key, e.g. superclaw-global:<slug>.
    expect(
      extractAtSkillMentionKeys([
        "Use @skill:superclaw-global:skill-creator please",
        "and @skill:company/abc-123/release-notes too",
      ]),
    ).toEqual(["superclaw-global:skill-creator", "company/abc-123/release-notes"]);
  });

  it("captures a bare slug (hand-typed) and de-dups across sources", () => {
    expect(
      extractAtSkillMentionKeys(["@skill:skill-creator", "again @skill:skill-creator", null]),
    ).toEqual(["skill-creator"]);
  });

  it("strips trailing sentence/path punctuation that is never a valid key ending", () => {
    expect(extractAtSkillMentionKeys(["see @skill:weather, and @skill:foo."])).toEqual([
      "weather",
      "foo",
    ]);
  });

  it("does NOT match `@skill:` embedded after a word char (email/code), only at a boundary", () => {
    expect(extractAtSkillMentionKeys(["mail to bob@skill:notme and x=@skill:yes"])).toEqual(["yes"]);
  });

  it("ignores the markdown skill://<uuid> form (that is the other extractor's job)", () => {
    expect(extractAtSkillMentionKeys(["[x](skill://11111111-1111-4111-8111-111111111111)"])).toEqual(
      [],
    );
  });
});

describe("findUnresolvedAtSkillMentions (run-level fail-closed gate)", () => {
  const available = ["superclaw-global:skill-creator", "company/abc-123/release-notes"];

  it("returns [] when every @skill canonical key is in the injectable set", () => {
    expect(
      findUnresolvedAtSkillMentions("use @skill:superclaw-global:skill-creator now", available),
    ).toEqual([]);
  });

  it("flags a canonical key that is NOT injectable (typo / deleted) — the run must refuse", () => {
    expect(
      findUnresolvedAtSkillMentions("@skill:superclaw-global:gone please", available),
    ).toEqual(["superclaw-global:gone"]);
  });

  it("flags a BARE slug — only canonical keys resolve, so a hand-typed slug refuses", () => {
    // `skill-creator` (bare) != the canonical `superclaw-global:skill-creator`.
    expect(findUnresolvedAtSkillMentions("@skill:skill-creator", available)).toEqual(["skill-creator"]);
  });

  it("returns [] for text with no @skill token (no current-turn mention → never refuse)", () => {
    expect(findUnresolvedAtSkillMentions("just a normal message", available)).toEqual([]);
    expect(findUnresolvedAtSkillMentions(null, available)).toEqual([]);
  });

  it("catches a bad @skill in an EARLIER coalesced comment, not just the latest (joined bodies)", () => {
    // A deferred wake batch joins several comment bodies; the gate must scan all of them,
    // so an unresolved @skill in the earlier body is still refused.
    const joined = ["please @skill:superclaw-global:gone do X", "thanks, also a follow-up"].join("\n");
    expect(findUnresolvedAtSkillMentions(joined, available)).toEqual(["superclaw-global:gone"]);
  });
});

describe("applyRunScopedMentionedSkillKeys", () => {
  it("adds mentioned skills without mutating the original config", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/release-changelog",
      "paperclipai/paperclip/paperclip",
      "company/company-1/release-changelog",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          "paperclipai/paperclip/paperclip",
          "company/company-1/release-changelog",
        ],
      },
    });
    expect(originalConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    });
  });

  it("preserves existing version pins when adding mentioned skills", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          { key: "company/company-1/release-changelog", versionId: "version-1" },
        ],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/security-review",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          { key: "company/company-1/release-changelog", versionId: "version-1" },
          { key: "company/company-1/security-review", versionId: null },
        ],
      },
    });
  });
});

describe("sourcesMentionPlugin", () => {
  it("is true when any source carries a plugin:// mention", () => {
    const href = buildPluginMentionHref("plugin-abc");
    expect(sourcesMentionPlugin(["plain", `enable [@x](${href})`])).toBe(true);
  });

  it("is false with no plugin mention (skill mentions do not count)", () => {
    const skill = buildSkillMentionHref("skill-1");
    expect(sourcesMentionPlugin([`use [/s](${skill})`, null, undefined, ""])).toBe(false);
  });

  it("is false for an empty source list", () => {
    expect(sourcesMentionPlugin([])).toBe(false);
  });
});

describe("runScopedPluginConsentForProject", () => {
  // Minimal db whose select().from().where() yields each queued result in order.
  function queueDb(...results: unknown[][]) {
    let i = 0;
    const chain: any = {
      from: () => chain,
      where: () => Promise.resolve(results[i++] ?? []),
    };
    return { select: () => chain } as any;
  }
  const href = buildPluginMentionHref("plugin-1");
  const mentioned = `please use [@p](${href})`;
  const args = { companyId: "c1", runId: "r1", projectId: "proj-1" };

  it("opts in on a USER-authored comment (active member) on a same-project owned issue", async () => {
    const db = queueDb(
      [{ id: "iss-1" }], // owned issues belonging to projectId
      [{ body: mentioned, authorUserId: "u1", authorAgentId: null, createdByRunId: null }],
      [{ principalId: "u1" }], // active member lookup
    );
    expect(await runScopedPluginConsentForProject({ db, ...args })).toBe(true);
  });

  it("does NOT opt in when the run owns no issue in the bridged project (cross-issue borrow blocked)", async () => {
    const db = queueDb([]); // projectId equality yields no owned issue
    expect(await runScopedPluginConsentForProject({ db, ...args })).toBe(false);
  });

  it("does NOT use the mutable issue title/description as a source (only comments)", async () => {
    // Even though an owned issue exists, with no qualifying comment there is no
    // consent — issue text is never consulted (an agent could edit it).
    const db = queueDb([{ id: "iss-1" }], []);
    expect(await runScopedPluginConsentForProject({ db, ...args })).toBe(false);
  });

  it("does NOT opt in when the comment author is NOT an active member (board-concierge sentinel)", async () => {
    const db = queueDb(
      [{ id: "iss-1" }],
      [{ body: mentioned, authorUserId: "board-concierge", authorAgentId: null, createdByRunId: null }],
      [], // membership lookup finds no active human member
    );
    expect(await runScopedPluginConsentForProject({ db, ...args })).toBe(false);
  });

  it("does NOT opt in on an AGENT-authored comment (no self-grant)", async () => {
    const db = queueDb(
      [{ id: "iss-1" }],
      [{ body: mentioned, authorUserId: null, authorAgentId: "a1", createdByRunId: null }],
    );
    expect(await runScopedPluginConsentForProject({ db, ...args })).toBe(false);
  });

  it("does NOT opt in on a run-generated comment", async () => {
    const db = queueDb(
      [{ id: "iss-1" }],
      [{ body: mentioned, authorUserId: "u1", authorAgentId: null, createdByRunId: "r1" }],
    );
    expect(await runScopedPluginConsentForProject({ db, ...args })).toBe(false);
  });
});
