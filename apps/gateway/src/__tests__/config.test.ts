import { describe, expect, it } from "vitest";
import { GatewayConfigError, loadGatewayConfig } from "../config.js";

describe("loadGatewayConfig", () => {
  it("uses safe loopback defaults with an empty env", () => {
    const config = loadGatewayConfig({});
    expect(config.listenHost).toBe("127.0.0.1");
    expect(config.listenPort).toBe(8788);
    expect(config.upstreamHost).toBe("127.0.0.1");
    expect(config.upstreamPort).toBe(3100);
    expect(config.upstreamBaseUrl).toBe("http://127.0.0.1:3100");
    expect(config.upstreamHealthPath).toBe("/api/health");
    expect(config.clawHuntBaseUrl).toBeNull();
  });

  it("reads and canonicalizes an explicit ClawHunt identity upstream", () => {
    const config = loadGatewayConfig({
      SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL: "https://clawhunt.example/root/",
      SUPERCLAW_GATEWAY_CLAWHUNT_TIMEOUT_MS: "3200",
    });
    expect(config.clawHuntBaseUrl).toBe("https://clawhunt.example/root");
    expect(config.clawHuntTimeoutMs).toBe(3200);
  });

  it("rejects unsafe or ambiguous ClawHunt identity upstream URLs", () => {
    for (const value of [
      "http://clawhunt.example",
      "https://user:pass@clawhunt.example",
      "https://clawhunt.example/path?tenant=other",
      "https://clawhunt.example/path#fragment",
      "file:///etc/passwd",
    ]) {
      expect(() =>
        loadGatewayConfig({ SUPERCLAW_GATEWAY_CLAWHUNT_BASE_URL: value }),
      ).toThrow(GatewayConfigError);
    }
  });

  it("reads overrides from the environment", () => {
    const config = loadGatewayConfig({
      SUPERCLAW_GATEWAY_HOST: "0.0.0.0",
      SUPERCLAW_GATEWAY_PORT: "9000",
      SUPERCLAW_GATEWAY_UPSTREAM_PORT: "9001",
      SUPERCLAW_GATEWAY_UPSTREAM_HEALTH_PATH: "/healthz",
    });
    expect(config.listenHost).toBe("0.0.0.0");
    expect(config.listenPort).toBe(9000);
    expect(config.upstreamBaseUrl).toBe("http://127.0.0.1:9001");
    expect(config.upstreamHealthPath).toBe("/healthz");
  });

  it("fails closed when the upstream host is not loopback", () => {
    expect(() => loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HOST: "0.0.0.0" })).toThrow(
      GatewayConfigError,
    );
    expect(() => loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HOST: "10.0.0.5" })).toThrow(
      /must be loopback/,
    );
  });

  it("derives a valid bracketed URL for an IPv6 loopback host", () => {
    expect(loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HOST: "::1" }).upstreamBaseUrl).toBe(
      "http://[::1]:3100",
    );
    expect(loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HOST: "localhost" }).upstreamBaseUrl).toBe(
      "http://localhost:3100",
    );
  });

  it("blocks a non-loopback upstream URL override (no parallel governance channel)", () => {
    expect(() =>
      loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_URL: "http://10.0.0.5:3100" }),
    ).toThrow(/must be loopback/);
    expect(() =>
      loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_URL: "http://evil.example.com" }),
    ).toThrow(/must be loopback/);
  });

  it("accepts a loopback upstream URL override, including IPv6", () => {
    expect(loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_URL: "http://127.0.0.1:7000" }).upstreamBaseUrl).toBe(
      "http://127.0.0.1:7000",
    );
    expect(loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_URL: "http://[::1]:7000" }).upstreamBaseUrl).toBe(
      "http://[::1]:7000",
    );
  });

  it("accepts an already-bracketed IPv6 upstream host without double-bracketing", () => {
    expect(loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HOST: "[::1]" }).upstreamBaseUrl).toBe(
      "http://[::1]:3100",
    );
  });

  it("rejects a non-http(s) upstream URL scheme", () => {
    expect(() => loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_URL: "ftp://127.0.0.1:21" })).toThrow(
      /must be http/,
    );
    expect(() =>
      loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_URL: "file:///etc/passwd" }),
    ).toThrow(GatewayConfigError);
  });

  it("rejects a health path containing a backslash", () => {
    expect(() =>
      loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HEALTH_PATH: "/api\\health" }),
    ).toThrow(/must be an absolute path/);
  });

  it("rejects an out-of-range or malformed port instead of silently falling back", () => {
    expect(() => loadGatewayConfig({ SUPERCLAW_GATEWAY_PORT: "70000" })).toThrow(GatewayConfigError);
    expect(() => loadGatewayConfig({ SUPERCLAW_GATEWAY_PORT: "not-a-number" })).toThrow(
      GatewayConfigError,
    );
  });

  it("rejects an absolute or protocol-relative health path (probe must stay loopback)", () => {
    expect(() =>
      loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HEALTH_PATH: "http://10.0.0.5/health" }),
    ).toThrow(/must be an absolute path/);
    expect(() =>
      loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HEALTH_PATH: "//10.0.0.5/health" }),
    ).toThrow(/must be an absolute path/);
    expect(() =>
      loadGatewayConfig({ SUPERCLAW_GATEWAY_UPSTREAM_HEALTH_PATH: "relative/health" }),
    ).toThrow(/must be an absolute path/);
  });
});
