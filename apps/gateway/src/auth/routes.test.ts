import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClawHuntAuthRouter } from "./routes.js";

describe("GET /auth/me", () => {
  const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  });

  async function start(fetchImpl: typeof fetch): Promise<string> {
    const app = express();
    app.use(
      "/api",
      createClawHuntAuthRouter({
        baseUrl: "https://clawhunt.example",
        timeoutMs: 500,
        fetchImpl,
      }),
    );
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("rejects a missing bearer token without contacting ClawHunt", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const base = await start(fetchImpl);

    const response = await fetch(`${base}/api/auth/me`);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards only the bearer token and returns only identity fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 42,
          username: "alice",
          email: "alice@example.com",
          avatar_url: "https://cdn.example/alice.png",
          is_admin: true,
          access_status: "approved",
          tier: "pro",
          superclaw_plan: "plus",
          credit_balance: 9999,
          frozen_balance: 123,
          wallet_address: "secret",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const base = await start(fetchImpl);

    const response = await fetch(`${base}/api/auth/me`, {
      headers: {
        authorization: "Bearer signed.jwt.token",
        cookie: "should=never-forward",
        "x-untrusted-header": "nope",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      id: 42,
      username: "alice",
      email: "alice@example.com",
      avatar_url: "https://cdn.example/alice.png",
      is_admin: true,
      access_status: "approved",
      tier: "pro",
      superclaw_plan: "plus",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://clawhunt.example/api/auth/me");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer signed.jwt.token",
    });
  });

  it("maps an invalid upstream token to a generic unauthorized response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ detail: "token expired" }), { status: 401 }));
    const base = await start(fetchImpl);

    const response = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: "Bearer expired.jwt.token" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: "ClawHunt session is invalid" });
  });

  it("fails closed when the upstream payload is not a valid identity", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ credit_balance: 10 }), { status: 200 }));
    const base = await start(fetchImpl);

    const response = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: "Bearer signed.jwt.token" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ detail: "ClawHunt returned an invalid identity" });
  });

  it("maps upstream 403 to 401 (invalid session), forwarding no upstream body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("nope", { status: 403 }));
    const base = await start(fetchImpl);
    const response = await fetch(`${base}/api/auth/me`, { headers: { authorization: "Bearer t" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ detail: expect.stringMatching(/invalid/i) });
  });

  it("maps upstream 429 to 503 (busy)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("busy", { status: 429 }));
    const base = await start(fetchImpl);
    const response = await fetch(`${base}/api/auth/me`, { headers: { authorization: "Bearer t" } });
    expect(response.status).toBe(503);
  });

  it("maps a redirect (302, under redirect:manual) and a 500 to 502 — the SSRF/open-redirect defense", async () => {
    for (const status of [302, 500]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      const base = await start(fetchImpl);
      const response = await fetch(`${base}/api/auth/me`, { headers: { authorization: "Bearer t" } });
      expect(response.status).toBe(502);
    }
  });

  it("maps an upstream timeout/abort to 504 (not 502)", async () => {
    // Never resolves within timeoutMs=500 → the router aborts → must be 504.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const base = await start(fetchImpl);
    const response = await fetch(`${base}/api/auth/me`, { headers: { authorization: "Bearer t" } });
    expect(response.status).toBe(504);
  });
});
