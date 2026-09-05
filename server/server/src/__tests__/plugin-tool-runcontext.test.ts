/**
 * Blocker 1 (agent-identity half) — bind a plugin-tool runContext to the
 * authenticated caller so an agent cannot drive tools under another agent's
 * identity within the same company.
 * See docs/node-agent-capability-bridge-design.md §3.1.
 */

import { describe, expect, it } from "vitest";
import { runContextActorMismatch } from "../services/plugin-tool-runcontext.js";

const RUN = { agentId: "agent-1", companyId: "co-1", runId: "run-1", projectId: "proj-1" };

describe("runContextActorMismatch", () => {
  it("accepts an agent whose identity matches the runContext", () => {
    expect(
      runContextActorMismatch({ type: "agent", agentId: "agent-1", companyId: "co-1", runId: "run-1" }, RUN),
    ).toBeNull();
  });

  it("rejects an agent impersonating another agent in the same company", () => {
    expect(
      runContextActorMismatch({ type: "agent", agentId: "agent-2", companyId: "co-1", runId: "run-1" }, RUN),
    ).toMatch(/does not match the authenticated agent/);
  });

  it("rejects an agent whose company does not match", () => {
    expect(
      runContextActorMismatch({ type: "agent", agentId: "agent-1", companyId: "co-2", runId: "run-1" }, RUN),
    ).toMatch(/does not match the authenticated agent/);
  });

  it("rejects a present runId that does not match (defense-in-depth)", () => {
    expect(
      runContextActorMismatch({ type: "agent", agentId: "agent-1", companyId: "co-1", runId: "run-9" }, RUN),
    ).toMatch(/runId does not match/);
  });

  it("allows an agent with no runId claim (absent != mismatch)", () => {
    expect(
      runContextActorMismatch({ type: "agent", agentId: "agent-1", companyId: "co-1" }, RUN),
    ).toBeNull();
  });

  it("does not bind non-agent (board/operator) callers — they keep the self-consistency check", () => {
    expect(runContextActorMismatch({ type: "board", companyId: "co-1" }, RUN)).toBeNull();
    expect(runContextActorMismatch({ type: "board", companyId: "co-2" }, RUN)).toBeNull();
  });
});
