import { describe, expect, it } from "vitest";
import {
  buildPluginMentionHref,
  buildSkillMentionHref,
} from "@paperclipai/shared";
import { parseMentionChipHref } from "./mention-chips";

describe("parseMentionChipHref — plugin mentions", () => {
  it("recognizes a plugin:// href as a plugin chip", () => {
    const href = buildPluginMentionHref("plugin-123");
    expect(parseMentionChipHref(href)).toEqual({ kind: "plugin", pluginId: "plugin-123" });
  });

  it("does not confuse a plugin mention with a skill mention", () => {
    expect(parseMentionChipHref(buildSkillMentionHref("skill-1"))).toMatchObject({ kind: "skill" });
    expect(parseMentionChipHref(buildPluginMentionHref("p1"))).toMatchObject({ kind: "plugin" });
  });

  it("returns null for a plain web link (never a chip)", () => {
    expect(parseMentionChipHref("https://example.com/plugin")).toBeNull();
  });
});
