import { afterEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { HttpUpstreamClient, UpstreamClientError } from "../upstream.js";
import { createGatewayApp } from "../app.js";

describe("HttpUpstreamClient construction guards", () => {
  it("refuses a health path that resolves off the upstream origin (defense in depth)", () => {
    expect(() => new HttpUpstreamClient("http://127.0.0.1:3100", "http://10.0.0.5/health", 5000)).toThrow(
      UpstreamClientError,
    );
    expect(() => new HttpUpstreamClient("http://127.0.0.1:3100", "//10.0.0.5/health", 5000)).toThrow(
      UpstreamClientError,
    );
  });

  it("accepts a same-origin path", () => {
    const client = new HttpUpstreamClient("http://127.0.0.1:3100", "/api/health", 5000);
    expect(client).toBeInstanceOf(HttpUpstreamClient);
  });
});

interface Running {
  baseUrl: string;
  close: () => Promise<void>;
}

function startServer(app: Express): Promise<Running> {
  return new Promise<Running>((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

describe("HttpUpstreamClient against a real loopback upstream", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const close = cleanups.pop();
      if (close) await close();
    }
  });

  it("reports reachable end-to-end through the gateway when the upstream serves /api/health", async () => {
    const upstreamApp = express();
    upstreamApp.get("/api/health", (_req, res) => {
      res.json({ ok: true });
    });
    const upstream = await startServer(upstreamApp);
    cleanups.push(upstream.close);

    const client = new HttpUpstreamClient(upstream.baseUrl, "/api/health", 5000);
    const gateway = await startServer(createGatewayApp({ upstream: client }));
    cleanups.push(gateway.close);

    const res = await fetch(`${gateway.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      service: "superclaw",
      upstream: { reachable: true, status: 200 },
    });
  });

  it("reports unreachable when the upstream serves only the wrong path (proves /api/health correctness)", async () => {
    const upstreamApp = express();
    upstreamApp.get("/health", (_req, res) => {
      res.json({ ok: true }); // root /health, NOT /api/health
    });
    const upstream = await startServer(upstreamApp);
    cleanups.push(upstream.close);

    const client = new HttpUpstreamClient(upstream.baseUrl, "/api/health", 5000);
    const health = await client.health();
    expect(health.reachable).toBe(false);
    expect(health.status).toBe(404);
  });

  it("reports unreachable (status null) when nothing is listening", async () => {
    // Bind then close to obtain a definitely-free loopback port.
    const probe = await startServer(express());
    const deadBaseUrl = probe.baseUrl;
    await probe.close();

    const client = new HttpUpstreamClient(deadBaseUrl, "/api/health", 1500);
    const health = await client.health();
    expect(health.reachable).toBe(false);
    expect(health.status).toBeNull();
  });
});
