import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMPANY_TOOL_NAMES, MARKETPLACE_WRITE_TOOL_NAMES } from "./command-vocabulary.js";

// Repo root, relative to this test file (apps/gateway/src/governance/).
const SUPERCLAW = "../../../../packages/superclaw/src/superclaw/";

function readPy(name: string): string {
  return readFileSync(fileURLToPath(new URL(SUPERCLAW + name, import.meta.url)), "utf8");
}

/** Slice the `{ ... }` literal of a `NAME: dict[str, str] = { "k": "v", ... }`. */
function dictBlock(src: string, dictName: string): string {
  const start = src.indexOf(dictName);
  if (start === -1) throw new Error(`${dictName} not found`);
  const open = src.indexOf("{", start);
  const close = src.indexOf("}", open);
  return src.slice(open + 1, close);
}

/** Extract the RHS string values of a string->string dict literal. */
function dictValues(src: string, dictName: string): string[] {
  return [...dictBlock(src, dictName).matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1] as string);
}

/** Extract the "key" -> "value" pairs of a string->string dict literal. */
function dictPairs(src: string, dictName: string): Array<[string, string]> {
  return [...dictBlock(src, dictName).matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(
    (m) => [m[1] as string, m[2] as string],
  );
}

/**
 * Parse each `class …Command` block (bounded to its own class, never crossing
 * into the next) for its command_type and is_read flag. A class that omits
 * is_read defaults to a WRITE, matching Python's `getattr(cls, "is_read", False)`.
 */
function parseCommandClasses(src: string, prefix: string): Array<{ ct: string; isRead: boolean }> {
  // Only the class-definition region, before the registry/mapping declarations.
  const limitIdx = src.indexOf(`${prefix.toUpperCase()}_COMMAND_TYPE_TO_TOOL_NAME`);
  const region = limitIdx === -1 ? src : src.slice(0, limitIdx);
  const classRe = /class\s+\w+Command\b[\s\S]*?(?=\nclass\s+\w+Command\b|$)/g;
  const out: Array<{ ct: string; isRead: boolean }> = [];
  for (const block of region.matchAll(classRe)) {
    const text = block[0];
    const ctMatch = text.match(new RegExp(`command_type:\\s*ClassVar\\[str\\]\\s*=\\s*"(${prefix}\\.\\w+)"`));
    if (!ctMatch) continue;
    const irMatch = text.match(/is_read:\s*ClassVar\[bool\]\s*=\s*(True|False)/);
    out.push({ ct: ctMatch[1] as string, isRead: irMatch ? irMatch[1] === "True" : false });
  }
  return out;
}

describe("command vocabulary stays in sync with the Python single source", () => {
  it("COMPANY_TOOL_NAMES == company_commands.py COMMAND_TYPE_TO_TOOL_NAME values", () => {
    const py = dictValues(readPy("company_commands.py"), "COMMAND_TYPE_TO_TOOL_NAME");
    expect([...COMPANY_TOOL_NAMES].sort()).toEqual([...py].sort());
  });

  it("MARKETPLACE_WRITE_TOOL_NAMES == marketplace command classes with is_read=False", () => {
    const src = readPy("marketplace_commands.py");
    const ctToTool = new Map<string, string>(dictPairs(src, "MARKETPLACE_COMMAND_TYPE_TO_TOOL_NAME"));
    const classes = parseCommandClasses(src, "marketplace");

    // Registry consistency: every command class is mapped to a tool name and
    // vice versa. A new command class missing from the map (or a stale map
    // entry) fails here instead of silently producing a false-green.
    expect(new Set(classes.map((c) => c.ct))).toEqual(new Set(ctToTool.keys()));

    // Derive writes from each class's real is_read flag (mirrors Python
    // `if not getattr(cls, "is_read", False)`), so a flag flip turns this red.
    const writes = classes.filter((c) => !c.isRead).map((c) => ctToTool.get(c.ct) as string);
    expect([...MARKETPLACE_WRITE_TOOL_NAMES].sort()).toEqual([...writes].sort());
  });
});
