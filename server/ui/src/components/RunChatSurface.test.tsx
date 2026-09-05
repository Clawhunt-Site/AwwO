// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { LiveRunForIssue } from "../api/heartbeats";
import { RunChatSurface } from "./RunChatSurface";

vi.mock("./IssueChatThread", () => ({
  IssueChatThread: ({ emptyMessage }: { emptyMessage: string }) => (
    <div data-testid="nux-thread">{emptyMessage}</div>
  ),
}));

const run: LiveRunForIssue = {
  id: "run-1",
  status: "running",
  agentId: "agent-1",
  agentName: "Agent",
  createdAt: new Date(0).toISOString(),
  startedAt: new Date(0).toISOString(),
  finishedAt: null,
} as LiveRunForIssue;

function act(callback: () => void) {
  flushSync(callback);
}

async function renderSurface() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<RunChatSurface run={run} transcript={[]} hasOutput={false} />);
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

afterEach(async () => {
  document.body.innerHTML = "";
  await i18n.changeLanguage("en");
});

describe("RunChatSurface thread presentation", () => {
  it("renders the graduated issue thread without a chat-flag branch", async () => {
    await i18n.changeLanguage("en");
    const { container, cleanup } = await renderSurface();
    expect(container.querySelector('[data-testid="nux-thread"]')).not.toBeNull();
    expect(container.textContent).toContain("Waiting for run output...");
    await cleanup();
  });

  it("passes localized empty text to the embedded issue thread", async () => {
    await i18n.changeLanguage("zh-CN");
    const { container, cleanup } = await renderSurface();
    expect(container.textContent).toContain("等待运行输出...");
    expect(container.textContent).not.toContain("Waiting for run output...");
    await cleanup();
  });
});
