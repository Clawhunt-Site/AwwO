// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { ActivityRow } from "./ActivityRow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeActivityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "activity-1",
    companyId: "company-1",
    actorType: "system",
    actorId: "system",
    action: "issue.read_marked",
    entityType: "unknown",
    entityId: "entity-1",
    agentId: null,
    runId: null,
    details: null,
    createdAt: new Date("2026-06-27T08:00:00.000Z"),
    ...overrides,
  };
}

describe("ActivityRow", () => {
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T10:00:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    container.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
    await i18n.changeLanguage("en");
  });

  it("localizes activity fallback copy, board actor, references, and relative time in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ActivityRow
          event={makeActivityEvent({
            actorType: "user",
            actorId: "local-board",
            details: {
              addedReferencedIssues: [
                { id: "issue-1", title: "关联任务" },
              ],
            },
          })}
          agentMap={new Map()}
          userProfileMap={new Map([[
            "local-board",
            { label: "Board", image: null },
          ]])}
          entityNameMap={new Map([["unknown:entity-1", "任务一"]])}
        />,
      );
    });

    expect(container.textContent).toContain("看板");
    expect(container.textContent).toContain("标记已读");
    expect(container.textContent).toContain("任务一");
    expect(container.textContent).toContain("新增引用");
    expect(container.textContent).toContain("2小时前");
    expect(container.textContent).not.toContain("issue read marked");
    expect(container.textContent).not.toContain("Added references");
    expect(container.textContent).not.toContain("Board");
    expect(container.textContent).not.toContain("2h ago");

    await act(async () => {
      root.unmount();
    });
  });
});
