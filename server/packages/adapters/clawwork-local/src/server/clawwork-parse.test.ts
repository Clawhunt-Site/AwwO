import { describe, it, expect } from "vitest";
import { clawworkTerminalError, clawworkExtensionError } from "./clawwork-parse.js";

function jsonl(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("clawworkTerminalError", () => {
  it("returns null for a clean run (assistant stopReason=stop)", () => {
    const stdout = jsonl(
      { type: "agent_start" },
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }] },
    );
    expect(clawworkTerminalError(stdout)).toBeNull();
  });

  it("detects a terminal assistant stopReason=error even with partial text (fake-success guard)", () => {
    const stdout = jsonl(
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "relay 401", content: [{ type: "text", text: "partial" }] }] },
    );
    expect(clawworkTerminalError(stdout)).toBe("relay 401");
  });

  it("detects stopReason=aborted (falls back to a generic message when no errorMessage)", () => {
    const stdout = jsonl(
      { type: "turn_end", message: { role: "assistant", stopReason: "aborted", content: [] } },
    );
    expect(clawworkTerminalError(stdout)).toBe("request aborted");
  });

  it("ignores toolUse stopReason (a normal mid-loop tool turn is not an error)", () => {
    const stdout = jsonl(
      { type: "turn_end", message: { role: "assistant", stopReason: "toolUse", content: [] } },
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }] },
    );
    expect(clawworkTerminalError(stdout)).toBeNull();
  });

  it("tolerates malformed lines and non-assistant messages", () => {
    const stdout =
      "not json\n" +
      jsonl({ type: "agent_end", messages: [{ role: "user", content: "hi" }, { role: "assistant", stopReason: "stop", content: [] }] });
    expect(clawworkTerminalError(stdout)).toBeNull();
  });
});

describe("clawworkExtensionError", () => {
  it("detects an extension_error JSONL event (pi-local's parser skips it)", () => {
    const stdout = jsonl({ type: "extension_error", error: "superclaw-governance threw: boom" });
    expect(clawworkExtensionError(stdout, "")).toContain("boom");
  });
  it("detects an 'Extension error' stderr line (print mode)", () => {
    expect(clawworkExtensionError("", "Extension error (superclaw-governance): cannot read property")).toMatch(/Extension error/i);
  });
  it("returns null for a clean run", () => {
    const stdout = jsonl({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
    expect(clawworkExtensionError(stdout, "")).toBeNull();
  });
});
