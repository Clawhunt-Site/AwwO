import { describe, expect, it } from "vitest";
import type { CompanyPortabilityManifest } from "@paperclipai/shared";
import { generateReadme } from "../services/company-export-readme.js";

// generateReadme only reads the four array fields below; the branding/attribution
// lines render regardless of manifest content, so an otherwise-empty manifest is
// enough to exercise them.
function emptyManifest(): CompanyPortabilityManifest {
  return {
    agents: [],
    skills: [],
    projects: [],
    issues: [],
  } as unknown as CompanyPortabilityManifest;
}

describe("generateReadme branding", () => {
  it("attributes the exported package to SuperClaw, not Paperclip", () => {
    const md = generateReadme(emptyManifest(), {
      companyName: "Acme",
      companyDescription: null,
    });

    expect(md).toContain("package from SuperClaw");
    expect(md).toContain("Exported from SuperClaw on ");
    // The Paperclip-branded external links must not creep back in via a re-vendor.
    expect(md).not.toContain("paperclip.ing");
    expect(md).not.toContain("[Paperclip]");
  });
});
