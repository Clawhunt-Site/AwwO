import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyList = vi.hoisted(() => vi.fn());

vi.mock("../services/companies.js", () => ({
  companyService: () => ({ list: mockCompanyList }),
}));

const { chatCompatStubsRoutes } = await import("../routes/chat-stubs.js");

function buildApp(deploymentMode: "local_trusted" | "authenticated") {
  const app = express();
  app.use(express.json());
  app.use("/api", chatCompatStubsRoutes({} as never, { deploymentMode }));
  return app;
}

describe("chat-compat stub routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("team/messages reports zero unread", async () => {
    const res = await request(buildApp("local_trusted")).get("/api/team/messages");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_unread: 0 });
  });

  it("team/companies projects the company list", async () => {
    mockCompanyList.mockResolvedValue([{ id: "c1", name: "Acme", status: "active" }]);
    const res = await request(buildApp("local_trusted")).get("/api/team/companies");
    expect(res.status).toBe(200);
    expect(res.body.companies).toEqual([
      { company_profile_id: "c1", name: "Acme", status: "active" },
    ]);
  });

  it("onboarding reports completed (migrated installs are past the tour)", async () => {
    const res = await request(buildApp("local_trusted")).get("/api/onboarding");
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
  });

  it("onboarding/complete acknowledges", async () => {
    const res = await request(buildApp("local_trusted")).post("/api/onboarding/complete");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("control-token rotate returns a fresh token", async () => {
    const res = await request(buildApp("local_trusted")).post("/api/runtime/control-token/rotate");
    expect(res.status).toBe(200);
    expect(typeof res.body.control_token).toBe("string");
    expect(res.body.control_token.length).toBeGreaterThan(0);
  });

  it("refuses off local_trusted", async () => {
    const res = await request(buildApp("authenticated")).get("/api/team/messages");
    expect(res.status).toBe(403);
  });
});
