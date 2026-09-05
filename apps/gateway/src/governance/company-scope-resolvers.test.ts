import { describe, expect, it } from "vitest";
import { CompanyScope, CompanyScopeError } from "./company-scope.js";
import {
  assertSameOrigin,
  normalizeHome,
  resolveAgentCompany,
  resolveInteractionCompany,
  resolveIssueCompany,
  resolveWorkProductCompany,
  resolveWorkspaceCompany,
  type ScopeStore,
} from "./company-scope-resolvers.js";

const scope = (over: Partial<ConstructorParameters<typeof CompanyScope>[0]> = {}): CompanyScope =>
  new CompanyScope({ principalId: "op", actorCompanyId: "company_home", ...over });

/** A store where every lookup returns the same configurable entity (or null). */
function fakeStore(entities: Partial<Record<keyof ScopeStore, unknown>>): ScopeStore {
  const get = (key: keyof ScopeStore) => (entities[key] ?? null) as never;
  return {
    getAgentProfile: () => get("getAgentProfile"),
    getIssue: () => get("getIssue"),
    getWorkProduct: () => get("getWorkProduct"),
    getWorkspaceProfile: () => get("getWorkspaceProfile"),
    getIssueInteraction: () => get("getIssueInteraction"),
  };
}

describe("resolveAgentCompany (representative of the resolver pattern)", () => {
  it("fails closed without a store", () => {
    expect(() => resolveAgentCompany("agent_1", scope(), null, "agent.update")).toThrow(
      /without state/,
    );
  });

  it("fails closed on an unknown id", () => {
    expect(() => resolveAgentCompany("agent_x", scope(), fakeStore({}), "agent.update")).toThrow(
      /unknown agent/,
    );
  });

  it("fails closed when the resolved company is blank/corrupt", () => {
    const store = fakeStore({ getAgentProfile: { companyProfileId: "" } });
    expect(() => resolveAgentCompany("agent_1", scope(), store, "agent.update")).toThrow(
      /unverifiable|fail-closed/,
    );
  });

  it("fails closed when the resolved company is out of scope", () => {
    const store = fakeStore({ getAgentProfile: { companyProfileId: "company_other" } });
    expect(() => resolveAgentCompany("agent_1", scope(), store, "agent.update")).toThrow(
      CompanyScopeError,
    );
  });

  it("returns the company when in scope", () => {
    const store = fakeStore({ getAgentProfile: { companyProfileId: "company_home" } });
    expect(resolveAgentCompany("agent_1", scope(), store, "agent.update")).toBe("company_home");
  });
});

describe("the other resolvers share the contract", () => {
  it("issue / work_product / workspace fail closed without a store", () => {
    expect(() => resolveIssueCompany("i", scope(), null, "x")).toThrow(/without state/);
    expect(() => resolveWorkProductCompany("w", scope(), null, "x")).toThrow(/without state/);
    expect(() => resolveWorkspaceCompany("ws", scope(), null, "x")).toThrow(/without state/);
  });

  it("resolve and return an in-scope company", () => {
    expect(
      resolveIssueCompany("i", scope(), fakeStore({ getIssue: { companyProfileId: "company_home" } }), "x"),
    ).toBe("company_home");
  });
});

describe("resolveInteractionCompany resolves via the issue", () => {
  it("uses the interaction's issue company, forbidding a foreign-company issue", () => {
    const store: ScopeStore = {
      ...fakeStore({}),
      getIssueInteraction: () => ({ issueId: "issue_1" }),
      getIssue: () => ({ companyProfileId: "company_other" }),
    };
    expect(() => resolveInteractionCompany("inter_1", scope(), store, "board.resolve")).toThrow(
      CompanyScopeError,
    );
  });

  it("returns the issue company when in scope", () => {
    const store: ScopeStore = {
      ...fakeStore({}),
      getIssueInteraction: () => ({ issueId: "issue_1" }),
      getIssue: () => ({ companyProfileId: "company_home" }),
    };
    expect(resolveInteractionCompany("inter_1", scope(), store, "board.resolve")).toBe("company_home");
  });

  it("fails closed on an unknown interaction", () => {
    expect(() => resolveInteractionCompany("x", scope(), fakeStore({}), "board.resolve")).toThrow(
      /unknown board inbox/,
    );
  });
});

describe("normalizeHome", () => {
  it("maps a blank/absent company to the actor's home", () => {
    expect(normalizeHome(null, "company_home")).toBe("company_home");
    expect(normalizeHome(undefined, "company_home")).toBe("company_home");
    expect(normalizeHome("", "company_home")).toBe("company_home");
  });
  it("leaves a concrete company unchanged", () => {
    expect(normalizeHome("company_b", "company_home")).toBe("company_b");
  });
});

describe("assertSameOrigin", () => {
  it("passes when every ref shares the anchor company", () => {
    expect(() =>
      assertSameOrigin("company_a", "workspace", [
        ["assignee", "company_a"],
        ["reports_to", "company_a"],
      ]),
    ).not.toThrow();
  });

  it("forbids a cross-company related ref even if each is individually in scope", () => {
    expect(() =>
      assertSameOrigin("company_a", "workspace", [["assignee", "company_b"]]),
    ).toThrow(/not same-origin/);
  });
});
