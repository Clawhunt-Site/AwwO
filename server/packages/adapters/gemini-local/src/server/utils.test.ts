import { describe, expect, it } from "vitest";
import { firstGeminiErrorLine, firstNonEmptyLine } from "./utils.js";

describe("firstGeminiErrorLine", () => {
  it("surfaces the real auth error, not the leading YOLO/trust notices", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      'Approval mode overridden to "default" because the current folder is not trusted.',
      "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.",
      "    at throwIneligibleOrProjectIdError (file:///.../chunk.js:1:1)",
    ].join("\n");
    // firstNonEmptyLine would (wrongly) return the YOLO notice...
    expect(firstNonEmptyLine(stderr)).toMatch(/^YOLO mode is enabled/);
    // ...firstGeminiErrorLine returns the actual cause.
    expect(firstGeminiErrorLine(stderr)).toMatch(/^Error authenticating: IneligibleTierError/);
  });

  it("returns empty string when stderr holds only informational notices", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      'Approval mode overridden to "default" because the current folder is not trusted.',
    ].join("\n");
    expect(firstGeminiErrorLine(stderr)).toBe("");
  });

  it("prefers an error-looking line over a non-error first line", () => {
    const stderr = ["Some incidental progress line.", "Request failed: quota exceeded."].join("\n");
    expect(firstGeminiErrorLine(stderr)).toBe("Request failed: quota exceeded.");
  });

  it("falls back to the first non-notice line when nothing looks like an error", () => {
    expect(firstGeminiErrorLine("just a plain message\nsecond line")).toBe("just a plain message");
  });
});
