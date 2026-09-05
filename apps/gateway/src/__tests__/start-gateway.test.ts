import { afterEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway, type GatewayRuntime } from "../index.js";

const SAVED_ENV = { ...process.env };

/** Bind then close to obtain a currently-free loopback port. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function startStubUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const app: Express = express();
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  return new Promise((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

describe("startGateway boot wiring", () => {
  let runtime: GatewayRuntime | null = null;
  let stubClose: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (runtime) await runtime.stop();
    if (stubClose) await stubClose();
    runtime = null;
    stubClose = null;
    for (const key of Object.keys(process.env)) {
      if ((key.startsWith("SUPERCLAW_GATEWAY_") || key === "SUPERCLAW_HOME") && !(key in SAVED_ENV)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, SAVED_ENV);
  });

  it("binds the front door and proxies /health to the upstream end-to-end", async () => {
    const stub = await startStubUpstream();
    stubClose = stub.close;
    const listenPort = await freePort();

    process.env.SUPERCLAW_GATEWAY_HOST = "127.0.0.1";
    process.env.SUPERCLAW_GATEWAY_PORT = String(listenPort);
    process.env.SUPERCLAW_GATEWAY_UPSTREAM_PORT = String(stub.port);
    // Keep the automation store + control-token + lifecycle marker out of the real ~/.superclaw.
    process.env.SUPERCLAW_HOME = join(tmpdir(), `gw-home-${randomUUID()}`);
    process.env.SUPERCLAW_GATEWAY_AUTOMATION_FILE = join(tmpdir(), `gw-test-${randomUUID()}`, "chat-automations.json");

    runtime = await startGateway();

    const res = await fetch(`http://127.0.0.1:${listenPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      service: "superclaw",
      upstream: { reachable: true, status: 200 },
    });
    // The automation scheduler liveness is read back through /health (never optimistic).
    expect(body.automation).toMatchObject({ running: true, lastTickAt: null });
  });

  it("rejects when the front-door port is already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const { port } = blocker.address() as AddressInfo;

    process.env.SUPERCLAW_GATEWAY_PORT = String(port);
    try {
      await expect(startGateway()).rejects.toBeTruthy();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
