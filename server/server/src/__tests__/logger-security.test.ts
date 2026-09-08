import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rootLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  };
  const transport = vi.fn(() => ({ write: vi.fn() }));
  const pino = vi.fn(() => rootLogger);
  (pino as typeof pino & { transport: typeof transport }).transport = transport;
  const pinoHttp = vi.fn(() => vi.fn());
  const mkdirSync = vi.fn();
  return { rootLogger, transport, pino, pinoHttp, mkdirSync };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: mocks.mkdirSync };
});
vi.mock("pino", () => ({ default: mocks.pino }));
vi.mock("pino-http", () => ({ pinoHttp: mocks.pinoHttp }));
vi.mock("../config-file.js", () => ({ readConfigFile: vi.fn(() => null) }));
vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: vi.fn((value: string) => value),
  resolveDefaultLogsDir: vi.fn(() => "/tmp/awwo-logger-security"),
}));

const originalLogLevel = process.env.AWWO_LOG_LEVEL;

async function importLogger() {
  vi.resetModules();
  return import("../middleware/logger.js");
}

describe("logger security configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AWWO_LOG_LEVEL;
  });

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.AWWO_LOG_LEVEL;
    else process.env.AWWO_LOG_LEVEL = originalLogLevel;
  });

  it("preserves debug as the default and redacts session headers", async () => {
    await importLogger();

    expect(mocks.pino).toHaveBeenCalledOnce();
    expect(mocks.pino.mock.calls[0]?.[0]).toMatchObject({
      level: "debug",
      redact: expect.arrayContaining([
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
      ]),
    });
  });

  it("constructs the root and HTTP logger from silent before either can emit", async () => {
    process.env.AWWO_LOG_LEVEL = "silent";
    await importLogger();

    expect(mocks.pino.mock.calls[0]?.[0]).toMatchObject({ level: "silent" });
    expect(mocks.pinoHttp).toHaveBeenCalledOnce();
    expect(mocks.pinoHttp.mock.calls[0]?.[0]).toMatchObject({ logger: mocks.rootLogger });
  });

  it.each(["fatal", "error", "warn", "info", "debug", "trace", "silent"])(
    "accepts the documented %s level",
    async (level) => {
      process.env.AWWO_LOG_LEVEL = level;
      await importLogger();

      expect(mocks.pino.mock.calls[0]?.[0]).toMatchObject({ level });
    },
  );

  it("treats a whitespace-only setting as the default", async () => {
    process.env.AWWO_LOG_LEVEL = "   ";
    await importLogger();

    expect(mocks.pino.mock.calls[0]?.[0]).toMatchObject({ level: "debug" });
  });

  it("fails before creating a log directory when the level is invalid", async () => {
    process.env.AWWO_LOG_LEVEL = "verbose";

    await expect(importLogger()).rejects.toThrow(
      "AWWO_LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent",
    );
    expect(mocks.mkdirSync).not.toHaveBeenCalled();
    expect(mocks.pino).not.toHaveBeenCalled();
    expect(mocks.pinoHttp).not.toHaveBeenCalled();
  });

  it("rejects case variants without echoing the supplied value", async () => {
    process.env.AWWO_LOG_LEVEL = "SILENT";

    await expect(importLogger()).rejects.toThrow(
      "AWWO_LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent",
    );
    await expect(importLogger()).rejects.not.toThrow("SILENT");
  });

  it("removes invite tokens from structured requests, messages, and error properties", async () => {
    await importLogger();
    const options = mocks.pinoHttp.mock.calls[0]?.[0] as any;
    const segment = "fixture-invite-segment";
    const url = `/api/invites/${segment}/accept?token=fixture-page-cursor`;
    const req = {
      method: "POST",
      url,
      originalUrl: url,
      headers: { cookie: "session=fixture-cookie" },
      params: { token: segment },
      query: { token: "fixture-page-cursor" },
      route: { path: `/api/invites/${segment}/accept` },
    };
    const res = {
      statusCode: 500,
      __errorContext: {
        error: { message: `Invite ${segment} failed` },
        reqBody: { password: "fixture-password" },
        reqParams: { token: segment },
        reqQuery: { token: "fixture-page-cursor" },
      },
    };

    const output = {
      request: options.serializers.req(req),
      success: options.customSuccessMessage(req, res),
      error: options.customErrorMessage(req, res, new Error(`Invite ${segment} failed`)),
      errorObject: options.customErrorObject(
        req,
        res,
        new Error(`Invite ${segment} failed`),
        { err: new Error(`Invite ${segment} failed`) },
      ),
      props: options.customProps(req, res),
      fallbackProps: options.customProps(req, { statusCode: 500 }),
    };
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain(segment);
    expect(serialized).not.toContain("fixture-password");
    expect(serialized).not.toContain("fixture-cookie");
    expect(serialized).toContain("fixture-page-cursor");
    expect(serialized).toContain("[REDACTED]");
    expect(output.errorObject.err).toMatchObject({ message: "Invite [REDACTED] failed" });
    expect(output.fallbackProps.routePath).toBe("/api/invites/[REDACTED]/accept");
  });
});
