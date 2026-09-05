import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindLocalChatCompanyId = vi.hoisted(() => vi.fn());
const mockListRuntimeSkillEntries = vi.hoisted(() => vi.fn());
const mockUnionGlobalRuntimeSkillEntries = vi.hoisted(() => vi.fn());
const mockEnsureSeedChatSkills = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../services/chat-compat.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/chat-compat.js")>();
  return { ...actual, findLocalChatCompanyId: mockFindLocalChatCompanyId };
});
vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({ listRuntimeSkillEntries: mockListRuntimeSkillEntries }),
}));
vi.mock("../services/global-runtime-skills.js", () => ({
  unionGlobalRuntimeSkillEntries: mockUnionGlobalRuntimeSkillEntries,
}));
// The route fires a best-effort seed at construction; stub it so the route test
// neither touches the real ~/.superclaw/skills nor depends on the seed.
vi.mock("../services/seed-chat-skills.js", () => ({ ensureSeedChatSkills: mockEnsureSeedChatSkills }));

const { chatSkillsRoutes } = await import("../routes/chat-skills.js");

function buildApp(deploymentMode: "local_trusted" | "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(chatSkillsRoutes({} as never, { deploymentMode }));
  return app;
}

describe("chat /v1/skills route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("projects company skills UNIONED with the global store (missing filtered out)", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    const companyEntries = [
      { key: "code-review", runtimeName: "code-review", sourceStatus: "available" },
      { key: "gone", runtimeName: "gone", sourceStatus: "missing" },
    ];
    mockListRuntimeSkillEntries.mockResolvedValue(companyEntries);
    // The global union is what the heartbeat run injects; the picker must match it,
    // so a global skill (e.g. the skill-creator) is @-referenceable, not just
    // silently injected at runtime.
    mockUnionGlobalRuntimeSkillEntries.mockImplementation(async (entries: typeof companyEntries) => [
      ...entries,
      {
        key: "superclaw-global:skill-creator",
        runtimeName: "skill-creator",
        sourceStatus: "available",
      },
    ]);
    const res = await request(buildApp("local_trusted")).get("/v1/skills");
    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual([
      { slug: "code-review", name: "code-review", description: "" },
      { slug: "superclaw-global:skill-creator", name: "skill-creator", description: "" },
    ]);
    // Skip the heavy catalog materialization on a suggestion read; the global union
    // receives the company entries (it dedups, company wins on a name collision).
    expect(mockListRuntimeSkillEntries).toHaveBeenCalledWith("company1", { materializeMissing: false });
    expect(mockUnionGlobalRuntimeSkillEntries).toHaveBeenCalledWith(companyEntries);
  });

  it("excludes vendored engine skills (paperclipai/paperclip/*) so the upstream brand never leaks into the @ picker", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    // The chat company's runtime skills mix the user's own company skills with the
    // upstream engine skills the adapter sync brings in. The suggestion source must
    // surface only SuperClaw capabilities — the vendored `paperclipai/paperclip/*`
    // keys both leak the brand and are engine internals a user shouldn't @-invoke.
    const companyEntries = [
      { key: "company/company1/weekly-report", runtimeName: "weekly-report", sourceStatus: "available" },
      { key: "paperclipai/paperclip/paperclip-board", runtimeName: "paperclip-board", sourceStatus: "available" },
      { key: "paperclipai/paperclip/browseraccess", runtimeName: "browseraccess", sourceStatus: "available" },
    ];
    mockListRuntimeSkillEntries.mockResolvedValue(companyEntries);
    mockUnionGlobalRuntimeSkillEntries.mockImplementation(async (entries: typeof companyEntries) => [
      ...entries,
      { key: "superclaw-global:skill-creator", runtimeName: "skill-creator", sourceStatus: "available" },
    ]);
    const res = await request(buildApp("local_trusted")).get("/v1/skills");
    expect(res.status).toBe(200);
    // Only the user's company skill + the global SuperClaw skill survive; BOTH vendored
    // entries are dropped, and no returned slug/name contains "paperclip".
    expect(res.body.skills).toEqual([
      { slug: "company/company1/weekly-report", name: "weekly-report", description: "" },
      { slug: "superclaw-global:skill-creator", name: "skill-creator", description: "" },
    ]);
    const blob = JSON.stringify(res.body).toLowerCase();
    expect(blob).not.toContain("paperclip");
  });

  it("still surfaces global skills before the local company exists", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue(null);
    // No company → no company-skill read, but the global store is still unioned
    // (with empty company entries) so the built-in skill-creator is selectable.
    mockUnionGlobalRuntimeSkillEntries.mockResolvedValue([
      { key: "superclaw-global:skill-creator", runtimeName: "skill-creator", sourceStatus: "available" },
    ]);
    const res = await request(buildApp("local_trusted")).get("/v1/skills");
    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual([
      { slug: "superclaw-global:skill-creator", name: "skill-creator", description: "" },
    ]);
    expect(mockListRuntimeSkillEntries).not.toHaveBeenCalled();
    expect(mockUnionGlobalRuntimeSkillEntries).toHaveBeenCalledWith([]);
  });

  it("refuses off local_trusted", async () => {
    const res = await request(buildApp("authenticated")).get("/v1/skills");
    expect(res.status).toBe(403);
  });

  it("seeds the built-in skills only on local_trusted, never on authenticated", () => {
    // Seeding writes ~/.superclaw/skills, so it must respect the deployment gate
    // — a non-local instance must not mutate the global store at startup.
    buildApp("local_trusted");
    expect(mockEnsureSeedChatSkills).toHaveBeenCalledTimes(1);
    mockEnsureSeedChatSkills.mockClear();
    buildApp("authenticated");
    expect(mockEnsureSeedChatSkills).not.toHaveBeenCalled();
  });
});
