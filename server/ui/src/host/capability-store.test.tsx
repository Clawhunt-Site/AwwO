// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityStoreProvider, useCapabilityStore, type CapabilityStoreApi } from "./capability-store";

describe("capability-store context", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("defaults to unavailable + no-op open outside a provider (standalone Paperclip)", async () => {
    let seen: CapabilityStoreApi | undefined;
    function Probe() {
      seen = useCapabilityStore();
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
    });
    expect(seen?.available).toBe(false);
    expect(seen?.open()).toBe(false);
  });

  it("is available on the FIRST render inside a provider and invokes the host opener", async () => {
    // The value is delivered by context during render (not an effect), so a child reads
    // host mode synchronously on its first render — no standalone flash. An effect-based
    // registration would read `available: false` on the first render instead.
    const opener = vi.fn();
    let seen: CapabilityStoreApi | undefined;
    function Probe() {
      seen = useCapabilityStore();
      return null;
    }
    await act(async () => {
      root.render(
        <CapabilityStoreProvider opener={opener}>
          <Probe />
        </CapabilityStoreProvider>,
      );
    });
    expect(seen?.available).toBe(true);
    expect(seen?.open()).toBe(true);
    expect(opener).toHaveBeenCalledTimes(1);
  });
});
