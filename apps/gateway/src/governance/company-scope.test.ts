import { describe, expect, it } from "vitest";
import { check, CompanyScope, CompanyScopeError, requireResolvedCompany } from "./company-scope.js";

const scope = (over: Partial<ConstructorParameters<typeof CompanyScope>[0]> = {}): CompanyScope =>
  new CompanyScope({ principalId: "op", actorCompanyId: "company_home", ...over });

describe("CompanyScope construction / normalization", () => {
  it("defaults is_admin to false (fail-closed)", () => {
    expect(scope().isAdmin).toBe(false);
  });

  it("always folds the actor company into the allowed set; empty -> own only", () => {
    expect([...scope().allowedCompanyIds]).toEqual(["company_home"]);
    expect([...scope({ allowedCompanyIds: ["company_b"] }).allowedCompanyIds].sort()).toEqual([
      "company_b",
      "company_home",
    ]);
  });

  it("ignores a bare string for allowedCompanyIds (no per-char company grant)", () => {
    const s = scope({ allowedCompanyIds: "company_b" as unknown as string[] });
    expect([...s.allowedCompanyIds]).toEqual(["company_home"]);
    expect(s.permits("c")).toBe(false);
    expect(s.permits("company_b")).toBe(false);
  });

  it("filters non-string / empty entries from allowedCompanyIds", () => {
    const s = scope({
      allowedCompanyIds: ["company_b", "", 123 as unknown as string, null as unknown as string],
    });
    expect([...s.allowedCompanyIds].sort()).toEqual(["company_b", "company_home"]);
  });

  it("degrades a blank / non-string acting-agent id to null (kept if whitespace, per truthiness)", () => {
    expect(scope({ actorAgentProfileId: "" }).actorAgentProfileId).toBeNull();
    expect(scope({ actorAgentProfileId: 123 as unknown as string }).actorAgentProfileId).toBeNull();
    // whitespace-only is a non-empty string -> KEPT (matches Python `and agent_id`)
    expect(scope({ actorAgentProfileId: "  " }).actorAgentProfileId).toBe("  ");
    expect(scope({ actorAgentProfileId: "agent_1" }).actorAgentProfileId).toBe("agent_1");
  });

  it("degrades a blank / whitespace / non-string respond grant and run id to null (stripped)", () => {
    expect(scope({ respondIssueId: "   " }).respondIssueId).toBeNull();
    expect(scope({ respondIssueId: 7 as unknown as string }).respondIssueId).toBeNull();
    expect(scope({ respondIssueId: "issue_1" }).respondIssueId).toBe("issue_1");
    expect(scope({ runId: "   " }).runId).toBeNull();
    expect(scope({ runId: "run_1" }).runId).toBe("run_1");
  });

  it("strips grant/run ids using Python's whitespace set, not JS trim()", () => {
    const NEL = String.fromCharCode(0x85); // U+0085: Python whitespace, NOT stripped by JS trim()
    const BOM = String.fromCharCode(0xfeff); // U+FEFF: stripped by JS trim(), NOT Python whitespace
    const NBSP = String.fromCharCode(0xa0);
    const IDEOGRAPHIC = String.fromCharCode(0x3000);

    // U+0085 alone -> Python strips -> degrades to null.
    expect(scope({ respondIssueId: NEL }).respondIssueId).toBeNull();
    expect(scope({ runId: NEL }).runId).toBeNull();
    // U+FEFF alone -> Python keeps it -> preserved verbatim (NOT dropped like JS trim).
    expect(scope({ respondIssueId: BOM }).respondIssueId).toBe(BOM);
    expect(scope({ runId: BOM }).runId).toBe(BOM);
    // NBSP + ideographic space are Python whitespace -> degrades to null.
    expect(scope({ respondIssueId: NBSP + IDEOGRAPHIC }).respondIssueId).toBeNull();
  });

  it("does not let a caller widen scope by mutating the exposed allowed set", () => {
    const s = scope({ allowedCompanyIds: ["company_b"] });
    (s.allowedCompanyIds as Set<string>).add("evil");
    expect(s.permits("evil")).toBe(false);
    // each access returns a fresh copy, so the internal set is never aliased out
    expect(s.allowedCompanyIds).not.toBe(s.allowedCompanyIds);
  });

  it("is runtime-immutable (frozen): authority fields cannot be reassigned to widen scope", () => {
    const s = scope();
    expect(Object.isFrozen(s)).toBe(true);
    // In ESM strict mode this throws; in any mode the value must not change.
    try {
      (s as { isAdmin: boolean }).isAdmin = true;
    } catch {
      /* frozen object assignment throws in strict mode — expected */
    }
    expect(s.isAdmin).toBe(false);
    expect(s.permits("company_other")).toBe(false);
  });

  it("freezes the prototype: permits cannot be monkeypatched to widen authority", () => {
    expect(Object.isFrozen(CompanyScope.prototype)).toBe(true);
    const proto = Object.getPrototypeOf(scope()) as { permits: unknown };
    try {
      proto.permits = () => true;
    } catch {
      /* frozen prototype assignment throws in strict mode — expected */
    }
    // a fresh scope still uses the real permits and denies the out-of-scope id
    expect(scope().permits("company_other")).toBe(false);
  });

  it("is final: a subclass that overrides permits cannot be constructed", () => {
    class EvilScope extends CompanyScope {
      override permits(): boolean {
        return true;
      }
    }
    expect(() => new EvilScope({ principalId: "op", actorCompanyId: "company_home" })).toThrow(
      /final/,
    );
  });
});

describe("check rejects a non-authentic scope", () => {
  it("fails closed when handed anything that is not a real CompanyScope", () => {
    const fake = { permits: () => true } as unknown as CompanyScope;
    expect(() => check("company_other", fake, "company.update")).toThrow(CompanyScopeError);
    expect(() => check("company_other", fake, "company.update")).toThrow(/authentic CompanyScope/);
  });

  it("fails closed on a prototype-forged object, even one with isAdmin=true", () => {
    // Object.create satisfies instanceof but carries no private brand; with
    // isAdmin=true its permits would short-circuit to true if it ever ran.
    const forged = Object.create(CompanyScope.prototype) as Record<string, unknown>;
    forged.isAdmin = true;
    expect(forged instanceof CompanyScope).toBe(true); // instanceof alone is fooled
    expect(CompanyScope.isAuthentic(forged)).toBe(false); // the brand check is not
    expect(() => check("company_other", forged as unknown as CompanyScope, "x")).toThrow(
      /authentic CompanyScope/,
    );
  });

  it("still passes for an authentic in-scope CompanyScope", () => {
    expect(() => check("company_home", scope(), "company.update")).not.toThrow();
    expect(CompanyScope.isAuthentic(scope())).toBe(true);
  });
});

describe("CompanyScope.permits", () => {
  it("treats null / undefined / empty target as the actor's home (true)", () => {
    const s = scope();
    expect(s.permits(null)).toBe(true);
    expect(s.permits(undefined)).toBe(true);
    expect(s.permits("")).toBe(true);
  });

  it("permits a company in the allowed set, denies one outside it", () => {
    const s = scope({ allowedCompanyIds: ["company_b"] });
    expect(s.permits("company_home")).toBe(true);
    expect(s.permits("company_b")).toBe(true);
    expect(s.permits("company_other")).toBe(false);
  });

  it("rejects a non-string id BEFORE the admin short-circuit (unverifiable scope)", () => {
    const admin = scope({ isAdmin: true });
    for (const bad of [123, ["x"], { c: 1 }, true]) {
      expect(admin.permits(bad as unknown)).toBe(false);
    }
  });

  it("an admin permits any string company", () => {
    const admin = scope({ isAdmin: true });
    expect(admin.permits("company_anything")).toBe(true);
  });

  it("only a literal true grants admin — a truthy non-boolean fails closed", () => {
    for (const bad of ["false", "true", 1, {}, []]) {
      const s = scope({ isAdmin: bad as unknown as boolean });
      expect(s.isAdmin).toBe(false);
      expect(s.permits("company_other")).toBe(false);
    }
  });

  it("permits called on a forged `this` (no private brand) throws, never grants", () => {
    const forged = Object.create(CompanyScope.prototype) as { isAdmin: boolean; permits: (c: unknown) => boolean };
    forged.isAdmin = true;
    // Reading the private #allowed on a non-instance throws — fail-closed.
    expect(() => forged.permits("company_other")).toThrow();
  });
});

describe("check", () => {
  it("passes when in scope", () => {
    expect(() => check("company_home", scope(), "company.update")).not.toThrow();
    expect(() => check(null, scope(), "company.update")).not.toThrow();
  });

  it("raises a forbidden for an out-of-scope company", () => {
    try {
      check("company_other", scope(), "company.update");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CompanyScopeError);
      expect((err as CompanyScopeError).message).toMatch(/outside the actor's scope/);
      expect((err as CompanyScopeError).targetCompany).toBe("company_other");
    }
  });

  it("raises an unverifiable-scope error for a non-string id, even for an admin", () => {
    expect(() => check(123 as unknown, scope({ isAdmin: true }), "agent.hire")).toThrow(
      /unverifiable company scope/,
    );
  });
});

describe("requireResolvedCompany", () => {
  it("accepts a concrete non-empty company id", () => {
    expect(() => requireResolvedCompany("company_home", "agent", "agent")).not.toThrow();
  });

  it("fails closed on a null / empty / non-string resolved company", () => {
    expect(() => requireResolvedCompany("", "agent", "agent")).toThrow(CompanyScopeError);
    expect(() => requireResolvedCompany(null, "issue", "issue")).toThrow(/unverifiable/);
    expect(() => requireResolvedCompany(42 as unknown, "issue", "issue")).toThrow(/fail-closed/);
  });
});
