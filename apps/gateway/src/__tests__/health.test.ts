import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildHealthPayload, createGatewayApp } from "../app.js";
import type { UpstreamClient, UpstreamHealth } from "../upstream.js";

function fakeUpstream(health: UpstreamHealth): UpstreamClient {
  return { health: async () => health };
}

describe("buildHealthPayload", () => {
  it("mirrors the python /health shape and embeds upstream status", () => {
    const payload = buildHealthPayload({ reachable: true, status: 200 });
    expect(payload).toEqual({
      ok: true,
      service: "superclaw",
      upstream: { reachable: true, status: 200 },
    });
  });

  it("keeps the gateway ok when the upstream is unreachable (distinct liveness)", () => {
    const payload = buildHealthPayload({ reachable: false, status: null, detail: "ECONNREFUSED" });
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe("superclaw");
    expect(payload.upstream.reachable).toBe(false);
  });
});

describe("GET /health (gateway app, injected fake upstream)", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  async function startApp(upstream: UpstreamClient): Promise<string> {
    const app = createGatewayApp({ upstream });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    close = () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    return `http://127.0.0.1:${port}`;
  }

  it.each(["/health", "/api/health"])("%s returns aggregated health when the upstream is reachable", async (path) => {
    const base = await startApp(fakeUpstream({ reachable: true, status: 200 }));
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      service: "superclaw",
      upstream: { reachable: true, status: 200 },
    });
  });

  it.each(["/health", "/api/health"])("%s surfaces an upstream-down state without failing the gateway", async (path) => {
    const base = await startApp(fakeUpstream({ reachable: false, status: null, detail: "down" }));
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; upstream: { reachable: boolean } };
    expect(body.ok).toBe(true);
    expect(body.upstream.reachable).toBe(false);
  });

  it("/gateway-id returns identity immediately WITHOUT awaiting upstream", async () => {
    // A hanging upstream.health() must not delay /gateway-id — it is the fast readiness/identity
    // probe the co-launcher polls. If it awaited upstream, this fetch would hang and time out.
    const hanging: UpstreamClient = { health: () => new Promise<UpstreamHealth>(() => {}) };
    const app = createGatewayApp({ upstream: hanging, instanceId: "inst-123" });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    close = () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const res = await fetch(`http://127.0.0.1:${port}/gateway-id`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, instanceId: "inst-123" });
  });
});
