import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  validateRelayBaseUrl,
  prepareClawrelayProvider,
  ClawworkRelayConfigError,
} from "./runtime-config.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("validateRelayBaseUrl", () => {
  it("accepts a normal https base and strips a trailing slash", () => {
    expect(validateRelayBaseUrl("https://relay.example.com/v1/")).toBe("https://relay.example.com/v1");
  });
  it("accepts loopback http", () => {
    expect(validateRelayBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });
  it("rejects userinfo (credential exfil surface)", () => {
    expect(() => validateRelayBaseUrl("https://user:pass@relay.example.com")).toThrow(ClawworkRelayConfigError);
  });
  it("rejects remote plaintext http", () => {
    expect(() => validateRelayBaseUrl("http://relay.example.com")).toThrow(ClawworkRelayConfigError);
  });
  it("rejects empty", () => {
    expect(() => validateRelayBaseUrl("")).toThrow(ClawworkRelayConfigError);
  });
  it("rejects a non-URL", () => {
    expect(() => validateRelayBaseUrl("not a url")).toThrow(ClawworkRelayConfigError);
  });
});

describe("prepareClawrelayProvider", () => {
  it("writes the provider config to an EPHEMERAL dir, never the workspace, with NO plaintext key", async () => {
    const prepared = await prepareClawrelayProvider({
      env: {
        SUPERCLAW_RELAY_BASE_URL: "https://relay.example.com/v1",
        SUPERCLAW_RELAY_API_KEY: "sk-super-secret-key-value",
      },
      modelSlug: "superclaw-plus",
    });
    cleanups.push(prepared.cleanup);

    // The dir is a fresh os.tmpdir() mkdtemp, not under any cwd/workspace.
    expect(prepared.agentConfigDir).toContain("superclaw-clawwork-agent-");
    const modelsPath = path.join(prepared.agentConfigDir, "models.json");
    const raw = fs.readFileSync(modelsPath, "utf8");

    // CRITICAL credential hygiene: the real key MUST NOT be on disk; the apiKey
    // is the env-binding placeholder, resolved by ClawWork from the child env.
    expect(raw).not.toContain("sk-super-secret-key-value");
    const parsed = JSON.parse(raw);
    expect(parsed.providers.clawrelay.apiKey).toBe("$SUPERCLAW_RELAY_API_KEY");
    expect(parsed.providers.clawrelay.baseUrl).toBe("https://relay.example.com/v1");
    expect(parsed.providers.clawrelay.models).toEqual([{ id: "superclaw-plus" }]);

    // models.json is 0600.
    expect(fs.statSync(modelsPath).mode & 0o777).toBe(0o600);
  });

  it("fails closed when the relay base is missing", async () => {
    await expect(
      prepareClawrelayProvider({
        env: { SUPERCLAW_RELAY_API_KEY: "sk-key" },
        modelSlug: "superclaw-core",
      }),
    ).rejects.toBeInstanceOf(ClawworkRelayConfigError);
  });

  it("fails closed when the relay key is missing", async () => {
    await expect(
      prepareClawrelayProvider({
        env: { SUPERCLAW_RELAY_BASE_URL: "https://relay.example.com" },
        modelSlug: "superclaw-core",
      }),
    ).rejects.toBeInstanceOf(ClawworkRelayConfigError);
  });

  it("cleanup removes the ephemeral dir", async () => {
    const prepared = await prepareClawrelayProvider({
      env: {
        SUPERCLAW_RELAY_BASE_URL: "https://relay.example.com",
        SUPERCLAW_RELAY_API_KEY: "sk-key",
      },
      modelSlug: null,
    });
    expect(fs.existsSync(prepared.agentConfigDir)).toBe(true);
    await prepared.cleanup();
    expect(fs.existsSync(prepared.agentConfigDir)).toBe(false);
  });
});
