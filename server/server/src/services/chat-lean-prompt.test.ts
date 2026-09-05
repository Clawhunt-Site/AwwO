import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  asString,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";

// Shared mock state for the agentService module (hoisted so vi.mock can see it).
const h = vi.hoisted(() => ({
  listResult: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ id: string; data: Record<string, unknown> }>,
}));

vi.mock("./agents.js", () => ({
  agentService: () => ({
    list: vi.fn(async () => h.listResult),
    create: vi.fn(async (_companyId: string, data: Record<string, unknown>) => {
      h.created.push(data);
      return { id: "chat-agent-1" };
    }),
    update: vi.fn(async (id: string, data: Record<string, unknown>) => {
      h.updated.push({ id, data });
      return { id };
    }),
  }),
}));

// Provenance signal — chat-compat gates on this. Controllable so we can simulate
// an external adapter overriding an allow-listed built-in type.
const reg = vi.hoisted(() => ({ builtinActive: true }));
vi.mock("../adapters/registry.js", () => ({
  isBuiltinAdapterActive: vi.fn((_type: string) => reg.builtinActive),
}));

// Imported AFTER vi.mock so chat-compat binds the mocked deps.
const { CHAT_AGENT_CHARTER, CHAT_ELIGIBLE_ADAPTER_TYPES, isChatEligibleAdapter, ensureChatAgent } =
  await import("./chat-compat.js");

// Phrases that uniquely identify the heavy Paperclip agent base / wake scaffolding.
// A lean chat prompt must contain NONE of them (Codex's adverse-acceptance list,
// plus the contract/wake markers).
const HEAVY_MARKERS = [
  "Continue your Paperclip work",
  "Execution contract",
  "final disposition",
  "in_review",
  "in_progress",
  "## Paperclip Wake Payload",
  "child issues",
];

const TEMPLATE_DATA = { agent: { id: "a1", name: "Chat Assistant" } };

function chatWakePayload() {
  return {
    chat: true,
    reason: "user_message",
    issue: null,
    comments: [
      {
        id: "c1",
        issueId: "i1",
        body: "What is the capital of France?",
        bodyTruncated: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        author: { type: "user", id: "u1" },
      },
      {
        id: "c2",
        issueId: "i1",
        body: "Paris.",
        bodyTruncated: false,
        createdAt: "2026-01-01T00:00:01.000Z",
        author: { type: "agent", id: "a1" },
      },
    ],
    commentWindow: { requestedCount: 2, includedCount: 2, missingCount: 0 },
    truncated: false,
  };
}

function companyWakePayload() {
  return {
    reason: "assignment",
    issue: {
      id: "i1",
      identifier: "PAP-1",
      title: "Ship the feature",
      status: "in_progress",
      priority: "high",
      workMode: "execute",
    },
    comments: [],
    commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
    truncated: false,
  };
}

// Replicates the prompt assembly every local adapter performs for a FRESH (no
// native session) run — see claude-local execute.ts:375 (promptTemplate resolution)
// and :694 (joinPromptSections). codex-local/gemini-local/etc. use the identical
// `asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE)` +
// renderTemplate + renderPaperclipWakePrompt path, so this covers them all.
function assembleFreshPrompt(
  config: Record<string, unknown>,
  wakePayload: unknown,
): string {
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const renderedPrompt = renderTemplate(promptTemplate, TEMPLATE_DATA);
  const wakePrompt = renderPaperclipWakePrompt(wakePayload);
  return joinPromptSections([wakePrompt, renderedPrompt]);
}

describe("chat lean prompt assembly (local adapter fresh run)", () => {
  it("a chat agent (promptTemplate=CHAT_AGENT_CHARTER) yields a lean prompt — no Paperclip base/contract", () => {
    const prompt = assembleFreshPrompt(
      { promptTemplate: CHAT_AGENT_CHARTER },
      chatWakePayload(),
    );
    // The lean charter + conversation transcript are present...
    expect(prompt).toContain("SuperClaw's chat assistant");
    expect(prompt).toContain("Conversation so far");
    expect(prompt).toContain("User: What is the capital of France?");
    expect(prompt).toContain("Assistant: Paris.");
    // ...and NONE of the heavy Paperclip scaffolding.
    for (const marker of HEAVY_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
    expect(prompt.toLowerCase()).not.toContain("paperclip-managed company");
  });

  it("control: a default agent (no promptTemplate) on a company wake IS heavy — proves the assertions can fail", () => {
    const prompt = assembleFreshPrompt({}, companyWakePayload());
    // The default base IS the thing we suppress for chat — assert it would trip
    // the heavy-marker checks, so the chat assertions above are meaningful.
    expect(prompt).toContain("Continue your Paperclip work");
    expect(prompt).toContain("Execution contract");
    expect(prompt).toContain("## Paperclip Wake Payload");
  });
});

describe("CHAT_AGENT_CHARTER", () => {
  it("is lean: contains no Paperclip issue/contract scaffolding", () => {
    for (const marker of HEAVY_MARKERS) {
      expect(CHAT_AGENT_CHARTER).not.toContain(marker);
    }
    expect(CHAT_AGENT_CHARTER).not.toContain("Paperclip");
  });

  it("still authorizes real execution (not an ask-only mode)", () => {
    expect(CHAT_AGENT_CHARTER).toContain("tools");
    expect(CHAT_AGENT_CHARTER.toLowerCase()).toContain("workspace");
  });
});

describe("CHAT_ELIGIBLE_ADAPTER_TYPES (fail-closed allow-list)", () => {
  it("allows the local conversational adapters", () => {
    for (const t of [
      "claude_local",
      "codex_local",
      "gemini_local",
      "cursor",
      "opencode_local",
      "pi_local",
      "grok_local",
      "clawwork_local",
      "hermes_local",
    ]) {
      expect(CHAT_ELIGIBLE_ADAPTER_TYPES.has(t)).toBe(true);
    }
  });

  it("refuses gateways/cloud, process/http, acpx_local (incomplete), and unknown adapters", () => {
    for (const t of [
      "hermes_gateway",
      "openclaw_gateway",
      "cursor_cloud",
      "process",
      "http",
      // acpx_local is an incomplete ACP bridge that leaks raw protocol frames into
      // chat output — intentionally NOT a chat backend.
      "acpx_local",
      "some_future_external_gateway",
    ]) {
      expect(CHAT_ELIGIBLE_ADAPTER_TYPES.has(t)).toBe(false);
    }
  });
});

describe("isChatEligibleAdapter (provenance-bound, fail-closed)", () => {
  it("accepts an allow-listed type backed by the trusted built-in module", () => {
    reg.builtinActive = true;
    expect(isChatEligibleAdapter("claude_local")).toBe(true);
  });

  it("refuses an allow-listed type that an external adapter has overridden", () => {
    // External adapter registered as "claude_local" → not the trusted built-in.
    reg.builtinActive = false;
    expect(isChatEligibleAdapter("claude_local")).toBe(false);
    reg.builtinActive = true;
  });

  it("refuses an ineligible type regardless of provenance", () => {
    reg.builtinActive = true;
    expect(isChatEligibleAdapter("hermes_gateway")).toBe(false);
    expect(isChatEligibleAdapter("process")).toBe(false);
  });
});

describe("ensureChatAgent charter wiring", () => {
  beforeEach(() => {
    reg.builtinActive = true;
  });

  it("rejects an external adapter overriding an allow-listed type (fail-closed)", async () => {
    h.listResult = [];
    h.created = [];
    reg.builtinActive = false; // external override of "claude_local"
    await expect(ensureChatAgent({} as never, "company-1", "claude_local")).rejects.toThrow();
    expect(h.created).toHaveLength(0);
    reg.builtinActive = true;
  });

  it("rejects ineligible adapters before touching the db (fail-closed)", async () => {
    for (const t of ["hermes_gateway", "openclaw_gateway", "process", "http", "mystery_adapter"]) {
      h.listResult = [];
      h.created = [];
      await expect(ensureChatAgent({} as never, "company-1", t)).rejects.toThrow();
      expect(h.created).toHaveLength(0);
    }
  });

  it("stamps the lean charter as promptTemplate on a freshly created chat agent", async () => {
    h.listResult = [];
    h.created = [];
    h.updated = [];
    await ensureChatAgent({} as never, "company-1", "claude_local");
    expect(h.created).toHaveLength(1);
    expect((h.created[0].adapterConfig as Record<string, unknown>).promptTemplate).toBe(
      CHAT_AGENT_CHARTER,
    );
  });

  it("repairs an existing chat agent missing the charter (idempotent)", async () => {
    h.created = [];
    h.updated = [];
    h.listResult = [{ id: "existing-1", adapterType: "claude_local", adapterConfig: {} }];
    await ensureChatAgent({} as never, "company-1", "claude_local");
    expect(h.created).toHaveLength(0);
    expect(h.updated).toHaveLength(1);
    expect(h.updated[0].id).toBe("existing-1");
    expect((h.updated[0].data.adapterConfig as Record<string, unknown>).promptTemplate).toBe(
      CHAT_AGENT_CHARTER,
    );
  });

  it("does not rewrite an existing chat agent that already has the charter", async () => {
    h.created = [];
    h.updated = [];
    h.listResult = [
      {
        id: "existing-1",
        adapterType: "claude_local",
        adapterConfig: { promptTemplate: CHAT_AGENT_CHARTER },
      },
    ];
    await ensureChatAgent({} as never, "company-1", "claude_local");
    expect(h.updated).toHaveLength(0);
    expect(h.created).toHaveLength(0);
  });
});
