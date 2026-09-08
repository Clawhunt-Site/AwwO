import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const createdDirectories: string[] = [];

afterEach(async () => {
  const fs = await import("node:fs/promises");
  for (const directory of createdDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("silent logger integration", () => {
  it("persists trace records when trace logging is selected", async () => {
    const fs = await import("node:fs/promises");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "awwo-logger-trace-"));
    createdDirectories.push(directory);
    const loggerUrl = new URL("../middleware/logger.ts", import.meta.url).href;
    const script = `(async () => {
      const { logger } = await import(${JSON.stringify(loggerUrl)});
      logger.trace("fixture trace record");
      await new Promise((resolve, reject) => logger.flush((error) => error ? reject(error) : resolve()));
    })().catch((error) => { console.error(error); process.exitCode = 1; });`;

    execFileSync(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        AWWO_LOG_LEVEL: "trace",
        PAPERCLIP_LOG_DIR: directory,
      },
      stdio: "pipe",
      timeout: 20_000,
    });

    const output = await fs.readFile(path.join(directory, "server.log"), "utf8");
    expect(output).toContain("fixture trace record");
  });

  it("writes zero bytes for root and HTTP request logging in a fresh process", async () => {
    const fs = await import("node:fs/promises");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "awwo-logger-silent-"));
    createdDirectories.push(directory);
    const loggerUrl = new URL("../middleware/logger.ts", import.meta.url).href;
    const script = `(async () => {
      const { default: express } = await import("express");
      const { default: request } = await import("supertest");
      const { logger, httpLogger } = await import(${JSON.stringify(loggerUrl)});
      logger.info("fixture root record");
      const app = express();
      app.use(httpLogger);
      app.get("/api/invites/fixture-invite-segment/accept", (_req, res) => res.json({ ok: true }));
      await request(app).get("/api/invites/fixture-invite-segment/accept");
      await new Promise((resolve, reject) => logger.flush((error) => error ? reject(error) : resolve()));
    })().catch((error) => { console.error(error); process.exitCode = 1; });`;

    execFileSync(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        AWWO_LOG_LEVEL: "silent",
        PAPERCLIP_LOG_DIR: directory,
      },
      stdio: "pipe",
      timeout: 20_000,
    });

    const logFile = path.join(directory, "server.log");
    const size = await fs.stat(logFile).then((stat) => stat.size).catch(() => 0);
    expect(size).toBe(0);
  });

  it("redacts invitation and session values in the actual formatted file log", async () => {
    const fs = await import("node:fs/promises");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "awwo-logger-redaction-"));
    createdDirectories.push(directory);
    const loggerUrl = new URL("../middleware/logger.ts", import.meta.url).href;
    const script = `(async () => {
      const { default: express } = await import("express");
      const { default: request } = await import("supertest");
      const { logger, httpLogger } = await import(${JSON.stringify(loggerUrl)});
      const app = express();
      app.use(httpLogger);
      app.post("/api/invites/fixture-invite-segment/accept", (_req, res) => {
        res.setHeader("set-cookie", "session=fixture-response-session-value");
        res.json({ ok: true });
      });
      app.post("/api/invites/fixture-error-segment/accept", (_req, res) => {
        res.__errorContext = {
          error: {
            message: "Invite fixture-error-segment failed",
            authorization: "Bearer fixture-error-authorization",
          },
          reqQuery: { token: "fixture-error-segment" },
        };
        res.err = new Error("Invite fixture-error-segment failed");
        res.status(500).json({ ok: false });
      });
      await request(app)
        .post("/api/invites/fixture-invite-segment/accept?token=fixture-invite-segment")
        .set("cookie", "session=fixture-session-value")
        .set("authorization", "Bearer fixture-authorization-value");
      await request(app)
        .post("/api/invites/fixture-error-segment/accept?token=fixture-error-segment")
        .set("cookie", "session=fixture-error-session-value");
      await new Promise((resolve, reject) => logger.flush((error) => error ? reject(error) : resolve()));
    })().catch((error) => { console.error(error); process.exitCode = 1; });`;

    execFileSync(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        AWWO_LOG_LEVEL: "debug",
        PAPERCLIP_LOG_DIR: directory,
      },
      stdio: "pipe",
      timeout: 20_000,
    });

    const output = await fs.readFile(path.join(directory, "server.log"), "utf8");
    expect(output).not.toContain("fixture-invite-segment");
    expect(output).not.toContain("fixture-error-segment");
    expect(output).not.toContain("fixture-session-value");
    expect(output).not.toContain("fixture-authorization-value");
    expect(output).not.toContain("fixture-response-session-value");
    expect(output).not.toContain("fixture-error-session-value");
    expect(output).not.toContain("fixture-error-authorization");
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("/api/invites/[REDACTED]/accept");
  });
});
