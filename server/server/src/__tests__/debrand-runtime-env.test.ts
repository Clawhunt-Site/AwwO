import { describe, expect, it } from "vitest";
import {
  mirrorApiEnvAliases,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";

// The chat manager skills read SUPERCLAW_RUNTIME_API_URL / _CANDIDATES_JSON (de-branded,
// no "PAPERCLIP" wording). These must reach the agent env, mirrored from the legacy
// PAPERCLIP_RUNTIME_* names the runtime sets.
describe("de-branded runtime API env reaches the agent", () => {
  it("mirrorApiEnvAliases mirrors RUNTIME_API_URL + RUNTIME_API_CANDIDATES_JSON", () => {
    const env: Record<string, string> = {
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:8791",
      PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: '["http://127.0.0.1:8791"]',
    };
    mirrorApiEnvAliases(env);
    expect(env.SUPERCLAW_RUNTIME_API_URL).toBe("http://127.0.0.1:8791");
    expect(env.SUPERCLAW_RUNTIME_API_CANDIDATES_JSON).toBe('["http://127.0.0.1:8791"]');
  });

  // Isolate every host env var these cases read/source, so the suite is order- and
  // host-independent (no leakage from a real ~/.superclaw runtime in CI).
  const HOST_KEYS = [
    "PAPERCLIP_RUNTIME_API_URL",
    "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON",
    "SUPERCLAW_RUNTIME_API_URL",
    "SUPERCLAW_RUNTIME_API_CANDIDATES_JSON",
    "PAPERCLIP_API_KEY",
    "SUPERCLAW_API_KEY",
  ];
  function withHostEnv(set: Record<string, string>, body: () => void) {
    const prev = new Map(HOST_KEYS.map((k) => [k, process.env[k]]));
    for (const k of HOST_KEYS) delete process.env[k];
    Object.assign(process.env, set);
    try {
      body();
    } finally {
      for (const k of HOST_KEYS) delete process.env[k];
      for (const [k, v] of prev) if (v !== undefined) process.env[k] = v;
    }
  }

  it("sources RUNTIME_API_URL + _CANDIDATES from process.env when the adapter env lacks them", () => {
    // Regression (real codex e2e): the host sets the runtime API locator in process.env
    // (index.ts), not the per-adapter `env`, so a bare `env[...]` mirror produced NO
    // SUPERCLAW_RUNTIME_* and the manager skills failed with api_base_unset on codex.
    withHostEnv(
      {
        PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:8793",
        PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: '["http://127.0.0.1:8793"]',
        PAPERCLIP_API_KEY: "host-key-must-not-leak",
      },
      () => {
        const env: Record<string, string> = {}; // adapter env without the runtime locator
        mirrorApiEnvAliases(env);
        expect(env.SUPERCLAW_RUNTIME_API_URL).toBe("http://127.0.0.1:8793");
        expect(env.SUPERCLAW_RUNTIME_API_CANDIDATES_JSON).toBe('["http://127.0.0.1:8793"]');
        // Agent-specific suffixes (API_KEY) must NOT be sourced from the host global env.
        expect(env.SUPERCLAW_API_KEY).toBeUndefined();
        expect(env.PAPERCLIP_API_KEY).toBeUndefined();
      },
    );
  });

  it("a populated adapter-env value is NEVER clobbered by a stale host process.env value", () => {
    // The host fallback must only fire when the adapter env carries NEITHER alias —
    // otherwise a stale SUPERCLAW_RUNTIME_API_URL in process.env would overwrite a correct
    // adapter-local PAPERCLIP_RUNTIME_API_URL (cross-contamination flagged by both advisors).
    withHostEnv({ SUPERCLAW_RUNTIME_API_URL: "http://stale-host:9999" }, () => {
      const env: Record<string, string> = { PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:8793" };
      mirrorApiEnvAliases(env);
      expect(env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:8793");
      expect(env.SUPERCLAW_RUNTIME_API_URL).toBe("http://127.0.0.1:8793"); // mirrored from env, not host
    });
  });

  it("mirror is bidirectional (SUPERCLAW name alone populates the PAPERCLIP alias)", () => {
    const env: Record<string, string> = { SUPERCLAW_RUNTIME_API_URL: "http://127.0.0.1:9000" };
    mirrorApiEnvAliases(env);
    expect(env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:9000");
  });

  it("sanitizeInheritedPaperclipEnv KEEPS the runtime API url + candidates (skills resolve loopback)", () => {
    const sanitized = sanitizeInheritedPaperclipEnv({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:8791",
      PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: '["http://127.0.0.1:8791"]',
      PAPERCLIP_API_KEY: "secret-should-be-stripped",
    } as NodeJS.ProcessEnv);
    expect(sanitized.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:8791");
    expect(sanitized.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON).toBe('["http://127.0.0.1:8791"]');
    expect(sanitized.PAPERCLIP_API_KEY).toBeUndefined(); // non-kept PAPERCLIP_ still stripped
  });
});
