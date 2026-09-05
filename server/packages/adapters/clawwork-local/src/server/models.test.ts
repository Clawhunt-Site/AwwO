import { describe, it, expect } from "vitest";
import { translateRelayPackageModel, listClawworkModels, RELAY_GROUP_SLUGS } from "./models.js";

describe("translateRelayPackageModel", () => {
  it("maps known tiers to their relay group slug", () => {
    expect(translateRelayPackageModel("core")).toBe("superclaw-core");
    expect(translateRelayPackageModel("plus")).toBe("superclaw-plus");
    expect(translateRelayPackageModel("max")).toBe("superclaw-max");
  });
  it("is case-insensitive on the tier name", () => {
    expect(translateRelayPackageModel("PLUS")).toBe("superclaw-plus");
  });
  it("defaults an empty/whitespace model to the base tier slug", () => {
    expect(translateRelayPackageModel("")).toBe(RELAY_GROUP_SLUGS.core);
    expect(translateRelayPackageModel("   ")).toBe(RELAY_GROUP_SLUGS.core);
    expect(translateRelayPackageModel(null)).toBe(RELAY_GROUP_SLUGS.core);
  });
  it("passes through an already-resolved slug or raw override verbatim", () => {
    expect(translateRelayPackageModel("superclaw-plus")).toBe("superclaw-plus");
    expect(translateRelayPackageModel("some/raw-model")).toBe("some/raw-model");
  });
});

describe("listClawworkModels", () => {
  it("returns the static relay tiers", () => {
    expect(listClawworkModels().map((m) => m.id)).toEqual(["core", "plus", "max"]);
  });
});
